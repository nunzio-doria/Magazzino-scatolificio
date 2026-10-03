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
  listDistinctMacchine,
  getProductLocations,
} from './supabase.js';
import { toastSuccess, toastError, toastWarning } from './toast.js';
import { startCamera, stopCamera, switchCamera as switchCameraShared, toggleTorch } from './camera.js';
import feedback from './feedback.js';
import { enqueueTransaction, onQueueChange, getQueueCount, isNetworkError } from './offline-queue.js';
import { animateNumber, replayAnimation, emptyStateHtml, openOverlay, closeOverlay, enableSheetDrag, setButtonBusy } from './ui-utils.js';
import { CATEGORY_LABELS } from './products.js';
import { shelfLabel } from './products-shared.js';

let currentMode = null; // 'deposito' | 'prelievo'
let currentProduct = null;
let currentLocationId = null; // scaffale scelto per il movimento (obbligatorio se l'articolo sta su più scaffali)
let machinesCache = null; // elenco macchine per il campo Macchinario del prelievo cuscinetti

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
  els.shelfWrap = document.getElementById('scan-shelf-wrap');
  els.shelfGroup = document.getElementById('scan-shelf-group');
  els.qtyInput = document.getElementById('scan-qty-input');
  els.qtyValue = document.getElementById('scan-qty-value');
  els.qtyMinusBtn = document.getElementById('scan-qty-minus');
  els.qtyPlusBtn = document.getElementById('scan-qty-plus');
  els.puntoInput = document.getElementById('scan-punto-input');
  els.puntoWrap = document.getElementById('scan-punto-wrap');
  els.puntoLabel = document.getElementById('scan-punto-label');
  els.prelievoFields = document.getElementById('scan-prelievo-fields');
  els.lineaGroup = document.getElementById('scan-linea-group');
  els.lineaInput = document.getElementById('scan-linea-input');
  els.lineaFixed = document.getElementById('scan-linea-fixed');
  els.lineaFixedName = document.getElementById('scan-linea-fixed-name');
  els.macchinarioWrap = document.getElementById('scan-macchinario-wrap');
  els.macchinarioSelect = document.getElementById('scan-macchinario-input');
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

  els.lineaGroup?.querySelectorAll('[data-linea]').forEach((btn) => {
    btn.addEventListener('click', () => {
      feedback.focusTap();
      setLinea(btn.dataset.linea);
    });
  });

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
  bindHoldRepeat(els.qtyMinusBtn, -1);
  bindHoldRepeat(els.qtyPlusBtn, 1);
  els.stopCameraBtn.addEventListener('click', collapseCamera);
  els.switchCameraBtn.addEventListener('click', () =>
    switchCameraShared(handleDetectedCode, { focusHintEl: els.focusHint, switchBtnEl: els.switchCameraBtn, torchBtnEl: els.torchBtn })
  );
  els.torchBtn?.addEventListener('click', () => toggleTorch(els.torchBtn));

  onQueueChange(updateOfflineBadge);
  updateOfflineBadge(getQueueCount());

  resetAll();
  loadIdlePanel();
  bindScanModalBack();
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
// Tasto indietro del telefono: stessa chiusura del pulsante Annulla (ferma la fotocamera, azzera la modalità).
function bindScanModalBack() {
  els.scanModal?.addEventListener('overlay-back', (e) => {
    e.preventDefault();
    closeScanModal();
  });
}

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
    const subtitleParts = [shelfLabel(product), product.macchina].filter(Boolean);
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
  const locs = getProductLocations(currentProduct);
  const multiple = locs.length > 1;
  const isDeposit = currentMode === 'deposito';
  if (multiple && !currentLocationId) {
    // Articolo su più scaffali: finché non si sceglie lo scaffale non c'è una giacenza da confrontare
    els.afterBox.classList.remove('scan-after-warn');
    els.afterLabel.textContent = 'Scegli lo scaffale';
    els.afterValue.textContent = '—';
    return;
  }
  // Su più scaffali conta la quantità dello scaffale scelto, altrimenti la giacenza dell'articolo
  const chosen = multiple ? locs.find((l) => l.id === currentLocationId) : null;
  const stock = Number(chosen ? chosen.quantita : currentProduct.quantita_disponibile) || 0;
  const qty = parseInt(els.qtyInput.value, 10) || 1;
  const after = isDeposit ? stock + qty : stock - qty;
  const insufficient = !isDeposit && after < 0;
  els.afterBox.classList.toggle('scan-after-warn', insufficient);
  if (insufficient) {
    els.afterLabel.textContent = chosen ? 'Non basta su questo scaffale' : 'Non basta la giacenza';
    els.afterValue.textContent = `disponibili ${stock}`;
  } else {
    els.afterLabel.textContent = chosen ? `Scaffale ${chosen.locazione || 'senza nome'} dopo` : 'Giacenza dopo';
    els.afterValue.textContent = `${isDeposit ? '↑' : '↓'} ${after} (${isDeposit ? '+' : '−'}${qty})`;
  }
}
function stepQty(delta) {
  feedback.focusTap();
  setQty(parseInt(els.qtyInput.value, 10) + delta);
}

// ---- Pressione prolungata sui pulsanti +/− della quantità -------------------
// Un tocco = ±1. Tenendo premuto, dopo una breve attesa parte la ripetizione
// a velocità costante, con un tick aptico+sonoro a ogni scatto:
// - da 1 a 5: un numero alla volta, uno scatto ogni HOLD_FINE_MS
// - da 5 in su: salti di 5 (5 → 10 → 15 → 20 …), uno scatto ogni HOLD_COARSE_MS
// - da 30 in su: stessi salti di 5 ma più veloci, uno scatto ogni HOLD_FAST_MS
// In discesa è speculare (… 35 → 30 → 25 → 20 → 15 → 10 → 5, poi 4 → 3 → 2 → 1).
const HOLD_DELAY_MS = 400; // attesa prima che parta la ripetizione (evita scatti involontari su un tocco lungo)
const HOLD_FINE_MS = 300; // intervallo tra gli scatti da ±1
const HOLD_COARSE_MS = 500; // intervallo tra gli scatti da ±5
const HOLD_FAST_MS = 200; // intervallo tra gli scatti da ±5 oltre la soglia veloce
const HOLD_FAST_FROM = 30; // da questo valore in su gli scatti da 5 accelerano
const HOLD_JUMP = 5;

/** Passo del prossimo scatto: ±1 sotto la soglia, ±5 (agganciato ai multipli di 5) sopra. */
function nextHoldValue(cur, dir) {
  const fine = dir > 0 ? cur < HOLD_JUMP : cur <= HOLD_JUMP;
  if (fine) return { value: cur + dir, coarse: false };
  const value = dir > 0 ? (Math.floor(cur / HOLD_JUMP) + 1) * HOLD_JUMP : (Math.ceil(cur / HOLD_JUMP) - 1) * HOLD_JUMP;
  return { value, coarse: true };
}

/** Attesa prima del prossimo scatto, in base al valore da cui si parte. */
function holdInterval(cur, dir) {
  if (!nextHoldValue(cur, dir).coarse) return HOLD_FINE_MS;
  const fast = dir > 0 ? cur >= HOLD_FAST_FROM : cur > HOLD_FAST_FROM;
  return fast ? HOLD_FAST_MS : HOLD_COARSE_MS;
}

function bindHoldRepeat(btn, dir) {
  let timer = null;
  btn.dataset.noHaptic = '1'; // il feedback lo danno già gli scatti (stepQty / qtyTick)

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  function tick() {
    const cur = parseInt(els.qtyInput.value, 10) || 1;
    const { value, coarse } = nextHoldValue(cur, dir);
    const clamped = Math.max(1, value);
    if (clamped === cur) {
      stop(); // già al minimo: inutile continuare a ripetere
      return;
    }
    setQty(clamped);
    feedback.qtyTick(coarse ? 1 : 0);
    timer = setTimeout(tick, holdInterval(clamped, dir));
  }

  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stop();
    try {
      btn.setPointerCapture(e.pointerId);
    } catch (err) {
      // non essenziale: senza cattura il rilascio fuori dal pulsante è comunque gestito da pointerleave
    }
    stepQty(dir); // il primo scatto è immediato, come un normale tocco
    timer = setTimeout(tick, HOLD_DELAY_MS);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave'].forEach((ev) => btn.addEventListener(ev, stop));
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
  });
  // Tasto lungo su touch = menu contestuale/selezione: va evitato, altrimenti interrompe la ripetizione
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // Tastiera / tecnologie assistive: Invio o Spazio generano un click senza pointer (detail 0)
  btn.addEventListener('click', (e) => {
    if (e.detail === 0) stepQty(dir);
  });
}

function renderResult(product) {
  hideResultSkeleton();
  els.resultCard.classList.remove('hidden');
  replayAnimation(els.resultCard, 'result-pop');
  // Cinghie: in alto in grassetto la descrizione, sotto (più piccolo) il codice. Negli altri
  // casi, o se la descrizione manca, c'è solo il codice: mai lo stesso testo due volte.
  const descrizione = (product.punto_utilizzo_standard || '').trim();
  const descrizioneInTitolo = product.categoria === 'cinghie' && descrizione && descrizione !== product.codice_articolo;
  els.productName.textContent = descrizioneInTitolo ? descrizione : product.codice_articolo;
  els.productCode.textContent = descrizioneInTitolo ? product.codice_articolo : '';
  els.productCode.classList.toggle('hidden', !descrizioneInTitolo);
  els.productStock.textContent = product.quantita_disponibile;
  const locNames = getProductLocations(product).map((l) => l.locazione).filter(Boolean);
  els.productLoc.textContent = locNames.length ? locNames.join(', ') : '—';
  renderShelfChoices(product);
  els.puntoInput.value = product.punto_utilizzo_standard || '';
  setupPrelievoFields(product);
  setQty(1);

  els.confirmBtn.textContent = currentMode === 'deposito' ? 'Conferma deposito' : 'Conferma prelievo';
  // Il colore del pulsante segue la modalità (variabili di data-mode sul pannello)
  els.confirmBtn.className = 'btn-mode press-spring flex-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide';
  updateAfterPreview();
}

/**
 * Articolo su più scaffali: mostra un pulsante per scaffale (con la sua quantità) e obbliga a sceglierne
 * uno prima di confermare, senza preselezione. Con un solo scaffale non c'è nulla da scegliere:
 * il movimento va su quello. Nel prelievo gli scaffali vuoti non sono selezionabili.
 */
function renderShelfChoices(product) {
  const locs = getProductLocations(product);
  const multiple = locs.length > 1;
  currentLocationId = multiple ? null : locs[0]?.id ?? null;
  els.shelfWrap.classList.toggle('hidden', !multiple);
  els.shelfGroup.innerHTML = '';
  if (!multiple) return;

  const isPrelievo = currentMode === 'prelievo';
  locs.forEach((l) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.locationId = l.id;
    btn.setAttribute('aria-pressed', 'false');
    btn.disabled = isPrelievo && l.quantita <= 0;
    btn.className =
      'scan-linea-btn press-spring min-h-[44px] rounded-lg border px-3 py-1.5 font-display font-semibold tracking-wide text-sm bg-graphite-900 text-graphite-200 border-graphite-700 flex flex-col items-center justify-center leading-tight disabled:opacity-40';
    const name = document.createElement('span');
    name.className = 'uppercase max-w-full truncate';
    name.textContent = l.locazione || 'Senza scaffale'; // testo, mai HTML
    const qty = document.createElement('span');
    qty.className = 'font-mono text-xs font-normal opacity-80';
    qty.textContent = `${l.quantita} pz`;
    btn.append(name, qty);
    btn.addEventListener('click', () => {
      feedback.focusTap();
      currentLocationId = l.id;
      els.shelfGroup.querySelectorAll('[data-location-id]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.locationId === l.id));
      });
      updateAfterPreview();
    });
    els.shelfGroup.appendChild(btn);
  });
}

/** Evidenzia la linea scelta (L1/L2) e la salva nel campo nascosto. '' = nessuna scelta. */
function setLinea(value) {
  els.lineaInput.value = value || '';
  els.lineaGroup.querySelectorAll('[data-linea]').forEach((btn) => {
    const on = btn.dataset.linea === value;
    btn.setAttribute('aria-pressed', String(on));
  });
}

/**
 * Campi extra del Prelievo: la linea si chiede sempre; per i cuscinetti anche
 * macchinario e punto di utilizzo. Per cinghie e ricambi tecnici il punto non
 * si chiede (resta quello standard dell'articolo).
 */
function setupPrelievoFields(product) {
  const isPrelievo = currentMode === 'prelievo';
  const isBearing = product.categoria === 'cuscinetti';
  els.prelievoFields.classList.toggle('hidden', !isPrelievo);
  els.macchinarioWrap.classList.toggle('hidden', !(isPrelievo && isBearing));
  els.puntoWrap.classList.toggle('hidden', isPrelievo && !isBearing);
  els.puntoLabel.textContent = isPrelievo && isBearing ? 'Punto di utilizzo' : 'Punto utilizzo';
  els.puntoInput.placeholder = isPrelievo && isBearing ? 'Dove viene montato' : 'es. Linea 1';
  // Articolo usato su una sola linea (L1 o L2): la linea è automatica e non si sceglie, si vede solo quale è.
  // Con L1-L2 o senza linea, invece, va scelta.
  const fixedLinea = product.linea === 'L1' || product.linea === 'L2' ? product.linea : '';
  setLinea(fixedLinea);
  els.lineaGroup.classList.toggle('hidden', !!fixedLinea);
  els.lineaFixed.classList.toggle('hidden', !fixedLinea);
  els.lineaFixedName.textContent = fixedLinea === 'L1' ? 'Linea 1' : fixedLinea === 'L2' ? 'Linea 2' : '';
  if (isPrelievo && isBearing) fillMacchinari(product.macchina);
}

function renderMacchinariOptions(names, selected) {
  const sel = els.macchinarioSelect;
  sel.innerHTML = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = 'Seleziona macchinario…';
  sel.appendChild(first);
  const list = [...names];
  if (selected && !list.some((n) => n.toLowerCase() === selected.toLowerCase())) list.unshift(selected);
  list.forEach((n) => {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  });
  const match = selected ? list.find((n) => n.toLowerCase() === selected.toLowerCase()) : '';
  sel.value = match || '';
}

async function fillMacchinari(productMacchina) {
  const preferred = (productMacchina || '').trim();
  renderMacchinariOptions(machinesCache || [], preferred);
  if (machinesCache) return;
  try {
    machinesCache = await listDistinctMacchine();
  } catch (err) {
    console.warn('Elenco macchine non disponibile (offline?): resta solo quella dell\'articolo.', err);
    return;
  }
  // Se nel frattempo l'operatore ha già scelto qualcosa, non glielo cambio
  if (currentMode === 'prelievo' && currentProduct && !els.macchinarioSelect.value) {
    renderMacchinariOptions(machinesCache, preferred);
  } else if (currentMode === 'prelievo' && currentProduct) {
    renderMacchinariOptions(machinesCache, els.macchinarioSelect.value);
  }
}

function resetResult() {
  currentProduct = null;
  currentLocationId = null;
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
async function runTransaction({ product, quantita, puntoUtilizzo, linea, macchinario, locationId }) {
  const tipo = currentMode;
  try {
    const result = await processTransaction({
      productId: product.id,
      tipo,
      quantita,
      puntoUtilizzo,
      linea,
      macchinario,
      locationId,
    });

    if (tipo === 'deposito') feedback.transactionDeposito();
    else feedback.transactionPrelievo();

    toastSuccess(
      `${tipo === 'deposito' ? 'Deposito' : 'Prelievo'} registrato: ${result.codice_articolo} → nuova giacenza ${result.nuova_giacenza}${
        getProductLocations(product).length > 1 && result.locazione_scaffale ? ` (${result.locazione_scaffale}: ${result.giacenza_scaffale})` : ''
      }`
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
      const saved = enqueueTransaction({ productId: product.id, tipo, quantita, puntoUtilizzo, linea, macchinario, locationId, codice_articolo: product.codice_articolo });
      if (!saved) {
        // Senza rete e senza spazio sul dispositivo il movimento andrebbe perso:
        // meglio dirlo chiaramente che far credere che sia stato salvato.
        feedback.errorAction();
        toastError('Movimento NON registrato: manca la connessione e la memoria del dispositivo è piena. Riprova con la rete attiva.');
        return { ok: false };
      }
      const delta = tipo === 'deposito' ? quantita : -quantita;
      adjustCachedProductQuantity(product.id, delta, locationId);
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

  // Articolo su più scaffali: lo scaffale va scelto, il movimento è sempre su uno scaffale preciso
  if (getProductLocations(currentProduct).length > 1 && !currentLocationId) {
    feedback.errorAction();
    toastError('Scegli lo scaffale.');
    return;
  }

  // Prelievo: linea sempre obbligatoria; per i cuscinetti anche macchinario e punto di utilizzo
  let linea = null;
  let macchinario = null;
  const punto = els.puntoInput.value.trim();
  if (currentMode === 'prelievo') {
    linea = els.lineaInput.value;
    if (!linea) {
      feedback.errorAction();
      toastError('Seleziona la linea (Linea 1 o Linea 2).');
      return;
    }
    if (currentProduct.categoria === 'cuscinetti') {
      macchinario = els.macchinarioSelect.value;
      if (!macchinario) {
        feedback.errorAction();
        toastError('Seleziona il macchinario.');
        return;
      }
      if (!punto) {
        feedback.errorAction();
        toastError('Indica il punto di utilizzo del cuscinetto.');
        return;
      }
    }
  }

  setButtonBusy(els.confirmBtn, true, 'Registrazione…');
  const product = currentProduct;
  const outcome = await runTransaction({ product, quantita, puntoUtilizzo: punto, linea, macchinario, locationId: currentLocationId });
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
        <p class="ui-note text-graphite-500 mt-0.5 truncate">${escapeHtml(r.profiles?.full_name || 'Utente')} · ${date.toLocaleString('it-IT', {
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
