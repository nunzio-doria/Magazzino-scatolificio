// =============================================================
// history-admin.js — Gestione cronologia movimenti (Impostazioni, solo
// Admin): permette di rivedere ed eliminare singoli movimenti dallo
// storico (anche più di uno alla volta), al posto della vecchia
// eliminazione totale e irreversibile.
// =============================================================

import { listTransactions, deleteTransactions } from './supabase.js';
import { toastSuccess, toastError } from './toast.js';
import { staggerIndex, emptyStateHtml, setButtonBusy, openOverlay, closeOverlay } from './ui-utils.js';
import { confirmDialog } from './ui-modal.js';
import feedback from './feedback.js';
import { loadIdlePanel } from './scanner.js';

const els = {};
let history = [];
let filter = 'tutti'; // 'tutti' | 'deposito' | 'prelievo'
const selected = new Set();

export function initHistoryAdmin() {
  els.modal = document.getElementById('history-manage-modal');
  els.openBtn = document.getElementById('history-manage-btn');
  els.closeBtn = document.getElementById('history-manage-close');
  els.tabs = document.querySelectorAll('[data-history-manage-tab]');
  els.skeleton = document.getElementById('history-manage-skeleton');
  els.list = document.getElementById('history-manage-list');
  els.actionBar = document.getElementById('history-manage-actionbar');
  els.count = document.getElementById('history-manage-count');
  els.deleteBtn = document.getElementById('history-manage-delete-btn');

  els.openBtn?.addEventListener('click', () => {
    openOverlay(els.modal);
    refreshHistory();
  });
  els.closeBtn?.addEventListener('click', () => closeOverlay(els.modal));
  els.modal?.addEventListener('click', (e) => {
    if (e.target === els.modal) closeOverlay(els.modal);
  });
  els.tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.historyManageTab;
      els.tabs.forEach((b) => b.classList.toggle('history-tab-active', b === btn));
      render();
    });
  });
  els.deleteBtn?.addEventListener('click', handleDeleteSelected);
}

async function refreshHistory() {
  selected.clear();
  els.skeleton.classList.remove('hidden');
  els.list.classList.add('hidden');
  els.actionBar.classList.add('hidden');
  try {
    history = await listTransactions({ limit: 500 });
    render();
  } catch (err) {
    console.error(err);
    els.list.innerHTML = emptyStateHtml('wifi-off', 'Connessione assente', 'Controlla la rete e riprova.');
    toastError('Errore nel caricamento della cronologia.');
  } finally {
    els.skeleton.classList.add('hidden');
    els.list.classList.remove('hidden');
  }
}

function filteredHistory() {
  if (filter === 'tutti') return history;
  return history.filter((h) => h.tipo === filter);
}

function render() {
  const rows = filteredHistory();
  els.list.innerHTML = '';
  if (rows.length === 0) {
    els.list.innerHTML = emptyStateHtml('inbox', 'Nessun movimento', 'Non risultano movimenti per questo filtro.');
    window.lucide?.createIcons();
    updateActionBar();
    return;
  }
  rows.forEach((h, i) => els.list.appendChild(historyRow(h, i)));
  window.lucide?.createIcons();
  updateActionBar();
}

function historyRow(h, i) {
  const date = new Date(h.data_ora);
  const row = document.createElement('label');
  row.className = 'list-item-in flex items-center gap-3 py-2.5 px-1 border-b border-graphite-800 last:border-0 cursor-pointer select-none';
  row.style.setProperty('--i', staggerIndex(i));

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'shrink-0 w-5 h-5 rounded accent-amber-400';
  checkbox.checked = selected.has(h.id);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(h.id);
    else selected.delete(h.id);
    updateActionBar();
  });

  const info = document.createElement('div');
  info.className = 'min-w-0 flex-1';
  info.innerHTML = `
    <p class="text-sm text-graphite-100 truncate font-medium">${escapeHtml(h.products?.codice_articolo || '—')}</p>
    <p class="text-xs text-graphite-500 mt-0.5">${escapeHtml(h.profiles?.full_name || 'Utente')} · ${escapeHtml(
    h.punto_utilizzo_specifico || '—'
  )} · ${date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
  `;

  const badge = document.createElement('span');
  badge.className = `shrink-0 font-mono text-sm font-semibold px-2.5 py-1 rounded-full ${
    h.tipo === 'deposito' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-300'
  }`;
  badge.textContent = `${h.tipo === 'deposito' ? '+' : '−'}${h.quantita}`;

  row.append(checkbox, info, badge);
  return row;
}

function updateActionBar() {
  const n = selected.size;
  els.actionBar.classList.toggle('hidden', n === 0);
  if (els.count) els.count.textContent = n === 1 ? '1 selezionato' : `${n} selezionati`;
  if (els.deleteBtn) els.deleteBtn.disabled = n === 0;
}

async function handleDeleteSelected() {
  const ids = Array.from(selected);
  if (!ids.length) return;
  const ok = await confirmDialog({
    title: ids.length === 1 ? 'Eliminare il movimento?' : `Eliminare ${ids.length} movimenti?`,
    message: 'Verranno cancellati per sempre dallo storico. La giacenza attuale non cambia. L\'operazione non è reversibile.',
    confirmLabel: 'Elimina',
    danger: true,
  });
  if (!ok) return;

  setButtonBusy(els.deleteBtn, true, 'Eliminazione…');
  try {
    await deleteTransactions(ids);
    feedback.confirmAction();
    toastSuccess(ids.length === 1 ? 'Movimento eliminato.' : `${ids.length} movimenti eliminati.`);
    loadIdlePanel(); // "ultimi movimenti" in Scanner deve aggiornarsi subito
    await refreshHistory();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Errore durante l\'eliminazione.');
    setButtonBusy(els.deleteBtn, false);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
