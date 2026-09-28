// =============================================================
// products.js — Magazzino: file principale/orchestratore. Inizializza i
// tre moduli (products-list.js, products-data.js, products-detail.js),
// e gestisce la barra di ricerca con il suo scanner — l'unica parte che
// non apparteneva chiaramente a nessuno dei tre.
// =============================================================

import { getProductByBarcode, getProductById } from './supabase.js';
import { refreshManualsCache } from './manuals.js';
import { toastError } from './toast.js';
import { startCamera, stopCamera } from './camera.js';
import feedback from './feedback.js';
import { els, state, CATEGORY_LABELS } from './products-shared.js';
import { initProductsList, setCategory, setListStatic } from './products-list.js';
import { initProductsData, refresh, enterProducts, resetProducts } from './products-data.js';
import { initProductsDetail, openDetail, stopBarcodeScan } from './products-detail.js';

export { CATEGORY_LABELS };
export { refresh, enterProducts, resetProducts };

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
  els.lowStockToggle = document.getElementById('product-lowstock-toggle');

  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(refresh, 280);
  });
  els.scanSearchBtn?.addEventListener('click', startSearchScan);
  els.searchScannerCloseBtn?.addEventListener('click', stopSearchScan);
  els.lowStockToggle.addEventListener('change', refresh);

  initProductsDetail();
  initProductsList();
  initProductsData();

  setCategory(state.currentCategory);
}

let searchDebounce = null;
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
    if (product.categoria && product.categoria !== state.currentCategory) setCategory(product.categoria);
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
