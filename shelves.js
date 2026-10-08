// =============================================================
// shelves.js — Gestione scaffali (vista Impostazioni, solo Admin)
// Elenco degli scaffali con il numero di articoli associati, modulo per
// aggiungerne di nuovi alla tabella `shelves` del database e pulsante per rimuoverli. Gli scaffali
// registrati compaiono nella tendina "Locazione magazzino" del form articolo.
// =============================================================

import { listShelvesWithCounts, createShelf, deleteShelf, setShelfArea, SHELF_AREAS, DEFAULT_SHELF_AREA, bumpProductsVersion } from './supabase.js';
import { toastSuccess, toastError } from './toast.js';
import { isAdmin } from './auth.js';
import { staggerIndex, setButtonBusy, openOverlay, closeOverlay, enableSheetDrag } from './ui-utils.js';
import { confirmDialog } from './ui-modal.js';
import feedback from './feedback.js';

const els = {};
let tableMissing = false;
let areaMissing = false;
let newShelfArea = DEFAULT_SHELF_AREA;

const AREA_ON = ['bg-amber-400', 'border-amber-400', 'text-white'];
const AREA_OFF = ['bg-graphite-800', 'border-graphite-700', 'text-graphite-300', 'hover:border-amber-400'];

/** Evidenzia nel modulo l'area scelta per il nuovo scaffale */
function paintAreaToggle() {
  els.areaToggle?.querySelectorAll('[data-area]').forEach((btn) => {
    const on = btn.dataset.area === newShelfArea;
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.remove(...(on ? AREA_OFF : AREA_ON));
    btn.classList.add(...(on ? AREA_ON : AREA_OFF));
  });
}

export function initShelves() {
  els.form = document.getElementById('shelf-form');
  els.input = document.getElementById('shelf-name-input');
  els.addBtn = document.getElementById('shelf-add-btn');
  els.notice = document.getElementById('shelves-notice');
  els.noticeDefault = els.notice?.textContent || '';
  els.list = document.getElementById('shelves-list');
  els.skeleton = document.getElementById('shelves-list-skeleton');
  els.form?.addEventListener('submit', handleAdd);
  els.areaToggle = document.getElementById('shelf-area-toggle');
  els.areaToggle?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-area]');
    if (!btn || !SHELF_AREAS.includes(btn.dataset.area)) return;
    newShelfArea = btn.dataset.area;
    paintAreaToggle();
  });
  paintAreaToggle();

  els.modal = document.getElementById('shelves-modal');
  els.manageBtn = document.getElementById('shelves-manage-btn');
  els.closeBtn = document.getElementById('shelves-modal-close');
  els.manageBtn?.addEventListener('click', () => {
    openOverlay(els.modal);
    refreshShelves();
  });
  els.closeBtn?.addEventListener('click', () => closeOverlay(els.modal));
  els.modal?.addEventListener('click', (e) => {
    if (e.target === els.modal) closeOverlay(els.modal);
  });
  enableSheetDrag(els.modal?.querySelector('.modal-panel'), () => closeOverlay(els.modal));
}

export async function refreshShelves() {
  if (!els.list || !isAdmin()) return;
  els.skeleton.classList.remove('hidden');
  els.list.classList.add('hidden');
  try {
    const result = await listShelvesWithCounts();
    tableMissing = result.tableMissing;
    areaMissing = result.areaMissing;
    render(result.shelves);
  } catch (err) {
    console.error(err);
    toastError('Impossibile caricare l\'elenco degli scaffali.');
  } finally {
    els.skeleton.classList.add('hidden');
  }
}

function render(shelves) {
  // Se la tabella non esiste ancora si avvisa e si blocca il modulo: aggiungere non potrebbe funzionare
  els.notice.textContent = els.noticeDefault;
  els.notice.classList.toggle('hidden', !tableMissing);
  els.input.disabled = tableMissing;
  els.addBtn.disabled = tableMissing;
  // Le aree si salvano nella colonna `shelves.area`: finché la migrazione non è stata eseguita si resta in Magazzino
  if (areaMissing && !tableMissing) {
    els.notice.textContent = 'Per usare le aree serve eseguire una volta sql/add_shelves_area.sql su Supabase: nel frattempo tutti gli scaffali risultano in Magazzino.';
    els.notice.classList.remove('hidden');
  }

  els.list.innerHTML = '';
  if (shelves.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-graphite-500 py-2';
    empty.textContent = 'Nessuno scaffale ancora registrato.';
    els.list.appendChild(empty);
  }
  shelves.forEach((sh, i) => {
    const row = document.createElement('div');
    row.className = 'list-item-in card-plate rounded-xl pl-3.5 pr-1.5 py-1.5 flex items-center justify-between gap-2';
    row.style.setProperty('--i', staggerIndex(i));

    const name = document.createElement('span');
    name.className = 'block truncate text-sm font-medium text-graphite-100';
    name.textContent = sh.nome; // testo, mai HTML
    const meta = document.createElement('span');
    meta.className = 'ui-note whitespace-nowrap text-graphite-500';
    meta.textContent = sh.articoli === 1 ? '1 articolo' : `${sh.articoli} articoli`;
    // Area: tocca per passare all'altra (sono due). Gli scaffali non ancora registrati si registrano al primo cambio.
    const areaBtn = document.createElement('button');
    areaBtn.type = 'button';
    areaBtn.disabled = areaMissing;
    areaBtn.setAttribute('aria-label', `Area di ${sh.nome}: ${sh.area}. Tocca per cambiarla`);
    areaBtn.className = 'ui-label inline-flex items-center gap-1 rounded-md border border-graphite-700 px-2 min-h-[32px] font-display font-semibold uppercase tracking-wide text-graphite-300 hover:border-amber-400 transition-colors disabled:opacity-60';
    areaBtn.innerHTML = '<i data-lucide="repeat-2" class="w-3 h-3" stroke-width="2.2"></i><span></span>';
    areaBtn.querySelector('span').textContent = sh.area; // testo, mai HTML
    areaBtn.addEventListener('click', () => handleArea(sh, areaBtn));
    const info = document.createElement('div');
    info.className = 'min-w-0 flex-1';
    const sub = document.createElement('div');
    sub.className = 'flex items-center gap-2 mt-1';
    sub.append(areaBtn, meta);
    info.append(name, sub);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', `Rimuovi lo scaffale ${sh.nome}`);
    removeBtn.className = 'shrink-0 w-11 h-11 rounded-lg flex items-center justify-center text-rose-700 hover:bg-rose-50 transition-colors';
    removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-5 h-5" stroke-width="2"></i>';
    removeBtn.addEventListener('click', () => handleRemove(sh, removeBtn));
    row.append(info, removeBtn);
    els.list.appendChild(row);
  });
  els.list.classList.remove('hidden');
  window.lucide?.createIcons();
}

async function handleArea(shelf, btn) {
  const target = SHELF_AREAS.find((a) => a !== shelf.area) || DEFAULT_SHELF_AREA;
  setButtonBusy(btn, true);
  try {
    await setShelfArea(shelf, target);
    feedback.confirmAction();
    toastSuccess(`"${shelf.nome}" ora è in ${target}.`);
    await refreshShelves();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || 'Impossibile cambiare l\'area.');
    setButtonBusy(btn, false);
  }
}

async function handleRemove(shelf, btn) {
  const usato = shelf.articoli > 0;
  const ok = await confirmDialog({
    title: 'Rimuovere lo scaffale?',
    message: usato
      ? `"${shelf.nome}" è assegnato a ${shelf.articoli} ${shelf.articoli === 1 ? 'articolo' : 'articoli'}: resteranno senza scaffale assegnato. L'operazione non si può annullare.`
      : `"${shelf.nome}" non è assegnato a nessun articolo. Verrà tolto dall'elenco.`,
    confirmLabel: 'Rimuovi',
    danger: true,
  });
  if (!ok) return;
  setButtonBusy(btn, true);
  try {
    const { articoliSvuotati } = await deleteShelf(shelf);
    feedback.deleteAction();
    toastSuccess(
      articoliSvuotati > 0
        ? `Scaffale "${shelf.nome}" rimosso (${articoliSvuotati} ${articoliSvuotati === 1 ? 'articolo aggiornato' : 'articoli aggiornati'}).`
        : `Scaffale "${shelf.nome}" rimosso.`
    );
    if (articoliSvuotati > 0) bumpProductsVersion(); // la lista del Magazzino si aggiorna al rientro
    document.dispatchEvent(new CustomEvent('shelf-removed', { detail: { nome: shelf.nome } }));
    await refreshShelves();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || 'Impossibile rimuovere lo scaffale.');
    setButtonBusy(btn, false);
  }
}

async function handleAdd(e) {
  e.preventDefault();
  const nome = els.input.value;
  setButtonBusy(els.addBtn, true, 'Aggiunta…');
  try {
    const row = await createShelf(nome, newShelfArea);
    els.input.value = '';
    feedback.confirmAction();
    toastSuccess(`Scaffale "${row.nome}" aggiunto in ${newShelfArea}.`);
    await refreshShelves();
  } catch (err) {
    feedback.errorAction();
    toastError(err.message || 'Impossibile aggiungere lo scaffale.');
  } finally {
    if (!tableMissing) setButtonBusy(els.addBtn, false);
  }
}
