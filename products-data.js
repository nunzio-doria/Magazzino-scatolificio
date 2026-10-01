// =============================================================
// products-data.js — Magazzino: caricamento/cache dell'elenco, import
// Excel, undo/redo. Codice spostato qui pari pari da products.js: stessa
// logica, stesso comportamento, solo riorganizzato in un file più piccolo.
// =============================================================

import { listProducts, createProduct, updateProduct, deleteProduct, bulkUpsertProducts, getProductsVersion, getProductLocations } from './supabase.js';
import { toastSuccess, toastError, toastWarning } from './toast.js';
import feedback from './feedback.js';
import { replayAnimation, openOverlay, closeOverlay, loadLib } from './ui-utils.js';
import { els, state, CATEGORY_LABELS } from './products-shared.js';
import { renderCurrentList, setListStatic } from './products-list.js';

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
let importCategory = 'cuscinetti';

// --- UNDO / REDO -----------------------------------------------------
const HISTORY_LIMIT = 20;
let undoStack = [];
let redoStack = [];

function toWritableRow(row) {
  return {
    id: row.id,
    categoria: row.categoria,
    codice_articolo: row.codice_articolo,
    scorta_minima: row.scorta_minima,
    codice_barre: row.codice_barre,
    linea: row.linea,
    macchina: row.macchina,
  };
}

/** Scaffali e quantità di un articolo da ripristinare con annulla/ripeti (la giacenza totale ne è la somma) */
function toWritableLocations(row) {
  return getProductLocations(row).map((l) => ({ locazione: l.locazione, quantita: l.quantita }));
}

/**
 * Configurazione import Excel per categoria: elenco colonne attese (in ordine,
 * da sinistra) e funzione di mappatura riga → campi della tabella products.
 */
const CATEGORY_IMPORT_CONFIG = {
  cuscinetti: {
    hint: 'Colonne A→C: Codice, Locazione, Quantità. La scorta minima viene impostata automaticamente a 5 per tutti gli articoli. Per mettere lo stesso codice su più scaffali, scrivi più righe con lo stesso codice (una per scaffale).',
    mapRow: (c) => ({
      codice_articolo: c[0],
      locazione: c[1] || null,
      quantita_disponibile: toInt(c[2]),
      scorta_minima: 5,
    }),
  },
  cinghie: {
    hint: 'Colonne A→G: Codice, Locazione, Quantità, Linea, Macchina, Punto di utilizzo, Scorta minima. Per mettere lo stesso codice su più scaffali, scrivi più righe con lo stesso codice (una per scaffale).',
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
    hint: 'Colonne A→G: Codice, Locazione, Quantità, Linea, Macchina, Descrizione, Scorta minima. Per mettere lo stesso codice su più scaffali, scrivi più righe con lo stesso codice (una per scaffale).',
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

export function initProductsData() {
  els.undoBtn = document.getElementById('product-undo-btn');
  els.redoBtn = document.getElementById('product-redo-btn');

  // Import Excel (dentro un modale a cassetto, aperto da Impostazioni)
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

  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);
  els.importInput.addEventListener('change', handleImportFileChange);
  els.importCategoryTabs.forEach((btn) => {
    btn.addEventListener('click', () => setImportCategory(btn.dataset.importCategoryTab));
  });

  setImportCategory(importCategory);
  updateHistoryButtons();
}

/** Interroga il database con i filtri correnti (ricerca, sotto scorta, categoria, linea/macchina). */
async function fetchCurrentList() {
  let list = await listProducts({
    search: els.searchInput.value.trim(),
    onlyLowStock: els.lowStockToggle.checked,
    categoria: state.currentCategory,
  });
  if (state.currentCategory === 'cinghie' || state.currentCategory === 'pezzi_ricambio') {
    if (state.lineaFilterValue) list = list.filter((p) => matchesLineaFilter(p.linea, state.lineaFilterValue));
    if (state.macchinaFilterValue) list = list.filter((p) => p.macchina === state.macchinaFilterValue);
  }
  return list;
}

function matchesLineaFilter(productLinea, wanted) {
  if (!wanted) return true;
  if (productLinea === wanted) return true;
  if (wanted !== 'L1-L2' && productLinea === 'L1-L2') return true;
  return false;
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
  state.currentList = [];
  refreshSeq += 1; // eventuali richieste in volo non devono più scrivere nulla
}

/** Aggiorna l'elenco senza caricamento e senza animazioni; se la rete non c'è resta l'elenco attuale. */
async function silentRefresh() {
  const seq = ++refreshSeq;
  try {
    const list = await fetchCurrentList();
    if (seq !== refreshSeq) return;
    state.currentList = list;
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
    state.currentList = list;
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
    if (state.currentList.length > 0) {
      renderCurrentList();
      toastWarning('Connessione assente: mostro gli ultimi dati caricati.');
    } else {
      renderCurrentList({ connectionError: true });
      toastError('Impossibile caricare gli articoli. Controlla la connessione.');
    }
  } finally {
    if (seq === refreshSeq) els.skeleton.classList.add('hidden');
  }
}

// --- UNDO / REDO -----------------------------------------------------

export function pushHistory(action) {
  undoStack.push(action);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  if (els.undoBtn) els.undoBtn.disabled = undoStack.length === 0;
  if (els.redoBtn) els.redoBtn.disabled = redoStack.length === 0;
}

export async function undo() {
  if (!undoStack.length) return;
  const action = undoStack[undoStack.length - 1];
  els.undoBtn.disabled = true;
  try {
    if (action.type === 'create') {
      await deleteProduct(action.after.id);
    } else if (action.type === 'update') {
      await updateProduct(action.before.id, toWritableRow(action.before), toWritableLocations(action.before));
    } else if (action.type === 'delete') {
      await createProduct(toWritableRow(action.before), toWritableLocations(action.before));
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

export async function redo() {
  if (!redoStack.length) return;
  const action = redoStack[redoStack.length - 1];
  els.redoBtn.disabled = true;
  try {
    if (action.type === 'create') {
      await createProduct(toWritableRow(action.after), toWritableLocations(action.after));
    } else if (action.type === 'update') {
      await updateProduct(action.after.id, toWritableRow(action.after), toWritableLocations(action.after));
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

// --- IMPORT EXCEL --------------------------------------------------

async function handleImportFileChange(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  const config = CATEGORY_IMPORT_CONFIG[importCategory];
  if (!config) return;

  showImportResult(`Lettura di "${file.name}"…`, 'info');
  try {
    await loadLib('xlsx');
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
    if (importCategory === state.currentCategory) refresh();
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
