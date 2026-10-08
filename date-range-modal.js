// =============================================================
// date-range-modal.js — Selettore di intervallo date disegnato ad hoc,
// al posto del calendario nativo del telefono. Stessa struttura e stessa
// animazione delle altre modali (.modal-overlay + .modal-panel, cassetto
// su mobile, finestra centrata su desktop), con la griglia del mese nei
// colori dell'app.
//
// Uso:  const range = await pickDateRange({ from, to });
//       -> { from: Date (00:00 del primo giorno), to: Date (23:59:59.999
//          dell'ultimo giorno) } oppure null se annullato.
// Si tocca il primo giorno e poi l'ultimo; un terzo tocco ricomincia.
// I giorni futuri non sono selezionabili.
// =============================================================

import feedback from './feedback.js';
import { openOverlay, closeOverlay, enableSheetDrag, modalCloseMs } from './ui-utils.js';

const MONTHS = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const WEEKDAYS = ['Lu', 'Ma', 'Me', 'Gi', 'Ve', 'Sa', 'Do'];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const fmt = (d) => (d ? d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');

/**
 * @param {{ from?: Date|null, to?: Date|null }} [initial]
 * @returns {Promise<{ from: Date, to: Date } | null>}
 */
export function pickDateRange({ from = null, to = null } = {}) {
  return new Promise((resolve) => {
    const today = startOfDay(new Date());
    let selFrom = from ? startOfDay(from) : null;
    let selTo = to ? startOfDay(to) : null;
    const anchor = selFrom || today;
    let viewYear = anchor.getFullYear();
    let viewMonth = anchor.getMonth();

    const overlay = document.createElement('div');
    overlay.className =
      'modal-overlay hidden fixed inset-0 z-[95] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm px-0 sm:px-4';

    const card = document.createElement('div');
    card.className = 'modal-panel modal-panel-card w-full sm:max-w-sm bg-graphite-900 border border-graphite-700 rounded-t-2xl sm:rounded-2xl flex flex-col';
    card.innerHTML = `
      <div data-sheet-drag class="sheet-grabber sm:hidden"><span class="sheet-grabber-pill"></span></div>
      <div data-sheet-drag class="flex items-center justify-between px-5 pb-3 pt-1 sm:pt-3 border-b border-graphite-800 shrink-0">
        <h3 class="font-display font-bold text-lg uppercase tracking-wide">Periodo personalizzato</h3>
        <button type="button" data-action="close" aria-label="Chiudi" class="modal-close modal-close--on-light">
          <i data-lucide="x" class="w-6 h-6" stroke-width="2.5"></i>
        </button>
      </div>
      <div class="px-5 pt-4 pb-1">
        <div class="grid grid-cols-2 gap-2 mb-3">
          <div data-role="box-from" class="cal-box rounded-lg border border-graphite-700 px-3 py-2">
            <p class="ui-label uppercase tracking-wide text-graphite-500">Dal</p>
            <p data-role="val-from" class="font-mono text-sm font-semibold text-graphite-100 mt-0.5"></p>
          </div>
          <div data-role="box-to" class="cal-box rounded-lg border border-graphite-700 px-3 py-2">
            <p class="ui-label uppercase tracking-wide text-graphite-500">Al</p>
            <p data-role="val-to" class="font-mono text-sm font-semibold text-graphite-100 mt-0.5"></p>
          </div>
        </div>
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center">
            <button type="button" data-nav="-12" aria-label="Anno precedente" class="cal-nav"><i data-lucide="chevrons-left" class="w-5 h-5"></i></button>
            <button type="button" data-nav="-1" aria-label="Mese precedente" class="cal-nav"><i data-lucide="chevron-left" class="w-5 h-5"></i></button>
          </div>
          <p data-role="month" class="font-display font-semibold uppercase tracking-wide text-sm text-graphite-100"></p>
          <div class="flex items-center">
            <button type="button" data-nav="1" aria-label="Mese successivo" class="cal-nav"><i data-lucide="chevron-right" class="w-5 h-5"></i></button>
            <button type="button" data-nav="12" aria-label="Anno successivo" class="cal-nav"><i data-lucide="chevrons-right" class="w-5 h-5"></i></button>
          </div>
        </div>
        <div class="grid grid-cols-7 mb-1">
          ${WEEKDAYS.map((w) => `<span class="ui-label text-center uppercase text-graphite-500 py-1">${w}</span>`).join('')}
        </div>
        <div data-role="grid" class="cal-grid grid grid-cols-7"></div>
      </div>
      <div class="flex gap-3 px-5 pt-3 pb-5">
        <button type="button" data-action="cancel"
          class="flex-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide text-graphite-400 hover:text-graphite-200 hover:bg-graphite-800 transition-colors">Annulla</button>
        <button type="button" data-action="apply"
          class="cal-apply flex-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide text-white bg-amber-400 hover:bg-amber-300 transition-colors">Applica</button>
      </div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const grid = card.querySelector('[data-role="grid"]');
    const monthEl = card.querySelector('[data-role="month"]');
    const valFrom = card.querySelector('[data-role="val-from"]');
    const valTo = card.querySelector('[data-role="val-to"]');
    const boxFrom = card.querySelector('[data-role="box-from"]');
    const boxTo = card.querySelector('[data-role="box-to"]');
    const applyBtn = card.querySelector('[data-action="apply"]');

    function renderSummary() {
      valFrom.textContent = fmt(selFrom);
      valTo.textContent = fmt(selTo);
      // La casella in attesa della prossima selezione è evidenziata.
      boxFrom.classList.toggle('cal-box-active', !selFrom || !!selTo);
      boxTo.classList.toggle('cal-box-active', !!selFrom && !selTo);
      applyBtn.disabled = !selFrom;
      applyBtn.classList.toggle('opacity-40', !selFrom);
    }

    function renderGrid(direction = 0) {
      monthEl.textContent = `${MONTHS[viewMonth]} ${viewYear}`;
      const first = new Date(viewYear, viewMonth, 1);
      const offset = (first.getDay() + 6) % 7; // settimana da lunedì
      const days = new Date(viewYear, viewMonth + 1, 0).getDate();
      let html = '';
      for (let i = 0; i < offset; i++) html += '<span></span>';
      for (let d = 1; d <= days; d++) {
        const date = new Date(viewYear, viewMonth, d);
        const t = date.getTime();
        const future = date > today;
        const isFrom = selFrom && t === selFrom.getTime();
        const isTo = selTo && t === selTo.getTime();
        const inside = selFrom && selTo && t > selFrom.getTime() && t < selTo.getTime();
        const cls = ['cal-day'];
        if (date.getTime() === today.getTime()) cls.push('cal-day-today');
        if (isFrom || isTo) cls.push('cal-day-edge');
        else if (inside) cls.push('cal-day-in');
        html += `<button type="button" data-ts="${t}" class="${cls.join(' ')}" ${future ? 'disabled' : ''}>${d}</button>`;
      }
      grid.innerHTML = html;
      if (direction) {
        grid.classList.remove('cal-slide-next', 'cal-slide-prev');
        void grid.offsetWidth;
        grid.classList.add(direction > 0 ? 'cal-slide-next' : 'cal-slide-prev');
      }
    }

    function renderAll(direction = 0) {
      renderSummary();
      renderGrid(direction);
    }

    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ts]');
      if (!btn || btn.disabled) return;
      const picked = startOfDay(new Date(Number(btn.dataset.ts)));
      if (!selFrom || selTo) {
        selFrom = picked; // nuovo inizio
        selTo = null;
      } else if (picked < selFrom) {
        selTo = selFrom; // secondo tocco prima dell'inizio: si invertono
        selFrom = picked;
      } else {
        selTo = picked;
      }
      feedback.tap();
      renderAll();
    });

    card.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = Number(btn.dataset.nav);
        const d = new Date(viewYear, viewMonth + step, 1);
        viewYear = d.getFullYear();
        viewMonth = d.getMonth();
        feedback.tap();
        renderAll(step);
      });
    });

    let settled = false;
    function settle(result, silent = false) {
      if (settled) return;
      settled = true;
      if (!silent) (result ? feedback.confirmAction() : feedback.cancelAction());
      document.removeEventListener('keydown', onKeyDown);
      closeOverlay(overlay);
      setTimeout(() => overlay.remove(), modalCloseMs() + 60);
      resolve(result);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') settle(null);
    }

    applyBtn.addEventListener('click', () => {
      if (!selFrom) return;
      settle({ from: selFrom, to: endOfDay(selTo || selFrom) });
    });
    card.querySelector('[data-action="cancel"]').addEventListener('click', () => settle(null));
    card.querySelector('[data-action="close"]').addEventListener('click', () => settle(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) settle(null);
    });
    overlay.addEventListener('overlay-cancel', () => settle(null, true)); // tasto indietro del telefono
    enableSheetDrag(card, () => settle(null));
    document.addEventListener('keydown', onKeyDown);

    renderAll();
    window.lucide?.createIcons();
    openOverlay(overlay);
  });
}
