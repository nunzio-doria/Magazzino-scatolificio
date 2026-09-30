// =============================================================
// low-stock.js — Scheda "Articoli sotto scorta" (Admin e Operatore).
// Si espande nella stessa tab (fisarmonica, niente modale a cassetto) e mostra
// UNA piastrella per serie di scaffale (SA, SB, SC...) col numero di articoli in
// rosso. Toccando una piastrella la griglia si "apre" subito sotto la sua riga e
// lì compaiono gli articoli, ognuno col suo scaffale preciso (SA002, SA003...).
// Un altro tocco su un'altra piastrella chiude la precedente e apre la nuova;
// un secondo tocco sulla stessa la richiude. Stesse durate e curve del resto
// dell'app (.acc-track, --dur-*, --ease-*).
// =============================================================

import { listProducts } from './supabase.js';
import { toastError } from './toast.js';
import { staggerIndex } from './ui-utils.js';
import { escapeHtml } from './products-shared.js';

const COLS = 2; // piastrelle per riga

const els = {};
let loaded = false;
let openKey = null; // sigla della serie con il dettaglio aperto
let groups = []; // [{ key, articoli }]

export function initLowStock() {
  els.card = document.getElementById('scanner-lowstock-card');
  els.openBtn = document.getElementById('scanner-lowstock-btn');
  els.track = document.getElementById('lowstock-track');
  els.skeleton = document.getElementById('lowstock-skeleton');
  els.body = document.getElementById('lowstock-body');
  if (!els.openBtn || !els.track) return;

  els.openBtn.addEventListener('click', () => {
    const opening = !els.track.classList.contains('acc-open');
    setCardOpen(opening);
    if (opening) refresh();
  });
}

function setCardOpen(open) {
  els.track.classList.toggle('acc-open', open);
  els.card.classList.toggle('lowstock-card-open', open);
  els.openBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

async function refresh() {
  openKey = null;
  // Solo al primo caricamento si mostra lo scheletro; alle aperture successive i dati
  // già presenti restano visibili mentre si aggiornano in silenzio.
  if (!loaded) {
    els.skeleton.classList.remove('hidden');
    els.body.classList.add('hidden');
  }
  try {
    const items = await listProducts({ onlyLowStock: true });
    render(items);
    loaded = true;
  } catch (err) {
    console.error(err);
    toastError('Errore nel caricamento degli articoli in scorta minima.');
  } finally {
    els.skeleton.classList.add('hidden');
    els.body.classList.remove('hidden');
  }
}

/** Sigla di serie di una locazione: lettere iniziali (SA002 → SA, A-12-3 → A). */
function shelfSeries(locazione) {
  const m = String(locazione || '').match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : 'Non assegnato';
}

function buildGroups(items) {
  const map = new Map();
  items.forEach((p) => {
    const key = shelfSeries(p.locazione);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  });
  const cmp = (a, b) => String(a).localeCompare(String(b), 'it', { numeric: true, sensitivity: 'base' });
  return Array.from(map.entries())
    .sort((a, b) => (a[0] === 'Non assegnato') - (b[0] === 'Non assegnato') || cmp(a[0], b[0]))
    .map(([key, articoli]) => ({
      key,
      articoli: articoli.slice().sort((a, b) => cmp(a.locazione || '', b.locazione || '') || cmp(a.codice_articolo, b.codice_articolo)),
    }));
}

function render(items) {
  if (items.length === 0) {
    groups = [];
    els.body.innerHTML = `
      <div class="flex flex-col items-center text-center py-6">
        <i data-lucide="circle-check" class="w-9 h-9 text-emerald-600 mb-2" stroke-width="1.6"></i>
        <p class="text-sm text-graphite-300 font-medium">Nessun articolo sotto scorta minima.</p>
      </div>`;
    window.lucide?.createIcons();
    return;
  }

  groups = buildGroups(items);

  // Una riga di piastrelle per volta, e subito sotto ogni riga uno "slot" a fisarmonica
  // (chiuso) dove comparirà il dettaglio della piastrella toccata in quella riga.
  const rows = [];
  for (let i = 0; i < groups.length; i += COLS) rows.push(groups.slice(i, i + COLS));

  els.body.innerHTML = rows
    .map(
      (row, r) => `
    <div class="grid grid-cols-2 gap-2 mb-2">
      ${row.map((g, c) => tileHtml(g, r * COLS + c)).join('')}
    </div>
    <div class="acc-track lowstock-slot" data-slot-row="${r}">
      <div class="acc-inner"><div class="lowstock-slot-inner"></div></div>
    </div>`
    )
    .join('');

  els.body.querySelectorAll('[data-tile-key]').forEach((btn) => {
    btn.addEventListener('click', () => toggleTile(btn));
  });
  window.lucide?.createIcons();
}

function tileHtml(g, i) {
  return `
    <button type="button" data-tile-key="${escapeHtml(g.key)}" data-tile-row="${Math.floor(i / COLS)}"
      class="list-item-in lowstock-tile relative card-plate rounded-xl p-3 pt-4 text-center" style="--i:${staggerIndex(i)}">
      <i data-lucide="check" class="lowstock-tile-check absolute top-1.5 left-1.5 w-3.5 h-3.5 text-amber-400" stroke-width="2.6"></i>
      <span class="absolute top-1.5 right-1.5 font-mono text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-700">${g.articoli.length}</span>
      <span class="mx-auto w-9 h-9 rounded-lg bg-graphite-700/50 flex items-center justify-center">
        <i data-lucide="shelving-unit" class="w-[18px] h-[18px] text-graphite-400" stroke-width="1.8"></i>
      </span>
      <p class="text-xs font-display font-bold uppercase tracking-wide mt-1.5 truncate">${g.key === 'Non assegnato' ? 'Non assegnato' : 'Scaffale ' + escapeHtml(g.key)}</p>
    </button>`;
}

function slotOf(row) {
  return els.body.querySelector(`.lowstock-slot[data-slot-row="${row}"]`);
}

function toggleTile(btn) {
  const key = btn.dataset.tileKey;
  const row = btn.dataset.tileRow;
  const wasOpen = openKey === key;

  // Chiude quello aperto (se c'è): la sua fisarmonica si richiude mentre la nuova si apre.
  if (openKey !== null) {
    const prevBtn = els.body.querySelector(`[data-tile-key="${CSS.escape(openKey)}"]`);
    if (prevBtn) {
      prevBtn.classList.remove('lowstock-tile-selected');
      const prevSlot = slotOf(prevBtn.dataset.tileRow);
      prevSlot?.classList.remove('acc-open');
    }
  }

  if (wasOpen) {
    openKey = null;
    return;
  }

  openKey = key;
  btn.classList.add('lowstock-tile-selected');
  const slot = slotOf(row);
  const group = groups.find((g) => g.key === key);
  const inner = slot.querySelector('.lowstock-slot-inner');
  inner.innerHTML = detailHtml(group);
  window.lucide?.createIcons();
  void slot.offsetWidth; // reflow: la transizione parte sempre, anche su uno slot appena riempito
  slot.classList.add('acc-open');
}

function detailHtml(group) {
  const title = group.key === 'Non assegnato' ? 'Senza scaffale' : `Scaffale ${escapeHtml(group.key)}`;
  return `
    <div class="lowstock-detail rounded-xl border-2 border-graphite-700 overflow-hidden mb-2">
      <p class="px-4 py-2 ui-note font-display font-bold uppercase tracking-wide text-graphite-400 bg-graphite-800/40">${title} · ${group.articoli.length} ${group.articoli.length === 1 ? 'articolo' : 'articoli'}</p>
      ${group.articoli
        .map(
          (p, i) => `
        <div class="lowstock-item flex items-center justify-between gap-3 px-4 py-2.5 border-t border-graphite-700" style="--i:${i}">
          <div class="min-w-0">
            <p class="text-sm font-display font-bold text-graphite-100 truncate">${escapeHtml(p.codice_articolo)}</p>
            <p class="ui-note text-graphite-500 mt-0.5 truncate">${escapeHtml([p.punto_utilizzo_standard, p.macchina].filter(Boolean).join(' · ') || '—')}</p>
            <p class="ui-note text-graphite-400 mt-0.5 flex items-center gap-1 font-semibold">
              <i data-lucide="shelving-unit" class="w-3 h-3" stroke-width="2"></i>${escapeHtml(p.locazione || 'Non assegnata')}
            </p>
          </div>
          <span class="shrink-0 font-mono text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-700">${p.quantita_disponibile} / ${p.scorta_minima}</span>
        </div>`
        )
        .join('')}
    </div>`;
}
