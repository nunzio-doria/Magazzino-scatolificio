// =============================================================
// products-detail.js — Magazzino: scheda articolo di sola lettura e
// modulo di modifica/creazione. Codice spostato qui pari pari da
// products.js: stessa logica, stesso comportamento, solo riorganizzato
// in un file più piccolo.
// =============================================================

import { createProduct, updateProduct, deleteProduct, listDistinctMacchine, createMachine, listDistinctLocazioni, createShelf } from './supabase.js';
import { getManualForMachineName, openManualForMachineName, refreshManualsCache } from './manuals.js';
import { toastSuccess, toastError } from './toast.js';
import { isAdmin } from './auth.js';
import { startCamera, stopCamera, switchCamera as switchCameraShared, toggleTorch } from './camera.js';
import { attachFieldDropdown } from './picker.js';
import { loadIdlePanel } from './scanner.js';
import { confirmDialog } from './ui-modal.js';
import { enhanceSelect } from './ui-select.js';
import feedback from './feedback.js';
import { openOverlay, closeOverlay, enableSheetDrag, replayAnimation, setButtonBusy } from './ui-utils.js';
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
  els.detailQuantita = document.getElementById('product-detail-quantita');
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
  els.locazioneBtn = document.getElementById('product-locazione-btn');
  els.locazioneValue = document.getElementById('product-locazione-value');
  els.locazioneHidden = document.getElementById('product-locazione');
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

  els.newBtn = document.getElementById('product-new-btn');
  els.newBtn.addEventListener('click', () => openModal());
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
  attachFieldDropdown({
    triggerBtn: els.lineaBtn,
    valueEl: els.lineaValue,
    hiddenInput: els.lineaHidden,
    getOptions: LINEA_OPTIONS,
    allowCustom: false,
    onChange: updateManualButtonVisibility,
  });
  attachFieldDropdown({
    triggerBtn: els.locazioneBtn,
    valueEl: els.locazioneValue,
    hiddenInput: els.locazioneHidden,
    getOptions: async () => {
      try {
        return await listDistinctLocazioni();
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
        const row = await createShelf(nome);
        feedback.confirmAction();
        toastSuccess(`Scaffale "${row.nome}" aggiunto.`);
        return row.nome;
      } catch (err) {
        feedback.errorAction();
        toastError(err.message || 'Impossibile aggiungere lo scaffale.');
        return null;
      }
    },
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
  ['product-codice-articolo', 'product-punto-standard', 'product-quantita', 'product-scorta-minima', 'product-codice-barre'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = readOnly;
  });
  els.categoriaSelectUI ? els.categoriaSelectUI.setDisabled(readOnly) : (els.categoriaSelect.disabled = readOnly);
  els.lineaBtn.disabled = readOnly;
  els.macchinaBtn.disabled = readOnly;
  els.locazioneBtn.disabled = readOnly;
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
  els.locazioneHidden.value = product?.locazione || '';
  els.locazioneValue.textContent = product?.locazione || 'Seleziona…';
  els.locazioneValue.classList.toggle('text-graphite-400', !product?.locazione);
  els.locazioneValue.classList.toggle('text-graphite-100', !!product?.locazione);
  document.getElementById('product-quantita').value = product?.quantita_disponibile ?? 0;
  document.getElementById('product-scorta-minima').value = product?.scorta_minima ?? (state.currentCategory === 'cuscinetti' ? 5 : 0);
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
  updatePuntoStandardField(categoria);
}

/**
 * Per i Ricambi tecnici il campo "Punto utilizzo standard" diventa "Descrizione":
 * stesso campo del database (punto_utilizzo_standard), ma spostato subito sotto il
 * codice articolo e a piena larghezza, come richiesto per quella categoria. Per le
 * altre categorie resta "Punto utilizzo standard", appaiato alla Locazione magazzino.
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
    locazioneRow.classList.remove('grid-cols-2');
    locazioneRow.classList.add('grid-cols-1');
  } else {
    label.textContent = 'Punto utilizzo standard';
    input.placeholder = 'es. Linea 2';
    locazioneRow.classList.remove('grid-cols-1');
    locazioneRow.classList.add('grid-cols-2');
    locazioneRow.insertBefore(wrap, locazioneRow.firstChild);
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

export function stopBarcodeScan() {
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
    locazione: els.locazioneHidden.value || null,
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
    if (payload.categoria === state.currentCategory) refresh();
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
