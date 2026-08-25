import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";
import { STATE_ISO, STATE_LIST } from "./states.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const OVERPASS_URLS = [
  process.env.OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
].filter(Boolean);

// Shared community-submitted trails —
// a real, persistent, shared database
// (MongoDB Atlas free tier), separate
// from each user's own browser storage.
// Only active once MONGODB_URI is set
// as an environment variable on Render;
// until then, community-trail features
// quietly no-op so nothing else breaks.
let mongoClientPromise = null;

function getMongoClient() {
  if (!process.env.MONGODB_URI) return null;
  if (!mongoClientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI);
    mongoClientPromise = client
      .connect()
      .then(() => client)
      .catch((err) => {
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

// ------------------------------------
// Persistent region cache (MongoDB) --
// fixed lat/lon grid so trail/park/
// protected-area data, once queried
// anywhere, never needs to hit Overpass
// again for that same area, by anyone.
// ------------------------------------

// Fixed lat/lon grid, \~0.5deg cells
// (roughly 35-55km depending on latitude).
const CACHE_GRID_SIZE_DEG = 0.5;

function gridCellsForBounds(swLat, swLon, neLat, neLon) {
  // A tiny epsilon on the upper bounds prevents a bbox edge that lands
  // exactly on a 0.5deg grid line from counting one extra "phantom" cell.
  const EPSILON = 1e-9;
  const minCellLat = Math.floor(swLat / CACHE_GRID_SIZE_DEG);
  const maxCellLat = Math.floor((neLat - EPSILON) / CACHE_GRID_SIZE_DEG);
  const minCellLon = Math.floor(swLon / CACHE_GRID_SIZE_DEG);
  const maxCellLon = Math.floor((neLon - EPSILON) / CACHE_GRID_SIZE_DEG);
  const cells = [];
  for (let latIdx = minCellLat; latIdx <= maxCellLat; latIdx++) {
    for (let lonIdx = minCellLon; lonIdx <= maxCellLon; lonIdx++) {
      cells.push(`\( {latIdx}_ \){lonIdx}`);
    }
  }
  return cells;
}

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
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
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

function difficultyFromTags(tags) {
  const sac = tags.sac_scale;
  if (!sac) return "Unknown";
  if (sac === "hiking") return "Easy";
  if (sac === "mountain_hiking") return "Moderate";
  if (
    sac === "demanding_mountain_hiking" ||
    sac === "alpine_hiking" ||
    sac === "demanding_alpine_hiking"
  )
    return "Strenuous";
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
    return res.status(400).json({
      error:
        "Unknown or missing state. Send a full state name (California) or two-letter code (CA).",
    });
  }
  const cacheKey =
    iso +
    "::" +
    q.toLowerCase() +
    "::" +
    near.toLowerCase() +
    "::" +
    (hasDirectPoint ? directLat + "," + directLon : "");
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ trails: cached.data, cached: true });
  }

  let centerPoint = hasDirectPoint ? { lat: directLat, lon: directLon } : null;
  if (near && !centerPoint) {
    try {
      const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
        `${near}, ${stateInput}, USA`
      )}`;
      const geoResp = await fetch(geoUrl, {
        headers: {
          "User-Agent":
            "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
        },
      });
      const geoData = await geoResp.json();
      if (geoData && geoData[0]) {
        centerPoint = {
          lat: parseFloat(geoData[0].lat),
          lon: parseFloat(geoData[0].lon),
        };
      }
    } catch (geoErr) {
      console.error("Geocoding failed:", geoErr);
    }
    if (!centerPoint) {
      return res.status(404).json({
        error: `Couldn't find "${near}" in ${stateInput}. Try a different spelling or nearby city.`,
      });
    }
  }

  const nameFilter = q
    ? `["name"\~"${escapeRegex(q)}",i]`
    : `["name"]`;
  const RADIUS_METERS = 24000; // \~15 miles around the searched city
  const overpassQuery = centerPoint
    ? `[out:json][timeout:25];
(
  way(around:\( {RADIUS_METERS}, \){centerPoint.lat},${centerPoint.lon})
["highway"\~"^(path|footway)\( "] \){nameFilter};
  relation(around:\( {RADIUS_METERS}, \){centerPoint.lat},${centerPoint.lon})
["route"\~"^(hiking|foot)\( "] \){nameFilter};
);
out tags geom;`.trim()
    : `[out:json][timeout:35];
area["ISO3166-2"="${iso}"]
["admin_level"="4"]->.a;
(
  way(area.a)
["highway"\~"^(path|footway)\( "] \){nameFilter};
  relation(area.a)
["route"\~"^(hiking|foot)\( "] \){nameFilter};
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
            "User-Agent":
              "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
            Accept: "application/json, text/plain, */*",
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
      return res.status(502).json({
        error:
          "All Overpass mirrors are busy right now — please try again in a minute.",
        detail: (lastError || "").slice(0, 500),
      });
    }

    const elements = data.elements || [];
    const byName = new Map();
    const superRelationsToResolve = [];

    for (const el of elements) {
      if (!el.tags?.name) continue;
      const name = el.tags.name;
      let segs = [];
      if (el.type === "relation" && Array.isArray(el.members)) {
        el.members.forEach((m) => {
          if (m.geometry && m.geometry.length >= 2)
            segs.push(m.geometry.filter((p) => p));
        });
      } else if (el.geometry && el.geometry.length >= 2) {
        segs.push(el.geometry.filter((p) => p));
      }
      if (segs.length === 0) {
        if (el.type === "relation" && q)
          superRelationsToResolve.push({ id: el.id, name });
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

    const toResolve = superRelationsToResolve
      .slice(0, 3)
      .filter(({ name }) => !byName.has(name));
    const resolved = await Promise.allSettled(
      toResolve.map(async ({ id, name }) => {
        const recurseQuery = `[out:json]
[timeout:25];relation(${id});
(._;>>;);out geom;`.trim();
        const recurseData = await runOverpassQuery(recurseQuery);
        const segCoordsList = (recurseData.elements || [])
          .filter((e) => e.type === "way" && e.geometry && e.geometry.length >= 2)
          .map((e) =>
            e.geometry.filter((p) => p).map((p) => [p.lat, p.lon])
          );
        if (segCoordsList.length === 0) throw new Error("no geometry resolved");
        const lenKm = segCoordsList.reduce(
          (sum, seg) =>
            sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))),
          0
        );
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
      else
        console.error(
          `Super-relation resolution failed for "${toResolve[i].name}":`,
          r.reason?.message || r.reason
        );
    });

    if (q) {
      try {
        const npsWhere = `UPPER(TRLNAME) LIKE UPPER('%${escapeRegex(q).replace(
          /'/g,
          "''"
        )}%') OR UPPER(TRLALTNAME) LIKE UPPER('%${escapeRegex(q).replace(
          /'/g,
          "''"
        )}%')`;
        const npsUrl =
          "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0/query" +
          `?where=${encodeURIComponent(
            npsWhere
          )}&outFields=TRLNAME,TRLALTNAME,TRLTYPE,TRLSURFACE,TRLCLASS,TRLUSE,UNITNAME&f=geojson`;
        const npsResp = await fetch(npsUrl, {
          headers: {
            "User-Agent":
              "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
          },
        });
        if (npsResp.ok) {
          const npsData = await npsResp.json();
          (npsData.features || []).forEach((f) => {
            const name = f.properties.TRLNAME || f.properties.TRLALTNAME;
            if (!name || byName.has(name)) return;
            const geom = f.geometry;
            if (!geom) return;
            const lines =
              geom.type === "MultiLineString"
                ? geom.coordinates
                : geom.type === "LineString"
                ? [geom.coordinates]
                : [];
            const segCoordsList = lines
              .map((line) => line.map(([lon, lat]) => [lat, lon]))
              .filter((seg) => seg.length >= 2);
            if (segCoordsList.length === 0) return;
            const lenKm = segCoordsList.reduce(
              (sum, seg) =>
                sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))),
              0
            );
            byName.set(name, {
              name,
              distance_km: lenKm,
              segments: segCoordsList.length,
              lat: segCoordsList[0][0][0],
              lon: segCoordsList[0][0][1],
              tags: {
                surface: f.properties.TRLSURFACE || null,
                description: f.properties.UNITNAME
                  ? `Official NPS trail in ${f.properties.UNITNAME}.`
                  : null,
              },
              segmentsGeom: segCoordsList,
            });
          });
        }
      } catch (npsErr) {
        console.error("NPS trails merge failed:", npsErr.message || npsErr);
      }

      try {
        const usgsWhere = `UPPER(NAME) LIKE UPPER('%${escapeRegex(q).replace(
          /'/g,
          "''"
        )}%')`;
        const usgsUrl =
          "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/11/query" +
          `?where=${encodeURIComponent(
            usgsWhere
          )}&outFields=NAME&inSR=4326&f=geojson`;
        const usgsResp = await fetch(usgsUrl, {
          headers: {
            "User-Agent":
              "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
          },
        });
        if (usgsResp.ok) {
          const usgsData = await usgsResp.json();
          (usgsData.features || []).forEach((f) => {
            const name = f.properties.NAME;
            if (!name || byName.has(name)) return;
            const geom = f.geometry;
            if (!geom) return;
            const lines =
              geom.type === "MultiLineString"
                ? geom.coordinates
                : geom.type === "LineString"
                ? [geom.coordinates]
                : [];
            const segCoordsList = lines
              .map((line) => line.map(([lon, lat]) => [lat, lon]))
              .filter((seg) => seg.length >= 2);
            if (segCoordsList.length === 0) return;
            const lenKm = segCoordsList.reduce(
              (sum, seg) =>
                sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))),
              0
            );
            byName.set(name, {
              name,
              distance_km: lenKm,
              segments: segCoordsList.length,
              lat: segCoordsList[0][0][0],
              lon: segCoordsList[0][0][1],
              tags: {
                surface: null,
                description:
                  "From USGS's National Trails dataset, aggregated from federal, state, and local sources.",
              },
              segmentsGeom: segCoordsList,
            });
          });
        }
      } catch (usgsErr) {
        console.error(
          "USGS National Trails merge failed:",
          usgsErr.message || usgsErr
        );
      }
    }

    const MAX_POINTS_PER_TRAIL = 400;
    const trails = Array.from(byName.values())
      .filter((t) => t.distance_km > 0.1)
      .map((t) => {
        const totalPoints = t.segmentsGeom.reduce((s, seg) => s + seg.length, 0);
        const perSegBudget = Math.max(
          2,
          Math.floor(MAX_POINTS_PER_TRAIL / t.segmentsGeom.length)
        );
        const geometry =
          totalPoints <= MAX_POINTS_PER_TRAIL
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
          osm_url: `https://www.openstreetmap.org/?mlat=\( {t.lat}&mlon= \){t.lon}#map=15/\( {t.lat}/ \){t.lon}`,
        };
      })
      .sort((a, b) => b.distance_km - a.distance_km)
      .slice(0, 150);

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
            osm_description:
              c.notes || "A custom route added by a Trailseeker user.",
            osm_url: null,
            community: true,
          });
        });
      }
    } catch (communityErr) {
      console.error(
        "Community trails merge failed:",
        communityErr.message || communityErr
      );
    }

    cache.set(cacheKey, { data: trails, expires: Date.now() + CACHE_TTL_MS });
    res.json({
      trails,
      cached: false,
      source: "OpenStreetMap (Overpass API)",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to fetch trail data",
      detail: String(err.message || err),
    });
  }
});

function parkKind(tags) {
  if (tags.boundary === "national_park" || tags.protection_title === "National Park")
    return "National Park";
  if (tags.boundary === "protected_area" || tags.leisure === "nature_reserve")
    return "State / Protected Park";
  if (tags.leisure === "park") return "City / Local Park";
  return "Park";
}

// Client-side fetch timeout. Overpass [timeout:N] only bounds server processing
// once a query starts — it does nothing if a mirror never responds.
const FETCH_TIMEOUT_MS = 25000;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runOverpassQuery(overpassQuery) {
  let lastError = null;
  for (const url of OVERPASS_URLS) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "User-Agent":
            "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
          Accept: "application/json, text/plain, */*",
        },
        body: overpassQuery,
      });
      if (!resp.ok) {
        lastError = await resp.text();
        console.error(
          "Overpass non-OK:",
          url,
          resp.status,
          String(lastError).slice(0, 200)
        );
        continue;
      }
      return await resp.json();
    } catch (innerErr) {
      console.error("Overpass mirror failed:", url, {
        name: innerErr?.name,
        message: innerErr?.message,
        cause: innerErr?.cause,
      });
      lastError =
        innerErr?.name === "AbortError"
          ? "Request timed out"
          : String(innerErr?.message || innerErr);
    }
  }
  throw new Error(lastError || "All Overpass mirrors failed");
    }app.get("/api/usa-trails", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q || q.length < 3) {
    return res.status(400).json({
      error: "Enter at least 3 characters of a trail name to search nationwide.",
    });
  }
  const cacheKey = `usa::${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ trails: cached.data, cached: true });
  }

  const nameFilter = `["name"\~"${escapeRegex(q)}",i]`;
  const query = `[out:json]
[timeout:60];
(
  relation["route"\~"^(hiking|foot)\( "] \){nameFilter};
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
          if (m.geometry && m.geometry.length >= 2)
            segs.push(m.geometry.filter((p) => p));
        });
      }
      if (segs.length === 0) {
        superRelationsToResolve.push({ id: el.id, name });
        continue;
      }
      const lenKm = segs.reduce((sum, seg) => sum + wayLengthKm(seg), 0);
      const segCoordsList = segs.map((seg) => seg.map((p) => [p.lat, p.lon]));
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

    for (const { id, name } of superRelationsToResolve) {
      if (byName.has(name)) continue;
      try {
        const recurseData = await runOverpassQuery(`[out:json]
[timeout:90];relation(${id});
(._;>>;);out geom;`);
        const segCoordsList = (recurseData.elements || [])
          .filter((e) => e.type === "way" && e.geometry && e.geometry.length >= 2)
          .map((e) =>
            e.geometry.filter((p) => p).map((p) => [p.lat, p.lon])
          );
        if (segCoordsList.length === 0) continue;
        const lenKm = segCoordsList.reduce(
          (sum, seg) =>
            sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))),
          0
        );
        byName.set(name, {
          name,
          distance_km: lenKm,
          segments: segCoordsList.length,
          lat: segCoordsList[0][0][0],
          lon: segCoordsList[0][0][1],
          tags: {},
          segmentsGeom: segCoordsList,
        });
      } catch (recurseErr) {
        console.error(
          `USA trail super-relation resolution failed for "${name}":`,
          recurseErr.message || recurseErr
        );
      }
    }

    try {
      const npsWhere = `UPPER(TRLNAME) LIKE UPPER('%${escapeRegex(q).replace(
        /'/g,
        "''"
      )}%') OR UPPER(TRLALTNAME) LIKE UPPER('%${escapeRegex(q).replace(
        /'/g,
        "''"
      )}%')`;
      const npsUrl =
        "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0/query" +
        `?where=${encodeURIComponent(
          npsWhere
        )}&outFields=TRLNAME,TRLALTNAME,TRLSURFACE,UNITNAME&f=geojson`;
      const npsResp = await fetch(npsUrl, {
        headers: {
          "User-Agent":
            "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
        },
      });
      if (npsResp.ok) {
        const npsData = await npsResp.json();
        (npsData.features || []).forEach((f) => {
          const name = f.properties.TRLNAME || f.properties.TRLALTNAME;
          if (!name || byName.has(name)) return;
          const geom = f.geometry;
          if (!geom) return;
          const lines =
            geom.type === "MultiLineString"
              ? geom.coordinates
              : geom.type === "LineString"
              ? [geom.coordinates]
              : [];
          const segCoordsList = lines
            .map((line) => line.map(([lon, lat]) => [lat, lon]))
            .filter((seg) => seg.length >= 2);
          if (segCoordsList.length === 0) return;
          const lenKm = segCoordsList.reduce(
            (sum, seg) =>
              sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))),
            0
          );
          byName.set(name, {
            name,
            distance_km: lenKm,
            segments: segCoordsList.length,
            lat: segCoordsList[0][0][0],
            lon: segCoordsList[0][0][1],
            tags: {
              surface: f.properties.TRLSURFACE || null,
              description: f.properties.UNITNAME
                ? `Official NPS trail in ${f.properties.UNITNAME}.`
                : null,
            },
            segmentsGeom: segCoordsList,
          });
        });
      }
    } catch (npsErr) {
      console.error("NPS nationwide merge failed:", npsErr.message || npsErr);
    }

    try {
      const usgsWhere = `UPPER(NAME) LIKE UPPER('%${escapeRegex(q).replace(
        /'/g,
        "''"
      )}%')`;
      const usgsUrl =
        "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/11/query" +
        `?where=${encodeURIComponent(
          usgsWhere
        )}&outFields=NAME&inSR=4326&f=geojson`;
      const usgsResp = await fetch(usgsUrl, {
        headers: {
          "User-Agent":
            "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
        },
      });
      if (usgsResp.ok) {
        const usgsData = await usgsResp.json();
        (usgsData.features || []).forEach((f) => {
          const name = f.properties.NAME;
          if (!name || byName.has(name)) return;
          const geom = f.geometry;
          if (!geom) return;
          const lines =
            geom.type === "MultiLineString"
              ? geom.coordinates
              : geom.type === "LineString"
              ? [geom.coordinates]
              : [];
          const segCoordsList = lines
            .map((line) => line.map(([lon, lat]) => [lat, lon]))
            .filter((seg) => seg.length >= 2);
          if (segCoordsList.length === 0) return;
          const lenKm = segCoordsList.reduce(
            (sum, seg) =>
              sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))),
            0
          );
          byName.set(name, {
            name,
            distance_km: lenKm,
            segments: segCoordsList.length,
            lat: segCoordsList[0][0][0],
            lon: segCoordsList[0][0][1],
            tags: {
              surface: null,
              description:
                "From USGS's National Trails dataset, aggregated from federal, state, and local sources.",
            },
            segmentsGeom: segCoordsList,
          });
        });
      }
    } catch (usgsErr) {
      console.error("USGS nationwide merge failed:", usgsErr.message || usgsErr);
    }

    const MAX_POINTS_PER_TRAIL = 600;
    const trails = Array.from(byName.values())
      .filter((t) => t.distance_km > 0.5)
      .map((t) => {
        const totalPoints = t.segmentsGeom.reduce((s, seg) => s + seg.length, 0);
        const perSegBudget = Math.max(
          2,
          Math.floor(MAX_POINTS_PER_TRAIL / t.segmentsGeom.length)
        );
        const geometry =
          totalPoints <= MAX_POINTS_PER_TRAIL
            ? t.segmentsGeom
            : t.segmentsGeom.map((seg) => decimate(seg, perSegBudget));
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
          osm_url: `https://www.openstreetmap.org/?mlat=\( {t.lat}&mlon= \){t.lon}#map=6/\( {t.lat}/ \){t.lon}`,
        };
      })
      .sort((a, b) => b.distance_km - a.distance_km)
      .slice(0, 20);

    try {
      const collection = await getCommunityTrailsCollection();
      if (collection) {
        const community = await collection
          .find({ name: { $regex: escapeRegex(q), $options: "i" } })
          .limit(20)
          .toArray();
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
            osm_description:
              c.notes || "A custom route added by a Trailseeker user.",
            osm_url: null,
            community: true,
          });
        });
      }
    } catch (communityErr) {
      console.error(
        "Community trails merge (usa) failed:",
        communityErr.message || communityErr
      );
    }

    cache.set(cacheKey, { data: trails, expires: Date.now() + CACHE_TTL_MS });
    res.json({ trails, cached: false });
  } catch (err) {
    console.error("USA trails lookup failed:", err.message || err);
    res
      .status(502)
      .json({ error: "Overpass is busy right now — try again in a minute." });
  }
});

app.get("/api/parks", async (req, res) => {
  const stateInput = (req.query.state || "").trim();
  const q = (req.query.q || "").trim();
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];
  if (!iso) {
    return res.status(400).json({
      error:
        "Unknown or missing state. Send a full state name (California) or two-letter code (CA).",
    });
  }
  const cacheKey = `parks::\( {iso}:: \){q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ parks: cached.data, cached: true });
  }

  const nameFilter = q
    ? `["name"\~"${escapeRegex(q)}",i]`
    : `["name"]`;
  const cityQuery = `[out:json][timeout:25];
area["ISO3166-2"="${iso}"]->.searchArea;
(
  way["leisure"="park"]${nameFilter}(area.searchArea);
  relation["leisure"="park"]${nameFilter}(area.searchArea);
  way["boundary"="national_park"]${nameFilter}(area.searchArea);
  relation["boundary"="national_park"]${nameFilter}(area.searchArea);
  way["boundary"="protected_area"]${nameFilter}(area.searchArea);
  relation["boundary"="protected_area"]${nameFilter}(area.searchArea);
);
out center tags;`.trim();

  try {
    const data = await runOverpassQuery(cityQuery);
    const parks = (data.elements || [])
      .filter((el) => el.tags?.name && (el.center || el.lat))
      .map((el) => ({
        name: el.tags.name,
        lat: el.center ? el.center.lat : el.lat,
        lon: el.center ? el.center.lon : el.lon,
        type: el.tags.boundary || el.tags.leisure || "park",
        osm_id: el.id,
      }))
      .slice(0, 40);

    cache.set(cacheKey, { data: parks, expires: Date.now() + CACHE_TTL_MS });
    res.json({ parks, cached: false });
  } catch (err) {
    console.error("Parks lookup failed:", err.message || err);
    res
      .status(502)
      .json({ error: "Overpass is busy right now — try again in a minute." });
  }
});

app.get("/api/park-info", async (req, res) => {
  const name = (req.query.name || "").trim();
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!name || Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.json({ available: false });
  }
  try {
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      name
    )}`;
    const wikiResp = await fetch(wikiUrl, {
      headers: {
        "User-Agent":
          "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
      },
    });
    if (!wikiResp.ok) return res.json({ available: false });
    const wiki = await wikiResp.json();
    res.json({
      available: true,
      extract: wiki.extract || null,
      thumbnail: wiki.thumbnail?.source || null,
      url: wiki.content_urls?.desktop?.page || null,
    });
  } catch (err) {
    console.error("Park info failed:", err.message || err);
    res.json({ available: false });
  }
});

app.get("/api/reccons", async (req, res) => {
  const stateInput = (req.query.state || "").trim();
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];
  if (!iso) {
    return res.status(400).json({ error: "Unknown or missing state." });
  }
  const cacheKey = `reccons::${iso}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ areas: cached.data, cached: true });
  }
  const query = `[out:json][timeout:25];
area["ISO3166-2"="${iso}"]->.searchArea;
(
  relation["boundary"="protected_area"]["protect_class"\~"^(1|2|3|4|5|6)$"](area.searchArea);
  way["boundary"="protected_area"]["protect_class"\~"^(1|2|3|4|5|6)$"](area.searchArea);
);
out center tags;`.trim();
  try {
    const data = await runOverpassQuery(query);
    const areas = (data.elements || [])
      .filter((el) => el.tags?.name && (el.center || el.lat))
      .map((el) => ({
        name: el.tags.name,
        lat: el.center ? el.center.lat : el.lat,
        lon: el.center ? el.center.lon : el.lon,
        protect_class: el.tags.protect_class || null,
        osm_id: el.id,
      }))
      .slice(0, 50);
    cache.set(cacheKey, { data: areas, expires: Date.now() + CACHE_TTL_MS });
    res.json({ areas, cached: false });
  } catch (err) {
    console.error("Rec areas lookup failed:", err.message || err);
    res
      .status(502)
      .json({ error: "Overpass is busy right now — try again in a minute." });
  }
});

app.get("/api/usfs-trail-info", async (req, res) => {
  const name = (req.query.name || "").trim();
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!name || Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.json({ available: false });
  }
  const buffer = 0.3;
  const envelope = `\( {lon - buffer}, \){lat - buffer},\( {lon + buffer}, \){lat + buffer}`;
  const safeName = name.replace(/'/g, "''").slice(0, 80);
  const where = `UPPER(trail_name) LIKE UPPER('%${safeName}%')`;
  const url =
    "https://apps.fs.usda.gov/ArcX/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query" +
    `?where=${encodeURIComponent(
      where
    )}&geometry=${envelope}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&f=json`;
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
      },
    });
    if (!resp.ok) return res.json({ available: false });
    const data = await resp.json();
    const features = data.features || [];
    if (features.length === 0) return res.json({ available: false });
    const first = features[0].attributes;
    let totalMiles = 0;
    features.forEach((f) => {
      totalMiles += Number(f.attributes.gis_miles) || 0;
    });
    res.json({
      available: true,
      trailNumber: first.trail_no || null,
      trailType: first.trail_type || null,
      trailClass: first.trail_class || null,
      surface: first.trail_surface || null,
      managingOrg: first.admin_org || first.managing_org || null,
      hikerAllowed:
        first.hiker_pedestrian_managed === "YES" ||
        first.hiker_pedestrian_managed === 1,
      miles: totalMiles > 0 ? Math.round(totalMiles * 10) / 10 : null,
    });
  } catch (err) {
    console.error("USFS trail lookup failed:", err.message || err);
    res.json({ available: false });
  }
});

app.get("/api/blm-trail-info", async (req, res) => {
  const name = (req.query.name || "").trim();
  const stateInput = (req.query.state || "").trim();
  if (!name) return res.json({ available: false });
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];
  const stateAbbr = iso ? iso.split("-")[1] : null;
  const safeName = name.replace(/'/g, "''").slice(0, 80);
  let where = `UPPER(ROUTE_PRMRY_NM) LIKE UPPER('%${safeName}%')`;
  if (stateAbbr) where += ` AND ADMIN_ST='${stateAbbr}'`;
  const url =
    "https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer/7/query" +
    `?where=${encodeURIComponent(where)}&outFields=*&f=json`;
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
      },
    });
    if (!resp.ok) return res.json({ available: false });
    const data = await resp.json();
    const features = data.features || [];
    if (features.length === 0) return res.json({ available: false });
    const first = features[0].attributes;
    res.json({
      available: true,
      routeName: first.ROUTE_PRMRY_NM || null,
      routeType: first.ROUTE_TYPE || null,
      adminState: first.ADMIN_ST || null,
      managingOffice: first.ADMIN_ORGN_NM || null,
    });
  } catch (err) {
    console.error("BLM trail lookup failed:", err.message || err);
    res.json({ available: false });
  }
});
app.get("/api/elevation", async (req, res) => {
  const locations = (req.query.locations || "").trim();
  if (!locations) return res.status(400).json({ error: "Missing locations" });
  const points = locations.split("|").map((p) => p.split(",").map(Number));

  try {
    const settled = [];
    for (const [lat, lon] of points) {
      const url = `https://epqs.nationalmap.gov/v1/json?x=\( {lon}&y= \){lat}&units=Feet`;
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent":
              "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
          },
        });
        if (!resp.ok) {
          const bodyText = await resp.text().catch(() => "");
          throw new Error(
            `USGS EPQS returned ${resp.status}: ${bodyText.slice(0, 200)}`
          );
        }
        const data = await resp.json();
        const value = data && data.value;
        if (
          value === undefined ||
          value === null ||
          Number(value) < -100000 ||
          Number.isNaN(Number(value))
        ) {
          throw new Error(
            `no usable value in response: ${JSON.stringify(data).slice(0, 200)}`
          );
        }
        settled.push(Number(value));
      } catch (pointErr) {
        if (settled.filter((v) => v === null).length === 0) {
          console.error(
            `USGS EPQS point (\( {lat}, \){lon}) failed:`,
            pointErr.message || pointErr
          );
        }
        settled.push(null);
      }
    }
    const successCount = settled.filter((v) => v !== null).length;
    if (successCount >= Math.ceil(points.length * 0.5)) {
      return res.json({ elevations: settled, source: "usgs-epqs", units: "feet" });
    }
    console.error(
      `USGS EPQS: only \( {successCount}/ \){points.length} points succeeded, falling back`
    );
  } catch (err) {
    console.error("USGS EPQS failed:", err.message || err);
  }

  try {
    const otdResp = await fetch(
      `https://api.opentopodata.org/v1/srtm90m?locations=${locations}`,
      {
        headers: {
          "User-Agent":
            "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
        },
      }
    );
    if (otdResp.ok) {
      const otdData = await otdResp.json();
      if (otdData.results && otdData.results.some((r) => r.elevation !== null)) {
        const feet = otdData.results.map((r) =>
          r.elevation === null ? null : r.elevation * 3.28084
        );
        return res.json({
          elevations: feet,
          source: "opentopodata",
          units: "feet",
        });
      }
    }
  } catch (err) {
    console.error("Open-Topo-Data failed:", err.message || err);
  }

  res.status(502).json({
    error:
      "Elevation data isn't available right now — both providers failed to respond.",
  });
});

const WMO_WEATHER_CODES = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
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
  const cacheKey = `weather::\( {lat.toFixed(2)}, \){lon.toFixed(2)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ ...cached.data, cached: true });
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=\( {lat}&longitude= \){lon}&daily=weather_code,temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto&forecast_days=3`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
      },
    });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error(
        `Open-Meteo returned ${resp.status}: ${bodyText.slice(0, 200)}`
      );
    }
    const data = await resp.json();
    const daily = data.daily;
    if (!daily || !Array.isArray(daily.time))
      throw new Error("Unexpected response shape from Open-Meteo");
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
    res
      .status(502)
      .json({ error: "Couldn't load the weather forecast right now." });
  }
});

// ------------------------------------
// GET /api/map-pins?swLat=&swLon=&neLat=&neLon=
// ------------------------------------
const MAP_PINS_MAX_SPAN_DEG = 1.5;
const MAX_POINTS_PER_TRAIL_MAPPINS = 30;

async function fetchMapPinsDataForBounds(swLat, swLon, neLat, neLon) {
  const bbox = `\( {swLat}, \){swLon},\( {neLat}, \){neLon}`;
  // Geo-filter MUST come immediately after the element type, BEFORE tag brackets.
  // Two separate out blocks: trails need geom, parks/areas need center.
  const query = `[out:json]
[timeout:25];
(
  way(${bbox})
["highway"\~"^(path|footway)$"]["name"];
  relation(${bbox})
["route"\~"^(hiking|foot)$"]["name"];
);
out tags geom;
(
  way(${bbox})["leisure"="park"]
["name"];
  way(${bbox})
["boundary"="national_park"]["name"];
  relation(${bbox})
["boundary"="national_park"]["name"];
  way(${bbox})
["boundary"="protected_area"]["name"];
  relation(${bbox})
["boundary"="protected_area"]["name"];
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

    const isTrail =
      tags.highway === "path" ||
      tags.highway === "footway" ||
      /^(hiking|foot)$/.test(tags.route || "");
    const isPark = tags.leisure === "park";
    const isArea =
      tags.boundary === "national_park" || tags.boundary === "protected_area";

    if (isTrail) {
      let segs = [];
      if (el.type === "relation" && Array.isArray(el.members)) {
        el.members.forEach((m) => {
          if (m.geometry && m.geometry.length >= 2)
            segs.push(m.geometry.filter((p) => p));
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
        existing.distance_km =
          Math.round((existing.distance_km + lenKm) * 10) / 10;
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
      parks.push({
        name,
        kind: "City / Local Park",
        lat: center.lat,
        lon: center.lon,
      });
    } else if (isArea) {
      if (seenAreaNames.has(name)) continue;
      seenAreaNames.add(name);
      const center = el.center || (el.geometry && el.geometry[0]);
      if (!center) continue;
      areas.push({
        name,
        kind:
          tags.boundary === "national_park" ? "National Park" : "Protected Area",
        lat: center.lat,
        lon: center.lon,
      });
    }
  }

  const trails = Array.from(trailsByName.values()).map((t) => {
    const totalPoints = t.segmentsGeom.reduce((s, seg) => s + seg.length, 0);
    const perSegBudget = Math.max(
      2,
      Math.floor(MAX_POINTS_PER_TRAIL_MAPPINS / t.segmentsGeom.length)
    );
    const geometry =
      totalPoints <= MAX_POINTS_PER_TRAIL_MAPPINS
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
    return res.status(400).json({
      error: "Missing or invalid swLat, swLon, neLat, neLon query params.",
    });
  }
  const latSpan = neLat - swLat;
  const lonSpan = neLon - swLon;
  if (latSpan <= 0 || lonSpan <= 0) {
    return res.status(400).json({
      error:
        "Invalid bounding box — neLat/neLon must be greater than swLat/swLon.",
    });
  }
  if (latSpan > MAP_PINS_MAX_SPAN_DEG || lonSpan > MAP_PINS_MAX_SPAN_DEG) {
    return res.status(400).json({
      error: `Zoom in a bit — that area is too large to search at once (max ${MAP_PINS_MAX_SPAN_DEG}° span per side).`,
    });
  }

  const round = (n) => Math.round(n * 100) / 100;
  const cacheKey = `mapPins::\( {round(swLat)}, \){round(swLon)},${round(
    neLat
  )},${round(neLon)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    const cellKeys = gridCellsForBounds(swLat, swLon, neLat, neLon);
    const cellLookups = await Promise.all(
      cellKeys.map(async (cellKey) => ({
        cellKey,
        data: await getCachedRegion(cellKey),
      }))
    );
    const hitCells = cellLookups.filter((c) => c.data !== null);
    const missCells = cellLookups.filter((c) => c.data === null);

    // ONE Overpass call for the whole viewport when any cell is a miss
    // (not one call per cell — that hammered public mirrors).
    let freshData = null;
    if (missCells.length > 0) {
      try {
        freshData = await fetchMapPinsDataForBounds(swLat, swLon, neLat, neLon);

        const mergeByName = (existingList, newList) => {
          const byName = new Map(
            (existingList || []).map((item) => [item.name, item])
          );
          newList.forEach((item) => {
            if (!byName.has(item.name)) byName.set(item.name, item);
          });
          return Array.from(byName.values());
        };

        await Promise.all(
          missCells.map(async ({ cellKey }) => {
            const bounds = boundsForGridCell(cellKey);
            const fullyCovered =
              bounds.swLat >= swLat &&
              bounds.neLat <= neLat &&
              bounds.swLon >= swLon &&
              bounds.neLon <= neLon;
            const inCell = (lat, lon) =>
              lat >= bounds.swLat &&
              lat < bounds.neLat &&
              lon >= bounds.swLon &&
              lon < bounds.neLon;

            const newTrails = freshData.trails.filter((t) =>
              inCell(t.lat, t.lon)
            );
            const newParks = freshData.parks.filter((p) =>
              inCell(p.lat, p.lon)
            );
            const newAreas = freshData.areas.filter((a) =>
              inCell(a.lat, a.lon)
            );
            const foundSomething =
              newTrails.length > 0 ||
              newParks.length > 0 ||
              newAreas.length > 0;
            if (!foundSomething && !fullyCovered) return;

            const existing = (await getCachedRegion(cellKey)) || {
              trails: [],
              parks: [],
              areas: [],
            };
            await saveCachedRegion(cellKey, {
              trails: mergeByName(existing.trails, newTrails),
              parks: mergeByName(existing.parks, newParks),
              areas: mergeByName(existing.areas, newAreas),
            });
          })
        );
      } catch (overpassErr) {
        console.error(
          "Live Overpass failed for map-pins; serving cache only:",
          overpassErr.message || overpassErr
        );
        // Only hard-fail if we have nothing cached to show
        if (hitCells.length === 0) {
          throw overpassErr;
        }
      }
    }

    const trailsByName = new Map();
    const parksByName = new Map();
    const areasByName = new Map();

    for (const { data } of hitCells) {
      (data.trails || []).forEach((t) => {
        if (!trailsByName.has(t.name)) trailsByName.set(t.name, t);
      });
      (data.parks || []).forEach((p) => {
        if (!parksByName.has(p.name)) parksByName.set(p.name, p);
      });
      (data.areas || []).forEach((a) => {
        if (!areasByName.has(a.name)) areasByName.set(a.name, a);
      });
    }
    if (freshData) {
      freshData.trails.forEach((t) => {
        if (!trailsByName.has(t.name)) trailsByName.set(t.name, t);
      });
      freshData.parks.forEach((p) => {
        if (!parksByName.has(p.name)) parksByName.set(p.name, p);
      });
      freshData.areas.forEach((a) => {
        if (!areasByName.has(a.name)) areasByName.set(a.name, a);
      });
    }

    const PIN_BOUNDS_BUFFER_DEG = 0.5;
    const withinBufferedBounds = (lat, lon) =>
      lat >= swLat - PIN_BOUNDS_BUFFER_DEG &&
      lat <= neLat + PIN_BOUNDS_BUFFER_DEG &&
      lon >= swLon - PIN_BOUNDS_BUFFER_DEG &&
      lon <= neLon + PIN_BOUNDS_BUFFER_DEG;

    const trails = Array.from(trailsByName.values()).slice(0, 200);
    const filteredParks = Array.from(parksByName.values())
      .filter((p) => withinBufferedBounds(p.lat, p.lon))
      .slice(0, 100);
    const filteredAreas = Array.from(areasByName.values())
      .filter((a) => withinBufferedBounds(a.lat, a.lon))
      .slice(0, 100);

    try {
      const collection = await getCommunityTrailsCollection();
      if (collection) {
        const community = await collection
          .find({
            lat: { $gte: swLat, $lte: neLat },
            lon: { $gte: swLon, $lte: neLon },
          })
          .limit(50)
          .toArray();
        community.forEach((c) => {
          if (trailsByName.has(c.name)) return;
          const rawGeom = Array.isArray(c.geometry) ? c.geometry : [];
          const totalPoints = rawGeom.reduce(
            (s, seg) => s + (seg ? seg.length : 0),
            0
          );
          const perSegBudget =
            rawGeom.length > 0
              ? Math.max(
                  2,
                  Math.floor(MAX_POINTS_PER_TRAIL_MAPPINS / rawGeom.length)
                )
              : 2;
          const geometry =
            totalPoints <= MAX_POINTS_PER_TRAIL_MAPPINS || rawGeom.length === 0
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
      console.error(
        "Community trails merge (map-pins) failed:",
        communityErr.message || communityErr
      );
    }

    const result = {
      trails,
      parks: filteredParks,
      areas: filteredAreas,
    };
    cache.set(cacheKey, { data: result, expires: Date.now() + CACHE_TTL_MS });
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error("Map-pins lookup failed:", err.message || err);
    res
      .status(502)
      .json({ error: "Overpass is busy right now — try again in a minute." });
  }
});

app.post("/api/community-trails", async (req, res) => {
  const collection = await getCommunityTrailsCollection();
  if (!collection) {
    return res.status(503).json({
      error:
        "The shared database isn't configured yet — MONGODB_URI needs to be set on the server.",
    });
  }
  const { name, state, geometry, distance_km, notes, lat, lon } = req.body || {};
  if (!name || !state || !geometry || !Array.isArray(geometry) || geometry.length === 0) {
    return res
      .status(400)
      .json({ error: "Missing name, state, or geometry." });
  }
  if (!STATE_ISO[state] && !STATE_ISO[state.toLowerCase()]) {
    return res
      .status(400)
      .json({ error: "Unrecognized state — pick one from the list." });
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
    res
      .status(500)
      .json({ error: "Couldn't save this to the shared database right now." });
  }
});

app.use(express.static(path.join(__dirname, "public")));

// Startup diagnostics
if (!process.env.MONGODB_URI) {
  console.warn(
    "MONGODB_URI not set — region cache and community trails disabled"
  );
} else {
  getMongoClient()
    .then(() => console.log("MongoDB connected"))
    .catch((e) =>
      console.error("MongoDB startup connect failed:", e.message || e)
    );
}

app.listen(PORT, () => {
  console.log(`Trailseeker running at http://localhost:${PORT}`);
});
