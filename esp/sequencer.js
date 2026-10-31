// Web step sequencer (notes/seq_spec.md), run by the controller in the
// AudioWorklet on its clock. Up to 24 steps of pad keys (chords up to the
// voices), each with pressure, gate and tie. Its notes take voices like the
// keyboard, follow octave, transpose and root, and are the first stolen.
//
// Recording (arp + rec): with the sequence stopped, step by step (a pad or
// chord writes a step and moves on, Hold a rest, a pad held + Hold a tie);
// while it plays, live, quantized to the nearest step after one bar of
// count-in, adding to or replacing the steps (seqOverdub).

export const STEPS = 24;
const MAX_KEYS = 5;
// Step length: name and beats.
export const DIVISIONS = [['1/4', 1], ['1/8', 0.5], ['1/8T', 1 / 3], ['1/16', 0.25], ['1/16T', 1 / 6], ['1/32', 0.125]];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const emptyStep = () => ({ keys: [], on: true, tie: false, pressure: 255, gate: 50 });

// Steps from a preset (or nothing): always 24, values in range.
export function cleanSteps(list) {
  return Array.from({ length: STEPS }, (_, i) => {
    const s = list?.[i] || {};
    return { keys: (s.keys || []).filter((k) => k >= 0 && k < 24).slice(0, MAX_KEYS), on: s.on !== false,
      tie: !!s.tie, pressure: clamp(Math.round(s.pressure ?? 255), 1, 255), gate: clamp(Math.round(s.gate ?? 50), 1, 100) };
  });
}

export class Sequencer {
  constructor(controller) {
    this.c = controller;
    this.steps = cleanSteps();
    this.version = 1;       // bumped on every pattern change, for the panel copy
    this.playing = false;
    this.pos = 0;           // next step to play
    this.gridAt = 0;        // its time on the grid (before swing)
    this.sounding = [];     // { key, offAt, tie }
    this.rec = 'off';       // 'off', 'step' or 'live'
    this.recPos = 0;        // step record: the step being written
    this.countUntil = 0;    // live record: end of the count-in bar
    this.chord = null;      // step record: keys held for this step
    this.held = new Map();  // live record: key -> { step, at }
    this.replaced = new Set(); // live replace: steps already cleared in this pass
    this.skip = new Map();  // step -> keys just played live, not repeated in this pass
  }

  length() { return clamp(Math.round(this.c.pr.seqLength), 1, STEPS); }
  stepMs() { return this.c.clockTimeMs * DIVISIONS[clamp(this.c.pr.seqDivision, 0, DIVISIONS.length - 1)][1]; }
  // Swing delays the odd steps, up to half a step.
  swing(i) { return i & 1 ? this.stepMs() * clamp(this.c.pr.seqSwing, 0, 100) / 200 : 0; }
  changed() { this.version++; }

  // ---- Transport ---------------------------------------------------------

  // With an external clock the start waits for the next beat; with the
  // internal one it starts at once and the beat follows the sequence.
  play(on, quantize = false) {
    if (on === this.playing) return;
    const c = this.c;
    if (!on) {
      this.playing = false;
      this.release();
      if (this.rec === 'live') this.stopRecord();
      return;
    }
    this.playing = true;
    this.pos %= this.length();
    if (quantize) this.gridAt = c.clockStart + Math.ceil((c.timeMs - c.clockStart) / c.clockTimeMs) * c.clockTimeMs;
    else {
      this.gridAt = c.timeMs;
      if (this.pos === 0) c.alignBeat();
    }
  }

  // Double tap on Hold, MIDI Start: from step 1.
  restart(quantize = false) {
    this.play(false);
    this.pos = 0;
    this.play(true, quantize);
  }

  release() {
    for (const n of this.sounding) this.c.seqVoiceOff(n.key);
    this.sounding = [];
  }

  tick() {
    const c = this.c, now = c.timeMs;
    if (!c.pr.seqMode) {
      if (this.playing) this.play(false);
      if (this.rec !== 'off') this.stopRecord();
      return;
    }
    for (const n of this.sounding) if (!n.tie && now >= n.offAt) { c.seqVoiceOff(n.key); n.off = true; }
    if (this.sounding.some((n) => n.off)) this.sounding = this.sounding.filter((n) => !n.off);
    if (!this.playing) return;
    const ms = this.stepMs(), len = this.length();
    this.pos %= len;
    if (now - this.gridAt > 2 * ms + 50) this.gridAt = now; // fell behind (tempo jump)
    while (now >= this.gridAt + this.swing(this.pos)) {
      this.fire(this.pos, ms);
      this.pos = (this.pos + 1) % len;
      if (this.pos === 0) this.replaced.clear();
      this.gridAt += ms;
    }
  }

  // A step: notes of the step before end (tied ones that repeat carry on),
  // its own notes start for gate % of the step (a tie holds them).
  fire(i, ms) {
    const c = this.c, s = this.steps[i], keys = s.on ? s.keys : [];
    const skip = this.skip.get(i);
    this.skip.delete(i);
    const carried = [];
    for (const n of this.sounding) {
      if (n.tie && keys.includes(n.key)) carried.push(n);
      else c.seqVoiceOff(n.key);
    }
    this.sounding = [];
    const offAt = c.timeMs + ms * s.gate / 100;
    for (const key of keys) {
      const n = carried.find((x) => x.key === key);
      if (n) { n.tie = s.tie; n.offAt = offAt; this.sounding.push(n); continue; }
      if (skip?.has(key)) continue;
      c.seqVoiceOn(key, s.pressure);
      this.sounding.push({ key, tie: s.tie, offAt });
    }
  }

  // A held step pad on the panel: its notes once, with the sequence stopped.
  audition(i) {
    if (this.playing || i < 0 || i >= STEPS) return;
    this.release();
    this.fire(i, this.stepMs());
    for (const n of this.sounding) n.tie = false;
  }

  // ---- Recording -----------------------------------------------------------

  record() {
    this.held.clear(); this.chord = null; this.replaced.clear(); this.skip.clear();
    if (this.playing) {
      this.rec = 'live';
      this.countUntil = this.c.timeMs + 4 * this.c.clockTimeMs;
    } else {
      this.rec = 'step';
      this.recPos = 0;
    }
    this.changed();
  }

  stopRecord() {
    for (const [key, h] of [...this.held]) this.lengthen(h, key);
    this.held.clear();
    this.chord = null;
    this.rec = 'off';
    this.changed();
  }

  keyOn(key, pressure) {
    if (this.rec === 'live') {
      const c = this.c;
      if (c.timeMs < this.countUntil) return;
      const len = this.length();
      // The nearest step: the one about to play (then not repeated in this
      // pass, the note is already sounding) or the one that just played.
      const next = this.gridAt - c.timeMs < this.stepMs() / 2;
      const step = next ? this.pos : (this.pos + len - 1) % len;
      if (next) (this.skip.get(step) || this.skip.set(step, new Set()).get(step)).add(key);
      this.write(step, key, pressure, !c.pr.seqOverdub);
      this.held.set(key, { step, at: c.timeMs });
    } else if (this.rec === 'step') {
      if (!this.chord) {
        this.chord = new Set();
        this.steps[this.recPos] = { ...emptyStep(), pressure };
      }
      this.chord.add(key);
      this.write(this.recPos, key, pressure, false);
    }
  }

  keyOff(key) {
    if (this.rec === 'live') {
      const h = this.held.get(key);
      if (!h) return;
      this.held.delete(key);
      this.lengthen(h, key);
    } else if (this.rec === 'step' && this.chord?.delete(key) && !this.chord.size) {
      this.chord = null;
      this.advance();
    }
  }

  // Hold during step record: a rest, or with keys held a tie (the held
  // notes go on into the next step).
  rest() {
    if (this.rec !== 'step') return;
    if (this.chord) {
      const s = this.steps[this.recPos];
      s.tie = true;
      this.advance();
      this.steps[this.recPos] = { ...emptyStep(), keys: s.keys.slice(), pressure: s.pressure, gate: s.gate };
    } else {
      this.steps[this.recPos] = emptyStep();
      this.advance();
    }
    this.changed();
  }

  advance() { this.recPos = (this.recPos + 1) % this.length(); this.changed(); }

  write(i, key, pressure, replace) {
    let s = this.steps[i];
    if (replace && !this.replaced.has(i)) { s = this.steps[i] = emptyStep(); this.replaced.add(i); }
    if (!s.keys.includes(key) && s.keys.length < MAX_KEYS) {
      s.keys.push(key);
      if (s.keys.length === 1) s.pressure = pressure;
    }
    s.on = true;
    this.changed();
  }

  // A live note released: its gate, or ties over the steps it lasted.
  lengthen(h, key) {
    const ms = this.stepMs(), len = this.length();
    const duration = this.c.timeMs - h.at;
    const spanned = clamp(Math.round(duration / ms), 1, len);
    for (let j = 1; j < spanned; j++) {
      this.steps[(h.step + j - 1) % len].tie = true;
      this.write((h.step + j) % len, key, this.steps[h.step].pressure, false);
    }
    const last = this.steps[(h.step + spanned - 1) % len];
    last.gate = clamp(Math.round((duration - (spanned - 1) * ms) / ms * 100), 5, 100);
    this.changed();
  }

  // ---- Editing -----------------------------------------------------------

  // Tap on a step pad: on / off; an empty step gets the last played key.
  toggleStep(i, key) {
    const s = this.steps[i];
    if (!s) return;
    if (!s.keys.length) { s.keys = [clamp(key, 0, 23)]; s.on = true; } else s.on = !s.on;
    this.changed();
  }

  editStep(i, values) {
    const s = this.steps[i];
    if (!s) return;
    if ('pressure' in values) s.pressure = clamp(Math.round(values.pressure), 1, 255);
    if ('gate' in values) s.gate = clamp(Math.round(values.gate), 1, 100);
    if ('tie' in values) s.tie = !!values.tie;
    if ('on' in values) s.on = !!values.on;
    if (values.clear) Object.assign(s, emptyStep());
    this.changed();
  }

  load(steps) { this.steps = cleanSteps(steps); this.changed(); }
  clear() { this.steps = cleanSteps(); this.changed(); }

  // For the panel: transport, recording and where the pattern is (the steps
  // themselves only when they changed).
  status(withSteps) {
    const len = this.length(), ms = this.stepMs(), pattern = len * ms;
    const elapsed = this.pos * ms - (this.gridAt - this.c.timeMs);
    return {
      playing: this.playing, rec: this.rec, recPos: this.recPos,
      counting: this.rec === 'live' && this.c.timeMs < this.countUntil,
      current: this.playing ? (this.pos + len - 1) % len : this.pos,
      phaseMs: this.playing ? ((elapsed % pattern) + pattern) % pattern : 0, patternMs: pattern,
      version: this.version, steps: withSteps ? this.steps.map((s) => ({ ...s, keys: s.keys.slice() })) : undefined,
    };
  }
}
