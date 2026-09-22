// =============================================================
// scanner.js — Scansione barcode con fotocamera + flusso deposito/prelievo
// =============================================================

import {
  getProductByBarcode,
  processTransaction,
  listProducts,
  listTransactions,
  getCachedProductByBarcode,
  searchCachedProducts,
  adjustCachedProductQuantity,
  bumpProductsVersion,
} from './supabase.js';
import { toastSuccess, toastError, toastWarning } from './toast.js';
import { startCamera, stopCamera, switchCamera as switchCameraShared, toggleTorch } from './camera.js';
import feedback from './feedback.js';
import { enqueueTransaction, onQueueChange, getQueueCount, isNetworkError } from './offline-queue.js';
import { animateNumber, replayAnimation, emptyStateHtml, openOverlay, closeOverlay, enableSheetDrag, setButtonBusy } from './ui-utils.js';
import { CATEGORY_LABELS } from './products.js';

let currentMode = null; // 'deposito' | 'prelievo'
let currentProduct = null;

const els = {};

export function initScanner() {
  els.modeDeposito = document.getElementById('mode-deposito');
  els.modePrelievo = document.getElementById('mode-prelievo');
  els.scanModal = document.getElementById('scan-mode-modal');
  els.scanModalPanel = document.getElementById('scan-modal-panel');
  els.closeModalBtn = document.getElementById('scan-mode-close-btn');
  els.findMethods = document.getElementById('scan-find-methods');
  els.openCameraBtn = document.getElementById('scan-open-camera-btn');
  els.cameraCollapse = document.getElementById('scanner-camera-collapse');
  els.readerWrap = document.getElementById('scanner-reader-wrap');
  els.reader = document.getElementById('scanner-reader');
  els.codeSearchWrap = document.getElementById('scanner-code-search-wrap');
  els.codeSearchInput = document.getElementById('scanner-code-search-input');
  els.codeSearchResults = document.getElementById('scanner-code-search-results');
  els.findDivider = document.getElementById('scan-find-divider');
  els.resultCard = document.getElementById('scan-result-card');
  els.resultSkeleton = document.getElementById('scan-result-skeleton');
  els.productName = document.getElementById('scan-product-name');
  els.productCode = document.getElementById('scan-product-code');
  els.productStock = document.getElementById('scan-product-stock');
  els.productLoc = document.getElementById('scan-product-loc');
  els.qtyInput = document.getElementById('scan-qty-input');
  els.qtyValue = document.getElementById('scan-qty-value');
  els.qtyMinusBtn = document.getElementById('scan-qty-minus');
  els.qtyPlusBtn = document.getElementById('scan-qty-plus');
  els.puntoInput = document.getElementById('scan-punto-input');
  els.confirmBtn = document.getElementById('scan-confirm-btn');
  els.cancelBtn = document.getElementById('scan-cancel-btn');
  els.modeBanner = document.getElementById('scan-mode-banner');
  els.afterBox = document.getElementById('scan-after');
  els.afterValue = document.getElementById('scan-after-value');
  els.afterLabel = document.getElementById('scan-after-label');
  els.stopCameraBtn = document.getElementById('scanner-stop-btn');
  els.switchCameraBtn = document.getElementById('scanner-switch-btn');
  els.torchBtn = document.getElementById('scanner-torch-btn');
  els.focusHint = document.getElementById('scanner-focus-hint');
  els.idlePanel = document.getElementById('scanner-idle-panel');
  els.lowStockCountEl = document.getElementById('scanner-lowstock-count');
  els.recentListEl = document.getElementById('scanner-recent-list');
  els.recentEmptyEl = document.getElementById('scanner-recent-empty');
  els.offlineBadge = document.getElementById('scanner-offline-badge');
  els.offlineBadgeCount = document.getElementById('scanner-offline-badge-count');

  els.modeDeposito.addEventListener('click', () => selectMode('deposito'));
  els.modePrelievo.addEventListener('click', () => selectMode('prelievo'));
  els.closeModalBtn.addEventListener('click', () => {
    feedback.cancelAction();
    closeScanModal();
  });
  enableSheetDrag(els.scanModalPanel, closeScanModal); // trascinamento verso il basso per chiudere
  els.openCameraBtn.addEventListener('click', expandCamera);
  // Appena si tocca il campo di ricerca, il pulsante "scansiona" e il
  // separatore spariscono per fare spazio ai risultati (la modale è
  // sempre ancorata in alto, quindi c'è già spazio sotto la barra di
  // ricerca a prescindere dalla tastiera).
  els.codeSearchInput.addEventListener('focus', () => {
    toggleScanCameraSection(false);
    setTimeout(() => {
      els.codeSearchWrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 300);
  });
  els.codeSearchInput.addEventListener('blur', () => {
    if (!els.codeSearchInput.value.trim()) toggleScanCameraSection(true);
  });
  initCodeSearch();
  els.cancelBtn.addEventListener('click', () => {
    feedback.cancelAction();
    resetResult();
  });
  els.confirmBtn.addEventListener('click', confirmTransaction);
  els.qtyMinusBtn.addEventListener('click', () => stepQty(-1));
  els.qtyPlusBtn.addEventListener('click', () => stepQty(1));
  els.stopCameraBtn.addEventListener('click', collapseCamera);
  els.switchCameraBtn.addEventListener('click', () =>
    switchCameraShared(handleDetectedCode, { focusHintEl: els.focusHint, switchBtnEl: els.switchCameraBtn, torchBtnEl: els.torchBtn })
  );
  els.torchBtn?.addEventListener('click', () => toggleTorch(els.torchBtn));

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

  // Il colore di testata, bordo, conferma e anteprima dipende da questo attributo (vedi style.css)
  els.scanModalPanel.dataset.mode = mode;
  els.modeBanner.textContent = mode === 'deposito' ? 'Deposito' : 'Prelievo';

  openScanModal();
}

/** Apre la finestra di scansione/ricerca sopra la vista Scanner. La
 *  fotocamera NON parte da sola: resta il pulsante "Effettua scansione
 *  codice" finché l'utente non lo preme (vedi expandCamera). */
function openScanModal() {
  showFindMethods();
  openOverlay(els.scanModal);
  // Con mouse e tastiera (desktop) non c'è la fotocamera: la ricerca per codice è
  // l'unico modo per trovare l'articolo, quindi il cursore parte già nel campo.
  // Su telefono no: la tastiera resterebbe aperta senza che serva.
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    requestAnimationFrame(() => els.codeSearchInput.focus({ preventScroll: true }));
  }
}

/** Chiude del tutto la finestra ed esce dalla modalità deposito/prelievo. */
function closeScanModal() {
  if (!els.scanModal.dataset.modalOpen) return; // già chiusa
  collapseCamera();
  currentMode = null;
  currentProduct = null;
  els.modeDeposito.classList.remove('mode-active-deposito');
  els.modePrelievo.classList.remove('mode-active-prelievo');
  closeOverlay(els.scanModal);
}

/** Torna alla schermata "scansiona o cerca", pronta per il prossimo
 *  articolo: fotocamera richiusa (va riaperta col pulsante), ricerca per
 *  codice azzerata. Usata sia alla prima apertura sia dopo un Annulla. */
function showFindMethods() {
  els.findMethods.classList.remove('hidden');
  els.resultCard.classList.add('hidden');
  els.resultSkeleton.classList.add('hidden');
  resetCodeSearch();
  collapseCamera();
  toggleScanCameraSection(true);
}

/** Nasconde/mostra il pulsante "Effettua scansione codice" (e il
 *  separatore "oppure") per lasciare tutto lo spazio disponibile alla
 *  ricerca per codice mentre la tastiera è aperta. Se la fotocamera era
 *  attiva la richiude, dato che si sta comunque passando all'altro modo
 *  di cercare l'articolo. */
function toggleScanCameraSection(show) {
  if (!show) collapseCamera();
  els.openCameraBtn.classList.toggle('hidden', !show);
  els.findDivider?.classList.toggle('hidden', !show);
}

/** Un articolo è stato trovato: si passa alla scheda quantità/conferma,
 *  richiudendo fotocamera e ricerca. */
function hideFindMethods() {
  collapseCamera();
  els.findMethods.classList.add('hidden');
  closeCodeSearchPanel();
}

/** Espande con animazione fluida il riquadro della fotocamera e la avvia:
 *  chiamata solo dal pulsante "Effettua scansione codice", mai in automatico. */
function expandCamera() {
  els.openCameraBtn.classList.add('hidden');
  els.cameraCollapse.classList.add('expanded');
  startCamera('scanner-reader', handleDetectedCode, {
    focusHintEl: els.focusHint,
    switchBtnEl: els.switchCameraBtn,
    torchBtnEl: els.torchBtn,
    errorHint: 'Usa la ricerca per codice.',
  }).then((started) => {
    if (started === null) return; // richiesta superata da una chiusura: la sezione è già a posto
    if (started) els.stopCameraBtn.classList.remove('hidden');
    else collapseCamera(); // fotocamera non disponibile: torna al pulsante
  });
}

/** Richiude il riquadro della fotocamera (stessa animazione, alla
 *  rovescia) e la ferma. Riporta al solo pulsante "Effettua scansione". */
function collapseCamera() {
  stopCamera();
  els.cameraCollapse.classList.remove('expanded');
  els.openCameraBtn.classList.remove('hidden');
  els.switchCameraBtn?.classList.add('hidden');
  els.stopCameraBtn?.classList.add('hidden');
  els.torchBtn?.classList.add('hidden');
  els.focusHint?.classList.add('hidden');
}

// --- RICERCA PER CODICE ARTICOLO --------------------------------------
// Alternativa alla scansione: filtro dinamico mentre si scrive, selezione
// di un risultato dalla tendina obbligatoria per procedere — non esiste un
// modo di "inviare" il testo digitato cosí com'è, quindi non si può
// procedere con un codice che non esiste davvero a magazzino.

const CATEGORY_BADGE_CLASSES = {
  cuscinetti: 'bg-graphite-700 text-graphite-200',
  cinghie: 'bg-emerald-500/15 text-emerald-700',
  pezzi_ricambio: 'bg-amber-500/15 text-amber-300',
};

let codeSearchDebounce = null;
let codeSearchSeq = 0; // scarta risposte arrivate in ordine sbagliato (rete lenta + digitazione veloce)

function initCodeSearch() {
  els.codeSearchInput.addEventListener('input', () => {
    clearTimeout(codeSearchDebounce);
    const term = els.codeSearchInput.value.trim();
    if (!term) {
      closeCodeSearchPanel();
      return;
    }
    codeSearchDebounce = setTimeout(() => runCodeSearch(term), 250);
  });
  els.codeSearchInput.addEventListener('focus', () => {
    if (els.codeSearchInput.value.trim()) openCodeSearchPanel();
  });
  document.addEventListener('click', (e) => {
    if (!els.codeSearchWrap.contains(e.target)) closeCodeSearchPanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.codeSearchWrap.classList.contains('custom-select-open')) closeCodeSearchPanel();
  });
}

function resetCodeSearch() {
  els.codeSearchInput.value = '';
  closeCodeSearchPanel();
}

function openCodeSearchPanel() {
  els.codeSearchWrap.classList.add('custom-select-open');
}
function closeCodeSearchPanel() {
  els.codeSearchWrap.classList.remove('custom-select-open');
}

async function runCodeSearch(term) {
  const seq = ++codeSearchSeq;
  els.codeSearchResults.innerHTML = '<p class="text-center text-xs text-graphite-500 py-4">Ricerca…</p>';
  openCodeSearchPanel();

  let results = [];
  let offline = false;
  try {
    results = await listProducts({ search: term });
  } catch (err) {
    if (!isNetworkError(err)) console.error(err);
    results = searchCachedProducts(term);
    offline = true;
  }
  if (seq !== codeSearchSeq) return; // l'utente ha digitato altro nel frattempo, risposta obsoleta

  renderCodeSearchResults(results, offline);
}

function renderCodeSearchResults(results, offline) {
  els.codeSearchResults.innerHTML = '';

  if (offline && results.length) {
    const notice = document.createElement('p');
    notice.className = 'px-3.5 pt-2.5 ui-note text-amber-300';
    notice.textContent = 'Offline: risultati dall\'ultima sincronizzazione.';
    els.codeSearchResults.appendChild(notice);
  }

  if (!results.length) {
    els.codeSearchResults.innerHTML += `<p class="text-center text-xs text-graphite-500 py-4">Nessun articolo trovato.</p>`;
    return;
  }

  results.slice(0, 30).forEach((product) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className =
      'custom-select-option w-full text-left px-3.5 py-2.5 text-sm flex items-center justify-between gap-2 border-t border-graphite-700 first:border-t-0';
    const badgeClass = CATEGORY_BADGE_CLASSES[product.categoria] || 'bg-graphite-700 text-graphite-200';
    const label = CATEGORY_LABELS[product.categoria] || product.categoria;
    const subtitleParts = [product.locazione, product.macchina].filter(Boolean);
    row.innerHTML = `
      <span class="min-w-0">
        <span class="block font-mono font-semibold text-graphite-100 truncate">${escapeHtml(product.codice_articolo)}</span>
        ${subtitleParts.length ? `<span class="block ui-note text-graphite-500 truncate">${escapeHtml(subtitleParts.join(' · '))}</span>` : ''}
      </span>
      <span class="shrink-0 whitespace-nowrap px-2 py-0.5 rounded-full ui-label font-display font-semibold uppercase tracking-wide ${badgeClass}">${escapeHtml(label)}</span>
    `;
    row.addEventListener('click', () => {
      resetCodeSearch();
      onProductMatched(product);
    });
    els.codeSearchResults.appendChild(row);
  });
}

let lastCode = null;
let lastCodeAt = 0;

async function handleDetectedCode(code) {
  // Debounce: evita letture duplicate ravvicinate dello stesso codice.
  const debounceMs = 2500;
  const now = Date.now();
  if (code === lastCode && now - lastCodeAt < debounceMs) return;
  lastCode = code;
  lastCodeAt = now;

  if (!currentMode) {
    feedback.scanNoMode();
    toastWarning('Seleziona prima DEPOSITO o PRELIEVO.');
    return;
  }

  showResultSkeleton();
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
      replayAnimation(els.reader, 'reader-flash-fail');
      toastError(`Nessun articolo trovato per il codice "${code}".`);
      return;
    }
    feedback.scanFound();
    replayAnimation(els.reader, 'reader-flash-ok');
    onProductMatched(product, { fromCache });
  } catch (err) {
    console.error(err);
    hideResultSkeleton();
    feedback.errorAction();
    replayAnimation(els.reader, 'reader-flash-fail');
    toastError('Errore nella ricerca articolo.');
  }
}

/** Un articolo è stato individuato (fotocamera o ricerca per codice): chiude
 *  subito l'interfaccia di ricerca e passa alla selezione di quantità/
 *  dettagli. Punto unico condiviso da entrambi i modi di trovare un
 *  articolo, cosí si comportano sempre allo stesso modo. */
function onProductMatched(product, { fromCache = false } = {}) {
  document.activeElement?.blur(); // chiude la tastiera se il campo ricerca codice aveva il focus
  if (fromCache) toastWarning('Offline: dati dell\'articolo dall\'ultima sincronizzazione, potrebbero non essere aggiornati.', 4000);
  currentProduct = product;
  hideFindMethods();
  renderResult(product);
}

function showResultSkeleton() {
  els.resultCard.classList.add('hidden');
  els.resultSkeleton.classList.remove('hidden');
}
function hideResultSkeleton() {
  els.resultSkeleton.classList.add('hidden');
}

/** Aggiorna sia il valore nascosto (quello letto da confirmTransaction) sia
 *  quello mostrato all'operatore, con un minimo di 1. Niente tastiera:
 *  la quantità si cambia solo con i due pulsanti +/-. */
function setQty(value) {
  const qty = Math.max(1, Math.round(value) || 1);
  els.qtyInput.value = qty;
  els.qtyValue.textContent = qty;
  updateAfterPreview();
}

/** Anteprima "Giacenza dopo": mostra subito l'effetto dell'operazione sulla
 *  giacenza (freccia su/giù) e avvisa in rosso se un prelievo supera quanto c'è. */
function updateAfterPreview() {
  if (!els.afterBox || !currentProduct) return;
  const stock = Number(currentProduct.quantita_disponibile) || 0;
  const qty = parseInt(els.qtyInput.value, 10) || 1;
  const isDeposit = currentMode === 'deposito';
  const after = isDeposit ? stock + qty : stock - qty;
  const insufficient = !isDeposit && after < 0;
  els.afterBox.classList.toggle('scan-after-warn', insufficient);
  if (insufficient) {
    els.afterLabel.textContent = 'Non basta la giacenza';
    els.afterValue.textContent = `disponibili ${stock}`;
  } else {
    els.afterLabel.textContent = 'Giacenza dopo';
    els.afterValue.textContent = `${isDeposit ? '↑' : '↓'} ${after} (${isDeposit ? '+' : '−'}${qty})`;
  }
}
function stepQty(delta) {
  feedback.focusTap();
  setQty(parseInt(els.qtyInput.value, 10) + delta);
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
  setQty(1);

  els.confirmBtn.textContent = currentMode === 'deposito' ? 'Conferma deposito' : 'Conferma prelievo';
  // Il colore del pulsante segue la modalità (variabili di data-mode sul pannello)
  els.confirmBtn.className = 'btn-mode press-spring flex-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide';
  updateAfterPreview();
}

function resetResult() {
  currentProduct = null;
  els.resultCard.classList.add('hidden');
  els.resultSkeleton.classList.add('hidden');
  // Si torna alla schermata "scansiona o cerca" solo se la modalità è
  // ancora attiva: durante resetAll() (si lascia la vista Scanner) mode è
  // già stato azzerato prima di arrivare qui, quindi la modale resta chiusa.
  if (currentMode) showFindMethods();
}

function resetAll() {
  closeScanModal();
}

/**
 * Esegue la transazione vera e propria: online la registra subito, offline
 * la accoda per la sincronizzazione automatica e aggiorna otticamente la
 * giacenza in cache.
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
      const saved = enqueueTransaction({ productId: product.id, tipo, quantita, puntoUtilizzo, codice_articolo: product.codice_articolo });
      if (!saved) {
        // Senza rete e senza spazio sul dispositivo il movimento andrebbe perso:
        // meglio dirlo chiaramente che far credere che sia stato salvato.
        feedback.errorAction();
        toastError('Movimento NON registrato: manca la connessione e la memoria del dispositivo è piena. Riprova con la rete attiva.');
        return { ok: false };
      }
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

  setButtonBusy(els.confirmBtn, true, 'Registrazione…');
  const product = currentProduct;
  const outcome = await runTransaction({ product, quantita, puntoUtilizzo: els.puntoInput.value.trim() });
  setButtonBusy(els.confirmBtn, false);

  if (outcome.ok) {
    bumpProductsVersion(); // la lista del Magazzino verrà aggiornata in silenzio al rientro
    // Il numero conta visibilmente verso il nuovo valore invece di
    // cambiare di scatto, e lampeggia brevemente: il momento in cui il
    // pezzo viene registrato deve essere impossibile da non notare.
    animateNumber(els.productStock, outcome.nuovaGiacenza, { from: product.quantita_disponibile, duration: 550 });
    replayAnimation(els.productStock, 'stock-pulse');
    setTimeout(() => {
      resetResult();
      loadIdlePanel();
    }, 550);
  }
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
export async function loadIdlePanel() {
  if (!els.recentListEl) return; // non ancora inizializzato (caso limite)
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

  rows.forEach((r, i) => {
    const date = new Date(r.data_ora);
    const row = document.createElement('div');
    row.className = 'list-item-in flex items-center justify-between gap-3 py-1.5 border-t border-graphite-800 first:border-t-0 first:pt-0';
    row.style.setProperty('--i', i);
    row.innerHTML = `
      <div class="min-w-0">
        <p class="text-sm text-graphite-100 truncate font-medium">${escapeHtml(r.products?.codice_articolo || '—')}</p>
        <p class="ui-note text-graphite-500 mt-0.5">${date.toLocaleString('it-IT', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })}</p>
      </div>
      <span class="shrink-0 font-mono text-xs font-semibold px-2 py-0.5 rounded-full ${
        r.tipo === 'deposito' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-300'
      }">${r.tipo === 'deposito' ? '+' : '−'}${r.quantita}</span>
    `;
    els.recentListEl.appendChild(row);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
