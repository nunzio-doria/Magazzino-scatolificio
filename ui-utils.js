import feedback from './feedback.js';
// =============================================================
// ui-utils.js — Utility di interfaccia condivise tra le viste:
// contatori numerici animati e anelli di progresso (KPI dashboard).
// =============================================================

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

let scrollLockCount = 0;
let savedScrollY = 0;

/**
 * Blocca lo scroll della pagina sotto una modale aperta (product-modal,
 * field-picker-modal, article-history-modal, dialog di conferma...). Usa un
 * contatore cosí due modali aperte in sequenza (es. picker sopra il form
 * articolo) non sbloccano lo sfondo chiudendone solo una.
 * position:fixed invece del solo overflow:hidden, perché su iOS Safari
 * overflow:hidden da solo non impedisce comunque lo scroll/rimbalzo dietro
 * l'overlay.
 */
export function lockBodyScroll() {
  if (scrollLockCount === 0) {
    savedScrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
  }
  scrollLockCount += 1;
}

/** Sblocca lo scroll quando l'ultima modale aperta si chiude */
export function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    window.scrollTo(0, savedScrollY);
  }
}

/** Durata (ms) della chiusura di tutte le modali: la legge dal token CSS --dur-slow, così
 *  resta sempre uguale alla transizione del pannello (340 solo come valore di riserva). */
export function modalCloseMs() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-slow'));
  return Number.isFinite(v) && v > 0 ? v : 340;
}

/**
 * Apre una modale (overlay con classe .modal-overlay) con l'animazione
 * standard dell'app. Sicura se richiamata due volte o durante una chiusura.
 */
export function openOverlay(el) {
  if (!el || el.dataset.modalOpen) return;
  el.dataset.modalOpen = '1';
  clearTimeout(el._hideTimer); // annulla un'eventuale chiusura ancora in corso
  el.classList.remove('hidden');
  void el.offsetWidth; // reflow: la transizione parte sempre
  lockBodyScroll();
  el.classList.add('modal-visible');
}

/** Chiude una modale con l'animazione standard. Sicura se già chiusa. */
export function closeOverlay(el) {
  if (!el || !el.dataset.modalOpen) return;
  delete el.dataset.modalOpen;
  el.classList.remove('modal-visible');
  unlockBodyScroll();
  el._hideTimer = setTimeout(() => el.classList.add('hidden'), modalCloseMs());
}

/**
 * Trascinamento verso il basso per chiudere un cassetto (bottom sheet), valido
 * per tutte le modali. Zone che avviano il trascinamento: ogni elemento del
 * pannello con l'attributo data-sheet-drag (la maniglia in cima e la riga del
 * titolo): un'area ampia e a tutta larghezza, non solo la barretta.
 * - Solo al tocco (dito/penna) e solo su schermi stretti, dove il pannello è
 *   un cassetto: su desktop le modali sono finestre centrate e non si trascinano.
 * - Un tocco su un pulsante o un campo dentro la zona resta un normale tocco.
 * - Segue il dito 1:1; al rilascio chiude se si è superato il 28% dell'altezza
 *   oppure se il gesto è stato una strisciata veloce, altrimenti torna su.
 * @param {HTMLElement} panel il pannello (.modal-panel)
 * @param {() => void} onClose funzione di chiusura della modale
 */
export function enableSheetDrag(panel, onClose) {
  if (!panel || panel.dataset.sheetDragBound) return;
  panel.dataset.sheetDragBound = '1';
  const narrow = window.matchMedia('(max-width: 639px)');
  let pointerId = null;
  let startY = 0;
  let startT = 0;
  let dy = 0;

  panel.querySelectorAll('[data-sheet-drag]').forEach((zone) => {
    zone.addEventListener('pointerdown', (e) => {
      if (pointerId !== null || e.pointerType === 'mouse' || !narrow.matches) return;
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      pointerId = e.pointerId;
      startY = e.clientY;
      startT = performance.now();
      dy = 0;
      try {
        zone.setPointerCapture(e.pointerId); // continua a ricevere il gesto anche se il dito esce dalla zona
      } catch (err) {
        /* puntatore non più attivo: si prosegue senza cattura */
      }
      panel.classList.add('sheet-dragging');
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      dy = Math.max(0, e.clientY - startY); // non si trascina oltre la posizione tutta aperta
      panel.style.transform = `translateY(${dy}px)`;
    });
    const end = (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      panel.classList.remove('sheet-dragging');
      const height = panel.getBoundingClientRect().height || 1;
      const fastSwipe = dy > 48 && performance.now() - startT < 260;
      const shouldClose = e.type !== 'pointercancel' && (dy > height * 0.28 || fastSwipe);
      panel.style.transform = '';
      dy = 0;
      // Sotto soglia: tolta la classe .sheet-dragging e lo stile inline, la
      // transizione CSS riporta da sola il pannello in posizione.
      if (shouldClose) {
        feedback.cancelAction();
        onClose();
      }
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  });
}

/**
 * Chiude tutte le modali aperte (es. alla disconnessione). Alle modali che
 * hanno una Promise in sospeso (picker, conferma) manda prima l'evento
 * 'overlay-cancel', cosí si risolvono come "annullato" invece di restare appese.
 */
export function closeAllOverlays() {
  document.querySelectorAll('.modal-overlay[data-modal-open]').forEach((el) => {
    el.dispatchEvent(new CustomEvent('overlay-cancel'));
    closeOverlay(el);
  });
}

/**
 * Anima il testo di un elemento da un numero all'altro (count-up/down),
 * invece di sostituire il valore di colpo. Rispetta prefers-reduced-motion.
 * @param {HTMLElement} el
 * @param {number} to
 * @param {{ from?: number, duration?: number, formatter?: (n:number)=>string }} [opts]
 */
export function animateNumber(el, to, { from = null, duration = 650, formatter } = {}) {
  if (!el) return;
  const start = from != null ? from : Number(el.textContent.replace(/[^\d.-]/g, '')) || 0;
  const end = Number(to) || 0;
  const fmt = formatter || ((n) => String(Math.round(n)));

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || start === end) {
    el.textContent = fmt(end);
    return;
  }

  const t0 = performance.now();
  function frame(now) {
    const progress = Math.min((now - t0) / duration, 1);
    const value = start + (end - start) * easeOutCubic(progress);
    el.textContent = fmt(value);
    if (progress < 1) requestAnimationFrame(frame);
    else el.textContent = fmt(end);
  }
  requestAnimationFrame(frame);
}

/**
 * Anima lo stroke-dashoffset di un anello SVG di progresso verso una
 * percentuale target (0-100). circleEl deve avere già impostato
 * stroke-dasharray = circonferenza.
 */
export function animateRing(circleEl, percent, { duration = 700 } = {}) {
  if (!circleEl) return;
  const circumference = parseFloat(circleEl.getAttribute('stroke-dasharray')) || 0;
  const clamped = Math.max(0, Math.min(100, percent || 0));
  const targetOffset = circumference * (1 - clamped / 100);
  const startOffset = parseFloat(circleEl.style.strokeDashoffset || circleEl.getAttribute('stroke-dashoffset')) || circumference;

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    circleEl.style.strokeDashoffset = String(targetOffset);
    return;
  }

  const t0 = performance.now();
  function frame(now) {
    const progress = Math.min((now - t0) / duration, 1);
    const value = startOffset + (targetOffset - startOffset) * easeOutCubic(progress);
    circleEl.style.strokeDashoffset = String(value);
    if (progress < 1) requestAnimationFrame(frame);
    else circleEl.style.strokeDashoffset = String(targetOffset);
  }
  requestAnimationFrame(frame);
}

/**
 * Forza un "replay" di un'animazione CSS su un elemento: rimuove la
 * classe, forza il reflow, la riaggiunge. Utile per far ripartire la
 * micro-animazione di comparsa ogni volta (es. card risultato scanner).
 */
export function replayAnimation(el, className) {
  if (!el) return;
  el.classList.remove(className);
  // eslint-disable-next-line no-unused-expressions
  void el.offsetWidth; // forza il reflow
  el.classList.add(className);
}

/**
 * Markup di uno stato vuoto illustrato (icona lucide + titolo + sottotitolo),
 * coerente in tutte le viste invece di una singola riga di testo grigio.
 */
/**
 * Indice limitato per lo sfalsamento (--i) delle liste lunghe: oltre una
 * decina di elementi lo stagger diventerebbe percettibilmente lento a
 * caricare, quindi si appiattisce sul valore massimo invece di crescere
 * all'infinito con la lunghezza della lista.
 */
export function staggerIndex(i, max = 10) {
  return Math.min(i, max);
}

export function emptyStateHtml(icon, title, subtitle = '') {
  return `
    <div class="empty-state-in flex flex-col items-center gap-2.5 py-4">
      <span class="w-14 h-14 rounded-full bg-graphite-800/60 flex items-center justify-center">
        <i data-lucide="${icon}" class="w-6 h-6 text-graphite-600" stroke-width="1.6"></i>
      </span>
      <p class="font-display font-semibold text-sm text-graphite-300">${title}</p>
      ${subtitle ? `<p class="text-xs text-graphite-500 max-w-[220px] text-center leading-relaxed">${subtitle}</p>` : ''}
    </div>`;
}
