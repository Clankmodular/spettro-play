// AudioWorklet hosting the Daisy firmware compiled to WebAssembly and the
// JavaScript port of the ESP32 control side.
//
// Every 5 ms (240 samples at 48 kHz, the SPI task period) the controller
// writes a 128-byte control frame; the Daisy parses it before the next
// 96-frame block and its reply frame goes back to the controller and, about
// 30 times per second, to the panel for LEDs and display.

import { Controller, FRAME, IMAGE } from './esp/controller.js';

// The engine runs at engineRate (48 kHz); sampleRate, the device's rate,
// may differ (44.1 kHz interfaces): then process() resamples. Frame and status timing count engine samples.

class SpectrumProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Compiled on the main thread; instantiating here keeps memory local.
    const { module, engineRate = sampleRate, testTone = false } = options.processorOptions;
    this.testTone = testTone; // ?test=tone: a plain sine, the engine idle
    this.tonePhase = 0;
    this.frameSamples = Math.round(engineRate * 0.005);
    this.statusSamples = Math.round(engineRate / 30); // ~33 ms
    // Engine samples per output sample; 1 plays the engine straight through.
    this.step = engineRate / sampleRate;
    this.phase = 1; // read position in the FIFO, one sample of history behind
    const stub = new Proxy({}, { get: () => () => 0 });
    const imports = new Proxy({}, { get: () => stub });
    const instance = new WebAssembly.Instance(module, imports);
    const e = instance.exports;
    this.e = e;
    if (e._initialize) e._initialize();
    e.spectrum_init();
    this.mem = e.memory;
    this.rxPtr = e.spectrum_rx();
    this.blockFrames = e.spectrum_block_frames();
    this.controller = new Controller();
    this.reply = new Uint8Array(FRAME);
    this.sinceFrame = this.frameSamples;
    this.sinceStatus = 0;

    // Engine renders 96-frame blocks; the browser asks for 128-frame quanta,
    // more engine samples than that when resampling down.
    this.fifoL = new Float32Array(this.blockFrames * 12);
    this.fifoR = new Float32Array(this.blockFrames * 12);
    this.fifoCount = 0;
    // Views into the engine's memory, made once: it never grows, and
    // allocating on the audio thread risks garbage-collection pauses.
    this.outPtr = -1;
    // spectrum_lights() computes the lights into a static buffer: call it each
    // time, read it through these views.
    this.lights = new Float32Array(this.mem.buffer, e.spectrum_lights(), 16);
    // Web drone stutter (beat repeat of the output): the last 3 s of engine
    // output, frozen while a slice of it repeats. Step -12..12 from the
    // transpose fader during a Hold capture, 0 is off; it stays set, so each
    // new capture stutters again at once with the last step.
    this.engineRate = engineRate;
    this.history = [new Float32Array(Math.round(engineRate * 3)), new Float32Array(Math.round(engineRate * 3))];
    this.historyPos = 0;
    this.stutter = { step: 0, on: false, anchor: 0, pos: 0, mix: 0, fade: 1 / Math.round(engineRate * 0.003) };
    this.tapLights = this.lights.subarray(8, 16);
    // Load: time spent in process() against the audio time it produced,
    // over about a second (Date.now is coarse, the sum is not biased).
    this.load = { work: 0, frames: 0, peak: 0, last: { load: 0, peak: 0 } };

    this.port.onmessage = ({ data }) => this.message(data);
    this.port.postMessage({ type: 'ready' });
  }

  message(data) {
    const c = this.controller;
    switch (data.type) {
      case 'set':
        Object.assign(c.pr, data.values);
        if ('selKeyboard' in data.values || 'keyboardLayout' in data.values) c.updateKeyboard();
        // Web fx mix goes straight to the engine, not through the SPI frame.
        if ('fxMix' in data.values) this.e.spectrum_set_fx_mix(c.pr.fxMix);
        break;
      case 'prop':
        if ('midiChannel' in data.values && data.values.midiChannel !== c.midiChannel) c.midiReset();
        Object.assign(c, data.values);
        break;
      case 'call': c[data.method](...(data.args || [])); break;
      case 'stutter': this.stutter.step = data.step; break;
      case 'midi': c.midi(data.bytes); break;
      case 'adc':
        for (const [channel, value] of data.values) {
          this.e.spectrum_set_adc(channel, value);
          if (channel === 7) this.tuneCents = value * 100 - 50;
        }
        break;
    }
  }

  sendFrame() {
    const c = this.controller;
    c.tick(5);
    new Uint8Array(this.mem.buffer, this.rxPtr, FRAME).set(c.buildFrame());
    if (!this.e.spectrum_frame()) return;
    this.reply.set(new Uint8Array(this.mem.buffer, this.e.spectrum_reply(), FRAME));
    c.reply(this.reply);
  }

  // Filter lobes for the analyser, with the controls modulated as on the ESP.
  geometry() {
    const c = this.controller, pr = c.pr;
    const mod = (base, d) => Math.min(255, Math.max(0, base + c.lfo(d) + c.cc(d))) / 255;
    const ptr = this.e.spectrum_geometry(mod(pr.spectralBands, 37), mod(pr.spectralSpread, 39),
      mod(pr.spectralWidth, 40), pr.spectralRotate / 65535, IMAGE / 65535, pr.spectralMode,
      c.displayNoteHz() * Math.pow(2, (this.tuneCents || 0) / 1200));
    return new Float32Array(this.mem.buffer, ptr, 33).slice();
  }

  renderBlock() {
    if (this.sinceFrame >= this.frameSamples) { this.sinceFrame -= this.frameSamples; this.sendFrame(); }
    const n = this.blockFrames;
    const ptr = this.e.spectrum_render();
    if (ptr !== this.outPtr) { this.outPtr = ptr; this.out = new Float32Array(this.mem.buffer, ptr, 2 * n); }
    const out = this.out;
    // While it stutters, the captured voices are silenced in the frame and
    // whatever else is played sounds over the repeat.
    this.controller.droneMuted = this.stutter.step !== 0 && this.controller.droneActive();
    if (this.controller.droneMuted || this.stutter.mix) this.stutterBlock(out, n);
    else {
      const [hl, hr] = this.history, cap = hl.length;
      for (let i = 0; i < n; i++) {
        const l = out[2 * i], r = out[2 * i + 1];
        this.fifoL[this.fifoCount + i] = l; this.fifoR[this.fifoCount + i] = r;
        hl[this.historyPos] = l; hr[this.historyPos] = r;
        if (++this.historyPos === cap) this.historyPos = 0;
      }
    }
    this.fifoCount += n;
    this.sinceFrame += n;
    this.sinceStatus += n;
    if (this.sinceStatus >= this.statusSamples) {
      this.sinceStatus = 0;
      this.e.spectrum_lights();
      const lights = this.lights, pr = this.controller.pr;
      // Only the preset fields the page reads (it mirrors the rest itself).
      this.port.postMessage({ type: 'status', status: this.controller.status(), reply: this.reply.slice(),
        pr: { latchedNote: pr.latchedNote, trilloOn: pr.trilloOn, spectralMode: pr.spectralMode, oscBank: pr.oscBank },
        geometry: this.geometry(), bandLevels: Array.from(lights.subarray(0, 8)),
        taps: Array.from(lights.subarray(8, 16)), delayHits: this.hits, load: this.load.last });
      this.hits = 0;
    }
    // Hits are collected every block so short flashes are not missed.
    if (this.controller.attacks.length) { this.e.spectrum_lights(); this.hits = (this.hits || 0) | this.controller.delayHits(this.tapLights); }
  }

  // Beat repeat added to the live sound (the captured voices are silenced):
  // the history stops at the start and its last slice (one division of the
  // beat) loops, with the samples before the slice crossfaded in at the
  // seam. 3 ms fades in and out; the stutter ends by itself when the Hold
  // capture does, and the step is kept for the next.
  stutterBlock(out, n) {
    const S = this.stutter, c = this.controller, [hl, hr] = this.history, cap = hl.length;
    const want = S.step !== 0 && c.droneActive();
    if (want && !S.on) { S.on = true; S.anchor = this.historyPos; S.pos = 0; }
    const steps = Math.ceil(Math.abs(S.step) / 2) - 1; // 2 LED steps per division
    const beats = [2, 1, 0.5, 0.25, 0.125, 0.0625][Math.max(0, steps)] * (S.step < 0 ? 2 / 3 : 1);
    const fadeLen = Math.round(1 / S.fade);
    const len = Math.max(2 * fadeLen, Math.min(cap - 2 * fadeLen, Math.round(beats * c.clockTimeMs / 1000 * this.engineRate)));
    if (S.pos >= len) S.pos %= len;
    const at = (k) => (k % cap + cap) % cap;
    for (let i = 0; i < n; i++) {
      const l = out[2 * i], r = out[2 * i + 1];
      S.mix = Math.min(1, Math.max(0, S.mix + (want ? S.fade : -S.fade)));
      let sl = 0, sr = 0;
      if (S.mix > 0) {
        const start = S.anchor - len, k = at(start + S.pos);
        sl = hl[k]; sr = hr[k];
        const into = S.pos - (len - fadeLen);
        if (into >= 0) { // seam: blend towards the samples just before the slice
          const w = (into + 1) / fadeLen, j = at(start - fadeLen + into);
          sl += (hl[j] - sl) * w; sr += (hr[j] - sr) * w;
        }
        if (++S.pos >= len) S.pos = 0;
      }
      this.fifoL[this.fifoCount + i] = l + sl * S.mix;
      this.fifoR[this.fifoCount + i] = r + sr * S.mix;
      if (!S.on || S.mix === 0) { hl[this.historyPos] = l; hr[this.historyPos] = r; if (++this.historyPos === cap) this.historyPos = 0; }
    }
    if (!want && S.mix === 0) S.on = false;
  }

  process(_inputs, outputs) {
    const t0 = Date.now();
    const [left, right] = outputs[0];
    const quantum = left.length;
    if (this.testTone) {
      const inc = 2 * Math.PI * 440 / sampleRate;
      for (let i = 0; i < quantum; i++) { left[i] = 0.25 * Math.sin(this.tonePhase); this.tonePhase = (this.tonePhase + inc) % (2 * Math.PI); }
      if (right) right.set(left);
    } else if (this.step === 1) {
      while (this.fifoCount < quantum) this.renderBlock();
      left.set(this.fifoL.subarray(0, quantum));
      if (right) right.set(this.fifoR.subarray(0, quantum));
      this.fifoL.copyWithin(0, quantum, this.fifoCount);
      this.fifoR.copyWithin(0, quantum, this.fifoCount);
      this.fifoCount -= quantum;
    } else this.resample(left, right, quantum);
    const L = this.load, spent = Date.now() - t0;
    L.work += spent; L.frames += quantum; L.peak = Math.max(L.peak, spent);
    if (L.frames >= sampleRate) {
      const audioMs = L.frames / sampleRate * 1000;
      L.last = { load: L.work / audioMs, peak: L.peak / (quantum / sampleRate * 1000) };
      L.work = 0; L.frames = 0; L.peak = 0;
    }
    return true;
  }

  // Engine rate to device rate, 4-point Catmull-Rom interpolation around the
  // read position (one sample of history before it, two after).
  resample(left, right, quantum) {
    const fl = this.fifoL, fr = this.fifoR;
    const cubic = (a, b, c, d, x) => b + 0.5 * x * (c - a + x * (2 * a - 5 * b + 4 * c - d + x * (3 * (b - c) + d - a)));
    let phase = this.phase;
    for (let i = 0; i < quantum; i++) {
      const n = Math.floor(phase), x = phase - n;
      while (this.fifoCount < n + 3) this.renderBlock();
      left[i] = cubic(fl[n - 1], fl[n], fl[n + 1], fl[n + 2], x);
      if (right) right[i] = cubic(fr[n - 1], fr[n], fr[n + 1], fr[n + 2], x);
      phase += this.step;
    }
    // Keep one sample of history before the next read position.
    const drop = Math.floor(phase) - 1;
    fl.copyWithin(0, drop, this.fifoCount);
    fr.copyWithin(0, drop, this.fifoCount);
    this.fifoCount -= drop;
    this.phase = phase - drop;
  }
}

registerProcessor('spectrum-engine', SpectrumProcessor);
