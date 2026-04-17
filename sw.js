const CACHE = 'filedrop-v21';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './preview.svg',
  './lib/peerjs.min.js',
  './lib/qrcode.min.js',
  './lib/html5-qrcode.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(url => c.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, {ignoreSearch: true}).then(cached => cached || fetch(e.request))
  );
});
