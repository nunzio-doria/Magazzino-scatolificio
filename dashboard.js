// =============================================================
// dashboard.js — Reportistica consumi (vista Admin)
// =============================================================

import { getConsumptionStats, listTransactions } from './supabase.js';
import { toastError } from './toast.js';

const els = {};
let currentFrom = null;
let articleHistoryCache = [];
let articleHistoryFilter = 'tutti'; // 'tutti' | 'deposito' | 'prelievo'

export function initDashboard() {
  els.periodSelect = document.getElementById('dash-period-select');
  els.statsWrap = document.getElementById('dash-consumption-list');
  els.statsSkeleton = document.getElementById('dash-consumption-skeleton');
  els.historyWrap = document.getElementById('dash-history-list');
  els.historySkeleton = document.getElementById('dash-history-skeleton');
  els.totalDeposits = document.getElementById('dash-kpi-depositi');
  els.totalWithdrawals = document.getElementById('dash-kpi-prelievi');
  els.totalMovements = document.getElementById('dash-kpi-movimenti');

  // Modale storico articolo
  els.articleModal = document.getElementById('article-history-modal');
  els.articleModalTitle = document.getElementById('article-history-title');
  els.articleModalClose = document.getElementById('article-history-close');
  els.articleModalList = document.getElementById('article-history-list');
  els.articleModalTabs = document.querySelectorAll('[data-history-tab]');

  els.periodSelect.addEventListener('change', refresh);
  els.articleModalClose.addEventListener('click', closeArticleHistory);
  els.articleModal.addEventListener('click', (e) => {
    if (e.target === els.articleModal) closeArticleHistory();
  });
  els.articleModalTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      articleHistoryFilter = btn.dataset.historyTab;
      els.articleModalTabs.forEach((b) => b.classList.toggle('history-tab-active', b === btn));
      renderArticleHistory();
    });
  });

  refresh();
}

function periodToFromDate(period) {
  const now = new Date();
  const d = new Date(now);
  if (period === '7d') d.setDate(now.getDate() - 7);
  else if (period === '30d') d.setDate(now.getDate() - 30);
  else if (period === '90d') d.setDate(now.getDate() - 90);
  else return null;
  return d.toISOString();
}

export async function refresh() {
  currentFrom = periodToFromDate(els.periodSelect.value);

  els.statsSkeleton.classList.remove('hidden');
  els.statsWrap.classList.add('hidden');
  els.historySkeleton.classList.remove('hidden');
  els.historyWrap.classList.add('hidden');

  try {
    const [stats, history] = await Promise.all([
      getConsumptionStats({ from: currentFrom }),
      listTransactions({ from: currentFrom, limit: 100 }),
    ]);

    renderKpis(history);
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

function renderKpis(history) {
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
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'w-full text-left py-2 hover:bg-graphite-700/30 rounded-lg px-2 -mx-2 transition-colors';
    row.innerHTML = `
      <div class="flex justify-between text-sm mb-1">
        <span class="text-graphite-200 truncate pr-2 font-medium">${escapeHtml(s.codice_articolo)}</span>
        <span class="font-mono font-semibold text-amber-400 shrink-0">${s.totale}</span>
      </div>
      <div class="h-2 rounded-full bg-graphite-800 overflow-hidden">
        <div class="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-300 bar-grow" style="--target-width:${pct}%"></div>
      </div>
    `;
    row.addEventListener('click', () => openArticleHistory(s.product_id, s.codice_articolo));
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
    els.historyWrap.appendChild(historyRow(h));
  }
}

function historyRow(h) {
  const date = new Date(h.data_ora);
  const row = document.createElement('div');
  row.className = 'flex items-center justify-between gap-3 py-2.5 border-b border-graphite-800 last:border-0';
  row.innerHTML = `
    <div class="min-w-0">
      <p class="text-sm text-graphite-100 truncate font-medium">${escapeHtml(h.products?.codice_articolo || '—')}</p>
      <p class="text-xs text-graphite-500 mt-0.5">${escapeHtml(h.profiles?.full_name || 'Utente')} · ${escapeHtml(
    h.punto_utilizzo_specifico || '—'
  )} · ${date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
    </div>
    <span class="shrink-0 font-mono text-sm font-semibold px-2.5 py-1 rounded-full ${
      h.tipo === 'deposito' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-700'
    }">${h.tipo === 'deposito' ? '+' : '−'}${h.quantita}</span>
  `;
  return row;
}

// --- Storico dettagliato per singolo articolo (modale) --------------

async function openArticleHistory(productId, codiceArticolo) {
  els.articleModalTitle.textContent = codiceArticolo;
  articleHistoryFilter = 'tutti';
  els.articleModalTabs.forEach((b) => b.classList.toggle('history-tab-active', b.dataset.historyTab === 'tutti'));
  els.articleModalList.innerHTML = '<div class="skeleton h-12 w-full mb-2"></div><div class="skeleton h-12 w-full mb-2"></div><div class="skeleton h-12 w-full"></div>';

  els.articleModal.classList.remove('hidden');
  requestAnimationFrame(() => els.articleModal.classList.add('modal-visible'));

  try {
    articleHistoryCache = await listTransactions({ from: currentFrom, productId, limit: 500 });
    renderArticleHistory();
  } catch (err) {
    console.error(err);
    els.articleModalList.innerHTML = '<p class="text-center text-sm text-rose-700 py-6">Errore nel caricamento dello storico.</p>';
  }
}

function renderArticleHistory() {
  const filtered =
    articleHistoryFilter === 'tutti' ? articleHistoryCache : articleHistoryCache.filter((h) => h.tipo === articleHistoryFilter);

  els.articleModalList.innerHTML = '';
  if (!filtered.length) {
    els.articleModalList.innerHTML = '<p class="text-center text-sm text-graphite-500 py-6">Nessun movimento trovato.</p>';
    return;
  }
  for (const h of filtered) {
    els.articleModalList.appendChild(historyRow(h));
  }
}

function closeArticleHistory() {
  els.articleModal.classList.remove('modal-visible');
  setTimeout(() => els.articleModal.classList.add('hidden'), 180);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
