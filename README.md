# TrailMark Live

A standalone version of the full TrailMark app — **Track**, **Journal**, and
**Discover** — where Discover is backed by real, live trail data from
[OpenStreetMap](https://www.openstreetmap.org) instead of a hardcoded list.

## What's in it

- **Track** — GPS-tracked hikes using your browser's geolocation, with a live
  timer and distance readout. Falls back to timing-only if location isn't
  available.
- **Journal** — every hike you've tracked or logged by hand, saved in the
  browser's `localStorage` so it's there next time you open the page.
- **Discover** — search real named trails in any US state, pulled live from
  OpenStreetMap. Save trails for later or log one straight to your journal.

## How Discover's live data works

- The backend (`server.js`) is a small Express server. When you search a state,
  it sends a query to the public **Overpass API** (OpenStreetMap's search
  engine) asking for every named `path`/`footway` inside that state's
  boundary.
- OpenStreetMap often splits one long trail into many short mapped segments.
  The server groups segments that share a name and sums their length using
  the actual GPS geometry, so you get one real distance per trail rather than
  a pile of fragments.
- Results are cached in memory for 10 minutes per state+search so repeat
  searches don't hit the public Overpass endpoint unnecessarily — it's free,
  shared infrastructure with rate limits.
- No API key is required. Overpass is open and free to query.

## Running it locally

Requires **Node 18+** (for built-in `fetch`).

```bash
cd trailmark-live
npm install
npm start
```

Then open **http://localhost:3000**.

## Notes and honest limitations

- **Difficulty** comes from OSM's `sac_scale` tag, which most US trail
  mappers don't set — expect a lot of "Unknown". This is a real gap in the
  crowd-sourced data, not a bug.
- **Distance** is computed from the mapped trail geometry, so accuracy
  depends on how well that trail has been surveyed/mapped in OpenStreetMap.
  Well-trafficked national park trails tend to be mapped precisely;
  obscure local trails sometimes aren't mapped at all yet.
- The Overpass query only looks for `highway=path` and `highway=footway`
  ways with a `name` tag. Some trails are mapped as `route=hiking`
  relations instead — extending the query to also parse those would catch
  more multi-day/long-distance trails.
- The public Overpass instance (`overpass-api.de`) can be slow or briefly
  unavailable under load. For a production app, consider running your own
  Overpass instance or using a paid alternative.
- **Track and Journal data lives in your browser's `localStorage`**, not on
  the server — it's per-device and won't sync across devices or survive
  clearing browser data. A real multi-device version would need a database
  and accounts.

## Deploying it

This is a normal Node app, so it deploys anywhere that runs Node:
**Render**, **Railway**, **Fly.io**, a VPS, etc. (Vercel/Netlify work too,
but you'd adapt `server.js` into a serverless function rather than a
long-running Express server.) There's no database and no secrets to
configure — just `npm install && npm start`.

## Extending it

- Swap in a different data source (Recreation.gov's RIDB API, the National
  Park Service API) by replacing the Overpass call in `server.js` — the
  rest of the app doesn't care where the data comes from as long as the
  `/api/trails` response shape stays the same.
- Add elevation gain by fetching each trail's geometry against an elevation
  API (e.g. Open-Elevation) and summing positive changes between points.
- Wire this backend into the original TrailMark React artifact's Discover
  tab instead of its hardcoded array, by pointing its `fetch` calls at
  this server.
