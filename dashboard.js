// =============================================================
// dashboard.js — Reportistica consumi (vista Admin)
// =============================================================

import { getConsumptionStats, listTransactions, getProductsVersion } from './supabase.js';
import { toastError, toastSuccess, toastWarning } from './toast.js';
import { enhanceSelect } from './ui-select.js';
import { animateNumber, animateRing, emptyStateHtml, openOverlay, closeOverlay, enableSheetDrag, staggerIndex } from './ui-utils.js';
import feedback from './feedback.js';

const els = {};
let currentFrom = null;
let currentPeriodLabel = '30d';
let lastStats = [];
let lastHistory = [];
let hasLoadedOnce = false; // true dopo il primo caricamento riuscito, per distinguere "dati vuoti" da "mai caricato"

// --- Caricamento: completo solo una volta per accesso, come il Magazzino ---
// Un deposito/prelievo (anche offline, sincronizzato più tardi) fa scattare la stessa
// "versione" del Magazzino: se cambia, o se il periodo selezionato è diverso da quello
// mostrato, al rientro nel Report si aggiorna in silenzio, senza caricamento animato.
const REVALIDATE_MS = 10 * 60 * 1000;
let reportLoadedOnce = false;
let seenProductsVersion = 0;
let lastLoadedAt = 0;
let refreshSeq = 0;
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
  enableSheetDrag(els.articleModal.querySelector('.modal-panel'), () => closeArticleHistory());
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

/** Con `list-static` sulla vista i numeri/anelli/barre/righe compaiono già al valore finale (niente animazione). */
function setReportStatic(on) {
  document.getElementById('view-dashboard')?.classList.toggle('list-static', on);
}

function markReportLoaded() {
  reportLoadedOnce = true;
  seenProductsVersion = getProductsVersion();
  lastLoadedAt = Date.now();
}

/** Chiamata da app.js ogni volta che si entra nel Report. */
export function enterDashboard() {
  if (!reportLoadedOnce) return refresh(); // primo ingresso: caricamento completo
  const periodChanged = els.periodSelect.value !== currentPeriodLabel;
  const changed = getProductsVersion() !== seenProductsVersion;
  const old = Date.now() - lastLoadedAt > REVALIDATE_MS;
  if (periodChanged || changed || old) return silentRefresh();
  return Promise.resolve();
}

/** Dopo il logout: la prossima volta si riparte da zero. */
export function resetDashboard() {
  reportLoadedOnce = false;
  seenProductsVersion = 0;
  lastLoadedAt = 0;
  lastStats = [];
  lastHistory = [];
  hasLoadedOnce = false;
  refreshSeq += 1;
}

/** Aggiorna Report senza caricamento e senza animazioni; se la rete non c'è restano i dati attuali. */
async function silentRefresh() {
  const seq = ++refreshSeq;
  currentFrom = periodToFromDate(els.periodSelect.value);
  currentPeriodLabel = els.periodSelect.value;
  try {
    const [stats, history] = await Promise.all([
      getConsumptionStats({ from: currentFrom }),
      listTransactions({ from: currentFrom, limit: 100 }),
    ]);
    if (seq !== refreshSeq) return;
    lastStats = stats;
    lastHistory = history;
    hasLoadedOnce = true;
    setReportStatic(true);
    renderKpis(history);
    renderStats(stats);
    renderHistory(history);
    markReportLoaded();
  } catch (err) {
    console.warn("Aggiornamento silenzioso del Report non riuscito, resta l'ultimo caricato.", err);
  }
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
  const seq = ++refreshSeq;
  currentFrom = periodToFromDate(els.periodSelect.value);
  currentPeriodLabel = els.periodSelect.value;
  setReportStatic(false); // caricamento "vero": numeri, anelli e barre animano da zero

  els.statsSkeleton.classList.remove('hidden');
  els.statsWrap.classList.add('hidden');
  els.historySkeleton.classList.remove('hidden');
  els.historyWrap.classList.add('hidden');

  try {
    const [stats, history] = await Promise.all([
      getConsumptionStats({ from: currentFrom }),
      listTransactions({ from: currentFrom, limit: 100 }),
    ]);
    if (seq !== refreshSeq) return;
    lastStats = stats;
    lastHistory = history;
    hasLoadedOnce = true;

    renderKpis(history);
    renderStats(stats);
    renderHistory(history);
    markReportLoaded();
  } catch (err) {
    if (seq !== refreshSeq) return;
    console.error(err);
    // Se avevamo già dati da un caricamento precedente (lastStats/lastHistory
    // non sono più il valore iniziale), meglio ri-mostrare quelli con un
    // avviso che lasciare le card vuote senza spiegazione o, peggio,
    // nascoste del tutto.
    if (hasLoadedOnce) {
      renderKpis(lastHistory);
      renderStats(lastStats);
      renderHistory(lastHistory);
      toastWarning('Connessione assente: mostro gli ultimi dati caricati.');
    } else {
      els.statsWrap.innerHTML = emptyStateHtml('wifi-off', 'Connessione assente', 'Controlla la rete e riprova.');
      els.historyWrap.innerHTML = emptyStateHtml('wifi-off', 'Connessione assente', 'Controlla la rete e riprova.');
      toastError('Errore nel caricamento della reportistica.');
    }
  } finally {
    if (seq !== refreshSeq) return;
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
  stats.slice(0, 15).forEach((s, i) => {
    const pct = Math.max(6, Math.round((s.totale / max) * 100));
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'list-item-in w-full text-left py-2 hover:bg-graphite-700/30 rounded-lg px-2 -mx-2 transition-colors';
    row.style.setProperty('--i', staggerIndex(i));
    row.innerHTML = `
      <div class="flex justify-between text-sm mb-1">
        <span class="text-graphite-200 truncate pr-2 font-medium">${escapeHtml(s.codice_articolo)}</span>
        <span class="font-mono font-semibold text-amber-400 shrink-0">${s.totale}</span>
      </div>
      <div class="h-2 rounded-full bg-graphite-800 overflow-hidden">
        <div class="h-full rounded-full bg-gradient-to-r from-amber-300 to-amber-400 bar-grow" style="--target-width:${pct}%; --i:${i}"></div>
      </div>
    `;
    row.addEventListener('click', () => openArticleHistory(s.product_id, s.codice_articolo));
    els.statsWrap.appendChild(row);
  });
}

function renderHistory(history) {
  els.historyWrap.innerHTML = '';
  if (history.length === 0) {
    els.historyWrap.innerHTML = emptyStateHtml('inbox', 'Nessun movimento', 'Non risultano depositi o prelievi nel periodo selezionato.');
    window.lucide?.createIcons();
    return;
  }
  history.forEach((h, i) => {
    els.historyWrap.appendChild(historyRow(h, i));
  });
}

function historyRow(h, i = 0) {
  const date = new Date(h.data_ora);
  const row = document.createElement('div');
  row.className = 'list-item-in flex items-center justify-between gap-3 py-2.5 border-b border-graphite-800 last:border-0';
  row.style.setProperty('--i', staggerIndex(i));
  row.innerHTML = `
    <div class="min-w-0">
      <p class="text-sm text-graphite-100 truncate font-medium">${escapeHtml(h.products?.codice_articolo || '—')}</p>
      <p class="text-xs text-graphite-500 mt-0.5">${escapeHtml(h.profiles?.full_name || 'Utente')} · ${escapeHtml(
    h.punto_utilizzo_specifico || '—'
  )} · ${date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
    </div>
    <span class="shrink-0 font-mono text-sm font-semibold px-2.5 py-1 rounded-full ${
      h.tipo === 'deposito' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-300'
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

  openOverlay(els.articleModal);

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
    els.articleModalList.innerHTML = emptyStateHtml('inbox', 'Nessun movimento', 'Nessun movimento trovato per questo filtro.');
    window.lucide?.createIcons();
    return;
  }
  filtered.forEach((h, i) => {
    els.articleModalList.appendChild(historyRow(h, i));
  });
}

function closeArticleHistory() {
  closeOverlay(els.articleModal);
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
