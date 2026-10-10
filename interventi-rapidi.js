// =============================================================
// interventi-rapidi.js — Impostazioni → Interventi rapidi (solo Admin)
// Elenco dei lavori ricorrenti associati a una linea e a una macchina. Nel Blocco Note
// Interventi, scelte linea e macchina, compaiono da soli come scelte rapide.
// =============================================================

import { LINEE, lineaLabel, listRapidi, createRapido, deleteRapido } from './interventi-data.js';
import { listDistinctMacchine } from './supabase.js';
import { invalidateRapidi } from './interventi.js';
import { openPicker } from './picker.js';
import { toastSuccess, toastError, toastWarning } from './toast.js';
import { isAdmin } from './auth.js';
import { staggerIndex, setButtonBusy, openOverlay, closeOverlay, enableSheetDrag, syncSegIndicator } from './ui-utils.js';
import { confirmDialog } from './ui-modal.js';
import feedback from './feedback.js';

const $ = (id) => document.getElementById(id);
const els = {};
let linea = '';
let macchina = '';
let tableMissing = false;

export function initInterventiRapidi() {
  els.modal = $('rapidi-modal');
  els.seg = $('rapidi-linea-seg');
  els.form = $('rapidi-form');
  els.title = $('rapidi-titolo');
  els.addBtn = $('rapidi-add-btn');
  els.list = $('rapidi-list');
  els.skeleton = $('rapidi-skeleton');
  els.notice = $('rapidi-notice');
  if (!els.modal) return;

  $('rapidi-manage-btn')?.addEventListener('click', () => {
    openOverlay(els.modal);
    syncSegIndicator(els.seg);
    refresh();
  });
  $('rapidi-modal-close').addEventListener('click', () => closeOverlay(els.modal));
  els.modal.addEventListener('click', (e) => e.target === els.modal && closeOverlay(els.modal));
  enableSheetDrag(els.modal.querySelector('.modal-panel'), () => closeOverlay(els.modal));

  els.seg.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-linea]');
    if (!btn) return;
    const changed = linea !== btn.dataset.linea;
    linea = btn.dataset.linea;
    feedback.modeSelect();
    if (changed && macchina) {
      // La macchina già scelta deve esistere anche sulla nuova linea
      const onLine = await listDistinctMacchine({ linea }).catch(() => null);
      if (onLine && !onLine.includes(macchina)) {
        macchina = '';
        const v = $('rapidi-macchina-value');
        v.textContent = 'Macchina…';
        v.classList.replace('text-graphite-100', 'text-graphite-400');
      }
    }
    els.seg.querySelectorAll('[data-linea]').forEach((b) => b.classList.toggle('category-tab-active', b.dataset.linea === linea));
    syncSegIndicator(els.seg);
  });

  $('rapidi-macchina-btn').addEventListener('click', async () => {
    let options = [];
    try {
      // Solo le macchine presenti sulla linea scelta (tutte se non ancora scelta)
    options = await listDistinctMacchine({ linea });
    } catch (err) {
      feedback.errorAction();
      toastError('Impossibile caricare l\'elenco delle macchine.');
      return;
    }
    const picked = await openPicker({ title: 'Macchina', options, keepOrder: true, currentValue: macchina });
    if (!picked) return;
    macchina = picked;
    feedback.stepDone();
    const v = $('rapidi-macchina-value');
    v.textContent = macchina;
    v.classList.replace('text-graphite-400', 'text-graphite-100');
  });

  els.form.addEventListener('submit', onAdd);
}

async function refresh() {
  if (!isAdmin()) return;
  els.skeleton.classList.remove('hidden');
  els.list.classList.add('hidden');
  try {
    const res = await listRapidi();
    tableMissing = res.tableMissing;
    render(res.rapidi);
  } catch (err) {
    console.error(err);
    toastError('Impossibile caricare gli interventi rapidi.');
  } finally {
    els.skeleton.classList.add('hidden');
  }
}

function render(rapidi) {
  els.notice.classList.toggle('hidden', !tableMissing);
  els.addBtn.disabled = tableMissing;
  els.title.disabled = tableMissing;
  els.list.innerHTML = '';
  if (!rapidi.length) {
    const p = document.createElement('p');
    p.className = 'text-sm text-graphite-500 py-2';
    p.textContent = 'Nessun intervento rapido ancora registrato.';
    els.list.appendChild(p);
  }
  const order = (v) => LINEE.findIndex((l) => l.value === v);
  const sorted = [...rapidi].sort((a, b) => order(a.linea) - order(b.linea) || a.macchina.localeCompare(b.macchina, 'it') || a.titolo.localeCompare(b.titolo, 'it'));
  let lastKey = '';
  let i = 0;
  sorted.forEach((r) => {
    const key = `${r.linea}|${r.macchina}`;
    if (key !== lastKey) {
      lastKey = key;
      const h = document.createElement('p');
      h.className = 'ui-label font-display font-bold uppercase tracking-wider text-graphite-400 pt-2';
      h.textContent = `${lineaLabel(r.linea)} · ${r.macchina}`; // testo, mai HTML
      els.list.appendChild(h);
    }
    const row = document.createElement('div');
    row.className = 'list-item-in card-plate rounded-xl pl-3.5 pr-1.5 py-1.5 flex items-center justify-between gap-2';
    row.style.setProperty('--i', staggerIndex(i++));
    const name = document.createElement('span');
    name.className = 'min-w-0 text-sm font-medium text-graphite-100';
    name.textContent = r.titolo;
    const del = document.createElement('button');
    del.type = 'button';
    del.setAttribute('aria-label', `Rimuovi ${r.titolo}`);
    del.className = 'shrink-0 w-11 h-11 rounded-lg flex items-center justify-center text-rose-700 hover:bg-rose-50 transition-colors';
    del.innerHTML = '<i data-lucide="trash-2" class="w-5 h-5" stroke-width="2"></i>';
    del.addEventListener('click', () => onRemove(r));
    row.append(name, del);
    els.list.appendChild(row);
  });
  els.list.classList.remove('hidden');
  window.lucide?.createIcons();
}

async function onAdd(e) {
  e.preventDefault();
  const titolo = els.title.value.trim();
  if (!linea || !macchina || !titolo) {
    feedback.errorAction();
    toastWarning('Scegli linea e macchina e scrivi l\'intervento.');
    return;
  }
  setButtonBusy(els.addBtn, true);
  try {
    await createRapido({ linea, macchina, titolo });
    els.title.value = '';
    invalidateRapidi();
    feedback.confirmAction();
    toastSuccess('Intervento rapido aggiunto.', 2000);
    await refresh();
  } catch (err) {
    feedback.errorAction();
    toastError(err.message || 'Impossibile aggiungere l\'intervento rapido.');
  } finally {
    setButtonBusy(els.addBtn, false);
  }
}

async function onRemove(r) {
  const ok = await confirmDialog({ title: 'Rimuovere l\'intervento rapido?', message: `"${r.titolo}" non comparirà più tra le scelte rapide di ${lineaLabel(r.linea)} · ${r.macchina}.`, confirmLabel: 'Rimuovi', danger: true });
  if (!ok) return;
  try {
    await deleteRapido(r.id);
    invalidateRapidi();
    await refresh();
  } catch (err) {
    feedback.errorAction();
    toastError('Impossibile rimuovere l\'intervento rapido.');
  }
}
