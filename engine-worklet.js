// AudioWorklet hosting the Daisy firmware compiled to WebAssembly and the
// JavaScript port of the ESP32 control side.
//
// Every 5 ms (240 samples at 48 kHz, the SPI task period) the controller
// writes a 128-byte control frame; the Daisy parses it before the next
// 96-frame block and its reply frame goes back to the controller and, about
// 30 times per second, to the panel for LEDs and display.

import { Controller, FRAME } from './esp/controller.js';

// sampleRate is the AudioContext rate: 48 kHz, matching the engine.
const FRAME_SAMPLES = Math.round(sampleRate * 0.005);
const STATUS_SAMPLES = Math.round(sampleRate / 30); // ~33 ms

class SpectrumProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Compiled on the main thread; instantiating here keeps memory local.
    const { module } = options.processorOptions;
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
    this.sinceFrame = FRAME_SAMPLES;
    this.sinceStatus = 0;

    // Engine renders 96-frame blocks; the browser asks for 128-frame quanta.
    this.fifoL = new Float32Array(this.blockFrames * 4);
    this.fifoR = new Float32Array(this.blockFrames * 4);
    this.fifoCount = 0;

    this.port.onmessage = ({ data }) => this.message(data);
    this.port.postMessage({ type: 'ready' });
  }

  message(data) {
    const c = this.controller;
    switch (data.type) {
      case 'set':
        Object.assign(c.pr, data.values);
        if ('selKeyboard' in data.values || 'keyboardLayout' in data.values) c.updateKeyboard();
        break;
      case 'prop':
        if ('midiChannel' in data.values && data.values.midiChannel !== c.midiChannel) c.midiReset();
        Object.assign(c, data.values);
        break;
      case 'call': c[data.method](...(data.args || [])); break;
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
      mod(pr.spectralWidth, 40), pr.spectralRotate / 65535, pr.spectralStereo / 65535, pr.spectralMode,
      c.displayNoteHz() * Math.pow(2, (this.tuneCents || 0) / 1200));
    return new Float32Array(this.mem.buffer, ptr, 33).slice();
  }

  renderBlock() {
    if (this.sinceFrame >= FRAME_SAMPLES) { this.sinceFrame -= FRAME_SAMPLES; this.sendFrame(); }
    const n = this.blockFrames;
    const out = new Float32Array(this.mem.buffer, this.e.spectrum_render(), 2 * n);
    for (let i = 0; i < n; i++) {
      this.fifoL[this.fifoCount + i] = out[2 * i];
      this.fifoR[this.fifoCount + i] = out[2 * i + 1];
    }
    this.fifoCount += n;
    this.sinceFrame += n;
    this.sinceStatus += n;
    if (this.sinceStatus >= STATUS_SAMPLES) {
      this.sinceStatus = 0;
      const lights = new Float32Array(this.mem.buffer, this.e.spectrum_lights(), 16);
      const taps = Array.from(lights.subarray(8, 16));
      this.port.postMessage({ type: 'status', status: this.controller.status(), reply: this.reply.slice(),
        pr: this.controller.pr, geometry: this.geometry(),
        bandLevels: Array.from(lights.subarray(0, 8)), taps, delayHits: this.hits });
      this.hits = 0;
    }
    // Hits are collected every block so short flashes are not missed.
    if (this.controller.attacks.length) {
      const taps = new Float32Array(this.mem.buffer, this.e.spectrum_lights(), 16).subarray(8, 16);
      this.hits = (this.hits || 0) | this.controller.delayHits(taps);
    }
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    const quantum = left.length;
    while (this.fifoCount < quantum) this.renderBlock();
    left.set(this.fifoL.subarray(0, quantum));
    if (right) right.set(this.fifoR.subarray(0, quantum));
    this.fifoL.copyWithin(0, quantum, this.fifoCount);
    this.fifoR.copyWithin(0, quantum, this.fifoCount);
    this.fifoCount -= quantum;
    return true;
  }
}

registerProcessor('spectrum-engine', SpectrumProcessor);
