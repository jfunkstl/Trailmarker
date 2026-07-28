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
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];

  if (!iso) {
    return res.status(400).json({ error: "Unknown or missing state. Send a full state name (California) or two-letter code (CA)." });
  }

  const cacheKey = `${iso}::${q.toLowerCase()}::${near.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ trails: cached.data, cached: true });
  }

  // If a city/place was given, geocode it (scoped to the chosen state) via
  // Nominatim, then search a radius around that point instead of the whole
  // state. This lets the same search box work for either a trail name or a
  // place name.
  let centerPoint = null;
  if (near) {
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
  // OSM equivalent of a "named trail". Long trails are often split into many
  // short ways sharing the same name, so we group and sum them below.
  const RADIUS_METERS = 24000; // ~15 miles around the searched city
  const overpassQuery = centerPoint
    ? `
    [out:json][timeout:25];
    way(around:${RADIUS_METERS},${centerPoint.lat},${centerPoint.lon})["highway"~"^(path|footway)$"]${nameFilter};
    out tags geom;
  `.trim()
    : `
    [out:json][timeout:25];
    area["ISO3166-2"="${iso}"]["admin_level"="4"]->.a;
    way(area.a)["highway"~"^(path|footway)$"]${nameFilter};
    out tags geom;
  `.trim();

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
    for (const el of elements) {
      if (!el.tags?.name || !el.geometry || el.geometry.length < 2) continue;
      const name = el.tags.name;
      const lenKm = wayLengthKm(el.geometry);
      const segCoords = el.geometry.filter((p) => p).map((p) => [p.lat, p.lon]);
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += 1;
        existing.segmentsGeom.push(segCoords);
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          segments: 1,
          lat: el.geometry[0].lat,
          lon: el.geometry[0].lon,
          tags: el.tags,
          segmentsGeom: [segCoords],
        });
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

    cache.set(cacheKey, { data: trails, expires: Date.now() + CACHE_TTL_MS });
    res.json({ trails, cached: false, source: "OpenStreetMap (Overpass API)" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch trail data", detail: String(err.message || err) });
  }
});

// Classifies a park by whichever OSM tags matched it — national parks and
// protected/state-level areas use `boundary`, while most city/local parks
// use `leisure=park`.
function parkKind(tags) {
  if (tags.boundary === "national_park" || tags.protection_title === "National Park") return "National Park";
  if (tags.boundary === "protected_area" || tags.leisure === "nature_reserve") return "State / Protected Park";
  if (tags.leisure === "park") return "City / Local Park";
  return "Park";
}

app.get("/api/parks", async (req, res) => {
  const stateInput = (req.query.state || "").trim();
  const q = (req.query.q || "").trim();
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];

  if (!iso) {
    return res.status(400).json({ error: "Unknown or missing state. Send a full state name (California) or two-letter code (CA)." });
  }

  const cacheKey = `parks::${iso}::${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ parks: cached.data, cached: true });
  }

  const nameFilter = q ? `["name"~"${escapeRegex(q)}",i]` : `["name"]`;
  const overpassQuery = `
    [out:json][timeout:25];
    area["ISO3166-2"="${iso}"]["admin_level"="4"]->.a;
    (
      way["leisure"="park"]${nameFilter}(area.a);
      relation["leisure"="park"]${nameFilter}(area.a);
      way["leisure"="nature_reserve"]${nameFilter}(area.a);
      relation["leisure"="nature_reserve"]${nameFilter}(area.a);
      way["boundary"="national_park"]${nameFilter}(area.a);
      relation["boundary"="national_park"]${nameFilter}(area.a);
      way["boundary"="protected_area"]${nameFilter}(area.a);
      relation["boundary"="protected_area"]${nameFilter}(area.a);
    );
    out tags center;
  `.trim();

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
        if (!resp.ok) { lastError = await resp.text(); continue; }
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

    const seen = new Map();
    (data.elements || []).forEach((el) => {
      const name = el.tags && el.tags.name;
      const center = el.center;
      if (!name || !center) return;
      if (seen.has(name)) return; // same park often returned as both way + relation
      seen.set(name, {
        name,
        state: stateInput,
        kind: parkKind(el.tags),
        lat: center.lat,
        lon: center.lon,
        osm_description: el.tags.description || null,
        osm_url: `https://www.openstreetmap.org/?mlat=${center.lat}&mlon=${center.lon}#map=13/${center.lat}/${center.lon}`,
      });
    });

    const parks = Array.from(seen.values()).slice(0, 150);
    cache.set(cacheKey, { data: parks, expires: Date.now() + CACHE_TTL_MS });
    res.json({ parks, cached: false, source: "OpenStreetMap (Overpass API)" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch park data", detail: String(err.message || err) });
  }
});
// flaky/CORS-restricted for direct browser calls. Tries Open-Topo-Data first
// (more reliable), falls back to Open-Elevation if that fails.
app.get("/api/elevation", async (req, res) => {
  const locations = (req.query.locations || "").trim(); // "lat,lon|lat,lon|..."
  if (!locations) return res.status(400).json({ error: "Missing locations" });

  try {
    const otdResp = await fetch(`https://api.opentopodata.org/v1/srtm90m?locations=${locations}`, {
      headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" },
    });
    if (otdResp.ok) {
      const otdData = await otdResp.json();
      if (otdData.results && otdData.results.every((r) => r.elevation !== null)) {
        return res.json({ elevations: otdData.results.map((r) => r.elevation), source: "opentopodata" });
      }
    }
  } catch (err) {
    console.error("Open-Topo-Data failed:", err.message || err);
  }

  try {
    const oeResp = await fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${locations}`, {
      headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" },
    });
    if (oeResp.ok) {
      const oeData = await oeResp.json();
      return res.json({ elevations: oeData.results.map((r) => r.elevation), source: "open-elevation" });
    }
  } catch (err) {
    console.error("Open-Elevation failed:", err.message || err);
  }

  res.status(502).json({ error: "Elevation data isn't available right now — both providers failed to respond." });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Trailseeker running at http://localhost:${PORT}`);
});
