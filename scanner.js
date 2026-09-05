// =============================================================
// scanner.js — Scansione barcode con fotocamera + flusso deposito/prelievo
// =============================================================

import {
  getProductByBarcode,
  processTransaction,
  listProducts,
  listTransactions,
  getCachedProductByBarcode,
  adjustCachedProductQuantity,
} from './supabase.js';
import { toastSuccess, toastError, toastWarning, toastInfo } from './toast.js';
import { startCamera, stopCamera, switchCamera as switchCameraShared, toggleTorch } from './camera.js';
import feedback from './feedback.js';
import { enqueueTransaction, onQueueChange, getQueueCount, isNetworkError } from './offline-queue.js';
import { animateNumber, replayAnimation, emptyStateHtml } from './ui-utils.js';

const CONTINUOUS_MODE_KEY = 'magazzino-scanner-continuous';

let currentMode = null; // 'deposito' | 'prelievo'
let currentProduct = null;
let continuousMode = false;
try {
  continuousMode = localStorage.getItem(CONTINUOUS_MODE_KEY) === '1';
} catch (err) {
  continuousMode = false;
}

const els = {};

export function initScanner() {
  els.modeDeposito = document.getElementById('mode-deposito');
  els.modePrelievo = document.getElementById('mode-prelievo');
  els.readerWrap = document.getElementById('scanner-reader-wrap');
  els.reader = document.getElementById('scanner-reader');
  els.manualForm = document.getElementById('manual-barcode-form');
  els.manualInput = document.getElementById('manual-barcode-input');
  els.resultCard = document.getElementById('scan-result-card');
  els.resultSkeleton = document.getElementById('scan-result-skeleton');
  els.productName = document.getElementById('scan-product-name');
  els.productCode = document.getElementById('scan-product-code');
  els.productStock = document.getElementById('scan-product-stock');
  els.productLoc = document.getElementById('scan-product-loc');
  els.qtyInput = document.getElementById('scan-qty-input');
  els.puntoInput = document.getElementById('scan-punto-input');
  els.confirmBtn = document.getElementById('scan-confirm-btn');
  els.cancelBtn = document.getElementById('scan-cancel-btn');
  els.modeBanner = document.getElementById('scan-mode-banner');
  els.stopCameraBtn = document.getElementById('scanner-stop-btn');
  els.switchCameraBtn = document.getElementById('scanner-switch-btn');
  els.torchBtn = document.getElementById('scanner-torch-btn');
  els.focusHint = document.getElementById('scanner-focus-hint');
  els.idlePanel = document.getElementById('scanner-idle-panel');
  els.lowStockCountEl = document.getElementById('scanner-lowstock-count');
  els.recentListEl = document.getElementById('scanner-recent-list');
  els.recentEmptyEl = document.getElementById('scanner-recent-empty');
  els.continuousToggle = document.getElementById('scanner-continuous-toggle');
  els.offlineBadge = document.getElementById('scanner-offline-badge');
  els.offlineBadgeCount = document.getElementById('scanner-offline-badge-count');

  els.modeDeposito.addEventListener('click', () => selectMode('deposito'));
  els.modePrelievo.addEventListener('click', () => selectMode('prelievo'));
  els.manualForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = els.manualInput.value.trim();
    if (code) handleDetectedCode(code);
    els.manualInput.value = '';
  });
  els.cancelBtn.addEventListener('click', () => {
    feedback.cancelAction();
    resetResult();
  });
  els.confirmBtn.addEventListener('click', confirmTransaction);
  els.stopCameraBtn.addEventListener('click', () => {
    stopCamera();
    els.stopCameraBtn.classList.add('hidden');
    els.switchCameraBtn.classList.add('hidden');
    els.torchBtn?.classList.add('hidden');
    els.focusHint?.classList.add('hidden');
  });
  els.switchCameraBtn.addEventListener('click', () =>
    switchCameraShared(handleDetectedCode, { focusHintEl: els.focusHint, switchBtnEl: els.switchCameraBtn, torchBtnEl: els.torchBtn })
  );
  els.torchBtn?.addEventListener('click', () => toggleTorch(els.torchBtn));

  if (els.continuousToggle) {
    els.continuousToggle.checked = continuousMode;
    els.continuousToggle.addEventListener('change', () => {
      continuousMode = els.continuousToggle.checked;
      try {
        localStorage.setItem(CONTINUOUS_MODE_KEY, continuousMode ? '1' : '0');
      } catch (err) {
        /* ignorabile */
      }
      feedback.modeSelect();
      toastInfo(continuousMode ? 'Scansione continua attiva: conferma automatica a quantità 1.' : 'Scansione continua disattivata.', 3000);
    });
  }

  onQueueChange(updateOfflineBadge);
  updateOfflineBadge(getQueueCount());

  resetAll();
  loadIdlePanel();
}

function updateOfflineBadge(count) {
  if (!els.offlineBadge) return;
  els.offlineBadge.classList.toggle('hidden', !count);
  if (els.offlineBadgeCount) els.offlineBadgeCount.textContent = count;
}

function selectMode(mode) {
  feedback.modeSelect();
  currentMode = mode;
  els.modeDeposito.classList.toggle('mode-active-deposito', mode === 'deposito');
  els.modePrelievo.classList.toggle('mode-active-prelievo', mode === 'prelievo');

  els.modeBanner.textContent = mode === 'deposito' ? 'Modalità DEPOSITO — inquadra il barcode' : 'Modalità PRELIEVO — inquadra il barcode';
  els.modeBanner.className = `text-center text-sm font-display font-semibold tracking-wide uppercase py-2 rounded-md ${
    mode === 'deposito' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-300'
  }`;
  els.modeBanner.classList.remove('hidden');
  els.readerWrap.classList.remove('hidden');
  els.manualForm.classList.remove('hidden');
  els.idlePanel.classList.add('hidden');

  startCamera('scanner-reader', handleDetectedCode, {
    focusHintEl: els.focusHint,
    switchBtnEl: els.switchCameraBtn,
    torchBtnEl: els.torchBtn,
  }).then((started) => {
    if (started) els.stopCameraBtn.classList.remove('hidden');
  });
}

let lastCode = null;
let lastCodeAt = 0;

async function handleDetectedCode(code) {
  // Debounce: evita letture duplicate ravvicinate dello stesso codice.
  // In modalità continua l'intervallo è più corto, per non rallentare
  // la scansione ravvicinata di più pezzi identici.
  const debounceMs = continuousMode ? 900 : 2500;
  const now = Date.now();
  if (code === lastCode && now - lastCodeAt < debounceMs) return;
  lastCode = code;
  lastCodeAt = now;

  if (!currentMode) {
    feedback.scanNoMode();
    toastWarning('Seleziona prima DEPOSITO o PRELIEVO.');
    return;
  }

  if (!continuousMode) showResultSkeleton();
  try {
    let product;
    let fromCache = false;
    try {
      product = await getProductByBarcode(code);
    } catch (networkErr) {
      product = getCachedProductByBarcode(code);
      fromCache = !!product;
      if (!fromCache) throw networkErr;
    }

    if (!product) {
      hideResultSkeleton();
      feedback.scanNotFound();
      toastError(`Nessun articolo trovato per il codice "${code}".`);
      return;
    }
    feedback.scanFound();
    if (fromCache) toastWarning('Offline: dati dell\'articolo dall\'ultima sincronizzazione, potrebbero non essere aggiornati.', 4000);
    currentProduct = product;

    if (continuousMode) {
      await autoConfirm(product);
    } else {
      renderResult(product);
    }
  } catch (err) {
    console.error(err);
    hideResultSkeleton();
    feedback.errorAction();
    toastError('Errore nella ricerca articolo.');
  }
}

function showResultSkeleton() {
  els.resultCard.classList.add('hidden');
  els.resultSkeleton.classList.remove('hidden');
}
function hideResultSkeleton() {
  els.resultSkeleton.classList.add('hidden');
}

function renderResult(product) {
  hideResultSkeleton();
  els.resultCard.classList.remove('hidden');
  replayAnimation(els.resultCard, 'result-pop');
  els.productName.textContent = product.codice_articolo;
  els.productCode.textContent = product.codice_articolo;
  els.productStock.textContent = product.quantita_disponibile;
  els.productLoc.textContent = product.locazione || '—';
  els.puntoInput.value = product.punto_utilizzo_standard || '';
  els.qtyInput.value = 1;

  els.confirmBtn.textContent = currentMode === 'deposito' ? 'Conferma deposito' : 'Conferma prelievo';
  els.confirmBtn.className = `flex-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide text-white transition-transform active:scale-95 ${
    currentMode === 'deposito' ? 'bg-emerald-400 hover:bg-emerald-300' : 'bg-amber-400 hover:bg-amber-300'
  }`;

  // Focus automatico sul campo quantità per inserimento rapido
  requestAnimationFrame(() => {
    els.qtyInput.focus();
    els.qtyInput.select();
  });
}

function resetResult() {
  currentProduct = null;
  els.resultCard.classList.add('hidden');
  els.resultSkeleton.classList.add('hidden');
}

function resetAll() {
  currentMode = null;
  currentProduct = null;
  els.modeBanner.classList.add('hidden');
  els.readerWrap.classList.add('hidden');
  els.manualForm.classList.add('hidden');
  els.idlePanel.classList.remove('hidden');
  els.modeDeposito.classList.remove('mode-active-deposito');
  els.modePrelievo.classList.remove('mode-active-prelievo');
  els.switchCameraBtn?.classList.add('hidden');
  els.stopCameraBtn?.classList.add('hidden');
  els.torchBtn?.classList.add('hidden');
  els.focusHint?.classList.add('hidden');
  resetResult();
}

/**
 * Esegue la transazione vera e propria: online la registra subito, offline
 * la accoda per la sincronizzazione automatica e aggiorna otticamente la
 * giacenza in cache. Condivisa tra la conferma manuale e la modalità
 * di scansione continua.
 */
async function runTransaction({ product, quantita, puntoUtilizzo }) {
  const tipo = currentMode;
  try {
    const result = await processTransaction({
      productId: product.id,
      tipo,
      quantita,
      puntoUtilizzo,
    });

    if (tipo === 'deposito') feedback.transactionDeposito();
    else feedback.transactionPrelievo();

    toastSuccess(
      `${tipo === 'deposito' ? 'Deposito' : 'Prelievo'} registrato: ${result.codice_articolo} → nuova giacenza ${result.nuova_giacenza}`
    );

    if (result.sotto_scorta) {
      // Il secondo avviso arriva subito dopo il tono di conferma: un piccolo
      // ritardo evita che le due sequenze sonore si sovrappongano.
      setTimeout(() => feedback.lowStockAlert(), 350);
      toastWarning(`⚠️ Scorta minima raggiunta per ${result.codice_articolo}.`, 6000);
    }
    return { ok: true, nuovaGiacenza: result.nuova_giacenza };
  } catch (err) {
    if (isNetworkError(err)) {
      enqueueTransaction({ productId: product.id, tipo, quantita, puntoUtilizzo, codice_articolo: product.codice_articolo });
      const delta = tipo === 'deposito' ? quantita : -quantita;
      adjustCachedProductQuantity(product.id, delta);
      feedback.offlineQueued();
      toastWarning(
        `${tipo === 'deposito' ? 'Deposito' : 'Prelievo'} salvato offline (${product.codice_articolo}): verrà sincronizzato alla riconnessione.`,
        5000
      );
      return { ok: true, offline: true, nuovaGiacenza: (product.quantita_disponibile || 0) + delta };
    }
    console.error(err);
    feedback.errorAction();
    toastError(err.message?.includes('Giacenza insufficiente') ? err.message : 'Errore durante la registrazione della transazione.');
    return { ok: false };
  }
}

async function confirmTransaction() {
  if (!currentProduct || !currentMode) return;
  const quantita = parseInt(els.qtyInput.value, 10);
  if (!quantita || quantita <= 0) {
    feedback.errorAction();
    toastError('Inserisci una quantità valida.');
    return;
  }

  els.confirmBtn.disabled = true;
  els.confirmBtn.classList.add('opacity-60');
  const product = currentProduct;
  const outcome = await runTransaction({ product, quantita, puntoUtilizzo: els.puntoInput.value.trim() });
  els.confirmBtn.disabled = false;
  els.confirmBtn.classList.remove('opacity-60');

  if (outcome.ok) {
    // Il numero conta visibilmente verso il nuovo valore invece di
    // cambiare di scatto, poi la card si chiude.
    animateNumber(els.productStock, outcome.nuovaGiacenza, { from: product.quantita_disponibile, duration: 550 });
    setTimeout(() => {
      resetResult();
      loadIdlePanel();
    }, 550);
  }
}

/** Conferma automatica a quantità 1, usata dalla modalità di scansione continua */
async function autoConfirm(product) {
  hideResultSkeleton();
  const outcome = await runTransaction({
    product,
    quantita: 1,
    puntoUtilizzo: product.punto_utilizzo_standard || '',
  });
  currentProduct = null;
  if (outcome.ok) loadIdlePanel();
}

/** Chiamata quando si esce dalla vista scanner (es. cambio tab) */
export function teardownScanner() {
  stopCamera();
  resetAll();
}

/** Attiva direttamente una modalità (deposito/prelievo), usata dagli shortcut della PWA */
export function activateMode(mode) {
  if (mode !== 'deposito' && mode !== 'prelievo') return;
  selectMode(mode);
}

/**
 * Riempie il pannello mostrato prima di scegliere Deposito/Prelievo, cosí
 * la schermata iniziale non resta vuota: conteggio sotto-scorta e ultimi
 * movimenti registrati, a colpo d'occhio prima ancora di scansionare.
 */
async function loadIdlePanel() {
  try {
    const [lowStock, recent] = await Promise.all([listProducts({ onlyLowStock: true }), listTransactions({ limit: 5 })]);
    animateNumber(els.lowStockCountEl, lowStock.length, { duration: 500 });
    renderRecent(recent);
  } catch (err) {
    console.error(err);
  }
}

function renderRecent(rows) {
  els.recentListEl.innerHTML = '';
  if (!rows || rows.length === 0) {
    els.recentEmptyEl.innerHTML = emptyStateHtml('history', 'Nessun movimento', 'I depositi e i prelievi registrati compariranno qui.');
    els.recentEmptyEl.classList.remove('hidden');
    window.lucide?.createIcons();
    return;
  }
  els.recentEmptyEl.classList.add('hidden');

  for (const r of rows) {
    const date = new Date(r.data_ora);
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-3 py-1.5 border-t border-graphite-800 first:border-t-0 first:pt-0';
    row.innerHTML = `
      <div class="min-w-0">
        <p class="text-sm text-graphite-100 truncate font-medium">${escapeHtml(r.products?.codice_articolo || '—')}</p>
        <p class="text-[11px] text-graphite-500 mt-0.5">${date.toLocaleString('it-IT', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })}</p>
      </div>
      <span class="shrink-0 font-mono text-xs font-semibold px-2 py-0.5 rounded-full ${
        r.tipo === 'deposito' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-700'
      }">${r.tipo === 'deposito' ? '+' : '−'}${r.quantita}</span>
    `;
    els.recentListEl.appendChild(row);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
