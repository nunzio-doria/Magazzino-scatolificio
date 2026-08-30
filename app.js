// =============================================================
// app.js — Entry point: routing viste, ruoli, orchestrazione moduli
// =============================================================

import { initAuth, authState, isAdmin } from './auth.js';
import { initScanner, teardownScanner } from './scanner.js';
import { initProducts, refresh as refreshProducts } from './products.js';
import { initDashboard, refresh as refreshDashboard } from './dashboard.js';
import { initUsers, refreshUsers } from './users.js';
import { initPicker } from './picker.js';

const VIEWS = ['scanner', 'products', 'dashboard', 'settings'];
let modulesInitialized = false;
let currentView = null;
let isTransitioning = false;

function onAuthed(profile) {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  window.lucide?.createIcons();

  const roleLabel = profile.role === 'admin' ? 'Admin' : 'Operatore';
  document.getElementById('user-role-badge').textContent = roleLabel;
  document.getElementById('user-role-badge').className = `text-[10px] font-display font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
    profile.role === 'admin' ? 'bg-amber-500/20 text-amber-400' : 'bg-sky-500/20 text-sky-700'
  }`;
  document.getElementById('settings-user-name').textContent = profile.full_name || profile.email;
  document.getElementById('settings-user-role').textContent = roleLabel;

  // Elementi visibili solo all'admin (gestione articoli, dashboard, import Excel, utenti)
  document.querySelectorAll('[data-admin-only]').forEach((el) => {
    el.classList.toggle('hidden', !isAdmin());
  });

  if (!modulesInitialized) {
    initPicker();
    initScanner();
    initProducts();
    initDashboard();
    initUsers();
    initNav();
    modulesInitialized = true;
  }
  switchView('scanner', { animate: false });
}

function onSignedOut() {
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('auth-view').classList.remove('hidden');
  document.getElementById('login-password').value = '';
}

function initNav() {
  document.querySelectorAll('[data-nav-target]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.navTarget));
  });
  document.getElementById('settings-btn').addEventListener('click', () => switchView('settings'));
}

function switchView(view, { animate = true } = {}) {
  if (view === 'products' || view === 'dashboard') {
    if (!isAdmin()) view = 'scanner';
  }
  if (view === currentView) return;
  if (isTransitioning) return; // evita di sovrapporre più transizioni se si tocca velocemente

  const previousView = currentView;
  const fromIndex = previousView ? VIEWS.indexOf(previousView) : -1;
  const toIndex = VIEWS.indexOf(view);
  const forward = fromIndex === -1 ? true : toIndex > fromIndex; // direzione: avanti = scivola da destra

  currentView = view;

  for (const v of VIEWS) {
    document.querySelector(`[data-nav-target="${v}"]`)?.classList.toggle('nav-active', v === view);
  }

  if (view !== 'scanner') teardownScanner();
  if (view === 'products') refreshProducts();
  if (view === 'dashboard') refreshDashboard();
  if (view === 'settings' && isAdmin()) refreshUsers();

  const toSection = document.getElementById(`view-${view}`);
  const fromSection = previousView ? document.getElementById(`view-${previousView}`) : null;

  if (!animate || !fromSection) {
    // Prima apparizione: nessuna vista precedente da cui uscire, la mostra e basta
    fromSection?.classList.add('hidden');
    toSection.classList.remove('hidden');
    return;
  }

  animateViewSwitch(fromSection, toSection, forward);
}

function animateViewSwitch(fromSection, toSection, forward) {
  isTransitioning = true;
  const host = toSection.parentElement;

  // Misura la posizione reale (in px, coordinate viewport) della vista uscente
  // PRIMA di renderla absolute, cosí l'overlay resta perfettamente allineato
  // alla vista entrante anche con il padding del contenitore (main).
  const hostRect = host.getBoundingClientRect();
  const fromRect = fromSection.getBoundingClientRect();

  host.style.minHeight = `${fromSection.offsetHeight}px`;

  const exitClass = forward ? 'view-exit-to-left' : 'view-exit-to-right';
  const enterClass = forward ? 'view-enter-from-right' : 'view-enter-from-left';

  fromSection.style.position = 'absolute';
  fromSection.style.top = `${fromRect.top - hostRect.top}px`;
  fromSection.style.left = `${fromRect.left - hostRect.left}px`;
  fromSection.style.width = `${fromRect.width}px`;
  fromSection.classList.add('view-leaving', exitClass);

  toSection.classList.remove('hidden');
  void toSection.offsetWidth; // forza il reflow prima di avviare l'animazione di ingresso
  toSection.classList.add('view-entering', enterClass);

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    fromSection.classList.add('hidden');
    fromSection.classList.remove('view-leaving', 'view-exit-to-left', 'view-exit-to-right');
    fromSection.style.position = '';
    fromSection.style.top = '';
    fromSection.style.left = '';
    fromSection.style.width = '';
    toSection.classList.remove('view-entering', 'view-enter-from-right', 'view-enter-from-left');
    host.style.minHeight = '';
    isTransitioning = false;
  };
  toSection.addEventListener('animationend', cleanup, { once: true });
  setTimeout(cleanup, 550); // rete di sicurezza se l'evento non scattasse
}

initAuth(onAuthed, onSignedOut);

// Registra il service worker per rendere l'app installabile (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => console.warn('Service worker non registrato:', err));
  });
}
