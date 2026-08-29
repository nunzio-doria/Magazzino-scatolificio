// =============================================================
// toast.js — Notifiche toast leggere, animate con Tailwind
// =============================================================

let container = null;

function ensureContainer() {
  if (!container) container = document.getElementById('toast-container');
  return container;
}

const ICONS = {
  success: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`,
  error: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`,
  warning: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/></svg>`,
  info: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0Zm-9-3.75h.008v.008H12V8.25Z"/></svg>`,
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
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
    </button>
  `;

  const close = () => {
    el.classList.add('toast-exit');
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('button').addEventListener('click', close);
  root.appendChild(el);

  if (duration > 0) setTimeout(close, duration);
  return { close };
}

export const toastSuccess = (msg, d) => showToast(msg, 'success', d);
export const toastError = (msg, d) => showToast(msg, 'error', d);
export const toastWarning = (msg, d) => showToast(msg, 'warning', d);
export const toastInfo = (msg, d) => showToast(msg, 'info', d);
