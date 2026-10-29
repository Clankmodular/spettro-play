// Preset memory: 32 banks of 24 slots (the instrument has 12). Bank 0 is the
// code-backed factory bank; user banks 1..31 live in this browser.

import { FACTORY } from './factory-presets.js';

const KEY = 'spettro.presets.v1';
export const SLOTS = 24;

export class Presets {
  constructor() {
    this.user = {};
    try { this.user = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { this.user = {}; }
  }

  get(bank, slot) {
    if (bank === 0) return FACTORY[slot] || null;
    return this.user[`${bank}.${slot}`] || null;
  }

  put(bank, slot, data) {
    if (bank === 0) return;
    this.user[`${bank}.${slot}`] = data;
    try { localStorage.setItem(KEY, JSON.stringify(this.user)); } catch { /* storage unavailable: kept for this session */ }
  }

  all() { return this.user; }
}
