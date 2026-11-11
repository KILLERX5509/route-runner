// Offline support. App files: network first (so updates show up right away),
// falling back to the saved copy when there's no signal. Map tiles and the
// Excel reader: saved copy first.

const VERSION = 'rr-1.0.0';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/optimizer.js',
  './js/importer.js',
  './js/services.js',
  './js/store.js',
  './lib/leaflet/leaflet.js',
  './lib/leaflet/leaflet.css',
  './fonts/overpass-400.woff2',
  './fonts/overpass-600.woff2',
  './fonts/overpass-800.woff2',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];
const TILE_CACHE = 'rr-tiles';
const LIB_CACHE = 'rr-libs';
const TILE_MAX = 2500;
const TILE_HOSTS = ['basemaps.cartocdn.com', 'tile.openstreetmap.org'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([VERSION, TILE_CACHE, LIB_CACHE]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req));
  } else if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    e.respondWith(cacheFirst(req, TILE_CACHE, true));
  } else if (url.hostname === 'cdn.sheetjs.com') {
    e.respondWith(cacheFirst(req, LIB_CACHE, false));
  }
  // Everything else (address lookup, drive times) goes straight to the network.
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}

let putsSinceTrim = 0;
async function cacheFirst(req, name, trim) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') {
    cache.put(req, res.clone());
    if (trim && ++putsSinceTrim > 100) {
      putsSinceTrim = 0;
      const keys = await cache.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - TILE_MAX))) await cache.delete(k);
    }
  }
  return res;
}
