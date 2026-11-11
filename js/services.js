// Map data services: address lookup, drive times, road shapes.
//
// Without an OpenRouteService key: addresses are looked up with OpenStreetMap's
// free Nominatim service (about 1 per second) and distances are straight-line
// estimates. With a free OpenRouteService key: faster address lookup, real
// driving times, and the route drawn along actual roads.

import { geocache_ } from './store.js';

const ORS = 'https://api.openrouteservice.org';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
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

// Full driving-time and distance matrix, split into requests of at most
// 3,500 cells (the free plan's per-request limit).
export async function orsMatrix(key, pts, signal) {
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
    if (s + per < n) await sleep(1600); // stays under 40 requests a minute
  }
  // Points the road network can't reach get a pessimistic straight-line guess.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (durations[i][j] == null || distances[i][j] == null) {
        const d = haversine(pts[i], pts[j]) * ROAD_FACTOR * 1.5;
        distances[i][j] = d;
        durations[i][j] = d / AVG_SPEED;
      }
    }
  }
  return { durations, distances, road: true };
}

// Road-following line through the points, in chunks of 50 (free plan limit).
export async function orsRoadLine(key, pts, signal) {
  const out = [];
  for (let s = 0; s < pts.length - 1; s += 49) {
    const chunk = pts.slice(s, s + 50);
    if (chunk.length < 2) break;
    const j = await orsPost('/v2/directions/driving-car/geojson', key, {
      coordinates: chunk.map((p) => [p.lng, p.lat]),
      radiuses: chunk.map(() => -1),
      instructions: false,
    }, signal);
    const coords = j.features?.[0]?.geometry?.coordinates || [];
    for (const [lng, lat] of coords) out.push([lat, lng]);
  }
  return out;
}

const RANK = { exact: 3, street: 2, rough: 1 };

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

let lastNominatim = 0;
async function nominatimGeocode(text, signal) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const u = new URL(NOMINATIM);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'us');
  u.searchParams.set('q', text);
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
}

const stripUnit = (t) => t.replace(/\b(suite|ste|apt|unit|bldg|building|#)\s*\.?\s*[\w-]+/gi, '').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();

// Look up one address. Returns { lat, lng, precision, source } or null.
export async function geocodeText(text, { key, focus, signal } = {}) {
  let r = null;
  if (key) r = await orsGeocode(key, text, focus, signal); // throws on bad key / limit
  if (!r || r.precision !== 'exact') {
    const n = await nominatimGeocode(text, signal);
    if (n && (!r || RANK[n.precision] > RANK[r.precision])) r = n;
  }
  if ((!r || r.precision === 'rough') && stripUnit(text) !== text) {
    const n = await nominatimGeocode(stripUnit(text), signal);
    if (n && (!r || RANK[n.precision] > RANK[r.precision])) r = n;
  }
  return r;
}

// Fill in coordinates for every stop that doesn't have them.
// onProgress(doneCount, total, stop) is called after each stop.
export async function geocodeStops(stops, { key, focus, signal, onProgress } = {}) {
  const todo = stops.filter((s) => s.lat == null);
  let keyProblem = null;
  let i = 0;
  for (const s of todo) {
    if (signal?.aborted) break;
    const cached = geocache_.get(s.address);
    if (cached) {
      Object.assign(s, { lat: cached.lat, lng: cached.lng, precision: cached.precision, geo: cached.source });
    } else if (s.address) {
      let r = null;
      try {
        r = await geocodeText(s.address, { key: keyProblem ? null : key, focus, signal });
      } catch (e) {
        if (e.name === 'AbortError') break;
        if (e instanceof OrsError) {
          keyProblem = e.message;
          try { r = await geocodeText(s.address, { focus, signal }); } catch (e2) { if (e2.name === 'AbortError') break; }
        }
      }
      if (r) {
        Object.assign(s, { lat: r.lat, lng: r.lng, precision: r.precision, geo: r.source });
        if (r.precision !== 'rough') geocache_.set(s.address, r);
      } else {
        s.geo = 'failed';
      }
      if (key && !keyProblem) await sleep(120);
    } else {
      s.geo = 'failed';
    }
    i++;
    onProgress?.(i, todo.length, s);
  }
  return { keyProblem };
}

export { OrsError };
