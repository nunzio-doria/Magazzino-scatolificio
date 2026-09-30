// =============================================================
// movements.js — Modale "Movimenti" (Admin e Operatore, sola lettura)
// Tutti i depositi/prelievi con tab Tutti/Depositi/Prelievi, chi li ha
// effettuati, e un dettaglio a comparsa (accordion) toccando la riga.
// La cancellazione dei movimenti resta uno strumento distinto, riservato
// all'Admin (Impostazioni → Zona pericolosa → history-admin.js).
// =============================================================

import { listTransactions } from './supabase.js';
import { toastError } from './toast.js';
import { staggerIndex, emptyStateHtml, openOverlay, closeOverlay, enableSheetDrag } from './ui-utils.js';

const els = {};
let rows = [];
let filter = 'tutti'; // 'tutti' | 'deposito' | 'prelievo'
let openId = null; // id della riga con il dettaglio aperto (una sola alla volta)

export function initMovements() {
  els.modal = document.getElementById('movements-modal');
  els.openBtn = document.getElementById('scanner-movements-viewall-btn');
  els.closeBtn = document.getElementById('movements-modal-close');
  els.tabs = document.querySelectorAll('[data-movements-tab]');
  els.skeleton = document.getElementById('movements-list-skeleton');
  els.list = document.getElementById('movements-list');

  els.openBtn?.addEventListener('click', () => {
    openOverlay(els.modal);
    refresh();
  });
  els.closeBtn?.addEventListener('click', () => closeOverlay(els.modal));
  els.modal?.addEventListener('click', (e) => {
    if (e.target === els.modal) closeOverlay(els.modal);
  });
  enableSheetDrag(els.modal?.querySelector('.modal-panel'), () => closeOverlay(els.modal));

  els.tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.movementsTab;
      els.tabs.forEach((b) => b.classList.toggle('history-tab-active', b === btn));
      render();
    });
  });
}

async function refresh() {
  openId = null;
  els.skeleton.classList.remove('hidden');
  els.list.classList.add('hidden');
  try {
    rows = await listTransactions({ limit: 300 });
    render();
  } catch (err) {
    console.error(err);
    els.list.innerHTML = emptyStateHtml('wifi-off', 'Connessione assente', 'Controlla la rete e riprova.');
    toastError('Errore nel caricamento dei movimenti.');
  } finally {
    els.skeleton.classList.add('hidden');
    els.list.classList.remove('hidden');
  }
}

function filtered() {
  if (filter === 'tutti') return rows;
  return rows.filter((r) => r.tipo === filter);
}

function render() {
  const list = filtered();
  els.list.innerHTML = '';
  if (list.length === 0) {
    els.list.innerHTML = emptyStateHtml('inbox', 'Nessun movimento', 'Non risultano movimenti per questo filtro.');
    window.lucide?.createIcons();
    return;
  }
  list.forEach((r, i) => els.list.appendChild(movementRow(r, i)));
  window.lucide?.createIcons();
}

function movementRow(r, i) {
  const date = new Date(r.data_ora);
  const wrap = document.createElement('div');
  wrap.className = 'list-item-in border-b border-graphite-800 last:border-0';
  wrap.style.setProperty('--i', staggerIndex(i));

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'w-full flex items-center gap-3 py-2.5 px-1 text-left';
  head.innerHTML = `
    <div class="min-w-0 flex-1">
      <p class="text-sm text-graphite-100 truncate font-medium">${escapeHtml(r.products?.codice_articolo || '—')}</p>
      <p class="ui-note text-graphite-500 mt-0.5 truncate">${escapeHtml(r.profiles?.full_name || 'Utente')} · ${date.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
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
  const detailRows = [
    ['Punto di utilizzo', r.punto_utilizzo_specifico],
    ['Linea', r.linea],
    ['Macchina', r.macchinario],
    ['Note', r.note],
  ].filter(([, v]) => v);
  inner.innerHTML = `<div class="pl-1 pr-2 pb-3 pt-0.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">${detailRows
    .map(([label, val]) => `<span class="ui-note text-graphite-500">${escapeHtml(label)}</span><span class="text-sm text-graphite-200 truncate">${escapeHtml(val)}</span>`)
    .join('')}</div>${detailRows.length === 0 ? '<p class="ui-note text-graphite-500 pb-3 pl-1">Nessun altro dettaglio.</p>' : ''}`;
  track.appendChild(inner);

  head.addEventListener('click', () => {
    const isOpen = openId === r.id;
    openId = isOpen ? null : r.id;
    // Un solo dettaglio aperto alla volta: si richiudono tutti gli altri accordion visibili.
    els.list.querySelectorAll('.acc-track.acc-open').forEach((t) => t.classList.remove('acc-open'));
    els.list.querySelectorAll('.movement-chev').forEach((c) => c.classList.remove('rotate-180'));
    if (!isOpen) {
      track.classList.add('acc-open');
      head.querySelector('.movement-chev')?.classList.add('rotate-180');
    }
  });

  wrap.append(head, track);
  return wrap;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
