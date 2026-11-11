// The map: MapLibre GL (sharp vector map) with OpenFreeMap's free tiles.
// Everything else in the app talks to the map through this small API.

const ml = window.maplibregl;

export const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

const GREEN = '#0B6E4F';
const BLUE = '#2F80ED';

export function createMapView(container, { center, onPinTap, onMapTap, onLongPress, onUserMove }) {
  const map = new ml.Map({
    container,
    style: STYLES.light,
    center: [center[1], center[0]],
    zoom: 12,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 60,
    fadeDuration: 0,
    cooperativeGestures: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');

  let styleKey = 'light';
  let routeData = { coords: [], kind: 'straight' };
  let navData = { coords: [] };
  let pins = [];
  let meMarker = null;
  let meEl = null;
  let navMode = false;

  const empty = () => ({ type: 'FeatureCollection', features: [] });
  const line = (coords, props = {}) => (coords.length >= 2
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } }] }
    : empty());

  function firstSymbolLayer() {
    const layers = map.getStyle()?.layers || [];
    return layers.find((l) => l.type === 'symbol')?.id;
  }

  function install() {
    if (!map.getSource('rr-route')) {
      const before = firstSymbolLayer();
      map.addSource('rr-route', { type: 'geojson', data: line(routeData.coords, { kind: routeData.kind }) });
      map.addSource('rr-nav', { type: 'geojson', data: line(navData.coords) });
      map.addLayer({ id: 'rr-route-casing', type: 'line', source: 'rr-route', filter: ['==', ['get', 'kind'], 'road'],
        layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 } }, before);
      map.addLayer({ id: 'rr-route-road', type: 'line', source: 'rr-route', filter: ['==', ['get', 'kind'], 'road'],
        layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': GREEN, 'line-width': 5 } }, before);
      map.addLayer({ id: 'rr-route-dots', type: 'line', source: 'rr-route', filter: ['==', ['get', 'kind'], 'straight'],
        layout: { 'line-cap': 'round' }, paint: { 'line-color': GREEN, 'line-width': 5, 'line-dasharray': [0.1, 2.2] } }, before);
      map.addLayer({ id: 'rr-nav-casing', type: 'line', source: 'rr-nav',
        layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1A4F9C', 'line-width': 13 } }, before);
      map.addLayer({ id: 'rr-nav-line', type: 'line', source: 'rr-nav',
        layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': BLUE, 'line-width': 9 } }, before);
    }
  }
  map.on('style.load', install);

  function setStyle(dark) {
    const key = dark ? 'dark' : 'light';
    if (key === styleKey) return;
    styleKey = key;
    map.setStyle(STYLES[key], { diff: false });
  }

  // Pins are plain HTML elements so they look exactly like the rest of the app.
  function setPins(list) {
    for (const p of pins) p.marker.remove();
    pins = [];
    // Added in order so later ones sit on top: done, then upcoming (last first), then next.
    const order = [...list].sort((a, b) => a.z - b.z);
    for (const p of order) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'pin-wrap';
      el.setAttribute('aria-label', p.label);
      el.innerHTML = `<div class="${p.cls}"><span>${p.num}</span></div>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); onPinTap?.(p.id); });
      const marker = new ml.Marker({ element: el, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(map);
      pins.push({ id: p.id, marker });
    }
  }

  function setRouteLine(coords, kind) {
    routeData = { coords, kind };
    map.getSource('rr-route')?.setData(line(coords, { kind }));
  }

  function setNavLine(coords) {
    navData = { coords };
    map.getSource('rr-nav')?.setData(line(coords));
  }

  function setMe(me, heading) {
    if (!me) return;
    if (!meMarker) {
      meEl = document.createElement('div');
      meEl.className = 'me';
      meEl.innerHTML = '<div class="me-dot"></div><svg class="me-arrow" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 4 33 34 20 27 7 34z"/></svg>';
      meMarker = new ml.Marker({ element: meEl, anchor: 'center', rotationAlignment: 'map', pitchAlignment: 'map' })
        .setLngLat([me.lng, me.lat]).addTo(map);
    }
    meMarker.setLngLat([me.lng, me.lat]);
    if (Number.isFinite(heading)) meMarker.setRotation(heading);
  }

  function fit(points, padding) {
    if (!points.length) return;
    if (points.length === 1) return focus(points[0], 15, padding);
    let w = 180, s = 90, e = -180, n = -90;
    for (const p of points) { w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
    map.fitBounds([[w, s], [e, n]], { padding, maxZoom: 16, duration: 600, bearing: 0, pitch: 0 });
  }

  function focus(p, zoom, padding) {
    map.easeTo({ center: [p.lng, p.lat], zoom: zoom ?? Math.max(map.getZoom(), 14), padding, duration: 500 });
  }

  function follow(p, { bearing, zoom, padding }) {
    map.easeTo({ center: [p.lng, p.lat], bearing, zoom, pitch: 50, padding, duration: 900, easing: (t) => t });
  }

  function setNavMode(on) {
    navMode = on;
    meEl?.classList.toggle('is-nav', on);
    if (on) { map.touchZoomRotate.enableRotation(); }
    else {
      map.touchZoomRotate.disableRotation();
      map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
    }
  }

  // Taps, long-presses, and "the user moved the map".
  map.on('click', (e) => onMapTap?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
  map.on('contextmenu', (e) => onLongPress?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
  let press = null;
  map.on('touchstart', (e) => {
    if (press) clearTimeout(press.timer);
    if (e.originalEvent.touches.length !== 1) { press = null; return; }
    const at = e.point, ll = e.lngLat;
    press = { at, timer: setTimeout(() => { press = null; onLongPress?.({ lat: ll.lat, lng: ll.lng }); }, 650) };
  });
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  map.on('touchmove', (e) => { if (press && Math.hypot(e.point.x - press.at.x, e.point.y - press.at.y) > 10) cancelPress(); });
  map.on('touchend', cancelPress);
  map.on('touchcancel', cancelPress);
  map.on('dragstart', (e) => { if (e.originalEvent) onUserMove?.(); });

  return {
    map,
    setStyle,
    setPins,
    setRouteLine,
    setNavLine,
    setMe,
    fit,
    focus,
    follow,
    setNavMode,
    getCenter: () => { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
    getZoom: () => map.getZoom(),
    resize: () => map.resize(),
    isNav: () => navMode,
  };
}
