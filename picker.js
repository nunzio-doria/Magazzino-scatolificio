// =============================================================
// picker.js — Modale di selezione personalizzato (combobox "vera")
// Sostituisce select/datalist nativi, inaffidabili su mobile.
// Uso: const valore = await openPicker({ title, options, allowCustom, currentValue });
// Ritorna la stringa scelta, '' se l'utente svuota la selezione, o null se annulla.
// =============================================================

import { openOverlay, closeOverlay, enableSheetDrag } from './ui-utils.js';

const els = {};
let resolveFn = null;
let allOptions = [];
let allowCustomValue = false;

export function initPicker() {
  els.modal = document.getElementById('field-picker-modal');
  enableSheetDrag(els.modal.querySelector('.modal-panel'), () => closePicker(null));
  els.title = document.getElementById('field-picker-title');
  els.closeBtn = document.getElementById('field-picker-close');
  els.searchWrap = document.getElementById('field-picker-search-wrap');
  els.search = document.getElementById('field-picker-search');
  els.list = document.getElementById('field-picker-list');
  els.clearBtn = document.getElementById('field-picker-clear');

  els.closeBtn.addEventListener('click', () => closePicker(null));
  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal) closePicker(null);
  });
  // Chiusura forzata (es. disconnessione): la Promise si risolve come "annullato"
  els.modal.addEventListener('overlay-cancel', () => closePicker(null));
  els.search.addEventListener('input', () => renderList(els.search.value));
  els.clearBtn.addEventListener('click', () => closePicker(''));
}

/**
 * Apre il picker e risolve una Promise con il valore scelto.
 * @param {{title:string, options:string[], allowCustom?:boolean, currentValue?:string}} opts
 * @returns {Promise<string|null>} valore selezionato, '' se svuotato, null se annullato
 */
export function openPicker({ title, options, allowCustom = false, currentValue = '' }) {
  return new Promise((resolve) => {
    resolveFn = resolve;
    allOptions = [...new Set(options.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'it'));
    allowCustomValue = allowCustom;

    els.title.textContent = title;
    els.searchWrap.classList.toggle('hidden', !allowCustom && allOptions.length <= 6);
    els.search.value = '';
    els.search.removeAttribute('placeholder'); // nessun placeholder, come richiesto

    renderList('', currentValue);
    // Niente autofocus: la tastiera deve restare chiusa finché l'utente
    // non tocca esplicitamente il campo di ricerca.
    openOverlay(els.modal);
  });
}

function renderList(filterText, currentValue) {
  const term = (filterText || '').trim().toLowerCase();
  const filtered = term ? allOptions.filter((o) => o.toLowerCase().includes(term)) : allOptions;

  els.list.innerHTML = '';

  if (!filtered.length && !term) {
    els.list.innerHTML = '<p class="text-center text-sm text-graphite-500 py-6">Nessun valore ancora registrato.</p>';
  }

  for (const opt of filtered) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className =
      'w-full text-left px-4 py-3 rounded-lg hover:bg-graphite-700/50 transition-colors flex items-center justify-between gap-2';
    row.innerHTML = `<span class="text-graphite-100">${escapeHtml(opt)}</span>${
      opt === currentValue
        ? '<i data-lucide="check" class="w-4 h-4 text-amber-400 shrink-0" stroke-width="2.5"></i>'
        : ''
    }`;
    row.addEventListener('click', () => closePicker(opt));
    els.list.appendChild(row);
  }

  // Se è permesso un valore libero e il testo digitato non corrisponde a nessuna opzione esistente,
  // offre la possibilità di aggiungerlo come nuovo valore.
  if (allowCustomValue && term && !allOptions.some((o) => o.toLowerCase() === term)) {
    const addRow = document.createElement('button');
    addRow.type = 'button';
    addRow.className =
      'w-full text-left px-4 py-3 rounded-lg hover:bg-amber-400/10 transition-colors flex items-center gap-2 text-amber-400 font-medium mt-1 border-t border-graphite-700';
    addRow.innerHTML = `
      <i data-lucide="plus" class="w-4 h-4 shrink-0" stroke-width="2.5"></i>
      <span>Aggiungi "${escapeHtml(filterText.trim())}"</span>
    `;
    addRow.addEventListener('click', () => closePicker(filterText.trim()));
    els.list.appendChild(addRow);
  }

  window.lucide?.createIcons();
}

function closePicker(value) {
  closeOverlay(els.modal);
  const resolve = resolveFn;
  resolveFn = null;
  resolve?.(value);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =============================================================
// attachFieldDropdown — tendina inline agganciata a un campo (Linea,
// Macchina nel form "Nuovo/Modifica articolo"), invece del modale a
// tutto schermo di openPicker(). Usa la stessa tecnica grid-template-rows
// e le stesse classi .custom-select-* già usate per i <select> nativi
// (ui-select.js): "si abbassa" sotto al campo, non copre il modale già
// aperto con un secondo modale in sovraimpressione.
//
// A differenza di enhanceSelect() le opzioni non vengono da un <select>:
// possono essere una lista statica o una funzione (anche async) per
// caricarle al volo, ed è possibile permettere un valore libero digitato
// (allowCustom) — esattamente come faceva openPicker().
// =============================================================

/**
 * @param {Object} opts
 * @param {HTMLButtonElement} opts.triggerBtn - il bottone che mostra il valore corrente
 * @param {HTMLElement} opts.valueEl - lo <span> dentro il bottone con il testo del valore
 * @param {HTMLInputElement} opts.hiddenInput - l'hidden input con il valore reale del form
 * @param {string[] | (() => (string[]|Promise<string[]>))} opts.getOptions - opzioni statiche, o funzione (anche async) che le carica
 * @param {boolean} [opts.allowCustom] - se true, permette di digitare e aggiungere un valore non in elenco
 * @param {(value: string) => void} [opts.onChange] - richiamata quando l'utente sceglie/svuota un valore
 */
export function attachFieldDropdown({ triggerBtn, valueEl, hiddenInput, getOptions, allowCustom = false, hideSearch = false, onChange }) {
  if (!triggerBtn || triggerBtn.dataset.fieldDropdown === 'true') return;
  triggerBtn.dataset.fieldDropdown = 'true';
  triggerBtn.classList.add('custom-select-trigger');

  const anchor = triggerBtn.parentElement;
  anchor.classList.add('custom-select');

  const panelTrack = document.createElement('div');
  panelTrack.className = 'custom-select-panel-track';
  const panelInner = document.createElement('div');
  panelInner.className = 'custom-select-panel-inner card-plate rounded-lg border border-graphite-700';
  const scrollArea = document.createElement('div');
  scrollArea.className = 'max-h-60 overflow-y-auto';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'p-2 border-b border-graphite-700 sticky top-0 bg-graphite-800';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = allowCustom ? 'Cerca o digita per aggiungere…' : 'Cerca…';
  searchInput.autocomplete = 'off';
  searchInput.className =
    'w-full rounded-md bg-graphite-900 border border-graphite-700 px-3 py-2 text-sm focus:border-amber-400 outline-none transition-colors';
  searchWrap.appendChild(searchInput);

  const listEl = document.createElement('div');
  listEl.className = 'p-1';

  scrollArea.appendChild(searchWrap);
  scrollArea.appendChild(listEl);
  panelInner.appendChild(scrollArea);
  panelTrack.appendChild(panelInner);
  anchor.appendChild(panelTrack);

  let open = false;
  let loading = false;
  let allOptions = [];

  function currentValue() {
    return hiddenInput.value || '';
  }

  async function loadOptions() {
    if (typeof getOptions !== 'function') {
      allOptions = [...new Set((getOptions || []).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'it'));
      return;
    }
    loading = true;
    renderList(searchInput.value);
    try {
      const result = await getOptions();
      allOptions = [...new Set((result || []).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'it'));
    } catch (err) {
      console.warn('Impossibile caricare le opzioni per questo campo.', err);
      allOptions = [];
    }
    loading = false;
  }

  function renderList(filterText) {
    const term = (filterText || '').trim().toLowerCase();
    const filtered = term ? allOptions.filter((o) => o.toLowerCase().includes(term)) : allOptions;

    listEl.innerHTML = '';
    searchWrap.classList.toggle('hidden', hideSearch || (!allowCustom && !loading && allOptions.length <= 6));

    if (loading) {
      listEl.innerHTML = '<p class="text-center text-xs text-graphite-500 py-4">Caricamento…</p>';
      return;
    }
    if (!filtered.length && !term) {
      listEl.innerHTML = '<p class="text-center text-xs text-graphite-500 py-4">Nessun valore ancora registrato.</p>';
    }

    filtered.forEach((opt) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'custom-select-option w-full text-left px-3.5 py-2.5 text-sm rounded-md flex items-center justify-between gap-2';
      row.innerHTML = `<span class="truncate">${escapeHtml(opt)}</span>${
        opt === currentValue() ? '<i data-lucide="check" class="w-4 h-4 text-amber-400 shrink-0" stroke-width="2.5"></i>' : ''
      }`;
      row.addEventListener('click', () => selectValue(opt));
      listEl.appendChild(row);
    });

    if (allowCustom && term && !allOptions.some((o) => o.toLowerCase() === term)) {
      const addRow = document.createElement('button');
      addRow.type = 'button';
      addRow.className =
        'w-full text-left px-3.5 py-2.5 text-sm rounded-md flex items-center gap-2 text-amber-400 font-medium mt-1 border-t border-graphite-700 hover:bg-amber-400/10 transition-colors';
      addRow.innerHTML = `<i data-lucide="plus" class="w-4 h-4 shrink-0" stroke-width="2.5"></i><span>Aggiungi "${escapeHtml(
        filterText.trim()
      )}"</span>`;
      addRow.addEventListener('click', () => selectValue(filterText.trim()));
      listEl.appendChild(addRow);
    }

    window.lucide?.createIcons();
  }

  function selectValue(value) {
    hiddenInput.value = value;
    valueEl.textContent = value || 'Seleziona…';
    valueEl.classList.toggle('text-graphite-400', !value);
    valueEl.classList.toggle('text-graphite-100', !!value);
    onChange?.(value);
    closePanel();
  }

  async function openPanel() {
    if (open) return;
    open = true;
    anchor.classList.add('custom-select-open');
    searchInput.value = '';
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    await loadOptions();
    renderList('');
  }
  function closePanel() {
    if (!open) return;
    open = false;
    anchor.classList.remove('custom-select-open');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }
  function onDocClick(e) {
    if (!anchor.contains(e.target)) closePanel();
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') closePanel();
  }

  triggerBtn.addEventListener('click', () => (open ? closePanel() : openPanel()));
  searchInput.addEventListener('input', () => renderList(searchInput.value));

  return { close: closePanel };
}
