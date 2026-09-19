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
 * field-picker-modal, article-history-modal, confirm-overlay...). Usa un
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
