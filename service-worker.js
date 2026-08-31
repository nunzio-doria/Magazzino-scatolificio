// =============================================================
// service-worker.js — Shell statica in cache per installabilità PWA.
// I dati (Supabase, CDN esterni) passano sempre dalla rete: qui si
// mette in cache solo l'involucro dell'app (HTML/CSS/JS/icone locali).
// =============================================================

const CACHE_NAME = 'magazzino-shell-v8';
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
  './icons/icon-192.png',
  './icons/icon-512.png',
];

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

  // Solo richieste GET same-origin: la shell statica dell'app.
  // Tutto il resto (Supabase, CDN, POST/RPC) va sempre in rete, mai intercettato.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Cache-first: risposta immediata, poi aggiorna la cache in background
        // (stale-while-revalidate) senza far dipendere la risposta dalla rete.
        fetch(request)
          .then((response) => {
            if (response && response.ok) {
              caches.open(CACHE_NAME).then((cache) => cache.put(request, response));
            }
          })
          .catch(() => {});
        return cached;
      }

      // Non in cache: prova la rete. IMPORTANTE — non deve mai risolvere con
      // undefined (causava "ERR_FAILED" nella PWA installata quando la rete
      // falliva anche solo momentaneamente su una risorsa non ancora in cache).
      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Rete assente e nulla in cache: per una navigazione di pagina,
          // ripiega sulla shell dell'app (index.html) così l'app si apre
          // comunque invece di mostrare una schermata di errore.
          if (request.mode === 'navigate') {
            return caches.match('./index.html').then((fallback) => fallback || Response.error());
          }
          return Response.error();
        });
    })
  );
});
