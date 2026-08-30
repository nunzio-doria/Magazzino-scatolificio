// =============================================================
// toast.js — Notifiche toast leggere, animate con Tailwind
// =============================================================

let container = null;

function ensureContainer() {
  if (!container) container = document.getElementById('toast-container');
  return container;
}

const ICONS = {
  success: '<i data-lucide="circle-check" class="w-5 h-5" stroke-width="2.25"></i>',
  error: '<i data-lucide="circle-x" class="w-5 h-5" stroke-width="2.25"></i>',
  warning: '<i data-lucide="triangle-alert" class="w-5 h-5" stroke-width="2.25"></i>',
  info: '<i data-lucide="info" class="w-5 h-5" stroke-width="2.25"></i>',
};

const STYLES = {
  success: 'border-emerald-500/40 text-emerald-300',
  error: 'border-rose-500/40 text-rose-300',
  warning: 'border-amber-500/50 text-amber-300',
  info: 'border-sky-500/40 text-sky-300',
};

/**
 * Mostra un toast.
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} type
 * @param {number} duration ms (0 = resta finché non chiuso manualmente)
 */
export function showToast(message, type = 'info', duration = 4200) {
  const root = ensureContainer();
  if (!root) return;

  const el = document.createElement('div');
  el.className = `pointer-events-auto flex items-start gap-3 w-full max-w-sm rounded-lg border bg-graphite-800/95 backdrop-blur px-4 py-3 shadow-lift toast-enter ${STYLES[type] || STYLES.info}`;
  el.innerHTML = `
    <span class="shrink-0 mt-0.5">${ICONS[type] || ICONS.info}</span>
    <p class="text-sm text-graphite-100 leading-snug flex-1">${message}</p>
    <button class="shrink-0 text-graphite-500 hover:text-graphite-200 transition-colors" aria-label="Chiudi">
      <i data-lucide="x" class="w-4 h-4" stroke-width="2"></i>
    </button>
  `;

  const close = () => {
    el.classList.add('toast-exit');
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('button').addEventListener('click', close);
  root.appendChild(el);
  window.lucide?.createIcons();

  if (duration > 0) setTimeout(close, duration);
  return { close };
}

export const toastSuccess = (msg, d) => showToast(msg, 'success', d);
export const toastError = (msg, d) => showToast(msg, 'error', d);
export const toastWarning = (msg, d) => showToast(msg, 'warning', d);
export const toastInfo = (msg, d) => showToast(msg, 'info', d);
