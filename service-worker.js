// =============================================================
// service-worker.js — Shell statica in cache per installabilità PWA.
// I dati (Supabase, CDN esterni) passano sempre dalla rete: qui si
// mette in cache solo l'involucro dell'app (HTML/CSS/JS/icone locali).
//
// Strategia: NETWORK-FIRST, non più cache-first. La cache serve solo
// come fallback per l'offline, mai come fonte primaria — così se in
// cache finisce mai una versione rotta o vecchia di un file, non resta
// "incollata" lì per sempre: appena la rete è disponibile la richiesta
// successiva la sovrascrive da sola, senza bisogno di cancellare
// manualmente i dati del sito da Chrome.
//
// Librerie esterne (CDN): l'app le carica da fuori (Supabase, Tailwind,
// lettore codici, icone...). Per poter partire anche senza rete vengono
// salvate in cache alla prima volta che si caricano online. Quelle con
// versione fissa nell'URL si servono direttamente dalla cache; le altre
// (Tailwind, Supabase "@2", CSS dei font) restano rete-prima.
// =============================================================

const CACHE_NAME = 'magazzino-shell-v12';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './tailwind.config.js',
  './manifest.json',
  './app.js',
  './auth.js',
  './camera.js',
  './scanner.js',
  './products.js',
  './dashboard.js',
  './toast.js',
  './supabase.js',
  './picker.js',
  './users.js',
  './ui-modal.js',
  './ui-select.js',
  './feedback.js',
  './ui-utils.js',
  './offline-queue.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.ico',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
];

// Host esterni da cui l'app carica librerie e font: solo questi vengono
// salvati in cache, tutto il resto (Supabase API, ecc.) passa sempre dalla rete.
const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdn.tailwindcss.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

/** URL con versione esatta (es. lib@2.5.2) o file font: contenuto immutabile, si può servire dalla cache. */
function isImmutableCdnUrl(url) {
  return url.hostname === 'fonts.gstatic.com' || /@\d+\.\d+\.\d+/.test(url.pathname);
}

/** Salva in cache solo risposte utili (anche "opaque" dei tag <script> cross-origin), mai i contenuti parziali (206). */
function isCacheable(response) {
  return response && response.status !== 206 && (response.ok || response.type === 'opaque');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Promise.allSettled invece di cache.addAll: se un singolo file manca o
      // fallisce (es. 404), non deve compromettere la cache di tutti gli altri.
      Promise.allSettled(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] impossibile mettere in cache', url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCdn = CDN_HOSTS.includes(url.hostname);

  // Solo la shell statica dell'app e le librerie/font dei CDN elencati.
  // Tutto il resto (Supabase, POST/RPC, altri domini) va sempre in rete, mai intercettato.
  if (!isSameOrigin && !isCdn) return;

  // Librerie con versione fissa: cache-first (non cambiano mai), rete solo se mancano.
  if (isCdn && isImmutableCdnUrl(url)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetchAndCache(request))
    );
    return;
  }

  event.respondWith(
    // Rete come prima scelta: qualsiasi risposta valida aggiorna subito la
    // cache, cosí un file rotto o vecchio non può mai restare "bloccato"
    // come fonte primaria — solo l'offline reale ripiega sulla cache.
    fetchAndCache(request).catch(() =>
      caches.match(request).then((cached) => {
        if (cached) return cached;
        // Nulla in cache e rete assente: per una navigazione di pagina,
        // ripiega sulla shell dell'app (index.html) così l'app si apre
        // comunque invece di mostrare una schermata di errore.
        if (request.mode === 'navigate') {
          return caches.match('./index.html').then((fallback) => fallback || Response.error());
        }
        return Response.error();
      })
    )
  );
});

function fetchAndCache(request) {
  return fetch(request).then((response) => {
    if (isCacheable(response)) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
    }
    return response;
  });
}
