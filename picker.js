// =============================================================
// picker.js — Modale di selezione personalizzato (combobox "vera")
// Sostituisce select/datalist nativi, inaffidabili su mobile.
// Uso: const valore = await openPicker({ title, options, allowCustom, currentValue });
// Ritorna la stringa scelta, '' se l'utente svuota la selezione, o null se annulla.
// =============================================================

import { lockBodyScroll, unlockBodyScroll } from './ui-utils.js';

const els = {};
let resolveFn = null;
let allOptions = [];
let allowCustomValue = false;

export function initPicker() {
  els.modal = document.getElementById('field-picker-modal');
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
    els.modal.classList.remove('hidden');
    lockBodyScroll();
    requestAnimationFrame(() => {
      els.modal.classList.add('modal-visible');
      // Niente autofocus: la tastiera deve restare chiusa finché l'utente
      // non tocca esplicitamente il campo di ricerca.
    });
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
  els.modal.classList.remove('modal-visible');
  unlockBodyScroll();
  setTimeout(() => els.modal.classList.add('hidden'), 180);
  const resolve = resolveFn;
  resolveFn = null;
  resolve?.(value);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
