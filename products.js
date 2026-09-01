// =============================================================
// products.js — Magazzino: categorie, CRUD, import Excel, barcode
// =============================================================

import { listProducts, createProduct, updateProduct, deleteProduct, bulkUpsertProducts, listDistinctMacchine } from './supabase.js';
import { toastSuccess, toastError } from './toast.js';
import { isAdmin } from './auth.js';
import { startCamera, stopCamera } from './camera.js';
import { openPicker } from './picker.js';
import { animateFluidSwap } from './app.js';
import { confirmDialog } from './ui-modal.js';
import { enhanceSelect } from './ui-select.js';

const els = {};
let currentList = [];
let editingId = null;
let editingSnapshot = null; // riga completa del prodotto in modifica/eliminazione, per l'undo
let searchDebounce = null;
let currentCategory = 'cuscinetti';
let importCategory = 'cuscinetti';
let lineaFilterValue = '';
let macchinaFilterValue = '';
let viewMode = 'list'; // 'list' | 'shelf' | 'machine'
const VIEW_MODE_ORDER = ['list', 'shelf', 'machine']; // determina la direzione della transizione
const openShelves = new Set(); // locazioni espanse, persiste tra i refresh
const openMachines = new Set(); // macchine espanse, persiste tra i refresh
// Il riordino per macchina ha senso solo dove l'articolo è davvero legato a
// una macchina specifica: cinghie e pezzi di ricambio. I cuscinetti sono
// stock generico, senza questa associazione.
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

const CATEGORY_LABELS = {
  cuscinetti: 'Cuscinetti',
  cinghie: 'Cinghie',
  pezzi_ricambio: 'Pezzi di ricambio',
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
};

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

export function initProducts() {
  els.searchInput = document.getElementById('product-search-input');
  els.listWrap = document.getElementById('product-list');
  els.skeleton = document.getElementById('product-list-skeleton');
  els.emptyState = document.getElementById('product-empty-state');
  els.newBtn = document.getElementById('product-new-btn');
  els.undoBtn = document.getElementById('product-undo-btn');
  els.redoBtn = document.getElementById('product-redo-btn');
  els.lowStockToggle = document.getElementById('product-lowstock-toggle');
  els.categoryTabs = document.querySelectorAll('[data-category-tab]');
  els.viewModeTabs = document.querySelectorAll('[data-view-mode-tab]');
  els.shelfView = document.getElementById('product-shelf-view');
  els.machineView = document.getElementById('product-machine-view');
  els.machineViewTab = document.querySelector('[data-view-mode-tab="machine"]');
  els.lineaFilterWrap = document.getElementById('product-linea-filter-wrap');
  els.lineaFilterBtn = document.getElementById('product-linea-filter-btn');
  els.lineaFilterValue = document.getElementById('product-linea-filter-value');
  els.macchinaFilterBtn = document.getElementById('product-macchina-filter-btn');
  els.macchinaFilterValue = document.getElementById('product-macchina-filter-value');

  // Import Excel (vista Impostazioni)
  els.importCategoryTabs = document.querySelectorAll('[data-import-category-tab]');
  els.importWrap = document.getElementById('product-import-wrap');
  els.importPending = document.getElementById('product-import-pending');
  els.importInput = document.getElementById('product-import-input');
  els.importHint = document.getElementById('product-import-hint');
  els.importResult = document.getElementById('product-import-result');

  // Modale form
  els.modal = document.getElementById('product-modal');
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
  els.barcodePreviewWrap = document.getElementById('product-barcode-preview-wrap');
  els.barcodeSvg = document.getElementById('product-barcode-svg');
  els.printLabelBtn = document.getElementById('product-print-label-btn');
  els.generateBarcodeBtn = document.getElementById('product-generate-barcode-btn');
  els.scanBarcodeBtn = document.getElementById('product-scan-barcode-btn');
  els.scanBarcodeStopBtn = document.getElementById('product-scan-barcode-stop');
  els.barcodeScannerWrap = document.getElementById('product-barcode-scanner-wrap');

  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(refresh, 280);
  });
  els.lowStockToggle.addEventListener('change', refresh);
  els.lineaFilterBtn?.addEventListener('click', pickLineaFilter);
  els.macchinaFilterBtn?.addEventListener('click', pickMacchinaFilter);
  els.newBtn.addEventListener('click', () => openModal());
  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);
  els.closeModalBtn.addEventListener('click', closeModal);
  els.form.addEventListener('submit', handleSubmit);
  els.deleteBtn.addEventListener('click', handleDelete);
  els.printLabelBtn.addEventListener('click', printCurrentLabel);
  els.generateBarcodeBtn.addEventListener('click', generateBarcodeForCurrentArticle);
  els.categoriaSelect.addEventListener('change', updateLineaMacchinaVisibility);
  els.scanBarcodeBtn.addEventListener('click', startBarcodeScan);
  els.scanBarcodeStopBtn.addEventListener('click', stopBarcodeScan);
  els.importInput.addEventListener('change', handleImportFileChange);
  els.lineaBtn.addEventListener('click', pickLinea);
  els.macchinaBtn.addEventListener('click', pickMacchina);

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

function setCategory(category) {
  currentCategory = category;
  els.categoryTabs.forEach((btn) => btn.classList.toggle('category-tab-active', btn.dataset.categoryTab === category));

  const showLineaFilter = category === 'cinghie';
  els.lineaFilterWrap.classList.toggle('hidden', !showLineaFilter);
  if (!showLineaFilter) {
    lineaFilterValue = '';
    macchinaFilterValue = '';
    updateFilterLabels();
  }

  // Riordino per macchina: visibile solo per le categorie dove l'associazione
  // a una macchina ha senso (cinghie, pezzi di ricambio) — non per i cuscinetti.
  const showMachineView = MACHINE_VIEW_CATEGORIES.includes(category);
  els.machineViewTab?.classList.toggle('hidden', !showMachineView);
  if (!showMachineView && viewMode === 'machine') {
    // La categoria appena scelta non supporta questa modalità: torna
    // silenziosamente a Elenco, senza animazione (cambio di contesto, non
    // un'azione dell'utente sul toggle).
    viewMode = 'list';
    els.viewModeTabs.forEach((btn) => btn.classList.toggle('view-mode-tab-active', btn.dataset.viewModeTab === 'list'));
  }

  refresh();
}

function setViewMode(mode) {
  if (mode === viewMode) return;
  const previousMode = viewMode;
  viewMode = mode;
  els.viewModeTabs.forEach((btn) => btn.classList.toggle('view-mode-tab-active', btn.dataset.viewModeTab === mode));

  if (currentList.length === 0) return; // l'empty state resta cosí com'è, nulla da animare

  // Direzione della transizione coerente con l'ordine dei tab: Elenco →
  // Scaffalatura → Macchina scivola "avanti", il percorso inverso "indietro".
  const forward = VIEW_MODE_ORDER.indexOf(mode) > VIEW_MODE_ORDER.indexOf(previousMode);
  const fromEl = viewModeElement(previousMode);

  renderModeContent(mode);
  const toEl = viewModeElement(mode);

  animateFluidSwap(fromEl, toEl, forward);
}

function viewModeElement(mode) {
  if (mode === 'shelf') return els.shelfView;
  if (mode === 'machine') return els.machineView;
  return els.listWrap;
}

function renderModeContent(mode) {
  if (mode === 'shelf') renderShelves();
  else if (mode === 'machine') renderByMachine();
  else renderList();
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

export async function refresh() {
  els.skeleton.classList.remove('hidden');
  els.listWrap.classList.add('hidden');
  els.emptyState.classList.add('hidden');
  try {
    currentList = await listProducts({
      search: els.searchInput.value.trim(),
      onlyLowStock: els.lowStockToggle.checked,
      categoria: currentCategory,
    });
    if (currentCategory === 'cinghie') {
      if (lineaFilterValue) currentList = currentList.filter((p) => matchesLineaFilter(p.linea, lineaFilterValue));
      if (macchinaFilterValue) currentList = currentList.filter((p) => p.macchina === macchinaFilterValue);
    }
    renderCurrentList();
  } catch (err) {
    console.error(err);
    toastError('Errore nel caricamento degli articoli.');
  } finally {
    els.skeleton.classList.add('hidden');
  }
}

function matchesLineaFilter(productLinea, wanted) {
  if (!wanted) return true;
  if (productLinea === wanted) return true;
  if (wanted !== 'L1-L2' && productLinea === 'L1-L2') return true;
  return false;
}

function renderCurrentList() {
  els.listWrap.classList.add('hidden');
  els.shelfView.classList.add('hidden');
  els.machineView.classList.add('hidden');
  els.emptyState.classList.add('hidden');

  if (currentList.length === 0) {
    els.emptyState.classList.remove('hidden');
    return;
  }

  renderModeContent(viewMode);
}

function renderList() {
  els.listWrap.innerHTML = '';
  els.listWrap.classList.remove('hidden');

  for (const p of currentList) {
    const lowStock = p.quantita_disponibile < p.scorta_minima;
    const subtitleParts = [p.locazione, p.macchina, p.punto_utilizzo_standard, p.linea].filter(Boolean);
    const row = document.createElement('button');
    row.type = 'button';
    row.className =
      'w-full text-left card-plate rounded-xl px-4 py-3 flex items-center justify-between gap-3 hover:border-amber-500/40 transition-colors';
    row.innerHTML = `
      <div class="min-w-0">
        <p class="font-display font-bold text-graphite-100 truncate">${escapeHtml(p.codice_articolo)}</p>
        <p class="text-xs text-graphite-500 mt-0.5 truncate">${escapeHtml(subtitleParts.join(' · ') || '—')}</p>
      </div>
      <div class="shrink-0 text-right">
        <span class="inline-block px-2.5 py-1 rounded-full text-sm font-mono font-semibold ${
          lowStock ? 'bg-rose-500/15 text-rose-700' : 'bg-graphite-700 text-graphite-200'
        }">${p.quantita_disponibile}</span>
        ${lowStock ? '<p class="text-[10px] uppercase tracking-wide text-rose-700 mt-1">sotto scorta</p>' : ''}
      </div>
    `;
    if (isAdmin()) row.addEventListener('click', () => openModal(p));
    else row.disabled = true;
    els.listWrap.appendChild(row);
  }
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

  for (const key of sortedKeys) {
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
              ${subtitleParts.length ? `<p class="text-[11px] text-graphite-500 mt-0.5 truncate">${escapeHtml(subtitleParts.join(' · '))}</p>` : ''}
            </div>
            <span class="shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-mono font-semibold ${
              lowStock ? 'bg-rose-500/15 text-rose-700' : 'bg-graphite-700 text-graphite-200'
            }">${p.quantita_disponibile}</span>
          </button>
        `;
      })
      .join('');

    const card = document.createElement('div');
    card.className = `shelf-card card-plate rounded-xl${isOpen ? ' shelf-open' : ''}`;
    card.innerHTML = `
      <div class="shelf-header flex items-center justify-between gap-3 px-4 py-3.5 border-2 border-graphite-700 rounded-xl">
        <div class="flex items-center gap-3 min-w-0">
          <span class="shrink-0 w-9 h-9 rounded-lg bg-graphite-700/50 flex items-center justify-center">
            <i data-lucide="${iconName}" class="w-[18px] h-[18px] text-graphite-400" stroke-width="1.8"></i>
          </span>
          <div class="min-w-0">
            <p class="font-display font-bold uppercase tracking-wide truncate">${escapeHtml(key)}</p>
            <p class="text-[11px] text-graphite-500 mt-0.5">${items.length} ${items.length === 1 ? 'articolo' : 'articoli'} · ${totQty} pz${
      lowCount ? ` · <span class="text-rose-700">${lowCount} sotto scorta</span>` : ''
    }</p>
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

    // Sola lettura per l'operatore: stesso criterio usato nell'elenco piatto.
    card.querySelectorAll('.shelf-item').forEach((btn) => {
      if (isAdmin()) {
        const product = items.find((p) => String(p.id) === btn.dataset.productId);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(product);
        });
        btn.classList.add('hover:bg-graphite-700/30', 'transition-colors');
      } else {
        btn.disabled = true;
      }
    });

    wrapEl.appendChild(card);
  }

  window.lucide?.createIcons();
}

function openModal(product = null) {
  editingId = product?.id || null;
  editingSnapshot = product ? { ...product } : null;
  els.modalTitle.textContent = product ? 'Modifica articolo' : 'Nuovo articolo';
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
  els.modal.classList.remove('hidden');
  requestAnimationFrame(() => els.modal.classList.add('modal-visible'));
}

function updateLineaMacchinaVisibility() {
  els.lineaMacchinaWrap.classList.toggle('hidden', els.categoriaSelect.value !== 'cinghie');
  updateGenerateBarcodeVisibility();
}

/** Il pulsante "genera barcode" ha senso solo per le cinghie, che non hanno un codice a barre fisico sulla confezione */
function updateGenerateBarcodeVisibility() {
  els.generateBarcodeBtn.classList.toggle('hidden', els.categoriaSelect.value !== 'cinghie');
}

async function pickLinea() {
  const val = await openPicker({
    title: 'Seleziona linea',
    options: LINEA_OPTIONS,
    allowCustom: false,
    currentValue: els.lineaHidden.value,
  });
  if (val === null) return; // annullato
  setPickerValue(els.lineaHidden, els.lineaValue, val);
}

async function pickMacchina() {
  let options = [];
  try {
    options = await listDistinctMacchine();
  } catch (err) {
    console.warn('Impossibile caricare l\'elenco delle macchine registrate.', err);
  }
  const val = await openPicker({
    title: 'Seleziona macchina',
    options,
    allowCustom: true,
    currentValue: els.macchinaHidden.value,
  });
  if (val === null) return; // annullato
  setPickerValue(els.macchinaHidden, els.macchinaValue, val);
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

function closeModal() {
  stopBarcodeScan();
  els.modal.classList.remove('modal-visible');
  setTimeout(() => els.modal.classList.add('hidden'), 180);
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
  } catch (err) {
    els.barcodePreviewWrap.classList.add('hidden');
  }
}

/** Apre la fotocamera per acquisire il barcode già stampato sulla confezione (cuscinetti) */
async function startBarcodeScan() {
  els.barcodeScannerWrap.classList.remove('hidden');
  const started = await startCamera('product-barcode-scanner-reader', (code) => {
    document.getElementById('product-codice-barre').value = code;
    updateBarcodePreview();
    stopBarcodeScan();
    toastSuccess(`Codice a barre acquisito: ${code}`);
  });
  if (!started) els.barcodeScannerWrap.classList.add('hidden');
}

function stopBarcodeScan() {
  stopCamera();
  els.barcodeScannerWrap.classList.add('hidden');
}

/**
 * Genera un codice a barre deterministico per articoli senza un barcode fisico
 * (es. cinghie): stesso prefisso di categoria + codice articolo, quindi è stabile
 * "per sempre" — rigenerarlo per lo stesso articolo produce sempre lo stesso valore.
 */
function generateBarcodeForCurrentArticle() {
  const codice = document.getElementById('product-codice-articolo').value.trim();
  if (!codice) {
    toastError('Inserisci prima il codice articolo.');
    return;
  }
  const categoria = els.categoriaSelect.value;
  const prefix = { cuscinetti: 'CUS', cinghie: 'CIN', pezzi_ricambio: 'PZR' }[categoria] || 'ART';
  const generated = `${prefix}-${codice}`.toUpperCase().replace(/\s+/g, '');
  document.getElementById('product-codice-barre').value = generated;
  updateBarcodePreview();
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
  submitBtn.disabled = true;
  submitBtn.classList.add('opacity-60');
  try {
    if (editingId) {
      const before = editingSnapshot;
      const after = await updateProduct(editingId, payload);
      pushHistory({ type: 'update', before, after });
      toastSuccess('Articolo aggiornato.');
    } else {
      const after = await createProduct(payload);
      pushHistory({ type: 'create', before: null, after });
      toastSuccess('Articolo creato.');
    }
    closeModal();
    if (payload.categoria === currentCategory) refresh();
  } catch (err) {
    console.error(err);
    toastError(err.message?.includes('duplicate') ? 'Codice articolo già esistente in questa categoria, oppure barcode già usato.' : 'Errore nel salvataggio.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.classList.remove('opacity-60');
  }
}

async function handleDelete() {
  if (!editingId) return;
  const ok = await confirmDialog({
    title: 'Eliminare l\'articolo?',
    message: 'Lo storico transazioni resterà collegato. L\'operazione non è reversibile.',
    confirmLabel: 'Elimina',
    danger: true,
  });
  if (!ok) return;
  try {
    const before = editingSnapshot;
    await deleteProduct(editingId);
    pushHistory({ type: 'delete', before, after: null });
    toastSuccess('Articolo eliminato.');
    closeModal();
    refresh();
  } catch (err) {
    console.error(err);
    toastError('Impossibile eliminare: verifica che non ci siano transazioni collegate.');
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
    toastSuccess('Operazione annullata.');
    refresh();
  } catch (err) {
    console.error(err);
    toastError('Impossibile annullare l\'operazione (l\'articolo potrebbe avere transazioni collegate).');
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
    toastSuccess('Operazione ripetuta.');
    refresh();
  } catch (err) {
    console.error(err);
    toastError('Impossibile ripetere l\'operazione (l\'articolo potrebbe avere transazioni collegate).');
  } finally {
    updateHistoryButtons();
  }
}

/** Genera un PDF stampabile con SOLO il barcode e il suo numero sotto (nessun testo aggiuntivo) */
function printCurrentLabel() {
  const barcode = document.getElementById('product-codice-barre').value.trim();
  if (!barcode) {
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
    toastSuccess(`${CATEGORY_LABELS[importCategory]}: importazione completata.`);
    if (importCategory === currentCategory) refresh();
  } catch (err) {
    console.error(err);
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
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
