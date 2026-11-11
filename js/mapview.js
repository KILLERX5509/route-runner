// The map: MapLibre GL with free tiles.
//   satellite: USGS aerial imagery (public domain, no key) with street names on top.
//              With a free ArcGIS key, Esri World Imagery instead (sharper up close).
//   map:       OpenFreeMap "liberty" street map.
//   dark:      OpenFreeMap dark street map.

const ml = window.maplibregl;

const VECTOR = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const SAT = {
  usgs: {
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 16,
    attribution: 'Imagery: USGS The National Map',
  },
  esri: (key) => ({
    tiles: [`https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(key)}`],
    maxzoom: 19,
    attribution: 'Imagery: Esri, Vantor, Earthstar Geographics',
  }),
};

// Route colors, like Google Maps: dark blue for where you're headed now,
// faded blue for the rest of the route.
const CURRENT = '#3B2BEB', CURRENT_EDGE = '#17106E';
const REST = '#8E9BFA', REST_EDGE = '#4C57C6';

export function createMapView(container, { center, onPinTap, onMapTap, onLongPress, onUserMove, onSatelliteFail }) {
  const map = new ml.Map({
    container,
    style: VECTOR.light,
    center: [center[1], center[0]],
    zoom: 12,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 60,
    fadeDuration: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');

  let look = { kind: 'map', satKey: '' }; // what's showing now
  let lines = { current: [], rest: [] };
  let pins = [];
  let meMarker = null, meEl = null;
  let navMode = false;
  let satErrors = 0, satOk = false;

  const fc = (coords) => (coords && coords.length >= 2
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] }
    : { type: 'FeatureCollection', features: [] });

  function firstSymbolLayer() {
    return (map.getStyle()?.layers || []).find((l) => l.type === 'symbol')?.id;
  }

  // Turn the street map into "satellite with labels".
  function makeHybrid() {
    const layers = map.getStyle().layers || [];
    const src = look.satKey ? SAT.esri(look.satKey) : SAT.usgs;
    const firstReal = layers.find((l) => l.type !== 'background')?.id;
    map.addSource('rr-sat', { type: 'raster', tiles: src.tiles, tileSize: 256, maxzoom: src.maxzoom, attribution: src.attribution });
    map.addLayer({ id: 'rr-sat', type: 'raster', source: 'rr-sat', paint: { 'raster-fade-duration': 0 } }, firstReal);
    for (const l of layers) {
      try {
        if (['background', 'fill', 'fill-extrusion', 'raster', 'hillshade', 'heatmap'].includes(l.type)) {
          map.setLayoutProperty(l.id, 'visibility', 'none');
        } else if (l.type === 'line') {
          if (l['source-layer'] === 'transportation') map.setPaintProperty(l.id, 'line-opacity', 0.28);
          else map.setLayoutProperty(l.id, 'visibility', 'none');
        } else if (l.type === 'symbol' && l.layout?.['text-field']) {
          map.setPaintProperty(l.id, 'text-color', '#ffffff');
          map.setPaintProperty(l.id, 'text-halo-color', 'rgba(0,0,0,0.85)');
          map.setPaintProperty(l.id, 'text-halo-width', 1.6);
        }
      } catch { /* a layer that doesn't take that property */ }
    }
    satErrors = 0;
    satOk = false;
  }

  function install() {
    if (look.kind === 'satellite') makeHybrid();
    if (map.getSource('rr-rest')) return;
    const before = firstSymbolLayer();
    map.addSource('rr-rest', { type: 'geojson', data: fc(lines.rest) });
    map.addSource('rr-current', { type: 'geojson', data: fc(lines.current) });
    const round = { 'line-join': 'round', 'line-cap': 'round' };
    map.addLayer({ id: 'rr-rest-edge', type: 'line', source: 'rr-rest', layout: round, paint: { 'line-color': REST_EDGE, 'line-width': 9, 'line-opacity': 0.75 } }, before);
    map.addLayer({ id: 'rr-rest', type: 'line', source: 'rr-rest', layout: round, paint: { 'line-color': REST, 'line-width': 6 } }, before);
    map.addLayer({ id: 'rr-current-edge', type: 'line', source: 'rr-current', layout: round, paint: { 'line-color': CURRENT_EDGE, 'line-width': 11 } }, before);
    map.addLayer({ id: 'rr-current', type: 'line', source: 'rr-current', layout: round, paint: { 'line-color': CURRENT, 'line-width': 7.5 } }, before);
  }
  map.on('style.load', install);
  // Keep the map credits as a small (i) button until tapped.
  map.once('load', () => {
    container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  });

  // If the imagery won't load, fall back to the street map instead of a blank screen.
  map.on('error', (e) => {
    if (e?.sourceId !== 'rr-sat' || satOk) return;
    if (++satErrors === 10) onSatelliteFail?.();
  });
  map.on('sourcedata', (e) => { if (e.sourceId === 'rr-sat' && e.tile) satOk = true; });

  function setLook(kind, satKey = '') {
    if (look.kind === kind && look.satKey === satKey) return;
    look = { kind, satKey };
    map.setStyle(kind === 'dark' ? VECTOR.dark : VECTOR.light, { diff: false });
  }

  // Teardrop pins: the number sits in the round head, the tip marks the exact spot.
  function setPins(list) {
    for (const p of pins) p.marker.remove();
    pins = [];
    const order = [...list].sort((a, b) => a.z - b.z);
    for (const p of order) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `pin-wrap ${p.wrapCls || ''}`;
      el.setAttribute('aria-label', p.label);
      el.innerHTML = `<div class="${p.cls}"><span>${p.num}</span></div>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); onPinTap?.(p.id); });
      const marker = new ml.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(map);
      pins.push({ id: p.id, marker });
    }
  }

  function setRoute({ current = [], rest = [] }) {
    lines = { current, rest };
    map.getSource('rr-current')?.setData(fc(current));
    map.getSource('rr-rest')?.setData(fc(rest));
  }

  function setMe(p) {
    if (!p) return;
    if (!meMarker) {
      meEl = document.createElement('div');
      meEl.className = 'me';
      meEl.innerHTML = '<div class="me-dot"></div><svg class="me-arrow" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4 40 42 24 33 8 42z"/></svg>';
      meMarker = new ml.Marker({ element: meEl, anchor: 'center', rotationAlignment: 'viewport', pitchAlignment: 'map' })
        .setLngLat([p.lng, p.lat]).addTo(map);
    }
    meMarker.setLngLat([p.lng, p.lat]);
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

  // Heading-up driving view: the map turns so the road ahead points up the screen.
  function follow(p, { bearing, zoom, padding }) {
    map.easeTo({ center: [p.lng, p.lat], bearing, zoom, pitch: 45, padding, duration: 950, easing: (t) => t });
  }

  function setNavMode(on) {
    navMode = on;
    meEl?.classList.toggle('is-nav', on);
    if (on) map.touchZoomRotate.enableRotation();
    else {
      map.touchZoomRotate.disableRotation();
      map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
    }
  }

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
    setLook,
    setPins,
    setRoute,
    setMe,
    fit,
    focus,
    follow,
    setNavMode,
    getCenter: () => { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
    getZoom: () => map.getZoom(),
    resize: () => map.resize(),
    isNav: () => navMode,
    look: () => look.kind,
  };
}
