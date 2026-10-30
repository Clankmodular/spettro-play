// Panel geometry measured from the Spettro artwork.
// Units are PDF points in a 842 x 595 viewBox with y pointing down; the
// static artwork (panel.svg) uses the same space, so positions match the
// drawing exactly.

export const VIEWBOX = { width: 842, height: 595 };
// Whole instrument, pad field included. The web panel is cut straight at
// y 63 (no connector area). The bottom edge, with its
// 14 pt corners, ends at y 573.4; the same 5 pt margin as at the top.
export const CROP = { x: 8, y: 58, width: 828, height: 521 };

// 24 touch pads (45.9 pt), three rows of eight, each row shifted half a pad
// to the left of the one above. Index 0 is the top-left pad.
const PAD_ROWS = [
  { y: 427.6, x0: 418.7 },
  { y: 474.2, x0: 391.7 },
  { y: 520.9, x0: 364.8 },
];
export const PAD_SIZE = 45.9;
export const PADS = PAD_ROWS.flatMap((row, r) =>
  Array.from({ length: 8 }, (_, c) => ({ index: r * 8 + c, row: r, col: c, x: row.x0 + c * 53.86, y: row.y })));

// Knob caps are 31.2 pt with a 270-degree printed scale around them.
export const KNOBS = [
  { id: 'amount',  x: 63.4,  y: 169.4 },
  { id: 'speed',   x: 120.2, y: 114.0 },
  { id: 'shape',   x: 277.1, y: 197.7 },
  { id: 'shift',   x: 219.4, y: 272.3 },
  { id: 'reso',    x: 141.7, y: 325.1 },
  { id: 'xmod',    x: 364.9, y: 281.4 },
  { id: 'spread',  x: 638.8, y: 207.3 },
  { id: 'diffuse', x: 716.4, y: 154.9 },
  { id: 'time',    x: 581.3, y: 281.1 },
];

// Fader caps are 22.7 pt; slots are 6.2 x 69.2 pt with round ends.
// from/to are the cap centre at the two ends of travel (to = maximum).
export const FADERS = [
  { id: 'bands',   from: [63.4, 303.4],  to: [63.4, 240.4] },
  // Oscillator A is the sub, B the main oscillator with the banks.
  { id: 'oscA',    from: [443.7, 312.9], to: [443.7, 249.9] },
  { id: 'oscB',    from: [482.2, 312.9], to: [482.2, 249.9] },
  { id: 'blend',   from: [333.3, 349.7], to: [396.3, 349.7] },
  // Web: image is fixed; drive moved to its fader, fx mix (dry/effects) on
  // the old drive fader.
  { id: 'fx',      from: [536.4, 210.3], to: [536.4, 147.3] },
  { id: 'drive',   from: [575.8, 168.7], to: [575.8, 105.7] },
  { id: 'volume',  from: [786.2, 186.4], to: [786.2, 123.4] },
  // Web-only hold fader (pressure for PC keyboard and mouse) takes the
  // original attack place; attack moves one column left and 10 pt down.
  { id: 'attack',  from: [709.3, 322.9], to: [709.3, 259.9] },
  { id: 'hold',    from: [747.7, 312.9], to: [747.7, 249.9] },
  { id: 'release', from: [786.1, 312.9], to: [786.1, 249.9] },
  // Diagonal transpose fader beside the pads.
  { id: 'transpose', from: [291.9, 499.6], to: [323.2, 443.0] },
];

// Round push buttons (17.9 pt caps) with their LED, when the panel has one.
export const BUTTONS = [
  { id: 'lfoAssign', x: 177.7, y: 114.0, led: { x: 177.7, y: 133.1, shape: 'dot' } },
  { id: 'lfoWave',   x: 283.7, y: 114.0 },
  { id: 'mode',      x: 271.0, y: 325.0, led: { x: 290.1, y: 325.0, shape: 'dot' } },
  { id: 'subOctave', x: 443.7, y: 349.6 },
  { id: 'bank',      x: 482.2, y: 349.6, led: { x: 501.3, y: 349.6, shape: 'dot' } },
  // Tap: Delay / Freeze bank; hold 1 s: normal / reverse.
  { id: 'delay',     x: 554.7, y: 349.8, led: { x: 573.8, y: 349.6, shape: 'dot' } },
  { id: 'envelope',  x: 786.1, y: 349.8, led: { x: 805.2, y: 349.6, shape: 'dot' } },
  { id: 'preset',    x: 74.5,  y: 398.6, led: { x: 74.5,  y: 376.3, shape: 'pill' } },
  { id: 'clock',     x: 125.3, y: 412.8, led: { x: 125.0, y: 390.5, shape: 'pill' } },
  { id: 'system',    x: 175.8, y: 434.8, led: { x: 175.8, y: 412.5, shape: 'pill' } },
];

// Ring buttons (22.7 pt caps in a 24.1 pt bezel) along the lower edge.
export const RING_BUTTONS = [
  { id: 'octDown2', x: 49.4,  y: 448.6, led: { x: 49.4,  y: 423.1 } },
  { id: 'octDown1', x: 93.4,  y: 459.1, led: { x: 93.4,  y: 433.5 } },
  { id: 'octUp1',   x: 137.3, y: 475.9, led: { x: 137.3, y: 450.3 } },
  { id: 'octUp2',   x: 181.2, y: 500.3, led: { x: 181.2, y: 474.7 } },
  { id: 'hold',     x: 225.2, y: 533.7, led: { x: 225.2, y: 508.1 } },  // printed as a snowflake
  { id: 'arp',      x: 252.2, y: 486.4, led: { x: 252.2, y: 460.8 } },
  { id: 'loop',     x: 279.2, y: 439.1, led: { x: 279.2, y: 413.5 } },  // records control movements
];

// LFO waveform LEDs, left to right as printed: tri, ramp down, ramp up,
// square, random (Daisy waves 1..5; the final firmware drops the sine).
export const LFO_LEDS = [202.1, 216.2, 230.4, 244.5, 258.6].map((x) => ({ x, y: 114.0 }));

// Sub divisor LEDs beside the 1 / 2 / 4 legend.
export const SUB_LEDS = [335.2, 349.6, 364.0].map((y) => ({ x: 424.6, y }));

// Eight-segment band chains, pill shaped and following the printed arc.
export const BAND_CHAIN = [
  [107.3, 255.7], [124.8, 246.0], [141.4, 234.8], [156.9, 222.2],
  [171.1, 208.3], [184.1, 193.1], [195.6, 176.7], [205.3, 160.0],
];
export const SPREAD_CHAIN = [
  [646.4, 301.8], [659.5, 286.0], [672.1, 270.1], [686.2, 255.3],
  [701.6, 241.8], [718.1, 229.7], [735.6, 219.2], [751.5, 209.5],
];

// TFT window. The instrument has 69.2 pt at (388.9, 125); the web panel uses
// 124.74 pt where the logo was (154 pt reduced twice by 10%, same centre). There is no encoder: pages are edited with
// the mouse on the screen.
export const DISPLAY = { x: 361.13, y: 86.63, size: 124.74 };

// Trimmers printed with the tuning-fork and comb symbols.
export const TRIMMERS = [
  { id: 'tune',  x: 671.1, y: 349.8 },
  { id: 'touch', x: 709.4, y: 349.8 },
];
