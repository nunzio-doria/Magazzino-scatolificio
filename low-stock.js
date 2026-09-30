// =============================================================
// low-stock.js — Modale "Scorta minima" (Admin e Operatore).
// Esplode gli articoli sotto scorta di Cuscinetti, Cinghie e Ricambi tecnici
// in piastrelle: una per scaffale (Cuscinetti) o per macchina (Cinghie e
// Ricambi tecnici), col numero di articoli in rosso. Toccando una piastrella
// se ne apre il dettaglio sotto, con la piastrella evidenziata (bordo,
// sfondo tenue e segno di spunta) così è chiaro quale sia selezionata.
// =============================================================

import { listProducts } from './supabase.js';
import { toastError } from './toast.js';
import { openOverlay, closeOverlay, enableSheetDrag, staggerIndex } from './ui-utils.js';
import { CATEGORY_LABELS, escapeHtml } from './products-shared.js';

const els = {};
let selected = null; // { key: 'cuscinetti'|'altro', groupName } della piastrella aperta

export function initLowStock() {
  els.modal = document.getElementById('lowstock-modal');
  els.openBtn = document.getElementById('scanner-lowstock-btn');
  els.closeBtn = document.getElementById('lowstock-modal-close');
  els.skeleton = document.getElementById('lowstock-skeleton');
  els.body = document.getElementById('lowstock-body');

  els.openBtn?.addEventListener('click', () => {
    openOverlay(els.modal);
    refresh();
  });
  els.closeBtn?.addEventListener('click', () => closeOverlay(els.modal));
  els.modal?.addEventListener('click', (e) => {
    if (e.target === els.modal) closeOverlay(els.modal);
  });
  enableSheetDrag(els.modal?.querySelector('.modal-panel'), () => closeOverlay(els.modal));
}

async function refresh() {
  selected = null;
  els.skeleton.classList.remove('hidden');
  els.body.classList.add('hidden');
  try {
    const items = await listProducts({ onlyLowStock: true });
    render(items);
  } catch (err) {
    console.error(err);
    toastError('Errore nel caricamento degli articoli in scorta minima.');
  } finally {
    els.skeleton.classList.add('hidden');
    els.body.classList.remove('hidden');
  }
}

/** Raggruppa: Cuscinetti per scaffale (locazione), Cinghie/Ricambi tecnici per macchina. */
function groupBy(items, keyFn) {
  const map = new Map();
  items.forEach((p) => {
    const key = keyFn(p) || 'Non assegnato';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  });
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'it', { numeric: true, sensitivity: 'base' }))
    .map(([name, articoli]) => ({ name, articoli }));
}

function render(items) {
  const cuscinetti = groupBy(
    items.filter((p) => p.categoria === 'cuscinetti'),
    (p) => p.locazione
  );
  const altro = groupBy(
    items.filter((p) => p.categoria !== 'cuscinetti'),
    (p) => p.macchina
  );

  if (items.length === 0) {
    els.body.innerHTML = `
      <div class="flex flex-col items-center text-center py-8">
        <i data-lucide="circle-check" class="w-9 h-9 text-emerald-600 mb-2" stroke-width="1.6"></i>
        <p class="text-sm text-graphite-300 font-medium">Nessun articolo sotto scorta minima.</p>
      </div>`;
    window.lucide?.createIcons();
    return;
  }

  els.body.innerHTML = `
    ${section('cuscinetti', CATEGORY_LABELS.cuscinetti, 'per scaffale', 'box', cuscinetti)}
    ${section('altro', 'Cinghie e ricambi tecnici', 'per macchina', 'cog', altro)}
    <div id="lowstock-detail" class="hidden mt-1 pt-3 border-t border-graphite-800"></div>
  `;

  els.body.querySelectorAll('[data-tile-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tileKey;
      const name = btn.dataset.tileName;
      const isSame = selected && selected.key === key && selected.groupName === name;
      selected = isSame ? null : { key, groupName: name };
      const group = (key === 'cuscinetti' ? cuscinetti : altro).find((g) => g.name === name);
      renderTiles();
      renderDetail(group, key === 'cuscinetti' ? 'Scaffale' : 'Macchina');
    });
  });
  window.lucide?.createIcons();

  function renderTiles() {
    els.body.querySelectorAll('[data-tile-key]').forEach((btn) => {
      const isSelected = selected && selected.key === btn.dataset.tileKey && selected.groupName === btn.dataset.tileName;
      btn.classList.toggle('lowstock-tile-selected', !!isSelected);
      const check = btn.querySelector('.lowstock-tile-check');
      if (check) check.classList.toggle('hidden', !isSelected);
    });
  }
}

function section(key, title, subtitle, icon, groups) {
  if (groups.length === 0) return '';
  return `
    <p class="ui-note font-display font-bold uppercase tracking-wide text-graphite-400 mb-2 mt-3 first:mt-0">${escapeHtml(title)} · ${subtitle}</p>
    <div class="grid grid-cols-2 gap-2 mb-1">
      ${groups
        .map(
          (g, i) => `
        <button type="button" data-tile-key="${key}" data-tile-name="${escapeHtml(g.name)}"
          class="list-item-in lowstock-tile relative card-plate rounded-xl p-3 text-center transition-colors" style="--i:${staggerIndex(i)}">
          <i data-lucide="check" class="lowstock-tile-check hidden absolute top-1.5 left-1.5 w-3.5 h-3.5 text-amber-400" stroke-width="2.6"></i>
          <span class="absolute top-1.5 right-1.5 font-mono text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-700">${g.articoli.length}</span>
          <i data-lucide="${icon}" class="w-5 h-5 mx-auto text-graphite-400"></i>
          <p class="text-xs font-display font-semibold mt-1 truncate">${escapeHtml(g.name)}</p>
        </button>`
        )
        .join('')}
    </div>`;
}

function renderDetail(group, label) {
  const detail = document.getElementById('lowstock-detail');
  if (!detail) return;
  if (!group) {
    detail.classList.add('hidden');
    detail.innerHTML = '';
    return;
  }
  detail.classList.remove('hidden');
  detail.innerHTML = `
    <p class="text-sm font-display font-bold mb-2">${escapeHtml(label)} ${escapeHtml(group.name)}</p>
    <div class="space-y-2">
      ${group.articoli
        .map(
          (p) => `
        <div class="flex items-center justify-between gap-3 py-1.5 border-b border-graphite-800 last:border-0">
          <div class="min-w-0">
            <p class="text-sm text-graphite-100 truncate font-medium">${escapeHtml(p.codice_articolo)}</p>
            <p class="ui-note text-graphite-500 mt-0.5 truncate">${escapeHtml(p.punto_utilizzo_standard || p.macchina || '—')}</p>
          </div>
          <span class="shrink-0 font-mono text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-700">${p.quantita_disponibile} / ${p.scorta_minima}</span>
        </div>`
        )
        .join('')}
    </div>`;
  window.lucide?.createIcons();
}
