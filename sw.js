const CACHE_NAME = 'g-auth-v17';
const urlsToCache = [
  './index.html',
  './style.css',
  './script.js',
  './format-converter.html',
  './format-converter-v2.html',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const requestUrl = new URL(request.url);

  if (request.method !== 'GET' || requestUrl.origin !== self.location.origin) {
    return;
  }

  const isDocumentRequest = request.mode === 'navigate'
    || request.destination === 'document';

  if (isDocumentRequest) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const responseCopy = response.clone();
          return caches.open(CACHE_NAME)
            .then(cache => cache.put(request, responseCopy))
            .then(() => response);
        })
        .catch(() => caches.match(request)
          .then(response => response || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .then(response => response || fetch(request))
  );
});
