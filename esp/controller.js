// JavaScript port of the ESP32 control side of Spectrum.
//
// Runs inside the AudioWorklet, so note timing, the clock and the frame
// cadence follow audio time like the 5 ms SPI task on the instrument. The
// panel state lives in `pr` with the firmware field names and scales; every
// frame is written as in updateBuffer() (esp32/src/spectrum.cpp).

import { KEYS, degreeForKey, frequency, nearestDegree } from './scales.js';
import { Sequence, stepsPerBeat, euclidHit, humanDelay, humanPressure, withArpRhythm, MAX_ARP_STEPS } from './trillo.js';

export const FRAME = 128;
const VOICES = 5;
const NOTE = [1, 18, 19, 124, 77], CENTS = [2, 75, 76, 125, 78], GATE = [0, 69, 71, 126, 55];
const TRIGGER = [8, 70, 72, 127, 56], PRESSURE = [5, 73, 74, 13, 79], ENVELOPE = [16, 21, 23, 18, 31];
const OCTAVES = [0.125, 0.25, 0.5, 1, 2, 4, 8];
const MIN_FREQ = 27.5, MAX_FREQ = 6535.5;
const OWNER_KEYBOARD = 0, OWNER_MIDI = 1;
const ENV_ACTIVE = 2;

// Modulation destination IDs (shared/modulation_destinations.h).
export const DEST = {
  Volume: 0, Pitch: 1, Blend: 2, OscWave: 4, SubWave: 5, Stereo: 6, Rotate: 8, DelayTime: 9,
  None: 11, Trillo: 13, Drive: 21, ReverbSize: 25, ReverbDetail: 26, DelayFeedback: 27,
  LfoAmount: 30, LfoSpeed: 31, Attack: 34, Release: 35, Bands: 37, Spread: 39, Width: 40,
  Crossmod: 41, Feedback: 42, Dispersion: 43, Master: 45, SubDetune: 47, SubDivider: 48,
  FilterMode: 49, LfoWave: 50, Octave: 52, Transpose: 53, Tune: 54,
};
// Web: image (band stereo width) is fixed; its fader now carries drive, so
// it is not modulated either. 75 % (was half: narrower than most old presets,
// which averaged about 65 %; asked by the user).
export const IMAGE = 49151.25;

// Web drone stutter: the transpose fader in 12 zones from the bottom, the
// first the plain drone, then repeats from slow to fast (length in beats).
export const STUTTER = [['drone', 0], ['1/2', 2], ['1/4.', 1.5], ['1/4', 1], ['1/8.', 0.75], ['1/4T', 2 / 3],
  ['1/8', 0.5], ['1/8T', 1 / 3], ['1/16', 0.25], ['1/16T', 1 / 6], ['1/32', 0.125], ['1/64', 0.0625]];
const LFO_DESTINATIONS = [DEST.Attack, DEST.Release, DEST.Drive, DEST.Bands, DEST.Spread, DEST.Rotate,
  DEST.Width, DEST.DelayTime, DEST.Feedback, DEST.Dispersion, DEST.OscWave, DEST.SubWave,
  DEST.Blend, DEST.Crossmod, DEST.Master, DEST.Transpose, DEST.Tune,
  DEST.ReverbSize, DEST.ReverbDetail, DEST.DelayFeedback];
const SUPPORTED = new Set(LFO_DESTINATIONS);
// One LFO per control (lfo_bank.h of the engine, on the Daisy): these the Daisy
// does not apply; the controller moves them with the wave the engine reports,
// as the ESP32 would with its own copy of the bank.
const LFO_HERE = new Set([DEST.Attack, DEST.Release, DEST.Transpose, DEST.Tune, DEST.Master]);
// lfo_clock::Index: the 15 speed choices (/16 .. X16) of a speed control.
export const lfoSpeedIndex = (c) => (c < 128 ? (c * 7) >> 7 : 7 + (((c - 128) * 8) >> 7));
export const LFO_SPEEDS = ['/16', '/8', '/6', '/4', '/3', '/2', '/1.5', 'X1', 'X1.5', 'X2', 'X3', 'X4', 'X6', 'X8', 'X16'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Init patch: PresetData defaults, on the Spettro controls.
export function defaultPreset() {
  return {
    selKeyboard: 0, keyboardLayout: 0, scaleRoot: 0, octaveIndex: 3,
    keyboardBase: 3, // web: the pads start at C3 (presets without it: C4)
    attack: 0, release: 0, wave_shape: 0, spectralStereo: 0, oscSubBlend: 32767.5,
    subWave: 0, crossMod: 0, subDetuneCents: 0, subOctave: 1,
    spectralRotate: 32767.5, spectralWidth: 63.75, spectralBands: 128, spectralSpread: 128,
    // Web: bands bipolar (byte 32): 0..128 one to eight bands from the bottom,
    // 128 all, above it the lowest fade out down to the top band alone.
    bandsBipolar: true,
    spectralMode: 1, delayTime: 0, delayRegen: 0, delayShift: 0, delayReverse: 0, // web: starts in harmonic
    // Web: the freeze slots carry reverb size (255 = the firmware hall),
    // reverb detail (reverbFuse: 0 = one loop per band, 255 = the firmware
    // tank) and
    // delay feedback (240 and up: hold), changed in the web build of the
    // Daisy DSP. Diffuse (delayRegen) holds the reverb from 240.
    reverbSize: 255, reverbFuse: 255, delayFeedback: 0, driveAmount: 0,
    fxMix: 0.5, // web: dry/effects, 0.5 = both at unity
    // The final firmware has no sine: tri is the first LFO wave.
    lfoSpeed: 5, lfoWave: 1, lfoAmount: 0, lfoAssigned: new Uint8Array(7),
    // Web: one LFO per control (3 November): its amount, bipolar
    // (-255..255, control units from the control's own value, the arrival
    // of its LFO; 0 none), its wave (1..5) and speed (0..255, lfo_clock).
    lfoDepth: new Array(56).fill(0), lfoAmountInDepth: true,
    lfoWaves: new Array(56).fill(1), lfoSpeeds: new Array(56).fill(128),
    // Web: per-pad rules of the arpeggio (set on a held pad with the latched
    // arpeggio): { [key]: { play: [x, y], acc, limit, mode } }, see arpRule.
    arpRules: {},
    ccAssignDest: [DEST.None, DEST.None, DEST.None, DEST.None], ccAssignAmount: [0, 0, 0, 0],
    trilloOn: false, bandAttackShape: 0, bandReleaseShape: 0, bandSustainMask: 0xff,
    trilloSpeed: 128, trilloHoldPercent: 50, trilloPattern: 0,
    // Web: the arpeggio's Euclidean rhythm and humanize (see trillo.js).
    trilloSteps: 8, trilloHits: 8, trilloHumanize: 0,
    latchedNote: false, articulationDegreeTranspose: 0, presetBpm: 120, oscBank: 0,
  };
}

// Older presets. With the freeze: the firmware hall, no detail, no
// feedback, and the LFO assignments of the freeze controls dropped. With
// reverb decay and bands (30 October) or tilt (until 31 October): they go,
// the firmware tank and no LFO on detail. reverbDetail (31 October, an hour)
// ran the other way: 0 was the tank.
export function migratePreset(pr) {
  return withArpRhythm(withLfoPerControl(withoutOctaveLfo(withBipolarBands(withLfoDepth(withKeyboardBase(migrateReverb(pr)))))));
}

// Web: one LFO per control (3 November). Older presets had one LFO for every
// assignment: each control gets its wave and speed, and the amount goes into
// its depth (now the bipolar amount of each control), so they sound the
// same (each control now runs its own copy, all in step on the clock).
// Presets of the first version of the day kept a separate amount per
// control (lfoAmounts): it goes into the depth too.
function withLfoPerControl(pr) {
  if (pr.lfoAmountInDepth) return pr;
  const perControl = Array.isArray(pr.lfoWaves) && pr.lfoWaves.length === 56;
  const amounts = perControl ? (pr.lfoAmounts || []) : new Array(56).fill(pr.lfoAmount ?? 0);
  const mask = Array.from(pr.lfoAssigned || []), depths = Array.from(pr.lfoDepth || new Array(56).fill(0));
  for (let d = 0; d < 56; d++) {
    depths[d] = Math.round((depths[d] || 0) * (amounts[d] ?? 255) / 255);
    if (!depths[d] && mask.length > d >> 3) mask[d >> 3] &= ~(1 << (d & 7));
  }
  const { lfoAmounts, ...rest } = pr;
  return { ...rest, lfoAssigned: mask, lfoDepth: depths, lfoAmountInDepth: true,
    lfoWaves: perControl ? pr.lfoWaves : new Array(56).fill(pr.lfoWave ?? 1),
    lfoSpeeds: perControl ? pr.lfoSpeeds : new Array(56).fill(pr.lfoSpeed ?? 5) };
}

// Web: the LFO no longer goes on the octave (asked by the user); presets
// that had it lose it.
function withoutOctaveLfo(pr) {
  const d = DEST.Octave, bit = 1 << (d & 7);
  if (!(pr.lfoAssigned?.[d >> 3] & bit) && !pr.lfoDepth?.[d]) return pr;
  const lfoAssigned = Array.from(pr.lfoAssigned || []), lfoDepth = Array.from(pr.lfoDepth || []);
  if (lfoAssigned.length > d >> 3) lfoAssigned[d >> 3] &= ~bit;
  if (lfoDepth.length > d) lfoDepth[d] = 0;
  return { ...pr, lfoAssigned, lfoDepth };
}

// Presets before the bipolar bands: their count goes in the lower half (255
// all eight -> 128) and an LFO on the bands moves as far, but no further
// than all the bands (it stopped there before; now it would cut the lowest).
export function withBipolarBands(pr) {
  if (pr.bandsBipolar) return pr;
  const k = 128 / 255, bands = (pr.spectralBands ?? 255) * k;
  const lfoDepth = Array.isArray(pr.lfoDepth) ? pr.lfoDepth.slice() : pr.lfoDepth;
  if (Array.isArray(lfoDepth)) lfoDepth[DEST.Bands] = Math.round(Math.min((lfoDepth[DEST.Bands] || 0) * k, 128 - bands));
  return { ...pr, bandsBipolar: true, spectralBands: bands, ...(lfoDepth ? { lfoDepth } : {}) };
}

// Presets made when the pads started at C4: an octave up, so they sound the
// same (the panel also halves their per-key frequencies, see applyPreset).
export function withKeyboardBase(pr) {
  if (pr.keyboardBase === 3) return pr;
  return { ...pr, keyboardBase: 3, octaveIndex: clamp((pr.octaveIndex ?? 3) + 1, 0, 6) };
}

// Presets before per-destination depths: every assigned control the full
// 255 up, as the single LFO offset was.
function withLfoDepth(pr) {
  if (Array.isArray(pr.lfoDepth) && pr.lfoDepth.length === 56) return pr;
  const mask = pr.lfoAssigned || [];
  const lfoDepth = Array.from({ length: 56 }, (_, d) => (mask[d >> 3] & (1 << (d & 7)) ? 255 : 0));
  return { ...pr, lfoDepth };
}

function migrateReverb(pr) {
  if ('freezeDuration' in pr || !('reverbSize' in pr || 'reverbDecay' in pr)) {
    const { freezeDuration, freezeSelection, freezeProbability, ...rest } = pr;
    const lfo = Array.from(pr.lfoAssigned || []);
    if (lfo.length > 3) lfo[3] &= ~((1 << 1) | (1 << 2) | (1 << 3)); // DEST 25, 26, 27
    return { ...rest, reverbSize: 255, reverbFuse: 255, delayFeedback: 0, lfoAssigned: lfo };
  }
  if ('reverbDecay' in pr || 'reverbTilt' in pr) {
    const { reverbDecay, reverbBands, reverbTilt, ...rest } = pr;
    const lfo = Array.from(pr.lfoAssigned || []);
    if (lfo.length > 3) lfo[3] &= ~(1 << 2); // DEST 26
    return { ...rest, reverbSize: 'reverbDecay' in pr ? 255 : pr.reverbSize, reverbFuse: 255, lfoAssigned: lfo };
  }
  if ('reverbDetail' in pr) {
    const { reverbDetail, ...rest } = pr;
    return { ...rest, reverbFuse: 255 - reverbDetail };
  }
  return pr;
}

export class Controller {
  constructor() {
    this.pr = defaultPreset();
    this.frame = new Uint8Array(FRAME);
    this.analyserRequested = false;
    this.lfoOutput = 0;
    // Wave of every control's LFO, 0..255 (engine spectrum_lfo_waves), the
    // control being edited (sent in every frame) and the turn of the others.
    this.lfoWaves = new Uint8Array(56);
    this.lfoFocus = -1;
    this.lfoCursor = 0;
    this.midiChannel = 0; // 0 = omni
    this.midiCc = [0, 0, 0, 0];

    // Keys: pressure, stack order and per-key tuning.
    this.keyAftertouch = new Uint8Array(KEYS);
    this.keyDown = new Uint8Array(KEYS);
    this.keyStack = [];
    this.keyboardFreq = new Float32Array(KEYS);
    // Web: the note recorder of the looper (see noteRecArm): armed, the open
    // take or overdub, the live voices being recorded (index -> { key,
    // octave, fader }) and the events for the panel (recDrain).
    this.rec = { armed: false, maxMs: 0, take: null, overdub: null, voices: new Map(), events: [] };
    // Keys held at the closing press of a note take: the cycle plays them
    // from then on and their release by hand is ignored (noteLoopTakeover).
    this.loopTaken = new Set();
    this.updateKeyboard();

    // Voices, as the polyV* arrays of the firmware.
    this.v = Array.from({ length: VOICES }, () => ({
      key: 255, note: 60, cents: 50, aft: 0, gate: false, trig: false, owner: OWNER_KEYBOARD,
      transpose: 0, degree: 0, octave: 3, holdKey: 255, midiNote: -1, midiChannel: -1, looped: false, pin: null,
      bendTo: 255, bendPos: 0,
    }));
    this.gen = new Uint8Array(VOICES);
    this.stealIdx = 0;
    this.adsr = new Uint8Array(VOICES);
    this.restartBits = 0;
    this.momentaryHold = new Set();

    // Clock: internal 110 BPM at boot.
    this.bpm = 110;
    this.clockTimeMs = 545;
    this.timeMs = 0;
    this.clockStart = 0;

    // Note attacks, for the delay-line lights (one echo per line and note).
    this.attacks = [];

    // Arpeggio (Trillo).
    this.sequence = new Sequence();
    this.arpRulesReset();
    this.arpKey = 255;
    this.arpNext = null;
    this.arpGate = null; this.arpPeriod = 0;
    this.arpStep = 0;

    // Held MIDI notes (midiHeldNotes): note -> { channel, pressure, order,
    // keyDown, retouchAt }, and the MIDI arpeggio that sequences them.
    this.midiHeld = new Map();
    this.midiOrder = 1;
    this.midiArp = { active: false, sequence: new Sequence(0x5bd1e995), next: null, step: 0, gate: null, period: 0, playing: false };
  }

  // ---- Pitch ------------------------------------------------------------

  updateKeyboard() {
    for (let k = 0; k < KEYS; k++)
      this.keyboardFreq[k] = frequency(this.pr.selKeyboard, degreeForKey(k, this.pr.keyboardLayout));
  }

  // Per-key edits of the Keyboard page (keyboardMemorizedKey).
  setKeyboardFrequencies(list) {
    list.forEach((f, k) => { if (k < KEYS && f > 0) this.keyboardFreq[k] = Math.min(MAX_FREQ, Math.max(MIN_FREQ, f)); });
    this.v.forEach((v, i) => { if (v.gate) this.renderVoice(i); });
  }

  currentOctaveIndex() {
    return clamp(this.pr.octaveIndex, 0, 6);
  }

  currentDegreeTranspose(fader = this.pr.articulationDegreeTranspose) {
    return clamp(fader + Math.round(this.lfo(DEST.Transpose) * 24 / 255), -12, 12);
  }

  baseFrequency(key, degree) {
    const f = this.keyboardFreq[key];
    if (!degree) return f;
    const scale = this.pr.selKeyboard;
    const d = nearestDegree(scale, f);
    return frequency(scale, d + degree) * (f / frequency(scale, d));
  }

  static toNote(freq) {
    const n = clamp(Math.round(12 * Math.log2(freq / 440)) + 69, 0, 116);
    const ref = clamp(440 * Math.pow(2, (n - 69) / 12), 27.5, 6644.875);
    return [n, clamp(Math.trunc(1200 * Math.log2(freq / ref) + 50), 0, 127)];
  }

  renderVoice(i) {
    const v = this.v[i];
    if (v.owner !== OWNER_KEYBOARD || v.key >= KEYS) return;
    const degree = v.degree + (v.acc || 0);
    let f = clamp(this.baseFrequency(v.key, degree) * OCTAVES[v.octave], MIN_FREQ, MAX_FREQ);
    if (v.bendTo < KEYS && v.bendPos > 0) {
      // Touch bend: geometric interpolation towards the neighbour pad.
      const to = clamp(this.baseFrequency(v.bendTo, degree) * OCTAVES[v.octave], MIN_FREQ, MAX_FREQ);
      f *= Math.pow(to / f, v.bendPos);
    }
    const [note, cents] = Controller.toNote(f);
    v.note = clamp(note + v.transpose, 0, 127);
    v.cents = cents;
  }

  // Live voices follow octave, transpose and root; momentary captures freeze.
  // Notes of the looper's note cycle keep the octave and transpose fader of
  // their take (v.pin), and follow only the LFO on transpose and the root.
  refreshVoices() {
    for (let i = 0; i < VOICES; i++) {
      const v = this.v[i];
      if (!v.gate || v.owner !== OWNER_KEYBOARD || v.key >= KEYS || v.holdKey < KEYS) continue;
      v.degree = this.currentDegreeTranspose(v.pin?.degree);
      v.octave = v.pin ? v.pin.octave : this.currentOctaveIndex();
      v.transpose = this.pr.scaleRoot;
      this.renderVoice(i);
    }
    for (const v of this.v) if (v.owner === OWNER_MIDI && v.midiNote >= 0) this.renderMidiVoice(v);
  }

  // ---- Voice allocation (claimVoiceLocked) ---------------

  silent(i) {
    const v = this.v[i];
    return !v.gate && this.adsr[i] <= ENV_ACTIVE;
  }

  claimVoice(owner) {
    if (this.v.every((_, i) => this.silent(i))) this.stealIdx = 0;
    let chosen = -1;
    for (let n = 0; n < VOICES && chosen < 0; n++) {
      const i = (this.stealIdx + n) % VOICES;
      if (this.silent(i)) chosen = i;
    }
    for (let n = 0; n < VOICES && chosen < 0; n++) {
      const i = (this.stealIdx + n) % VOICES;
      if (this.v[i].holdKey >= KEYS) chosen = i;
    }
    if (chosen < 0) return -1;
    this.stealIdx = (chosen + 1) % VOICES;
    const v = this.v[chosen];
    if (v.owner !== owner) { v.midiNote = -1; v.key = 255; }
    v.owner = owner;
    v.holdKey = 255;
    return chosen;
  }

  allocKeyboardVoice(key) {
    for (let i = 0; i < VOICES; i++) {
      const v = this.v[i];
      if (v.owner === OWNER_KEYBOARD && !v.looped && v.gate && v.key === key) return i;
    }
    for (let i = 0; i < VOICES; i++) {
      const v = this.v[i];
      if (v.owner === OWNER_KEYBOARD && !v.looped && !v.gate && v.key === key && this.adsr[i] > ENV_ACTIVE) return i;
    }
    return this.noteLoopPlaying ? this.claimLoopAwareVoice(!!this.noteLooping) : this.claimVoice(OWNER_KEYBOARD);
  }

  // Web: with a note cycle of the looper playing, its notes come first. A
  // played note takes a free voice, then one releasing, then one of its own
  // played notes, never a sounding note of the cycle (it stays silent when
  // they hold every voice); the cycle takes its own oldest first, then the
  // played notes. Round robin within each step, as claimVoice.
  claimLoopAwareVoice(looped) {
    const free = (i) => this.v[i].holdKey >= KEYS;
    const steps = [
      (i) => this.silent(i),
      (i) => !this.v[i].gate && free(i),
      (i) => this.v[i].gate && free(i) && this.v[i].looped === looped,
      ...(looped ? [(i) => this.v[i].gate && free(i)] : []),
    ];
    let chosen = -1;
    for (const ok of steps) {
      for (let n = 0; n < VOICES && chosen < 0; n++) {
        const i = (this.stealIdx + n) % VOICES;
        if (ok(i)) chosen = i;
      }
      if (chosen >= 0) break;
    }
    if (chosen < 0) return -1;
    this.stealIdx = (chosen + 1) % VOICES;
    const v = this.v[chosen];
    if (v.owner !== OWNER_KEYBOARD) { v.midiNote = -1; v.key = 255; }
    v.owner = OWNER_KEYBOARD;
    v.holdKey = 255;
    return chosen;
  }

  // ---- Keyboard ---------------------------------------------------------

  // Pad or PC key pressed; pressure 1..255.
  keyOn(key, pressure) {
    if (key < 0 || key >= KEYS) return;
    pressure = clamp(Math.round(pressure), 1, 255);
    if (!this.noteLooping) this.loopTaken.delete(key);
    if (this.pr.latchedNote && this.keyStack.includes(key) && !this.keyDown[key]) {
      // Latched retouch: a short tap removes the key on release.
      this.keyDown[key] = 1;
      this.retouchAt = this.retouchAt || new Map();
      this.retouchAt.set(key, this.timeMs);
      return;
    }
    this.keyDown[key] = 1;
    this.keyAftertouch[key] = pressure;
    // While paused by Hold, a new key clears the stack and starts a fresh
    // arpeggio, with Hold still off as on the firmware (touchDown).
    if (this.pr.trilloOn && this.arpPaused) { this.keyStack = []; this.arpPaused = false; }
    this.keyStack = this.keyStack.filter((k) => k !== key);
    this.keyStack.push(key);
    // With the arpeggio on, keys only feed the stack.
    if (this.pr.trilloOn) { if (this.arpNext === null) this.arpNext = this.timeMs; return; }
    this.noteOnKey(key, true);
  }

  keyPressure(key, pressure) {
    if (key < 0 || key >= KEYS || !this.keyDown[key]) return;
    this.keyAftertouch[key] = clamp(Math.round(pressure), 1, 255);
    for (const v of this.v) if (v.owner === OWNER_KEYBOARD && !v.looped && v.key === key && v.gate) v.aft = this.keyAftertouch[key];
  }

  keyOff(key) {
    if (!this.noteLooping && this.loopTaken.delete(key)) return; // the note cycle plays it now
    if (key < 0 || key >= KEYS || !this.keyDown[key]) return;
    this.keyDown[key] = 0;
    if (this.pr.latchedNote) {
      const touchedAt = this.retouchAt && this.retouchAt.get(key);
      if (touchedAt !== undefined) {
        this.retouchAt.delete(key);
        if (this.timeMs - touchedAt <= 150) this.releaseKey(key);
        else this.restartKeyBands(key);
      }
      return;
    }
    if (this.momentaryHold.has(key)) return;
    this.releaseKey(key);
  }

  // ---- Touch bend (shared/adjacent_bend.h, with the finger position) -------
  // The hardware bends by the pressure balance of two adjacent pads; on a
  // screen the finger's position between the two pad centres takes its place
  // (pos 0..1). As on the instrument it is off with the arpeggio, works in
  // Hold, and reaching the neighbour moves the note there without a new
  // trigger, restarting the bands (restartVoiceBands).

  keyBend(key, target, pos) {
    if (key < 0 || key >= KEYS || target < 0 || target >= KEYS || this.pr.trilloOn) return;
    pos = clamp(pos, 0, 1);
    this.recBend(key, target, pos);
    this.v.forEach((v, i) => {
      if (v.owner !== OWNER_KEYBOARD || v.looped || v.key !== key || !v.gate) return;
      v.bendTo = pos > 0 ? target : 255;
      v.bendPos = pos;
      this.renderVoice(i);
    });
  }

  keySlide(key, target) {
    if (key < 0 || key >= KEYS || target < 0 || target >= KEYS || this.pr.trilloOn) return;
    if (!this.keyDown[key] || this.keyDown[target]) return;
    this.recSlide(key, target);
    this.keyDown[key] = 0;
    this.keyDown[target] = 1;
    this.keyAftertouch[target] = this.keyAftertouch[key];
    this.keyStack = this.keyStack.map((k) => (k === key ? target : k));
    if (this.momentaryHold.delete(key)) this.momentaryHold.add(target);
    if (this.retouchAt?.has(key)) { this.retouchAt.set(target, this.retouchAt.get(key)); this.retouchAt.delete(key); }
    this.v.forEach((v, i) => {
      if (v.owner !== OWNER_KEYBOARD || v.looped || v.key !== key || !v.gate) return;
      v.key = target;
      if (v.holdKey === key) v.holdKey = target;
      v.bendTo = 255; v.bendPos = 0;
      this.restartBits ^= 1 << i;
      this.renderVoice(i);
    });
  }

  releaseKey(key) {
    this.keyStack = this.keyStack.filter((k) => k !== key);
    // The arpeggio finishes its current step; it only loses the key.
    if (this.pr.trilloOn && key === this.arpKey) return;
    for (const v of this.v) if (v.owner === OWNER_KEYBOARD && !v.looped && v.key === key) v.gate = false;
  }

  // ---- Arpeggio (updateTrillo, KTE:64-416) ----------------------------------

  setTrillo(on) {
    if (on === this.pr.trilloOn) return;
    this.pr.trilloOn = on;
    this.arpPaused = false;
    this.sequence.reset();
    this.arpStep = 0;
    this.arpRulesReset();
    if (on) {
      // Held notes stop sounding directly and become the arpeggio.
      for (const v of this.v) if (v.owner === OWNER_KEYBOARD && !v.looped) v.gate = false;
      this.arpNext = this.keyStack.length ? this.timeMs : null;
      return;
    }
    this.stopArpNote();
    this.arpNext = null;
    // Keys still held sound again as plain notes.
    if (!this.pr.latchedNote) this.keyStack = this.keyStack.filter((k) => this.keyDown[k]);
    for (const k of this.keyStack) this.noteOnKey(k, true);
  }

  arpRhythm() {
    const pr = this.pr, steps = clamp(pr.trilloSteps ?? 8, 1, MAX_ARP_STEPS);
    return { steps, hits: clamp(pr.trilloHits ?? steps, 1, steps), human: clamp(pr.trilloHumanize ?? 0, 0, 100) };
  }

  stopArpNote() {
    if (this.arpKey >= KEYS) return;
    for (const v of this.v) if (v.owner === OWNER_KEYBOARD && !v.looped && v.key === this.arpKey) v.gate = false;
    this.arpKey = 255;
  }

  // End of the sounding arpeggio note: its share of the interval to the next
  // onset (gate.steps, in steps) at the step length and hold of now, so a
  // change of tempo or hold acts on it at once, also with the arpeggio latched.
  arpGateEnd(gate, period) {
    return gate ? gate.from + Math.max(1, gate.steps * period * clamp(this.pr.trilloHoldPercent, 1, 100) / 100) : 0;
  }

  arpeggio() {
    if (!this.pr.trilloOn) return;
    const pr = this.pr;
    const speed = clamp(pr.trilloSpeed + this.cc(DEST.Trillo), 0, 255);
    const period = this.clockTimeMs / stepsPerBeat(speed);
    // Web (asked by the user): a new tempo moves the next step at once (last
    // step + the new step length) instead of after the old one.
    if (this.arpNext !== null && this.arpPeriod && period !== this.arpPeriod) this.arpNext += period - this.arpPeriod;
    this.arpPeriod = period;
    if (this.arpKey < KEYS && this.timeMs >= this.arpGateEnd(this.arpGate, period)) this.stopArpNote();
    if (!this.keyStack.length || this.arpPaused) { this.arpNext = null; this.sequence.reset(); this.arpStep = 0; this.arpRulesReset(); return; }
    if (this.arpNext === null) this.arpNext = this.timeMs;
    if (this.timeMs - this.arpNext > 2 * period) this.arpNext = this.timeMs;
    const { steps, hits, human } = this.arpRhythm();
    const delay = humanDelay(human, this.arpStep, period);
    if (this.timeMs < this.arpNext + delay) return;
    this.stopArpNote();
    // A rest of the Euclidean rhythm: the pattern stays where it is.
    if (!euclidHit(steps, hits, this.arpStep)) { this.arpStep++; this.arpNext += period; return; }
    const index = this.sequence.next(pr.trilloPattern, this.keyStack, (k) => this.keyboardFreq[k]);
    const key = index < this.keyStack.length ? this.keyStack[index] : 255;
    const rule = key < KEYS ? pr.arpRules?.[key] : null;
    // A pad with a rule plays only on its cycles (x of every y) and moves by
    // its accumulator each time it plays.
    if (key < KEYS && (!rule || this.arpRulePlays(rule))) {
      // A pad's own velocity (rule.vel, %) in place of the played pressure;
      // the humanize works on either.
      const vel = rule?.vel ? clamp(Math.round(rule.vel * 2.55), 1, 255) : 0;
      const base = vel || this.keyAftertouch[key];
      const pressure = human ? humanPressure(human, this.arpStep, base) : vel || undefined;
      this.noteOnKey(key, true, pressure, rule ? this.arpAccumulate(key, rule) : 0);
      this.arpKey = key;
      // Gate length uses the interval to the next (humanized) onset.
      this.arpGate = { from: this.timeMs, steps: (period + humanDelay(human, this.arpStep + 1, period) - delay) / period };
    }
    // A cycle: the pattern back at its first step (every step for one key).
    if (this.sequence.position === 0 || this.keyStack.length === 1) this.arpCycle++;
    this.arpStep++;
    this.arpNext += period;
  }

  // ---- Web: arpeggio rules per pad (as the OXI One MKII's conditions and
  // accumulator). play [x, y]: the pad sounds on cycle x of every y (a cycle
  // is one pass of the pattern). acc: scale degrees added each time it
  // plays, limit: how far, mode: clip (back to 0 past the limit), wrap (past
  // +limit on from -limit, and the other way round: it keeps going round
  // -limit..+limit), pendulum (back and forth between 0 and the limit).

  arpRulesReset() { this.arpCycle = 0; this.arpAcc = new Map(); }

  arpRulePlays(rule) {
    const [x, y] = rule.play || [1, 1];
    return y <= 1 || (this.arpCycle % y) === x - 1;
  }

  arpAccumulate(key, rule) {
    const step = rule.acc | 0, limit = Math.max(1, rule.limit | 0);
    if (!step) return 0;
    const st = this.arpAcc.get(key) || { v: 0, dir: 1 };
    const out = st.v, s = Math.abs(step), sign = Math.sign(step);
    let a = Math.abs(st.v);
    if (rule.mode === 'wrap') {
      const span = 2 * limit + 1;
      let w = st.v + step;
      if (w > limit) w -= span; else if (w < -limit) w += span;
      st.v = w;
      this.arpAcc.set(key, st);
      return out;
    } else if (rule.mode === 'pendulum') {
      // Turns back where the next step would leave 0..limit.
      if (a + st.dir * s > limit || a + st.dir * s < 0) st.dir = -st.dir;
      a = clamp(a + st.dir * s, 0, limit);
    } else { a += s; if (a > limit) a = 0; }
    st.v = sign * a;
    this.arpAcc.set(key, st);
    return out;
  }

  restartKeyBands(key) {
    this.v.forEach((v, i) => { if (v.owner === OWNER_KEYBOARD && !v.looped && v.key === key && v.gate) this.restartBits ^= 1 << i; });
  }

  noteOnKey(key, trigger, pressure, acc = 0) {
    const i = this.allocKeyboardVoice(key);
    if (i < 0) return;
    const v = this.v[i];
    const fresh = !v.gate || v.key !== key;
    if (fresh || this.pr.trilloOn || this.pr.latchedNote) {
      v.pin = null;
      v.transpose = this.pr.scaleRoot;
      v.degree = this.currentDegreeTranspose(v.pin?.degree);
      v.octave = v.pin ? v.pin.octave : this.currentOctaveIndex();
    }
    v.key = key;
    v.bendTo = 255; v.bendPos = 0;
    v.aft = pressure ?? this.keyAftertouch[key];
    v.gate = true;
    v.acc = acc; // web: arpeggio accumulator, scale degrees
    v.looped = !!this.noteLooping;
    if (trigger) v.trig = true;
    this.lastVoice = i;
    this.renderVoice(i);
    if (trigger && this.recording()) this.recNoteOn(i);
  }

  // ---- Hold (❄): tap latches, hold >= 300 ms captures momentarily -------

  holdDown() {
    this.holdPressedAt = this.timeMs;
    this.holdCaptured = false;
    for (let k = 0; k < KEYS; k++) if (this.keyDown[k]) this.momentaryHold.add(k);
    this.v.forEach((v) => { if (v.owner === OWNER_KEYBOARD && !v.looped && v.gate && this.momentaryHold.has(v.key)) v.holdKey = v.key; });
    // Web-only (the firmware captures keyboard keys only): MIDI notes held
    // at the press are captured too, until Hold is released.
    for (const h of this.midiHeld.values()) if (h.keyDown) h.captured = true;
  }

  // Web drone: notes captured by a held Hold (keyboard or MIDI).
  capturedVoice(v) {
    return v.gate && (v.owner === OWNER_KEYBOARD ? v.holdKey < KEYS : !!this.midiHeld.get(v.midiNote)?.captured);
  }

  droneActive() {
    if (this.momentaryHold.size) return true;
    for (const h of this.midiHeld.values()) if (h.captured) return true;
    return false;
  }

  holdUp() {
    const long = this.timeMs - this.holdPressedAt >= 300;
    const captured = [...this.momentaryHold];
    this.momentaryHold.clear();
    this.v.forEach((v) => { v.holdKey = 255; });
    // Captured MIDI notes no longer pressed end with the latch below: released
    // by a long press, kept if a tap switches the latch on.
    for (const h of this.midiHeld.values()) h.captured = false;
    if (long) {
      this.setLatch(false);
      for (const k of captured) if (!this.keyDown[k]) this.releaseKey(k);
      return;
    }
    this.setLatch(!this.pr.latchedNote);
  }

  setLatch(on) {
    // With the arpeggio running, Hold is its transport: off pauses and keeps
    // the stack, on restarts from step 0.
    if (this.pr.trilloOn && this.keyStack.length) {
      this.pr.latchedNote = on;
      this.arpPaused = !on;
      this.stopArpNote();
      this.sequence.reset(); this.arpStep = 0;
      this.arpRulesReset();
      this.arpNext = on ? this.timeMs : null;
      if (!on) this.midiReleaseLatched();
      return;
    }
    this.pr.latchedNote = on;
    if (on) return;
    for (const k of [...this.keyStack]) if (!this.keyDown[k]) this.releaseKey(k);
    this.midiReleaseLatched();
  }

  // ---- MIDI -------------------------------------------------------------

  renderMidiVoice(v) {
    const scale = this.pr.selKeyboard;
    const f = 440 * Math.pow(2, (v.midiNote - 69) / 12);
    // Quantized to the keyboard tuning, then octave and root/transpose (semitones).
    let q = frequency(scale, nearestDegree(scale, f));
    q *= OCTAVES[this.currentOctaveIndex()] * Math.pow(2, (this.pr.scaleRoot + this.currentDegreeTranspose()) / 12);
    const [note, cents] = Controller.toNote(clamp(q, MIN_FREQ, MAX_FREQ));
    v.note = note; v.cents = cents;
  }

  midi(bytes) {
    const [status, a = 0, b = 0] = bytes;
    const type = status & 0xf0, channel = (status & 0x0f) + 1;
    if (status >= 0xf8) return this.midiRealtime(status);
    if (type < 0x80 || type === 0xf0) return;
    if (this.midiChannel && channel !== this.midiChannel) return;
    if (type === 0x90 && b > 0) this.midiNoteOn(channel, a, 1 + Math.trunc((b - 1) * 254 / 126));
    else if (type === 0x80 || type === 0x90) this.midiNoteOff(channel, a);
    else if (type === 0xa0) this.midiPolyPressure(a, Math.trunc(b * 255 / 127));
    else if (type === 0xd0) for (const v of this.v) { if (v.owner === OWNER_MIDI && v.gate) v.aft = Math.trunc(a * 255 / 127); }
    else if (type === 0xb0) {
      if (a >= 1 && a <= 4) this.midiCc[a - 1] = Math.trunc(b * 255 / 127);
      else if (a === 120 || a === 123) this.midiAllNotesOff(channel);
    }
  }

  // Note-on (midiHandleNoteOn): the note joins the held set; with the
  // arpeggio on, the arpeggio owns every note, the first one included.
  midiNoteOn(channel, note, pressure) {
    const held = this.midiHeld.get(note);
    const retouch = this.pr.trilloOn && this.pr.latchedNote && held && !held.keyDown;
    const h = held || {};
    Object.assign(h, { channel, keyDown: true, retouchAt: retouch ? this.timeMs : undefined });
    if (!retouch) { h.pressure = pressure; h.order = this.midiOrder++; }
    this.midiHeld.set(note, h);
    if (this.pr.trilloOn) return;
    this.midiVoiceOn(note, channel, h.pressure);
  }

  // Note-off (midiHandleNoteOff): with Hold the note stays at its last
  // pressure; with the arpeggio a retouch shorter than 150 ms removes it.
  midiNoteOff(channel, note) {
    const h = this.midiHeld.get(note);
    if (!h || h.channel !== channel) return;
    h.keyDown = false;
    const retouchAt = h.retouchAt;
    h.retouchAt = undefined;
    const removeRetouch = this.pr.trilloOn && retouchAt !== undefined && this.timeMs - retouchAt <= 150;
    if ((this.pr.latchedNote || h.captured) && !removeRetouch) {
      for (const v of this.v) if (v.owner === OWNER_MIDI && v.gate && v.midiNote === note && v.midiChannel === channel) v.aft = h.pressure;
      return;
    }
    this.midiHeld.delete(note);
    if (this.pr.trilloOn && this.midiArp.active) return; // the arpeggio finishes its step
    this.midiVoiceOff(note, channel);
  }

  // Hold off: notes no longer pressed are released (midiReleaseLatchedNotes).
  midiReleaseLatched() {
    for (const [note, h] of [...this.midiHeld]) if (!h.keyDown) this.midiNoteOff(h.channel, note);
  }

  midiPolyPressure(note, pressure) {
    const h = this.midiHeld.get(note);
    if (!h || (this.pr.latchedNote && !h.keyDown)) return;
    h.pressure = pressure;
    for (const v of this.v) if (v.owner === OWNER_MIDI && v.gate && v.midiNote === note) v.aft = pressure;
  }

  midiAllNotesOff(channel) {
    for (const [note, h] of [...this.midiHeld]) if (h.channel === channel) this.midiHeld.delete(note);
    for (const v of this.v) if (v.owner === OWNER_MIDI && v.midiChannel === channel) v.gate = false;
  }

  // Input channel change: all notes off and CCs zeroed.
  midiReset() {
    this.midiHeld.clear();
    this.midiSilence();
    this.midiCc = [0, 0, 0, 0];
  }

  midiVoiceOn(note, channel, pressure) {
    let i = this.v.findIndex((v) => v.owner === OWNER_MIDI && v.gate && v.midiNote === note && v.midiChannel === channel);
    if (i < 0) i = this.claimVoice(OWNER_MIDI);
    if (i < 0) return;
    const v = this.v[i];
    Object.assign(v, { midiNote: note, midiChannel: channel, aft: pressure, gate: true, trig: true });
    this.lastVoice = i;
    this.renderMidiVoice(v);
  }

  midiVoiceOff(note, channel) {
    for (const v of this.v) if (v.owner === OWNER_MIDI && v.midiNote === note && v.midiChannel === channel) v.gate = false;
  }

  midiSilence() {
    for (const v of this.v) if (v.owner === OWNER_MIDI) v.gate = false;
  }

  // MIDI arpeggio (midiUpdateTrillo): the keyboard tempo, Pattern, gate and
  // Groove over the newest twelve held MIDI notes in played order. It runs
  // beside the keyboard arpeggio; switching the arpeggio off plays the held
  // notes again.
  midiArpeggio() {
    const a = this.midiArp, pr = this.pr;
    const held = [...this.midiHeld].sort((x, y) => x[1].order - y[1].order);
    if (!pr.trilloOn || !held.length) {
      if (a.active) {
        this.midiSilence();
        if (!pr.trilloOn) for (const [note, h] of held.slice(-VOICES)) this.midiVoiceOn(note, h.channel, h.pressure);
      }
      a.active = false; a.playing = false; a.next = null;
      return;
    }
    if (!a.active) {
      Object.assign(a, { active: true, playing: false, step: 0, next: this.timeMs });
      a.sequence.reset();
      this.midiSilence();
    }
    const speed = clamp(pr.trilloSpeed + this.cc(DEST.Trillo), 0, 255);
    const period = this.clockTimeMs / stepsPerBeat(speed);
    // Tempo and hold at once (see arpeggio).
    if (a.period && period !== a.period) a.next += period - a.period;
    a.period = period;
    if (a.playing && this.timeMs >= this.arpGateEnd(a.gate, period)) { this.midiSilence(); a.playing = false; }
    if (this.timeMs - a.next > 2 * period) a.next = this.timeMs;
    const { steps, hits, human } = this.arpRhythm();
    const delay = humanDelay(human, a.step, period);
    if (this.timeMs < a.next + delay) return;
    if (!euclidHit(steps, hits, a.step)) {
      if (a.playing) { this.midiSilence(); a.playing = false; }
      a.step++; a.next += period;
      return;
    }
    const used = held.slice(-12);
    const index = a.sequence.next(pr.trilloPattern, used.map(([note]) => note), (note) => 440 * Math.pow(2, (note - 69) / 12));
    if (index < used.length) {
      const [note, h] = used[index];
      this.midiSilence();
      this.midiVoiceOn(note, h.channel, human ? humanPressure(human, a.step, h.pressure) : h.pressure);
      a.playing = true;
      a.gate = { from: this.timeMs, steps: (period + humanDelay(human, a.step + 1, period) - delay) / period };
    }
    a.step++;
    a.next += period;
  }

  midiRealtime() {
    // MIDI clock is decoded on the panel side (ui.midiClock) with its timestamps.
  }

  // ---- Clock -------------------------------------------------------------

  setBpm(bpm) {
    this.bpm = clamp(Math.round(bpm), 41, 249);
    this.clockTimeMs = Math.trunc(60000 / this.bpm);
  }

  // External clock: period in ms per beat (clockTimeMs = round(period)).
  setClockMs(ms) {
    this.clockTimeMs = clamp(Math.round(ms), 1, 3000);
    this.bpm = 60000 / this.clockTimeMs;
  }

  alignBeat() { this.clockStart = this.timeMs; }

  // ---- Web: the note cycle of the motion loop ------------------------------
  // Recorded here, like an audio looper (the user's choice, 4 November): what
  // the keyboard voices play while rec is armed, the arpeggio's steps
  // included, not the pads pressed. Points: [ms, key, pressure, octave, fader,
  // acc] a note (octave, transpose fader and arpeggio accumulator as it
  // sounded), [ms, key, 0] its end, [ms, key, -1, target, pos] a bend,
  // [ms, key, -2, target] a slide to the next pad, [ms, key, -4, octave,
  // fader] an octave or transpose change on a sounding note. The cycle plays
  // them on voices of its own (v.looped), outside the arpeggio, Hold and the
  // pads, so turning the arpeggio off or changing octave or transpose leaves
  // it as it was; they follow only the root, the scale and the LFO on
  // transpose. Older cycles (pads recorded on the panel: notes without the
  // octave, [ms, 0, -3, octave] octave changes) still play through the
  // keyboard path. The panel mirrors the points (recDrain) to draw and save
  // them. phase: where it is now, in recorded time; align: start from the
  // top on the next beat. The octave cycle (octave changes recorded without
  // notes) is played the same way, before the notes on each tick.

  // keep: the same cycle retimed (quantize, speed): the notes it holds go on.
  setNoteLoop(loop, align = false, keep = false) {
    const old = this.noteLoop;
    if (keep && old && loop) {
      this.noteLoop = Object.assign(this.eventLoop(loop, align), { on: old.on, direct: old.direct, latched: old.latched });
      this.noteLoop.pinned = old.pinned;
      this.noteLoopPlaying = true;
      return;
    }
    this.noteLoopRelease();
    this.noteLoop = this.eventLoop(loop, align);
    this.noteLoopPlaying = !!this.noteLoop;
    if (!this.noteLoop) { this.rec.overdub = null; return; }
    // Older cycles with octave changes and notes with their octave (the
    // first takes of 4 November): the changes do not move the panel.
    this.noteLoop.pinned = this.noteLoop.points.some(([, , p, o]) => p > 0 && o !== undefined);
  }

  setOctaveLoop(loop, align = false) { this.octaveLoop = this.eventLoop(loop, align); }

  eventLoop(loop, align) {
    if (!loop || !(loop.length > 0)) return null;
    const rate = loop.rate || 1;
    const len = loop.length, intoBeat = (this.timeMs - this.clockStart) % this.clockTimeMs;
    const origin = align ? this.timeMs + (intoBeat ? this.clockTimeMs - intoBeat : 0) : this.timeMs - (loop.phase || 0) / rate;
    // last: the position already played; events after it and up to the
    // position of each tick fire (from the top: the one at 0 too).
    const last = align ? -1 : (((loop.phase || 0) - 1e-6) % len + len) % len;
    return { points: loop.points.slice(), length: len, rate, origin, last,
      on: new Set(), direct: new Set(), latched: new Set(), pending: [] };
  }

  noteLoopRelease() {
    const n = this.noteLoop;
    if (!n) return;
    for (const k of n.direct) this.loopVoiceOff(k);
    for (const k of n.on) this.keyOff(k);
    n.direct.clear(); n.on.clear();
  }

  // ---- Recording (rec armed on the panel) --------------------------------
  // The first note played opens the take, or, over a closed cycle, an
  // overdub: its points join the cycle at its play position and sound from
  // the next round. The closing press ends it (noteRecClose); a take also
  // ends at maxMs.

  noteRecArm(maxMs) { this.rec.armed = true; this.rec.maxMs = maxMs || 64 * this.clockTimeMs; }

  noteRecCancel() { this.rec.armed = false; this.rec.take = null; this.rec.overdub = null; this.rec.voices.clear(); }

  noteRecClose() {
    const r = this.rec;
    r.armed = false;
    if (r.take) {
      const take = r.take, length = clamp(this.timeMs - take.origin, 1, r.maxMs);
      r.take = null;
      // Notes still sounding stop with the cycle.
      for (const e of r.voices.values()) take.points.push([length - 1, e.key, 0]);
      r.voices.clear();
      const points = take.points.filter(([at]) => at < length);
      // What is held by hand (or latched) was the take: the cycle plays it
      // now from the top, so it stops and its release by hand is ignored.
      this.noteLoopTakeover();
      this.setNoteLoop({ points, length, rate: 1, phase: 0 });
      r.events.push({ kind: 'take', points, length });
    } else if (r.overdub) {
      const at = this.loopPos();
      this.recPush([...r.voices.values()].map((e) => [at, e.key, 0]));
      r.voices.clear();
      r.overdub = null;
    }
  }

  // The panel's mirror of the take (status.rec), with the cycle's position
  // when it was read.
  recDrain() {
    const r = this.rec;
    if (!r.events.length) return undefined;
    const events = r.events.map((e) => (e.kind === 'take' ? { ...e, pos: this.loopPos() } : e));
    r.events = [];
    return events;
  }

  loopPos() {
    const n = this.noteLoop;
    return n ? Math.max(0, ((this.timeMs - n.origin) * n.rate) % n.length) : 0;
  }

  recording() { return this.rec.armed && !this.noteLooping; }

  recTime() { return this.rec.take ? this.timeMs - this.rec.take.origin : this.loopPos(); }

  recPush(points) {
    const r = this.rec;
    if (r.take) { r.take.points.push(...points); return; }
    if (!this.noteLoop) return;
    this.noteLoop.pending.push(...points);
    r.events.push({ kind: 'add', points });
  }

  // A live keyboard voice starts a note (noteOnKey).
  recNoteOn(i) {
    const r = this.rec, v = this.v[i];
    if (!r.take && !r.overdub) {
      if (this.noteLoop) { r.overdub = true; r.events.push({ kind: 'overdub' }); }
      else { r.take = { origin: this.timeMs, points: [] }; r.events.push({ kind: 'start' }); }
    }
    const t = this.recTime(), old = r.voices.get(i);
    if (old && old.key !== v.key) this.recPush([[t, old.key, 0]]);
    const fader = this.pr.articulationDegreeTranspose;
    r.voices.set(i, { key: v.key, octave: v.octave, fader });
    this.recPush([[t, v.key, v.aft, v.octave, fader, v.acc || 0]]);
  }

  // Each tick: ends of the recorded notes, and octave or transpose changes
  // on them (live voices follow the panel, see refreshVoices).
  recScan() {
    const r = this.rec;
    if (r.take && this.timeMs - r.take.origin >= r.maxMs) { this.noteRecClose(); return; }
    if (!r.voices.size) return;
    const t = this.recTime(), out = [];
    for (const [i, e] of r.voices) {
      const v = this.v[i];
      if (!v.gate || v.looped || v.owner !== OWNER_KEYBOARD || v.key !== e.key) { out.push([t, e.key, 0]); r.voices.delete(i); continue; }
      const fader = v.holdKey < KEYS ? e.fader : this.pr.articulationDegreeTranspose;
      if (v.octave !== e.octave || fader !== e.fader) {
        e.octave = v.octave; e.fader = fader;
        out.push([t, e.key, -4, v.octave, fader]);
      }
    }
    if (out.length) this.recPush(out);
  }

  // A live bend or slide of recorded notes (keyBend, keySlide).
  recBend(key, target, pos) {
    if (!this.recording()) return;
    for (const e of this.rec.voices.values()) if (e.key === key) { this.recPush([[this.recTime(), key, -1, target, pos]]); return; }
  }

  recSlide(key, target) {
    if (!this.recording()) return;
    for (const e of this.rec.voices.values()) {
      if (e.key !== key) continue;
      this.recPush([[this.recTime(), key, -2, target]]);
      e.key = target;
      return;
    }
  }

  // A take closes and its cycle starts from the top: what is held by hand
  // (or latched by Hold) is the take, now played by the cycle, so it stops
  // here, its release by hand is ignored and the arpeggio starts again.
  // Without this the first round played over the held keys.
  noteLoopTakeover() {
    for (let k = 0; k < KEYS; k++) if (this.keyDown[k] && !this.momentaryHold.has(k)) this.loopTaken.add(k);
    for (const k of this.loopTaken) this.keyDown[k] = 0;
    this.keyStack = this.keyStack.filter((k) => this.momentaryHold.has(k));
    this.retouchAt?.clear();
    for (const v of this.v) if (v.owner === OWNER_KEYBOARD && !v.looped && v.holdKey >= KEYS) v.gate = false;
    this.arpRestart();
  }

  arpRestart() {
    this.stopArpNote();
    this.arpNext = null; this.arpPaused = false; this.arpStep = 0;
    this.sequence.reset();
    this.arpRulesReset();
  }

  // ---- Playback --------------------------------------------------------

  // A note of the cycle on a voice of its own (one per key of the cycle).
  loopVoiceOn(key, pressure, octave, fader, acc) {
    let i = this.v.findIndex((v) => v.owner === OWNER_KEYBOARD && v.looped && v.gate && v.key === key);
    if (i < 0) i = this.claimLoopAwareVoice(true);
    if (i < 0) return;
    const v = this.v[i];
    v.owner = OWNER_KEYBOARD; v.holdKey = 255; v.midiNote = -1;
    v.key = key; v.looped = true;
    v.pin = { octave: clamp(octave, 0, 6), degree: fader ?? 0 };
    v.transpose = this.pr.scaleRoot;
    v.degree = this.currentDegreeTranspose(v.pin.degree);
    v.octave = v.pin.octave;
    v.bendTo = 255; v.bendPos = 0;
    v.aft = clamp(Math.round(pressure), 1, 255);
    v.acc = acc || 0;
    v.gate = true; v.trig = true;
    this.lastVoice = i;
    this.renderVoice(i);
  }

  loopVoices(key, fn) {
    this.v.forEach((v, i) => { if (v.owner === OWNER_KEYBOARD && v.looped && v.gate && v.key === key) fn(v, i); });
  }

  loopVoiceOff(key) { this.loopVoices(key, (v) => { v.gate = false; }); }

  // An octave or transpose change recorded on a sounding note: its voice
  // moves there, as it did in the take; the panel stays.
  loopRetune(key, octave, fader) {
    this.loopVoices(key, (v, i) => {
      v.pin = { octave: clamp(octave, 0, 6), degree: fader ?? v.pin?.degree ?? 0 };
      v.octave = v.pin.octave;
      v.degree = this.currentDegreeTranspose(v.pin.degree);
      this.renderVoice(i);
    });
  }

  loopVoiceBend(key, target, pos) {
    if (target < 0 || target >= KEYS) return;
    this.loopVoices(key, (v, i) => {
      v.bendPos = clamp(pos, 0, 1);
      v.bendTo = v.bendPos > 0 ? target : 255;
      this.renderVoice(i);
    });
  }

  loopVoiceSlide(key, target) {
    if (target < 0 || target >= KEYS) return;
    this.loopVoices(key, (v, i) => {
      v.key = target; v.bendTo = 255; v.bendPos = 0;
      this.restartBits ^= 1 << i;
      this.renderVoice(i);
    });
  }

  // An octave change of an older cycle: the panel follows it (octaveSeq).
  loopOctave(index) {
    this.pr.octaveIndex = clamp(index, 0, 6);
    this.octaveSeq = (this.octaveSeq || 0) + 1;
  }

  // Top of an older note cycle (played through the keyboard) with the
  // arpeggio on: each round starts as the take did. The keys the cycle
  // latched (Hold) go, and with no key left the arpeggio starts again.
  noteLoopTop(n) {
    if (!this.pr.trilloOn || (!n.on.size && !n.latched.size)) return;
    for (const k of n.latched) if (!n.on.has(k) && !this.keyDown[k]) this.releaseKey(k);
    n.latched.clear();
    if (!this.keyStack.length) this.arpRestart();
  }

  noteLoopTick() {
    this.eventLoopTick(this.octaveLoop);
    this.eventLoopTick(this.noteLoop);
  }

  eventLoopTick(n) {
    if (!n) return;
    if (this.timeMs < n.origin) return; // waiting for the beat
    const pos = ((this.timeMs - n.origin) * n.rate) % n.length;
    const fire = (from, to) => {
      for (const [at, key, p, target, bend, acc] of n.points) {
        if (at <= from || at > to) continue;
        this.noteLooping = true;
        if (p > 0 && target !== undefined) { this.loopVoiceOn(key, p, target, bend, acc); n.direct.add(key); }
        else if (p > 0) { // older cycles: through the keyboard
          if (n.on.has(key)) this.keyOff(key);
          this.keyOn(key, p); n.on.add(key);
          if (this.pr.latchedNote) n.latched.add(key);
        }
        else if (p === 0) { if (n.direct.delete(key)) this.loopVoiceOff(key); else if (n.on.delete(key)) this.keyOff(key); }
        else if (p === -3) { if (!n.pinned) this.loopOctave(target); }
        else if (p === -4) this.loopRetune(key, target, bend);
        else if (p === -1 && n.direct.has(key)) this.loopVoiceBend(key, target, bend);
        else if (p === -2 && n.direct.has(key)) {
          if (!n.direct.has(target)) { this.loopVoiceSlide(key, target); n.direct.delete(key); n.direct.add(target); }
        }
        else if (n.on.has(key) && p === -1) this.keyBend(key, target, bend);
        else if (n.on.has(key) && p === -2 && !n.on.has(target)) {
          this.keySlide(key, target);
          n.on.delete(key); n.on.add(target);
        }
        this.noteLooping = false;
      }
    };
    if (pos >= n.last) fire(n.last, pos);
    else {
      fire(n.last, n.length);
      if (n === this.noteLoop) this.noteLoopTop(n);
      if (n.pending.length) { n.points = [...n.points, ...n.pending]; n.pending = []; }
      fire(-1, pos);
    }
    n.last = pos;
  }

  clockPhase() {
    const period = this.clockTimeMs;
    return Math.trunc(((this.timeMs - this.clockStart) % period) * 256 / period) & 255;
  }

  // ---- Modulation sums -------------------------

  // Web: one LFO per control, run by the Daisy (lfo_bank.h of the engine) from the
  // frame bytes 96-112. Each assigned control moves from its value by its
  // own bipolar amount (lfoDepth) times its own wave.
  lfoDepthOf(d) {
    const pr = this.pr, mask = pr.lfoAssigned;
    if (!SUPPORTED.has(d) || !(mask[d >> 3] & (1 << (d & 7)))) return 0;
    return clamp(Math.round(pr.lfoDepth?.[d] ?? 0), -255, 255);
  }

  // Where the LFO moves a control now (control units), for the display.
  lfoShown(d) { return this.lfoDepthOf(d) * this.lfoWaves[d] / 255; }

  // What the controller applies itself: attack, release, transpose, tune
  // and master; the Daisy applies the others.
  lfo(d) { return LFO_HERE.has(d) ? this.lfoShown(d) : 0; }

  // lfo_bank.h WriteEntry (engine): four controls a frame, the one being
  // edited every time, the others in turn (20 controls: 7 frames, 35 ms).
  writeLfoBank(f) {
    const pr = this.pr, n = LFO_DESTINATIONS.length;
    f[96] = 0xb8;
    const entry = (slot, d) => {
      const at = 97 + slot * 4, depth = this.lfoDepthOf(d) & 0xffff;
      f[at] = d;
      f[at + 1] = (clamp(pr.lfoWaves?.[d] ?? 1, 0, 5) & 7) | (lfoSpeedIndex(clamp(pr.lfoSpeeds?.[d] ?? 128, 0, 255)) << 3);
      f[at + 2] = depth >> 8; f[at + 3] = depth & 255;
    };
    let slot = 0;
    if (SUPPORTED.has(this.lfoFocus)) entry(slot++, this.lfoFocus);
    for (let tries = 0; slot < 4 && tries < n; tries++) {
      const d = LFO_DESTINATIONS[this.lfoCursor++ % n];
      if (d !== this.lfoFocus) entry(slot++, d);
    }
  }

  cc(d) {
    let sum = 0;
    for (let i = 0; i < 4; i++)
      if (this.pr.ccAssignDest[i] === d) sum += Math.trunc(this.midiCc[i] * this.pr.ccAssignAmount[i] / 100);
    return sum;
  }

  // ---- Frame (updateBuffer) --------------------------------

  buildFrame() {
    const pr = this.pr, f = this.frame;
    f.fill(0);
    const cc = (d) => this.cc(d), assign = (d) => this.lfo(d) + this.cc(d);
    const u16 = (at, value) => { const x = clamp(Math.round(value), 0, 65535); f[at] = x >> 8; f[at + 1] = x & 255; };

    for (let i = 0; i < VOICES; i++) {
      const v = this.v[i];
      if (v.trig) {
        this.gen[i] = this.gen[i] + 1 >= 0x80 ? 1 : this.gen[i] + 1;
        v.trig = false;
        this.attacks.push(this.timeMs);
      }
      f[NOTE[i]] = v.note; f[CENTS[i]] = v.cents; f[GATE[i]] = v.gate ? 1 : 0;
      f[TRIGGER[i]] = this.gen[i];
      // Web drone stutter: the captured voices go silent (pressure drives the
      // sustain level), still held, while the repeat plays; new notes sound.
      f[PRESSURE[i]] = (v.owner === OWNER_MIDI && !v.gate) || (this.droneMuted && this.capturedVoice(v)) ? 0 : v.aft;
    }
    f[6] = clamp(Math.round(pr.attack + assign(DEST.Attack)), 0, 255);
    f[7] = clamp(Math.round(pr.release + assign(DEST.Release)), 0, 255);
    u16(10, pr.wave_shape + assign(DEST.OscWave) * 255);
    f[12] = clamp(Math.round(pr.spectralWidth + assign(DEST.Width)), 0, 255);
    u16(14, pr.spectralRotate + assign(DEST.Rotate) * 255);
    f[16] = clamp(Math.round(pr.delayShift + assign(DEST.Dispersion)), 0, 255);
    const subIndex = pr.subOctave === 4 ? 2 : pr.subOctave === 2 ? 1 : 0;
    f[17] = 1 << clamp(subIndex + Math.round(assign(DEST.SubDivider) * 2 / 255), 0, 2);
    f[20] = clamp(Math.round(pr.delayTime + assign(DEST.DelayTime)), 0, 255);
    f[21] = clamp(Math.round(pr.delayRegen + assign(DEST.Feedback)), 0, 255);
    f[22] = clamp(Math.round(pr.subWave + assign(DEST.SubWave)), 0, 255);
    f[23] = 0x53;
    f[24] = clamp(Math.round(pr.crossMod + assign(DEST.Crossmod)), 0, 255);
    u16(25, this.clockTimeMs);
    f[27] = this.restartBits;
    f[28] = pr.delayReverse ? 1 : 0;
    f[29] = 0xb0 | (pr.oscBank >= 0 && pr.oscBank <= 4 ? pr.oscBank : 0); // 4: web External
    f[30] = clamp(Math.trunc(assign(DEST.Master) * 127 / 255), -127, 127) & 255;
    f[32] = clamp(Math.round(pr.spectralBands + assign(DEST.Bands)), 0, 255);
    // Spread: legacy byte 33 plus the u16 extension (spectral_control.h).
    const spread = clamp(pr.spectralSpread + assign(DEST.Spread), 0, 255);
    const spread16 = Math.trunc(clamp(spread / 255, 0, 1) * 65535 + 0.5);
    f[33] = Math.trunc(spread16 / 257); f[113] = 0x53; f[114] = 1; f[115] = spread16 >> 8; f[116] = spread16 & 255;
    f[35] = Math.trunc(IMAGE / 65535 * 255);
    u16(36, pr.oscSubBlend + assign(DEST.Blend) * 255);
    f[42] = this.clockPhase();
    f[43] = 0; f[45] = 72;
    f[53] = pr.trilloOn ? 1 : 0;
    f[54] = clamp(pr.subDetuneCents + Math.round(assign(DEST.SubDetune) * 200 / 255), -100, 100) + 100;
    f[57] = 255; // the wave at full scale; lfo() applies the amount
    f[58] = clamp(pr.lfoWave + Math.round(assign(DEST.LfoWave) * 5 / 255), 0, 5);
    f[59] = clamp(pr.lfoSpeed + assign(DEST.LfoSpeed), 0, 255);
    f[60] = clamp(Math.round(pr.reverbSize + assign(DEST.ReverbSize)), 0, 255);
    f[61] = 255;
    f[62] = clamp(Math.round(pr.reverbFuse + assign(DEST.ReverbDetail)), 0, 255);
    f[63] = clamp(Math.round(pr.delayFeedback + assign(DEST.DelayFeedback)), 0, 255);
    f[64] = 0xf2;
    f[65] = (pr.bandAttackShape & 15) | ((pr.bandReleaseShape & 15) << 4);
    f[66] = ~pr.bandSustainMask & 255;
    f[80] = clamp(Math.round(pr.driveAmount + assign(DEST.Drive)), 0, 255);
    f[81] = this.analyserRequested ? 0xa6 : 0;
    f[83] = clamp(pr.spectralMode + Math.round(assign(DEST.FilterMode) / 255), 0, 3);
    f[87] = 0xb7; f[88] = 7; // bytes 89-95: the single LFO has no destinations
    this.writeLfoBank(f);
    return f;
  }

  // Daisy reply (FillNormalSpiTxFrame): envelopes and LFO output; web: the
  // wave of every control's LFO (spectrum_lfo_waves).
  reply(tx, waves) {
    if (waves) this.lfoWaves.set(waves);
    if (tx[17] !== 54) return;
    for (let i = 0; i < VOICES; i++) this.adsr[i] = tx[ENVELOPE[i]];
    this.lfoOutput = tx[34];
  }

  // Advance control time by one 5 ms frame.
  // Delay lines hit by an echo now: the eight predelays have no feedback, so
  // each attack returns once per line after that line's tap time.
  delayHits(tapMs, windowMs = 90) {
    let mask = 0;
    for (const t of this.attacks)
      for (let b = 0; b < 8; b++) {
        const at = t + tapMs[b];
        if (tapMs[b] > 5 && this.timeMs >= at && this.timeMs < at + windowMs) mask |= 1 << b;
      }
    return mask;
  }

  tick(ms) {
    this.timeMs += ms;
    while (this.attacks.length && this.timeMs - this.attacks[0] > 16000) this.attacks.shift();
    this.noteLoopTick();
    this.arpeggio();
    this.midiArpeggio();
    this.refreshVoices();
    this.recScan();
  }

  // Pitch of the most recent note, for the analyser filter overlay.
  displayNoteHz() {
    const v = this.v[this.lastVoice ?? 0];
    return 440 * Math.pow(2, (v.note - 69 + (v.cents - 50) / 100) / 12);
  }

  // Snapshot for the panel: LEDs and display.
  status() {
    return {
      keys: Array.from(this.keyDown),
      stack: this.keyStack.slice(),
      voices: this.v.map((v, i) => ({ key: v.owner === OWNER_KEYBOARD ? v.key : 255, gate: v.gate, env: this.adsr[i], note: v.note })),
      latched: this.pr.latchedNote,
      captured: [...this.momentaryHold],
      midiCaptured: [...this.midiHeld.values()].some((h) => h.captured),
      trilloOn: this.pr.trilloOn,
      arpKey: this.arpKey,
      arpPaused: !!this.arpPaused,
      octave: this.pr.octaveIndex,
      octaveSeq: this.octaveSeq || 0,
      bpm: this.bpm,
      clockPhase: this.clockPhase(),
      lfoOutput: this.lfoOutput,
      lfoWaves: Array.from(this.lfoWaves),
    };
  }
}
