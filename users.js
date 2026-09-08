// =============================================================
// users.js — Gestione utenti registrati (vista Impostazioni, solo Admin)
// Permette di associare Nome e Cognome a ogni utente, usato al posto
// dell'email nello storico transazioni e nei report.
// =============================================================

import { listProfiles, updateProfileName, deleteAllTransactions } from './supabase.js';
import { toastSuccess, toastError } from './toast.js';
import { staggerIndex, replayAnimation } from './ui-utils.js';
import { confirmDialog } from './ui-modal.js';
import feedback from './feedback.js';

const els = {};
let profiles = [];

export function initUsers() {
  els.list = document.getElementById('users-list');
  els.skeleton = document.getElementById('users-list-skeleton');
  els.deleteAllHistoryBtn = document.getElementById('settings-delete-all-history-btn');
  els.deleteAllHistoryBtn?.addEventListener('click', handleDeleteAllHistory);
}

export async function refreshUsers() {
  if (!els.list) return;
  els.skeleton.classList.remove('hidden');
  els.list.classList.add('hidden');
  try {
    profiles = await listProfiles();
    renderUsers();
  } catch (err) {
    console.error(err);
    toastError('Errore nel caricamento degli utenti.');
  } finally {
    els.skeleton.classList.add('hidden');
    els.list.classList.remove('hidden');
  }
}

function renderUsers() {
  els.list.innerHTML = '';
  profiles.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'list-item-in card-plate rounded-xl p-3 flex items-center gap-3';
    row.style.setProperty('--i', staggerIndex(i));
    row.innerHTML = `
      <div class="min-w-0 flex-1">
        <p class="text-xs text-graphite-500 truncate">${escapeHtml(p.email)}</p>
        <input type="text" value="${escapeHtml(p.full_name || '')}" placeholder="Nome e Cognome"
          class="user-name-input w-full mt-1 rounded-lg bg-graphite-800 border border-graphite-700 px-3 py-2 text-sm focus:border-amber-400 outline-none transition-colors">
      </div>
      <span class="shrink-0 text-[10px] font-display font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
        p.role === 'admin' ? 'bg-amber-500/20 text-amber-400' : 'bg-sky-500/20 text-sky-700'
      }">${p.role === 'admin' ? 'Admin' : 'Operatore'}</span>
      <button type="button" class="user-save-btn shrink-0 w-9 h-9 rounded-lg border border-graphite-700 hover:border-amber-400 text-graphite-400 hover:text-amber-400 flex items-center justify-center transition-colors" aria-label="Salva nome" title="Salva">
        <i data-lucide="check" class="w-4 h-4" stroke-width="2.25"></i>
      </button>
    `;
    const input = row.querySelector('.user-name-input');
    const saveBtn = row.querySelector('.user-save-btn');
    saveBtn.addEventListener('click', () => saveName(p.id, input.value.trim(), saveBtn));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveName(p.id, input.value.trim(), saveBtn);
    });
    els.list.appendChild(row);
  });
  window.lucide?.createIcons();
}

async function saveName(id, name, btn) {
  if (!name) {
    toastError('Il nome non può essere vuoto.');
    return;
  }
  btn.disabled = true;
  btn.classList.add('opacity-50');
  try {
    await updateProfileName(id, name);
    toastSuccess('Nome aggiornato.');
    replayAnimation(btn, 'stock-pulse');
    const p = profiles.find((x) => x.id === id);
    if (p) p.full_name = name;
  } catch (err) {
    console.error(err);
    toastError('Errore nel salvataggio del nome.');
  } finally {
    btn.disabled = false;
    btn.classList.remove('opacity-50');
  }
}

/**
 * Cancellazione integrale della cronologia movimenti (tutti gli articoli),
 * spostata qui in Impostazioni — sostituisce la vecchia eliminazione
 * "per singolo articolo" che stava nella scheda prodotto.
 */
async function handleDeleteAllHistory() {
  const ok = await confirmDialog({
    title: 'Eliminare tutta la cronologia?',
    message:
      'Verranno cancellati per sempre TUTTI i movimenti (depositi e prelievi) di TUTTI gli articoli. La giacenza attuale non cambia: viene rimosso solo lo storico. L\'operazione non è reversibile.',
    confirmLabel: 'Elimina tutto',
    danger: true,
  });
  if (!ok) return;

  const btn = els.deleteAllHistoryBtn;
  btn.disabled = true;
  btn.classList.add('opacity-50');
  try {
    await deleteAllTransactions();
    feedback.confirmAction();
    toastSuccess('Cronologia movimenti eliminata.');
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Errore durante l\'eliminazione della cronologia.');
  } finally {
    btn.disabled = false;
    btn.classList.remove('opacity-50');
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
