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
  let size = 3;
  while (size > 1 && textWidth(text, size) > 208) size--;
  drawText(ctx, text, 16, 17, size, back ? COLOR.secondary : COLOR.normal);
  // The advance of '< ' (textWidth of a string ending in a space leaves the space out).
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
// cards as on the instrument, or compact rows when the list is longer
// (narrower still for six or seven).
function rows(ctx, menu, items) {
  const compact = items.length > 3, n = items.length;
  const top = compact ? 52 : 54, h = n > 6 ? 24 : n > 5 ? 27 : compact ? 33 : 54, gap = n > 6 ? 2 : compact ? 3 : 6;
  return items.map(([label, value, act = {}], i) => {
    const y = top + i * (h + gap);
    card(ctx, 12, y, 216, h, label, value, menu.row === i ? 'focus' : 'idle', 3, !!act.step);
    return { x: 12, y, w: 216, h, select: () => { menu.row = i; }, ...act };
  });
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
  drawText(ctx, m.hint, 120, 228, 1, COLOR.secondary, 'center');
  return regions;
}

// Sequencer recording, over the top of any page: the mode, where it is
// (step / length, or the beats left of the count-in) and a row of the steps
// (with notes lighter, the playing or written one in red).
export function drawSeqRecord(ctx, m) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 240, 60);
  drawText(ctx, m.title, 12, 10, 2, COLOR.popup);
  drawText(ctx, m.right, 228, 10, 2, COLOR.normal, 'right');
  const len = m.steps.length, gap = len > 16 ? 1 : 2;
  const w = Math.floor((216 - gap * (len - 1)) / len), x0 = 12 + Math.floor((216 - (w * len + gap * (len - 1))) / 2);
  m.steps.forEach((full, i) => {
    ctx.fillStyle = i === m.at ? COLOR.popup : full ? COLOR.secondary : COLOR.track;
    ctx.fillRect(x0 + i * (w + gap), i % 4 ? 36 : 32, w, i % 4 ? 14 : 18); // beat starts taller
  });
  ctx.fillStyle = COLOR.rule;
  ctx.fillRect(0, 59, 240, 1);
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
