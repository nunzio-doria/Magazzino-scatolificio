// =============================================================
// dashboard.js — Reportistica consumi (vista Admin)
// =============================================================

import { getConsumptionStats, listTransactions } from './supabase.js';
import { toastError } from './toast.js';

const els = {};

export function initDashboard() {
  els.periodSelect = document.getElementById('dash-period-select');
  els.statsWrap = document.getElementById('dash-consumption-list');
  els.statsSkeleton = document.getElementById('dash-consumption-skeleton');
  els.historyWrap = document.getElementById('dash-history-list');
  els.historySkeleton = document.getElementById('dash-history-skeleton');
  els.totalDeposits = document.getElementById('dash-kpi-depositi');
  els.totalWithdrawals = document.getElementById('dash-kpi-prelievi');
  els.totalMovements = document.getElementById('dash-kpi-movimenti');

  els.periodSelect.addEventListener('change', refresh);
  refresh();
}

function periodToFromDate(period) {
  const now = new Date();
  const d = new Date(now);
  if (period === '7d') d.setDate(now.getDate() - 7);
  else if (period === '30d') d.setDate(now.getDate() - 30);
  else if (period === '90d') d.setDate(now.getDate() - 90);
  else return null; // 'all'
  return d.toISOString();
}

export async function refresh() {
  const from = periodToFromDate(els.periodSelect.value);

  els.statsSkeleton.classList.remove('hidden');
  els.statsWrap.classList.add('hidden');
  els.historySkeleton.classList.remove('hidden');
  els.historyWrap.classList.add('hidden');

  try {
    const [stats, history] = await Promise.all([
      getConsumptionStats({ from }),
      listTransactions({ from, limit: 100 }),
    ]);

    renderKpis(history, stats);
    renderStats(stats);
    renderHistory(history);
  } catch (err) {
    console.error(err);
    toastError('Errore nel caricamento della reportistica.');
  } finally {
    els.statsSkeleton.classList.add('hidden');
    els.statsWrap.classList.remove('hidden');
    els.historySkeleton.classList.add('hidden');
    els.historyWrap.classList.remove('hidden');
  }
}

function renderKpis(history, stats) {
  const depositi = history.filter((h) => h.tipo === 'deposito').length;
  const prelievi = history.filter((h) => h.tipo === 'prelievo').length;
  els.totalDeposits.textContent = depositi;
  els.totalWithdrawals.textContent = prelievi;
  els.totalMovements.textContent = history.length;
}

function renderStats(stats) {
  els.statsWrap.innerHTML = '';
  if (stats.length === 0) {
    els.statsWrap.innerHTML = '<p class="text-graphite-500 text-sm py-4 text-center">Nessun prelievo nel periodo selezionato.</p>';
    return;
  }
  const max = Math.max(...stats.map((s) => s.totale));
  for (const s of stats.slice(0, 15)) {
    const pct = Math.max(6, Math.round((s.totale / max) * 100));
    const row = document.createElement('div');
    row.className = 'py-2';
    row.innerHTML = `
      <div class="flex justify-between text-sm mb-1">
        <span class="text-graphite-200 truncate pr-2"><span class="font-mono text-xs text-graphite-500">${escapeHtml(
          s.codice_articolo
        )}</span> ${escapeHtml(s.descrizione)}</span>
        <span class="font-mono font-semibold text-amber-300 shrink-0">${s.totale}</span>
      </div>
      <div class="h-2 rounded-full bg-graphite-800 overflow-hidden">
        <div class="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-300 bar-grow" style="--target-width:${pct}%"></div>
      </div>
    `;
    els.statsWrap.appendChild(row);
  }
}

function renderHistory(history) {
  els.historyWrap.innerHTML = '';
  if (history.length === 0) {
    els.historyWrap.innerHTML = '<p class="text-graphite-500 text-sm py-4 text-center">Nessun movimento nel periodo selezionato.</p>';
    return;
  }
  for (const h of history) {
    const date = new Date(h.data_ora);
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-3 py-2.5 border-b border-graphite-800 last:border-0';
    row.innerHTML = `
      <div class="min-w-0">
        <p class="text-sm text-graphite-100 truncate">
          <span class="font-mono text-xs text-graphite-500">${escapeHtml(h.products?.codice_articolo || '—')}</span>
          ${escapeHtml(h.products?.descrizione || '—')}
        </p>
        <p class="text-xs text-graphite-500 mt-0.5">${escapeHtml(h.profiles?.full_name || 'Utente')} · ${escapeHtml(
      h.punto_utilizzo_specifico || '—'
    )} · ${date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
      </div>
      <span class="shrink-0 font-mono text-sm font-semibold px-2.5 py-1 rounded-full ${
        h.tipo === 'deposito' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
      }">${h.tipo === 'deposito' ? '+' : '−'}${h.quantita}</span>
    `;
    els.historyWrap.appendChild(row);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
