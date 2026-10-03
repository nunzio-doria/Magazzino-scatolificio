// =============================================================
// minigame.js — Easter egg: minigioco "Pesca i barattoli".
//
// Si avvia tenendo premuto per 5 secondi il tasto "Magazzino" della barra
// di navigazione in basso. Negli ultimi 1,3 secondi lo schermo trema sempre
// più forte, si crepa e si frantuma lasciando comparire il gioco (con
// vibrazione e suono sincronizzati a ogni fase).
//
// Piovono barattoli: si sposta il secchio (dito, mouse o frecce ← →) per
// farli entrare dentro. Ogni barattolo mancato costa un cuore (3 in alto a
// sinistra); il punteggio è in alto a destra. Più si segna, più sale la
// difficoltà. Dal livello 1 in poi, insieme ai barattoli cadono oggetti
// del reparto scatolificio:
//   BONUS  bobina di banda stagnata (+5), calamita (attira i barattoli),
//          chiave inglese (+1 cuore), arresto di emergenza (rallenta tutto)
//   MALUS  scarto arrugginito (-1 cuore), macchia d'olio (secchio scivoloso),
//          scintilla di saldatura (secchio bloccato per un attimo)
//
// Lo sfondo segue l'ora reale (sole di giorno, luna e stelle di notte, con
// alba e tramonto) oppure si forza dal menu di pausa (Giorno / Notte / Auto),
// dove si trovano anche gli interruttori di vibrazione e suono.
//
// Nella schermata iniziale cammina avanti e indietro un personaggio che ogni
// tanto controlla l'orologio (toccandolo lo fa subito, con tic-tac).
// All'apertura compare la schermata iniziale: Nuova partita, High score
// (le 5 migliori classifiche, con nome di chi le ha fatte), Impostazioni.
// A fine partita, se il punteggio entra in classifica, si inserisce il nome.
//
// Vive interamente nel browser. Non scrive nulla su Supabase: l'unico dato
// salvato (in localStorage, solo su questo dispositivo) è la classifica con
// l'ultimo nome usato. Le scelte del menu di pausa/impostazioni restano
// solo finché l'app non viene ricaricata.
// =============================================================

import { pushLayer, releaseLayer } from './nav-history.js';
import { isSoundEnabled, isHapticsEnabled } from './feedback.js'; // valori di partenza = impostazioni suoni/vibrazione dell'app

const HOLD_MS = 5000; // pressione prolungata necessaria
const MOVE_TOLERANCE = 24; // px di spostamento del dito oltre i quali la pressione è annullata
const MAX_LIVES = 3;
const POINTS_PER_LEVEL = 5; // ogni 5 punti sale il livello

// Sequenza "lo schermo si rompe" (ms dall'inizio della pressione)
const FX_TREMOR_MS = 3700; // inizia a tremare
const FX_CRACK1_MS = 4250; // prima crepa
const FX_CRACK2_MS = 4650; // seconda crepa, più estesa
const SHARD_NODE_BUDGET = 14000; // nodi DOM totali (nodi dell'istantanea × frammenti) oltre cui si riducono i frammenti
const SHARD_NODE_LIMIT = 24000; // oltre questo limite niente istantanea: frammenti di vetro semplici

const FONT_UI = "'Barlow Condensed', sans-serif";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (x) => {
  const k = clamp(x, 0, 1);
  return k * k * (3 - 2 * k);
};

// ---------- Classifica (high score) ----------
// Le 5 migliori partite, salvate in localStorage solo su questo dispositivo.
const SCORES_KEY = 'magazzino-minigame-scores';
const NAME_KEY = 'magazzino-minigame-name';
const MAX_SCORES = 5;
const NAME_MAX = 10;
const cleanName = (v) =>
  String(v || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .\-]/g, '')
    .slice(0, NAME_MAX);
const byRank = (a, b) => b.score - a.score || a.at - b.at; // a parità vince chi l'ha fatto prima

function loadScores() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCORES_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e) => e && Number.isFinite(e.score) && e.score > 0)
      .map((e) => ({ name: cleanName(e.name).trim() || '---', score: Math.floor(e.score), at: Number(e.at) || 0 }))
      .sort(byRank)
      .slice(0, MAX_SCORES);
  } catch (_) {
    return [];
  }
}
function scoreQualifies(score) {
  if (!(score > 0)) return false;
  const list = loadScores();
  return list.length < MAX_SCORES || score > list[list.length - 1].score;
}
// Inserisce il punteggio e restituisce la posizione (0 = primo) nella nuova classifica
function insertScore(name, score) {
  const entry = { name, score: Math.floor(score), at: Date.now() };
  const list = loadScores();
  list.push(entry);
  list.sort(byRank);
  const pos = list.indexOf(entry);
  try {
    localStorage.setItem(SCORES_KEY, JSON.stringify(list.slice(0, MAX_SCORES)));
    localStorage.setItem(NAME_KEY, name);
  } catch (_) {
    /* memoria piena o bloccata: la classifica vale solo per questa sessione */
  }
  return pos;
}
function lastName() {
  try {
    return cleanName(localStorage.getItem(NAME_KEY));
  } catch (_) {
    return '';
  }
}

// ---------- Preferenze di sessione (nessun salvataggio su disco) ----------
// sound / haptics null = segue le impostazioni dell'app; true/false = scelta fatta nel menu di pausa
const prefs = { sound: null, haptics: null, bg: 'auto' };
const effSound = () => (prefs.sound === null ? isSoundEnabled() : prefs.sound);
const effHaptics = () => (prefs.haptics === null ? isHapticsEnabled() : prefs.haptics);
const hapticsSupported = () => typeof navigator.vibrate === 'function';

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

// --- Bonus ---
// Bobina di banda stagnata (rotolo di lamiera visto di fronte): dorata per distinguersi
const COIL = [
  '...KKKKK...',
  '..KGGGYYK..',
  '.KGYYYYYYK.',
  'KGYYKKKYYYK',
  'KGYKKKKKYYK',
  'KYYKKKKKYOK',
  'KYYKKKKKYOK',
  'KYYYKKKYOOK',
  '.KYYYYYOOK.',
  '..KYYOOOK..',
  '...KKKKK...',
];
const PAL_COIL = { G: '#fff2a8', Y: '#f4cf55', O: '#c58d1f', K: '#5a3a0a' };
// Calamita a ferro di cavallo (i reparti la usano per sollevare le lamiere)
const MAGNET = [
  '...RRRRR...',
  '.RRRRRRRRR.',
  'RRHRRRRRRRR',
  'RRRR...RRRR',
  'RHRR...RRRD',
  'RRRR...RRRD',
  'RRRR...RRRD',
  'RRRR...RRRD',
  'WWWW...WWWW',
  'WSSW...WSSW',
  'KKKK...KKKK',
];
const PAL_MAGNET = { R: '#e5383b', H: '#ff9aa0', D: '#a31d27', W: '#f4f7fb', S: '#a0abbd', K: '#4b5469' };
// Chiave inglese (manutenzione)
const WRENCH = [
  '.HS...DD.',
  'HSS...SDD',
  'HSSS.SSDD',
  '.HSSSSSD.',
  '..HSSSD..',
  '...HSD...',
  '...HSD...',
  '...HSD...',
  '...HSD...',
  '..HSSSD..',
  '..HSSSD..',
  '...KKK...',
];
const PAL_WRENCH = { H: '#d6ecff', S: '#6fb4ff', D: '#2f6db5', K: '#17365e' };
// Fungo di arresto di emergenza
const STOPBTN = [
  '...KKKKK...',
  '..KRRRRRK..',
  '.KRHHRRRRK.',
  'KRHHRRRRRRK',
  'KRRRRRRRRDK',
  'KRRRRRRRDDK',
  '.KDDDDDDDK.',
  '..KKYYYKK..',
  '...KYYYK...',
  '..KYYYYYK..',
  '..KKKKKKK..',
];
const PAL_STOP = { R: '#e5383b', H: '#ff8c90', D: '#9d1a22', Y: '#f4cf55', K: '#2a0a10' };

// --- Malus ---
// Scarto arrugginito (barattolo ammaccato con ruggine)
const RUST = [
  '..SHSSM..',
  '.SHHSMDK.',
  '.MHSSMKD.',
  '.SHKHSMD.',
  '.DMDDKKK.',
  '.MHSKMDK.',
  '.MKSSMDK.',
  '.DMDDKKK.',
  '.SHHKSMD.',
  '.MHSSMKK.',
  'MSKSSMDKK',
  '.MSSMMDK.',
];
const PAL_RUST = { H: '#d9a066', S: '#b8733a', M: '#8e4f26', D: '#6a381b', K: '#47250f' };
// Goccia d'olio lubrificante
const OIL = [
  '....K....',
  '....K....',
  '...KDK...',
  '...KDK...',
  '..KDDDK..',
  '..KDDDK..',
  '.KDDHDDK.',
  '.KDHHDDK.',
  'KDDHDDDDK',
  'KDDDDDDDK',
  '.KDDDDDK.',
  '..KKKKK..',
];
const PAL_OIL = { K: '#120c04', D: '#3b2a12', H: '#c98a2b' };
// Scintilla dell'arco di saldatura
const SPARK = [
  '.....Y.....',
  '..Y..W..Y..',
  '...Y.W.Y...',
  '....YWY....',
  '.YYYWBWYYY.',
  'YWWWBBBWWWY',
  '.YYYWBWYYY.',
  '....YWY....',
  '...Y.W.Y...',
  '..Y..W..Y..',
  '.....Y.....',
];
const PAL_SPARK = { Y: '#ffd23f', W: '#ffffff', B: '#4cc9f0' };

// kind: good = barattolo (se manca costa un cuore), bonus = da prendere, malus = da evitare
const ITEMS = {
  can: { kind: 'good', rows: CAN, pal: PAL },
  coil: { kind: 'bonus', rows: COIL, pal: PAL_COIL, glow: '#ffe27a' },
  magnet: { kind: 'bonus', rows: MAGNET, pal: PAL_MAGNET, glow: '#ff9aa0' },
  wrench: { kind: 'bonus', rows: WRENCH, pal: PAL_WRENCH, glow: '#8fd0ff' },
  stop: { kind: 'bonus', rows: STOPBTN, pal: PAL_STOP, glow: '#ffd0d2' },
  rust: { kind: 'malus', rows: RUST, pal: PAL_RUST },
  oil: { kind: 'malus', rows: OIL, pal: PAL_OIL },
  spark: { kind: 'malus', rows: SPARK, pal: PAL_SPARK },
};
for (const it of Object.values(ITEMS)) {
  it.w = it.rows[0].length;
  it.h = it.rows.length;
}

// Durata degli effetti (secondi)
const FX_DUR = { magnet: 8, stop: 6, oil: 6, freeze: 1.3 };

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

const CLOUD = [
  '....XXXX......',
  '..XXXXXXXX.XX.',
  '.XXXXXXXXXXXXX',
  'XXXXXXXXXXXXXX',
  '.XXXXXXXXXXXX.',
];

// Font 3x5 per punteggio, livello e scritte che compaiono sul gioco
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
  A: ['010', '101', '111', '101', '101'],
  C: ['011', '100', '100', '100', '011'],
  E: ['111', '100', '111', '100', '111'],
  G: ['011', '100', '101', '101', '011'],
  I: ['111', '010', '010', '010', '111'],
  L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'],
  N: ['110', '101', '101', '101', '101'],
  O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'],
  R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'],
  T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'],
  V: ['101', '101', '101', '101', '010'],
  '+': ['000', '010', '111', '010', '000'],
  '-': ['000', '000', '111', '000', '000'],
  ' ': ['000', '000', '000', '000', '000'],
};

// Icone dell'interfaccia (disegnate a pixel, nessuna emoji). X = colore del testo.
const ICONS = {
  pause: ['.........', '.XXX.XXX.', '.XXX.XXX.', '.XXX.XXX.', '.XXX.XXX.', '.XXX.XXX.', '.XXX.XXX.', '.XXX.XXX.', '.........'],
  play: ['..X......', '..XX.....', '..XXX....', '..XXXX...', '..XXXXX..', '..XXXX...', '..XXX....', '..XX.....', '..X......'],
  soundOn: ['...X.......', '..XX...X...', 'XXXX.X..X..', 'XXXX..X..X.', 'XXXX..X..X.', 'XXXX..X..X.', 'XXXX.X..X..', '..XX...X...', '...X.......'],
  soundOff: ['...X.......', '..XX.......', 'XXXX.X...X.', 'XXXX..X.X..', 'XXXX...X...', 'XXXX..X.X..', 'XXXX.X...X.', '..XX.......', '...X.......'],
  vibrate: ['...XXXXX...', '...X...X...', '.X.X...X.X.', 'X..X...X..X', 'X..X...X..X', 'X..X...X..X', '.X.X...X.X.', '...X...X...', '...XXXXX...'],
  sun: ['.....X.....', '.X...X...X.', '..X.....X..', '....XXX....', '...XXXXX...', 'XX.XXXXX.XX', '...XXXXX...', '....XXX....', '..X.....X..', '.X...X...X.', '.....X.....'],
  moon: ['...XXXXX...', '..XXX......', '.XXX.......', '.XXX.......', 'XXXX.......', 'XXXX.......', 'XXXX.......', '.XXX.......', '.XXXX......', '..XXXXXX...', '...XXXXX...'],
  clock: ['...XXXXX...', '..X.....X..', '.X...X...X.', 'X....X....X', 'X....X....X', 'X....XXX..X', 'X.........X', 'X.........X', '.X.......X.', '..X.....X..', '...XXXXX...'],
};

const GROUND_H = 6;
const BUCKET_H = 14;

// ---------- Cielo: colori e posizione di sole/luna in base all'ora ----------
const SKY_N = 14;
const SKY_NIGHT = { top: [11, 16, 32], bot: [40, 70, 128] };
const SKY_DAY = { top: [72, 148, 232], bot: [192, 228, 252] };
const SKY_TWI = { top: [74, 54, 122], bot: [255, 153, 92] };
const mixC = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const rgbStr = (c) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;

function skyBands(d, twi) {
  return Array.from({ length: SKY_N }, (_, i) => {
    const k = i / (SKY_N - 1);
    const night = mixC(SKY_NIGHT.top, SKY_NIGHT.bot, k);
    const day = mixC(SKY_DAY.top, SKY_DAY.bot, k);
    const tw = mixC(SKY_TWI.top, SKY_TWI.bot, k);
    return rgbStr(mixC(mixC(night, day, d), tw, twi * 0.75));
  });
}

// Alba e tramonto calcolati per Sarno (SA) a partire dalla data e dal fuso del dispositivo
function sunTimes(date) {
  const rad = Math.PI / 180;
  const lat = 40.8 * rad;
  const lon = 14.6;
  const start = new Date(date.getFullYear(), 0, 0);
  const n = Math.floor((date - start) / 86400000);
  const decl = 23.44 * rad * Math.sin((2 * Math.PI * (284 + n)) / 365);
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl));
  const H = Math.acos(clamp(cosH, -1, 1)) / rad / 15; // ore tra mezzogiorno solare e tramonto
  const B = (2 * Math.PI * (n - 81)) / 364;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // equazione del tempo (minuti)
  const noon = 12 - lon / 15 - eot / 60 - date.getTimezoneOffset() / 60;
  return { rise: noon - H, set: noon + H };
}

// d: 0 notte … 1 giorno; twi: 1 ad alba/tramonto; sunP: 0 alba … 1 tramonto; moonQ: 0 tramonto … 1 alba
function skyAt(date) {
  const h = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const { rise, set } = sunTimes(date);
  const w = 0.4; // circa mezz'ora di crepuscolo attorno ad alba e tramonto
  const d = Math.min(smooth((h - (rise - w)) / (2 * w)), smooth((set + w - h) / (2 * w)));
  const twi = 1 - Math.abs(2 * d - 1);
  const dayLen = set - rise;
  const sunP = clamp((h - rise) / dayLen, -0.06, 1.06);
  const hs = h >= set ? h - set : h + 24 - set;
  const moonQ = clamp(hs / (24 - dayLen), 0, 1);
  return { d, twi, sunP, moonQ };
}
const SKY_FIXED_DAY = { d: 1, twi: 0, sunP: 0.62, moonQ: 0.4 };
const SKY_FIXED_NIGHT = { d: 0, twi: 0, sunP: 0.62, moonQ: 0.4 };

// ---------- Vibrazione ----------
// Priorità: 1 = segnali di contorno, 2 = eventi di gioco, 3 = eventi forti. Un segnale
// di priorità minore non interrompe uno più forte ancora in corso.
let hapUntil = 0;
let hapPrio = 0;
function vib(pattern, prio = 2) {
  if (!effHaptics() || !hapticsSupported()) return;
  const now = performance.now();
  if (prio < hapPrio && now < hapUntil) return;
  const arr = Array.isArray(pattern) ? pattern : [pattern];
  const norm = arr.map((ms, i) => (i % 2 === 0 && ms > 0 ? Math.max(ms, 15) : ms)); // sotto ~15 ms il motorino non parte
  try {
    navigator.vibrate(norm);
  } catch (_) {
    /* vibrazione non disponibile: nessun problema */
  }
  hapUntil = now + norm.reduce((a, b) => a + b, 0);
  hapPrio = prio;
}
function vibStop() {
  try {
    if (hapticsSupported()) navigator.vibrate(0);
  } catch (_) {
    /* niente da fermare */
  }
  hapUntil = 0;
  hapPrio = 0;
}
// Rampa: impulsi sempre più lunghi e pause sempre più corte per `total` ms
function rampPattern(total, p0, p1, g0, g1) {
  const out = [];
  let t = 0;
  for (let i = 0; t < total; i++) {
    const k = clamp(t / total, 0, 1);
    const p = Math.round(p0 + (p1 - p0) * k);
    const gp = Math.round(g0 + (g1 - g0) * k);
    out.push(p, gp);
    t += p + gp;
  }
  return out;
}

// Vocabolario aptico del minigioco
const HAP = {
  tremor: rampPattern(550, 15, 24, 95, 55), // fa "tremare" il telefono insieme allo schermo
  crack1: [45, 25, 20, 40, ...rampPattern(280, 24, 32, 45, 25)], // colpo secco + tremore più fitto
  crack2: [70, 25, 40, 25, ...rampPattern(270, 32, 40, 22, 12)], // colpo più forte + tremore quasi continuo
  shatter: [160, 35, 100, 35, 70, 35, 40], // esplosione di vetri
  abort: [15], // pressione rilasciata prima del tempo: la tensione scende
  launch: [20, 40, 20, 40, 30], // il gioco "si accende"
  pause: [18],
  resume: [18],
  on: [15, 40, 26],
  off: [26],
  day: [15, 45, 22, 45, 30], // impulsi che crescono: sale il sole
  night: [30, 45, 22, 45, 15], // impulsi che calano: scende la sera
  auto: [15, 70, 15], // tic-tac dell'orologio
  coil: [18, 30, 18, 30, 40],
  magnet: [15, 25, 20, 25, 28, 25, 36],
  magnetPull: [15],
  wrench: [20, 40, 20, 40, 35], // tre giri di cricchetto
  stop: [60, 45, 30],
  stopEnd: [20],
  magnetEnd: [15],
  rust: [70, 40, 70],
  oil: [18, 30, 18, 30, 18, 30, 18, 30, 18], // onda viscida
  oilEnd: [15],
  spark: [15, 10, 15, 10, 15, 10, 15, 10, 15, 10, 15, 10, 40], // crepitio dell'arco
  sparkEnd: [15],
  dodge: [15],
  bonusMiss: [15],
  spawnBonus: [15],
  spawnMalus: [15, 50, 15],
  level: [20, 40, 20, 40, 35],
  miss: 35,
  over: 120,
  tap: [15],
  back: [15, 25, 15], // si torna indietro: doppio tocco leggero
  record: [30, 40, 30, 40, 30, 40, 90], // nuovo high score: tre colpi che salgono e uno lungo
  saved: [20, 40, 45], // nome registrato: il "timbro"
  denied: [30, 40, 30], // nome vuoto
  key: [15], // lettera digitata
  keyFull: [15, 40, 15], // nome al massimo o carattere non valido
};

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

// Un solo AudioContext condiviso: lo usano sia la sequenza di rottura sia il gioco.
// Va creato/ripreso dentro un gesto dell'utente (la pressione sul tasto) per le policy autoplay.
let graph = null;
function getGraph() {
  if (graph) {
    if (graph.ctx.state !== 'running') graph.ctx.resume().catch(() => {});
    graph.syncMaster();
    return graph;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  let ctx;
  try {
    ctx = new AC();
  } catch (_) {
    return null;
  }
  const master = ctx.createGain();
  master.gain.value = effSound() ? 0.7 : 0;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp);
  comp.connect(ctx.destination);
  const musicBus = ctx.createGain();
  musicBus.gain.value = 0.5;
  musicBus.connect(master);
  const sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.9;
  sfxBus.connect(master);

  // Rumore bianco (per hi-hat, rullante, clangore, vetri)
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

  function noise(bus, t, { dur = 0.05, vol = 0.1, kind = 'highpass', freq = 6000, freq2 = null }) {
    const s = ctx.createBufferSource();
    s.buffer = nbuf;
    const fl = ctx.createBiquadFilter();
    fl.type = kind;
    fl.frequency.setValueAtTime(freq, t);
    if (freq2) fl.frequency.exponentialRampToValueAtTime(freq2, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl);
    fl.connect(g);
    g.connect(bus);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.03);
  }

  graph = {
    ctx,
    master,
    musicBus,
    sfxBus,
    nbuf,
    pulse,
    tone,
    noise,
    syncMaster() {
      master.gain.setTargetAtTime(effSound() ? 0.7 : 0, ctx.currentTime, 0.015);
    },
    // Mette in pausa il motore audio quando non serve (risparmia batteria)
    idle() {
      if (ctx.state === 'running') ctx.suspend().catch(() => {});
    },
  };
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return graph;
}

// ---------- Suoni della sequenza "lo schermo si rompe" ----------
const fxSound = {
  // Rombo sordo che sale mentre lo schermo trema. Restituisce { stop() }.
  rumble() {
    const G = getGraph();
    if (!G || !effSound()) return null;
    const { ctx } = G;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = G.nbuf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(80, t);
    lp.frequency.exponentialRampToValueAtTime(340, t + 1.3);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.55, t + 1.3);
    src.connect(lp);
    lp.connect(ng);
    ng.connect(G.sfxBus);
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(34, t);
    sub.frequency.exponentialRampToValueAtTime(74, t + 1.3);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.35, t + 1.3);
    sub.connect(sg);
    sg.connect(G.sfxBus);
    src.start(t, Math.random() * 0.5);
    sub.start(t);
    return {
      stop(fade = 0.06) {
        const n = ctx.currentTime;
        try {
          ng.gain.cancelScheduledValues(n);
          sg.gain.cancelScheduledValues(n);
          ng.gain.setTargetAtTime(0.0001, n, fade / 3);
          sg.gain.setTargetAtTime(0.0001, n, fade / 3);
          src.stop(n + fade + 0.1);
          sub.stop(n + fade + 0.1);
        } catch (_) {
          /* già fermato */
        }
      },
    };
  },
  // Crepa nel vetro: schiocco secco; la seconda è più grave e più forte
  crack(n) {
    const G = getGraph();
    if (!G || !effSound()) return;
    const t = G.ctx.currentTime;
    G.noise(G.sfxBus, t, { dur: 0.05, vol: 0.34, kind: 'highpass', freq: 2400 + n * 1300 });
    G.noise(G.sfxBus, t + 0.03, { dur: 0.03, vol: 0.2, kind: 'bandpass', freq: 5200 });
    G.tone(G.sfxBus, t, { type: 'triangle', f: 1100, f2: 180, dur: 0.09, vol: 0.2 });
    if (n >= 2) G.tone(G.sfxBus, t, { type: 'sine', f: 120, f2: 50, dur: 0.18, vol: 0.32 });
  },
  // Vetro che esplode: colpo grave + sventagliata di rumore + tintinnii
  shatter() {
    const G = getGraph();
    if (!G || !effSound()) return;
    const t = G.ctx.currentTime;
    G.tone(G.sfxBus, t, { type: 'sine', f: 130, f2: 38, dur: 0.34, vol: 0.45 });
    G.noise(G.sfxBus, t, { dur: 0.28, vol: 0.36, kind: 'highpass', freq: 3000 });
    G.noise(G.sfxBus, t, { dur: 0.55, vol: 0.2, kind: 'bandpass', freq: 3200, freq2: 600 });
    for (let i = 0; i < 16; i++) {
      const at = t + 0.02 + Math.random() * 0.65;
      G.tone(G.sfxBus, at, { type: 'sine', f: 2000 + Math.random() * 4800, dur: 0.06 + Math.random() * 0.09, vol: 0.03 + Math.random() * 0.045 });
    }
  },
  // Il gioco si accende: arpeggio chiptune ascendente
  boot() {
    const G = getGraph();
    if (!G || !effSound()) return;
    const t = G.ctx.currentTime + 0.3;
    [60, 64, 67, 72, 76, 79].forEach((n, k) => G.tone(G.sfxBus, t + k * 0.06, { type: 'square', f: mtof(n), dur: 0.09, vol: 0.12 }));
    G.tone(G.sfxBus, t + 0.4, { type: 'square', f: mtof(84), dur: 0.22, vol: 0.12 });
    G.tone(G.sfxBus, t + 0.4, { wave: G.pulse, f: mtof(72), dur: 0.22, vol: 0.09 });
  },
  // Pressione rilasciata prima del tempo: la tensione si scarica
  abort() {
    const G = getGraph();
    if (!G || !effSound()) return;
    const t = G.ctx.currentTime;
    G.tone(G.sfxBus, t, { type: 'sine', f: 260, f2: 90, dur: 0.18, vol: 0.12 });
    G.noise(G.sfxBus, t, { dur: 0.06, vol: 0.08, kind: 'bandpass', freq: 3600 });
  },
};

// ---------- Geometria dei frammenti ----------
function clipRect(poly, x0, y0, x1, y1) {
  const run = (pts, inside, cross) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ia = inside(a);
      const ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cross(a, b));
    }
    return out;
  };
  let p = poly;
  p = run(p, (q) => q[0] >= x0, (a, b) => [x0, a[1] + ((x0 - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]);
  if (!p.length) return p;
  p = run(p, (q) => q[0] <= x1, (a, b) => [x1, a[1] + ((x1 - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]);
  if (!p.length) return p;
  p = run(p, (q) => q[1] >= y0, (a, b) => [a[0] + ((y0 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y0]);
  if (!p.length) return p;
  p = run(p, (q) => q[1] <= y1, (a, b) => [a[0] + ((y1 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y1]);
  return p;
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return Math.abs(a) / 2;
}

function exitDist(ox, oy, a, vw, vh) {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const tx = dx > 1e-6 ? (vw - ox) / dx : dx < -1e-6 ? -ox / dx : Infinity;
  const ty = dy > 1e-6 ? (vh - oy) / dy : dy < -1e-6 ? -oy / dy : Infinity;
  return Math.max(0, Math.min(tx, ty));
}

// Raggiera di crepe attorno al punto d'impatto (ox, oy): settori divisi da anelli irregolari
function makeGeometry(ox, oy, vw, vh, bands) {
  const diag = Math.hypot(vw, vh);
  const S = 9;
  const a0 = Math.random() * Math.PI * 2;
  const angles = Array.from({ length: S }, (_, j) => a0 + ((j + (Math.random() - 0.5) * 0.55) / S) * Math.PI * 2);
  const radii = [0.13, 0.3, 0.55].slice(0, bands - 1).map((r) => r * diag);
  radii.push(diag * 2.2);
  const V = radii.map((r, i) =>
    angles.map((a) => {
      const k = i === radii.length - 1 ? 1 : 0.85 + Math.random() * 0.3;
      return [ox + Math.cos(a) * r * k, oy + Math.sin(a) * r * k];
    })
  );
  const cells = [];
  for (let j = 0; j < S; j++) {
    const j2 = (j + 1) % S;
    const raw = [[[ox, oy], V[0][j], V[0][j2]]];
    for (let i = 0; i < radii.length - 1; i++) raw.push([V[i][j], V[i][j2], V[i + 1][j2], V[i + 1][j]]);
    for (const poly of raw) {
      const c = clipRect(poly, 0, 0, vw, vh);
      if (c.length >= 3 && polyArea(c) > 120) cells.push(c);
    }
  }
  return { cells, V, angles, radii, S };
}

// Copia "leggera" della pagina per i frammenti: via script e simili, svuotato ciò che è fuori
// schermo o nascosto (stesso ingombro, nessun contenuto) così il numero di nodi resta basso.
function prune(orig, copy, vw, vh) {
  let o = orig.firstElementChild;
  let c = copy.firstElementChild;
  while (o && c) {
    const nextO = o.nextElementSibling;
    const nextC = c.nextElementSibling;
    const tag = o.tagName;
    if (tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'IFRAME' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'TEMPLATE' || o.classList.contains('mg-fx')) {
      c.remove();
    } else if (getComputedStyle(o).display === 'none') {
      c.textContent = '';
    } else {
      const r = o.getBoundingClientRect();
      const off = r.width > 0 && r.height > 0 && (r.bottom < -40 || r.top > vh + 40 || r.right < -40 || r.left > vw + 40);
      if (off && o.firstElementChild) {
        c.textContent = '';
        c.style.width = `${r.width}px`;
        c.style.height = `${r.height}px`;
        c.style.boxSizing = 'border-box';
        c.style.overflow = 'hidden';
      } else {
        prune(o, c, vw, vh);
      }
    }
    o = nextO;
    c = nextC;
  }
}

// ---------- Sequenza: tremolio → crepe → frantumazione ----------
// Una copia della pagina corrente (divisa in frammenti ritagliati) copre lo schermo, trema
// sempre più forte e si crepa; allo scadere dei 5 secondi i frammenti cadono e lasciano
// vedere il gioco che compare sotto. Se la pagina è troppo pesante per essere copiata,
// i frammenti sono semplici lastre di vetro semitrasparente sopra la pagina.
function createBreakFx(ox, oy, holdStart) {
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let box = null;
  let cv = null;
  let cx = null;
  let raf = 0;
  let alive = true;
  let built = false;
  let broken = false;
  let vw = 0;
  let vh = 0;
  let rumble = null;
  let dirty = false;
  const shards = [];
  const segs = [];
  const stageT = [null, null, null];
  const stageP = [0, 0, 0];
  const stageMax = [1, 1, 1];

  function build() {
    if (built) return;
    built = true;
    vw = document.documentElement.clientWidth || window.innerWidth;
    vh = window.innerHeight;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    // Istantanea della pagina
    let snap = null;
    let nodes = 0;
    try {
      snap = document.body.cloneNode(true);
      prune(document.body, snap, vw, vh);
      nodes = snap.getElementsByTagName('*').length;
    } catch (_) {
      snap = null;
    }

    // Quanti frammenti: meno se la pagina è pesante
    let geo = null;
    for (let bands = 4; bands >= 2; bands--) {
      geo = makeGeometry(ox, oy, vw, vh, bands);
      if (!snap || nodes * geo.cells.length <= SHARD_NODE_BUDGET || bands === 2) break;
    }
    if (snap && nodes * geo.cells.length > SHARD_NODE_LIMIT) snap = null;

    let pageBg = getComputedStyle(document.body).backgroundColor;
    if (!pageBg || pageBg === 'transparent' || pageBg === 'rgba(0, 0, 0, 0)') pageBg = getComputedStyle(document.documentElement).backgroundColor;
    if (!pageBg || pageBg === 'transparent' || pageBg === 'rgba(0, 0, 0, 0)') pageBg = '#ffffff';

    box = mk('div', { position: 'fixed', inset: '0', zIndex: '210', pointerEvents: 'none', overflow: 'hidden', willChange: 'transform', userSelect: 'none', webkitUserSelect: 'none' });
    box.className = 'mg-fx';
    box.setAttribute('aria-hidden', 'true');
    box.setAttribute('inert', '');

    for (const poly of geo.cells) {
      const xs = poly.map((p) => p[0]);
      const ys = poly.map((p) => p[1]);
      const bx = Math.floor(Math.min(...xs));
      const by = Math.floor(Math.min(...ys));
      const bw = Math.ceil(Math.max(...xs)) - bx + 1;
      const bh = Math.ceil(Math.max(...ys)) - by + 1;
      const el = mk('div', { position: 'absolute', left: `${bx}px`, top: `${by}px`, width: `${bw}px`, height: `${bh}px` });
      const inner = mk('div', { position: 'absolute', inset: '0', overflow: 'hidden' });
      const clip = `polygon(${poly.map((p) => `${(p[0] - bx).toFixed(1)}px ${(p[1] - by).toFixed(1)}px`).join(',')})`;
      inner.style.clipPath = clip;
      inner.style.webkitClipPath = clip;
      if (snap) {
        const page = mk('div', { position: 'absolute', left: `${-bx}px`, top: `${-by}px`, width: `${vw}px`, height: `${vh}px`, overflow: 'hidden', background: pageBg });
        page.style.contain = 'layout paint'; // fa da riferimento anche per gli elementi position:fixed della copia
        const scroller = mk('div', { position: 'absolute', left: '0', top: `${-scrollY}px`, width: `${vw}px` });
        scroller.append(snap.cloneNode(true));
        page.append(scroller);
        inner.append(page);
      } else {
        inner.style.background = 'linear-gradient(135deg, rgba(255,255,255,.34), rgba(160,200,255,.10) 55%, rgba(255,255,255,.24))';
      }
      el.append(inner);
      box.append(el);
      const cxm = poly.reduce((s, p) => s + p[0], 0) / poly.length;
      const cym = poly.reduce((s, p) => s + p[1], 0) / poly.length;
      shards.push({ el, cx: cxm, cy: cym, lx: cxm - bx, ly: cym - by });
    }

    // Tela delle crepe
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv = mk('canvas', { position: 'absolute', left: '0', top: '0', width: `${vw}px`, height: `${vh}px` });
    cv.width = Math.round(vw * dpr);
    cv.height = Math.round(vh * dpr);
    cx = cv.getContext('2d');
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    box.append(cv);
    document.body.append(box);

    // Segmenti delle crepe (raggi, cerchi irregolari e piccole ramificazioni)
    const diag = Math.hypot(vw, vh);
    const last = geo.radii.length - 1;
    const stageOf = (i) => (i < Math.ceil((last + 1) / 2) ? 1 : 2);
    const addSeg = (A, B, s) => {
      let d0 = Math.hypot(A[0] - ox, A[1] - oy);
      let d1 = Math.hypot(B[0] - ox, B[1] - oy);
      let a = A;
      let b = B;
      if (d1 < d0) {
        [a, b] = [b, a];
        [d0, d1] = [d1, d0];
      }
      segs.push({ a, b, d0, d1, s });
      stageMax[s] = Math.max(stageMax[s], d1);
    };
    for (let j = 0; j < geo.S; j++) {
      const ang = geo.angles[j];
      const j2 = (j + 1) % geo.S;
      for (let i = 0; i <= last; i++) {
        const A = i === 0 ? [ox, oy] : geo.V[i - 1][j];
        let B = geo.V[i][j];
        if (i === last) {
          const e = exitDist(ox, oy, ang, vw, vh);
          if (e <= Math.hypot(A[0] - ox, A[1] - oy)) continue;
          B = [ox + Math.cos(ang) * e, oy + Math.sin(ang) * e];
        }
        addSeg(A, B, stageOf(i));
        if (Math.random() < 0.75) {
          const t = 0.3 + Math.random() * 0.5;
          const q = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
          const ba = ang + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.4);
          const len = diag * (0.03 + Math.random() * 0.04);
          addSeg(q, [q[0] + Math.cos(ba) * len, q[1] + Math.sin(ba) * len], stageOf(i));
        }
        if (i < last) addSeg(geo.V[i][j], geo.V[i][j2], stageOf(i));
      }
    }
    dirty = true;
  }

  function drawCracks() {
    cx.clearRect(0, 0, vw, vh);
    const lines = [];
    for (const s of [1, 2]) {
      const p = stageP[s];
      if (p <= 0) continue;
      const front = (1 - Math.pow(1 - p, 2)) * stageMax[s];
      for (const sg of segs) {
        if (sg.s !== s) continue;
        const f = clamp((front - sg.d0) / Math.max(1, sg.d1 - sg.d0), 0, 1);
        if (f <= 0) continue;
        lines.push([sg.a[0], sg.a[1], sg.a[0] + (sg.b[0] - sg.a[0]) * f, sg.a[1] + (sg.b[1] - sg.a[1]) * f]);
      }
    }
    const stroke = (w, color, off) => {
      cx.lineWidth = w;
      cx.strokeStyle = color;
      cx.lineCap = 'round';
      cx.beginPath();
      for (const l of lines) {
        cx.moveTo(l[0] + off, l[1] + off);
        cx.lineTo(l[2] + off, l[3] + off);
      }
      cx.stroke();
    };
    stroke(3.2, 'rgba(0,0,0,.35)', 0.8); // ombra: fa risaltare la crepa su qualsiasi sfondo
    stroke(1.5, 'rgba(255,255,255,.95)', 0);
    stroke(0.7, 'rgba(150,210,255,.9)', -0.8); // riflesso azzurrino del vetro
    if (stageP[1] > 0) {
      // punto d'impatto
      const g = cx.createRadialGradient(ox, oy, 0, ox, oy, 26);
      g.addColorStop(0, 'rgba(255,255,255,.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      cx.fillStyle = g;
      cx.beginPath();
      cx.arc(ox, oy, 26, 0, Math.PI * 2);
      cx.fill();
    }
  }

  function loop() {
    if (!alive || broken) return;
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    const e = clamp((now - holdStart - FX_TREMOR_MS) / (HOLD_MS - FX_TREMOR_MS), 0, 1);
    const amp = (0.8 + 6.7 * e * e) * (reduce ? 0.3 : 1);
    const dx = (Math.random() * 2 - 1) * amp;
    const dy = (Math.random() * 2 - 1) * amp;
    const rot = reduce ? 0 : (Math.random() * 2 - 1) * amp * 0.045;
    box.style.transform = `translate3d(${dx.toFixed(2)}px,${dy.toFixed(2)}px,0) rotate(${rot.toFixed(3)}deg) scale(${(1 + amp * 0.0032).toFixed(4)})`;
    for (const s of [1, 2]) {
      if (stageT[s] == null) continue;
      const p = clamp((now - stageT[s]) / 260, 0, 1);
      if (p !== stageP[s]) {
        stageP[s] = p;
        dirty = true;
      }
    }
    if (dirty) {
      drawCracks();
      dirty = (stageT[1] != null && stageP[1] < 1) || (stageT[2] != null && stageP[2] < 1);
    }
  }

  function dispose() {
    alive = false;
    cancelAnimationFrame(raf);
    if (box) box.remove();
    box = null;
  }

  return {
    // Inizia a tremare: rombo sordo + vibrazione a impulsi crescenti
    tremor() {
      if (!alive) return;
      build();
      rumble = fxSound.rumble();
      vib(HAP.tremor, 3);
      raf = requestAnimationFrame(loop);
    },
    // n = 1 prima crepa, n = 2 seconda crepa (più estesa): schiocco + colpo di vibrazione
    crack(n) {
      if (!alive || !built) return;
      stageT[n] = performance.now();
      dirty = true;
      fxSound.crack(n);
      vib(n === 1 ? HAP.crack1 : HAP.crack2, 3);
    },
    // Rottura: i frammenti volano via dal punto d'impatto e cadono
    shatter() {
      if (!alive) return;
      build();
      broken = true;
      cancelAnimationFrame(raf);
      if (rumble) rumble.stop(0.05);
      rumble = null;
      box.style.transform = 'none';
      const flash = mk('div', { position: 'absolute', inset: '0', background: '#fff', opacity: '0', pointerEvents: 'none' });
      box.append(flash);
      flash.animate([{ opacity: reduce ? 0.3 : 0.75 }, { opacity: 0 }], { duration: 240, easing: 'ease-out' });
      cv.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards' });
      let maxEnd = 0;
      for (const s of shards) {
        const ddx = s.cx - ox;
        const ddy = s.cy - oy;
        const dist = Math.hypot(ddx, ddy) || 1;
        const ux = ddx / dist;
        const uy = ddy / dist;
        const push = 40 + Math.random() * 120;
        const rot = (Math.random() * 2 - 1) * 70;
        const fall = vh * (0.9 + Math.random() * 0.5);
        const delay = Math.min(160, (dist / Math.hypot(vw, vh)) * 260);
        const dur = 700 + Math.random() * 260;
        s.el.style.transformOrigin = `${s.lx}px ${s.ly}px`;
        s.el.animate(
          [
            { transform: 'translate(0px,0px) rotate(0deg)', opacity: 1 },
            { transform: `translate(${(ux * push * 0.4).toFixed(1)}px,${(uy * push * 0.4 - 12).toFixed(1)}px) rotate(${(rot * 0.3).toFixed(1)}deg)`, opacity: 1, offset: 0.3 },
            { transform: `translate(${(ux * push).toFixed(1)}px,${(uy * push + fall).toFixed(1)}px) rotate(${rot.toFixed(1)}deg)`, opacity: 0.6 },
          ],
          { duration: dur, delay, easing: 'cubic-bezier(.4,0,.9,.55)', fill: 'forwards' }
        );
        maxEnd = Math.max(maxEnd, delay + dur);
      }
      fxSound.shatter();
      vib(HAP.shatter, 3);
      setTimeout(dispose, maxEnd + 120);
      return maxEnd;
    },
    // Pressione rilasciata in anticipo: la crepa svanisce e lo schermo torna normale
    cancel() {
      if (!alive || broken) return;
      alive = false;
      cancelAnimationFrame(raf);
      if (rumble) rumble.stop(0.08);
      rumble = null;
      if (built) {
        vibStop();
        fxSound.abort();
        vib(HAP.abort, 3);
        const b = box;
        if (b) {
          b.style.transform = 'none';
          b.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
          setTimeout(() => b.remove(), 260);
        }
      }
    },
  };
}

// ---------- Utilità DOM ----------
function mk(tag, style, text) {
  const el = document.createElement(tag);
  if (style) Object.assign(el.style, style);
  if (text != null) el.textContent = text;
  return el;
}

// Icona a pixel (SVG con quadratini nitidi). Con pal = null i pixel "X" usano il colore del testo.
function svgIcon(rows, pal, px) {
  const ns = 'http://www.w3.org/2000/svg';
  const w = rows[0].length;
  const h = rows.length;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w * px));
  svg.setAttribute('height', String(h * px));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'block';
  svg.style.flex = 'none';
  const byColor = {};
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const col = pal ? pal[ch] : 'currentColor';
      (byColor[col] = byColor[col] || []).push(`M${x} ${y}h1v1h-1z`);
    });
  });
  for (const [col, d] of Object.entries(byColor)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d.join(''));
    p.setAttribute('fill', col);
    svg.append(p);
  }
  return svg;
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
      fontFamily: FONT_UI,
      fontWeight: '700',
      fontSize: '18px',
      textTransform: 'uppercase',
      letterSpacing: '.06em',
      cursor: 'pointer',
    },
    label
  );
}

function mkSwitch(label) {
  const b = mk('button', {
    position: 'relative',
    width: '54px',
    height: '30px',
    borderRadius: '6px',
    border: '2px solid rgba(255,255,255,.4)',
    background: 'transparent',
    cursor: 'pointer',
    padding: '0',
    flex: 'none',
    transition: 'background .15s, border-color .15s',
  });
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-label', label);
  const knob = mk('span', { position: 'absolute', top: '3px', left: '3px', width: '20px', height: '20px', borderRadius: '3px', background: '#fff', transition: 'transform .15s, background .15s' });
  b.append(knob);
  b.set = (on) => {
    b.setAttribute('aria-checked', String(on));
    b.style.background = on ? '#f4cf55' : 'transparent';
    b.style.borderColor = on ? '#f4cf55' : 'rgba(255,255,255,.4)';
    knob.style.transform = on ? 'translateX(24px)' : 'none';
    knob.style.background = on ? '#1a1a2e' : '#fff';
  };
  return b;
}

// ---------- Personaggio della home (sprite 51×99 disegnato dall'utente) ----------
// Camminata e controllo dell'orologio si ottengono rimontando le parti dello
// sprite (gambe, avambraccio, testa): nessuna immagine esterna.
const CHAR_ROWS = [
  '.....................abbabaabb.....................',
  '...................bbcccccccccdd...................',
  '.................adcccccccccccccda.................',
  '................bcceccffcffccccccca................',
  '...............dccghhhgggffgggggcccd...............',
  '..............dccgiijjjjiiiijjjjhgcca..............',
  '..............dcgiijjjkkkkkkkkjjjigca..............',
  '.............bceiijjjkkkkkkkkkkjjjigcb.............',
  '.............bcfiijjjkkkkkkkkkkjjjihcb.............',
  '.............acfiijjjkkkkkkkkkkjjjihca.............',
  '.............dffhijjjjjkkkkkkkkjjjigga.............',
  '.............dffgijjkkkkkkkkkkkjjjhggd.............',
  '.............dfggijkkkkkkkkkkkkkjjhcfd.............',
  '.............degiihgclmkkkjkkhclgjihcd.............',
  '.............dchhglclldgijjjgdddddhhcd.............',
  '.............bchhiihgghhhjjhiggmmihhcd.............',
  '............hlnkkhgmcoghihhjgmlmghkjglm............',
  '............highkiihijihhkjkiiiihijigih............',
  '............hhghijjjjjikhkjhjiiiijkhggh............',
  '............ljghikkjjjjiikiiijjjkkjighg............',
  '............lighijiiiijhjkjhjiiiijjhgjg............',
  '.............hhgijkkkkjijkkiikkkkkihhh.............',
  '.............djgijjkkkjgikigjkkkkjihjd.............',
  '.............ajghijkkjjihhhijjkkkjihjd.............',
  '..............aghijkkiiiihiiiikkkjild..............',
  '...............ahijkjiiijhjjijikkjhd...............',
  '...............ahiikiiiggigggjjkjjhd...............',
  '...............dfijkjjihiiihijjkijhd...............',
  '................dhjjjjjihhhijjijiilp...............',
  '...............dagijijjjjjjjjjiiigdd...............',
  '.............ddbmdfihijjkkkjkjihglqbdd.............',
  '...........ddmqnoqlfgijkkkkkjihhdmqmqqdb...........',
  '..........dqqpnqpqqaggijjkkjiggdmopqnpqmd..........',
  '........ddmrrrnprpmdbdffhhhhgdadmpppnsppqdb........',
  '.......dmqrtttnprppmdgddaaaadgdqpprpnsrrromb.......',
  '......dmpqrttrnruppqchgggggghglqrpprnprrpopma......',
  '......dqtqtuurnmnnnpolghhhhhhlopnnnmnstrrorqb......',
  '.....aqrttqrtrqqqqmnuqlgggggcornmqqqqsrrqprpmd.....',
  '.....aorttqrtrrtppqqnunooppmm.nqqpppprrpqprrpd.....',
  '.....aptutqputrrrrsqqn.nooofunqqpprsrtrpqsrrrd.....',
  '....ampttttqrtrrrrttqqn.nof.nqqppppsrtrqprrrrqd....',
  '....aprttrrmqrpprspp.tqmnnpmqp.ukjk.prompprrrpd....',
  '....artrqpqmqpqqqqqqqtpoqnnqprqhjjjimromqpqrrrb....',
  '...bqrtrrqqfqmrppprruqpoqnmprqnnnnnnmqonqqrrtrqb...',
  '...bqrrrrqqfqmossrrtoqprnnqurqnfffffnqonqqtrrrqb...',
  '...bptrrrqmdqmmmmmmmqqppnoqurqqmhjkiqmqdmqtrrrrb...',
  '...drsrrrqmdompppppppqrrntqurqt.ojjppmqbmqrtrrrb...',
  '..dqrrrrrqmdompprrrrrqrrnpqurqrooooopmqbmortrrrmd..',
  '..aouttrrqmdqmpprrrrrqrrnpqttqtooooopmqbmqrrrrrod..',
  '..bptrrroqmdqmprprrrrqrrnrqutqroooooumqbmqosrttpd..',
  '..bptqqoomdmqmoprrrroqrrnpqtrqouttttqmqmbmqqqorud..',
  '.aaptrpmmmdoopqqqqqqqprrnpqtrrqqqqqqqsoobmmmtrrudb.',
  '.dqrtqooomdqotttrrppprtrnsqrrrppppppsrqqbmooqqrpqb.',
  '.dqrtttqqmdoouttrrrrrrrrnpqtrrrrrrprttqobmmmprtpqb.',
  '.aqrrrrpqmdootqrrrrrttrpnsqrtrrtrrrtqtqqbmqptttpqb.',
  '.a.rrrrrqbboouqrrrrrttrrnsqtttttrrrtqtqodbqrtttttb.',
  '.burrrrrqbbooqpqprrrrrrpnsqrtrrrrrrorqqoabqrtrrrrb.',
  '.brrrrrpqbbdmmppqprsrrrpnpqrrrrrrroprqndbbqrrtrtrd.',
  'amrrrrrpqbbbqqmmmqorppppmpqpppppqqqmmmqabbqrprrrrqb',
  'bqrpprpqqb.dqqpppmmmmmmmmmqqqqqqqmmttoqb.aqqpprprqd',
  'dmmmmmmnnb.adqopppppppprmtqpppstprptqqda.dnnmmmmmmb',
  'dmppr.oqma.dcldddrprppprmpopprrrrpdddllb.dqqqppppqb',
  'dppddaddbabceclceldddllldllllddllleclcccbadadaalppb',
  'dqdhikkigabeelcvveeeeeeeleeceeeeeevveleebahikkjhcmd',
  '.dhkkkkkiabcelvvvvvvvvvvcvvevvvvvvvvvlceaaikkkkkhb.',
  '.akkkkijjhbllvvvvvevvvvvcvvevvvvevvvvvllahkkikkkka.',
  '.akkkkigjhblvvvvvvccevvvceeevveeevvvvvvlaikgikkkka.',
  '.aikkkidghaeevvvvvvveleeclleelevvvvvvveeaihdikkkia.',
  '.agihkjhaabeevvvvvvvvelllllllevvvvvvvveebaagkkhjga.',
  '..aahhihhabeevvvvvvelllddbbbllccvvvvvveebahhighaa..',
  '....abaab.aeevvvvvvvveclbbbllevvvvvvvveeb.aaabb....',
  '..........aeevvvvvvvvvelbbblcvvvvvvvvveeb..........',
  '..........bevvvvvvvvvvelbablevvvvvvvvvveb..........',
  '..........bevvvvvvvvvvelb.blevvvvvvvvvveb..........',
  '..........bevvvvvvvvveelb.bleevvvvvvvvveb..........',
  '..........aevvvvvvvvveelb.bleevvvvvvvvveb..........',
  '..........bevvvvvvvvveelb.bleevvvvvvvvvcb..........',
  '..........aeevvvvvvveeelb.bleeevvvvvvveed..........',
  '..........alcvvvvvveeella.blleeevvvvvveld..........',
  '...........alevvvveeeelb...bleeeevvvvelb...........',
  '...........alleeeeeeellb...alleeeeeeellb...........',
  '...........dcllleeeeellb...bleeeeeelllea...........',
  '...........dceeeeevvcclb...bllevveeeeeeb...........',
  '...........deeeeevvveclb...bleevvveeeeeb...........',
  '...........deevvvveeellb...bleeeevvvveeb...........',
  '...........devvvvveeellb...aleeeevvvvveb...........',
  '..........ddeeeeevveeelb...bleeevveeeeedb..........',
  '..........adlllllleeeelb...bleeecllllclda..........',
  '..........aeevvvvecllelb...blelllevvvveed..........',
  '..........bevvvvvvvecllb...bllcvvvvvvvved..........',
  '..........bcdddddvveeelb...bleeevvdddddcd..........',
  '...........dgggggdbdeelb...blccdddgggggd...........',
  '..........ddgghgigggdab.....daagggighggda..........',
  '........ddahhhgighhhhgb.....dgghhhgjghhhadd........',
  '.......aajjjjiighhhhhgb.....aggghhhgijjjjjda.......',
  '.......ahhjjjjhhhhggggb.....agggghhhhjjjjiha.......',
  '.......dghhhhhhggggcgab.....aagcgggghhhhhhha.......',
  '.......aggggggggggaab.........aaagggggggggga.......',
  '.......abaaaaaaaaa...............aaaaaaaaaaa.......',
];
const CHAR_PAL = { a: '#060305', b: '#020205', c: '#1f2137', d: '#08070b', e: '#222742', f: '#454056', g: '#533030', h: '#9a5d48', i: '#b17a65', j: '#e19771', k: '#f6b189', l: '#111427', m: '#a1938d', n: '#465067', o: '#c1c8cc', p: '#e8f1f4', q: '#acb5bb', r: '#e9f3f5', s: '#e8f3f5', t: '#e9f4f5', u: '#edf5f7', v: '#344366', W: '#fff6c8', G: '#f4cf55', D: '#2b2f3a', Y: '#ffffff' };
const CHAR_W = 51;
const CHAR_H = 99;

const charGrid = () => CHAR_ROWS.map((r) => r.split(''));
const charBlank = () => Array.from({ length: CHAR_H }, () => Array(CHAR_W).fill('.'));

// Costruisce un fotogramma. p: lift (-1/0/1 gamba alzata), armL/armR (-1/0/1 oscillazione mano), watch (0/1 avambraccio alzato), head (0/1 testa inclinata)
function buildCharFrame(p) {
  const S = charGrid();
  const out = charBlank();
  const put = (x, y, c) => {
    if (c !== '.' && x >= 0 && x < CHAR_W && y >= 0 && y < CHAR_H) out[y][x] = c;
  };

  // Gambe (righe 72–98): la gamba \"alzata\" perde due righe a metà polpaccio e il piede sale
  const LEG_TOP = 72;
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? 0 : 26;
    const x1 = side < 0 ? 25 : CHAR_W - 1;
    const lifted = p.lift === side;
    for (let y = LEG_TOP; y < CHAR_H; y++) {
      const dy = lifted && y >= 82 ? -2 : 0;
      for (let x = x0; x <= x1; x++) put(x, y + dy, S[y][x]);
    }
  }

  // Busto: righe 0–71. Testa (righe 0–31) più in basso di un pixel quando guarda l'orologio
  const ARM_Y = 58;
  const inArm = (x, y) => y >= ARM_Y && (x <= 9 || x >= 41);
  for (let y = 0; y < LEG_TOP; y++) {
    for (let x = 0; x < CHAR_W; x++) {
      if (inArm(x, y)) continue;
      if (p.watch && y >= 52 && x >= 41) continue; // l'avambraccio destro viene ridisegnato sotto
      if (p.head && y < 32) continue;
      put(x, y, S[y][x]);
    }
  }
  if (p.head) {
    for (let y = 1; y < 33; y++) for (let x = 0; x < CHAR_W; x++) put(x, y, S[y - 1][x]); // la testa scende di un pixel
    for (let x = 0; x < CHAR_W; x++) if (out[32][x] === '.') put(x, 32, S[32][x]); // il collo resta unito al busto
  }

  // Braccia che oscillano (la sinistra dello sprite è sempre libera; la destra solo se non guarda l'orologio)
  const swing = (x0, x1, dy) => {
    for (let y = ARM_Y; y <= 72; y++) {
      const sy = Math.min(71, Math.max(ARM_Y, y - dy));
      for (let x = x0; x <= x1; x++) put(x, y, S[sy][x]);
    }
  };
  swing(0, 9, p.armL || 0);
  if (!p.watch) swing(41, 50, p.armR || 0);

  // Avambraccio destro alzato: la porzione righe 52–71, colonne 41–50 ruota di 90° e va in orizzontale sul petto
  if (p.watch) {
    const w = 10;
    const h = 20;
    const X1 = 50; // bordo destro (gomito)
    const Y0 = 46; // bordo alto
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const c = S[52 + v][41 + u];
        put(X1 - (h - 1) + (h - 1 - v), Y0 + u, c);
      }
    }
    for (let y = Y0; y < Y0 + w; y++) put(X1, y, 'a'); // contorno del gomito
    // Orologio sul polso: cassa dorata, quadrante chiaro, lancette scure
    const wx = 40;
    const wy = Y0 + 2;
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) out[wy + j][wx + i] = 'G';
    for (let j = 1; j < 4; j++) for (let i = 1; i < 4; i++) out[wy + j][wx + i] = 'W';
    out[wy + 2][wx + 2] = 'D';
    out[wy + 1][wx + 2] = 'D';
    out[wy + 2][wx + 3] = 'D';
    for (let j = 0; j < 5; j++) {
      out[wy + j][wx - 1] = 'D';
      out[wy + j][wx + 5] = 'D';
    }
    if (p.glint) out[wy + 1][wx + 1] = 'Y';
  }
  return out;
}

// ---------- Audio del gioco: musica + effetti ----------
function createAudio() {
  const G = getGraph();
  if (!G) return null;
  const { ctx, musicBus, sfxBus, tone, noise, pulse } = G;

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

  // ----- Effetti: ogni evento del gioco ha il suo suono (e la sua vibrazione, vedi HAP) -----
  const at = () => ctx.currentTime;
  const sfx = {
    catch(combo) {
      const t = at();
      const n = PENTA[Math.min(combo, PENTA.length - 1)];
      tone(sfxBus, t, { type: 'square', f: mtof(n), dur: 0.09, vol: 0.15 });
      tone(sfxBus, t + 0.05, { type: 'square', f: mtof(n + 7), dur: 0.1, vol: 0.12 });
      tone(sfxBus, t, { type: 'sine', f: mtof(n + 24), dur: 0.16, vol: 0.05 }); // tintinnio metallico
    },
    miss() {
      const t = at();
      tone(sfxBus, t, { type: 'sawtooth', f: 220, f2: 80, dur: 0.3, vol: 0.16 });
      noise(sfxBus, t, { dur: 0.12, vol: 0.14, kind: 'lowpass', freq: 600 });
    },
    clank() {
      const t = at();
      noise(sfxBus, t, { dur: 0.07, vol: 0.12, kind: 'bandpass', freq: 3200 });
      tone(sfxBus, t, { type: 'sine', f: 1760, dur: 0.18, vol: 0.05 });
      tone(sfxBus, t, { type: 'sine', f: 2637, dur: 0.14, vol: 0.04 });
    },
    levelUp() {
      const t = at() + 0.05;
      [72, 76, 79, 84].forEach((n, k) => tone(sfxBus, t + k * 0.07, { type: 'square', f: mtof(n), dur: 0.1, vol: 0.13 }));
    },
    gameOver() {
      const t = at() + 0.3;
      [67, 64, 60, 55].forEach((n, k) => tone(sfxBus, t + k * 0.22, { type: 'square', f: mtof(n), dur: k === 3 ? 0.6 : 0.24, vol: 0.14 }));
    },
    click() {
      tone(sfxBus, at(), { type: 'square', f: 660, dur: 0.05, vol: 0.1 });
    },

    // --- Bonus ---
    // Bobina: monetina metallica + scintillio di lamiera
    coil() {
      const t = at();
      [84, 88, 91, 96].forEach((n, k) => tone(sfxBus, t + k * 0.055, { type: 'square', f: mtof(n), dur: 0.09, vol: 0.11 }));
      tone(sfxBus, t, { type: 'sine', f: mtof(108), dur: 0.35, vol: 0.05 });
      noise(sfxBus, t, { dur: 0.12, vol: 0.06, kind: 'highpass', freq: 8000 });
    },
    // Calamita: ronzio elettromagnetico che sale e "clack" di aggancio
    magnet() {
      const t = at();
      tone(sfxBus, t, { type: 'sawtooth', f: 90, f2: 260, dur: 0.38, vol: 0.09 });
      tone(sfxBus, t + 0.05, { type: 'sine', f: 180, f2: 520, dur: 0.33, vol: 0.12 });
      tone(sfxBus, t + 0.34, { type: 'square', f: 1568, dur: 0.07, vol: 0.09 });
      noise(sfxBus, t + 0.34, { dur: 0.04, vol: 0.14, kind: 'bandpass', freq: 2400 });
    },
    magnetPull() {
      tone(sfxBus, at(), { type: 'sine', f: 2200, f2: 2800, dur: 0.05, vol: 0.05 });
    },
    magnetEnd() {
      tone(sfxBus, at(), { type: 'sawtooth', f: 260, f2: 80, dur: 0.25, vol: 0.07 });
    },
    // Chiave inglese: tre scatti di cricchetto e campanello di "riparato"
    wrench() {
      const t = at();
      [0, 0.07, 0.14].forEach((d) => {
        noise(sfxBus, t + d, { dur: 0.025, vol: 0.14, kind: 'bandpass', freq: 2200 });
        tone(sfxBus, t + d, { type: 'square', f: 900, dur: 0.02, vol: 0.08 });
      });
      tone(sfxBus, t + 0.24, { type: 'sine', f: 784, dur: 0.16, vol: 0.13 });
      tone(sfxBus, t + 0.32, { type: 'sine', f: 1046, dur: 0.24, vol: 0.13 });
    },
    // Arresto di emergenza: la linea si ferma (discesa lunga + tonfo)…
    stopOn() {
      const t = at();
      tone(sfxBus, t, { type: 'sawtooth', f: 440, f2: 60, dur: 0.7, vol: 0.13 });
      tone(sfxBus, t, { type: 'sine', f: 110, f2: 40, dur: 0.25, vol: 0.3 });
      noise(sfxBus, t, { dur: 0.45, vol: 0.1, kind: 'lowpass', freq: 900, freq2: 120 });
    },
    // …e riparte (salita rapida)
    stopEnd() {
      const t = at();
      tone(sfxBus, t, { type: 'square', f: 120, f2: 520, dur: 0.3, vol: 0.1 });
      noise(sfxBus, t, { dur: 0.1, vol: 0.06, kind: 'bandpass', freq: 1500 });
    },

    // --- Malus ---
    // Scarto arrugginito: raschio stridulo e cupo
    rust() {
      const t = at();
      tone(sfxBus, t, { type: 'sawtooth', f: 150, f2: 70, dur: 0.35, vol: 0.2 });
      tone(sfxBus, t, { type: 'square', f: 95, dur: 0.25, vol: 0.12 });
      noise(sfxBus, t, { dur: 0.22, vol: 0.18, kind: 'bandpass', freq: 900 });
    },
    // Olio: "splat" viscido con bollicine
    oil() {
      const t = at();
      [0, 0.09, 0.18].forEach((d, k) => tone(sfxBus, t + d, { type: 'sine', f: 420 - k * 60, f2: 170 - k * 25, dur: 0.22, vol: 0.15 }));
      noise(sfxBus, t, { dur: 0.3, vol: 0.09, kind: 'lowpass', freq: 700 });
    },
    oilEnd() {
      tone(sfxBus, at(), { type: 'sine', f: 200, f2: 900, dur: 0.07, vol: 0.12 });
    },
    // Scintilla di saldatura: scarica elettrica
    spark() {
      const t = at();
      noise(sfxBus, t, { dur: 0.18, vol: 0.2, kind: 'highpass', freq: 5000 });
      tone(sfxBus, t, { type: 'square', f: 1800, f2: 300, dur: 0.15, vol: 0.12 });
      for (let k = 0; k < 4; k++) tone(sfxBus, t + 0.04 + k * 0.035, { type: 'square', f: 900 + Math.random() * 1500, dur: 0.03, vol: 0.08 });
    },
    sparkEnd() {
      const t = at();
      tone(sfxBus, t, { type: 'square', f: 1200, dur: 0.03, vol: 0.08 });
      tone(sfxBus, t + 0.05, { type: 'square', f: 1600, dur: 0.03, vol: 0.08 });
    },

    // --- Segnali di contorno (molto leggeri) ---
    bonusSpawn() {
      const t = at();
      tone(sfxBus, t, { type: 'sine', f: 2093, dur: 0.07, vol: 0.035 });
      tone(sfxBus, t + 0.06, { type: 'sine', f: 2637, dur: 0.08, vol: 0.035 });
    },
    malusSpawn() {
      tone(sfxBus, at(), { type: 'triangle', f: 196, f2: 165, dur: 0.1, vol: 0.06 });
    },
    dodge() {
      const t = at();
      noise(sfxBus, t, { dur: 0.05, vol: 0.05, kind: 'bandpass', freq: 1400 });
      tone(sfxBus, t, { type: 'sine', f: 520, f2: 700, dur: 0.05, vol: 0.04 });
    },
    bonusMiss() {
      tone(sfxBus, at(), { type: 'triangle', f: 440, f2: 330, dur: 0.12, vol: 0.05 });
    },

    // --- Menu di pausa ---
    pauseOpen() {
      const t = at();
      tone(sfxBus, t, { type: 'square', f: 660, dur: 0.05, vol: 0.09 });
      tone(sfxBus, t + 0.06, { type: 'square', f: 440, dur: 0.07, vol: 0.09 });
    },
    pauseClose() {
      const t = at();
      tone(sfxBus, t, { type: 'square', f: 440, dur: 0.05, vol: 0.09 });
      tone(sfxBus, t + 0.06, { type: 'square', f: 660, dur: 0.07, vol: 0.09 });
    },
    toggleOn() {
      const t = at();
      tone(sfxBus, t, { type: 'square', f: 660, dur: 0.05, vol: 0.1 });
      tone(sfxBus, t + 0.06, { type: 'square', f: 990, dur: 0.08, vol: 0.1 });
    },
    toggleOff() {
      const t = at();
      tone(sfxBus, t, { type: 'square', f: 660, dur: 0.05, vol: 0.1 });
      tone(sfxBus, t + 0.06, { type: 'square', f: 440, dur: 0.08, vol: 0.1 });
    },
    // Giorno: scintillio che sale; Notte: note morbide che scendono; Auto: tic-tac d'orologio
    day() {
      const t = at();
      [784, 988, 1175, 1568].forEach((f, k) => tone(sfxBus, t + k * 0.07, { type: 'sine', f, dur: 0.18, vol: 0.12 }));
      noise(sfxBus, t + 0.2, { dur: 0.15, vol: 0.04, kind: 'highpass', freq: 8000 });
    },
    night() {
      const t = at();
      [988, 784, 587, 392].forEach((f, k) => tone(sfxBus, t + k * 0.08, { type: 'sine', f, dur: 0.22, vol: 0.12 }));
      tone(sfxBus, t + 0.05, { type: 'triangle', f: 98, dur: 0.4, vol: 0.12 });
    },
    // --- Home, classifica, nome ---
    // Nuova partita: tre note che salgono e uno sbuffo, come una linea che si avvia
    start() {
      const t = at();
      [60, 67, 72].forEach((n, k) => tone(sfxBus, t + k * 0.06, { type: 'square', f: mtof(n), dur: 0.09, vol: 0.12 }));
      noise(sfxBus, t, { dur: 0.18, vol: 0.05, kind: 'bandpass', freq: 900 });
    },
    // Torna indietro: due toni che scendono
    back() {
      const t = at();
      tone(sfxBus, t, { type: 'square', f: 660, dur: 0.04, vol: 0.09 });
      tone(sfxBus, t + 0.05, { type: 'square', f: 495, dur: 0.06, vol: 0.09 });
    },
    // Nuovo high score: fanfara a squillo con scintillio
    record() {
      const t = at() + 0.1;
      [72, 76, 79, 84, 79, 84, 88].forEach((n, k) => tone(sfxBus, t + k * 0.09, { type: 'square', f: mtof(n), dur: k === 6 ? 0.5 : 0.1, vol: 0.13 }));
      tone(sfxBus, t + 0.54, { type: 'triangle', f: mtof(60), dur: 0.5, vol: 0.16 });
      noise(sfxBus, t + 0.54, { dur: 0.35, vol: 0.05, kind: 'highpass', freq: 8000 });
    },
    // Nome registrato: colpo di timbro + tintinnio
    saved() {
      const t = at();
      tone(sfxBus, t, { type: 'sine', f: 150, f2: 55, dur: 0.12, vol: 0.26 });
      noise(sfxBus, t, { dur: 0.06, vol: 0.12, kind: 'bandpass', freq: 2600 });
      tone(sfxBus, t + 0.08, { type: 'sine', f: 1568, dur: 0.22, vol: 0.08 });
      tone(sfxBus, t + 0.14, { type: 'sine', f: 2093, dur: 0.26, vol: 0.07 });
    },
    // Nome vuoto: doppio ronzio basso
    denied() {
      const t = at();
      tone(sfxBus, t, { type: 'square', f: 200, dur: 0.07, vol: 0.12 });
      tone(sfxBus, t + 0.1, { type: 'square', f: 160, dur: 0.1, vol: 0.12 });
    },
    // Lettera digitata (più acuta se il nome è pieno)
    key(full) {
      tone(sfxBus, at(), { type: 'square', f: full ? 1175 : 880, dur: 0.025, vol: 0.07 });
    },
    // Riga della classifica che compare
    row() {
      tone(sfxBus, at(), { type: 'triangle', f: 740, dur: 0.04, vol: 0.07 });
    },
    auto() {
      const t = at();
      noise(sfxBus, t, { dur: 0.03, vol: 0.12, kind: 'bandpass', freq: 3400 });
      tone(sfxBus, t, { type: 'square', f: 1400, dur: 0.02, vol: 0.06 });
      noise(sfxBus, t + 0.09, { dur: 0.03, vol: 0.1, kind: 'bandpass', freq: 2400 });
      tone(sfxBus, t + 0.09, { type: 'square', f: 1000, dur: 0.02, vol: 0.06 });
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
    // Riprende da dove si era fermata (dopo la pausa)
    resumeMusic() {
      if (timer) return;
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
    dispose() {
      clearInterval(timer);
      timer = null;
    },
  };
}

// ---------- Aggancio al tasto Magazzino ----------
export function initMinigame() {
  const btn = document.querySelector('[data-nav-target="products"]');
  const nav = btn && btn.closest('nav');
  if (!btn || !nav) return;

  let timers = [];
  let fx = null;
  let startX = 0;
  let startY = 0;
  let swallowClick = false;
  let swallowTimer = null;

  // Annulla la pressione (rilascio, spostamento del dito, ecc.): se la sequenza di rottura era
  // già iniziata, lo schermo si "ricompone" con un suono e un colpetto di vibrazione.
  const cancelHold = () => {
    timers.forEach(clearTimeout);
    timers = [];
    if (fx) {
      fx.cancel();
      fx = null;
      setTimeout(() => {
        if (!active && !fx && graph) graph.idle(); // niente gioco in corso: si spegne il motore audio
      }, 450);
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
    const holdStart = performance.now();
    getGraph(); // dentro il gesto dell'utente: sblocca l'audio per la sequenza che seguirà
    const f = createBreakFx(e.clientX, e.clientY, holdStart);
    fx = f;
    timers = [
      setTimeout(() => f.tremor(), FX_TREMOR_MS),
      setTimeout(() => f.crack(1), FX_CRACK1_MS),
      setTimeout(() => f.crack(2), FX_CRACK2_MS),
      setTimeout(() => {
        timers = [];
        fx = null;
        swallowClick = true; // al rilascio il tocco NON deve cambiare sezione
        f.shatter();
        launchGame({ fx: f });
      }, HOLD_MS),
    ];
  });
  btn.addEventListener('pointermove', (e) => {
    if (timers.length && Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE) cancelHold();
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

let active = false;

// ---------- Gioco ----------
function launchGame({ fx = null } = {}) {
  if (active) return;
  active = true;
  if (!fx) vib(40, 2);
  const audio = createAudio();
  if (fx && audio) fxSound.boot();

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
  overlay.setAttribute('data-no-haptic', ''); // il minigioco ha la sua vibrazione: niente tocco generico dell'app

  const wrap = mk('div', { position: 'relative', overflow: 'hidden' });
  const canvas = mk('canvas', { display: 'block', imageRendering: 'pixelated' });
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const pauseBtn = mk('button', {
    position: 'absolute',
    top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
    left: '50%',
    transform: 'translateX(-50%)',
    width: '40px',
    height: '40px',
    borderRadius: '8px',
    border: '2px solid rgba(255,255,255,.35)',
    background: 'rgba(8,12,28,.35)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0',
    cursor: 'pointer',
  });
  pauseBtn.type = 'button';
  pauseBtn.setAttribute('aria-label', 'Pausa e impostazioni');
  pauseBtn.append(svgIcon(ICONS.pause, null, 2));

  const hint = mk(
    'div',
    {
      position: 'absolute',
      left: '0',
      right: '0',
      top: '38%',
      textAlign: 'center',
      color: '#fff',
      fontFamily: FONT_UI,
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

  // Schermate a pannello (home, classifica, game over): si scorrono se lo schermo è basso
  const mkScreen = (bg) => {
    const scr = mk('div', {
      position: 'absolute',
      inset: '0',
      display: 'none',
      overflowY: 'auto',
      background: bg,
      color: '#fff',
      fontFamily: FONT_UI,
      textTransform: 'uppercase',
      textAlign: 'center',
      padding: 'calc(env(safe-area-inset-top, 0px) + 12px) 16px 16px',
      boxSizing: 'border-box',
    });
    const inner = mk('div', {
      margin: 'auto',
      width: '100%',
      maxWidth: '300px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '14px',
    });
    scr.append(inner);
    return { scr, inner };
  };
  const wide = (b) => {
    b.type = 'button';
    b.style.width = '100%';
    return b;
  };

  // Home
  const homeScr = mkScreen('rgba(5,8,20,.32)');
  const homeTitle = mk('div', { fontSize: '56px', lineHeight: '.95', fontWeight: '700', letterSpacing: '.05em', color: '#f4cf55', textShadow: '0 4px 0 rgba(0,0,0,.6)' });
  homeTitle.append(mk('div', null, 'Pesca'), mk('div', { fontSize: '34px', color: '#fff' }, 'i barattoli'));
  const homeBest = mk('div', { fontSize: '18px', fontWeight: '600', letterSpacing: '.08em', color: '#cbd5e8', minHeight: '22px', textShadow: '0 2px 0 rgba(0,0,0,.6)' }, '');
  const newGameBtn = wide(pixelButton('Nuova partita', true));
  const scoresBtn = wide(pixelButton('High score', false));
  const settingsBtn = wide(pixelButton('Impostazioni', false));
  const homeExitBtn = wide(pixelButton('Esci', false));
  homeExitBtn.style.background = 'transparent';
  homeExitBtn.style.borderColor = 'rgba(255,255,255,.2)';
  homeExitBtn.style.color = '#cbd5e8';
  const homeBtns = mk('div', { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', marginTop: '8px' });
  homeBtns.append(newGameBtn, scoresBtn, settingsBtn, homeExitBtn);
  homeScr.inner.append(homeTitle, homeBest, homeBtns);
  // Titolo e tasti in alto: sotto resta lo spazio per il personaggio che cammina sul suolo
  homeScr.inner.style.margin = '0 auto auto';
  homeScr.inner.style.position = 'relative';
  homeScr.inner.style.zIndex = '1';
  homeScr.scr.style.paddingTop = 'calc(env(safe-area-inset-top, 0px) + 5vh)';
  const charCv = mk('canvas', { position: 'absolute', left: '0', bottom: '0', imageRendering: 'pixelated', cursor: 'pointer', touchAction: 'manipulation', zIndex: '0' });
  charCv.width = CHAR_W;
  charCv.height = CHAR_H;
  charCv.setAttribute('role', 'img');
  charCv.setAttribute('aria-label', 'Il custode del magazzino');
  const charCtx = charCv.getContext('2d');
  homeScr.scr.append(charCv);

  // Classifica
  const scoresScr = mkScreen('rgba(5,8,20,.82)');
  const scoresTitle = mk('div', { fontSize: '42px', fontWeight: '700', letterSpacing: '.08em', color: '#f4cf55' }, 'High score');
  const scoresList = mk('div', { display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' });
  const scoresBackBtn = wide(pixelButton('Indietro', true));
  const scoresRetryBtn = wide(pixelButton('Riprova', true));
  const scoresMenuBtn = wide(pixelButton('Menu', false));
  const scoresBtns = mk('div', { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', marginTop: '6px' });
  scoresBtns.append(scoresBackBtn, scoresRetryBtn, scoresMenuBtn);
  scoresScr.inner.append(scoresTitle, scoresList, scoresBtns);

  // Game over (con inserimento del nome se il punteggio entra in classifica)
  const overScr = mkScreen('rgba(5,8,20,.78)');
  const panel = overScr.scr;
  const panelInner = overScr.inner;
  const panelTitle = mk('div', { fontSize: '44px', fontWeight: '700', color: '#ff6b6b', letterSpacing: '.06em' }, 'Game over');
  const panelScore = mk('div', { fontSize: '24px', fontWeight: '600', letterSpacing: '.06em' }, '');
  const panelBest = mk('div', { fontSize: '16px', fontWeight: '600', letterSpacing: '.08em', color: '#9fb4e8' }, '');
  const nameBox = mk('div', { display: 'none', flexDirection: 'column', alignItems: 'center', gap: '10px', width: '100%' });
  const nameLabel = mk('div', { fontSize: '18px', fontWeight: '600', letterSpacing: '.08em', color: '#f4cf55' }, 'Inserisci il tuo nome');
  const nameInput = mk('input', {
    width: '100%',
    height: '54px',
    boxSizing: 'border-box',
    textAlign: 'center',
    fontFamily: FONT_UI,
    fontWeight: '700',
    fontSize: '30px',
    letterSpacing: '.18em',
    textTransform: 'uppercase',
    color: '#fff',
    background: 'rgba(255,255,255,.1)',
    border: '2px solid #f4cf55',
    borderRadius: '10px',
    outline: 'none',
    padding: '0 8px',
  });
  nameInput.type = 'text';
  nameInput.maxLength = NAME_MAX;
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.setAttribute('autocapitalize', 'characters');
  nameInput.setAttribute('autocorrect', 'off');
  nameInput.setAttribute('enterkeyhint', 'done');
  nameInput.setAttribute('aria-label', 'Nome per la classifica');
  const saveBtn = wide(pixelButton('Salva', true));
  nameBox.append(nameLabel, nameInput, saveBtn);
  const retryBtn = wide(pixelButton('Riprova', true));
  const exitBtn = wide(pixelButton('Menu', false));
  const overBtns = mk('div', { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', marginTop: '4px' });
  overBtns.append(retryBtn, exitBtn);
  panelInner.append(panelTitle, panelScore, panelBest, nameBox, overBtns);

  // Menu di pausa: vibrazione, suono, sfondo Giorno/Notte/Auto, legenda bonus e malus
  const menu = mk('div', {
    position: 'absolute',
    inset: '0',
    display: 'none',
    background: 'rgba(5,8,20,.55)',
    color: '#fff',
    fontFamily: FONT_UI,
    textTransform: 'uppercase',
    overflowY: 'auto',
    padding: 'calc(env(safe-area-inset-top, 0px) + 12px) 16px 16px',
    boxSizing: 'border-box',
  });
  const card = mk('div', {
    width: '100%',
    maxWidth: '330px',
    margin: 'auto',
    background: 'rgba(12,18,40,.94)',
    border: '2px solid rgba(255,255,255,.28)',
    borderRadius: '12px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    boxSizing: 'border-box',
  });
  const menuTitle = mk('div', { fontSize: '34px', fontWeight: '700', letterSpacing: '.08em', textAlign: 'center' }, 'Pausa');

  const mkRow = (label, iconHolder, control) => {
    const r = mk('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' });
    const left = mk('div', { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '20px', fontWeight: '600', letterSpacing: '.06em' });
    left.append(iconHolder, mk('span', null, label));
    r.append(left, control);
    return r;
  };
  const hapticsIcon = mk('span', { display: 'flex', width: '22px', justifyContent: 'center' });
  hapticsIcon.append(svgIcon(ICONS.vibrate, null, 2));
  const soundIcon = mk('span', { display: 'flex', width: '22px', justifyContent: 'center' });
  const hapticsSw = mkSwitch('Vibrazione');
  const soundSw = mkSwitch('Suono');
  const hapticsRow = mkRow('Vibrazione', hapticsIcon, hapticsSw);
  const soundRow = mkRow('Suono', soundIcon, soundSw);
  if (!hapticsSupported()) hapticsRow.style.display = 'none'; // iOS: nessuna Vibration API, un interruttore inutile

  const bgLabel = mk('div', { fontSize: '16px', fontWeight: '600', letterSpacing: '.08em', color: '#9fb4e8' }, 'Sfondo');
  const bgSeg = mk('div', { display: 'flex', gap: '6px' });
  const bgButtons = {};
  [
    ['day', 'Giorno', ICONS.sun],
    ['night', 'Notte', ICONS.moon],
    ['auto', 'Auto', ICONS.clock],
  ].forEach(([key, label, icon]) => {
    const b = mk('button', {
      flex: '1',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '4px',
      padding: '8px 4px',
      borderRadius: '8px',
      border: '2px solid rgba(255,255,255,.3)',
      background: 'transparent',
      color: '#fff',
      fontFamily: FONT_UI,
      fontWeight: '700',
      fontSize: '16px',
      letterSpacing: '.06em',
      textTransform: 'uppercase',
      cursor: 'pointer',
    });
    b.type = 'button';
    b.append(svgIcon(icon, null, 2), mk('span', null, label));
    bgButtons[key] = b;
    bgSeg.append(b);
  });

  const legend = mk('div', { display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid rgba(255,255,255,.18)', paddingTop: '12px' });
  const legendRow = (title, color, entries) => {
    const wrapRow = mk('div', { display: 'flex', flexDirection: 'column', gap: '6px' });
    wrapRow.append(mk('div', { fontSize: '14px', fontWeight: '700', letterSpacing: '.1em', color }, title));
    const cells = mk('div', { display: 'flex', gap: '4px' });
    for (const [key, caption] of entries) {
      const cell = mk('div', { flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', minWidth: '0' });
      const it = ITEMS[key];
      const iconBox = mk('div', { height: '26px', display: 'flex', alignItems: 'center' });
      iconBox.append(svgIcon(it.rows, it.pal, 2));
      cell.append(iconBox, mk('div', { fontSize: '13px', fontWeight: '600', letterSpacing: '.03em', color: '#cbd5e8', textAlign: 'center', lineHeight: '1.1' }, caption));
      cells.append(cell);
    }
    wrapRow.append(cells);
    return wrapRow;
  };
  legend.append(
    legendRow('Bonus', '#8fe388', [['coil', 'Bobina +5'], ['magnet', 'Calamita'], ['wrench', '+1 cuore'], ['stop', 'Stop linea']]),
    legendRow('Malus', '#ff8f8f', [['rust', '-1 cuore'], ['oil', 'Olio'], ['spark', 'Scintilla']])
  );

  const resumeBtn = pixelButton('Riprendi', true);
  const quitBtn = pixelButton('Menu principale', false);
  const backBtn = pixelButton('Indietro', true); // visibile solo nelle Impostazioni aperte dalla home
  resumeBtn.type = 'button';
  quitBtn.type = 'button';
  backBtn.type = 'button';
  resumeBtn.style.width = '100%';
  quitBtn.style.width = '100%';
  backBtn.style.width = '100%';
  backBtn.style.display = 'none';
  card.append(menuTitle, hapticsRow, soundRow, bgLabel, bgSeg, legend, resumeBtn, quitBtn, backBtn);
  menu.append(card);

  wrap.append(canvas, hint, pauseBtn, homeScr.scr, scoresScr.scr, panel, menu);
  overlay.append(wrap);
  document.body.append(overlay);

  // --- Stato ---
  let scale = 3;
  let W = 120;
  let H = 240;
  let topPad = 6;
  let stars = [];
  let clouds = [];
  let raf = 0;
  let last = 0;
  let amb = 0; // tempo "d'ambiente" (stelle, nuvole): corre anche in pausa
  let hintTimer = 0;
  let lastPullFx = 0;
  const keys = { left: false, right: false };

  const g = {
    state: 'home', // home | intro | play | paused | over
    resume: 'play',
    introT: 0,
    score: 0,
    lives: MAX_LIVES,
    items: [],
    parts: [],
    pops: [],
    fx: { magnet: 0, stop: 0, oil: 0, freeze: 0 },
    timeScale: 1,
    t: 0,
    spawn: 1,
    hurt: 0,
    hurtRgb: '255,60,60',
    flashT: 0,
    flashRgb: '255,255,255',
    bump: 0,
    combo: 0,
    cx: 60,
    tcx: 60,
    vx: 0,
    bw: 28,
    by: 200,
  };

  const level = () => Math.floor(g.score / POINTS_PER_LEVEL);

  function baseBucketW() {
    return clamp(Math.round(W * 0.24), 24, 34);
  }

  // --- Ambiente (giorno / notte) ---
  const env = { d: 1, twi: 0, sunP: 0.62, moonQ: 0.4 };
  let skyCur = null;
  let skyClock = 0;
  let bandKey = -1;
  let bands = [];

  function skyTarget() {
    if (prefs.bg === 'day') return SKY_FIXED_DAY;
    if (prefs.bg === 'night') return SKY_FIXED_NIGHT;
    if (!skyCur) skyCur = skyAt(new Date());
    return skyCur;
  }
  function updateEnv(dt, snap) {
    skyClock -= dt;
    if (skyClock <= 0) {
      skyCur = skyAt(new Date());
      skyClock = 5;
    }
    const t = skyTarget();
    const k = snap ? 1 : Math.min(1, dt * 2.5);
    env.d += (t.d - env.d) * k;
    env.twi += (t.twi - env.twi) * k;
    env.sunP += (t.sunP - env.sunP) * k;
    env.moonQ += (t.moonQ - env.moonQ) * k;
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

    // Stelle e nuvole fisse (generatore pseudo-casuale con seme, così non "ballano" al resize)
    let seed = 1234567;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    stars = Array.from({ length: 30 }, () => ({
      x: Math.floor(rnd() * W),
      y: Math.floor(rnd() * (H - GROUND_H - 20)),
      c: rnd() > 0.7 ? '#ffffff' : '#9fb0dd',
      ph: rnd() * Math.PI * 2,
      big: rnd() > 0.88,
    }));
    clouds = Array.from({ length: 4 }, (_, i) => ({
      x0: rnd() * (W + 40),
      y: Math.floor(H * (0.1 + 0.13 * i + rnd() * 0.05)),
      v: 3 + rnd() * 5,
    }));
  }

  function resetRound() {
    g.score = 0;
    g.lives = MAX_LIVES;
    g.items = [];
    g.parts = [];
    g.pops = [];
    g.fx = { magnet: 0, stop: 0, oil: 0, freeze: 0 };
    g.timeScale = 1;
    g.t = 0;
    g.spawn = 1;
    g.hurt = 0;
    g.flashT = 0;
    g.bump = 0;
    g.bw = baseBucketW();
    g.cx = W / 2;
    g.tcx = W / 2;
    g.vx = 0;
    g.combo = 0;
  }

  function startRound(intro) {
    resetRound();
    g.state = intro ? 'intro' : 'play';
    g.introT = intro ? 0.95 : 0;
    showScreen(null);
    if (audio) {
      audio.setTempo(BASE_BPM);
      if (!intro) audio.startMusic();
    }
  }

  function applyTempo() {
    if (audio) audio.setTempo((BASE_BPM + Math.min(level(), 10) * 5) * (g.fx.stop > 0 ? 0.72 : 1));
  }

  // --- Oggetti che cadono ---
  function pickType() {
    const lv = level();
    const pMalus = lv >= 1 ? Math.min(0.28, 0.1 + (lv - 1) * 0.03) : 0;
    const pBonus = lv >= 1 ? 0.1 : 0.05;
    const pick = (pool) => {
      const tot = pool.reduce((s, p) => s + p[1], 0);
      let x = Math.random() * tot;
      for (const [k, w] of pool) {
        x -= w;
        if (x <= 0) return k;
      }
      return pool[0][0];
    };
    const r = Math.random();
    if (r < pMalus) {
      const pool = [['rust', 3]];
      if (g.fx.oil <= 0) pool.push(['oil', 2]);
      if (lv >= 2 && g.fx.freeze <= 0) pool.push(['spark', 2]);
      return pick(pool);
    }
    if (r < pMalus + pBonus) {
      const pool = [['coil', 3]];
      if (g.fx.magnet <= 0) pool.push(['magnet', 2]);
      if (g.fx.stop <= 0) pool.push(['stop', 2]);
      if (g.lives < MAX_LIVES) pool.push(['wrench', 3]);
      return pick(pool);
    }
    return 'can';
  }

  function spawnItem() {
    const lv = level();
    const k = H / 240; // la velocità scala con l'altezza dello schermo
    const type = pickType();
    const it = ITEMS[type];
    const amp = lv >= 3 ? Math.min(9, (lv - 2) * 1.5) : 0;
    const margin = amp + 2;
    const base = 42 + lv * 7;
    g.items.push({
      type,
      kind: it.kind,
      w: it.w,
      h: it.h,
      x0: margin + Math.random() * Math.max(1, W - it.w - margin * 2),
      x: 0,
      y: -it.h,
      vy: Math.min(165, base * (0.9 + Math.random() * 0.25)) * k,
      amp,
      freq: 2 + Math.random() * 2,
      ph: Math.random() * Math.PI * 2,
      age: 0,
      vx: 0,
      missed: false,
      pulled: false,
    });
    g.spawn = Math.max(0.38, 1.15 - lv * 0.07) + Math.random() * 0.25;
    // Segnale d'arrivo: scintillio per i bonus, nota grave per i malus
    if (it.kind === 'bonus') {
      if (audio) audio.bonusSpawn();
      vib(HAP.spawnBonus, 1);
    } else if (it.kind === 'malus') {
      if (audio) audio.malusSpawn();
      vib(HAP.spawnMalus, 1);
    }
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

  function pop(text, x, color) {
    g.pops.push({ text, x: clamp(x, text.length * 2 + 2, W - text.length * 2 - 2), y: g.by - 6, life: 1, color });
  }

  function flash(rgb, t) {
    g.flashRgb = rgb;
    g.flashT = t;
  }

  function addScore(n) {
    const before = level();
    g.score += n;
    if (level() > before) {
      if (audio) audio.levelUp();
      vib(HAP.level, 2);
      applyTempo();
    }
  }

  function loseLife(kind) {
    g.lives -= 1;
    g.hurt = 0.25;
    g.hurtRgb = kind === 'rust' ? '255,140,40' : '255,60,60';
    g.combo = 0;
    if (kind === 'rust') {
      vib(HAP.rust, 3);
      if (audio) audio.rust();
    } else {
      vib(HAP.miss, 2);
      if (audio) audio.miss();
    }
    if (g.lives <= 0) {
      g.state = 'over';
      g.fx = { magnet: 0, stop: 0, oil: 0, freeze: 0 };
      g.timeScale = 1;
      if (audio) audio.stopMusic();
      if (scoreQualifies(g.score)) beginNameEntry();
      else showGameOver();
    }
  }

  // Raccolta di un oggetto dentro il secchio
  function collect(c, center) {
    switch (c.type) {
      case 'can':
        addScore(1);
        g.combo += 1;
        g.bump = 0.12;
        if (audio) audio.catch(g.combo - 1);
        burst(center, g.by, '#e8eef8', 6);
        break;
      case 'coil':
        addScore(5);
        g.combo += 1;
        g.bump = 0.14;
        if (audio) audio.coil();
        vib(HAP.coil, 2);
        burst(center, g.by, '#ffe27a', 12);
        pop('+5', center, '#ffe27a');
        break;
      case 'magnet':
        g.fx.magnet = FX_DUR.magnet;
        g.bump = 0.14;
        if (audio) audio.magnet();
        vib(HAP.magnet, 2);
        burst(center, g.by, '#ff9aa0', 10);
        pop('CALAMITA', center, '#ff9aa0');
        break;
      case 'wrench':
        g.bump = 0.14;
        if (g.lives < MAX_LIVES) {
          g.lives += 1;
          pop('VITA', center, '#ff8c90');
        } else {
          addScore(3);
          pop('+3', center, '#8fd0ff');
        }
        if (audio) audio.wrench();
        vib(HAP.wrench, 2);
        burst(center, g.by, '#8fd0ff', 10);
        break;
      case 'stop':
        g.fx.stop = FX_DUR.stop;
        g.bump = 0.14;
        if (audio) audio.stopOn();
        vib(HAP.stop, 2);
        flash('90,140,255', 0.25);
        pop('STOP', center, '#ffd0d2');
        applyTempo();
        break;
      case 'rust':
        burst(center, g.by, '#b8733a', 10);
        pop('RUGGINE', center, '#ff9a4d');
        loseLife('rust');
        break;
      case 'oil':
        g.fx.oil = FX_DUR.oil;
        g.vx = (Math.random() < 0.5 ? -1 : 1) * 40;
        g.bump = 0.14;
        if (audio) audio.oil();
        vib(HAP.oil, 2);
        burst(center, g.by, '#c98a2b', 10);
        pop('OLIO', center, '#c98a2b');
        break;
      case 'spark':
        g.fx.freeze = FX_DUR.freeze;
        if (audio) audio.spark();
        vib(HAP.spark, 3);
        flash('170,225,255', 0.22);
        burst(center, g.by, '#ffd23f', 12);
        burst(center, g.by, '#4cc9f0', 6);
        pop('SCARICA', center, '#4cc9f0');
        break;
      default:
        break;
    }
  }

  // Fine di un effetto temporaneo: stesso trattamento (suono + vibrazione) dell'inizio
  function endFx(key) {
    if (g.state === 'over') return;
    if (key === 'magnet') {
      if (audio) audio.magnetEnd();
      vib(HAP.magnetEnd, 2);
    } else if (key === 'stop') {
      if (audio) audio.stopEnd();
      vib(HAP.stopEnd, 2);
      applyTempo();
    } else if (key === 'oil') {
      g.vx = 0;
      if (audio) audio.oilEnd();
      vib(HAP.oilEnd, 2);
    } else if (key === 'freeze') {
      if (audio) audio.sparkEnd();
      vib(HAP.sparkEnd, 2);
    }
  }

  function update(dt) {
    if (g.state === 'intro') {
      g.introT -= dt;
      if (g.introT <= 0) {
        g.state = 'play';
        if (audio) audio.startMusic();
      }
    }

    // Effetti temporanei (a tempo reale)
    for (const key of ['magnet', 'stop', 'oil', 'freeze']) {
      if (g.fx[key] > 0) {
        g.fx[key] -= dt;
        if (g.fx[key] <= 0) {
          g.fx[key] = 0;
          endFx(key);
        }
      }
    }
    // "Stop linea": il mondo scorre al 45% della velocità (si ferma/riparte in modo morbido)
    g.timeScale += ((g.fx.stop > 0 ? 0.45 : 1) - g.timeScale) * Math.min(1, dt * 4);
    const wdt = dt * g.timeScale;
    g.t += wdt;

    // Secchio
    const frozen = g.fx.freeze > 0;
    if (!frozen) {
      if (keys.left) g.tcx -= 120 * dt;
      if (keys.right) g.tcx += 120 * dt;
    }
    const lv = level();
    g.bw = Math.max(baseBucketW() - 8, baseBucketW() - Math.floor(lv / 3) * 2); // si restringe un po' con i livelli alti
    g.tcx = clamp(g.tcx, g.bw / 2, W - g.bw / 2);
    if (frozen) {
      g.vx = 0; // scarica di saldatura: il secchio resta bloccato dov'è
    } else if (g.fx.oil > 0) {
      // Olio: molla poco smorzata, il secchio pattina e supera il bersaglio
      g.vx += (g.tcx - g.cx) * 60 * dt;
      g.vx *= Math.max(0, 1 - 3.5 * dt);
      g.cx += g.vx * dt;
      if (g.cx < g.bw / 2 || g.cx > W - g.bw / 2) g.vx *= -0.4;
    } else {
      g.cx += (g.tcx - g.cx) * Math.min(1, dt * 20);
    }
    g.cx = clamp(g.cx, g.bw / 2, W - g.bw / 2);

    if (g.state === 'play') {
      g.spawn -= wdt;
      if (g.spawn <= 0) spawnItem();
    }

    const left = g.cx - g.bw / 2;
    for (let i = g.items.length - 1; i >= 0; i--) {
      const c = g.items[i];
      c.age += wdt;
      c.y += c.vy * g.timeScale * dt;

      // Calamita: i barattoli e i bonus vicini al secchio vengono attirati verso il centro
      if (g.fx.magnet > 0 && !c.missed && c.kind !== 'malus' && c.y > topPad + 10 && c.y < g.by - 2) {
        const dx = g.cx - (c.x0 + c.w / 2);
        if (Math.abs(dx) < 46) {
          c.x0 = clamp(c.x0 + dx * Math.min(1, dt * (1.2 + 3 * (c.y / g.by))), 0, W - c.w);
          if (!c.pulled) {
            c.pulled = true;
            const now = performance.now();
            if (now - lastPullFx > 220) {
              lastPullFx = now;
              if (audio) audio.magnetPull();
              vib(HAP.magnetPull, 1);
            }
          }
        }
      }

      if (c.missed) c.x += c.vx * dt;
      else c.x = c.x0 + Math.sin(c.age * c.freq + c.ph) * c.amp;

      if (!c.missed && c.y + c.h >= g.by + 2) {
        const center = c.x + c.w / 2;
        if (center >= left + 1 && center <= left + g.bw - 1) {
          collect(c, center);
          g.items.splice(i, 1);
          if (g.state === 'over') break;
          continue;
        }
        // Non preso (anche se sfiora il bordo): rimbalza di lato e cade; costa un cuore solo se è un barattolo
        c.missed = true;
        c.vx = (center < g.cx ? -1 : 1) * 28;
        if (c.kind === 'good') {
          loseLife('miss');
          if (g.state === 'over') break;
        }
      }

      if (c.y + c.h >= H - GROUND_H) {
        const mid = c.x + c.w / 2;
        if (c.kind === 'good' && c.missed) {
          burst(mid, H - GROUND_H, '#a0abbd', 5);
          if (audio) audio.clank();
        } else if (c.kind === 'bonus') {
          burst(mid, H - GROUND_H, '#a0abbd', 4);
          if (audio) audio.bonusMiss(); // bonus perso: nota discendente leggera
          vib(HAP.bonusMiss, 1);
        } else if (c.kind === 'malus') {
          burst(mid, H - GROUND_H, '#6f7b91', 4);
          if (audio) audio.dodge(); // pericolo evitato: breve fruscio
          vib(HAP.dodge, 1);
        }
        g.items.splice(i, 1);
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
    for (let i = g.pops.length - 1; i >= 0; i--) {
      const p = g.pops[i];
      p.life -= dt * 1.1;
      p.y -= 14 * dt;
      if (p.life <= 0) g.pops.splice(i, 1);
    }

    if (g.hurt > 0) g.hurt -= dt;
    if (g.flashT > 0) g.flashT -= dt;
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

  function disc(cxp, cyp, r) {
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      ctx.fillRect(R(cxp - w), R(cyp + dy), w * 2 + 1, 1);
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

  function textW(str, s) {
    return str.length * 4 * s - s;
  }
  function drawText(str, xRight, y, s) {
    let x = R(xRight - textW(str, s));
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

  function drawSun(x, y, a) {
    const k = env.twi * 0.8;
    const core = rgbStr(mixC([255, 243, 176], [255, 176, 102], k));
    const edge = rgbStr(mixC([255, 210, 63], [255, 122, 61], k));
    ctx.globalAlpha = a * 0.16;
    ctx.fillStyle = edge;
    disc(x, y, 14);
    ctx.globalAlpha = a * 0.3;
    disc(x, y, 10);
    ctx.globalAlpha = a;
    disc(x, y, 7);
    ctx.fillStyle = core;
    disc(x, y, 5);
    // raggi: lampeggiano a due lunghezze
    const rad = Math.floor(amb * 2) % 2 ? 10 : 9;
    ctx.fillStyle = edge;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let s = 0; s < 3; s++) ctx.fillRect(R(x + dx * (rad + s)), R(y + dy * (rad + s)), 1, 1);
    }
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      for (let s = 0; s < 2; s++) ctx.fillRect(R(x + dx * (rad - 2 + s)), R(y + dy * (rad - 2 + s)), 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  function drawMoon(x, y, a) {
    ctx.globalAlpha = a * 0.14;
    ctx.fillStyle = '#9fb4e8';
    disc(x, y, 11);
    ctx.globalAlpha = a;
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        if (dx * dx + dy * dy > 36) continue;
        const cut = (dx - 3) * (dx - 3) + (dy + 2) * (dy + 2);
        if (cut <= 27) continue;
        ctx.fillStyle = dx < -3 ? '#d9d4b8' : '#f4f1de';
        ctx.fillRect(R(x + dx), R(y + dy), 1, 1);
      }
    }
    ctx.globalAlpha = 1;
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
    // Olio: macchie scure lucide sul secchio
    if (g.fx.oil > 0) {
      ctx.fillStyle = '#3b2a12';
      ctx.fillRect(x + 3, y + 3, 4, 2);
      ctx.fillRect(x + w - 8, y + 6, 5, 3);
      ctx.fillRect(x + 6, y + 9, 3, 3);
      ctx.fillStyle = '#c98a2b';
      ctx.fillRect(x + 3, y + 3, 1, 1);
      ctx.fillRect(x + w - 8, y + 6, 1, 1);
    }
    // Scarica: archi elettrici attorno al secchio
    if (g.fx.freeze > 0) {
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = Math.random() < 0.5 ? '#4cc9f0' : '#ffffff';
        const px = x - 3 + Math.floor(Math.random() * (w + 6));
        const py = y - 3 + Math.floor(Math.random() * (BUCKET_H + 6));
        ctx.fillRect(px, py, 1, Math.random() < 0.4 ? 2 : 1);
      }
    }
    // Calamita: arco di punti che pulsa sopra il secchio
    if (g.fx.magnet > 0) {
      const blink = g.fx.magnet < 1.5 && Math.floor(amb * 8) % 2 === 0; // negli ultimi istanti lampeggia
      if (!blink) {
        for (let k = 0; k <= 16; k++) {
          const ang = Math.PI + (k / 16) * Math.PI;
          const rr = 22 + (Math.floor(amb * 6) % 2) * 3;
          ctx.fillStyle = k % 2 ? '#ff9aa0' : '#8fd0ff';
          ctx.globalAlpha = 0.85;
          ctx.fillRect(R(g.cx + Math.cos(ang) * rr), R(g.by + 2 + Math.sin(ang) * rr * 0.6), 1, 1);
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawItem(c) {
    const it = ITEMS[c.type];
    sprite(it.rows, c.x, c.y, it.pal);
    if (c.missed) return;
    if (it.kind === 'bonus') {
      // scintillii attorno ai bonus
      const ph = Math.floor(amb * 6 + c.ph * 3) % 4;
      ctx.fillStyle = it.glow;
      const pts = [[-2, 1], [it.w + 1, 3], [it.w - 2, -2], [1, it.h + 1]];
      const p = pts[ph];
      ctx.fillRect(R(c.x) + p[0], R(c.y) + p[1], 1, 1);
      ctx.fillRect(R(c.x) + p[0] - 1, R(c.y) + p[1], 3, 1);
      ctx.fillRect(R(c.x) + p[0], R(c.y) + p[1] - 1, 1, 3);
    } else if (it.kind === 'malus' && Math.floor(amb * 3 + c.ph) % 2 === 0) {
      // parentesi rosse che lampeggiano: segnalano il pericolo
      ctx.fillStyle = '#ff4d4d';
      const x = R(c.x) - 2;
      const y = R(c.y) - 2;
      const w = it.w + 4;
      const h = it.h + 4;
      for (const [px, py, sx, sy] of [[x, y, 1, 1], [x + w - 1, y, -1, 1], [x, y + h - 1, 1, -1], [x + w - 1, y + h - 1, -1, -1]]) {
        ctx.fillRect(px, py, 1, 1);
        ctx.fillRect(px + sx, py, 1, 1);
        ctx.fillRect(px, py + sy, 1, 1);
      }
    }
  }

  function draw() {
    // cielo (a fasce) in base a giorno/notte/alba/tramonto
    const key = Math.round(env.d * 200) * 1000 + Math.round(env.twi * 200);
    if (key !== bandKey) {
      bandKey = key;
      bands = skyBands(env.d, env.twi);
      overlay.style.background = bands[0];
    }
    const bh = Math.ceil(H / SKY_N);
    for (let i = 0; i < SKY_N; i++) {
      ctx.fillStyle = bands[i];
      ctx.fillRect(0, i * bh, W, bh);
    }

    // stelle (solo di notte, con scintillio)
    const night = Math.pow(1 - env.d, 1.5);
    if (night > 0.03) {
      for (const s of stars) {
        const tw = 0.65 + 0.35 * Math.sin(amb * 1.8 + s.ph);
        ctx.globalAlpha = night * tw;
        ctx.fillStyle = s.c;
        ctx.fillRect(s.x, s.y, 1, 1);
        if (s.big) {
          ctx.globalAlpha = night * tw * 0.5;
          ctx.fillRect(s.x - 1, s.y, 1, 1);
          ctx.fillRect(s.x + 1, s.y, 1, 1);
          ctx.fillRect(s.x, s.y - 1, 1, 1);
          ctx.fillRect(s.x, s.y + 1, 1, 1);
        }
      }
      ctx.globalAlpha = 1;
    }

    // sole e luna seguono l'ora: arco da est a ovest
    const horizon = H - GROUND_H;
    const peak = H * 0.2;
    const arc = (p) => horizon - Math.sin(Math.PI * clamp(p, 0, 1)) * (horizon - peak);
    const sunA = clamp(env.d * 1.4, 0, 1);
    if (sunA > 0.02) drawSun(W * (0.14 + 0.72 * clamp(env.sunP, 0, 1)), arc(env.sunP), sunA);
    const moonA = clamp((1 - env.d) * 1.4, 0, 1);
    if (moonA > 0.02) drawMoon(W * (0.14 + 0.72 * env.moonQ), arc(env.moonQ), moonA);

    // nuvole che scorrono piano (più chiare di giorno, scure di notte, rosate al tramonto)
    let cloudCol = mixC([58, 72, 118], [255, 255, 255], env.d);
    cloudCol = mixC(cloudCol, [255, 196, 168], env.twi * 0.7);
    ctx.fillStyle = rgbStr(cloudCol);
    ctx.globalAlpha = 0.3 + 0.6 * env.d;
    for (const c of clouds) {
      const x = ((c.x0 + amb * c.v) % (W + 40)) - 20;
      mask(CLOUD, x, c.y, rgbStr(cloudCol));
    }
    ctx.globalAlpha = 1;

    // suolo
    ctx.fillStyle = rgbStr(mixC([34, 40, 68], [88, 105, 143], env.d));
    ctx.fillRect(0, H - GROUND_H, W, GROUND_H);
    ctx.fillStyle = rgbStr(mixC([74, 85, 128], [157, 179, 222], env.d));
    ctx.fillRect(0, H - GROUND_H, W, 1);
    ctx.fillStyle = rgbStr(mixC([23, 28, 51], [69, 83, 119], env.d));
    for (let x = 0; x < W; x += 8) ctx.fillRect(x, H - GROUND_H + 3, 4, 1);

    if (g.state === 'home') return; // la schermata iniziale mostra solo il cielo

    for (const c of g.items) drawItem(c);
    drawBucket();

    for (const p of g.parts) {
      ctx.fillStyle = p.color;
      ctx.fillRect(R(p.x), R(p.y), 1, 1);
    }

    // scritte che salgono dal secchio (+5, VITA, STOP, …)
    for (const p of g.pops) {
      ctx.globalAlpha = clamp(p.life * 1.6, 0, 1);
      const cxm = R(p.x + textW(p.text, 1) / 2);
      ctx.fillStyle = 'rgba(0,0,0,.7)';
      drawText(p.text, cxm + 1, p.y + 1, 1);
      ctx.fillStyle = p.color;
      drawText(p.text, cxm, p.y, 1);
    }
    ctx.globalAlpha = 1;

    // HUD: cuori in alto a sinistra, punteggio e livello in alto a destra
    for (let i = 0; i < MAX_LIVES; i++) heart(5 + i * (HW + 3), topPad, i < g.lives);
    textWithShadow(String(g.score), W - 5, topPad, 2, '#ffffff');
    textWithShadow(`LV ${level() + 1}`, W - 5, topPad + 13, 1, env.d > 0.6 ? '#2a3f78' : '#9fb4e8');

    // effetti attivi: icona con barretta del tempo residuo (lampeggia negli ultimi istanti)
    let slot = 0;
    for (const [fxKey, itemKey, color] of [['magnet', 'magnet', '#8fe388'], ['stop', 'stop', '#8fe388'], ['oil', 'oil', '#ff8f8f'], ['freeze', 'spark', '#ff8f8f']]) {
      const left = g.fx[fxKey];
      if (left <= 0) continue;
      const x = 5 + slot * 14;
      const y = topPad + HH + 5;
      slot += 1;
      if (left < 1.5 && Math.floor(amb * 8) % 2 === 0) continue;
      const it = ITEMS[itemKey];
      sprite(it.rows, x, y, it.pal);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(x, y + it.h + 1, 12, 2);
      ctx.fillStyle = color;
      ctx.fillRect(x, y + it.h + 1, R((12 * left) / FX_DUR[fxKey]), 2);
    }

    // velature: stop linea (azzurrina) e lampi di evento
    if (g.fx.stop > 0) {
      ctx.fillStyle = 'rgba(110,150,255,.10)';
      ctx.fillRect(0, 0, W, H);
    }
    if (g.hurt > 0) {
      ctx.fillStyle = `rgba(${g.hurtRgb},${Math.min(0.35, g.hurt * 1.4)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (g.flashT > 0) {
      ctx.fillStyle = `rgba(${g.flashRgb},${Math.min(0.3, g.flashT * 1.6)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!last) last = ts;
    const dt = Math.min(0.05, (ts - last) / 1000);
    last = ts;
    amb += dt;
    updateEnv(dt, false);
    if (g.state === 'play' || g.state === 'intro') update(dt);
    else if (g.state === 'home') charTick(dt);
    draw();
  }

  // ---------- Pausa e impostazioni ----------
  function refreshMenu() {
    hapticsSw.set(effHaptics());
    soundSw.set(effSound());
    soundIcon.replaceChildren(svgIcon(effSound() ? ICONS.soundOn : ICONS.soundOff, null, 2));
    for (const [k, b] of Object.entries(bgButtons)) {
      const on = prefs.bg === k;
      b.setAttribute('aria-pressed', String(on));
      b.style.background = on ? '#f4cf55' : 'transparent';
      b.style.borderColor = on ? '#f4cf55' : 'rgba(255,255,255,.3)';
      b.style.color = on ? '#1a1a2e' : '#fff';
    }
  }

  function openPause() {
    if (g.state !== 'play' && g.state !== 'intro') return;
    g.resume = g.state;
    g.state = 'paused';
    keys.left = false;
    keys.right = false;
    setMenuMode('pause');
    refreshMenu();
    menu.style.display = 'block';
    if (audio) {
      audio.stopMusic();
      audio.pauseOpen();
    }
    vib(HAP.pause, 2);
  }

  function closePause() {
    if (g.state !== 'paused') return;
    menu.style.display = 'none';
    g.state = g.resume || 'play';
    last = 0; // evita un salto di tempo alla ripresa
    if (audio) {
      audio.pauseClose();
      if (g.state === 'play') audio.resumeMusic();
    }
    vib(HAP.resume, 2);
  }

  function setBg(mode) {
    if (prefs.bg === mode) return;
    prefs.bg = mode;
    skyCur = skyAt(new Date());
    skyClock = 5;
    refreshMenu();
    if (audio) audio[mode]();
    vib(HAP[mode], 2);
  }

  // ---------- Schermate: home, classifica, impostazioni, game over ----------
  let screen = 'home'; // home | scores | settings | over | null (si sta giocando)
  let subLayer = null; // voce di cronologia di classifica/impostazioni: il tasto indietro del telefono torna alla home
  let afterOver = false; // la classifica è stata aperta subito dopo una partita
  let lockUntil = 0; // dopo un game over ignora i tocchi per un attimo (il dito è ancora sul gioco)

  // ---------- Personaggio: cammina e ogni tanto guarda l'orologio ----------
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const frameCache = new Map();
  const charFrame = (p) => {
    const key = `${p.lift || 0}|${p.armL || 0}|${p.armR || 0}|${p.watch || 0}|${p.head || 0}|${p.glint || 0}`;
    let cv = frameCache.get(key);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = CHAR_W;
      cv.height = CHAR_H;
      const c = cv.getContext('2d');
      buildCharFrame(p).forEach((row, y) =>
        row.forEach((ch, x) => {
          if (ch === '.') return;
          c.fillStyle = CHAR_PAL[ch];
          c.fillRect(x, y, 1, 1);
        })
      );
      frameCache.set(key, cv);
    }
    return cv;
  };
  const WALK = [{ lift: -1, armL: -1, armR: 1 }, {}, { lift: 1, armL: 1, armR: -1 }, {}];
  const cs = { x: 8, dir: 1, mode: 'walk', t: 0, step: 0, until: 3, watchIn: 4, z: 2, shown: '' };

  function layoutChar() {
    if (screen !== 'home') return;
    const wr = wrap.getBoundingClientRect();
    const ir = homeScr.inner.getBoundingClientRect();
    const groundTop = wr.height - GROUND_H * scale;
    const avail = groundTop - (ir.bottom - wr.top) - 6;
    cs.z = clamp(Math.floor(avail / CHAR_H), 1, scale);
    charCv.style.width = `${CHAR_W * cs.z}px`;
    charCv.style.height = `${CHAR_H * cs.z}px`;
    charCv.style.bottom = `${GROUND_H * scale - scale}px`; // i piedi poggiano sul bordo del suolo
    cs.maxX = Math.max(0, Math.floor(wr.width / cs.z) - CHAR_W);
    cs.x = clamp(cs.x, 0, cs.maxX);
    cs.shown = '';
  }

  function charSet(mode, dur) {
    cs.mode = mode;
    cs.t = 0;
    cs.until = dur;
  }
  function charWatch(byTap) {
    if (cs.mode === 'watch') return;
    charSet('watch', 2.4);
    cs.tic = 0;
    cs.watchIn = 7 + Math.random() * 6;
    if (audio) audio.auto(); // tic-tac d'orologio: lo stesso dell'opzione Auto dello sfondo
    if (byTap) vib(HAP.auto, 2);
  }
  charCv.addEventListener('click', () => charWatch(true));

  function charTick(dt) {
    if (screen !== 'home') return;
    cs.t += dt;
    cs.watchIn -= dt;
    let p;
    if (cs.mode === 'walk') {
      if (!reduceMotion) cs.x += cs.dir * 16 * dt;
      if (cs.x <= 0 || cs.x >= cs.maxX) {
        cs.x = clamp(cs.x, 0, cs.maxX);
        cs.dir = cs.x <= 0 ? 1 : -1;
        charSet('idle', 0.7);
      } else if (cs.t >= cs.until) {
        if (Math.random() < 0.4) cs.dir = -cs.dir;
        charSet('idle', 0.5 + Math.random() * 0.7);
      }
      p = reduceMotion ? {} : WALK[Math.floor(cs.t / 0.2) % 4];
    } else if (cs.mode === 'idle') {
      if (cs.t >= cs.until) {
        if (cs.watchIn <= 0) charWatch(false);
        else charSet('walk', 3 + Math.random() * 3);
      }
      p = {};
    } else {
      // alza il braccio (0,3 s), guarda l'orologio con un luccichio, poi riabbassa
      if (cs.t >= cs.until) {
        charSet('walk', 3 + Math.random() * 3);
        p = {};
      } else if (cs.t < 0.3 || cs.t > cs.until - 0.3) p = { watch: 1 };
      else {
        p = { watch: 1, head: 1, glint: Math.floor(cs.t * 4) % 2 };
        if (audio && cs.t > 1.3 && cs.tic === 0) {
          cs.tic = 1;
          audio.auto(); // secondo tic a metà occhiata
        }
      }
    }
    const left = Math.round(cs.x);
    const key = `${left}|${cs.z}|${JSON.stringify(p)}`;
    if (key === cs.shown) return;
    cs.shown = key;
    charCtx.clearRect(0, 0, CHAR_W, CHAR_H);
    charCtx.drawImage(charFrame(p), 0, 0);
    charCv.style.transform = `translateX(${left * cs.z}px)`;
  }

  function showScreen(name) {
    screen = name;
    homeScr.scr.style.display = name === 'home' ? 'flex' : 'none';
    scoresScr.scr.style.display = name === 'scores' ? 'flex' : 'none';
    panel.style.display = name === 'over' ? 'flex' : 'none';
    pauseBtn.style.display = name === null ? 'flex' : 'none';
    if (name !== 'settings') menu.style.display = 'none';
    if (name === 'home') layoutChar();
  }
  const locked = () => performance.now() < lockUntil;
  const feel = (soundName, pattern, prio = 2) => {
    if (audio && audio[soundName]) audio[soundName]();
    vib(pattern, prio);
  };

  function pushSub(onBack) {
    releaseSub();
    subLayer = pushLayer(() => {
      subLayer = null;
      onBack();
    });
  }
  function releaseSub() {
    if (!subLayer) return;
    const l = subLayer;
    subLayer = null;
    releaseLayer(l);
  }

  function showHint() {
    clearTimeout(hintTimer);
    hint.style.opacity = '1';
    hintTimer = setTimeout(() => {
      hint.style.opacity = '0';
    }, 3500);
  }

  function goHome() {
    releaseSub();
    if (audio) audio.stopMusic();
    resetRound();
    g.state = 'home';
    keys.left = false;
    keys.right = false;
    clearTimeout(hintTimer);
    hint.style.opacity = '0';
    const best = loadScores()[0];
    homeBest.textContent = best ? `Record: ${best.name} ${best.score}` : 'Nessun record';
    showScreen('home');
    last = 0;
  }

  function newGame() {
    if (screen !== 'home') return;
    feel('start', HAP.launch);
    startRound(true);
    last = 0;
    showHint();
  }

  // Classifica: 5 righe, posizioni vuote con trattini; la riga appena fatta è evidenziata
  function renderScores(hi) {
    const list = loadScores();
    const rankCol = ['#f4cf55', '#d6deee', '#d99a62', '#9fb4e8', '#9fb4e8'];
    scoresList.replaceChildren();
    for (let i = 0; i < MAX_SCORES; i++) {
      const e = list[i];
      const isHi = i === hi;
      const row = mk('div', {
        display: 'grid',
        gridTemplateColumns: '30px 1fr auto',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderRadius: '8px',
        fontSize: '26px',
        fontWeight: '700',
        letterSpacing: '.08em',
        background: isHi ? '#f4cf55' : 'rgba(255,255,255,.09)',
        color: isHi ? '#1a1a2e' : e ? '#fff' : 'rgba(255,255,255,.35)',
        textAlign: 'left',
      });
      row.append(
        mk('span', { color: isHi ? '#1a1a2e' : rankCol[i] }, String(i + 1)),
        mk('span', { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, e ? e.name : '---'),
        mk('span', null, e ? String(e.score) : '--')
      );
      scoresList.append(row);
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        row.animate([{ opacity: 0, transform: 'translateX(-14px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: 90 + i * 80, easing: 'ease-out', fill: 'backwards' });
      }
      if (audio) setTimeout(() => active && screen === 'scores' && audio.row(), 90 + i * 80); // un \"tic\" per ogni riga che compare
    }
  }

  function openScores(fromOver, hi = -1) {
    afterOver = fromOver;
    scoresBackBtn.style.display = fromOver ? 'none' : '';
    scoresRetryBtn.style.display = fromOver ? '' : 'none';
    scoresMenuBtn.style.display = fromOver ? '' : 'none';
    scoresTitle.textContent = hi === 0 ? 'Nuovo record!' : 'High score';
    showScreen('scores');
    renderScores(hi);
    if (!fromOver) {
      pushSub(() => leaveScores(true));
      feel('pauseOpen', HAP.tap);
    }
  }
  function leaveScores(fromBack) {
    if (screen !== 'scores') return;
    if (!fromBack) releaseSub();
    feel('back', HAP.back);
    goHome();
  }

  function setMenuMode(mode) {
    const inSettings = mode === 'settings';
    menuTitle.textContent = inSettings ? 'Impostazioni' : 'Pausa';
    resumeBtn.style.display = inSettings ? 'none' : '';
    quitBtn.style.display = inSettings ? 'none' : '';
    backBtn.style.display = inSettings ? '' : 'none';
  }
  function openSettings() {
    if (screen !== 'home') return;
    setMenuMode('settings');
    refreshMenu();
    showScreen('settings');
    menu.style.display = 'block';
    pushSub(() => closeSettings(true));
    feel('pauseOpen', HAP.pause);
  }
  function closeSettings(fromBack) {
    if (screen !== 'settings') return;
    if (!fromBack) releaseSub();
    menu.style.display = 'none';
    showScreen('home');
    feel('pauseClose', HAP.resume);
  }

  function showGameOver() {
    panelTitle.textContent = 'Game over';
    panelTitle.style.color = '#ff6b6b';
    panelScore.textContent = `Punteggio: ${g.score}`;
    const best = loadScores()[0];
    panelBest.textContent = best ? `Record: ${best.name} ${best.score}` : '';
    nameBox.style.display = 'none';
    overBtns.style.display = 'flex';
    panelInner.style.margin = 'auto';
    lockUntil = performance.now() + 700;
    showScreen('over');
    feel('gameOver', HAP.over, 3);
  }

  function beginNameEntry() {
    panelTitle.textContent = 'Nuovo record!';
    panelTitle.style.color = '#f4cf55';
    panelScore.textContent = `Punteggio: ${g.score}`;
    panelBest.textContent = '';
    nameBox.style.display = 'flex';
    overBtns.style.display = 'none';
    panelInner.style.margin = '10vh auto auto'; // in alto: la tastiera non copre il campo né il pulsante
    nameInput.value = lastName();
    prevLen = nameInput.value.length;
    lockUntil = performance.now() + 900;
    showScreen('over');
    feel('record', HAP.record, 3);
    setTimeout(() => {
      if (active && screen === 'over' && nameBox.style.display === 'flex') nameInput.focus();
    }, 1000);
  }

  let prevLen = 0;
  nameInput.addEventListener('input', () => {
    const raw = nameInput.value;
    const v = cleanName(raw);
    if (v !== raw) nameInput.value = v;
    if (v.length === prevLen && raw !== v) vib(HAP.keyFull, 1); // carattere non valido
    else if (v.length >= NAME_MAX && v.length > prevLen) {
      if (audio) audio.key(true);
      vib(HAP.keyFull, 1);
    } else feel('key', HAP.key, 1);
    prevLen = v.length;
  });
  function saveName() {
    if (locked() || screen !== 'over' || nameBox.style.display !== 'flex') return;
    const name = cleanName(nameInput.value).trim();
    if (!name) {
      feel('denied', HAP.denied);
      nameInput.animate([{ transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-5px)' }, { transform: 'none' }], { duration: 260 });
      nameInput.focus();
      return;
    }
    nameInput.blur();
    const pos = insertScore(name, g.score);
    feel('saved', HAP.saved);
    openScores(true, pos);
  }
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveName();
    }
  });
  saveBtn.addEventListener('click', saveName);

  newGameBtn.addEventListener('click', newGame);
  scoresBtn.addEventListener('click', () => {
    if (screen === 'home') openScores(false);
  });
  settingsBtn.addEventListener('click', openSettings);
  homeExitBtn.addEventListener('click', () => {
    if (screen !== 'home') return;
    feel('back', HAP.back);
    close(false);
  });
  scoresBackBtn.addEventListener('click', () => leaveScores(false));
  scoresRetryBtn.addEventListener('click', () => {
    if (screen !== 'scores') return;
    feel('click', HAP.tap);
    startRound(false);
    last = 0;
  });
  scoresMenuBtn.addEventListener('click', () => {
    if (screen !== 'scores') return;
    feel('back', HAP.back);
    goHome();
  });
  backBtn.addEventListener('click', () => closeSettings(false));

  pauseBtn.addEventListener('click', openPause);
  resumeBtn.addEventListener('click', closePause);
  quitBtn.addEventListener('click', () => {
    if (g.state !== 'paused') return;
    menu.style.display = 'none';
    feel('back', HAP.back);
    goHome();
  });
  hapticsSw.addEventListener('click', () => {
    if (effHaptics()) {
      vib(HAP.off, 2); // ultimo impulso, prima di spegnere
      prefs.haptics = false;
    } else {
      prefs.haptics = true;
      vib(HAP.on, 2);
    }
    refreshMenu();
    if (audio) (effHaptics() ? audio.toggleOn : audio.toggleOff)();
  });
  soundSw.addEventListener('click', () => {
    if (effSound()) {
      // il suono di "spento" deve sentirsi: si silenzia dopo che è finito
      prefs.sound = false;
      if (audio) audio.toggleOff();
      setTimeout(() => {
        if (graph) graph.syncMaster();
      }, 170);
      vib(HAP.off, 2);
    } else {
      prefs.sound = true;
      if (graph) graph.syncMaster();
      setTimeout(() => {
        if (audio && active) audio.toggleOn();
      }, 40);
      vib(HAP.on, 2);
    }
    refreshMenu();
  });
  for (const [k, b] of Object.entries(bgButtons)) b.addEventListener('click', () => setBg(k));

  // ---------- Input ----------
  function setTarget(clientX) {
    const rect = canvas.getBoundingClientRect();
    g.tcx = clamp((clientX - rect.left) / scale, g.bw / 2, W - g.bw / 2);
  }
  const onPointer = (e) => {
    if (g.state === 'paused') return;
    // Ignora i tocchi sui pulsanti del gioco; accetta tutto il resto (anche il dito
    // ancora appoggiato sul tasto della barra da cui è partita la pressione lunga).
    if (overlay.contains(e.target) && e.target.closest('button')) return;
    setTarget(e.clientX);
  };
  const onKeyDown = (e) => {
    if (e.target && e.target.tagName === 'INPUT') return; // si sta scrivendo il nome
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
      if (g.state === 'paused') closePause();
      else if (screen === 'settings') closeSettings(false);
      else if (screen === 'scores' && !afterOver) leaveScores(false);
      else openPause();
    } else if (g.state === 'paused') return;
    else if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = true;
    else if (e.key === 'ArrowRight' || e.key === 'd') keys.right = true;
  };
  const onKeyUp = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = false;
    else if (e.key === 'ArrowRight' || e.key === 'd') keys.right = false;
  };
  const onResize = () => {
    layout();
    layoutChar();
  };
  const onVisibility = () => {
    last = 0; // evita un salto di tempo al ritorno sulla pagina
    if (document.hidden) {
      openPause(); // se si esce dall'app il gioco va in pausa
      if (graph) graph.idle();
    } else {
      getGraph();
    }
  };
  // Le policy autoplay (soprattutto iOS) sbloccano l'audio solo dopo un gesto: lo si riprova a ogni tocco
  const unlockAudio = () => {
    if (graph && graph.ctx.state !== 'running' && !document.hidden) graph.ctx.resume().catch(() => {});
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
    clearTimeout(hintTimer);
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('pointerdown', onPointer);
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('pointerup', unlockAudio);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    vibStop();
    if (audio) audio.dispose();
    overlay.remove();
    if (!fromBack) {
      releaseSub();
      releaseLayer(layer);
    }
    // il motore audio resta acceso un attimo per non tagliare l'ultimo suono, poi si spegne
    setTimeout(() => {
      if (!active && graph) graph.idle();
    }, 450);
  }
  layer = pushLayer(() => close(true));

  exitBtn.addEventListener('click', () => {
    if (locked() || screen !== 'over') return;
    feel('back', HAP.back);
    goHome();
  });
  retryBtn.addEventListener('click', () => {
    if (locked() || screen !== 'over') return;
    feel('click', HAP.tap);
    startRound(false);
    last = 0;
  });

  layout();
  updateEnv(0, true); // lo sfondo parte già coerente con l'ora, senza transizione
  goHome(); // all'apertura compare la schermata iniziale
  if (fx) {
    // il gioco "salta fuori" mentre i frammenti dello schermo cadono
    wrap.animate([{ transform: 'scale(1.07)', filter: 'brightness(1.8)' }, { transform: 'scale(1)', filter: 'brightness(1)' }], { duration: 560, easing: 'ease-out' });
  }
  raf = requestAnimationFrame(frame);
}
