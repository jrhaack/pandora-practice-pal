/**
 * Murmur service worker: cache the app shell and use network-first loading for the bank.
 * Offline study also requires a saved bank, both audio packs, and their runtime caches.
 * Runtime imports survive shell updates; the audio libraries own model-file caches.
 */
const SHELL = 'pp-shell-v15';
const AUDIO_RUNTIME = 'murmur-audio-runtime-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './murmur-sync.js',
  './murmur-adaptive.js',
  './phone-study.js',
  './parse.js',
  './voice.js',
  './ear.js',
  './ai.js',
  './tts-worker.js',
  './stt-worker.js',
  './speechtext.js',
  './voice-setup.js',
  './audio-files.js',
  './manifest.webmanifest',
  './icons/signalcraft-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) =>
        Promise.all(
          ks.filter((k) => k.startsWith('pp-shell-') && k !== SHELL).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) {
    // Pin and retain runtime imports fetched during audio setup (JS, module workers,
    // and WASM). Model files retain their own transformers/voice cache; API traffic
    // and arbitrary cross-origin responses never enter the app cache.
    if (url.hostname !== 'cdn.jsdelivr.net' || !url.pathname.startsWith('/npm/')) return;
    e.respondWith(
      caches.open(AUDIO_RUNTIME).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const response = await fetch(e.request);
        if (response.ok) {
          const copy = response.clone();
          e.waitUntil(cache.put(e.request, copy).catch(() => {}));
        }
        return response;
      })
    );
    return;
  }
  if (
    url.pathname.endsWith('bank.json') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('/')
  ) {
    // network first so updates show up immediately; cache when offline
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' })
        .then(async (r) => {
          if (!r.ok) return (await caches.match(e.request, { ignoreSearch: true })) || r;
          const copy = r.clone();
          const saved = caches
            .open(SHELL)
            .then((c) => c.put(e.request, copy))
            .catch(() => {});
          e.waitUntil(saved);
          return r;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((r) => {
          if (r.ok) {
            const copy = r.clone();
            e.waitUntil(
              caches
                .open(SHELL)
                .then((c) => c.put(e.request, copy))
                .catch(() => {})
            );
          }
          return r;
        })
    )
  );
});
