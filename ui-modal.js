// =============================================================
// ui-modal.js — Modale di conferma disegnato ad hoc, al posto del
// confirm() nativo del browser. Overlay + card animati (fade + scala
// con lieve overshoot elastico, in tema con le altre transizioni
// dell'app), risolve una Promise<boolean> come farebbe confirm().
// =============================================================

import feedback from './feedback.js';
import { lockBodyScroll, unlockBodyScroll } from './ui-utils.js';

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
    overlay.className = 'confirm-overlay';

    const card = document.createElement('div');
    card.className = 'confirm-card card-plate rounded-xl p-5';
    card.innerHTML = `
      <p class="font-display font-bold text-lg leading-snug">${title}</p>
      <p class="text-sm text-graphite-400 leading-relaxed mt-1.5">${message}</p>
      <div class="flex gap-3 mt-5">
        <button type="button" data-action="cancel"
          class="flex-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide text-graphite-400 hover:text-graphite-200 hover:bg-graphite-800 transition-colors">${cancelLabel}</button>
        <button type="button" data-action="confirm"
          class="flex-1 rounded-lg py-3 font-display font-semibold uppercase tracking-wide text-white transition-colors ${
            danger ? 'bg-rose-500 hover:bg-rose-400' : 'bg-amber-400 hover:bg-amber-300'
          }">${confirmLabel}</button>
      </div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    lockBodyScroll();

    // Un frame vuoto prima di aprire: cosí il browser registra lo stato
    // iniziale (invisibile/rimpicciolito) e la transizione parte davvero.
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('confirm-open')));

    function settle(result) {
      if (result) {
        danger ? feedback.deleteAction() : feedback.confirmAction();
      } else {
        feedback.cancelAction();
      }
      document.removeEventListener('keydown', onKeyDown);
      overlay.classList.remove('confirm-open');
      overlay.classList.add('confirm-closing');
      unlockBodyScroll();
      setTimeout(() => overlay.remove(), 220);
      resolve(result);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') settle(false);
      if (e.key === 'Enter') settle(true);
    }

    card.querySelector('[data-action="cancel"]').addEventListener('click', () => settle(false));
    card.querySelector('[data-action="confirm"]').addEventListener('click', () => settle(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) settle(false);
    });
    document.addEventListener('keydown', onKeyDown);
  });
}
