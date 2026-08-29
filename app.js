// =============================================================
// app.js — Entry point: routing viste, ruoli, orchestrazione moduli
// =============================================================

import { initAuth, authState, isAdmin } from './auth.js';
import { initScanner, teardownScanner } from './scanner.js';
import { initProducts, refresh as refreshProducts } from './products.js';
import { initDashboard, refresh as refreshDashboard } from './dashboard.js';

const VIEWS = ['scanner', 'products', 'dashboard', 'settings'];
let modulesInitialized = false;
let currentView = 'scanner';

function onAuthed(profile) {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');

  document.getElementById('user-name').textContent = profile.full_name || profile.email;
  const roleLabel = profile.role === 'admin' ? 'Admin' : 'Operatore';
  document.getElementById('user-role-badge').textContent = roleLabel;
  document.getElementById('user-role-badge').className = `text-[10px] font-display font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
    profile.role === 'admin' ? 'bg-amber-500/20 text-amber-300' : 'bg-sky-500/20 text-sky-300'
  }`;
  document.getElementById('settings-user-name').textContent = profile.full_name || profile.email;
  document.getElementById('settings-user-role').textContent = roleLabel;

  // Elementi visibili solo all'admin (gestione articoli, dashboard, import Excel)
  document.querySelectorAll('[data-admin-only]').forEach((el) => {
    el.classList.toggle('hidden', !isAdmin());
  });

  if (!modulesInitialized) {
    initScanner();
    initProducts();
    initDashboard();
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
    section.classList.toggle('hidden', !active);
    navBtn?.classList.toggle('nav-active', active);
  }

  if (view !== 'scanner') teardownScanner();
  if (view === 'products') refreshProducts();
  if (view === 'dashboard') refreshDashboard();
}

initAuth(onAuthed, onSignedOut);
