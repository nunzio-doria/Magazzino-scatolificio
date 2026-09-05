// =============================================================
// ui-utils.js — Utility di interfaccia condivise tra le viste:
// contatori numerici animati, anelli di progresso (KPI dashboard)
// e pull-to-refresh per le liste scrollabili.
// =============================================================

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
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
export function emptyStateHtml(icon, title, subtitle = '') {
  return `
    <div class="flex flex-col items-center gap-2.5 py-4">
      <span class="w-14 h-14 rounded-full bg-graphite-800/60 flex items-center justify-center">
        <i data-lucide="${icon}" class="w-6 h-6 text-graphite-600" stroke-width="1.6"></i>
      </span>
      <p class="font-display font-semibold text-sm text-graphite-300">${title}</p>
      ${subtitle ? `<p class="text-xs text-graphite-500 max-w-[220px] text-center leading-relaxed">${subtitle}</p>` : ''}
    </div>`;
}

/**
 * Collega il gesto di pull-to-refresh alla pagina: agisce solo quando la
 * vista attualmente visibile è una di quelle registrate in viewRefreshMap
 * (es. { 'view-products': refreshProducts, 'view-dashboard': refreshDashboard })
 * e la pagina è già scrollata in cima.
 * @param {Record<string, () => Promise<void>>} viewRefreshMap
 */
export function initPullToRefresh(viewRefreshMap) {
  const indicator = document.getElementById('pull-refresh-indicator');
  const icon = indicator?.querySelector('i');
  if (!indicator) return;

  const THRESHOLD = 62;
  const MAX_PULL = 100;
  let startY = 0;
  let pulling = false;
  let ready = false;
  let refreshing = false;
  let activeFn = null;

  function findActiveRefreshFn() {
    for (const [viewId, fn] of Object.entries(viewRefreshMap)) {
      const section = document.getElementById(viewId);
      if (section && !section.classList.contains('hidden')) return fn;
    }
    return null;
  }

  function reset() {
    indicator.style.transform = 'translate(-50%, 0)';
    indicator.style.opacity = '0';
    indicator.classList.add('hidden');
    indicator.classList.remove('pull-ready', 'pull-spinning');
    ready = false;
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      if (refreshing || window.scrollY > 4) return;
      activeFn = findActiveRefreshFn();
      if (!activeFn) return;
      startY = e.touches[0].clientY;
      pulling = true;
      indicator.classList.remove('hidden');
    },
    { passive: true }
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!pulling || refreshing || !activeFn) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || window.scrollY > 4) {
        reset();
        pulling = false;
        return;
      }
      const dist = Math.min(dy * 0.5, MAX_PULL);
      indicator.style.transform = `translate(-50%, ${dist}px)`;
      indicator.style.opacity = String(Math.min(dist / THRESHOLD, 1));
      if (icon) icon.style.transform = `rotate(${dist * 2.8}deg)`;
      ready = dist >= THRESHOLD;
      indicator.classList.toggle('pull-ready', ready);
    },
    { passive: true }
  );

  document.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    if (ready && activeFn) {
      refreshing = true;
      indicator.classList.add('pull-spinning');
      indicator.style.transform = 'translate(-50%, 54px)';
      indicator.style.opacity = '1';
      try {
        await activeFn();
      } catch (err) {
        console.error('Pull-to-refresh: aggiornamento fallito.', err);
      } finally {
        refreshing = false;
        reset();
      }
    } else {
      reset();
    }
  });
}
