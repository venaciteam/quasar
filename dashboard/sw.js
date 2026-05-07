// ═══════════════════════════════════
//   VNCT Service Worker — Quasar
//   Bump CACHE_VERSION to force update
// ═══════════════════════════════════
const CACHE_VERSION = 5;
const CACHE_NAME = `vnct-v${CACHE_VERSION}`;

const APP_SHELL = [
  '/dashboard/app.html',
  '/dashboard/index.html',
  '/dashboard/css/style.css',
  '/dashboard/css/vnct-fab-only.css',
  '/dashboard/js/vnct-common.js',
  '/dashboard/js/utils.js',
  '/dashboard/js/commandsBlock.js',
  '/dashboard/js/pages/moderation.js',
  '/dashboard/js/pages/welcome.js',
  '/dashboard/js/pages/reactionroles.js',
  '/dashboard/js/pages/embeds.js',
  '/dashboard/js/pages/customcmds.js',
  '/dashboard/js/pages/tempvoice.js',
  '/dashboard/js/app.js',
  '/dashboard/icon.png',
];

const IMMUTABLE_EXT = /\.(png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  // Never cache API or auth responses
  if (request.url.includes('/api/') || request.url.includes('/auth/')) return;

  if (IMMUTABLE_EXT.test(request.url)) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached || fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
      )
    );
  } else {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
  }
});
