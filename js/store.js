// Everything is stored on the phone (localStorage). Nothing leaves the device
// except address lookups and drive-time requests.

const K_ROUTES = 'rr.routes.v1';
const K_SETTINGS = 'rr.settings.v1';
const K_CURRENT = 'rr.current.v1';
const K_GEOCACHE = 'rr.geocache.v1';
const GEOCACHE_MAX = 3000;

export const DEFAULT_SETTINGS = {
  v: 3,
  orsKey: '',
  navApp: 'builtin',    // builtin | apple | google | waze
  voice: true,
  curbside: true,       // plan arrivals with the stop on your right
  endMode: 'open',      // open | return
  mapStyle: 'satellite', // satellite | map | dark
  satKey: '',           // optional ArcGIS key for sharper imagery
  areaHint: '',
  roadLines: true,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('Storage write failed', e);
    return false;
  }
}

export const loadSettings = () => {
  const saved = read(K_SETTINGS, {});
  const s = { ...DEFAULT_SETTINGS, ...saved };
  if (!saved.v) {
    // Settings from version 1: switch to the new built-in directions once.
    s.navApp = 'builtin';
    s.voice = true;
    delete s.cartoKey;
  }
  if (!saved.v || saved.v < 3) {
    // Version 1.2: satellite map, curbside arrivals.
    s.mapStyle = 'satellite';
    s.curbside = true;
    s.roadLines = true;
    s.v = 3;
  }
  return s;
};
export const saveSettings = (s) => write(K_SETTINGS, s);

export const loadRoutes = () => {
  const r = read(K_ROUTES, []);
  return Array.isArray(r) ? r : [];
};
export const saveRoutes = (routes) => write(K_ROUTES, routes);

export const loadCurrentId = () => read(K_CURRENT, null);
export const saveCurrentId = (id) => write(K_CURRENT, id);

export function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
}

// Address -> coordinates cache, so the same address is never looked up twice.
let geocache = null;
const normAddr = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const geocache_ = {
  get(address) {
    geocache ??= read(K_GEOCACHE, {});
    return geocache[normAddr(address)] || null;
  },
  set(address, value) {
    geocache ??= read(K_GEOCACHE, {});
    geocache[normAddr(address)] = { ...value, t: Date.now() };
    const keys = Object.keys(geocache);
    if (keys.length > GEOCACHE_MAX) {
      keys.sort((a, b) => (geocache[a].t || 0) - (geocache[b].t || 0));
      for (const k of keys.slice(0, keys.length - GEOCACHE_MAX)) delete geocache[k];
    }
    write(K_GEOCACHE, geocache);
  },
  clear() {
    geocache = {};
    write(K_GEOCACHE, geocache);
  },
  size() {
    geocache ??= read(K_GEOCACHE, {});
    return Object.keys(geocache).length;
  },
};

export function storageUsedKB() {
  let total = 0;
  try {
    for (const k of [K_ROUTES, K_SETTINGS, K_CURRENT, K_GEOCACHE]) total += (localStorage.getItem(k) || '').length;
  } catch { /* ignore */ }
  return Math.round((total * 2) / 1024);
}

export async function askPersistentStorage() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch { /* ignore */ }
}
