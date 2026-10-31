// Display pages other than the analyser, following the card layouts of the
// ESP32 firmware (display_style.h, spectrum.cpp drawing functions): header in
// Org_01 size 3 with a rule at y 46, cards on 0x1082 / 0x1105 / 0x2081.
//
// The web version has no encoder: editable cards carry < > arrows and every
// page returns its mouse regions ({x, y, w, h, step, click, select}).

import { COLOR, drawText, textWidth } from './display.js';

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
    const open = new Map();
    const bar = (key, from, to) => ctx.fillRect(px(from), Y + 6 + key * 4 + 1, Math.max(2, px(to) - px(from)), 3);
    for (const [at, key, p] of pts) {
      if (open.has(key)) { bar(key, open.get(key), at); open.delete(key); }
      if (p) open.set(key, at);
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
// stretches it to them and starts it on the beat, no leaves it.
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
