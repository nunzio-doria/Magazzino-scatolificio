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
import { initOfflineSync } from './offline-queue.js';
import { processTransaction, adjustCachedProductQuantity } from './supabase.js';
import { toastSuccess, toastError } from './toast.js';
import { closeAllOverlays } from './ui-utils.js';

const VIEWS = ['scanner', 'products', 'dashboard', 'settings'];
let modulesInitialized = false;
let currentView = null;
let isTransitioning = false;
let pendingSwitch = null; // ultima sezione richiesta durante una transizione: parte appena finisce
let swRegistration = null;

function onAuthed(profile) {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  window.lucide?.createIcons();

  const roleLabel = profile.role === 'admin' ? 'Admin' : 'Operatore';
  document.getElementById('user-role-badge').textContent = roleLabel;
  document.getElementById('user-role-badge').className = `ui-label whitespace-nowrap font-display font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
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
    initSettingsRefreshButton();
    initOfflineSync(
      async (payload) => {
        const result = await processTransaction(payload);
        toastSuccess(`Sincronizzato: ${payload.codice_articolo} (${payload.tipo === 'deposito' ? 'deposito' : 'prelievo'})`, 3000);
        return result;
      },
      {
        // Movimento rifiutato dal server: si avvisa l'operatore e si toglie dalla
        // cache la variazione di giacenza applicata "a vista" quando era stato accodato.
        onDiscard: ({ payload }, err) => {
          const delta = payload.tipo === 'deposito' ? payload.quantita : -payload.quantita;
          adjustCachedProductQuantity(payload.productId, -delta);
          const reason = err.message?.includes('Giacenza insufficiente') ? err.message : 'il server ha rifiutato l\'operazione';
          toastError(
            `Movimento offline NON registrato: ${payload.tipo === 'deposito' ? 'deposito' : 'prelievo'} di ${payload.quantita} su ${payload.codice_articolo} — ${reason}.`,
            9000
          );
        },
      }
    );
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
  // Pulizia completa: senza, modali aperte, fotocamera accesa e blocco dello
  // scroll resterebbero attivi sotto la schermata di login (e riapparirebbero
  // al login successivo, magari di un altro utente). Solo se l'app è già
  // stata avviata: al primo caricamento senza sessione non c'è nulla da chiudere.
  if (modulesInitialized) {
    closeAllOverlays();
    teardownScanner();
    teardownProducts();
    for (const v of VIEWS) {
      document.getElementById(`view-${v}`)?.classList.add('hidden');
      document.querySelector(`[data-nav-target="${v}"]`)?.classList.remove('nav-active');
    }
    currentView = null; // il prossimo login riparte sempre dallo Scanner
    pendingSwitch = null;
  }
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('auth-view').classList.remove('hidden');
  document.getElementById('login-password').value = '';
}

function initNav() {
  document.querySelectorAll('[data-nav-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Feedback e rimbalzo partono solo quando il cambio vista avviene davvero
      switchView(btn.dataset.navTarget, {
        onStart: () => {
          feedback.navTap();
          triggerNavTap(btn);
        },
      });
    });
  });
  document.getElementById('settings-btn').addEventListener('click', () => {
    switchView('settings', { onStart: () => feedback.navTap() });
  });
}

/**
 * Unico punto da cui, ora, si può forzare un aggiornamento: niente più
 * gesti (pull-to-refresh, con o senza tocco, sono stati rimossi). Il
 * pulsante fa due cose distinte:
 * 1. Ricarica i dati (articoli + dashboard) dal database.
 * 2. Chiede al service worker di controllare se c'è una versione più
 *    recente dell'app — se la trova, il listener 'controllerchange' già
 *    registrato più sotto ricarica la pagina in automatico una volta sola.
 */
function initSettingsRefreshButton() {
  const btn = document.getElementById('settings-refresh-btn');
  const status = document.getElementById('settings-refresh-status');
  if (!btn) return;
  let running = false;

  btn.addEventListener('click', async () => {
    if (running) return;
    running = true;
    btn.disabled = true;
    btn.classList.add('opacity-60', 'pointer-events-none');
    if (status) status.textContent = 'Aggiornamento in corso…';

    const results = await Promise.allSettled([
      refreshProducts(),
      refreshDashboard(),
      swRegistration ? swRegistration.update() : Promise.resolve(),
    ]);
    const failed = results.some((r) => r.status === 'rejected');

    btn.disabled = false;
    btn.classList.remove('opacity-60', 'pointer-events-none');
    running = false;

    if (failed) {
      if (status) status.textContent = '';
      toastError('Aggiornamento parziale: controlla la connessione.');
    } else {
      if (status) status.textContent = 'Dati aggiornati.';
      toastSuccess('Aggiornato.', 2000);
      setTimeout(() => {
        if (status) status.textContent = '';
      }, 4000);
    }
  });
}

/** Bounce a molla sul pulsante appena cambiata sezione (anche su tap ravvicinati) */
function triggerNavTap(btn) {
  btn.classList.remove('nav-tapped');
  void btn.offsetWidth; // forza il replay dell'animazione
  btn.classList.add('nav-tapped');
}

/**
 * @param {string} view
 * @param {{ animate?: boolean, onStart?: () => void }} [opts] onStart viene
 *   richiamata solo quando il cambio vista parte davvero (non se è già la
 *   vista corrente, e con un po' di ritardo se prima deve finire una transizione).
 */
export function switchView(view, { animate = true, onStart } = {}) {
  // Solo la Dashboard/Report resta riservata all'admin: il Magazzino è
  // visibile anche all'operatore in sola lettura (CRUD già disabilitato
  // in products.js tramite isAdmin() sui singoli controlli).
  if (view === 'dashboard' && !isAdmin()) view = 'scanner';
  if (isTransitioning) {
    // Non si sovrappongono due transizioni: si ricorda solo l'ultimo tocco
    // (se torna alla vista già in arrivo, la richiesta in coda decade).
    pendingSwitch = view === currentView ? null : { view, opts: { animate, onStart } };
    return;
  }
  if (view === currentView) return;
  onStart?.();

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

  // Il refresh (fetch rete + ricostruzione della lista + rigenerazione delle
  // icone) è rinviato a dopo la fine dell'animazione invece di partire nello
  // stesso istante del tocco: se parte subito, il lavoro pesante sul thread
  // principale compete con la CSS animation proprio nei suoi primi frame,
  // ed è la causa più probabile di scatti percepiti durante il cambio vista.
  const doRefresh = () => {
    if (view === 'products') refreshProducts();
    if (view === 'dashboard') refreshDashboard();
    if (view === 'settings' && isAdmin()) refreshUsers();
  };

  const toSection = document.getElementById(`view-${view}`);
  const fromSection = previousView ? document.getElementById(`view-${previousView}`) : null;

  if (!animate || !fromSection) {
    // Prima apparizione: nessuna vista precedente da cui uscire, la mostra e basta
    fromSection?.classList.add('hidden');
    toSection.classList.remove('hidden');
    doRefresh();
    return;
  }

  animateFluidSwap(fromSection, toSection, forward, doRefresh);
}

/**
 * Fluid Slide & Scale riusabile: la sezione uscente rimpicciolisce e
 * scivola via, quella entrante arriva con overshoot elastico. Usata sia
 * per il cambio Scanner/Magazzino/Report, sia (importata altrove) per il
 * toggle Elenco/Scaffalatura nel Magazzino, cosí il "linguaggio" di
 * movimento resta identico in tutta l'app.
 * @param {() => void} [onSettled] - richiamata a transizione conclusa (es.
 *   per rimandare lì il refresh dati pesante, invece di farlo partire nello
 *   stesso istante dell'animazione e rischiare di farla scattare).
 */
export function animateFluidSwap(fromSection, toSection, forward, onSettled) {
  if (isTransitioning) return; // non sovrapporre un'animazione già in corso
  isTransitioning = true;
  const host = toSection.parentElement;

  // Per la durata della transizione, sia la vista uscente (ancora presente,
  // position:absolute alla sua geometria originale) sia quella entrante
  // (già alla sua altezza reale, non "cresce" gradualmente: solo min-height
  // lo fa, il contenuto vero no) contribuiscono insieme all'altezza
  // scrollabile del documento, che quindi oscilla bruscamente per una
  // frazione di secondo. Su Android questo fa lampeggiare per un istante
  // la scrollbar overlay — confermato via screen recording. Bloccando qui
  // lo scroll della pagina, il browser non ha nulla a cui reagire; lo stato
  // finale (corretto) si ristabilisce da solo non appena sblocchiamo, a
  // transizione conclusa.
  const previousHtmlOverflowY = document.documentElement.style.overflowY;
  document.documentElement.style.overflowY = 'hidden';

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

  // Le classi di ingresso si applicano PRIMA di togliere "hidden": un elemento
  // display:none non fa partire le sue animazioni CSS, quindi restano "in
  // pausa" al fotogramma iniziale finché non diventa visibile. Evita cosí un
  // istante in cui la vista entrante sarebbe visibile alla sua dimensione
  // naturale piena, non ancora ridotta/sfumata dall'animazione — uno dei
  // contributi al rimbalzo di altezza che faceva comparire/sparire la
  // scrollbar durante il cambio di sezione.
  toSection.classList.add('view-fluid-entering', enterClass);
  toSection.classList.remove('hidden');

  // L'altezza del contenitore segue quella della vista in arrivo con una
  // transizione morbida invece di restare bloccata sull'altezza della vista
  // vecchia fino alla fine e poi "saltare" di colpo alla nuova: è uno degli
  // scatti più percepibili quando due viste hanno lunghezze molto diverse
  // (es. dal Magazzino, con tanti articoli, allo Scanner, molto più corto).
  const toHeight = toSection.offsetHeight;
  host.style.transition = 'min-height 320ms cubic-bezier(0.22, 1, 0.36, 1)';
  requestAnimationFrame(() => {
    host.style.minHeight = `${toHeight}px`;
  });

  let done = false;
  const onEnterEnd = (e) => {
    if (e.target === toSection) cleanup();
  };
  const cleanup = () => {
    if (done) return;
    done = true;
    toSection.removeEventListener('animationend', onEnterEnd); // niente listener residui se scatta prima il timer
    fromSection.classList.add('hidden');
    fromSection.classList.remove('view-fluid-leaving', 'view-fluid-exit-left', 'view-fluid-exit-right');
    fromSection.style.position = '';
    fromSection.style.top = '';
    fromSection.style.left = '';
    fromSection.style.width = '';
    toSection.classList.remove('view-fluid-entering', 'view-fluid-enter-right', 'view-fluid-enter-left');
    host.style.minHeight = '';
    host.style.transition = '';
    document.documentElement.style.overflowY = previousHtmlOverflowY;
    isTransitioning = false;
    // Se nel frattempo è stata toccata un'altra sezione, si passa subito a
    // quella (il refresh della vista intermedia sarebbe lavoro sprecato).
    if (pendingSwitch) {
      const { view, opts } = pendingSwitch;
      pendingSwitch = null;
      switchView(view, opts);
      return;
    }
    // Il lavoro pesante (fetch + ricostruzione DOM + icone) parte solo ora,
    // a thread principale libero dall'animazione appena conclusa.
    onSettled?.();
  };
  // L'ingresso (160ms di ritardo + 520ms) termina dopo l'uscita (260ms): è
  // il suo animationend a far scattare il cleanup. Si considera solo
  // l'evento della vista stessa: quelli degli elementi interni (righe della
  // lista, badge, stati vuoti...) risalgono fino a qui e finiscono prima,
  // chiudendo la transizione in anticipo.
  toSection.addEventListener('animationend', onEnterEnd);
  setTimeout(cleanup, 720); // rete di sicurezza se l'evento non scattasse
}

/**
 * Misura l'altezza reale della barra in basso (margine di sicurezza incluso)
 * e la pubblica come variabile CSS --nav-h, da cui dipendono lo spazio in
 * fondo al contenuto e la posizione dei toast. Si riaggiorna da sola se
 * cambia (rotazione, dimensione del testo, margini del dispositivo).
 */
function initNavMetrics() {
  const nav = document.querySelector('nav.nav-glass');
  if (!nav) return;
  const update = () => {
    const h = nav.offsetHeight;
    if (h > 0) document.documentElement.style.setProperty('--nav-h', `${h}px`); // 0 = ancora nascosta (login)
  };
  update();
  if ('ResizeObserver' in window) {
    try {
      new ResizeObserver(update).observe(nav, { box: 'border-box' });
    } catch (err) {
      new ResizeObserver(update).observe(nav);
    }
  }
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
}

initNavMetrics();
initAuth(onAuthed, onSignedOut);

// Registra il service worker per rendere l'app installabile (PWA).
// Auto-update: appena un nuovo service worker prende il controllo, la pagina
// si ricarica da sola una volta sola, cosí l'utente ha sempre l'ultima
// versione senza dover mai cancellare manualmente i dati del sito.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./service-worker.js');
      swRegistration = registration;
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
