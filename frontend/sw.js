// Force update: bump version number to bust the cache
const CACHE = 'ekalavya-v30';

self.addEventListener('install', e => {
  // Skip waiting immediately — don't wait for old tabs to close
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(['./', './index.html', './manifest.json'])).catch(() => {})
  );
});

self.addEventListener('activate', e => {
  // Delete ALL old caches immediately
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => {
        console.log('[SW] Deleting old cache:', k);
        return caches.delete(k);
      }))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/') || e.request.url.includes('railway.app')) return;

  // Network-first for HTML AND JavaScript — always get the current
  // version. A previous "cache first" rule for .js files meant that
  // once a browser cached app.js, it would NEVER check for updates
  // again on its own, regardless of what was actually deployed —
  // every future code fix would silently fail to reach that device
  // until its cache was manually cleared. Falls back to the cached
  // copy only if the network request genuinely fails (offline use).
  if (e.request.url.endsWith('.html') || e.request.url.endsWith('.js') || e.request.url.endsWith('/')) {
    e.respondWith(
      fetch(e.request)
        .then(r => { const clone = r.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache first for everything else (images, fonts, etc. — safe to
  // cache since these rarely change and aren't where bug fixes live)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
