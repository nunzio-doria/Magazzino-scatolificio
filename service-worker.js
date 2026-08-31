// =============================================================
// service-worker.js — Shell statica in cache per installabilità PWA.
// I dati (Supabase, CDN esterni) passano sempre dalla rete: qui si
// mette in cache solo l'involucro dell'app (HTML/CSS/JS/icone locali).
// =============================================================

const CACHE_NAME = 'magazzino-shell-v5';
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
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
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
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
