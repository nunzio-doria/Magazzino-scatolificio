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
let currentView = 'scanner';

function onAuthed(profile) {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');

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
  switchView('scanner');
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

function switchView(view) {
  if (view === 'products' || view === 'dashboard') {
    if (!isAdmin()) view = 'scanner';
  }
  currentView = view;

  for (const v of VIEWS) {
    const section = document.getElementById(`view-${v}`);
    const navBtn = document.querySelector(`[data-nav-target="${v}"]`);
    const active = v === view;
    if (active) {
      section.classList.remove('hidden');
      // Transizione "glass": rimuove e riapplica la classe per far ripartire l'animazione
      section.classList.remove('view-transition-active');
      void section.offsetWidth; // forza il reflow
      section.classList.add('view-transition-active');
    } else {
      section.classList.add('hidden');
      section.classList.remove('view-transition-active');
    }
    navBtn?.classList.toggle('nav-active', active);
  }

  if (view !== 'scanner') teardownScanner();
  if (view === 'products') refreshProducts();
  if (view === 'dashboard') refreshDashboard();
  if (view === 'settings' && isAdmin()) refreshUsers();
}

initAuth(onAuthed, onSignedOut);

// Registra il service worker per rendere l'app installabile (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => console.warn('Service worker non registrato:', err));
  });
}
