# Route Runner

A free iPhone web app for driving a long list of stops. Import a spreadsheet,
every stop gets a numbered pin, and Optimize puts them in the fastest order
from where you are. Routes are saved on the phone so you only import once.

## Put it online (free, about 5 minutes, done once)

Use a computer with Chrome or Edge.

1. Go to github.com and sign in. Click **New** (new repository).
2. Name it `route-runner`, choose **Public**, and click **Create repository**.
3. On the empty repo page, click **uploading an existing file**.
4. Unzip `route-runner.zip`. Open the folder, select **everything inside it**
   (index.html, css, js, lib, fonts, icons, and the rest) and drag it onto the page.
   Click **Commit changes**.
5. Go to **Settings > Pages**. Under "Build and deployment", set Source to
   **Deploy from a branch**, Branch to **main** and **/ (root)**, then **Save**.
6. Wait a minute or two, then refresh that page. It shows your link, which looks
   like `https://YOUR-USERNAME.github.io/route-runner/`.

## Put it on your iPhone

1. Open your link in **Safari** (it has to be Safari).
2. Tap the Share button, then **Add to Home Screen**, then **Add**.
3. Open Route Runner from the home screen icon and allow location when asked.
4. Do your imports **inside the home screen app**. It keeps its own storage,
   separate from Safari.

## Using it

- **Import spreadsheet**: pick an .xlsx or .csv file from Files or iCloud Drive.
  Columns are matched automatically (name, address, city, state, ZIP, notes,
  phone, or latitude/longitude). Any layout works; you can fix the matching.
- Addresses are looked up once, then saved with the route.
- **Optimize** puts the remaining stops in the fastest order from your location.
  Under Settings you can choose to end at the last stop or come back to the start.
- **Navigate** hands the next stop to Apple Maps, Google Maps, or Waze (Settings).
  **Done** checks it off and moves to the next one.
- Tap any stop for more: skip it, do it next, move it to a number, edit it,
  place its pin by hand, or call its phone number.
- Press and hold the map to drop a new stop.
- **Saved routes** holds every route with its order and progress. Use
  **Save backup** now and then to keep a copy in iCloud Drive.

## Optional: real drive times

Without a key, Optimize uses straight-line distances (works well in most towns)
and address lookup runs about one per second. For real driving times, faster
lookup, and route lines that follow the roads, make a free account at
openrouteservice.org, copy your API key, and paste it under Settings.
The key is stored only on your phone.

## Updating

Upload changed files to the same GitHub repo. The app picks up the new version
the next time it opens with a signal. Your routes on the phone aren't affected.

## What's inside

- `index.html`, `css/app.css`: layout and design
- `js/app.js`: map, panels, import flow, saved routes, settings
- `js/optimizer.js`: route ordering (exact up to 13 stops; fast local search above)
- `js/importer.js`: CSV/Excel reading and column matching
- `js/services.js`: address lookup and drive times
- `js/store.js`: on-phone storage
- `sw.js`, `manifest.webmanifest`, `icons/`: home screen app and offline support
- `lib/leaflet` (map library, BSD-2), `fonts/` (Overpass, SIL Open Font License)

Map data and tiles © OpenStreetMap contributors. If you add a free CARTO key
in Settings, the map uses CARTO's tiles instead.
