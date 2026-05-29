const CACHE_NAME = 'tbd-portal-mobile-v16';
const APP_SHELL = [
  '/portal/',
  '/portal/index.html',
  '/portal/index.html?app=tbd-portal-mobile-v9',
  '/portal/manifest.json?v=2',
  '/dashboard/dashboard.css',
  '/dashboard/dashboard.js',
  '/dashboard/icons/icon-192.png?v=2',
  '/dashboard/icons/icon-512.png?v=2'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached || caches.match('/portal/index.html'));
      return cached || networkFetch;
    })
  );
});
