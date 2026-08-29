// =============================================================
// scanner.js — Scansione barcode con fotocamera + flusso deposito/prelievo
// =============================================================

import { getProductByBarcode, processTransaction } from './supabase.js';
import { toastSuccess, toastError, toastWarning } from './toast.js';

let html5Qrcode = null;
let currentMode = null; // 'deposito' | 'prelievo'
let currentProduct = null;
let isCameraRunning = false;

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

  els.modeDeposito.addEventListener('click', () => selectMode('deposito'));
  els.modePrelievo.addEventListener('click', () => selectMode('prelievo'));
  els.manualForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = els.manualInput.value.trim();
    if (code) handleDetectedCode(code);
    els.manualInput.value = '';
  });
  els.cancelBtn.addEventListener('click', resetResult);
  els.confirmBtn.addEventListener('click', confirmTransaction);
  els.stopCameraBtn.addEventListener('click', stopCamera);

  resetAll();
}

function selectMode(mode) {
  currentMode = mode;
  els.modeDeposito.classList.toggle('mode-active-deposito', mode === 'deposito');
  els.modePrelievo.classList.toggle('mode-active-prelievo', mode === 'prelievo');

  els.modeBanner.textContent = mode === 'deposito' ? 'Modalità DEPOSITO — inquadra il barcode' : 'Modalità PRELIEVO — inquadra il barcode';
  els.modeBanner.className = `text-center text-sm font-display font-semibold tracking-wide uppercase py-2 rounded-md ${
    mode === 'deposito' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
  }`;
  els.modeBanner.classList.remove('hidden');
  els.readerWrap.classList.remove('hidden');
  els.manualForm.classList.remove('hidden');
  startCamera();
}

async function startCamera() {
  if (isCameraRunning) return;
  try {
    // eslint-disable-next-line no-undef
    html5Qrcode = new Html5Qrcode('scanner-reader');
    await html5Qrcode.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: { width: 260, height: 140 }, aspectRatio: 1.6 },
      (decodedText) => handleDetectedCode(decodedText),
      () => {} // ignora i frame senza rilevamento
    );
    isCameraRunning = true;
    els.stopCameraBtn.classList.remove('hidden');
  } catch (err) {
    console.error(err);
    toastError('Impossibile accedere alla fotocamera. Usa l\'inserimento manuale.');
  }
}

async function stopCamera() {
  if (html5Qrcode && isCameraRunning) {
    try {
      await html5Qrcode.stop();
      await html5Qrcode.clear();
    } catch (err) {
      console.warn(err);
    }
  }
  isCameraRunning = false;
  els.stopCameraBtn.classList.add('hidden');
}

let lastCode = null;
let lastCodeAt = 0;

async function handleDetectedCode(code) {
  // Debounce: evita letture duplicate ravvicinate dello stesso codice
  const now = Date.now();
  if (code === lastCode && now - lastCodeAt < 2500) return;
  lastCode = code;
  lastCodeAt = now;

  if (!currentMode) {
    toastWarning('Seleziona prima DEPOSITO o PRELIEVO.');
    return;
  }

  showResultSkeleton();
  try {
    const product = await getProductByBarcode(code);
    if (!product) {
      hideResultSkeleton();
      toastError(`Nessun articolo trovato per il codice "${code}".`);
      return;
    }
    currentProduct = product;
    renderResult(product);
  } catch (err) {
    console.error(err);
    hideResultSkeleton();
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
  els.productName.textContent = product.descrizione;
  els.productCode.textContent = product.codice_articolo;
  els.productStock.textContent = product.quantita_disponibile;
  els.productLoc.textContent = product.locazione || '—';
  els.puntoInput.value = product.punto_utilizzo_standard || '';
  els.qtyInput.value = 1;

  els.confirmBtn.textContent = currentMode === 'deposito' ? 'Conferma deposito' : 'Conferma prelievo';
  els.confirmBtn.className = `flex-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide text-graphite-950 transition-transform active:scale-95 ${
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
  els.modeDeposito.classList.remove('mode-active-deposito');
  els.modePrelievo.classList.remove('mode-active-prelievo');
  resetResult();
}

async function confirmTransaction() {
  if (!currentProduct || !currentMode) return;
  const quantita = parseInt(els.qtyInput.value, 10);
  if (!quantita || quantita <= 0) {
    toastError('Inserisci una quantità valida.');
    return;
  }

  els.confirmBtn.disabled = true;
  els.confirmBtn.classList.add('opacity-60');
  try {
    const result = await processTransaction({
      productId: currentProduct.id,
      tipo: currentMode,
      quantita,
      puntoUtilizzo: els.puntoInput.value.trim(),
    });

    toastSuccess(
      `${currentMode === 'deposito' ? 'Deposito' : 'Prelievo'} registrato: ${result.codice_articolo} → nuova giacenza ${result.nuova_giacenza}`
    );

    if (result.sotto_scorta) {
      toastWarning(`⚠️ Scorta minima raggiunta per ${result.codice_articolo} (${result.descrizione}).`, 6000);
    }

    resetResult();
  } catch (err) {
    console.error(err);
    toastError(err.message?.includes('Giacenza insufficiente') ? err.message : 'Errore durante la registrazione della transazione.');
  } finally {
    els.confirmBtn.disabled = false;
    els.confirmBtn.classList.remove('opacity-60');
  }
}

/** Chiamata quando si esce dalla vista scanner (es. cambio tab) */
export function teardownScanner() {
  stopCamera();
  resetAll();
}
