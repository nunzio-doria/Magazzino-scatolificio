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
// Due giochi: Rush (pesca i barattoli, con classifica) e Campagna (il personaggio
// cammina nel reparto e si arriva alla porta di uscita saltando e abbassandosi:
// 2 livelli, stelle in base ai cuori rimasti, progressi salvati sul dispositivo).
// Nella schermata iniziale cammina avanti e indietro un personaggio (4 pose
// disegnate dall'utente) che ogni tanto controlla l'orologio (toccandolo lo
// fa subito, con tic-tac).
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
  B: ['110', '101', '110', '101', '110'],
  D: ['110', '101', '101', '101', '110'],
  F: ['111', '100', '110', '100', '100'],
  H: ['101', '101', '111', '101', '101'],
  J: ['001', '001', '001', '101', '010'],
  K: ['101', '101', '110', '101', '101'],
  Q: ['010', '101', '101', '110', '011'],
  W: ['101', '101', '111', '111', '101'],
  X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'],
  Z: ['111', '001', '010', '100', '111'],
  '!': ['010', '010', '010', '000', '010'],
  '.': ['000', '000', '000', '000', '010'],
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
  star: ['...X...', '..XXX..', 'XXXXXXX', '.XXXXX.', '..XXX..', '.XX.XX.', '.X...X.'],
  lock: ['..XXXXX..', '.XX...XX.', '.X.....X.', '.X.....X.', 'XXXXXXXXX', 'XXXXXXXXX', 'XXXX.XXXX', 'XXXX.XXXX', 'XXXXXXXXX'],
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
  jump: [15], // stacco da terra
  duck: [15], // ci si abbassa
  hit: [45, 30, 45], // urto contro un ostacolo: due colpi secchi
  slam: [55], // la pressa batte vicino al personaggio
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

// ---------- Personaggio della home (4 pose disegnate dall'utente, ~48 px) ----------
// Camminata a 8 fotogrammi per passo: busto e gambe dalla posa di profilo,
// gambe intermedie ricavate spostando le due gambe dello sprite.
const CHAR_POSES = {
  front: [
    '.........ppppo.........',
    '.......wxuuussyx.......',
    '......xsppsspnsvA......',
    '......sjiiiigggmw......',
    '.....AnjiggggggipB.....',
    '.....vnjigggggijpw.....',
    '.....vpjgggggggjpx.....',
    '.....xnmqnigiqqmmx.....',
    '.....simpmjimppjmw.....',
    '....wqjnnijgjijmnqk....',
    '....snnjjjmgmiijmmf....',
    '.....nsjiijimggjms.....',
    '.....hsjgjjmjigjq......',
    '......smijjjjjims......',
    '......knjijjjiimp......',
    '.....xuonjiiijnpzB.....',
    '...AsekeppjimnvekfyA...',
    '..BffafaepwwwsebhaffA..',
    '..Aadafllfpnpfllhaeav..',
    '.vkacdbdekkclkfdcdeahB.',
    '.AeaehddcckokfefafeacB.',
    '.vaaflhfefclfhppolhcal.',
    '.obafrhhfhdkdekkdohabe.',
    'zfcchrfbaddhdefhdrkeadA',
    'AdbfolfeefdhdeeefovfabB',
    'AbaeAlccbbchdcbcdoAfaax',
    'paaeBkdbabchdcbaeoBfabk',
    'oaaepvffdabhdbbffxofaak',
    'ohkksBkfhffkhefefBolkhk',
    'AmiqAzyuvxxvvvvuxzBsiiA',
    'BgggwxvrrrrvtrrruyBiggs',
    'Bggnpvrrtttvvurrrxqmigs',
    'BjinAvrrrtzAzurrruAsiiw',
    '.BBBlvrrruxAvrrrrvABBA.',
    '....ovrrrrvAurrrrvA....',
    '....ourrrrvAurrrrvA....',
    '....ovrrrtvAurrrrxA....',
    '....oyrrrvxAuurrtzA....',
    '.....yvvxvxAutuvuz.....',
    '.....zvvvvxAutrruA.....',
    '.....ozxvvyAurrrrA.....',
    '.....ozzzyxAvzyyxA.....',
    '......AyyxwAxtuuuA.....',
    '......BpppqBzyqqAB.....',
    '.....BnjjnqBynnnnBh....',
    '.....BqmmqB.AnjjjnA....',
    '......BBBBB.BqqqqqB....',
    '............BBBBBBB....',
  ],
  stepA: [
    '...........ppppp.........',
    '.........yxvssssso.......',
    '........vvsqnpssswl......',
    '........xvnigggjjjs......',
    '.......BvpjgggggggmB.....',
    '.......zsnjjggggggjB.....',
    '.......yspnjggggggjB.....',
    '.......yssmjnqniijqB.....',
    '.......wwpjjlnqiisll.....',
    '.......nmqjjjjjjiqqA.....',
    '.......mqqjigggjijmp.....',
    '.......ljpjiigijjjjw.....',
    '........wqmjgiijnjm......',
    '........Bwmjgjjmnmn......',
    '........Bkpjjjijmjn......',
    '.......solenmjigimf......',
    '.......ldekhksljmk.......',
    '......Ahhbafkeouyl.......',
    '......Aldcabfklokl.......',
    '......BracbafabkkB.......',
    '......BobbbdldddkB.......',
    '......BhbbbeoeabhB.......',
    '......Becaakledaekf......',
    '......BebchrfebachA......',
    '......Bfbdkufbffdhz......',
    '......Bfaackkaaabhz......',
    '......BlaaafofabbhzB.....',
    '......BvhbadzhfdahwB.....',
    '......BzkefelkeeekqmB....',
    '......BzveesmwyvuznmB....',
    '......BzAAjggjArtwnmB....',
    '.......zxqgggnwrrzpB.....',
    '.......Bvwigjnorrzl......',
    '......ByzvzAAuoortl......',
    '......Axvzvuttrrrrz......',
    '......AvvxAutrtrrrz......',
    '.....vzuvxxzutrtrrts.....',
    '....lAvxxxxAyuttrruu.....',
    '...lAuuvvxyzfzvttrrz.....',
    '...AuuvvvvAh.Avrtrrzh....',
    '..AvuxvvxAh..Byttrrvo....',
    '.Bxuxxxxz.....zuorrvA....',
    'AppyvvxA......AuruutzAAA.',
    'Bpnszvyz......AyxttznqjmB',
    '.BqnpBB.......yxuysnjjmpz',
    '..Aqmmqy.......BBnmnnnsB.',
    '..BpqqqB........BssABy...',
    '...BBBAB........BBB......',
  ],
  stepB: [
    '...........moopp.........',
    '.........wywvsssxv.......',
    '........xvssqpnpssw......',
    '.......fvrpnigggjjmm.....',
    '.......zvppjiggggggw.....',
    '.......zuppjiggggggq.....',
    '.......zvppnjggggggj.....',
    '.......Avusmjqqqigmw.....',
    '.......Bwspjjlwsmisq.....',
    '.......Bqnqjmjnmmgss.....',
    '.......Binqjijggmgnm.....',
    '........piqjiggimmnw.....',
    '........Bqqmiggiinnw.....',
    '........wzpnjijjnnnA.....',
    '........Bhfsmmjijnn......',
    '.......ulkkesnmjiis......',
    '.......yfeflefspqq.......',
    '......ykdbahkdhhA........',
    '......zhaaaafkklo........',
    '......AfaabehaaekB.......',
    '......vdaaafocffkx.......',
    '.....wkaaadkhdffhv.......',
    '.....xhaachohccafh.......',
    '.....xhahkrkhdhhahA......',
    '.....AkbaeokhabbbhA......',
    '......yaabhukdaabhA......',
    '......BfaaetkfbachA......',
    '......BkaabhlhfhhhB......',
    '......Bxcdfhvytfekpw.....',
    '......BAkdenwyuruznB.....',
    '......BzAqjgjsrruznB.....',
    '.......AwiggnyrrrAsn.....',
    '......BAwmgijyrrryA......',
    '......ByzzBAAtrrrrA......',
    '......BxxAyutrtrrrz......',
    '......AvxxAutrrrrry......',
    '.....vyxvxxzvtrtrrrz.....',
    '....vzvvxxxzAvttrrrA.....',
    '...ozvuxxxxAlzvrtrrz.....',
    '..pAvvxxxxAk.Avttrrz.....',
    '.sByvxxxxAk..Axttrrx.....',
    '.wpxvxxyAf....ztorrrA....',
    '.qnszxyA......zurtrvB....',
    '.wqnwBAv......AyxrrvBzAB.',
    '.BsnqwB.......BxvyyqqmjjB',
    '..Apmmql.......AwnnmmjmnB',
    '..BwqqpB.......BsqqqqssBp',
    '...BBBBB........BBBppm...',
  ],
  back: [
    '..........psssp.........',
    '........wzuuuuxAw.......',
    '.......wvputvvuvvz......',
    '......osppppspppsx......',
    '......xpppppppppppA.....',
    '.....pvpppppppppppB.....',
    '.....pvppppppppppvB.....',
    '.....pvppppppppppvB.....',
    '.....ovuspppppppsvA.....',
    '.....wsussppppsvuul.....',
    '.....wmvuuuuuuuuusm.....',
    '.....hwssuuuuuuuvmw.....',
    '......zssuvsssuspw......',
    '.......wnwwssswps.......',
    '.......BweccdddpA.......',
    '.....oBolkkkkkkkoBv.....',
    '....wohccbbcccbaaeoA....',
    '...Afecccccccccbcbbdy...',
    '..wkcecbcccccccbccdabB..',
    '..AdafcbccccccccccfaaA..',
    '..tachbbccccccbbbbhaak..',
    '.Ahaekbbccccccccbalfadz.',
    '.Aeaetacccccccccccofaby.',
    '.oaafucccccccccccbufaals',
    '.kachvdbcccccccccaufaahy',
    'kkeckzkacccccccccfxhddhy',
    'khhhhzkdbcccccccehyhffhz',
    'khhhhylkfdcddcdfklyhffhy',
    '.khhlAkddddddddafhAofflx',
    '.vkhkAxutuuuuuuutuApffrz',
    '.pjnnAuorrroooooouAnnml.',
    '.qjnnAutrrroooooruAqqml.',
    '.wmnsAuuuuuutttttvAwmjw.',
    '..ABwvuuvxyzzxvvvvA.BB..',
    '.....wuuuuvxBxxvvvB.....',
    '.....wuuuuvxBxvvvvB.....',
    '.....wuuuuvxBxvvvvB.....',
    '.....vvuvvxxBzxxvvB.....',
    '.....syvutuxBxrrrvB.....',
    '......zrrorxAxyxux......',
    '......zrrrrxAvrrvy......',
    '......zurrtyBwsswx......',
    '......zvvvvxApqqnA......',
    '......yvvvvxAsqqqw......',
    '.......wwwwABsqqqw......',
    '......snmmnwAwqqqw......',
    '......sqqqqw.zsssA......',
    '......oBBBBB............',
  ],
};
const CHAR_PAL = { a: '#ecf6f8', b: '#eaf4f6', c: '#e9f2f5', d: '#e5f0f3', e: '#d7e0e3', f: '#bec6cb', g: '#f2b18a', h: '#acb5bb', i: '#dd9d7d', j: '#c38266', k: '#969da3', l: '#8f7d76', m: '#946859', n: '#7e5044', o: '#454b5e', p: '#543f40', q: '#55332f', r: '#384059', s: '#3c2c2f', t: '#2a344f', u: '#27293c', v: '#212233', w: '#22161c', x: '#181522', y: '#13131f', z: '#0c0e1a', A: '#08080f', B: '#070408', G: '#f4cf55', W: '#fff6c8', D: '#2b2f3a', Y: '#ffffff' };
const CHAR_W = 28;
const CHAR_H = 48;
const CHAR_STEP = 15; // pixel percorsi dal corpo in un passo: tiene il piede d'appoggio fermo a terra
const CHAR_FRAMES = 12; // fotogrammi per passo
const CHAR_CYCLE = CHAR_FRAMES * 2; // il ciclo completo sono due passi (le braccia si scambiano)
const LEG_TOP = 39;

const charBlank = () => Array.from({ length: CHAR_H }, () => Array(CHAR_W).fill('.'));
const charPut = (out, x, y, c) => {
  if (c && c !== '.' && x >= 0 && x < CHAR_W && y >= 0 && y < CHAR_H) out[y][x] = c;
};
function charRuns(str) {
  const r = [];
  let s = -1;
  for (let x = 0; x <= str.length; x++) {
    const on = x < str.length && str[x] !== '.';
    if (on && s < 0) s = x;
    if (!on && s >= 0) {
      r.push([s, x - 1]);
      s = -1;
    }
  }
  return r;
}
// ---- Gambe: dal bacino (riga 34) al piede (riga 47), coscia compresa ----
// Ogni gamba ha tre posizioni chiave per riga: dietro (u = -1), sotto il bacino (u = 0) e davanti (u = +1);
// in mezzo si interpolano gli estremi della riga, quindi coscia, ginocchio e piede si muovono insieme.
const HIP_Y = 34; // prima riga della coscia (sopra c'è il busto)
const FOOT_Y = CHAR_H - 1;
const HIP_X = 12; // colonna che separa la gamba dietro da quella davanti nelle cosce

function charLegSet(poseRows, footRows) {
  const rows = [];
  for (let y = HIP_Y; y <= FOOT_Y; y++) {
    if (y < LEG_TOP) {
      const r = charRuns(poseRows[y]);
      const l = r[0][0];
      const rr = r[r.length - 1][1];
      rows.push({ y, row: poseRows[y], back: [l, HIP_X], front: [HIP_X + 1, rr] });
    } else {
      const r = charRuns(footRows[y]);
      rows.push({ y, row: footRows[y], back: r[0], front: r[r.length - 1] });
    }
  }
  return rows;
}
const LEGS_A = charLegSet(CHAR_POSES.stepA, CHAR_POSES.stepA);
const LEGS_B = charLegSet(CHAR_POSES.stepA, CHAR_POSES.stepB);

// Gamba verticale sotto il bacino: coscia un po' più stretta del bacino, poi il piede della gamba davanti
const legRest = (e) => {
  if (e.y < LEG_TOP) {
    const t = (e.y - HIP_Y) / (LEG_TOP - HIP_Y);
    return [Math.round(7 + 2 * t), Math.round(18 - 2 * t)];
  }
  return [e.front[0] - 4, e.front[1] - 4];
};

// u: -1 dietro .. +1 davanti; lift: righe di sollevamento del piede; il ginocchio va avanti e il piede resta indietro
function charLeg(out, set, u, lift) {
  const fwd = Math.round(lift * 0.6);
  const bend = Math.round(lift * 0.7);
  const t = Math.abs(u);
  for (const e of set) {
    const rest = legRest(e);
    const src = u >= 0 ? e.front : e.back;
    let sh;
    if (e.y <= LEG_TOP) sh = (fwd * (e.y - HIP_Y)) / (LEG_TOP - HIP_Y); // il ginocchio avanza
    else sh = fwd - ((fwd + bend) * (e.y - LEG_TOP)) / (FOOT_Y - LEG_TOP); // la caviglia torna indietro
    const tl = Math.round(rest[0] + (src[0] - rest[0]) * t + sh);
    const tr = Math.round(rest[1] + (src[1] - rest[1]) * t + sh);
    const tw = Math.max(1, tr - tl);
    const sw = src[1] - src[0];
    const dy = lift > 0 ? Math.round((lift * Math.min(1, (e.y - HIP_Y + 1) / (FOOT_Y - HIP_Y + 1)))) : 0;
    for (let x = tl; x <= tr; x++) charPut(out, x + 1, e.y - dy, e.row[src[0] + Math.round(((x - tl) * sw) / tw)]);
  }
}

const charStamp = (out, rows, offX, y0, y1, dy) => {
  for (let y = y0; y <= y1; y++) for (let x = 0; x < rows[y].length; x++) charPut(out, x + offX, y + dy, rows[y][x]);
};

// Gamba nella fase phi (0..1) di un ciclo di due passi: appoggio da +1 (davanti) a -1 (dietro),
// poi oscillazione col ginocchio piegato fino al nuovo contatto.
function legAt(phi) {
  if (phi < 0.5) {
    const u = 1 - 4 * phi;
    if (phi < 0.06) return { set: LEGS_A, u, lift: 0 }; // tallone a terra
    return { set: u >= 0 ? LEGS_B : LEGS_A, u, lift: 0 }; // piede piatto, poi si stacca da dietro
  }
  const p = phi - 0.5;
  const u = -1 + 4 * p;
  const lift = Math.round(3 * Math.sin(Math.PI * clamp((p - 0.02) / 0.46, 0, 1)));
  if (p < 0.12) return { set: LEGS_B, u, lift }; // spinta: tallone alzato
  if (u < 0) return { set: LEGS_A, u, lift };
  if (p < 0.43) return { set: LEGS_B, u, lift };
  return { set: LEGS_A, u, lift: 0 };
}

// k = 0..CHAR_CYCLE-1: due passi (le braccia si scambiano tra il primo e il secondo).
// Busto: sale e scende, la testa lo segue con un attimo di ritardo e si china in avanti al contatto;
// le mani oscillano in opposizione alle gambe.
function buildWalkFrame(k) {
  const psi = (k % CHAR_CYCLE) / CHAR_CYCLE;
  const out = charBlank();
  const l1 = legAt(psi);
  const l2 = legAt((psi + 0.5) % 1);
  // la gamba che oscilla va disegnata sopra quella d'appoggio
  const order = psi < 0.5 ? [l1, l2] : [l2, l1];
  for (const l of order) charLeg(out, l.set, l.u, l.lift);

  const stepT = (psi * 2) % 1; // posizione nel passo
  const up = (t) => {
    const f = ((t % 1) + 1) % 1;
    return f > 0.3 && f < 0.7;
  };
  const bob = up(stepT) ? 1 : 0;
  const headBob = up(stepT - 0.08) ? 1 : 0;
  const nod = stepT < 0.25 || stepT > 0.9 ? 1 : 0; // la testa va avanti di un pixel al contatto
  const S = CHAR_POSES.stepA;

  // busto (righe 0..33), senza le mani che oscillano
  const near = { x0: 8, x1: 14, y0: 28, y1: 33 };
  const far = { x0: 16, x1: 20, y0: 27, y1: 33 };
  const inBlock = (b, x, y) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  for (let y = 17; y <= 19; y++) for (let x = 0; x < S[y].length; x++) charPut(out, x + 1, y, S[y][x]); // base del collo: nessuno spiraglio tra testa e busto
  for (let y = 0; y < HIP_Y; y++) {
    const dy = y <= 17 ? -headBob : -bob;
    const dx = y <= 15 ? nod : 0;
    for (let x = 0; x < S[y].length; x++) {
      let c = S[y][x];
      if (inBlock(near, x, y)) c = (y >= 31 && x <= 11 ? S[y][7] : S[y][15]) || '.'; // dove c'era la mano: si vede il busto
      else if (inBlock(far, x, y)) c = x <= 17 ? S[y][15] || '.' : '.';
      charPut(out, x + 1 + dx, y + dy, c);
    }
  }
  if (bob) for (let x = 0; x < S[HIP_Y - 1].length; x++) charPut(out, x + 1, HIP_Y - 1, S[HIP_Y - 1][x]); // chiude il vuoto in vita

  // mani: quella vicina va avanti quando la gamba vicina è indietro; la lontana al contrario
  const sw = -Math.round(2 * Math.cos(2 * Math.PI * psi));
  const hand = (b, dx, dy) => {
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) charPut(out, x + 1 + dx, y - bob + dy, S[y][x]);
  };
  hand(far, -sw, 0);
  hand(near, sw, sw > 0 ? -1 : 0);
  return out;
}

// Posa frontale (p.watch: avambraccio destro alzato a guardare l'orologio; p.glint: luccichio del quadrante)
function buildFrontFrame(p) {
  const S = CHAR_POSES.front;
  const out = charBlank();
  const X = 2;
  for (let y = 0; y < CHAR_H; y++) {
    for (let x = 0; x < S[y].length; x++) {
      if (p.watch && y >= 25 && x >= 18) continue; // l'avambraccio viene ridisegnato sotto
      charPut(out, x + X, y, S[y][x]);
    }
  }
  if (p.watch) {
    const Y0 = 24;
    for (let v = 0; v < 10; v++) for (let u = 0; u < 5; u++) charPut(out, 22 - v + X, Y0 + u, S[24 + v][18 + u]);
    for (let j = 0; j < 5; j++) charPut(out, 20 + X, Y0 + j, 'D'); // cinturino
    for (let j = 1; j <= 3; j++) {
      charPut(out, 18 + X, Y0 + j, 'G');
      charPut(out, 19 + X, Y0 + j, 'G');
    }
    charPut(out, 19 + X, Y0 + 2, p.glint ? 'Y' : 'W');
  }
  return out;
}
const buildBackFrame = () => {
  const out = charBlank();
  charStamp(out, CHAR_POSES.back, 2, 0, CHAR_H - 1, 0);
  return out;
};


// Posa abbassata (alta 40 px): stesse gambe della camminata, busto accorciato di 8 righe e testa/spalle in avanti
const CROUCH_DROP = new Set([20, 21, 22, 23, 24, 25, 26, 27]);
function buildCrouchFrame(k) {
  const rows = [];
  buildWalkFrame(k).forEach((r, y) => {
    if (CROUCH_DROP.has(y)) return;
    if (y >= 20) return rows.push(r);
    const lean = Array(CHAR_W).fill('.'); // righe di testa e spalle: 2 pixel avanti
    for (let x = 0; x < CHAR_W - 2; x++) lean[x + 2] = r[x];
    rows.push(lean);
  });
  const pad = Array.from({ length: CHAR_H - rows.length }, () => Array(CHAR_W).fill('.'));
  return pad.concat(rows);
}

// ---------- Campagna: livelli e regole (nessun disegno qui) ----------
// Il personaggio cammina da solo verso destra. Si salta (tocco) e ci si abbassa (dito
// premuto in basso, più lento). Distanze in pixel di gioco, altezze dal pavimento.
const CAMP_KEY = 'magazzino-minigame-campaign';
const C_GRAV = 300;
const C_JUMP = 160; // velocità iniziale del salto: altezza massima ~43 px, in aria ~1 s
const C_HIT_HALF = 4; // metà larghezza del corpo che può essere colpito
const C_H_STAND = 44;
const C_H_DUCK = 34; // sprite abbassato: 40 px
const C_DUCK_SPEED = 0.5;
const C_INV = 1.4; // secondi di invulnerabilità dopo un colpo
const DOOR_GAP = 6; // distanza della porta dal traguardo
const DOOR_W = 34;
const DOOR_H = 60; // più alta del personaggio (48 px)
const WIN_WALK = 1.0; // secondi per entrare nella porta
const PRESS = { T: 2.0, up0: 0.3, warn0: 1.25, slam0: 1.65, slam1: 1.77, w: 22 };

// Altezza (dal pavimento) del bordo basso della pressa nell'istante tp del suo ciclo
function pressBottom(tp) {
  if (tp < PRESS.up0) return 62 * (tp / PRESS.up0); // risale dopo la battuta
  if (tp < PRESS.warn0) return 62; // alta: si passa
  if (tp < PRESS.slam0) return 62 - 28 * ((tp - PRESS.warn0) / (PRESS.slam0 - PRESS.warn0)); // avviso: scende piano, lampeggia
  if (tp < PRESS.slam1) return 34 * (1 - (tp - PRESS.slam0) / (PRESS.slam1 - PRESS.slam0)); // battuta
  return 0; // a terra
}

const OB = {
  crate: (x) => ({ k: 'crate', x, w: 14, lo: 0, hi: 14 }),
  tall: (x) => ({ k: 'tall', x, w: 12, lo: 0, hi: 20 }),
  oil: (x) => ({ k: 'oil', x, w: 18, lo: 0, hi: 3 }),
  beam: (x) => ({ k: 'beam', x, w: 38, lo: 38, hi: 50 }),
  // o (scostamento del ciclo) si calcola dopo, in base a quando arriva il personaggio
  press: (x) => ({ k: 'press', x, w: PRESS.w, lo: 0, hi: 300, o: 0, tp: 0 }),
};

// Secondi per arrivare a x camminando e abbassandosi solo sotto i tubi bassi (da 14 px prima a 6 dopo)
function campArrival(obs, speed, x) {
  let t = 0;
  let pos = 0;
  const spans = obs.filter((o) => o.k === 'beam').map((o) => [o.x - 14, o.x + o.w + 6]);
  for (const [a, b] of spans) {
    if (a >= x) break;
    t += (a - pos) / speed;
    const end = Math.min(b, x);
    t += (end - a) / (speed * C_DUCK_SPEED);
    pos = end;
  }
  return t + (x - pos) / speed;
}
// Imposta la fase di ogni pressa: chi cammina senza fermarsi arriva mentre sta scendendo (colpo):
// bisogna abbassarsi in anticipo per rallentare e passare quando è alta
function tunePresses(obs, speed) {
  for (const o of obs) {
    if (o.k !== 'press') continue;
    const arr = campArrival(obs, speed, o.x - C_HIT_HALF);
    o.o = (((1.5 - arr) % PRESS.T) + PRESS.T) % PRESS.T;
  }
  return obs;
}

function buildCampLevels() {
  const s1 = 52;
  const s2 = 62;
  const lv = [
    {
      id: 1,
      name: 'Magazzino',
      sub: 'Casse, pozze e tubi bassi',
      theme: 'wh',
      len: 1400,
      speed: s1,
      obs: [OB.crate(230), OB.crate(330), OB.oil(440), OB.tall(560), OB.beam(690), OB.crate(830), OB.oil(920), OB.beam(1030), OB.tall(1130), OB.crate(1230)],
      pick: [
        { k: 'coil', x: 237, h: 52 },
        { k: 'coil', x: 451, h: 50 },
        { k: 'coil', x: 566, h: 58 },
        { k: 'wrench', x: 770, h: 54 },
        { k: 'coil', x: 837, h: 52 },
        { k: 'coil', x: 1136, h: 58 },
        { k: 'coil', x: 1237, h: 52 },
      ],
      tips: [
        { x: 70, to: 215, lines: ['TOCCA PER SALTARE'] },
        { x: 600, to: 720, lines: ['TIENI PREMUTO IN BASSO', 'PER ABBASSARTI'] },
      ],
    },
    {
      id: 2,
      name: 'Saldatura e presse',
      sub: 'Presse a tempo e tubi bassi',
      theme: 'fa',
      len: 1900,
      speed: s2,
      obs: [
        OB.crate(220),
        OB.beam(330),
        OB.press(480),
        OB.tall(610),
        OB.oil(700),
        OB.beam(810),
        OB.crate(915),
        OB.press(1040),
        OB.tall(1160),
        OB.beam(1270),
        OB.press(1420),
        OB.crate(1540),
        OB.oil(1620),
        OB.beam(1720),
      ],
      pick: [
        { k: 'coil', x: 227, h: 52 },
        { k: 'coil', x: 616, h: 58 },
        { k: 'wrench', x: 760, h: 54 },
        { k: 'coil', x: 921, h: 52 },
        { k: 'coil', x: 1166, h: 58 },
        { k: 'coil', x: 1546, h: 52 },
        { k: 'coil', x: 1631, h: 50 },
      ],
      tips: [{ x: 330, to: 500, lines: ['LE PRESSE BATTONO A TEMPO', 'ABBASSATI PER RALLENTARE'] }],
    },
  ];
  // Più veloce = più lungo: le distanze in secondi tra gli ostacoli restano le stesse
  const stretch = (l, k) => {
    l.len = Math.round(l.len * k);
    l.obs.forEach((o) => (o.x = Math.round(o.x * k)));
    l.pick.forEach((p) => (p.x = Math.round(p.x * k)));
    l.tips.forEach((t) => {
      t.x = Math.round(t.x * k);
      t.to = Math.round(t.to * k);
    });
  };
  stretch(lv[0], s1 / 38);
  stretch(lv[1], s2 / 44);
  for (const l of lv) tunePresses(l.obs, l.speed);
  return lv;
}
const CAMP_LEVELS = buildCampLevels();

function newCamp(lv) {
  const def = CAMP_LEVELS[lv];
  return {
    lv,
    def,
    len: def.len,
    speed: def.speed,
    obs: def.obs.map((o) => ({ ...o })),
    pick: def.pick.map((p) => ({ ...p, got: false })),
    x: 0,
    pf: 0, // altezza dei piedi dal pavimento
    vy: 0,
    duck: false,
    hearts: MAX_LIVES,
    inv: 0,
    jumpBuf: 0,
    score: 0,
    t: 0,
    walkD: 0,
    state: 'run', // run | win | dead
    endT: 0,
  };
}

// Un passo di gioco. inp = { jump: true solo nel fotogramma del tocco, crouch: dito premuto }.
// Restituisce gli eventi (per suoni, vibrazioni e particelle): { k, ... }
function campStep(c, dt, inp) {
  const ev = [];
  c.t += dt;
  if (c.state !== 'run') {
    c.endT += dt;
    return ev;
  }
  c.inv = Math.max(0, c.inv - dt);
  c.jumpBuf = Math.max(0, c.jumpBuf - dt);
  if (inp.jump) c.jumpBuf = 0.12; // se si tocca un attimo prima di atterrare, il salto parte lo stesso

  // Abbassarsi (solo a terra)
  // Sotto un tubo basso non ci si rialza: si resta abbassati finché si è sotto
  const underBeam = c.duck && c.obs.some((o) => o.k === 'beam' && c.x + C_HIT_HALF > o.x + 1 && c.x - C_HIT_HALF < o.x + o.w - 1);
  const wantDuck = (!!inp.crouch || underBeam) && c.pf <= 0;
  if (wantDuck !== c.duck) {
    c.duck = wantDuck;
    ev.push({ k: wantDuck ? 'duck' : 'rise' });
  }
  // Salto
  if (c.pf <= 0 && c.vy <= 0 && c.jumpBuf > 0) {
    c.vy = C_JUMP;
    c.pf = 0.01;
    c.jumpBuf = 0;
    if (c.duck) {
      c.duck = false;
      ev.push({ k: 'rise' });
    }
    ev.push({ k: 'jump' });
  }
  if (c.pf > 0 || c.vy > 0) {
    c.pf += c.vy * dt;
    c.vy -= C_GRAV * dt;
    if (c.pf <= 0) {
      c.pf = 0;
      c.vy = 0;
      ev.push({ k: 'land' });
    }
  }
  const sp = c.speed * (c.duck ? C_DUCK_SPEED : 1);
  c.x += sp * dt;
  c.walkD += sp * dt;

  // Presse: avviso e battuta (con la distanza dal personaggio, per il volume)
  const hh = c.duck ? C_H_DUCK : C_H_STAND;
  const top = c.pf + hh;
  for (const o of c.obs) {
    if (o.k !== 'press') continue;
    const prev = o.tp;
    o.tp = (c.t + o.o) % PRESS.T;
    const cross = (a) => (prev < a && o.tp >= a) || (prev > o.tp && (a <= o.tp || a > prev));
    const d = o.x + o.w / 2 - c.x;
    if (cross(PRESS.warn0)) ev.push({ k: 'warn', d });
    if (cross(PRESS.slam0)) ev.push({ k: 'slam', d });
  }

  // Urti
  if (c.inv <= 0) {
    for (const o of c.obs) {
      if (c.x + C_HIT_HALF <= o.x + 1 || c.x - C_HIT_HALF >= o.x + o.w - 1) continue;
      const lo = o.k === 'press' ? pressBottom(o.tp) : o.lo;
      if (c.pf < o.hi - 1 && top > lo + 1 && (o.k !== 'press' || top > lo)) {
        c.hearts -= 1;
        c.inv = C_INV;
        ev.push({ k: 'hit', what: o.k });
        if (c.hearts <= 0) {
          c.state = 'dead';
          c.endT = 0;
          ev.push({ k: 'dead' });
        }
        break;
      }
    }
  }
  if (c.state !== 'run') return ev;

  // Bonus
  for (const p of c.pick) {
    if (p.got || Math.abs(p.x - c.x) > 7) continue;
    if (p.h < top && p.h + 10 > c.pf) {
      p.got = true;
      if (p.k === 'coil') {
        c.score += 5;
        ev.push({ k: 'coil', x: p.x, h: p.h });
      } else if (c.hearts < MAX_LIVES) {
        c.hearts += 1;
        ev.push({ k: 'wrench', life: true, x: p.x, h: p.h });
      } else {
        c.score += 3;
        ev.push({ k: 'wrench', life: false, x: p.x, h: p.h });
      }
    }
  }

  if (c.x >= c.len) {
    c.state = 'win';
    c.endT = 0;
    ev.push({ k: 'win' });
  }
  return ev;
}

function loadCamp() {
  try {
    const raw = JSON.parse(localStorage.getItem(CAMP_KEY) || '{}');
    const st = Array.isArray(raw.stars) ? raw.stars : [];
    return { stars: CAMP_LEVELS.map((_, i) => clamp(Math.floor(Number(st[i]) || 0), 0, 3)) };
  } catch (_) {
    return { stars: CAMP_LEVELS.map(() => 0) };
  }
}
// Salva le stelle migliori; il livello successivo si sblocca col precedente completato
function saveCampStars(lv, stars) {
  const cur = loadCamp();
  cur.stars[lv] = Math.max(cur.stars[lv], stars);
  try {
    localStorage.setItem(CAMP_KEY, JSON.stringify(cur));
  } catch (_) {
    /* memoria piena o bloccata: i progressi valgono solo per questa sessione */
  }
  return cur;
}
const campUnlocked = (prog, lv) => lv === 0 || prog.stars[lv - 1] > 0;

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
    // --- Campagna ---
    // Salto: glissando verso l'alto
    jump() {
      tone(sfxBus, at(), { type: 'square', f: 330, f2: 660, dur: 0.11, vol: 0.09 });
    },
    // Atterraggio: colpo sordo
    land() {
      const t = at();
      tone(sfxBus, t, { type: 'sine', f: 120, f2: 60, dur: 0.08, vol: 0.14 });
      noise(sfxBus, t, { dur: 0.06, vol: 0.08, kind: 'lowpass', freq: 500 });
    },
    // Ci si abbassa: fruscio che scende; ci si rialza: fruscio che sale
    duck() {
      noise(sfxBus, at(), { dur: 0.1, vol: 0.07, kind: 'bandpass', freq: 1600, freq2: 500 });
    },
    rise() {
      noise(sfxBus, at(), { dur: 0.1, vol: 0.06, kind: 'bandpass', freq: 500, freq2: 1600 });
    },
    // Urto: botto metallico
    hit() {
      const t = at();
      tone(sfxBus, t, { type: 'sawtooth', f: 200, f2: 70, dur: 0.26, vol: 0.2 });
      tone(sfxBus, t, { type: 'square', f: 1568, dur: 0.03, vol: 0.08 });
      noise(sfxBus, t, { dur: 0.2, vol: 0.18, kind: 'bandpass', freq: 1100 });
    },
    // Pressa che sta per battere: due bip (più deboli se è lontana)
    warn(v = 1) {
      const t = at();
      tone(sfxBus, t, { type: 'square', f: 1320, dur: 0.05, vol: 0.07 * v });
      tone(sfxBus, t + 0.09, { type: 'square', f: 1320, dur: 0.05, vol: 0.07 * v });
    },
    // Battuta della pressa: tonfo e colpo di lamiera
    slam(v = 1) {
      const t = at();
      tone(sfxBus, t, { type: 'sine', f: 110, f2: 38, dur: 0.32, vol: 0.26 * v });
      noise(sfxBus, t, { dur: 0.22, vol: 0.2 * v, kind: 'lowpass', freq: 700 });
      noise(sfxBus, t, { dur: 0.06, vol: 0.08 * v, kind: 'highpass', freq: 5000 });
    },
    // Livello completato: arpeggio e accordo
    win() {
      const t = at() + 0.05;
      [72, 76, 79, 84].forEach((n, k) => tone(sfxBus, t + k * 0.1, { type: 'square', f: mtof(n), dur: 0.1, vol: 0.12 }));
      const t2 = t + 0.45;
      tone(sfxBus, t2, { type: 'triangle', f: mtof(72), dur: 0.6, vol: 0.15 });
      tone(sfxBus, t2, { type: 'triangle', f: mtof(79), dur: 0.6, vol: 0.12 });
      tone(sfxBus, t2, { type: 'sine', f: mtof(96), dur: 0.5, vol: 0.06 });
      noise(sfxBus, t2, { dur: 0.3, vol: 0.05, kind: 'highpass', freq: 8000 });
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

  // Home (menu principale: Rush, Campagna, Impostazioni)
  const homeScr = mkScreen('rgba(5,8,20,.32)');
  const titleStyle = { fontSize: '56px', lineHeight: '.95', fontWeight: '700', letterSpacing: '.05em', color: '#f4cf55', textShadow: '0 4px 0 rgba(0,0,0,.6)' };
  const homeTitle = mk('div', titleStyle);
  homeTitle.append(mk('div', null, 'Arcade'), mk('div', { fontSize: '30px', color: '#fff' }, 'del magazzino'));
  const rushBtn = wide(pixelButton('Rush', true));
  const campBtn = wide(pixelButton('Campagna', true));
  const settingsBtn = wide(pixelButton('Impostazioni', false));
  const homeExitBtn = wide(pixelButton('Esci', false));
  const quietBtn = (b) => {
    b.style.background = 'transparent';
    b.style.borderColor = 'rgba(255,255,255,.2)';
    b.style.color = '#cbd5e8';
    return b;
  };
  quietBtn(homeExitBtn);
  const homeBtns = mk('div', { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', marginTop: '8px' });
  homeBtns.append(rushBtn, campBtn, settingsBtn, homeExitBtn);
  homeScr.inner.append(homeTitle, homeBtns);
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

  // Rush (pesca i barattoli)
  const rushScr = mkScreen('rgba(5,8,20,.5)');
  const rushTitle = mk('div', titleStyle);
  rushTitle.append(mk('div', null, 'Rush'), mk('div', { fontSize: '24px', color: '#fff', letterSpacing: '.08em' }, 'pesca i barattoli'));
  const homeBest = mk('div', { fontSize: '18px', fontWeight: '600', letterSpacing: '.08em', color: '#cbd5e8', minHeight: '22px', textShadow: '0 2px 0 rgba(0,0,0,.6)' }, '');
  const newGameBtn = wide(pixelButton('Nuova partita', true));
  const scoresBtn = wide(pixelButton('High score', false));
  const rushBackBtn = quietBtn(wide(pixelButton('Indietro', false)));
  const rushBtns = mk('div', { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', marginTop: '8px' });
  rushBtns.append(newGameBtn, scoresBtn, rushBackBtn);
  rushScr.inner.append(rushTitle, homeBest, rushBtns);

  // Campagna: scelta del livello
  const levelsScr = mkScreen('rgba(5,8,20,.5)');
  const levelsTitle = mk('div', { ...titleStyle, fontSize: '46px' }, 'Campagna');
  const levelsList = mk('div', { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' });
  const levelsBackBtn = quietBtn(wide(pixelButton('Indietro', false)));
  levelsScr.inner.append(levelsTitle, levelsList, levelsBackBtn);

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
  const panelStars = mk('div', { display: 'none', gap: '8px', justifyContent: 'center' });
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
  const nextBtn = wide(pixelButton('Livello successivo', true));
  nextBtn.style.display = 'none';
  overBtns.append(nextBtn, retryBtn, exitBtn);
  panelInner.append(panelTitle, panelScore, panelStars, panelBest, nameBox, overBtns);

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

  wrap.append(canvas, hint, pauseBtn, homeScr.scr, rushScr.scr, levelsScr.scr, scoresScr.scr, panel, menu);
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
    mode: 'rush', // rush | camp
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
    g.mode = 'rush';
    camp = null;
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
    if (g.mode === 'camp' && camp) {
      drawCamp();
      return;
    }

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

  // ---------- Campagna ----------
  let camp = null;
  let campProg = loadCamp();
  let campIntro = 0;
  let campShake = 0;
  let campDone = false; // il pannello finale è già comparso
  const campIn = { jumpQ: false, crouch: false };
  const cp = { parts: [], pops: [] };
  const hold = { on: false, lower: false, fired: false, timer: 0 };
  const HOLD_MS = 110; // tocco breve = salto; dito premuto in basso = abbassati

  const floorY = () => Math.round(clamp(H * 0.66, 125, H - 34)); // linea del pavimento
  const heroX = () => Math.round(W * 0.3); // colonna fissa del personaggio: scorre il mondo

  const campActive = () => g.mode === 'camp' && camp && camp.state === 'run' && g.state === 'play';
  const onCampDown = (e) => {
    if (!campActive()) return;
    if (overlay.contains(e.target) && e.target.closest('button')) return;
    const r = canvas.getBoundingClientRect();
    hold.on = true;
    hold.fired = false;
    hold.lower = e.clientY - r.top > r.height * 0.5;
    clearTimeout(hold.timer);
    hold.timer = setTimeout(() => {
      if (!hold.on) return;
      hold.fired = true;
      if (hold.lower) campIn.crouch = true;
      else campIn.jumpQ = true;
    }, HOLD_MS);
  };
  const onCampUp = () => {
    if (!hold.on) return;
    hold.on = false;
    clearTimeout(hold.timer);
    if (!hold.fired && campActive()) campIn.jumpQ = true; // tocco breve: salta
    campIn.crouch = false;
  };
  function campReleaseInput() {
    hold.on = false;
    clearTimeout(hold.timer);
    campIn.crouch = false;
    campIn.jumpQ = false;
  }

  // Scelta del livello: carte con stelle; il secondo si sblocca completando il primo
  const starRow = (n, px) => {
    const row = mk('div', { display: 'flex', gap: '3px' });
    for (let i = 0; i < 3; i++) row.append(svgIcon(ICONS.star, { X: i < n ? '#f4cf55' : 'rgba(255,255,255,.2)' }, px));
    return row;
  };
  function renderLevels() {
    campProg = loadCamp();
    levelsList.replaceChildren();
    CAMP_LEVELS.forEach((def, i) => {
      const open = campUnlocked(campProg, i);
      const b = mk('button', {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        width: '100%',
        minHeight: '72px',
        padding: '8px 14px',
        boxSizing: 'border-box',
        borderRadius: '10px',
        border: `2px solid ${open ? '#f4cf55' : 'rgba(255,255,255,.2)'}`,
        background: open ? 'rgba(244,207,85,.12)' : 'rgba(255,255,255,.05)',
        color: open ? '#fff' : 'rgba(255,255,255,.45)',
        fontFamily: FONT_UI,
        textTransform: 'uppercase',
        textAlign: 'left',
        cursor: open ? 'pointer' : 'default',
      });
      b.type = 'button';
      const num = mk('div', { fontSize: '38px', fontWeight: '700', color: open ? '#f4cf55' : 'inherit', minWidth: '26px', textAlign: 'center' }, String(i + 1));
      const txt = mk('div', { flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' });
      txt.append(
        mk('div', { fontSize: '22px', fontWeight: '700', letterSpacing: '.05em' }, def.name),
        mk('div', { fontSize: '14px', fontWeight: '600', letterSpacing: '.06em', opacity: '.8' }, open ? def.sub : `Completa il livello ${i}`)
      );
      b.append(num, txt, open ? starRow(campProg.stars[i], 3) : svgIcon(ICONS.lock, null, 3));
      b.addEventListener('click', () => {
        if (screen !== 'levels') return;
        if (open) startCamp(i);
        else feel('denied', HAP.denied);
      });
      levelsList.append(b);
    });
  }
  function goLevels() {
    releaseSub();
    if (audio) audio.stopMusic();
    camp = null;
    g.mode = 'camp';
    g.state = 'home';
    campReleaseInput();
    clearTimeout(hintTimer);
    hint.style.opacity = '0';
    renderLevels();
    showScreen('levels');
    pushSub(() => goHome());
    last = 0;
  }

  function startCamp(lv) {
    if (!campUnlocked(campProg, lv)) return;
    releaseSub();
    feel('start', HAP.launch);
    camp = newCamp(lv);
    g.mode = 'camp';
    g.hurt = 0;
    g.flashT = 0;
    cp.parts = [];
    cp.pops = [];
    campReleaseInput();
    campShake = 0;
    campDone = false;
    campIntro = 1.6;
    g.state = 'intro';
    showScreen(null);
    clearTimeout(hintTimer);
    hint.style.opacity = '0';
    if (audio) audio.setTempo(lv === 0 ? BASE_BPM : BASE_BPM + 12);
    last = 0;
  }

  const volFor = (d) => clamp(1 - Math.abs(d) / 160, 0.15, 1);
  function campPuff(x, y, n, color, up) {
    for (let i = 0; i < n; i++) {
      cp.parts.push({ x: x + (Math.random() - 0.5) * 8, y: y - 1, vx: (Math.random() - 0.5) * 40 - 8, vy: -Math.random() * (up || 22), life: 0.35 + Math.random() * 0.2, color });
    }
  }
  function campPop(text, color) {
    cp.pops.push({ text, x: heroX() - Math.round(textW(text, 1) / 2), y: floorY() - 70, life: 0.9, color });
  }

  function campEvent(e) {
    const px = heroX();
    const fy = floorY();
    switch (e.k) {
      case 'jump':
        feel('jump', HAP.jump, 1);
        campPuff(px, fy, 4, '#c9cfdf');
        break;
      case 'land':
        if (audio) audio.land();
        campPuff(px, fy, 6, '#c9cfdf');
        break;
      case 'duck':
        feel('duck', HAP.duck, 1);
        break;
      case 'rise':
        if (audio) audio.rise();
        break;
      case 'hit':
        feel('hit', HAP.hit, 3);
        g.hurt = 0.25;
        g.hurtRgb = '255,60,60';
        campShake = 0.25;
        campPuff(px, fy - 24, 10, '#ffb347', 60);
        break;
      case 'warn':
        if (audio) audio.warn(volFor(e.d));
        break;
      case 'slam':
        if (audio) audio.slam(volFor(e.d));
        if (Math.abs(e.d) < 55) vib(HAP.slam, 2);
        if (Math.abs(e.d) < 90) campShake = Math.max(campShake, 0.12);
        campPuff(px + e.d, fy, 8, '#ffb347', 50);
        break;
      case 'coil':
        feel('coil', HAP.coil, 2);
        campPop('+5', '#ffe27a');
        break;
      case 'wrench':
        feel('wrench', HAP.wrench, 2);
        campPop(e.life ? 'VITA' : '+3', '#8fe388');
        break;
      case 'win':
        if (audio) audio.stopMusic();
        feel('win', HAP.record, 3);
        g.flashT = 0.2;
        g.flashRgb = '255,230,140';
        break;
      case 'dead':
        if (audio) audio.stopMusic();
        feel('gameOver', HAP.over, 3);
        break;
      default:
    }
  }

  function campTick(dt) {
    if (!camp) return;
    g.hurt = Math.max(0, g.hurt - dt);
    g.flashT = Math.max(0, g.flashT - dt);
    campShake = Math.max(0, campShake - dt);
    for (const p of cp.parts) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 220 * dt;
      p.life -= dt;
    }
    cp.parts = cp.parts.filter((p) => p.life > 0);
    for (const p of cp.pops) {
      p.y -= 18 * dt;
      p.life -= dt;
    }
    cp.pops = cp.pops.filter((p) => p.life > 0);

    if (g.state === 'intro') {
      campIntro -= dt;
      if (campIntro <= 0) {
        g.state = 'play';
        if (audio) audio.startMusic();
      }
      return;
    }
    const inp = { jump: campIn.jumpQ, crouch: campIn.crouch };
    campIn.jumpQ = false;
    for (const e of campStep(camp, dt, inp)) campEvent(e);
    if (!campDone && ((camp.state === 'win' && camp.endT > 1.3) || (camp.state === 'dead' && camp.endT > 0.9))) {
      campDone = true;
      showCampResult(camp.state === 'win');
    }
  }

  function showCampResult(win) {
    const lv = camp.lv;
    const stars = clamp(camp.hearts, 1, 3);
    campReleaseInput();
    g.state = 'over';
    panelTitle.textContent = win ? 'Livello completato!' : 'Fine corsa';
    panelTitle.style.color = win ? '#f4cf55' : '#ff6b6b';
    panelTitle.style.fontSize = '38px';
    panelScore.textContent = `Punteggio: ${camp.score}`;
    nameBox.style.display = 'none';
    overBtns.style.display = 'flex';
    panelInner.style.margin = 'auto';
    exitBtn.textContent = 'Livelli';
    panelStars.replaceChildren();
    if (win) {
      campProg = saveCampStars(lv, stars);
      panelStars.style.display = 'flex';
      for (let i = 0; i < 3; i++) {
        const st = svgIcon(ICONS.star, { X: i < stars ? '#f4cf55' : 'rgba(255,255,255,.2)' }, 6);
        panelStars.append(st);
        if (i < stars) {
          if (!reduceMotion) st.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.3)', opacity: 1 }, { transform: 'scale(1)' }], { duration: 260, delay: 250 + i * 200, easing: 'ease-out', fill: 'backwards' });
          setTimeout(() => {
            if (active && screen === 'over') {
              if (audio) audio.row();
              vib(HAP.key, 1);
            }
          }, 250 + i * 200);
        }
      }
    } else panelStars.style.display = 'none';
    const more = win && lv + 1 < CAMP_LEVELS.length;
    nextBtn.style.display = more ? '' : 'none';
    panelBest.textContent = win && !more ? 'Altri livelli in arrivo' : '';
    lockUntil = performance.now() + 700;
    showScreen('over');
  }

  // ----- Disegno della Campagna -----
  function playerFrame(c) {
    if (c.state === 'dead' || g.state === 'intro') return charFrame('front', () => buildFrontFrame({}));
    if (c.pf > 0) return charFrame('jump', () => buildWalkFrame(6)); // in aria: gamba piegata e braccia in opposizione
    if (c.duck) {
      const k = Math.floor(((c.walkD % (CHAR_STEP * 2)) / (CHAR_STEP * 2)) * CHAR_CYCLE) % CHAR_CYCLE;
      return charFrame(`c${k}`, () => buildCrouchFrame(k)); // gambe che si muovono anche da accovacciato
    }
    const k = Math.floor(((c.walkD % (CHAR_STEP * 2)) / (CHAR_STEP * 2)) * CHAR_CYCLE) % CHAR_CYCLE;
    return charFrame(`w${k}`, () => buildWalkFrame(k));
  }

  function drawObstacle(o, sx, fy) {
    const x = Math.round(sx);
    if (o.k === 'crate') {
      ctx.fillStyle = '#5a3a1c';
      ctx.fillRect(x, fy - 14, 14, 14);
      ctx.fillStyle = '#b07a43';
      ctx.fillRect(x + 1, fy - 13, 12, 12);
      ctx.fillStyle = '#8d5e30';
      ctx.fillRect(x + 1, fy - 8, 12, 2);
      ctx.fillRect(x + 6, fy - 13, 2, 12);
      ctx.fillStyle = '#d29a62';
      ctx.fillRect(x + 1, fy - 13, 12, 1);
    } else if (o.k === 'tall') {
      ctx.fillStyle = '#1d3358';
      ctx.fillRect(x, fy - 20, 12, 20);
      ctx.fillStyle = '#3f6aa8';
      ctx.fillRect(x + 1, fy - 19, 10, 18);
      ctx.fillStyle = '#2c4d82';
      ctx.fillRect(x + 1, fy - 15, 10, 2);
      ctx.fillRect(x + 1, fy - 6, 10, 2);
      ctx.fillStyle = '#7aa6e0';
      ctx.fillRect(x + 2, fy - 19, 2, 18);
    } else if (o.k === 'oil') {
      ctx.fillStyle = '#12151f';
      ctx.fillRect(x + 1, fy - 3, o.w - 2, 3);
      ctx.fillRect(x, fy - 2, o.w, 2);
      ctx.fillStyle = '#3a4260';
      ctx.fillRect(x + 4, fy - 2, 4, 1);
      ctx.fillRect(x + 11, fy - 3, 2, 1);
    } else if (o.k === 'beam') {
      // tubo appeso con due staffe al soffitto
      ctx.fillStyle = '#3a4258';
      ctx.fillRect(x + 4, 0, 2, fy - o.hi);
      ctx.fillRect(x + o.w - 6, 0, 2, fy - o.hi);
      ctx.fillStyle = '#4a5368';
      ctx.fillRect(x, fy - o.hi, o.w, o.hi - o.lo);
      ctx.fillStyle = '#9aa6bd';
      ctx.fillRect(x + 1, fy - o.hi + 1, o.w - 2, 3);
      ctx.fillStyle = '#2a3042';
      ctx.fillRect(x, fy - o.lo - 2, o.w, 2);
      ctx.fillStyle = '#d8b24a';
      for (let i = 0; i < 4; i++) ctx.fillRect(x + 4 + i * 9, fy - o.hi + 6, 3, 2);
    } else if (o.k === 'press') {
      const bot = pressBottom(o.tp);
      const warn = o.tp >= PRESS.warn0 && o.tp < PRESS.slam1;
      const hot = warn && Math.floor(amb * 10) % 2 === 0;
      const headY = fy - Math.round(bot) - 10;
      const cx = x + (o.w >> 1);
      ctx.fillStyle = '#2a3042';
      ctx.fillRect(cx - 4, 0, 8, Math.max(0, headY));
      ctx.fillStyle = '#566078';
      ctx.fillRect(cx - 3, 0, 2, Math.max(0, headY));
      ctx.fillStyle = hot ? '#e5483b' : '#6c7893';
      ctx.fillRect(x, headY, o.w, 8);
      ctx.fillStyle = hot ? '#ff9a8f' : '#a6b1c8';
      ctx.fillRect(x, headY, o.w, 1);
      for (let i = 0; i < o.w; i += 4) {
        ctx.fillStyle = (i >> 2) % 2 ? '#1a1d28' : '#e2b93b';
        ctx.fillRect(x + i, headY + 8, 4, 2);
      }
      ctx.fillStyle = '#2b3142';
      ctx.fillRect(x - 1, fy - 2, o.w + 2, 2);
    }
  }

  function drawCamp() {
    const c = camp;
    const fy = floorY();
    const px = heroX();
    const cx = c.x;
    const day = env.d;
    const fac = c.def.theme === 'fa';

    ctx.save();
    if (campShake > 0) ctx.translate(Math.round((Math.random() - 0.5) * 3), 0);

    // parete con finestre: attraverso i vetri si vede il cielo vero (giorno, notte, sole, luna)
    const wall = fac ? mixC([52, 36, 40], [122, 86, 80], day) : mixC([40, 48, 72], [98, 108, 138], day);
    const winSp = 76;
    const wx0 = -((cx * 0.35) % winSp) - winSp;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-4, 0, W + 8, fy);
    for (let x = wx0; x < W + winSp; x += winSp) ctx.rect(Math.round(x + 24), fy - 108, 28, 40);
    ctx.clip('evenodd');
    ctx.fillStyle = rgbStr(wall);
    ctx.fillRect(-4, 0, W + 8, fy);
    ctx.restore();
    const frameC = rgbStr(mixC([18, 20, 32], [60, 66, 86], day));
    ctx.fillStyle = frameC;
    for (let x = wx0; x < W + winSp; x += winSp) {
      const wx = Math.round(x + 24);
      const wy = fy - 108;
      ctx.fillRect(wx - 1, wy - 1, 30, 1);
      ctx.fillRect(wx - 1, wy + 40, 30, 1);
      ctx.fillRect(wx - 1, wy - 1, 1, 42);
      ctx.fillRect(wx + 28, wy - 1, 1, 42);
      ctx.fillRect(wx + 13, wy, 2, 40);
      ctx.fillRect(wx, wy + 19, 28, 2);
    }
    // fascia di zoccolo e dettagli di reparto
    ctx.fillStyle = rgbStr(mixC(wall, [0, 0, 0], 0.3));
    ctx.fillRect(-4, fy - 12, W + 8, 12);
    if (fac) {
      // tubi lungo il soffitto, con giunti
      const pj = 44;
      const px0 = -((cx * 0.5) % pj) - pj;
      ctx.fillStyle = rgbStr(mixC([40, 26, 30], [96, 68, 64], day));
      ctx.fillRect(-4, 10, W + 8, 5);
      ctx.fillRect(-4, 20, W + 8, 3);
      ctx.fillStyle = rgbStr(mixC([70, 46, 48], [150, 110, 100], day));
      for (let x = px0; x < W + pj; x += pj) ctx.fillRect(Math.round(x), 9, 3, 15);
    } else {
      // scaffalature con scatole, più lontane del piano di gioco
      const rs = 92;
      const rx0 = -((cx * 0.6) % rs) - rs;
      for (let x = rx0; x < W + rs; x += rs) {
        const rx = Math.round(x);
        ctx.fillStyle = rgbStr(mixC([26, 32, 50], [70, 80, 106], day));
        ctx.fillRect(rx, fy - 56, 2, 44);
        ctx.fillRect(rx + 38, fy - 56, 2, 44);
        ctx.fillRect(rx, fy - 36, 40, 2);
        ctx.fillRect(rx, fy - 56, 40, 2);
        ctx.fillStyle = rgbStr(mixC([60, 44, 34], [130, 98, 70], day));
        ctx.fillRect(rx + 4, fy - 46, 12, 10);
        ctx.fillRect(rx + 20, fy - 44, 14, 8);
        ctx.fillRect(rx + 8, fy - 26, 16, 14);
      }
    }
    // lampade appese
    const ls = 64;
    const lx0 = -((cx * 0.5) % ls) - ls;
    for (let x = lx0; x < W + ls; x += ls) {
      const lx = Math.round(x + 30);
      ctx.fillStyle = '#2a3042';
      ctx.fillRect(lx + 4, 0, 1, 26);
      ctx.fillStyle = '#d9dce6';
      ctx.fillRect(lx, 26, 9, 3);
      ctx.fillStyle = `rgba(255,236,170,${0.12 + 0.1 * (1 - day)})`;
      ctx.fillRect(lx - 3, 29, 15, 2);
      ctx.fillRect(lx - 6, 31, 21, 2);
    }

    // pavimento: corsia con strisce gialle che scorrono
    ctx.fillStyle = rgbStr(fac ? mixC([30, 24, 28], [84, 66, 62], day) : mixC([26, 30, 46], [78, 88, 112], day));
    ctx.fillRect(-4, fy, W + 8, H - fy);
    ctx.fillStyle = rgbStr(mixC([74, 85, 128], [170, 186, 224], day));
    ctx.fillRect(-4, fy, W + 8, 1);
    ctx.fillStyle = '#e2b93b';
    const off = -(cx % 32);
    for (let x = off - 32; x < W + 32; x += 32) ctx.fillRect(Math.round(x), fy + 4, 16, 2);
    ctx.fillStyle = rgbStr(mixC([18, 22, 36], [60, 70, 96], day));
    const tl = -(cx % 26);
    for (let x = tl - 26; x < W + 26; x += 26) ctx.fillRect(Math.round(x), fy + 12, 1, H - fy - 12);
    ctx.fillRect(-4, fy + 12, W + 8, 1);

    // porta d'uscita: più alta del personaggio, a 6 px dal traguardo
    const dx = Math.round(px + (c.len + DOOR_GAP - cx));
    if (dx < W + 40) {
      const near = c.len + DOOR_GAP - cx < 70 || c.state === 'win';
      ctx.fillStyle = '#caa24a';
      ctx.fillRect(dx - 2, fy - DOOR_H - 2, DOOR_W + 4, DOOR_H + 2);
      ctx.fillStyle = near ? '#fff0b8' : '#0c0f18';
      ctx.fillRect(dx, fy - DOOR_H, DOOR_W, DOOR_H);
      if (near) {
        ctx.fillStyle = '#e8cf7a';
        ctx.fillRect(dx + 5, fy - DOOR_H, DOOR_W - 10, DOOR_H);
        ctx.fillStyle = '#fffbe0';
        ctx.fillRect(dx + 11, fy - DOOR_H, DOOR_W - 22, DOOR_H);
      } else {
        ctx.fillStyle = '#161a27';
        ctx.fillRect(dx + 4, fy - DOOR_H + 4, DOOR_W - 8, DOOR_H - 4);
      }
      ctx.fillStyle = '#1f7a45';
      ctx.fillRect(dx - 2, fy - DOOR_H - 14, DOOR_W + 4, 12);
      ctx.fillStyle = '#d9ffe6';
      drawText('USCITA', dx - 2 + Math.round((DOOR_W + 4 + textW('USCITA', 1)) / 2), fy - DOOR_H - 11, 1);
    }

    for (const o of c.obs) {
      const sx = px + (o.x - cx);
      if (sx > W + 4 || sx + o.w < -4) continue;
      drawObstacle(o, sx, fy);
    }

    // bobine e chiavi inglesi (da prendere in salto)
    for (const p of c.pick) {
      if (p.got) continue;
      const sx = px + (p.x - cx);
      if (sx > W + 12 || sx < -12) continue;
      const it = ITEMS[p.k];
      const bob = Math.sin(amb * 4 + p.x) * 1.5;
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = it.glow;
      disc(sx, fy - p.h - it.h / 2 + bob, 8);
      ctx.globalAlpha = 1;
      sprite(it.rows, sx - it.w / 2, fy - p.h - it.h + bob, it.pal);
    }

    // personaggio
    if (c.state !== 'win' || c.endT < WIN_WALK) {
      const frame = c.state === 'win' ? charFrame('back', buildBackFrame) : playerFrame(c);
      const blink = c.inv > 0 && c.state === 'run' && Math.floor(c.t * 14) % 2 === 0;
      if (!blink) {
        const feet = fy - Math.round(c.pf);
        if (c.state === 'dead') {
          ctx.save();
          ctx.translate(px, fy);
          ctx.rotate((Math.PI / 2) * Math.min(1, c.endT / 0.3));
          ctx.drawImage(frame, -14, -CHAR_H);
          ctx.restore();
        } else {
          // vittoria: di schiena verso la porta, con un passetto ogni 0,12 s; svanisce quando è sulla soglia
          const e = clamp(c.endT / WIN_WALK, 0, 1);
          const walkIn = c.state === 'win' ? (c.len + DOOR_GAP + DOOR_W / 2 - c.x) * (1 - (1 - e) * (1 - e)) : 0;
          const step = c.state === 'win' && Math.floor(c.endT / 0.12) % 2 ? 1 : 0;
          ctx.globalAlpha = c.state === 'win' ? 1 - clamp((e - 0.55) / 0.45, 0, 1) : 1;
          ctx.drawImage(frame, Math.round(px - 14 + walkIn), feet - CHAR_H - step);
          ctx.globalAlpha = 1;
        }
      }
    }

    for (const p of cp.parts) {
      ctx.globalAlpha = clamp(p.life * 3, 0, 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(R(p.x), R(p.y), 1, 1);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // suggerimenti sul pavimento
    for (const tip of c.def.tips) {
      if (c.x < tip.x || c.x > tip.to || g.state === 'intro') continue;
      tip.lines.forEach((ln, i) => {
        const w = textW(ln, 1);
        textWithShadow(ln, Math.round(W / 2 + w / 2), fy + 18 + i * 9, 1, '#ffe27a');
      });
    }
    for (const p of cp.pops) {
      ctx.globalAlpha = clamp(p.life * 1.6, 0, 1);
      textWithShadow(p.text, p.x + textW(p.text, 1), R(p.y), 1, p.color);
    }
    ctx.globalAlpha = 1;

    // HUD: cuori, bobine e avanzamento
    for (let i = 0; i < MAX_LIVES; i++) heart(5 + i * (HW + 3), topPad, i < c.hearts);
    textWithShadow(String(c.score), W - 5, topPad, 2, '#ffffff');
    const bx = Math.round(W * 0.42);
    const bw = W - 5 - bx;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(bx, topPad + 13, bw, 3);
    ctx.fillStyle = '#f4cf55';
    ctx.fillRect(bx, topPad + 13, Math.round(bw * clamp(c.x / c.len, 0, 1)), 3);
    for (const o of c.obs) {
      if (o.k !== 'press') continue;
      ctx.fillStyle = '#e5483b';
      ctx.fillRect(bx + Math.round(bw * (o.x / c.len)), topPad + 17, 1, 2);
    }

    // titolo del livello all'inizio
    if (g.state === 'intro') {
      const a = clamp(Math.min(campIntro / 0.3, (1.6 - campIntro) / 0.2), 0, 1);
      ctx.globalAlpha = a;
      const t1 = `LIVELLO ${c.lv + 1}`;
      const t2 = c.def.name.toUpperCase();
      textWithShadow(t1, Math.round(W / 2 + textW(t1, 2) / 2), Math.round(H * 0.22), 2, '#f4cf55');
      textWithShadow(t2, Math.round(W / 2 + textW(t2, 1) / 2), Math.round(H * 0.22) + 16, 1, '#ffffff');
      ctx.globalAlpha = 1;
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
    if (g.state === 'home') charTick(dt);
    else if (g.state === 'play' || g.state === 'intro') {
      if (g.mode === 'camp') campTick(dt);
      else update(dt);
    }
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
    campReleaseInput();
    quitBtn.textContent = g.mode === 'camp' ? 'Esci dal livello' : 'Esci dalla partita';
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

  // ---------- Personaggio: cammina di profilo, si ferma di fronte, guarda l'orologio ----------
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const frameCache = new Map();
  const charFrame = (key, build) => {
    let cv = frameCache.get(key);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = CHAR_W;
      cv.height = CHAR_H;
      const c = cv.getContext('2d');
      build().forEach((row, y) =>
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
  // mode: idle (di fronte) | walk (di profilo) | turn (di schiena, al bordo) | watch (di fronte, guarda l'orologio)
  const cs = { x: 8, dir: 1, mode: 'idle', t: 0, until: 0.8, walked: 0, watchIn: 4, z: 2, maxX: 0, shown: '', tic: 0 };

  function layoutChar() {
    if (screen !== 'home') return;
    const wr = wrap.getBoundingClientRect();
    const ir = homeScr.inner.getBoundingClientRect();
    const groundTop = wr.height - GROUND_H * scale;
    const avail = groundTop - (ir.bottom - wr.top) - 6;
    cs.z = clamp(Math.floor(avail / CHAR_H), 1, Math.min(scale, 3)); // al massimo ~144 px di altezza
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
    charSet('watch', 2.6);
    cs.tic = 0;
    cs.watchIn = 8 + Math.random() * 6;
    if (audio) audio.auto(); // tic-tac d'orologio: lo stesso dell'opzione Auto dello sfondo
    if (byTap) vib(HAP.auto, 2);
  }
  charCv.addEventListener('click', () => charWatch(true));

  function charTick(dt) {
    if (screen !== 'home') return;
    cs.t += dt;
    cs.watchIn -= dt;
    let key;
    let build;
    let flip = false;
    if (cs.mode === 'walk') {
      cs.x += cs.dir * (CHAR_STEP / 0.6) * dt; // un passo ogni 0,6 s
      cs.walked += (CHAR_STEP / 0.6) * dt;
      const atEdge = (cs.dir < 0 && cs.x <= 0) || (cs.dir > 0 && cs.x >= cs.maxX);
      if (atEdge) {
        cs.x = clamp(cs.x, 0, cs.maxX);
        charSet('turn', 0.7); // al bordo si gira di schiena prima di tornare indietro
      } else if (cs.t >= cs.until) charSet('idle', 0.7 + Math.random() * 0.9);
    }
    if (cs.mode === 'walk') {
      const k = Math.floor(((cs.walked % (CHAR_STEP * 2)) / (CHAR_STEP * 2)) * CHAR_CYCLE) % CHAR_CYCLE;
      key = `w${k}`;
      build = () => buildWalkFrame(k);
      flip = cs.dir < 0;
    } else if (cs.mode === 'turn') {
      if (cs.t >= cs.until) {
        cs.dir = cs.x <= 0 ? 1 : -1;
        charSet('walk', 3 + Math.random() * 3);
      }
      key = 'back';
      build = buildBackFrame;
    } else if (cs.mode === 'idle') {
      if (cs.t >= cs.until) {
        if (cs.watchIn <= 0) charWatch(false);
        else if (reduceMotion) charSet('idle', 1.5);
        else {
          cs.dir = cs.x < cs.maxX * 0.25 ? 1 : cs.x > cs.maxX * 0.75 ? -1 : Math.random() < 0.5 ? 1 : -1;
          charSet('walk', 3 + Math.random() * 3);
        }
      }
      key = 'front';
      build = () => buildFrontFrame({});
    }
    if (cs.mode === 'watch') {
      // alza il braccio (0,3 s), guarda l'orologio con un luccichio, poi riabbassa
      if (cs.t >= cs.until) {
        charSet('idle', 0.6);
        key = 'front';
        build = () => buildFrontFrame({});
      } else {
        const up = cs.t < 0.3 || cs.t > cs.until - 0.3;
        const glint = !up && Math.floor(cs.t * 4) % 2 ? 1 : 0;
        key = `watch${glint}`;
        build = () => buildFrontFrame({ watch: 1, glint });
        if (audio && cs.t > 1.3 && cs.tic === 0) {
          cs.tic = 1;
          audio.auto(); // secondo tic a metà occhiata
        }
      }
    }
    if (!key) return;
    const left = Math.round(cs.x);
    const sig = `${left}|${cs.z}|${key}|${flip}`;
    if (sig === cs.shown) return;
    cs.shown = sig;
    charCtx.clearRect(0, 0, CHAR_W, CHAR_H);
    charCtx.save();
    if (flip) {
      charCtx.translate(CHAR_W, 0);
      charCtx.scale(-1, 1);
    }
    charCtx.drawImage(charFrame(key, build), 0, 0);
    charCtx.restore();
    charCv.style.transform = `translateX(${left * cs.z}px)`;
  }

  function showScreen(name) {
    screen = name;
    homeScr.scr.style.display = name === 'home' ? 'flex' : 'none';
    rushScr.scr.style.display = name === 'rush' ? 'flex' : 'none';
    levelsScr.scr.style.display = name === 'levels' ? 'flex' : 'none';
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

  // Menu principale
  function goHome() {
    releaseSub();
    if (audio) audio.stopMusic();
    g.mode = 'rush';
    camp = null;
    resetRound();
    g.state = 'home';
    keys.left = false;
    keys.right = false;
    clearTimeout(hintTimer);
    hint.style.opacity = '0';
    showScreen('home');
    last = 0;
  }

  // Menu di Rush: Nuova partita, High score
  function goRush() {
    releaseSub();
    if (audio) audio.stopMusic();
    g.mode = 'rush';
    camp = null;
    resetRound();
    g.state = 'home';
    keys.left = false;
    keys.right = false;
    clearTimeout(hintTimer);
    hint.style.opacity = '0';
    const best = loadScores()[0];
    homeBest.textContent = best ? `Record: ${best.name} ${best.score}` : 'Nessun record';
    showScreen('rush');
    pushSub(() => goHome());
    last = 0;
  }

  function newGame() {
    if (screen !== 'rush') return;
    releaseSub();
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
    goRush();
  }

  function setMenuMode(mode) {
    const inSettings = mode === 'settings';
    menuTitle.textContent = inSettings ? 'Impostazioni' : 'Pausa';
    resumeBtn.style.display = inSettings ? 'none' : '';
    quitBtn.style.display = inSettings ? 'none' : '';
    legend.style.display = !inSettings && g.mode === 'camp' ? 'none' : ''; // la legenda bonus/malus è di Rush
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

  function resetPanel() {
    panelTitle.style.fontSize = '44px';
    panelStars.style.display = 'none';
    nextBtn.style.display = 'none';
    exitBtn.textContent = 'Menu';
  }

  function showGameOver() {
    resetPanel();
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
    resetPanel();
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

  rushBtn.addEventListener('click', () => {
    if (screen !== 'home') return;
    feel('pauseOpen', HAP.tap);
    goRush();
  });
  campBtn.addEventListener('click', () => {
    if (screen !== 'home') return;
    feel('pauseOpen', HAP.tap);
    goLevels();
  });
  rushBackBtn.addEventListener('click', () => {
    if (screen !== 'rush') return;
    feel('back', HAP.back);
    goHome();
  });
  levelsBackBtn.addEventListener('click', () => {
    if (screen !== 'levels') return;
    feel('back', HAP.back);
    goHome();
  });
  newGameBtn.addEventListener('click', newGame);
  scoresBtn.addEventListener('click', () => {
    if (screen === 'rush') openScores(false);
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
    goRush();
  });
  backBtn.addEventListener('click', () => closeSettings(false));

  pauseBtn.addEventListener('click', openPause);
  resumeBtn.addEventListener('click', closePause);
  quitBtn.addEventListener('click', () => {
    if (g.state !== 'paused') return;
    menu.style.display = 'none';
    feel('back', HAP.back);
    if (g.mode === 'camp') goLevels();
    else goRush();
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
    if (g.state === 'paused' || g.mode === 'camp') return;
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
      else if (screen === 'rush' || screen === 'levels') {
        feel('back', HAP.back);
        goHome();
      } else openPause();
    } else if (g.state === 'paused') return;
    else if (g.mode === 'camp') {
      if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        campIn.jumpQ = true;
        e.preventDefault();
      } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') campIn.crouch = true;
    } else if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = true;
    else if (e.key === 'ArrowRight' || e.key === 'd') keys.right = true;
  };
  const onKeyUp = (e) => {
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') campIn.crouch = false;
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
  window.addEventListener('pointerdown', onCampDown);
  window.addEventListener('pointerup', onCampUp);
  window.addEventListener('pointercancel', onCampUp);
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
    window.removeEventListener('pointerdown', onCampDown);
    window.removeEventListener('pointerup', onCampUp);
    window.removeEventListener('pointercancel', onCampUp);
    clearTimeout(hold.timer);
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
    if (g.mode === 'camp') goLevels();
    else goRush();
  });
  retryBtn.addEventListener('click', () => {
    if (locked() || screen !== 'over') return;
    feel('click', HAP.tap);
    if (g.mode === 'camp' && camp) startCamp(camp.lv);
    else {
      startRound(false);
      last = 0;
    }
  });
  nextBtn.addEventListener('click', () => {
    if (locked() || screen !== 'over' || !camp) return;
    startCamp(camp.lv + 1);
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
