// =============================================================
// manuals-browser.js — Vista "Manuali" (barra in basso, visibile a tutti:
// Admin e Operatore). Una card ad accordion per ogni macchina registrata,
// con i manuali PDF disponibili (Generale + linee) aperti nello stesso
// visualizzatore già usato altrove nell'app.
//
// Riusa deliberatamente lo stesso pattern shelf-card/shelf-header/
// shelf-chevron/shelf-body-track già presente in products.js (vista
// "Scaffalatura"), così l'apertura/chiusura delle card ha esattamente le
// stesse animazioni del resto dell'app invece di introdurne di nuove.
// =============================================================

import { listMachinesWithCounts } from './supabase.js';
import { refreshManualsCache, getManualsForMachine, openManualViewer } from './manuals.js';
import { staggerIndex } from './ui-utils.js';
import { toastError } from './toast.js';

// Stesse etichette/ordine usati in Impostazioni → Gestione macchine (machines.js).
const LINEA_SLOTS = [
  { value: '', label: 'Generale' },
  { value: 'L1', label: 'Linea 1' },
  { value: 'L2', label: 'Linea 2' },
  { value: 'L1-L2', label: 'Linea 1-2' },
];

const els = {};
let loaded = false; // dopo il primo caricamento, i rientri nella vista non mostrano più lo scheletro

export function initManualsBrowser() {
  els.skeleton = document.getElementById('manuals-browser-skeleton');
  els.list = document.getElementById('manuals-browser-list');
  els.empty = document.getElementById('manuals-browser-empty');
}

/** Richiamata da app.js ogni volta che si entra nella vista Manuali. */
export async function enterManualsBrowser() {
  if (!els.list) return;
  if (!loaded) {
    els.skeleton?.classList.remove('hidden');
    els.list.classList.add('hidden');
    els.empty?.classList.add('hidden');
  }
  try {
    const [{ machines }] = await Promise.all([listMachinesWithCounts(), refreshManualsCache()]);
    render(machines.filter((m) => m.id)); // solo le macchine registrate possono avere un manuale collegato
    loaded = true;
  } catch (err) {
    console.error(err);
    toastError('Impossibile caricare l\'elenco delle macchine.');
  } finally {
    els.skeleton?.classList.add('hidden');
  }
}

/** Si richiama al logout, così il prossimo accesso (magari di un altro utente) ricarica da capo. */
export function resetManualsBrowser() {
  loaded = false;
}

function render(machines) {
  els.list.innerHTML = '';
  if (machines.length === 0) {
    els.list.classList.add('hidden');
    els.empty?.classList.remove('hidden');
    return;
  }
  els.empty?.classList.add('hidden');

  machines.forEach((machine, i) => {
    const manuals = getManualsForMachine(machine.id); // Map<linea, riga machine_manuals>
    const count = manuals.size;

    const slotsHtml = LINEA_SLOTS.filter((slot) => manuals.has(slot.value))
      .map((slot) => {
        const manual = manuals.get(slot.value);
        return `
          <button type="button" data-linea="${slot.value}"
            class="shelf-item w-full text-left flex items-center gap-2.5 px-4 py-2.5 border-t border-graphite-700 first:border-t-0">
            <i data-lucide="file-text" class="w-4 h-4 shrink-0 text-graphite-500"></i>
            <span class="min-w-0 flex-1">
              <span class="block text-xs font-semibold text-graphite-400">${escapeHtml(slot.label)}</span>
              <span class="block text-sm text-graphite-100 truncate">${escapeHtml(manual.file_name)}</span>
            </span>
            <i data-lucide="chevron-right" class="w-4 h-4 shrink-0 text-graphite-500"></i>
          </button>
        `;
      })
      .join('');

    const card = document.createElement('div');
    card.className = 'list-item-in shelf-card card-plate rounded-xl';
    card.style.setProperty('--i', staggerIndex(i));
    card.innerHTML = `
      <div class="shelf-header flex items-center justify-between gap-3 px-4 py-3.5 border-2 border-graphite-700 rounded-xl${count ? '' : ' opacity-60'}">
        <div class="flex items-center gap-3 min-w-0">
          <span class="shrink-0 w-9 h-9 rounded-lg bg-graphite-700/50 flex items-center justify-center">
            <i data-lucide="cog" class="w-[18px] h-[18px] text-graphite-400" stroke-width="1.8"></i>
          </span>
          <div class="min-w-0">
            <p class="font-display font-bold uppercase tracking-wide truncate">${escapeHtml(machine.nome)}</p>
            <p class="ui-note text-graphite-500 mt-0.5">${
              count ? `${count} ${count === 1 ? 'manuale disponibile' : 'manuali disponibili'}` : 'nessun manuale caricato'
            }</p>
          </div>
        </div>
        ${count ? '<i data-lucide="chevron-down" class="shelf-chevron w-5 h-5 text-graphite-400 shrink-0" stroke-width="2"></i>' : ''}
      </div>
      ${count ? `<div class="shelf-body-track"><div class="shelf-body-inner">${slotsHtml}</div></div>` : ''}
    `;

    if (count) {
      card.querySelector('.shelf-header').addEventListener('click', () => {
        card.classList.toggle('shelf-open');
      });
      card.querySelectorAll('.shelf-item').forEach((btn) => {
        const manual = manuals.get(btn.dataset.linea);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openManualViewer(manual);
        });
      });
    }

    els.list.appendChild(card);
  });

  els.list.classList.remove('hidden');
  window.lucide?.createIcons();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
