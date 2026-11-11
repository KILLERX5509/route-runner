// In-app turn-by-turn navigation to one stop at a time.

import { getDirections, arrowFor, roadName } from './router.js';
import { haversine } from './services.js';

const ARRIVE_METERS = 35;
const OFF_ROUTE_METERS = 45;
const REROUTE_GAP_MS = 6000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Arrow drawings (white strokes on the green sign). Left turns are mirrored rights.
const ARROWS = {
  straight: '<path d="M24 42V8M12 20 24 8l12 12"/>',
  'slight-right': '<path d="M16 42V26L32 10M20 10h12v12"/>',
  right: '<path d="M14 42V22a6 6 0 0 1 6-6h20M32 8l8 8-8 8"/>',
  'sharp-right': '<path d="M14 8v20a6 6 0 0 0 6 6h14M26 42l12-8-4-14"/>',
  uturn: '<path d="M30 42V18a8 8 0 0 0-16 0v20M6 30l8 8 8-8"/>',
  roundabout: '<circle cx="24" cy="22" r="8"/><path d="M24 42V30M30 16l8-8M30 8h8v8"/>',
  arrive: '<path d="M24 6 40 22 24 38 8 22z" fill="#FFC20E" stroke="#1d1d1d"/>',
};
function arrowSVG(kind) {
  const left = kind.endsWith('left');
  const base = kind.replace('left', 'right');
  const path = ARROWS[base] || ARROWS.straight;
  return `<svg viewBox="0 0 48 48" aria-hidden="true" style="${left ? 'transform:scaleX(-1)' : ''}">${path}</svg>`;
}

function fmtNavDist(m) {
  const ft = m * 3.28084;
  if (ft < 1000) return `${Math.max(50, Math.round(ft / 50) * 50)} ft`;
  const mi = m / 1609.344;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}
function spokenDist(m) {
  const mi = m / 1609.344;
  if (mi < 0.1) return `${Math.max(100, Math.round((m * 3.28084) / 100) * 100)} feet`;
  if (mi < 0.35) return 'a quarter mile';
  if (mi < 0.6) return 'half a mile';
  if (mi < 0.85) return 'three quarters of a mile';
  const r = Math.round(mi * 2) / 2;
  return r === 1 ? '1 mile' : `${r} miles`;
}
const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);

// Local flat projection (meters) around a point; accurate enough within a few km.
function projector(lat0, lng0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320, ky = 110540;
  return (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky];
}

export function createNavigator({ mapview, getMe, settings, onArrive, onEnd, onChange, fallbackNav }) {
  const S = {
    active: false, stop: null, num: 0, route: null, idx: 0, along: 0,
    off: 0, lastReroute: 0, routing: false, said: new Map(), follow: true,
    wake: null, arrived: false, heading: null, speed: 0, abort: null,
  };
  const ui = $('#nav');

  /* ---------- voice + screen */
  function speak(text) {
    if (!settings().voice || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 1;
      speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }
  async function keepAwake() {
    try { if (navigator.wakeLock && !S.wake) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener?.('release', () => { S.wake = null; }); } } catch { S.wake = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (S.active && document.visibilityState === 'visible') { S.wake = null; keepAwake(); const me = getMe(); if (me) onFix(me); }
  });

  /* ---------- layout */
  function padding() {
    const h = window.innerHeight;
    const top = ui.querySelector('.nav-top')?.getBoundingClientRect().bottom || 120;
    const bottom = h - (ui.querySelector('.nav-bottom')?.getBoundingClientRect().top || h - 150);
    // Put the car in the lower third, looking up the road.
    return { top: Math.max(top + 20, h * 0.42), bottom: bottom + 10, left: 30, right: 30 };
  }

  function render() {
    ui.innerHTML = `
      <div class="nav-top" role="status" aria-live="polite">
        <div class="nav-arrow" id="nav-arrow">${arrowSVG('straight')}</div>
        <div class="nav-text"><b id="nav-dist">Finding route</b><span id="nav-instr"></span></div>
      </div>
      <div class="nav-then" id="nav-then" hidden></div>
      <button class="nav-recenter pill" id="nav-recenter" type="button" hidden>Re-center</button>
      <div class="nav-bottom">
        <div class="nav-dest">
          <span class="shield" id="nav-num">${S.num}</span>
          <div class="nav-dest-text"><b>${esc(S.stop.name)}</b><span id="nav-eta">&nbsp;</span></div>
        </div>
        <div class="nav-btns">
          <button class="btn btn-secondary" type="button" id="nav-voice" aria-pressed="${settings().voice}">${settings().voice ? 'Voice on' : 'Voice off'}</button>
          <button class="btn btn-secondary" type="button" id="nav-here">I'm here</button>
          <button class="btn btn-danger" type="button" id="nav-end">End</button>
        </div>
      </div>
      <div class="nav-arrived" id="nav-arrived" hidden></div>`;
    ui.hidden = false;
    $('#nav-end').onclick = () => end(true);
    $('#nav-here').onclick = () => arrive(true);
    $('#nav-voice').onclick = (e) => {
      const s = settings();
      s.voice = !s.voice;
      onChange?.('voice', s.voice);
      e.currentTarget.textContent = s.voice ? 'Voice on' : 'Voice off';
      e.currentTarget.setAttribute('aria-pressed', String(s.voice));
      if (!s.voice) try { speechSynthesis.cancel(); } catch { /* ignore */ }
    };
    $('#nav-recenter').onclick = () => { S.follow = true; $('#nav-recenter').hidden = true; const me = getMe(); if (me) camera(me); };
  }

  function banner(step, dist) {
    const arrow = $('#nav-arrow'), d = $('#nav-dist'), t = $('#nav-instr');
    if (!arrow) return;
    arrow.innerHTML = arrowSVG(arrowFor(step));
    d.textContent = step.type === 'arrive' && dist < 60 ? 'Now' : fmtNavDist(dist);
    t.textContent = step.text;
  }

  /* ---------- route following */
  function snap(me) {
    const r = S.route;
    const proj = projector(me.lat, me.lng);
    const n = r.coords.length;
    const scan = (from, to) => {
      let best = { d: Infinity, i: 0, t: 0 };
      for (let i = Math.max(0, from); i < Math.min(n - 1, to); i++) {
        const [ax, ay] = proj(r.coords[i][0], r.coords[i][1]);
        const [bx, by] = proj(r.coords[i + 1][0], r.coords[i + 1][1]);
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < best.d) best = { d, i, t };
      }
      return best;
    };
    let b = scan(S.idx - 15, S.idx + 250);
    if (b.d > 80) { const all = scan(0, n); if (all.d < b.d) b = all; }
    const segLen = r.cum[b.i + 1] - r.cum[b.i];
    const a = r.coords[b.i], c = r.coords[b.i + 1];
    const bearing = (Math.atan2(
      Math.sin(((c[0] - a[0]) * Math.PI) / 180) * Math.cos((c[1] * Math.PI) / 180),
      Math.cos((a[1] * Math.PI) / 180) * Math.sin((c[1] * Math.PI) / 180) - Math.sin((a[1] * Math.PI) / 180) * Math.cos((c[1] * Math.PI) / 180) * Math.cos(((c[0] - a[0]) * Math.PI) / 180),
    ) * 180) / Math.PI;
    return { dist: b.d, idx: b.i, along: r.cum[b.i] + b.t * segLen, bearing: (bearing + 360) % 360 };
  }

  function camera(me) {
    if (!S.follow) return;
    const zoom = S.speed > 22 ? 15.2 : S.speed > 12 ? 16 : 16.8;
    mapview.follow(me, { bearing: S.heading ?? 0, zoom, padding: padding() });
  }

  function announce(step, dist) {
    if (!step) return;
    const fast = S.speed > 20;
    const far = fast ? 1600 : 800, mid = fast ? 450 : 200, near = fast ? 150 : 45;
    const lvl = S.said.get(step) || 0;
    if (step.type === 'arrive') return; // arrival has its own message
    if (dist <= near && lvl < 3) { S.said.set(step, 3); speak(step.text); }
    else if (dist <= mid && dist > near * 1.4 && lvl < 2) { S.said.set(step, 2); speak(`In ${spokenDist(dist)}, ${lowerFirst(step.text)}`); }
    else if (dist <= far && dist > mid * 1.5 && lvl < 1 && step.distance !== 0) { S.said.set(step, 1); speak(`In ${spokenDist(dist)}, ${lowerFirst(step.text)}`); }
  }

  function onFix(me) {
    if (!S.active || !S.route || S.arrived) return;
    if (Number.isFinite(me.speed)) S.speed = me.speed;
    const sp = snap(me);
    S.idx = sp.idx;
    S.along = sp.along;
    const moving = S.speed > 2 && Number.isFinite(me.heading) && me.heading >= 0;
    S.heading = moving ? me.heading : (sp.dist < 25 ? sp.bearing : (S.heading ?? sp.bearing));
    mapview.setMe(me, S.heading);
    camera(me);

    // Off the route? Get a new one (not too often).
    const tol = Math.max(OFF_ROUTE_METERS, (me.acc || 0) * 1.2);
    if (sp.dist > tol) S.off++; else S.off = 0;
    if (S.off >= 3 && !S.routing && Date.now() - S.lastReroute > REROUTE_GAP_MS) { reroute(me, true); return; }

    const r = S.route;
    const remaining = Math.max(0, r.distance - S.along);
    const toStop = haversine(me, S.stop);
    const snoozed = S.lastArriveDismiss && Date.now() - S.lastArriveDismiss < 90000;
    if (!snoozed && (toStop < ARRIVE_METERS || (remaining < 25 && sp.dist < 60))) { arrive(false); return; }

    // Next step worth showing: skip the "keep going straight" ones.
    const upcoming = r.steps.filter((s) => s.startDist > S.along + 3);
    const nextMajor = upcoming.find((s) => !s.minor) || upcoming[upcoming.length - 1] || r.steps[r.steps.length - 1];
    const dist = Math.max(0, nextMajor.startDist - S.along);
    banner(nextMajor, dist);
    announce(nextMajor, dist);

    // "Then ..." hint when two turns come close together
    const i = upcoming.indexOf(nextMajor);
    const after = upcoming.slice(i + 1).find((s) => !s.minor);
    const then = $('#nav-then');
    if (then) {
      if (after && after.startDist - nextMajor.startDist < 250) {
        then.innerHTML = `<span>Then</span>${arrowSVG(arrowFor(after))}`;
        then.hidden = false;
      } else then.hidden = true;
    }

    const secs = r.duration * (remaining / Math.max(1, r.distance));
    const eta = new Date(Date.now() + secs * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const mins = Math.max(1, Math.round(secs / 60));
    const el = $('#nav-eta');
    if (el) el.textContent = `Arrive ${eta}. ${mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`}, ${fmtNavDist(remaining)}`;
  }

  async function reroute(me, quiet) {
    S.routing = true;
    if (quiet) S.lastReroute = Date.now(); // only real reroutes count toward the wait
    S.abort?.abort();
    S.abort = new AbortController();
    if (!quiet) { const d = $('#nav-dist'); if (d) d.textContent = 'Finding route'; }
    try {
      const heading = S.speed > 2 ? S.heading : undefined;
      const route = await getDirections(me, S.stop, { orsKey: settings().orsKey, heading, destName: S.stop.name, signal: S.abort.signal });
      if (!S.active) return;
      S.route = route;
      S.idx = 0; S.along = 0; S.off = 0; S.said = new Map();
      mapview.setNavLine(route.coords);
      if (quiet) speak('Rerouting');
      onFix(getMe() || me);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (!S.route) showRouteError(e);
    } finally {
      S.routing = false;
    }
  }

  function showRouteError(e) {
    const d = $('#nav-dist'), t = $('#nav-instr');
    if (d) d.textContent = "Couldn't get directions";
    if (t) t.innerHTML = `${esc(e.message || 'Check your connection.')} <button type="button" id="nav-retry">Try again</button> <button type="button" id="nav-ext">Open in Maps</button>`;
    $('#nav-retry')?.addEventListener('click', () => { const me = getMe(); if (me) reroute(me, false); });
    $('#nav-ext')?.addEventListener('click', () => { const s = S.stop; end(false); fallbackNav(s); });
  }

  function arrive(manual) {
    if (S.arrived) return;
    S.arrived = true;
    const box = $('#nav-arrived');
    if (!box) return;
    if (!manual) speak(`You have arrived at ${S.stop.name}`);
    box.innerHTML = `
      <div class="sign">
        <div class="sign-row"><span class="shield">${S.num}</span><div><h2>${esc(S.stop.name)}</h2><p class="addr">You're here.</p></div></div>
        <div class="nav-arrived-btns">
          <button class="btn btn-sign-primary" type="button" id="arr-next">Done, go to next stop</button>
          <div class="two">
            <button class="btn btn-sign" type="button" id="arr-done">Done, stop here</button>
            <button class="btn btn-sign" type="button" id="arr-not">Not yet</button>
          </div>
        </div>
      </div>`;
    box.hidden = false;
    $('#arr-next').onclick = () => { const s = S.stop; box.hidden = true; onArrive(s, true); };
    $('#arr-done').onclick = () => { const s = S.stop; end(false); onArrive(s, false); };
    $('#arr-not').onclick = () => { box.hidden = true; S.arrived = false; S.lastArriveDismiss = Date.now(); };
  }

  /* ---------- public */
  async function start(stop, num) {
    const wasActive = S.active;
    S.active = true;
    S.stop = stop; S.num = num; S.route = null; S.arrived = false; S.follow = true;
    S.said = new Map(); S.idx = 0; S.along = 0; S.off = 0;
    render();
    keepAwake();
    speak(wasActive ? '' : ' '); // unlocks speech on iPhone while we still have the tap
    mapview.setNavMode(true);
    mapview.setNavLine([]);
    const me = getMe();
    if (!me) {
      showRouteError(new Error('Waiting for your location. Make sure location is allowed.'));
      return;
    }
    await reroute(me, false);
    if (S.route && S.active) {
      const first = S.route.steps.find((s) => !s.minor && s.startDist > 30) || S.route.steps[S.route.steps.length - 1];
      speak(`Starting route to ${stop.name}. ${first ? `In ${spokenDist(first.startDist)}, ${lowerFirst(first.text)}` : ''}`);
      // Already said "in X miles"; still give the closer warning and the "turn now".
      if (first) S.said.set(first, first.startDist < 300 ? 2 : 1);
    }
  }

  function end(userEnded) {
    S.active = false;
    S.abort?.abort();
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    try { S.wake?.release(); } catch { /* ignore */ }
    S.wake = null;
    ui.hidden = true;
    ui.innerHTML = '';
    mapview.setNavLine([]);
    mapview.setNavMode(false);
    onEnd?.(userEnded);
  }

  function userMovedMap() {
    if (!S.active) return;
    S.follow = false;
    const b = $('#nav-recenter');
    if (b) b.hidden = false;
  }

  return { start, end, onFix, userMovedMap, isActive: () => S.active, _state: S };
}
