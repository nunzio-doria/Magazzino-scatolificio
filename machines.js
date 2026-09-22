// =============================================================
// machines.js — Gestione macchine (vista Impostazioni, solo Admin)
// Elenco delle macchine con il numero di articoli associati, modulo per
// aggiungerne di nuove alla tabella `machines` del database e pulsante per rimuoverle. Le macchine
// registrate compaiono nel form articolo e nel filtro "per macchina".
// =============================================================

import { listMachinesWithCounts, createMachine, deleteMachine, bumpProductsVersion } from './supabase.js';
import { toastSuccess, toastError } from './toast.js';
import { isAdmin } from './auth.js';
import { staggerIndex, setButtonBusy, openOverlay, closeOverlay, enableSheetDrag } from './ui-utils.js';
import { confirmDialog } from './ui-modal.js';
import feedback from './feedback.js';

const els = {};
let tableMissing = false;

export function initMachines() {
  els.form = document.getElementById('machine-form');
  els.input = document.getElementById('machine-name-input');
  els.addBtn = document.getElementById('machine-add-btn');
  els.notice = document.getElementById('machines-notice');
  els.list = document.getElementById('machines-list');
  els.skeleton = document.getElementById('machines-list-skeleton');
  els.form?.addEventListener('submit', handleAdd);

  els.modal = document.getElementById('machines-modal');
  els.manageBtn = document.getElementById('machines-manage-btn');
  els.closeBtn = document.getElementById('machines-modal-close');
  els.manageBtn?.addEventListener('click', () => {
    openOverlay(els.modal);
    refreshMachines();
  });
  els.closeBtn?.addEventListener('click', () => closeOverlay(els.modal));
  els.modal?.addEventListener('click', (e) => {
    if (e.target === els.modal) closeOverlay(els.modal);
  });
  enableSheetDrag(els.modal?.querySelector('.modal-panel'), () => closeOverlay(els.modal));
}

export async function refreshMachines() {
  if (!els.list || !isAdmin()) return;
  els.skeleton.classList.remove('hidden');
  els.list.classList.add('hidden');
  try {
    const result = await listMachinesWithCounts();
    tableMissing = result.tableMissing;
    render(result.machines);
  } catch (err) {
    console.error(err);
    toastError('Impossibile caricare l\'elenco delle macchine.');
  } finally {
    els.skeleton.classList.add('hidden');
  }
}

function render(machines) {
  // Se la tabella non esiste ancora si avvisa e si blocca il modulo: aggiungere non potrebbe funzionare
  els.notice.classList.toggle('hidden', !tableMissing);
  els.input.disabled = tableMissing;
  // Il grigiore arriva dalla regola globale su :disabled, non serve una classe manuale qui.
  els.addBtn.disabled = tableMissing;

  els.list.innerHTML = '';
  if (machines.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-graphite-500 py-2';
    empty.textContent = 'Nessuna macchina ancora registrata.';
    els.list.appendChild(empty);
  }
  machines.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'list-item-in card-plate rounded-xl pl-3.5 pr-1.5 py-1.5 flex items-center justify-between gap-2';
    row.style.setProperty('--i', staggerIndex(i));
    const name = document.createElement('span');
    name.className = 'min-w-0 truncate text-sm font-medium text-graphite-100';
    name.textContent = m.nome; // testo, mai HTML
    const meta = document.createElement('span');
    meta.className = 'shrink-0 ui-note whitespace-nowrap text-graphite-500';
    meta.textContent = m.articoli === 1 ? '1 articolo' : `${m.articoli} articoli`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', `Rimuovi la macchina ${m.nome}`);
    removeBtn.className = 'shrink-0 w-11 h-11 rounded-lg flex items-center justify-center text-rose-700 hover:bg-rose-50 transition-colors';
    removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-5 h-5" stroke-width="2"></i>';
    removeBtn.addEventListener('click', () => handleRemove(m, removeBtn));
    row.append(name, meta, removeBtn);
    els.list.appendChild(row);
  });
  els.list.classList.remove('hidden');
  window.lucide?.createIcons();
}

async function handleRemove(machine, btn) {
  const usata = machine.articoli > 0;
  const ok = await confirmDialog({
    title: 'Rimuovere la macchina?',
    message: usata
      ? `"${machine.nome}" è assegnata a ${machine.articoli} ${machine.articoli === 1 ? 'articolo' : 'articoli'}: resteranno senza macchina assegnata. L'operazione non si può annullare.`
      : `"${machine.nome}" non è assegnata a nessun articolo. Verrà tolta dall'elenco.`,
    confirmLabel: 'Rimuovi',
    danger: true,
  });
  if (!ok) return;
  setButtonBusy(btn, true);
  try {
    const { articoliSvuotati } = await deleteMachine(machine);
    feedback.deleteAction();
    toastSuccess(
      articoliSvuotati > 0
        ? `Macchina "${machine.nome}" rimossa (${articoliSvuotati} ${articoliSvuotati === 1 ? 'articolo aggiornato' : 'articoli aggiornati'}).`
        : `Macchina "${machine.nome}" rimossa.`
    );
    if (articoliSvuotati > 0) bumpProductsVersion(); // la lista del Magazzino si aggiorna al rientro
    // Se il Magazzino stava filtrando proprio per questa macchina, il filtro va tolto
    document.dispatchEvent(new CustomEvent('machine-removed', { detail: { nome: machine.nome } }));
    await refreshMachines();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || 'Impossibile rimuovere la macchina.');
    setButtonBusy(btn, false);
  }
}

async function handleAdd(e) {
  e.preventDefault();
  const nome = els.input.value;
  setButtonBusy(els.addBtn, true, 'Aggiunta…');
  try {
    const row = await createMachine(nome);
    els.input.value = '';
    feedback.confirmAction();
    toastSuccess(`Macchina "${row.nome}" aggiunta.`);
    await refreshMachines();
  } catch (err) {
    feedback.errorAction();
    toastError(err.message || 'Impossibile aggiungere la macchina.');
  } finally {
    if (!tableMissing) setButtonBusy(els.addBtn, false);
  }
}
