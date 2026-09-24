// =============================================================
// machines.js — Gestione macchine (vista Impostazioni, solo Admin)
// Elenco delle macchine con il numero di articoli associati, modulo per
// aggiungerne di nuove alla tabella `machines` del database e pulsante per rimuoverle. Le macchine
// registrate compaiono nel form articolo e nel filtro "per macchina".
// =============================================================

import { listMachinesWithCounts, createMachine, deleteMachine, bumpProductsVersion, uploadMachineManual, deleteMachineManual, uploadOperatorManual, deleteOperatorManual } from './supabase.js';
import { toastSuccess, toastError } from './toast.js';
import { isAdmin } from './auth.js';
import { staggerIndex, setButtonBusy, openOverlay, closeOverlay, enableSheetDrag } from './ui-utils.js';
import { confirmDialog } from './ui-modal.js';
import { refreshManualsCache, getManualsForMachine, getOperatorManualsForMachine, openManualViewer } from './manuals.js';
import feedback from './feedback.js';

// Stesse opzioni del campo "Linea" nel form articolo (products.js): un
// manuale può essere caricato per ognuna, oppure come "Generale" (vale per
// la macchina a prescindere dalla linea del pezzo).
const LINEA_SLOTS = [
  { value: '', label: 'Generale' },
  { value: 'L1', label: 'Linea 1' },
  { value: 'L2', label: 'Linea 2' },
  { value: 'L1-L2', label: 'Linea 1-2' },
];

const els = {};
let tableMissing = false;

export function initMachines() {
  els.form = document.getElementById('machine-form');
  els.input = document.getElementById('machine-name-input');
  els.addBtn = document.getElementById('machine-add-btn');
  els.notice = document.getElementById('machines-notice');
  els.list = document.getElementById('machines-list');
  els.skeleton = document.getElementById('machines-list-skeleton');
  els.form?.addEventListener('submit', handleAdd);

  els.modal = document.getElementById('machines-modal');
  els.manageBtn = document.getElementById('machines-manage-btn');
  els.closeBtn = document.getElementById('machines-modal-close');
  els.manageBtn?.addEventListener('click', () => {
    openOverlay(els.modal);
    refreshMachines();
  });
  els.closeBtn?.addEventListener('click', () => closeOverlay(els.modal));
  els.modal?.addEventListener('click', (e) => {
    if (e.target === els.modal) closeOverlay(els.modal);
  });
  enableSheetDrag(els.modal?.querySelector('.modal-panel'), () => closeOverlay(els.modal));
}

export async function refreshMachines() {
  if (!els.list || !isAdmin()) return;
  els.skeleton.classList.remove('hidden');
  els.list.classList.add('hidden');
  try {
    const [result] = await Promise.all([listMachinesWithCounts(), refreshManualsCache()]);
    tableMissing = result.tableMissing;
    render(result.machines);
  } catch (err) {
    console.error(err);
    toastError('Impossibile caricare l\'elenco delle macchine.');
  } finally {
    els.skeleton.classList.add('hidden');
  }
}

function render(machines) {
  // Se la tabella non esiste ancora si avvisa e si blocca il modulo: aggiungere non potrebbe funzionare
  els.notice.classList.toggle('hidden', !tableMissing);
  els.input.disabled = tableMissing;
  // Il grigiore arriva dalla regola globale su :disabled, non serve una classe manuale qui.
  els.addBtn.disabled = tableMissing;

  els.list.innerHTML = '';
  if (machines.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-graphite-500 py-2';
    empty.textContent = 'Nessuna macchina ancora registrata.';
    els.list.appendChild(empty);
  }
  machines.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'list-item-in card-plate rounded-xl pl-3.5 pr-1.5 py-1.5';
    row.style.setProperty('--i', staggerIndex(i));

    const topLine = document.createElement('div');
    topLine.className = 'flex items-center justify-between gap-2';
    const name = document.createElement('span');
    name.className = 'min-w-0 truncate text-sm font-medium text-graphite-100';
    name.textContent = m.nome; // testo, mai HTML
    const meta = document.createElement('span');
    meta.className = 'shrink-0 ui-note whitespace-nowrap text-graphite-500';
    meta.textContent = m.articoli === 1 ? '1 articolo' : `${m.articoli} articoli`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', `Rimuovi la macchina ${m.nome}`);
    removeBtn.className = 'shrink-0 w-11 h-11 rounded-lg flex items-center justify-center text-rose-700 hover:bg-rose-50 transition-colors';
    removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-5 h-5" stroke-width="2"></i>';
    removeBtn.addEventListener('click', () => handleRemove(m, removeBtn));
    topLine.append(name, meta, removeBtn);
    row.appendChild(topLine);

    row.appendChild(buildManualRow(m));
    els.list.appendChild(row);
  });
  els.list.classList.remove('hidden');
  window.lucide?.createIcons();
}

/** Riga secondaria con i manuali ricambi (uno per linea, o "Generale") e i manuali operatore (più di uno) di una macchina, con i relativi controlli (solo Admin). */
function buildManualRow(machine) {
  const wrap = document.createElement('div');
  wrap.className = 'mt-1 pt-1.5 border-t border-graphite-800/70 space-y-1';

  if (!machine.id) {
    // Macchina "storica" (solo testo su qualche articolo, mai registrata in tabella): non
    // può avere un manuale finché non viene registrata con lo stesso nome tramite il form sopra.
    const note = document.createElement('p');
    note.className = 'ui-note text-graphite-600 italic';
    note.textContent = 'Registrala per allegare un manuale';
    wrap.appendChild(note);
    return wrap;
  }

  const spareLabel = document.createElement('p');
  spareLabel.className = 'ui-note font-semibold uppercase tracking-wide text-graphite-500';
  spareLabel.textContent = 'Manuali ricambi';
  wrap.appendChild(spareLabel);

  const manuals = getManualsForMachine(machine.id); // Map<linea, riga>
  LINEA_SLOTS.forEach((slot) => {
    wrap.appendChild(buildManualSlotRow(machine, slot, manuals.get(slot.value) || null));
  });

  wrap.appendChild(buildOperatorManualsSection(machine));

  return wrap;
}

/** Sezione "Manuali operatore": elenco libero (0, 1 o più file) con pulsante "Aggiungi" per caricarne altri. */
function buildOperatorManualsSection(machine) {
  const section = document.createElement('div');
  section.className = 'pt-2 mt-1 border-t border-graphite-800/70 space-y-1';

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between gap-2';
  const label = document.createElement('p');
  label.className = 'ui-note font-semibold uppercase tracking-wide text-graphite-500';
  label.textContent = 'Manuali operatore';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.setAttribute('aria-label', `Aggiungi manuale operatore per ${machine.nome}`);
  addBtn.className = 'shrink-0 flex items-center gap-1 text-xs font-display font-semibold uppercase tracking-wide text-amber-300 hover:text-amber-200 px-1.5 py-1 rounded-md hover:bg-graphite-800 transition-colors';
  addBtn.innerHTML = '<i data-lucide="plus" class="w-3.5 h-3.5" stroke-width="2.4"></i> Aggiungi';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/pdf';
  fileInput.className = 'hidden';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) handleUploadOperatorManual(machine, file, addBtn);
  });
  addBtn.addEventListener('click', () => fileInput.click());
  header.append(label, addBtn, fileInput);
  section.appendChild(header);

  const manuals = getOperatorManualsForMachine(machine.id); // Array, nessun limite
  if (manuals.length === 0) {
    const none = document.createElement('p');
    none.className = 'ui-note italic text-graphite-600';
    none.textContent = 'nessun manuale operatore caricato';
    section.appendChild(none);
  } else {
    manuals.forEach((manual) => section.appendChild(buildOperatorManualItemRow(machine, manual)));
  }

  return section;
}

function buildOperatorManualItemRow(machine, manual) {
  const row = document.createElement('div');
  row.className = 'flex items-center justify-between gap-2';

  const info = document.createElement('span');
  info.className = 'min-w-0 flex-1 flex items-center gap-1.5 ui-note text-graphite-500 truncate';
  info.insertAdjacentHTML('beforeend', '<i data-lucide="file-text" class="w-3.5 h-3.5 shrink-0 text-graphite-500"></i>');
  const fname = document.createElement('span');
  fname.className = 'truncate';
  fname.textContent = manual.file_name;
  info.appendChild(fname);

  const actions = document.createElement('div');
  actions.className = 'shrink-0 flex items-center gap-1';

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.setAttribute('aria-label', `Apri manuale operatore ${manual.file_name} di ${machine.nome}`);
  viewBtn.className = 'w-9 h-9 rounded-lg flex items-center justify-center text-graphite-400 hover:text-amber-300 hover:bg-graphite-800 transition-colors';
  viewBtn.innerHTML = '<i data-lucide="eye" class="w-4 h-4" stroke-width="2"></i>';
  viewBtn.addEventListener('click', () => openManualViewer(manual));
  actions.appendChild(viewBtn);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.setAttribute('aria-label', `Elimina manuale operatore ${manual.file_name} di ${machine.nome}`);
  removeBtn.className = 'w-9 h-9 rounded-lg flex items-center justify-center text-rose-700 hover:bg-rose-50 transition-colors';
  removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4" stroke-width="2"></i>';
  removeBtn.addEventListener('click', () => handleRemoveOperatorManual(machine, manual, removeBtn));
  actions.appendChild(removeBtn);

  row.append(info, actions);
  return row;
}

function buildManualSlotRow(machine, slot, manual) {
  const row = document.createElement('div');
  row.className = 'flex items-center justify-between gap-2';

  const info = document.createElement('span');
  info.className = 'min-w-0 flex-1 flex items-center gap-1.5 ui-note text-graphite-500 truncate';
  const label = document.createElement('span');
  label.className = 'shrink-0 font-semibold text-graphite-400';
  label.textContent = `${slot.label}:`;
  info.appendChild(label);
  if (manual) {
    info.insertAdjacentHTML('beforeend', '<i data-lucide="file-text" class="w-3.5 h-3.5 shrink-0 text-graphite-500"></i>');
    const fname = document.createElement('span');
    fname.className = 'truncate';
    fname.textContent = manual.file_name;
    info.appendChild(fname);
  } else {
    const none = document.createElement('span');
    none.className = 'truncate italic';
    none.textContent = 'nessun manuale';
    info.appendChild(none);
  }

  const actions = document.createElement('div');
  actions.className = 'shrink-0 flex items-center gap-1';

  if (manual) {
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.setAttribute('aria-label', `Apri manuale ${slot.label} di ${machine.nome}`);
    viewBtn.className = 'w-9 h-9 rounded-lg flex items-center justify-center text-graphite-400 hover:text-amber-300 hover:bg-graphite-800 transition-colors';
    viewBtn.innerHTML = '<i data-lucide="eye" class="w-4 h-4" stroke-width="2"></i>';
    viewBtn.addEventListener('click', () => openManualViewer(manual));
    actions.appendChild(viewBtn);
  }

  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.setAttribute('aria-label', manual ? `Sostituisci manuale ${slot.label} di ${machine.nome}` : `Carica manuale ${slot.label} per ${machine.nome}`);
  uploadBtn.title = manual ? 'Sostituisci manuale' : 'Carica manuale PDF';
  uploadBtn.className = 'w-9 h-9 rounded-lg flex items-center justify-center text-graphite-400 hover:text-amber-300 hover:bg-graphite-800 transition-colors';
  uploadBtn.innerHTML = `<i data-lucide="${manual ? 'replace' : 'upload'}" class="w-4 h-4" stroke-width="2"></i>`;
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/pdf';
  fileInput.className = 'hidden';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) handleUploadManual(machine, slot, file, uploadBtn);
  });
  uploadBtn.addEventListener('click', () => fileInput.click());
  actions.append(uploadBtn, fileInput);

  if (manual) {
    const removeManualBtn = document.createElement('button');
    removeManualBtn.type = 'button';
    removeManualBtn.setAttribute('aria-label', `Elimina manuale ${slot.label} di ${machine.nome}`);
    removeManualBtn.title = 'Elimina manuale';
    removeManualBtn.className = 'w-9 h-9 rounded-lg flex items-center justify-center text-rose-700 hover:bg-rose-50 transition-colors';
    removeManualBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4" stroke-width="2"></i>';
    removeManualBtn.addEventListener('click', () => handleRemoveManual(machine, slot, manual, removeManualBtn));
    actions.appendChild(removeManualBtn);
  }

  row.append(info, actions);
  return row;
}

async function handleUploadManual(machine, slot, file, btn) {
  setButtonBusy(btn, true);
  try {
    await uploadMachineManual(machine.id, slot.value, file);
    feedback.confirmAction();
    toastSuccess(`Manuale "${slot.label}" caricato per "${machine.nome}".`);
    await refreshMachines();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || 'Impossibile caricare il manuale.');
    setButtonBusy(btn, false);
  }
}

async function handleRemoveManual(machine, slot, manual, btn) {
  const ok = await confirmDialog({
    title: 'Eliminare il manuale?',
    message: `Il manuale "${slot.label}" (${manual.file_name}) collegato a "${machine.nome}" verrà eliminato. L'operazione non si può annullare.`,
    confirmLabel: 'Elimina',
    danger: true,
  });
  if (!ok) return;
  setButtonBusy(btn, true);
  try {
    await deleteMachineManual(manual);
    feedback.deleteAction();
    toastSuccess(`Manuale "${slot.label}" di "${machine.nome}" eliminato.`);
    await refreshMachines();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || 'Impossibile eliminare il manuale.');
    setButtonBusy(btn, false);
  }
}

async function handleUploadOperatorManual(machine, file, btn) {
  setButtonBusy(btn, true);
  try {
    await uploadOperatorManual(machine.id, file);
    feedback.confirmAction();
    toastSuccess(`Manuale operatore "${file.name}" caricato per "${machine.nome}".`);
    await refreshMachines();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || 'Impossibile caricare il manuale.');
    setButtonBusy(btn, false);
  }
}

async function handleRemoveOperatorManual(machine, manual, btn) {
  const ok = await confirmDialog({
    title: 'Eliminare il manuale?',
    message: `Il manuale operatore "${manual.file_name}" collegato a "${machine.nome}" verrà eliminato. L'operazione non si può annullare.`,
    confirmLabel: 'Elimina',
    danger: true,
  });
  if (!ok) return;
  setButtonBusy(btn, true);
  try {
    await deleteOperatorManual(manual);
    feedback.deleteAction();
    toastSuccess(`Manuale operatore "${manual.file_name}" di "${machine.nome}" eliminato.`);
    await refreshMachines();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || 'Impossibile eliminare il manuale.');
    setButtonBusy(btn, false);
  }
}

async function handleRemove(machine, btn) {
  const usata = machine.articoli > 0;
  const ok = await confirmDialog({
    title: 'Rimuovere la macchina?',
    message: usata
      ? `"${machine.nome}" è assegnata a ${machine.articoli} ${machine.articoli === 1 ? 'articolo' : 'articoli'}: resteranno senza macchina assegnata. L'operazione non si può annullare.`
      : `"${machine.nome}" non è assegnata a nessun articolo. Verrà tolta dall'elenco.`,
    confirmLabel: 'Rimuovi',
    danger: true,
  });
  if (!ok) return;
  setButtonBusy(btn, true);
  try {
    const { articoliSvuotati } = await deleteMachine(machine);
    feedback.deleteAction();
    toastSuccess(
      articoliSvuotati > 0
        ? `Macchina "${machine.nome}" rimossa (${articoliSvuotati} ${articoliSvuotati === 1 ? 'articolo aggiornato' : 'articoli aggiornati'}).`
        : `Macchina "${machine.nome}" rimossa.`
    );
    if (articoliSvuotati > 0) bumpProductsVersion(); // la lista del Magazzino si aggiorna al rientro
    // Se il Magazzino stava filtrando proprio per questa macchina, il filtro va tolto
    document.dispatchEvent(new CustomEvent('machine-removed', { detail: { nome: machine.nome } }));
    await refreshMachines();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || 'Impossibile rimuovere la macchina.');
    setButtonBusy(btn, false);
  }
}

async function handleAdd(e) {
  e.preventDefault();
  const nome = els.input.value;
  setButtonBusy(els.addBtn, true, 'Aggiunta…');
  try {
    const row = await createMachine(nome);
    els.input.value = '';
    feedback.confirmAction();
    toastSuccess(`Macchina "${row.nome}" aggiunta.`);
    await refreshMachines();
  } catch (err) {
    feedback.errorAction();
    toastError(err.message || 'Impossibile aggiungere la macchina.');
  } finally {
    if (!tableMissing) setButtonBusy(els.addBtn, false);
  }
}
