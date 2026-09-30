// Pandora Practice service worker: app shell cached, bank.json network-first with cache fallback.
const SHELL = 'pp-shell-v3';
const ASSETS = ['./', './index.html', './style.css', './app.js', './parse.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;                       // API calls go straight out
  if (url.pathname.endsWith('bank.json')) {
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok && e.request.method === 'GET') { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); } return r; })));
});
