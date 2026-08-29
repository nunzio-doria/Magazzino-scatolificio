// =============================================================
// auth.js — Login, logout, sessione e ruolo utente corrente
// =============================================================

import { supabase, signIn, signOut, getSession, getMyProfile } from './supabase.js';
import { toastError, toastSuccess } from './toast.js';

/** Stato applicativo dell'utente corrente, popolato dopo il login */
export const authState = {
  session: null,
  profile: null, // { id, full_name, role, email }
};

export function isAdmin() {
  return authState.profile?.role === 'admin';
}

/**
 * Inizializza il modulo auth: collega il form di login, controlla se
 * esiste già una sessione valida e resta in ascolto dei cambi di stato.
 * @param {(profile: object) => void} onAuthed callback chiamata quando l'utente è autenticato+profilato
 * @param {() => void} onSignedOut callback chiamata quando l'utente esce/non è autenticato
 */
export function initAuth(onAuthed, onSignedOut) {
  const form = document.getElementById('login-form');
  const emailInput = document.getElementById('login-email');
  const passInput = document.getElementById('login-password');
  const submitBtn = document.getElementById('login-submit');
  const errorBox = document.getElementById('login-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-60', 'cursor-not-allowed');
    submitBtn.querySelector('.btn-label').textContent = 'Accesso in corso…';

    try {
      await signIn(emailInput.value.trim(), passInput.value);
      const session = await getSession();
      const profile = await getMyProfile();
      authState.session = session;
      authState.profile = profile;
      toastSuccess(`Bentornato, ${profile.full_name || profile.email}`);
      onAuthed(profile);
    } catch (err) {
      console.error(err);
      errorBox.textContent = mapAuthError(err);
      errorBox.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove('opacity-60', 'cursor-not-allowed');
      submitBtn.querySelector('.btn-label').textContent = 'Accedi';
    }
  });

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try {
      await signOut();
    } catch (err) {
      console.error(err);
    }
    authState.session = null;
    authState.profile = null;
    onSignedOut();
  });

  // Controlla sessione esistente al caricamento
  getSession()
    .then(async (session) => {
      if (!session) return onSignedOut();
      const profile = await getMyProfile();
      authState.session = session;
      authState.profile = profile;
      onAuthed(profile);
    })
    .catch(() => onSignedOut());

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') onSignedOut();
  });
}

function mapAuthError(err) {
  const msg = err?.message || '';
  if (msg.includes('Invalid login credentials')) return 'Email o password non corrette.';
  if (msg.includes('Email not confirmed')) return 'Email non ancora confermata. Controlla la posta.';
  return 'Accesso non riuscito. Riprova.';
}
