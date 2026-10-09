// =============================================================
// global-search.js — Ricerca articoli e scansione rapida nella testata.
// - Campo "Cerca articolo…": al tocco si apre un pannello sotto la testata (con velo);
//   i risultati compaiono mentre si scrive. Un tocco su un articolo apre la sua scheda;
//   in Movimenti ogni risultato ha anche Deposito / Prelievo, che aprono il cassetto
//   del movimento già con l'articolo scelto.
// - Pulsante fotocamera: cassetto con scansione immediata del codice; dopo la lettura
//   offre scheda e, in Movimenti, Deposito/Prelievo.
// Tasto indietro del telefono, Esc e tocco sul velo chiudono il pannello.
// =============================================================

import { listProducts, getProductByBarcode, getCachedProductByBarcode, searchCachedProducts } from './supabase.js';
import { isNetworkError } from './offline-queue.js';
import { startCamera, stopCamera } from './camera.js';
import { openOverlay, closeOverlay, enableSheetDrag, replayAnimation, modalCloseMs } from './ui-utils.js';
import { pushLayer, releaseLayer } from './nav-history.js';
import { openDetail } from './products-detail.js';
import { startMovement } from './scanner.js';
import { CATEGORY_LABELS, shelfLabel, escapeHtml } from './products-shared.js';
import { toastError } from './toast.js';
import feedback from './feedback.js';

const BADGE = {
  cuscinetti: 'bg-graphite-700 text-graphite-200',
  cinghie: 'bg-emerald-500/15 text-emerald-700',
  pezzi_ricambio: 'bg-amber-500/15 text-amber-300',
};
const SEARCH_SVG =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

const el = {};
let panelOpen = false;
let layer = null; // voce della cronologia (tasto indietro)
let seq = 0;
let debounce = null;
let results = [];
let initialized = false;

const inMovements = () => {
  const v = document.getElementById('view-scanner');
  return !!v && !v.classList.contains('hidden');
};

export function initGlobalSearch() {
  if (initialized) return;
  initialized = true;
  el.header = document.querySelector('header.app-header');
  el.layer = document.getElementById('hsearch-layer');
  el.backdrop = document.getElementById('hsearch-backdrop');
  el.panel = document.getElementById('hsearch-panel');
  el.input = document.getElementById('hsearch-input');
  el.clear = document.getElementById('hsearch-clear');
  el.scanBtn = document.getElementById('hsearch-scan-btn');
  el.qsModal = document.getElementById('qs-modal');
  el.qsPanel = document.getElementById('qs-panel');
  el.qsCamera = document.getElementById('qs-camera-collapse');
  el.qsReader = document.getElementById('qs-reader');
  el.qsResult = document.getElementById('qs-result');
  if (!el.input || !el.panel) return;

  el.input.addEventListener('focus', openPanel);
  el.input.addEventListener('input', onInput);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
    if (e.key === 'Enter' && results[0]) {
      e.preventDefault();
      pick(results[0], 'scheda');
    }
  });
  el.clear.addEventListener('click', () => {
    feedback.clearInput();
    el.input.value = '';
    onInput();
    el.input.focus({ preventScroll: true });
  });
  el.backdrop.addEventListener('click', () => closePanel());
  el.panel.addEventListener('click', onPanelClick);
  el.scanBtn?.addEventListener('click', () => {
    closePanel({ clear: true });
    openQuickScan();
  });
  window.visualViewport?.addEventListener('resize', fitPanel);

  enableSheetDrag(el.qsPanel, closeQuickScan);
  document.getElementById('qs-close-btn')?.addEventListener('click', closeQuickScan);
  el.qsModal.addEventListener('overlay-back', (e) => {
    e.preventDefault();
    closeQuickScan();
  });
  el.qsModal.addEventListener('overlay-cancel', () => stopCamera());
  el.qsResult.addEventListener('click', onQsResultClick);
}

/** Chiude e azzera la ricerca (logout). */
export function resetGlobalSearch() {
  closePanel({ clear: true, silent: true });
  clearTimeout(debounce);
  seq += 1;
  if (el.qsModal?.dataset.modalOpen) closeQuickScan();
}

function openPanel() {
  if (panelOpen) return;
  panelOpen = true;
  el.layer.classList.add('hs-open');
  el.layer.setAttribute('aria-hidden', 'false');
  el.header.classList.add('hs-active');
  layer = pushLayer(() => {
    layer = null;
    closePanel({ fromBack: true });
  });
  fitPanel();
  if (el.input.value.trim()) runSearch(el.input.value.trim());
  else renderHint();
}

export function closePanel({ clear = false, fromBack = false, silent = false } = {}) {
  if (!el.input) return;
  if (panelOpen) {
    panelOpen = false;
    el.layer.classList.remove('hs-open');
    el.layer.setAttribute('aria-hidden', 'true');
    el.header.classList.remove('hs-active');
    if (layer && !fromBack) releaseLayer(layer);
    layer = null;
    if (!silent) feedback.overlayClose();
  }
  el.input.blur();
  if (clear) {
    el.input.value = '';
    el.clear?.classList.remove('on');
    results = [];
  }
}

/** Il pannello non deve finire sotto la tastiera: altezza = spazio visibile sotto la testata. */
function fitPanel() {
  if (!panelOpen) return;
  const top = el.header.getBoundingClientRect().bottom + 8;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  el.panel.style.maxHeight = `${Math.max(180, vh - top - 12)}px`;
}

function onInput() {
  const term = el.input.value.trim();
  el.clear.classList.toggle('on', el.input.value !== '');
  clearTimeout(debounce);
  if (!term) {
    seq += 1;
    results = [];
    renderHint();
    return;
  }
  debounce = setTimeout(() => runSearch(term), 220);
}

function renderHint() {
  el.panel.innerHTML = `<div class="hs-hint">${SEARCH_SVG}<p>Digita il codice dell'articolo<br>oppure scansionalo con la fotocamera.</p></div>`;
}

async function runSearch(term) {
  const mySeq = ++seq;
  if (!el.panel.querySelector('.hs-row')) {
    el.panel.innerHTML =
      '<div class="hs-skel space-y-3"><div class="skeleton h-10 w-full"></div><div class="skeleton h-10 w-4/5"></div><div class="skeleton h-10 w-3/5"></div></div>';
  }
  let list = [];
  let offline = false;
  try {
    list = await listProducts({ search: term });
  } catch (err) {
    if (!isNetworkError(err)) console.error(err);
    list = searchCachedProducts(term);
    offline = true;
  }
  if (mySeq !== seq || !panelOpen) return; // risposta superata da una digitazione più recente
  results = list.slice(0, 30);
  renderResults(offline);
}

function renderResults(offline) {
  if (!results.length) {
    el.panel.innerHTML = `<div class="hs-hint">${SEARCH_SVG}<p>Nessun articolo trovato.</p></div>`;
    return;
  }
  const withActions = inMovements();
  const rows = results
    .map((p, i) => {
      const sub = [shelfLabel(p), p.macchina].filter(Boolean).join(' · ');
      const badge = BADGE[p.categoria] || 'bg-graphite-700 text-graphite-200';
      const label = CATEGORY_LABELS[p.categoria] || p.categoria;
      return `
        <div class="hs-row" style="--i:${Math.min(i, 7)}">
          <button type="button" class="hs-main" data-i="${i}" data-act="scheda">
            <span class="min-w-0">
              <span class="hs-code">${escapeHtml(p.codice_articolo)}</span>
              ${sub ? `<span class="hs-sub">${escapeHtml(sub)}</span>` : ''}
            </span>
            <span class="shrink-0 whitespace-nowrap px-2 py-0.5 rounded-full ui-label font-display font-semibold uppercase tracking-wide ${badge}">${escapeHtml(label)}</span>
          </button>
          ${
            withActions
              ? `<div class="hs-actions">
                  <button type="button" class="hs-btn hs-btn--dep font-display" data-i="${i}" data-act="deposito">Deposito</button>
                  <button type="button" class="hs-btn hs-btn--pre font-display" data-i="${i}" data-act="prelievo">Prelievo</button>
                </div>`
              : ''
          }
        </div>`;
    })
    .join('');
  el.panel.innerHTML = (offline ? '<p class="hs-note">Offline: risultati dall\'ultima sincronizzazione.</p>' : '') + rows;
}

function onPanelClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const product = results[Number(btn.dataset.i)];
  if (product) pick(product, btn.dataset.act);
}

/** Azione scelta su un articolo: 'scheda' | 'deposito' | 'prelievo'. */
function pick(product, act) {
  closePanel({ clear: true });
  // Un attimo per far chiudere il pannello prima che si apra il cassetto: nessuna sovrapposizione.
  setTimeout(() => runAction(product, act), 140);
}

function runAction(product, act) {
  if (act === 'deposito' || act === 'prelievo') startMovement(product, act);
  else openDetail(product);
}

/* ------------------------------------------------------------ scansione rapida */

let lastCode = null;
let lastCodeAt = 0;
let qsProduct = null;

function openQuickScan() {
  qsProduct = null;
  el.qsResult.classList.add('hidden');
  el.qsResult.innerHTML = '';
  openOverlay(el.qsModal);
  startQsCamera();
}

function startQsCamera() {
  el.qsResult.classList.add('hidden');
  el.qsCamera.classList.add('expanded');
  startCamera('qs-reader', onQsCode, {
    focusHintEl: document.getElementById('qs-focus-hint'),
    switchBtnEl: document.getElementById('qs-switch-btn'),
    torchBtnEl: document.getElementById('qs-torch-btn'),
    errorHint: 'Usa il campo di ricerca in alto.',
  }).then((started) => {
    if (started === false) el.qsCamera.classList.remove('expanded');
  });
}

function closeQuickScan() {
  stopCamera();
  closeOverlay(el.qsModal);
}

async function onQsCode(code) {
  const now = Date.now();
  if (code === lastCode && now - lastCodeAt < 2500) return;
  lastCode = code;
  lastCodeAt = now;
  try {
    let product;
    try {
      product = await getProductByBarcode(code);
    } catch (netErr) {
      product = getCachedProductByBarcode(code);
      if (!product) throw netErr;
    }
    if (!product) {
      feedback.scanNotFound();
      replayAnimation(el.qsReader, 'reader-flash-fail');
      toastError(`Nessun articolo trovato per il codice "${code}".`);
      return;
    }
    feedback.scanFound();
    replayAnimation(el.qsReader, 'reader-flash-ok');
    showQsResult(product);
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    replayAnimation(el.qsReader, 'reader-flash-fail');
    toastError('Errore nella ricerca articolo.');
  }
}

function showQsResult(product) {
  qsProduct = product;
  stopCamera();
  el.qsCamera.classList.remove('expanded');
  const sub = [shelfLabel(product), product.macchina].filter(Boolean).join(' · ');
  const badge = BADGE[product.categoria] || 'bg-graphite-700 text-graphite-200';
  const label = CATEGORY_LABELS[product.categoria] || product.categoria;
  el.qsResult.innerHTML = `
    <div class="qs-found">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="hs-code text-lg">${escapeHtml(product.codice_articolo)}</p>
          ${sub ? `<p class="hs-sub mt-0.5">${escapeHtml(sub)}</p>` : ''}
        </div>
        <span class="shrink-0 whitespace-nowrap px-2 py-0.5 rounded-full ui-label font-display font-semibold uppercase tracking-wide ${badge}">${escapeHtml(label)}</span>
      </div>
      <div class="mt-4 flex flex-col gap-2">
        ${
          inMovements()
            ? `<div class="flex gap-2">
                <button type="button" class="hs-btn hs-btn--lg hs-btn--dep font-display" data-qs="deposito">Deposito</button>
                <button type="button" class="hs-btn hs-btn--lg hs-btn--pre font-display" data-qs="prelievo">Prelievo</button>
              </div>`
            : ''
        }
        <button type="button" class="hs-btn hs-btn--lg hs-btn--info font-display" data-qs="scheda">Scheda articolo</button>
        <button type="button" class="qs-link" data-qs="again">Scansiona un altro codice</button>
      </div>
    </div>`;
  el.qsResult.classList.remove('hidden');
}

function onQsResultClick(e) {
  const btn = e.target.closest('[data-qs]');
  if (!btn || !qsProduct) return;
  const act = btn.dataset.qs;
  if (act === 'again') {
    lastCode = null;
    startQsCamera();
    return;
  }
  const product = qsProduct;
  closeOverlay(el.qsModal);
  setTimeout(() => runAction(product, act), Math.round(modalCloseMs() * 0.55));
}
