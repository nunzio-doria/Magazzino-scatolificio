// =============================================================
// manuals.js — Manuali ricambi (PDF) delle macchine: cache condivisa
// (usata da machines.js in Impostazioni e da products.js in Ricambi
// tecnici) + visualizzatore PDF interno con ricerca del codice.
//
// Il PDF viene sempre aperto DENTRO l'app (canvas + pdf.js), mai in una
// scheda del browser o in un'app esterna: l'utente resta sul manuale con
// i pulsanti di navigazione (pagina, occorrenze del codice, zoom) sempre
// a portata di pollice.
// =============================================================

import { listMachineManuals, getManualSignedUrl, normalizeMachineName } from './supabase.js';
import { toastError, toastWarning } from './toast.js';
import { openOverlay, closeOverlay } from './ui-utils.js';

const PDFJS_VERSION = '3.11.174';

const els = {};
let manualsByMachineId = new Map(); // machine_id -> riga machine_manuals
let manualsByMachineName = new Map(); // nome macchina normalizzato -> riga machine_manuals
let manualsTableMissing = false;

const state = {
  pdfDoc: null,
  manual: null,
  currentPage: 1,
  numPages: 0,
  zoom: 1, // moltiplicatore sopra la scala "adatta alla larghezza"
  searchTerm: '',
  matches: [], // numeri di pagina (in ordine) che contengono il termine cercato
  matchIndex: -1,
  renderSeq: 0, // scarta render di pagine ormai superate da una navigazione più recente
};

// --- CACHE MANUALI (condivisa con machines.js e products.js) -----------

/** Ricarica dal database le mappe machine_id/nome → manuale. Va richiamata dopo ogni upload/eliminazione. */
export async function refreshManualsCache() {
  try {
    const { manuals, tableMissing } = await listMachineManuals();
    manualsByMachineId = manuals;
    manualsByMachineName = new Map();
    manuals.forEach((row) => {
      const nome = normalizeMachineName(row.machines?.nome);
      if (nome) manualsByMachineName.set(nome.toLowerCase(), row);
    });
    manualsTableMissing = tableMissing;
  } catch (err) {
    console.warn('Impossibile caricare l\'elenco dei manuali.', err);
  }
  return manualsByMachineId;
}

/** Manuale (riga machine_manuals) già caricato per una macchina, dato il suo id. */
export function getManualForMachine(machineId) {
  if (!machineId) return null;
  return manualsByMachineId.get(machineId) || null;
}

/** Manuale già caricato per una macchina, dato il suo nome testuale (es. il campo `products.macchina`). */
export function getManualForMachineName(nome) {
  const key = normalizeMachineName(nome).toLowerCase();
  if (!key) return null;
  return manualsByMachineName.get(key) || null;
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
  els.canvas = document.getElementById('manual-viewer-canvas');
  els.highlightLayer = document.getElementById('manual-viewer-highlights');
  els.loading = document.getElementById('manual-viewer-loading');
  els.error = document.getElementById('manual-viewer-error');
  els.errorText = document.getElementById('manual-viewer-error-text');

  els.pageIndicator = document.getElementById('manual-viewer-page-indicator');
  els.prevPageBtn = document.getElementById('manual-viewer-prev-page');
  els.nextPageBtn = document.getElementById('manual-viewer-next-page');
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
  els.prevPageBtn?.addEventListener('click', () => goToPage(state.currentPage - 1));
  els.nextPageBtn?.addEventListener('click', () => goToPage(state.currentPage + 1));
  els.zoomInBtn?.addEventListener('click', () => changeZoom(0.2));
  els.zoomOutBtn?.addEventListener('click', () => changeZoom(-0.2));
  els.prevResultBtn?.addEventListener('click', () => stepResult(-1));
  els.nextResultBtn?.addEventListener('click', () => stepResult(1));
  els.searchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(els.searchInput.value);
  });
}

function closeViewer() {
  closeOverlay(els.modal);
  state.pdfDoc = null; // il documento (e la sua memoria) non serve più finché non si riapre
}

// --- API PUBBLICA: apertura del visualizzatore --------------------------

/**
 * Apre il visualizzatore per un manuale già noto (riga machine_manuals).
 * @param {{ file_name: string, storage_path: string }} manual
 * @param {{ searchTerm?: string }} [opts] se presente, cerca subito il codice e salta alla prima pagina trovata
 */
export async function openManualViewer(manual, opts = {}) {
  if (!manual) return;
  openOverlay(els.modal);
  resetViewerUI();
  els.title.textContent = manual.file_name;
  setLoading(true);
  try {
    const pdfjsLib = await ensurePdfJs();
    const url = await getManualSignedUrl(manual.storage_path);
    const pdfDoc = await pdfjsLib.getDocument(url).promise;

    state.pdfDoc = pdfDoc;
    state.manual = manual;
    state.numPages = pdfDoc.numPages;
    state.zoom = 1;
    state.currentPage = 1;
    state.searchTerm = '';
    state.matches = [];
    state.matchIndex = -1;
    if (els.searchInput) els.searchInput.value = opts.searchTerm || '';

    if (opts.searchTerm) {
      await runSearch(opts.searchTerm, { silent: true });
      if (!state.matches.length) {
        toastWarning(`Codice "${opts.searchTerm}" non trovato nel manuale — apro comunque la prima pagina.`);
        await renderPage(1);
      }
    } else {
      await renderPage(1);
    }
  } catch (err) {
    console.error(err);
    showError('Impossibile aprire questo manuale. Controlla la connessione e riprova.');
  } finally {
    setLoading(false);
  }
}

/**
 * Cerca (per nome macchina) il manuale già caricato e lo apre già
 * posizionato sul codice indicato. Usata dalla scheda articolo in Ricambi
 * tecnici, dove `products.macchina` è un nome testuale.
 * @param {string} nomeMacchina
 * @param {string} codiceArticolo
 */
export async function openManualForMachineName(nomeMacchina, codiceArticolo) {
  const manual = getManualForMachineName(nomeMacchina);
  if (!manual) {
    toastWarning('Nessun manuale caricato per questa macchina. Puoi caricarlo da Impostazioni → Gestione macchine.');
    return;
  }
  await openManualViewer(manual, { searchTerm: codiceArticolo });
}

// --- RENDER / NAVIGAZIONE -------------------------------------------------

function resetViewerUI() {
  els.error?.classList.add('hidden');
  els.highlightLayer.innerHTML = '';
  updateResultsBar();
  updatePageIndicator();
}

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

async function goToPage(pageNum) {
  const clamped = Math.min(Math.max(1, pageNum), state.numPages || 1);
  if (clamped === state.currentPage) return;
  await renderPage(clamped);
}

async function changeZoom(delta) {
  state.zoom = Math.min(2.5, Math.max(0.5, +(state.zoom + delta).toFixed(2)));
  await renderPage(state.currentPage);
}

async function renderPage(pageNum) {
  if (!state.pdfDoc) return;
  const seq = ++state.renderSeq;
  state.currentPage = pageNum;
  updatePageIndicator();
  updateResultsBar();

  const page = await state.pdfDoc.getPage(pageNum);
  if (seq !== state.renderSeq) return; // l'utente ha già cambiato pagina nel frattempo

  const containerWidth = Math.max(els.canvasWrap.clientWidth - 4, 240);
  const baseViewport = page.getViewport({ scale: 1 });
  const fitScale = containerWidth / baseViewport.width;
  const viewport = page.getViewport({ scale: fitScale * state.zoom });

  const outputScale = window.devicePixelRatio || 1;
  const canvas = els.canvas;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  els.highlightLayer.style.width = `${Math.floor(viewport.width)}px`;
  els.highlightLayer.style.height = `${Math.floor(viewport.height)}px`;

  const ctx = canvas.getContext('2d');
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
  await page.render({ canvasContext: ctx, viewport, transform }).promise;
  if (seq !== state.renderSeq) return;

  els.highlightLayer.innerHTML = '';
  if (state.searchTerm) {
    const content = await page.getTextContent();
    if (seq !== state.renderSeq) return;
    drawHighlights(content, viewport, state.searchTerm);
  }
  window.lucide?.createIcons();
}

function updatePageIndicator() {
  if (els.pageIndicator) els.pageIndicator.textContent = `Pagina ${state.currentPage} di ${state.numPages || '—'}`;
  if (els.prevPageBtn) els.prevPageBtn.disabled = state.currentPage <= 1;
  if (els.nextPageBtn) els.nextPageBtn.disabled = state.currentPage >= state.numPages;
}

function updateResultsBar() {
  const hasResults = state.matches.length > 0;
  els.resultsBar?.classList.toggle('hidden', !hasResults);
  if (!hasResults) return;
  const posInResults = state.matches.indexOf(state.currentPage);
  const shownIndex = posInResults >= 0 ? posInResults : state.matchIndex;
  if (els.resultsLabel) {
    els.resultsLabel.textContent = `"${state.searchTerm}" — pagina ${shownIndex + 1} di ${state.matches.length}`;
  }
}

async function stepResult(direction) {
  if (!state.matches.length) return;
  const current = state.matches.indexOf(state.currentPage);
  const base = current >= 0 ? current : state.matchIndex;
  state.matchIndex = (base + direction + state.matches.length) % state.matches.length;
  await renderPage(state.matches[state.matchIndex]);
}

// --- RICERCA DEL CODICE NEL TESTO DEL PDF --------------------------------

/**
 * Cerca `term` in tutte le pagine del manuale corrente (estrazione testo via
 * pdf.js, senza ri-renderizzare le pagine) e salta alla prima pagina trovata.
 */
async function runSearch(term, { silent = false } = {}) {
  const clean = (term || '').trim();
  if (!state.pdfDoc || !clean) {
    state.searchTerm = '';
    state.matches = [];
    state.matchIndex = -1;
    updateResultsBar();
    return;
  }
  state.searchTerm = clean;
  const lower = clean.toLowerCase();
  const matches = [];
  for (let p = 1; p <= state.numPages; p++) {
    const page = await state.pdfDoc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(' ').toLowerCase();
    if (text.includes(lower)) matches.push(p);
  }
  state.matches = matches;
  state.matchIndex = matches.length ? 0 : -1;
  if (matches.length) {
    await renderPage(matches[0]);
  } else {
    if (!silent) toastError(`Nessuna pagina contiene "${clean}".`);
    state.searchTerm = ''; // niente evidenziazioni residue di una ricerca senza risultati
    els.highlightLayer.innerHTML = '';
    updateResultsBar();
  }
}

/** Evidenzia con un riquadro semitrasparente ogni occorrenza di `term` nel testo della pagina già renderizzata. */
function drawHighlights(content, viewport, term) {
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
  const highlighted = new Set();
  while (idx !== -1) {
    const matchEnd = idx + lower.length;
    spans.forEach(({ start, end, item }, i) => {
      if (start < matchEnd && end > idx && item.str.trim() && !highlighted.has(i)) {
        highlighted.add(i);
        drawHighlightBox(item, viewport);
      }
    });
    idx = fullLower.indexOf(lower, idx + 1);
  }
}

function drawHighlightBox(item, viewport) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib?.Util) return;
  const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const scaleX = Math.hypot(tx[0], tx[1]) || 1;
  const fontHeight = Math.hypot(tx[2], tx[3]) || 10;
  const width = Math.max((item.width || 0) * scaleX, 6);
  const x = tx[4];
  const top = tx[5] - fontHeight;
  const box = document.createElement('div');
  box.className = 'manual-highlight';
  box.style.left = `${x}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${fontHeight * 1.15}px`;
  els.highlightLayer.appendChild(box);
}
