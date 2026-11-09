// Offline service worker: cache-first for the app shell + libraries.
// Bump CACHE whenever any file below changes — that is what makes installed apps
// see the "Nova verzija" banner.
const CACHE = 'moj-budzet-v29';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css',
  './js/app.js', './js/db.js', './js/repo.js', './js/analytics.js',
  './js/categorize.js', './js/crypto.js', './js/parse-intesa.js', './js/import-pdf.js',
  './vendor/sql-wasm.js', './vendor/sql-wasm.wasm',
  './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
  './vendor/chart.umd.js', './vendor/xlsx.full.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable.png',
];

self.addEventListener('install', e => {
  // Do NOT skipWaiting automatically — the new version waits until the user taps
  // "Osveži", then we skipWaiting + reload (auto-update UX without surprise reloads).
  // cache:'reload' bypasses the browser HTTP cache (GitHub Pages serves max-age=600),
  // so a new version never gets packaged with stale copies of the old files.
  e.waitUntil(caches.open(CACHE).then(c =>
    c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('message', e => { if(e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if(res && res.ok && new URL(e.request.url).origin === self.location.origin){
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      }
      return res;
    }).catch(() => e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
  );
});
