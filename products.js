// =============================================================
// products.js — Magazzino: categorie, CRUD, import Excel, barcode
// =============================================================

import {
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  bulkUpsertProducts,
  listDistinctMacchine,
  getProductByBarcode,
  getProductById,
  getProductsVersion,
  createMachine,
} from './supabase.js';
import { getManualForMachineName, openManualForMachineName, refreshManualsCache } from './manuals.js';
import { toastSuccess, toastError, toastWarning } from './toast.js';
import { isAdmin } from './auth.js';
import { startCamera, stopCamera, switchCamera as switchCameraShared, toggleTorch } from './camera.js';
import { openPicker, attachFieldDropdown } from './picker.js';
import { animateFluidSwap } from './app.js';
import { loadIdlePanel } from './scanner.js';
import { confirmDialog } from './ui-modal.js';
import { enhanceSelect } from './ui-select.js';
import feedback from './feedback.js';
import { openOverlay, closeOverlay, enableSheetDrag, staggerIndex, replayAnimation, setButtonBusy } from './ui-utils.js';

const els = {};
let currentList = [];
let editingId = null;
let editingSnapshot = null; // riga completa del prodotto in modifica/eliminazione, per l'undo
let searchDebounce = null;

// --- Caricamento della lista: completo solo una volta per accesso ---------
// Al primo ingresso nel Magazzino dopo l'accesso si vede il caricamento; ai rientri
// successivi la lista già in memoria compare subito, senza caricamento né animazione
// d'ingresso. Se nel frattempo è cambiata una giacenza (movimento registrato) o sono
// passati più di REVALIDATE_MS, l'elenco si aggiorna in silenzio, senza che si veda nulla.
const REVALIDATE_MS = 10 * 60 * 1000;
let productsLoadedOnce = false;
let seenProductsVersion = 0;
let lastLoadedAt = 0;
let refreshSeq = 0; // scarta le risposte arrivate in ritardo (ricerche digitate in fretta)
let currentCategory = 'cuscinetti';
let importCategory = 'cuscinetti';
let lineaFilterValue = '';
let macchinaFilterValue = '';
let viewMode = 'shelf'; // 'shelf' | 'machine' — la vista a elenco non esiste più
const VIEW_MODE_ORDER = ['shelf', 'machine']; // determina la direzione della transizione
let detailProduct = null; // articolo mostrato nella scheda di sola lettura
let returnToDetail = null; // se il modale di modifica è stato aperto dalla scheda, articolo a cui tornare annullando
const openShelves = new Set(); // locazioni espanse, persiste tra i refresh
const openMachines = new Set(); // macchine espanse, persiste tra i refresh
// Il selettore Scaffalatura/Macchina e il riordino per macchina hanno senso solo dove
// l'articolo è davvero legato a una macchina specifica: cinghie e pezzi di ricambio. I
// cuscinetti sono stock generico: mostrano sempre e solo la scaffalatura, senza selettore.
const MACHINE_VIEW_CATEGORIES = ['cinghie', 'pezzi_ricambio'];

// --- UNDO / REDO -----------------------------------------------------
const HISTORY_LIMIT = 20;
let undoStack = [];
let redoStack = [];

function toWritableRow(row) {
  return {
    id: row.id,
    categoria: row.categoria,
    codice_articolo: row.codice_articolo,
    locazione: row.locazione,
    quantita_disponibile: row.quantita_disponibile,
    scorta_minima: row.scorta_minima,
    codice_barre: row.codice_barre,
    linea: row.linea,
    macchina: row.macchina,
  };
}

export const CATEGORY_LABELS = {
  cuscinetti: 'Cuscinetti',
  cinghie: 'Cinghie',
  pezzi_ricambio: 'Ricambi tecnici',
};

const LINEA_OPTIONS = ['L1', 'L2', 'L1-L2'];

/**
 * Configurazione import Excel per categoria: elenco colonne attese (in ordine,
 * da sinistra) e funzione di mappatura riga → campi della tabella products.
 */
const CATEGORY_IMPORT_CONFIG = {
  cuscinetti: {
    hint: 'Colonne A→C: Codice, Locazione, Quantità. La scorta minima viene impostata automaticamente a 5 per tutti gli articoli.',
    mapRow: (c) => ({
      codice_articolo: c[0],
      locazione: c[1] || null,
      quantita_disponibile: toInt(c[2]),
      scorta_minima: 5,
    }),
  },
  cinghie: {
    hint: 'Colonne A→G: Codice, Locazione, Quantità, Linea, Macchina, Punto di utilizzo, Scorta minima.',
    mapRow: (c) => ({
      codice_articolo: c[0],
      locazione: c[1] || null,
      quantita_disponibile: toInt(c[2]),
      linea: c[3] || null,
      macchina: c[4] || null,
      punto_utilizzo_standard: c[5] || null,
      scorta_minima: toInt(c[6]),
    }),
  },
  pezzi_ricambio: {
    hint: 'Colonne A→G: Codice, Locazione, Quantità, Linea, Macchina, Punto di utilizzo, Scorta minima.',
    mapRow: (c) => ({
      codice_articolo: c[0],
      locazione: c[1] || null,
      quantita_disponibile: toInt(c[2]),
      linea: c[3] || null,
      macchina: c[4] || null,
      punto_utilizzo_standard: c[5] || null,
      scorta_minima: toInt(c[6]),
    }),
  },
};

/**
 * Converte una cella dell'Excel in intero per l'importazione. Una cella VUOTA o non
 * numerica diventa `null`, non `0`: la funzione del database che importa le righe
 * (bulk_upsert_products) lascia invariato un valore esistente quando riceve null, e usa
 * 0 solo per un articolo nuovo. Restituire 0 qui, invece di null, azzererebbe in silenzio
 * la giacenza (o la scorta minima) di un articolo già presente ogni volta che, in un
 * successivo reimport, quella colonna viene lasciata vuota per quella riga.
 */
function toInt(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export function initProducts() {
  // Cache dei manuali ricambi (macchina → PDF): caricata subito, non solo da Admin,
  // perché il pulsante "Apri manuale" in Ricambi tecnici serve anche agli operatori.
  refreshManualsCache();

  els.searchInput = document.getElementById('product-search-input');
  els.scanSearchBtn = document.getElementById('product-scan-search-btn');
  els.searchScannerWrap = document.getElementById('product-search-scanner-wrap');
  els.searchScannerCloseBtn = document.getElementById('product-search-scanner-close');
  els.skeleton = document.getElementById('product-list-skeleton');
  els.emptyState = document.getElementById('product-empty-state');
  els.newBtn = document.getElementById('product-new-btn');
  els.undoBtn = document.getElementById('product-undo-btn');
  els.redoBtn = document.getElementById('product-redo-btn');
  els.lowStockToggle = document.getElementById('product-lowstock-toggle');
  els.categoryTabs = document.querySelectorAll('[data-category-tab]');
  els.viewModeTabs = document.querySelectorAll('[data-view-mode-tab]');
  els.viewModeWrap = document.getElementById('product-view-mode-wrap');
  els.shelfView = document.getElementById('product-shelf-view');
  els.machineView = document.getElementById('product-machine-view');
  els.lineaFilterWrap = document.getElementById('product-linea-filter-wrap');
  els.lineaFilterBtn = document.getElementById('product-linea-filter-btn');
  els.lineaFilterValue = document.getElementById('product-linea-filter-value');
  els.macchinaFilterBtn = document.getElementById('product-macchina-filter-btn');
  els.macchinaFilterValue = document.getElementById('product-macchina-filter-value');

  // Import Excel (ora dentro un modale a cassetto, aperto da Impostazioni)
  els.excelModal = document.getElementById('excel-import-modal');
  els.excelOpenBtn = document.getElementById('excel-import-manage-btn');
  els.excelCloseBtn = document.getElementById('excel-import-modal-close');
  els.importCategoryTabs = document.querySelectorAll('[data-import-category-tab]');
  els.importWrap = document.getElementById('product-import-wrap');
  els.importPending = document.getElementById('product-import-pending');
  els.importInput = document.getElementById('product-import-input');
  els.importHint = document.getElementById('product-import-hint');
  els.importResult = document.getElementById('product-import-result');
  els.excelOpenBtn?.addEventListener('click', () => openOverlay(els.excelModal));
  els.excelCloseBtn?.addEventListener('click', () => closeOverlay(els.excelModal));
  els.excelModal?.addEventListener('click', (e) => {
    if (e.target === els.excelModal) closeOverlay(els.excelModal);
  });

  // Scheda articolo (sola lettura): si apre toccando un articolo
  els.detailModal = document.getElementById('product-detail-modal');
  els.detailCloseBtn = document.getElementById('product-detail-close');
  els.detailCategory = document.getElementById('product-detail-category');
  els.detailCode = document.getElementById('product-detail-code');
  els.detailLocazione = document.getElementById('product-detail-locazione');
  els.detailQuantita = document.getElementById('product-detail-quantita');
  els.detailLowStock = document.getElementById('product-detail-lowstock');
  els.detailRows = document.getElementById('product-detail-rows');
  els.detailManualBtn = document.getElementById('product-detail-manual-btn');
  els.detailEditBtn = document.getElementById('product-detail-edit-btn');
  enableSheetDrag(els.detailModal.querySelector('.modal-panel'), () => closeDetail());
  els.detailCloseBtn.addEventListener('click', closeDetail);
  // Sola lettura: nessun dato si perde, quindi si può chiudere anche toccando lo sfondo
  els.detailModal.addEventListener('click', (e) => {
    if (e.target === els.detailModal) closeDetail();
  });
  els.detailEditBtn.addEventListener('click', editFromDetail);
  els.detailManualBtn.addEventListener('click', () => {
    if (!detailProduct?.macchina) return;
    openManualForMachineName(detailProduct.macchina, detailProduct.linea || '', detailProduct.codice_articolo);
  });
  els.detailRows.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="print"]')) printLabelFor(detailProduct?.codice_barre);
  });

  // Modale form
  els.modal = document.getElementById('product-modal');
  enableSheetDrag(els.modal.querySelector('.modal-panel'), () => closeModal());
  els.form = document.getElementById('product-form');
  els.modalTitle = document.getElementById('product-modal-title');
  els.closeModalBtn = document.getElementById('product-modal-close');
  els.deleteBtn = document.getElementById('product-delete-btn');
  els.categoriaSelect = document.getElementById('product-categoria');
  els.categoriaSelectUI = enhanceSelect(els.categoriaSelect);
  els.lineaMacchinaWrap = document.getElementById('product-linea-macchina-wrap');
  els.lineaBtn = document.getElementById('product-linea-btn');
  els.lineaValue = document.getElementById('product-linea-value');
  els.lineaHidden = document.getElementById('product-linea');
  els.macchinaBtn = document.getElementById('product-macchina-btn');
  els.macchinaValue = document.getElementById('product-macchina-value');
  els.macchinaHidden = document.getElementById('product-macchina');
  els.openManualBtn = document.getElementById('product-open-manual-btn');
  els.barcodePreviewWrap = document.getElementById('product-barcode-preview-wrap');
  els.barcodeSvg = document.getElementById('product-barcode-svg');
  els.printLabelBtn = document.getElementById('product-print-label-btn');
  els.generateBarcodeBtn = document.getElementById('product-generate-barcode-btn');
  els.scanBarcodeBtn = document.getElementById('product-scan-barcode-btn');
  els.scanBarcodeStopBtn = document.getElementById('product-scan-barcode-stop');
  els.barcodeScannerWrap = document.getElementById('product-barcode-scanner-wrap');
  els.scanSwitchBtn = document.getElementById('product-scan-switch-btn');
  els.scanTorchBtn = document.getElementById('product-scan-torch-btn');

  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(refresh, 280);
  });
  els.scanSearchBtn?.addEventListener('click', startSearchScan);
  els.searchScannerCloseBtn?.addEventListener('click', stopSearchScan);
  els.lowStockToggle.addEventListener('change', refresh);
  els.lineaFilterBtn?.addEventListener('click', pickLineaFilter);
  els.macchinaFilterBtn?.addEventListener('click', pickMacchinaFilter);
  // Una macchina è stata rimossa dalle Impostazioni: se era il filtro attivo, lo si toglie
  document.addEventListener('machine-removed', (e) => {
    const removed = (e.detail?.nome || '').trim().toLowerCase();
    if (removed && macchinaFilterValue.trim().toLowerCase() === removed) {
      macchinaFilterValue = '';
      updateFilterLabels();
    }
  });
  els.newBtn.addEventListener('click', () => openModal());
  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);
  els.closeModalBtn.addEventListener('click', () => closeModal());
  els.form.addEventListener('submit', handleSubmit);
  els.deleteBtn.addEventListener('click', handleDelete);
  els.printLabelBtn.addEventListener('click', printCurrentLabel);
  els.generateBarcodeBtn.addEventListener('click', generateBarcodeForCurrentArticle);
  els.categoriaSelect.addEventListener('change', updateLineaMacchinaVisibility);
  els.openManualBtn?.addEventListener('click', () => {
    const codice = document.getElementById('product-codice-articolo').value.trim();
    const macchina = els.macchinaHidden.value;
    const linea = els.lineaHidden.value;
    if (!macchina) return;
    openManualForMachineName(macchina, linea, codice);
  });
  els.scanBarcodeBtn.addEventListener('click', startBarcodeScan);
  els.scanBarcodeStopBtn.addEventListener('click', stopBarcodeScan);
  els.scanSwitchBtn?.addEventListener('click', () =>
    switchCameraShared(handleBarcodeScanDetected, { switchBtnEl: els.scanSwitchBtn, torchBtnEl: els.scanTorchBtn })
  );
  els.scanTorchBtn?.addEventListener('click', () => toggleTorch(els.scanTorchBtn));
  els.importInput.addEventListener('change', handleImportFileChange);
  attachFieldDropdown({
    triggerBtn: els.lineaBtn,
    valueEl: els.lineaValue,
    hiddenInput: els.lineaHidden,
    getOptions: LINEA_OPTIONS,
    allowCustom: false,
    onChange: updateManualButtonVisibility,
  });
  attachFieldDropdown({
    triggerBtn: els.macchinaBtn,
    valueEl: els.macchinaValue,
    hiddenInput: els.macchinaHidden,
    getOptions: async () => {
      try {
        return await listDistinctMacchine();
      } catch (err) {
        console.warn('Impossibile caricare l\'elenco delle macchine registrate.', err);
        return [];
      }
    },
    // Si può scrivere il nome di una macchina nuova e aggiungerla: viene registrata nella
    // tabella delle macchine (solo admin, come tutto il form articolo) e selezionata.
    allowCustom: true,
    hideSearch: false,
    onChange: updateManualButtonVisibility,
    onCreate: async (nome) => {
      try {
        const row = await createMachine(nome);
        feedback.confirmAction();
        toastSuccess(`Macchina "${row.nome}" aggiunta.`);
        return row.nome;
      } catch (err) {
        feedback.errorAction();
        toastError(err.message || 'Impossibile aggiungere la macchina.');
        return null;
      }
    },
  });

  els.categoryTabs.forEach((btn) => {
    btn.addEventListener('click', () => setCategory(btn.dataset.categoryTab));
  });
  els.viewModeTabs.forEach((btn) => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.viewModeTab));
  });
  els.importCategoryTabs.forEach((btn) => {
    btn.addEventListener('click', () => setImportCategory(btn.dataset.importCategoryTab));
  });

  document.getElementById('product-codice-barre').addEventListener('input', updateBarcodePreview);

  setCategory(currentCategory);
  setImportCategory(importCategory);
  updateHistoryButtons();
}

let searchScanLastCode = null;
let searchScanLastAt = 0;

/** Apre un piccolo lettore inline per cercare un articolo scansionandone il barcode */
async function startSearchScan() {
  els.searchScannerWrap.classList.remove('hidden');
  const started = await startCamera('product-search-scanner-reader', handleSearchScanDetected, {
    errorHint: 'Usa il campo di ricerca.',
  });
  if (started === false) els.searchScannerWrap.classList.add('hidden');
}

async function stopSearchScan() {
  await stopCamera();
  els.searchScannerWrap.classList.add('hidden');
}

/** Chiamata quando si esce dalla vista Magazzino: chiude eventuali fotocamere rimaste aperte */
export function teardownProducts() {
  stopSearchScan();
  stopBarcodeScan();
  // Uscendo dal Magazzino: al rientro gli elementi già presenti non devono rifare l'animazione d'ingresso
  setListStatic(true);
}

async function handleSearchScanDetected(code) {
  const now = Date.now();
  if (code === searchScanLastCode && now - searchScanLastAt < 2000) return;
  searchScanLastCode = code;
  searchScanLastAt = now;

  try {
    const product = await getProductByBarcode(code);
    if (!product) {
      feedback.scanNotFound();
      toastError(`Nessun articolo trovato per il codice "${code}".`);
      return;
    }
    feedback.scanFound();
    await stopSearchScan();
    els.searchInput.value = product.codice_articolo;
    if (product.categoria && product.categoria !== currentCategory) setCategory(product.categoria);
    else refresh();
    // Recupera il record completo (get_product_by_barcode restituisce solo i
    // campi che servono allo scanner) cosí la scheda mostra anche
    // linea/macchina/punto di utilizzo, non solo i campi base.
    try {
      const fullProduct = await getProductById(product.id);
      openDetail(fullProduct);
    } catch (modalErr) {
      console.warn('Impossibile aprire la scheda completa dell\'articolo.', modalErr);
    }
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Errore nella ricerca articolo.');
  }
}

function setCategory(category) {
  currentCategory = category;
  els.categoryTabs.forEach((btn) => btn.classList.toggle('category-tab-active', btn.dataset.categoryTab === category));

  const showLineaFilter = category === 'cinghie' || category === 'pezzi_ricambio';
  els.lineaFilterWrap.classList.toggle('hidden', !showLineaFilter);
  if (!showLineaFilter) {
    lineaFilterValue = '';
    macchinaFilterValue = '';
    updateFilterLabels();
  }
  els.searchInput.placeholder = showLineaFilter
    ? 'Cerca per codice, locazione, macchina, punto utilizzo…'
    : 'Cerca per codice o scaffale…';

  // Selettore Scaffalatura/Macchina: solo per le categorie dove l'associazione a una
  // macchina ha senso (cinghie, pezzi di ricambio). I cuscinetti mostrano sempre la
  // scaffalatura, senza selettore.
  const showViewToggle = MACHINE_VIEW_CATEGORIES.includes(category);
  els.viewModeWrap?.classList.toggle('hidden', !showViewToggle);
  if (!showViewToggle && viewMode !== 'shelf') {
    // La categoria appena scelta non supporta il riordino per macchina: si torna
    // silenziosamente alla scaffalatura, senza animazione (cambio di contesto, non
    // un'azione dell'utente sul selettore).
    viewMode = 'shelf';
    els.viewModeTabs.forEach((btn) => btn.classList.toggle('view-mode-tab-active', btn.dataset.viewModeTab === 'shelf'));
  }

  refresh();
}

function setViewMode(mode) {
  if (mode === viewMode) return;
  const previousMode = viewMode;
  viewMode = mode;
  els.viewModeTabs.forEach((btn) => btn.classList.toggle('view-mode-tab-active', btn.dataset.viewModeTab === mode));

  if (currentList.length === 0) return; // l'empty state resta cosí com'è, nulla da animare

  // Direzione della transizione coerente con l'ordine dei tab: Scaffalatura →
  // Macchina scivola "avanti", il percorso inverso "indietro".
  const forward = VIEW_MODE_ORDER.indexOf(mode) > VIEW_MODE_ORDER.indexOf(previousMode);
  const fromEl = viewModeElement(previousMode);

  renderModeContent(mode);
  const toEl = viewModeElement(mode);

  animateFluidSwap(fromEl, toEl, forward);
}

function viewModeElement(mode) {
  return mode === 'machine' ? els.machineView : els.shelfView;
}

function renderModeContent(mode) {
  if (mode === 'machine') renderByMachine();
  else renderShelves();
}

function setImportCategory(category) {
  importCategory = category;
  els.importCategoryTabs.forEach((btn) => btn.classList.toggle('import-category-tab-active', btn.dataset.importCategoryTab === category));

  const importConfig = CATEGORY_IMPORT_CONFIG[category];
  els.importWrap.classList.toggle('hidden', !importConfig);
  els.importPending.classList.toggle('hidden', !!importConfig);
  if (importConfig) {
    els.importHint.textContent = importConfig.hint;
    els.importResult.classList.add('hidden');
    els.importInput.value = '';
  }
}

// Markup dell'empty state: due varianti, sempre scritte esplicitamente ad
// ogni utilizzo — mai lasciate come markup statico nell'HTML — cosí non
// resta mai "congelato" il messaggio sbagliato da uno stato precedente
// (es. l'avviso di connessione assente che rimane visibile anche quando
// poi una ricerca legittimamente non trova risultati).
const EMPTY_STATE_HTML = `
  <span class="w-14 h-14 rounded-full bg-graphite-800/60 flex items-center justify-center">
    <i data-lucide="package-search" class="w-6 h-6 text-graphite-600" stroke-width="1.6"></i>
  </span>
  <p class="font-display font-semibold text-sm text-graphite-300">Nessun articolo trovato</p>
  <p class="text-xs text-graphite-500 max-w-[220px] text-center leading-relaxed">Prova a modificare la ricerca o i filtri applicati.</p>
`;
const CONNECTION_ERROR_HTML = `
  <span class="w-14 h-14 rounded-full bg-rose-500/10 flex items-center justify-center">
    <i data-lucide="wifi-off" class="w-6 h-6 text-rose-600" stroke-width="1.6"></i>
  </span>
  <p class="font-display font-semibold text-sm text-graphite-300">Connessione assente</p>
  <p class="text-xs text-graphite-500 max-w-[220px] text-center leading-relaxed">Controlla la rete e riprova.</p>
`;

/** Interroga il database con i filtri correnti (ricerca, sotto scorta, categoria, linea/macchina). */
async function fetchCurrentList() {
  let list = await listProducts({
    search: els.searchInput.value.trim(),
    onlyLowStock: els.lowStockToggle.checked,
    categoria: currentCategory,
  });
  if (currentCategory === 'cinghie' || currentCategory === 'pezzi_ricambio') {
    if (lineaFilterValue) list = list.filter((p) => matchesLineaFilter(p.linea, lineaFilterValue));
    if (macchinaFilterValue) list = list.filter((p) => p.macchina === macchinaFilterValue);
  }
  return list;
}

/** Con `list-static` sulla vista gli elementi dell'elenco compaiono già al loro posto (niente animazione d'ingresso). */
function setListStatic(on) {
  document.getElementById('view-products')?.classList.toggle('list-static', on);
}

function markListLoaded() {
  productsLoadedOnce = true;
  seenProductsVersion = getProductsVersion();
  lastLoadedAt = Date.now();
}

/** Chiamata da app.js ogni volta che si entra nel Magazzino. */
export function enterProducts() {
  if (!productsLoadedOnce) return refresh(); // primo ingresso: caricamento completo
  const changed = getProductsVersion() !== seenProductsVersion;
  const old = Date.now() - lastLoadedAt > REVALIDATE_MS;
  if (changed || old) return silentRefresh();
  return Promise.resolve(); // la lista in memoria è quella giusta: niente da fare
}

/** Dopo il logout: la prossima volta si riparte da zero. */
export function resetProducts() {
  productsLoadedOnce = false;
  seenProductsVersion = 0;
  lastLoadedAt = 0;
  currentList = [];
  refreshSeq += 1; // eventuali richieste in volo non devono più scrivere nulla
}

/** Aggiorna l'elenco senza caricamento e senza animazioni; se la rete non c'è resta l'elenco attuale. */
async function silentRefresh() {
  const seq = ++refreshSeq;
  try {
    const list = await fetchCurrentList();
    if (seq !== refreshSeq) return;
    currentList = list;
    setListStatic(true);
    renderCurrentList();
    markListLoaded();
  } catch (err) {
    console.warn('Aggiornamento silenzioso del Magazzino non riuscito, resta l\'elenco attuale.', err);
  }
}

export async function refresh() {
  const seq = ++refreshSeq;
  setListStatic(false); // caricamento "vero": gli elementi entrano con la loro animazione
  els.skeleton.classList.remove('hidden');
  els.shelfView.classList.add('hidden');
  els.machineView.classList.add('hidden');
  els.emptyState.classList.add('hidden');
  try {
    const list = await fetchCurrentList();
    if (seq !== refreshSeq) return; // nel frattempo è partita una richiesta più recente
    currentList = list;
    renderCurrentList();
    markListLoaded();
  } catch (err) {
    if (seq !== refreshSeq) return;
    console.error(err);
    // Se la richiesta fallisce (rete assente, timeout...) currentList NON
    // viene sovrascritta: mantiene ancora l'ultimo elenco caricato con
    // successo. Se c'è qualcosa, meglio ri-mostrarlo (con un avviso) che
    // lasciare la schermata vuota — la vera causa del problema "cade la
    // rete e sparisce tutto": qui la vista veniva nascosta a inizio
    // funzione e non veniva più ripristinata in caso di errore.
    if (currentList.length > 0) {
      renderCurrentList();
      toastWarning('Connessione assente: mostro gli ultimi dati caricati.');
    } else {
      els.emptyState.innerHTML = CONNECTION_ERROR_HTML;
      els.emptyState.classList.remove('hidden');
      window.lucide?.createIcons();
      toastError('Impossibile caricare gli articoli. Controlla la connessione.');
    }
  } finally {
    if (seq === refreshSeq) els.skeleton.classList.add('hidden');
  }
}

function matchesLineaFilter(productLinea, wanted) {
  if (!wanted) return true;
  if (productLinea === wanted) return true;
  if (wanted !== 'L1-L2' && productLinea === 'L1-L2') return true;
  return false;
}

function renderCurrentList() {
  els.shelfView.classList.add('hidden');
  els.machineView.classList.add('hidden');
  els.emptyState.classList.add('hidden');

  if (currentList.length === 0) {
    els.emptyState.innerHTML = EMPTY_STATE_HTML;
    els.emptyState.classList.remove('hidden');
    window.lucide?.createIcons();
    return;
  }

  renderModeContent(viewMode);
}

/**
 * Vista "scaffalatura": raggruppa gli articoli della categoria/filtri
 * correnti per locazione, una card per scaffale.
 */
function renderShelves() {
  renderGroupedCards({
    wrapEl: els.shelfView,
    openSet: openShelves,
    groupKeyFn: (p) => p.locazione,
    subtitleFields: (p) => [p.macchina, p.punto_utilizzo_standard, p.linea],
    unassignedLabel: 'Non assegnata',
    iconName: 'box',
  });
}

/**
 * Vista "riordino per macchina": stessa logica della scaffalatura ma
 * raggruppata per macchina invece che per locazione — mostra a colpo
 * d'occhio cosa serve riassortire per ciascuna macchina di produzione.
 * Disponibile solo per le categorie in MACHINE_VIEW_CATEGORIES.
 */
function renderByMachine() {
  renderGroupedCards({
    wrapEl: els.machineView,
    openSet: openMachines,
    groupKeyFn: (p) => p.macchina,
    subtitleFields: (p) => [p.locazione, p.punto_utilizzo_standard, p.linea],
    unassignedLabel: 'Nessuna macchina assegnata',
    iconName: 'wrench',
  });
}

/**
 * Motore condiviso da Scaffalatura e Riordino per macchina: raggruppa
 * currentList per una chiave qualsiasi (locazione o macchina) e disegna
 * una card per gruppo, espandibile al tap sull'header (animazione
 * grid-template-rows in CSS) con un lieve stagger in ingresso sugli
 * articoli. Lo stato aperto/chiuso di ogni gruppo persiste tra i refresh
 * tramite l'openSet passato dal chiamante (Set separati per scaffalatura
 * e macchina, cosí non si mescolano tra loro).
 */
function renderGroupedCards({ wrapEl, openSet, groupKeyFn, subtitleFields, unassignedLabel, iconName }) {
  wrapEl.innerHTML = '';
  wrapEl.classList.remove('hidden');

  const groups = new Map(); // chiave di raggruppamento -> prodotti
  for (const p of currentList) {
    const key = groupKeyFn(p) || unassignedLabel;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) =>
    a.localeCompare(b, 'it', { numeric: true, sensitivity: 'base' })
  );

  sortedKeys.forEach((key, cardIndex) => {
    const items = groups.get(key);
    const totQty = items.reduce((sum, p) => sum + (p.quantita_disponibile || 0), 0);
    const lowCount = items.filter((p) => p.quantita_disponibile < p.scorta_minima).length;
    const isOpen = openSet.has(key);

    const itemsHtml = items
      .map((p, i) => {
        const lowStock = p.quantita_disponibile < p.scorta_minima;
        const subtitleParts = subtitleFields(p).filter(Boolean);
        return `
          <button type="button" data-product-id="${p.id}" style="--i:${i}"
            class="shelf-item w-full text-left flex items-center justify-between gap-3 px-4 py-2.5 border-t border-graphite-700 first:border-t-0">
            <div class="min-w-0">
              <p class="font-display font-bold text-graphite-100 truncate text-sm">${escapeHtml(p.codice_articolo)}</p>
              ${subtitleParts.length ? `<p class="ui-note text-graphite-500 mt-0.5 truncate">${escapeHtml(subtitleParts.join(' · '))}</p>` : ''}
            </div>
            <span class="shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-mono font-semibold ${
              lowStock ? 'bg-rose-500/15 text-rose-700' : 'bg-graphite-700 text-graphite-200'
            }">${p.quantita_disponibile}</span>
          </button>
        `;
      })
      .join('');

    const card = document.createElement('div');
    card.className = `list-item-in shelf-card card-plate rounded-xl${isOpen ? ' shelf-open' : ''}`;
    card.style.setProperty('--i', staggerIndex(cardIndex));
    card.innerHTML = `
      <div class="shelf-header flex items-center justify-between gap-3 px-4 py-3.5 border-2 border-graphite-700 rounded-xl">
        <div class="flex items-center gap-3 min-w-0">
          <span class="shrink-0 w-9 h-9 rounded-lg bg-graphite-700/50 flex items-center justify-center">
            <i data-lucide="${iconName}" class="w-[18px] h-[18px] text-graphite-400" stroke-width="1.8"></i>
          </span>
          <div class="min-w-0">
            <p class="font-display font-bold uppercase tracking-wide truncate">${escapeHtml(key)}</p>
            <p class="ui-note text-graphite-500 mt-0.5 flex flex-wrap gap-x-2">
              <span class="whitespace-nowrap">${items.length} ${items.length === 1 ? 'articolo' : 'articoli'} · ${totQty} pz</span>${
      lowCount ? `<span class="whitespace-nowrap font-semibold text-rose-700">${lowCount} sotto scorta</span>` : ''
    }
            </p>
          </div>
        </div>
        <i data-lucide="chevron-down" class="shelf-chevron w-5 h-5 text-graphite-400 shrink-0" stroke-width="2"></i>
      </div>
      <div class="shelf-body-track">
        <div class="shelf-body-inner">${itemsHtml}</div>
      </div>
    `;

    card.querySelector('.shelf-header').addEventListener('click', () => {
      const opening = !card.classList.contains('shelf-open');
      card.classList.toggle('shelf-open', opening);
      if (opening) openSet.add(key);
      else openSet.delete(key);
    });

    // Toccando un articolo si apre la scheda di sola lettura (uguale per tutti); la
    // modifica si raggiunge da lì con il pulsante a matita, riservato all'Admin.
    card.querySelectorAll('.shelf-item').forEach((btn) => {
      const product = items.find((p) => String(p.id) === btn.dataset.productId);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDetail(product);
      });
      btn.classList.add('hover:bg-graphite-700/30', 'transition-colors');
    });

    wrapEl.appendChild(card);
  });

  window.lucide?.createIcons();
}

/**
 * Un operatore (non admin) può aprire la scheda di un articolo per
 * consultarla, ma non modificarla: disabilita tutti i campi e nasconde i
 * pulsanti che scrivono sul database (salva, elimina). Il codice a barre
 * resta comunque visibile/stampabile — è una lettura, non una scrittura.
 */
function applyModalPermissions() {
  const readOnly = !isAdmin();
  ['product-codice-articolo', 'product-punto-standard', 'product-locazione', 'product-quantita', 'product-scorta-minima', 'product-codice-barre'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = readOnly;
  });
  els.categoriaSelectUI ? els.categoriaSelectUI.setDisabled(readOnly) : (els.categoriaSelect.disabled = readOnly);
  els.lineaBtn.disabled = readOnly;
  els.macchinaBtn.disabled = readOnly;
  els.scanBarcodeBtn.disabled = readOnly;
  if (readOnly) {
    els.deleteBtn.classList.add('hidden');
    els.generateBarcodeBtn.classList.add('hidden');
  }
  const submitBtn = els.form.querySelector('button[type="submit"]');
  submitBtn?.classList.toggle('hidden', readOnly);
  els.modalTitle.textContent = readOnly ? 'Dettaglio articolo' : (editingId ? 'Modifica articolo' : 'Nuovo articolo');
}

function openModal(product = null, { fromDetail = false } = {}) {
  returnToDetail = fromDetail ? product : null;
  editingId = product?.id || null;
  editingSnapshot = product ? { ...product } : null;
  els.deleteBtn.classList.toggle('hidden', !product);
  els.form.reset();
  stopBarcodeScan();

  els.categoriaSelect.value = product?.categoria || currentCategory;
  els.categoriaSelectUI?.sync();
  document.getElementById('product-codice-articolo').value = product?.codice_articolo || '';
  els.lineaHidden.value = product?.linea || '';
  els.lineaValue.textContent = product?.linea || 'Seleziona…';
  els.lineaValue.classList.toggle('text-graphite-400', !product?.linea);
  els.lineaValue.classList.toggle('text-graphite-100', !!product?.linea);
  els.macchinaHidden.value = product?.macchina || '';
  els.macchinaValue.textContent = product?.macchina || 'Seleziona…';
  els.macchinaValue.classList.toggle('text-graphite-400', !product?.macchina);
  els.macchinaValue.classList.toggle('text-graphite-100', !!product?.macchina);
  document.getElementById('product-punto-standard').value = product?.punto_utilizzo_standard || '';
  document.getElementById('product-locazione').value = product?.locazione || '';
  document.getElementById('product-quantita').value = product?.quantita_disponibile ?? 0;
  document.getElementById('product-scorta-minima').value = product?.scorta_minima ?? (currentCategory === 'cuscinetti' ? 5 : 0);
  document.getElementById('product-codice-barre').value = product?.codice_barre || '';

  updateLineaMacchinaVisibility();
  updateBarcodePreview();
  updateGenerateBarcodeVisibility();
  applyModalPermissions();
  openOverlay(els.modal);

  // Aggiorna in background la cache dei manuali (potrebbe essere stato caricato/rimosso
  // da poco in Impostazioni) e ricalcola la visibilità del pulsante, solo se la scheda
  // aperta è ancora la stessa nel frattempo.
  const openedId = editingId;
  refreshManualsCache().then(() => {
    if (editingId === openedId) updateManualButtonVisibility();
  });
}

function updateLineaMacchinaVisibility() {
  const categoria = els.categoriaSelect.value;
  els.lineaMacchinaWrap.classList.toggle('hidden', categoria !== 'cinghie' && categoria !== 'pezzi_ricambio');
  updateGenerateBarcodeVisibility();
  updateManualButtonVisibility();
}

/**
 * Mostra il pulsante "Apri manuale ricambi" solo per la categoria Ricambi
 * tecnici, quando è selezionata una macchina e quella macchina ha già un
 * manuale PDF caricato (vedi Impostazioni → Gestione macchine).
 */
function updateManualButtonVisibility() {
  if (!els.openManualBtn) return;
  const categoria = els.categoriaSelect.value;
  const macchina = els.macchinaHidden.value;
  const linea = els.lineaHidden.value;
  const hasManual = categoria === 'pezzi_ricambio' && !!macchina && !!getManualForMachineName(macchina, linea);
  els.openManualBtn.classList.toggle('hidden', !hasManual);
}

/** Il pulsante "genera barcode" ha senso solo per le cinghie, che non hanno un codice a barre fisico sulla confezione */
function updateGenerateBarcodeVisibility() {
  els.generateBarcodeBtn.classList.toggle('hidden', els.categoriaSelect.value !== 'cinghie');
}

function setPickerValue(hiddenInput, labelEl, value) {
  hiddenInput.value = value;
  labelEl.textContent = value || 'Seleziona…';
  labelEl.classList.toggle('text-graphite-400', !value);
  labelEl.classList.toggle('text-graphite-100', !!value);
}

async function pickLineaFilter() {
  const val = await openPicker({
    title: 'Filtra per linea',
    options: LINEA_OPTIONS,
    allowCustom: false,
    currentValue: lineaFilterValue,
  });
  if (val === null) return; // annullato
  lineaFilterValue = val;
  updateFilterLabels();
  refresh();
}

async function pickMacchinaFilter() {
  let options = [];
  try {
    options = await listDistinctMacchine();
  } catch (err) {
    console.warn('Impossibile caricare l\'elenco delle macchine registrate.', err);
  }
  const val = await openPicker({
    title: 'Filtra per macchina',
    options,
    allowCustom: false,
    currentValue: macchinaFilterValue,
  });
  if (val === null) return; // annullato
  macchinaFilterValue = val;
  updateFilterLabels();
  refresh();
}

function updateFilterLabels() {
  if (els.lineaFilterValue) {
    els.lineaFilterValue.textContent = lineaFilterValue || 'Tutte le linee';
    els.lineaFilterValue.classList.toggle('text-graphite-400', !lineaFilterValue);
    els.lineaFilterValue.classList.toggle('text-graphite-100', !!lineaFilterValue);
  }
  if (els.macchinaFilterValue) {
    els.macchinaFilterValue.textContent = macchinaFilterValue || 'Tutte le macchine';
    els.macchinaFilterValue.classList.toggle('text-graphite-400', !macchinaFilterValue);
    els.macchinaFilterValue.classList.toggle('text-graphite-100', !!macchinaFilterValue);
  }
}

/**
 * Chiude il modale di modifica. Se era stato aperto dalla scheda articolo e si annulla
 * (X o trascinamento), si torna alla scheda; dopo un salvataggio o un'eliminazione no
 * (backToDetail: false), perché i dati mostrati sarebbero superati.
 */
function closeModal({ backToDetail = true } = {}) {
  stopBarcodeScan();
  const back = backToDetail ? returnToDetail : null;
  returnToDetail = null;
  // Prima si apre la scheda, poi si chiude il modale: il blocco dello scroll non scende mai a zero
  if (back) openDetail(back);
  closeOverlay(els.modal);
}

// --- SCHEDA ARTICOLO (sola lettura) ------------------------------------

function openDetail(product) {
  if (!product) return;
  detailProduct = product;
  renderDetail(product);
  openOverlay(els.detailModal);

  // Aggiorna in background la cache dei manuali (potrebbe essere stato caricato/rimosso
  // da poco in Impostazioni) e ricalcola il pulsante, solo se la scheda è ancora la stessa.
  const openedId = product.id;
  refreshManualsCache().then(() => {
    if (detailProduct?.id === openedId) updateDetailManualButton();
  });
}

function closeDetail() {
  detailProduct = null;
  closeOverlay(els.detailModal);
}

/** Dalla scheda al modale di modifica (solo Admin): il pulsante è comunque nascosto agli operatori. */
function editFromDetail() {
  const product = detailProduct;
  if (!product || !isAdmin()) return;
  // Prima si apre il modale di modifica, poi si chiude la scheda: il blocco dello scroll non scende mai a zero
  openModal(product, { fromDetail: true });
  detailProduct = null;
  closeOverlay(els.detailModal);
}

function detailValueHtml(value, { mono = false } = {}) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return '<span class="detail-row-value detail-row-value--empty">—</span>';
  return `<span class="detail-row-value${mono ? ' font-mono' : ''}">${escapeHtml(text)}</span>`;
}

function renderDetail(p) {
  els.detailCategory.textContent = CATEGORY_LABELS[p.categoria] || '';
  els.detailCode.textContent = p.codice_articolo || '—';

  const locazione = (p.locazione || '').trim();
  els.detailLocazione.textContent = locazione || '—';
  els.detailLocazione.classList.toggle('text-graphite-400', !locazione);

  const qty = p.quantita_disponibile ?? 0;
  const lowStock = qty < (p.scorta_minima ?? 0); // la scorta minima non si mostra, si segnala solo se si è sotto
  els.detailQuantita.textContent = qty;
  els.detailQuantita.className = `inline-block px-3 py-0.5 rounded-full font-mono font-bold text-xl ${
    lowStock ? 'bg-rose-500/15 text-rose-700' : 'bg-graphite-700 text-graphite-200'
  }`;
  els.detailLowStock.classList.toggle('hidden', !lowStock);

  const hasMachine = p.categoria === 'cinghie' || p.categoria === 'pezzi_ricambio';
  const rows = [];
  if (hasMachine) {
    rows.push({ label: 'Linea', value: p.linea });
    rows.push({ label: 'Macchina', value: p.macchina });
  }
  if (hasMachine || (p.punto_utilizzo_standard || '').trim()) {
    rows.push({ label: 'Punto utilizzo standard', value: p.punto_utilizzo_standard });
  }
  rows.push({ label: 'Codice a barre', value: p.codice_barre, mono: true, print: !!(p.codice_barre || '').trim() });

  els.detailRows.innerHTML = rows
    .map(
      (r) => `
      <div class="detail-row${r.print ? ' detail-row--center' : ''}">
        <dt class="detail-row-label">${escapeHtml(r.label)}</dt>
        <dd class="m-0 min-w-0 flex items-center justify-end gap-2">
          ${detailValueHtml(r.value, { mono: r.mono })}
          ${
            r.print
              ? `<button type="button" data-action="print" aria-label="Stampa etichetta PDF" title="Stampa etichetta PDF"
                  class="shrink-0 w-11 h-11 rounded-lg bg-graphite-800 border border-graphite-700 hover:border-amber-400 text-graphite-300 hover:text-amber-400 flex items-center justify-center transition-colors">
                  <i data-lucide="printer" class="w-5 h-5" stroke-width="1.6"></i>
                </button>`
              : ''
          }
        </dd>
      </div>`
    )
    .join('');

  updateDetailManualButton();
  window.lucide?.createIcons();
}

/** Pulsante manuale (solo icona): solo per Ricambi tecnici, con una macchina che ha già un manuale PDF caricato. */
function updateDetailManualButton() {
  const p = detailProduct;
  const hasManual =
    !!p && p.categoria === 'pezzi_ricambio' && !!p.macchina && !!getManualForMachineName(p.macchina, p.linea || '');
  els.detailManualBtn.classList.toggle('hidden', !hasManual);
}

function updateBarcodePreview() {
  const value = document.getElementById('product-codice-barre').value.trim();
  if (!value) {
    els.barcodePreviewWrap.classList.add('hidden');
    return;
  }
  try {
    // eslint-disable-next-line no-undef
    JsBarcode(els.barcodeSvg, value, {
      format: 'CODE128',
      width: 2,
      height: 60,
      displayValue: true,
      background: 'transparent',
      lineColor: '#14161a',
      fontOptions: 'bold',
      fontSize: 14,
      margin: 6,
    });
    els.barcodePreviewWrap.classList.remove('hidden');
    replayAnimation(els.barcodePreviewWrap, 'result-pop');
  } catch (err) {
    els.barcodePreviewWrap.classList.add('hidden');
  }
}

function handleBarcodeScanDetected(code) {
  document.getElementById('product-codice-barre').value = code;
  updateBarcodePreview();
  stopBarcodeScan();
  feedback.scanFound();
  toastSuccess(`Codice a barre acquisito: ${code}`);
}

/** Apre la fotocamera per acquisire il barcode già stampato sulla confezione (cuscinetti) */
async function startBarcodeScan() {
  els.barcodeScannerWrap.classList.remove('hidden');
  const started = await startCamera('product-barcode-scanner-reader', handleBarcodeScanDetected, {
    switchBtnEl: els.scanSwitchBtn,
    torchBtnEl: els.scanTorchBtn,
    errorHint: 'Inserisci il codice a mano.',
  });
  if (started === false) els.barcodeScannerWrap.classList.add('hidden');
}

function stopBarcodeScan() {
  stopCamera();
  els.barcodeScannerWrap.classList.add('hidden');
  els.scanSwitchBtn?.classList.add('hidden');
  els.scanTorchBtn?.classList.add('hidden');
}

/**
 * Genera un codice a barre deterministico per articoli senza un barcode fisico
 * (es. cinghie): stesso prefisso di categoria + codice articolo, quindi è stabile
 * "per sempre" — rigenerarlo per lo stesso articolo produce sempre lo stesso valore.
 */
function generateBarcodeForCurrentArticle() {
  const codice = document.getElementById('product-codice-articolo').value.trim();
  if (!codice) {
    feedback.errorAction();
    toastError('Inserisci prima il codice articolo.');
    return;
  }
  const categoria = els.categoriaSelect.value;
  const prefix = { cuscinetti: 'CUS', cinghie: 'CIN', pezzi_ricambio: 'PZR' }[categoria] || 'ART';
  const generated = `${prefix}-${codice}`.toUpperCase().replace(/\s+/g, '');
  document.getElementById('product-codice-barre').value = generated;
  updateBarcodePreview();
  feedback.confirmAction();
  toastSuccess('Codice a barre generato.');
}

async function handleSubmit(e) {
  e.preventDefault();
  const payload = {
    categoria: els.categoriaSelect.value,
    codice_articolo: document.getElementById('product-codice-articolo').value.trim(),
    linea: els.lineaHidden.value || null,
    macchina: els.macchinaHidden.value || null,
    punto_utilizzo_standard: document.getElementById('product-punto-standard').value.trim() || null,
    locazione: document.getElementById('product-locazione').value.trim() || null,
    quantita_disponibile: parseInt(document.getElementById('product-quantita').value, 10) || 0,
    scorta_minima: parseInt(document.getElementById('product-scorta-minima').value, 10) || 0,
    codice_barre: document.getElementById('product-codice-barre').value.trim() || null,
  };

  const submitBtn = els.form.querySelector('button[type="submit"]');
  setButtonBusy(submitBtn, true, 'Salvataggio…');
  try {
    if (editingId) {
      const before = editingSnapshot;
      const after = await updateProduct(editingId, payload);
      pushHistory({ type: 'update', before, after });
      feedback.confirmAction();
      toastSuccess('Articolo aggiornato.');
    } else {
      const after = await createProduct(payload);
      pushHistory({ type: 'create', before: null, after });
      feedback.confirmAction();
      toastSuccess('Articolo creato.');
    }
    closeModal({ backToDetail: false });
    if (payload.categoria === currentCategory) refresh();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message?.includes('duplicate') ? 'Codice articolo già esistente in questa categoria, oppure barcode già usato.' : 'Errore nel salvataggio.');
  } finally {
    setButtonBusy(submitBtn, false);
  }
}

async function handleDelete() {
  if (!editingId) return;
  const ok = await confirmDialog({
    title: 'Eliminare l\'articolo?',
    message: 'Verranno eliminati anche tutti i movimenti (depositi/prelievi) registrati per questo articolo. L\'operazione non è reversibile.',
    confirmLabel: 'Elimina',
    danger: true,
  });
  if (!ok) return;
  try {
    const before = editingSnapshot;
    await deleteProduct(editingId);
    pushHistory({ type: 'delete', before, after: null });
    toastSuccess('Articolo eliminato.');
    closeModal({ backToDetail: false });
    refresh();
    loadIdlePanel(); // la cronologia dell'articolo è sparita anche dagli "ultimi movimenti" in Scanner
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Errore durante l\'eliminazione dell\'articolo.');
  }
}

// --- UNDO / REDO -----------------------------------------------------

function pushHistory(action) {
  undoStack.push(action);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  if (els.undoBtn) els.undoBtn.disabled = undoStack.length === 0;
  if (els.redoBtn) els.redoBtn.disabled = redoStack.length === 0;
}

async function undo() {
  if (!undoStack.length) return;
  const action = undoStack[undoStack.length - 1];
  els.undoBtn.disabled = true;
  try {
    if (action.type === 'create') {
      await deleteProduct(action.after.id);
    } else if (action.type === 'update') {
      await updateProduct(action.before.id, toWritableRow(action.before));
    } else if (action.type === 'delete') {
      await createProduct(toWritableRow(action.before));
    }
    undoStack.pop();
    redoStack.push(action);
    feedback.undo();
    toastSuccess('Operazione annullata.');
    refresh();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Impossibile annullare l\'operazione.');
  } finally {
    updateHistoryButtons();
  }
}

async function redo() {
  if (!redoStack.length) return;
  const action = redoStack[redoStack.length - 1];
  els.redoBtn.disabled = true;
  try {
    if (action.type === 'create') {
      await createProduct(toWritableRow(action.after));
    } else if (action.type === 'update') {
      await updateProduct(action.after.id, toWritableRow(action.after));
    } else if (action.type === 'delete') {
      await deleteProduct(action.before.id);
    }
    redoStack.pop();
    undoStack.push(action);
    feedback.redo();
    toastSuccess('Operazione ripetuta.');
    refresh();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Impossibile ripetere l\'operazione.');
  } finally {
    updateHistoryButtons();
  }
}

/** Genera un PDF stampabile con SOLO il barcode e il suo numero sotto (nessun testo aggiuntivo) */
function printCurrentLabel() {
  printLabelFor(document.getElementById('product-codice-barre').value.trim());
}

/** Stessa etichetta, per un barcode qualsiasi (usata sia dal modale di modifica sia dalla scheda articolo) */
function printLabelFor(barcode) {
  barcode = (barcode || '').trim();
  if (!barcode) {
    feedback.errorAction();
    toastError('Inserisci o genera un codice a barre prima di stampare.');
    return;
  }

  const canvas = document.createElement('canvas');
  // eslint-disable-next-line no-undef
  JsBarcode(canvas, barcode, {
    format: 'CODE128',
    width: 2.6,
    height: 80,
    displayValue: true,
    fontSize: 18,
    margin: 8,
    background: '#ffffff',
    lineColor: '#000000',
  });
  const imgData = canvas.toDataURL('image/png');

  // eslint-disable-next-line no-undef
  const { jsPDF } = window.jspdf;
  const LABEL_W = 70;
  const LABEL_H = 35;
  // Orientamento esplicito: senza specificarlo, jsPDF può interpretare un
  // formato [largo, alto] come portrait e invertire le dimensioni, tagliando
  // il barcode fuori dalla pagina — bug risolto forzando 'landscape'.
  const doc = new jsPDF({ unit: 'mm', orientation: 'landscape', format: [LABEL_W, LABEL_H] });

  // Adatta l'immagine mantenendo le proporzioni reali del barcode generato,
  // centrata nella pagina, così non viene mai tagliata né distorta.
  const marginMM = 4;
  const maxW = LABEL_W - marginMM * 2;
  const maxH = LABEL_H - marginMM * 2;
  const aspect = canvas.width / canvas.height;
  let drawW = maxW;
  let drawH = drawW / aspect;
  if (drawH > maxH) {
    drawH = maxH;
    drawW = drawH * aspect;
  }
  const x = (LABEL_W - drawW) / 2;
  const y = (LABEL_H - drawH) / 2;
  doc.addImage(imgData, 'PNG', x, y, drawW, drawH);

  doc.save(`barcode_${barcode}.pdf`);
  feedback.confirmAction();
  toastSuccess('Etichetta PDF generata.');
}

// --- IMPORT EXCEL --------------------------------------------------

async function handleImportFileChange(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  const config = CATEGORY_IMPORT_CONFIG[importCategory];
  if (!config) return;

  showImportResult(`Lettura di "${file.name}"…`, 'info');
  try {
    const buffer = await file.arrayBuffer();
    // eslint-disable-next-line no-undef
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    // eslint-disable-next-line no-undef
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

    let dataRows = rows;
    if (rows.length && String(rows[0][0] ?? '').trim().toLowerCase().includes('codice')) {
      dataRows = rows.slice(1);
    }

    const mapped = [];
    for (const r of dataRows) {
      const cells = (r || []).map((c) => (c === null || c === undefined ? '' : String(c).trim()));
      if (!cells[0]) continue;
      mapped.push(config.mapRow(cells));
    }

    if (!mapped.length) {
      showImportResult('Nessuna riga valida trovata nel file (colonna Codice vuota?).', 'error');
      return;
    }

    showImportResult(`Importazione di ${mapped.length} righe in corso…`, 'info');
    const result = await bulkUpsertProducts(importCategory, mapped);
    showImportResult(
      `Importazione completata: ${result.totale} articoli (${result.inseriti} nuovi, ${result.aggiornati} aggiornati).`,
      'success'
    );
    feedback.confirmAction();
    toastSuccess(`${CATEGORY_LABELS[importCategory]}: importazione completata.`);
    if (importCategory === currentCategory) refresh();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    showImportResult('Errore durante la lettura o l\'importazione del file. Verifica che sia un .xlsx valido con le colonne nell\'ordine corretto.', 'error');
  }
}

function showImportResult(message, type) {
  const styles = {
    info: 'bg-graphite-700/60 text-graphite-300',
    success: 'bg-emerald-500/15 text-emerald-700',
    error: 'bg-rose-500/15 text-rose-700',
  };
  els.importResult.textContent = message;
  els.importResult.className = `text-xs mt-2 rounded-lg px-3 py-2 ${styles[type] || styles.info}`;
  els.importResult.classList.remove('hidden');
  replayAnimation(els.importResult, 'empty-state-in');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
