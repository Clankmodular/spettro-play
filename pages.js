// Display pages other than the analyser, following the card layouts of the
// ESP32 firmware (display_style.h, spectrum.cpp drawing functions): header in
// Org_01 size 3 with a rule at y 46, cards on 0x1082 / 0x1105 / 0x2081.
//
// The web version has no encoder: editable cards carry < > arrows and every
// page returns its mouse regions ({x, y, w, h, step, click, select}).

import { COLOR, drawText, textWidth } from './display.js?v=664d8b57f8';

const ARROW_W = 22;

function header(ctx, title, right, back) {
  const text = back ? `< ${title}` : title;
  // Room left of the right-hand label.
  const room = 208 - (right ? textWidth(right, 2) + 8 : 0);
  let size = 3;
  while (size > 1 && textWidth(text, size) > room) size--;
  // '< ' grey, then the title over it in white: offset by the text minus the
  // title (textWidth('< ') would drop the trailing space).
  drawText(ctx, back ? '<' : title, 16, 17, size, back ? COLOR.secondary : COLOR.normal);
  if (back) drawText(ctx, title, 16 + textWidth(text, size) - textWidth(title, size), 17, size, COLOR.normal);
  if (right) drawText(ctx, right, 224, 21, 2, COLOR.secondary, 'right');
  ctx.fillStyle = COLOR.rule;
  ctx.fillRect(16, 46, 208, 1);
}

function arrows(ctx, x, y, w, h, color) {
  const cy = y + h / 2 - 5;
  drawText(ctx, '<', x + w - 2 * ARROW_W + 6, cy, 2, color);
  drawText(ctx, '>', x + w - ARROW_W + 6, cy, 2, color);
}

// Card with a small label and a large value; state: idle or focus.
function card(ctx, x, y, w, h, label, value, state = 'idle', valueSize = 3, withArrows = false) {
  ctx.fillStyle = state === 'focus' ? COLOR.cardFocus : COLOR.card;
  ctx.fillRect(x, y, w, h);
  const accent = state === 'focus' ? COLOR.highlight : COLOR.secondary;
  const room = w - 16 - (withArrows ? 2 * ARROW_W : 0);
  if (h >= 40) {
    drawText(ctx, label, x + 8, y + 6, 2, accent);
    let size = valueSize;
    while (size > 1 && textWidth(value, size) > room) size--;
    drawText(ctx, value, x + 8, y + h - 6 - size * 5, size, state === 'idle' ? COLOR.normal : accent);
  } else {
    const ty = y + (h - 10) / 2;
    drawText(ctx, label, x + 8, ty, 2, accent);
    let size = 2;
    while (size > 1 && textWidth(value, size) > room - textWidth(label, 2) - 8) size--;
    drawText(ctx, value, x + w - 8 - (withArrows ? 2 * ARROW_W - 4 : 0), ty + (2 - size) * 2, size,
      state === 'idle' ? COLOR.normal : accent, 'right');
  }
  if (withArrows) arrows(ctx, x, y, w, h, state === 'idle' ? COLOR.secondary : accent);
}

// Rows of a list page. Item: [label, value, { step, click }]. Three tall
// cards as on the instrument, or compact rows when the list is longer.
function rows(ctx, menu, items) {
  // Fill the page below the header (to 236), up to 54 high: 3 rows 54,
  // 4 rows 43, 5 rows 33.
  const compact = items.length > 3;
  const top = compact ? 52 : 54, gap = compact ? 3 : 6;
  const h = Math.min(54, Math.floor((236 - top - (items.length - 1) * gap) / items.length));
  return items.map(([label, value, act = {}], i) => {
    const y = top + i * (h + gap);
    card(ctx, 12, y, 216, h, label, value, menu.row === i ? 'focus' : 'idle', 3, !!act.step);
    return { x: 12, y, w: 216, h, select: () => { menu.row = i; }, ...act };
  });
}

// Loop page (rec held): one recorded cycle, its values over its length as
// a stepped line, the play position as a 2 px line, and its speed.
export function drawLoopPage(ctx, m, act) {
  header(ctx, m.name || 'loops', `${m.count}/24`, act.back);
  const regions = [{ x: 0, y: 0, w: 240, h: 46, click: act.back }];
  if (!m.lane) {
    card(ctx, 12, 54, 216, 120, 'loops', m.count ? '' : 'none', 'idle', 3);
    return regions;
  }
  const X = 12, Y = 54, W = 216, H = 120, len = m.lane.length, pts = m.lane.points;
  ctx.fillStyle = COLOR.card;
  ctx.fillRect(X, Y, W, H);
  const px = (at) => X + 4 + Math.round((W - 8) * at / len);
  const py = (v) => Y + 4 + Math.round((H - 8) * (1 - v));
  ctx.fillStyle = COLOR.highlight;
  // Notes: a bar per note, one row of 4 px per pad (pad 1 at the top).
  if (m.lane.notes) {
    const open = new Map(), seen = new Set();
    const bar = (key, from, to) => ctx.fillRect(px(from), Y + 6 + key * 4 + 1, Math.max(2, px(to) - px(from)), 3);
    for (const [at, key, p, target] of pts) {
      if (p === -1 || p <= -3) continue; // a bend (the note stays on its row) or an octave change
      // A release with no note before it: an overdubbed note across the top.
      if (p === 0 && !open.has(key) && !seen.has(key)) bar(key, 0, at);
      seen.add(key);
      if (open.has(key)) { bar(key, open.get(key), at); open.delete(key); }
      if (p > 0) open.set(key, at);
      else if (p === -2) open.set(target, at); // a slide: on the next pad's row
    }
    for (const [key, from] of open) bar(key, from, len);
  } else for (let i = 0; i < pts.length; i++) {
    const x0 = px(pts[i][0]), x1 = i + 1 < pts.length ? px(pts[i + 1][0]) : X + W - 4;
    const y = py(pts[i][1]);
    ctx.fillRect(x0, y - 1, Math.max(2, x1 - x0), 2);
    if (i + 1 < pts.length) {
      const y2 = py(pts[i + 1][1]);
      ctx.fillRect(x1 - 1, Math.min(y, y2) - 1, 2, Math.abs(y2 - y) + 2);
    }
  }
  ctx.fillStyle = COLOR.normal;
  ctx.fillRect(px(m.pos), Y, 2, H);
  card(ctx, 12, 180, 216, 54, 'speed', m.speed, 'focus', 3, true);
  regions.push({ x: 12, y: 180, w: 216, h: 54, select: () => {}, step: act.speed });
  return regions;
}

// Quantize a cycle (loop page, pad held): how many bars it should last; yes
// stretches it to them from where it is (nudged by under half a beat so its
// top falls on a beat), no leaves it.
export function drawQuantizePage(ctx, m, act) {
  header(ctx, 'quantize', m.name, act.no);
  card(ctx, 12, 54, 216, 70, 'bars', m.bars, 'focus', 4, true);
  card(ctx, 12, 130, 216, 44, 'now', m.now, 'idle', 2);
  card(ctx, 12, 180, 104, 54, '', 'yes', 'focus', 3);
  card(ctx, 124, 180, 104, 54, '', 'no', 'idle', 3);
  return [{ x: 0, y: 0, w: 240, h: 46, click: act.no },
    { x: 12, y: 54, w: 216, h: 70, select: () => {}, step: act.bars },
    { x: 12, y: 180, w: 104, h: 54, click: act.yes }, { x: 124, y: 180, w: 104, h: 54, click: act.no }];
}

export function drawListPage(ctx, title, menu, items, right, back) {
  header(ctx, title, right, back);
  const regions = rows(ctx, menu, items);
  if (back) regions.push({ x: 0, y: 0, w: 240, h: 46, click: back });
  return regions;
}

// ---- Arpeggio page: the Euclidean rhythm as a ring ("Orbit", 4 November,
// the user's choice among three drafts; colours of the other pages). Hits
// are discs sized by their humanized pressure and moved by the swing (a
// ghost ring where they would sit straight), each with a gate trail that
// fills while its note sounds; a comet on the rim follows the arpeggio and
// the firing hit pulses. In the middle tempo and pattern; in the corners
// steps, hits, gate and human. The focused value sits on a cardFocus box with its label
// in highlight blue, and turns blue the part of the drawing it moves. On
// the instrument the encoder turns through the six and a press takes one
// (cardEdit, value blue), as m.editing; here a click picks, wheel or drag
// changes.

// Pixel circles as fillCircle / drawCircle: a disc of diameter d, row by
// row; a ring is the disc less a smaller one, t pixels inside.
function spans(d, j) {
  const r = d / 2, y = j + 0.5 - r, w = y * y < r * r ? 2 * Math.sqrt(r * r - y * y) : 0;
  return [Math.round(r - w / 2), Math.round(r + w / 2)];
}
function disc(ctx, x, y, d, color) {
  ctx.fillStyle = color;
  const x0 = Math.round(x - d / 2), y0 = Math.round(y - d / 2);
  for (let j = 0; j < d; j++) { const [a, b] = spans(d, j); if (b > a) ctx.fillRect(x0 + a, y0 + j, b - a, 1); }
}
function ring(ctx, x, y, d, t, color) {
  ctx.fillStyle = color;
  const x0 = Math.round(x - d / 2), y0 = Math.round(y - d / 2);
  for (let j = 0; j < d; j++) {
    const [a, b] = spans(d, j), k = j - t;
    const [c, e] = k >= 0 && k < d - 2 * t ? spans(d - 2 * t, k) : [0, 0];
    if (e <= c) { if (b > a) ctx.fillRect(x0 + a, y0 + j, b - a, 1); continue; }
    ctx.fillRect(x0 + a, y0 + j, t + c - a, 1);
    ctx.fillRect(x0 + t + e, y0 + j, b - t - e, 1);
  }
}
function fill(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export const ARP_PARAMS = ['tempo', 'pattern', 'gate', 'steps', 'hits', 'human'];

// m: { values: six strings in ARP_PARAMS order, gate, human (0-100), steps,
// focus (index), editing, on, rhythm: [{ hit, delay (steps), p }],
// ph: play position in steps (null when stopped), age: ms since the playing hit fired (-1: none),
// stepMs }. act: { select(i), step(i, n, fine) }.
export function drawArpPage(ctx, m, act) {
  // Radius 77 (68 until 4 November: the pattern name grew to size 3, the user
  // found size 2 too small): hits stay clear of converge, the widest name,
  // and of the corner boxes.
  const cx = 120, cy = 118, R = 77, r = m.rhythm, n = m.steps;
  const focus = ARP_PARAMS[m.focus];
  const tint = (id, color) => (focus === id ? COLOR.highlight : color);
  const back = (id) => (focus === id ? (m.editing ? COLOR.cardEdit : COLOR.cardFocus) : null);
  const ang = (i) => (-90 + 360 * i / n) * Math.PI / 180;
  const at = (i, rad) => [cx + Math.cos(ang(i)) * rad, cy + Math.sin(ang(i)) * rad];
  const ph = m.ph, cur = ph === null ? -1 : Math.floor(ph);
  const fired = cur >= 0 && r[cur]?.hit && m.age >= 0;
  // Rim: a plain 2 px circle (the user's choice over a dotted one), and a
  // comet over it behind the play position.
  ring(ctx, cx, cy, 2 * R + 2, 2, COLOR.rail);
  const samples = Math.ceil(4 * Math.PI * R / n / 1.5); // two steps of arc, every 1.5 px
  if (ph !== null) for (let a = 0; a < samples; a++) {
    const behind = 2 * a / samples;
    const [x, y] = at(ph - behind, R);
    fill(ctx, x - 1, y - 1, 2, 2, behind < 0.3 ? COLOR.normal : behind < 1.2 ? tint('tempo', COLOR.secondary) : COLOR.rail);
  }
  { const [x, y] = at(0, R + 9); fill(ctx, x - 1, y - 3, 2, 6, COLOR.secondary); } // first step
  // Rests.
  r.forEach((s, i) => {
    if (s.hit) return;
    const [x, y] = at(i, R);
    disc(ctx, x, y, 6, i === cur ? COLOR.secondary : tint('steps', COLOR.track));
  });
  // Gate trails: tenths of a step; the playing one fills as its note sounds.
  const trail = Math.max(1, Math.round(m.gate / 10));
  r.forEach((s, i) => {
    if (!s.hit) return;
    const lit = i === cur && fired ? Math.min(trail, Math.floor(m.age / m.stepMs * 10)) : 0;
    for (let k = 1; k <= trail; k++) {
      const [x, y] = at(i + s.delay + k / 10, R);
      fill(ctx, x - 1, y - 1, 3, 3, k <= lit ? COLOR.normal : tint('gate', COLOR.secondary));
    }
  });
  // Swing ghosts: where a moved hit would sit straight.
  r.forEach((s, i) => {
    if (!s.hit || s.delay < 0.04) return;
    const [x, y] = at(i, R);
    ring(ctx, x, y, 9, 1, tint('human', COLOR.rail));
  });
  // Hits, sized by their pressure; the one firing pulses for 160 ms.
  r.forEach((s, i) => {
    if (!s.hit) return;
    const size = 7 + Math.round(8 * s.p / 255), on = i === cur && fired;
    const [x, y] = at(i + s.delay, R);
    disc(ctx, x, y, size, on ? COLOR.normal : tint('hits', m.on ? COLOR.meter : COLOR.secondary));
    if (on && m.age < 160) ring(ctx, x, y, size + 6 + 2 * Math.round(m.age / 32), 2, m.age < 80 ? COLOR.normal : COLOR.secondary);
  });
  const regions = [];
  // Tempo and pattern on the ring's centre (y 90-143; a column chart of the
  // pattern's next notes under them went on 4 November, the user did not
  // read it). Boxes 4 px wider than the text: converge's still clears the hits.
  const centre = (i, y, size, color, h) => {
    const id = ARP_PARAMS[i], text = m.values[i], w = textWidth(text, size), b = back(id);
    if (b) fill(ctx, cx - w / 2 - 4, y - 5, w + 8, size * 5 + 10, b);
    drawText(ctx, text, cx, y, size, focus === id ? (m.editing ? COLOR.highlight : COLOR.normal) : color, 'center');
    if (focus === id) fill(ctx, cx - w / 2, y + size * 5 + 3, w, 2, COLOR.highlight);
    regions.push({ x: 64, y: y - 8, w: 112, h, select: () => act.select(i), click: () => act.select(i), step: (s, fine) => act.step(i, s, fine) });
  };
  centre(0, 90, 5, COLOR.normal, 34);
  centre(1, 126, 3, COLOR.secondary, 34);
  // Corners: boxes 6 px from every edge, text 12 px from the sides; gate and
  // human with a meter under the value.
  const corner = (i, x, y, align, meter) => {
    const id = ARP_PARAMS[i], v = m.values[i], b = back(id);
    const w = Math.max(textWidth(id, 2), textWidth(v, 3), meter !== undefined ? 44 : 0) + 12;
    const bx = align === 'right' ? x - w + 6 : x - 6, h = meter !== undefined ? 44 : 40;
    if (b) fill(ctx, bx, y - 5, w, h, b);
    drawText(ctx, id, x, y, 2, focus === id ? COLOR.highlight : COLOR.secondary, align);
    drawText(ctx, v, x, y + 16, 3, focus === id && m.editing ? COLOR.highlight : COLOR.normal, align);
    if (meter !== undefined) {
      const mx = align === 'right' ? x - 44 : x;
      fill(ctx, mx, y + 33, 44, 2, COLOR.track);
      fill(ctx, mx, y + 33, Math.round(44 * meter), 2, focus === id ? COLOR.highlight : COLOR.meter);
    }
    const rx = align === 'right' ? 240 - 84 : 0, ry = y < 120 ? 0 : 240 - 50;
    regions.push({ x: rx, y: ry, w: 84, h: 50, select: () => act.select(i), click: () => act.select(i), step: (s, fine) => act.step(i, s, fine) });
  };
  // Value 16 px under its label (12 until 4 November: the user wanted them
  // further apart).
  corner(3, 12, 11, 'left');
  corner(4, 228, 11, 'right');
  corner(2, 12, 195, 'left', m.gate / 100);
  corner(5, 228, 195, 'right', m.human / 100);
  return regions;
}

// Envelope bars of the five voices at the foot of a page.
function voiceBars(ctx, voices, y = 225) {
  voices.forEach((v, i) => {
    const x = 12 + i * 44;
    ctx.fillStyle = COLOR.track;
    ctx.fillRect(x, y, 40, 6);
    ctx.fillStyle = v.gate ? COLOR.meter : COLOR.secondary;
    ctx.fillRect(x, y, Math.round(40 * v.env / 255), 6);
  });
}

export function drawNotePage(ctx, m, steps) {
  header(ctx, 'keyboard', `key ${m.key + 1}`);
  const cards = [
    [12, 54, 216, 44, 'scale', m.scale], [12, 102, 128, 44, 'note', m.note], [146, 102, 82, 44, 'root', m.root],
    [12, 150, 216, 44, m.freqLabel, m.freq], [12, 198, 216, 24, 'layout', m.layout],
  ];
  const regions = cards.map(([x, y, w, h, label, value], i) => {
    card(ctx, x, y, w, h, label, value, m.row === i ? 'focus' : 'idle', 3, true);
    return { x, y, w, h, select: () => { m.row = i; }, step: (n, fine) => steps(i, n, fine) };
  });
  voiceBars(ctx, m.voices, 228);
  return regions;
}

export function drawBpmPage(ctx, m, step) {
  header(ctx, 'tempo', m.source);
  // Large digits in place of the 180 x 144 BPM bitmap of the firmware.
  ctx.fillStyle = COLOR.card;
  ctx.fillRect(12, 62, 216, 120);
  drawText(ctx, String(m.bpm), 120, 92, 9, m.flash ? COLOR.highlight : COLOR.normal, 'center');
  drawText(ctx, '<', 22, 112, 3, COLOR.secondary);
  drawText(ctx, '>', 206, 112, 3, COLOR.secondary);
  drawText(ctx, 'bpm', 120, 160, 2, COLOR.secondary, 'center');
  drawText(ctx, `${m.ms} ms`, 120, 200, 3, COLOR.secondary, 'center');
  return [
    { x: 12, y: 62, w: 44, h: 120, click: () => step(-1) },
    { x: 184, y: 62, w: 44, h: 120, click: () => step(1) },
    { x: 56, y: 62, w: 128, h: 120, step },
  ];
}

export function drawPresetPage(ctx, m, act) {
  header(ctx, 'preset', m.dirty ? 'edited' : '');
  card(ctx, 12, 54, 102, 84, 'BNK', String(m.bank).padStart(2, '0'), m.row === 0 ? 'focus' : 'idle', 5, true);
  card(ctx, 126, 54, 102, 84, 'PRS', String(m.slot + 1).padStart(2, '0'), m.row === 1 ? 'focus' : 'idle', 5, true);
  const button = (x, label, enabled) => {
    ctx.fillStyle = enabled ? COLOR.cardFocus : COLOR.card;
    ctx.fillRect(x, 146, 104, 30);
    drawText(ctx, label, x + 52, 156, 2, enabled ? COLOR.highlight : COLOR.rail, 'center');
  };
  button(12, 'load', m.used[m.slot]);
  button(124, 'save', m.bank > 0);
  let size = 2;
  while (size > 1 && textWidth(m.name || '-', size) > 216) size--;
  drawText(ctx, m.name || '-', 120, 184, size, COLOR.normal, 'center');
  // Slot occupancy of the bank, two rows of 12; a click selects the slot.
  const regions = [
    { x: 12, y: 54, w: 102, h: 84, select: () => { m.row = 0; }, step: act.bank },
    { x: 126, y: 54, w: 102, h: 84, select: () => { m.row = 1; }, step: act.slot },
    { x: 12, y: 146, w: 104, h: 30, click: act.load },
    { x: 124, y: 146, w: 104, h: 30, click: act.save },
  ];
  for (let i = 0; i < m.used.length; i++) {
    const x = 12 + (i % 12) * 18, y = 198 + Math.floor(i / 12) * 13;
    ctx.fillStyle = i === m.slot ? COLOR.highlight : m.used[i] ? COLOR.secondary : COLOR.track;
    ctx.fillRect(x, y, 14, 9);
    regions.push({ x: x - 2, y: y - 2, w: 18, h: 13, click: () => act.pick(i) });
  }
  return regions;
}

// Sub detune: +-100 cent slider, dragged or clicked.
export function drawDetunePage(ctx, cents, set, close) {
  header(ctx, 'sub detune', '', close);
  ctx.fillStyle = COLOR.card;
  ctx.fillRect(12, 62, 216, 150);
  drawText(ctx, `${cents > 0 ? '+' : ''}${cents} ct`, 120, 82, 4, COLOR.normal, 'center');
  ctx.fillStyle = COLOR.rail;
  ctx.fillRect(24, 148, 192, 4);
  ctx.fillStyle = COLOR.normal;
  ctx.fillRect(119, 140, 2, 20);
  ctx.fillStyle = COLOR.selected;
  ctx.fillRect(Math.round(120 + cents * 0.96) - 4, 136, 8, 28);
  drawText(ctx, '-100', 24, 176, 2, COLOR.secondary);
  drawText(ctx, '+100', 216, 176, 2, COLOR.secondary, 'right');
  const fromX = (x) => Math.round(Math.max(-100, Math.min(100, (x - 120) / 0.96)));
  return [
    { x: 12, y: 120, w: 216, h: 60, press: (x) => set(fromX(x)), drag: (x) => set(fromX(x)), step: (n) => set(cents + n) },
    { x: 0, y: 0, w: 240, h: 46, click: close },
  ];
}
