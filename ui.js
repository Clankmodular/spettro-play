// Panel behaviour of the ESP32 that does not touch audio: control scaling,
// button gestures, display pages edited with the mouse, LFO assignment, Loop (control
// motion), presets and LEDs. Notes, voices, arpeggio and the SPI frame run
// in the AudioWorklet (esp/controller.js); this side sends it `pr` changes.

import { defaultPreset, migratePreset, DEST, STUTTER } from './esp/controller.js';
import { SCALES, LAYOUT_NAMES, KEYS, degreeForKey, frequency, nearestDegree } from './esp/scales.js';
import { PATTERNS, GROOVES, DIVISIONS, divisionIndex, speedForDivision } from './esp/trillo.js';
import * as P from './pages.js';
import { MODES, BANKS } from './display.js';
import { Presets, SLOTS } from './presets.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const now = () => performance.now();
const ADC_TUNE = 7, ADC_MASTER = 8;
const LATENCY_KEY = 'spettro.latency';
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BANK_ORDER = [0, 2, 3, 1, 4]; // Classic, Fold, Noise, Exciter, External (oscillator::Next)
const LFO_WAVES = ['tri', 'ramp', 'saw', 'square', 'random']; // Daisy waves 1..5
const SHAPES = ['flat', 'saw', 'inv saw', 'triangle', 'inv tri'];
const CC_DESTS = [[DEST.None, 'none'], [DEST.OscWave, 'osc1 wave'], [DEST.SubWave, 'osc2 wave'], [DEST.Blend, 'blend'],
  [DEST.Crossmod, 'Xmod'], [DEST.SubDetune, 'sub detune'], [DEST.SubDivider, 'osc2 div'], [DEST.Drive, 'drive'],
  [DEST.Attack, 'attack'], [DEST.Release, 'release'], [DEST.Trillo, 'trl speed'], [DEST.Bands, 'bands'],
  [DEST.Spread, 'spread'], [DEST.Rotate, 'rotate'], [DEST.Width, 'width'],
  [DEST.FilterMode, 'flt mode'], [DEST.DelayTime, 'fx time'], [DEST.Feedback, 'reverb'], [DEST.Dispersion, 'disp'],
  [DEST.ReverbSize, 'rev size'], [DEST.ReverbTilt, 'rev tilt'], [DEST.DelayFeedback, 'fx feedback'],
  [DEST.Master, 'master'], [DEST.LfoSpeed, 'lfo speed'], [DEST.LfoAmount, 'lfo amount'], [DEST.LfoWave, 'lfo wave']];
const LFO_LABEL = { [DEST.Attack]: 'attack', [DEST.Release]: 'release', [DEST.Drive]: 'drive', [DEST.Bands]: 'flt band',
  [DEST.Spread]: 'flt spread', [DEST.Rotate]: 'flt rotate', [DEST.Stereo]: 'flt stereo', [DEST.Width]: 'flt width',
  [DEST.DelayTime]: 'fx time', [DEST.Feedback]: 'reverb', [DEST.Dispersion]: 'fx disp', [DEST.ReverbSize]: 'rev size',
  [DEST.ReverbTilt]: 'rev tilt', [DEST.DelayFeedback]: 'fx feedback', [DEST.OscWave]: 'osc1 wave',
  [DEST.SubWave]: 'osc2 wave', [DEST.Blend]: 'osc blend', [DEST.Crossmod]: 'osc Xmod', [DEST.Master]: 'master',
  [DEST.Octave]: 'octave', [DEST.Transpose]: 'transpose', [DEST.Tune]: 'tune' };
const LED = { white: '#f1efe9', yellow: '#ffb321', turquoise: '#36d3dc', red: '#ff3a2f', blue: '#4d9dff',
  green: '#47d86a', orange: '#ff8a1c', violet: '#c6a2ff' };
const MODE_COLORS = [LED.blue, LED.yellow, LED.green, LED.red];
// Linear mix of two #rrggbb colours, t = 0..1 towards b.
function mixColor(a, b, t) {
  const c = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `rgb(${[0, 1, 2].map((i) => Math.round(c(a, i) + (c(b, i) - c(a, i)) * t)).join(',')})`;
}

// Panel blend taper (shared/blend_control.h).
function blendFromPanel(raw) {
  const full = 65535, margin = full * 0.05, span = full - 2 * margin;
  if (raw <= margin) return 0;
  if (raw >= full - margin) return full;
  const lower = raw < full / 2;
  const x = (lower ? raw - margin : full - margin - raw) / span;
  const power = x * x * (3 - 2 * x) * full;
  return lower ? power : full - power;
}
function blendToPanel(value) {
  const full = 65535, margin = full * 0.05, span = full - 2 * margin;
  if (value <= 0) return margin;
  if (value >= full) return full - margin;
  const lower = value < full / 2, target = (lower ? value : full - value) / full;
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (mid * mid * (3 - 2 * mid) < target) lo = mid; else hi = mid; }
  const d = (lo + hi) / 2 * span;
  return lower ? margin + d : full - margin - d;
}

// Band-envelope time ratios (band_envelope.h Ratios) for the editor graph.
function bandRatio(shape, band) {
  const x = band / 7;
  const raw = [1, 1 - x, x, 1 - Math.abs(2 * x - 1), Math.abs(2 * x - 1)][shape] ?? 1;
  return shape ? Math.pow(2, 4 * (raw - 1)) : 1;
}
const SUSTAIN_CHOICES = 17;
const sustainMask = (c) => (c === 0 ? 0 : c <= 7 ? (1 << c) - 1 : c === 8 ? 0xff : c <= 15 ? (0xff << (16 - c)) & 0xff : 0xff);
const sustainChoice = (mask) => { for (let c = 0; c < 16; c++) if (sustainMask(c) === mask) return c; return 16; };
const sustainLabel = (c) => (c === 0 ? 'none' : c === 8 ? 'all' : c >= 16 ? 'custom' : c === 1 ? '1' : c < 8 ? `1-${c}` : c === 9 ? '8' : `${17 - c}-8`);

export class Ui {
  constructor(panel, display) {
    this.panel = panel;
    this.display = display;
    this.pr = defaultPreset();
    this.reverbBank = false; // the three knobs by Δt: delay or reverb
    this.stutterStep = 0; // web drone stutter, 0..11 (STUTTER), kept between drones
    this.adc = { tune: 0.5, volume: 0.75 };
    this.page = 'analyser';
    this.menus = { note: { row: 0, editing: false }, arp: { row: 0, editing: false }, envelope: { row: 0, editing: false },
      system: { row: 0, editing: false }, midi: { row: 0, editing: false }, setup: { row: 0, editing: false },
      preset: { row: 1, editing: false } };
    this.systemPage = 'system';
    this.midiChannel = 0;
    this.lastKey = 16;
    this.customFreq = null;  // per-key edits, null = from the scale
    this.buttons = {};
    this.taps = [];
    this.bpmFlash = 0;
    this.lfoLearn = { learning: false, startedAt: 0, touched: false };
    this.loop = { armed: false, lanes: new Map(), completed: new Set(), taps: [], movedSinceTap: false };
    this.presets = new Presets();
    this.presetBank = 0; this.presetSlot = 0; // the page opens on the factory bank
    this.regions = [];
    this.state = null;
    this.syncPanel();
    requestAnimationFrame(() => this.frame());
  }

  attach(port, ctx) {
    this.port = port;
    this.ctx = ctx;
    this.send('set', { values: { ...this.pr, lfoAssigned: this.pr.lfoAssigned } });
    this.send('prop', { values: { analyserRequested: true, midiChannel: this.midiChannel } });
    this.sendAdc();
    this.call('setBpm', 110);
  }

  send(type, data) { this.port?.postMessage({ type, ...data }); }
  call(method, ...args) { this.send('call', { method, args }); }
  set(values) { Object.assign(this.pr, values); this.send('set', { values }); this.presetDirty = true; }
  sendAdc() { this.send('adc', { values: [[ADC_TUNE, this.adc.tune], [ADC_MASTER, this.adc.volume]] }); }

  // ---- Controls -----------------------------------------------------------

  // Panel position (0..1) of every continuous control from the current pr.
  positions() {
    const pr = this.pr, r = this.reverbBank;
    return {
      amount: pr.lfoAmount / 255, speed: pr.lfoSpeed / 255, bands: pr.spectralBands / 255,
      shape: pr.spectralSpread / 255, shift: pr.spectralRotate / 65535, reso: pr.spectralWidth / 255,
      xmod: pr.crossMod / 255, blend: blendToPanel(pr.oscSubBlend) / 65535, oscA: pr.subWave / 255,
      oscB: pr.wave_shape / 65535, drive: pr.driveAmount / 255, fx: pr.fxMix,
      volume: this.adc.volume, tune: this.adc.tune, touch: 0.5,
      time: (r ? pr.reverbSize : pr.delayTime) / 255, spread: (r ? pr.reverbTilt : pr.delayShift) / 255,
      diffuse: (r ? pr.delayRegen : pr.delayFeedback) / 255,
      attack: pr.attack / 255, release: pr.release / 255,
      transpose: this.drone() ? (this.stutterStep + 0.5) / 12 : (pr.articulationDegreeTranspose + 12) / 24,
    };
  }

  syncPanel() {
    this.panel.defaults = { ...this.positions(), shift: 0.5, blend: 0.5, fx: 0.5, tune: 0.5, transpose: 0.5 };
    for (const [id, v] of Object.entries(this.positions())) this.panel.set(id, v);
  }

  destinationFor(id) {
    const r = this.reverbBank;
    return { bands: DEST.Bands, shape: DEST.Spread, shift: DEST.Rotate, reso: DEST.Width, xmod: DEST.Crossmod,
      blend: DEST.Blend, oscA: DEST.SubWave, oscB: DEST.OscWave, drive: DEST.Drive,
      volume: DEST.Master, attack: DEST.Attack, release: DEST.Release, transpose: DEST.Transpose, tune: DEST.Tune,
      time: r ? DEST.ReverbSize : DEST.DelayTime, spread: r ? DEST.ReverbTilt : DEST.Dispersion,
      diffuse: r ? DEST.Feedback : DEST.DelayFeedback }[id];
  }

  control(id, v, fromLoop = false) {
    if (!fromLoop) {
      // While assigning, controls do not move (wheel and double click included).
      if (this.lfoLearn.learning) { this.syncPanel(); return; }
      this.loopRecord(id, v);
    }
    const b = (x) => Math.round(x * 255), r = this.reverbBank;
    switch (id) {
      case 'amount': return this.set({ lfoAmount: b(v) });
      case 'speed': return this.set({ lfoSpeed: b(v) });
      case 'bands': return this.set({ spectralBands: b(v) });
      case 'shape': return this.set({ spectralSpread: v * 255 });
      case 'shift': return this.set({ spectralRotate: v * 65535 });
      case 'reso': return this.set({ spectralWidth: v * 255 });
      case 'xmod': { const raw = v * 65535; return this.set({ crossMod: raw < 1024 ? 0 : raw > 64511 ? 255 : b(v) }); }
      case 'blend': return this.set({ oscSubBlend: blendFromPanel(v * 65535) });
      case 'oscA': return this.set({ subWave: b(v) });
      case 'oscB': return this.set({ wave_shape: v * 65535 });
      case 'drive': return this.set({ driveAmount: b(v) });
      case 'fx': return this.set({ fxMix: v });
      case 'time': return this.set(r ? { reverbSize: b(v) } : { delayTime: b(v) });
      case 'spread': return this.set(r ? { reverbTilt: b(v) } : { delayShift: b(v) });
      case 'diffuse': return this.set(r ? { delayRegen: b(v) } : { delayFeedback: b(v) });
      case 'attack': return this.set({ attack: b(v) });
      case 'release': return this.set({ release: b(v) });
      case 'volume': this.adc.volume = v; return this.sendAdc();
      case 'tune': this.adc.tune = v; return this.sendAdc();
      case 'touch': this.touchSensitivity = v; return;
      case 'transpose': {
        // Web drone: while Hold holds captured notes the fader picks the
        // stutter (beat repeat of the output) instead, in 12 zones from the
        // bottom: the plain drone, then faster and faster repeats.
        if (this.drone()) {
          const step = clamp(Math.floor(v * 12), 0, 11);
          if (step === this.stutterStep) return;
          this.stutterStep = step;
          this.send('stutter', { step });
          this.display.show(step ? `stutter ${STUTTER[step][0]}` : 'drone', 600);
          return;
        }
        // pitch_fader::Quantize with range 12 and its hysteresis margin.
        const scaled = v * 24 - 12, current = this.pr.articulationDegreeTranspose;
        if (Math.abs(scaled - current) > 0.5 + 36 / 255) {
          this.set({ articulationDegreeTranspose: Math.round(scaled) });
          this.display.show(`transpose ${Math.round(scaled) > 0 ? '+' : ''}${Math.round(scaled)}`, 600);
        }
        return;
      }
    }
  }

  // ---- LFO assignment (lfo_assignment::Gesture) --------------------------

  // A knob or fader touched while assign is lit toggles its LFO destination;
  // the touch does not move the control.
  touchControl(id) {
    if (!this.lfoLearn.learning) return false;
    const d = this.destinationFor(id);
    if (d !== undefined) { this.toggleLfo(d); this.lfoLearn.touched = true; }
    return true;
  }

  toggleLfo(d) {
    const mask = this.pr.lfoAssigned.slice();
    mask[d >> 3] ^= 1 << (d & 7);
    this.set({ lfoAssigned: mask });
    const on = !!(mask[d >> 3] & (1 << (d & 7)));
    this.display.show(`LFO ${LFO_LABEL[d] || ''}: ${on ? 'on' : 'off'}`, 1000);
  }

  // ---- Buttons ---------------------------------------------------------

  button(id, down) {
    const t = now();
    const b = this.buttons[id] || (this.buttons[id] = {});
    if (down) { b.down = true; b.at = t; b.consumed = false; b.encoderMoved = false; }
    const held = t - (b.at || t);
    if (!down) b.down = false;
    // The envelope and arp menus close on any other button, which then acts as usual.
    const owner = { envelope: 'envelope', arp: 'arp' }[this.page];
    if (owner && down && id !== owner) this.openPage('analyser');
    if (this.lfoLearn.learning && down && id.startsWith('oct')) { this.toggleLfo(DEST.Octave); this.lfoLearn.touched = true; b.consumed = true; return; }

    switch (id) {
      // Tap: change octave (the lit one again: back to 0). Held 300 ms or
      // more (web only): momentary, the release restores the previous octave
      // unless another octave button has changed it meanwhile.
      case 'octDown2': case 'octDown1': case 'octUp1': case 'octUp2': {
        if (down) {
          const index = { octDown2: 1, octDown1: 2, octUp1: 4, octUp2: 5 }[id];
          b.previous = this.pr.octaveIndex;
          b.octave = this.pr.octaveIndex === index ? 3 : index;
          this.set({ octaveIndex: b.octave });
        } else if (!b.consumed && held >= 300 && this.pr.octaveIndex === b.octave) this.set({ octaveIndex: b.previous });
        return;
      }
      case 'hold': return this.call(down ? 'holdDown' : 'holdUp');
      case 'arp':
        if (down) { b.timer = setTimeout(() => { b.consumed = true; this.openPage(this.page === 'arp' ? 'analyser' : 'arp'); }, 300); return; }
        clearTimeout(b.timer);
        if (b.consumed) return;
        if (this.page === 'arp') return this.openPage('analyser');
        return this.call('setTrillo', !this.pr.trilloOn), (this.pr.trilloOn = !this.pr.trilloOn);
      case 'loop': return down && this.loopButton();
      case 'lfoAssign': return this.lfoButton(down);
      case 'lfoWave':
        if (!down) return;
        this.set({ lfoWave: this.pr.lfoWave >= 5 ? 1 : this.pr.lfoWave + 1 });
        return this.display.show(`lfo ${LFO_WAVES[this.pr.lfoWave - 1]}`, 700);
      case 'mode':
        if (!down) return;
        this.set({ spectralMode: (this.pr.spectralMode + 1) % 4 });
        return this.display.show(MODES[this.pr.spectralMode], 900);
      case 'bank': {
        if (!down) return;
        const next = BANK_ORDER[(BANK_ORDER.indexOf(this.pr.oscBank) + 1) % BANK_ORDER.length];
        this.set({ oscBank: next });
        return this.display.show(BANKS[next], 900);
      }
      case 'subOctave':
        // Tap < 350 ms cycles 1/2/4; a hold opens the sub detune page
        // (on the instrument: hold and turn the encoder).
        if (down) { b.timer = setTimeout(() => { b.consumed = true; this.openPage(this.page === 'detune' ? 'analyser' : 'detune'); }, 350); return; }
        clearTimeout(b.timer);
        if (b.consumed) return;
        return this.set({ subOctave: this.pr.subOctave === 1 ? 2 : this.pr.subOctave === 2 ? 4 : 1 });
      case 'delay':
        // delay_freeze::BankButton: hold 1 s reverse, release before switches
        // between the delay and reverb knobs.
        if (down) {
          b.timer = setTimeout(() => {
            b.consumed = true;
            this.set({ delayReverse: this.pr.delayReverse ? 0 : 1 });
            this.display.show(this.pr.delayReverse ? 'delay reverse' : 'delay normal', 1000);
          }, 1000);
          return;
        }
        clearTimeout(b.timer);
        if (b.consumed) return;
        this.reverbBank = !this.reverbBank;
        return this.syncPanel();
      case 'envelope':
        if (!down) return;
        return this.openPage(this.page === 'envelope' ? 'analyser' : 'envelope');
      case 'preset':
        if (!down) return;
        if (this.page === 'preset' && t - (b.lastTap || 0) < 360 && this.presetSnapshot) {
          this.applyPreset(this.presetSnapshot); this.display.show('panel', 900);
        } else this.openPage(this.page === 'preset' ? 'analyser' : 'preset');
        b.lastTap = t;
        return;
      case 'clock':
        if (down) { b.timer = setTimeout(() => { b.consumed = true; this.openPage(this.page === 'bpm' ? 'analyser' : 'bpm'); }, 300); return; }
        clearTimeout(b.timer);
        if (!b.consumed) this.tapTempo(t);
        return;
      case 'system':
        // Former Keyboard button: tap cycles pages, hold 2 s opens System.
        if (down) { b.timer = setTimeout(() => { b.consumed = true; this.openPage('system'); this.systemPage = 'system'; }, 2000); return; }
        clearTimeout(b.timer);
        if (!b.consumed) this.keyboardShortPress();
    }
  }

  keyboardShortPress() {
    const p = this.page;
    if (p === 'system') {
      if (this.systemPage === 'cc') this.systemPage = 'midi';
      else if (this.systemPage !== 'system') this.systemPage = 'system';
      else this.openPage('analyser');
      return;
    }
    if (p === 'analyser') return this.openPage('note');
    return this.openPage('analyser');
  }

  openPage(page) {
    this.page = page;
    for (const m of Object.values(this.menus)) m.editing = false;
    if (page === 'preset') this.presetSnapshot = this.snapshot();
  }

  // Web gesture: a press on assign starts assigning (LED blinking red) and
  // clicks on knobs and faders toggle them; the next press ends. A second
  // press within 400 ms, with nothing toggled, clears every destination.
  lfoButton(down) {
    if (!down) return;
    const l = this.lfoLearn, t = now();
    if (!l.learning) {
      l.learning = true; l.startedAt = t; l.touched = false;
      this.display.show('LFO assign', 900);
      return;
    }
    l.learning = false;
    if (t - l.startedAt < 400 && !l.touched) {
      this.set({ lfoAssigned: new Uint8Array(7) });
      this.display.show('LFO: all cleared', 1000);
    } else this.display.show('LFO assign off', 700);
  }

  tapTempo(t) {
    this.taps = this.taps.filter((x) => t - x < 2000);
    const intervals = [];
    for (let i = 1; i < this.taps.length; i++) intervals.push(this.taps[i] - this.taps[i - 1]);
    const interval = this.taps.length ? t - this.taps[this.taps.length - 1] : 0;
    this.taps.push(t);
    if (!interval || interval < 240 || interval > 1500) return;
    const avg = [...intervals.slice(-5), interval].reduce((a, b) => a + b) / Math.min(6, intervals.length + 1);
    if (Math.abs(interval - avg) > avg * 0.5) { this.taps = [t]; return; }
    this.setBpm(60000 / avg);
    this.bpmFlash = t;
  }

  setBpm(bpm) {
    this.bpm = clamp(Math.round(bpm), 41, 249);
    this.call('setBpm', this.bpm);
  }

  // ---- Screen: mouse in place of the encoder ------------------------------

  // Regions come from the page drawn last: arrows at the right edge of a
  // card step its value, wheel and vertical drag step it too, a click on the
  // rest of the card selects it or runs its action.
  regionAt(x, y) {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
    }
    return null;
  }

  screen(type, x, y, arg, fine) {
    const r = this.regionAt(x, y);
    if (type === 'hover' || type === 'leave') {
      this.panel.canvas.style.cursor = r && (r.click || r.step || r.press) ? 'pointer' : 'default';
      return;
    }
    if (type === 'wheel') { if (r?.step) { r.select?.(); r.step(arg, fine); } return; }
    if (type === 'down') {
      this.pressed = r; this.dragAccum = 0; this.dragged = false;
      r?.select?.();
      r?.press?.(x, y);
      return;
    }
    const p = this.pressed;
    if (type === 'drag' && p) {
      if (p.drag) { p.drag(x, y); this.dragged = true; return; }
      if (!p.step) return;
      this.dragAccum += arg;
      while (Math.abs(this.dragAccum) >= 12) {
        const s = Math.sign(this.dragAccum);
        this.dragAccum -= 12 * s;
        this.dragged = true;
        p.step(s, false);
      }
      return;
    }
    if (type === 'up' && p) {
      this.pressed = null;
      // Regions are rebuilt every frame: the release must land on the same box.
      const same = r && r.x === p.x && r.y === p.y && r.w === p.w && r.h === p.h;
      if (this.dragged || !same) return;
      // Arrows: the two 22 px boxes at the right edge of a stepping card.
      if (p.step && !p.click && x >= p.x + p.w - 44) return p.step(x >= p.x + p.w - 22 ? 1 : -1, false);
      p.click?.();
    }
  }

  edit(page, row, step, fine = false) {
    const pr = this.pr;
    if (page === 'note') {
      const key = this.lastKey;
      if (row === 0) { this.set({ selKeyboard: (pr.selKeyboard + step + SCALES.length) % SCALES.length }); this.customFreq = null; }
      if (row === 1) this.shiftKey(key, step);
      if (row === 2) this.set({ scaleRoot: (pr.scaleRoot + step + 12) % 12 });
      if (row === 3) this.nudgeKey(key, step, fine);
      if (row === 4) { this.set({ keyboardLayout: (pr.keyboardLayout + step + 6) % 6 }); this.customFreq = null; }
      return;
    }
    if (page === 'arp') {
      if (row === 0) this.set({ trilloSpeed: speedForDivision(clamp(divisionIndex(pr.trilloSpeed) + step, 0, 6)) });
      if (row === 1) this.set({ trilloPattern: (pr.trilloPattern + step + PATTERNS.length) % PATTERNS.length });
      if (row === 2) this.set({ trilloHoldPercent: clamp(pr.trilloHoldPercent + step, 1, 100) });
      if (row === 3) this.set({ trilloGroove: (pr.trilloGroove + step + GROOVES.length) % GROOVES.length });
      if (row === 4) this.set({ trilloGrooveAmount: clamp(pr.trilloGrooveAmount + step, 0, 100) });
      return;
    }
    if (page === 'envelope') {
      if (row === 0) this.set({ bandAttackShape: (pr.bandAttackShape + step + 5) % 5 });
      if (row === 1) this.set({ bandSustainMask: sustainMask(clamp(sustainChoice(pr.bandSustainMask) + step, 0, SUSTAIN_CHOICES - 2)) });
      if (row === 2) this.set({ bandReleaseShape: (pr.bandReleaseShape + step + 5) % 5 });
      return;
    }
    if (page === 'midi' && row === 0) this.setMidiChannel((this.midiChannel + step + 17) % 17);
    if (page === 'preset') {
      if (row === 0) this.presetBank = clamp(this.presetBank + step, 0, 31);
      if (row === 1) this.presetSlot = clamp(this.presetSlot + step, 0, SLOTS - 1);
    }
  }

  editCc(row, step) {
    const i = this.ccIndex, pr = this.pr;
    if (row === 0) {
      const at = CC_DESTS.findIndex(([d]) => d === pr.ccAssignDest[i]);
      const dest = pr.ccAssignDest.slice();
      dest[i] = CC_DESTS[(at + step + CC_DESTS.length) % CC_DESTS.length][0];
      this.set({ ccAssignDest: dest });
    } else {
      const amount = pr.ccAssignAmount.slice();
      amount[i] = clamp(amount[i] + step, -100, 100);
      this.set({ ccAssignAmount: amount });
    }
  }

  setMidiChannel(ch) {
    this.midiChannel = ch;
    this.send('prop', { values: { midiChannel: ch } });
    this.onMidiChannel?.(ch);
  }

  // Per-key tuning edits (Keyboard note page).
  keyFrequencies() {
    return this.customFreq || Array.from({ length: KEYS }, (_, k) => frequency(this.pr.selKeyboard, degreeForKey(k, this.pr.keyboardLayout)));
  }
  shiftKey(key, step) {
    const f = this.keyFrequencies().slice(), scale = this.pr.selKeyboard;
    const d = nearestDegree(scale, f[key]);
    f[key] = frequency(scale, d + step) * (f[key] / frequency(scale, d));
    this.applyKeyFrequencies(f);
  }
  // 1 Hz per step, 0.01 Hz with shift + wheel.
  nudgeKey(key, step, fine) {
    const f = this.keyFrequencies().slice();
    f[key] = clamp(f[key] + step * (fine ? 0.01 : 1), 27.5, 6535.5);
    this.applyKeyFrequencies(f);
  }
  applyKeyFrequencies(f) {
    this.customFreq = f;
    this.call('setKeyboardFrequencies', f);
    this.presetDirty = true;
  }

  // ---- Pads, PC keyboard and MIDI -------------------------------------------

  // Real pen/touch pressure, scaled by the touch-sensitivity trimmer
  // (centre = unity, as the key-sensitivity offset of the instrument).
  touchPressure(pressure) {
    const gain = Math.pow(4, (this.touchSensitivity ?? 0.5) * 2 - 1);
    return clamp(1 + Math.round(Math.min(1, pressure * gain) * 254), 1, 255);
  }

  // Keys without real pressure (finger, mouse, PC keyboard) play as a key
  // pressed fully.
  pad(index, action, pressure, source = 'pad') {
    if (action === 'on') {
      this.lastKey = index;
      this.call('keyOn', index, pressure == null ? 255 : this.touchPressure(pressure));
    } else if (action === 'pressure') this.call('keyPressure', index, this.touchPressure(pressure));
    else this.call('keyOff', index);
  }

  // Touch bend from pad index towards target, pos 0..1; off with the
  // arpeggio, as on the instrument. The instrument also turns it off in the
  // preset menu, where its keys pick slots; here the pads still play there.
  bendAllowed() { return !this.pr.trilloOn; }
  padBend(index, target, pos) { if (this.bendAllowed()) this.call('keyBend', index, target, pos); }
  // The finger reached the neighbour: the note moves there. False when the
  // bend is off, so the panel keeps the note on its pad.
  padSlide(index, target) {
    if (!this.bendAllowed()) return false;
    this.call('keySlide', index, target);
    this.lastKey = target;
    return true;
  }

  releaseAllKeys() { for (let k = 0; k < KEYS; k++) this.call('keyOff', k); }

  // MIDI clock at 24 ppqn: tempo from the tick intervals, phase realigned
  // on every beat and on Start; times out after twice the period.
  midiClock(status, time) {
    const c = this.clockIn || (this.clockIn = { ticks: [], count: 0, last: 0 });
    if (status === 0xfa) { c.count = 0; c.ticks = []; c.running = true; this.call('alignBeat'); return; }
    if (status === 0xfc) { c.running = false; return; }
    if (status === 0xfb) { c.running = true; return; }
    if (status !== 0xf8) return;
    c.ticks.push(time);
    if (c.ticks.length > 25) c.ticks.shift();
    c.last = time;
    if (c.count % 24 === 0) this.call('alignBeat');
    c.count++;
    if (c.ticks.length >= 7) {
      const span = c.ticks[c.ticks.length - 1] - c.ticks[0];
      const beatMs = span / (c.ticks.length - 1) * 24;
      if (beatMs >= 200 && beatMs <= 3000 && Math.abs(beatMs - (this.clockMs || 0)) > 1) {
        this.clockMs = beatMs;
        this.bpm = 60000 / beatMs;
        this.call('setClockMs', beatMs);
      }
    }
    this.clockSource = 'midi';
    clearTimeout(c.timeout);
    c.timeout = setTimeout(() => { this.clockSource = 'int'; this.clockMs = 0; this.setBpm(this.bpm || 110); }, Math.max(250, 2 * (this.clockMs || 500)));
  }

  midi(bytes, time = now()) {
    if (bytes[0] >= 0xf8) return this.midiClock(bytes[0], time);
    // Program change recalls presets of the user banks (bank = pc / 24 + 1).
    if ((bytes[0] & 0xf0) === 0xc0) {
      const ch = (bytes[0] & 15) + 1;
      if (!this.midiChannel || ch === this.midiChannel) {
        const bank = Math.floor(bytes[1] / SLOTS) + 1, slot = bytes[1] % SLOTS;
        const data = this.presets.get(bank, slot);
        if (data) { this.presetBank = bank; this.presetSlot = slot; this.applyPreset(data); }
      }
      return;
    }
    this.send('midi', { bytes });
  }

  // ---- Loop: control motion recorder (shared/control_motion.h) -------------
  // Every control has its own cycle: it starts at the control's first movement
  // while armed and ends at the next press, without beat snapping. A new take
  // re-records only the controls moved in it; the other cycles keep playing.

  beatMs() { return 60000 / (this.bpm || 110); }
  loopMaxMs() { return 64 * this.beatMs(); }

  loopState() {
    const L = this.loop;
    for (const lane of L.lanes.values()) if (!lane.length) return 'recording';
    return L.armed ? 'armed' : L.lanes.size ? 'playing' : 'idle';
  }

  loopButton() {
    const L = this.loop, t = now();
    // Double tap (second within 320 ms, nothing moved) clears every cycle.
    L.taps = L.taps.filter((x) => t - x < 320);
    if (L.taps.length && !L.movedSinceTap) {
      L.taps = []; L.armed = false; L.lanes.clear();
      this.display.show('loop cleared', 900);
      return;
    }
    L.taps.push(t); L.movedSinceTap = false;
    if (!L.armed) { L.armed = true; L.completed.clear(); return; }
    // The second press closes the open cycles at once.
    L.armed = false;
    let longest = 0;
    for (const lane of L.lanes.values()) {
      if (lane.length) continue;
      this.loopFinish(lane, t);
      longest = Math.max(longest, lane.length);
    }
    if (longest) this.display.show(`loop ${(longest / this.beatMs()).toFixed(1)} beat`, 900);
  }

  loopFinish(lane, end) {
    lane.length = clamp(end - lane.origin, 1, this.loopMaxMs());
    lane.points = lane.points.filter(([at]) => at < lane.length);
    lane.idx = -1;
  }

  loopRecord(id, v) {
    const L = this.loop, t = now();
    L.movedSinceTap = true;
    const lane = L.lanes.get(id);
    if (!L.armed) { L.lanes.delete(id); return; } // a hand movement deletes only this cycle
    if (L.completed.has(id)) return;
    // The first movement of a control in this take replaces its old cycle.
    if (!lane || lane.length) { L.lanes.set(id, { origin: t, length: 0, points: [[0, v]], idx: -1 }); return; }
    if (t - lane.origin >= this.loopMaxMs()) { this.loopFinish(lane, t); L.completed.add(id); return; }
    lane.points.push([t - lane.origin, v]);
  }

  loopPlay() {
    const L = this.loop, t = now();
    for (const [id, lane] of L.lanes) {
      if (!lane.length) {
        if (t - lane.origin >= this.loopMaxMs()) { this.loopFinish(lane, lane.origin + this.loopMaxMs()); L.completed.add(id); }
        continue;
      }
      const pos = (t - lane.origin) % lane.length;
      let i = 0;
      while (i + 1 < lane.points.length && lane.points[i + 1][0] <= pos) i++;
      if (i === lane.idx) continue;
      lane.idx = i;
      const v = lane.points[i][1];
      this.panel.set(id, v);
      this.control(id, v, true);
    }
  }

  // Cycles for a preset; an open cycle is saved as recorded so far.
  loopClip() {
    const t = now(), lanes = [];
    for (const [id, lane] of this.loop.lanes) {
      const length = lane.length || clamp(t - lane.origin, 1, this.loopMaxMs());
      lanes.push([id, { length, phase: (t - lane.origin) % length, points: lane.points.filter(([at]) => at < length) }]);
    }
    return lanes.length ? { version: 2, lanes } : null;
  }

  loopLoad(clip) {
    const L = this.loop, t = now();
    L.armed = false; L.completed.clear(); L.lanes = new Map();
    for (const [id, lane] of clip?.lanes || []) {
      // Version 1 clips: one shared length, each lane a plain point list.
      const c = Array.isArray(lane) ? { length: clip.length, phase: 0, points: lane } : lane;
      if (c.length > 0 && c.points?.length) L.lanes.set(id, { origin: t - c.phase, length: c.length, points: c.points, idx: -1 });
    }
  }

  // ---- Presets ----------------------------------------------------------

  snapshot() {
    return { pr: { ...this.pr, lfoAssigned: Array.from(this.pr.lfoAssigned) },
      volume: this.adc.volume, tune: this.adc.tune, bpm: this.bpm || 110, customFreq: this.customFreq,
      loop: this.loopClip(), name: this.presetName || '' };
  }

  applyPreset(data) {
    const saved = migratePreset(data.pr);
    const pr = { ...defaultPreset(), ...saved };
    pr.lfoAssigned = Uint8Array.from(saved.lfoAssigned || []);
    pr.latchedNote = this.pr.latchedNote;
    const trillo = pr.trilloOn;
    pr.trilloOn = this.pr.trilloOn;
    this.pr = pr;
    this.send('set', { values: pr });
    if (trillo !== this.pr.trilloOn) { this.call('setTrillo', trillo); this.pr.trilloOn = trillo; }
    this.adc.volume = data.volume ?? this.adc.volume;
    this.adc.tune = data.tune ?? this.adc.tune;
    this.sendAdc();
    if (data.bpm) this.setBpm(data.bpm);
    this.customFreq = data.customFreq || null;
    if (this.customFreq) this.call('setKeyboardFrequencies', this.customFreq);
    this.loopLoad(data.loop);
    this.presetName = data.name || '';
    this.syncPanel();
    this.presetDirty = false;
  }

  loadPreset() {
    const data = this.presets.get(this.presetBank, this.presetSlot);
    if (!data) return this.display.show('empty', 700);
    this.applyPreset(data);
    this.display.show(data.name || `preset ${this.presetSlot + 1}`, 900);
  }

  savePreset() {
    if (this.presetBank === 0) return this.display.show('factory bank', 900);
    const data = this.snapshot();
    data.name = data.name || `${String(this.presetBank).padStart(2, '0')}-${String(this.presetSlot + 1).padStart(2, '0')}`;
    this.presetName = data.name;
    this.presets.put(this.presetBank, this.presetSlot, data);
    this.presetDirty = false;
    this.display.show('saved', 900);
  }

  factoryReset() {
    this.applyPreset({ pr: defaultPreset(), volume: 0.75, tune: 0.5, bpm: 110 });
  }

  exportPresets() {
    const blob = new Blob([JSON.stringify(this.presets.all(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'spettro-presets.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- Status, LEDs and display ----------------------------------------------

  // Web drone: notes captured by a held Hold.
  drone() {
    const s = this.state?.status;
    return !!s && (s.captured.length > 0 || s.midiCaptured);
  }

  status(data) {
    this.state = data;
    // Drone start and end move the transpose fader: to the stutter step,
    // kept from the last drone (the worklet starts it at once), then back
    // to the transpose; the worklet stops the stutter.
    const drone = this.drone();
    if (drone !== !!this.wasDrone) { this.wasDrone = drone; this.syncPanel(); }
    // Fields the controller owns.
    this.pr.latchedNote = data.pr.latchedNote;
    this.pr.trilloOn = data.pr.trilloOn;
    this.bpm = data.status.bpm;
  }

  // Lights and screen at about 30 fps (the status arrives at 30 Hz); a 60 or
  // 120 Hz display would only redraw more, which costs the iPad audio.
  frame() {
    requestAnimationFrame(() => this.frame());
    this.loopPlay();
    const t = now();
    if (t - (this.drawnAt || 0) < 30) return;
    this.drawnAt = t;
    if (!this.state) { this.display.render(null); return; }
    this.leds();
    this.drawDisplay();
  }

  leds() {
    const { status, reply } = this.state, pr = this.pr, p = this.panel, t = now();
    const blink = (ms) => (t % ms) < ms / 2;

    // Bands: steady yellow for the number of filters; while notes sound, the
    // filters take the filter-mode colour and follow their own envelopes.
    // Assigned to the LFO: the count with the LFO offset added, white.
    const bandsLfo = (pr.lfoAssigned[DEST.Bands >> 3] & (1 << (DEST.Bands & 7))) !== 0;
    const amount = 1 + clamp(pr.spectralBands / 255 + (bandsLfo ? status.lfoOutput / 255 : 0), 0, 1) * 7;
    const levels = this.state.bandLevels || [];
    const sounding = levels.some((l) => l > 0.01);
    for (let i = 0; i < 8; i++) {
      const present = i === 0 ? 1 : clamp(amount - i, 0, 1);
      if (!present) p.light(`band${i}`, null);
      else if (sounding) p.light(`band${i}`, levels[i] > 0.01 ? MODE_COLORS[pr.spectralMode] : null, Math.min(1, levels[i]) * present);
      else p.light(`band${i}`, bandsLfo ? LED.white : LED.yellow, present);
    }
    // Delay lines against the base time T, as the firmware display: shorter
    // turquoise, T white, longer orange (saturated at T/4 and 4T); brighter
    // the longer the echo. Yellow when an echo arrives; red while the
    // feedback holds (reported as frozen).
    const taps = this.state.taps || [], hits = this.state.delayHits || 0;
    const count = Math.ceil(amount - 1e-6);
    const sorted = taps.slice(0, count).filter((t) => t > 5).sort((a, b) => a - b);
    const base = ((reply[29] << 8) | reply[30]) || sorted[sorted.length >> 1] || 1;
    const freeze = reply[40] === 0xf2;
    const frozen = freeze ? reply[42] : 0, pending = freeze ? reply[43] : 0;
    for (let i = 0; i < 8; i++) {
      const id = `delay${i}`, bit = 1 << i;
      if (frozen & bit) { p.light(id, LED.red, 1); continue; }
      if (pending & bit) { p.light(id, blink(260) ? LED.red : null, 0.8); continue; }
      const on = i < count && taps[i] > 5;
      if (!on) { p.light(id, null); continue; }
      if (hits & bit) { p.light(id, LED.yellow, 1); continue; }
      const octaves = clamp(Math.log2(taps[i] / base), -2, 2);
      p.light(id, mixColor(LED.white, octaves < 0 ? LED.turquoise : LED.orange, Math.abs(octaves) / 2), 0.35 + 0.65 * (octaves + 2) / 4);
    }
    for (let i = 0; i < 5; i++) p.light(`lfo${i}`, i === pr.lfoWave - 1 ? LED.white : null, 0.35 + 0.65 * status.lfoOutput / 255);
    const anyLfo = pr.lfoAssigned.some((b) => b);
    // Assign: red only while assigning, white when anything is assigned.
    p.light('lfoAssign', this.lfoLearn.learning ? (blink(300) ? LED.red : null) : anyLfo ? LED.white : null);
    p.light('mode', MODE_COLORS[pr.spectralMode]);
    p.light('bank', { 0: LED.white, 1: LED.green, 2: LED.red, 3: LED.blue, 4: LED.orange }[pr.oscBank]);
    const delayMs = (reply[29] << 8) | reply[30];
    // Reverb bank: steady red. Delay bank: a flash per delay time.
    if (this.reverbBank) p.light('delay', LED.red, 0.8);
    else p.light('delay', delayMs > 0 && (t % Math.max(60, delayMs)) < 50 ? (pr.delayReverse ? LED.red : LED.turquoise) : null, 0.8);
    const shaped = pr.bandAttackShape || pr.bandReleaseShape || pr.bandSustainMask !== 0xff;
    // Envelope and arp LEDs blink while their menu is open.
    p.light('envelope', this.page === 'envelope' ? (blink(400) ? LED.yellow : null) : shaped ? LED.yellow : null);
    [1, 2, 4].forEach((d, i) => p.light(`sub${i}`, pr.subOctave === d ? LED.white : null));
    // Transpose LEDs (12, bottom first): + yellow from the bottom, − red from
    // the top; during a drone violet from the bottom up to the stutter zone
    // (one LED: the plain drone).
    const droning = this.drone(), tr = pr.articulationDegreeTranspose;
    for (let i = 0; i < 12; i++) {
      const on = droning ? i <= this.stutterStep : tr > 0 ? i < tr : tr < 0 && i >= 12 + tr;
      p.light(`transpose${i}`, on ? (droning ? LED.violet : tr > 0 ? LED.yellow : LED.red) : null);
    }
    p.light('preset', this.page === 'preset' || this.presetName ? (this.presetDirty && this.presetName ? LED.red : LED.turquoise) : null);
    // Clock: yellow flash on the beat, steady while the BPM page is open.
    p.light('clock', this.page === 'bpm' || status.clockPhase < 40 ? LED.yellow : null);
    p.light('system', this.page === 'system' || this.page === 'note' ? LED.yellow : null);
    const oct = { octDown2: 1, octDown1: 2, octUp1: 4, octUp2: 5 };
    for (const [id, index] of Object.entries(oct)) p.light(id, pr.octaveIndex === index ? LED.yellow : null, Math.abs(index - 3) === 2 ? 1 : 0.7);
    p.light('hold', status.latched ? LED.red : status.captured.length || status.midiCaptured ? LED.violet : null);
    p.light('arp', this.page === 'arp' ? (blink(400) ? LED.turquoise : null)
      : status.trilloOn ? (status.arpPaused ? (blink(500) ? LED.turquoise : null) : LED.turquoise) : null);
    const L = this.loopState();
    p.light('loop', L === 'armed' ? (blink(400) ? LED.orange : null) : L === 'recording' ? LED.red : L === 'playing' ? LED.blue : null);

    // Rings and bars: yellow up to the value; LFO knobs white; a control
    // assigned to the LFO white, with the LFO offset added (lfo_assignment
    // Offset, reported in TX[34]); a control played by the loop blue; the
    // three knobs by Δt red in the reverb bank.
    const pos = this.positions(), lfo = status.lfoOutput / 255;
    for (const id of p.valueLights()) {
      const d = this.destinationFor(id);
      const assigned = d !== undefined && (pr.lfoAssigned[d >> 3] & (1 << (d & 7))) !== 0;
      const looped = this.loop.lanes.get(id)?.length > 0;
      const reverb = this.reverbBank && (id === 'time' || id === 'spread' || id === 'diffuse');
      const drone = id === 'transpose' && this.drone();
      const color = id === 'amount' || id === 'speed' || assigned ? LED.white : looped ? LED.blue : reverb ? LED.red
        : drone ? LED.violet : null;
      p.indicate(id, clamp(pos[id] + (assigned ? lfo : 0), 0, 1), color);
    }

    // Pads: envelope level in yellow (red above 235), arpeggio stack in white.
    const lit = new Array(KEYS).fill(null);
    for (const k of status.stack) lit[k] = [LED.white, 0.25];
    for (const k of status.captured) lit[k] = [LED.violet, 0.6];
    for (const v of status.voices) if (v.key < KEYS && (v.gate || v.env > 2)) lit[v.key] = [v.env > 235 ? LED.red : LED.yellow, 0.25 + 0.75 * v.env / 255];
    for (let k = 0; k < KEYS; k++) if (status.keys[k] && !lit[k]) lit[k] = [LED.yellow, 0.35];
    // Slides take over, as SlideLeds (shared/slide_leds.h): the visited pads
    // dim turquoise, the two pads under the finger pulsing turquoise (400 ms,
    // split by the position), the note's own pad light violet.
    if (this.bendAllowed()) {
      const level = new Array(KEYS).fill(0), origin = new Array(KEYS).fill(false);
      const light = (k, l) => { if (k >= 0 && l > level[k]) level[k] = l; };
      for (const s of p.slides.values()) {
        if (!s.trail) continue;
        const phase = (t - s.started) % 400, wave = phase < 200 ? 200 - phase : phase - 200;
        const pulse = 40 + wave * 180 / 200;
        for (const k of s.trail) light(k, 22);
        origin[s.origin] = true;
        light(s.origin, 30 + wave * 45 / 200);
        light(s.at, 22 + (pulse - 22) * (1 - s.pos));
        if (s.bendTo >= 0) light(s.bendTo, 22 + (pulse - 22) * s.pos);
      }
      // LED levels 0..255 to pad-light opacity (the screen needs a floor).
      for (let k = 0; k < KEYS; k++) if (level[k]) lit[k] = [origin[k] ? LED.violet : LED.turquoise, Math.min(1, 0.15 + 0.85 * level[k] / 220)];
    }
    for (let k = 0; k < KEYS; k++) p.padLight(k, lit[k]?.[0], lit[k]?.[1] ?? 0);
  }

  drawDisplay() {
    const d = this.display, ctx = d.ctx, pr = this.pr, s = this.state;
    const page = this.page;
    this.regions = [];
    if (page === 'analyser') { d.render({ ...s, pr }); return; }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 240, 240);
    const back = () => this.openPage('analyser');
    if (page === 'note') this.regions = this.drawNote(ctx);
    else if (page === 'bpm') {
      this.regions = P.drawBpmPage(ctx, { bpm: Math.round(this.bpm || 110), ms: Math.trunc(60000 / (this.bpm || 110)),
        source: this.clockSource || 'int', flash: now() - this.bpmFlash < 150 }, (n) => this.setBpm((this.bpm || 110) + n));
    } else if (page === 'preset') this.regions = this.drawPreset(ctx);
    else if (page === 'arp') this.regions = this.drawArp(ctx);
    else if (page === 'envelope') this.regions = this.drawEnvelope(ctx);
    else if (page === 'system') this.regions = this.drawSystem(ctx);
    else if (page === 'detune') {
      this.regions = P.drawDetunePage(ctx, pr.subDetuneCents,
        (cents) => this.set({ subDetuneCents: clamp(Math.round(cents), -100, 100) }), back);
    }
    if (d.message && now() < d.message.until) d.drawMessage(d.message.text);
  }

  drawNote(ctx) {
    const pr = this.pr, key = this.lastKey, f = this.keyFrequencies()[key];
    const scale = SCALES[pr.selKeyboard];
    const degree = nearestDegree(pr.selKeyboard, f);
    const midi = 69 + 12 * Math.log2(f / 440);
    const n = Math.round(midi), cents = Math.round((midi - n) * 100);
    return P.drawNotePage(ctx, Object.assign(this.menus.note, {
      key, scale: scale.name, note: `${NOTE_NAMES[((n + pr.scaleRoot) % 12 + 12) % 12]}${Math.floor((n + pr.scaleRoot) / 12) - 1}`,
      root: NOTE_NAMES[pr.scaleRoot], freqLabel: 'cents', freq: `${cents >= 0 ? '+' : ''}${cents} ct  ${f.toFixed(1)}`,
      layout: LAYOUT_NAMES[pr.keyboardLayout], voices: this.state.status.voices, degree,
    }), (row, step, fine) => this.edit('note', row, step, fine));
  }

  drawPreset(ctx) {
    const m = this.menus.preset;
    const used = Array.from({ length: SLOTS }, (_, i) => !!this.presets.get(this.presetBank, i));
    const data = this.presets.get(this.presetBank, this.presetSlot);
    return P.drawPresetPage(ctx, Object.assign(m, { bank: this.presetBank, slot: this.presetSlot, name: data?.name || '',
      used, dirty: this.presetDirty, hint: 'pick a slot, then load or save' }), {
      bank: (n) => { this.presetBank = clamp(this.presetBank + n, 0, 31); },
      slot: (n) => { this.presetSlot = clamp(this.presetSlot + n, 0, SLOTS - 1); },
      pick: (i) => { this.presetSlot = i; m.row = 1; },
      load: () => this.loadPreset(),
      save: () => this.savePreset(),
    });
  }

  // Stepping row of a list page.
  stepper(page, row) { return { step: (n, fine) => this.edit(page, row, n, fine) }; }

  drawArp(ctx) {
    const pr = this.pr, s = (row) => this.stepper('arp', row);
    return P.drawListPage(ctx, 'arpeggio', this.menus.arp, [
      ['tempo', DIVISIONS[divisionIndex(pr.trilloSpeed)], s(0)], ['pattern', PATTERNS[pr.trilloPattern], s(1)],
      ['hold', `${pr.trilloHoldPercent}%`, s(2)], ['groove', GROOVES[pr.trilloGroove].name, s(3)],
      ['amount', `${pr.trilloGrooveAmount}%`, s(4)],
    ], pr.trilloOn ? 'on' : 'off');
  }

  drawEnvelope(ctx) {
    const pr = this.pr, s = (row) => this.stepper('envelope', row);
    return P.drawListPage(ctx, 'envelope', this.menus.envelope, [
      ['attack', SHAPES[pr.bandAttackShape], s(0)], ['sustain', sustainLabel(sustainChoice(pr.bandSustainMask)), s(1)],
      ['release', SHAPES[pr.bandReleaseShape], s(2)],
    ]);
  }

  drawSystem(ctx) {
    const sp = this.systemPage, pr = this.pr;
    const go = (page) => ({ click: () => { this.systemPage = page; } });
    const toSystem = () => { this.systemPage = 'system'; };
    if (sp === 'system') {
      return P.drawListPage(ctx, 'system', this.menus.system, [
        ['midi', `ch ${this.midiChannel || 'omni'}`, go('midi')],
        ['keyboard', SCALES[pr.selKeyboard].name, { click: () => { this.openPage('note'); } }],
        ['setup', '', go('setup')]], 'web', () => this.openPage('analyser'));
    }
    if (sp === 'midi') {
      const label = (i) => CC_DESTS.find(([d]) => d === pr.ccAssignDest[i])?.[1] || 'none';
      return P.drawListPage(ctx, 'midi', this.menus.midi, [
        ['channel', this.midiChannel ? `ch${this.midiChannel}` : 'omni', this.stepper('midi', 0)],
        ...[0, 1, 2, 3].map((i) => [`cc${i + 1}`, label(i), { click: () => { this.ccIndex = i; this.systemPage = 'cc'; } }])],
      '', toSystem);
    }
    if (sp === 'cc') {
      const i = this.ccIndex, m = this.menus.cc || (this.menus.cc = { row: 0 });
      return P.drawListPage(ctx, `cc${i + 1}`, m, [
        ['destination', CC_DESTS.find(([d]) => d === pr.ccAssignDest[i])?.[1] || 'none', { step: (n) => this.editCc(0, n) }],
        ['amount', `${pr.ccAssignAmount[i]}%`, { step: (n) => this.editCc(1, n) }]], '', () => { this.systemPage = 'midi'; });
    }
    // Audio check (web): engine load over the last second and the worst
    // render quantum, both in % of the time available; output latency, and a
    // tap that switches to the larger, safer buffer (reloads the page).
    const load = this.state?.load, c = this.ctx;
    const latency = c ? Math.round(((c.baseLatency || 0) + (c.outputLatency || 0)) * 1000) : 0;
    const safe = this.latencyHint() === 'playback';
    return P.drawListPage(ctx, 'setup', this.menus.setup, [
      ['fact. reset', '', { click: () => { this.factoryReset(); this.display.show('factory reset', 1000); } }],
      ['export presets', '', { click: () => this.exportPresets() }],
      ['audio load', load ? `${Math.round(load.load * 100)}% pk ${Math.round(load.peak * 100)}%` : '-'],
      [safe ? 'latency safe' : 'latency low', c ? `${latency}ms ${c.sampleRate / 1000}k` : '-', { click: () => this.setLatencyHint(safe ? 'interactive' : 'playback') }]],
    '', toSystem);
  }

  // Audio buffer: 'interactive' (lowest latency) or 'playback' (larger and
  // safer against crackles on slow or busy devices). Read at audio start.
  latencyHint() {
    try { return localStorage.getItem(LATENCY_KEY) === 'playback' ? 'playback' : 'interactive'; } catch { return 'interactive'; }
  }

  setLatencyHint(hint) {
    try { localStorage.setItem(LATENCY_KEY, hint); } catch { /* not stored: stays as it is */ }
    location.reload();
  }
}
