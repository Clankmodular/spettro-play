// Port of shared/trillo_pattern.h and trillo_groove.h: arpeggio patterns,
// step divisions; the groove templates are the web's own.

export const PATTERNS = ['up', 'down', 'up/down', 'played', 'reverse', 'random', 'shuffle', 'converge', 'thumb', 'pinky'];
const UP = 0, DOWN = 1, UPDOWN = 2, PLAYED = 3, REVERSE = 4, RANDOM = 5, SHUFFLE = 6, CONVERGE = 7, THUMB = 8, PINKY = 9;

// Web grooves (31 October, the user's choice: the firmware's genre names,
// mostly swing and drum accents, did not suit the instrument). On Spettro the
// pressure opens the bands and drives the sustain, so a groove moves the
// timbre as well as the time. Level: pressure in % (null: as played); delay:
// % of a step, after the grid. Always at full amount (no amount row).
export const GROOVES = [
  ['straight', null, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['swing', [100, 50, 75, 50, 95, 50, 75, 55, 100, 50, 75, 50, 95, 50, 80, 60], [0, 50, 0, 50, 0, 50, 0, 50, 0, 50, 0, 50, 0, 50, 0, 50]],
  // Beats full, the steps between barely touched: the bands just open.
  ['ghost', [100, 18, 22, 15, 95, 20, 15, 25, 100, 15, 22, 18, 90, 25, 15, 20], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  // The pressure climbs over the bar (the filter opens), falls, or both.
  ['swell', [20, 25, 31, 36, 41, 47, 52, 57, 63, 68, 73, 79, 84, 89, 95, 100], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['fade', [100, 95, 89, 84, 79, 73, 68, 63, 57, 52, 47, 41, 36, 31, 25, 20], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['breath', [20, 23, 32, 45, 60, 75, 88, 97, 100, 97, 88, 75, 60, 45, 32, 23], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  // Seven accents spread evenly over 16 (Euclidean rhythm).
  ['euclid', [100, 30, 100, 30, 100, 30, 100, 30, 30, 100, 30, 100, 30, 100, 30, 30], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  // An accent every 3 steps against the bar of 4, realigned every 16.
  ['poly 3', [100, 40, 40, 100, 40, 40, 100, 40, 40, 100, 40, 40, 100, 40, 40, 100], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  // In each group of 4 the notes close up and fade, like a bouncing ball.
  ['rush', [100, 80, 65, 50, 100, 80, 65, 50, 100, 80, 65, 50, 100, 80, 65, 50], [0, 60, 70, 50, 0, 60, 70, 50, 0, 60, 70, 50, 0, 60, 70, 50]],
  // Uneven delays and pressures, the same on every bar: loose, drunk.
  ['drift', [90, 55, 75, 100, 45, 80, 60, 95, 70, 50, 100, 65, 85, 40, 75, 60], [0, 22, 8, 35, 12, 28, 4, 40, 18, 6, 30, 14, 38, 10, 25, 2]],
].map(([name, level, delay]) => ({ name, level, delay }));

// Tempo row: (speed*7)>>8 selects steps per beat.
export const DIVISIONS = ['/4', '/2', 'X1', 'X2', 'X4', 'X8', 'X16'];
const STEPS_PER_BEAT = [0.25, 0.5, 1, 2, 4, 8, 16];
export const divisionIndex = (speed) => Math.min(6, Math.max(0, (speed * 7) >> 8));
export const stepsPerBeat = (speed) => STEPS_PER_BEAT[divisionIndex(speed)];
export const speedForDivision = (index) => Math.trunc((index * 256 + 128) / 7);

export const PLAYED_PRESSURE = 256;
export function groovePressure(groove, step) {
  const levels = GROOVES[groove % GROOVES.length].level;
  return levels ? Math.trunc((255 * levels[step & 15] + 50) / 100) : PLAYED_PRESSURE;
}
export const grooveDelay = (groove, step, period) =>
  period * GROOVES[groove % GROOVES.length].delay[step & 15] / 100;

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
