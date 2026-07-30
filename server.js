import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { STATE_ISO, STATE_LIST } from "./states.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const OVERPASS_URLS = [
  process.env.OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
].filter(Boolean);

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
  const sac = tags && tags.sac_scale;
  if (!sac) return "Unknown";
  if (sac === "hiking") return "Easy";
  if (sac === "mountain_hiking") return "Moderate";
  if (sac === "demanding_mountain_hiking" || sac === "alpine_hiking" || sac === "demanding_alpine_hiking") return "Strenuous";
  return "Unknown";
}

function normalizeTrailName(name) {
  return (name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function esriPathsToSegments(geometry) {
  if (!geometry || !geometry.paths) return [];
  return geometry.paths
    .filter((path) => path && path.length >= 2)
    .map((path) => path.map(([lon, lat]) => [lat, lon]));
}

function segmentsLengthKm(segments) {
  let d = 0;
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      d += haversineKm(seg[i - 1][1], seg[i - 1][0], seg[i][1], seg[i][0]);
    }
  }
  return d;
}

function trailsFromOverpass(elements, stateInput) {
  const byName = new Map();

  for (const el of elements) {
    if (!el.tags || !el.tags.name) continue;
    const name = el.tags.name;
    let segmentsGeom = [];

    if (el.type === "way" && el.geometry && el.geometry.length >= 2) {
      segmentsGeom = [el.geometry.filter((p) => p).map((p) => [p.lat, p.lon])];
    } else if (el.type === "relation") {
      const members = el.members || [];
      for (const m of members) {
        if (m.type === "way" && m.geometry && m.geometry.length >= 2) {
          segmentsGeom.push(m.geometry.filter((p) => p).map((p) => [p.lat, p.lon]));
        }
      }
      if (segmentsGeom.length === 0 && el.geometry && el.geometry.length >= 2) {
        segmentsGeom = [el.geometry.filter((p) => p).map((p) => [p.lat, p.lon])];
      }
    } else if (el.geometry && el.geometry.length >= 2) {
      segmentsGeom = [el.geometry.filter((p) => p).map((p) => [p.lat, p.lon])];
    }

    if (segmentsGeom.length === 0) continue;

    let lenKm = 0;
    for (const seg of segmentsGeom) {
      for (let i = 1; i < seg.length; i++) {
        lenKm += haversineKm(seg[i - 1][1], seg[i - 1][0], seg[i][1], seg[i][0]);
      }
    }

    const key = normalizeTrailName(name);
    const existing = byName.get(key);
    if (existing) {
      existing.distance_km += lenKm;
      existing.segments += segmentsGeom.length;
      existing.segmentsGeom.push(...segmentsGeom);
    } else {
      const first = segmentsGeom[0][0];
      byName.set(key, {
        name,
        distance_km: lenKm,
        segments: segmentsGeom.length,
        lat: first[0],
        lon: first[1],
        tags: el.tags,
        segmentsGeom,
      });
    }
  }

  const MAX_POINTS_PER_TRAIL = 400;
  return Array.from(byName.values())
    .filter((t) => t.distance_km > 0.1)
    .map((t) => {
      const totalPoints = t.segmentsGeom.reduce((s, seg) => s + seg.length, 0);
      const perSegBudget = Math.max(2, Math.floor(MAX_POINTS_PER_TRAIL / Math.max(1, t.segmentsGeom.length)));
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
        source: "OpenStreetMap",
      };
    });
}

async function fetchUsfsTrails({ q, centerPoint, stateInput }) {
  if (!q && !centerPoint) return [];

  const base =
    "https://apps.fs.usda.gov/ArcX/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query";

  let where = "1=1";
  if (q) {
    const safe = q.replace(/'/g, "''").slice(0, 80);
    where = `UPPER(trail_name) LIKE UPPER('%${safe}%')`;
  }

  const params = new URLSearchParams({
    where,
    outFields:
      "trail_name,trail_no,trail_type,trail_class,trail_surface,admin_org,managing_org,gis_miles,hiker_pedestrian_managed",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    resultRecordCount: "150",
  });

  if (centerPoint) {
    const buffer = 0.35;
    const envelope = `\( {centerPoint.lon - buffer}, \){centerPoint.lat - buffer},\( {centerPoint.lon + buffer}, \){centerPoint.lat + buffer}`;
    params.set("geometry", envelope);
    params.set("geometryType", "esriGeometryEnvelope");
    params.set("inSR", "4326");
    params.set("spatialRel", "esriSpatialRelIntersects");
  }

  try {
    const resp = await fetch(`\( {base}? \){params}`, {
      headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const features = data.features || [];

    const byName = new Map();
    for (const f of features) {
      const attrs = f.attributes || {};
      const name = attrs.trail_name;
      if (!name) continue;
      const segments = esriPathsToSegments(f.geometry);
      if (segments.length === 0) continue;

      const key = normalizeTrailName(name);
      const miles = Number(attrs.gis_miles) || 0;
      const existing = byName.get(key);
      if (existing) {
        existing.segmentsGeom.push(...segments);
        existing.segments += segments.length;
        existing.miles += miles;
      } else {
        const first = segments[0][0];
        byName.set(key, {
          name,
          segmentsGeom: [...segments],
          segments: segments.length,
          miles,
          lat: first[0],
          lon: first[1],
          attrs,
        });
      }
    }

    const MAX_POINTS_PER_TRAIL = 400;
    return Array.from(byName.values()).map((t) => {
      const distKm = t.miles > 0 ? t.miles * 1.60934 : segmentsLengthKm(t.segmentsGeom);
      const totalPoints = t.segmentsGeom.reduce((s, seg) => s + seg.length, 0);
      const perSegBudget = Math.max(2, Math.floor(MAX_POINTS_PER_TRAIL / Math.max(1, t.segmentsGeom.length)));
      const geometry =
        totalPoints <= MAX_POINTS_PER_TRAIL
          ? t.segmentsGeom
          : t.segmentsGeom.map((seg) => decimate(seg, perSegBudget));

      return {
        name: t.name,
        state: stateInput,
        distance_km: Math.round(distKm * 10) / 10,
        difficulty: "Unknown",
        surface: t.attrs.trail_surface || null,
        segments: t.segments,
        lat: t.lat,
        lon: t.lon,
        geometry,
        osm_description: null,
        osm_url: null,
        source: "USFS",
        trail_no: t.attrs.trail_no || null,
        managing_org: t.attrs.admin_org || t.attrs.managing_org || null,
      };
    });
  } catch (err) {
    console.error("USFS trail search failed:", err.message || err);
    return [];
  }
}

function mergeTrails(osmTrails, usfsTrails) {
  const byName = new Map();
  for (const t of osmTrails) {
    byName.set(normalizeTrailName(t.name), t);
  }
  for (const t of usfsTrails) {
    const key = normalizeTrailName(t.name);
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, t);
      continue;
    }
    const preferUsfs =
      (t.geometry && t.geometry.length) > (existing.geometry && existing.geometry.length) ||
      t.distance_km > existing.distance_km * 1.1;
    if (preferUsfs) {
      byName.set(key, {
        ...t,
        osm_description: existing.osm_description || t.osm_description,
        osm_url: existing.osm_url || t.osm_url,
        difficulty: existing.difficulty !== "Unknown" ? existing.difficulty : t.difficulty,
      });
    } else {
      existing.source = (existing.source || "OpenStreetMap") + "+USFS";
      existing.trail_no = t.trail_no || existing.trail_no;
      existing.managing_org = t.managing_org || existing.managing_org;
      if (!existing.surface && t.surface) existing.surface = t.surface;
    }
  }
  return Array.from(byName.values());
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
      error: "Unknown or missing state. Send a full state name (California) or two-letter code (CA).",
    });
  }

  const cacheKey = `v2::\( {iso}:: \){q.toLowerCase()}::\( {near.toLowerCase()}:: \){hasDirectPoint ? `\( {directLat}, \){directLon}` : ""}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ trails: cached.data, cached: true });
  }

  let centerPoint = hasDirectPoint ? { lat: directLat, lon: directLon } : null;
  if (near && !centerPoint) {
    try {
      const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=\( {encodeURIComponent(` \){near}, ${stateInput}, USA`)}`;
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
      return res.status(404).json({
        error: `Couldn't find "${near}" in ${stateInput}. Try a different spelling or nearby city.`,
      });
    }
  }

  const nameFilter = q ? `["name"\~"${escapeRegex(q)}",i]` : `["name"]`;
  const RADIUS_METERS = 24000;

  const overpassQuery = centerPoint
    ? `
    [out:json][timeout:45];
    (
      way(around:\( {RADIUS_METERS}, \){centerPoint.lat},\( {centerPoint.lon})["highway"\~"^(path|footway) \)"]${nameFilter};
      relation(around:\( {RADIUS_METERS}, \){centerPoint.lat},\( {centerPoint.lon})["type"="route"]["route"\~"^(hiking|foot) \)"]${nameFilter};
    );
    out tags geom;
  `.trim()
    : `
    [out:json][timeout:45];
    area["ISO3166-2"="${iso}"]["admin_level"="4"]->.a;
    (
      way(area.a)["highway"\~"^(path|footway)\( "] \){nameFilter};
      relation(area.a)["type"="route"]["route"\~"^(hiking|foot)\( "] \){nameFilter};
    );
    out tags geom;
  `.trim();

  try {
    const [osmData, usfsTrails] = await Promise.all([
      (async () => {
        let data = null;
        let lastError = null;
        for (const url of OVERPASS_URLS) {
          try {
            const resp = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "text/plain",
                "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
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
          }
        }
        if (!data) {
          throw new Error(lastError || "All Overpass mirrors failed");
        }
        return data;
      })(),
      fetchUsfsTrails({ q, centerPoint, stateInput }),
    ]);

    const osmTrails = trailsFromOverpass(osmData.elements || [], stateInput);
    const merged = mergeTrails(osmTrails, usfsTrails)
      .sort((a, b) => b.distance_km - a.distance_km)
      .slice(0, 150);

    cache.set(cacheKey, { data: merged, expires: Date.now() + CACHE_TTL_MS });
    res.json({
      trails: merged,
      cached: false,
      source: "OpenStreetMap + USFS",
      counts: { osm: osmTrails.length, usfs: usfsTrails.length, merged: merged.length },
    });
  } catch (err) {
    console.error(err);
    try {
      const usfsOnly = await fetchUsfsTrails({ q, centerPoint, stateInput });
      if (usfsOnly.length > 0) {
        const sorted = usfsOnly.sort((a, b) => b.distance_km - a.distance_km).slice(0, 150);
        cache.set(cacheKey, { data: sorted, expires: Date.now() + CACHE_TTL_MS });
        return res.json({
          trails: sorted,
          cached: false,
          source: "USFS (OpenStreetMap unavailable)",
          counts: { osm: 0, usfs: usfsOnly.length, merged: sorted.length },
        });
      }
    } catch (_) {}
    res.status(500).json({
      error: "Failed to fetch trail data",
      detail: String(err.message || err),
    });
  }
});

function parkKind(tags) {
  if (tags.boundary === "national_park" || tags.protection_title === "National Park") return "National Park";
  if (tags.boundary === "protected_area" || tags.leisure === "nature_reserve") return "State / Protected Park";
  if (tags.leisure === "park") return "City / Local Park";
  return "Park";
}

async function runOverpassQuery(overpassQuery) {
  let lastError = null;
  for (const url of OVERPASS_URLS) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)",
          Accept: "application/json, text/plain, */*",
        },
        body: overpassQuery,
      });
      if (!resp.ok) {
        lastError = await resp.text();
        continue;
      }
      return await resp.json();
    } catch (innerErr) {
      lastError = String(innerErr.message || innerErr);
    }
  }
  throw new Error(lastError || "All Overpass mirrors failed");
}

app.get("/api/parks", async (req, res) => {
  const stateInput = (req.query.state || "").trim();
  const q = (req.query.q || "").trim();
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];

  if (!iso) {
    return res.status(400).json({
      error: "Unknown or missing state. Send a full state name (California) or two-letter code (CA).",
    });
  }
  const stateCode = iso.split("-")[1];

  const cacheKey = `parks::\( {iso}:: \){q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ parks: cached.data, cached: true });
  }

  const results = [];

  if (process.env.NPS_API_KEY) {
    try {
      const npsResp = await fetch(
        `https://developer.nps.gov/api/v1/parks?stateCode=${stateCode}&limit=200`,
        { headers: { "X-Api-Key": process.env.NPS_API_KEY } }
      );
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
            lat,
            lon,
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

  try {
    const nameFilter = q ? `["name"\~"${escapeRegex(q)}",i]` : `["name"]`;
    const cityQuery = `
      [out:json][timeout:30];
      area["ISO3166-2"="${iso}"]["admin_level"="4"]->.a;
      way["leisure"="park"]${nameFilter}(area.a);
      out tags center 150;
    `.trim();
    const data = await runOverpassQuery(cityQuery);
    (data.elements || []).forEach((el) => {
      const name = el.tags && el.tags.name;
      const center = el.center;
      if (!name || !center) return;
      results.push({
        name,
        state: stateInput,
        kind: "City / Local Park",
        lat: center.lat,
        lon: center.lon,
        osm_description: el.tags.description || null,
        osm_url: `https://www.openstreetmap.org/?mlat=\( {center.lat}&mlon= \){center.lon}#map=13/\( {center.lat}/ \){center.lon}`,
      });
    });
  } catch (err) {
    console.error("OSM city parks lookup failed:", err.message || err);
  }

  const seen = new Map();
  results.forEach((p) => {
    if (!seen.has(p.name)) seen.set(p.name, p);
  });
  const parks = Array.from(seen.values()).slice(0, 200);

  if (parks.length === 0 && !process.env.NPS_API_KEY) {
    return res.json({
      parks: [],
      cached: false,
      note: "No city parks matched, and national/state park coverage needs an NPS_API_KEY configured on the server to work.",
    });
  }

  cache.set(cacheKey, { data: parks, expires: Date.now() + CACHE_TTL_MS });
  res.json({ parks, cached: false });
});

app.get("/api/park-info", async (req, res) => {
  const name = (req.query.name || "").trim();
  if (!process.env.NPS_API_KEY) {
    return res.json({ available: false, reason: "NPS_API_KEY not configured" });
  }
  if (!name) return res.status(400).json({ error: "Missing name" });

  try {
    const searchResp = await fetch(
      `https://developer.nps.gov/api/v1/parks?q=${encodeURIComponent(name)}&limit=1`,
      { headers: { "X-Api-Key": process.env.NPS_API_KEY } }
    );
    if (!searchResp.ok) throw new Error(`NPS parks lookup returned ${searchResp.status}`);
    const searchData = await searchResp.json();
    const park = searchData.data && searchData.data[0];
    if (!park) return res.json({ available: false, reason: "No matching NPS unit" });

    let alerts = [];
    try {
      const alertResp = await fetch(
        `https://developer.nps.gov/api/v1/alerts?parkCode=${park.parkCode}`,
        { headers: { "X-Api-Key": process.env.NPS_API_KEY } }
      );
      if (alertResp.ok) {
        const alertData = await alertResp.json();
        alerts = (alertData.data || []).map((a) => ({
          title: a.title,
          description: a.description,
          category: a.category,
        }));
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

app.get("/api/reccons", async (req, res) => {
  const stateInput = (req.query.state || "").trim();
  const q = (req.query.q || "").trim();
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];

  if (!iso) {
    return res.status(400).json({
      error: "Unknown or missing state. Send a full state name (California) or two-letter code (CA).",
    });
  }

  const cacheKey = `reccons::\( {iso}:: \){q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ areas: cached.data, cached: true });
  }

  const nameFilter = q ? `["name"\~"${escapeRegex(q)}",i]` : `["name"]`;
  const query = `
    [out:json][timeout:30];
    area["ISO3166-2"="${iso}"]["admin_level"="4"]->.a;
    (
      way["boundary"="protected_area"]["operator"\~"Forest Service|Bureau of Land Management",i]${nameFilter}(area.a);
      relation["boundary"="protected_area"]["operator"\~"Forest Service|Bureau of Land Management",i]${nameFilter}(area.a);
      way["boundary"="national_park"]["operator"\~"Forest Service",i]${nameFilter}(area.a);
      relation["boundary"="national_park"]["operator"\~"Forest Service",i]${nameFilter}(area.a);
    );
    out tags center 150;
  `.trim();

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
        kind: /forest service/i.test(operator)
          ? "National Forest"
          : /bureau of land management/i.test(operator)
            ? "BLM Land"
            : "Conservation Area",
        lat: center.lat,
        lon: center.lon,
        osm_description: el.tags.description || null,
        osm_url: `https://www.openstreetmap.org/?mlat=\( {center.lat}&mlon= \){center.lon}#map=12/\( {center.lat}/ \){center.lon}`,
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

  const buffer = 0.3;
  const envelope = `\( {lon - buffer}, \){lat - buffer},\( {lon + buffer}, \){lat + buffer}`;
  const safeName = name.replace(/'/g, "''").slice(0, 80);
  const where = `UPPER(trail_name) LIKE UPPER('%${safeName}%')`;
  const url =
    "https://apps.fs.usda.gov/ArcX/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query" +
    `?where=\( {encodeURIComponent(where)}&geometry= \){envelope}&geometryType=esriGeometryEnvelope` +
    `&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&f=json`;

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" },
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
      hikerAllowed: first.hiker_pedestrian_managed === "YES" || first.hiker_pedestrian_managed === 1,
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
      headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" },
    });
    if (!resp.ok) return res.json({ available: false });
    const data = await resp.json();
    const features = data.features || [];
    if (features.length === 0) return res.json({ available: false });

    const first = features[0].attributes;
    let totalMiles = 0;
    features.forEach((f) => {
      totalMiles += Number(f.attributes.GIS_MILES) || 0;
    });

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
  const locations = (req.query.locations || "").trim();
  if (!locations) return res.status(400).json({ error: "Missing locations" });
  const points = locations.split("|").map((p) => p.split(",").map(Number));

  try {
    const settled = [];
    for (const [lat, lon] of points) {
      const url = `https://epqs.nationalmap.gov/v1/json?x=\( {lon}&y= \){lat}&units=Feet`;
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" },
        });
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
          console.error(`USGS EPQS point (\( {lat}, \){lon}) failed:`, pointErr.message || pointErr);
        }
        settled.push(null);
      }
    }
    const successCount = settled.filter((v) => v !== null).length;
    if (successCount >= Math.ceil(points.length * 0.5)) {
      return res.json({ elevations: settled, source: "usgs-epqs", units: "feet" });
    }
    console.error(`USGS EPQS: only \( {successCount}/ \){points.length} points succeeded, falling back`);
  } catch (err) {
    console.error("USGS EPQS failed:", err.message || err);
  }

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

  res.status(502).json({
    error: "Elevation data isn't available right now — both providers failed to respond.",
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Trailseeker running at http://localhost:${PORT}`);
});
