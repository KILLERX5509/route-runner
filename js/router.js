// Turn-by-turn directions for in-app navigation.
// Main source: the free OpenStreetMap routing server (OSRM). Backup: OpenRouteService.

import { osrmGet, coordPath, orsPostRaw, haversine } from './services.js';

// Normalized route:
// { coords: [[lng,lat]...], cum: [meters along route at each coord], distance, duration,
//   steps: [{ type, modifier, exit, name, ref, distance, duration, startIndex, startDist, text, minor }] }

export async function getDirections(from, to, { orsKey, heading, destName, signal } = {}) {
  let route = null, err = null;
  try {
    const bearing = Number.isFinite(heading) ? `&bearings=${Math.round((heading + 360) % 360)},60;` : '';
    const j = await osrmGet(`/route/v1/driving/${coordPath([from, to])}?overview=false&steps=true&geometries=geojson${bearing}`, signal);
    route = fromOsrm(j, destName);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    err = e;
  }
  if (!route && orsKey) {
    try {
      const j = await orsPostRaw('/v2/directions/driving-car/geojson', orsKey, {
        coordinates: [[from.lng, from.lat], [to.lng, to.lat]], radiuses: [-1, -1], instructions: true, units: 'm',
      }, signal);
      route = fromOrs(j, destName);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      err = e;
    }
  }
  if (!route) throw err || new Error('No route found');
  finish(route);
  return route;
}

function same(a, b) { return a && b && a[0] === b[0] && a[1] === b[1]; }

export function fromOsrm(j, destName) {
  const r = j.routes?.[0];
  if (!r) throw new Error('No route found');
  const coords = [];
  const steps = [];
  for (const leg of r.legs) {
    for (const st of leg.steps) {
      let g = st.geometry?.coordinates || [st.maneuver.location];
      let startIndex;
      if (coords.length && same(coords[coords.length - 1], g[0])) { startIndex = coords.length - 1; g = g.slice(1); } else startIndex = coords.length;
      coords.push(...g);
      const s = {
        type: st.maneuver.type,
        modifier: st.maneuver.modifier || '',
        exit: st.maneuver.exit,
        name: st.name || '',
        ref: st.ref || '',
        distance: st.distance,
        duration: st.duration,
        startIndex,
      };
      s.text = osrmText(s, destName);
      s.minor = isMinor(s);
      steps.push(s);
    }
  }
  if (coords.length < 2) coords.push(coords[0]);
  return { coords, steps, distance: r.distance, duration: r.duration };
}

const ORS_TYPES = {
  0: ['turn', 'left'], 1: ['turn', 'right'], 2: ['turn', 'sharp left'], 3: ['turn', 'sharp right'],
  4: ['turn', 'slight left'], 5: ['turn', 'slight right'], 6: ['continue', 'straight'], 7: ['roundabout', ''],
  8: ['exit roundabout', ''], 9: ['turn', 'uturn'], 10: ['arrive', ''], 11: ['depart', ''], 12: ['fork', 'slight left'], 13: ['fork', 'slight right'],
};

export function fromOrs(j, destName) {
  const f = j.features?.[0];
  if (!f) throw new Error('No route found');
  const coords = f.geometry.coordinates;
  const seg = f.properties.segments?.[0] || { steps: [], distance: f.properties.summary?.distance, duration: f.properties.summary?.duration };
  const steps = seg.steps.map((st) => {
    const [type, modifier] = ORS_TYPES[st.type] || ['continue', ''];
    const s = { type, modifier, exit: st.exit_number, name: st.name && st.name !== '-' ? st.name : '', ref: '', distance: st.distance, duration: st.duration, startIndex: st.way_points[0] };
    s.text = type === 'arrive' ? `Arrive at ${destName || 'your stop'}` : st.instruction;
    s.minor = isMinor(s);
    return s;
  });
  return { coords, steps, distance: seg.distance, duration: seg.duration };
}

function finish(route) {
  const cum = [0];
  for (let i = 1; i < route.coords.length; i++) {
    const a = route.coords[i - 1], b = route.coords[i];
    cum.push(cum[i - 1] + haversine({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] }));
  }
  route.cum = cum;
  route.distance = cum[cum.length - 1] || route.distance || 0;
  for (const s of route.steps) s.startDist = cum[Math.min(s.startIndex, cum.length - 1)];
}

// Steps you don't need to be told about ahead of time.
function isMinor(s) {
  if (s.type === 'depart') return true;
  if (s.type === 'new name' || s.type === 'notification') return true;
  if (s.type === 'continue' && (!s.modifier || s.modifier === 'straight')) return true;
  return false;
}

const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const ordinal = (n) => ORD[(n || 1) - 1] || `${n}th`;

export function roadName(s) {
  const ref = (s.ref || '').split(';')[0].trim();
  return s.name || ref || '';
}

export function osrmText(s, destName) {
  const road = roadName(s);
  const onto = road ? ` onto ${road}` : '';
  const mod = (s.modifier || '').replace('uturn', 'U-turn');
  const side = mod.replace('slight ', '').replace('sharp ', '');
  switch (s.type) {
    case 'depart': return road ? `Head out on ${road}` : 'Head out';
    case 'arrive': {
      const where = s.modifier === 'left' ? ', on the left' : s.modifier === 'right' ? ', on the right' : '';
      return `Arrive at ${destName || 'your stop'}${where}`;
    }
    case 'turn':
    case 'end of road':
      if (s.modifier === 'uturn') return `Make a U-turn${onto}`;
      if (s.modifier === 'straight') return `Continue straight${onto}`;
      return `${s.type === 'end of road' ? 'At the end of the road, turn' : 'Turn'} ${mod}${onto}`;
    case 'new name': return road ? `Continue onto ${road}` : 'Continue straight';
    case 'continue': return s.modifier && s.modifier !== 'straight' ? `Keep ${side}${onto}` : `Continue${onto}`;
    case 'merge': return `Merge${side ? ` ${side}` : ''}${onto}`;
    case 'on ramp': return `Take the ramp${side ? ` on the ${side}` : ''}${onto}`;
    case 'off ramp': return `Take the exit${side ? ` on the ${side}` : ''}${onto}`;
    case 'fork': return `Keep ${side || 'straight'} at the fork${onto}`;
    case 'roundabout':
    case 'rotary': return `At the roundabout, take the ${ordinal(s.exit)} exit${onto}`;
    case 'roundabout turn': return `At the roundabout, turn ${mod}${onto}`;
    case 'exit roundabout':
    case 'exit rotary': return `Exit the roundabout${onto}`;
    default: return `Continue${onto}`;
  }
}

// Which arrow to draw for a step.
export function arrowFor(s) {
  if (!s) return 'straight';
  if (s.type === 'arrive') return 'arrive';
  if (s.type === 'roundabout' || s.type === 'rotary' || s.type === 'roundabout turn') return 'roundabout';
  const m = s.modifier || 'straight';
  if (m === 'uturn') return 'uturn';
  return m.replace(' ', '-'); // left, right, slight-left, sharp-right, straight
}
