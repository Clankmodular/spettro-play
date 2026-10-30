// Spettro web: audio start-up and the wiring between panel, display,
// PC keyboard, MIDI and the ESP32 port running in the AudioWorklet.

import { Panel } from './panel.js';
import { Display } from './display.js';
import { Ui } from './ui.js';

const panel = new Panel(document.getElementById('instrument'), {
  onControl: (id, v) => ui.control(id, v),
  onTouch: (id) => ui.touchControl(id),
  onButton: (id, down) => ui.button(id, down),
  onPad: (index, action, pressure) => ui.pad(index, action, pressure),
  onBend: (index, target, pos) => ui.padBend(index, target, pos),
  onSlide: (index, target) => ui.padSlide(index, target),
  onScreen: (type, x, y, arg, fine) => ui.screen(type, x, y, arg, fine),
});
const display = new Display(panel.canvas);
const ui = new Ui(panel, display);
window.spettro = { ui, panel, display }; // for inspection from the console

// ---- Audio ----------------------------------------------------------------

// The Daisy engine runs at 48 kHz, as the instrument.
const ENGINE_RATE = 48000;
const TEST = new URLSearchParams(location.search).get('test');
const overlay = document.getElementById('start');
async function start() {
  overlay.classList.add('starting');
  const engine = await fetch('spectrum.wasm');
  if (!engine.ok) throw new Error('motore audio non trovato');
  // The context runs at the device's own rate and the worklet resamples:
  // forcing 48 kHz on an interface at 44.1 kHz makes Safari resample, which
  // crackles on iPad.
  const ctx = new AudioContext({ latencyHint: ui.latencyHint() });
  // Audio checks for crackles: ?test=osc plays a browser sine (none of our
  // code on the audio thread), ?test=tone a sine from the worklet without
  // the engine. The panel stays silent in both.
  if (TEST === 'osc') {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = 440; gain.gain.value = 0.25;
    osc.connect(gain).connect(ctx.destination); osc.start();
    overlay.querySelector('p').textContent = `test: browser sine 440 Hz at ${ctx.sampleRate / 1000} kHz`;
    overlay.style.pointerEvents = 'none'; // one sine only
    return;
  }
  const [module] = await Promise.all([
    WebAssembly.compileStreaming(engine),
    ctx.audioWorklet.addModule('engine-worklet.js'),
  ]);
  const node = new AudioWorkletNode(ctx, 'spectrum-engine', {
    numberOfInputs: 1, outputChannelCount: [2], processorOptions: { module, engineRate: ENGINE_RATE, testTone: TEST === 'tone' },
  });
  node.connect(ctx.destination);
  window.spettro.node = node;
  await new Promise((resolve) => {
    node.port.onmessage = ({ data }) => { if (data.type === 'ready') resolve(); };
  });
  node.port.onmessage = ({ data }) => { if (data.type === 'status') ui.status(data); };
  ui.attach(node.port, ctx);
  audio = { ctx, node };
  overlay.remove();
  document.body.classList.add('running');
  useInput(inputSelect.value).catch(() => { inputSelect.value = ''; });
}
let audio = null;
overlay.addEventListener('click', () => start().catch((err) => {
  overlay.querySelector('p').textContent = `Impossibile avviare l'audio: ${err.message}`;
  console.error(err);
}));

// ---- Audio input (External bank of oscillator B) -------------------------

// The chosen input feeds the worklet (summed to mono there); without
// echo cancellation, noise suppression or gain control, which would colour
// an instrument. Remembered in this browser and reopened at start.
const INPUT_KEY = 'spettro.audioInput';
const inputSelect = document.getElementById('audio-input');
let inputStream = null, inputSource = null;
async function listInputs() {
  const devices = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) || [];
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const chosen = inputSelect.value;
  // Before permission is given the browser hides names and ids.
  inputSelect.replaceChildren(new Option('off', ''),
    ...inputs.map((d, i) => new Option(d.label || `ingresso ${i + 1}`, d.deviceId || 'default')));
  inputSelect.value = [...inputSelect.options].some((o) => o.value === chosen) ? chosen : '';
}
async function useInput(id) {
  inputSource?.disconnect();
  inputStream?.getTracks().forEach((t) => t.stop());
  inputSource = inputStream = null;
  if (!id || !audio) return;
  inputStream = await navigator.mediaDevices.getUserMedia({ audio: {
    deviceId: id === 'default' ? undefined : { exact: id },
    echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } } });
  inputSource = audio.ctx.createMediaStreamSource(inputStream);
  inputSource.connect(audio.node);
  const deviceId = inputStream.getAudioTracks()[0]?.getSettings().deviceId;
  await listInputs();
  if (deviceId && [...inputSelect.options].some((o) => o.value === deviceId)) inputSelect.value = deviceId;
}
if (navigator.mediaDevices?.getUserMedia) {
  let saved = '';
  try { saved = localStorage.getItem(INPUT_KEY) || ''; } catch { /* storage unavailable */ }
  listInputs().then(() => {
    if (saved && ![...inputSelect.options].some((o) => o.value === saved)) inputSelect.add(new Option('ingresso scelto', saved));
    inputSelect.value = saved;
  });
  navigator.mediaDevices.addEventListener?.('devicechange', listInputs);
  inputSelect.addEventListener('change', () => {
    inputSelect.blur();
    try { localStorage.setItem(INPUT_KEY, inputSelect.value); } catch { /* not remembered */ }
    useInput(inputSelect.value).catch((err) => {
      console.warn('audio input:', err);
      inputSelect.value = '';
    });
  });
} else {
  inputSelect.replaceChildren(new Option('non supportato', ''));
  inputSelect.disabled = true;
}

// ---- Guide ----------------------------------------------------------------

const guide = document.getElementById('guide');
document.getElementById('guide-open').addEventListener('click', (e) => { e.currentTarget.blur(); guide.showModal(); });
document.getElementById('guide-close').addEventListener('click', () => guide.close());
// A click on the backdrop (outside the box) closes it too.
guide.addEventListener('click', (e) => { if (e.target === guide) guide.close(); });

// Full screen shows the instrument alone (the bar hides; Esc or the system
// control leaves). Older iPad Safari only has the webkit-prefixed calls.
const fullscreen = document.getElementById('fullscreen');
const root = document.documentElement;
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
fullscreen.addEventListener('click', () => {
  fullscreen.blur();
  if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  else (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root);
});
const onFullscreen = () => {
  const on = !!fullscreenElement();
  fullscreen.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('fullscreen', on);
};
document.addEventListener('fullscreenchange', onFullscreen);
document.addEventListener('webkitfullscreenchange', onFullscreen);

// ---- Keyboard mode ------------------------------------------------------

// Pad rows on the three letter rows; function keys as the panel buttons.
const PAD_KEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI',
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK',
  'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma'];
const FUNCTION_KEYS = { Digit1: 'octDown2', Digit2: 'octDown1', Digit3: 'octUp1', Digit4: 'octUp2',
  Space: 'hold', Digit5: 'arp', Digit6: 'loop' };
const keyboardToggle = document.getElementById('keyboard-mode');
let keyboardMode = false;
const setKeyboardMode = (on) => {
  keyboardMode = on;
  keyboardToggle.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('keyboard-mode', on);
  if (!on) ui.releaseAllKeys();
};
keyboardToggle.addEventListener('click', () => { setKeyboardMode(!keyboardMode); keyboardToggle.blur(); });

const held = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('select, input') || guide.open) return;
  if (e.code === 'Backquote' || (e.code === 'KeyK' && e.altKey)) { setKeyboardMode(!keyboardMode); e.preventDefault(); return; }
  if (!keyboardMode || e.ctrlKey || e.metaKey || e.altKey) return;
  const pad = PAD_KEYS.indexOf(e.code), fn = FUNCTION_KEYS[e.code];
  if (pad < 0 && !fn) return;
  e.preventDefault();
  if (e.repeat || held.has(e.code)) return;
  held.add(e.code);
  if (pad >= 0) ui.pad(pad, 'on', null, 'keyboard');
  else ui.button(fn, true);
});
window.addEventListener('keyup', (e) => {
  if (!held.delete(e.code)) return;
  const pad = PAD_KEYS.indexOf(e.code), fn = FUNCTION_KEYS[e.code];
  if (pad >= 0) ui.pad(pad, 'off', null, 'keyboard');
  else if (fn) ui.button(fn, false);
});
window.addEventListener('blur', () => {
  for (const code of held) {
    const pad = PAD_KEYS.indexOf(code), fn = FUNCTION_KEYS[code];
    if (pad >= 0) ui.pad(pad, 'off', null, 'keyboard');
    else if (fn) ui.button(fn, false);
  }
  held.clear();
});

// ---- MIDI -------------------------------------------------------------------

const midiSelect = document.getElementById('midi-input');
const channelSelect = document.getElementById('midi-channel');
let midiAccess = null;
function refreshMidi() {
  const current = midiSelect.value;
  midiSelect.innerHTML = '';
  const all = new Option('tutti gli ingressi', 'all');
  midiSelect.add(all);
  for (const input of midiAccess.inputs.values()) midiSelect.add(new Option(input.name, input.id));
  midiSelect.value = [...midiSelect.options].some((o) => o.value === current) ? current : 'all';
  for (const input of midiAccess.inputs.values())
    input.onmidimessage = (e) => { if (midiSelect.value === 'all' || midiSelect.value === input.id) ui.midi(Array.from(e.data), e.timeStamp); };
}
if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then((access) => {
    midiAccess = access;
    refreshMidi();
    access.onstatechange = refreshMidi;
  }).catch(() => { midiSelect.innerHTML = '<option>MIDI non disponibile</option>'; midiSelect.disabled = true; });
} else {
  midiSelect.innerHTML = '<option>MIDI non supportato</option>';
  midiSelect.disabled = true;
}
for (let ch = 1; ch <= 16; ch++) channelSelect.add(new Option(`canale ${ch}`, String(ch)));
channelSelect.addEventListener('change', () => ui.setMidiChannel(Number(channelSelect.value)));
ui.onMidiChannel = (ch) => { channelSelect.value = String(ch); };
