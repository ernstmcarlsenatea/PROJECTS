// Phase 6 — minimal PWA service worker for the Kundeplan Cartoon Atlas.
//
// Strategy:
//   - App shell (index.html): network-first, fall back to cache. This means
//     fresh deploys are picked up as soon as the user is online, but the app
//     still loads when offline.
//   - Hashed assets (/assets/*): cache-first, with background revalidation.
//     Vite emits content-hashed filenames, so a hit is always safe to serve.
//   - Anything else (e.g. Firestore / Google APIs): bypassed completely so
//     the SDK's own offline persistence handles it.
//
// To upgrade: bump CACHE_VERSION. The 'activate' handler purges any cache
// whose name does not match the current version.

const CACHE_VERSION = 'kundeplan-v1';
const APP_SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isSameOrigin(url) {
  try {
    return new URL(url).origin === self.location.origin;
  } catch (_) {
    return false;
  }
}

function isHashedAsset(url) {
  try {
    return new URL(url).pathname.includes('/assets/');
  } catch (_) {
    return false;
  }
}

function isNavigationRequest(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!isSameOrigin(request.url)) return; // Let Firestore / MSAL handle their own traffic.

  if (isNavigationRequest(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  if (isHashedAsset(request.url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        });
      })
    );
  }
});
