// Murmur service worker: app shell cached; bank.json network-first; works offline after the first visit.
const SHELL = 'pp-shell-v11';
const ASSETS = ['./', './index.html', './style.css', './app.js', './parse.js', './voice.js', './ear.js', './ai.js', './tts-worker.js', './stt-worker.js', './speechtext.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('pp-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // APIs, CDN and the voice model go straight out (the model has its own cache)
  if (url.pathname.endsWith('bank.json') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    // network first so updates show up immediately; cache when offline
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); } return r; })));
});
