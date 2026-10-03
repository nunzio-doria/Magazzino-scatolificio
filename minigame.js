// =============================================================
// minigame.js — Easter egg: minigioco "Pesca i barattoli".
//
// Si avvia tenendo premuto per 5 secondi il tasto "Magazzino" della barra
// di navigazione in basso. Piovono barattoli: si sposta il secchio (dito o
// mouse, oppure frecce ← → da tastiera) per farli entrare dentro. Ogni
// barattolo mancato costa un cuore (3 in alto a sinistra); il punteggio è
// in alto a destra. Più si segna, più la difficoltà sale.
//
// Solo illustrativo: vive interamente nel browser. Non legge né scrive nulla
// su Supabase, né su localStorage, né altrove.
// =============================================================

import { pushLayer, releaseLayer } from './nav-history.js';
import { isSoundEnabled, isHapticsEnabled } from './feedback.js'; // rispetta le impostazioni suoni/vibrazione dell'app

const HOLD_MS = 5000; // pressione prolungata necessaria
const MOVE_TOLERANCE = 24; // px di spostamento del dito oltre i quali la pressione è annullata
const MAX_LIVES = 3;
const POINTS_PER_LEVEL = 5; // ogni 5 barattoli presi sale il livello

// ---------- Sprite pixel-art ----------
// Barattolo metallico: nessuna scritta né colore, solo acciaio con la
// cordonatura (le due nervature orizzontali) sul corpo.
const PAL = { H: '#f4f7fb', S: '#cdd5e1', M: '#a0abbd', D: '#6f7b91', K: '#4b5469' };
const CAN = [
  '.SHHSSMD.',
  'SHHSSSMDK',
  '.MHSSMDK.',
  '.SHHHSMD.',
  '.DMDDKKK.',
  '.MHSSMDK.',
  '.MHSSMDK.',
  '.DMDDKKK.',
  '.SHHHSMD.',
  '.MHSSMDK.',
  'MSSSSMDKK',
  '.MSSMMDK.',
];
const CW = 9;
const CH = 12;

const HEART = [
  '..XX.XX..',
  '.XXXXXXX.',
  'XXXXXXXXX',
  'XXXXXXXXX',
  '.XXXXXXX.',
  '..XXXXX..',
  '...XXX...',
  '....X....',
];
const HW = 9;
const HH = 8;

// Font 3x5 per punteggio e livello
const FONT = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  L: ['100', '100', '100', '100', '111'],
  V: ['101', '101', '101', '101', '010'],
  ' ': ['000', '000', '000', '000', '000'],
};

const GROUND_H = 6;
const BUCKET_H = 14;

// Cielo a fasce (effetto pixel-art): dal blu notte al blu più chiaro vicino al suolo
const SKY = (() => {
  const from = [11, 16, 32];
  const to = [40, 70, 128];
  const n = 14;
  return Array.from({ length: n }, (_, i) => {
    const k = i / (n - 1);
    return `rgb(${from.map((f, j) => Math.round(f + (to[j] - f) * k)).join(',')})`;
  });
})();

let active = false;

// ---------- Aggancio al tasto Magazzino ----------
export function initMinigame() {
  const btn = document.querySelector('[data-nav-target="products"]');
  const nav = btn && btn.closest('nav');
  if (!btn || !nav) return;

  let timer = null;
  let startX = 0;
  let startY = 0;
  let swallowClick = false;
  let swallowTimer = null;

  const cancelHold = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // Niente menu contestuale / selezione / callout durante la pressione lunga
  btn.style.webkitTouchCallout = 'none';
  btn.style.webkitUserSelect = 'none';
  btn.style.userSelect = 'none';
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancelHold();
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      swallowClick = true; // al rilascio il tocco NON deve cambiare sezione
      launchGame();
    }, HOLD_MS);
  });
  btn.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE) cancelHold();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => btn.addEventListener(t, cancelHold));

  // In fase di cattura sulla nav: intercetta il click di rilascio prima del gestore di navigazione
  nav.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );
  window.addEventListener(
    'pointerup',
    () => {
      if (!swallowClick) return;
      clearTimeout(swallowTimer);
      swallowTimer = setTimeout(() => {
        swallowClick = false;
      }, 400);
    },
    true
  );
}

// ---------- Utilità DOM ----------
function mk(tag, style, text) {
  const el = document.createElement(tag);
  if (style) Object.assign(el.style, style);
  if (text != null) el.textContent = text;
  return el;
}

function pixelButton(label, primary) {
  return mk(
    'button',
    {
      minHeight: '48px',
      minWidth: '140px',
      padding: '0 20px',
      borderRadius: '10px',
      border: '2px solid ' + (primary ? '#f4cf55' : 'rgba(255,255,255,.35)'),
      background: primary ? '#f4cf55' : 'rgba(255,255,255,.08)',
      color: primary ? '#1a1a2e' : '#fff',
      fontFamily: "'Barlow Condensed', sans-serif",
      fontWeight: '700',
      fontSize: '18px',
      textTransform: 'uppercase',
      letterSpacing: '.06em',
      cursor: 'pointer',
    },
    label
  );
}

// ---------- Vibrazione ----------
function vib(ms) {
  try {
    if (isHapticsEnabled() && navigator.vibrate) navigator.vibrate(ms);
  } catch (_) {
    /* vibrazione non disponibile: nessun problema */
  }
}

// ---------- Audio ----------
// Tutto sintetizzato al volo con Web Audio (nessun file audio): musichetta
// chiptune a 4 voci (melodia, arpeggio, basso, batteria) + effetti sonori.
// La canzoncina è originale, in Do maggiore (Do – La min – Fa – Sol), 8 battute in loop.
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

const MELODY = [
  76, 79, 76, 72, 67, 72, 76, 79, // Do
  81, 79, 76, 72, 69, 72, 76, 81, // La min
  77, 81, 77, 72, 69, 72, 77, 81, // Fa
  79, 77, 74, 71, 67, 71, 74, 0, //  Sol
  72, 76, 79, 84, 79, 76, 72, 76, // Do
  69, 72, 76, 81, 76, 72, 76, 72, // La min
  77, 76, 74, 72, 74, 76, 77, 81, // Fa
  79, 77, 74, 71, 74, 77, 79, 0, //  Sol
];
const CHORDS = [
  { root: 48, arp: [64, 67, 72, 67] }, // Do
  { root: 45, arp: [64, 69, 72, 69] }, // La min
  { root: 41, arp: [65, 69, 72, 69] }, // Fa
  { root: 43, arp: [62, 67, 71, 67] }, // Sol
];
const PENTA = [72, 74, 76, 79, 81, 84, 86, 88]; // scala dei "catch" consecutivi
const BASE_BPM = 128;

function createAudio(startMuted) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  let ctx;
  try {
    ctx = new AC();
  } catch (_) {
    return null;
  }

  const master = ctx.createGain();
  master.gain.value = startMuted ? 0 : 0.7;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp);
  comp.connect(ctx.destination);
  const musicBus = ctx.createGain();
  musicBus.gain.value = 0.5;
  musicBus.connect(master);
  const sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.9;
  sfxBus.connect(master);

  // Rumore bianco (per hi-hat, rullante, clangore)
  const nbuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = nbuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  // Onda a impulso 25% (timbro "NES") per l'arpeggio
  const N = 32;
  const real = new Float32Array(N + 1);
  const imag = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * 0.25);
  const pulse = ctx.createPeriodicWave(real, imag);

  function tone(bus, t, { type = 'square', wave = null, f, f2 = null, dur = 0.1, vol = 0.1 }) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    if (wave) o.setPeriodicWave(wave);
    else o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  function noise(bus, t, { dur = 0.05, vol = 0.1, kind = 'highpass', freq = 6000 }) {
    const s = ctx.createBufferSource();
    s.buffer = nbuf;
    const fl = ctx.createBiquadFilter();
    fl.type = kind;
    fl.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl);
    fl.connect(g);
    g.connect(bus);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.03);
  }

  // ----- Musica -----
  let bpm = BASE_BPM;
  let step = 0;
  let nextTime = 0;
  let timer = null;

  function scheduleStep(i, t) {
    const bar = Math.floor(i / 8);
    const s = i % 8;
    const ch = CHORDS[bar % 4];
    const sd = 60 / bpm / 2; // durata di una croma

    const m = MELODY[i];
    if (m) tone(musicBus, t, { type: 'square', f: mtof(m), dur: sd * 0.9, vol: 0.085 });

    if (s % 2 === 1) tone(musicBus, t, { wave: pulse, f: mtof(ch.arp[(s - 1) / 2]), dur: sd * 0.8, vol: 0.07 });

    if (s === 0 || s === 2 || s === 6) tone(musicBus, t, { type: 'triangle', f: mtof(ch.root), dur: sd * 1.8, vol: 0.2 });
    else if (s === 4) tone(musicBus, t, { type: 'triangle', f: mtof(ch.root + 7), dur: sd * 1.8, vol: 0.2 });

    if (s === 0 || s === 4) tone(musicBus, t, { type: 'sine', f: 150, f2: 45, dur: 0.13, vol: 0.28 }); // cassa
    const fill = bar === 7 && s >= 6;
    if (s === 2 || s === 6 || fill) noise(musicBus, t, { dur: 0.09, vol: 0.1, kind: 'bandpass', freq: 1800 }); // rullante
    noise(musicBus, t, { dur: 0.03, vol: s % 2 ? 0.035 : 0.05, kind: 'highpass', freq: 7000 }); // hi-hat
  }

  function tick() {
    while (nextTime < ctx.currentTime + 0.15) {
      scheduleStep(step, nextTime);
      nextTime += 60 / bpm / 2;
      step = (step + 1) % 64;
    }
  }

  // ----- Effetti -----
  const sfx = {
    catch(combo) {
      const t = ctx.currentTime;
      const n = PENTA[Math.min(combo, PENTA.length - 1)];
      tone(sfxBus, t, { type: 'square', f: mtof(n), dur: 0.09, vol: 0.15 });
      tone(sfxBus, t + 0.05, { type: 'square', f: mtof(n + 7), dur: 0.1, vol: 0.12 });
      tone(sfxBus, t, { type: 'sine', f: mtof(n + 24), dur: 0.16, vol: 0.05 }); // tintinnio metallico
    },
    miss() {
      const t = ctx.currentTime;
      tone(sfxBus, t, { type: 'sawtooth', f: 220, f2: 80, dur: 0.3, vol: 0.16 });
      noise(sfxBus, t, { dur: 0.12, vol: 0.14, kind: 'lowpass', freq: 600 });
    },
    clank() {
      const t = ctx.currentTime;
      noise(sfxBus, t, { dur: 0.07, vol: 0.12, kind: 'bandpass', freq: 3200 });
      tone(sfxBus, t, { type: 'sine', f: 1760, dur: 0.18, vol: 0.05 });
      tone(sfxBus, t, { type: 'sine', f: 2637, dur: 0.14, vol: 0.04 });
    },
    levelUp() {
      const t = ctx.currentTime + 0.05;
      [72, 76, 79, 84].forEach((n, k) => tone(sfxBus, t + k * 0.07, { type: 'square', f: mtof(n), dur: 0.1, vol: 0.13 }));
    },
    gameOver() {
      const t = ctx.currentTime + 0.3;
      [67, 64, 60, 55].forEach((n, k) =>
        tone(sfxBus, t + k * 0.22, { type: 'square', f: mtof(n), dur: k === 3 ? 0.6 : 0.24, vol: 0.14 })
      );
    },
    click() {
      tone(sfxBus, ctx.currentTime, { type: 'square', f: 660, dur: 0.05, vol: 0.1 });
    },
  };

  return {
    ...sfx,
    startMusic() {
      if (timer) return;
      step = 0;
      nextTime = ctx.currentTime + 0.08;
      timer = setInterval(tick, 30);
      tick();
    },
    stopMusic() {
      clearInterval(timer);
      timer = null;
    },
    setTempo(v) {
      bpm = v;
    },
    setMuted(m) {
      master.gain.setTargetAtTime(m ? 0 : 0.7, ctx.currentTime, 0.02);
    },
    resume() {
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    },
    suspend() {
      if (ctx.state === 'running') ctx.suspend().catch(() => {});
    },
    dispose() {
      clearInterval(timer);
      timer = null;
      ctx.close().catch(() => {});
    },
  };
}

// ---------- Gioco ----------
function launchGame() {
  if (active) return;
  active = true;
  vib(40);
  let muted = !isSoundEnabled(); // parte silenzioso se l'app ha i suoni disattivati
  const audio = createAudio(muted);

  // --- DOM ---
  const overlay = mk('div', {
    position: 'fixed',
    inset: '0',
    zIndex: '200',
    background: '#070b18',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'none',
    userSelect: 'none',
    webkitUserSelect: 'none',
    webkitTouchCallout: 'none',
    overscrollBehavior: 'none',
  });
  overlay.id = 'minigame-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Minigioco: pesca i barattoli');

  const wrap = mk('div', { position: 'relative', overflow: 'hidden' });
  const canvas = mk('canvas', { display: 'block', imageRendering: 'pixelated' });
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const closeBtn = mk(
    'button',
    {
      position: 'absolute',
      top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
      left: '50%',
      transform: 'translateX(-50%)',
      width: '40px',
      height: '40px',
      borderRadius: '8px',
      border: '2px solid rgba(255,255,255,.3)',
      background: 'rgba(255,255,255,.1)',
      color: '#fff',
      fontSize: '18px',
      lineHeight: '1',
      cursor: 'pointer',
    },
    '✕'
  );
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Chiudi minigioco');

  const muteBtn = mk(
    'button',
    {
      position: 'absolute',
      top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
      left: 'calc(50% + 28px)',
      width: '40px',
      height: '40px',
      borderRadius: '8px',
      border: '2px solid rgba(255,255,255,.3)',
      background: 'rgba(255,255,255,.1)',
      color: '#fff',
      fontSize: '16px',
      lineHeight: '1',
      cursor: 'pointer',
      display: audio ? 'block' : 'none',
    },
    muted ? '🔇' : '🔊'
  );
  muteBtn.type = 'button';
  muteBtn.setAttribute('aria-label', 'Attiva o disattiva l\'audio');

  const hint = mk(
    'div',
    {
      position: 'absolute',
      left: '0',
      right: '0',
      top: '38%',
      textAlign: 'center',
      color: '#fff',
      fontFamily: "'Barlow Condensed', sans-serif",
      fontWeight: '700',
      fontSize: '20px',
      padding: '0 16px',
      boxSizing: 'border-box',
      textTransform: 'uppercase',
      letterSpacing: '.06em',
      textShadow: '0 2px 0 rgba(0,0,0,.6)',
      pointerEvents: 'none',
      transition: 'opacity .5s',
    },
    'Prendi i barattoli col secchio'
  );

  const panel = mk('div', {
    position: 'absolute',
    inset: '0',
    display: 'none',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '14px',
    background: 'rgba(5,8,20,.78)',
    color: '#fff',
    fontFamily: "'Barlow Condensed', sans-serif",
    textTransform: 'uppercase',
    textAlign: 'center',
  });
  const panelTitle = mk('div', { fontSize: '44px', fontWeight: '700', color: '#ff6b6b', letterSpacing: '.06em' }, 'Game over');
  const panelScore = mk('div', { fontSize: '24px', fontWeight: '600', letterSpacing: '.06em' }, '');
  const retryBtn = pixelButton('Riprova', true);
  const exitBtn = pixelButton('Esci', false);
  retryBtn.type = 'button';
  exitBtn.type = 'button';
  panel.append(panelTitle, panelScore, retryBtn, exitBtn);

  wrap.append(canvas, hint, closeBtn, muteBtn, panel);
  overlay.append(wrap);
  document.body.append(overlay);

  // --- Stato ---
  let scale = 3;
  let W = 120;
  let H = 240;
  let topPad = 6;
  let stars = [];
  let raf = 0;
  let last = 0;
  const keys = { left: false, right: false };

  const g = {
    state: 'play',
    score: 0,
    lives: MAX_LIVES,
    cans: [],
    parts: [],
    t: 0,
    spawn: 1,
    hurt: 0,
    bump: 0,
    combo: 0,
    cx: 60,
    tcx: 60,
    bw: 28,
    by: 200,
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const level = () => Math.floor(g.score / POINTS_PER_LEVEL);

  function baseBucketW() {
    return clamp(Math.round(W * 0.24), 24, 34);
  }

  function layout() {
    const cssW = Math.min(window.innerWidth, 520);
    const cssH = window.innerHeight;
    scale = Math.max(2, Math.round(cssW / 140));
    W = Math.max(90, Math.floor(cssW / scale));
    H = Math.max(160, Math.floor(cssH / scale));
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W * scale}px`;
    canvas.style.height = `${H * scale}px`;
    wrap.style.width = `${W * scale}px`;
    wrap.style.height = `${H * scale}px`;
    ctx.imageSmoothingEnabled = false;

    // Area sicura in alto (notch): misurata una volta e convertita in pixel logici
    const probe = mk('div', { position: 'fixed', top: '0', left: '0', paddingTop: 'env(safe-area-inset-top, 0px)', visibility: 'hidden' });
    document.body.append(probe);
    const inset = probe.offsetHeight;
    probe.remove();
    topPad = Math.ceil(inset / scale) + 6;

    g.by = H - GROUND_H - BUCKET_H;
    g.cx = clamp(g.cx, g.bw / 2, W - g.bw / 2);
    g.tcx = clamp(g.tcx, g.bw / 2, W - g.bw / 2);

    // Stelle fisse (generatore pseudo-casuale con seme, così non "ballano" al resize)
    let seed = 1234567;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    stars = Array.from({ length: 26 }, () => ({
      x: Math.floor(rnd() * W),
      y: Math.floor(rnd() * (H - GROUND_H - 20)),
      c: rnd() > 0.7 ? '#ffffff' : '#7f95c9',
    }));
  }

  function startRound() {
    g.state = 'play';
    g.score = 0;
    g.lives = MAX_LIVES;
    g.cans = [];
    g.parts = [];
    g.t = 0;
    g.spawn = 1;
    g.hurt = 0;
    g.bump = 0;
    g.bw = baseBucketW();
    g.cx = W / 2;
    g.tcx = W / 2;
    g.combo = 0;
    panel.style.display = 'none';
    if (audio) {
      audio.setTempo(BASE_BPM);
      audio.startMusic();
    }
  }

  function spawnCan() {
    const lv = level();
    const k = H / 240; // la velocità scala con l'altezza dello schermo
    const amp = lv >= 3 ? Math.min(9, (lv - 2) * 1.5) : 0;
    const margin = amp + 2;
    const base = 42 + lv * 7;
    g.cans.push({
      x0: margin + Math.random() * Math.max(1, W - CW - margin * 2),
      x: 0,
      y: -CH,
      vy: Math.min(165, base * (0.9 + Math.random() * 0.25)) * k,
      amp,
      freq: 2 + Math.random() * 2,
      ph: Math.random() * Math.PI * 2,
      age: 0,
      vx: 0,
      missed: false,
    });
    g.spawn = Math.max(0.38, 1.15 - lv * 0.07) + Math.random() * 0.25;
  }

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      g.parts.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 50,
        vy: -20 - Math.random() * 45,
        life: 0.4 + Math.random() * 0.3,
        color,
      });
    }
  }

  const vibrate = vib;

  function loseLife() {
    g.lives -= 1;
    g.hurt = 0.25;
    g.combo = 0;
    vibrate(35);
    if (audio) audio.miss();
    if (g.lives <= 0) {
      g.state = 'over';
      if (audio) {
        audio.stopMusic();
        audio.gameOver();
      }
      panelScore.textContent = `Punteggio: ${g.score}`;
      panel.style.display = 'flex';
      vibrate(120);
    }
  }

  function update(dt) {
    g.t += dt;
    if (keys.left) g.tcx -= 120 * dt;
    if (keys.right) g.tcx += 120 * dt;

    // Il secchio si restringe un po' con i livelli alti
    const lv = level();
    g.bw = Math.max(baseBucketW() - 8, baseBucketW() - Math.floor(lv / 3) * 2);
    g.tcx = clamp(g.tcx, g.bw / 2, W - g.bw / 2);
    g.cx += (g.tcx - g.cx) * Math.min(1, dt * 20);
    g.cx = clamp(g.cx, g.bw / 2, W - g.bw / 2);

    g.spawn -= dt;
    if (g.spawn <= 0) spawnCan();

    const left = g.cx - g.bw / 2;
    for (let i = g.cans.length - 1; i >= 0; i--) {
      const c = g.cans[i];
      c.age += dt;
      c.y += c.vy * dt;
      if (c.missed) c.x += c.vx * dt;
      else c.x = c.x0 + Math.sin(c.age * c.freq + c.ph) * c.amp;

      if (!c.missed && c.y + CH >= g.by + 2) {
        const center = c.x + CW / 2;
        if (center >= left + 1 && center <= left + g.bw - 1) {
          // Preso: entra nel secchio
          const lvBefore = level();
          g.score += 1;
          g.combo += 1;
          g.bump = 0.12;
          if (audio) {
            audio.catch(g.combo - 1);
            if (level() > lvBefore) {
              audio.levelUp();
              audio.setTempo(BASE_BPM + Math.min(level(), 10) * 5); // la musica accelera
            }
          }
          burst(center, g.by, '#e8eef8', 6);
          g.cans.splice(i, 1);
          continue;
        }
        // Mancato (anche se sfiora il bordo): rimbalza di lato e cade
        c.missed = true;
        c.vx = (center < g.cx ? -1 : 1) * 28;
        loseLife();
        if (g.state === 'over') break;
      }

      if (c.y + CH >= H - GROUND_H) {
        if (c.missed) {
          burst(c.x + CW / 2, H - GROUND_H, '#a0abbd', 5);
          if (audio) audio.clank();
        }
        g.cans.splice(i, 1);
      }
    }

    for (let i = g.parts.length - 1; i >= 0; i--) {
      const p = g.parts[i];
      p.life -= dt;
      if (p.life <= 0) {
        g.parts.splice(i, 1);
        continue;
      }
      p.vy += 140 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    if (g.hurt > 0) g.hurt -= dt;
    if (g.bump > 0) g.bump -= dt;
  }

  // ---------- Disegno ----------
  const R = Math.round;

  function sprite(rows, x, y, pal) {
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        const ch = rows[r][c];
        if (ch === '.') continue;
        ctx.fillStyle = pal[ch];
        ctx.fillRect(R(x) + c, R(y) + r, 1, 1);
      }
    }
  }

  function mask(rows, x, y, color) {
    ctx.fillStyle = color;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (rows[r][c] !== '.') ctx.fillRect(R(x) + c, R(y) + r, 1, 1);
      }
    }
  }

  function heart(x, y, full) {
    ['-1,0', '1,0', '0,-1', '0,1'].forEach((o) => {
      const [dx, dy] = o.split(',').map(Number);
      mask(HEART, x + dx, y + dy, '#2a0a10');
    });
    mask(HEART, x, y, full ? '#e5383b' : '#3a3f5c');
    if (full) {
      ctx.fillStyle = '#ffb3b8';
      ctx.fillRect(R(x) + 2, R(y) + 2, 1, 1);
      ctx.fillRect(R(x) + 1, R(y) + 2, 1, 1);
    }
  }

  function drawText(str, xRight, y, s, color) {
    const width = str.length * 4 * s - s;
    let x = R(xRight - width);
    for (const ch of str) {
      const rows = FONT[ch] || FONT[' '];
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 3; c++) {
          if (rows[r][c] === '1') ctx.fillRect(x + c * s, R(y) + r * s, s, s);
        }
      }
      x += 4 * s;
    }
  }

  function textWithShadow(str, xRight, y, s, color) {
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    drawText(str, xRight + 1, y + 1, s);
    ctx.fillStyle = color;
    drawText(str, xRight, y, s);
  }

  function drawBucket() {
    const w = R(g.bw);
    const x = R(g.cx - g.bw / 2);
    const y = g.by + (g.bump > 0 ? 1 : 0);
    // bordo
    ctx.fillStyle = '#b9c9ee';
    ctx.fillRect(x - 1, y, w + 2, 2);
    // bocca scura (si intravede l'interno)
    ctx.fillStyle = '#16264a';
    ctx.fillRect(x + 1, y + 2, w - 2, 1);
    // corpo a trapezio
    const bodyH = BUCKET_H - 2;
    for (let r = 0; r < bodyH; r++) {
      const inset = Math.floor((r * 3) / (bodyH - 1));
      const rx = x + inset;
      const rw = w - inset * 2;
      ctx.fillStyle = '#4f7cc4';
      ctx.fillRect(rx, y + 2 + r, rw, 1);
      ctx.fillStyle = '#7ea3e6'; // riflesso a sinistra
      ctx.fillRect(rx, y + 2 + r, 2, 1);
      ctx.fillStyle = '#34559a'; // ombra a destra
      ctx.fillRect(rx + rw - 2, y + 2 + r, 2, 1);
      if (r === 4 || r === 9) {
        ctx.fillStyle = '#2a4482'; // fascette
        ctx.fillRect(rx, y + 2 + r, rw, 1);
      }
    }
  }

  function draw() {
    // cielo
    const bh = Math.ceil(H / SKY.length);
    for (let i = 0; i < SKY.length; i++) {
      ctx.fillStyle = SKY[i];
      ctx.fillRect(0, i * bh, W, bh);
    }
    for (const s of stars) {
      ctx.fillStyle = s.c;
      ctx.fillRect(s.x, s.y, 1, 1);
    }
    // suolo
    ctx.fillStyle = '#222844';
    ctx.fillRect(0, H - GROUND_H, W, GROUND_H);
    ctx.fillStyle = '#4a5580';
    ctx.fillRect(0, H - GROUND_H, W, 1);
    ctx.fillStyle = '#171c33';
    for (let x = 0; x < W; x += 8) ctx.fillRect(x, H - GROUND_H + 3, 4, 1);

    for (const c of g.cans) sprite(CAN, c.x, c.y, PAL);
    drawBucket();

    for (const p of g.parts) {
      ctx.fillStyle = p.color;
      ctx.fillRect(R(p.x), R(p.y), 1, 1);
    }

    // HUD: cuori in alto a sinistra, punteggio e livello in alto a destra
    for (let i = 0; i < MAX_LIVES; i++) heart(5 + i * (HW + 3), topPad, i < g.lives);
    textWithShadow(String(g.score), W - 5, topPad, 2, '#ffffff');
    textWithShadow(`LV ${level() + 1}`, W - 5, topPad + 13, 1, '#9fb4e8');

    if (g.hurt > 0) {
      ctx.fillStyle = `rgba(255,60,60,${Math.min(0.35, g.hurt * 1.4)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!last) last = ts;
    const dt = Math.min(0.05, (ts - last) / 1000);
    last = ts;
    if (g.state === 'play') update(dt);
    draw();
  }

  // ---------- Input ----------
  function setTarget(clientX) {
    const rect = canvas.getBoundingClientRect();
    g.tcx = clamp((clientX - rect.left) / scale, g.bw / 2, W - g.bw / 2);
  }
  const onPointer = (e) => {
    // Ignora i tocchi sui pulsanti del gioco; accetta tutto il resto (anche il dito
    // ancora appoggiato sul tasto della barra da cui è partita la pressione lunga).
    if (overlay.contains(e.target) && e.target.closest('button')) return;
    setTarget(e.clientX);
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = true;
    else if (e.key === 'ArrowRight' || e.key === 'd') keys.right = true;
    else if (e.key === 'Escape') close(false);
  };
  const onKeyUp = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = false;
    else if (e.key === 'ArrowRight' || e.key === 'd') keys.right = false;
  };
  const onResize = () => layout();
  const onVisibility = () => {
    last = 0; // evita un salto di tempo al ritorno sulla pagina
    if (audio) {
      if (document.hidden) audio.suspend();
      else audio.resume();
    }
  };
  // Le policy autoplay (soprattutto iOS) sbloccano l'audio solo dopo un gesto: lo si riprova a ogni tocco
  const unlockAudio = () => {
    if (audio) audio.resume();
  };

  window.addEventListener('pointermove', onPointer);
  window.addEventListener('pointerdown', onPointer);
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('pointerup', unlockAudio);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);

  // Tasto "indietro" del telefono: chiude il gioco invece di uscire dall'app
  let layer = null;
  function close(fromBack) {
    if (!active) return;
    active = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('pointerdown', onPointer);
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('pointerup', unlockAudio);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    if (audio) audio.dispose();
    overlay.remove();
    if (!fromBack) releaseLayer(layer);
  }
  layer = pushLayer(() => close(true));

  closeBtn.addEventListener('click', () => close(false));
  exitBtn.addEventListener('click', () => close(false));
  retryBtn.addEventListener('click', () => {
    if (audio) audio.click();
    startRound();
    last = 0;
  });
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.textContent = muted ? '🔇' : '🔊';
    if (audio) {
      audio.setMuted(muted);
      audio.resume();
      if (!muted) audio.click();
    }
  });

  layout();
  startRound();
  setTimeout(() => {
    hint.style.opacity = '0';
  }, 3000);
  raf = requestAnimationFrame(frame);
}
