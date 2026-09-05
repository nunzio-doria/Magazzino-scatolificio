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
const listeners = [];

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
  } catch (err) {
    console.warn('Impossibile salvare la coda offline.', err);
  }
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

/** Accoda una transazione da sincronizzare appena torna la rete */
export function enqueueTransaction(payload) {
  const queue = loadQueue();
  queue.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload,
    queuedAt: new Date().toISOString(),
  });
  saveQueue(queue);
  notify();
}

let flushing = false;

/**
 * Prova a inviare le transazioni in coda, in ordine, tramite processFn
 * (tipicamente processTransaction di supabase.js). Si ferma al primo
 * errore cosí da riprovare più tardi nello stesso ordine, invece di
 * scartare o disordinare le transazioni rimaste.
 * @param {(payload: object) => Promise<any>} processFn
 * @returns {Promise<{synced: number}>}
 */
export async function flushQueue(processFn) {
  if (flushing) return { synced: 0 };
  flushing = true;
  let synced = 0;
  try {
    let queue = loadQueue();
    while (queue.length) {
      const item = queue[0];
      try {
        await processFn(item.payload);
      } catch (err) {
        console.warn('Sincronizzazione offline interrotta, riprovo più tardi.', err);
        break;
      }
      queue.shift();
      saveQueue(queue);
      notify();
      synced += 1;
    }
  } finally {
    flushing = false;
  }
  return { synced };
}

/**
 * Collega il flush automatico: alla riconnessione (evento 'online') e,
 * se già online, subito all'avvio.
 */
export function initOfflineSync(processFn) {
  window.addEventListener('online', () => flushQueue(processFn));
  if (navigator.onLine) flushQueue(processFn);
}

/** Un errore è "di rete" (quindi da mettere in coda) se siamo offline o se la chiamata è proprio fallita per assenza di connessione */
export function isNetworkError(err) {
  if (!navigator.onLine) return true;
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('network') || msg.includes('load failed');
}
