# Route Runner

A free iPhone web app for driving a long list of stops. Import a spreadsheet,
every stop gets a numbered pin, Optimize puts them in the fastest order from
where you are, and Go gives turn-by-turn directions right inside the app.
Routes are saved on the phone so you only import once.

## Put it online (free, done once)

1. Create a public GitHub repository named `route-runner`.
2. Upload everything inside this folder (index.html, css, js, lib, fonts, icons,
   and the rest). Drag the contents, not the folder itself.
3. Settings > Pages > Deploy from a branch > main, / (root) > Save.
4. Your link: `https://YOUR-USERNAME.github.io/route-runner/`

To update later, upload the new files the same way. They replace the old ones.

## Put it on your iPhone

1. Open your link in Safari, tap Share, then Add to Home Screen.
2. Open Route Runner from the home screen and allow location.
3. Import inside the home screen app. It keeps its own storage, separate from Safari.

## Using it

- **Import spreadsheet**: .xlsx or .csv from Files or iCloud Drive. Columns are
  matched automatically. If a file has several sheets, pick one.
- **Optimize**: puts the remaining stops in the fastest order from your location,
  using real drive times.
- **Go**: turn-by-turn directions in the app. The map turns with you so the road
  ahead is always up, with spoken directions and rerouting if you miss a turn.
  When you pull up, a card shows the business name and address; **Next stop**
  checks it off and starts directions to the next one.
- **Curbside arrivals** (on by default): every approach is planned so the business
  is on your right and you don't cross traffic. Each stop shows "Right side" or
  "Left side" for when that isn't possible.
- **Map**: satellite with street names (or Map / Dark in Settings). Red pins show
  the stop number; the tip is the exact spot. Dark blue is your path to the next
  stop, faded blue is the rest of the route.
- Tap any stop to skip it, do it next, move it to a number, edit it, place its
  pin by hand, or call it. Press and hold the map to drop a new stop.
- **Saved routes** keeps every route with its order and progress. Use
  **Save backup** now and then to keep a copy in iCloud Drive.

## Good to know

- Keep Route Runner open on screen while driving. iPhone web apps can't track
  location in the background; the app keeps the screen awake for you
  (iOS 18.4 or later). If you switch apps, directions pick up when you come back.
- Drive times come from free OpenStreetMap routing and don't include live traffic.
- If directions don't speak, check the volume. Spoken directions can be turned
  off in Settings or from the Voice button while driving.
- Settings > Directions can hand stops to Apple Maps, Google Maps, or Waze instead.

## Free services used (no keys needed)

- Map: MapLibre GL with OpenFreeMap tiles. Map data © OpenStreetMap contributors.
- Satellite: USGS The National Map aerial imagery (public domain). Optional free
  ArcGIS key in Settings for sharper Esri imagery up close.
- Business locations: OpenStreetMap via Overpass, used to put pins on the building.
- Directions and drive times: OSRM on the FOSSGIS routing server.
- Address lookup: U.S. Census Bureau geocoder, then OpenStreetMap Nominatim.
- Optional backup: a free OpenRouteService key (Settings) is used if the routing
  server is down.

## What's inside

- `index.html`, `css/app.css`: layout and design
- `js/app.js`: panels, import flow, saved routes, settings
- `js/mapview.js`: the map, pins, satellite view and route lines
- `js/nav.js`, `js/router.js`: turn-by-turn navigation
- `js/optimizer.js`: route ordering (exact up to 13 stops; fast local search above)
- `js/importer.js`: CSV/Excel reading, column matching, address cleanup
- `js/services.js`: address lookup and drive times
- `js/store.js`: on-phone storage
- `sw.js`, `manifest.webmanifest`, `icons/`: home screen app and offline support
- `lib/maplibre` (BSD-3), `fonts/` (Overpass, SIL Open Font License)

If your repo still has an old `lib/leaflet` folder from version 1.0, you can
delete it; nothing uses it anymore.
