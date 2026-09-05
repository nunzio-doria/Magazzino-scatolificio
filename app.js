// =============================================================
// app.js — Entry point: routing viste, ruoli, orchestrazione moduli
// =============================================================

import { initAuth, authState, isAdmin } from './auth.js';
import { initScanner, teardownScanner, activateMode } from './scanner.js';
import { initProducts, refresh as refreshProducts, teardownProducts } from './products.js';
import { initDashboard, refresh as refreshDashboard } from './dashboard.js';
import { initUsers, refreshUsers } from './users.js';
import { initPicker } from './picker.js';
import feedback, { initFeedbackSettings } from './feedback.js';
import { initPullToRefresh } from './ui-utils.js';
import { initOfflineSync } from './offline-queue.js';
import { processTransaction } from './supabase.js';
import { toastSuccess } from './toast.js';

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
    initFeedbackSettings();
    initPullToRefresh({
      'view-products': refreshProducts,
      'view-dashboard': refreshDashboard,
    });
    initOfflineSync(async (payload) => {
      const result = await processTransaction(payload);
      toastSuccess(`Sincronizzato: ${payload.codice_articolo} (${payload.tipo === 'deposito' ? 'deposito' : 'prelievo'})`, 3000);
      return result;
    });
    modulesInitialized = true;
  }
  switchView('scanner', { animate: false });

  // Shortcut PWA "Deposito"/"Prelievo": apre lo scanner già pronto nella
  // modalità scelta dalla schermata Home, invece di richiedere il tap manuale.
  const shortcutMode = new URLSearchParams(window.location.search).get('mode');
  if (shortcutMode === 'deposito' || shortcutMode === 'prelievo') {
    window.history.replaceState({}, '', window.location.pathname);
    requestAnimationFrame(() => activateMode(shortcutMode));
  }
}

function onSignedOut() {
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('auth-view').classList.remove('hidden');
  document.getElementById('login-password').value = '';
}

function initNav() {
  document.querySelectorAll('[data-nav-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      feedback.navTap();
      switchView(btn.dataset.navTarget);
      triggerNavTap(btn);
    });
  });
  document.getElementById('settings-btn').addEventListener('click', () => {
    feedback.navTap();
    switchView('settings');
  });
}

/** Bounce a molla sul pulsante appena cambiata sezione (anche su tap ravvicinati) */
function triggerNavTap(btn) {
  btn.classList.remove('nav-tapped');
  void btn.offsetWidth; // forza il replay dell'animazione
  btn.classList.add('nav-tapped');
}

export function switchView(view, { animate = true } = {}) {
  // Solo la Dashboard/Report resta riservata all'admin: il Magazzino è
  // visibile anche all'operatore in sola lettura (CRUD già disabilitato
  // in products.js tramite isAdmin() sui singoli controlli).
  if (view === 'dashboard' && !isAdmin()) view = 'scanner';
  if (view === currentView) return;
  if (isTransitioning) return; // evita di sovrapporre più transizioni se si tocca velocemente

  const previousView = currentView;
  const fromIndex = previousView ? VIEWS.indexOf(previousView) : -1;
  const toIndex = VIEWS.indexOf(view);
  const forward = fromIndex === -1 ? true : toIndex > fromIndex; // direzione: avanti = scivola da destra

  currentView = view;

  // Entrando nello Scanner, toglie il focus da qualsiasi campo di testo
  // rimasto attivo (es. la ricerca nel Magazzino) cosí la tastiera
  // virtuale si chiude subito invece di restare aperta sopra la fotocamera.
  if (view === 'scanner') document.activeElement?.blur();

  for (const v of VIEWS) {
    document.querySelector(`[data-nav-target="${v}"]`)?.classList.toggle('nav-active', v === view);
  }

  if (view !== 'scanner') teardownScanner();
  if (view !== 'products') teardownProducts();
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

  animateFluidSwap(fromSection, toSection, forward);
}

/**
 * Fluid Slide & Scale riusabile: la sezione uscente rimpicciolisce e
 * scivola via, quella entrante arriva con overshoot elastico. Usata sia
 * per il cambio Scanner/Magazzino/Report, sia (importata altrove) per il
 * toggle Elenco/Scaffalatura nel Magazzino, cosí il "linguaggio" di
 * movimento resta identico in tutta l'app.
 */
export function animateFluidSwap(fromSection, toSection, forward) {
  if (isTransitioning) return; // non sovrapporre un'animazione già in corso
  isTransitioning = true;
  const host = toSection.parentElement;

  // Misura la posizione reale (in px, coordinate viewport) della vista uscente
  // PRIMA di renderla absolute, cosí resta perfettamente allineata alla vista
  // entrante anche con il padding del contenitore.
  const hostRect = host.getBoundingClientRect();
  const fromRect = fromSection.getBoundingClientRect();
  host.style.minHeight = `${fromSection.offsetHeight}px`;

  const exitClass = forward ? 'view-fluid-exit-left' : 'view-fluid-exit-right';
  const enterClass = forward ? 'view-fluid-enter-right' : 'view-fluid-enter-left';

  fromSection.style.position = 'absolute';
  fromSection.style.top = `${fromRect.top - hostRect.top}px`;
  fromSection.style.left = `${fromRect.left - hostRect.left}px`;
  fromSection.style.width = `${fromRect.width}px`;
  fromSection.classList.add('view-fluid-leaving', exitClass);

  toSection.classList.remove('hidden');
  void toSection.offsetWidth; // forza il reflow prima di avviare l'animazione di ingresso
  toSection.classList.add('view-fluid-entering', enterClass);

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    fromSection.classList.add('hidden');
    fromSection.classList.remove('view-fluid-leaving', 'view-fluid-exit-left', 'view-fluid-exit-right');
    fromSection.style.position = '';
    fromSection.style.top = '';
    fromSection.style.left = '';
    fromSection.style.width = '';
    toSection.classList.remove('view-fluid-entering', 'view-fluid-enter-right', 'view-fluid-enter-left');
    host.style.minHeight = '';
    isTransitioning = false;
  };
  // L'ingresso (160ms di ritardo + 480ms) termina dopo l'uscita (240ms): è
  // il suo animationend a far scattare il cleanup.
  toSection.addEventListener('animationend', cleanup, { once: true });
  setTimeout(cleanup, 720); // rete di sicurezza se l'evento non scattasse
}

initAuth(onAuthed, onSignedOut);

// Registra il service worker per rendere l'app installabile (PWA).
// Auto-update: appena un nuovo service worker prende il controllo, la pagina
// si ricarica da sola una volta sola, cosí l'utente ha sempre l'ultima
// versione senza dover mai cancellare manualmente i dati del sito.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./service-worker.js');
      // Controlla subito se c'è una versione più recente (utile se l'app
      // resta aperta a lungo, o il browser non ha ancora rifatto il check).
      registration.update().catch(() => {});
      // E di nuovo ogni volta che l'utente torna sull'app dopo averla lasciata
      // in background: è il momento più naturale per aggiornarsi in silenzio.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration.update().catch(() => {});
      });
    } catch (err) {
      console.warn('Service worker non registrato:', err);
    }
  });

  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });
}
