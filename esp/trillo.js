// Port of shared/trillo_pattern.h: arpeggio patterns, step divisions; the
// rhythm (Euclidean and humanize) is the web's own, in place of
// trillo_groove.h.

export const PATTERNS = ['up', 'down', 'up/down', 'played', 'reverse', 'random', 'shuffle', 'converge', 'thumb', 'pinky'];
const UP = 0, DOWN = 1, UPDOWN = 2, PLAYED = 3, REVERSE = 4, RANDOM = 5, SHUFFLE = 6, CONVERGE = 7, THUMB = 8, PINKY = 9;

// Web rhythm (4 November, the user's choice, in place of the groove
// templates): a Euclidean rhythm, `hits` spread as evenly as they go over
// `steps` (the first step always plays; hits = steps plays every step), and
// a humanize (0..100 %) on pressure and microswing. A step without a hit is
// a rest: the pattern does not move, so its notes keep their order.
export const MAX_ARP_STEPS = 16;
export const euclidHit = (steps, hits, step) => ((step % steps) * hits) % steps < hits;

// One random value 0..1 per step and use, the same every time it is asked
// (the gate of a step needs the delay of the next one).
function noise(step, salt) {
  let x = (Math.imul(step, 0x9e3779b1) ^ salt) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// Humanize: the odd steps late by up to 22 % of a step (swing; a triplet
// feel is 33 %) and every step by up to 12 % more at random; the pressure
// down by up to 80 % at random (about -13 dB; on Spettro it opens the bands:
// the timbre moves too). Stronger since 4 November (the user did not hear
// it: 12 % + 8 % and 60 % moved the notes by 15 % and 3 dB at most).
export const humanDelay = (human, step, period) =>
  period * human / 100 * ((step & 1) * 0.22 + noise(step, 0x51) * 0.12);
export const humanPressure = (human, step, pressure) =>
  Math.max(1, Math.round(pressure * (1 - human / 100 * 0.8 * noise(step, 0xa7))));

// The groove templates of 31 October, for older presets: their nearest
// rhythm and humanize (straight 0, euclid 7 of 16, poly 3 a rest every 3,
// the loose ones more humanize).
const GROOVE_RHYTHM = [[8, 8, 0], [8, 8, 50], [8, 8, 70], [8, 8, 40], [8, 8, 40], [8, 8, 40],
  [16, 7, 20], [3, 2, 20], [8, 8, 60], [8, 8, 80]];
export function withArpRhythm(pr) {
  if (pr.trilloSteps !== undefined) return pr;
  const { trilloGroove, ...rest } = pr;
  const [trilloSteps, trilloHits, trilloHumanize] = GROOVE_RHYTHM[trilloGroove] || GROOVE_RHYTHM[0];
  return { ...rest, trilloSteps, trilloHits, trilloHumanize };
}

// Per-pad velocity of the arpeggio's rules: `vel` (4 November, 5-100 %, 0
// = as played) became `velocity` 0-100 (the user: a value from 0 to 100,
// starting from how the pad was played); no field = as played.
export function withArpVelocity(pr) {
  if (!pr.arpRules || !Object.values(pr.arpRules).some((r) => r && 'vel' in r)) return pr;
  const arpRules = {};
  for (const [key, { vel, ...rule }] of Object.entries(pr.arpRules)) arpRules[key] = vel ? { ...rule, velocity: vel } : rule;
  return { ...pr, arpRules };
}

// Tempo row: (speed*7)>>8 selects steps per beat.
export const DIVISIONS = ['/4', '/2', 'X1', 'X2', 'X4', 'X8', 'X16'];
const STEPS_PER_BEAT = [0.25, 0.5, 1, 2, 4, 8, 16];
export const divisionIndex = (speed) => Math.min(6, Math.max(0, (speed * 7) >> 8));
export const stepsPerBeat = (speed) => STEPS_PER_BEAT[divisionIndex(speed)];
export const speedForDivision = (index) => Math.trunc((index * 256 + 128) / 7);

// Results are indices into the played stack (trillo::Sequence).
export class Sequence {
  constructor(seed = 0x81b5d9a3) { this.rng = seed >>> 0 || 1; this.reset(); }
  reset(playedStart = 0) { this.count = 0; this.position = 0; this.playedStart = playedStart; this.keys = []; this.order = []; this.deck = []; }

  randomBelow(n) {
    let r = this.rng;
    r ^= r << 13; r >>>= 0; r ^= r >>> 17; r ^= r << 5; r >>>= 0;
    this.rng = r;
    return r % n;
  }

  next(pattern, keys, frequency) {
    const count = keys.length;
    if (!count || count > 24) { this.reset(); return 255; }
    pattern = pattern < PATTERNS.length ? pattern : UP;
    const pitches = keys.map(frequency);
    const order = keys.map((_, i) => i).sort((a, b) => pitches[a] - pitches[b] || a - b);
    let changed = count !== this.count || pattern !== this.pattern;
    for (let i = 0; i < count && !changed; i++) changed = keys[i] !== this.keys[i] || order[i] !== this.order[i];
    if (changed) {
      this.position = pattern === PLAYED ? this.playedStart % count : 0;
      this.playedStart = 0; this.count = count; this.pattern = pattern; this.lastShuffle = 255;
      this.keys = keys.slice(); this.order = order;
    }
    if (count === 1) return 0;
    let rank = 0, length = count;
    const bounce = (step) => (step < count ? step : 2 * count - 2 - step);
    switch (pattern) {
      case DOWN: rank = count - 1 - this.position; break;
      case UPDOWN: case CONVERGE:
        length = 2 * count - 2;
        rank = bounce(this.position);
        if (pattern === CONVERGE) rank = rank & 1 ? count - 1 - (rank >> 1) : rank >> 1;
        break;
      case PLAYED: case REVERSE: {
        const index = pattern === PLAYED ? this.position : count - 1 - this.position;
        this.position = (this.position + 1) % count;
        return index;
      }
      case RANDOM: rank = this.randomBelow(count); break;
      case SHUFFLE:
        if (!this.position) {
          this.deck = Array.from({ length: count }, (_, i) => i);
          for (let i = count - 1; i; i--) { const j = this.randomBelow(i + 1); [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]]; }
          if (this.deck[0] === this.lastShuffle) { const j = 1 + this.randomBelow(count - 1); [this.deck[0], this.deck[j]] = [this.deck[j], this.deck[0]]; }
        }
        rank = this.deck[this.position];
        this.lastShuffle = rank;
        break;
      case THUMB: case PINKY: {
        const pinky = pattern === PINKY;
        length = 2 * (count - 1);
        const step = this.position >> 1;
        rank = (this.position & 1) ? (pinky ? step : step + 1) : (pinky ? count - 1 : 0);
        break;
      }
      default: rank = this.position;
    }
    this.position = (this.position + 1) % length;
    return this.order[rank];
  }
}
