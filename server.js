import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { STATE_ISO, STATE_LIST } from "./states.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";

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
  const iso = STATE_ISO[stateInput] || STATE_ISO[stateInput.toLowerCase()];

  if (!iso) {
    return res.status(400).json({ error: "Unknown or missing state. Send a full state name (California) or two-letter code (CA)." });
  }

  const cacheKey = `${iso}::${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.json({ trails: cached.data, cached: true });
  }

  const nameFilter = q ? `["name"~"${escapeRegex(q)}",i]` : `["name"]`;
  // Ways tagged highway=path or highway=footway with a name are the closest
  // OSM equivalent of a "named trail". Long trails are often split into many
  // short ways sharing the same name, so we group and sum them below.
  const overpassQuery = `
    [out:json][timeout:25];
    area["ISO3166-2"="${iso}"]["admin_level"="4"]->.a;
    way(area.a)["highway"~"^(path|footway)$"]${nameFilter};
    out tags geom;
  `.trim();

  try {
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: overpassQuery,
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return res.status(502).json({ error: "Overpass API returned an error", detail: detail.slice(0, 300) });
    }

    const data = await resp.json();
    const elements = data.elements || [];

    const byName = new Map();
    for (const el of elements) {
      if (!el.tags?.name || !el.geometry || el.geometry.length < 2) continue;
      const name = el.tags.name;
      const lenKm = wayLengthKm(el.geometry);
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += 1;
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          segments: 1,
          lat: el.geometry[0].lat,
          lon: el.geometry[0].lon,
          tags: el.tags,
        });
      }
    }

    const trails = Array.from(byName.values())
      .filter((t) => t.distance_km > 0.1)
      .map((t) => ({
        name: t.name,
        state: stateInput,
        distance_km: Math.round(t.distance_km * 10) / 10,
        difficulty: difficultyFromTags(t.tags),
        surface: t.tags.surface || null,
        segments: t.segments,
        lat: t.lat,
        lon: t.lon,
        osm_url: `https://www.openstreetmap.org/?mlat=${t.lat}&mlon=${t.lon}#map=15/${t.lat}/${t.lon}`,
      }))
      .sort((a, b) => b.distance_km - a.distance_km)
      .slice(0, 150);

    cache.set(cacheKey, { data: trails, expires: Date.now() + CACHE_TTL_MS });
    res.json({ trails, cached: false, source: "OpenStreetMap (Overpass API)" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch trail data", detail: String(err.message || err) });
  }
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`TrailMark Live running at http://localhost:${PORT}`);
});
