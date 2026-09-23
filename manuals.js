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

const els = {};
let manualsByMachineId = new Map(); // machine_id -> Map<linea, riga machine_manuals> (linea '' = generale)
let manualsByMachineName = new Map(); // nome macchina normalizzato (minuscolo) -> Map<linea, riga>
let manualsTableMissing = false;

const state = {
  pdfDoc: null,
  manual: null,
  zoom: 1, // moltiplicatore sopra la scala "adatta alla larghezza", cambia risoluzione di rendering
  fitScale: 1,
  searchTerm: '',
  matches: [], // numeri di pagina (in ordine) che contengono il termine cercato
  matchIndex: -1,
  pages: [], // { pageNum, page, wrapper, canvas, textLayerEl, highlightEl, rendered, renderToken }
  loadToken: 0, // invalida i render in corso quando si apre un altro manuale prima che il precedente finisca
  visiblePage: 1,
  observer: null,
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
  els.pagesWrap.innerHTML = '';
  els.pagesWrap.style.transform = 'none';
  state.pages = [];
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
    state.manual = manual;
    state.zoom = 1;
    state.searchTerm = '';
    state.matches = [];
    state.matchIndex = -1;

    await buildPageShells(token);
    if (token !== state.loadToken) return;

    if (opts.searchTerm) {
      await runSearch(opts.searchTerm, { silent: true });
      if (!state.matches.length) {
        toastWarning(`Codice "${opts.searchTerm}" non trovato nel manuale — apro comunque il manuale.`);
      }
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

function setLoading(on) {
  els.loading?.classList.toggle('hidden', !on);
  els.canvasWrap?.classList.toggle('invisible', on);
}

function showError(message) {
  if (els.error) {
    if (els.errorText) els.errorText.textContent = message;
    els.error.classList.remove('hidden');
  }
  els.canvasWrap?.classList.add('invisible');
}

/** Crea un div segnaposto per ogni pagina (dimensioni corrette da subito, per uno scroll stabile) e osserva quali entrano in vista. */
async function buildPageShells(token) {
  const containerWidth = Math.max(els.canvasWrap.clientWidth - 16, 240);
  const numPages = state.pdfDoc.numPages;
  state.pages = [];

  for (let p = 1; p <= numPages; p++) {
    const page = await state.pdfDoc.getPage(p);
    if (token !== state.loadToken) return;
    const base = page.getViewport({ scale: 1 });
    if (p === 1) state.fitScale = containerWidth / base.width;

    const wrapper = document.createElement('div');
    wrapper.className = 'manual-page relative bg-white shadow-lift rounded';
    wrapper.dataset.page = String(p);
    wrapper.style.width = `${Math.round(base.width * state.fitScale)}px`;
    wrapper.style.height = `${Math.round(base.height * state.fitScale)}px`;
    els.pagesWrap.appendChild(wrapper);

    // Spinner segnaposto: visibile finché la pagina non è stata renderizzata almeno
    // una volta (o dopo essere stata liberata dalla memoria), così si capisce sempre
    // se una pagina sta ancora caricando invece di sembrare "bloccata".
    const spinner = document.createElement('div');
    spinner.className = 'manual-page-spinner absolute inset-0 flex items-center justify-center pointer-events-none';
    spinner.innerHTML = '<i data-lucide="loader-circle" class="w-6 h-6 text-amber-400/70 animate-spin" stroke-width="2"></i>';
    wrapper.appendChild(spinner);

    state.pages.push({ pageNum: p, page, wrapper, spinner, rendered: false });
  }

  els.pageIndicator.textContent = `Pagina 1 di ${numPages}`;
  window.lucide?.createIcons();

  state.observer = new IntersectionObserver(onPagesIntersect, {
    root: els.canvasWrap,
    rootMargin: '600px 0px 600px 0px', // pre-carica circa uno schermo prima/dopo
    threshold: [0, 0.5],
  });
  state.pages.forEach((entry) => state.observer.observe(entry.wrapper));

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
  state.pages.forEach((entry) => state.freeObserver.observe(entry.wrapper));
}

function onPagesIntersect(entries) {
  let bestRatio = 0;
  entries.forEach((entry) => {
    const pageNum = Number(entry.target.dataset.page);
    const pageEntry = state.pages[pageNum - 1];
    if (entry.isIntersecting) {
      renderPageEntry(pageEntry);
      if (entry.intersectionRatio >= bestRatio) {
        bestRatio = entry.intersectionRatio;
        state.visiblePage = pageNum;
      }
    }
  });
  if (els.pageIndicator) els.pageIndicator.textContent = `Pagina ${state.visiblePage} di ${state.pages.length}`;
}

/** Libera le pagine ormai lontane (fuori dal margine ampio di state.freeObserver). */
function onPagesLeaveFreeZone(entries) {
  entries.forEach((entry) => {
    if (entry.isIntersecting) return;
    const pageNum = Number(entry.target.dataset.page);
    freePageCanvas(state.pages[pageNum - 1]);
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
  if (state.searchTerm) drawHighlights(entry, content, viewport, state.searchTerm);

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
  const anchorEntry = findPageEntryAtClientY(anchorClientY) || state.pages[state.visiblePage - 1];
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

async function scrollToPage(pageNum) {
  const entry = state.pages[pageNum - 1];
  if (!entry) return;
  entry.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!entry.rendered) await renderPageEntry(entry);
}

/** Cerca `term` in tutte le pagine del manuale (estrazione testo via pdf.js) e scorre alla prima pagina trovata. */
async function runSearch(term, { silent = false } = {}) {
  const clean = (term || '').trim();
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
  for (const entry of state.pages) {
    const content = await entry.page.getTextContent();
    const text = content.items.map((it) => it.str).join(' ').toLowerCase();
    if (text.includes(lower)) matches.push(entry.pageNum);
  }
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
