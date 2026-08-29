// =============================================================
// products.js — Magazzino: categorie, CRUD, import Excel, barcode
// =============================================================

import { listProducts, createProduct, updateProduct, deleteProduct, bulkUpsertProducts } from './supabase.js';
import { toastSuccess, toastError, toastInfo } from './toast.js';
import { isAdmin } from './auth.js';
import { startCamera, stopCamera } from './camera.js';

const els = {};
let currentList = [];
let editingId = null;
let searchDebounce = null;
let currentCategory = 'cuscinetti';

const CATEGORY_LABELS = {
  cuscinetti: 'Cuscinetti',
  cinghie: 'Cinghie',
  pezzi_ricambio: 'Pezzi di ricambio',
};

/**
 * Configurazione import Excel per categoria: elenco colonne attese (in ordine,
 * da sinistra) e funzione di mappatura riga → campi della tabella products.
 * Le colonne si leggono per POSIZIONE, non per nome (la prima riga, se
 * riconosciuta come intestazione, viene comunque saltata automaticamente).
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
  els.lowStockToggle = document.getElementById('product-lowstock-toggle');
  els.categoryTabs = document.querySelectorAll('[data-category-tab]');

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
  els.lineaMacchinaWrap = document.getElementById('product-linea-macchina-wrap');
  els.barcodePreviewWrap = document.getElementById('product-barcode-preview-wrap');
  els.barcodeSvg = document.getElementById('product-barcode-svg');
  els.printLabelBtn = document.getElementById('product-print-label-btn');
  els.scanBarcodeBtn = document.getElementById('product-scan-barcode-btn');
  els.scanBarcodeStopBtn = document.getElementById('product-scan-barcode-stop');
  els.barcodeScannerWrap = document.getElementById('product-barcode-scanner-wrap');

  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(refresh, 280);
  });
  els.lowStockToggle.addEventListener('change', refresh);
  els.newBtn.addEventListener('click', () => openModal());
  els.closeModalBtn.addEventListener('click', closeModal);
  els.form.addEventListener('submit', handleSubmit);
  els.deleteBtn.addEventListener('click', handleDelete);
  els.printLabelBtn.addEventListener('click', printCurrentLabel);
  els.categoriaSelect.addEventListener('change', updateLineaMacchinaVisibility);
  els.scanBarcodeBtn.addEventListener('click', startBarcodeScan);
  els.scanBarcodeStopBtn.addEventListener('click', stopBarcodeScan);
  els.importInput.addEventListener('change', handleImportFileChange);

  els.categoryTabs.forEach((btn) => {
    btn.addEventListener('click', () => setCategory(btn.dataset.categoryTab));
  });

  // Anteprima barcode live mentre si digita il codice a barre
  document.getElementById('product-codice-barre').addEventListener('input', updateBarcodePreview);

  setCategory(currentCategory);
}

function setCategory(category) {
  currentCategory = category;
  els.categoryTabs.forEach((btn) => btn.classList.toggle('category-tab-active', btn.dataset.categoryTab === category));

  const importConfig = CATEGORY_IMPORT_CONFIG[category];
  const admin = isAdmin();
  els.importWrap.classList.toggle('hidden', !(importConfig && admin));
  els.importPending.classList.toggle('hidden', !(!importConfig && admin));
  if (importConfig) {
    els.importHint.textContent = importConfig.hint;
    els.importResult.classList.add('hidden');
    els.importInput.value = '';
  }

  refresh();
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
    renderList();
  } catch (err) {
    console.error(err);
    toastError('Errore nel caricamento degli articoli.');
  } finally {
    els.skeleton.classList.add('hidden');
  }
}

function renderList() {
  els.listWrap.innerHTML = '';
  if (currentList.length === 0) {
    els.emptyState.classList.remove('hidden');
    return;
  }
  els.listWrap.classList.remove('hidden');

  for (const p of currentList) {
    const lowStock = p.quantita_disponibile < p.scorta_minima;
    const subtitleParts = [p.locazione, p.punto_utilizzo_standard, p.linea, p.macchina].filter(Boolean);
    const row = document.createElement('button');
    row.type = 'button';
    row.className =
      'w-full text-left card-plate rounded-xl px-4 py-3 flex items-center justify-between gap-3 hover:border-amber-500/40 transition-colors';
    row.innerHTML = `
      <div class="min-w-0">
        <p class="font-mono text-xs text-graphite-500 tracking-wide">${escapeHtml(p.codice_articolo)}</p>
        <p class="font-medium text-graphite-100 truncate">${escapeHtml(p.descrizione || p.codice_articolo)}</p>
        <p class="text-xs text-graphite-500 mt-0.5">${escapeHtml(subtitleParts.join(' · ') || '—')}</p>
      </div>
      <div class="shrink-0 text-right">
        <span class="inline-block px-2.5 py-1 rounded-full text-sm font-mono font-semibold ${
          lowStock ? 'bg-rose-500/15 text-rose-300' : 'bg-graphite-700 text-graphite-200'
        }">${p.quantita_disponibile}</span>
        ${lowStock ? '<p class="text-[10px] uppercase tracking-wide text-rose-400 mt-1">sotto scorta</p>' : ''}
      </div>
    `;
    if (isAdmin()) row.addEventListener('click', () => openModal(p));
    else row.disabled = true;
    els.listWrap.appendChild(row);
  }
}

function openModal(product = null) {
  editingId = product?.id || null;
  els.modalTitle.textContent = product ? 'Modifica articolo' : 'Nuovo articolo';
  els.deleteBtn.classList.toggle('hidden', !product);
  els.form.reset();
  stopBarcodeScan();

  els.categoriaSelect.value = product?.categoria || currentCategory;
  document.getElementById('product-codice-articolo').value = product?.codice_articolo || '';
  document.getElementById('product-descrizione').value = product?.descrizione || '';
  document.getElementById('product-linea').value = product?.linea || '';
  document.getElementById('product-macchina').value = product?.macchina || '';
  document.getElementById('product-punto-standard').value = product?.punto_utilizzo_standard || '';
  document.getElementById('product-locazione').value = product?.locazione || '';
  document.getElementById('product-quantita').value = product?.quantita_disponibile ?? 0;
  document.getElementById('product-scorta-minima').value = product?.scorta_minima ?? (currentCategory === 'cuscinetti' ? 5 : 0);
  document.getElementById('product-codice-barre').value = product?.codice_barre || '';

  updateLineaMacchinaVisibility();
  updateBarcodePreview();
  els.modal.classList.remove('hidden');
  requestAnimationFrame(() => els.modal.classList.add('modal-visible'));
}

function updateLineaMacchinaVisibility() {
  els.lineaMacchinaWrap.classList.toggle('hidden', els.categoriaSelect.value !== 'cinghie');
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
      lineColor: '#e8e6e1',
      fontOptions: 'bold',
      fontSize: 14,
      margin: 6,
    });
    els.barcodePreviewWrap.classList.remove('hidden');
  } catch (err) {
    els.barcodePreviewWrap.classList.add('hidden');
  }
}

/** Apre la fotocamera per acquisire il barcode già stampato sulla confezione (non ne genera uno nuovo) */
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

async function handleSubmit(e) {
  e.preventDefault();
  const payload = {
    categoria: els.categoriaSelect.value,
    codice_articolo: document.getElementById('product-codice-articolo').value.trim(),
    descrizione: document.getElementById('product-descrizione').value.trim() || null,
    linea: document.getElementById('product-linea').value.trim() || null,
    macchina: document.getElementById('product-macchina').value.trim() || null,
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
      await updateProduct(editingId, payload);
      toastSuccess('Articolo aggiornato.');
    } else {
      await createProduct(payload);
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
  if (!confirm('Eliminare definitivamente questo articolo? Lo storico transazioni resterà collegato.')) return;
  try {
    await deleteProduct(editingId);
    toastSuccess('Articolo eliminato.');
    closeModal();
    refresh();
  } catch (err) {
    console.error(err);
    toastError('Impossibile eliminare: verifica che non ci siano transazioni collegate.');
  }
}

/** Genera un PDF stampabile con l'etichetta a barcode dell'articolo corrente nel form */
function printCurrentLabel() {
  const codice = document.getElementById('product-codice-articolo').value.trim();
  const descrizione = document.getElementById('product-descrizione').value.trim();
  const barcode = document.getElementById('product-codice-barre').value.trim();
  if (!barcode) {
    toastError('Inserisci un codice a barre prima di stampare.');
    return;
  }

  const canvas = document.createElement('canvas');
  // eslint-disable-next-line no-undef
  JsBarcode(canvas, barcode, {
    format: 'CODE128',
    width: 2.4,
    height: 70,
    displayValue: true,
    fontSize: 16,
    margin: 4,
  });
  const imgData = canvas.toDataURL('image/png');

  // eslint-disable-next-line no-undef
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: [90, 50] });

  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(codice || '—', 5, 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(doc.splitTextToSize(descrizione || codice || '', 80), 5, 13);
  doc.addImage(imgData, 'PNG', 5, 20, 80, 24);

  doc.save(`etichetta_${codice || 'articolo'}.pdf`);
  toastSuccess('Etichetta PDF generata.');
}

// --- IMPORT EXCEL --------------------------------------------------

async function handleImportFileChange(e) {
  const file = e.target.files?.[0];
  e.target.value = ''; // permette di ricaricare lo stesso file una seconda volta
  if (!file) return;

  const config = CATEGORY_IMPORT_CONFIG[currentCategory];
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
      dataRows = rows.slice(1); // salta la riga di intestazione
    }

    const mapped = [];
    for (const r of dataRows) {
      const cells = (r || []).map((c) => (c === null || c === undefined ? '' : String(c).trim()));
      if (!cells[0]) continue; // salta righe senza codice articolo
      mapped.push(config.mapRow(cells));
    }

    if (!mapped.length) {
      showImportResult('Nessuna riga valida trovata nel file (colonna Codice vuota?).', 'error');
      return;
    }

    showImportResult(`Importazione di ${mapped.length} righe in corso…`, 'info');
    const result = await bulkUpsertProducts(currentCategory, mapped);
    showImportResult(
      `Importazione completata: ${result.totale} articoli (${result.inseriti} nuovi, ${result.aggiornati} aggiornati).`,
      'success'
    );
    toastSuccess(`${CATEGORY_LABELS[currentCategory]}: importazione completata.`);
    refresh();
  } catch (err) {
    console.error(err);
    showImportResult('Errore durante la lettura o l\'importazione del file. Verifica che sia un .xlsx valido con le colonne nell\'ordine corretto.', 'error');
  }
}

function showImportResult(message, type) {
  const styles = {
    info: 'bg-graphite-700/60 text-graphite-300',
    success: 'bg-emerald-500/15 text-emerald-300',
    error: 'bg-rose-500/15 text-rose-300',
  };
  els.importResult.textContent = message;
  els.importResult.className = `text-xs mt-2 rounded-lg px-3 py-2 ${styles[type] || styles.info}`;
  els.importResult.classList.remove('hidden');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
