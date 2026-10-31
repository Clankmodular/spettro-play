// Web step sequencer (notes/seq_spec.md), run by the controller in the
// AudioWorklet on its clock. Up to 24 steps of pad keys (chords up to the
// voices), each with pressure, gate and tie. Its notes take voices like the
// keyboard, follow octave, transpose and root, and are the first stolen.
//
// Recording (rec in seq mode): with the sequence stopped, step by step (a pad or
// chord writes a step and moves on, Hold a rest, a pad held + Hold a tie);
// while it plays, live at once, quantized to the nearest step, adding to
// or replacing the steps (seqOverdub). Live, the slides of each note are
// kept too: bends: { key: [[t, from, to, pos], ...] } on its first step, t
// in steps from the note's start, from the pad it is on, to the pad it
// bends towards (255 none), pos 0..1, as the keyboard's touch bend.

export const STEPS = 24;
const MAX_KEYS = 5;
// Step length: name and beats.
export const DIVISIONS = [['1/4', 1], ['1/8', 0.5], ['1/8T', 1 / 3], ['1/16', 0.25], ['1/16T', 1 / 6], ['1/32', 0.125]];
// Play directions, as on the OXI One MKII (pr.seqDirection).
export const DIRECTIONS = ['forward', 'backward', 'pendulum', 'random'];
const BACKWARD = 1, PENDULUM = 2, RANDOM = 3;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// oct: the keyboard octave (octaveIndex) the step was written at; the
// sequence plays it moved by its own octave (pr.seqOctave), not the keyboard's.
export const emptyStep = () => ({ keys: [], oct: 3, on: true, tie: false, pressure: 255, gate: 50 });

// Slides of the keys still in a step (none: undefined).
function cleanBends(bends, keys) {
  if (!bends) return undefined;
  const out = {};
  for (const k of keys) {
    const points = bends[k];
    if (!Array.isArray(points) || !points.length) continue;
    out[k] = points.filter((p) => p?.length === 4).slice(0, 4000).map(([t, from, to, pos]) =>
      [Math.max(0, +t || 0), clamp(from | 0, 0, 23), to >= 0 && to < 24 ? to | 0 : 255, clamp(+pos || 0, 0, 1)]);
  }
  return Object.keys(out).length ? out : undefined;
}

// Steps from a preset (or nothing): always 24, values in range.
export function cleanSteps(list) {
  return Array.from({ length: STEPS }, (_, i) => {
    const s = list?.[i] || {};
    const keys = (s.keys || []).filter((k) => k >= 0 && k < 24).slice(0, MAX_KEYS);
    return { keys, oct: clamp(Math.round(s.oct ?? 3), 0, 6), on: s.on !== false, tie: !!s.tie,
      pressure: clamp(Math.round(s.pressure ?? 255), 1, 255), gate: clamp(Math.round(s.gate ?? 50), 1, 100),
      bends: cleanBends(s.bends, keys) };
  });
}

export class Sequencer {
  constructor(controller) {
    this.c = controller;
    this.steps = cleanSteps();
    this.version = 1;       // bumped on every pattern change, for the panel copy
    this.playing = false;
    this.pos = 0;           // next step to play
    this.last = 0;          // the step played last
    this.way = 1;           // pendulum: going up or down
    this.count = 0;         // steps played since step 1, for swing and the pattern phase
    this.rng = 0x9e3779b9;  // random direction
    this.gridAt = 0;        // its time on the grid (before swing)
    this.sounding = [];     // { key, tag (its voice), offAt, tie, at, bend, idx }
    this.rec = 'off';       // 'off', 'step' or 'live'
    this.recPos = 0;        // step record: the step being written
    this.chord = null;      // step record: keys held for this step
    this.held = new Map();  // live record: key -> { step, at, cur (pad it is on now), points }
    this.replaced = new Set(); // live replace: steps already cleared in this pass
    this.skip = new Map();  // step -> keys just played live, not repeated in this pass
    this.captured = false;  // Hold held over it (keyboard view): a drone of its notes
  }

  length() { return clamp(Math.round(this.c.pr.seqLength), 1, STEPS); }
  stepMs() { return this.c.clockTimeMs * DIVISIONS[clamp(this.c.pr.seqDivision, 0, DIVISIONS.length - 1)][1]; }
  direction() { return clamp(this.c.pr.seqDirection | 0, 0, DIRECTIONS.length - 1); }
  // Swing delays every second step played, up to half a step.
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
      this.captured = false;
      this.release();
      if (this.rec === 'live') this.stopRecord();
      return;
    }
    this.playing = true;
    this.pos %= this.length();
    if (this.pos === this.first()) this.count = 0;
    if (quantize) this.gridAt = c.clockStart + Math.ceil((c.timeMs - c.clockStart) / c.clockTimeMs) * c.clockTimeMs;
    else {
      this.gridAt = c.timeMs;
      if (!this.count) c.alignBeat();
    }
  }

  // Double tap on Hold, MIDI Start: from the start (the last step backward).
  restart(quantize = false) {
    this.play(false);
    this.pos = this.first();
    this.way = 1;
    this.count = 0;
    this.play(true, quantize);
  }

  first() { return this.direction() === BACKWARD ? this.length() - 1 : 0; }

  // The step after i in the play direction. Pendulum turns at the ends
  // without playing them twice.
  next(i, len) {
    switch (this.direction()) {
      case BACKWARD: return (i + len - 1) % len;
      case PENDULUM:
        if (len < 2) return 0;
        if (i + this.way < 0 || i + this.way >= len) this.way = -this.way;
        return clamp(i + this.way, 0, len - 1);
      case RANDOM: {
        let r = this.rng;
        r ^= r << 13; r >>>= 0; r ^= r >>> 17; r ^= r << 5; r >>>= 0;
        this.rng = r;
        return r % len;
      }
      default: return (i + 1) % len;
    }
  }

  release() {
    for (const n of this.sounding) this.c.seqVoiceOff(n.tag);
    this.sounding = [];
  }

  // Hold pressed on the keyboard view while it plays: its notes join the
  // drone until Hold is released; then they end and it plays on. Caught
  // between two notes, the step played last sounds again for the drone.
  capture(on) {
    if (on === this.captured || (on && !this.playing)) return;
    if (on && !this.sounding.length) this.fire(this.last, this.stepMs());
    this.captured = on;
    if (!on) this.release();
  }

  tick() {
    const c = this.c, now = c.timeMs;
    if (!c.pr.seqMode) {
      if (this.playing) this.play(false);
      if (this.rec !== 'off') this.stopRecord();
      return;
    }
    // Captured by Hold: the notes sounding stay (a drone, the stutter repeats
    // it) and the steps go on silently, so it comes back in time.
    if (!this.captured) for (const n of this.sounding) if (!n.tie && now >= n.offAt) { c.seqVoiceOff(n.tag); n.off = true; }
    if (this.sounding.some((n) => n.off)) this.sounding = this.sounding.filter((n) => !n.off);
    const ms = this.stepMs();
    // Recorded slides, on the step's time (so they follow the tempo).
    if (!this.captured) for (const n of this.sounding) {
      if (!n.bend) continue;
      const t = (now - n.at) / ms;
      let i = n.idx;
      while (i + 1 < n.bend.length && n.bend[i + 1][0] <= t) i++;
      if (i === n.idx) continue;
      n.idx = i;
      const [, from, to, pos] = n.bend[i];
      c.seqVoiceBend(n.tag, from, to, pos);
    }
    if (!this.playing) return;
    const len = this.length();
    this.pos %= len;
    if (now - this.gridAt > 2 * ms + 50) this.gridAt = now; // fell behind (tempo jump)
    while (now >= this.gridAt + this.swing(this.count)) {
      if (!this.captured) this.fire(this.pos, ms);
      this.last = this.pos;
      this.pos = this.next(this.pos, len);
      this.count++;
      if (this.count % len === 0) this.replaced.clear();
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
      else c.seqVoiceOff(n.tag);
    }
    this.sounding = [];
    const offAt = c.timeMs + ms * s.gate / 100;
    for (const key of keys) {
      const n = carried.find((x) => x.key === key);
      if (n) { n.tie = s.tie; n.offAt = offAt; this.sounding.push(n); continue; }
      if (skip?.has(key)) continue;
      const tag = c.seqVoiceOn(key, s.pressure, s.oct);
      this.sounding.push({ key, tag, tie: s.tie, offAt, at: c.timeMs, bend: s.bends?.[key], idx: -1 });
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
    if (this.playing) this.rec = 'live';
    else {
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
      // The nearest step: the one about to play (then not repeated in this
      // pass, the note is already sounding) or the one that just played.
      const next = this.gridAt - c.timeMs < this.stepMs() / 2;
      const step = next ? this.pos : this.last;
      if (next) (this.skip.get(step) || this.skip.set(step, new Set()).get(step)).add(key);
      this.write(step, key, pressure, !c.pr.seqOverdub);
      this.held.set(key, { step, at: c.timeMs, cur: key, points: [] });
    } else if (this.rec === 'step') {
      if (!this.chord) {
        this.chord = new Set();
        this.steps[this.recPos] = { ...emptyStep(), pressure, oct: this.c.pr.octaveIndex };
      }
      this.chord.add(key);
      this.write(this.recPos, key, pressure, false);
    }
  }

  keyOff(key) {
    if (this.rec === 'live') {
      const [first, h] = this.heldOn(key);
      if (!h) return;
      this.held.delete(first);
      this.lengthen(h, first);
    } else if (this.rec === 'step' && this.chord?.delete(key) && !this.chord.size) {
      this.chord = null;
      this.advance();
    }
  }

  // A live note by the pad it is on now (a slide moves it): [first key, entry].
  heldOn(key) {
    for (const entry of this.held) if (entry[1].cur === key) return entry;
    return [];
  }

  // Touch bend and slide of a held key while recording live: points of its curve.
  bend(key, to, pos) {
    const h = this.rec === 'live' && this.heldOn(key)[1];
    if (!h) return;
    const t = (this.c.timeMs - h.at) / this.stepMs(), last = h.points[h.points.length - 1];
    to = pos > 0 ? to : 255;
    if (last && last[1] === key && last[2] === to && last[3] === pos) return;
    if (last && last[0] === t) h.points.pop();
    h.points.push([t, key, to, pos]);
  }

  slide(key, to) {
    const h = this.rec === 'live' && this.heldOn(key)[1];
    if (!h) return;
    h.cur = to;
    h.points.push([(this.c.timeMs - h.at) / this.stepMs(), to, 255, 0]);
  }

  // Hold during step record: a rest, or with keys held a tie (the held
  // notes go on into the next step).
  rest() {
    if (this.rec !== 'step') return;
    if (this.chord) {
      const s = this.steps[this.recPos];
      s.tie = true;
      this.advance();
      this.steps[this.recPos] = { ...emptyStep(), keys: s.keys.slice(), oct: s.oct, pressure: s.pressure, gate: s.gate };
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
      if (s.keys.length === 1) { s.pressure = pressure; s.oct = this.c.pr.octaveIndex; }
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
    const first = this.steps[h.step];
    if (h.points.length && first.keys.includes(key)) first.bends = { ...first.bends, [key]: h.points };
    this.changed();
  }

  // ---- Editing -----------------------------------------------------------

  // Tap on a step pad: on / off; an empty step gets the last played key.
  toggleStep(i, key) {
    const s = this.steps[i];
    if (!s) return;
    if (!s.keys.length) { s.keys = [clamp(key, 0, 23)]; s.oct = this.c.pr.octaveIndex; s.on = true; } else s.on = !s.on;
    this.changed();
  }

  editStep(i, values) {
    const s = this.steps[i];
    if (!s) return;
    if ('pressure' in values) s.pressure = clamp(Math.round(values.pressure), 1, 255);
    if ('gate' in values) s.gate = clamp(Math.round(values.gate), 1, 100);
    if ('tie' in values) s.tie = !!values.tie;
    if ('on' in values) s.on = !!values.on;
    if ('keys' in values) {
      s.keys = [...new Set(values.keys)].filter((k) => k >= 0 && k < 24).slice(0, MAX_KEYS);
      s.bends = cleanBends(s.bends, s.keys); // a note moved by hand loses its slide
    }
    if ('oct' in values) s.oct = clamp(Math.round(values.oct), 0, 6);
    if (values.clear) Object.assign(s, emptyStep());
    this.changed();
  }

  load(steps) { this.steps = cleanSteps(steps); this.changed(); }
  clear() { this.steps = cleanSteps(); this.changed(); }

  // For the panel: transport, recording and where the pattern is (the steps
  // themselves only when they changed).
  status(withSteps) {
    const len = this.length(), ms = this.stepMs(), pattern = len * ms;
    const elapsed = this.count * ms - (this.gridAt - this.c.timeMs);
    return {
      playing: this.playing, rec: this.rec, recPos: this.recPos,
      current: this.playing ? this.last : this.pos,
      phaseMs: this.playing ? ((elapsed % pattern) + pattern) % pattern : 0, patternMs: pattern,
      version: this.version, steps: withSteps ? this.steps.map((s) => ({ ...s, keys: s.keys.slice() })) : undefined,
    };
  }
}
