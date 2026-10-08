// =============================================================
// dashboard.js — Report (vista Admin)
//
// Contiene solo due cose, entrambe filtrate dallo stesso periodo:
//   1. Vita utile dei ricambi (lifespan.js)
//   2. Elenco dei movimenti diviso in due tab, Depositi e Prelievi, con lo stesso
//      controllo segmentato e lo stesso scambio animato di Cuscinetti/Cinghie/Ricambi.
//      Toccando una riga si espande la scheda con tutti i dettagli del movimento.
//
// Periodi: ultimi 7 / 30 giorni, 3 / 6 / 12 mesi, tutto lo storico, oppure un
// intervallo scelto con il calendario dell'app (date-range-modal.js).
// =============================================================

import { listTransactionsRange, getProductsVersion } from './supabase.js';
import { toastError, toastSuccess, toastWarning } from './toast.js';
import { enhanceSelect } from './ui-select.js';
import { loadLib, emptyStateHtml, staggerIndex, syncSegIndicator } from './ui-utils.js';
import { animateFluidSwap } from './app.js';
import { pickDateRange } from './date-range-modal.js';
import { CATEGORY_LABELS } from './products-shared.js';
import feedback from './feedback.js';
import { refreshLifespan, resetLifespan } from './lifespan.js';

const TABS = ['deposito', 'prelievo'];
const PAGE_SIZE = 40; // righe mostrate per volta; "Mostra altri" ne aggiunge altre
const REVALIDATE_MS = 10 * 60 * 1000;
const CUSTOM_PLACEHOLDER = 'Personalizzato…';

const els = {};
let periodUi = null; // controllo del <select> personalizzato (ui-select.js)
let customRange = null; // { from: Date, to: Date } dell'ultimo periodo personalizzato scelto
let currentPeriod = '30d'; // periodo mostrato adesso
let data = { deposito: [], prelievo: [] };
let shown = { deposito: PAGE_SIZE, prelievo: PAGE_SIZE };
let openId = { deposito: null, prelievo: null }; // riga con il dettaglio aperto (una per elenco)
let activeTab = 'deposito';
let hasLoadedOnce = false;
let swapBusy = false; // true mentre lo scambio animato tra i due elenchi è in corso
let queuedTab = null;

// Caricamento: completo solo la prima volta; poi, al rientro nel Report, si aggiorna in
// silenzio se è cambiato il periodo, il Magazzino (stessa "versione" dei prodotti) o è
// passato troppo tempo.
let reportLoadedOnce = false;
let seenProductsVersion = 0;
let lastLoadedAt = 0;
let refreshSeq = 0;

export function initDashboard() {
  els.periodSelect = document.getElementById('dash-period-select');
  periodUi = enhanceSelect(els.periodSelect);
  els.exportBtn = document.getElementById('dash-export-btn');
  els.seg = document.getElementById('report-seg');
  els.tabs = document.querySelectorAll('[data-report-tab]');
  els.skeleton = document.getElementById('report-skeleton');
  els.lists = document.getElementById('report-lists');
  els.listDeposito = document.getElementById('report-list-deposito');
  els.listPrelievo = document.getElementById('report-list-prelievo');

  els.periodSelect.addEventListener('change', onPeriodChange);
  els.exportBtn?.addEventListener('click', exportReport);
  els.tabs.forEach((btn) => btn.addEventListener('click', () => selectTab(btn.dataset.reportTab)));

  refresh();
}

// --- Periodo --------------------------------------------------------

/** { from, to } in formato ISO (o null) per il periodo indicato. */
function periodRange(period) {
  const now = new Date();
  const d = new Date(now);
  if (period === '7d') d.setDate(now.getDate() - 7);
  else if (period === '30d') d.setDate(now.getDate() - 30);
  else if (period === '3m') d.setMonth(now.getMonth() - 3);
  else if (period === '6m') d.setMonth(now.getMonth() - 6);
  else if (period === '12m') d.setFullYear(now.getFullYear() - 1);
  else if (period === 'custom' && customRange) return { from: customRange.from.toISOString(), to: customRange.to.toISOString() };
  else return { from: null, to: null };
  return { from: d.toISOString(), to: null };
}

const fmtShort = (d) => d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });

function updateCustomOptionLabel() {
  const opt = els.periodSelect.querySelector('option[value="custom"]');
  if (!opt) return;
  opt.textContent = customRange ? `${fmtShort(customRange.from)} – ${fmtShort(customRange.to)}` : CUSTOM_PLACEHOLDER;
  periodUi?.rebuild();
}

async function onPeriodChange() {
  const value = els.periodSelect.value;
  if (value === 'custom') {
    const range = await pickDateRange({ from: customRange?.from, to: customRange?.to });
    if (!range) {
      // Annullato: si torna al periodo che era già mostrato.
      els.periodSelect.value = currentPeriod;
      periodUi?.sync();
      return;
    }
    customRange = range;
    updateCustomOptionLabel();
    periodUi?.sync();
  } else if (value === currentPeriod) {
    return;
  }
  refresh();
}

// --- Caricamento ----------------------------------------------------

/** Con `list-static` sulla vista le righe compaiono già finali (niente animazione a cascata). */
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
  if (!reportLoadedOnce) return refresh();
  const periodChanged = els.periodSelect.value !== currentPeriod;
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
  data = { deposito: [], prelievo: [] };
  hasLoadedOnce = false;
  refreshSeq += 1;
  resetLifespan();
}

async function fetchMovements(range) {
  const rows = await listTransactionsRange({ from: range.from, to: range.to });
  return {
    deposito: rows.filter((r) => r.tipo === 'deposito'),
    prelievo: rows.filter((r) => r.tipo === 'prelievo'),
  };
}

function applyData(next, range) {
  data = next;
  shown = { deposito: PAGE_SIZE, prelievo: PAGE_SIZE };
  openId = { deposito: null, prelievo: null };
  hasLoadedOnce = true;
  renderList('deposito');
  renderList('prelievo');
  markReportLoaded();
  refreshLifespan(range.from, range.to);
}

/** Aggiorna senza scheletro e senza animazioni; se la rete manca restano i dati attuali. */
async function silentRefresh() {
  const seq = ++refreshSeq;
  const period = els.periodSelect.value;
  const range = periodRange(period);
  try {
    const next = await fetchMovements(range);
    if (seq !== refreshSeq) return;
    currentPeriod = period;
    setReportStatic(true);
    applyData(next, range);
  } catch (err) {
    console.warn("Aggiornamento silenzioso del Report non riuscito, resta l'ultimo caricato.", err);
  }
}

export async function refresh() {
  const seq = ++refreshSeq;
  const period = els.periodSelect.value;
  const range = periodRange(period);
  setReportStatic(false); // caricamento "vero": le righe compaiono a cascata

  els.skeleton.classList.remove('hidden');
  els.lists.classList.add('hidden');

  try {
    const next = await fetchMovements(range);
    if (seq !== refreshSeq) return;
    currentPeriod = period;
    applyData(next, range);
  } catch (err) {
    if (seq !== refreshSeq) return;
    console.error(err);
    if (hasLoadedOnce) {
      // Meglio mostrare gli ultimi dati con un avviso che lasciare l'elenco vuoto senza spiegazione.
      renderList('deposito');
      renderList('prelievo');
      toastWarning('Connessione assente: mostro gli ultimi dati caricati.');
    } else {
      const offline = emptyStateHtml('wifi-off', 'Connessione assente', 'Controlla la rete e riprova.');
      els.listDeposito.innerHTML = offline;
      els.listPrelievo.innerHTML = offline;
      window.lucide?.createIcons();
      toastError('Errore nel caricamento della reportistica.');
    }
    // Il periodo mostrato resta quello precedente: la tendina lo rispecchia.
    els.periodSelect.value = currentPeriod;
    periodUi?.sync();
  } finally {
    if (seq === refreshSeq) {
      els.skeleton.classList.add('hidden');
      els.lists.classList.remove('hidden');
      syncSegIndicator(els.seg);
    }
  }
}

// --- Tab Depositi / Prelievi ---------------------------------------

const listEl = (tab) => (tab === 'prelievo' ? els.listPrelievo : els.listDeposito);

function selectTab(tab) {
  if (swapBusy) {
    // Scambio in corso: si ricorda l'ultimo tocco e lo si applica appena finisce.
    queuedTab = tab === activeTab ? null : tab;
    return;
  }
  if (tab === activeTab) return;
  const previous = activeTab;
  activeTab = tab;
  els.tabs.forEach((btn) => btn.classList.toggle('category-tab-active', btn.dataset.reportTab === tab));
  syncSegIndicator(els.seg); // il rettangolo blu scorre lateralmente sul nuovo pulsante

  // L'elenco entrante anima già da sé: niente cascata delle righe sopra lo scambio.
  setReportStatic(true);
  swapBusy = true;
  const forward = TABS.indexOf(tab) > TABS.indexOf(previous);
  animateFluidSwap(
    listEl(previous),
    listEl(tab),
    forward,
    () => {
      swapBusy = false;
      if (queuedTab) {
        const next = queuedTab;
        queuedTab = null;
        if (next !== activeTab) selectTab(next);
      }
    },
    { flat: true }
  );
}

// --- Elenchi --------------------------------------------------------

function renderList(tab) {
  const host = listEl(tab);
  const rows = data[tab];
  host.innerHTML = '';
  if (rows.length === 0) {
    host.innerHTML =
      tab === 'deposito'
        ? emptyStateHtml('package-plus', 'Nessun deposito', 'Non risultano depositi nel periodo selezionato.')
        : emptyStateHtml('package-minus', 'Nessun prelievo', 'Non risultano prelievi nel periodo selezionato.');
    window.lucide?.createIcons();
    return;
  }
  const count = Math.min(shown[tab], rows.length);
  for (let i = 0; i < count; i++) host.appendChild(movementRow(rows[i], i, tab));
  if (rows.length > count) host.appendChild(moreButton(tab, rows.length - count));
  window.lucide?.createIcons();
}

function moreButton(tab, remaining) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.role = 'more';
  btn.className =
    'w-full mt-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide text-xs text-graphite-400 hover:text-graphite-200 hover:bg-graphite-800 transition-colors';
  btn.textContent = `Mostra altri (${remaining})`;
  btn.addEventListener('click', () => {
    const host = listEl(tab);
    const start = Math.min(shown[tab], data[tab].length);
    shown[tab] = start + PAGE_SIZE;
    const end = Math.min(shown[tab], data[tab].length);
    btn.remove();
    for (let i = start; i < end; i++) host.appendChild(movementRow(data[tab][i], i - start, tab));
    if (data[tab].length > end) host.appendChild(moreButton(tab, data[tab].length - end));
    window.lucide?.createIcons();
  });
  return btn;
}

const LINEA_LABELS = { L1: 'Linea 1', L2: 'Linea 2' };

function movementRow(r, i, tab) {
  const date = new Date(r.data_ora);
  const wrap = document.createElement('div');
  wrap.className = 'list-item-in border-b border-graphite-800 last:border-0';
  wrap.style.setProperty('--i', staggerIndex(i));

  const head = document.createElement('button');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');
  head.className = 'w-full flex items-center gap-3 py-2.5 px-1 text-left';
  head.innerHTML = `
    <div class="min-w-0 flex-1">
      <p class="text-sm text-graphite-100 truncate font-medium">${escapeHtml(r.products?.codice_articolo || '—')}</p>
      <p class="ui-note text-graphite-500 mt-0.5 truncate">${escapeHtml(r.profiles?.full_name || 'Utente')} · ${date.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })}</p>
    </div>
    <span class="shrink-0 font-mono text-sm font-semibold px-2.5 py-1 rounded-full ${
      r.tipo === 'deposito' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-300'
    }">${r.tipo === 'deposito' ? '+' : '−'}${r.quantita}</span>
    <i data-lucide="chevron-down" class="movement-chev w-4 h-4 text-graphite-500 shrink-0 transition-transform"></i>
  `;

  const track = document.createElement('div');
  track.className = 'acc-track';
  const inner = document.createElement('div');
  inner.className = 'acc-inner';
  inner.innerHTML = detailCard(r);
  track.appendChild(inner);

  head.addEventListener('click', () => {
    const host = listEl(tab);
    const willOpen = openId[tab] !== r.id;
    openId[tab] = willOpen ? r.id : null;
    // Un solo dettaglio aperto alla volta per elenco.
    host.querySelectorAll('.acc-track.acc-open').forEach((t) => t.classList.remove('acc-open'));
    host.querySelectorAll('.movement-chev').forEach((c) => c.classList.remove('rotate-180'));
    host.querySelectorAll('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (willOpen) {
      track.classList.add('acc-open');
      head.querySelector('.movement-chev')?.classList.add('rotate-180');
      head.setAttribute('aria-expanded', 'true');
    }
  });

  wrap.append(head, track);
  return wrap;
}

/** Scheda di dettaglio: tutte le informazioni registrate per il movimento. */
function detailCard(r) {
  const date = new Date(r.data_ora);
  const p = r.products || {};
  const isDeposito = r.tipo === 'deposito';
  const fields = [
    ['Articolo', p.codice_articolo],
    ['Descrizione', p.punto_utilizzo_standard],
    ['Categoria', CATEGORY_LABELS[p.categoria] || ''],
    ['Quantità', `${isDeposito ? '+' : '−'}${r.quantita}`],
    ['Data e ora', date.toLocaleString('it-IT', { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })],
    ['Operatore', r.profiles?.full_name || 'Utente'],
    ['Scaffale', r.locazione],
    ['Linea', LINEA_LABELS[r.linea] || r.linea],
    ['Macchinario', r.macchinario],
    ['Punto di utilizzo', r.punto_utilizzo_specifico],
    ['Note', r.note],
  ].filter(([, v]) => v);
  return `
    <div class="report-detail rounded-lg bg-graphite-800 border border-graphite-700 mx-1 mb-3 mt-0.5 px-3 py-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
      ${fields
        .map(
          ([label, val]) =>
            `<span class="ui-note text-graphite-500">${escapeHtml(label)}</span><span class="text-sm text-graphite-100 text-right break-words min-w-0">${escapeHtml(val)}</span>`
        )
        .join('')}
    </div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Esportazione ---------------------------------------------------

/** Esporta in Excel i movimenti del periodo corrente: un foglio per i depositi e uno per i prelievi. */
async function exportReport() {
  if (!data.deposito.length && !data.prelievo.length) {
    toastError('Nessun dato da esportare per il periodo selezionato.');
    return;
  }
  try {
    await loadLib('xlsx');
    // eslint-disable-next-line no-undef
    const wb = XLSX.utils.book_new();
    const toRows = (list) =>
      list.map((h) => ({
        Data: new Date(h.data_ora).toLocaleString('it-IT'),
        Articolo: h.products?.codice_articolo || '—',
        Quantità: h.quantita,
        Scaffale: h.locazione || '',
        Linea: h.linea || '',
        Macchinario: h.macchinario || '',
        'Punto utilizzo': h.punto_utilizzo_specifico || '',
        Operatore: h.profiles?.full_name || '',
        Note: h.note || '',
      }));
    // eslint-disable-next-line no-undef
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(toRows(data.deposito)), 'Depositi');
    // eslint-disable-next-line no-undef
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(toRows(data.prelievo)), 'Prelievi');

    const periodLabels = { '7d': '7gg', '30d': '30gg', '3m': '3mesi', '6m': '6mesi', '12m': '12mesi', all: 'storico' };
    const label =
      currentPeriod === 'custom' && customRange
        ? `${customRange.from.toISOString().slice(0, 10)}_${customRange.to.toISOString().slice(0, 10)}`
        : periodLabels[currentPeriod] || currentPeriod;
    // eslint-disable-next-line no-undef
    XLSX.writeFile(wb, `report_magazzino_${label}_${new Date().toISOString().slice(0, 10)}.xlsx`);

    feedback.confirmAction();
    toastSuccess('Report esportato.');
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError("Errore durante l'esportazione del report.");
  }
}
