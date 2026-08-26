import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";
import { STATE_ISO, STATE_LIST } from "./states.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
// Mirror list verified directly against the OSM wiki's currently-maintained
// public-instance table (wiki.openstreetmap.org/wiki/Overpass_API) rather
// than assumed from memory -- two of the three original mirrors turned out
// to be stale:
//   - overpass.kumi.systems was renamed to overpass.private.coffee (same
//     operator, "no rate limit in place" per their own usage policy). The
//     old kumi.systems domain is legacy, which likely explains its mixed
//     502/timeout behavior versus a clean connect failure.
//   - overpass.openstreetmap.ru isn't on the current official list at all
//     -- it appears to simply be defunct, matching that it never once
//     succeeded across every live test.
// Replaced with the VK Maps instance (maps.mail.ru) as genuinely different
// hosting than overpass-api.de's Hetzner infrastructure -- real network
// path diversity if that path is ever the one having trouble.
const OVERPASS_URLS = [
  process.env.OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
].filter(Boolean);

// Shared community-submitted trails — a real, persistent, shared database
// (MongoDB Atlas free tier), separate from each user's own browser storage.
// Only active once MONGODB_URI is set as an environment variable on Render;
// until then, community-trail features quietly no-op so nothing else breaks.
let mongoClientPromise = null;
function getMongoClient() {
  if (!process.env.MONGODB_URI) return null;
  if (!mongoClientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI);
    mongoClientPromise = client.connect().then(() => client).catch((err) => {
      console.error("MongoDB connection failed:", err.message || err);
      mongoClientPromise = null;
      throw err;
    });
  }
  return mongoClientPromise;
}
async function getCommunityTrailsCollection() {
  const clientPromise = getMongoClient();
  if (!clientPromise) return null;
  try {
    const client = await clientPromise;
    return client.db("trailseeker").collection("community_trails");
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistent region cache (MongoDB) -- fixed lat/lon grid so trail/park/
// protected-area data, once queried anywhere, never needs to hit Overpass
// again for that same area, by anyone. Step 1 (this plumbing) was verified
// working in isolation with zero live behavior change. Step 2 wires it into
// /api/map-pins below.
// ---------------------------------------------------------------------------

// Fixed lat/lon grid, ~0.5deg cells (roughly 35-55km depending on latitude).
// Chosen so a typical /api/map-pins viewport (max 1.5deg span, per
// MAP_PINS_MAX_SPAN_DEG below) only ever needs to touch a handful of cells
// (up to 3x3=9), not dozens.
const CACHE_GRID_SIZE_DEG = 0.5;

// Given a bounding box, returns the list of grid cell keys it overlaps.
// Two overlapping-but-not-identical viewports will share most of their
// cells -- that's the whole point. Exact-bbox caching (like the existing
// 10-minute in-memory cache below) almost never hits twice in a row, since
// the map's exact viewport changes continuously as someone pans.
function gridCellsForBounds(swLat, swLon, neLat, neLon) {
  // A tiny epsilon on the upper bounds prevents a bbox edge that lands
  // exactly on a 0.5deg grid line from counting one extra "phantom" cell
  // it doesn't actually have any real overlap with (Math.floor of an exact
  // boundary value belongs to the next cell up, not the one below it).
  const EPSILON = 1e-9;
  const minCellLat = Math.floor(swLat / CACHE_GRID_SIZE_DEG);
  const maxCellLat = Math.floor((neLat - EPSILON) / CACHE_GRID_SIZE_DEG);
  const minCellLon = Math.floor(swLon / CACHE_GRID_SIZE_DEG);
  const maxCellLon = Math.floor((neLon - EPSILON) / CACHE_GRID_SIZE_DEG);
  const cells = [];
  for (let latIdx = minCellLat; latIdx <= maxCellLat; latIdx++) {
    for (let lonIdx = minCellLon; lonIdx <= maxCellLon; lonIdx++) {
      cells.push(`${latIdx}_${lonIdx}`);
    }
  }
  return cells;
}

// Inverse of the above -- given a grid cell key, returns the exact lat/lon
// bounds it covers. Needed when we run an Overpass query scoped to exactly
// one still-uncached cell (rather than the caller's arbitrary viewport).
function boundsForGridCell(cellKey) {
  const [latIdx, lonIdx] = cellKey.split("_").map(Number);
  return {
    swLat: latIdx * CACHE_GRID_SIZE_DEG,
    swLon: lonIdx * CACHE_GRID_SIZE_DEG,
    neLat: (latIdx + 1) * CACHE_GRID_SIZE_DEG,
    neLon: (lonIdx + 1) * CACHE_GRID_SIZE_DEG,
  };
}

async function getCachedRegionsCollection() {
  const clientPromise = getMongoClient();
  if (!clientPromise) return null;
  try {
    const client = await clientPromise;
    return client.db("trailseeker").collection("cached_regions");
  } catch (err) {
    return null;
  }
}

// Looks up a single grid cell's cached data, if any. Returns null both for
// a genuine cache miss AND when MongoDB isn't configured/reachable --
// callers should treat both cases identically: fall back to a live query.
async function getCachedRegion(cellKey) {
  const collection = await getCachedRegionsCollection();
  if (!collection) return null;
  try {
    const doc = await collection.findOne({ cellKey });
    return doc ? doc.data : null;
  } catch (err) {
    console.error(`Cache lookup failed for cell ${cellKey}:`, err.message || err);
    return null;
  }
}

// Saves a grid cell's data to the persistent cache. Upserts so re-saving
// the same cell (e.g. a manual refresh down the line) overwrites cleanly
// instead of creating duplicate documents.
async function saveCachedRegion(cellKey, data) {
  const collection = await getCachedRegionsCollection();
  if (!collection) return false;
  try {
    await collection.updateOne(
      { cellKey },
      { $set: { cellKey, data, cachedAt: new Date() } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error(`Cache save failed for cell ${cellKey}:`, err.message || err);
    return false;
  }
}

// Simple in-memory cache so repeat searches don't hammer the public Overpass
// endpoint (it's free, shared infrastructure and rate-limits aggressively).
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const la1 = (lat1 * Math.PI) / 180;
  const la2 = (lat2 * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function wayLengthKm(geometry) {
  let d = 0;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1];
    const b = geometry[i];
    if (a && b) d += haversineKm(a.lon, a.lat, b.lon, b.lat);
  }
  return d;
}

// Long trails can have thousands of GPS points across hundreds of segments.
// Sending all of them would bloat the response, so we thin each segment down
// to a max number of points while keeping the overall shape of the path.
function decimate(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const stride = points.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * stride)]);
  out.push(points[points.length - 1]);
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// OSM's sac_scale tag is the closest thing to a standard difficulty rating.
// Most US trails don't have it set, so "Unknown" will be common — that's
// a real limitation of crowd-sourced data, not a bug.
function difficultyFromTags(tags) {
  const sac = tags.sac_scale;
  if (!sac) return "Unknown";
  if (sac === "hiking") return "Easy";
  if (sac === "mountain_hiking") return "Moderate";
  if (sac === "demanding_mountain_hiking" || sac === "alpine_hiking" || sac === "demanding_alpine_hiking") return "Strenuous";
  return "Unknown";
}

app.get("/api/states", (_req, res) => {
  res.json({ states: STATE_LIST });
});

app.get("/api/trails", async (req, res) => {
  const stateInput = (req.query.state || "").trim();
  const q = (req.query.q || "").trim();
  const near = (req.query.near || "").trim();
  const directLat = parseFloat(req.query.lat);
  const directLon = parseFloat(req.query.lon);
  const hasDirectPoint = !Number.isNaN(directLat) && !Number.isNaN(directLon);
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];

  if (!iso) {
    return res.status(400).json({ error: "Unknown or missing state. Send a full state name (California) or two-letter code (CA)." });
  }

  const cacheKey = `${iso}::${q.toLowerCase()}::${near.toLowerCase()}::${hasDirectPoint ? `${directLat},${directLon}` : ""}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ trails: cached.data, cached: true });
  }

  // If we were given exact coordinates directly (e.g. "trails near this
  // park"), skip geocoding entirely and use them as-is.
  let centerPoint = hasDirectPoint ? { lat: directLat, lon: directLon } : null;
  if (near && !centerPoint) {
    try {
      const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(`${near}, ${stateInput}, USA`)}`;
      const geoResp = await fetch(geoUrl, {
        headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" },
      });
      const geoData = await geoResp.json();
      if (geoData && geoData[0]) {
        centerPoint = { lat: parseFloat(geoData[0].lat), lon: parseFloat(geoData[0].lon) };
      }
    } catch (geoErr) {
      console.error("Geocoding failed:", geoErr);
    }
    if (!centerPoint) {
      return res.status(404).json({ error: `Couldn't find "${near}" in ${stateInput}. Try a different spelling or nearby city.` });
    }
  }

  const nameFilter = q ? `["name"~"${escapeRegex(q)}",i]` : `["name"]`;
  // Ways tagged highway=path or highway=footway with a name are the closest
  // OSM equivalent of a "named trail" for shorter/local trails. But most
  // iconic, long-distance, or well-known named trails (e.g. Half Dome Trail,
  // John Muir Trail) are mapped as "hiking route" RELATIONS that group many
  // ways together — a plain way search misses these entirely. So we search
  // both and merge them below.
  const RADIUS_METERS = 24000; // ~15 miles around the searched city
  const overpassQuery = centerPoint
    ? `[out:json][timeout:25];
(
  way(around:${RADIUS_METERS},${centerPoint.lat},${centerPoint.lon})["highway"~"^(path|footway)$"]${nameFilter};
  relation(around:${RADIUS_METERS},${centerPoint.lat},${centerPoint.lon})["route"~"^(hiking|foot)$"]${nameFilter};
);
out tags geom;`.trim()
    : `[out:json][timeout:35];
area["ISO3166-2"="${iso}"]["admin_level"="4"]->.a;
(
  way(area.a)["highway"~"^(path|footway)$"]${nameFilter};
  relation(area.a)["route"~"^(hiking|foot)$"]${nameFilter};
);
out tags geom;`.trim();

  try {
    let data = null;
    let lastError = null;

    for (const url of OVERPASS_URLS) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
            "Accept": "application/json, text/plain, */*",
          },
          body: overpassQuery,
        });

        if (!resp.ok) {
          lastError = await resp.text();
          continue;
        }

        data = await resp.json();
        break;
      } catch (innerErr) {
        lastError = String(innerErr.message || innerErr);
        continue;
      }
    }

    if (!data) {
      return res.status(502).json({ error: "All Overpass mirrors are busy right now — please try again in a minute.", detail: (lastError || "").slice(0, 500) });
    }

    const elements = data.elements || [];

    const byName = new Map();
    const superRelationsToResolve = []; // { id, name } — relations with no directly-resolvable geometry

    for (const el of elements) {
      if (!el.tags?.name) continue;
      const name = el.tags.name;

      // Ways carry a flat geometry array. Relations (hiking routes) instead
      // carry their geometry nested under each way-member — collect each
      // member's points as its own segment.
      let segs = [];
      if (el.type === "relation" && Array.isArray(el.members)) {
        el.members.forEach((m) => {
          if (m.geometry && m.geometry.length >= 2) segs.push(m.geometry.filter((p) => p));
        });
      } else if (el.geometry && el.geometry.length >= 2) {
        segs.push(el.geometry.filter((p) => p));
      }

      if (segs.length === 0) {
        // A relation with no directly-resolvable geometry is very likely a
        // "super-relation" — a master relation (e.g. the Pacific Crest Trail
        // as a whole) whose direct members are themselves relations (one per
        // state segment), not ways. A plain query can't see through that
        // extra level, so we queue it for a targeted recursive follow-up
        // instead of silently dropping it.
        if (el.type === "relation" && q) superRelationsToResolve.push({ id: el.id, name });
        continue;
      }

      const lenKm = segs.reduce((sum, seg) => sum + wayLengthKm(seg), 0);
      const segCoordsList = segs.map((seg) => seg.map((p) => [p.lat, p.lon]));
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += segs.length;
        existing.segmentsGeom.push(...segCoordsList);
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          segments: segs.length,
          lat: segs[0][0].lat,
          lon: segs[0][0].lon,
          tags: el.tags,
          segmentsGeom: segCoordsList,
        });
      }
    }

    // Resolve super-relations: recurse all the way down to the actual way
    // geometries, however many levels of nested sub-relations there are.
    // Run these concurrently instead of one-by-one — sequential awaits here
    // were very likely the main reason searches were taking minutes.
    const toResolve = superRelationsToResolve.slice(0, 3).filter(({ name }) => !byName.has(name)); // cap: at most a few per search
    const resolved = await Promise.allSettled(
      toResolve.map(async ({ id, name }) => {
        const recurseQuery = `[out:json][timeout:25];relation(${id});(._;>>;);out geom;`.trim();
        const recurseData = await runOverpassQuery(recurseQuery);
        const segCoordsList = (recurseData.elements || [])
          .filter((e) => e.type === "way" && e.geometry && e.geometry.length >= 2)
          .map((e) => e.geometry.filter((p) => p).map((p) => [p.lat, p.lon]));
        if (segCoordsList.length === 0) throw new Error("no geometry resolved");
        const lenKm = segCoordsList.reduce((sum, seg) => sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))), 0);
        return {
          name,
          distance_km: lenKm,
          segments: segCoordsList.length,
          lat: segCoordsList[0][0][0],
          lon: segCoordsList[0][0][1],
          tags: {},
          segmentsGeom: segCoordsList,
        };
      })
    );
    resolved.forEach((r, i) => {
      if (r.status === "fulfilled") byName.set(r.value.name, r.value);
      else console.error(`Super-relation resolution failed for "${toResolve[i].name}":`, r.reason?.message || r.reason);
    });

    // Merge in official NPS trail centerlines when a name was searched — this
    // catches famous NPS trails (e.g. Half Dome) that OSM might tag under a
    // different name or not at all. This national layer has no clean
    // per-state field, so it's only worth querying when we have a specific
    // name to filter by (keeps it fast and avoids one state crowding out others).
    if (q) {
      try {
        const npsWhere = `UPPER(TRLNAME) LIKE UPPER('%${escapeRegex(q).replace(/'/g, "''")}%') OR UPPER(TRLALTNAME) LIKE UPPER('%${escapeRegex(q).replace(/'/g, "''")}%')`;
        const npsUrl = "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0/query"
          + `?where=${encodeURIComponent(npsWhere)}&outFields=TRLNAME,TRLALTNAME,TRLTYPE,TRLSURFACE,TRLCLASS,TRLUSE,UNITNAME&f=geojson`;
        const npsResp = await fetch(npsUrl, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
        if (npsResp.ok) {
          const npsData = await npsResp.json();
          (npsData.features || []).forEach((f) => {
            const name = f.properties.TRLNAME || f.properties.TRLALTNAME;
            if (!name || byName.has(name)) return;
            const geom = f.geometry;
            if (!geom) return;
            // GeoJSON LineString/MultiLineString coords are [lon,lat] — flip to [lat,lon].
            const lines = geom.type === "MultiLineString" ? geom.coordinates : geom.type === "LineString" ? [geom.coordinates] : [];
            const segCoordsList = lines.map((line) => line.map(([lon, lat]) => [lat, lon])).filter((seg) => seg.length >= 2);
            if (segCoordsList.length === 0) return;
            const lenKm = segCoordsList.reduce((sum, seg) => sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))), 0);
            byName.set(name, {
              name,
              distance_km: lenKm,
              segments: segCoordsList.length,
              lat: segCoordsList[0][0][0],
              lon: segCoordsList[0][0][1],
              tags: {
                surface: f.properties.TRLSURFACE || null,
                description: f.properties.UNITNAME ? `Official NPS trail in ${f.properties.UNITNAME}.` : null,
              },
              segmentsGeom: segCoordsList,
            });
          });
        }
      } catch (npsErr) {
        console.error("NPS trails merge failed:", npsErr.message || npsErr);
        // Not fatal — OSM results still get returned below.
      }

      // USGS's own "National Trails" layer — an aggregated dataset pulled
      // from 50+ federal/state/local sources, explicitly including National
      // Scenic Trails and other long-distance routes that OSM often maps
      // inconsistently (or as nested route relations we can't fully resolve).
      try {
        const usgsWhere = `UPPER(NAME) LIKE UPPER('%${escapeRegex(q).replace(/'/g, "''")}%')`;
        const usgsUrl = "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/11/query"
          + `?where=${encodeURIComponent(usgsWhere)}&outFields=NAME&inSR=4326&f=geojson`;
        const usgsResp = await fetch(usgsUrl, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
        if (usgsResp.ok) {
          const usgsData = await usgsResp.json();
          (usgsData.features || []).forEach((f) => {
            const name = f.properties.NAME;
            if (!name || byName.has(name)) return;
            const geom = f.geometry;
            if (!geom) return;
            const lines = geom.type === "MultiLineString" ? geom.coordinates : geom.type === "LineString" ? [geom.coordinates] : [];
            const segCoordsList = lines.map((line) => line.map(([lon, lat]) => [lat, lon])).filter((seg) => seg.length >= 2);
            if (segCoordsList.length === 0) return;
            const lenKm = segCoordsList.reduce((sum, seg) => sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))), 0);
            byName.set(name, {
              name,
              distance_km: lenKm,
              segments: segCoordsList.length,
              lat: segCoordsList[0][0][0],
              lon: segCoordsList[0][0][1],
              tags: { surface: null, description: "From USGS's National Trails dataset, aggregated from federal, state, and local sources." },
              segmentsGeom: segCoordsList,
            });
          });
        }
      } catch (usgsErr) {
        console.error("USGS National Trails merge failed:", usgsErr.message || usgsErr);
      }
    }

    const MAX_POINTS_PER_TRAIL = 400;
    const trails = Array.from(byName.values())
      .filter((t) => t.distance_km > 0.1)
      .map((t) => {
        const totalPoints = t.segmentsGeom.reduce((s, seg) => s + seg.length, 0);
        const perSegBudget = Math.max(2, Math.floor(MAX_POINTS_PER_TRAIL / t.segmentsGeom.length));
        const geometry = totalPoints <= MAX_POINTS_PER_TRAIL
          ? t.segmentsGeom
          : t.segmentsGeom.map((seg) => decimate(seg, perSegBudget));
        return {
          name: t.name,
          state: stateInput,
          distance_km: Math.round(t.distance_km * 10) / 10,
          difficulty: difficultyFromTags(t.tags),
          surface: t.tags.surface || null,
          segments: t.segments,
          lat: t.lat,
          lon: t.lon,
          geometry,
          osm_description: t.tags.description || null,
          osm_url: `https://www.openstreetmap.org/?mlat=${t.lat}&mlon=${t.lon}#map=15/${t.lat}/${t.lon}`,
        };
      })
      .sort((a, b) => b.distance_km - a.distance_km)
      .slice(0, 150);

    // Merge in community-submitted trails (custom routes users have added
    // to the shared database) matching this state and name filter.
    try {
      const collection = await getCommunityTrailsCollection();
      if (collection) {
        const mongoQuery = { state: stateInput };
        if (q) mongoQuery.name = { $regex: escapeRegex(q), $options: "i" };
        const community = await collection.find(mongoQuery).limit(50).toArray();
        community.forEach((c) => {
          trails.push({
            name: c.name,
            state: c.state,
            distance_km: c.distance_km,
            difficulty: "Unknown",
            surface: null,
            segments: c.geometry.length,
            lat: c.lat,
            lon: c.lon,
            geometry: c.geometry,
            osm_description: c.notes || "A custom route added by a Trailseeker user.",
            osm_url: null,
            community: true,
          });
        });
      }
    } catch (communityErr) {
      console.error("Community trails merge failed:", communityErr.message || communityErr);
    }

    cache.set(cacheKey, { data: trails, expires: Date.now() + CACHE_TTL_MS });
    res.json({ trails, cached: false, source: "OpenStreetMap (Overpass API)" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch trail data", detail: String(err.message || err) });
  }
});

// Classifies a park by whichever OSM tags matched it — national parks and
// protected/state-level areas use boundary, while most city/local parks
// use leisure=park.
function parkKind(tags) {
  if (tags.boundary === "national_park" || tags.protection_title === "National Park") return "National Park";
  if (tags.boundary === "protected_area" || tags.leisure === "nature_reserve") return "State / Protected Park";
  if (tags.leisure === "park") return "City / Local Park";
  return "Park";
}

// Wraps fetch() with a hard timeout via AbortController. Overpass's own
// [timeout:N] query parameter only bounds how long the SERVER spends
// processing a query once it starts -- it does nothing if a mirror never
// responds at all (connection accepted but hung, or silently dropped).
// Without a client-side timeout, a single unresponsive mirror can leave a
// fetch() pending indefinitely, which is what caused the "Loading..."
// freeze this endpoint hit earlier.
//
// 20s (not the original 12s) -- a live diagnostic showed a TINY single-node
// query against overpass-api.de taking ~4s just for connection + response.
// The real /api/map-pins query is far larger (full viewport, multiple tag
// filters across trails/parks/areas), so it needs real headroom under
// Overpass's own internal [timeout:25] query budget rather than being cut
// off by an overly tight client-side timeout before a legitimate (if slow)
// response has a chance to arrive.
const FETCH_TIMEOUT_MS = 20000;
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Shared helper: tries each Overpass mirror in turn for a given query,
// returning parsed JSON or throwing once all mirrors have failed. Logs
// every individual mirror's failure (not just the last one) -- without
// this, a caller only ever sees whichever mirror happened to be tried
// last, which makes it impossible to tell "only this one mirror is down"
// apart from "all three are unreachable" from the logs alone.
//
// Retries each mirror once before moving on. A live diagnostic showed
// overpass-api.de intermittently returning a raw connection failure
// ("fetch failed") on one attempt and a clean 200 with real data moments
// later on another -- that's flakiness, not a hard block, so a single
// retry on the same (otherwise-healthy) mirror is worth it before falling
// through to mirrors already confirmed to be in worse shape right now.
const OVERPASS_ATTEMPTS_PER_MIRROR = 2;
async function runOverpassQuery(overpassQuery) {
  let lastError = null;
  for (const url of OVERPASS_URLS) {
    for (let attempt = 1; attempt <= OVERPASS_ATTEMPTS_PER_MIRROR; attempt++) {
      try {
        const resp = await fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
            "Accept": "application/json, text/plain, */*",
          },
          body: overpassQuery,
        });
        if (!resp.ok) {
          lastError = await resp.text();
          console.error(`Overpass mirror returned ${resp.status} (attempt ${attempt}/${OVERPASS_ATTEMPTS_PER_MIRROR}): ${url}`, lastError.slice(0, 300));
          continue;
        }
        return await resp.json();
      } catch (innerErr) {
        lastError = innerErr.name === "AbortError" ? "Request timed out" : String(innerErr.message || innerErr);
        console.error(`Overpass mirror unreachable (attempt ${attempt}/${OVERPASS_ATTEMPTS_PER_MIRROR}): ${url}`, lastError);
      }
    }
  }
  throw new Error(lastError || "All Overpass mirrors failed");
}

// Nationwide search for multi-state, long-distance trails (Appalachian Trail,
// Pacific Crest Trail, Continental Divide Trail, etc.) — deliberately NOT
// bounded to a state, since that's exactly the problem: these trails span
// many states and get fragmented into per-state sections otherwise. This
// requires a specific name (searching all of OSM with no name filter at all
// would be far too slow/heavy).
app.get("/api/usa-trails", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q || q.length < 3) {
    return res.status(400).json({ error: "Enter at least 3 characters of a trail name to search nationwide." });
  }

  const cacheKey = `usa::${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ trails: cached.data, cached: true });
  }

  const nameFilter = `["name"~"${escapeRegex(q)}",i]`;
  const query = `[out:json][timeout:60];
(
  relation["route"~"^(hiking|foot)$"]${nameFilter};
);
out tags geom;`.trim();

  try {
    const data = await runOverpassQuery(query);
    const elements = data.elements || [];
    const byName = new Map();
    const superRelationsToResolve = [];

    for (const el of elements) {
      if (!el.tags?.name) continue;
      const name = el.tags.name;
      let segs = [];
      if (Array.isArray(el.members)) {
        el.members.forEach((m) => {
          if (m.geometry && m.geometry.length >= 2) segs.push(m.geometry.filter((p) => p));
        });
      }
      if (segs.length === 0) {
        superRelationsToResolve.push({ id: el.id, name });
        continue;
      }
      const lenKm = segs.reduce((sum, seg) => sum + wayLengthKm(seg), 0);
      const segCoordsList = segs.map((seg) => seg.map((p) => [p.lat, p.lon]));
      byName.set(name, {
        name, distance_km: lenKm, segments: segs.length,
        lat: segs[0][0].lat, lon: segs[0][0].lon, tags: el.tags, segmentsGeom: segCoordsList,
      });
    }

    // A name search this specific should only ever match one or two relations,
    // so resolve all of them recursively (no need for the small cap used in
    // the per-state search, which has to guard against broad browsing).
    for (const { id, name } of superRelationsToResolve) {
      if (byName.has(name)) continue;
      try {
        const recurseData = await runOverpassQuery(`[out:json][timeout:90];relation(${id});(._;>>;);out geom;`);
        const segCoordsList = (recurseData.elements || [])
          .filter((e) => e.type === "way" && e.geometry && e.geometry.length >= 2)
          .map((e) => e.geometry.filter((p) => p).map((p) => [p.lat, p.lon]));
        if (segCoordsList.length === 0) continue;
        const lenKm = segCoordsList.reduce((sum, seg) => sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))), 0);
        byName.set(name, {
          name, distance_km: lenKm, segments: segCoordsList.length,
          lat: segCoordsList[0][0][0], lon: segCoordsList[0][0][1], tags: {}, segmentsGeom: segCoordsList,
        });
      } catch (recurseErr) {
        console.error(`USA trail super-relation resolution failed for "${name}":`, recurseErr.message || recurseErr);
      }
    }

    // Also check NPS and USGS's national trail layers, same as the per-state
    // search does — these are already nationwide/unbounded by design.
    try {
      const npsWhere = `UPPER(TRLNAME) LIKE UPPER('%${escapeRegex(q).replace(/'/g, "''")}%') OR UPPER(TRLALTNAME) LIKE UPPER('%${escapeRegex(q).replace(/'/g, "''")}%')`;
      const npsUrl = "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0/query"
        + `?where=${encodeURIComponent(npsWhere)}&outFields=TRLNAME,TRLALTNAME,TRLSURFACE,UNITNAME&f=geojson`;
      const npsResp = await fetch(npsUrl, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
      if (npsResp.ok) {
        const npsData = await npsResp.json();
        (npsData.features || []).forEach((f) => {
          const name = f.properties.TRLNAME || f.properties.TRLALTNAME;
          if (!name || byName.has(name)) return;
          const geom = f.geometry;
          if (!geom) return;
          const lines = geom.type === "MultiLineString" ? geom.coordinates : geom.type === "LineString" ? [geom.coordinates] : [];
          const segCoordsList = lines.map((line) => line.map(([lon, lat]) => [lat, lon])).filter((seg) => seg.length >= 2);
          if (segCoordsList.length === 0) return;
          const lenKm = segCoordsList.reduce((sum, seg) => sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))), 0);
          byName.set(name, {
            name, distance_km: lenKm, segments: segCoordsList.length,
            lat: segCoordsList[0][0][0], lon: segCoordsList[0][0][1],
            tags: { surface: f.properties.TRLSURFACE || null, description: f.properties.UNITNAME ? `Official NPS trail in ${f.properties.UNITNAME}.` : null },
            segmentsGeom: segCoordsList,
          });
        });
      }
    } catch (npsErr) {
      console.error("NPS nationwide merge failed:", npsErr.message || npsErr);
    }

    try {
      const usgsWhere = `UPPER(NAME) LIKE UPPER('%${escapeRegex(q).replace(/'/g, "''")}%')`;
      const usgsUrl = "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/11/query"
        + `?where=${encodeURIComponent(usgsWhere)}&outFields=NAME&inSR=4326&f=geojson`;
      const usgsResp = await fetch(usgsUrl, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
      if (usgsResp.ok) {
        const usgsData = await usgsResp.json();
        (usgsData.features || []).forEach((f) => {
          const name = f.properties.NAME;
          if (!name || byName.has(name)) return;
          const geom = f.geometry;
          if (!geom) return;
          const lines = geom.type === "MultiLineString" ? geom.coordinates : geom.type === "LineString" ? [geom.coordinates] : [];
          const segCoordsList = lines.map((line) => line.map(([lon, lat]) => [lat, lon])).filter((seg) => seg.length >= 2);
          if (segCoordsList.length === 0) return;
          const lenKm = segCoordsList.reduce((sum, seg) => sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))), 0);
          byName.set(name, {
            name, distance_km: lenKm, segments: segCoordsList.length,
            lat: segCoordsList[0][0][0], lon: segCoordsList[0][0][1],
            tags: { surface: null, description: "From USGS's National Trails dataset, aggregated from federal, state, and local sources." },
            segmentsGeom: segCoordsList,
          });
        });
      }
    } catch (usgsErr) {
      console.error("USGS nationwide merge failed:", usgsErr.message || usgsErr);
    }

    const MAX_POINTS_PER_TRAIL = 600; // a bit higher here since these are often very long trails
    const trails = Array.from(byName.values())
      .filter((t) => t.distance_km > 0.5)
      .map((t) => {
        const totalPoints = t.segmentsGeom.reduce((s, seg) => s + seg.length, 0);
        const perSegBudget = Math.max(2, Math.floor(MAX_POINTS_PER_TRAIL / t.segmentsGeom.length));
        const geometry = totalPoints <= MAX_POINTS_PER_TRAIL ? t.segmentsGeom : t.segmentsGeom.map((seg) => decimate(seg, perSegBudget));
        return {
          name: t.name,
          state: "USA",
          distance_km: Math.round(t.distance_km * 10) / 10,
          difficulty: difficultyFromTags(t.tags),
          surface: t.tags.surface || null,
          segments: t.segments,
          lat: t.lat,
          lon: t.lon,
          geometry,
          osm_description: t.tags.description || null,
          osm_url: `https://www.openstreetmap.org/?mlat=${t.lat}&mlon=${t.lon}#map=6/${t.lat}/${t.lon}`,
        };
      })
      .sort((a, b) => b.distance_km - a.distance_km)
      .slice(0, 20);

    // Merge in community-submitted trails matching this name, nationwide
    // (no state constraint here, same as the rest of this endpoint).
    try {
      const collection = await getCommunityTrailsCollection();
      if (collection) {
        const community = await collection.find({ name: { $regex: escapeRegex(q), $options: "i" } }).limit(20).toArray();
        community.forEach((c) => {
          trails.push({
            name: c.name,
            state: c.state || "USA",
            distance_km: c.distance_km,
            difficulty: "Unknown",
            surface: null,
            segments: c.geometry.length,
            lat: c.lat,
            lon: c.lon,
            geometry: c.geometry,
            osm_description: c.notes || "A custom route added by a Trailseeker user.",
            osm_url: null,
            community: true,
          });
        });
      }
    } catch (communityErr) {
      console.error("Community trails merge failed:", communityErr.message || communityErr);
    }

    cache.set(cacheKey, { data: trails, expires: Date.now() + CACHE_TTL_MS });
    res.json({ trails, cached: false });
  } catch (err) {
    console.error("USA trails search failed:", err.message || err);
    res.status(502).json({ error: "Overpass is busy right now — try again in a minute." });
  }
});

app.get("/api/parks", async (req, res) => {
  const stateInput = (req.query.state || "").trim();
  const q = (req.query.q || "").trim();
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];

  if (!iso) {
    return res.status(400).json({ error: "Unknown or missing state. Send a full state name (California) or two-letter code (CA)." });
  }
  const stateCode = iso.split("-")[1]; // "US-CA" -> "CA"

  const cacheKey = `parks::${iso}::${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ parks: cached.data, cached: true });
  }

  const results = [];

  // Official NPS units (national parks, monuments, historic sites, recreation
  // areas, etc.) — reliable and authoritative, but only available once a free
  // NPS_API_KEY is configured (see /api/park-info comment below for how).
  if (process.env.NPS_API_KEY) {
    try {
      const npsResp = await fetch(`https://developer.nps.gov/api/v1/parks?stateCode=${stateCode}&limit=200`, {
        headers: { "X-Api-Key": process.env.NPS_API_KEY },
      });
      if (npsResp.ok) {
        const npsData = await npsResp.json();
        (npsData.data || []).forEach((p) => {
          if (q && !p.fullName.toLowerCase().includes(q.toLowerCase())) return;
          const lat = parseFloat(p.latitude);
          const lon = parseFloat(p.longitude);
          if (Number.isNaN(lat) || Number.isNaN(lon)) return;
          results.push({
            name: p.fullName,
            state: stateInput,
            kind: p.designation || "National Park Service Site",
            lat, lon,
            osm_description: p.description ? p.description.slice(0, 500) : null,
            osm_url: p.url,
          });
        });
      } else {
        console.error("NPS parks lookup returned", npsResp.status);
      }
    } catch (err) {
      console.error("NPS parks lookup failed:", err.message || err);
    }
  }

  // City/local parks from OpenStreetMap — kept to a single simple clause.
  // The earlier version combined 8 tag conditions in one query and appears
  // to have been silently timing out on the whole-state scan; this is much
  // lighter and should actually return results.
  try {
    const nameFilter = q ? `["name"~"${escapeRegex(q)}",i]` : `["name"]`;
    const cityQuery = `[out:json][timeout:30];
area["ISO3166-2"="${iso}"]["admin_level"="4"]->.a;
way["leisure"="park"]${nameFilter}(area.a);
out tags center 150;`.trim();
    const data = await runOverpassQuery(cityQuery);
    (data.elements || []).forEach((el) => {
      const name = el.tags && el.tags.name;
      const center = el.center;
      if (!name || !center) return;
      results.push({
        name, state: stateInput, kind: "City / Local Park",
        lat: center.lat, lon: center.lon,
        osm_description: el.tags.description || null,
        osm_url: `https://www.openstreetmap.org/?mlat=${center.lat}&mlon=${center.lon}#map=13/${center.lat}/${center.lon}`,
      });
    });
  } catch (err) {
    console.error("OSM city parks lookup failed:", err.message || err);
    // Not fatal — NPS results (if any) still get returned below.
  }

  const seen = new Map();
  results.forEach((p) => { if (!seen.has(p.name)) seen.set(p.name, p); });
  const parks = Array.from(seen.values()).slice(0, 200);

  if (parks.length === 0 && !process.env.NPS_API_KEY) {
    return res.json({ parks: [], cached: false, note: "No city parks matched, and national/state park coverage needs an NPS_API_KEY configured on the server to work." });
  }

  cache.set(cacheKey, { data: parks, expires: Date.now() + CACHE_TTL_MS });
  res.json({ parks, cached: false });
});

// Requires a free API key (https://www.nps.gov/subjects/developer/get-started.htm)
// set as the NPS_API_KEY environment variable on Render. Until that's set,
// this just reports itself unavailable so the app falls back to Wikipedia/OSM.
app.get("/api/park-info", async (req, res) => {
  const name = (req.query.name || "").trim();
  if (!process.env.NPS_API_KEY) {
    return res.json({ available: false, reason: "NPS_API_KEY not configured" });
  }
  if (!name) return res.status(400).json({ error: "Missing name" });

  try {
    const searchResp = await fetch(`https://developer.nps.gov/api/v1/parks?q=${encodeURIComponent(name)}&limit=1`, {
      headers: { "X-Api-Key": process.env.NPS_API_KEY },
    });
    if (!searchResp.ok) throw new Error(`NPS parks lookup returned ${searchResp.status}`);
    const searchData = await searchResp.json();
    const park = searchData.data && searchData.data[0];
    if (!park) return res.json({ available: false, reason: "No matching NPS unit" });

    let alerts = [];
    try {
      const alertResp = await fetch(`https://developer.nps.gov/api/v1/alerts?parkCode=${park.parkCode}`, {
        headers: { "X-Api-Key": process.env.NPS_API_KEY },
      });
      if (alertResp.ok) {
        const alertData = await alertResp.json();
        alerts = (alertData.data || []).map((a) => ({ title: a.title, description: a.description, category: a.category }));
      }
    } catch (alertErr) {
      console.error("NPS alerts lookup failed:", alertErr.message || alertErr);
    }

    res.json({
      available: true,
      description: park.description,
      url: park.url,
      alerts,
    });
  } catch (err) {
    console.error("NPS lookup failed:", err.message || err);
    res.json({ available: false, reason: "NPS API error" });
  }
});

// Official USFS trail data (National Forest System Trails layer) — gives a
// real trail number, surface type, managing forest, and hiker-access status
// for trails inside National Forests. Free, no key, no signup.
// National Forests, BLM lands, and wildlife refuges/wilderness areas —
// distinct from /api/parks (which covers NPS units and city/local parks).
// Kept to one simple query, same lesson learned from the earlier Parks bug:
// compound multi-clause Overpass queries over a whole state are prone to
// silently timing out.
app.get("/api/reccons", async (req, res) => {
  const stateInput = (req.query.state || "").trim();
  const q = (req.query.q || "").trim();
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];

  if (!iso) {
    return res.status(400).json({ error: "Unknown or missing state. Send a full state name (California) or two-letter code (CA)." });
  }

  const cacheKey = `reccons::${iso}::${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ areas: cached.data, cached: true });
  }

  const nameFilter = q ? `["name"~"${escapeRegex(q)}",i]` : `["name"]`;
  const query = `[out:json][timeout:30];
area["ISO3166-2"="${iso}"]["admin_level"="4"]->.a;
(
  way["boundary"="protected_area"]["operator"~"Forest Service|Bureau of Land Management",i]${nameFilter}(area.a);
  relation["boundary"="protected_area"]["operator"~"Forest Service|Bureau of Land Management",i]${nameFilter}(area.a);
  way["boundary"="national_park"]["operator"~"Forest Service",i]${nameFilter}(area.a);
  relation["boundary"="national_park"]["operator"~"Forest Service",i]${nameFilter}(area.a);
);
out tags center 150;`.trim();

  try {
    const data = await runOverpassQuery(query);
    const seen = new Map();
    (data.elements || []).forEach((el) => {
      const name = el.tags && el.tags.name;
      const center = el.center;
      if (!name || !center || seen.has(name)) return;
      const operator = el.tags.operator || "";
      seen.set(name, {
        name,
        state: stateInput,
        kind: /forest service/i.test(operator) ? "National Forest" : /bureau of land management/i.test(operator) ? "BLM Land" : "Conservation Area",
        lat: center.lat,
        lon: center.lon,
        osm_description: el.tags.description || null,
        osm_url: `https://www.openstreetmap.org/?mlat=${center.lat}&mlon=${center.lon}#map=12/${center.lat}/${center.lon}`,
      });
    });
    const areas = Array.from(seen.values()).slice(0, 150);
    cache.set(cacheKey, { data: areas, expires: Date.now() + CACHE_TTL_MS });
    res.json({ areas, cached: false });
  } catch (err) {
    console.error("Rec/conservation lookup failed:", err.message || err);
    res.status(502).json({ error: "Overpass is busy right now — try again in a minute." });
  }
});

app.get("/api/usfs-trail-info", async (req, res) => {
  const name = (req.query.name || "").trim();
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!name || Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.json({ available: false });
  }

  const buffer = 0.3; // degrees — generous enough to catch a whole trail's segments
  const envelope = `${lon - buffer},${lat - buffer},${lon + buffer},${lat + buffer}`;
  const safeName = name.replace(/'/g, "''").slice(0, 80);
  const where = `UPPER(trail_name) LIKE UPPER('%${safeName}%')`;
  const url = "https://apps.fs.usda.gov/ArcX/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query"
    + `?where=${encodeURIComponent(where)}&geometry=${envelope}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&f=json`;

  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) return res.json({ available: false });
    const data = await resp.json();
    const features = data.features || [];
    if (features.length === 0) return res.json({ available: false });

    const first = features[0].attributes;
    let totalMiles = 0;
    features.forEach((f) => { totalMiles += Number(f.attributes.gis_miles) || 0; });

    res.json({
      available: true,
      trailNumber: first.trail_no || null,
      trailType: first.trail_type || null,
      trailClass: first.trail_class || null,
      surface: first.trail_surface || null,
      managingOrg: first.admin_org || first.managing_org || null,
      hikerAllowed: first.hiker_pedestrian_managed === "YES" || first.hiker_pedestrian_managed === 1,
      miles: totalMiles > 0 ? Math.round(totalMiles * 10) / 10 : null,
    });
  } catch (err) {
    console.error("USFS trail lookup failed:", err.message || err);
    res.json({ available: false });
  }
});

// Official BLM trail data (National GTLF Trails layer). This layer actually
// has a state field (ADMIN_ST), so unlike USFS we can filter by state
// directly instead of needing a geometry envelope.
app.get("/api/blm-trail-info", async (req, res) => {
  const name = (req.query.name || "").trim();
  const stateInput = (req.query.state || "").trim();
  if (!name) return res.json({ available: false });

  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];
  const stateAbbr = iso ? iso.split("-")[1] : null;

  const safeName = name.replace(/'/g, "''").slice(0, 80);
  let where = `UPPER(ROUTE_PRMRY_NM) LIKE UPPER('%${safeName}%')`;
  if (stateAbbr) where += ` AND ADMIN_ST='${stateAbbr}'`;

  const url = "https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer/7/query"
    + `?where=${encodeURIComponent(where)}&outFields=*&f=json`;

  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) return res.json({ available: false });
    const data = await resp.json();
    const features = data.features || [];
    if (features.length === 0) return res.json({ available: false });

    const first = features[0].attributes;
    let totalMiles = 0;
    features.forEach((f) => { totalMiles += Number(f.attributes.GIS_MILES) || 0; });

    res.json({
      available: true,
      surface: first.OBSRVE_SRFCE_TYPE || null,
      allowedModes: first.PLAN_ALLOW_MODE_TRNSPRT || null,
      designation: first.ROUTE_SPCL_DSGNTN_TYPE || null,
      miles: totalMiles > 0 ? Math.round(totalMiles * 10) / 10 : null,
    });
  } catch (err) {
    console.error("BLM trail lookup failed:", err.message || err);
    res.json({ available: false });
  }
});

app.get("/api/elevation", async (req, res) => {
  const locations = (req.query.locations || "").trim(); // "lat,lon|lat,lon|..."
  if (!locations) return res.status(400).json({ error: "Missing locations" });
  const points = locations.split("|").map((p) => p.split(",").map(Number));

  // USGS's Elevation Point Query Service is official, free, no key, and far
  // more reliable than the community elevation APIs. It's one point per
  // request though, and firing 20 at once was likely triggering rate-limit
  // failures — a SINGLE failed point used to kill the whole batch (Promise.all).
  // Now we tolerate partial failures and space requests out a little.
  try {
    const settled = [];
    for (const [lat, lon] of points) {
      const url = `https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&units=Feet`;
      try {
        const resp = await fetch(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
        if (!resp.ok) {
          const bodyText = await resp.text().catch(() => "");
          throw new Error(`USGS EPQS returned ${resp.status}: ${bodyText.slice(0, 200)}`);
        }
        const data = await resp.json();
        const value = data && data.value;
        if (value === undefined || value === null || Number(value) < -100000 || Number.isNaN(Number(value))) {
          throw new Error(`no usable value in response: ${JSON.stringify(data).slice(0, 200)}`);
        }
        settled.push(Number(value));
      } catch (pointErr) {
        if (settled.filter((v) => v === null).length === 0) {
          // Log the first failure in full detail — later ones are probably the same cause.
          console.error(`USGS EPQS point (${lat},${lon}) failed:`, pointErr.message || pointErr);
        }
        settled.push(null); // keep the slot so the x-axis stays aligned; chart skips nulls
      }
    }
    const successCount = settled.filter((v) => v !== null).length;
    if (successCount >= Math.ceil(points.length * 0.5)) {
      return res.json({ elevations: settled, source: "usgs-epqs", units: "feet" });
    }
    console.error(`USGS EPQS: only ${successCount}/${points.length} points succeeded, falling back`);
  } catch (err) {
    console.error("USGS EPQS failed:", err.message || err);
  }

  // Fallback: Open-Topo-Data (covers non-US points too, if this app ever expands).
  try {
    const otdResp = await fetch(`https://api.opentopodata.org/v1/srtm90m?locations=${locations}`, {
      headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" },
    });
    if (otdResp.ok) {
      const otdData = await otdResp.json();
      if (otdData.results && otdData.results.some((r) => r.elevation !== null)) {
        const feet = otdData.results.map((r) => (r.elevation === null ? null : r.elevation * 3.28084));
        return res.json({ elevations: feet, source: "opentopodata", units: "feet" });
      }
    }
  } catch (err) {
    console.error("Open-Topo-Data failed:", err.message || err);
  }

  res.status(502).json({ error: "Elevation data isn't available right now — both providers failed to respond." });
});

// ---------------------------------------------------------------------------
// GET /api/weather?lat=&lon=
//
// 3-day forecast for the Weather button on the map-first prototype. Uses
// Open-Meteo (https://open-meteo.com) -- free, no key or signup required
// for non-commercial use, matching every other external API this app
// relies on.
// ---------------------------------------------------------------------------

// WMO weather codes, as returned by Open-Meteo's weather_code field.
// Table matches the official WMO code list Open-Meteo documents.
const WMO_WEATHER_CODES = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};
function describeWeatherCode(code) {
  return WMO_WEATHER_CODES[code] || "Unknown conditions";
}

app.get("/api/weather", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ error: "Missing or invalid lat/lon." });
  }

  // Rounded to ~1km precision -- weather doesn't meaningfully vary at
  // finer resolution than that, so small pans reuse the same cache entry.
  const cacheKey = `weather::${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto&forecast_days=3`;
    const resp = await fetch(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error(`Open-Meteo returned ${resp.status}: ${bodyText.slice(0, 200)}`);
    }
    const data = await resp.json();
    const daily = data.daily;
    if (!daily || !Array.isArray(daily.time)) throw new Error("Unexpected response shape from Open-Meteo");

    const days = daily.time.map((date, i) => ({
      date,
      high: Math.round(daily.temperature_2m_max[i]),
      low: Math.round(daily.temperature_2m_min[i]),
      description: describeWeatherCode(daily.weather_code[i]),
    }));

    const result = { days };
    cache.set(cacheKey, { data: result, expires: Date.now() + CACHE_TTL_MS });
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error("Weather lookup failed:", err.message || err);
    res.status(502).json({ error: "Couldn't load the weather forecast right now." });
  }
});

// ---------------------------------------------------------------------------
// TEMPORARY DIAGNOSTIC: GET /api/debug-overpass
//
// A day of complete, simultaneous failure across all three independent
// Overpass mirrors isn't consistent with a transient blip anymore -- this
// tests a few different requests directly from Render's own network so we
// can see exactly what's happening instead of guessing from the outside.
// Safe to delete once the underlying issue is understood.
// ---------------------------------------------------------------------------
app.get("/api/debug-overpass", async (_req, res) => {
  const results = {};

  // 1. General outbound internet sanity check -- totally unrelated to
  // Overpass. If this fails too, the problem is Render's egress in
  // general, not anything specific to Overpass's mirrors.
  try {
    const start = Date.now();
    const resp = await fetchWithTimeout("https://api.github.com", {}, 8000);
    results.generalInternet = { ok: resp.ok, status: resp.status, ms: Date.now() - start };
  } catch (err) {
    results.generalInternet = { ok: false, error: err.name === "AbortError" ? "timed out" : String(err.message || err) };
  }

  // 2. A lightweight GET to Overpass's own status endpoint (no POST, no
  // query body) -- if this succeeds while the POST-based queries fail,
  // that points at something specific to the POST request shape rather
  // than a full IP-level block.
  try {
    const start = Date.now();
    const resp = await fetchWithTimeout("https://overpass-api.de/api/status", {}, 8000);
    const text = await resp.text();
    results.overpassStatusGet = { ok: resp.ok, status: resp.status, ms: Date.now() - start, body: text.slice(0, 300) };
  } catch (err) {
    results.overpassStatusGet = { ok: false, error: err.name === "AbortError" ? "timed out" : String(err.message || err) };
  }

  // 3. The exact same POST request shape /api/map-pins actually uses,
  // against each configured mirror in turn, with full error detail.
  results.overpassMirrors = [];
  const tinyQuery = `[out:json][timeout:10];node(0,0,0.01,0.01);out;`;
  for (const url of OVERPASS_URLS) {
    const start = Date.now();
    try {
      const resp = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
          "Accept": "application/json, text/plain, */*",
        },
        body: tinyQuery,
      }, 10000);
      const text = await resp.text();
      results.overpassMirrors.push({ url, ok: resp.ok, status: resp.status, ms: Date.now() - start, body: text.slice(0, 200) });
    } catch (err) {
      results.overpassMirrors.push({ url, ok: false, ms: Date.now() - start, error: err.name === "AbortError" ? "timed out" : String(err.message || err), cause: err.cause ? String(err.cause) : null });
    }
  }

  results.overpassUrlEnvVarSet = Boolean(process.env.OVERPASS_URL);

  res.json(results);
});

// ---------------------------------------------------------------------------
// GET /api/map-pins?swLat=&swLon=&neLat=&neLon=
//
// Bounding-box endpoint for the map-first Discover redesign: given a Leaflet
// map's current viewport (map.getBounds()), returns trails + parks + rec/
// conservation areas that fall inside it.
//
// STEP 2 of the persistent region cache: the viewport is split into fixed
// 0.5deg grid cells. Cells that have ever been successfully queried before
// (by anyone) are served straight from MongoDB with zero Overpass calls.
// Only genuinely never-before-cached cells fall through to a live query,
// which is then itself cached for next time. This means an Overpass outage
// only affects brand-new areas -- anywhere already explored keeps working.
//
// IMPORTANT Overpass syntax note (this exact bug silently broke an earlier
// version of this endpoint): the geo-filter — (bbox) or (around:...) — MUST
// come immediately after the element type keyword, BEFORE any tag brackets.
//   way(bbox)["tag"]   -- correct
//   way["tag"](bbox)   -- WRONG, silently returns zero results, no error
// ---------------------------------------------------------------------------
const MAP_PINS_MAX_SPAN_DEG = 1.5;
// Deliberately tiny compared to /api/trails' own decimation (400pt cap) --
// this endpoint can return up to 200 trails per viewport at once, so each
// one only needs enough points for a rough on-demand elevation-gain
// estimate when a pin is tapped, not a full profile.
const MAX_POINTS_PER_TRAIL_MAPPINS = 30;

// Runs one Overpass query scoped to exactly the given bounds and returns
// the parsed { trails, parks, areas } for that area alone. Extracted out of
// the route handler so it can be called once per still-uncached grid cell,
// not just once per whole (arbitrary) viewport.
async function fetchMapPinsDataForBounds(swLat, swLon, neLat, neLon) {
  const bbox = `${swLat},${swLon},${neLat},${neLon}`;
  // Two separate query blocks, each with its own out statement. Overpass
  // QL only allows ONE geometry-modifier per out (geom OR center, never
  // both) — combining them into a single "out tags geom center;" silently
  // drops one, which is what caused trails to come back empty. Trails need
  // full path geometry to draw; parks/areas only need a point.
  const query = `[out:json][timeout:25];
(
  way(${bbox})["highway"~"^(path|footway)$"]["name"];
  relation(${bbox})["route"~"^(hiking|foot)$"]["name"];
);
out tags geom;
(
  way(${bbox})["leisure"="park"]["name"];
  way(${bbox})["boundary"="national_park"]["name"];
  relation(${bbox})["boundary"="national_park"]["name"];
  way(${bbox})["boundary"="protected_area"]["name"];
  relation(${bbox})["boundary"="protected_area"]["name"];
);
out tags center;`.trim();

  const data = await runOverpassQuery(query);
  const elements = data.elements || [];

  const trailsByName = new Map();
  const parks = [];
  const areas = [];
  const seenParkNames = new Set();
  const seenAreaNames = new Set();

  for (const el of elements) {
    const tags = el.tags || {};
    const name = tags.name;
    if (!name) continue;

    const isTrail = tags.highway === "path" || tags.highway === "footway" || /^(hiking|foot)$/.test(tags.route || "");
    const isPark = tags.leisure === "park";
    const isArea = tags.boundary === "national_park" || tags.boundary === "protected_area";

    if (isTrail) {
      let segs = [];
      if (el.type === "relation" && Array.isArray(el.members)) {
        el.members.forEach((m) => {
          if (m.geometry && m.geometry.length >= 2) segs.push(m.geometry.filter((p) => p));
        });
      } else if (el.geometry && el.geometry.length >= 2) {
        segs.push(el.geometry.filter((p) => p));
      }
      if (segs.length === 0) continue;
      const lenKm = segs.reduce((sum, seg) => sum + wayLengthKm(seg), 0);
      const firstPt = segs[0][0];
      const segCoordsList = segs.map((seg) => seg.map((p) => [p.lat, p.lon]));
      const existing = trailsByName.get(name);
      if (existing) {
        existing.distance_km = Math.round((existing.distance_km + lenKm) * 10) / 10;
        existing.segments += segs.length;
        existing.segmentsGeom.push(...segCoordsList);
      } else {
        trailsByName.set(name, {
          name,
          distance_km: Math.round(lenKm * 10) / 10,
          difficulty: difficultyFromTags(tags),
          lat: firstPt.lat,
          lon: firstPt.lon,
          segments: segs.length,
          segmentsGeom: segCoordsList,
        });
      }
    } else if (isPark) {
      if (seenParkNames.has(name)) continue;
      seenParkNames.add(name);
      const center = el.center || (el.geometry && el.geometry[0]);
      if (!center) continue;
      parks.push({ name, kind: "City / Local Park", lat: center.lat, lon: center.lon });
    } else if (isArea) {
      if (seenAreaNames.has(name)) continue;
      seenAreaNames.add(name);
      const center = el.center || (el.geometry && el.geometry[0]);
      if (!center) continue;
      areas.push({
        name,
        kind: tags.boundary === "national_park" ? "National Park" : "Protected Area",
        lat: center.lat,
        lon: center.lon,
      });
    }
  }

  const trails = Array.from(trailsByName.values()).map((t) => {
    const totalPoints = t.segmentsGeom.reduce((s, seg) => s + seg.length, 0);
    const perSegBudget = Math.max(2, Math.floor(MAX_POINTS_PER_TRAIL_MAPPINS / t.segmentsGeom.length));
    const geometry = totalPoints <= MAX_POINTS_PER_TRAIL_MAPPINS
      ? t.segmentsGeom
      : t.segmentsGeom.map((seg) => decimate(seg, perSegBudget));
    return {
      name: t.name,
      distance_km: t.distance_km,
      difficulty: t.difficulty,
      lat: t.lat,
      lon: t.lon,
      segments: t.segments,
      geometry,
    };
  });

  return { trails, parks, areas };
}

app.get("/api/map-pins", async (req, res) => {
  const swLat = parseFloat(req.query.swLat);
  const swLon = parseFloat(req.query.swLon);
  const neLat = parseFloat(req.query.neLat);
  const neLon = parseFloat(req.query.neLon);

  if ([swLat, swLon, neLat, neLon].some((v) => Number.isNaN(v))) {
    return res.status(400).json({ error: "Missing or invalid swLat, swLon, neLat, neLon query params." });
  }
  const latSpan = neLat - swLat;
  const lonSpan = neLon - swLon;
  if (latSpan <= 0 || lonSpan <= 0) {
    return res.status(400).json({ error: "Invalid bounding box — neLat/neLon must be greater than swLat/swLon." });
  }
  if (latSpan > MAP_PINS_MAX_SPAN_DEG || lonSpan > MAP_PINS_MAX_SPAN_DEG) {
    return res.status(400).json({ error: `Zoom in a bit — that area is too large to search at once (max ${MAP_PINS_MAX_SPAN_DEG}° span per side).` });
  }

  // Round the bbox to ~1km precision so small pans/zooms hit the same
  // fast-path in-memory cache entry instead of fragmenting it with
  // near-duplicate keys. This whole-viewport cache is checked first and is
  // separate from (and faster than) the per-cell persistent cache below.
  const round = (n) => Math.round(n * 100) / 100;
  const cacheKey = `mapPins::${round(swLat)},${round(swLon)},${round(neLat)},${round(neLon)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    // Split the requested viewport into fixed grid cells and check the
    // persistent cache for each one independently.
    const cellKeys = gridCellsForBounds(swLat, swLon, neLat, neLon);
    const cellLookups = await Promise.all(
      cellKeys.map(async (cellKey) => ({ cellKey, data: await getCachedRegion(cellKey) }))
    );

    const hitCells = cellLookups.filter((c) => c.data !== null);
    const missCells = cellLookups.filter((c) => c.data === null);

    // If ANY cell is a miss, fetch the whole requested viewport in exactly
    // ONE Overpass call -- the same request shape/volume as the original
    // pre-caching version of this endpoint -- rather than one call per
    // missing cell. Querying per-cell was the actual bug behind the
    // "Overpass is busy" / hang symptoms: even throttled, splitting one
    // viewport into up to 16 separate Overpass requests is far more volume
    // than the free public mirrors tolerate from one IP, and they start
    // failing or stalling as a block. This keeps Overpass call volume
    // identical to before caching existed, while still building up the
    // persistent cache for next time.
    let freshData = null;
    let liveOverpassFailed = false;
    if (missCells.length > 0) {
      try {
        freshData = await fetchMapPinsDataForBounds(swLat, swLon, neLat, neLon);
      } catch (liveErr) {
        // Overpass being unreachable shouldn't mean the map shows nothing
        // -- fall through and serve whatever's already cached for the
        // hit cells (if any). Only the miss cells stay empty for now.
        liveOverpassFailed = true;
        console.error("Live Overpass failed for map-pins; serving cache only:", liveErr.message || liveErr);
      }
    }

    if (freshData) {
      // Partition the single fresh response into each miss cell's own
      // slice (by each item's anchor lat/lon) and MERGE it into that
      // cell's cache (union by name, never removing existing items).
      // A real viewport is usually smaller than one 0.5deg grid cell, so
      // requiring a query to fully cover a cell before caching anything
      // would mean most cells never get cached at all. Instead each cell's
      // cached data grows more complete over time as different overlapping
      // viewports touch it -- purely additive, so there's no risk of ever
      // caching something wrong, only "not yet complete". The one thing
      // that DOES need full coverage to be safe is caching a cell as
      // confirmed EMPTY (finding nothing here) -- if this query only
      // reached a sliver of the cell, "found nothing" doesn't mean the
      // cell has nothing, so that case is left uncached rather than risk
      // permanently hiding a trail that's just outside today's viewport.
      const mergeByName = (existingList, newList) => {
        const byName = new Map((existingList || []).map((item) => [item.name, item]));
        newList.forEach((item) => { if (!byName.has(item.name)) byName.set(item.name, item); });
        return Array.from(byName.values());
      };
      await Promise.all(missCells.map(async ({ cellKey }) => {
        const bounds = boundsForGridCell(cellKey);
        const fullyCovered = bounds.swLat >= swLat && bounds.neLat <= neLat && bounds.swLon >= swLon && bounds.neLon <= neLon;
        const inCell = (lat, lon) => lat >= bounds.swLat && lat < bounds.neLat && lon >= bounds.swLon && lon < bounds.neLon;
        const newTrails = freshData.trails.filter((t) => inCell(t.lat, t.lon));
        const newParks = freshData.parks.filter((p) => inCell(p.lat, p.lon));
        const newAreas = freshData.areas.filter((a) => inCell(a.lat, a.lon));
        const foundSomething = newTrails.length > 0 || newParks.length > 0 || newAreas.length > 0;
        if (!foundSomething && !fullyCovered) return; // too soon to conclude this cell is empty
        const existing = (await getCachedRegion(cellKey)) || { trails: [], parks: [], areas: [] };
        await saveCachedRegion(cellKey, {
          trails: mergeByName(existing.trails, newTrails),
          parks: mergeByName(existing.parks, newParks),
          areas: mergeByName(existing.areas, newAreas),
        });
      }));
    }

    // Nothing cached for this viewport at all, AND the live fetch that was
    // supposed to fill that gap failed -- there's genuinely nothing to
    // show, so surface a real error instead of a silently empty map.
    if (hitCells.length === 0 && !freshData && liveOverpassFailed) {
      return res.status(502).json({ error: "Overpass is busy right now — please try again in a minute." });
    }

    // Merge strategy: dedupe by name, first-occurrence-wins. Cached hit
    // cells first, then the fresh whole-viewport data if the live fetch
    // succeeded (covers every miss cell for THIS response, even edge
    // cells that didn't get persisted above). If the live fetch failed,
    // freshData is null and this just serves whatever was already cached.
    const trailsByName = new Map();
    const parksByName = new Map();
    const areasByName = new Map();
    for (const { data } of hitCells) {
      (data.trails || []).forEach((t) => { if (!trailsByName.has(t.name)) trailsByName.set(t.name, t); });
      (data.parks || []).forEach((p) => { if (!parksByName.has(p.name)) parksByName.set(p.name, p); });
      (data.areas || []).forEach((a) => { if (!areasByName.has(a.name)) areasByName.set(a.name, a); });
    }
    if (freshData) {
      freshData.trails.forEach((t) => { if (!trailsByName.has(t.name)) trailsByName.set(t.name, t); });
      freshData.parks.forEach((p) => { if (!parksByName.has(p.name)) parksByName.set(p.name, p); });
      freshData.areas.forEach((a) => { if (!areasByName.has(a.name)) areasByName.set(a.name, a); });
    }

    // Large administrative boundary relations (e.g. a BLM field office
    // covering several counties) can report a centroid far outside the
    // searched viewport even when some sliver of the boundary technically
    // intersects it. A generous buffer keeps genuine edge cases (a park
    // that's mostly outside the box) while dropping pins that would show up
    // absurdly far from where the user is actually looking at the map.
    const PIN_BOUNDS_BUFFER_DEG = 0.5;
    const withinBufferedBounds = (lat, lon) =>
      lat >= swLat - PIN_BOUNDS_BUFFER_DEG && lat <= neLat + PIN_BOUNDS_BUFFER_DEG &&
      lon >= swLon - PIN_BOUNDS_BUFFER_DEG && lon <= neLon + PIN_BOUNDS_BUFFER_DEG;

    const trails = Array.from(trailsByName.values()).slice(0, 200);
    const filteredParks = Array.from(parksByName.values()).filter((p) => withinBufferedBounds(p.lat, p.lon)).slice(0, 100);
    const filteredAreas = Array.from(areasByName.values()).filter((a) => withinBufferedBounds(a.lat, a.lon)).slice(0, 100);

    // Merge in community-submitted trails whose saved point falls inside
    // this bounding box — a live query against the full requested viewport
    // (not per-cell; it's already fast, no need to cache it separately).
    try {
      const collection = await getCommunityTrailsCollection();
      if (collection) {
        const community = await collection.find({
          lat: { $gte: swLat, $lte: neLat },
          lon: { $gte: swLon, $lte: neLon },
        }).limit(50).toArray();
        community.forEach((c) => {
          if (trailsByName.has(c.name)) return;
          const rawGeom = Array.isArray(c.geometry) ? c.geometry : [];
          const totalPoints = rawGeom.reduce((s, seg) => s + (seg ? seg.length : 0), 0);
          const perSegBudget = rawGeom.length > 0 ? Math.max(2, Math.floor(MAX_POINTS_PER_TRAIL_MAPPINS / rawGeom.length)) : 2;
          const geometry = totalPoints <= MAX_POINTS_PER_TRAIL_MAPPINS || rawGeom.length === 0
            ? rawGeom
            : rawGeom.map((seg) => decimate(seg, perSegBudget));
          trails.push({
            name: c.name,
            distance_km: c.distance_km,
            difficulty: "Unknown",
            lat: c.lat,
            lon: c.lon,
            segments: rawGeom.length,
            geometry,
            community: true,
          });
        });
      }
    } catch (communityErr) {
      console.error("Community trails merge (map-pins) failed:", communityErr.message || communityErr);
    }

    const result = { trails, parks: filteredParks, areas: filteredAreas };
    if (liveOverpassFailed) {
      // Don't cache a degraded (cache-only, possibly incomplete) result as
      // if it were the definitive answer for this viewport -- the next
      // request for the same area should retry Overpass rather than reuse
      // this partial snapshot for a full 10 minutes.
      result.liveDataUnavailable = true;
      return res.json({ ...result, cached: false });
    }
    cache.set(cacheKey, { data: result, expires: Date.now() + CACHE_TTL_MS });
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error("Map-pins lookup failed:", err.message || err);
    res.status(502).json({ error: "Overpass is busy right now — try again in a minute." });
  }
});

// Lets a user submit a custom-created route (from Create or the trail
// editor) to the shared, searchable database — this is what makes routes
// like a homemade "Four Pass Loop" findable by other people via Discover,
// not just saved in your own browser.
app.post("/api/community-trails", async (req, res) => {
  const collection = await getCommunityTrailsCollection();
  if (!collection) {
    return res.status(503).json({ error: "The shared database isn't configured yet — MONGODB_URI needs to be set on the server." });
  }

  const { name, state, geometry, distance_km, notes, lat, lon } = req.body || {};
  if (!name || !state || !geometry || !Array.isArray(geometry) || geometry.length === 0) {
    return res.status(400).json({ error: "Missing name, state, or geometry." });
  }
  if (!STATE_ISO[state] && !STATE_ISO[state.toLowerCase()]) {
    return res.status(400).json({ error: "Unrecognized state — pick one from the list." });
  }

  try {
    await collection.insertOne({
      name: String(name).slice(0, 120),
      state,
      geometry,
      distance_km: Number(distance_km) || 0,
      notes: notes ? String(notes).slice(0, 500) : null,
      lat: Number(lat),
      lon: Number(lon),
      addedAt: new Date(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Community trail submission failed:", err.message || err);
    res.status(500).json({ error: "Couldn't save this to the shared database right now." });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Trailseeker running at http://localhost:${PORT}`);
});
