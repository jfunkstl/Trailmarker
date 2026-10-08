// ===========================================================================
// stateTrails.js -- official state / federal trail datasets for the map.
//
// Each source below gap-fills what OpenStreetMap is missing for one state (or,
// for the National Forest and BLM layers, for several). Every fetch function:
//   * is gated by a rough bounding box, so it makes NO network call for
//     viewports in other states and quietly returns [] on any failure;
//   * queries an ArcGIS layer by map envelope, asking for lon/lat (outSR=4326);
//   * returns trails shaped like the rest of the app expects:
//       { name, distance_km, difficulty, lat, lon, segments, segmentsGeom }
//
// fetchStateTrails() at the bottom runs all of them in parallel and returns the
// results in priority order. server.js merges that list in after the OSM data,
// skipping any name OSM already has (first one wins).
//
// To add a state: write a fetchXxxTrails() below (follow an existing one, and
// verify the layer's real field names first), then add it to the list in
// fetchStateTrails().
// ===========================================================================

// ---- small helpers (self-contained so this file has no dependency on server.js) ----

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

function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const la1 = (lat1 * Math.PI) / 180;
  const la2 = (lat2 * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// geometry = [{ lat, lon }, ...]
function wayLengthKm(geometry) {
  let d = 0;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1];
    const b = geometry[i];
    if (a && b) d += haversineKm(a.lon, a.lat, b.lon, b.lat);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Colorado COTREX (Colorado Trail Explorer) integration -- gap-fills the
// map with Colorado's official statewide trail dataset (~40,000 miles from
// 225+ land managers) alongside OSM data, since OSM alone is missing many
// local/regional trail systems OSM contributors haven't mapped.
//
// Endpoint and field names verified directly against gis.colorado.gov's own
// ArcGIS REST Services Directory before writing this (never guess API
// params/fields -- past USGS EPQS mistake). Confirmed: layer 40 on the
// Colorado_State_Basemap MapServer, copyright "Colorado Parks & Wildlife GIS
// Unit", esriGeometryPolyline. Native spatial reference is Web Mercator
// (3857), so outSR=4326 is required to get plain lat/lon back.
// ---------------------------------------------------------------------------
const COTREX_URL = "https://gis.colorado.gov/public/rest/services/OIT/Colorado_State_Basemap/MapServer/40/query";
// Colorado's documented extent on the COTREX layer itself -- used to skip
// querying COTREX entirely for viewports that don't overlap Colorado at
// all, since it's a state-only dataset and there's no point calling it for
// someone panning around, say, Oregon.
const COLORADO_BOUNDS = { swLat: 36.9, swLon: -109.1, neLat: 41.1, neLon: -102.0 };
function boundsOverlapColorado(swLat, swLon, neLat, neLon) {
  return swLat <= COLORADO_BOUNDS.neLat && neLat >= COLORADO_BOUNDS.swLat &&
    swLon <= COLORADO_BOUNDS.neLon && neLon >= COLORADO_BOUNDS.swLon;
}

async function fetchCotrexTrails(swLat, swLon, neLat, neLon) {
  if (!boundsOverlapColorado(swLat, swLon, neLat, neLon)) return [];
  const envelope = `${swLon},${swLat},${neLon},${neLat}`; // esriGeometryEnvelope order: xmin(lon),ymin(lat),xmax(lon),ymax(lat)
  const url = `${COTREX_URL}?geometry=${encodeURIComponent(envelope)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=name,length_mi_,surface,manager&outSR=4326&f=geojson`;
  try {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) {
      console.error(`COTREX query returned ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    const features = data.features || [];
    const byName = new Map();
    features.forEach((f) => {
      const props = f.properties || {};
      const name = props.name;
      const geom = f.geometry;
      if (!name || !geom) return;
      // GeoJSON LineString/MultiLineString coords are [lon,lat] -- flip to [lat,lon].
      const lines = geom.type === "MultiLineString" ? geom.coordinates : geom.type === "LineString" ? [geom.coordinates] : [];
      const segCoordsList = lines.map((line) => line.map(([lon, lat]) => [lat, lon])).filter((seg) => seg.length >= 2);
      if (segCoordsList.length === 0) return;
      const lenKm = (Number(props.length_mi_) || 0) * 1.60934;
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += segCoordsList.length;
        existing.segmentsGeom.push(...segCoordsList);
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          difficulty: "Unknown", // COTREX has no verified difficulty-rating field equivalent to OSM's sac_scale
          lat: segCoordsList[0][0][0],
          lon: segCoordsList[0][0][1],
          segments: segCoordsList.length,
          segmentsGeom: segCoordsList,
        });
      }
    });
    return Array.from(byName.values()).map((t) => ({ ...t, distance_km: Math.round(t.distance_km * 10) / 10 }));
  } catch (err) {
    console.error("COTREX trails lookup failed:", err.message || err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Missouri MDC (Missouri Department of Conservation) integration -- same
// gap-filling role as Colorado's COTREX above, for Missouri specifically.
//
// Endpoint, field names, and geometry type verified directly against the
// live ArcGIS REST Services Directory before writing this. An initial
// guessed service name (MO_Missouri_Department_of_Conservation_Trails,
// found via a stale open-data catalog listing) does not actually exist and
// returned "Invalid URL" -- the real, live service (confirmed via the
// org's own full service directory) is MO_MDC_Trails under org
// kNS2ppBA4rwAQQZy. Verify, never guess. Confirmed fields via a live
// sample record: Trail_Name, Area_Name, Miles, Biking, Equestrian, ADA.
// Geometry type is esriGeometryPolyline. Native spatial reference is Web
// Mercator (102100), so outSR=4326 is required to get plain lat/lon back,
// same as COTREX.
//
// The same sample record showed a blank Trail_Name but a populated
// Area_Name -- rather than silently dropping trails like that, they're
// grouped and shown under the conservation area's name instead, since
// that's still meaningfully identifying and better than losing real trail
// mileage entirely.
// ---------------------------------------------------------------------------
const MDC_TRAILS_URL = "https://services2.arcgis.com/kNS2ppBA4rwAQQZy/ArcGIS/rest/services/MO_MDC_Trails/FeatureServer/0/query";
// Missouri's approximate statewide extent -- used to skip querying this
// endpoint entirely for viewports that don't overlap Missouri at all.
const MISSOURI_BOUNDS = { swLat: 35.9, swLon: -95.9, neLat: 40.7, neLon: -89.0 };
function boundsOverlapMissouri(swLat, swLon, neLat, neLon) {
  return swLat <= MISSOURI_BOUNDS.neLat && neLat >= MISSOURI_BOUNDS.swLat &&
    swLon <= MISSOURI_BOUNDS.neLon && neLon >= MISSOURI_BOUNDS.swLon;
}

async function fetchMdcTrails(swLat, swLon, neLat, neLon) {
  if (!boundsOverlapMissouri(swLat, swLon, neLat, neLon)) return [];
  const envelope = `${swLon},${swLat},${neLon},${neLat}`; // esriGeometryEnvelope order: xmin(lon),ymin(lat),xmax(lon),ymax(lat)
  const url = `${MDC_TRAILS_URL}?geometry=${encodeURIComponent(envelope)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=Trail_Name,Area_Name,Miles&outSR=4326&f=geojson`;
  try {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) {
      console.error(`MDC trails query returned ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    const features = data.features || [];
    const byName = new Map();
    features.forEach((f) => {
      const props = f.properties || {};
      const trailName = (props.Trail_Name || "").trim();
      const areaName = (props.Area_Name || "").trim();
      const name = trailName || areaName; // fall back to the conservation area's name when the trail record itself has none
      const geom = f.geometry;
      if (!name || !geom) return;
      // GeoJSON LineString/MultiLineString coords are [lon,lat] -- flip to [lat,lon].
      const lines = geom.type === "MultiLineString" ? geom.coordinates : geom.type === "LineString" ? [geom.coordinates] : [];
      const segCoordsList = lines.map((line) => line.map(([lon, lat]) => [lat, lon])).filter((seg) => seg.length >= 2);
      if (segCoordsList.length === 0) return;
      const lenKm = (Number(props.Miles) || 0) * 1.60934;
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += segCoordsList.length;
        existing.segmentsGeom.push(...segCoordsList);
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          difficulty: "Unknown", // MDC has no difficulty-rating field equivalent to OSM's sac_scale
          lat: segCoordsList[0][0][0],
          lon: segCoordsList[0][0][1],
          segments: segCoordsList.length,
          segmentsGeom: segCoordsList,
        });
      }
    });
    return Array.from(byName.values()).map((t) => ({ ...t, distance_km: Math.round(t.distance_km * 10) / 10 }));
  } catch (err) {
    console.error("MDC trails lookup failed:", err.message || err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Washington State RCO Trails Database integration -- the state's official
// aggregated trails dataset (v2.0, April 2025), compiled by the Recreation
// and Conservation Office from federal, state, county, and city agencies.
// Same gap-filling role as COTREX and MDC above, for Washington.
//
// Endpoint, field names, and geometry verified directly against the live
// FeatureServer (services2.arcgis.com/TGEC20q86HQAeMS6, layer 0 "Trails")
// via real sample records before writing this. Geometry is esriGeometryPolyline
// and the native spatial reference is Web Mercator (102100), so outSR=4326 is
// required, same as COTREX and MDC. The service returns at most 2000 features
// per query.
//
// Real-data quirks the sample records showed, handled below:
//   - trail_name is often blank (many unnamed segments) -- fall back to
//     trail_alternate_name, then trail_system_name; truly unnamed segments
//     are skipped since there's nothing meaningful to label them with.
//   - The same trail is split into many rows (e.g. Palouse to Cascades State
//     Park Trail appears as several segments) -- combined by name here, with
//     segment_length_mi summed.
//   - Use flags are inconsistently cased ("yes"/"Yes"/blank) -- compared
//     case-insensitively. Trails are kept when hiking_walking is yes OR the
//     primary_use mentions hiking/walking.
//   - trail_status is "Existing" for real trails -- anything else (planned/
//     proposed) is skipped.
// ---------------------------------------------------------------------------
const WA_TRAILS_URL = "https://services2.arcgis.com/TGEC20q86HQAeMS6/arcgis/rest/services/WA_RCO_Trails_Database_Public_View/FeatureServer/0/query";
// Washington's approximate statewide extent -- used to skip querying this
// endpoint entirely for viewports that don't overlap Washington at all.
const WASHINGTON_BOUNDS = { swLat: 45.5, swLon: -124.85, neLat: 49.05, neLon: -116.9 };
function boundsOverlapWashington(swLat, swLon, neLat, neLon) {
  return swLat <= WASHINGTON_BOUNDS.neLat && neLat >= WASHINGTON_BOUNDS.swLat &&
    swLon <= WASHINGTON_BOUNDS.neLon && neLon >= WASHINGTON_BOUNDS.swLon;
}

function waTrailName(props) {
  const pick = (v) => (typeof v === "string" ? v.trim() : "");
  return pick(props.trail_name) || pick(props.trail_alternate_name) || pick(props.trail_system_name) || "";
}
function waIsHikeable(props) {
  const hikingYes = String(props.hiking_walking || "").trim().toLowerCase() === "yes";
  const primaryHiking = /hik|walk/i.test(String(props.primary_use || ""));
  return hikingYes || primaryHiking;
}
function waIsExisting(props) {
  const status = String(props.trail_status || "").trim();
  return !status || /^existing$/i.test(status);
}

async function fetchWaTrails(swLat, swLon, neLat, neLon) {
  if (!boundsOverlapWashington(swLat, swLon, neLat, neLon)) return [];
  const envelope = `${swLon},${swLat},${neLon},${neLat}`; // esriGeometryEnvelope order: xmin(lon),ymin(lat),xmax(lon),ymax(lat)
  const url = `${WA_TRAILS_URL}?where=1%3D1&geometry=${encodeURIComponent(envelope)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=trail_name,trail_alternate_name,trail_system_name,trail_surface,segment_length_mi,management_agency,hiking_walking,primary_use,trail_status&outSR=4326&f=geojson`;
  try {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) {
      console.error(`WA RCO trails query returned ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (data.error) {
      console.error("WA RCO trails query error:", JSON.stringify(data.error).slice(0, 300));
      return [];
    }
    const features = data.features || [];
    const byName = new Map();
    features.forEach((f) => {
      const props = f.properties || {};
      const geom = f.geometry;
      if (!geom || !waIsHikeable(props) || !waIsExisting(props)) return;
      const name = waTrailName(props);
      if (!name) return;
      // GeoJSON LineString/MultiLineString coords are [lon,lat] -- flip to [lat,lon].
      const lines = geom.type === "MultiLineString" ? geom.coordinates : geom.type === "LineString" ? [geom.coordinates] : [];
      const segCoordsList = lines.map((line) => line.map(([lon, lat]) => [lat, lon])).filter((seg) => seg.length >= 2);
      if (segCoordsList.length === 0) return;
      const lenKm = (Number(props.segment_length_mi) || 0) * 1.60934;
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += segCoordsList.length;
        existing.segmentsGeom.push(...segCoordsList);
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          difficulty: "Unknown", // the RCO database has no difficulty-rating field
          lat: segCoordsList[0][0][0],
          lon: segCoordsList[0][0][1],
          segments: segCoordsList.length,
          segmentsGeom: segCoordsList,
        });
      }
    });
    return Array.from(byName.values()).map((t) => ({ ...t, distance_km: Math.round(t.distance_km * 10) / 10 }));
  } catch (err) {
    console.error("WA RCO trails lookup failed:", err.message || err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Oregon federal trail integrations -- USFS National Forest trails and BLM
// trails. Oregon has no single statewide trail dataset like Washington's RCO
// layer, but a large share of its trail miles are on National Forest and BLM
// land, and both agencies publish free, token-free layers.
//
// Both layers verified directly against the live services via real sample
// records before writing this (the BLM "Public_Trails" ArcGIS Online layer
// was rejected -- it requires a login token).
//
// Query format: f=json (Esri JSON, geometry.paths = [lon,lat] pairs) rather
// than f=geojson, since that's the format the sample records were verified
// in. outSR=4326 is requested on both; the USFS layer is natively NAD83
// geographic (4269) and the BLM layer is Web Mercator (102100).
//
// Gated to the states listed in FEDERAL_TRAIL_STATES below (small-steps
// rollout: Oregon, then California).
// ---------------------------------------------------------------------------
// States where the federal (USFS + BLM) trail layers are merged into the map.
// Rolled out one state at a time -- add a state here (with its approximate
// extent) to turn it on. Each code is the BLM layer's ADMIN_ST value.
const FEDERAL_TRAIL_STATES = {
  OR: { swLat: 41.9, swLon: -124.8, neLat: 46.35, neLon: -116.4 },
  CA: { swLat: 32.5, swLon: -124.5, neLat: 42.05, neLon: -114.1 },
  ID: { swLat: 41.95, swLon: -117.3, neLat: 49.05, neLon: -110.99 },
};
// Returns the state codes (e.g. ["OR","CA"]) whose extent overlaps the viewport.
function federalTrailStatesInView(swLat, swLon, neLat, neLon) {
  return Object.entries(FEDERAL_TRAIL_STATES)
    .filter(([, b]) => swLat <= b.neLat && neLat >= b.swLat && swLon <= b.neLon && neLon >= b.swLon)
    .map(([code]) => code);
}

// USFS stores names in ALL CAPS ("BIG SPRINGS"); show them in Title Case.
function toTitleCase(str) {
  return String(str || "").toLowerCase().replace(/(^|[\s\-\/(])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

// Esri JSON polyline paths are arrays of [lon,lat] -- flip to [lat,lon].
function esriPathsToLatLon(geometry) {
  const paths = geometry && Array.isArray(geometry.paths) ? geometry.paths : [];
  return paths
    .map((path) => path.map(([lon, lat]) => [lat, lon]))
    .filter((seg) => seg.length >= 2);
}
function segmentsLengthKm(segCoordsList) {
  return segCoordsList.reduce((sum, seg) => sum + wayLengthKm(seg.map(([lat, lon]) => ({ lat, lon }))), 0);
}

// --- USFS (National Forest System trails) ---
// Verified fields: trail_name (often ALL CAPS), trail_no, trail_type (TERRA =
// land trail), trail_surface, gis_miles, hiker_pedestrian_managed (a date
// range like "01/01-12/31" when hikers are allowed, null otherwise).
const USFS_TRAILS_URL = "https://apps.fs.usda.gov/ArcX/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query";
async function fetchUsfsTrails(swLat, swLon, neLat, neLon) {
  if (federalTrailStatesInView(swLat, swLon, neLat, neLon).length === 0) return [];
  const envelope = `${swLon},${swLat},${neLon},${neLat}`;
  const where = "trail_type='TERRA' AND hiker_pedestrian_managed IS NOT NULL";
  const url = `${USFS_TRAILS_URL}?where=${encodeURIComponent(where)}&geometry=${encodeURIComponent(envelope)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=trail_name,trail_no,trail_surface,gis_miles,segment_length&returnGeometry=true&outSR=4326&f=json`;
  try {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) {
      console.error(`USFS trails query returned ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (data.error) {
      console.error("USFS trails query error:", JSON.stringify(data.error).slice(0, 300));
      return [];
    }
    const byName = new Map();
    (data.features || []).forEach((f) => {
      const a = f.attributes || {};
      const rawName = (a.trail_name || "").trim();
      const trailNo = (a.trail_no || "").trim();
      const name = rawName ? toTitleCase(rawName) : (trailNo ? `Trail #${trailNo}` : "");
      if (!name) return;
      const segCoordsList = esriPathsToLatLon(f.geometry);
      if (segCoordsList.length === 0) return;
      const miles = Number(a.gis_miles) || Number(a.segment_length) || 0;
      const lenKm = miles > 0 ? miles * 1.60934 : segmentsLengthKm(segCoordsList);
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += segCoordsList.length;
        existing.segmentsGeom.push(...segCoordsList);
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          difficulty: "Unknown", // USFS has trail class (1-5) but no hiking difficulty rating
          lat: segCoordsList[0][0][0],
          lon: segCoordsList[0][0][1],
          segments: segCoordsList.length,
          segmentsGeom: segCoordsList,
        });
      }
    });
    return Array.from(byName.values()).map((t) => ({ ...t, distance_km: Math.round(t.distance_km * 10) / 10 }));
  } catch (err) {
    console.error("USFS trails lookup failed:", err.message || err);
    return [];
  }
}

// --- BLM (National GTLF trails, Oregon) ---
// Verified fields: ROUTE_PRMRY_NM (name), ADMIN_ST ("OR"), PLAN_ASSET_CLASS
// ("Transportation System - Trail"), OBSRVE_SRFCE_TYPE. IMPORTANT: the real
// sample record had GIS_MILES null and BLM_MILES -1, so those fields can't be
// trusted -- length is computed from the geometry instead.
const BLM_TRAILS_URL = "https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer/7/query";
async function fetchBlmTrails(swLat, swLon, neLat, neLon) {
  const states = federalTrailStatesInView(swLat, swLon, neLat, neLon);
  if (states.length === 0) return [];
  const envelope = `${swLon},${swLat},${neLon},${neLat}`;
  const where = `ADMIN_ST IN (${states.map((c) => `'${c}'`).join(",")}) AND PLAN_ASSET_CLASS LIKE '%Trail%'`;
  const url = `${BLM_TRAILS_URL}?where=${encodeURIComponent(where)}&geometry=${encodeURIComponent(envelope)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ROUTE_PRMRY_NM,OBSRVE_SRFCE_TYPE&returnGeometry=true&outSR=4326&f=json`;
  try {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) {
      console.error(`BLM trails query returned ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (data.error) {
      console.error("BLM trails query error:", JSON.stringify(data.error).slice(0, 300));
      return [];
    }
    const byName = new Map();
    (data.features || []).forEach((f) => {
      const a = f.attributes || {};
      const name = (a.ROUTE_PRMRY_NM || "").trim();
      if (!name) return;
      const segCoordsList = esriPathsToLatLon(f.geometry);
      if (segCoordsList.length === 0) return;
      const lenKm = segmentsLengthKm(segCoordsList);
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += segCoordsList.length;
        existing.segmentsGeom.push(...segCoordsList);
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          difficulty: "Unknown", // BLM has no difficulty-rating field
          lat: segCoordsList[0][0][0],
          lon: segCoordsList[0][0][1],
          segments: segCoordsList.length,
          segmentsGeom: segCoordsList,
        });
      }
    });
    return Array.from(byName.values()).map((t) => ({ ...t, distance_km: Math.round(t.distance_km * 10) / 10 }));
  } catch (err) {
    console.error("BLM trails lookup failed:", err.message || err);
    return [];
  }
}

// --- California State Parks (RoadsTrails_Public, layer 15) ---
// Verified against the live service via real records. Notes from that data:
//  - Native spatial reference is California Albers (3310), so outSR=4326 is
//    requested to get plain lon/lat back.
//  - One layer mixes roads, trails, and abandoned routes. ROUTECLASS values
//    seen: State Park Trail, Other Agency Trail (the real trails), Motorized
//    Trail, State Park Road, Local Road, Non-system Route (abandoned /
//    decommissioned / planned routes), Not Determined. Only the two trail
//    classes are kept, and trails whose use (FCC) is "Bicycle" only are
//    skipped.
//  - ROUTENAME is often blank (stored as a space) -- fall back to UNITNAME
//    (the park name) so the mileage isn't lost, same approach as Missouri.
//  - SEGLNGTH didn't match the real geometry length in the sample record, so
//    length is computed from the geometry.
//  - The layer is current as of January 2020.
const CA_PARKS_TRAILS_URL = "https://services2.arcgis.com/AhxrK3F6WM8ECvDi/ArcGIS/rest/services/RoadsTrails_Public/FeatureServer/15/query";
async function fetchCaStateParksTrails(swLat, swLon, neLat, neLon) {
  if (!federalTrailStatesInView(swLat, swLon, neLat, neLon).includes("CA")) return [];
  const envelope = `${swLon},${swLat},${neLon},${neLat}`;
  const where = "ROUTECLASS IN ('State Park Trail','Other Agency Trail') AND (FCC <> 'Bicycle' OR FCC IS NULL)";
  const url = `${CA_PARKS_TRAILS_URL}?where=${encodeURIComponent(where)}&geometry=${encodeURIComponent(envelope)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ROUTENAME,UNITNAME,ROUTETYPE&returnGeometry=true&outSR=4326&f=json`;
  try {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) {
      console.error(`CA State Parks trails query returned ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (data.error) {
      console.error("CA State Parks trails query error:", JSON.stringify(data.error).slice(0, 300));
      return [];
    }
    const byName = new Map();
    (data.features || []).forEach((f) => {
      const a = f.attributes || {};
      const name = (a.ROUTENAME || "").trim() || (a.UNITNAME || "").trim();
      if (!name) return;
      const segCoordsList = esriPathsToLatLon(f.geometry);
      if (segCoordsList.length === 0) return;
      const lenKm = segmentsLengthKm(segCoordsList);
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += segCoordsList.length;
        existing.segmentsGeom.push(...segCoordsList);
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          difficulty: "Unknown", // no difficulty-rating field in this layer
          lat: segCoordsList[0][0][0],
          lon: segCoordsList[0][0][1],
          segments: segCoordsList.length,
          segmentsGeom: segCoordsList,
        });
      }
    });
    return Array.from(byName.values()).map((t) => ({ ...t, distance_km: Math.round(t.distance_km * 10) / 10 }));
  } catch (err) {
    console.error("CA State Parks trails lookup failed:", err.message || err);
    return [];
  }
}

// --- Nevada (NDOR statewide non-motorized trails, SCORP_NonMoto_Trails_Master) ---
// Nevada Division of Outdoor Recreation's statewide layer of non-motorized
// paved and unpaved trails, aggregated from federal, state, county, and city
// sources. Verified via a real record. Notes from that data:
//  - Native spatial reference is UTM zone 11N (26911), so outSR=4326 is
//    requested to get plain lon/lat back.
//  - Use flags are the STRINGS "1"/"0" (hiking, walking, ...). Trails are
//    kept when hiking or walking is "1".
//  - trailname can be blank: fall back to trailname2, then systemname.
//  - miles matched the geometry length in the sample; it's used when it's a
//    positive number, otherwise length is computed from the geometry.
//  - difficulty was "Easy" in the sample; other values I haven't seen are
//    mapped by keyword (moderate / hard words) and fall back to Unknown.
//  - status was "Open"; routes whose status says closed / proposed / planned /
//    abandoned are skipped.
const NV_TRAILS_URL = "https://arcgis.water.nv.gov/arcgis/rest/services/Hosted/SCORP_NonMoto_Trails_Master/FeatureServer/0/query";
const NEVADA_BOUNDS = { swLat: 34.9, swLon: -120.05, neLat: 42.05, neLon: -113.95 };
function boundsOverlapNevada(swLat, swLon, neLat, neLon) {
  return swLat <= NEVADA_BOUNDS.neLat && neLat >= NEVADA_BOUNDS.swLat &&
    swLon <= NEVADA_BOUNDS.neLon && neLon >= NEVADA_BOUNDS.swLon;
}
function nvDifficulty(raw) {
  const d = String(raw || "").toLowerCase();
  if (/easy|beginner/.test(d)) return "Easy";
  if (/moderate|intermediate/.test(d)) return "Moderate";
  if (/hard|difficult|strenuous|expert|advanced/.test(d)) return "Strenuous";
  return "Unknown";
}
async function fetchNvTrails(swLat, swLon, neLat, neLon) {
  if (!boundsOverlapNevada(swLat, swLon, neLat, neLon)) return [];
  const envelope = `${swLon},${swLat},${neLon},${neLat}`;
  const where = "hiking = '1' OR walking = '1'";
  const url = `${NV_TRAILS_URL}?where=${encodeURIComponent(where)}&geometry=${encodeURIComponent(envelope)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=trailname,trailname2,systemname,trailsurface,difficulty,miles,status&returnGeometry=true&outSR=4326&f=json`;
  try {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) {
      console.error(`NV trails query returned ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (data.error) {
      console.error("NV trails query error:", JSON.stringify(data.error).slice(0, 300));
      return [];
    }
    const byName = new Map();
    (data.features || []).forEach((f) => {
      const a = f.attributes || {};
      if (/clos|propos|planned|abandon|decommission/i.test(String(a.status || ""))) return;
      const pick = (v) => (typeof v === "string" ? v.trim() : "");
      const name = pick(a.trailname) || pick(a.trailname2) || pick(a.systemname);
      if (!name) return;
      const segCoordsList = esriPathsToLatLon(f.geometry);
      if (segCoordsList.length === 0) return;
      const miles = Number(a.miles);
      const lenKm = miles > 0 ? miles * 1.609344 : segmentsLengthKm(segCoordsList);
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += segCoordsList.length;
        existing.segmentsGeom.push(...segCoordsList);
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          difficulty: nvDifficulty(a.difficulty),
          surface: pick(a.trailsurface) || null,
          lat: segCoordsList[0][0][0],
          lon: segCoordsList[0][0][1],
          segments: segCoordsList.length,
          segmentsGeom: segCoordsList,
        });
      }
    });
    return Array.from(byName.values()).map((t) => ({ ...t, distance_km: Math.round(t.distance_km * 10) / 10 }));
  } catch (err) {
    console.error("NV trails lookup failed:", err.message || err);
    return [];
  }
}

// --- Arizona (Arizona State Parks statewide trails, AZSPTrails layer 3) ---
// A compilation of trails open to the public from cities, counties, state,
// federal agencies, and non-profits across Arizona (motorized and
// non-motorized, with a Y/N flag per use). Verified via a real record:
//  - Native spatial reference is UTM zone 12N (102206/3742), so outSR=4326 is
//    requested to get plain lon/lat back.
//  - Use flags are "Y"/"N" strings. Foot = "Y" marks trails open to people on
//    foot, which is what's kept (this includes paved city paths).
//  - TrailName can be blank (stored as a space): fall back to ManagUnit, then
//    Manager (e.g. "City of Yuma"), so the mileage isn't lost.
//  - Miles matched the geometry length in the sample; it's used when positive,
//    otherwise the length is computed from the geometry.
//  - Status was "Verified"; routes whose status says proposed / planned /
//    closed / abandoned are skipped. There's no difficulty field.
const AZ_TRAILS_URL = "https://services1.arcgis.com/UpxtrwRYNaXVpkGe/ArcGIS/rest/services/AZSPTrails/FeatureServer/3/query";
const ARIZONA_BOUNDS = { swLat: 31.3, swLon: -114.9, neLat: 37.05, neLon: -108.95 };
function boundsOverlapArizona(swLat, swLon, neLat, neLon) {
  return swLat <= ARIZONA_BOUNDS.neLat && neLat >= ARIZONA_BOUNDS.swLat &&
    swLon <= ARIZONA_BOUNDS.neLon && neLon >= ARIZONA_BOUNDS.swLon;
}
async function fetchAzTrails(swLat, swLon, neLat, neLon) {
  if (!boundsOverlapArizona(swLat, swLon, neLat, neLon)) return [];
  const envelope = `${swLon},${swLat},${neLon},${neLat}`;
  const where = "Foot = 'Y'";
  const url = `${AZ_TRAILS_URL}?where=${encodeURIComponent(where)}&geometry=${encodeURIComponent(envelope)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=TrailName,ManagUnit,Manager,Surface,Miles,Status&returnGeometry=true&outSR=4326&f=json`;
  try {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "Trailseeker/1.0 (https://github.com/jfunkstl/Trailmarker)" } });
    if (!resp.ok) {
      console.error(`AZ trails query returned ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (data.error) {
      console.error("AZ trails query error:", JSON.stringify(data.error).slice(0, 300));
      return [];
    }
    const byName = new Map();
    (data.features || []).forEach((f) => {
      const a = f.attributes || {};
      if (/propos|planned|clos|abandon|decommission/i.test(String(a.Status || ""))) return;
      const pick = (v) => (typeof v === "string" ? v.trim() : "");
      const name = pick(a.TrailName) || pick(a.ManagUnit) || pick(a.Manager);
      if (!name) return;
      const segCoordsList = esriPathsToLatLon(f.geometry);
      if (segCoordsList.length === 0) return;
      const miles = Number(a.Miles);
      const lenKm = miles > 0 ? miles * 1.609344 : segmentsLengthKm(segCoordsList);
      const existing = byName.get(name);
      if (existing) {
        existing.distance_km += lenKm;
        existing.segments += segCoordsList.length;
        existing.segmentsGeom.push(...segCoordsList);
      } else {
        byName.set(name, {
          name,
          distance_km: lenKm,
          difficulty: "Unknown", // no difficulty field in this layer
          surface: pick(a.Surface) || null,
          lat: segCoordsList[0][0][0],
          lon: segCoordsList[0][0][1],
          segments: segCoordsList.length,
          segmentsGeom: segCoordsList,
        });
      }
    });
    return Array.from(byName.values()).map((t) => ({ ...t, distance_km: Math.round(t.distance_km * 10) / 10 }));
  } catch (err) {
    console.error("AZ trails lookup failed:", err.message || err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Runs every state source for the viewport (in parallel) and returns one
// combined list, in priority order -- earlier sources win when two have the
// same trail name. Each source already returns [] when the viewport isn't in
// its state, and a failure in one never affects the others.
// ---------------------------------------------------------------------------
export async function fetchStateTrails(swLat, swLon, neLat, neLon) {
  const sources = [
    ["COTREX", fetchCotrexTrails],
    ["MDC", fetchMdcTrails],
    ["WA RCO", fetchWaTrails],
    ["USFS", fetchUsfsTrails],
    ["BLM", fetchBlmTrails],
    ["CA State Parks", fetchCaStateParksTrails],
    ["NV", fetchNvTrails],
    ["AZ", fetchAzTrails],
  ];
  const results = await Promise.all(
    sources.map(async ([label, fn]) => {
      try {
        return await fn(swLat, swLon, neLat, neLon);
      } catch (err) {
        console.error(`${label} trails merge failed:`, err.message || err);
        return [];
      }
    })
  );
  return results.flat();
}
