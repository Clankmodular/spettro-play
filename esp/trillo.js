// Port of shared/trillo_pattern.h and trillo_groove.h: arpeggio patterns,
// groove templates and step divisions.

export const PATTERNS = ['up', 'down', 'up/down', 'played', 'reverse', 'random', 'shuffle', 'converge', 'thumb', 'pinky'];
const UP = 0, DOWN = 1, UPDOWN = 2, PLAYED = 3, REVERSE = 4, RANDOM = 5, SHUFFLE = 6, CONVERGE = 7, THUMB = 8, PINKY = 9;

export const GROOVES = [
  ['Straight', [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Backbeat', [80, 45, 60, 50, 100, 50, 65, 55, 80, 45, 60, 50, 100, 55, 70, 60], [0, 6, 2, 8, 10, 6, 2, 8, 0, 6, 2, 8, 12, 6, 2, 10]],
  ['Swing', [100, 50, 75, 50, 95, 50, 75, 55, 100, 50, 75, 50, 95, 50, 80, 60], [0, 50, 0, 50, 0, 50, 0, 50, 0, 50, 0, 50, 0, 50, 0, 50]],
  ['Funk', [100, 40, 65, 90, 55, 95, 40, 75, 90, 40, 70, 55, 100, 45, 80, 65], [0, 12, 3, 5, 8, 16, 2, 6, 0, 14, 4, 9, 6, 18, 2, 7]],
  ['Hip Hop', [100, 35, 55, 75, 90, 40, 80, 45, 95, 50, 60, 85, 100, 35, 70, 55], [0, 40, 8, 30, 18, 42, 5, 35, 3, 38, 10, 32, 20, 44, 6, 36]],
  ['Laid Back', [95, 60, 75, 55, 100, 60, 70, 65, 95, 55, 80, 60, 100, 65, 75, 70], [0, 12, 18, 8, 22, 14, 20, 10, 0, 14, 20, 10, 26, 16, 22, 12]],
  ['Breakbeat', [100, 40, 65, 85, 95, 35, 80, 50, 90, 75, 40, 85, 100, 45, 70, 90], [0, 14, 2, 8, 8, 18, 3, 12, 0, 10, 5, 16, 10, 20, 2, 6]],
  ['Reggae', [65, 40, 100, 45, 70, 40, 95, 50, 65, 40, 100, 45, 75, 45, 100, 55], [0, 10, 14, 8, 4, 12, 18, 10, 0, 10, 14, 8, 4, 12, 20, 10]],
  ['Clave', [100, 40, 55, 95, 45, 60, 100, 40, 65, 50, 100, 45, 95, 40, 60, 50], [0, 5, 9, 2, 6, 10, 3, 7, 0, 8, 2, 6, 3, 9, 5, 10]],
  ['Afro', [100, 50, 65, 90, 45, 75, 95, 50, 80, 55, 100, 45, 85, 60, 75, 90], [0, 18, 7, 3, 22, 10, 4, 20, 8, 2, 24, 12, 5, 18, 6, 3]],
].map(([name, level, delay]) => ({ name, level, delay }));

// Tempo row: (speed*7)>>8 selects steps per beat.
export const DIVISIONS = ['/4', '/2', 'X1', 'X2', 'X4', 'X8', 'X16'];
const STEPS_PER_BEAT = [0.25, 0.5, 1, 2, 4, 8, 16];
export const divisionIndex = (speed) => Math.min(6, Math.max(0, (speed * 7) >> 8));
export const stepsPerBeat = (speed) => STEPS_PER_BEAT[divisionIndex(speed)];
export const speedForDivision = (index) => Math.trunc((index * 256 + 128) / 7);

export const PLAYED_PRESSURE = 256;
export function groovePressure(groove, step, amount) {
  if (!amount) return PLAYED_PRESSURE;
  const level = GROOVES[groove % GROOVES.length].level[step & 15];
  return Math.trunc((255 * (10000 - (100 - level) * amount) + 5000) / 10000);
}
export const grooveDelay = (groove, step, amount, period) =>
  period * GROOVES[groove % GROOVES.length].delay[step & 15] * amount / 10000;

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
