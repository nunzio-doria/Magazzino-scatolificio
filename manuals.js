// =============================================================
// manuals.js — Visualizzatore PDF dei manuali delle macchine: file
// principale. Rendering/scroll a finestra, zoom (pulsanti e pinch) e
// scrollbar personalizzata restano qui; la ricerca per parola chiave è in
// manuals-search.js, la cache dei manuali (usata anche da machines.js e
// products.js) è in manuals-data.js — entrambe riesportate da qui perché
// altri file già le importano da "./manuals.js".
//
// Il PDF viene sempre aperto DENTRO l'app: pagine incolonnate in scroll
// continuo, pinch-to-zoom che scala solo il PDF e mai il resto
// dell'interfaccia, testo selezionabile con pressione prolungata (vero
// text layer di pdf.js) ed evidenziazione puntuale del codice cercato.
// =============================================================

import { getManualSignedUrl } from './supabase.js';
import { toastWarning } from './toast.js';
import { openOverlay, closeOverlay } from './ui-utils.js';
import { runSearch, drawHighlights, stepResult } from './manuals-search.js';
import {
  refreshManualsCache,
  getManualForMachine,
  getManualsForMachine,
  getManualForMachineName,
  isManualsTableMissing,
  getAnyManualForMachine,
  getOperatorManualsForMachine,
  isOperatorManualsTableMissing,
  getSectionsForOperatorManual,
  isSectionsTableMissing,
} from './manuals-data.js';

export {
  refreshManualsCache,
  getManualForMachine,
  getManualsForMachine,
  getManualForMachineName,
  isManualsTableMissing,
  getAnyManualForMachine,
  getOperatorManualsForMachine,
  isOperatorManualsTableMissing,
  getSectionsForOperatorManual,
  isSectionsTableMissing,
};

const PDFJS_VERSION = '3.11.174';
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
// Limite di pixel (larghezza × altezza) per il canvas di una singola pagina. Oltre questa
// soglia, soprattutto con più pagine ad alta risoluzione tenute in memoria insieme, iOS/Safari
// può svuotare silenziosamente il canvas (appare tutto nero): meglio restare ben al di sotto.
const MAX_CANVAS_PIXELS = 4_000_000;
// Ogni pagina dell'intervallo aperto (l'intera sezione, o tutto il manuale) ha da subito il
// suo segnaposto, senza chiamare getPage: la dimensione arriva dalla pagina di riferimento
// e si corregge da sola quando la pagina viene davvero renderizzata. Così la lunghezza dello
// scroll è sempre quella vera e non ci sono più finestre che si allargano o si trimmano.

export const els = {};

export const state = {
  pdfDoc: null,
  manual: null,
  numPages: 0,
  zoom: 1, // moltiplicatore sopra la scala "adatta alla larghezza", cambia risoluzione di rendering
  fitScale: 1,
  searchTerm: '',
  matches: [], // numeri di pagina (in ordine) che contengono il termine cercato
  matchIndex: -1,
  searchToken: 0, // invalida una ricerca in corso se ne parte un'altra prima che finisca
  rangeStart: 1, // prima pagina navigabile (l'inizio della sezione, o 1)
  rangeEnd: 1, // ultima pagina navigabile (la fine della sezione, o l'ultima del manuale)
  pages: [], // una voce per OGNI pagina dell'intervallo, in ordine: { pageNum, page, baseW, baseH, wrapper, canvas, textLayerEl, highlightEl, rendered, rendering, renderToken }
  loadToken: 0, // invalida i render in corso quando si apre un altro manuale prima che il precedente finisca
  visiblePage: 1,
  observer: null,
  freeObserver: null,
  pinch: null, // { startDist, startZoom } durante un gesto a due dita
};

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

  els.pageInput = document.getElementById('manual-viewer-page-input');
  els.pageTotal = document.getElementById('manual-viewer-page-total');
  els.pageForm = document.getElementById('manual-viewer-page-form');
  els.zoomInBtn = document.getElementById('manual-viewer-zoom-in');
  els.zoomOutBtn = document.getElementById('manual-viewer-zoom-out');

  els.scrollbarTrack = document.getElementById('manual-viewer-scrollbar');
  els.scrollbarThumb = document.getElementById('manual-viewer-scrollbar-thumb');

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
  els.pageForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const target = Math.round(Number(els.pageInput.value));
    if (Number.isFinite(target)) scrollToPage(target);
    els.pageInput.blur();
  });

  els.canvasWrap?.addEventListener('scroll', scheduleVisiblePageUpdate, { passive: true });
  initPinchZoom();
  initCustomScrollbar();
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
 * @param {{ file_name: string, storage_path: string, bucket?: string }} manual `bucket` distingue manuali ricambi/operatore (vedi supabase.js); se assente si usa il bucket manuali ricambi.
 * @param {{ searchTerm?: string, startPage?: number, endPage?: number, title?: string }} opts `startPage`/`endPage` limitano il visualizzatore a quelle pagine (usato dai pulsanti/sezioni): non si può scorrere fuori dall'intervallo; ignorati se è presente `searchTerm`. `title` sostituisce il nome del file mostrato in alto (es. il nome del pulsante da cui si è aperto), altrimenti si vede il nome del file.
 * @param {{ searchTerm?: string }} [opts] se presente, cerca subito il codice e scorre alla prima pagina trovata
 */
export async function openManualViewer(manual, opts = {}) {
  if (!manual) return;
  const token = ++state.loadToken;
  openOverlay(els.modal);
  els.error?.classList.add('hidden');
  els.title.textContent = opts.title || manual.file_name;
  if (els.searchInput) els.searchInput.value = opts.searchTerm || '';
  setLoading(true);
  teardownPages();

  try {
    const pdfjsLib = await ensurePdfJs();
    const url = await getManualSignedUrl(manual.storage_path, manual.bucket);
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
      // Ricerca su tutto il manuale: prima si preparano i segnaposto di tutte le pagine,
      // poi runSearch scorre da sola al primo risultato.
      state.rangeStart = 1;
      state.rangeEnd = state.numPages;
      await buildPages(1, token);
      if (token !== state.loadToken) return;
      await runSearch(opts.searchTerm, { silent: true });
      if (token !== state.loadToken) return;
      if (!state.matches.length) {
        toastWarning(`Codice "${opts.searchTerm}" non trovato nel manuale — apro comunque il manuale.`);
      }
    } else if (opts.startPage) {
      // Sezione: l'intervallo è bloccato tra pagina iniziale e finale (entrambe incluse).
      const first = Math.min(Math.max(1, Math.round(opts.startPage)), state.numPages);
      const last = opts.endPage ? Math.min(Math.max(first, Math.round(opts.endPage)), state.numPages) : state.numPages;
      state.rangeStart = first;
      state.rangeEnd = last;
      await buildPages(first, token);
      if (token !== state.loadToken) return;
    } else {
      state.rangeStart = 1;
      state.rangeEnd = state.numPages;
      await buildPages(1, token);
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
  await openManualViewer(manual, { searchTerm: codiceArticolo, title: 'Manuale ricambi' });
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

/** Trova la voce di una pagina (le pagine sono contigue, quindi basta l'indice). */
function findPageEntry(pageNum) {
  const entry = state.pages[pageNum - state.rangeStart];
  return entry && entry.pageNum === pageNum ? entry : undefined;
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
  if (els.pageTotal) els.pageTotal.textContent = `di ${state.rangeEnd || state.numPages || '—'}`;
  if (els.pageInput && document.activeElement !== els.pageInput) {
    els.pageInput.value = state.visiblePage;
    els.pageInput.min = state.rangeStart || 1;
    els.pageInput.max = state.rangeEnd || '';
  }
}

// --- SCROLLBAR PERSONALIZZATA (binario sempre sul bordo destro, trascinabile) ---

const scrollbarState = { dragging: false, pointerId: null, startY: 0, startScrollTop: 0, raf: 0 };

function initCustomScrollbar() {
  const track = els.scrollbarTrack;
  const thumb = els.scrollbarThumb;
  const wrap = els.canvasWrap;
  if (!track || !thumb || !wrap) return;

  wrap.addEventListener('scroll', () => {
    if (scrollbarState.raf) return;
    scrollbarState.raf = requestAnimationFrame(() => {
      scrollbarState.raf = 0;
      updateCustomScrollbar();
    });
  });

  // Le dimensioni del contenuto cambiano con zoom, apertura di un nuovo manuale e
  // allargamento della finestra di pagine: un ResizeObserver sul contenuto intercetta
  // tutti questi casi da solo, senza dover richiamare l'aggiornamento da ogni punto
  // del codice che tocca le pagine.
  if (window.ResizeObserver) {
    new ResizeObserver(() => updateCustomScrollbar()).observe(els.pagesWrap);
  }

  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    scrollbarState.dragging = true;
    scrollbarState.pointerId = e.pointerId;
    scrollbarState.startY = e.clientY;
    scrollbarState.startScrollTop = wrap.scrollTop;
    thumb.classList.add('dragging');
    thumb.setPointerCapture(e.pointerId);
  });
  thumb.addEventListener('pointermove', (e) => {
    if (!scrollbarState.dragging || e.pointerId !== scrollbarState.pointerId) return;
    const trackHeight = track.clientHeight;
    const thumbHeight = thumb.offsetHeight;
    const scrollable = wrap.scrollHeight - wrap.clientHeight;
    const range = Math.max(1, trackHeight - thumbHeight);
    const deltaPx = e.clientY - scrollbarState.startY;
    wrap.scrollTop = scrollbarState.startScrollTop + (deltaPx / range) * scrollable;
  });
  const endDrag = (e) => {
    if (!scrollbarState.dragging) return;
    scrollbarState.dragging = false;
    thumb.classList.remove('dragging');
    try {
      thumb.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* già rilasciato */
    }
  };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);

  // Tocco/click sul binario (non sulla maniglia): salta subito a quel punto, come una
  // scrollbar nativa da scrivania.
  track.addEventListener('pointerdown', (e) => {
    if (e.target !== track) return;
    const trackRect = track.getBoundingClientRect();
    const thumbHeight = thumb.offsetHeight;
    const targetTop = Math.min(Math.max(0, e.clientY - trackRect.top - thumbHeight / 2), trackRect.height - thumbHeight);
    const range = Math.max(1, trackRect.height - thumbHeight);
    const scrollable = wrap.scrollHeight - wrap.clientHeight;
    wrap.scrollTop = (targetTop / range) * scrollable;
  });
}

/** Dimensiona e posiziona la maniglia in base allo scroll attuale; nasconde tutto se il contenuto non eccede l'area visibile. */
function updateCustomScrollbar() {
  const track = els.scrollbarTrack;
  const thumb = els.scrollbarThumb;
  const wrap = els.canvasWrap;
  if (!track || !thumb || !wrap) return;
  const scrollable = wrap.scrollHeight - wrap.clientHeight;
  if (scrollable <= 4) {
    track.classList.add('hidden');
    return;
  }
  track.classList.remove('hidden');
  const trackHeight = track.clientHeight;
  const thumbHeight = Math.max(28, (wrap.clientHeight / wrap.scrollHeight) * trackHeight);
  const thumbTop = (wrap.scrollTop / scrollable) * (trackHeight - thumbHeight);
  thumb.style.height = `${thumbHeight}px`;
  thumb.style.top = `${thumbTop}px`;
}

function setupWindowObservers() {
  state.observer = new IntersectionObserver(onPagesIntersect, {
    root: els.canvasWrap,
    rootMargin: '600px 0px 600px 0px', // pre-carica circa uno schermo prima/dopo
    threshold: [0],
  });

  // Observer separato, con un margine molto più ampio, dedicato SOLO a liberare la
  // memoria delle pagine ormai lontane. Deve essere più largo di quello sopra: se
  // avessero lo stesso margine, una pagina appena fuori dai 600px verrebbe liberata e
  // poi ri-renderizzata a ogni minimo scroll avanti/indietro.
  state.freeObserver = new IntersectionObserver(onPagesLeaveFreeZone, {
    root: els.canvasWrap,
    rootMargin: '2400px 0px 2400px 0px',
    threshold: [0],
  });
}

/** Applica al segnaposto la dimensione della pagina alla scala corrente. */
function sizeEntry(entry) {
  const scale = state.fitScale * state.zoom;
  entry.wrapper.style.width = `${Math.round(entry.baseW * scale)}px`;
  entry.wrapper.style.height = `${Math.round(entry.baseH * scale)}px`;
}

/**
 * Quando la dimensione reale di una pagina differisce da quella ipotizzata, la corregge
 * e, se la pagina è già SOPRA l'area visibile, compensa lo scroll di quanto è cambiata
 * la sua altezza: chi sta leggendo non deve vedere la pagina scivolare.
 */
function resizeEntryKeepingView(entry, baseW, baseH) {
  const wrap = els.canvasWrap;
  const above = entry.wrapper.getBoundingClientRect().bottom <= wrap.getBoundingClientRect().top;
  const oldHeight = entry.wrapper.offsetHeight;
  entry.baseW = baseW;
  entry.baseH = baseH;
  sizeEntry(entry);
  if (above) wrap.scrollTop += entry.wrapper.offsetHeight - oldHeight;
}

/**
 * Crea i segnaposto di TUTTE le pagine dell'intervallo (state.rangeStart..rangeEnd) e
 * porta la vista sulla pagina `targetPage`. Nessuna finestra mobile, nessuna pagina che
 * si aggiunge o sparisce mentre si scorre: l'intervallo è quello e basta.
 */
async function buildPages(targetPage, token) {
  teardownPages();
  setupWindowObservers();

  const target = Math.min(Math.max(targetPage, state.rangeStart), state.rangeEnd);
  const refPage = await state.pdfDoc.getPage(target);
  if (token !== state.loadToken) return;
  const base = refPage.getViewport({ scale: 1 });

  const frag = document.createDocumentFragment();
  for (let p = state.rangeStart; p <= state.rangeEnd; p++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'manual-page relative bg-white shadow-lift rounded';
    wrapper.dataset.page = String(p);
    // Spinner segnaposto: visibile finché la pagina non è stata renderizzata (o dopo
    // essere stata liberata dalla memoria), così si capisce sempre che sta caricando.
    const spinner = document.createElement('div');
    spinner.className = 'manual-page-spinner absolute inset-0 flex items-center justify-center pointer-events-none';
    spinner.innerHTML = '<span class="block w-6 h-6 rounded-full border-2 border-amber-400/70 border-t-transparent animate-spin"></span>';
    wrapper.appendChild(spinner);
    const entry = { pageNum: p, page: p === target ? refPage : null, baseW: base.width, baseH: base.height, wrapper, spinner, rendered: false, rendering: false };
    sizeEntry(entry);
    frag.appendChild(wrapper);
    state.pages.push(entry);
  }
  els.pagesWrap.appendChild(frag);
  state.pages.forEach((entry) => {
    state.observer.observe(entry.wrapper);
    state.freeObserver.observe(entry.wrapper);
  });

  await scrollToPage(target);
  updateCustomScrollbar();
}

function onPagesIntersect(entries) {
  entries.forEach((e) => {
    const entry = findPageEntry(Number(e.target.dataset.page));
    if (!entry) return;
    if (e.isIntersecting) {
      renderPageEntry(entry);
    } else if (entry.rendering && !entry.rendered) {
      // Scroll veloce: una pagina ormai superata smette di lavorare invece di intasare la coda.
      freePageCanvas(entry);
    }
  });
}

/** Pagina corrente = quella che contiene un punto a circa un terzo dell'altezza visibile (non dipende da quali pagine sono già renderizzate). */
let visiblePageRaf = 0;
function scheduleVisiblePageUpdate() {
  if (visiblePageRaf || !state.pages.length) return;
  visiblePageRaf = requestAnimationFrame(() => {
    visiblePageRaf = 0;
    const wrap = els.canvasWrap;
    if (!wrap || !state.pages.length) return;
    const y = wrap.scrollTop + wrap.clientHeight / 3;
    let lo = 0;
    let hi = state.pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (state.pages[mid].wrapper.offsetTop <= y) lo = mid;
      else hi = mid - 1;
    }
    const page = state.pages[lo].pageNum;
    if (page !== state.visiblePage) {
      state.visiblePage = page;
      updatePageIndicator();
    }
  });
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
  if (!entry || (!entry.rendered && !entry.renderTask && !entry.rendering)) return;
  entry.rendered = false;
  entry.rendering = false;
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
async function renderPageEntry(entry, { force = false } = {}) {
  if (!entry || !state.pdfDoc) return;
  // Una pagina già renderizzata, o in corso di rendering, non va rifatta a ogni passaggio
  // nell'observer (azzerare il canvas la farebbe lampeggiare in bianco): solo con force (zoom, evidenziazioni).
  if (!force && (entry.rendered || entry.rendering)) return;
  const myToken = (entry.renderToken || 0) + 1;
  entry.renderToken = myToken;
  entry.rendering = true;
  try {
    await renderPageEntryInner(entry, myToken);
  } finally {
    if (entry.renderToken === myToken) entry.rendering = false;
  }
}

async function renderPageEntryInner(entry, myToken) {

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

  if (!entry.page) {
    const pdfDoc = state.pdfDoc;
    const page = await pdfDoc.getPage(entry.pageNum);
    if (myToken !== entry.renderToken || pdfDoc !== state.pdfDoc || !entry.wrapper.isConnected) return;
    entry.page = page;
  }
  const realBase = entry.page.getViewport({ scale: 1 });
  if (Math.abs(realBase.width - entry.baseW) > 0.5 || Math.abs(realBase.height - entry.baseH) > 0.5) {
    resizeEntryKeepingView(entry, realBase.width, realBase.height);
  }

  const scale = state.fitScale * state.zoom;
  const viewport = entry.page.getViewport({ scale });

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

export async function renderAllRenderedPages() {
  await Promise.all(state.pages.filter((p) => p.rendered).map((p) => renderPageEntry(p, { force: true })));
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
  // Tutte le pagine (anche quelle non ancora renderizzate) ricevono subito le nuove
  // dimensioni, così il layout è coerente prima di riposizionare lo scroll.
  state.pages.forEach(sizeEntry);

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
  await renderAllRenderedPages();
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

/** Scorre alla pagina `pageNum` (sempre dentro l'intervallo aperto: una sezione non permette di uscirne). */
export async function scrollToPage(pageNum) {
  const token = state.loadToken;
  if (!state.pages.length) return;
  const target = Math.min(Math.max(Math.round(pageNum) || state.rangeStart, state.rangeStart), state.rangeEnd);
  const entry = findPageEntry(target);
  if (!entry) return;
  // Salto istantaneo: i segnaposto hanno già l'altezza giusta, quindi la posizione è esatta
  // e non c'è nessuna animazione che un cambio di layout possa interrompere a metà.
  const wrap = els.canvasWrap;
  const top = entry.wrapper.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop - 8;
  wrap.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  state.visiblePage = target;
  updatePageIndicator();
  await renderPageEntry(entry);
  if (token !== state.loadToken) return;
}
