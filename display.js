// The 240 x 240 ST7789 screen of Spectrum, redrawn as on the ESP32: Org_01
// text at integer scales, RGB565 palette, page geometry of display_style.h
// and the analyser of audio_spectrum_ui.inc.
//
// Pages keep the firmware's 240-unit coordinates; the canvas itself has the
// real resolution of the monitor. Rectangles and font pixels are snapped to
// device pixels so the text stays crisp; the analyser curves are vector
// paths sampled every half unit.

import { FONTS } from './fonts.js';

// Web: the screen font can be tried (System -> setup -> font); Org_01 is the
// instrument's. Every font is in the Adafruit GFX layout. A requested size
// becomes the whole-pixel scale giving caps about as tall as Org_01's (5 px
// a size); Org_01 keeps its sizes.
let FONT = FONTS[0].font;
export function setFont(name) { FONT = (FONTS.find((f) => f.name === name) || FONTS[0]).font; }
const pixels = (size) => (FONT === FONTS[0].font ? size : Math.max(1, Math.round(size * 5 / FONT.cap)));

export const SIZE = 240;
// The firmware leaves 12-16 px margins; the web screen shows the useful area
// 6..234 edge to edge. Pointer positions are mapped back with toPage().
export const VIEW = { offset: 6, size: 228 };
export const toPage = (u) => VIEW.offset + u * VIEW.size / SIZE;
const rgb = (c) => `rgb(${((c >> 11) & 31) * 255 / 31 | 0},${((c >> 5) & 63) * 255 / 63 | 0},${(c & 31) * 255 / 31 | 0})`;
export const COLOR = {
  normal: rgb(0xbdf7), highlight: rgb(0x24be), selected: rgb(0xfaa4), rule: rgb(0x2104),
  card: rgb(0x1082), cardFocus: rgb(0x1105), cardEdit: rgb(0x2081), rail: rgb(0x3186), secondary: rgb(0x7bef),
  track: rgb(0x18c3), meter: rgb(0x6efb), longer: rgb(0xfd20), outline: rgb(0x4e7f),
  fillOut: rgb(0x0845), fillIn: rgb(0x3845), filterFill: rgb(0x3800), filterLine: rgb(0xc104),
  popup: rgb(0xf206), grid: rgb(0x1082),
};
const TITLE_X = 16, TITLE_Y = 17, TOP = 70, BASELINE = 207, STEREO_Y = 216, DELAY_Y = 54;
const PLOT_HEIGHT = BASELINE - TOP - 3;
const MIN_HZ = 30, MAX_HZ = 20000;
const SAMPLES = 2 * SIZE; // analyser resolution, half a unit
const MODES = ['fixed', 'harmonic', 'interval', 'inharmonic'];
const BANKS = { 0: 'classic', 1: 'exciter', 2: 'fold', 3: 'noise', 4: 'external' };

function glyph(c) {
  const code = c.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e ? FONT.glyphs[code - 0x20] : null;
}

export function textWidth(text, size = 1) {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const g = glyph(text[i]);
    if (g) w += i < text.length - 1 ? g[3] : g[4] + g[1];
  }
  return w * pixels(size);
}

// Top-left datum like TFT_eSPI TL_DATUM; scale maps font pixels to screen.
function drawGlyphs(ctx, text, x, y, color, scale) {
  ctx.fillStyle = color;
  let advance = 0;
  for (const c of text) {
    const g = glyph(c);
    if (!g) continue;
    const [offset, w, h, xAdvance, xOffset, yOffset] = g;
    for (let row = 0; row < h; row++)
      for (let col = 0; col < w; col++) {
        const bit = row * w + col;
        if (!(FONT.bitmap[offset + (bit >> 3)] & (0x80 >> (bit & 7)))) continue;
        const left = scale(advance + xOffset + col), right = scale(advance + xOffset + col + 1);
        const top = scale(FONT.top + yOffset + row), bottom = scale(FONT.top + yOffset + row + 1);
        ctx.fillRect(x + left, y + top, right - left, bottom - top);
      }
    advance += xAdvance;
  }
}

export function drawText(ctx, text, x, y, size, color, align = 'left') {
  const w = textWidth(text, size);
  if (align === 'center') x -= w / 2;
  else if (align === 'right') x -= w;
  const k = pixels(size);
  drawGlyphs(ctx, text, Math.round(x), Math.round(y), color, (v) => v * k);
}

// Analyser titles: Org_01 rasterized at 23/10 (analyserTitlePixel).
const titlePixel = (v) => (FONT === FONTS[0].font ? Math.trunc((v * 23 + 5) / 10) : v * pixels(2.3));
function drawTitle(ctx, text, x, y, color) { drawGlyphs(ctx, text, x, y, color, titlePixel); }
const titleWidth = (text) => titlePixel(textWidth(text) / pixels(1));

export class Display {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.message = null;
    this.scale = 1;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // Backing store at the real pixel size; drawing stays in 240 units,
  // zoomed so the area VIEW fills the canvas.
  resize() {
    const css = this.canvas.getBoundingClientRect().width || SIZE;
    const k = Math.max(0.25, css * (window.devicePixelRatio || 1) / SIZE);
    if (Math.abs(k - this.scale) < 0.01 && this.canvas.width === Math.round(SIZE * k)) return;
    this.scale = k;
    this.canvas.width = this.canvas.height = Math.round(SIZE * k);
    const ctx = this.ctx, K = k * SIZE / VIEW.size, o = VIEW.offset;
    ctx.setTransform(K, 0, 0, K, -o * K, -o * K);
    // Rectangles land on whole device pixels: crisp font and cards.
    const raw = CanvasRenderingContext2D.prototype.fillRect;
    ctx.fillRect = (x, y, w, h) => {
      const X0 = Math.round((x - o) * K), Y0 = Math.round((y - o) * K);
      const X1 = Math.round((x + w - o) * K), Y1 = Math.round((y + h - o) * K);
      raw.call(ctx, X0 / K + o, Y0 / K + o, (X1 - X0) / K, (Y1 - Y0) / K);
    };
  }

  // Popup as showUiMessage: 1000 ms, 900 ms for mode names.
  show(text, ms = 1000) { this.message = { text, until: performance.now() + ms }; }

  clear() {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, SIZE, SIZE);
  }

  render(state) {
    this.clear();
    if (!state) return;
    this.drawAnalyser(state);
    if (this.message && performance.now() < this.message.until) this.drawMessage(this.message.text);
  }

  drawMessage(text) {
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(10, 84, 220, 78);
    ctx.strokeStyle = COLOR.popup;
    ctx.lineWidth = 2;
    ctx.strokeRect(11, 85, 218, 76);
    let size = 4;
    while (size > 1 && textWidth(text, size) > 200) size--;
    drawText(ctx, text, 120, 123 - size * 3, size, COLOR.normal, 'center');
  }

  drawAnalyser({ reply, pr, geometry }) {
    const ctx = this.ctx;
    drawTitle(ctx, MODES[pr.spectralMode] || 'fixed', TITLE_X, TITLE_Y, COLOR.normal);
    const bank = BANKS[pr.oscBank] || 'classic';
    drawTitle(ctx, bank, 224 - titleWidth(bank), TITLE_Y, COLOR.normal);

    ctx.fillStyle = COLOR.grid;
    for (let x = 30; x < SIZE; x += 30) ctx.fillRect(x, TOP + 3, 1, BASELINE - TOP - 3);
    for (let y = TOP + 57; y < BASELINE; y += 54) ctx.fillRect(0, y, SIZE, 1);

    // Measured spectrum: 64 columns, -48..-12 dB window, linear interpolation.
    const level = (raw) => Math.min(1, Math.max(0, (-72 * (1 - raw / 255) + 48) / 36));
    const analysing = reply[44] === 0xa6;
    const columns = Array.from({ length: 64 }, (_, i) => (analysing ? level(reply[48 + i]) : 0) * PLOT_HEIGHT);
    const spectrum = new Float32Array(SAMPLES), filter = this.filterOverlay(geometry);
    for (let i = 0; i < SAMPLES; i++) {
      const pos = Math.min(63, Math.max(0, (i / 2) * (64 / (SIZE - 1)) - 0.5));
      const l = Math.floor(pos), r = Math.min(l + 1, 63);
      spectrum[i] = columns[l] + (columns[r] - columns[l]) * (pos - l);
    }
    const area = (heights) => {
      const p = new Path2D();
      p.moveTo(0, BASELINE);
      for (let i = 0; i < SAMPLES; i++) p.lineTo(i / 2, BASELINE - heights[i]);
      p.lineTo(SIZE, BASELINE);
      p.closePath();
      return p;
    };
    const curve = (heights) => {
      const p = new Path2D();
      for (let i = 0; i < SAMPLES; i++) (i ? p.lineTo : p.moveTo).call(p, i / 2, BASELINE - heights[i]);
      return p;
    };
    const filterArea = area(filter.heights), spectrumArea = area(spectrum);
    ctx.fillStyle = COLOR.filterFill;
    ctx.fill(filterArea);
    // Spectrum: dark blue outside the filter lobes, lighter where they overlap.
    ctx.fillStyle = COLOR.fillOut;
    ctx.fill(spectrumArea);
    ctx.save();
    ctx.clip(filterArea);
    ctx.fillStyle = COLOR.fillIn;
    ctx.fill(spectrumArea);
    ctx.restore();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLOR.filterLine;
    ctx.stroke(curve(filter.heights));
    ctx.strokeStyle = COLOR.outline;
    ctx.stroke(curve(spectrum));
    ctx.fillStyle = COLOR.rail;
    ctx.fillRect(0, BASELINE, SIZE, 1);

    // Stereo meter growing outwards from the centre.
    const left = analysing ? level(reply[112]) * 110 : 0;
    const right = analysing ? level(reply[113]) * 110 : 0;
    ctx.fillStyle = COLOR.track;
    ctx.fillRect(8, STEREO_Y, 110, 6); ctx.fillRect(122, STEREO_Y, 110, 6);
    ctx.fillStyle = COLOR.meter;
    if (left > 0) ctx.fillRect(118 - left, STEREO_Y, left, 6);
    if (right > 0) ctx.fillRect(122, STEREO_Y, right, 6);
    ctx.fillStyle = COLOR.normal;
    ctx.fillRect(119, STEREO_Y - 2, 2, 10);

    // Delay target times at each filter's frequency (delay_timing.h).
    ctx.fillStyle = COLOR.rail;
    ctx.fillRect(0, DELAY_Y, SIZE, 1);
    const timing = reply[114] === 0xd8 && reply[115] <= 8 ? reply[115] : 0;
    for (let b = 0; b < 8; b++) {
      const c = filter.centers[b];
      if (c < 0) continue;
      const active = b < timing;
      const offset = active ? delayOffset(reply[116 + b]) : 0;
      const tip = DELAY_Y - offset;
      ctx.fillStyle = !active ? COLOR.track : offset > 0 ? COLOR.longer : COLOR.meter;
      if (active && tip !== DELAY_Y) ctx.fillRect(c - 1, Math.min(tip, DELAY_Y), 3, Math.abs(tip - DELAY_Y) + 1);
      ctx.fillRect(c - 2, tip - 1, 5, 3);
    }
  }

  // Gaussian lobes at the DSP's centre and -3 dB edges (keyboardFilterOverlay).
  filterOverlay(g) {
    const heights = new Float32Array(SAMPLES), centers = new Float32Array(8).fill(-1);
    if (!g) return { heights, centers };
    const count = g[0], scale = 239 / Math.log(MAX_HZ / MIN_HZ);
    const project = (hz) => Math.log(hz / MIN_HZ) * scale;
    const bands = Math.max(1, count);
    for (let b = 0; b < count; b++) {
      const f = g[1 + b], gain = g[9 + b], lower = g[17 + b], upper = g[25 + b];
      if (gain <= 0 || upper < MIN_HZ || lower > MAX_HZ) continue;
      const center = project(f);
      centers[b] = Math.min(239, Math.max(0, center));
      const lw = 1 + Math.max(0, center - project(lower)), rw = 1 + Math.max(0, project(upper) - center);
      const peak = (PLOT_HEIGHT - 1) * Math.min(1, Math.max(0, gain * Math.sqrt(bands)));
      const first = Math.max(0, Math.floor((center - 4 * lw) * 2)), last = Math.min(SAMPLES - 1, Math.ceil((center + 4 * rw) * 2));
      for (let i = first; i <= last; i++) {
        const x = i / 2, d = (x - center) / (x < center ? lw : rw);
        heights[i] = Math.max(heights[i], peak * Math.exp(-0.34657359 * d * d));
      }
    }
    return { heights, centers };
  }
}

function delayOffset(ratio) {
  if (ratio === 64) return 0;
  const octaves = ratio ? Math.log2(ratio / 64) : -2;
  return Math.round(Math.min(2, Math.max(-2, octaves)) * 6);
}

export { MODES, BANKS };
