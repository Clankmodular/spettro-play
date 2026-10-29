// Port of shared/keyboard_scales.h: tunings, pad layouts and degree mapping.

export const SCALES = [
  ['Chromatic', [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]],
  ['Major', [0, 200, 400, 500, 700, 900, 1100]],
  ['NatMinor', [0, 200, 300, 500, 700, 800, 1000]],
  ['HarmMinor', [0, 200, 300, 500, 700, 800, 1100]],
  ['MelMinor', [0, 200, 300, 500, 700, 900, 1100]],
  ['Dorian', [0, 200, 300, 500, 700, 900, 1000]],
  ['Phrygian', [0, 100, 300, 500, 700, 800, 1000]],
  ['Lydian', [0, 200, 400, 600, 700, 900, 1100]],
  ['Mixolyd', [0, 200, 400, 500, 700, 900, 1000]],
  ['Locrian', [0, 100, 300, 500, 600, 800, 1000]],
  ['PentaMaj', [0, 200, 400, 700, 900]],
  ['PentaMin', [0, 300, 500, 700, 1000]],
  ['Blues', [0, 300, 500, 600, 700, 1000]],
  ['Hirajoshi', [0, 200, 300, 700, 900]],
  ['Wholetone', [0, 200, 400, 600, 800, 1000]],
  ['Dim H-W', [0, 100, 300, 400, 600, 700, 900, 1000]],
  ['Dim W-H', [0, 200, 300, 500, 600, 800, 900, 1100]],
  ['Augmented', [0, 300, 400, 700, 800, 1100]],
  ['Hungarian', [0, 200, 300, 600, 700, 800, 1100]],
  ['Prometheus', [0, 200, 400, 600, 900, 1000]],
  // Spectrum variants: first octave of the previous project tunings.
  ['Slendro', [0, 224.3, 449.7, 676.0, 902.1]],
  ['Pelog', [0, 147.1, 386.3, 676.0, 902.1]],
  ['Sundanese', [0, 147.1, 449.7, 676.0, 902.1]],
  ['24-EDO', Array.from({ length: 24 }, (_, i) => i * 50)],
].map(([name, cents]) => ({ name, cents }));

export const LAYOUT_STEPS = [0, 2, 3, 4, 5, 7];
export const LAYOUT_NAMES = ['linear', '+2', '+3', '+4', '+5', '+7'];
export const REFERENCE = 261.6255653; // C4, A4 = 440 Hz.

// The Spettro panel has 24 pads in three rows of eight.
export const COLUMNS = 8, ROWS = 3, KEYS = COLUMNS * ROWS;

const layout = (value) => (value < LAYOUT_STEPS.length ? value : 0);
const scaleIndex = (value) => (value < SCALES.length ? value : 0);

// Physical indices run left to right, top row first; lowest note bottom left.
export function degreeForKey(key, layoutValue, columns = COLUMNS, rows = ROWS) {
  if (!columns || !rows || key >= columns * rows) return 0;
  const row = rows - 1 - Math.floor(key / columns);
  const stride = layout(layoutValue) ? LAYOUT_STEPS[layout(layoutValue)] : columns;
  return row * stride + (key % columns);
}

const FREQUENCIES = SCALES.map((s) => s.cents.map((c) => REFERENCE * Math.pow(2, c / 1200)));

export function frequency(scale, degree) {
  scale = scaleIndex(scale);
  const count = SCALES[scale].cents.length;
  let octave = Math.trunc(degree / count), step = degree % count;
  if (step < 0) { step += count; octave--; }
  return FREQUENCIES[scale][step] * Math.pow(2, octave);
}

export function nearestDegree(scale, f) {
  scale = scaleIndex(scale);
  if (!(f > 0) || !Number.isFinite(f)) return 0;
  const cents = 1200 * Math.log2(f / REFERENCE);
  const octave = Math.floor(cents / 1200);
  const within = cents - octave * 1200;
  const def = SCALES[scale].cents;
  let best = 0, distance = within;
  for (let i = 1; i <= def.length; i++) {
    const candidate = i === def.length ? 1200 : def[i];
    const delta = Math.abs(within - candidate);
    if (delta < distance) { best = i; distance = delta; }
  }
  return octave * def.length + best;
}
