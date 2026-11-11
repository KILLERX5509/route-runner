import { solveRoute, routeCost } from './optimizer.js';
import { FIELDS, parseFile, parseDelimited, detectColumns, buildStops, needsArea, cleanAddress } from './importer.js';
import { geocodeStops, geocodeOne, driveMatrix, roadLine, haversine, testOrsKey } from './services.js';
import { createMapView } from './mapview.js';
import { createNavigator } from './nav.js';
import * as store from './store.js';

const APP_VERSION = '1.1.0';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const DEFAULT_CENTER = [33.4957, -88.4273];
const HERE_METERS = 120;

const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="m7.5 12.3 3 3 6-6.3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  checkOn: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="m7.5 12.3 3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>',
  nav: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20 21l-8-4.2L4 21z" fill="currentColor"/></svg>',
};

const state = {
  settings: store.loadSettings(),
  routes: store.loadRoutes(),
  route: null,
  me: null,
  watchId: null,
  following: false,
  selectedId: null,
  roadLine: null,
  roadSig: '',
  placing: null,
  snap: 'peek',
  toastTimer: null,
  screenClose: null,
  gcAbort: null,
};

// Older versions stored some addresses with the city and ZIP written twice.
for (const r of state.routes) for (const s of r.stops || []) if (s.lat == null && s.address) s.address = cleanAddress(s.address);

/* ------------------------------------------------------------------ helpers */

const findStop = (id) => state.route?.stops.find((s) => s.id === id) || null;
const numOf = (s) => state.route.stops.indexOf(s) + 1;
const nextStop = (r) => r?.stops.find((s) => s.status === 'todo' && s.lat != null) || null;
const todoStops = (r) => r.stops.filter((s) => s.status === 'todo' && s.lat != null);
const routeSig = (r) => todoStops(r).map((s) => s.id).join(',');

function fmtDist(m) {
  if (m == null) return '';
  const mi = m / 1609.344;
  if (mi < 0.1) return `${Math.max(10, Math.round((m * 3.28084) / 10) * 10)} ft`;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}
function fmtDur(sec) {
  if (sec == null) return '';
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const ymd = () => new Date().toISOString().slice(0, 10);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function saveRoute(touch = true) {
  if (state.route && touch) state.route.updatedAt = Date.now();
  if (!store.saveRoutes(state.routes)) toast("Couldn't save. Your phone's storage for this app is full.");
}
function saveSettings() { store.saveSettings(state.settings); }

function makeStops(stops) {
  return stops.map((s) => ({
    notes: '', phone: '', extra: {}, ...s,
    id: store.uid(),
    status: 'todo',
    doneAt: null,
    leg: null,
    geo: s.geo ?? (s.lat != null ? 'sheet' : null),
    precision: s.precision ?? (s.lat != null ? 'exact' : null),
  }));
}

function newRoute(name, stops) {
  const r = {
    id: store.uid(),
    name: name || 'New route',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stops: makeStops(stops),
    optimizedAt: null,
    metric: null,
    returnLeg: null,
  };
  state.routes.unshift(r);
  return r;
}

function openRoute(id) {
  state.route = state.routes.find((r) => r.id === id) || null;
  store.saveCurrentId(state.route?.id ?? null);
  state.selectedId = null;
  state.roadLine = null;
  state.roadSig = '';
  renderAll();
  setSheet('peek');
  fitAll();
  maybeRoadLine();
}

/* ---------------------------------------------------------------------- map */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (state.settings.mapStyle === 'auto' ? darkQuery.matches : state.settings.mapStyle === 'dark');

const mv = createMapView($('#map'), {
  center: DEFAULT_CENTER,
  onPinTap: (id) => {
    if (state.placing || nav.isActive()) return;
    state.selectedId = id;
    renderMarkers();
    stopActions(id);
  },
  onMapTap: (ll) => {
    if (!state.placing) return;
    const s = findStop(state.placing);
    stopPlacing();
    if (!s) return;
    Object.assign(s, { lat: ll.lat, lng: ll.lng, geo: 'manual', precision: 'exact' });
    saveRoute();
    renderAll();
    scheduleRoadLine();
    toast(`Pin placed for ${s.name}.`);
  },
  onLongPress: (ll) => addStopAt(ll),
  onUserMove: () => {
    state.following = false;
    $('#btn-locate').classList.remove('is-on');
    nav.userMovedMap();
  },
});

function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  mv.setStyle(dark);
}
darkQuery.addEventListener?.('change', applyTheme);

function renderMarkers() {
  const r = state.route;
  if (!r) { mv.setPins([]); return; }
  const next = nextStop(r);
  const list = [];
  r.stops.forEach((s, i) => {
    if (s.lat == null) return;
    const isNext = s === next;
    const cls = ['pin'];
    if (isNext) cls.push('is-next');
    else if (s.status === 'done') cls.push('is-done');
    else if (s.status === 'skipped') cls.push('is-skipped');
    else if (s.precision && s.precision !== 'exact') cls.push('is-approx');
    if (String(i + 1).length >= 3) cls.push('is-long');
    if (s.id === state.selectedId) cls.push('is-selected');
    list.push({
      id: s.id, lat: s.lat, lng: s.lng, num: i + 1, cls: cls.join(' '),
      z: isNext ? 1e6 : s.status === 'todo' ? 1e5 - i : i,
      label: `Stop ${i + 1}, ${s.name}`,
    });
  });
  mv.setPins(list);
}

function renderLine() {
  const r = state.route;
  if (!r || nav.isActive()) { mv.setRouteLine([], 'straight'); return; }
  const todo = todoStops(r);
  if (!todo.length) { mv.setRouteLine([], 'straight'); return; }
  if (state.roadLine && state.roadSig === routeSig(r)) { mv.setRouteLine(state.roadLine, 'road'); return; }
  const pts = todo.map((s) => [s.lng, s.lat]);
  if (state.me) pts.unshift([state.me.lng, state.me.lat]);
  mv.setRouteLine(pts.length >= 2 ? pts : [], 'straight');
}

let roadAbort = null, roadTimer = null;
function scheduleRoadLine() {
  clearTimeout(roadTimer);
  roadTimer = setTimeout(maybeRoadLine, 1200);
}
async function maybeRoadLine() {
  const r = state.route;
  if (!r || !state.settings.roadLines) return;
  const sig = routeSig(r);
  if (state.roadLine && state.roadSig === sig) return;
  const pts = todoStops(r).map((s) => ({ lat: s.lat, lng: s.lng }));
  if (state.me) pts.unshift({ lat: state.me.lat, lng: state.me.lng });
  if (pts.length < 2) return;
  roadAbort?.abort();
  roadAbort = new AbortController();
  try {
    const line = await roadLine(pts, { orsKey: state.settings.orsKey, signal: roadAbort.signal });
    if (line.length && state.route === r && routeSig(r) === sig) {
      state.roadLine = line;
      state.roadSig = sig;
      renderLine();
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('Road line failed:', e.message);
  }
}

function topInset() {
  return $('.topbar').getBoundingClientRect().bottom + 12;
}
function mapPadding() {
  return { top: topInset(), bottom: Math.min(visibleSheet(), window.innerHeight * 0.65) + 20, left: 36, right: 36 };
}

function fitAll() {
  const r = state.route;
  let pts = r ? r.stops.filter((s) => s.lat != null && s.status !== 'done') : [];
  if (r && !pts.length) pts = r.stops.filter((s) => s.lat != null);
  pts = pts.map((s) => ({ lat: s.lat, lng: s.lng }));
  if (state.me) pts.push(state.me);
  if (pts.length) mv.fit(pts, mapPadding());
}

function focusOn(p, zoom) {
  mv.focus(p, zoom, mapPadding());
}

/* ------------------------------------------------------------------ location */

function setMe(p) {
  const me = {
    lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy,
    speed: p.coords.speed, heading: p.coords.heading, t: Date.now(),
  };
  const moved = !state.me || haversine(state.me, me) > 25;
  state.me = me;
  if (nav.isActive()) { nav.onFix(me); return; }
  mv.setMe(me, null);
  if (moved) {
    updateNextDistance();
    renderLine();
  }
  if (state.following) mv.focus(me, undefined, mapPadding());
}

function startWatch() {
  if (state.watchId != null || !navigator.geolocation) return;
  state.watchId = navigator.geolocation.watchPosition(setMe, () => {}, { enableHighAccuracy: true, maximumAge: 0 });
}

function getPosition(timeout = 12000) {
  if (state.me && Date.now() - state.me.t < 30000) return Promise.resolve(state.me);
  if (!navigator.geolocation) return Promise.reject(new Error('unavailable'));
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => { setMe(p); startWatch(); resolve(state.me); },
      reject,
      { enableHighAccuracy: true, timeout, maximumAge: 20000 },
    );
  });
}

function locationErrorText(err) {
  if (err?.code === 1) return "Location is blocked for this app. Allow it when asked, or turn on Location Services for Safari Websites in your iPhone's Settings.";
  if (err?.code === 3) return 'Finding your location took too long.';
  return "Your location isn't available right now.";
}

function updateNextDistance() {
  const r = state.route;
  const next = r && nextStop(r);
  const el = $('#next-away');
  if (!next || !el) return;
  if (state.me) {
    const d = haversine(state.me, next);
    el.textContent = d < HERE_METERS ? "You're here" : `${fmtDist(d)} away`;
    $('#next-done')?.classList.toggle('is-here', d < HERE_METERS);
  } else if (next.leg) {
    el.textContent = `${fmtDur(next.leg.sec)} drive`;
  }
}

/* -------------------------------------------------------------- navigation */

const nav = createNavigator({
  mapview: mv,
  getMe: () => state.me,
  settings: () => state.settings,
  onChange: () => saveSettings(),
  fallbackNav: (s) => openExternal(s, 'apple'),
  onArrive: (s, goNext) => {
    setStatus(s, 'done', { quiet: true });
    const n = numOf(s);
    if (!goNext) { toast(`Stop ${n} done.`); return; }
    const next = nextStop(state.route);
    if (next) {
      toast(`Stop ${n} done. Heading to stop ${numOf(next)}.`);
      nav.start(next, numOf(next));
    } else {
      nav.end(false);
      toast('Route complete. Nice work.', { duration: 6000 });
    }
  },
  onEnd: () => {
    document.body.classList.remove('is-nav');
    renderAll();
    setSheet('peek');
    if (state.me) focusOn(state.me, 15);
  },
});

async function startNav(s) {
  if (!s || s.lat == null) { toast("This stop isn't on the map yet."); return; }
  hideActions();
  closeScreen();
  if (!state.me || Date.now() - state.me.t > 60000) {
    busy('Finding your location');
    try { await getPosition(); } catch (e) { busy(false); toast(locationErrorText(e), { duration: 7000 }); return; }
    busy(false);
  }
  startWatch();
  document.body.classList.add('is-nav');
  state.following = false;
  renderLine();
  nav.start(s, numOf(s));
}

/* --------------------------------------------------------------- the sheet */

const sheet = $('#sheet');

function currentOffset() {
  const t = getComputedStyle(sheet).transform;
  if (!t || t === 'none') return sheet.offsetHeight;
  return new DOMMatrixReadOnly(t).m42;
}

function snapOffsets() {
  const H = sheet.offsetHeight, vh = window.innerHeight;
  const pe = $('#peek-end');
  const peekH = Math.min(pe ? pe.offsetTop + 6 : 180, Math.round(vh * 0.62));
  const list = [{ name: 'peek', y: Math.max(0, H - peekH) }];
  const halfY = Math.max(0, H - Math.round(vh * 0.62));
  if (halfY < list[0].y - 60) list.push({ name: 'half', y: halfY });
  list.push({ name: 'full', y: 0 });
  return list;
}

function visibleSheet() {
  const opts = snapOffsets();
  const o = opts.find((x) => x.name === state.snap) || opts[0];
  return Math.max(0, sheet.offsetHeight - o.y);
}

function setSheet(name, animate = true) {
  const opts = snapOffsets();
  const target = opts.find((o) => o.name === name) || opts[0];
  state.snap = target.name;
  sheet.classList.toggle('anim', animate);
  sheet.dataset.snap = target.name;
  sheet.style.transform = `translateY(${target.y}px)`;
  if (target.name !== 'full') $('#sheet-body').scrollTop = 0;
  const attr = $('.maplibregl-ctrl-bottom-right');
  if (attr) attr.style.bottom = `${Math.min(sheet.offsetHeight - target.y, window.innerHeight) + 2}px`;
}

function cycleSheet() {
  const order = snapOffsets().map((o) => o.name);
  const i = order.indexOf(state.snap);
  setSheet(order[(i + 1) % order.length]);
}

let drag = null, suppressClick = false;
sheet.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (state.snap === 'full' && !e.target.closest('.sheet-top')) return;
  if (e.target.closest('input, select, textarea')) return;
  const now = performance.now();
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, start: currentOffset(), cur: currentOffset(), moved: false, lastY: e.clientY, lastT: now, v: 0 };
});
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = e.clientY - drag.y0, dx = e.clientX - drag.x0;
  if (!drag.moved) {
    if (Math.abs(dy) < 8 || Math.abs(dy) < Math.abs(dx)) return;
    drag.moved = true;
    sheet.classList.remove('anim');
    try { sheet.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  const now = performance.now();
  drag.v = (e.clientY - drag.lastY) / Math.max(1, now - drag.lastT);
  drag.lastY = e.clientY;
  drag.lastT = now;
  drag.cur = Math.min(Math.max(0, drag.start + dy), sheet.offsetHeight - 70);
  sheet.style.transform = `translateY(${drag.cur}px)`;
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.moved) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 60);
  const opts = snapOffsets().sort((a, b) => a.y - b.y);
  let target;
  if (Math.abs(d.v) > 0.45) {
    target = d.v < 0
      ? [...opts].reverse().find((o) => o.y < d.cur - 10) || opts[0]
      : opts.find((o) => o.y > d.cur + 10) || opts[opts.length - 1];
  } else {
    target = opts.reduce((a, b) => (Math.abs(b.y - d.cur) < Math.abs(a.y - d.cur) ? b : a));
  }
  setSheet(target.name);
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
document.addEventListener('click', (e) => {
  if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
}, true);

function renderSheet() {
  const body = $('#sheet-body');
  const scroll = body.scrollTop;
  body.innerHTML = state.route ? routeHTML(state.route) : emptyHTML();
  body.scrollTop = scroll;
  updateNextDistance();
  requestAnimationFrame(() => setSheet(state.snap, false));
}

function emptyHTML() {
  return `
    <div class="sheet-top"><button class="grabber" type="button" data-action="cycle-sheet" aria-label="Expand or collapse"></button></div>
    <div class="empty">
      <h1>Add your stops</h1>
      <p>Pick a spreadsheet with your addresses. Every stop gets a numbered pin, and the app works out the fastest order from where you are.</p>
      <div class="stack">
        <button class="btn btn-primary btn-block" type="button" data-action="import">Import spreadsheet</button>
        <button class="btn btn-secondary btn-block" type="button" data-action="paste">Paste addresses</button>
        ${state.routes.length ? '<button class="btn btn-secondary btn-block" type="button" data-action="routes">Open a saved route</button>' : ''}
        <button class="btn btn-secondary btn-block" type="button" data-action="demo">Try a practice route near me</button>
      </div>
    </div>
    <div id="peek-end"></div>`;
}

function routeHTML(r) {
  const next = nextStop(r);
  const total = r.stops.length;
  const done = r.stops.filter((s) => s.status === 'done').length;
  const todo = r.stops.filter((s) => s.status === 'todo');
  const mapped = todo.filter((s) => s.lat != null);
  const missing = todo.length - mapped.length;
  const approx = mapped.filter((s) => s.precision && s.precision !== 'exact').length;
  const legsKnown = mapped.length > 0 && mapped.every((s) => s.leg);
  const sec = legsKnown ? mapped.reduce((a, s) => a + s.leg.sec, 0) + (r.returnLeg?.sec || 0) : null;
  const m = legsKnown ? mapped.reduce((a, s) => a + s.leg.m, 0) + (r.returnLeg?.m || 0) : null;
  const est = legsKnown && r.metric !== 'road';

  let sub = `${done} of ${total} done`;
  if (!r.optimizedAt && mapped.length > 1) sub += '. In spreadsheet order';
  else if (r.legsStale) sub += '. Order changed by hand';

  let sign;
  if (next) {
    const n = numOf(next);
    sign = `
      <article class="sign" aria-label="Next stop">
        <div class="sign-row">
          <span class="shield">${n}</span>
          <div>
            <h2>${esc(next.name)}</h2>
            ${next.address && next.address !== next.name ? `<p class="addr">${esc(next.address)}</p>` : ''}
          </div>
        </div>
        ${next.notes ? `<p class="notes">${esc(next.notes)}</p>` : ''}
        <div class="sign-foot">
          <span class="sign-away" id="next-away">${next.leg ? `${fmtDur(next.leg.sec)} drive` : ''}</span>
          <div class="sign-actions">
            <button class="btn btn-sign-primary" type="button" data-action="navigate" data-id="${next.id}">${ICON.nav}Go</button>
            <button class="btn btn-sign" id="next-done" type="button" data-action="done" data-id="${next.id}">Done</button>
          </div>
        </div>
      </article>`;
  } else if (todo.length) {
    sign = `<article class="sign is-finished"><h2>No stops on the map</h2><p>The stops left don't have a location yet. Fix them below to keep going.</p></article>`;
  } else {
    sign = `<article class="sign is-finished"><h2>Route complete</h2><p>All ${total} stops are done. Reset progress to run it again.</p></article>`;
  }

  const warns = [];
  if (missing) warns.push(`<div class="warn"><span>${missing} ${missing === 1 ? "stop isn't" : "stops aren't"} on the map yet.</span><button type="button" data-action="review">Fix</button></div>`);
  if (approx) warns.push(`<div class="warn"><span>${approx} ${approx === 1 ? 'pin is' : 'pins are'} approximate.</span><button type="button" data-action="review">Review</button></div>`);

  const rows = r.stops.map((s, i) => {
    const cls = ['stop'];
    let side = '';
    if (s === next) cls.push('is-next');
    if (s.status === 'done') { cls.push('is-done'); side = 'Done'; }
    else if (s.status === 'skipped') { cls.push('is-skipped'); side = 'Skipped'; }
    else if (s.lat == null) { cls.push('is-missing'); side = 'Not on map'; }
    else if (s.leg && !r.legsStale) side = fmtDur(s.leg.sec);
    if (s.id === state.selectedId) cls.push('is-selected');
    const tag = s.status === 'todo' && s.lat != null && s.precision && s.precision !== 'exact' ? '<span class="tag">Approx.</span>' : '';
    const checkLabel = s.status === 'done' ? `Mark stop ${i + 1} not done` : s.status === 'skipped' ? `Put stop ${i + 1} back` : `Mark stop ${i + 1} done`;
    return `<li class="${cls.join(' ')}">
      <button class="stop-main" type="button" data-action="stop" data-id="${s.id}">
        <span class="badge">${i + 1}</span>
        <span class="stop-text"><strong>${esc(s.name)}${tag}</strong><span>${esc(s.address || (s.lat != null ? 'Dropped pin' : ''))}</span></span>
        <span class="stop-side">${esc(side)}</span>
      </button>
      <button class="check" type="button" data-action="toggle-done" data-id="${s.id}" aria-label="${checkLabel}">${s.status === 'done' ? ICON.checkOn : ICON.check}</button>
    </li>`;
  }).join('');

  return `
    <div class="sheet-top">
      <button class="grabber" type="button" data-action="cycle-sheet" aria-label="Expand or collapse"></button>
      <div class="route-head">
        <div>
          <h1 class="route-name">${esc(r.name)}</h1>
          <p class="route-sub">${esc(sub)}</p>
        </div>
        <button class="btn btn-primary" type="button" data-action="optimize" ${mapped.length < 1 ? 'disabled' : ''}>Optimize</button>
      </div>
    </div>
    ${warns.join('')}
    <div class="sign-wrap">${sign}</div>
    <div id="peek-end"></div>
    <div class="stats">
      <div class="stat"><b>${todo.length}</b><span>stops left</span></div>
      <div class="stat"><b>${sec != null && !r.legsStale ? `${est ? '~' : ''}${fmtDur(sec)}` : '–'}</b><span>driving${est ? ', estimated' : ''}</span></div>
      <div class="stat"><b>${m != null && !r.legsStale ? `${est ? '~' : ''}${fmtDist(m)}` : '–'}</b><span>distance</span></div>
    </div>
    <div class="toolbar">
      <button class="btn btn-secondary" type="button" data-action="add-stop">Add stop</button>
      <button class="btn btn-secondary" type="button" data-action="fit">Show all</button>
      <button class="btn btn-secondary" type="button" data-action="reset">Reset progress</button>
      <button class="btn btn-secondary" type="button" data-action="rename">Rename</button>
      <button class="btn btn-secondary" type="button" data-action="export-csv">Export CSV</button>
    </div>
    <ol class="stop-list">${rows}</ol>`;
}

function renderAll() {
  renderMarkers();
  renderLine();
  renderSheet();
}

/* --------------------------------------------------------- UI primitives */

function busy(msg) {
  const b = $('#busy');
  if (!msg) { b.hidden = true; return; }
  b.innerHTML = `<span class="spinner"></span><span>${esc(msg)}</span>`;
  b.hidden = false;
}

function toast(msg, { action, run, duration = 4500 } = {}) {
  const t = $('#toast');
  clearTimeout(state.toastTimer);
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; run(); };
  state.toastTimer = setTimeout(() => { t.hidden = true; }, duration);
}

function banner(msg, actionLabel, run) {
  const b = $('#banner');
  if (!msg) { b.hidden = true; b.innerHTML = ''; return; }
  b.innerHTML = `<span>${esc(msg)}</span><button type="button">${esc(actionLabel)}</button>`;
  b.querySelector('button').onclick = run;
  b.hidden = false;
}

function openScreen(title, bodyHTML, { foot = '', left = 'Close', onClose = null } = {}) {
  const sc = $('#screen');
  sc.innerHTML = `
    <div class="screen-head">
      ${left ? `<button class="link" type="button" data-action="close-screen">${esc(left)}</button>` : '<span style="width:12px"></span>'}
      <h1>${esc(title)}</h1>
    </div>
    <div class="screen-body">${bodyHTML}</div>
    ${foot ? `<div class="screen-foot">${foot}</div>` : ''}`;
  sc.hidden = false;
  state.screenClose = onClose;
  return sc;
}
function closeScreen() {
  const sc = $('#screen');
  sc.hidden = true;
  sc.innerHTML = '';
  const f = state.screenClose;
  state.screenClose = null;
  f?.();
}

function showActions({ title, sub, items, onDismiss }) {
  const back = $('#actions');
  const list = items.filter(Boolean);
  back.innerHTML = `
    <div class="actions" role="dialog" aria-label="${esc(title)}">
      <div class="actions-title"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
      ${list.map((it, i) => it.html ?? `<button type="button" class="btn ${it.danger ? 'is-danger' : ''}" data-act="${i}">${esc(it.label)}</button>`).join('')}
      <button type="button" class="btn is-cancel" data-act="cancel">Cancel</button>
    </div>`;
  back.hidden = false;
  back.onclick = (e) => {
    if (e.target === back) { hideActions(); onDismiss?.(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'cancel') { hideActions(); onDismiss?.(); return; }
    const it = list[+b.dataset.act];
    if (it?.custom) { it.custom(b, back); return; }
    hideActions();
    it?.run?.();
  };
  const input = back.querySelector('input');
  if (input) setTimeout(() => input.focus(), 50);
  return back;
}
function hideActions() {
  const back = $('#actions');
  back.hidden = true;
  back.innerHTML = '';
  back.onclick = null;
}

function confirmSheet(title, message, okLabel, danger = false) {
  return new Promise((resolve) => {
    showActions({
      title, sub: message,
      items: [{ label: okLabel, danger, run: () => resolve(true) }],
      onDismiss: () => resolve(false),
    });
  });
}

function promptSheet(title, value, okLabel, placeholder = '') {
  return new Promise((resolve) => {
    showActions({
      title,
      items: [
        { html: `<input class="input" id="prompt-input" value="${esc(value)}" placeholder="${esc(placeholder)}" style="margin-bottom:8px" enterkeyhint="done">` },
        { label: okLabel, custom: () => { const v = $('#prompt-input').value.trim(); hideActions(); resolve(v); } },
      ],
      onDismiss: () => resolve(null),
    });
    $('#prompt-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = e.target.value.trim(); hideActions(); resolve(v); }
    });
  });
}

async function shareFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}

/* ------------------------------------------------------------ stop actions */

function externalUrl(s, app) {
  const ll = `${s.lat},${s.lng}`;
  switch (app) {
    case 'google': return isIOS ? `comgooglemaps://?daddr=${ll}&directionsmode=driving` : `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
    case 'waze': return isIOS ? `waze://?ll=${ll}&navigate=yes` : `https://waze.com/ul?ll=${ll}&navigate=yes`;
    default: return isIOS ? `maps://?daddr=${ll}&dirflg=d` : `https://maps.apple.com/?daddr=${ll}&dirflg=d`;
  }
}
function openExternal(s, app) {
  const url = externalUrl(s, app);
  if (url.startsWith('http')) window.open(url, '_blank', 'noopener');
  else window.location.href = url;
}
function openNav(s) {
  if (!s || s.lat == null) return toast("This stop isn't on the map yet.");
  if ((state.settings.navApp || 'builtin') === 'builtin') startNav(s);
  else openExternal(s, state.settings.navApp);
}

function setStatus(s, status, { quiet = false } = {}) {
  const prev = s.status;
  s.status = status;
  s.doneAt = status === 'done' ? Date.now() : null;
  saveRoute();
  renderAll();
  scheduleRoadLine();
  if (quiet) return;
  const n = numOf(s);
  if (status === 'done') {
    const next = nextStop(state.route);
    if (next) {
      toast(`Stop ${n} done.`, { action: 'Undo', run: () => setStatus(s, prev, { quiet: true }) });
      if (state.snap !== 'full') focusOn(next, mv.getZoom());
    } else if (!state.route.stops.some((x) => x.status === 'todo')) {
      toast('Route complete. Nice work.', { action: 'Undo', run: () => setStatus(s, prev, { quiet: true }) });
    } else {
      toast(`Stop ${n} done.`, { action: 'Undo', run: () => setStatus(s, prev, { quiet: true }) });
    }
  } else if (status === 'skipped') {
    toast(`Stop ${n} skipped. It's left out when you optimize.`, { action: 'Undo', run: () => setStatus(s, prev, { quiet: true }) });
  }
}

function markOrderChanged() {
  const r = state.route;
  r.legsStale = true;
  r.stops.forEach((s) => { s.leg = null; });
  r.returnLeg = null;
}

function makeNext(s) {
  const r = state.route;
  r.stops.splice(r.stops.indexOf(s), 1);
  const firstTodo = r.stops.findIndex((x) => x.status === 'todo');
  r.stops.splice(firstTodo < 0 ? r.stops.length : firstTodo, 0, s);
  markOrderChanged();
  saveRoute();
  renderAll();
  scheduleRoadLine();
  toast(`${s.name} is now stop ${numOf(s)}.`);
}

function moveStop(s, pos) {
  const r = state.route;
  const to = Math.min(Math.max(1, Math.round(pos)), r.stops.length) - 1;
  r.stops.splice(r.stops.indexOf(s), 1);
  r.stops.splice(to, 0, s);
  markOrderChanged();
  saveRoute();
  renderAll();
  scheduleRoadLine();
  toast(`Moved to stop ${to + 1}.`);
}

function removeStop(s) {
  const r = state.route;
  const i = r.stops.indexOf(s);
  r.stops.splice(i, 1);
  saveRoute();
  renderAll();
  scheduleRoadLine();
  toast(`Removed ${s.name}.`, {
    action: 'Undo',
    run: () => { r.stops.splice(i, 0, s); saveRoute(); renderAll(); scheduleRoadLine(); },
  });
}

function stopActions(id) {
  const s = findStop(id);
  if (!s) return;
  const r = state.route;
  const n = numOf(s);
  const next = nextStop(r);
  const total = r.stops.length;
  showActions({
    title: `${n}. ${s.name}`,
    sub: s.address || (s.lat != null ? 'Dropped pin' : ''),
    onDismiss: () => { state.selectedId = null; renderMarkers(); },
    items: [
      s.lat != null && { label: 'Go (turn-by-turn)', run: () => openNav(s) },
      s.lat != null && { label: 'Show on map', run: () => { setSheet('peek'); focusOn(s, 16); } },
      s.status !== 'done' ? { label: 'Mark done', run: () => setStatus(s, 'done') } : { label: 'Mark not done', run: () => setStatus(s, 'todo') },
      s.status === 'todo' && s !== next && s.lat != null && { label: 'Do this one next', run: () => makeNext(s) },
      s.status === 'skipped' ? { label: 'Put back in the route', run: () => setStatus(s, 'todo') }
        : s.status === 'todo' && { label: 'Skip for now', run: () => setStatus(s, 'skipped') },
      {
        html: `<div class="inline-move"><input class="input" id="move-to" type="number" inputmode="numeric" min="1" max="${total}" placeholder="Move to stop number (1 to ${total})" aria-label="New stop number"><button type="button" class="btn btn-secondary" data-act="move" style="width:auto;margin:0">Move</button></div>`,
      },
      s.phone && { label: `Call ${s.phone}`, run: () => { window.location.href = `tel:${s.phone.replace(/[^\d+]/g, '')}`; } },
      { label: 'Edit stop', run: () => editStopScreen(s) },
      { label: s.lat == null ? 'Place on map' : 'Move pin on map', run: () => startPlacing(s) },
      { label: 'Remove from route', danger: true, run: () => removeStop(s) },
    ],
  });
  const back = $('#actions');
  const moveBtn = back.querySelector('[data-act="move"]');
  moveBtn.removeAttribute('data-act');
  moveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const v = parseInt($('#move-to').value, 10);
    if (!Number.isFinite(v)) { $('#move-to').focus(); return; }
    hideActions();
    moveStop(s, v);
  });
}

async function addStopAt(ll) {
  if (!state.route || state.placing || nav.isActive()) return;
  const name = await promptSheet('Add a stop here', '', 'Add stop', 'Stop name (optional)');
  if (name == null) return;
  const r = state.route;
  const [s] = makeStops([{ name: name || 'Dropped pin', address: '', lat: ll.lat, lng: ll.lng, geo: 'manual', precision: 'exact' }]);
  r.stops.push(s);
  saveRoute();
  renderAll();
  scheduleRoadLine();
  toast(`Added stop ${r.stops.length}. Optimize to fit it into the route.`, { action: 'Optimize', run: optimize, duration: 7000 });
}

/* --------------------------------------------------------------- optimize */

async function optimize() {
  const r = state.route;
  if (!r) return;
  const todo = todoStops(r);
  if (!todo.length) return toast('No stops left to optimize.');

  busy('Finding your location');
  let start = null, locErr = null;
  try { start = await getPosition(); } catch (e) { locErr = e; }
  if (!start) {
    busy(false);
    const ok = await confirmSheet("Couldn't get your location", `${locationErrorText(locErr)} You can still optimize starting from the first stop in the list.`, 'Start from the first stop');
    if (!ok) return;
  }

  const pts = start ? [{ lat: start.lat, lng: start.lng }, ...todo] : todo.slice();
  busy('Getting drive times');
  const mat = pts.length > 1
    ? await driveMatrix(pts.map((p) => ({ lat: p.lat, lng: p.lng })), { orsKey: state.settings.orsKey })
    : { durations: [[0]], distances: [[0]], road: false };

  busy('Optimizing');
  await nextFrame();
  const end = state.settings.endMode === 'return' ? 'return' : 'open';
  const cost = mat.durations;
  const res = solveRoute(cost, { end, timeMs: 700 });
  const before = routeCost(cost, pts.map((_, i) => i).slice(1), end);
  const after = routeCost(cost, res.order, end);

  let prev = 0;
  const ordered = [];
  if (!start) { todo[0].leg = null; ordered.push(todo[0]); }
  for (const k of res.order) {
    const s = pts[k];
    s.leg = { sec: cost[prev][k], m: mat.distances[prev][k] };
    ordered.push(s);
    prev = k;
  }
  r.returnLeg = end === 'return' && res.order.length ? { sec: cost[prev][0], m: mat.distances[prev][0] } : null;

  const done = r.stops.filter((s) => s.status === 'done');
  const unmapped = r.stops.filter((s) => s.status === 'todo' && s.lat == null);
  const skipped = r.stops.filter((s) => s.status === 'skipped');
  [...unmapped, ...skipped].forEach((s) => { s.leg = null; });
  r.stops = [...done, ...ordered, ...unmapped, ...skipped];
  r.optimizedAt = Date.now();
  r.metric = mat.road ? 'road' : 'straight';
  r.legsStale = false;
  saveRoute();

  state.roadLine = null;
  state.roadSig = '';
  busy(false);
  renderAll();
  setSheet('peek');
  fitAll();
  maybeRoadLine();

  const total = ordered.reduce((a, s) => a + (s.leg?.sec || 0), 0) + (r.returnLeg?.sec || 0);
  let msg = `${ordered.length} stops in the best order: ${mat.road ? 'about' : 'roughly'} ${fmtDur(total)} of driving.`;
  if (before - after > 90) msg += ` That's ${fmtDur(before - after)} less than before.`;
  if (!mat.road) msg += ` Times are estimates because the routing server couldn't be reached${mat.note ? ` (${mat.note})` : ''}.`;
  if (unmapped.length) msg += ` ${unmapped.length} unmapped ${unmapped.length === 1 ? 'stop is' : 'stops are'} at the end.`;
  toast(msg, { duration: 9000 });
}

/* ----------------------------------------------------------------- import */

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  busy('Reading spreadsheet');
  try {
    const parsed = await parseFile(file);
    busy(false);
    mappingScreen(parsed, file.name.replace(/\.[^.]+$/, ''));
  } catch (err) {
    busy(false);
    toast(err.message || "Couldn't read that file.");
  }
});

function layoutFor(rows, hasHeader) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const first = rows[0] || [];
  const headers = [...Array(width).keys()].map((i) => (hasHeader && first[i] ? first[i] : colLetter(i)));
  const data = hasHeader ? rows.slice(1) : rows;
  return { hasHeader, headers, mapping: detectColumns(hasHeader ? first : [], data, width) };
}
function colLetter(i) {
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return `Column ${s}`;
}
function guessHeader(rows) {
  const filled = (rows[0] || []).filter(Boolean);
  return filled.length > 0
    && !filled.some((c) => /^-?\d+(\.\d+)?$/.test(c) || /^\d+[a-z]?\s+\S+/i.test(c))
    && filled.every((c) => c.length <= 40);
}

function mappingScreen(parsed, baseName) {
  const imp = {
    sheets: parsed.sheets,
    sheetIdx: 0,
    name: baseName || 'New route',
    areaHint: state.settings.areaHint || '',
  };
  const setSheetIdx = (i) => {
    imp.sheetIdx = i;
    imp.rows = imp.sheets[i].rows;
    Object.assign(imp, layoutFor(imp.rows, guessHeader(imp.rows)));
    if (imp.sheets.length > 1) imp.name = imp.sheets[i].name.trim();
  };
  setSheetIdx(Math.max(0, imp.sheets.findIndex((s) => s.rows.length > 1)));

  const build = () => buildStops(imp.rows, imp.mapping, { hasHeader: imp.hasHeader, headers: imp.headers, areaHint: imp.areaHint });

  const render = () => {
    const data = imp.hasHeader ? imp.rows.slice(1) : imp.rows;
    const sampleFor = (i) => data.find((r) => r[i])?.[i] || '';
    const opts = (sel) => ['<option value="-1">Not in sheet</option>', ...imp.headers.map((h, i) => {
      const sample = sampleFor(i);
      const label = imp.hasHeader ? `${h}${sample ? ` (${sample.slice(0, 22)})` : ''}` : `${h}: ${sample.slice(0, 28)}`;
      return `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(label)}</option>`;
    })].join('');

    const stops = build();
    const rawNoArea = buildStops(imp.rows, imp.mapping, { hasHeader: imp.hasHeader, headers: imp.headers, areaHint: '' })
      .filter((s) => s.lat == null && s.address && needsArea(s.address)).length;
    const hasLocationCol = imp.mapping.address >= 0 || (imp.mapping.lat >= 0 && imp.mapping.lng >= 0);
    const prevScroll = $('#screen:not([hidden]) .screen-body')?.scrollTop || 0;

    openScreen('Match your columns', `
      <div class="section">
        <label class="field"><span>Route name</span><input class="input" id="imp-name" value="${esc(imp.name)}" autocomplete="off"></label>
        ${imp.sheets.length > 1 ? `<label class="field"><span>Sheet</span><select class="input" id="imp-sheet">${imp.sheets.map((s, i) => `<option value="${i}" ${i === imp.sheetIdx ? 'selected' : ''}>${esc(s.name)} (${s.rows.length - 1} rows)</option>`).join('')}</select></label>` : ''}
        <label class="check-row"><input type="checkbox" id="imp-header" ${imp.hasHeader ? 'checked' : ''}> First row is column names</label>
      </div>
      <div class="section">
        <h2>Which column has what</h2>
        <p class="hint" style="margin:-2px 0 12px">These were matched automatically. Only the address (or latitude and longitude) is required.</p>
        <div class="map-grid">
          ${FIELDS.map((f) => `<label for="map-${f.key}">${esc(f.label)}</label><select class="input" id="map-${f.key}" data-field="${f.key}">${opts(imp.mapping[f.key])}</select>`).join('')}
        </div>
      </div>
      ${rawNoArea > 0 ? `
      <div class="section">
        <h2>Addresses without a city</h2>
        <p class="hint" style="margin:-2px 0 10px">${rawNoArea} ${rawNoArea === 1 ? 'address has' : 'addresses have'} no city or ZIP. Add your area so they're found in the right town.</p>
        <input class="input" id="imp-area" value="${esc(imp.areaHint)}" placeholder="City, State (for example Columbus, MS)" autocomplete="off">
      </div>` : ''}
      <div class="section">
        <h2>Preview</h2>
        <div class="preview" id="imp-preview">${previewHTML(stops)}</div>
      </div>`, {
      left: 'Cancel',
      foot: hasLocationCol
        ? `<button class="btn btn-primary btn-block" type="button" data-action="imp-go" ${stops.length ? '' : 'disabled'}>Add ${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}</button>`
        : '<p class="hint" style="margin:0 0 4px;text-align:center">Pick the column that has the street address.</p>',
    });
    $('#screen .screen-body').scrollTop = prevScroll;

    $('#imp-name').addEventListener('input', (e) => { imp.name = e.target.value; });
    $('#imp-sheet')?.addEventListener('change', (e) => { setSheetIdx(+e.target.value); render(); });
    $('#imp-header').addEventListener('change', (e) => { Object.assign(imp, layoutFor(imp.rows, e.target.checked)); render(); });
    document.querySelectorAll('[data-field]').forEach((sel) => sel.addEventListener('change', (e) => {
      const f = e.target.dataset.field, v = +e.target.value;
      if (v >= 0) for (const k of Object.keys(imp.mapping)) if (imp.mapping[k] === v && k !== f) imp.mapping[k] = -1;
      imp.mapping[f] = v;
      render();
    }));
    $('#imp-area')?.addEventListener('input', (e) => {
      imp.areaHint = e.target.value;
      $('#imp-preview').innerHTML = previewHTML(build());
    });
  };

  imp.go = async () => {
    const stops = build();
    if (!stops.length) return;
    if (imp.areaHint.trim()) { state.settings.areaHint = imp.areaHint.trim(); saveSettings(); }
    const r = newRoute(imp.name.trim() || 'New route', stops);
    state.route = r;
    store.saveCurrentId(r.id);
    saveRoute();
    store.askPersistentStorage();
    await geocodeFlow(r);
  };
  state.importJob = imp;
  render();
}

function previewHTML(stops) {
  if (!stops.length) return '<div class="preview-row"><span>No stops found with these columns yet.</span></div>';
  const rows = stops.slice(0, 3).map((s) => `<div class="preview-row"><b>${esc(s.name)}</b><span>${esc(s.address || `${s.lat?.toFixed(5)}, ${s.lng?.toFixed(5)}`)}</span>${s.notes ? `<br><span>${esc(s.notes)}</span>` : ''}</div>`).join('');
  return rows + (stops.length > 3 ? `<div class="preview-row"><span>And ${stops.length - 3} more</span></div>` : '');
}

async function geocodeFlow(r, onlyStops = null, { before } = {}) {
  const need = (onlyStops || r.stops).filter((s) => s.lat == null && s.address);
  if (!need.length) { before?.(); closeScreen(); afterImport(r); return; }
  const key = state.settings.orsKey;
  const ctrl = new AbortController();
  state.gcAbort = ctrl;
  openScreen('Finding addresses', `
    <p class="big-count" id="gc-count">0 of ${need.length}</p>
    <div class="progress"><i id="gc-bar"></i></div>
    <p class="hint" id="gc-now">Starting</p>
    <p class="hint" style="margin-top:18px">This usually takes under a minute. Each address is only looked up once, and saved routes open instantly after this.</p>`, {
    left: null,
    foot: '<button class="btn btn-secondary btn-block" type="button" data-action="gc-stop">Stop and fix the rest later</button>',
  });
  const focus = state.me || mv.getCenter();
  const res = await geocodeStops(need, {
    key, focus, signal: ctrl.signal,
    onProgress: (i, n, s) => {
      const c = $('#gc-count'); if (c) c.textContent = `${i} of ${n}`;
      const b = $('#gc-bar'); if (b) b.style.width = `${(i / n) * 100}%`;
      const t = $('#gc-now'); if (t) t.textContent = s.lat != null ? `Found ${s.name}` : `Couldn't find ${s.name}`;
    },
  });
  state.gcAbort = null;
  before?.();
  saveRoute();
  closeScreen();
  if (res.keyProblem) toast(`${res.keyProblem} Used the free lookup instead.`, { duration: 7000 });
  afterImport(r);
}

function afterImport(r) {
  state.roadLine = null;
  state.roadSig = '';
  renderAll();
  setSheet('peek');
  setTimeout(fitAll, 60);
  const missing = r.stops.filter((s) => s.lat == null).length;
  const approx = r.stops.filter((s) => s.lat != null && s.precision && s.precision !== 'exact').length;
  if (missing || approx) {
    reviewScreen();
  } else {
    toast(`All ${r.stops.length} stops found and saved. Tap Optimize to get the fastest order from where you are.`, { action: 'Optimize', run: optimize, duration: 9000 });
  }
}

async function retryLookups() {
  const r = state.route;
  if (!r) return;
  const targets = r.stops.filter((s) => s.status !== 'done' && s.address && (s.lat == null || (s.precision && s.precision !== 'exact')));
  if (!targets.length) return;
  const saved = new Map(targets.map((s) => [s.id, { lat: s.lat, lng: s.lng, precision: s.precision, geo: s.geo }]));
  for (const s of targets) Object.assign(s, { address: cleanAddress(s.address), lat: null, lng: null, precision: null, geo: null });
  await geocodeFlow(r, targets, {
    // Keep an old approximate pin if the new lookup didn't do better.
    before: () => targets.forEach((s) => { if (s.lat == null && saved.get(s.id).lat != null) Object.assign(s, saved.get(s.id)); }),
  });
}

function reviewScreen() {
  const r = state.route;
  if (!r) return;
  const bad = r.stops.filter((s) => s.status !== 'done' && (s.lat == null || (s.precision && s.precision !== 'exact')));
  const missing = bad.filter((s) => s.lat == null).length;
  const approx = bad.length - missing;
  const found = r.stops.filter((s) => s.lat != null).length;
  const items = bad.map((s) => `
    <div class="list-item">
      <button class="grow" type="button" data-action="edit-stop" data-id="${s.id}">
        <b>${numOf(s)}. ${esc(s.name)}</b>
        <span>${esc(s.address || 'No address')}</span>
        <span>${s.lat == null ? 'Not found. Edit the address or place it on the map.' : s.precision === 'street' ? 'Pin is on the right road, maybe not the exact building.' : 'Pin is only in the right area.'}</span>
      </button>
      <button class="more" type="button" data-action="stop" data-id="${s.id}" aria-label="More for ${esc(s.name)}">${ICON.more}</button>
    </div>`).join('');
  openScreen('Check these stops', `
    <div class="section">
      <p style="font-size:16px;line-height:1.45">${found} of ${r.stops.length} stops are on the map.
      ${missing ? `${missing} couldn't be found.` : ''} ${approx ? `${approx} ${approx === 1 ? 'is' : 'are'} approximate.` : ''}</p>
      <p class="hint">Tap a stop to fix its address, or use the dots to place it on the map yourself.</p>
      ${bad.some((s) => s.address) ? '<button class="btn btn-secondary btn-block" type="button" data-action="retry-lookups" style="margin-top:12px">Look these up again</button>' : ''}
    </div>
    ${bad.length ? `<div class="list">${items}</div>` : '<p class="hint">Everything looks good.</p>'}`, {
    left: 'Close',
    foot: '<button class="btn btn-primary btn-block" type="button" data-action="close-screen">Go to the map</button>',
  });
}

function pasteScreen() {
  openScreen('Paste addresses', `
    <label class="field"><span>Route name</span><input class="input" id="paste-name" value="Stops ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}" autocomplete="off"></label>
    <label class="field"><span>Stops</span><textarea class="input" id="paste-text" placeholder="One address per line.&#10;&#10;You can also copy rows straight out of Excel, Numbers, or Google Sheets, with the header row."></textarea></label>`, {
    left: 'Cancel',
    foot: '<button class="btn btn-primary btn-block" type="button" data-action="paste-go">Continue</button>',
  });
  setTimeout(() => $('#paste-text')?.focus(), 80);
}

function editStopScreen(s) {
  hideActions();
  openScreen('Edit stop', `
    <label class="field"><span>Name</span><input class="input" id="ed-name" value="${esc(s.name)}" autocomplete="off"></label>
    <label class="field"><span>Address</span><input class="input" id="ed-address" value="${esc(s.address)}" autocomplete="off" placeholder="Street, City, State ZIP"></label>
    <label class="field"><span>Notes</span><textarea class="input" id="ed-notes" style="min-height:90px">${esc(s.notes)}</textarea></label>
    <label class="field"><span>Phone</span><input class="input" id="ed-phone" value="${esc(s.phone)}" inputmode="tel" autocomplete="off"></label>
    <p class="hint">${s.lat != null ? `Pin location: ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}${s.precision && s.precision !== 'exact' ? ' (approximate)' : ''}.` : 'Not on the map yet.'}</p>
    <div class="two" style="margin-top:14px">
      <button class="btn btn-secondary" type="button" data-action="ed-lookup" data-id="${s.id}">Look up address</button>
      <button class="btn btn-secondary" type="button" data-action="ed-place" data-id="${s.id}">Place on map</button>
    </div>`, {
    left: 'Cancel',
    foot: `<button class="btn btn-primary btn-block" type="button" data-action="ed-save" data-id="${s.id}">Save stop</button>`,
  });
}

function readEditFields(s) {
  const addr = $('#ed-address').value.trim();
  const changed = addr !== s.address;
  s.name = $('#ed-name').value.trim() || s.name;
  s.address = addr;
  s.notes = $('#ed-notes').value.trim();
  s.phone = $('#ed-phone').value.trim();
  return changed;
}

async function lookupStop(s) {
  if (!s.address) return toast('Add an address first.');
  busy('Looking up address');
  let r = null;
  try { r = await geocodeOne(s, { key: state.settings.orsKey, focus: state.me || mv.getCenter() }); } catch {
    try { r = await geocodeOne(s, { focus: state.me || mv.getCenter() }); } catch { r = null; }
  }
  busy(false);
  if (!r) { toast("Couldn't find that address. Check the spelling, or place it on the map."); return false; }
  Object.assign(s, { lat: r.lat, lng: r.lng, precision: r.precision, geo: r.source });
  if (r.precision === 'exact') store.geocache_.set(s.address, r);
  toast(r.precision === 'exact' ? 'Found it.' : 'Found an approximate spot. Check the pin.');
  return true;
}

function addStopScreen() {
  openScreen('Add stop', `
    <label class="field"><span>Name</span><input class="input" id="add-name" autocomplete="off"></label>
    <label class="field"><span>Address</span><input class="input" id="add-address" autocomplete="off" placeholder="Street, City, State ZIP"></label>
    <label class="field"><span>Notes</span><input class="input" id="add-notes" autocomplete="off"></label>
    <p class="hint">Tip: you can also press and hold anywhere on the map to drop a stop there.</p>`, {
    left: 'Cancel',
    foot: '<button class="btn btn-primary btn-block" type="button" data-action="add-go">Add stop</button>',
  });
  setTimeout(() => $('#add-name')?.focus(), 80);
}

function startPlacing(s) {
  closeScreen();
  hideActions();
  state.placing = s.id;
  setSheet('peek');
  banner(`Tap the map where ${s.name} is.`, 'Cancel', stopPlacing);
}
function stopPlacing() {
  state.placing = null;
  banner(null);
}

/* ------------------------------------------------------------------ routes */

function routesScreen() {
  const list = state.routes.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((r) => {
    const done = r.stops.filter((s) => s.status === 'done').length;
    return `<div class="list-item ${r === state.route ? 'is-current' : ''}">
      <button class="grow" type="button" data-action="open-route" data-id="${r.id}">
        <b>${esc(r.name)}</b>
        <span>${r.stops.length} stops, ${done} done. Edited ${esc(fmtDate(r.updatedAt))}</span>
      </button>
      <button class="more" type="button" data-action="route-menu" data-id="${r.id}" aria-label="More for ${esc(r.name)}">${ICON.more}</button>
    </div>`;
  }).join('');
  openScreen('Saved routes', `
    <div class="two section">
      <button class="btn btn-primary" type="button" data-action="import">Import spreadsheet</button>
      <button class="btn btn-secondary" type="button" data-action="paste">Paste addresses</button>
    </div>
    <div class="section">
      ${state.routes.length ? `<div class="list">${list}</div>` : '<p class="hint">No saved routes yet. Every route you import is saved here automatically, with its pins, order, and progress.</p>'}
    </div>
    <div class="section">
      <h2>Backup</h2>
      <p class="hint">Routes are stored on this phone. Save a backup file to iCloud Drive or Files now and then, so you can restore them if anything happens.</p>
      <div class="two" style="margin-top:12px">
        <button class="btn btn-secondary" type="button" data-action="backup">Save backup</button>
        <button class="btn btn-secondary" type="button" data-action="restore">Restore backup</button>
      </div>
    </div>`);
}

function routeMenu(id) {
  const r = state.routes.find((x) => x.id === id);
  if (!r) return;
  showActions({
    title: r.name,
    sub: `${r.stops.length} stops`,
    items: [
      { label: 'Open', run: () => { closeScreen(); openRoute(r.id); } },
      { label: 'Rename', run: async () => { const v = await promptSheet('Rename route', r.name, 'Save'); if (v) { r.name = v; r.updatedAt = Date.now(); store.saveRoutes(state.routes); routesScreen(); renderSheet(); } } },
      { label: 'Make a fresh copy', run: () => duplicateRoute(r) },
      { label: 'Reset progress', run: () => { resetRoute(r); routesScreen(); } },
      { label: 'Export as CSV', run: () => exportCSV(r) },
      {
        label: 'Delete route', danger: true,
        run: async () => {
          if (!(await confirmSheet(`Delete ${r.name}?`, 'This removes the route and its progress from this phone.', 'Delete route', true))) return;
          state.routes = state.routes.filter((x) => x !== r);
          if (state.route === r) { state.route = null; store.saveCurrentId(null); renderAll(); }
          store.saveRoutes(state.routes);
          routesScreen();
          toast(`Deleted ${r.name}.`);
        },
      },
    ],
  });
}

function duplicateRoute(r) {
  const copy = JSON.parse(JSON.stringify(r));
  copy.id = store.uid();
  copy.name = `${r.name} copy`;
  copy.createdAt = copy.updatedAt = Date.now();
  copy.stops.forEach((s) => { s.id = store.uid(); s.status = 'todo'; s.doneAt = null; });
  state.routes.unshift(copy);
  store.saveRoutes(state.routes);
  routesScreen();
  toast(`Made ${copy.name}.`);
}

function resetRoute(r) {
  r.stops.forEach((s) => { if (s.status !== 'todo') { s.status = 'todo'; s.doneAt = null; } });
  r.updatedAt = Date.now();
  store.saveRoutes(state.routes);
  if (r === state.route) { renderAll(); scheduleRoadLine(); }
  toast('Progress reset. Every stop is back to not done.');
}

function exportCSV(r) {
  const extraKeys = [...new Set(r.stops.flatMap((s) => Object.keys(s.extra || {})))];
  const head = ['Order', 'Name', 'Address', 'Latitude', 'Longitude', 'Status', 'Notes', 'Phone', ...extraKeys];
  const q = (v) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [head.map(q).join(',')];
  r.stops.forEach((s, i) => lines.push([
    i + 1, s.name, s.address, s.lat ?? '', s.lng ?? '', s.status, s.notes, s.phone, ...extraKeys.map((k) => s.extra?.[k] ?? ''),
  ].map(q).join(',')));
  shareFile(`${r.name.replace(/[^\w\- ]+/g, '').trim() || 'route'}.csv`, lines.join('\n'), 'text/csv');
}

async function backup() {
  const data = { app: 'route-runner', version: 1, exportedAt: new Date().toISOString(), routes: state.routes, settings: state.settings };
  await shareFile(`route-runner-backup-${ymd()}.json`, JSON.stringify(data), 'application/json');
}

$('#backup-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'route-runner' || !Array.isArray(data.routes)) throw new Error('bad');
    let added = 0, updated = 0;
    for (const r of data.routes) {
      if (!r?.id || !Array.isArray(r.stops)) continue;
      const i = state.routes.findIndex((x) => x.id === r.id);
      if (i < 0) { state.routes.push(r); added++; }
      else if ((r.updatedAt || 0) > (state.routes[i].updatedAt || 0)) {
        if (state.route === state.routes[i]) state.route = r;
        state.routes[i] = r; updated++;
      }
    }
    if (data.settings?.orsKey && !state.settings.orsKey) { state.settings.orsKey = data.settings.orsKey; saveSettings(); }
    store.saveRoutes(state.routes);
    renderAll();
    if (!$('#screen').hidden) routesScreen();
    toast(`Restored ${added} new and ${updated} updated ${added + updated === 1 ? 'route' : 'routes'}.`);
  } catch {
    toast("That file isn't a Route Runner backup.");
  }
});

/* ---------------------------------------------------------------- settings */

function settingsScreen() {
  const s = state.settings;
  const seg = (name, value, options) => `<div class="segmented" role="radiogroup">${options.map(([v, label]) => `<label><input type="radio" name="${name}" value="${v}" ${value === v ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div>`;
  openScreen('Settings', `
    <div class="section">
      <h2>Directions</h2>
      ${seg('navApp', s.navApp || 'builtin', [['builtin', 'In this app'], ['apple', 'Apple'], ['google', 'Google'], ['waze', 'Waze']])}
      <p class="hint">"In this app" gives turn-by-turn directions right here. The others hand each stop to that app (Google Maps and Waze need their apps installed).</p>
      <label class="check-row" style="margin-top:6px"><input type="checkbox" id="set-voice" ${s.voice ? 'checked' : ''}> Spoken directions</label>
    </div>
    <div class="section">
      <h2>Where the route ends</h2>
      ${seg('endMode', s.endMode, [['open', 'At the last stop'], ['return', 'Back where I started']])}
    </div>
    <div class="section">
      <h2>Map look</h2>
      ${seg('mapStyle', ['auto', 'streets', 'dark'].includes(s.mapStyle) ? s.mapStyle : 'auto', [['auto', 'Auto'], ['streets', 'Light'], ['dark', 'Dark']])}
      <p class="hint">Auto switches to dark when your phone is in dark mode.</p>
      <label class="check-row" style="margin-top:6px"><input type="checkbox" id="set-roadlines" ${s.roadLines ? 'checked' : ''}> Draw the route along roads</label>
    </div>
    <div class="section">
      <h2>Your area</h2>
      <label class="field"><span>Added to addresses with no city</span><input class="input" id="set-area" value="${esc(s.areaHint)}" placeholder="City, State" autocomplete="off"></label>
    </div>
    <div class="section">
      <h2>Backup routing (optional)</h2>
      <p class="hint" style="margin:0 0 10px">Drive times and directions come from a free OpenStreetMap routing server, no key needed. If that server is ever down, a free OpenRouteService key is used instead. Make one at <a href="https://openrouteservice.org/plans/" target="_blank" rel="noopener">openrouteservice.org</a> and paste it here.</p>
      <label class="field"><span>OpenRouteService key</span><input class="input" id="set-key" value="${esc(s.orsKey)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Optional"></label>
      <div class="two">
        <button class="btn btn-secondary" type="button" data-action="test-key">Test key</button>
        <button class="btn btn-secondary" type="button" data-action="clear-key" ${s.orsKey ? '' : 'disabled'}>Remove key</button>
      </div>
    </div>
    <div class="section">
      <h2>Storage</h2>
      <p class="hint" style="margin:0 0 10px">Using ${store.storageUsedKB()} KB on this phone. ${store.geocache_.size()} looked-up addresses are remembered so they never need looking up again.</p>
      <button class="btn btn-secondary btn-block" type="button" data-action="clear-cache">Forget looked-up addresses</button>
    </div>
    <div class="section">
      <h2>About</h2>
      <p class="hint">Route Runner ${APP_VERSION}. Map by OpenFreeMap and OpenMapTiles, map data © OpenStreetMap contributors. Directions by OSRM on the FOSSGIS routing server. Address lookup by the U.S. Census Bureau and Nominatim. Excel files read with SheetJS.</p>
    </div>`, { left: 'Done' });

  document.querySelectorAll('#screen input[type=radio]').forEach((el) => el.addEventListener('change', (e) => {
    state.settings[e.target.name] = e.target.value;
    saveSettings();
    if (e.target.name === 'mapStyle') applyTheme();
  }));
  $('#set-voice').addEventListener('change', (e) => { state.settings.voice = e.target.checked; saveSettings(); });
  $('#set-key').addEventListener('change', (e) => { state.settings.orsKey = e.target.value.trim(); saveSettings(); });
  $('#set-roadlines').addEventListener('change', (e) => {
    state.settings.roadLines = e.target.checked;
    saveSettings();
    if (!e.target.checked) { state.roadLine = null; state.roadSig = ''; renderLine(); } else maybeRoadLine();
  });
  $('#set-area').addEventListener('change', (e) => { state.settings.areaHint = e.target.value.trim(); saveSettings(); });
}

/* ------------------------------------------------------------------- demo */

async function demoRoute() {
  busy('Finding your location');
  let c;
  try { c = await getPosition(); } catch { c = mv.getCenter(); }
  busy(false);
  const stops = [];
  for (let i = 0; i < 15; i++) {
    const ang = Math.random() * Math.PI * 2, dist = 800 + Math.random() * 6500;
    stops.push({
      name: `Practice stop ${i + 1}`,
      address: '',
      lat: c.lat + (dist * Math.cos(ang)) / 111320,
      lng: c.lng + (dist * Math.sin(ang)) / (111320 * Math.cos((c.lat * Math.PI) / 180)),
      geo: 'manual', precision: 'exact',
    });
  }
  const r = newRoute('Practice route', stops);
  state.route = r;
  store.saveCurrentId(r.id);
  saveRoute();
  renderAll();
  setSheet('peek');
  fitAll();
  toast('Added 15 practice stops around you, in random order. Tap Optimize to see the best order.', { action: 'Optimize', run: optimize, duration: 9000 });
}

/* ---------------------------------------------------------- click routing */

const ACTIONS = {
  'cycle-sheet': () => cycleSheet(),
  import: () => $('#file-input').click(),
  paste: () => pasteScreen(),
  routes: () => routesScreen(),
  demo: () => demoRoute(),
  optimize: () => optimize(),
  fit: () => { setSheet('peek'); fitAll(); },
  navigate: (id) => openNav(findStop(id)),
  done: (id) => setStatus(findStop(id), 'done'),
  'toggle-done': (id) => { const s = findStop(id); setStatus(s, s.status === 'todo' ? 'done' : 'todo'); },
  stop: (id) => { state.selectedId = id; renderMarkers(); stopActions(id); },
  review: () => reviewScreen(),
  'retry-lookups': () => retryLookups(),
  'close-screen': () => closeScreen(),
  'add-stop': () => addStopScreen(),
  'edit-stop': (id) => editStopScreen(findStop(id)),
  reset: async () => {
    if (await confirmSheet('Reset progress?', 'Every stop goes back to not done. The order stays the same.', 'Reset progress')) resetRoute(state.route);
  },
  rename: async () => {
    const v = await promptSheet('Rename route', state.route.name, 'Save');
    if (v) { state.route.name = v; saveRoute(); renderSheet(); }
  },
  'export-csv': () => exportCSV(state.route),
  'open-route': (id) => { closeScreen(); openRoute(id); },
  'route-menu': (id) => routeMenu(id),
  backup: () => backup(),
  restore: () => $('#backup-input').click(),
  'imp-go': () => state.importJob?.go(),
  'gc-stop': () => state.gcAbort?.abort(),
  'paste-go': () => {
    const text = $('#paste-text').value;
    let rows;
    if (text.includes('\t')) {
      rows = parseDelimited(text); // copied from a spreadsheet
    } else {
      // One stop per line. "Kroger, 123 Main St, Columbus, MS" -> name + address.
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      rows = [['Name', 'Address'], ...lines.map((l) => {
        const parts = l.split(',');
        if (parts.length > 1 && !/\d/.test(parts[0]) && /^\s*\d/.test(parts[1])) return [parts[0].trim(), parts.slice(1).join(',').trim()];
        return ['', l];
      })];
      if (rows.length === 1) rows = [];
    }
    if (!rows.length) return toast('Paste at least one address.');
    const name = $('#paste-name').value.trim();
    mappingScreen({ sheets: [{ name: 'Pasted', rows }] }, name);
  },
  'ed-save': async (id) => {
    const s = findStop(id);
    const changed = readEditFields(s);
    if (changed && s.address) {
      const found = await lookupStop(s);
      if (!found) { s.lat = null; s.lng = null; s.geo = 'failed'; s.precision = null; }
    }
    saveRoute();
    closeScreen();
    renderAll();
    scheduleRoadLine();
    if (!changed) toast('Saved.');
  },
  'ed-lookup': async (id) => {
    const s = findStop(id);
    readEditFields(s);
    if (await lookupStop(s)) { saveRoute(); renderAll(); editStopScreen(s); }
  },
  'ed-place': (id) => { const s = findStop(id); readEditFields(s); saveRoute(); startPlacing(s); },
  'add-go': async () => {
    const name = $('#add-name').value.trim();
    const address = $('#add-address').value.trim();
    const notes = $('#add-notes').value.trim();
    if (!address) return toast('Add an address, or press and hold on the map to drop a pin.');
    const r = state.route;
    const [s] = makeStops([{ name: name || address.split(',')[0], address, notes }]);
    r.stops.push(s);
    const found = await lookupStop(s);
    if (!found) s.geo = 'failed';
    saveRoute();
    closeScreen();
    renderAll();
    if (found) toast('Stop added at the end. Optimize to fit it into the route.', { action: 'Optimize', run: optimize, duration: 7000 });
    else toast("Stop added, but it isn't on the map yet.", { action: 'Place it', run: () => startPlacing(s), duration: 7000 });
  },
  'test-key': async () => {
    const key = $('#set-key').value.trim();
    if (!key) return toast('Paste your key first.');
    state.settings.orsKey = key;
    saveSettings();
    busy('Testing key');
    try { await testOrsKey(key); busy(false); toast('Key works. It will be used if the free routing server is down.'); } catch (e) { busy(false); toast(e.message || "That key didn't work."); }
  },
  'clear-key': () => { state.settings.orsKey = ''; saveSettings(); settingsScreen(); toast('Key removed.'); },
  'clear-cache': () => { store.geocache_.clear(); settingsScreen(); toast('Forgot all looked-up addresses.'); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el.dataset.id, el); }
});

$('#btn-routes').addEventListener('click', routesScreen);
$('#btn-settings').addEventListener('click', settingsScreen);
$('#btn-fit').addEventListener('click', () => { state.following = false; $('#btn-locate').classList.remove('is-on'); fitAll(); });
$('#btn-locate').addEventListener('click', async () => {
  try {
    const me = await getPosition();
    state.following = true;
    $('#btn-locate').classList.add('is-on');
    focusOn(me, Math.max(mv.getZoom(), 15));
  } catch (e) {
    toast(locationErrorText(e), { duration: 7000 });
  }
});

window.addEventListener('resize', () => { setSheet(state.snap, false); mv.resize(); });
// The page itself must never scroll; only the panels inside it do.
for (const el of [document.documentElement, document.body]) {
  el.addEventListener('scroll', () => { if (el.scrollTop || el.scrollLeft) { el.scrollTop = 0; el.scrollLeft = 0; } });
}
window.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') updateNextDistance();
});

/* -------------------------------------------------------------------- boot */

applyTheme();
state.route = state.routes.find((r) => r.id === store.loadCurrentId()) || null;
renderAll();
requestAnimationFrame(() => { setSheet('peek', false); fitAll(); maybeRoadLine(); });

navigator.permissions?.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') startWatch(); }).catch(() => {});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Exposed for automated tests only.
window.__rr = { state, optimize, openRoute, nav, mv, startNav };
