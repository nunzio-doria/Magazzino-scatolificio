// =============================================================
// dashboard.js — Reportistica consumi (vista Admin)
// =============================================================

import { getConsumptionStats, listTransactions } from './supabase.js';
import { toastError, toastSuccess } from './toast.js';
import { enhanceSelect } from './ui-select.js';
import { animateNumber, animateRing, emptyStateHtml } from './ui-utils.js';
import feedback from './feedback.js';

const els = {};
let currentFrom = null;
let currentPeriodLabel = '30d';
let lastStats = [];
let lastHistory = [];
let articleHistoryCache = [];
let articleHistoryFilter = 'tutti'; // 'tutti' | 'deposito' | 'prelievo'

export function initDashboard() {
  els.periodSelect = document.getElementById('dash-period-select');
  enhanceSelect(els.periodSelect);
  els.statsWrap = document.getElementById('dash-consumption-list');
  els.statsSkeleton = document.getElementById('dash-consumption-skeleton');
  els.historyWrap = document.getElementById('dash-history-list');
  els.historySkeleton = document.getElementById('dash-history-skeleton');
  els.totalDeposits = document.getElementById('dash-kpi-depositi');
  els.totalWithdrawals = document.getElementById('dash-kpi-prelievi');
  els.totalMovements = document.getElementById('dash-kpi-movimenti');
  els.ringDepositi = document.getElementById('dash-ring-depositi');
  els.ringPrelievi = document.getElementById('dash-ring-prelievi');
  els.exportBtn = document.getElementById('dash-export-btn');

  // Modale storico articolo
  els.articleModal = document.getElementById('article-history-modal');
  els.articleModalTitle = document.getElementById('article-history-title');
  els.articleModalClose = document.getElementById('article-history-close');
  els.articleModalList = document.getElementById('article-history-list');
  els.articleModalTabs = document.querySelectorAll('[data-history-tab]');

  els.periodSelect.addEventListener('change', refresh);
  els.exportBtn?.addEventListener('click', exportReport);
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
  currentPeriodLabel = els.periodSelect.value;

  els.statsSkeleton.classList.remove('hidden');
  els.statsWrap.classList.add('hidden');
  els.historySkeleton.classList.remove('hidden');
  els.historyWrap.classList.add('hidden');

  try {
    const [stats, history] = await Promise.all([
      getConsumptionStats({ from: currentFrom }),
      listTransactions({ from: currentFrom, limit: 100 }),
    ]);
    lastStats = stats;
    lastHistory = history;

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
  const totale = history.length;

  animateNumber(els.totalDeposits, depositi);
  animateNumber(els.totalWithdrawals, prelievi);
  animateNumber(els.totalMovements, totale);

  animateRing(els.ringDepositi, totale ? (depositi / totale) * 100 : 0);
  animateRing(els.ringPrelievi, totale ? (prelievi / totale) * 100 : 0);
}

function renderStats(stats) {
  els.statsWrap.innerHTML = '';
  if (stats.length === 0) {
    els.statsWrap.innerHTML = emptyStateHtml('trending-down', 'Nessun prelievo', 'Non risultano prelievi nel periodo selezionato.');
    window.lucide?.createIcons();
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
    els.historyWrap.innerHTML = emptyStateHtml('inbox', 'Nessun movimento', 'Non risultano depositi o prelievi nel periodo selezionato.');
    window.lucide?.createIcons();
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

/** Esporta lo storico e i consumi per articolo del periodo corrente in un file Excel */
function exportReport() {
  if (!lastHistory.length && !lastStats.length) {
    toastError('Nessun dato da esportare per il periodo selezionato.');
    return;
  }
  try {
    // eslint-disable-next-line no-undef
    const wb = XLSX.utils.book_new();

    const historyRows = lastHistory.map((h) => ({
      Data: new Date(h.data_ora).toLocaleString('it-IT'),
      Tipo: h.tipo === 'deposito' ? 'Deposito' : 'Prelievo',
      Articolo: h.products?.codice_articolo || '—',
      Quantità: h.quantita,
      'Punto utilizzo': h.punto_utilizzo_specifico || '',
      Operatore: h.profiles?.full_name || '',
    }));
    // eslint-disable-next-line no-undef
    const historySheet = XLSX.utils.json_to_sheet(historyRows);
    // eslint-disable-next-line no-undef
    XLSX.utils.book_append_sheet(wb, historySheet, 'Storico');

    const statsRows = lastStats.map((s) => ({
      Articolo: s.codice_articolo,
      'Totale prelevato': s.totale,
    }));
    // eslint-disable-next-line no-undef
    const statsSheet = XLSX.utils.json_to_sheet(statsRows);
    // eslint-disable-next-line no-undef
    XLSX.utils.book_append_sheet(wb, statsSheet, 'Consumi per articolo');

    const periodLabels = { '7d': '7gg', '30d': '30gg', '90d': '90gg', all: 'storico' };
    const filename = `report_magazzino_${periodLabels[currentPeriodLabel] || currentPeriodLabel}_${new Date()
      .toISOString()
      .slice(0, 10)}.xlsx`;
    // eslint-disable-next-line no-undef
    XLSX.writeFile(wb, filename);

    feedback.confirmAction();
    toastSuccess('Report esportato.');
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Errore durante l\'esportazione del report.');
  }
}
