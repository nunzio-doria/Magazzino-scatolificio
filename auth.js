// =============================================================
// auth.js — Login, logout, sessione e ruolo utente corrente
// =============================================================

import { supabase, signIn, signOut, getSession, getMyProfile } from './supabase.js';
import { toastError, toastSuccess, toastWarning } from './toast.js';
import { isNetworkError } from './offline-queue.js';

/** Stato applicativo dell'utente corrente, popolato dopo il login */
export const authState = {
  session: null,
  profile: null, // { id, full_name, role, email }
};

const CACHED_PROFILE_KEY = 'magazzino-cached-profile';

// --- TENTATIVI DI CONNESSIONE ------------------------------------------
// Se al momento dell'accesso manca la linea (anche solo per un istante),
// l'app non si arrende al primo errore né passa subito in modalità
// offline: riprova fino a 5 volte, con pause crescenti, e ripartendo
// subito se la rete torna prima della fine della pausa.
const MAX_CONNECT_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [1000, 2000, 3000, 4000]; // pausa dopo il 1°, 2°, 3°, 4° tentativo fallito

/** Tutti i tentativi sono falliti per mancanza di connessione (non per credenziali/permessi) */
class ConnectionError extends Error {
  constructor(cause) {
    super('Connessione assente');
    this.name = 'ConnectionError';
    this.cause = cause;
  }
}

/** Errore dovuto a rete assente o servizio momentaneamente irraggiungibile: vale la pena riprovare */
function isRetryableConnectionError(err) {
  if (isNetworkError(err)) return true;
  return err?.name === 'AuthRetryableFetchError' || err?.status === 0 || err?.status >= 500;
}

/** Attende ms millisecondi, ma si sblocca subito se il dispositivo torna online */
function waitOrOnline(ms) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener('online', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    window.addEventListener('online', finish, { once: true });
  });
}

/**
 * Esegue task() fino a MAX_CONNECT_ATTEMPTS volte finché fallisce per motivi
 * di connessione. Altri errori (es. password errata) vengono rilanciati subito.
 * Dopo l'ultimo tentativo fallito lancia ConnectionError.
 * @param {() => Promise<any>} task
 * @param {(attempt: number, max: number) => void} [onAttempt] chiamata prima di ogni tentativo
 */
async function withConnectionRetries(task, onAttempt) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
    onAttempt?.(attempt, MAX_CONNECT_ATTEMPTS);
    try {
      return await task();
    } catch (err) {
      if (!isRetryableConnectionError(err)) throw err;
      lastErr = err;
      if (attempt < MAX_CONNECT_ATTEMPTS) await waitOrOnline(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  throw new ConnectionError(lastErr);
}

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
  const statusBox = document.getElementById('login-status');
  const submitLabel = submitBtn.querySelector('.btn-label');

  const showStatus = (text) => {
    if (!statusBox) return;
    statusBox.textContent = text || '';
    statusBox.classList.toggle('hidden', !text);
  };
  const setFormBusy = (busy) => {
    // Il grigiore uniforme arriva dalla regola globale su :disabled (style.css); qui resta
    // solo cursor-not-allowed perché il pulsante Accedi, essendo w-full, va oltre le regole
    // pensate per i pulsanti normali.
    submitBtn.disabled = busy;
    submitBtn.classList.toggle('cursor-not-allowed', busy);
  };
  const showLoginError = (text) => {
    errorBox.textContent = text;
    errorBox.classList.remove('hidden');
  };

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
    showStatus('');
    setFormBusy(true);

    try {
      const { session, profile } = await withConnectionRetries(
        async () => {
          await signIn(emailInput.value.trim(), passInput.value);
          const session = await getSession();
          const profile = await getMyProfile();
          return { session, profile };
        },
        (attempt, max) => {
          if (attempt === 1) {
            submitLabel.textContent = 'Accesso in corso…';
          } else {
            submitLabel.textContent = `Riprovo… (${attempt}/${max})`;
            showStatus(`Connessione assente: nuovo tentativo ${attempt} di ${max}…`);
          }
        }
      );
      if (!profile) throw new Error('Profilo non trovato');
      authState.session = session;
      authState.profile = profile;
      cacheProfile(profile);
      resetIdleTimer(handleIdleTimeout);
      showStatus('');
      toastSuccess(`Bentornato, ${profile.full_name || profile.email}`);
      onAuthed(profile);
    } catch (err) {
      console.error(err);
      showStatus('');
      showLoginError(mapAuthError(err));
      form.classList.remove('shake-error');
      void form.offsetWidth; // forza il reflow per poter rilanciare l'animazione
      form.classList.add('shake-error');
    } finally {
      setFormBusy(false);
      submitLabel.textContent = 'Accedi';
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
  // getSession() legge il token in locale, ma se il token è scaduto tenta un
  // rinnovo via rete, e getMyProfile() richiede SEMPRE una verifica col
  // server. Se in quel momento la rete manca, questo NON significa "utente
  // non loggato": prima si riprova fino a 5 volte (la linea spesso torna
  // dopo pochi secondi), e solo se tutti i tentativi falliscono si ripiega
  // sull'ultimo profilo salvato in cache (modalità offline), a patto che la
  // sessione locale sia valida. Un errore diverso dalla connessione (sessione
  // revocata, profilo mancante) porta invece al login: la cache non basta.
  const onAttempt = (attempt, max) => {
    if (attempt === 1) return;
    showStatus(`Connessione assente: nuovo tentativo ${attempt} di ${max}…`);
  };

  (async () => {
    setFormBusy(true); // durante la verifica automatica il form non serve
    try {
      const session = await withConnectionRetries(() => getSession(), onAttempt);
      if (!session) return onSignedOut(); // nessuna sessione: qui sí che è un vero logout

      let profile;
      try {
        profile = await withConnectionRetries(() => getMyProfile(), onAttempt);
      } catch (err) {
        console.error(err);
        const cached = err instanceof ConnectionError ? getCachedProfile(session) : null;
        if (!cached) {
          // Nessun profilo in cache a cui appoggiarsi, oppure errore non di rete:
          // qui non c'è altra scelta che mostrare il login.
          if (err instanceof ConnectionError) showLoginError(mapAuthError(err));
          return onSignedOut();
        }
        authState.session = session;
        authState.profile = cached;
        resetIdleTimer(handleIdleTimeout);
        showStatus('');
        toastWarning('Connessione assente dopo 5 tentativi: accesso con gli ultimi dati salvati.');
        return onAuthed(cached);
      }

      if (!profile) return onSignedOut();
      authState.session = session;
      authState.profile = profile;
      cacheProfile(profile);
      resetIdleTimer(handleIdleTimeout);
      showStatus('');
      onAuthed(profile);
    } catch (err) {
      console.error(err);
      if (err instanceof ConnectionError) showLoginError(mapAuthError(err));
      onSignedOut();
    } finally {
      showStatus('');
      setFormBusy(false);
    }
  })();

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      stopIdleTimer();
      onSignedOut();
    }
  });
}

function mapAuthError(err) {
  if (err instanceof ConnectionError) {
    return `Connessione assente: impossibile accedere dopo ${MAX_CONNECT_ATTEMPTS} tentativi. Controlla la rete e riprova.`;
  }
  const msg = err?.message || '';
  if (msg.includes('Invalid login credentials')) return 'Email o password non corrette.';
  if (msg.includes('Email not confirmed')) return 'Email non ancora confermata. Controlla la posta.';
  return 'Accesso non riuscito. Riprova.';
}
