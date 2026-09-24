// =============================================================
// applications.js — Sezione "Applicazioni" (Impostazioni, solo Admin):
// una modale con una griglia di pulsanti "app", coerente con le altre
// modali dell'app (stessa apertura/chiusura a foglio con enableSheetDrag).
// Per ora contiene solo "Report" (la vecchia voce "Report" della barra in
// basso, spostata qui perché quello slot ora è occupato da "Manuali",
// visibile anche all'Operatore).
// =============================================================

import { openOverlay, closeOverlay, enableSheetDrag } from './ui-utils.js';
import { switchView } from './app.js';

const els = {};

export function initApplications() {
  els.modal = document.getElementById('applications-modal');
  els.manageBtn = document.getElementById('applications-manage-btn');
  els.closeBtn = document.getElementById('applications-modal-close');
  els.reportTile = document.getElementById('applications-report-tile');
  if (!els.modal) return;

  els.manageBtn?.addEventListener('click', () => openOverlay(els.modal));
  els.closeBtn?.addEventListener('click', () => closeOverlay(els.modal));
  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal) closeOverlay(els.modal);
  });
  enableSheetDrag(els.modal.querySelector('.modal-panel'), () => closeOverlay(els.modal));

  els.reportTile?.addEventListener('click', () => {
    closeOverlay(els.modal);
    switchView('dashboard');
  });
}
