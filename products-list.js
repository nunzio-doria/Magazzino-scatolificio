// =============================================================
// products-list.js — Magazzino: vista a scaffalatura e vista per macchina.
// Codice spostato qui pari pari da products.js: stessa logica, stesso
// comportamento, solo riorganizzato in un file più piccolo.
// =============================================================

import { openPicker } from './picker.js';
import { animateFluidSwap } from './app.js';
import { staggerIndex, syncSegIndicator, modalCloseMs } from './ui-utils.js';
import { listDistinctMacchine, getProductLocations, areaOfShelf, SHELF_AREAS } from './supabase.js';
import { els, state, LINEA_OPTIONS, MACHINE_VIEW_CATEGORIES, escapeHtml, shelfLabel, hasMultipleShelves, binIconHtml } from './products-shared.js';
import { refresh } from './products-data.js';
import { openDetail } from './products-detail.js';

const openShelves = new Set(); // locazioni espanse, persiste tra i refresh (una sola alla volta per gruppo, salvo durante la ricerca)
const openGroups = new Set(); // gruppi di scaffali (SA, SB...) espansi: indipendenti tra loro, ognuno si apre/chiude per conto suo
// Cambio scaffale: prima si richiude il vecchio, poi si apre il nuovo. Lo stato (closeEndsAt = istante in cui
// finisce l'ultima chiusura avviata; swapTimer = apertura in attesa, l'ultimo tocco vince) è per ambito:
// ogni gruppo SA/SB... ha il suo, così aprire uno scaffale in SB non interferisce con SA.
const scopes = new Map(); // chiave ambito -> { closeEndsAt, swapTimer }
function scopeOf(key) {
  if (!scopes.has(key)) scopes.set(key, { closeEndsAt: 0, swapTimer: null });
  return scopes.get(key);
}
let followRaf = 0;

/**
 * Uscendo dal Magazzino: al rientro deve essere tutto chiuso (gruppi e scaffali). Si azzera lo stato e
 * si richiudono le schede di scatto (classe shelf-reset-instant ferma per un istante le transizioni),
 * così non si vede nulla richiudersi mentre la sezione sta già uscendo.
 */
export function collapseAllShelves() {
  closeAreaPanel();
  cancelAnimationFrame(followRaf);
  scopes.forEach((sc) => clearTimeout(sc.swapTimer));
  scopes.clear();
  openShelves.clear();
  openGroups.clear();
  openMachines.clear();
  const host = document.getElementById('view-products');
  if (!host) return;
  host.classList.add('shelf-reset-instant');
  host.querySelectorAll('.shelf-card.shelf-open, .shelf-card.shelf-active').forEach((c) => c.classList.remove('shelf-open', 'shelf-active'));
  host.querySelectorAll('.shelf-group.group-open, .shelf-group.group-settled').forEach((g) => g.classList.remove('group-open', 'group-settled'));
  scheduleShelfClip();
  void host.offsetHeight; // applica lo stato chiuso senza transizione, poi si ripristinano le animazioni
  requestAnimationFrame(() => requestAnimationFrame(() => host.classList.remove('shelf-reset-instant')));
}

/**
 * Taglio dell'elenco dietro al banner fermo in alto: la parte di elenco che sta sopra il bordo
 * inferiore del banner viene ritagliata (clip-path), quindi non può mai comparire negli angoli
 * arrotondati né sopra al banner. A riposo (banner non fermo) il taglio è nullo.
 */
const openMachines = new Set(); // macchine espanse, persiste tra i refresh

// --- FILTRO PER AREA -------------------------------------------------------
// Compare solo se tra gli scaffali dell'elenco corrente ci sono più aree. '' = tutte le aree.
let areaFilter = '';
let areasPresent = []; // aree presenti nell'elenco corrente, nell'ordine di SHELF_AREAS

/** Scaffali dell'articolo che rientrano nell'area scelta (tutti se non c'è filtro; con filtro niente "senza scaffale") */
function locationsInArea(p) {
  const locs = getProductLocations(p);
  return areaFilter ? locs.filter((l) => l.locazione && areaOfShelf(l.locazione) === areaFilter) : locs;
}

/** Riallinea freccia, visibilità del selettore, opzioni e chip allo stato dell'elenco corrente */
function syncAreaFilter() {
  const found = new Set();
  for (const p of state.currentList) {
    for (const l of getProductLocations(p)) if (l.locazione) found.add(areaOfShelf(l.locazione));
  }
  areasPresent = SHELF_AREAS.filter((a) => found.has(a));
  const multi = areasPresent.length > 1;
  if (!multi || (areaFilter && !areasPresent.includes(areaFilter))) areaFilter = '';
  if (!multi) closeAreaPanel();

  // Cuscinetti non ha il tab Macchina: con più aree il selettore compare lo stesso, ma solo con Scaffalatura
  const canMachine = MACHINE_VIEW_CATEGORIES.includes(state.currentCategory);
  els.viewModeWrap?.classList.toggle('hidden', !(canMachine || multi));
  els.viewModeTabs.forEach((btn) => {
    const isMachineTab = btn.dataset.viewModeTab === 'machine';
    btn.classList.toggle('hidden', isMachineTab && !canMachine);
    const chev = btn.querySelector('.area-chevron');
    if (chev) chev.hidden = !(multi && btn.dataset.viewModeTab === viewMode);
  });
  els.areaBlock?.classList.toggle('hidden', !multi);
  renderAreaOptions();
  if (els.areaChip) {
    els.areaChip.hidden = !areaFilter;
    if (els.areaChipLabel) els.areaChipLabel.textContent = areaFilter;
  }
  syncSegs();
}

function renderAreaOptions() {
  if (!els.areaOptions) return;
  els.areaOptions.innerHTML = '';
  ['', ...areasPresent].forEach((area) => {
    const on = area === areaFilter;
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.className = `rounded-lg border px-3 text-xs font-display font-semibold uppercase tracking-wide min-h-[44px] transition-colors ${
      on ? 'bg-amber-400 border-amber-400 text-white' : 'bg-graphite-800 border-graphite-700 text-graphite-300 hover:border-amber-400'
    }`;
    b.textContent = area || 'Tutte le aree'; // testo, mai HTML
    b.addEventListener('click', () => applyAreaFilter(area));
    els.areaOptions.appendChild(b);
  });
}

function setAreaPanel(open) {
  if (!els.areaPanel) return;
  els.areaPanel.classList.toggle('area-panel-open', open);
  els.areaPanel.toggleAttribute('inert', !open);
  els.viewModeTabs?.forEach((btn) => {
    if (open) btn.dataset.areaOpen = String(btn.dataset.viewModeTab === viewMode);
    else delete btn.dataset.areaOpen;
  });
}
function closeAreaPanel() {
  setAreaPanel(false);
}
function toggleAreaPanel() {
  setAreaPanel(!els.areaPanel.classList.contains('area-panel-open'));
}

/** Sceglie l'area da mostrare ('' = tutte): la fisarmonica si richiude e l'elenco si ridisegna */
function applyAreaFilter(area) {
  closeAreaPanel();
  if (area === areaFilter) return;
  areaFilter = area;
  setListStatic(false);
  renderCurrentList();
}
let clipRaf = 0;
let clipApplied = false; // true se almeno un taglio è attivo: serve a ripulire quando si richiude
function updateShelfClip() {
  clipRaf = 0;
  const open = document.querySelectorAll('.shelf-card.shelf-open');
  if (!open.length && !clipApplied) return; // nessuno scaffale aperto: niente da fare ad ogni scroll
  if (clipApplied) {
    document.querySelectorAll('.shelf-card:not(.shelf-open) .shelf-body-inner').forEach((el) => {
      if (el.style.clipPath) el.style.clipPath = '';
    });
  }
  // prima tutte le letture, poi le scritture: evita ricalcoli di layout ripetuti
  const updates = [];
  open.forEach((card) => {
    const bar = card.querySelector('.shelf-header-sticky');
    const inner = card.querySelector('.shelf-body-inner');
    if (!bar || !inner) return;
    const cut = bar.getBoundingClientRect().bottom - inner.getBoundingClientRect().top;
    updates.push([inner, cut > 0.5 ? `inset(${cut.toFixed(1)}px 0 0 0)` : '']);
  });
  clipApplied = false;
  updates.forEach(([inner, value]) => {
    if (inner.style.clipPath !== value) inner.style.clipPath = value;
    if (value) clipApplied = true;
  });
}
function scheduleShelfClip() {
  if (!clipRaf) clipRaf = requestAnimationFrame(updateShelfClip);
}
window.addEventListener('scroll', scheduleShelfClip, { passive: true });
window.addEventListener('resize', scheduleShelfClip, { passive: true });

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
    updateShelfClip();
    const target = Math.max(0, Math.round(card.getBoundingClientRect().top + window.scrollY - headerH - 8));
    const diff = target - window.scrollY;
    if (Math.abs(diff) > 0.5) {
      window.scrollTo(0, reduced ? target : window.scrollY + diff * 0.22);
    }
    if (performance.now() < endAt || Math.abs(diff) > 1) followRaf = requestAnimationFrame(step);
  };
  followRaf = requestAnimationFrame(step);
}
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
  els.areaBlock = document.getElementById('product-area-block');
  els.areaPanel = document.getElementById('product-area-panel');
  els.areaOptions = document.getElementById('product-area-options');
  els.areaChip = document.getElementById('product-area-chip');
  els.areaChipLabel = document.getElementById('product-area-chip-label');
  els.areaChip?.addEventListener('click', () => applyAreaFilter(''));
  els.viewModeTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      // Tab già attivo con più aree presenti: apre/chiude la fisarmonica delle aree; altrimenti cambia vista
      if (btn.dataset.viewModeTab === viewMode && areasPresent.length > 1) toggleAreaPanel();
      else {
        closeAreaPanel();
        setViewMode(btn.dataset.viewModeTab);
      }
    });
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
  syncAreaFilter(); // la freccia delle aree passa sul tab appena attivato (e riallinea il selettore)

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
  syncAreaFilter();
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
 * correnti per locazione, una card per scaffale. Un articolo presente su più
 * scaffali compare in ciascuno, con la quantità di quello scaffale.
 */
function renderShelves() {
  const isRicambi = state.currentCategory === 'pezzi_ricambio';
  // Per gli articoli su più scaffali si ricorda anche il totale: la scorta minima vale su quello
  const totHint = (p) => (hasMultipleShelves(p) ? `tot. ${p.quantita_disponibile}` : '');
  renderGroupedCards({
    wrapEl: els.shelfView,
    openSet: openShelves,
    entriesFn: (p) => locationsInArea(p).map((l) => ({ key: l.locazione, qty: l.quantita })),
    titleField: isRicambi ? (p) => p.punto_utilizzo_standard || p.codice_articolo : (p) => p.codice_articolo,
    subtitleFields: isRicambi
      ? (p) => [p.codice_articolo, p.macchina, p.linea, totHint(p)]
      : (p) => [p.macchina, p.punto_utilizzo_standard, p.linea, totHint(p)],
    unassignedLabel: UNASSIGNED_SHELF,
    iconName: 'shelving-unit',
    // Solo per Cuscinetti/Cinghie/Ricambi tecnici: scaffali con la stessa sigla iniziale (SD002,
    // SD003, SD004...) restano ravvicinati, e si stacca visivamente quando la sigla cambia (SE001...).
    seriesFn: isRicambi || state.currentCategory === 'cuscinetti' || state.currentCategory === 'cinghie' ? shelfSeries : null,
  });
}

/** Sigla di serie di una locazione: la parte di lettere iniziale (SD002 → SD, A-12-3 → A). Nessuna lettera iniziale = '' (senza sigla). */
function shelfSeries(key) {
  if (key === UNASSIGNED_SHELF) return '~'; // "Non assegnata" ha un gruppo tutto suo
  const m = String(key).match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : '';
}
const UNASSIGNED_SHELF = 'Non assegnata';

/** Etichetta dell'area (Magazzino / Ufficio tecnico) di uno scaffale; vuota se non c'è area da mostrare */
function areaChipHtml(area) {
  if (!area) return '';
  const cls = area === 'Ufficio tecnico' ? 'shelf-area shelf-area--ufficio' : 'shelf-area';
  return `<span class="${cls} whitespace-nowrap">${escapeHtml(area)}</span>`;
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
    entriesFn: (p) => {
      if (!areaFilter) return [{ key: p.macchina, qty: p.quantita_disponibile }];
      const locs = locationsInArea(p); // con un'area scelta: solo gli articoli presenti lì, con la quantità di quell'area
      return locs.length ? [{ key: p.macchina, qty: locs.reduce((sum, l) => sum + (l.quantita || 0), 0) }] : [];
    },
    titleField: isRicambi ? (p) => p.punto_utilizzo_standard || p.codice_articolo : (p) => p.codice_articolo,
    subtitleFields: isRicambi ? (p) => [p.codice_articolo, shelfLabel(p), p.linea] : (p) => [shelfLabel(p), p.punto_utilizzo_standard, p.linea],
    unassignedLabel: 'Nessuna macchina assegnata',
    iconName: 'wrench',
  });
}

/**
 * Motore condiviso da Scaffalatura e Riordino per macchina: raggruppa
 * state.currentList per una chiave qualsiasi (locazione o macchina; `entriesFn`
 * restituisce, per ogni articolo, le coppie chiave+quantità in cui compare) e disegna
 * una card per gruppo, espandibile al tap sull'header (animazione
 * grid-template-rows in CSS) con un lieve stagger in ingresso sugli
 * articoli. Lo stato aperto/chiuso di ogni gruppo persiste tra i refresh
 * tramite l'openSet passato dal chiamante (Set separati per scaffalatura
 * e macchina, cosí non si mescolano tra loro).
 */
function renderGroupedCards({ wrapEl, openSet, entriesFn, titleField, subtitleFields, unassignedLabel, iconName, seriesFn = null }) {
  wrapEl.innerHTML = '';
  wrapEl.classList.remove('hidden');

  const searching = (els.searchInput?.value || '').trim().length > 0;
  const groups = new Map(); // chiave di raggruppamento -> [{ p: articolo, qty: quantità in quel gruppo }]
  for (const p of state.currentList) {
    for (const entry of entriesFn(p)) {
      const key = entry.key || unassignedLabel;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ p, qty: entry.qty });
    }
  }

  const sortedKeys = [...groups.keys()].sort((a, b) =>
    a.localeCompare(b, 'it', { numeric: true, sensitivity: 'base' })
  );

  // Con seriesFn (Cuscinetti/Cinghie/Ricambi per scaffale) gli scaffali della stessa sigla stanno
  // insieme in un gruppo chiuso "Scaffale SA": un tocco lo espande mostrando tutti gli scaffali.
  // I gruppi sono indipendenti: aprirne uno non chiude gli altri.
  const seriesOfKey = (key) => (seriesFn ? seriesFn(key) : null);
  const groupEls = new Map(); // sigla -> elemento interno dove vanno gli scaffali del gruppo
  const siblingKeys = new Map(); // sigla -> chiavi (scaffali) del gruppo: la regola "uno solo aperto" vale dentro al gruppo
  if (seriesFn) {
    for (const key of sortedKeys) {
      const series = seriesOfKey(key);
      if (!siblingKeys.has(series)) siblingKeys.set(series, []);
      siblingKeys.get(series).push(key);
    }
  }
  const scopeKey = (series) => (seriesFn ? `g:${series}` : 'all');
  // Una sigla con un solo scaffale (es. "Parete frontale", a differenza di SA001, SA002...)
  // non genera il gruppo \"Scaffale ...\": la card dello scaffale sta direttamente nella lista.
  const isSolo = (series) => !!seriesFn && siblingKeys.get(series)?.length === 1;
  const getParent = (series) => {
    if (!seriesFn || isSolo(series)) return wrapEl;
    if (!groupEls.has(series)) {
      const { el, inner } = buildShelfGroup(series, siblingKeys.get(series), groups, unassignedLabel, iconName, searching);
      groupEls.set(series, inner);
      wrapEl.appendChild(el);
    }
    return groupEls.get(series);
  };

  sortedKeys.forEach((key, cardIndex) => {
    const series = seriesOfKey(key);
    const items = groups.get(key);
    const totQty = items.reduce((sum, { qty }) => sum + (qty || 0), 0);
    const lowCount = items.filter(({ p }) => p.quantita_disponibile < p.scorta_minima).length;
    // Durante una ricerca (per codice, descrizione, macchina...) gli scaffali si aprono da soli:
    // il risultato si vede a colpo d'occhio, senza dover aprire ogni scaffale a mano.
    const isOpen = searching || openSet.has(key);

    const itemsHtml = items
      .map(({ p, qty }, i) => {
        // sotto scorta = totale di tutti gli scaffali sotto la scorta minima (non la quantità del singolo scaffale)
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
            }">${qty}</span>
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
            ${iconName === 'shelving-unit' && key !== unassignedLabel && areaOfShelf(key) === 'Ufficio tecnico'
              ? binIconHtml('shelf-ico')
              : `<i data-lucide="${iconName}" class="shelf-ico w-[18px] h-[18px] text-graphite-400" stroke-width="1.8"></i>`}
          </span>
          <div class="min-w-0">
            <p class="shelf-title font-display font-bold uppercase tracking-wide truncate">${escapeHtml(key)}</p>
            <p class="shelf-sub ui-note text-graphite-500 mt-0.5 flex flex-wrap gap-x-2">
              ${iconName === 'shelving-unit' && key !== unassignedLabel ? areaChipHtml(areaOfShelf(key)) : ''}<span class="whitespace-nowrap">${items.length} ${items.length === 1 ? 'articolo' : 'articoli'} · ${totQty} pz</span>${
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
      const scope = scopeOf(scopeKey(series));
      clearTimeout(scope.swapTimer);
      scope.swapTimer = null;

      if (openSet.has(key)) {
        // Già aperto: si richiude e basta.
        openSet.delete(key);
        card.classList.remove('shelf-open', 'shelf-active');
        scope.closeEndsAt = Math.max(scope.closeEndsAt, performance.now() + modalCloseMs());
        return;
      }

      // Un solo scaffale aperto (per gruppo): chiude l'eventuale precedente (tinta e cassetto insieme)...
      // (uno scaffale senza gruppo è indipendente: non chiude gli altri)
      const scopeEl = seriesFn ? card.parentElement : wrapEl;
      const others = isSolo(series)
        ? []
        : scopeEl.querySelectorAll(':scope > .shelf-card.shelf-open, :scope > .shelf-card.shelf-active');
      if (others.length) {
        others.forEach((c) => c.classList.remove('shelf-open', 'shelf-active'));
        scope.closeEndsAt = Math.max(scope.closeEndsAt, performance.now() + modalCloseMs());
      }
      (seriesFn ? siblingKeys.get(series) : [...openSet]).forEach((k) => openSet.delete(k));
      openSet.add(key);

      // ...e la tinta blu del nuovo parte subito dal centro; il cassetto si apre solo
      // quando quello vecchio ha finito di richiudersi.
      card.classList.add('shelf-active');
      const wait = Math.max(0, scope.closeEndsAt - performance.now());
      followCardToTop(card, wait);
      if (wait === 0) {
        card.classList.add('shelf-open');
      } else {
        scope.swapTimer = setTimeout(() => {
          scope.swapTimer = null;
          if (card.isConnected && openSet.has(key)) card.classList.add('shelf-open');
        }, wait);
      }
    });

    // Toccando un articolo si apre la scheda di sola lettura (uguale per tutti); la
    // modifica si raggiunge da lì con il pulsante a matita, riservato all'Admin.
    card.querySelectorAll('.shelf-item').forEach((btn) => {
      const product = items.find(({ p }) => String(p.id) === btn.dataset.productId)?.p;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDetail(product);
      });
      btn.classList.add('hover:bg-graphite-700/30', 'transition-colors');
    });

    getParent(series).appendChild(card);
  });

  window.lucide?.createIcons();
  scheduleShelfClip();
}

/**
 * Gruppo di scaffali con la stessa sigla (SA001, SA002... → "Scaffale SA"): un'unica scheda chiusa;
 * al tocco si espande (stessa animazione a cassetto degli scaffali) mostrando tutti i suoi scaffali.
 * Lo stato aperto/chiuso è in openGroups: i gruppi sono indipendenti, nessuno chiude gli altri.
 * Ritorna l'elemento del gruppo e il contenitore interno dove vanno aggiunti gli scaffali.
 */
function buildShelfGroup(series, keys, groups, unassignedLabel, iconName, searching) {
  const productIds = new Set();
  const lowIds = new Set();
  for (const k of keys) {
    for (const { p } of groups.get(k)) {
      productIds.add(p.id);
      if (p.quantita_disponibile < p.scorta_minima) lowIds.add(p.id);
    }
  }
  const title = series === '~' ? unassignedLabel : series ? `Scaffale ${series}` : 'Senza sigla';
  const shelvesTxt = series === '~' ? '' : `${keys.length} ${keys.length === 1 ? 'scaffale' : 'scaffali'} · `;
  const groupAreasHtml =
    iconName === 'shelving-unit' && series !== '~' ? [...new Set(keys.map((k) => areaOfShelf(k)))].map(areaChipHtml).join('') : '';
  const isOpen = searching || openGroups.has(series);

  const el = document.createElement('div');
  el.className = `list-item-in shelf-group${isOpen ? ' group-open group-settled' : ''}`;
  el.innerHTML = `
    <div class="shelf-group-header flex items-center justify-between gap-3 px-4 py-3.5 border-2 border-graphite-700 rounded-xl">
      <div class="flex items-center gap-3 min-w-0">
        <span class="shelf-ico-box shrink-0 w-9 h-9 rounded-lg bg-graphite-700/50 flex items-center justify-center">
          <i data-lucide="${iconName === 'wrench' ? 'wrench' : 'layers'}" class="shelf-ico w-[18px] h-[18px] text-graphite-400" stroke-width="1.8"></i>
        </span>
        <div class="min-w-0">
          <p class="shelf-title font-display font-bold uppercase tracking-wide truncate">${escapeHtml(title)}</p>
          <p class="shelf-sub ui-note text-graphite-500 mt-0.5 flex flex-wrap gap-x-2">
            ${groupAreasHtml}<span class="whitespace-nowrap">${shelvesTxt}${productIds.size} ${productIds.size === 1 ? 'articolo' : 'articoli'}</span>${
    lowIds.size ? `<span class="shelf-low whitespace-nowrap font-semibold text-rose-700">${lowIds.size} sotto scorta</span>` : ''
  }
          </p>
        </div>
      </div>
      <i data-lucide="chevron-down" class="shelf-chevron w-5 h-5 text-graphite-400 shrink-0" stroke-width="2"></i>
    </div>
    <div class="group-body-track">
      <div class="group-body-inner"><div class="group-shelves space-y-2.5"></div></div>
    </div>
  `;
  const track = el.querySelector('.group-body-track');
  const inner = el.querySelector('.group-shelves');

  // Con il cassetto aperto del tutto il ritaglio (overflow) va tolto: serve perché i banner degli
  // scaffali interni possano restare fermi in alto (sticky) mentre si scorre.
  let settleTimer = null;
  const settle = () => {
    clearTimeout(settleTimer);
    if (el.classList.contains('group-open')) el.classList.add('group-settled');
  };
  track.addEventListener('transitionend', (e) => {
    if (e.target === track && e.propertyName === 'grid-template-rows') settle();
  });

  el.querySelector('.shelf-group-header').addEventListener('click', () => {
    const on = !el.classList.contains('group-open');
    if (!searching) {
      if (on) openGroups.add(series);
      else openGroups.delete(series);
    }
    el.classList.toggle('group-open', on);
    clearTimeout(settleTimer);
    if (on) {
      settleTimer = setTimeout(settle, modalCloseMs() + 120); // ripiego se transitionend non arriva
    } else {
      el.classList.remove('group-settled'); // in chiusura si torna a ritagliare subito
    }
    scheduleShelfClip();
  });
  return { el, inner };
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
