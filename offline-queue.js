// =============================================================
// offline-queue.js — Coda locale per le transazioni (deposito/prelievo)
// registrate mentre manca la connessione di rete. Le transazioni restano
// salvate in localStorage e vengono ritentate automaticamente non appena
// il dispositivo torna online, nell'ordine in cui sono state create.
//
// Limite noto: la ricerca del prodotto tramite scansione richiede comunque
// una lettura riuscita almeno una volta (dal vivo o dalla cache locale in
// supabase.js) — offline puro "da zero", senza mai aver caricato prima
// il magazzino, non può risolvere un barcode mai visto.
// =============================================================

const QUEUE_KEY = 'magazzino-offline-queue';
const FAILED_KEY = 'magazzino-offline-failed'; // movimenti rifiutati dal server, tenuti da parte
const FAILED_MAX = 50;
const listeners = [];

// Codici con cui il database rifiuta DEFINITIVAMENTE un movimento (regola di
// business violata, articolo inesistente, valore non valido): ritentarlo non
// servirebbe mai. Qualsiasi altro errore (rete, sessione scaduta, server
// momentaneamente giù) è trattato come temporaneo e la coda si ferma per
// riprovare più tardi: meglio non perdere un movimento che scartarlo per errore.
const PERMANENT_REJECTION_CODES = new Set(['P0001', '23503', '23505', '23514', '22003', '22P02', 'PGRST116']);

function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch (err) {
    return [];
  }
}
function saveQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    return true;
  } catch (err) {
    console.warn('Impossibile salvare la coda offline.', err);
    return false;
  }
}

/** Movimenti rifiutati dal server durante la sincronizzazione (più recenti in fondo) */
export function getFailedTransactions() {
  try {
    return JSON.parse(localStorage.getItem(FAILED_KEY) || '[]');
  } catch (err) {
    return [];
  }
}
function addFailedTransaction(item, reason) {
  try {
    const failed = getFailedTransactions();
    failed.push({ ...item, failedAt: new Date().toISOString(), reason });
    localStorage.setItem(FAILED_KEY, JSON.stringify(failed.slice(-FAILED_MAX)));
  } catch (err) {
    console.warn('Impossibile salvare il movimento non sincronizzato.', err);
  }
}

/** true se il server ha rifiutato in modo definitivo l'operazione (vedi PERMANENT_REJECTION_CODES) */
export function isPermanentRejection(err) {
  if (isNetworkError(err)) return false;
  return PERMANENT_REJECTION_CODES.has(err?.code) || (err?.message || '').includes('Giacenza insufficiente');
}
function notify() {
  const count = getQueueCount();
  listeners.forEach((fn) => {
    try {
      fn(count);
    } catch (err) {
      console.warn(err);
    }
  });
}

export function getQueueCount() {
  return loadQueue().length;
}

/** Registra una callback chiamata ogni volta che la lunghezza della coda cambia */
export function onQueueChange(fn) {
  listeners.push(fn);
}

/**
 * Accoda una transazione da sincronizzare appena torna la rete.
 * @returns {boolean} false se non è stato possibile salvarla sul dispositivo
 *   (es. memoria piena): il chiamante deve dirlo all'operatore.
 */
export function enqueueTransaction(payload) {
  const queue = loadQueue();
  queue.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload,
    queuedAt: new Date().toISOString(),
  });
  if (!saveQueue(queue)) return false;
  notify();
  return true;
}

let flushing = false;

/**
 * Prova a inviare le transazioni in coda, in ordine, tramite processFn
 * (tipicamente processTransaction di supabase.js), nell'ordine di creazione.
 * - Errore temporaneo (rete, sessione, server giù): si ferma e riprova più
 *   tardi, cosí l'ordine non viene alterato.
 * - Rifiuto definitivo del server (es. giacenza insufficiente): il movimento
 *   viene tolto dalla coda e messo da parte tra i "non sincronizzati", poi si
 *   prosegue con i successivi, senza che uno solo blocchi tutti gli altri.
 * @param {(payload: object) => Promise<any>} processFn
 * @param {{ onDiscard?: (item: object, err: Error) => void }} [opts]
 * @returns {Promise<{synced: number, discarded: number}>}
 */
export async function flushQueue(processFn, { onDiscard } = {}) {
  if (flushing) return { synced: 0, discarded: 0 };
  flushing = true;
  let synced = 0;
  let discarded = 0;
  try {
    // Rileggiamo la coda da localStorage a ogni giro (non uno snapshot fisso):
    // nel frattempo l'operatore può aver accodato un nuovo movimento (es. durante
    // l'attesa della risposta del server) e non va perso quando risalviamo.
    let queue = loadQueue();
    while (queue.length) {
      const item = queue[0];
      let rejected = null;
      try {
        await processFn(item.payload);
      } catch (err) {
        if (!isPermanentRejection(err)) {
          console.warn('Sincronizzazione offline interrotta, riprovo più tardi.', err);
          break;
        }
        rejected = err;
      }
      // Rimuoviamo per id dalla coda più aggiornata possibile, non da quella
      // caricata all'inizio del flush.
      queue = loadQueue().filter((q) => q.id !== item.id);
      saveQueue(queue);
      if (rejected) {
        addFailedTransaction(item, rejected.message || 'Rifiutato dal server');
        discarded += 1;
        try {
          onDiscard?.(item, rejected);
        } catch (cbErr) {
          console.warn(cbErr);
        }
      } else {
        synced += 1;
      }
      notify();
    }
  } finally {
    flushing = false;
  }
  return { synced, discarded };
}

/**
 * Collega il flush automatico: alla riconnessione (evento 'online') e,
 * se già online, subito all'avvio.
 */
export function initOfflineSync(processFn, opts = {}) {
  const run = () =>
    flushQueue(processFn, opts).then((result) => {
      if (result.synced > 0) opts.onSynced?.(result);
    });
  window.addEventListener('online', run);
  if (navigator.onLine) run();
}

/** Un errore è "di rete" (quindi da mettere in coda) se siamo offline o se la chiamata è proprio fallita per assenza di connessione */
export function isNetworkError(err) {
  if (!navigator.onLine) return true;
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('network') || msg.includes('load failed');
}
