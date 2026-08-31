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
const MASK_BARS = 10;      // numero di barre del sipario
const MASK_STEP_MS = 22;   // sfalsamento tra una barra e la successiva
const MASK_PHASE_MS = 260; // durata dell'animazione della singola barra
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

  // Elementi visibili solo all'admin (gestione articoli, dashboard, import Excel, utenti).
  // Le sezioni view-* sono escluse: la loro visibilità è gestita esclusivamente da
  // switchView() — se le tocchiamo qui, per un admin la vista rimane "smascherata"
  // al primo render, ancora prima che switchView() abbia scelto la vista corrente,
  // causando la sovrapposizione Scanner/Report al primo avvio.
  document.querySelectorAll('[data-admin-only]').forEach((el) => {
    if (el.id?.startsWith('view-')) return;
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

  // Sipario di barre verticali sopra le due view. Nessun posizionamento
  // assoluto delle sezioni: fromSection e toSection restano ognuna al
  // proprio posto nel flusso normale, e non sono MAI entrambe visibili
  // nello stesso frame — lo swap avviene solo a schermo coperto.
  const curtain = document.createElement('div');
  curtain.className = 'view-mask-curtain';
  const bars = [];
  for (let i = 0; i < MASK_BARS; i++) {
    const bar = document.createElement('div');
    bar.className = 'view-mask-bar';
    // Avanti: sfalsamento da sinistra a destra. Indietro: specchiato,
    // cosí il sipario "insegue" la direzione di navigazione.
    bar.style.setProperty('--i', forward ? i : MASK_BARS - 1 - i);
    bar.style.setProperty('--mask-step', `${MASK_STEP_MS}ms`);
    bar.style.setProperty('--mask-phase', `${MASK_PHASE_MS}ms`);
    curtain.appendChild(bar);
    bars.push(bar);
  }
  host.style.position = host.style.position || 'relative';
  host.appendChild(curtain);

  const coverDuration = (MASK_BARS - 1) * MASK_STEP_MS + MASK_PHASE_MS;

  requestAnimationFrame(() => {
    bars.forEach((bar) => bar.classList.add('covering'));
  });

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    curtain.remove();
    isTransitioning = false;
  };

  setTimeout(() => {
    // Schermo completamente coperto: swap istantaneo del contenuto,
    // invisibile all'utente, poi si apre il sipario in rivelazione.
    fromSection.classList.add('hidden');
    toSection.classList.remove('hidden');
    bars.forEach((bar) => {
      bar.classList.remove('covering');
      bar.classList.add('revealing');
    });
    setTimeout(cleanup, coverDuration + 30); // +30ms rete di sicurezza
  }, coverDuration);
}

initAuth(onAuthed, onSignedOut);

// Registra il service worker per rendere l'app installabile (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => console.warn('Service worker non registrato:', err));
  });
}
