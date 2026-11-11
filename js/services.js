// Map data services: address lookup, drive times, road shapes.
//
// Address lookup, in order:
//   1. US Census Bureau geocoder (free, no key, built for US street addresses),
//      trying a few spellings ("US-45" -> "Hwy 45", without "Unit C", ...)
//   2. OpenRouteService, if you added a key
//   3. OpenStreetMap Nominatim (free, ~1 lookup a second)
//   4. Nominatim by business name + city, as a last resort
//
// Drive times and road shapes come from the free OpenStreetMap routing server
// (FOSSGIS OSRM). OpenRouteService is a backup if you added a key; straight
// lines are the last resort.

import { geocache_ } from './store.js';
import { cleanAddress } from './importer.js';

const ORS = 'https://api.openrouteservice.org';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
export const OSRM = 'https://routing.openstreetmap.de/routed-car';
const ROAD_FACTOR = 1.3;     // straight line -> rough road distance
const AVG_SPEED = 15.6;      // m/s, about 35 mph including town driving

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function haversine(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function straightMatrix(pts) {
  const distances = pts.map((a) => pts.map((b) => haversine(a, b) * ROAD_FACTOR));
  const durations = distances.map((row) => row.map((d) => d / AVG_SPEED));
  return { distances, durations, road: false };
}

class OrsError extends Error {
  constructor(msg, kind) { super(msg); this.kind = kind; }
}

/* ------------------------------------------------ OSRM (free routing server) */

// The free server asks for at most one request a second, so requests queue up.
let osrmChain = Promise.resolve();
let osrmLast = 0;
export function osrmGet(path, signal) {
  const run = async () => {
    const wait = 1100 - (Date.now() - osrmLast);
    if (wait > 0) await sleep(wait);
    osrmLast = Date.now();
    let res;
    try { res = await fetch(OSRM + path, { signal }); } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error("Couldn't reach the routing server. Check your connection.");
    }
    if (!res.ok) throw new Error(`Routing server error ${res.status}`);
    const j = await res.json();
    if (j.code !== 'Ok') throw new Error(j.message || j.code || 'Routing failed');
    return j;
  };
  const p = osrmChain.then(run, run);
  osrmChain = p.catch(() => {});
  return p;
}
export const coordPath = (pts) => pts.map((p) => `${(+p.lng).toFixed(6)},${(+p.lat).toFixed(6)}`).join(';');

async function osrmTable(pts, signal) {
  const j = await osrmGet(`/table/v1/driving/${coordPath(pts)}?annotations=duration,distance`, signal);
  return { durations: j.durations, distances: j.distances };
}

async function osrmLine(pts, signal) {
  const out = [];
  for (let s = 0; s < pts.length - 1; s += 79) {
    const chunk = pts.slice(s, s + 80);
    if (chunk.length < 2) break;
    const j = await osrmGet(`/route/v1/driving/${coordPath(chunk)}?overview=full&geometries=geojson`, signal);
    out.push(...(j.routes?.[0]?.geometry?.coordinates || []));
  }
  return out; // [lng, lat]
}

/* --------------------------------------------- OpenRouteService (optional) */

async function orsPost(path, key, body, signal) {
  let res;
  try {
    res = await fetch(ORS + path, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json, application/geo+json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new OrsError("Couldn't reach OpenRouteService. Check your connection.", 'network');
  }
  if (!res.ok) throw await orsHttpError(res);
  return res.json();
}

async function orsHttpError(res) {
  if (res.status === 401 || res.status === 403) return new OrsError('Your OpenRouteService key was rejected. Check it in Settings.', 'key');
  if (res.status === 429) return new OrsError('OpenRouteService limit reached for now. Try again in a minute, or tomorrow.', 'limit');
  let msg = `error ${res.status}`;
  try {
    const j = await res.json();
    msg = j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.message || msg;
  } catch { /* ignore */ }
  return new OrsError(`OpenRouteService: ${msg}`, 'other');
}

export async function testOrsKey(key) {
  const res = await orsPost('/v2/matrix/driving-car', key, {
    locations: [[-88.4273, 33.4957], [-88.4, 33.51]], metrics: ['duration'],
  });
  return Array.isArray(res.durations);
}

export async function orsPostRaw(path, key, body, signal) { return orsPost(path, key, body, signal); }

async function orsMatrix(key, pts, signal) {
  const n = pts.length;
  const locations = pts.map((p) => [p.lng, p.lat]);
  const per = Math.max(1, Math.floor(3500 / n));
  const durations = new Array(n), distances = new Array(n);
  for (let s = 0; s < n; s += per) {
    const sources = [];
    for (let i = s; i < Math.min(n, s + per); i++) sources.push(i);
    const body = { locations, metrics: ['duration', 'distance'], units: 'm' };
    if (per < n) { body.sources = sources; body.destinations = [...Array(n).keys()]; }
    const j = await orsPost('/v2/matrix/driving-car', key, body, signal);
    sources.forEach((src, k) => { durations[src] = j.durations[k]; distances[src] = j.distances[k]; });
    if (s + per < n) await sleep(1600);
  }
  return { durations, distances };
}

async function orsLine(key, pts, signal) {
  const out = [];
  for (let s = 0; s < pts.length - 1; s += 49) {
    const chunk = pts.slice(s, s + 50);
    if (chunk.length < 2) break;
    const j = await orsPost('/v2/directions/driving-car/geojson', key, {
      coordinates: chunk.map((p) => [p.lng, p.lat]), radiuses: chunk.map(() => -1), instructions: false,
    }, signal);
    out.push(...(j.features?.[0]?.geometry?.coordinates || []));
  }
  return out;
}

/* ------------------------------------------------------ public routing API */

// Drive-time matrix: free routing server, then OpenRouteService, then straight lines.
export async function driveMatrix(pts, { orsKey, signal } = {}) {
  const fix = (m) => {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (m.durations[i]?.[j] == null || m.distances[i]?.[j] == null) {
          const d = haversine(pts[i], pts[j]) * ROAD_FACTOR * 1.5;
          m.distances[i][j] = d;
          m.durations[i][j] = d / AVG_SPEED;
        }
      }
    }
    return m;
  };
  let note = '';
  try { return { ...fix(await osrmTable(pts, signal)), road: true }; } catch (e) {
    if (e.name === 'AbortError') throw e;
    note = e.message;
  }
  if (orsKey) {
    try { return { ...fix(await orsMatrix(orsKey, pts, signal)), road: true }; } catch (e) {
      if (e.name === 'AbortError') throw e;
      note = e.message;
    }
  }
  return { ...straightMatrix(pts), note };
}

// Road-following line through the points. Returns [[lng, lat], ...] or [].
export async function roadLine(pts, { orsKey, signal } = {}) {
  try { return await osrmLine(pts, signal); } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  if (orsKey) {
    try { return await orsLine(orsKey, pts, signal); } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }
  return [];
}

/* --------------------------------------------------------- address lookup */

const RANK = { exact: 3, street: 2, rough: 1 };

// JSONP: the Census geocoder doesn't allow normal cross-site requests.
let jsonpSeq = 0;
function jsonp(url, signal, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const cb = `__rrjsonp${jsonpSeq++}_${Date.now().toString(36)}`;
    const s = document.createElement('script');
    let done = false;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      window[cb] = () => { delete window[cb]; }; // late replies land harmlessly
      s.remove();
    };
    const onAbort = () => { if (!done) { finish(); reject(new DOMException('Aborted', 'AbortError')); } };
    window[cb] = (data) => { if (!done) { finish(); resolve(data); } };
    s.onerror = () => { if (!done) { finish(); reject(new Error('network')); } };
    const timer = setTimeout(() => { if (!done) { finish(); reject(new Error('timeout')); } }, timeout);
    signal?.addEventListener('abort', onAbort);
    s.src = `${url}&callback=${cb}`;
    document.head.appendChild(s);
  });
}

// Different ways of writing the same address, best first.
export function addressVariants(address) {
  const out = [];
  const push = (a, guess = false) => {
    a = cleanAddress(a.replace(/\s+/g, ' '));
    if (a && !out.some((v) => v.text === a)) out.push({ text: a, guess });
  };
  address = cleanAddress(address);
  push(address);
  const i = address.indexOf(',');
  const street = i >= 0 ? address.slice(0, i) : address;
  const rest = i >= 0 ? address.slice(i) : '';

  const noUnit = street
    .replace(/\s+(?:unit|ste\.?|suite|apt\.?|apartment|bldg\.?|building|rm\.?|room|lot|space|spc)\s*#?\s*[\w-]+$/i, '')
    .replace(/\s*#\s*[\w-]+$/, '')
    .replace(/^(\d+)\s+(?![NSEW]\b)[A-Za-z]\s+(?=\S)/, '$1 ')                    // "2325 A Martin..." -> "2325 Martin..."
    .replace(/\s+(Rd|St|Dr|Ave|Blvd|Ln|Pkwy|Cir|Ct|Pl|Way)\s+(?![NSEW]$)[A-Za-z]$/i, ' $1') // "516 Lincoln Rd A" -> "516 Lincoln Rd"
    .trim();
  push(noUnit + rest);

  const hwy = noUnit
    .replace(/\b(?:U\.?S\.?|[A-Z]{2}|Mississippi|State)[- ]?(?:Hwy|Highway|Route|Rte|Rt)?\.?\s*(\d+)\b/, 'Hwy $1')
    .replace(/\bHighway\b/i, 'Hwy')
    .replace(/\b(Hwy \d+)\s+(North|South|East|West)\b/i, (m, a, d) => `${a} ${d[0].toUpperCase()}`);
  push(hwy + rest);
  if (/\bHwy \d+$/.test(hwy)) {
    // Highways usually carry a direction in the address records; try them as a guess.
    for (const d of ['N', 'S', 'E', 'W']) push(`${hwy} ${d}${rest}`, true);
  }
  return out;
}

const cityOf = (address) => (address.split(',')[1] || '').trim().toLowerCase();

async function censusGeocode(text, expectCity, signal) {
  const url = `${CENSUS}?address=${encodeURIComponent(text)}&benchmark=Public_AR_Current&format=jsonp`;
  const j = await jsonp(url, signal);
  const matches = j?.result?.addressMatches || [];
  const m = matches.find((x) => !expectCity || (x.addressComponents?.city || '').toLowerCase() === expectCity) || null;
  if (!m) return null;
  return { lat: m.coordinates.y, lng: m.coordinates.x, precision: 'exact', source: 'census', matched: m.matchedAddress };
}

async function orsGeocode(key, text, focus, signal) {
  const u = new URL(ORS + '/geocode/search');
  u.searchParams.set('api_key', key);
  u.searchParams.set('text', text);
  u.searchParams.set('size', '1');
  u.searchParams.set('boundary.country', 'US');
  if (focus) {
    u.searchParams.set('focus.point.lat', focus.lat.toFixed(5));
    u.searchParams.set('focus.point.lon', focus.lng.toFixed(5));
  }
  let res;
  try { res = await fetch(u, { signal }); } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null;
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403 || res.status === 429) throw await orsHttpError(res);
    return null;
  }
  const f = (await res.json()).features?.[0];
  if (!f) return null;
  const [lng, lat] = f.geometry.coordinates;
  const layer = f.properties?.layer;
  const precision = layer === 'address' || layer === 'venue' ? 'exact' : layer === 'street' ? 'street' : 'rough';
  return { lat, lng, precision, source: 'ors' };
}

// Nominatim allows about one request a second; queue them.
let nomChain = Promise.resolve();
let nomLast = 0;
function nominatim(params, signal) {
  const run = async () => {
    const wait = 1100 - (Date.now() - nomLast);
    if (wait > 0) await sleep(wait);
    nomLast = Date.now();
    const u = new URL(NOMINATIM);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('limit', '1');
    u.searchParams.set('countrycodes', 'us');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    let res;
    try { res = await fetch(u, { signal, headers: { 'Accept-Language': 'en' } }); } catch (e) {
      if (e.name === 'AbortError') throw e;
      return null;
    }
    if (!res.ok) return null;
    const r = (await res.json())[0];
    if (!r) return null;
    const exact = r.type === 'house' || ['house', 'building'].includes(r.addresstype)
      || ['building', 'amenity', 'shop', 'office', 'tourism', 'leisure', 'craft', 'healthcare'].includes(r.category);
    const street = ['road', 'street'].includes(r.addresstype) || r.category === 'highway';
    return { lat: +r.lat, lng: +r.lon, precision: exact ? 'exact' : street ? 'street' : 'rough', source: 'osm' };
  };
  const p = nomChain.then(run, run);
  nomChain = p.catch(() => {});
  return p;
}

// Look up one stop (or a bare address string). Returns { lat, lng, precision, source } or null.
export async function geocodeOne(stopOrText, { key, focus, signal } = {}) {
  const address = cleanAddress(typeof stopOrText === 'string' ? stopOrText : stopOrText.address);
  const name = typeof stopOrText === 'string' ? '' : stopOrText.name || '';
  if (!address && !name) return null;
  const expectCity = cityOf(address);
  let best = null;
  const better = (r) => r && (!best || RANK[r.precision] > RANK[best.precision]);

  // 1. Census, with spelling variants
  if (address) {
    for (const v of addressVariants(address)) {
      let r = null;
      try { r = await censusGeocode(v.text, expectCity, signal); } catch (e) {
        if (e.name === 'AbortError') throw e;
        break; // Census unreachable: move on to the next service
      }
      if (r) {
        if (v.guess) r.precision = 'street';
        if (better(r)) best = r;
        if (best.precision === 'exact') return best;
      }
    }
  }
  // 2. OpenRouteService (throws on a bad key so the caller can say so)
  if (key && address) {
    const r = await orsGeocode(key, address, focus, signal);
    if (better(r)) best = r;
    if (best?.precision === 'exact') return best;
  }
  // 3. Nominatim by address
  if (address) {
    const variants = addressVariants(address).filter((v) => !v.guess).slice(0, 2);
    for (const v of variants) {
      const r = await nominatim({ q: v.text }, signal);
      if (better(r)) best = r;
      if (best?.precision === 'exact') return best;
    }
  }
  // 4. Business name in the same town, if it's near the other stops
  if (name) {
    const town = address.split(',').slice(1).join(',').trim();
    const r = await nominatim({ q: [name, town].filter(Boolean).join(', ') }, signal);
    const near = r && (!focus || haversine(focus, r) < 40000);
    if (near && r.precision === 'exact' && better(r)) best = r;
  }
  return best;
}

// Fill in coordinates for every stop that doesn't have them, a few at a time.
// onProgress(doneCount, total, stop) is called after each stop.
export async function geocodeStops(stops, { key, focus, signal, onProgress } = {}) {
  const todo = stops.filter((s) => s.lat == null);
  let keyProblem = null;
  let done = 0, next = 0;
  // Center later lookups on what's been found so far, so name searches stay local.
  const found = () => {
    const f = stops.filter((s) => s.lat != null);
    if (!f.length) return focus;
    return { lat: f.reduce((a, s) => a + s.lat, 0) / f.length, lng: f.reduce((a, s) => a + s.lng, 0) / f.length };
  };
  const worker = async () => {
    while (next < todo.length && !signal?.aborted) {
      const s = todo[next++];
      s.address = cleanAddress(s.address);
      const cached = s.address && geocache_.get(s.address);
      if (cached) {
        Object.assign(s, { lat: cached.lat, lng: cached.lng, precision: cached.precision, geo: cached.source });
      } else {
        let r = null;
        try {
          r = await geocodeOne(s, { key: keyProblem ? null : key, focus: found(), signal });
        } catch (e) {
          if (e.name === 'AbortError') return;
          if (e instanceof OrsError) {
            keyProblem = e.message;
            try { r = await geocodeOne(s, { focus: found(), signal }); } catch (e2) { if (e2.name === 'AbortError') return; }
          }
        }
        if (r) {
          Object.assign(s, { lat: r.lat, lng: r.lng, precision: r.precision, geo: r.source });
          if (r.precision === 'exact' && s.address) geocache_.set(s.address, r);
        } else {
          s.geo = 'failed';
        }
      }
      done++;
      onProgress?.(done, todo.length, s);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { keyProblem };
}

export { OrsError };
