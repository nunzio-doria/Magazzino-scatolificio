// =============================================================
// manuals-browser.js — Vista "Manuali" (barra in basso, visibile a tutti:
// Admin e Operatore). Due pannelli:
//  1) elenco macchine, righe semplici (non espandibili) — toccarne una apre
//  2) il dettaglio: un indice a griglia (3 per riga) di pulsanti personalizzati
//     ("Mettifoglio", "Squadratura"…) definiti dall'Admin, ognuno legato a un
//     intervallo di pagine di un manuale operatore; toccandolo si apre il PDF
//     già scorso a quella pagina. In basso il pulsante "Spare parts" apre il
//     manuale ricambi della macchina (quello cercabile per codice articolo).
//     L'Admin trova qui anche il pulsante "+" per aggiungerne di nuovi.
// =============================================================

import { listMachinesWithCounts, createManualSection, updateManualSection, deleteManualSection, uploadSectionIcon, getSectionIconUrl, updateManualSectionsOrder } from './supabase.js';
import { refreshManualsCache, getOperatorManualsForMachine, getSectionsForOperatorManual, getAnyManualForMachine, openManualViewer } from './manuals.js';
import { staggerIndex, setButtonBusy, openOverlay, closeOverlay, enableSheetDrag } from './ui-utils.js';
import { confirmDialog } from './ui-modal.js';
import { toastError, toastSuccess, toastWarning } from './toast.js';
import { isAdmin } from './auth.js';
import feedback from './feedback.js';

const els = {};
let loaded = false; // dopo il primo caricamento, i rientri nella vista non mostrano più lo scheletro
let cachedMachines = [];
let currentMachine = null;
let pendingIconFile = null;
let editingSection = null; // null = si sta creando un nuovo pulsante; altrimenti quello in modifica
let reorderMode = false;
let reorderSaving = false;

export function initManualsBrowser() {
  els.skeleton = document.getElementById('manuals-browser-skeleton');
  els.list = document.getElementById('manuals-browser-list');
  els.empty = document.getElementById('manuals-browser-empty');

  els.view = document.getElementById('view-manuals');
  els.listPanel = document.getElementById('manuals-list-panel');
  els.detailPanel = document.getElementById('manuals-detail-panel');
  els.detailBack = document.getElementById('manuals-detail-back');
  els.detailIconWrap = document.getElementById('manuals-detail-icon-wrap');
  els.detailTitle = document.getElementById('manuals-detail-title');
  els.detailGrid = document.getElementById('manuals-detail-grid');
  els.detailEmpty = document.getElementById('manuals-detail-empty');
  els.detailSpareBtn = document.getElementById('manuals-detail-spare-parts');
  els.reorderToggle = document.getElementById('manuals-detail-reorder-toggle');
  els.reorderHint = document.getElementById('manuals-reorder-hint');

  els.modal = document.getElementById('manual-section-modal');
  els.modalTitle = document.getElementById('manual-section-modal-title');
  els.modalClose = document.getElementById('manual-section-modal-close');
  els.form = document.getElementById('manual-section-form');
  els.noManualNotice = document.getElementById('manual-section-no-manual-notice');
  els.labelInput = document.getElementById('manual-section-label');
  els.manualSelect = document.getElementById('manual-section-manual');
  els.pageStartInput = document.getElementById('manual-section-page-start');
  els.pageEndInput = document.getElementById('manual-section-page-end');
  els.wholeCheckbox = document.getElementById('manual-section-whole');
  els.pagesRow = document.getElementById('manual-section-pages-row');
  els.iconInput = document.getElementById('manual-section-icon');
  els.iconPreview = document.getElementById('manual-section-icon-preview');
  els.iconPlaceholder = document.getElementById('manual-section-icon-placeholder');
  els.submitBtn = document.getElementById('manual-section-submit');
  els.deleteBtn = document.getElementById('manual-section-delete');

  if (!els.list) return; // markup non presente (non dovrebbe succedere)

  els.detailBack?.addEventListener('click', closeMachineDetail);
  els.detailSpareBtn?.addEventListener('click', () => {
    if (!currentMachine) return;
    const manual = getAnyManualForMachine(currentMachine.id);
    if (!manual) {
      toastWarning(`Nessun manuale ricambi caricato per "${currentMachine.nome}". Puoi caricarlo da Impostazioni → Gestione macchine.`);
      return;
    }
    openManualViewer(manual);
  });

  els.reorderToggle?.addEventListener('click', toggleReorderMode);

  els.modalClose?.addEventListener('click', () => closeOverlay(els.modal));
  els.modal?.addEventListener('click', (e) => {
    if (e.target === els.modal) closeOverlay(els.modal);
  });
  if (els.modal) enableSheetDrag(els.modal.querySelector('.modal-panel'), () => closeOverlay(els.modal));

  els.iconInput?.addEventListener('change', () => {
    const file = els.iconInput.files?.[0] || null;
    pendingIconFile = file;
    if (file) {
      els.iconPreview.src = URL.createObjectURL(file);
      els.iconPreview.classList.remove('hidden');
      els.iconPlaceholder.classList.add('hidden');
    } else {
      els.iconPreview.classList.add('hidden');
      els.iconPlaceholder.classList.remove('hidden');
    }
  });

  els.form?.addEventListener('submit', handleCreateSection);
  els.wholeCheckbox?.addEventListener('change', applyWholeDocumentToggle);
  els.deleteBtn?.addEventListener('click', handleDeleteFromModal);
}

/** Con "Manuale intero" spuntato, i campi pagina si nascondono e smettono di essere obbligatori. */
function applyWholeDocumentToggle() {
  const whole = els.wholeCheckbox.checked;
  els.pagesRow.classList.toggle('hidden', whole);
  els.pageStartInput.required = !whole;
  els.pageEndInput.required = !whole;
}

/** Richiamata da app.js ogni volta che si entra nella vista Manuali. */
export async function enterManualsBrowser() {
  if (!els.list) return;
  closeMachineDetail({ immediate: true });
  if (!loaded) {
    els.skeleton?.classList.remove('hidden');
    els.list.classList.add('hidden');
    els.empty?.classList.add('hidden');
  }
  try {
    const [{ machines }] = await Promise.all([listMachinesWithCounts(), refreshManualsCache()]);
    cachedMachines = machines.filter((m) => m.id); // solo le macchine registrate possono avere un manuale collegato
    renderList();
    loaded = true;
  } catch (err) {
    console.error(err);
    toastError('Impossibile caricare l\'elenco delle macchine.');
  } finally {
    els.skeleton?.classList.add('hidden');
  }
}

/** Si richiama al logout, così il prossimo accesso (magari di un altro utente) ricarica da capo. */
export function resetManualsBrowser() {
  loaded = false;
  cachedMachines = [];
  currentMachine = null;
  reorderMode = false;
  reorderSaving = false;
}

// ---------------------------------------------------------------- elenco --

function sectionsCountForMachine(machine) {
  return getOperatorManualsForMachine(machine.id).reduce((sum, m) => sum + getSectionsForOperatorManual(m.id).length, 0);
}

function renderList() {
  els.list.innerHTML = '';
  if (cachedMachines.length === 0) {
    els.list.classList.add('hidden');
    els.empty?.classList.remove('hidden');
    return;
  }
  els.empty?.classList.add('hidden');

  cachedMachines.forEach((machine, i) => {
    const hasOperatorManual = getOperatorManualsForMachine(machine.id).length > 0;
    const count = sectionsCountForMachine(machine);
    const meta = !hasOperatorManual
      ? 'nessun manuale operatore'
      : count === 0
        ? 'nessuna sezione creata'
        : `${count} ${count === 1 ? 'sezione' : 'sezioni'}`;

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'list-item-in press-spring w-full flex items-center justify-between gap-3 px-4 py-3.5 card-plate rounded-xl';
    row.style.setProperty('--i', staggerIndex(i));
    row.innerHTML = `
      <span class="flex items-center gap-3 min-w-0">
        <span class="shrink-0 w-9 h-9 rounded-lg bg-graphite-700/50 flex items-center justify-center">
          <i data-lucide="cog" class="w-[18px] h-[18px] text-graphite-400" stroke-width="1.8"></i>
        </span>
        <span class="min-w-0 text-left">
          <span class="block font-display font-bold uppercase tracking-wide truncate">${escapeHtml(machine.nome)}</span>
          <span class="block ui-note text-graphite-500 mt-0.5">${meta}</span>
        </span>
      </span>
      <i data-lucide="chevron-right" class="w-5 h-5 text-graphite-400 shrink-0"></i>
    `;
    row.addEventListener('click', () => openMachineDetail(machine));
    els.list.appendChild(row);
  });

  els.list.classList.remove('hidden');
  window.lucide?.createIcons();
}

// ---------------------------------------------------------------- dettaglio --

function openMachineDetail(machine) {
  currentMachine = machine;
  reorderMode = false;
  els.detailTitle.textContent = machine.nome;
  // #view-manuals ricava la propria altezza dai figli nel flusso normale: appena
  // sotto passiamo ANCHE l'elenco a position:absolute (serve per l'effetto di
  // parallasse), quindi in quel momento non gliene resterebbe più nessuno da cui
  // calcolarla. La misuriamo e la fissiamo ORA, mentre l'elenco è ancora nel
  // flusso e la fornisce correttamente, cosí i due pannelli assoluti (inset:0)
  // hanno un contenitore reale a cui agganciarsi invece di accorciarsi al loro
  // solo contenuto.
  if (els.view) els.view.style.minHeight = `${els.view.offsetHeight}px`;
  renderDetailGrid();
  els.view?.classList.add('manuals-detail-open');
  window.lucide?.createIcons();
}

function closeMachineDetail({ immediate = false } = {}) {
  if (reorderMode) exitReorderMode({ save: true });
  els.view?.classList.remove('manuals-detail-open');
  if (els.view) els.view.style.minHeight = '';
  if (immediate) currentMachine = null;
}

function renderDetailGrid() {
  if (!currentMachine) return;
  const machine = currentMachine;
  const operatorManuals = getOperatorManualsForMachine(machine.id);
  const sections = [];
  operatorManuals.forEach((manual) => {
    getSectionsForOperatorManual(manual.id).forEach((section) => sections.push({ section, manual }));
  });

  els.detailGrid.innerHTML = '';
  els.detailGrid.classList.toggle('reorder-mode', reorderMode);
  // innerHTML='' svuota i figli ma non le classi dell'elenco stesso: quelle di
  // blocco visivo durante il salvataggio vanno quindi ripulite esplicitamente,
  // altrimenti resterebbero appiccicate anche a riordino ormai concluso.
  els.detailGrid.classList.toggle('opacity-60', reorderSaving);
  els.detailGrid.classList.toggle('pointer-events-none', reorderSaving);

  sections.forEach(({ section, manual }, i) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.dataset.sectionId = section.id;
    tile.className = `manual-section-tile${reorderMode ? '' : ' list-item-in'} press-spring card-plate rounded-2xl flex flex-col items-center justify-center gap-2 p-2 border-2 border-graphite-700`;
    tile.style.setProperty('--i', staggerIndex(i));
    const iconUrl = section.icon_storage_path ? getSectionIconUrl(section.icon_storage_path) : null;
    tile.innerHTML = `
      <span class="manual-section-tile-icon flex items-center justify-center">
        ${
          iconUrl
            ? `<img src="${escapeHtml(iconUrl)}" alt="" class="w-full h-full object-contain">`
            : '<i data-lucide="book-open" class="w-full h-full text-graphite-400" stroke-width="1.6"></i>'
        }
      </span>
      <span class="ui-label text-center leading-tight font-display font-semibold uppercase tracking-wide line-clamp-2">${escapeHtml(section.label)}</span>
      ${reorderMode ? '<span class="reorder-handle"><i data-lucide="grip-vertical" class="w-3.5 h-3.5" stroke-width="2.4"></i></span>' : ''}
    `;
    if (reorderMode) {
      makeTileDraggable(tile);
    } else {
      tile.addEventListener('click', () => openManualViewer(manual, { startPage: section.page_start }));
      if (isAdmin()) {
        tile.title = 'Tieni premuto per modificare';
        tile.addEventListener(
          'contextmenu',
          (e) => {
            e.preventDefault();
            openSectionModal(machine, section);
          },
          { passive: false }
        );
      }
    }
    els.detailGrid.appendChild(tile);
  });

  if (isAdmin() && !reorderMode) {
    const addTile = document.createElement('button');
    addTile.type = 'button';
    addTile.setAttribute('aria-label', `Aggiungi pulsante per ${machine.nome}`);
    addTile.className = 'manual-section-tile list-item-in press-spring rounded-2xl flex flex-col items-center justify-center gap-2 p-2 border-2 border-dashed border-graphite-700 text-graphite-500 hover:text-amber-300 hover:border-amber-500/40 transition-colors';
    addTile.style.setProperty('--i', staggerIndex(sections.length));
    addTile.innerHTML = `
      <i data-lucide="plus" class="w-7 h-7" stroke-width="1.8"></i>
      <span class="ui-label text-center font-display font-semibold uppercase tracking-wide">Aggiungi</span>
    `;
    addTile.addEventListener('click', () => openSectionModal(machine));
    els.detailGrid.appendChild(addTile);
  }

  const isEmpty = sections.length === 0 && !isAdmin();
  els.detailGrid.classList.toggle('hidden', isEmpty);
  els.detailEmpty?.classList.toggle('hidden', !isEmpty);

  updateReorderToggleVisibility(sections.length);
  window.lucide?.createIcons();
}

// ---------------------------------------------------------------- riordino (Admin) --

/** Il pulsante "Riordina" ha senso solo per l'Admin e con almeno 2 pulsanti da scambiare. */
function updateReorderToggleVisibility(sectionsCount) {
  if (!els.reorderToggle) return;
  const canReorder = isAdmin() && sectionsCount > 1;
  els.reorderToggle.classList.toggle('hidden', !canReorder && !reorderMode);
  els.reorderToggle.disabled = reorderSaving;
  els.reorderToggle.innerHTML = `<i data-lucide="${reorderMode ? 'check' : 'move'}" class="w-[18px] h-[18px]" stroke-width="${reorderMode ? '2.4' : '1.8'}"></i>`;
  els.reorderToggle.classList.toggle('bg-amber-400', reorderMode);
  els.reorderToggle.classList.toggle('border-amber-400', reorderMode);
  els.reorderToggle.classList.toggle('text-white', reorderMode);
  els.detailBack.disabled = reorderSaving;
  els.detailBack.classList.toggle('opacity-40', reorderMode);
  els.detailBack.classList.toggle('pointer-events-none', reorderMode);
  els.reorderHint?.classList.toggle('hidden', !reorderMode);
}

function toggleReorderMode() {
  if (reorderSaving) return;
  if (reorderMode) exitReorderMode({ save: true });
  else enterReorderMode();
}

function enterReorderMode() {
  reorderMode = true;
  feedback.modeSelect();
  renderDetailGrid();
  window.lucide?.createIcons();
}

/** Esce dalla modalità Riordina; se `save` è vero (caso normale: si tocca il segno di spunta,
 *  oppure si torna indietro con un riordino in corso) salva il nuovo ordine letto dal DOM. */
async function exitReorderMode({ save }) {
  const grid = els.detailGrid;
  if (!save || !grid || !currentMachine) {
    reorderMode = false;
    renderDetailGrid();
    window.lucide?.createIcons();
    return;
  }
  // Durante il salvataggio resta visivamente "in modalità Riordina" (stessa spunta,
  // stesso ordine a schermo) ma bloccata, cosí non si può trascinare di nuovo mentre
  // la richiesta è in volo.
  const orderedIds = Array.from(grid.querySelectorAll('.manual-section-tile[data-section-id]')).map((t) => t.dataset.sectionId);
  reorderSaving = true;
  grid.classList.add('opacity-60', 'pointer-events-none');
  updateReorderToggleVisibility(orderedIds.length);
  try {
    await updateManualSectionsOrder(orderedIds);
    feedback.confirmAction();
    await refreshManualsCache();
    toastSuccess('Ordine dei pulsanti aggiornato.');
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || 'Impossibile salvare il nuovo ordine.');
  } finally {
    reorderSaving = false;
    reorderMode = false;
    renderDetailGrid();
    renderList();
    window.lucide?.createIcons();
  }
}

/**
 * Trascinamento libero di una tile dentro la griglia, via Pointer Events (uniforme
 * dito/mouse): al posto suo resta un segnaposto che segue il punto toccato, così
 * al rilascio l'ordine nel DOM è già quello nuovo — non serve altro calcolo.
 */
function makeTileDraggable(tile) {
  const grid = els.detailGrid;
  let dragging = false;
  let placeholder = null;
  let offsetX = 0;
  let offsetY = 0;
  let pointerId = null;

  const start = (e) => {
    if (dragging) return;
    dragging = true;
    pointerId = e.pointerId;
    try {
      tile.setPointerCapture(pointerId);
    } catch (err) {
      /* puntatore non più attivo: si prosegue senza cattura */
    }
    const rect = tile.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    placeholder = document.createElement('div');
    placeholder.className = 'manual-section-tile reorder-placeholder';
    tile.after(placeholder);
    tile.classList.add('reorder-dragging');
    tile.style.position = 'fixed';
    tile.style.width = `${rect.width}px`;
    tile.style.height = `${rect.height}px`;
    tile.style.left = `${rect.left}px`;
    tile.style.top = `${rect.top}px`;
    tile.style.zIndex = '60';
  };

  const move = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    tile.style.left = `${e.clientX - offsetX}px`;
    tile.style.top = `${e.clientY - offsetY}px`;
    tile.style.visibility = 'hidden';
    const below = document.elementFromPoint(e.clientX, e.clientY);
    tile.style.visibility = '';
    const overTile = below?.closest('.manual-section-tile');
    if (overTile && overTile !== placeholder && overTile.parentElement === grid && overTile !== tile) {
      const rect = overTile.getBoundingClientRect();
      const isAfter = e.clientX > rect.left + rect.width / 2 || e.clientY > rect.top + rect.height / 2;
      grid.insertBefore(placeholder, isAfter ? overTile.nextSibling : overTile);
    }
  };

  const end = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    try {
      tile.releasePointerCapture(pointerId);
    } catch (err) {
      /* già rilasciato */
    }
    placeholder?.replaceWith(tile);
    placeholder = null;
    tile.classList.remove('reorder-dragging');
    tile.style.position = '';
    tile.style.width = '';
    tile.style.height = '';
    tile.style.left = '';
    tile.style.top = '';
    tile.style.zIndex = '';
  };

  tile.addEventListener('pointerdown', start);
  tile.addEventListener('pointermove', move);
  tile.addEventListener('pointerup', end);
  tile.addEventListener('pointercancel', end);
}

async function handleDeleteFromModal() {
  if (!editingSection) return;
  const ok = await confirmDialog({
    title: 'Eliminare il pulsante?',
    message: `Il pulsante "${editingSection.label}" verrà eliminato. L'operazione non si può annullare.`,
    confirmLabel: 'Elimina',
    danger: true,
  });
  if (!ok) return;
  setButtonBusy(els.deleteBtn, true);
  try {
    await deleteManualSection(editingSection);
    feedback.deleteAction();
    toastSuccess(`Pulsante "${editingSection.label}" eliminato.`);
    closeOverlay(els.modal);
    await refreshManualsCache();
    renderDetailGrid();
    renderList();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || 'Impossibile eliminare il pulsante.');
  } finally {
    setButtonBusy(els.deleteBtn, false);
  }
}

// ---------------------------------------------------------------- modale "Aggiungi/Modifica pulsante" --

/** Stessa modale per creare (`section` assente) e modificare (`section` valorizzata) un pulsante. */
function openSectionModal(machine, section = null) {
  editingSection = section;
  const operatorManuals = getOperatorManualsForMachine(machine.id);

  els.form.reset();
  pendingIconFile = null;
  els.iconPreview.classList.add('hidden');
  els.iconPlaceholder.classList.remove('hidden');

  els.manualSelect.innerHTML = operatorManuals
    .map((m) => `<option value="${m.id}">${escapeHtml(m.file_name)}</option>`)
    .join('');

  const hasManuals = operatorManuals.length > 0;
  els.noManualNotice.classList.toggle('hidden', hasManuals);
  els.manualSelect.disabled = !hasManuals;
  els.labelInput.disabled = !hasManuals;
  els.pageStartInput.disabled = !hasManuals;
  els.pageEndInput.disabled = !hasManuals;
  els.iconInput.disabled = !hasManuals;
  els.submitBtn.disabled = !hasManuals;
  els.submitBtn.classList.toggle('opacity-50', !hasManuals);

  if (section) {
    els.modalTitle.textContent = 'Modifica pulsante';
    els.submitBtn.textContent = 'Salva modifiche';
    els.deleteBtn.classList.remove('hidden');
    els.labelInput.value = section.label;
    els.manualSelect.value = section.operator_manual_id;
    els.wholeCheckbox.checked = section.page_start == null && section.page_end == null;
    els.pageStartInput.value = section.page_start ?? '';
    els.pageEndInput.value = section.page_end ?? '';
    if (section.icon_storage_path) {
      els.iconPreview.src = getSectionIconUrl(section.icon_storage_path);
      els.iconPreview.classList.remove('hidden');
      els.iconPlaceholder.classList.add('hidden');
    }
  } else {
    els.modalTitle.textContent = 'Nuovo pulsante';
    els.submitBtn.textContent = 'Aggiungi';
    els.deleteBtn.classList.add('hidden');
  }
  applyWholeDocumentToggle();

  openOverlay(els.modal);
}

async function handleCreateSection(e) {
  e.preventDefault();
  if (!currentMachine) return;
  const label = els.labelInput.value.trim();
  const operatorManualId = els.manualSelect.value;
  const wholeDocument = els.wholeCheckbox.checked;
  let pageStart = null;
  let pageEnd = null;

  if (!label || !operatorManualId) return;
  if (!wholeDocument) {
    pageStart = Number(els.pageStartInput.value);
    pageEnd = Number(els.pageEndInput.value);
    if (!Number.isFinite(pageStart) || !Number.isFinite(pageEnd) || pageStart < 1 || pageEnd < pageStart) {
      toastError('Controlla l\'intervallo di pagine: la pagina finale deve essere uguale o successiva a quella iniziale.');
      return;
    }
  }

  setButtonBusy(els.submitBtn, true);
  try {
    let newIconStoragePath;
    if (pendingIconFile) newIconStoragePath = await uploadSectionIcon(pendingIconFile);

    if (editingSection) {
      await updateManualSection(editingSection.id, {
        operatorManualId,
        label,
        pageStart,
        pageEnd,
        newIconStoragePath,
        previousIconStoragePath: editingSection.icon_storage_path,
      });
      feedback.confirmAction();
      toastSuccess(`Pulsante "${label}" aggiornato.`);
    } else {
      const sortOrder = getSectionsForOperatorManual(operatorManualId).length;
      await createManualSection({
        machineId: currentMachine.id,
        operatorManualId,
        label,
        iconStoragePath: newIconStoragePath || null,
        pageStart,
        pageEnd,
        sortOrder,
      });
      feedback.confirmAction();
      toastSuccess(`Pulsante "${label}" aggiunto.`);
    }
    closeOverlay(els.modal);
    await refreshManualsCache();
    renderDetailGrid();
    renderList();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err.message || `Impossibile ${editingSection ? 'salvare le modifiche' : 'aggiungere il pulsante'}.`);
  } finally {
    setButtonBusy(els.submitBtn, false);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
