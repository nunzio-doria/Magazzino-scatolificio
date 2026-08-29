// =============================================================
// products.js — Anagrafica articoli: CRUD, barcode e stampa etichette
// =============================================================

import { listProducts, createProduct, updateProduct, deleteProduct } from './supabase.js';
import { toastSuccess, toastError } from './toast.js';
import { isAdmin } from './auth.js';

const els = {};
let currentList = [];
let editingId = null;
let searchDebounce = null;

export function initProducts() {
  els.searchInput = document.getElementById('product-search-input');
  els.listWrap = document.getElementById('product-list');
  els.skeleton = document.getElementById('product-list-skeleton');
  els.emptyState = document.getElementById('product-empty-state');
  els.newBtn = document.getElementById('product-new-btn');
  els.lowStockToggle = document.getElementById('product-lowstock-toggle');

  // Modale form
  els.modal = document.getElementById('product-modal');
  els.form = document.getElementById('product-form');
  els.modalTitle = document.getElementById('product-modal-title');
  els.closeModalBtn = document.getElementById('product-modal-close');
  els.deleteBtn = document.getElementById('product-delete-btn');
  els.barcodePreviewWrap = document.getElementById('product-barcode-preview-wrap');
  els.barcodeSvg = document.getElementById('product-barcode-svg');
  els.printLabelBtn = document.getElementById('product-print-label-btn');

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

  // Anteprima barcode live mentre si digita il codice articolo/barcode
  document.getElementById('product-codice-barre').addEventListener('input', updateBarcodePreview);

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
    const row = document.createElement('button');
    row.type = 'button';
    row.className =
      'w-full text-left card-plate rounded-xl px-4 py-3 flex items-center justify-between gap-3 hover:border-amber-500/40 transition-colors';
    row.innerHTML = `
      <div class="min-w-0">
        <p class="font-mono text-xs text-graphite-500 tracking-wide">${escapeHtml(p.codice_articolo)}</p>
        <p class="font-medium text-graphite-100 truncate">${escapeHtml(p.descrizione)}</p>
        <p class="text-xs text-graphite-500 mt-0.5">${escapeHtml(p.locazione || '—')} · ${escapeHtml(p.punto_utilizzo_standard || '—')}</p>
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

  document.getElementById('product-codice-articolo').value = product?.codice_articolo || '';
  document.getElementById('product-descrizione').value = product?.descrizione || '';
  document.getElementById('product-punto-standard').value = product?.punto_utilizzo_standard || '';
  document.getElementById('product-locazione').value = product?.locazione || '';
  document.getElementById('product-quantita').value = product?.quantita_disponibile ?? 0;
  document.getElementById('product-scorta-minima').value = product?.scorta_minima ?? 0;
  document.getElementById('product-codice-barre').value = product?.codice_barre || product?.codice_articolo || '';

  updateBarcodePreview();
  els.modal.classList.remove('hidden');
  requestAnimationFrame(() => els.modal.classList.add('modal-visible'));
}

function closeModal() {
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

async function handleSubmit(e) {
  e.preventDefault();
  const payload = {
    codice_articolo: document.getElementById('product-codice-articolo').value.trim(),
    descrizione: document.getElementById('product-descrizione').value.trim(),
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
    refresh();
  } catch (err) {
    console.error(err);
    toastError(err.message?.includes('duplicate') ? 'Codice articolo o barcode già esistente.' : 'Errore nel salvataggio.');
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

  // Canvas temporaneo per generare l'immagine del barcode ad alta risoluzione
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
  const doc = new jsPDF({ unit: 'mm', format: [90, 50] }); // formato etichetta 90x50mm

  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(codice || '—', 5, 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(doc.splitTextToSize(descrizione || '', 80), 5, 13);

  const imgProps = { w: 80, h: 24 };
  doc.addImage(imgData, 'PNG', 5, 20, imgProps.w, imgProps.h);

  doc.save(`etichetta_${codice || 'articolo'}.pdf`);
  toastSuccess('Etichetta PDF generata.');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
