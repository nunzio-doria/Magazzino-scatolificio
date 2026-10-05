// =============================================================
// products-detail.js — Magazzino: scheda articolo di sola lettura e
// modulo di modifica/creazione. Codice spostato qui pari pari da
// products.js: stessa logica, stesso comportamento, solo riorganizzato
// in un file più piccolo.
// =============================================================

import { createProduct, updateProduct, deleteProduct, listDistinctMacchine, createMachine, listDistinctLocazioni, createShelf, getProductBarcodes, getProductLocations } from './supabase.js';
import { getManualForMachineName, openManualForMachineName, refreshManualsCache } from './manuals.js';
import { toastSuccess, toastError } from './toast.js';
import { isAdmin } from './auth.js';
import { startCamera, stopCamera, switchCamera as switchCameraShared, toggleTorch } from './camera.js';
import { attachFieldDropdown } from './picker.js';
import { loadIdlePanel } from './scanner.js';
import { confirmDialog } from './ui-modal.js';
import { enhanceSelect } from './ui-select.js';
import feedback from './feedback.js';
import { openOverlay, closeOverlay, enableSheetDrag, replayAnimation, setButtonBusy, loadLib } from './ui-utils.js';
import { els, state, CATEGORY_LABELS, LINEA_OPTIONS, escapeHtml } from './products-shared.js';
import { refresh, pushHistory } from './products-data.js';

let editingId = null;
let editingSnapshot = null; // riga completa del prodotto in modifica/eliminazione, per l'undo
let detailProduct = null; // articolo mostrato nella scheda di sola lettura
let returnToDetail = null; // se il modale di modifica è stato aperto dalla scheda, articolo a cui tornare annullando

export function initProductsDetail() {
  // Scheda articolo (sola lettura): si apre toccando un articolo
  els.detailModal = document.getElementById('product-detail-modal');
  els.detailCloseBtn = document.getElementById('product-detail-close');
  els.detailCategory = document.getElementById('product-detail-category');
  els.detailCode = document.getElementById('product-detail-code');
  els.detailLocazione = document.getElementById('product-detail-locazione');
  els.detailLocazioneLabel = document.getElementById('product-detail-locazione-label');
  els.detailQuantita = document.getElementById('product-detail-quantita');
  els.detailQuantitaLabel = document.getElementById('product-detail-quantita-label');
  els.detailLowStock = document.getElementById('product-detail-lowstock');
  els.detailRows = document.getElementById('product-detail-rows');
  els.detailManualBtn = document.getElementById('product-detail-manual-btn');
  els.detailDescrizioneWrap = document.getElementById('product-detail-descrizione-wrap');
  els.detailDescrizione = document.getElementById('product-detail-descrizione');
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
    const btn = e.target.closest('[data-action="print"]');
    if (btn) printLabelFor(btn.dataset.code || detailProduct?.codice_barre);
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
  els.shelvesRows = document.getElementById('product-shelves-rows');
  els.shelvesTotal = document.getElementById('product-shelves-total');
  els.shelfAddBtn = document.getElementById('product-shelf-add-btn');
  els.openManualBtn = document.getElementById('product-open-manual-btn');
  els.barcodePreviewWrap = document.getElementById('product-barcode-preview-wrap');
  els.barcodeSvg = document.getElementById('product-barcode-svg');
  els.printLabelBtn = document.getElementById('product-print-label-btn');
  els.generateBarcodeBtn = document.getElementById('product-generate-barcode-btn');
  els.barcodeMakerInput = document.getElementById('product-barcode-produttore');
  els.barcodesExtraRows = document.getElementById('product-barcodes-extra-rows');
  els.barcodeAddBtn = document.getElementById('product-barcode-add-btn');
  els.scanBarcodeBtn = document.getElementById('product-scan-barcode-btn');
  els.scanBarcodeStopBtn = document.getElementById('product-scan-barcode-stop');
  els.barcodeScannerWrap = document.getElementById('product-barcode-scanner-wrap');
  els.scanSwitchBtn = document.getElementById('product-scan-switch-btn');
  els.scanTorchBtn = document.getElementById('product-scan-torch-btn');

  els.newBtn = document.getElementById('product-new-btn');
  els.newBtn.addEventListener('click', () => openModal());
  els.closeModalBtn.addEventListener('click', () => closeModal());
  els.form.addEventListener('submit', handleSubmit);
  els.deleteBtn.addEventListener('click', handleDelete);
  els.printLabelBtn.addEventListener('click', printCurrentLabel);
  els.generateBarcodeBtn.addEventListener('click', generateBarcodeForCurrentArticle);
  els.categoriaSelect.addEventListener('change', updateLineaMacchinaVisibility);
  els.shelfAddBtn.addEventListener('click', () => addShelfRow({}, { focus: true }));
  els.openManualBtn?.addEventListener('click', () => {
    const codice = document.getElementById('product-codice-articolo').value.trim();
    const macchina = els.macchinaHidden.value;
    const linea = els.lineaHidden.value;
    if (!macchina) return;
    openManualForMachineName(macchina, linea, codice);
  });
  els.scanBarcodeBtn.addEventListener('click', () => startBarcodeScan(document.getElementById('product-codice-barre')));
  els.barcodeAddBtn.addEventListener('click', () => addBarcodeRow({}, { focus: true }));
  els.scanBarcodeStopBtn.addEventListener('click', stopBarcodeScan);
  els.scanSwitchBtn?.addEventListener('click', () =>
    switchCameraShared(handleBarcodeScanDetected, { switchBtnEl: els.scanSwitchBtn, torchBtnEl: els.scanTorchBtn })
  );
  els.scanTorchBtn?.addEventListener('click', () => toggleTorch(els.scanTorchBtn));
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

  document.getElementById('product-codice-barre').addEventListener('input', updateBarcodePreview);
  bindDetailBack();
}

/**
 * Un operatore (non admin) può aprire la scheda di un articolo per
 * consultarla, ma non modificarla: disabilita tutti i campi e nasconde i
 * pulsanti che scrivono sul database (salva, elimina). Il codice a barre
 * resta comunque visibile/stampabile — è una lettura, non una scrittura.
 */
function applyModalPermissions() {
  const readOnly = !isAdmin();
  ['product-codice-articolo', 'product-punto-standard', 'product-scorta-minima', 'product-codice-barre'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = readOnly;
  });
  els.categoriaSelectUI ? els.categoriaSelectUI.setDisabled(readOnly) : (els.categoriaSelect.disabled = readOnly);
  els.lineaBtn.disabled = readOnly;
  els.macchinaBtn.disabled = readOnly;
  els.shelfAddBtn.disabled = readOnly;
  els.shelfAddBtn.classList.toggle('hidden', readOnly);
  els.shelvesRows.querySelectorAll('button, input').forEach((el) => {
    el.disabled = readOnly;
  });
  els.scanBarcodeBtn.disabled = readOnly;
  els.barcodeMakerInput.disabled = readOnly;
  els.barcodeAddBtn.classList.toggle('hidden', readOnly);
  els.barcodesExtraRows.querySelectorAll('button, input').forEach((el) => {
    el.disabled = readOnly;
  });
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

  els.categoriaSelect.value = product?.categoria || state.currentCategory;
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
  renderShelfRows(product ? getProductLocations(product) : []);
  document.getElementById('product-scorta-minima').value = product?.scorta_minima ?? (state.currentCategory === 'cuscinetti' ? 5 : 0);
  document.getElementById('product-codice-barre').value = product?.codice_barre || '';
  els.barcodeMakerInput.value = product?.produttore_barcode || '';
  els.barcodesExtraRows.innerHTML = '';
  (product?.barcodes_extra || []).forEach((b) => addBarcodeRow({ codice: b.codice_barre, produttore: b.produttore || '' }));

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

// --- SCAFFALI DELL'ARTICOLO (modulo di modifica) -----------------------
// Una riga per scaffale: nome dello scaffale + quantità presente su quello scaffale.
// La giacenza totale dell'articolo è la somma delle righe (la calcola il database).

function shelfRowValue(row) {
  return row.querySelector('[data-role="shelf"]').value.trim();
}

/** Nomi di scaffale già scelti nelle altre righe (minuscoli), per non proporli due volte */
function usedShelfNames(exceptRow) {
  const used = new Set();
  els.shelvesRows.querySelectorAll('.shelf-edit-row').forEach((r) => {
    if (r === exceptRow) return;
    const v = shelfRowValue(r).toLowerCase();
    if (v) used.add(v);
  });
  return used;
}

function updateShelvesTotal() {
  const rows = [...els.shelvesRows.querySelectorAll('.shelf-edit-row')];
  const total = rows.reduce((sum, r) => sum + Math.max(0, parseInt(r.querySelector('[data-role="qty"]').value, 10) || 0), 0);
  els.shelvesTotal.textContent = rows.length > 1 ? `Totale: ${total}` : '';
}

function addShelfRow({ locazione = '', quantita = 0 } = {}, { focus = false } = {}) {
  const row = document.createElement('div');
  row.className = 'shelf-edit-row flex items-start gap-2';
  row.innerHTML = `
    <div class="flex-1 min-w-0">
      <button type="button" data-role="pick" class="w-full flex items-center justify-between rounded-lg bg-graphite-800 border border-graphite-700 px-3.5 py-2.5 text-sm text-left hover:border-amber-400 transition-colors min-h-[44px]">
        <span data-role="value" class="truncate text-graphite-400">Seleziona…</span>
        <i data-lucide="chevrons-up-down" class="w-4 h-4 text-graphite-400 shrink-0" stroke-width="2"></i>
      </button>
      <input type="hidden" data-role="shelf">
    </div>
    <input type="number" data-role="qty" min="0" step="1" inputmode="numeric" aria-label="Quantità su questo scaffale"
      class="w-20 shrink-0 rounded-lg bg-graphite-800 border border-graphite-700 px-2 py-2.5 font-mono text-sm text-center focus:border-amber-400 outline-none transition-colors min-h-[44px]">
    <button type="button" data-role="remove" aria-label="Togli questo scaffale" title="Togli questo scaffale"
      class="shrink-0 w-11 h-11 rounded-lg flex items-center justify-center text-rose-700 hover:bg-rose-50 transition-colors">
      <i data-lucide="trash-2" class="w-5 h-5" stroke-width="2"></i>
    </button>`;
  els.shelvesRows.appendChild(row);

  const hidden = row.querySelector('[data-role="shelf"]');
  const valueEl = row.querySelector('[data-role="value"]');
  const qtyInput = row.querySelector('[data-role="qty"]');
  setPickerValue(hidden, valueEl, locazione || '');
  qtyInput.value = quantita ?? 0;
  qtyInput.addEventListener('input', updateShelvesTotal);
  qtyInput.addEventListener('focus', () => qtyInput.select());

  attachFieldDropdown({
    triggerBtn: row.querySelector('[data-role="pick"]'),
    valueEl,
    hiddenInput: hidden,
    getOptions: async () => {
      try {
        const used = usedShelfNames(row);
        return (await listDistinctLocazioni()).filter((n) => !used.has(n.toLowerCase()));
      } catch (err) {
        console.warn('Impossibile caricare l\'elenco degli scaffali registrati.', err);
        return [];
      }
    },
    // Si può scrivere il nome di uno scaffale nuovo e aggiungerlo: viene registrato nella
    // tabella degli scaffali (solo admin, come tutto il form articolo) e selezionato.
    allowCustom: true,
    hideSearch: false,
    onCreate: async (nome) => {
      try {
        const shelf = await createShelf(nome);
        feedback.confirmAction();
        toastSuccess(`Scaffale "${shelf.nome}" aggiunto.`);
        return shelf.nome;
      } catch (err) {
        feedback.errorAction();
        toastError(err.message || 'Impossibile aggiungere lo scaffale.');
        return null;
      }
    },
  });

  row.querySelector('[data-role="remove"]').addEventListener('click', () => {
    if (els.shelvesRows.querySelectorAll('.shelf-edit-row').length > 1) {
      row.remove();
    } else {
      // Ultima riga: si svuota invece di sparire, il modulo ha sempre almeno un campo scaffale
      setPickerValue(hidden, valueEl, '');
      qtyInput.value = 0;
    }
    updateShelvesTotal();
  });

  window.lucide?.createIcons();
  updateShelvesTotal();
  if (focus) row.querySelector('[data-role="pick"]').click();
  return row;
}

/** Ridisegna le righe degli scaffali dell'articolo aperto (una riga vuota per un articolo nuovo) */
function renderShelfRows(locations) {
  els.shelvesRows.innerHTML = '';
  const list = locations && locations.length ? locations : [{ locazione: '', quantita: 0 }];
  list.forEach((l) => addShelfRow({ locazione: l.locazione || '', quantita: l.quantita }));
}

/**
 * Scaffali inseriti nel modulo, pronti per il salvataggio. Le righe completamente vuote
 * (nessuno scaffale e quantità 0) si ignorano. Restituisce { error } se uno scaffale è ripetuto.
 */
function collectShelfRows() {
  const seen = new Set();
  const locations = [];
  for (const r of els.shelvesRows.querySelectorAll('.shelf-edit-row')) {
    const locazione = shelfRowValue(r) || null;
    const quantita = Math.max(0, parseInt(r.querySelector('[data-role="qty"]').value, 10) || 0);
    if (!locazione && quantita === 0) continue;
    const key = (locazione || '').toLowerCase();
    if (seen.has(key)) {
      return { error: locazione ? `Lo scaffale "${locazione}" è inserito due volte: unisci le quantità in una sola riga.` : 'Hai due righe senza scaffale: unisci le quantità in una sola riga.' };
    }
    seen.add(key);
    locations.push({ locazione, quantita });
  }
  return { locations };
}

/** Riga di un codice a barre aggiuntivo: codice, scansione, rimozione e produttore (facoltativo) */
function addBarcodeRow({ codice = '', produttore = '' } = {}, { focus = false } = {}) {
  const row = document.createElement('div');
  row.className = 'barcode-edit-row rounded-lg border border-graphite-700 p-2 space-y-2';
  row.innerHTML = `
    <div class="flex gap-2">
      <input type="text" data-role="code" autocomplete="off" placeholder="Altro codice a barre" aria-label="Altro codice a barre"
        class="flex-1 min-w-0 rounded-lg bg-graphite-800 border border-graphite-700 px-3.5 py-2.5 font-mono text-sm focus:border-amber-400 outline-none transition-colors min-h-[44px]">
      <button type="button" data-role="scan" aria-label="Scansiona codice a barre" title="Scansiona"
        class="camera-only shrink-0 w-11 h-11 rounded-lg bg-graphite-800 border border-graphite-700 hover:border-amber-400 text-graphite-300 hover:text-amber-400 flex items-center justify-center transition-colors">
        <i data-lucide="scan-barcode" class="w-5 h-5" stroke-width="1.6"></i>
      </button>
      <button type="button" data-role="remove" aria-label="Togli questo codice a barre" title="Togli questo codice a barre"
        class="shrink-0 w-11 h-11 rounded-lg flex items-center justify-center text-rose-700 hover:bg-rose-50 transition-colors">
        <i data-lucide="trash-2" class="w-5 h-5" stroke-width="2"></i>
      </button>
    </div>
    <input type="text" data-role="maker" maxlength="80" autocomplete="off" placeholder="Produttore (facoltativo)" aria-label="Produttore di questo codice"
      class="w-full rounded-lg bg-graphite-800 border border-graphite-700 px-3.5 py-2.5 text-sm focus:border-amber-400 outline-none transition-colors min-h-[44px]">`;
  els.barcodesExtraRows.appendChild(row);
  const codeInput = row.querySelector('[data-role="code"]');
  codeInput.value = codice;
  row.querySelector('[data-role="maker"]').value = produttore;
  row.querySelector('[data-role="scan"]').addEventListener('click', () => startBarcodeScan(codeInput));
  row.querySelector('[data-role="remove"]').addEventListener('click', () => row.remove());
  window.lucide?.createIcons();
  if (focus) codeInput.focus();
  return row;
}

/**
 * Codici a barre inseriti nel modulo: il principale (con il suo produttore) e gli altri. Le righe senza
 * codice si ignorano; un codice ripetuto si segnala. Restituisce { error } oppure { barcodes }.
 */
function collectBarcodes() {
  const primary = document.getElementById('product-codice-barre').value.trim();
  const primaryMaker = els.barcodeMakerInput.value.trim();
  const seen = new Set(primary ? [primary.toLowerCase()] : []);
  const extras = [];
  for (const r of els.barcodesExtraRows.querySelectorAll('.barcode-edit-row')) {
    const codice = r.querySelector('[data-role="code"]').value.trim();
    if (!codice) continue;
    if (seen.has(codice.toLowerCase())) return { error: `Il codice a barre "${codice}" è inserito due volte.` };
    seen.add(codice.toLowerCase());
    extras.push({ codice_barre: codice, produttore: r.querySelector('[data-role="maker"]').value.trim() || null });
  }
  if (!primary && extras.length) {
    // Il primo dei codici aggiuntivi diventa il principale, se quello principale è vuoto
    const [first, ...rest] = extras;
    return { barcodes: { primary: first.codice_barre, primaryMaker: first.produttore, extras: rest } };
  }
  return { barcodes: { primary: primary || null, primaryMaker: primaryMaker || null, extras } };
}

function updateLineaMacchinaVisibility() {
  const categoria = els.categoriaSelect.value;
  els.lineaMacchinaWrap.classList.toggle('hidden', categoria !== 'cinghie' && categoria !== 'pezzi_ricambio');
  updateGenerateBarcodeVisibility();
  updateManualButtonVisibility();
  updatePuntoStandardField(categoria);
}

/**
 * Per i Ricambi tecnici il campo "Punto utilizzo standard" diventa "Descrizione":
 * stesso campo del database (punto_utilizzo_standard), ma spostato subito sotto il
 * codice articolo e a piena larghezza, come richiesto per quella categoria. Per le
 * altre categorie resta "Punto utilizzo standard", sopra agli scaffali.
 */
function updatePuntoStandardField(categoria) {
  const topSlot = document.getElementById('product-punto-standard-top-slot');
  const wrap = document.getElementById('product-punto-standard-wrap');
  const label = document.getElementById('product-punto-standard-label');
  const input = document.getElementById('product-punto-standard');
  const locazioneRow = document.getElementById('product-locazione-row');
  if (!topSlot || !wrap || !label || !input || !locazioneRow) return;

  if (categoria === 'pezzi_ricambio') {
    label.textContent = 'Descrizione';
    input.placeholder = 'es. Guarnizione pompa dosatrice';
    topSlot.appendChild(wrap);
    locazioneRow.classList.add('hidden'); // la riga resterebbe vuota
  } else {
    label.textContent = 'Punto utilizzo standard';
    input.placeholder = 'es. Linea 2';
    locazioneRow.insertBefore(wrap, locazioneRow.firstChild);
    locazioneRow.classList.remove('hidden');
  }
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

/** Categorie senza un codice a barre fisico sulla confezione: per queste si può generare il barcode */
const BARCODE_GENERATABLE_CATEGORIES = ['cinghie', 'pezzi_ricambio'];

/** Il pulsante "genera barcode" ha senso solo per cinghie e ricambi tecnici (i cuscinetti hanno il codice stampato) */
function updateGenerateBarcodeVisibility() {
  els.generateBarcodeBtn.classList.toggle('hidden', !BARCODE_GENERATABLE_CATEGORIES.includes(els.categoriaSelect.value));
}

function setPickerValue(hiddenInput, labelEl, value) {
  hiddenInput.value = value;
  labelEl.textContent = value || 'Seleziona…';
  labelEl.classList.toggle('text-graphite-400', !value);
  labelEl.classList.toggle('text-graphite-100', !!value);
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

export function openDetail(product) {
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

function bindDetailBack() {
  els.modal?.addEventListener('overlay-back', (e) => {
    e.preventDefault();
    closeModal();
  });
  els.detailModal?.addEventListener('overlay-back', (e) => {
    e.preventDefault();
    closeDetail();
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

  // Tutte le locazioni dell'articolo: una riga per scaffale, con la quantità di ciascuno se sono più di una
  const locs = getProductLocations(p);
  const multiple = locs.length > 1;
  if (multiple) {
    els.detailLocazione.innerHTML = locs
      .map(
        (l) => `
        <div class="flex items-center justify-between gap-2">
          <span class="min-w-0 break-words${l.locazione ? '' : ' text-graphite-400'}">${escapeHtml(l.locazione || 'Senza scaffale')}</span>
          <span class="shrink-0 inline-block px-2 py-0.5 rounded-full bg-graphite-700 text-graphite-200 font-mono text-sm font-bold">${l.quantita}</span>
        </div>`
      )
      .join('');
  } else {
    const locazione = (locs[0]?.locazione || '').trim();
    els.detailLocazione.innerHTML = `<p class="${locazione ? '' : 'text-graphite-400'}">${escapeHtml(locazione || '—')}</p>`;
  }
  els.detailLocazioneLabel.textContent = multiple ? 'Locazioni magazzino' : 'Locazione magazzino';
  els.detailQuantitaLabel.textContent = multiple ? 'Quantità totale' : 'Quantità disponibile';

  const qty = p.quantita_disponibile ?? 0;
  const lowStock = qty < (p.scorta_minima ?? 0); // la scorta minima non si mostra, si segnala solo se si è sotto
  els.detailQuantita.textContent = qty;
  els.detailQuantita.className = `inline-block px-3 py-0.5 rounded-full font-mono font-bold text-xl ${
    lowStock ? 'bg-rose-500/15 text-rose-700' : 'bg-graphite-700 text-graphite-200'
  }`;
  els.detailLowStock.classList.toggle('hidden', !lowStock);

  // Descrizione: solo per i Ricambi tecnici, box dedicato subito sotto la testata
  const isRicambi = p.categoria === 'pezzi_ricambio';
  const descrizione = (p.punto_utilizzo_standard || '').trim();
  els.detailDescrizioneWrap.classList.toggle('hidden', !isRicambi);
  els.detailDescrizione.textContent = descrizione || '—';
  els.detailDescrizione.classList.toggle('text-graphite-400', !descrizione);

  const hasMachine = p.categoria === 'cinghie' || p.categoria === 'pezzi_ricambio';
  const rows = [];
  if (hasMachine) {
    rows.push({ label: 'Linea', value: p.linea });
    rows.push({ label: 'Macchina', value: p.macchina });
  }
  if (!isRicambi && (hasMachine || (p.punto_utilizzo_standard || '').trim())) {
    rows.push({ label: 'Punto utilizzo standard', value: p.punto_utilizzo_standard });
  }
  const codes = getProductBarcodes(p);
  if (codes.length) {
    codes.forEach((b, i) =>
      rows.push({ label: i === 0 ? 'Codice a barre' : 'Altro codice', value: b.codice_barre, maker: b.produttore, mono: true, print: true, code: b.codice_barre })
    );
  } else {
    rows.push({ label: 'Codice a barre', value: '', mono: true });
  }

  els.detailRows.innerHTML = rows
    .map(
      (r) => `
      <div class="detail-row${r.print ? ' detail-row--center' : ''}">
        <dt class="detail-row-label">${escapeHtml(r.label)}</dt>
        <dd class="m-0 min-w-0 flex items-center justify-end gap-2">
          ${
            r.maker
              ? `<div class="min-w-0 text-right">${detailValueHtml(r.value, { mono: r.mono })}<span class="ui-note text-graphite-500 block truncate">${escapeHtml(r.maker)}</span></div>`
              : detailValueHtml(r.value, { mono: r.mono })
          }
          ${
            r.print
              ? `<button type="button" data-action="print" data-code="${escapeHtml(r.code || '')}" aria-label="Stampa etichetta PDF" title="Stampa etichetta PDF"
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

let scanTargetInput = null; // campo del codice a barre in cui finisce la lettura (principale o una riga aggiuntiva)

function handleBarcodeScanDetected(code) {
  const target = scanTargetInput || document.getElementById('product-codice-barre');
  target.value = code;
  if (target.id === 'product-codice-barre') updateBarcodePreview();
  stopBarcodeScan();
  feedback.scanFound();
  toastSuccess(`Codice a barre acquisito: ${code}`);
}

/** Apre la fotocamera per acquisire il barcode già stampato sulla confezione (cuscinetti) */
async function startBarcodeScan(targetInput = null) {
  scanTargetInput = targetInput instanceof HTMLElement ? targetInput : null;
  els.barcodeScannerWrap.classList.remove('hidden');
  els.barcodeScannerWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const started = await startCamera('product-barcode-scanner-reader', handleBarcodeScanDetected, {
    switchBtnEl: els.scanSwitchBtn,
    torchBtnEl: els.scanTorchBtn,
    errorHint: 'Inserisci il codice a mano.',
  });
  if (started === false) els.barcodeScannerWrap.classList.add('hidden');
}

export function stopBarcodeScan() {
  scanTargetInput = null;
  stopCamera();
  els.barcodeScannerWrap.classList.add('hidden');
  els.scanSwitchBtn?.classList.add('hidden');
  els.scanTorchBtn?.classList.add('hidden');
}

/**
 * Genera un codice a barre deterministico per articoli senza un barcode fisico
 * (cinghie e ricambi tecnici): stesso prefisso di categoria + codice articolo, quindi è stabile
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
  const shelves = collectShelfRows();
  if (shelves.error) {
    feedback.errorAction();
    toastError(shelves.error);
    return;
  }
  const codes = collectBarcodes();
  if (codes.error) {
    feedback.errorAction();
    toastError(codes.error);
    return;
  }
  const payload = {
    categoria: els.categoriaSelect.value,
    codice_articolo: document.getElementById('product-codice-articolo').value.trim(),
    linea: els.lineaHidden.value || null,
    macchina: els.macchinaHidden.value || null,
    punto_utilizzo_standard: document.getElementById('product-punto-standard').value.trim() || null,
    scorta_minima: parseInt(document.getElementById('product-scorta-minima').value, 10) || 0,
  };

  const submitBtn = els.form.querySelector('button[type="submit"]');
  setButtonBusy(submitBtn, true, 'Salvataggio…');
  try {
    if (editingId) {
      const before = editingSnapshot;
      const after = await updateProduct(editingId, payload, shelves.locations, codes.barcodes);
      pushHistory({ type: 'update', before, after });
      feedback.confirmAction();
      toastSuccess('Articolo aggiornato.');
    } else {
      const after = await createProduct(payload, shelves.locations, codes.barcodes);
      pushHistory({ type: 'create', before: null, after });
      feedback.confirmAction();
      toastSuccess('Articolo creato.');
    }
    closeModal({ backToDetail: false });
    if (payload.categoria === state.currentCategory) refresh();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    const msg = err.message || '';
    toastError(
      msg.includes('già assegnato') || msg.includes('inserito due volte')
        ? msg
        : msg.includes('duplicate')
          ? 'Codice articolo già esistente in questa categoria, oppure barcode già usato.'
          : 'Errore nel salvataggio.'
    );
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

/** Genera un PDF stampabile con SOLO il barcode e il suo numero sotto (nessun testo aggiuntivo) */
function printCurrentLabel() {
  printLabelFor(document.getElementById('product-codice-barre').value.trim());
}

/** Stessa etichetta, per un barcode qualsiasi (usata sia dal modale di modifica sia dalla scheda articolo) */
async function printLabelFor(barcode) {
  barcode = (barcode || '').trim();
  if (!barcode) {
    feedback.errorAction();
    toastError('Inserisci o genera un codice a barre prima di stampare.');
    return;
  }

  try {
    await loadLib('jspdf'); // libreria PDF: caricata solo alla prima stampa
  } catch (err) {
    feedback.errorAction();
    toastError(err.message || 'Impossibile caricare la libreria PDF.');
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
