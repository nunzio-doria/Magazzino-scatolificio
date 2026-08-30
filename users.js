// =============================================================
// users.js — Gestione utenti registrati (vista Impostazioni, solo Admin)
// Permette di associare Nome e Cognome a ogni utente, usato al posto
// dell'email nello storico transazioni e nei report.
// =============================================================

import { listProfiles, updateProfileName } from './supabase.js';
import { toastSuccess, toastError } from './toast.js';

const els = {};
let profiles = [];

export function initUsers() {
  els.list = document.getElementById('users-list');
  els.skeleton = document.getElementById('users-list-skeleton');
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
  for (const p of profiles) {
    const row = document.createElement('div');
    row.className = 'card-plate rounded-xl p-3 flex items-center gap-3';
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
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
      </button>
    `;
    const input = row.querySelector('.user-name-input');
    const saveBtn = row.querySelector('.user-save-btn');
    saveBtn.addEventListener('click', () => saveName(p.id, input.value.trim(), saveBtn));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveName(p.id, input.value.trim(), saveBtn);
    });
    els.list.appendChild(row);
  }
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
