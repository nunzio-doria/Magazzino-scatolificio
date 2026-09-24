// =============================================================
// manuals.js — Manuali ricambi (PDF) delle macchine: cache condivisa
// (usata da machines.js in Impostazioni e da products.js in Ricambi
// tecnici) + visualizzatore PDF interno con ricerca del codice.
//
// Il PDF viene sempre aperto DENTRO l'app: pagine incolonnate in scroll
// continuo (niente pulsanti per cambiare pagina), pinch-to-zoom che scala
// solo il PDF e mai il resto dell'interfaccia, testo selezionabile con
// pressione prolungata (vero text layer di pdf.js) ed evidenziazione
// puntuale del codice cercato.
// =============================================================

import { listMachineManuals, getManualSignedUrl, normalizeMachineName } from './supabase.js';
import { toastError, toastWarning } from './toast.js';
import { openOverlay, closeOverlay } from './ui-utils.js';

const PDFJS_VERSION = '3.11.174';
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 3;
// Limite di pixel (larghezza × altezza) per il canvas di una singola pagina. Oltre questa
// soglia, soprattutto con più pagine ad alta risoluzione tenute in memoria insieme, iOS/Safari
// può svuotare silenziosamente il canvas (appare tutto nero): meglio restare ben al di sotto.
const MAX_CANVAS_PIXELS = 4_000_000;
// Su manuali da centinaia di pagine, creare un segnaposto per OGNI pagina (con relativa
// chiamata a getPage) bloccava l'interfaccia per secondi prima di mostrare qualsiasi cosa.
// Ora si carica solo una "finestra" di pagine attorno al punto di interesse (il risultato
// della ricerca, o l'inizio del manuale), che si allarga da sola scorrendo verso i bordi.
const WINDOW_RADIUS = 5; // pagine prima/dopo il centro alla prima apertura
const WINDOW_EXTEND = 10; // pagine aggiunte quando si scorre vicino a un bordo della finestra
const WINDOW_MAX = 40; // oltre questa dimensione, si liberano le pagine dal lato opposto
const SEARCH_BATCH = 16; // pagine analizzate in parallelo per blocco durante la ricerca del codice

const els = {};
let manualsByMachineId = new Map(); // machine_id -> Map<linea, riga machine_manuals> (linea '' = generale)
let manualsByMachineName = new Map(); // nome macchina normalizzato (minuscolo) -> Map<linea, riga>
let manualsTableMissing = false;

const state = {
  pdfDoc: null,
  manual: null,
  numPages: 0,
  zoom: 1, // moltiplicatore sopra la scala "adatta alla larghezza", cambia risoluzione di rendering
  fitScale: 1,
  searchTerm: '',
  matches: [], // numeri di pagina (in ordine) che contengono il termine cercato
  matchIndex: -1,
  searchToken: 0, // invalida una ricerca in corso se ne parte un'altra prima che finisca
  pages: [], // SOLO le pagine attualmente nella finestra caricata: { pageNum, page, wrapper, canvas, textLayerEl, highlightEl, rendered, renderToken }
  windowStart: 0, // primo numero di pagina attualmente caricato
  windowEnd: 0, // ultimo numero di pagina attualmente caricato
  extending: false, // true mentre extendWindow() sta aggiungendo pagine (evita richieste doppie)
  loadToken: 0, // invalida i render in corso quando si apre un altro manuale prima che il precedente finisca
  visiblePage: 1,
  observer: null,
  freeObserver: null,
  edgeObserver: null, // osserva le due "sentinelle" ai bordi della finestra per allargarla scorrendo
  pinch: null, // { startDist, startZoom } durante un gesto a due dita
};

// --- CACHE MANUALI (condivisa con machines.js e products.js) -----------

/** Ricarica dal database le mappe machine_id/nome → { linea → manuale }. Va richiamata dopo ogni upload/eliminazione. */
export async function refreshManualsCache() {
  try {
    const { manuals, tableMissing } = await listMachineManuals();
    manualsByMachineId = new Map();
    manualsByMachineName = new Map();
    manuals.forEach((row) => {
      if (!manualsByMachineId.has(row.machine_id)) manualsByMachineId.set(row.machine_id, new Map());
      manualsByMachineId.get(row.machine_id).set(row.linea || '', row);

      const nomeKey = normalizeMachineName(row.machines?.nome).toLowerCase();
      if (nomeKey) {
        if (!manualsByMachineName.has(nomeKey)) manualsByMachineName.set(nomeKey, new Map());
        manualsByMachineName.get(nomeKey).set(row.linea || '', row);
      }
    });
    manualsTableMissing = tableMissing;
  } catch (err) {
    console.warn('Impossibile caricare l\'elenco dei manuali.', err);
  }
  return manualsByMachineId;
}

/**
 * Manuale (riga machine_manuals) per una macchina (per id), con ripiego sul
 * manuale "generale" (linea vuota) se non esiste uno specifico per `linea`.
 */
export function getManualForMachine(machineId, linea = '') {
  const byLinea = machineId && manualsByMachineId.get(machineId);
  if (!byLinea) return null;
  return byLinea.get(linea || '') || byLinea.get('') || null;
}

/** Tutte le varianti (per linea) caricate per una macchina, dato il suo id. Chiave '' = generale. */
export function getManualsForMachine(machineId) {
  return manualsByMachineId.get(machineId) || new Map();
}

/**
 * Manuale per una macchina dato il suo nome testuale (es. `products.macchina`)
 * e la linea del pezzo (es. `products.linea`), con ripiego sul manuale
 * generale della stessa macchina se non ce n'è uno specifico per la linea.
 */
export function getManualForMachineName(nome, linea = '') {
  const key = normalizeMachineName(nome).toLowerCase();
  const byLinea = key && manualsByMachineName.get(key);
  if (!byLinea) return null;
  return byLinea.get(linea || '') || byLinea.get('') || null;
}

export function isManualsTableMissing() {
  return manualsTableMissing;
}

// --- CARICAMENTO LIBRERIA PDF.JS (CDN, caricata solo al primo utilizzo) --

function ensurePdfJs() {
  if (window.pdfjsLib) {
    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
    }
    return Promise.resolve(window.pdfjsLib);
  }
  if (ensurePdfJs._promise) return ensurePdfJs._promise;
  ensurePdfJs._promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`;
    script.onload = () => {
      if (!window.pdfjsLib) {
        reject(new Error('Libreria PDF non disponibile dopo il caricamento.'));
        return;
      }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error('Impossibile caricare il visualizzatore PDF.'));
    document.head.appendChild(script);
  });
  return ensurePdfJs._promise;
}

// --- INIZIALIZZAZIONE MODALE VISUALIZZATORE -----------------------------

export function initManuals() {
  els.modal = document.getElementById('manual-viewer-modal');
  els.title = document.getElementById('manual-viewer-title');
  els.closeBtn = document.getElementById('manual-viewer-close');
  els.canvasWrap = document.getElementById('manual-viewer-canvas-wrap');
  els.pagesWrap = document.getElementById('manual-viewer-pages');
  els.loading = document.getElementById('manual-viewer-loading');
  els.loadingText = document.getElementById('manual-viewer-loading-text');
  els.error = document.getElementById('manual-viewer-error');
  els.errorText = document.getElementById('manual-viewer-error-text');

  els.pageIndicator = document.getElementById('manual-viewer-page-indicator');
  els.zoomInBtn = document.getElementById('manual-viewer-zoom-in');
  els.zoomOutBtn = document.getElementById('manual-viewer-zoom-out');

  els.resultsBar = document.getElementById('manual-viewer-results-bar');
  els.resultsLabel = document.getElementById('manual-viewer-results-label');
  els.prevResultBtn = document.getElementById('manual-viewer-prev-result');
  els.nextResultBtn = document.getElementById('manual-viewer-next-result');

  els.searchForm = document.getElementById('manual-viewer-search-form');
  els.searchInput = document.getElementById('manual-viewer-search-input');

  els.closeBtn?.addEventListener('click', closeViewer);
  els.modal?.addEventListener('click', (e) => {
    if (e.target === els.modal) closeViewer();
  });
  els.zoomInBtn?.addEventListener('click', () => changeZoom(0.25));
  els.zoomOutBtn?.addEventListener('click', () => changeZoom(-0.25));
  els.prevResultBtn?.addEventListener('click', () => stepResult(-1));
  els.nextResultBtn?.addEventListener('click', () => stepResult(1));
  els.searchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(els.searchInput.value);
  });

  initPinchZoom();
}

function closeViewer() {
  closeOverlay(els.modal);
  teardownPages();
  state.pdfDoc = null; // il documento (e la sua memoria) non serve più finché non si riapre
}

function teardownPages() {
  state.observer?.disconnect();
  state.observer = null;
  state.freeObserver?.disconnect();
  state.freeObserver = null;
  state.edgeObserver?.disconnect();
  state.edgeObserver = null;
  els.pagesWrap.innerHTML = '';
  els.pagesWrap.style.transform = 'none';
  els.topSentinel = null;
  els.bottomSentinel = null;
  state.pages = [];
  state.windowStart = 0;
  state.windowEnd = 0;
}

// --- API PUBBLICA: apertura del visualizzatore --------------------------

/**
 * Apre il visualizzatore per un manuale già noto (riga machine_manuals).
 * @param {{ file_name: string, storage_path: string }} manual
 * @param {{ searchTerm?: string }} [opts] se presente, cerca subito il codice e scorre alla prima pagina trovata
 */
export async function openManualViewer(manual, opts = {}) {
  if (!manual) return;
  const token = ++state.loadToken;
  openOverlay(els.modal);
  els.error?.classList.add('hidden');
  els.title.textContent = manual.file_name;
  if (els.searchInput) els.searchInput.value = opts.searchTerm || '';
  setLoading(true);
  teardownPages();

  try {
    const pdfjsLib = await ensurePdfJs();
    const url = await getManualSignedUrl(manual.storage_path);
    const pdfDoc = await pdfjsLib.getDocument(url).promise;
    if (token !== state.loadToken) return; // l'utente ha già aperto un altro manuale nel frattempo

    state.pdfDoc = pdfDoc;
    state.numPages = pdfDoc.numPages;
    state.manual = manual;
    state.zoom = 1;
    state.searchTerm = '';
    state.matches = [];
    state.matchIndex = -1;

    await computeFitScale(token);
    if (token !== state.loadToken) return;

    if (opts.searchTerm) {
      // La ricerca scandisce l'intero documento (indipendentemente dalla finestra di
      // pagine caricate) e, se trova un risultato, costruisce da sola la finestra
      // giusta tramite scrollToPage → buildWindow.
      await runSearch(opts.searchTerm, { silent: true });
      if (token !== state.loadToken) return;
      if (!state.matches.length) {
        toastWarning(`Codice "${opts.searchTerm}" non trovato nel manuale — apro comunque il manuale.`);
        await buildWindow(1, token);
      }
    } else {
      await buildWindow(1, token);
    }
  } catch (err) {
    console.error(err);
    showError('Impossibile aprire questo manuale. Controlla la connessione e riprova.');
  } finally {
    if (token === state.loadToken) setLoading(false);
  }
}

/**
 * Cerca (per nome macchina + linea) il manuale già caricato e lo apre già
 * posizionato sul codice indicato. Usata dalla scheda articolo in Ricambi
 * tecnici, dove `products.macchina`/`products.linea` sono testuali.
 * @param {string} nomeMacchina
 * @param {string} linea es. 'L1', 'L2', 'L1-L2' o '' se non impostata
 * @param {string} codiceArticolo
 */
export async function openManualForMachineName(nomeMacchina, linea, codiceArticolo) {
  const manual = getManualForMachineName(nomeMacchina, linea);
  if (!manual) {
    toastWarning('Nessun manuale caricato per questa macchina/linea. Puoi caricarlo da Impostazioni → Gestione macchine.');
    return;
  }
  await openManualViewer(manual, { searchTerm: codiceArticolo });
}

// --- COSTRUZIONE PAGINE (placeholder + rendering pigro allo scroll) -----

function setLoading(on, message) {
  // #manual-viewer-loading è DENTRO #manual-viewer-canvas-wrap: se rendevamo quest'ultimo
  // "invisible" mentre si caricava, nascondevamo insieme a lui anche lo spinner stesso
  // (la visibilità si eredita) — risultato: schermo scuro e apparentemente bloccato,
  // niente indicatore visibile. L'overlay ha già uno sfondo opaco che copre tutto:
  // basta lui, non serve nascondere il contenitore.
  els.loading?.classList.toggle('hidden', !on);
  if (on && els.loadingText) els.loadingText.textContent = message || 'Apertura manuale…';
}

function showError(message) {
  if (els.error) {
    if (els.errorText) els.errorText.textContent = message;
    els.error.classList.remove('hidden');
  }
  els.canvasWrap?.classList.add('invisible');
}

/** Trova la pagina, tra quelle attualmente caricate, con questo numero. */
function findPageEntry(pageNum) {
  return state.pages.find((entry) => entry.pageNum === pageNum);
}

/** Calcola la scala "adatta alla larghezza" leggendo solo la pagina 1 (veloce, non l'intero documento). */
async function computeFitScale(token) {
  const containerWidth = Math.max(els.canvasWrap.clientWidth - 16, 240);
  const page1 = await state.pdfDoc.getPage(1);
  if (token !== state.loadToken) return;
  const base = page1.getViewport({ scale: 1 });
  state.fitScale = containerWidth / base.width;
}

function updatePageIndicator() {
  if (els.pageIndicator) els.pageIndicator.textContent = `Pagina ${state.visiblePage} di ${state.numPages}`;
}

/**
 * Ricostruisce da zero la finestra di pagine caricate, centrata su `centerPage`
 * (5 pagine prima, 5 dopo — WINDOW_RADIUS). Con manuali da centinaia di pagine è
 * questo, e non l'intero documento, a restare sempre leggero e immediato.
 */
async function buildWindow(centerPage, token) {
  teardownPages(); // pulisce le pagine/observer della finestra precedente (non tocca il documento)
  setupSentinels();
  setupWindowObservers();

  const start = Math.max(1, centerPage - WINDOW_RADIUS);
  const end = Math.min(state.numPages, centerPage + WINDOW_RADIUS);
  for (let p = start; p <= end; p++) {
    if (token !== state.loadToken) return;
    await addPageEntry(p);
  }
  state.windowStart = start;
  state.windowEnd = end;
  state.visiblePage = centerPage >= start && centerPage <= end ? centerPage : start;
  updatePageIndicator();
}

/** Due segnaposto invisibili ai bordi della finestra: quando entrano in vista, la allargano. */
function setupSentinels() {
  els.topSentinel = document.createElement('div');
  els.topSentinel.className = 'w-full h-px';
  els.bottomSentinel = document.createElement('div');
  els.bottomSentinel.className = 'w-full h-px';
  els.pagesWrap.appendChild(els.topSentinel);
  els.pagesWrap.appendChild(els.bottomSentinel);

  state.edgeObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        if (entry.target === els.topSentinel) extendWindow('up');
        else if (entry.target === els.bottomSentinel) extendWindow('down');
      });
    },
    { root: els.canvasWrap, rootMargin: '800px 0px 800px 0px' }
  );
  state.edgeObserver.observe(els.topSentinel);
  state.edgeObserver.observe(els.bottomSentinel);
}

function setupWindowObservers() {
  state.observer = new IntersectionObserver(onPagesIntersect, {
    root: els.canvasWrap,
    rootMargin: '600px 0px 600px 0px', // pre-carica circa uno schermo prima/dopo
    threshold: [0, 0.5],
  });

  // Observer separato, con un margine molto più ampio, dedicato SOLO a liberare la
  // memoria delle pagine ormai lontane. Deve essere più largo di quello sopra: se
  // avessero lo stesso margine, una pagina appena fuori dai 600px verrebbe liberata e
  // poi ri-renderizzata a ogni minimo scroll avanti/indietro (è quello che causava i
  // rallentamenti e i crash della scheda).
  state.freeObserver = new IntersectionObserver(onPagesLeaveFreeZone, {
    root: els.canvasWrap,
    rootMargin: '2400px 0px 2400px 0px',
    threshold: [0],
  });
}

/** Crea il segnaposto di una pagina (dimensioni corrette da subito) e la inserisce in coda o in testa alla finestra. */
async function addPageEntry(p, { prepend = false } = {}) {
  const page = await state.pdfDoc.getPage(p);
  const vp = page.getViewport({ scale: state.fitScale * state.zoom });

  const wrapper = document.createElement('div');
  wrapper.className = 'manual-page relative bg-white shadow-lift rounded';
  wrapper.dataset.page = String(p);
  wrapper.style.width = `${Math.round(vp.width)}px`;
  wrapper.style.height = `${Math.round(vp.height)}px`;

  // Spinner segnaposto: visibile finché la pagina non è stata renderizzata almeno
  // una volta (o dopo essere stata liberata dalla memoria), così si capisce sempre
  // se una pagina sta ancora caricando invece di sembrare "bloccata".
  const spinner = document.createElement('div');
  spinner.className = 'manual-page-spinner absolute inset-0 flex items-center justify-center pointer-events-none';
  spinner.innerHTML = '<i data-lucide="loader-circle" class="w-6 h-6 text-amber-400/70 animate-spin" stroke-width="2"></i>';
  wrapper.appendChild(spinner);

  const entry = { pageNum: p, page, wrapper, spinner, rendered: false };
  if (prepend) {
    els.pagesWrap.insertBefore(wrapper, els.topSentinel.nextSibling);
    state.pages.unshift(entry);
  } else {
    els.pagesWrap.insertBefore(wrapper, els.bottomSentinel);
    state.pages.push(entry);
  }

  state.observer?.observe(wrapper);
  state.freeObserver?.observe(wrapper);
  window.lucide?.createIcons();
  return entry;
}

/** Allarga la finestra di WINDOW_EXTEND pagine verso l'alto o il basso, quando l'utente scorre vicino a un bordo. */
async function extendWindow(direction) {
  if (state.extending) return;
  if (direction === 'up' && state.windowStart <= 1) return;
  if (direction === 'down' && state.windowEnd >= state.numPages) return;

  state.extending = true;
  const token = state.loadToken;
  try {
    if (direction === 'up') {
      const newStart = Math.max(1, state.windowStart - WINDOW_EXTEND);
      const prevScrollHeight = els.canvasWrap.scrollHeight;
      const prevScrollTop = els.canvasWrap.scrollTop;
      for (let p = state.windowStart - 1; p >= newStart; p--) {
        if (token !== state.loadToken) return;
        await addPageEntry(p, { prepend: true });
      }
      state.windowStart = newStart;
      // Compensa lo scroll: aggiungere pagine SOPRA a quelle già a schermo non deve
      // far "saltare" la vista di quanto è alto ciò che è stato appena inserito.
      els.canvasWrap.scrollTop = prevScrollTop + (els.canvasWrap.scrollHeight - prevScrollHeight);
    } else {
      const newEnd = Math.min(state.numPages, state.windowEnd + WINDOW_EXTEND);
      for (let p = state.windowEnd + 1; p <= newEnd; p++) {
        if (token !== state.loadToken) return;
        await addPageEntry(p);
      }
      state.windowEnd = newEnd;
    }
    trimWindowIfNeeded();
  } finally {
    state.extending = false;
  }
}

/** Oltre WINDOW_MAX pagine caricate insieme, libera quelle dal lato più lontano dalla pagina visibile. */
function trimWindowIfNeeded() {
  while (state.windowEnd - state.windowStart + 1 > WINDOW_MAX) {
    const distStart = state.visiblePage - state.windowStart;
    const distEnd = state.windowEnd - state.visiblePage;
    if (distStart > distEnd) removeFirstPageEntry();
    else removeLastPageEntry();
  }
}

function removeFirstPageEntry() {
  const entry = state.pages.shift();
  if (!entry) return;
  state.observer?.unobserve(entry.wrapper);
  state.freeObserver?.unobserve(entry.wrapper);
  freePageCanvas(entry);
  const removedHeight = entry.wrapper.getBoundingClientRect().height;
  entry.wrapper.remove();
  els.canvasWrap.scrollTop -= removedHeight; // idem: rimuovere pagine sopra sposta la vista, va compensato
  state.windowStart = state.pages[0]?.pageNum ?? state.windowStart;
}

function removeLastPageEntry() {
  const entry = state.pages.pop();
  if (!entry) return;
  state.observer?.unobserve(entry.wrapper);
  state.freeObserver?.unobserve(entry.wrapper);
  freePageCanvas(entry);
  entry.wrapper.remove();
  state.windowEnd = state.pages[state.pages.length - 1]?.pageNum ?? state.windowEnd;
}

function onPagesIntersect(entries) {
  let bestRatio = 0;
  let bestPage = null;
  entries.forEach((entry) => {
    const pageNum = Number(entry.target.dataset.page);
    if (entry.isIntersecting) {
      renderPageEntry(findPageEntry(pageNum));
      if (entry.intersectionRatio >= bestRatio) {
        bestRatio = entry.intersectionRatio;
        bestPage = pageNum;
      }
    }
  });
  if (bestPage != null) state.visiblePage = bestPage;
  updatePageIndicator();
}

/** Libera le pagine ormai lontane (fuori dal margine ampio di state.freeObserver). */
function onPagesLeaveFreeZone(entries) {
  entries.forEach((entry) => {
    if (entry.isIntersecting) return;
    const pageNum = Number(entry.target.dataset.page);
    freePageCanvas(findPageEntry(pageNum));
  });
}

/** Libera il canvas/text-layer di una pagina uscita dal margine di precarico. Verrà
 * ri-renderizzata automaticamente quando rientrerà in vista. */
function freePageCanvas(entry) {
  if (!entry || (!entry.rendered && !entry.renderTask)) return;
  entry.rendered = false;
  entry.renderToken = (entry.renderToken || 0) + 1; // scarta un eventuale render ancora in corso
  if (entry.renderTask) {
    // Annulla il render in corso PRIMA di svuotare il canvas: scrivere sul canvas
    // mentre pdf.js ci sta ancora disegnando sopra è ciò che mandava in crash la scheda.
    try {
      entry.renderTask.cancel();
    } catch {
      /* già concluso o già annullato: nessun problema */
    }
    entry.renderTask = null;
  }
  if (entry.canvas) {
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  }
  if (entry.textLayerEl) entry.textLayerEl.innerHTML = '';
  if (entry.highlightEl) entry.highlightEl.innerHTML = '';
  entry.spinner?.classList.remove('hidden');
}

/** Rende (o ri-rende, es. dopo uno zoom) il canvas + text layer + evidenziazioni di una pagina. */
async function renderPageEntry(entry) {
  if (!entry || !state.pdfDoc) return;
  const myToken = (entry.renderToken || 0) + 1;
  entry.renderToken = myToken;

  // Se questa stessa pagina ha già un render in corso (es. richiesta due volte di fila
  // durante uno scroll veloce), annullalo prima di riusare il canvas: lasciare che
  // pdf.js continui a disegnare su un canvas che stiamo per ridimensionare/riassegnare
  // è quello che mandava in crash la scheda (e nel frattempo rallentava tutto).
  if (entry.renderTask) {
    try {
      entry.renderTask.cancel();
    } catch {
      /* già concluso: nessun problema */
    }
    entry.renderTask = null;
  }

  const scale = state.fitScale * state.zoom;
  const viewport = entry.page.getViewport({ scale });

  entry.wrapper.style.width = `${Math.round(viewport.width)}px`;
  entry.wrapper.style.height = `${Math.round(viewport.height)}px`;

  if (!entry.canvas) {
    entry.canvas = document.createElement('canvas');
    entry.canvas.className = 'block rounded';
    entry.wrapper.appendChild(entry.canvas);
    entry.highlightEl = document.createElement('div');
    entry.highlightEl.className = 'absolute inset-0 pointer-events-none';
    entry.wrapper.appendChild(entry.highlightEl);
    entry.textLayerEl = document.createElement('div');
    entry.textLayerEl.className = 'textLayer';
    entry.wrapper.appendChild(entry.textLayerEl);
  }

  // Risoluzione di rendering più alta della resa a schermo, per un testo nitido anche
  // quando si aumenta lo zoom (non solo pixel-perfect al 100%) — ma mai oltre il budget
  // di sicurezza MAX_CANVAS_PIXELS, altrimenti il canvas rischia di apparire nero.
  const desiredOutputScale = (window.devicePixelRatio || 1) * 1.5;
  const viewportArea = viewport.width * viewport.height;
  const outputScale =
    viewportArea * desiredOutputScale * desiredOutputScale > MAX_CANVAS_PIXELS
      ? Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / viewportArea))
      : desiredOutputScale;
  entry.canvas.width = Math.floor(viewport.width * outputScale);
  entry.canvas.height = Math.floor(viewport.height * outputScale);
  entry.canvas.style.width = `${Math.floor(viewport.width)}px`;
  entry.canvas.style.height = `${Math.floor(viewport.height)}px`;

  const ctx = entry.canvas.getContext('2d');
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
  const renderTask = entry.page.render({ canvasContext: ctx, viewport, transform });
  entry.renderTask = renderTask;
  try {
    await renderTask.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.warn('Rendering pagina interrotto.', err);
    return; // annullato volutamente (nuovo render, zoom, o pagina liberata nel frattempo)
  } finally {
    if (entry.renderTask === renderTask) entry.renderTask = null;
  }
  if (myToken !== entry.renderToken) return; // superata da un render più recente (es. altro zoom)
  entry.spinner?.classList.add('hidden'); // il canvas ha già del contenuto valido da qui in poi

  entry.textLayerEl.innerHTML = '';
  entry.textLayerEl.style.width = `${Math.floor(viewport.width)}px`;
  entry.textLayerEl.style.height = `${Math.floor(viewport.height)}px`;
  const content = await entry.page.getTextContent();
  if (myToken !== entry.renderToken) return;

  try {
    // Vero text layer di pdf.js: testo reale (trasparente) sovrapposto al
    // disegno del canvas, così si può tenere premuto e selezionare un codice
    // esattamente come in un lettore PDF nativo.
    const task = window.pdfjsLib.renderTextLayer({
      textContentSource: content,
      container: entry.textLayerEl,
      viewport,
    });
    await task.promise;
  } catch (err) {
    console.warn('Text layer non disponibile per questa pagina (selezione testo disattivata).', err);
  }

  entry.highlightEl.innerHTML = '';
  entry.highlightEl.style.width = `${Math.floor(viewport.width)}px`;
  entry.highlightEl.style.height = `${Math.floor(viewport.height)}px`;
  if (state.searchTerm) {
    // Per l'evidenziazione serve la larghezza VERA di ogni singolo frammento di testo:
    // il `content` qui sopra ha combineTextItems attivo (il default, utile per la
    // selezione naturale del testo), che unisce più frammenti della stessa riga in un
    // solo elemento — compresi eventuali spazi di riempimento per allineare le tabelle —
    // gonfiandone la larghezza complessiva e producendo riquadri enormi. Con
    // disableCombineTextItems ogni frammento resta separato, con la sua larghezza reale.
    const preciseContent = await entry.page.getTextContent({ disableCombineTextItems: true });
    if (myToken !== entry.renderToken) return;
    drawHighlights(entry, preciseContent, viewport, state.searchTerm);
  }

  entry.rendered = true;
  window.lucide?.createIcons();
}

async function renderAllRenderedPages() {
  await Promise.all(state.pages.filter((p) => p.rendered).map((p) => renderPageEntry(p)));
}

// --- ZOOM (pulsanti +/- e pinch a due dita isolato al solo PDF) ---------

async function changeZoom(delta) {
  await applyZoom(state.zoom + delta);
}

/**
 * Applica un nuovo livello di zoom mantenendo fermo, sotto le dita (pinch) o al centro
 * dell'area visibile (pulsanti +/-), lo stesso punto del PDF — su entrambi gli assi X e Y.
 * @param {number} newZoom
 * @param {{ clientX: number, clientY: number }} [anchor] punto in coordinate schermo da tenere fermo; default: centro dell'area di lettura
 */
async function applyZoom(newZoom, anchor) {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +newZoom.toFixed(2)));
  if (clamped === state.zoom) return;

  const wrap = els.canvasWrap;
  const wrapRect = wrap.getBoundingClientRect();
  const anchorClientX = anchor?.clientX ?? wrapRect.left + wrap.clientWidth / 2;
  const anchorClientY = anchor?.clientY ?? wrapRect.top + wrap.clientHeight / 2;

  // Trova la pagina esatta sotto il punto di ancoraggio e memorizza la posizione
  // RELATIVA a quella pagina (0-1 sui due assi). È l'unico modo per tenerla ferma dopo
  // il ridimensionamento: gli spazi fissi tra una pagina e l'altra (i "gap") non si
  // ingrandiscono con lo zoom come le pagine, quindi una proporzione sull'intero scroll
  // sbaglierebbe di quel tanto e la vista "scivolerebbe" verso il basso dopo il pinch.
  const anchorEntry = findPageEntryAtClientY(anchorClientY) || findPageEntry(state.visiblePage);
  let fracX = 0.5;
  let fracY = 0.5;
  if (anchorEntry?.wrapper) {
    const pageRect = anchorEntry.wrapper.getBoundingClientRect();
    if (pageRect.width) fracX = (anchorClientX - pageRect.left) / pageRect.width;
    if (pageRect.height) fracY = (anchorClientY - pageRect.top) / pageRect.height;
  }

  state.zoom = clamped;
  await renderAllRenderedPages();
  // Anche le pagine non ancora renderizzate hanno bisogno delle nuove dimensioni segnaposto:
  state.pages.forEach((entry) => {
    if (!entry.rendered) {
      const vp = entry.page.getViewport({ scale: state.fitScale * state.zoom });
      entry.wrapper.style.width = `${Math.round(vp.width)}px`;
      entry.wrapper.style.height = `${Math.round(vp.height)}px`;
    }
  });

  if (anchorEntry?.wrapper) {
    // Ora che la pagina ha le nuove dimensioni, calcola dove si trova ORA lo stesso
    // punto relativo e sposta lo scroll di conseguenza (differenza in coordinate
    // schermo, valida qualunque sia il sistema di riferimento usato per lo scroll).
    const pageRectAfter = anchorEntry.wrapper.getBoundingClientRect();
    const targetClientX = pageRectAfter.left + fracX * pageRectAfter.width;
    const targetClientY = pageRectAfter.top + fracY * pageRectAfter.height;
    wrap.scrollLeft += targetClientX - anchorClientX;
    wrap.scrollTop += targetClientY - anchorClientY;
  }
}

/** Trova la pagina la cui area (verticale) contiene il punto `clientY` dato. */
function findPageEntryAtClientY(clientY) {
  return state.pages.find((entry) => {
    if (!entry.wrapper) return false;
    const rect = entry.wrapper.getBoundingClientRect();
    return clientY >= rect.top && clientY <= rect.bottom;
  });
}

/** Pinch a due dita SOLO sull'area del PDF: mai sul resto dell'interfaccia (che non ha questo listener). */
function initPinchZoom() {
  const wrap = els.canvasWrap;
  if (!wrap) return;
  let rafId = null;
  let pendingScale = null;

  const applyPreview = () => {
    rafId = null;
    if (pendingScale != null) els.pagesWrap.style.transform = `scale(${pendingScale})`;
  };

  wrap.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        const midClientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midClientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        state.pinch = { startDist: touchDistance(e.touches), startZoom: state.zoom, midClientX, midClientY };
        // Ancora la scala esattamente al punto tra le due dita (in coordinate locali,
        // non scalate, del contenuto): è ciò che rende il pinch fluido e "naturale"
        // invece che uno zoom fisso dall'alto che fa scappare il contenuto dalle dita.
        const pagesRect = els.pagesWrap.getBoundingClientRect();
        els.pagesWrap.style.transformOrigin = `${midClientX - pagesRect.left}px ${midClientY - pagesRect.top}px`;
      }
    },
    { passive: true }
  );

  wrap.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length === 2 && state.pinch) {
        e.preventDefault(); // impedisce il residuo scroll/gesto nativo durante il pinch
        state.pinch.midClientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        state.pinch.midClientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const dist = touchDistance(e.touches);
        const previewZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.pinch.startZoom * (dist / state.pinch.startDist)));
        state.pinch.previewZoom = previewZoom;
        // Anteprima istantanea via CSS (solo il contenitore delle pagine, mai il resto
        // dell'interfaccia), aggiornata al massimo una volta per frame per un movimento fluido.
        pendingScale = previewZoom / state.zoom;
        if (rafId == null) rafId = requestAnimationFrame(applyPreview);
      }
    },
    { passive: false }
  );

  const commitPinch = () => {
    if (!state.pinch) return;
    const { previewZoom, midClientX, midClientY } = state.pinch;
    state.pinch = null;
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    pendingScale = null;
    els.pagesWrap.style.transform = 'none';
    els.pagesWrap.style.transformOrigin = 'top center';
    // Ri-renderizza a piena nitidezza alla nuova risoluzione, mantenendo fermo sotto le
    // dita lo stesso punto del PDF su cui si è pinchato (sia in orizzontale sia in verticale).
    if (previewZoom) applyZoom(previewZoom, { clientX: midClientX, clientY: midClientY });
  };
  wrap.addEventListener('touchend', commitPinch);
  wrap.addEventListener('touchcancel', commitPinch);
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// --- RICERCA DEL CODICE NEL TESTO DEL PDF --------------------------------

function updateResultsBar() {
  const hasResults = state.matches.length > 0;
  els.resultsBar?.classList.toggle('hidden', !hasResults);
  if (!hasResults) return;
  if (els.resultsLabel) {
    els.resultsLabel.textContent = `"${state.searchTerm}" — pagina ${state.matchIndex + 1} di ${state.matches.length}`;
  }
}

async function stepResult(direction) {
  if (!state.matches.length) return;
  state.matchIndex = (state.matchIndex + direction + state.matches.length) % state.matches.length;
  // Feedback immediato al tocco: senza questo, se la pagina di destinazione non è
  // ancora renderizzata, sembra che il pulsante non abbia risposto al tocco.
  setResultsNavBusy(true);
  await scrollToPage(state.matches[state.matchIndex]);
  setResultsNavBusy(false);
  updateResultsBar();
}

function setResultsNavBusy(busy) {
  [els.prevResultBtn, els.nextResultBtn].forEach((btn) => {
    btn?.toggleAttribute('disabled', busy);
    btn?.classList.toggle('opacity-40', busy);
  });
  if (busy && els.resultsLabel) els.resultsLabel.textContent = 'Caricamento…';
}

/** Scorre alla pagina `pageNum`: se non è nella finestra attualmente caricata, la ricostruisce lì attorno. */
async function scrollToPage(pageNum) {
  const token = state.loadToken;
  let entry = findPageEntry(pageNum);
  if (!entry) {
    await buildWindow(pageNum, token);
    if (token !== state.loadToken) return;
    entry = findPageEntry(pageNum);
    if (!entry) return;
  }
  // Renderizza PRIMA di scorrere: se lo scroll "smooth" fosse già in corso mentre la
  // pagina riceve canvas e text layer (con il relativo micro-cambio di layout), il
  // browser può interrompere l'animazione a metà strada — è quello che faceva
  // "atterrare" all'inizio della finestra (5 pagine prima) invece che sul risultato.
  if (!entry.rendered) await renderPageEntry(entry);
  if (token !== state.loadToken) return;
  entry.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function yieldToBrowser() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function setSearchBusy(busy) {
  els.searchInput?.toggleAttribute('disabled', busy);
  const submitBtn = els.searchForm?.querySelector('button[type="submit"]');
  submitBtn?.toggleAttribute('disabled', busy);
  submitBtn?.classList.toggle('opacity-50', busy);
  els.prevResultBtn?.toggleAttribute('disabled', busy);
  els.nextResultBtn?.toggleAttribute('disabled', busy);
  if (busy) {
    els.resultsBar?.classList.remove('hidden');
    if (els.resultsLabel) els.resultsLabel.textContent = 'Ricerca in corso…';
  }
}

/**
 * Cerca `term` in TUTTO il manuale (indipendentemente da quali pagine sono attualmente
 * caricate) ed evidenzia/scorre alla prima pagina trovata. Su manuali da centinaia di
 * pagine, elaborare tutto in un solo colpo bloccava l'interfaccia: qui si procede a
 * blocchi paralleli, lasciando "respirare" il browser tra un blocco e l'altro, e con un
 * indicatore "Ricerca in corso…" così si vede chiaramente che sta lavorando.
 */
async function runSearch(term, { silent = false } = {}) {
  const clean = (term || '').trim();
  const searchToken = ++state.searchToken;
  if (!state.pdfDoc || !clean) {
    state.searchTerm = '';
    state.matches = [];
    state.matchIndex = -1;
    updateResultsBar();
    await renderAllRenderedPages(); // toglie eventuali evidenziazioni residue
    return;
  }
  state.searchTerm = clean;
  const lower = clean.toLowerCase();
  const matches = [];

  setSearchBusy(true);
  try {
    for (let start = 1; start <= state.numPages; start += SEARCH_BATCH) {
      if (searchToken !== state.searchToken) return; // è partita un'altra ricerca nel frattempo
      const end = Math.min(state.numPages, start + SEARCH_BATCH - 1);
      const batch = await Promise.all(
        Array.from({ length: end - start + 1 }, (_, i) => start + i).map(async (p) => {
          const page = await state.pdfDoc.getPage(p);
          const content = await page.getTextContent();
          const text = content.items.map((it) => it.str).join(' ').toLowerCase();
          return text.includes(lower) ? p : null;
        })
      );
      batch.forEach((p) => {
        if (p) matches.push(p);
      });
      // Avanzamento reale (non un generico "in corso"): compare nello spinner grande se
      // il manuale si sta aprendo ora, o nella barra risultati se si sta cercando a
      // manuale già aperto — a seconda di quale dei due è visibile in questo momento.
      const progress = `Ricerca di "${clean}"… ${end}/${state.numPages}`;
      if (els.loading && !els.loading.classList.contains('hidden') && els.loadingText) {
        els.loadingText.textContent = progress;
      }
      if (els.resultsLabel) els.resultsLabel.textContent = progress;
      await yieldToBrowser(); // niente più freeze: il browser può ridisegnare lo spinner tra un blocco e l'altro
    }
  } finally {
    setSearchBusy(false);
  }
  if (searchToken !== state.searchToken) return;

  state.matches = matches;
  state.matchIndex = matches.length ? 0 : -1;
  updateResultsBar();
  if (matches.length) {
    await scrollToPage(matches[0]);
    await renderAllRenderedPages(); // per far comparire l'evidenziazione anche sulle pagine già a schermo
  } else {
    if (!silent) toastError(`Nessuna pagina contiene "${clean}".`);
    state.searchTerm = ''; // niente evidenziazioni residue di una ricerca senza risultati
    await renderAllRenderedPages();
  }
}

/**
 * Evidenzia con un riquadro stretto (largo quanto il codice, non l'intera riga) ogni
 * occorrenza di `term` nel testo della pagina.
 */
function drawHighlights(entry, content, viewport, term) {
  const lower = term.toLowerCase();
  let full = '';
  const spans = []; // { start, end, item }
  content.items.forEach((item) => {
    const start = full.length;
    full += `${item.str} `;
    spans.push({ start, end: full.length - 1, item });
  });
  const fullLower = full.toLowerCase();
  let idx = fullLower.indexOf(lower);
  while (idx !== -1) {
    const matchEnd = idx + lower.length;
    spans.forEach(({ start, end, item }) => {
      if (start < matchEnd && end > idx && item.str.trim()) {
        const localStart = Math.max(0, idx - start);
        const localEnd = Math.min(item.str.length, matchEnd - start);
        if (localEnd > localStart) drawHighlightBox(entry, item, viewport, localStart, localEnd);
      }
    });
    idx = fullLower.indexOf(lower, idx + 1);
  }
}

function drawHighlightBox(entry, item, viewport, localStart, localEnd) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib?.Util) return;
  const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const scaleX = Math.hypot(tx[0], tx[1]) || 1;
  const fontHeight = Math.hypot(tx[2], tx[3]) || 10;
  const totalWidth = Math.max((item.width || 0) * scaleX, 1);
  const charWidth = totalWidth / Math.max(item.str.length, 1);

  const x = tx[4] + charWidth * localStart;
  const width = Math.max(charWidth * (localEnd - localStart), 4);
  const top = tx[5] - fontHeight;

  const box = document.createElement('div');
  box.className = 'manual-highlight';
  box.style.left = `${x}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${fontHeight * 1.15}px`;
  entry.highlightEl.appendChild(box);
}
