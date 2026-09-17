// =============================================================
// auth.js — Login, logout, sessione e ruolo utente corrente
// =============================================================

import { supabase, signIn, signOut, getSession, getMyProfile } from './supabase.js';
import { toastError, toastSuccess, toastWarning } from './toast.js';

/** Stato applicativo dell'utente corrente, popolato dopo il login */
export const authState = {
  session: null,
  profile: null, // { id, full_name, role, email }
};

const CACHED_PROFILE_KEY = 'magazzino-cached-profile';

// --- LOGOUT AUTOMATICO PER INATTIVITÀ --------------------------------
// Su dispositivi condivisi (tablet/PC in reparto) una sessione rimasta
// aperta resta autenticata a tempo indeterminato. Dopo il periodo di
// inattività sotto, l'utente viene disconnesso automaticamente; un
// avviso compare 60s prima per dargli il tempo di reagire con un tocco.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minuti senza interazione
const IDLE_WARNING_MS = 60 * 1000; // avviso 60s prima della disconnessione
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'];

let idleTimer = null;
let idleWarningTimer = null;
let activityListenersAttached = false;

/**
 * Avvia (o riavvia da zero) il conto alla rovescia di inattività. Va
 * richiamato ad ogni interazione dell'utente mentre è autenticato.
 * @param {() => void} onTimeout callback da eseguire allo scadere del tempo
 */
function resetIdleTimer(onTimeout) {
  clearTimeout(idleTimer);
  clearTimeout(idleWarningTimer);
  idleWarningTimer = setTimeout(() => {
    toastWarning('Disconnessione automatica tra 60s per inattività — tocca lo schermo per restare collegato.', 6000);
  }, IDLE_TIMEOUT_MS - IDLE_WARNING_MS);
  idleTimer = setTimeout(onTimeout, IDLE_TIMEOUT_MS);
}

function stopIdleTimer() {
  clearTimeout(idleTimer);
  clearTimeout(idleWarningTimer);
  idleTimer = null;
  idleWarningTimer = null;
}

/**
 * Collega gli ascoltatori di attività globali una sola volta per tutta la
 * vita della pagina. Il callback riceve sempre l'ultimo onTimeout valido
 * tramite il riferimento mutabile passato da initAuth, cosí funziona
 * identicamente su login/logout ripetuti nella stessa sessione di pagina.
 */
function attachActivityListeners(getIsAuthed, onTimeout) {
  if (activityListenersAttached) return;
  activityListenersAttached = true;
  for (const evt of ACTIVITY_EVENTS) {
    document.addEventListener(
      evt,
      () => {
        if (getIsAuthed()) resetIdleTimer(onTimeout);
      },
      { passive: true }
    );
  }
  // Se l'app torna in primo piano dopo essere stata in background a
  // lungo (schermo bloccato, altra app), è essa stessa "un'interazione":
  // riparte il conteggio invece di scattare subito al resume.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getIsAuthed()) resetIdleTimer(onTimeout);
  });
}

function cacheProfile(profile) {
  try {
    localStorage.setItem(CACHED_PROFILE_KEY, JSON.stringify(profile));
  } catch (err) {
    /* storage pieno o non disponibile: non blocca il login, si ignora */
  }
}

/** Profilo dell'ultimo login riuscito, salvato in locale per poterlo usare
 *  come fallback quando c'è una sessione valida ma la rete non permette
 *  di riverificarla (vedi sotto). Ritorna null se non corrisponde alla
 *  sessione attuale o non è mai stato salvato. */
function getCachedProfile(session) {
  try {
    const raw = localStorage.getItem(CACHED_PROFILE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    return cached?.id === session?.user?.id ? cached : null;
  } catch (err) {
    return null;
  }
}

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

  const handleIdleTimeout = async () => {
    try {
      await signOut();
    } catch (err) {
      console.error(err);
    }
    authState.session = null;
    authState.profile = null;
    stopIdleTimer();
    onSignedOut();
    toastWarning('Sessione terminata automaticamente per inattività.');
  };
  attachActivityListeners(() => !!authState.session, handleIdleTimeout);

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
      cacheProfile(profile);
      resetIdleTimer(handleIdleTimeout);
      toastSuccess(`Bentornato, ${profile.full_name || profile.email}`);
      onAuthed(profile);
    } catch (err) {
      console.error(err);
      errorBox.textContent = mapAuthError(err);
      errorBox.classList.remove('hidden');
      form.classList.remove('shake-error');
      void form.offsetWidth; // forza il reflow per poter rilanciare l'animazione
      form.classList.add('shake-error');
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
    stopIdleTimer();
    onSignedOut();
  });

  // Controlla sessione esistente al caricamento.
  // getSession() legge il token in locale (nessuna rete richiesta), ma
  // getMyProfile() al suo interno chiama supabase.auth.getUser(), che
  // richiede SEMPRE una verifica di rete col server. Se in quel momento
  // la rete è assente, questo NON significa "utente non loggato" — vuol
  // dire solo che non possiamo riverificarlo in questo istante. Trattarlo
  // come logout forzato l'utente sulla schermata di login, che a sua
  // volta richiede rete per accedere: un vicolo cieco offline, con in più
  // la perdita del contesto (ruolo admin/operatore) che aveva un attimo
  // prima. Se la sessione locale è valida, si ripiega sull'ultimo profilo
  // salvato in cache invece di buttare fuori l'utente.
  getSession()
    .then(async (session) => {
      if (!session) return onSignedOut(); // nessuna sessione: qui sí che è un vero logout
      try {
        const profile = await getMyProfile();
        authState.session = session;
        authState.profile = profile;
        cacheProfile(profile);
        resetIdleTimer(handleIdleTimeout);
        onAuthed(profile);
      } catch (err) {
        console.error(err);
        const cached = getCachedProfile(session);
        if (cached) {
          authState.session = session;
          authState.profile = cached;
          resetIdleTimer(handleIdleTimeout);
          toastWarning('Connessione assente: accesso con gli ultimi dati salvati.');
          onAuthed(cached);
        } else {
          // Nessun profilo in cache a cui appoggiarsi (es. primissimo
          // accesso su questo dispositivo mai riuscito online): qui non
          // c'è altra scelta che mostrare il login.
          onSignedOut();
        }
      }
    })
    .catch(() => onSignedOut());

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      stopIdleTimer();
      onSignedOut();
    }
  });
}

function mapAuthError(err) {
  const msg = err?.message || '';
  if (msg.includes('Invalid login credentials')) return 'Email o password non corrette.';
  if (msg.includes('Email not confirmed')) return 'Email non ancora confermata. Controlla la posta.';
  return 'Accesso non riuscito. Riprova.';
}
