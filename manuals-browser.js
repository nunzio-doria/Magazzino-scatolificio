// =============================================================
// manuals-browser.js — Vista "Manuali" (barra in basso, visibile a tutti:
// Admin e Operatore). Una card ad accordion per ogni macchina registrata:
// aperta, mostra tanti tab cliccabili quanti sono i manuali OPERATORE
// assegnati alla macchina (uso e manutenzione, sicurezza, ecc. — quelli
// caricati in Impostazioni → Gestione macchine), più un pulsante "SPARE
// PARTS" in basso a destra per aprire il manuale ricambi della macchina
// (quello già esistente, cercabile per codice dalla scheda articolo).
//
// Riusa deliberatamente lo stesso pattern shelf-card/shelf-header/
// shelf-chevron/shelf-body-track già presente in products.js (vista
// "Scaffalatura"), così l'apertura/chiusura delle card ha esattamente le
// stesse animazioni del resto dell'app invece di introdurne di nuove.
// =============================================================

import { listMachinesWithCounts } from './supabase.js';
import { refreshManualsCache, getOperatorManualsForMachine, getAnyManualForMachine, openManualViewer } from './manuals.js';
import { staggerIndex } from './ui-utils.js';
import { toastError, toastWarning } from './toast.js';

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
    const operatorManuals = getOperatorManualsForMachine(machine.id); // Array, uno per manuale caricato
    const count = operatorManuals.length;

    const tabsHtml = operatorManuals
      .map(
        (manual, idx) => `
          <button type="button" data-idx="${idx}" style="--i:${idx}"
            class="shelf-item press-spring flex items-center gap-1.5 max-w-full rounded-lg border border-graphite-700 bg-graphite-900 hover:border-amber-500/40 hover:bg-white px-3 py-2 text-left transition-colors">
            <i data-lucide="file-text" class="w-3.5 h-3.5 shrink-0 text-graphite-500"></i>
            <span class="min-w-0 truncate text-sm text-graphite-100">${escapeHtml(manual.file_name)}</span>
          </button>
        `
      )
      .join('');

    const card = document.createElement('div');
    card.className = 'list-item-in shelf-card card-plate rounded-xl';
    card.style.setProperty('--i', staggerIndex(i));
    card.innerHTML = `
      <div class="shelf-header flex items-center justify-between gap-3 px-4 py-3.5 border-2 border-graphite-700 rounded-xl">
        <div class="flex items-center gap-3 min-w-0">
          <span class="shrink-0 w-9 h-9 rounded-lg bg-graphite-700/50 flex items-center justify-center">
            <i data-lucide="cog" class="w-[18px] h-[18px] text-graphite-400" stroke-width="1.8"></i>
          </span>
          <div class="min-w-0">
            <p class="font-display font-bold uppercase tracking-wide truncate">${escapeHtml(machine.nome)}</p>
            <p class="ui-note text-graphite-500 mt-0.5">${
              count ? `${count} ${count === 1 ? 'manuale operatore' : 'manuali operatore'}` : 'nessun manuale operatore'
            }</p>
          </div>
        </div>
        <i data-lucide="chevron-down" class="shelf-chevron w-5 h-5 text-graphite-400 shrink-0" stroke-width="2"></i>
      </div>
      <div class="shelf-body-track">
        <div class="shelf-body-inner p-3 space-y-2">
          ${
            count
              ? `<div class="flex flex-wrap gap-2">${tabsHtml}</div>`
              : '<p class="ui-note italic text-graphite-600 px-1">Nessun manuale operatore caricato.</p>'
          }
          <div class="flex justify-end pt-1">
            <button type="button" data-spare-parts style="--i:${count}"
              class="shelf-item press-spring inline-flex items-center gap-1.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-white font-display font-bold uppercase tracking-wide text-xs px-3.5 py-2.5 shadow-lg shadow-amber-500/20">
              <i data-lucide="cog" class="w-4 h-4" stroke-width="2.2"></i>
              Spare parts
            </button>
          </div>
        </div>
      </div>
    `;

    card.querySelector('.shelf-header').addEventListener('click', () => {
      card.classList.toggle('shelf-open');
    });
    card.querySelectorAll('[data-idx]').forEach((btn) => {
      const manual = operatorManuals[Number(btn.dataset.idx)];
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openManualViewer(manual);
      });
    });
    card.querySelector('[data-spare-parts]').addEventListener('click', (e) => {
      e.stopPropagation();
      const manual = getAnyManualForMachine(machine.id);
      if (!manual) {
        toastWarning(`Nessun manuale ricambi caricato per "${machine.nome}". Puoi caricarlo da Impostazioni → Gestione macchine.`);
        return;
      }
      openManualViewer(manual);
    });

    els.list.appendChild(card);
  });

  els.list.classList.remove('hidden');
  window.lucide?.createIcons();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
