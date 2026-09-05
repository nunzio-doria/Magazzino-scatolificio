// =============================================================
// feedback.js — Feedback aptico (vibrazione) e sonoro (Web Audio API)
// differenziato per tipo di interazione: scansione riuscita/fallita,
// deposito/prelievo, allarme scorta minima, navigazione, conferme,
// eliminazioni, undo/redo.
//
// Nessun file audio esterno: tutti i suoni sono generati al volo con
// oscillatori, cosí funzionano anche offline (l'app è una PWA) e non
// pesano sulla cache del service worker.
//
// La vibrazione (Vibration API) funziona solo su Android/Chrome:
// iOS Safari e le PWA installate su iOS non la supportano ancora,
// quindi su iPhone/iPad il feedback sarà solo sonoro — il codice
// verifica la disponibilità dell'API e non genera errori se assente.
// =============================================================

const STORAGE_KEY = 'magazzino-feedback-settings';

let settings = loadSettings();
let audioCtx = null;

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { sound: true, haptics: true, ...JSON.parse(raw) };
  } catch (err) {
    console.warn('Impossibile leggere le preferenze di feedback.', err);
  }
  return { sound: true, haptics: true };
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('Impossibile salvare le preferenze di feedback.', err);
  }
}

export function isSoundEnabled() {
  return settings.sound;
}
export function isHapticsEnabled() {
  return settings.haptics;
}
export function setSoundEnabled(value) {
  settings.sound = !!value;
  saveSettings();
}
export function setHapticsEnabled(value) {
  settings.haptics = !!value;
  saveSettings();
}

/** Crea (o riprende) l'AudioContext. Va richiamato dopo un gesto utente per rispettare le policy autoplay dei browser. */
function ensureAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

/**
 * Suona una singola nota.
 * @param {number} freq Hz
 * @param {number} durationMs
 * @param {{type?: OscillatorType, delayMs?: number, gain?: number}} [opts]
 */
function tone(freq, durationMs, { type = 'sine', delayMs = 0, gain = 0.16 } = {}) {
  if (!settings.sound) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;

  const startAt = ctx.currentTime + delayMs / 1000;
  const stopAt = startAt + durationMs / 1000;

  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  osc.connect(gainNode);
  gainNode.connect(ctx.destination);

  // Inviluppo breve per evitare click secchi a inizio/fine nota
  gainNode.gain.setValueAtTime(0, startAt);
  gainNode.gain.linearRampToValueAtTime(gain, startAt + 0.008);
  gainNode.gain.linearRampToValueAtTime(0, stopAt);

  osc.start(startAt);
  osc.stop(stopAt + 0.02);
}

/** Suona una sequenza di note: [[freq, durationMs, delayMs, opts], ...] */
function sequence(notes) {
  for (const [freq, durationMs, delayMs, opts] of notes) {
    tone(freq, durationMs, { ...opts, delayMs });
  }
}

/**
 * Vibra secondo un pattern (ms). Un solo numero = singolo impulso;
 * un array = impulso/pausa alternati. No-op silenzioso se non supportato
 * (iOS) o disattivato nelle impostazioni.
 */
function vibrate(pattern) {
  if (!settings.haptics) return;
  if (typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern);
  } catch (err) {
    // alcuni browser lanciano se chiamato fuori da un gesto utente: ignorabile
  }
}

// -----------------------------------------------------------------
// Eventi di interazione — un nome per ciascuna azione dell'app
// -----------------------------------------------------------------

const feedback = {
  /** Modalità Deposito/Prelievo selezionata */
  modeSelect() {
    tone(700, 55, { type: 'sine', gain: 0.1 });
    vibrate(12);
  },

  /** Barcode letto e articolo trovato a magazzino */
  scanFound() {
    sequence([
      [880, 70, 0, { type: 'sine' }],
      [1318, 90, 60, { type: 'sine' }],
    ]);
    vibrate(25);
  },

  /** Barcode letto ma nessun articolo corrispondente */
  scanNotFound() {
    sequence([
      [220, 130, 0, { type: 'square', gain: 0.09 }],
      [180, 160, 110, { type: 'square', gain: 0.09 }],
    ]);
    vibrate([40, 60, 40]);
  },

  /** Tentativo di scansione senza aver scelto Deposito/Prelievo */
  scanNoMode() {
    tone(320, 140, { type: 'triangle', gain: 0.1 });
    vibrate(20);
  },

  /** Transazione di deposito confermata (tono caldo, ascendente) */
  transactionDeposito() {
    sequence([
      [523, 90, 0, { type: 'sine' }],
      [659, 110, 90, { type: 'sine' }],
      [784, 140, 200, { type: 'sine' }],
    ]);
    vibrate([0, 30, 30, 30]);
  },

  /** Transazione di prelievo confermata (timbro diverso, discendente) */
  transactionPrelievo() {
    sequence([
      [659, 90, 0, { type: 'triangle' }],
      [554, 110, 90, { type: 'triangle' }],
      [440, 140, 200, { type: 'triangle' }],
    ]);
    vibrate([0, 30, 30, 30]);
  },

  /** Scorta minima raggiunta dopo una transazione: allarme più marcato */
  lowStockAlert() {
    sequence([
      [988, 90, 0, { type: 'square', gain: 0.11 }],
      [988, 90, 150, { type: 'square', gain: 0.11 }],
      [988, 140, 300, { type: 'square', gain: 0.11 }],
    ]);
    vibrate([60, 80, 60, 80, 60]);
  },

  /** Cambio fotocamera nello scanner */
  cameraSwitch() {
    tone(500, 45, { type: 'sine', gain: 0.09 });
    vibrate(10);
  },

  /** Tap-to-focus sull'anteprima camera: tocco leggerissimo */
  focusTap() {
    tone(950, 25, { type: 'sine', gain: 0.05 });
    vibrate(8);
  },

  /** Cambio sezione nella barra di navigazione inferiore */
  navTap() {
    tone(600, 30, { type: 'sine', gain: 0.06 });
    vibrate(8);
  },

  /** Conferma generica (es. pulsante "Conferma" in un dialog, salvataggio form) */
  confirmAction() {
    sequence([
      [740, 60, 0, { type: 'sine', gain: 0.11 }],
      [988, 80, 55, { type: 'sine', gain: 0.11 }],
    ]);
    vibrate(20);
  },

  /** Annullamento / chiusura senza salvare */
  cancelAction() {
    tone(340, 70, { type: 'sine', gain: 0.08 });
    vibrate(10);
  },

  /** Azione distruttiva confermata (elimina articolo) */
  deleteAction() {
    sequence([
      [180, 90, 0, { type: 'square', gain: 0.13 }],
      [140, 150, 80, { type: 'square', gain: 0.13 }],
    ]);
    vibrate([70, 50, 70]);
  },

  /** Operazione annullata (undo) — blip più grave */
  undo() {
    tone(494, 70, { type: 'triangle', gain: 0.1 });
    vibrate(15);
  },

  /** Operazione ripetuta (redo) — blip più acuto */
  redo() {
    tone(740, 70, { type: 'triangle', gain: 0.1 });
    vibrate(15);
  },

  /** Errore generico (import fallito, salvataggio fallito, ecc.) */
  errorAction() {
    sequence([
      [200, 100, 0, { type: 'sawtooth', gain: 0.08 }],
      [160, 140, 90, { type: 'sawtooth', gain: 0.08 }],
    ]);
    vibrate([50, 40, 50]);
  },

  /** Transazione salvata in coda offline (né successo pieno né errore: "in attesa") */
  offlineQueued() {
    sequence([
      [523, 80, 0, { type: 'sine', gain: 0.09 }],
      [392, 120, 90, { type: 'sine', gain: 0.09 }],
    ]);
    vibrate([20, 40, 20]);
  },

  /** Transazioni in coda sincronizzate con successo alla riconnessione */
  syncComplete() {
    sequence([
      [659, 70, 0, { type: 'sine', gain: 0.1 }],
      [880, 90, 60, { type: 'sine', gain: 0.1 }],
      [1046, 110, 150, { type: 'sine', gain: 0.1 }],
    ]);
    vibrate([0, 20, 20, 20]);
  },
};

export default feedback;

/**
 * Collega gli switch delle impostazioni (suoni/vibrazione) nella vista
 * Impostazioni, se presenti nel DOM, e li allinea allo stato salvato.
 */
export function initFeedbackSettings() {
  const soundToggle = document.getElementById('feedback-sound-toggle');
  const hapticsToggle = document.getElementById('feedback-haptics-toggle');
  const hapticsRow = document.getElementById('feedback-haptics-row');

  // La Vibration API non esiste su iOS: nasconde il relativo switch invece
  // di mostrare un controllo che non avrebbe mai alcun effetto.
  const hapticsSupported = typeof navigator.vibrate === 'function';
  if (!hapticsSupported) hapticsRow?.classList.add('hidden');

  if (soundToggle) {
    soundToggle.checked = isSoundEnabled();
    soundToggle.addEventListener('change', () => {
      setSoundEnabled(soundToggle.checked);
      if (soundToggle.checked) feedback.confirmAction();
    });
  }
  if (hapticsToggle && hapticsSupported) {
    hapticsToggle.checked = isHapticsEnabled();
    hapticsToggle.addEventListener('change', () => {
      setHapticsEnabled(hapticsToggle.checked);
      if (hapticsToggle.checked) feedback.navTap();
    });
  }
}
