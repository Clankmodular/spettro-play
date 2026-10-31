// Interactive Spettro panel drawn over the panel artwork.
// Knobs, faders, buttons, pads and LEDs are SVG elements placed at the
// measured coordinates of panel-layout.js; values are 0..1 and every change
// is reported through the callbacks given to the constructor. Lights use the
// exact windows of the panel (panel-lights.js): knob rings and fader bars
// show the current value, LEDs light inside their printed outline.

import * as L from './panel-layout.js';
import { LIGHTS } from './panel-lights.js';
import { VIEW, toPage } from './display.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
};
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// The printed knob rings open 60 degrees at the bottom.
const KNOB_SWEEP = 300;
const RING_RADIUS = 31.7;

export class Panel {
  constructor(container, { onControl, onTouch, onTouchEnd, onButton, onPad, onBend, onSlide, onScreen }) {
    this.onControl = onControl;
    this.onTouchEnd = onTouchEnd;
    this.onTouch = onTouch;
    this.onButton = onButton;
    this.onPad = onPad;
    this.onBend = onBend;
    this.onSlide = onSlide;
    this.onScreen = onScreen;
    this.values = {};
    this.controls = {};
    this.leds = {};
    this.rings = {};
    this.centres = {};
    this.indicated = {};
    this.bars = {};

    const { x, y, width, height } = L.CROP;
    this.svg = el('svg', { viewBox: `${x} ${y} ${width} ${height}`, class: 'panel' }, container);
    this.defs = el('defs', {}, this.svg);
    this.gradients(this.defs);
    el('image', { href: 'panel.svg', x: 0, y: 0, width: L.VIEWBOX.width, height: L.VIEWBOX.height }, this.svg);

    this.ledLayer = el('g', { class: 'leds' }, this.svg);
    this.windows();
    L.KNOBS.forEach((k) => this.knob(k));
    L.TRIMMERS.forEach((k) => this.knob({ ...k, small: true }));
    L.FADERS.forEach((f) => this.fader(f));
    L.BUTTONS.forEach((b) => this.button(b, 8.95));
    L.RING_BUTTONS.forEach((b) => this.button(b, 11.35));
    this.pads();
    this.screen();
  }

  gradients(defs) {
    // Domed black caps, as on the panel artwork.
    const cap = el('radialGradient', { id: 'cap', cx: '45%', cy: '40%', r: '60%' }, defs);
    el('stop', { offset: '0', 'stop-color': '#7a7a7a' }, cap);
    el('stop', { offset: '0.35', 'stop-color': '#2a2a2a' }, cap);
    el('stop', { offset: '1', 'stop-color': '#050505' }, cap);
    const pad = el('radialGradient', { id: 'pad', cx: '50%', cy: '45%', r: '55%' }, defs);
    el('stop', { offset: '0', 'stop-color': '#e2e2e2' }, pad);
    el('stop', { offset: '0.8', 'stop-color': '#d0d0d0' }, pad);
    el('stop', { offset: '1', 'stop-color': '#9a9a9a' }, pad);
    const glow = el('filter', { id: 'glow', x: '-1', y: '-1', width: '3', height: '3' }, defs);
    el('feGaussianBlur', { stdDeviation: '1.4', result: 'b' }, glow);
    const merge = el('feMerge', {}, glow);
    el('feMergeNode', { in: 'b' }, merge);
    el('feMergeNode', { in: 'SourceGraphic' }, merge);
  }

  // A light window: dark when off, its lit part clipped to the hole shape.
  window(id, d) {
    const clip = el('clipPath', { id: `clip-${id}` }, this.defs);
    el('path', { d }, clip);
    const g = el('g', { class: 'window' }, this.ledLayer);
    el('path', { d, class: 'window-off' }, g);
    const lit = el('g', { 'clip-path': `url(#clip-${id})`, class: 'window-lit' }, g);
    return lit;
  }

  windows() {
    for (const [id, d] of Object.entries(LIGHTS.rings)) {
      const lit = this.window(`ring-${id}`, d);
      this.rings[id] = el('path', { class: 'value-light', fill: 'none', 'stroke-width': 10, 'stroke-linecap': 'butt' }, lit);
    }
    for (const [id, bar] of Object.entries(LIGHTS.bars)) {
      const lit = this.window(`bar-${id}`, bar.d);
      this.bars[id] = { bar, rect: el('rect', { class: 'value-light' }, lit) };
    }
    LIGHTS.bands.forEach((p, i) => { this.leds[`band${i}`] = el('path', { d: p.d, class: 'led' }, this.ledLayer); });
    LIGHTS.delays.forEach((p, i) => { this.leds[`delay${i}`] = el('path', { d: p.d, class: 'led' }, this.ledLayer); });
    const nearest = (x, y) => LIGHTS.leds.reduce((a, b) => (Math.hypot(b.x - x, b.y - y) < Math.hypot(a.x - x, a.y - y) ? b : a));
    const led = (id, at) => { this.leds[id] = el('path', { d: nearest(at.x, at.y).d, class: 'led' }, this.ledLayer); };
    for (const b of [...L.BUTTONS, ...L.RING_BUTTONS]) if (b.led) led(b.id, b.led);
    L.LFO_LEDS.forEach((p, i) => led(`lfo${i}`, p));
    L.SUB_LEDS.forEach((p, i) => led(`sub${i}`, p));
    L.TRANSPOSE_LEDS.forEach((p, i) => { this.leds[`transpose${i}`] = el('path', { d: p.d, class: 'led' }, this.ledLayer); });
  }

  // Controls with a value light (knob ring or fader bar).
  valueLights() { return [...Object.keys(this.rings), ...Object.keys(this.bars)]; }

  // Draw a value light at v in a colour (null = the usual yellow) without
  // moving the control: LFO motion, loop and freeze colours.
  // from: start of the light (a range, e.g. an LFO's travel); level: its
  // brightness.
  indicate(id, v, color, from = 0, level = 1) {
    const last = this.indicated[id];
    if (last && Math.abs(last.v - v) < 1e-3 && last.color === color && last.from === from && last.level === level) return;
    this.indicated[id] = { v, color, from, level };
    const node = this.rings[id] || this.bars[id]?.rect;
    if (!node) return;
    const [a, b] = from <= v ? [from, v] : [v, from];
    if (this.rings[id]) this.ring(id, b, a); else this.bar(id, b, a);
    if (color) {
      node.style.stroke = color; node.style.fill = color;
      node.style.opacity = level < 1 ? String(level) : '';
    } else node.removeAttribute('style');
  }

  ring(id, v, from = 0) {
    const node = this.rings[id];
    if (!node) return;
    const { x, y } = this.centres[id];
    if (v - from <= 0.001) { node.setAttribute('d', ''); return; }
    const a0 = (-KNOB_SWEEP / 2 + KNOB_SWEEP * from) * Math.PI / 180, a1 = (-KNOB_SWEEP / 2 + KNOB_SWEEP * v) * Math.PI / 180;
    const p = (a) => `${(x + RING_RADIUS * Math.sin(a)).toFixed(2)} ${(y - RING_RADIUS * Math.cos(a)).toFixed(2)}`;
    // Start a little before the printed end so the round cap fills.
    const start = from > 0 ? a0 : a0 - 0.2;
    node.setAttribute('d', `M${p(start)}A${RING_RADIUS} ${RING_RADIUS} 0 ${a1 - start > Math.PI ? 1 : 0} 1 ${p(a1)}`);
  }

  bar(id, v, from = 0) {
    const entry = this.bars[id];
    if (!entry) return;
    const { bar, rect } = entry;
    if (bar.horizontal) {
      const w = (bar.x1 - bar.x0) * (v - from);
      Object.entries({ x: bar.x0 + (bar.x1 - bar.x0) * from, y: bar.y0 - 1, width: w, height: bar.y1 - bar.y0 + 2 }).forEach(([k, val]) => rect.setAttribute(k, val));
    } else {
      const h = (bar.y1 - bar.y0) * (v - from);
      Object.entries({ x: bar.x0 - 1, y: bar.y1 - (bar.y1 - bar.y0) * v, width: bar.x1 - bar.x0 + 2, height: h }).forEach(([k, val]) => rect.setAttribute(k, val));
    }
  }

  // Pointer position in panel coordinates.
  point(event) {
    const p = this.svg.createSVGPoint();
    p.x = event.clientX; p.y = event.clientY;
    return p.matrixTransform(this.svg.getScreenCTM().inverse());
  }

  drag(node, { start, move, end }) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      node.setPointerCapture(e.pointerId);
      start?.(e);
      const onMove = (ev) => move?.(ev);
      const onUp = (ev) => {
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        node.removeEventListener('pointercancel', onUp);
        end?.(ev);
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
    });
  }

  knob({ id, x, y, small }) {
    const r = small ? 8.8 : 15.6;
    this.centres[id] = { x, y };
    const g = el('g', { class: 'control knob', transform: `translate(${x} ${y})`, 'data-id': id }, this.svg);
    el('circle', { r: r + 4, fill: 'transparent' }, g);
    const cap = el('g', {}, g);
    el('circle', { r, fill: 'url(#cap)', stroke: '#303030', 'stroke-width': 0.37 }, cap);
    el('line', { x1: 0, y1: -r * 0.35, x2: 0, y2: -r * 0.92, stroke: '#e8e6e1', 'stroke-width': small ? 0.9 : 1.3, 'stroke-linecap': 'round' }, cap);
    const set = (v) => {
      this.values[id] = v;
      cap.setAttribute('transform', `rotate(${(v - 0.5) * KNOB_SWEEP})`);
      this.ring(id, v); delete this.indicated[id]; // redrawn by the next indicate()
    };
    this.controls[id] = { set };
    let startY = 0, startV = 0, taken = false;
    this.drag(g, {
      // A touch taken by the UI does not turn the knob.
      start: (e) => { taken = !!this.onTouch?.(id); startY = e.clientY; startV = this.values[id]; },
      move: (e) => {
        if (taken) return;
        const fine = e.shiftKey ? 0.2 : 1;
        this.change(id, clamp01(startV + (startY - e.clientY) / 220 * fine));
      },
      end: () => this.onTouchEnd?.(id),
    });
    g.addEventListener('wheel', (e) => { e.preventDefault(); this.change(id, clamp01(this.values[id] - Math.sign(e.deltaY) / 64)); }, { passive: false });
    g.addEventListener('dblclick', () => this.change(id, this.defaults?.[id] ?? 0.5));
    set(0.5);
  }

  fader({ id, from, to }) {
    const g = el('g', { class: 'control fader', 'data-id': id }, this.svg);
    // Invisible track so the whole slot is draggable.
    el('line', { x1: from[0], y1: from[1], x2: to[0], y2: to[1], stroke: 'transparent', 'stroke-width': 22, 'stroke-linecap': 'round' }, g);
    const cap = el('g', {}, g);
    el('circle', { r: 11.35, fill: 'url(#cap)', stroke: '#303030', 'stroke-width': 0.37 }, cap);
    const dx = to[0] - from[0], dy = to[1] - from[1], len2 = dx * dx + dy * dy;
    const set = (v) => {
      this.values[id] = v;
      cap.setAttribute('transform', `translate(${from[0] + dx * v} ${from[1] + dy * v})`);
      this.bar(id, v); delete this.indicated[id];
    };
    this.controls[id] = { set };
    const at = (e) => { const p = this.point(e); return clamp01(((p.x - from[0]) * dx + (p.y - from[1]) * dy) / len2); };
    let offset = 0, taken = false;
    this.drag(g, {
      start: (e) => {
        taken = !!this.onTouch?.(id);
        if (taken) return;
        const v = at(e);
        // Grabbing the cap keeps it under the pointer; the slot jumps.
        offset = Math.abs(v - this.values[id]) < 0.18 ? this.values[id] - v : 0;
        this.change(id, clamp01(v + offset));
      },
      move: (e) => { if (!taken) this.change(id, clamp01(at(e) + offset)); },
      end: () => this.onTouchEnd?.(id),
    });
    g.addEventListener('wheel', (e) => { e.preventDefault(); this.change(id, clamp01(this.values[id] - Math.sign(e.deltaY) / 64)); }, { passive: false });
    g.addEventListener('dblclick', () => this.change(id, this.defaults?.[id] ?? 0.5));
    set(0.5);
  }

  button({ id, x, y }, r) {
    const g = el('g', { class: 'control button', transform: `translate(${x} ${y})`, 'data-id': id }, this.svg);
    el('circle', { r: r + 2, fill: 'transparent' }, g);
    const cap = el('circle', { r, fill: 'url(#cap)', stroke: '#303030', 'stroke-width': 0.37 }, g);
    this.drag(g, {
      start: () => { cap.setAttribute('transform', 'scale(0.94)'); this.onButton(id, true); },
      end: () => { cap.removeAttribute('transform'); this.onButton(id, false); },
    });
  }

  // Pads. Dragging a finger towards an adjacent pad bends the note there
  // (the same-row neighbours and the two of each next row, as the hardware
  // pairs); past three quarters of the way the note moves to that pad.
  pads() {
    const DEAD = 0.25; // no bend while the finger stays near its pad's centre
    const neighbours = L.PADS.map((a) => L.PADS.filter((b) => b !== a && Math.hypot(b.x - a.x, b.y - a.y) < L.PAD_SIZE * 1.3).map((b) => b.index));
    const discs = [];
    const pressed = new Set();
    // pointerId -> { origin, at, bendTo, pos, trail, started }; the ui draws
    // the slide lights from it (slide_leds.h).
    const touches = new Map();
    this.slides = touches;
    const press = (i, on) => {
      if (on) { pressed.add(i); discs[i].setAttribute('transform', 'scale(0.97)'); } else { pressed.delete(i); discs[i].removeAttribute('transform'); }
    };
    // Real pressure from a pen or Apple Pencil only: a finger on a touch
    // screen reports a fixed or made-up value (iPad), so it plays with the
    // hold fader like the mouse.
    const pressure = (e) => (e.pointerType === 'pen' ? e.pressure : null);
    const bend = (e, s) => {
      const q = this.point(e), a = L.PADS[s.at];
      let best = -1, far = 0;
      for (const n of neighbours[s.at]) {
        const b = L.PADS[n], dx = b.x - a.x, dy = b.y - a.y;
        const t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy);
        if (t > far) { far = t; best = n; }
      }
      const pos = best < 0 ? 0 : clamp01((far - DEAD) / (1 - 2 * DEAD));
      if (pos >= 1 && !pressed.has(best) && this.onSlide(s.at, best)) {
        press(s.at, false); press(best, true);
        s.trail?.add(best);
        s.at = best; s.bendTo = -1; s.pos = 0;
        return;
      }
      const target = pos > 0 ? best : -1;
      // The trail starts with the first bend and lasts until the finger lifts.
      if (target >= 0) {
        if (!s.trail) { s.trail = new Set([s.origin]); s.started = performance.now(); }
        s.trail.add(s.at).add(target);
      }
      if (target === s.bendTo && pos === s.pos) return;
      this.onBend(s.at, target < 0 ? s.bendTo : target, target < 0 ? 0 : pos);
      s.bendTo = target; s.pos = pos;
    };
    this.padNodes = L.PADS.map((p) => {
      const g = el('g', { class: 'pad', transform: `translate(${p.x} ${p.y})` }, this.svg);
      discs[p.index] = el('circle', { r: L.PAD_SIZE / 2 - 0.5, fill: 'url(#pad)', stroke: '#777', 'stroke-width': 1 }, g);
      const light = el('circle', { r: L.PAD_SIZE / 2 - 4, class: 'pad-light' }, g);
      this.drag(g, {
        start: (e) => {
          touches.set(e.pointerId, { origin: p.index, at: p.index, bendTo: -1, pos: 0, trail: null, started: 0 });
          press(p.index, true);
          this.onPad(p.index, 'on', pressure(e));
        },
        move: (e) => {
          const s = touches.get(e.pointerId);
          if (!s) return;
          const v = pressure(e);
          if (v !== null) this.onPad(s.at, 'pressure', v);
          bend(e, s);
        },
        end: (e) => {
          const s = touches.get(e.pointerId);
          touches.delete(e.pointerId);
          if (!s) return;
          press(s.at, false);
          this.onPad(s.at, 'off');
        },
      });
      return light;
    });
  }

  // The screen window of the panel; mouse in its own 240 x 240 units.
  // The canvas is an HTML element over the SVG, not a foreignObject:
  // WebKit (every iPad browser) draws foreignObject content without the
  // viewBox transform, so the screen and its touches landed elsewhere.
  screen() {
    const { x, y, size } = L.DISPLAY;
    const container = this.svg.parentNode;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'screen';
    container.appendChild(this.canvas);
    const place = () => {
      const m = this.svg.getScreenCTM();
      if (!m) return;
      const box = container.getBoundingClientRect();
      Object.assign(this.canvas.style, {
        left: `${m.a * x + m.e - box.left}px`, top: `${m.d * y + m.f - box.top}px`,
        width: `${m.a * size}px`, height: `${m.d * size}px`,
      });
    };
    place();
    new ResizeObserver(place).observe(this.svg);
    window.addEventListener('resize', place);
    // Canvas position to page units (the screen shows a zoomed view).
    const at = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return [toPage((e.clientX - r.left) / r.width * 240), toPage((e.clientY - r.top) / r.height * 240)];
    };
    // Drag steps values: up or right raises, down or left lowers (a swipe on
    // a touch screen); the larger of the two movements counts.
    let lastX = 0, lastY = 0;
    this.drag(this.canvas, {
      start: (e) => { lastX = e.clientX; lastY = e.clientY; this.onScreen('down', ...at(e)); },
      move: (e) => {
        const r = this.canvas.getBoundingClientRect();
        const dx = (e.clientX - lastX) / r.width * VIEW.size, dy = (lastY - e.clientY) / r.height * VIEW.size;
        lastX = e.clientX; lastY = e.clientY;
        this.onScreen('drag', ...at(e), Math.abs(dx) > Math.abs(dy) ? dx : dy);
      },
      end: (e) => this.onScreen('up', ...at(e)),
    });
    this.canvas.addEventListener('pointermove', (e) => { if (!e.buttons) this.onScreen('hover', ...at(e)); });
    this.canvas.addEventListener('pointerleave', () => this.onScreen('leave', -1, -1));
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.onScreen('wheel', ...at(e), e.deltaY < 0 ? 1 : -1, e.shiftKey);
    }, { passive: false });
  }

  change(id, v) {
    if (this.values[id] === v) return;
    this.controls[id].set(v);
    this.onControl(id, v);
  }

  // Move a control without reporting it (preset recall, bank switch).
  set(id, v) { this.controls[id]?.set(clamp01(v)); }

  // LED colour as CSS colour and brightness 0..1. Unchanged lights are not
  // touched: every style write makes the browser redraw.
  light(id, color, level = 1) {
    const node = this.leds[id];
    if (!node) return;
    const key = !level || !color ? '' : `${color}${Math.round(level * 100)}`;
    if (node.lit === key) return;
    node.lit = key;
    if (!key) { node.removeAttribute('style'); node.classList.remove('on'); return; }
    node.classList.add('on');
    node.style.fill = color;
    node.style.opacity = String(0.25 + 0.75 * Math.round(level * 100) / 100);
  }

  padLight(index, color, level) {
    const node = this.padNodes[index];
    const key = color ? `${color}${Math.round(level * 100)}` : '';
    if (node.lit === key) return;
    node.lit = key;
    node.style.fill = color || 'transparent';
    node.style.opacity = color ? String(Math.round(level * 100) / 100) : '0';
  }
}
