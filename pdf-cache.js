// =============================================================
// pdf-cache.js — Copia locale dei manuali PDF già aperti.
//
// Il file viene salvato nella Cache Storage del telefono la prima volta che
// si apre e le volte successive parte dal dispositivo, senza scaricare nulla
// (e funziona anche senza rete). La chiave è il percorso nello storage, non
// l'URL firmato (che cambia a ogni richiesta). Se un manuale viene sostituito
// ha un nuovo percorso, quindi non si vede mai una copia vecchia.
// Lo spazio è limitato: oltre MAX_ENTRIES file, o MAX_BYTES in totale, si
// eliminano quelli usati meno di recente.
// =============================================================

const CACHE_NAME = 'magazzino-manuali-pdf-v1'; // il service worker NON deve cancellarla (vedi activate)
const INDEX_KEY = 'magazzino-pdf-cache-index';
const MAX_ENTRIES = 25;
const MAX_BYTES = 400 * 1024 * 1024;

let persistAsked = false;

function requestFor(manual) {
  const bucket = manual.bucket || 'manuali-macchine';
  const path = String(manual.storage_path).split('/').map(encodeURIComponent).join('/');
  return new Request(`${self.location.origin}/__manuali-pdf__/${encodeURIComponent(bucket)}/${path}`);
}

function readIndex() {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeIndex(index) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    /* indice non salvabile: l'eliminazione ordinata userà solo il conteggio */
  }
}

function cacheAvailable() {
  return typeof caches !== 'undefined' && !!self.isSecureContext;
}

/** @returns {Promise<Uint8Array|null>} il PDF salvato, o null se non c'è (o non è leggibile) */
export async function getCachedPdf(manual) {
  if (!cacheAvailable() || !manual?.storage_path) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(requestFor(manual));
    if (!res) return null;
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) return null;
    const index = readIndex();
    const key = requestFor(manual).url;
    if (index[key]) {
      index[key].used = Date.now();
      writeIndex(index);
    }
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export async function removeCachedPdf(manual) {
  if (!cacheAvailable() || !manual?.storage_path) return;
  try {
    const req = requestFor(manual);
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(req);
    const index = readIndex();
    delete index[req.url];
    writeIndex(index);
  } catch {
    /* niente da rimuovere */
  }
}

/** Salva una copia del PDF. Non genera mai errori: se lo spazio non basta, semplicemente non salva. */
export async function savePdf(manual, bytes) {
  if (!cacheAvailable() || !manual?.storage_path || !bytes?.byteLength) return;
  try {
    if (!persistAsked) {
      persistAsked = true;
      navigator.storage?.persist?.(); // chiede al browser di non cancellare i dati da solo
    }
    const req = requestFor(manual);
    const cache = await caches.open(CACHE_NAME);
    await cache.put(req, new Response(new Blob([bytes], { type: 'application/pdf' }), { headers: { 'Content-Type': 'application/pdf' } }));
    const index = readIndex();
    index[req.url] = { size: bytes.byteLength, used: Date.now() };
    await evict(cache, index);
    writeIndex(index);
  } catch (err) {
    console.warn('[pdf-cache] copia locale non salvata', err);
  }
}

/** Quanti manuali sono salvati sul telefono e quanto spazio occupano (per le Impostazioni). */
export function getPdfCacheInfo() {
  const entries = Object.values(readIndex());
  return { count: entries.length, bytes: entries.reduce((sum, e) => sum + (e.size || 0), 0) };
}

/** Elimina tutti i PDF salvati sul telefono. */
export async function clearPdfCache() {
  if (cacheAvailable()) await caches.delete(CACHE_NAME);
  try {
    localStorage.removeItem(INDEX_KEY);
  } catch {
    /* niente da rimuovere */
  }
}

async function evict(cache, index) {
  const total = () => Object.values(index).reduce((sum, e) => sum + (e.size || 0), 0);
  const keys = () => Object.keys(index).sort((a, b) => (index[a].used || 0) - (index[b].used || 0));
  while (Object.keys(index).length > MAX_ENTRIES || total() > MAX_BYTES) {
    const oldest = keys()[0];
    if (!oldest || Object.keys(index).length <= 1) break; // l'ultimo salvato resta sempre
    await cache.delete(new Request(oldest));
    delete index[oldest];
  }
}
