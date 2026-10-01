// =============================================================
// products-list.js — Magazzino: vista a scaffalatura e vista per macchina.
// Codice spostato qui pari pari da products.js: stessa logica, stesso
// comportamento, solo riorganizzato in un file più piccolo.
// =============================================================

import { listDistinctMacchine } from './supabase.js';
import { openPicker } from './picker.js';
import { animateFluidSwap } from './app.js';
import { staggerIndex, syncSegIndicator, modalCloseMs } from './ui-utils.js';
import { els, state, LINEA_OPTIONS, MACHINE_VIEW_CATEGORIES, escapeHtml } from './products-shared.js';
import { refresh } from './products-data.js';
import { openDetail } from './products-detail.js';

const openShelves = new Set(); // locazioni espanse, persiste tra i refresh (una sola alla volta, salvo durante la ricerca)
// Cambio scaffale: prima si richiude il vecchio, poi si apre il nuovo. closeEndsAt = istante in cui
// finisce l'ultima chiusura avviata; swapTimer = apertura in attesa (l'ultimo tocco vince).
let closeEndsAt = 0;
let swapTimer = null;
let followRaf = 0;

/**
 * Porta la scheda appena aperta con il banner subito sotto l'header dell'app. La posizione finale
 * dipende da ciò che sta sopra (il vecchio scaffale che si richiude) e dalla pagina che cresce
 * mentre il cassetto si apre: invece di calcolarla una volta sola (e sbagliarla), la si
 * ricalcola a ogni fotogramma finché le animazioni non sono concluse. Un tocco/rotella
 * dell'utente interrompe subito l'inseguimento.
 */
function followCardToTop(card, delayMs) {
  cancelAnimationFrame(followRaf);
  const cs = getComputedStyle(document.documentElement);
  const headerH = parseFloat(cs.getPropertyValue('--header-h')) || 56;
  const slowMs = parseFloat(cs.getPropertyValue('--dur-slow')) || 340;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const endAt = performance.now() + delayMs + slowMs + 160;
  let cancelled = false;
  const stop = () => { cancelled = true; };
  ['touchstart', 'wheel', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, stop, { once: true, passive: true }));

  const step = () => {
    if (cancelled || !card.isConnected) return;
    const target = Math.max(0, Math.round(card.getBoundingClientRect().top + window.scrollY - headerH - 8));
    const diff = target - window.scrollY;
    if (Math.abs(diff) > 0.5) {
      window.scrollTo(0, reduced ? target : window.scrollY + diff * 0.22);
    }
    if (performance.now() < endAt || Math.abs(diff) > 1) followRaf = requestAnimationFrame(step);
  };
  followRaf = requestAnimationFrame(step);
}
const openMachines = new Set(); // macchine espanse, persiste tra i refresh
let viewMode = 'shelf'; // 'shelf' | 'machine' — la vista a elenco non esiste più
const VIEW_MODE_ORDER = ['shelf', 'machine']; // determina la direzione della transizione
let viewModeBusy = false; // true mentre una animateFluidSwap tra scaffalatura/macchina è in corso
let queuedViewMode = null; // ultima modalità richiesta mentre viewModeBusy era true

export function initProductsList() {
  els.categoryTabs = document.querySelectorAll('[data-category-tab]');
  els.viewModeTabs = document.querySelectorAll('[data-view-mode-tab]');
  els.categorySeg = document.getElementById('product-category-seg');
  els.viewModeWrap = document.getElementById('product-view-mode-wrap');
  els.shelfView = document.getElementById('product-shelf-view');
  els.machineView = document.getElementById('product-machine-view');
  els.lineaFilterWrap = document.getElementById('product-linea-filter-wrap');
  els.lineaFilterBtn = document.getElementById('product-linea-filter-btn');
  els.lineaFilterValue = document.getElementById('product-linea-filter-value');
  els.macchinaFilterBtn = document.getElementById('product-macchina-filter-btn');
  els.macchinaFilterValue = document.getElementById('product-macchina-filter-value');

  els.lineaFilterBtn?.addEventListener('click', pickLineaFilter);
  els.macchinaFilterBtn?.addEventListener('click', pickMacchinaFilter);
  // Una macchina è stata rimossa dalle Impostazioni: se era il filtro attivo, lo si toglie
  document.addEventListener('machine-removed', (e) => {
    const removed = (e.detail?.nome || '').trim().toLowerCase();
    if (removed && state.macchinaFilterValue.trim().toLowerCase() === removed) {
      state.macchinaFilterValue = '';
      updateFilterLabels();
    }
  });
  els.categoryTabs.forEach((btn) => {
    btn.addEventListener('click', () => setCategory(btn.dataset.categoryTab));
  });
  els.viewModeTabs.forEach((btn) => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.viewModeTab));
  });
}

export function setCategory(category) {
  state.currentCategory = category;
  els.categoryTabs.forEach((btn) => btn.classList.toggle('category-tab-active', btn.dataset.categoryTab === category));

  const showLineaFilter = category === 'cinghie' || category === 'pezzi_ricambio';
  els.lineaFilterWrap.classList.toggle('hidden', !showLineaFilter);
  if (!showLineaFilter) {
    state.lineaFilterValue = '';
    state.macchinaFilterValue = '';
    updateFilterLabels();
  }
  els.searchInput.placeholder = showLineaFilter
    ? 'Cerca per codice, locazione, macchina, punto utilizzo…'
    : 'Cerca per codice o scaffale…';

  // Selettore Scaffalatura/Macchina: solo per le categorie dove l'associazione a una
  // macchina ha senso (cinghie, pezzi di ricambio). I cuscinetti mostrano sempre la
  // scaffalatura, senza selettore.
  const showViewToggle = MACHINE_VIEW_CATEGORIES.includes(category);
  els.viewModeWrap?.classList.toggle('hidden', !showViewToggle);
  if (!showViewToggle && viewMode !== 'shelf') {
    // La categoria appena scelta non supporta il riordino per macchina: si torna
    // silenziosamente alla scaffalatura, senza animazione (cambio di contesto, non
    // un'azione dell'utente sul selettore).
    viewMode = 'shelf';
    els.viewModeTabs.forEach((btn) => btn.classList.toggle('view-mode-tab-active', btn.dataset.viewModeTab === 'shelf'));
  }

  syncSegs();
  refresh();
}

/** Riallinea i rettangoli blu scorrevoli dei due controlli segmentati al pulsante attivo. */
function syncSegs() {
  syncSegIndicator(els.categorySeg);
  syncSegIndicator(els.viewModeWrap);
}

function setViewMode(mode) {
  if (viewModeBusy) {
    // Non tocchiamo stato/UI finché la transizione in corso non è conclusa:
    // farlo subito disallineerebbe la tab selezionata dal contenuto davvero
    // visibile, perché la nuova animazione verrebbe scartata (già in corso
    // quella vecchia) mentre la modalità/tab risulterebbero già aggiornate.
    queuedViewMode = mode === viewMode ? null : mode;
    return;
  }
  if (mode === viewMode) return;
  applyViewMode(mode);
}

function applyViewMode(mode) {
  const previousMode = viewMode;
  viewMode = mode;
  els.viewModeTabs.forEach((btn) => btn.classList.toggle('view-mode-tab-active', btn.dataset.viewModeTab === mode));
  syncSegs();

  if (state.currentList.length === 0) return; // l'empty state resta cosí com'è, nulla da animare

  // Direzione della transizione coerente con l'ordine dei tab: Scaffalatura →
  // Macchina scivola "avanti", il percorso inverso "indietro".
  const forward = VIEW_MODE_ORDER.indexOf(mode) > VIEW_MODE_ORDER.indexOf(previousMode);
  const fromEl = viewModeElement(previousMode);

  // Il contenitore anima già il proprio ingresso (view-fluid-entering): far
  // rifare la stessa cosa a ogni singola card sommerebbe le due animazioni,
  // dando l'impressione che tutto si restringa per poi riassestarsi.
  setListStatic(true);
  renderModeContent(mode);
  const toEl = viewModeElement(mode);

  viewModeBusy = true;
  animateFluidSwap(fromEl, toEl, forward, () => {
    viewModeBusy = false;
    setListStatic(false);
    if (queuedViewMode) {
      const next = queuedViewMode;
      queuedViewMode = null;
      if (next !== viewMode) applyViewMode(next);
    }
  }, { flat: true });
}

function viewModeElement(mode) {
  return mode === 'machine' ? els.machineView : els.shelfView;
}

function renderModeContent(mode) {
  if (mode === 'machine') renderByMachine();
  else renderShelves();
}

// Markup dell'empty state: due varianti, sempre scritte esplicitamente ad
// ogni utilizzo — mai lasciate come markup statico nell'HTML — cosí non
// resta mai "congelato" il messaggio sbagliato da uno stato precedente
// (es. l'avviso di connessione assente che rimane visibile anche quando
// poi una ricerca legittimamente non trova risultati).
const EMPTY_STATE_HTML = `
  <span class="w-14 h-14 rounded-full bg-graphite-800/60 flex items-center justify-center">
    <i data-lucide="package-search" class="w-6 h-6 text-graphite-600" stroke-width="1.6"></i>
  </span>
  <p class="font-display font-semibold text-sm text-graphite-300">Nessun articolo trovato</p>
  <p class="text-xs text-graphite-500 max-w-[220px] text-center leading-relaxed">Prova a modificare la ricerca o i filtri applicati.</p>
`;
const CONNECTION_ERROR_HTML = `
  <span class="w-14 h-14 rounded-full bg-rose-500/10 flex items-center justify-center">
    <i data-lucide="wifi-off" class="w-6 h-6 text-rose-600" stroke-width="1.6"></i>
  </span>
  <p class="font-display font-semibold text-sm text-graphite-300">Connessione assente</p>
  <p class="text-xs text-graphite-500 max-w-[220px] text-center leading-relaxed">Controlla la rete e riprova.</p>
`;

/** Con `list-static` sulla vista gli elementi dell'elenco compaiono già al loro posto (niente animazione d'ingresso). */
export function setListStatic(on) {
  document.getElementById('view-products')?.classList.toggle('list-static', on);
}

/**
 * Ridisegna l'elenco a partire da state.currentList. `opts.connectionError`
 * mostra l'avviso "connessione assente" invece del generico "nessun
 * articolo trovato" quando currentList è vuoto perché l'ultimo caricamento
 * è fallito e non c'era già nulla in memoria da poter mostrare al suo posto
 * (vedi products-data.js → refresh).
 */
export function renderCurrentList(opts = {}) {
  els.shelfView.classList.add('hidden');
  els.machineView.classList.add('hidden');
  els.emptyState.classList.add('hidden');

  if (opts.connectionError) {
    els.emptyState.innerHTML = CONNECTION_ERROR_HTML;
    els.emptyState.classList.remove('hidden');
    window.lucide?.createIcons();
    return;
  }

  if (state.currentList.length === 0) {
    els.emptyState.innerHTML = EMPTY_STATE_HTML;
    els.emptyState.classList.remove('hidden');
    window.lucide?.createIcons();
    return;
  }

  renderModeContent(viewMode);
}

/**
 * Vista "scaffalatura": raggruppa gli articoli della categoria/filtri
 * correnti per locazione, una card per scaffale.
 */
function renderShelves() {
  const isRicambi = state.currentCategory === 'pezzi_ricambio';
  renderGroupedCards({
    wrapEl: els.shelfView,
    openSet: openShelves,
    groupKeyFn: (p) => p.locazione,
    titleField: isRicambi ? (p) => p.punto_utilizzo_standard || p.codice_articolo : (p) => p.codice_articolo,
    subtitleFields: isRicambi ? (p) => [p.codice_articolo, p.macchina, p.linea] : (p) => [p.macchina, p.punto_utilizzo_standard, p.linea],
    unassignedLabel: 'Non assegnata',
    iconName: 'shelving-unit',
    // Solo per Cuscinetti/Cinghie/Ricambi tecnici: scaffali con la stessa sigla iniziale (SD002,
    // SD003, SD004...) restano ravvicinati, e si stacca visivamente quando la sigla cambia (SE001...).
    seriesFn: isRicambi || state.currentCategory === 'cuscinetti' || state.currentCategory === 'cinghie' ? shelfSeries : null,
  });
}

/** Sigla di serie di una locazione: la parte di lettere iniziale (SD002 → SD, A-12-3 → A). Nessuna lettera iniziale = nessuna serie. */
function shelfSeries(key) {
  const m = String(key).match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Vista "riordino per macchina": stessa logica della scaffalatura ma
 * raggruppata per macchina invece che per locazione — mostra a colpo
 * d'occhio cosa serve riassortire per ciascuna macchina di produzione.
 * Disponibile solo per le categorie in MACHINE_VIEW_CATEGORIES.
 */
function renderByMachine() {
  const isRicambi = state.currentCategory === 'pezzi_ricambio';
  renderGroupedCards({
    wrapEl: els.machineView,
    openSet: openMachines,
    groupKeyFn: (p) => p.macchina,
    titleField: isRicambi ? (p) => p.punto_utilizzo_standard || p.codice_articolo : (p) => p.codice_articolo,
    subtitleFields: isRicambi ? (p) => [p.codice_articolo, p.locazione, p.linea] : (p) => [p.locazione, p.punto_utilizzo_standard, p.linea],
    unassignedLabel: 'Nessuna macchina assegnata',
    iconName: 'wrench',
  });
}

/**
 * Motore condiviso da Scaffalatura e Riordino per macchina: raggruppa
 * state.currentList per una chiave qualsiasi (locazione o macchina) e disegna
 * una card per gruppo, espandibile al tap sull'header (animazione
 * grid-template-rows in CSS) con un lieve stagger in ingresso sugli
 * articoli. Lo stato aperto/chiuso di ogni gruppo persiste tra i refresh
 * tramite l'openSet passato dal chiamante (Set separati per scaffalatura
 * e macchina, cosí non si mescolano tra loro).
 */
function renderGroupedCards({ wrapEl, openSet, groupKeyFn, titleField, subtitleFields, unassignedLabel, iconName, seriesFn = null }) {
  wrapEl.innerHTML = '';
  wrapEl.classList.remove('hidden');

  const searching = (els.searchInput?.value || '').trim().length > 0;
  const groups = new Map(); // chiave di raggruppamento -> prodotti
  for (const p of state.currentList) {
    const key = groupKeyFn(p) || unassignedLabel;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) =>
    a.localeCompare(b, 'it', { numeric: true, sensitivity: 'base' })
  );

  let lastSeries; // undefined = non ancora iniziato (niente separatore prima della primissima card)
  sortedKeys.forEach((key, cardIndex) => {
    if (seriesFn) {
      const series = seriesFn(key);
      if (lastSeries !== undefined && series !== lastSeries) wrapEl.appendChild(buildSeriesDivider(series));
      lastSeries = series;
    }
    const items = groups.get(key);
    const totQty = items.reduce((sum, p) => sum + (p.quantita_disponibile || 0), 0);
    const lowCount = items.filter((p) => p.quantita_disponibile < p.scorta_minima).length;
    // Durante una ricerca (per codice, descrizione, macchina...) gli scaffali si aprono da soli:
    // il risultato si vede a colpo d'occhio, senza dover aprire ogni scaffale a mano.
    const isOpen = searching || openSet.has(key);

    const itemsHtml = items
      .map((p, i) => {
        const lowStock = p.quantita_disponibile < p.scorta_minima;
        const subtitleParts = subtitleFields(p).filter(Boolean);
        return `
          <button type="button" data-product-id="${p.id}" style="--i:${i}"
            class="shelf-item w-full text-left flex items-center justify-between gap-3 px-4 py-2.5 border-t border-graphite-700 first:border-t-0">
            <div class="min-w-0">
              <p class="font-display font-bold text-graphite-100 truncate text-sm">${escapeHtml(titleField(p))}</p>
              ${subtitleParts.length ? `<p class="ui-note text-graphite-500 mt-0.5 truncate">${escapeHtml(subtitleParts.join(' · '))}</p>` : ''}
            </div>
            <span class="shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-mono font-semibold ${
              lowStock ? 'bg-rose-500/15 text-rose-700' : 'bg-graphite-700 text-graphite-200'
            }">${p.quantita_disponibile}</span>
          </button>
        `;
      })
      .join('');

    const card = document.createElement('div');
    card.className = `list-item-in shelf-card card-plate rounded-xl${isOpen ? ' shelf-open shelf-active' : ''}`;
    card.style.setProperty('--i', staggerIndex(cardIndex));
    card.innerHTML = `
      <div class="shelf-header-sticky"><div class="shelf-header flex items-center justify-between gap-3 px-4 py-3.5 border-2 border-graphite-700 rounded-xl">
        <div class="flex items-center gap-3 min-w-0">
          <span class="shelf-ico-box shrink-0 w-9 h-9 rounded-lg bg-graphite-700/50 flex items-center justify-center">
            <i data-lucide="${iconName}" class="shelf-ico w-[18px] h-[18px] text-graphite-400" stroke-width="1.8"></i>
          </span>
          <div class="min-w-0">
            <p class="shelf-title font-display font-bold uppercase tracking-wide truncate">${escapeHtml(key)}</p>
            <p class="shelf-sub ui-note text-graphite-500 mt-0.5 flex flex-wrap gap-x-2">
              <span class="whitespace-nowrap">${items.length} ${items.length === 1 ? 'articolo' : 'articoli'} · ${totQty} pz</span>${
      lowCount ? `<span class="shelf-low whitespace-nowrap font-semibold text-rose-700">${lowCount} sotto scorta</span>` : ''
    }
            </p>
          </div>
        </div>
        <i data-lucide="chevron-down" class="shelf-chevron w-5 h-5 text-graphite-400 shrink-0" stroke-width="2"></i>
      </div></div>
      <div class="shelf-body-track">
        <div class="shelf-body-inner">${itemsHtml}</div>
      </div>
    `;

    card.querySelector('.shelf-header').addEventListener('click', () => {
      // Durante la ricerca tutti i risultati sono già aperti: ognuno si apre/chiude per conto suo.
      if (searching) {
        const on = !card.classList.contains('shelf-open');
        card.classList.toggle('shelf-open', on);
        card.classList.toggle('shelf-active', on);
        return;
      }
      clearTimeout(swapTimer);
      swapTimer = null;

      if (openSet.has(key)) {
        // Già aperto: si richiude e basta.
        openSet.delete(key);
        card.classList.remove('shelf-open', 'shelf-active');
        closeEndsAt = Math.max(closeEndsAt, performance.now() + modalCloseMs());
        return;
      }

      // Un solo scaffale aperto: chiude l'eventuale precedente (tinta e cassetto insieme)...
      const others = wrapEl.querySelectorAll('.shelf-card.shelf-open, .shelf-card.shelf-active');
      if (others.length) {
        others.forEach((c) => c.classList.remove('shelf-open', 'shelf-active'));
        closeEndsAt = Math.max(closeEndsAt, performance.now() + modalCloseMs());
      }
      openSet.clear();
      openSet.add(key);

      // ...e la tinta blu del nuovo parte subito dal centro; il cassetto si apre solo
      // quando quello vecchio ha finito di richiudersi.
      card.classList.add('shelf-active');
      const wait = Math.max(0, closeEndsAt - performance.now());
      followCardToTop(card, wait);
      if (wait === 0) {
        card.classList.add('shelf-open');
      } else {
        swapTimer = setTimeout(() => {
          swapTimer = null;
          if (card.isConnected && openSet.has(key)) card.classList.add('shelf-open');
        }, wait);
      }
    });

    // Toccando un articolo si apre la scheda di sola lettura (uguale per tutti); la
    // modifica si raggiunge da lì con il pulsante a matita, riservato all'Admin.
    card.querySelectorAll('.shelf-item').forEach((btn) => {
      const product = items.find((p) => String(p.id) === btn.dataset.productId);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDetail(product);
      });
      btn.classList.add('hover:bg-graphite-700/30', 'transition-colors');
    });

    wrapEl.appendChild(card);
  });

  window.lucide?.createIcons();
}

/**
 * Separatore tra una serie e la successiva (es. SD... → SE...): un'etichetta con la
 * sigla e una linea, più uno spazio verticale extra (margin-top maggiore del normale
 * space-y-2.5 della lista) per staccare visivamente il gruppo che segue.
 */
function buildSeriesDivider(series) {
  const el = document.createElement('div');
  el.className = 'shelf-series-divider flex items-center gap-2 px-1';
  el.innerHTML = `
    <span class="shrink-0 text-[11px] font-display font-bold uppercase tracking-wide text-graphite-500">${series ? `Serie ${escapeHtml(series)}` : 'Senza sigla'}</span>
    <span class="flex-1 h-px bg-graphite-800"></span>
  `;
  return el;
}

async function pickLineaFilter() {
  const val = await openPicker({
    title: 'Filtra per linea',
    options: LINEA_OPTIONS,
    allowCustom: false,
    currentValue: state.lineaFilterValue,
  });
  if (val === null) return; // annullato
  state.lineaFilterValue = val;
  updateFilterLabels();
  refresh();
}

async function pickMacchinaFilter() {
  let options = [];
  try {
    options = await listDistinctMacchine();
  } catch (err) {
    console.warn('Impossibile caricare l\'elenco delle macchine registrate.', err);
  }
  const val = await openPicker({
    title: 'Filtra per macchina',
    options,
    allowCustom: false,
    currentValue: state.macchinaFilterValue,
  });
  if (val === null) return; // annullato
  state.macchinaFilterValue = val;
  updateFilterLabels();
  refresh();
}

function updateFilterLabels() {
  if (els.lineaFilterValue) {
    els.lineaFilterValue.textContent = state.lineaFilterValue || 'Tutte le linee';
    els.lineaFilterValue.classList.toggle('text-graphite-400', !state.lineaFilterValue);
    els.lineaFilterValue.classList.toggle('text-graphite-100', !!state.lineaFilterValue);
  }
  if (els.macchinaFilterValue) {
    els.macchinaFilterValue.textContent = state.macchinaFilterValue || 'Tutte le macchine';
    els.macchinaFilterValue.classList.toggle('text-graphite-400', !state.macchinaFilterValue);
    els.macchinaFilterValue.classList.toggle('text-graphite-100', !!state.macchinaFilterValue);
  }
}
