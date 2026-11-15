const CACHE = 'evento-v3';
const SHELL = [
  '/',
  '/index.html',
  '/app.html',
  '/reset.html',
  '/css/styles.css',
  '/js/config.js',
  '/js/ui.js',
  '/js/app.js',
  '/js/login.js',
  '/js/offline.js',
  '/js/reset.js',
  '/manifest.webmanifest',
  'https://esm.sh/@supabase/supabase-js@2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API: siempre red (sin cache)
  if (url.pathname.startsWith('/api/')) return;

  // Navegación: red primero, fallback a cache
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(request).then((r) => r || caches.match('/app.html')))
    );
    return;
  }

  // Assets (incluye CDN): cache primero, revalidando en segundo plano
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
