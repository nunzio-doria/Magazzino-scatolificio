// =============================================================
// ui-modal.js — Modale di conferma disegnato ad hoc, al posto del
// confirm() nativo del browser. Usa la stessa struttura e la stessa
// animazione di tutte le altre modali dell'app (.modal-overlay +
// .modal-panel), e risolve una Promise<boolean> come farebbe confirm().
// =============================================================

import feedback from './feedback.js';
import { openOverlay, closeOverlay, enableSheetDrag, modalCloseMs } from './ui-utils.js';

/**
 * @param {{ title?: string, message: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = 'Conferma',
  message,
  confirmLabel = 'Conferma',
  cancelLabel = 'Annulla',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className =
      'modal-overlay hidden fixed inset-0 z-[95] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm px-0 sm:px-4';

    const card = document.createElement('div');
    card.className = 'modal-panel modal-panel-card w-full sm:max-w-sm card-plate rounded-t-2xl sm:rounded-2xl p-5';
    card.innerHTML = `
      <div data-sheet-drag class="sheet-grabber sm:hidden -mt-5 mb-1"><span class="sheet-grabber-pill"></span></div>
      <p data-sheet-drag data-role="title" class="font-display font-bold text-lg leading-snug"></p>
      <p data-sheet-drag data-role="message" class="text-sm text-graphite-400 leading-relaxed mt-1.5"></p>
      <div class="flex gap-3 mt-5">
        <button type="button" data-action="cancel"
          class="flex-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide text-graphite-400 hover:text-graphite-200 hover:bg-graphite-800 transition-colors"></button>
        <button type="button" data-action="confirm"
          class="flex-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide text-white transition-colors ${
            danger ? 'bg-rose-500 hover:bg-rose-400' : 'bg-amber-400 hover:bg-amber-300'
          }"></button>
      </div>
    `;
    // Testi inseriti come semplice testo (mai come HTML)
    card.querySelector('[data-role="title"]').textContent = title;
    card.querySelector('[data-role="message"]').textContent = message;
    card.querySelector('[data-action="cancel"]').textContent = cancelLabel;
    card.querySelector('[data-action="confirm"]').textContent = confirmLabel;

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    openOverlay(overlay);

    let settled = false;
    function settle(result, silent = false) {
      if (settled) return;
      settled = true;
      if (!silent) {
        if (result) {
          danger ? feedback.deleteAction() : feedback.confirmAction();
        } else {
          feedback.cancelAction();
        }
      }
      document.removeEventListener('keydown', onKeyDown);
      closeOverlay(overlay);
      setTimeout(() => overlay.remove(), modalCloseMs() + 60);
      resolve(result);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') settle(false);
      // Invio conferma solo se non c'è un pulsante con il focus (in quel caso
      // decide il click nativo del pulsante: "Annulla" resta "Annulla").
      if (e.key === 'Enter' && !e.repeat && !(document.activeElement instanceof HTMLButtonElement)) settle(true);
    }

    card.querySelector('[data-action="cancel"]').addEventListener('click', () => settle(false));
    card.querySelector('[data-action="confirm"]').addEventListener('click', () => settle(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) settle(false);
    });
    overlay.addEventListener('overlay-cancel', () => settle(false, true));
    enableSheetDrag(card, () => settle(false)); // trascinando verso il basso equivale ad "Annulla"
    document.addEventListener('keydown', onKeyDown);
  });
}
