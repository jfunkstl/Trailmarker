// ---------- offline support ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.error("SW registration failed:", err));
  });
}

// Standard slippy-map tile math: converts a lat/lon to the x/y tile
// coordinates OSM uses at a given zoom level.
function latLonToTile(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

// Builds the list of tile URLs covering a bounding box across a zoom range,
// so we can proactively cache a trail's area before you lose signal —
// rather than only caching whatever you happened to scroll past.
function tileUrlsForBounds(points, minZoom, maxZoom) {
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  const minLat = Math.min(...lats) - 0.02, maxLat = Math.max(...lats) + 0.02;
  const minLon = Math.min(...lons) - 0.02, maxLon = Math.max(...lons) + 0.02;
  const urls = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const nw = latLonToTile(maxLat, minLon, z);
    const se = latLonToTile(minLat, maxLon, z);
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) {
        const sub = ["a", "b", "c"][(x + y) % 3];
        urls.push(`https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`);
      }
    }
  }
  return urls;
}

function downloadTrailForOffline(trail, buttonEl) {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
    showToast("Offline support is still starting up — try again in a few seconds");
    return;
  }
  const allPoints = [];
  (trail.geometry || []).forEach((seg) => seg.forEach((pt) => allPoints.push(pt)));
  if (allPoints.length === 0 && trail.lat != null) allPoints.push([trail.lat, trail.lon]);
  if (allPoints.length === 0) {
    showToast("No map data to download for this trail");
    return;
  }
  const urls = tileUrlsForBounds(allPoints, 12, 16);
  const originalText = buttonEl.textContent;
  buttonEl.textContent = `Downloading… 0/${urls.length}`;
  buttonEl.disabled = true;

  const onMessage = (event) => {
    if (event.data.type === "PREFETCH_PROGRESS") {
      buttonEl.textContent = `Downloading… ${event.data.done}/${event.data.total}`;
    } else if (event.data.type === "PREFETCH_DONE") {
      buttonEl.textContent = "Downloaded ✓";
      buttonEl.disabled = false;
      navigator.serviceWorker.removeEventListener("message", onMessage);
      showToast("Map area saved for offline use");
    }
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  navigator.serviceWorker.controller.postMessage({ type: "PREFETCH_TILES", urls });
}

// ---------- API INTEGRATION UTILITIES ----------

/**
 * 1. Overpass API (OpenStreetMap)
 * Fetches hiking trails directly from OSM near a given bounding box.
 */
async function fetchOverpassTrailData(south, west, north, east) {
  const query = `
    [out:json][timeout:25];
    (
      way["highway"~"path|footway|bridleway"]["sac_scale"](${south},${west},${north},${east});
      relation["route"="hiking"](${south},${west},${north},${east});
    );
    out body;
    >;
    out skel qt;
  `;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Overpass API request failed");
    return await res.json();
  } catch (err) {
    console.error("Overpass API Error:", err);
    return null;
  }
}

/**
 * 2. USGS Elevation API
 * Retrieves elevation values for points via USGS Point Query API.
 */
async function fetchUsgsElevation(lat, lon) {
  const url = `https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Feet`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    return data?.value ? parseFloat(data.value) : null;
  } catch (err) {
    console.error("USGS Elevation API Error:", err);
    return null;
  }
}

/**
 * 3. RIDB (Recreation.gov API)
 * Fetches campsite and trailhead facility details. Requires an API key.
 */
async function fetchRidbFacilities(query, apiKey) {
  if (!apiKey) return null;
  const url = `https://ridb.recreation.gov/api/v1/facilities?query=${encodeURIComponent(query)}&limit=10`;
  try {
    const res = await fetch(url, { headers: { apiKey } });
    if (!res.ok) throw new Error("RIDB API request failed");
    return await res.json();
  } catch (err) {
    console.error("RIDB API Error:", err);
    return null;
  }
}

/**
 * 4. Mapbox Directions API
 * Snaps trail markers along walking routes using Mapbox network routing.
 */
async function fetchMapboxSnappedRoute(coordinates, accessToken) {
  if (!accessToken || coordinates.length < 2) return null;
  const coordString = coordinates.map((c) => `${c[1]},${c[0]}`).join(";");
  const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coordString}?geometries=geojson&access_token=${accessToken}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Mapbox Directions API request failed");
    return await res.json();
  } catch (err) {
    console.error("Mapbox API Error:", err);
    return null;
  }
}

/**
 * 5. Thunderforest / OpenCycleMap Topo Tiles
 * Adds topographic trail layers to standard Leaflet maps.
 */
function addOutdoorTopoTileLayer(map, apiKey) {
  if (!apiKey) return;
  const tileUrl = `https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=${apiKey}`;
  L.tileLayer(tileUrl, {
    maxZoom: 18,
    attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/">OSM</a>, Tiles &copy; <a href="https://www.thunderforest.com/">Thunderforest</a>',
  }).addTo(map);
}

// ---------- storage ----------
const HIKES_KEY = "trailmark-hikes";
const WISHLIST_KEY = "trailmark-wishlist";

const loadHikes = () => JSON.parse(localStorage.getItem(HIKES_KEY) || "[]");
const saveHikes = (hikes) => localStorage.setItem(HIKES_KEY, JSON.stringify(hikes));
const loadWishlist = () => JSON.parse(localStorage.getItem(WISHLIST_KEY) || "[]");
const saveWishlist = (list) => localStorage.setItem(WISHLIST_KEY, JSON.stringify(list));

let hikes = loadHikes();
let wishlist = loadWishlist();

// ---------- helpers & geometry utilities ----------
const uid = () => Math.random().toString(36).slice(2, 10);

const fmtTime = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const fmtDist = (meters) => {
  const feet = meters * 3.28084;
  return feet >= 528 ? `${(meters / 1609.34).toFixed(2)} mi` : `${Math.round(feet)} ft`;
};
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

function stateOptionsHtml(selected) {
  return ALL_STATES.map((s) => `<option value="${s}" ${s === selected ? "selected" : ""}>${s}</option>`).join("");
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const la1 = (lat1 * Math.PI) / 180, la2 = (lat2 * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// -------------------------------------------------------------
// 1. chainSegmentsFromStart(segments, startPoint)
// Greedily orders and re-orients segments to maintain contiguous trail flow.
// -------------------------------------------------------------
function chainSegmentsFromStart(segments, startPoint = null) {
  if (!segments || segments.length === 0) return [];
  
  // Clone working pool of segments
  const pool = segments.map((seg) => seg.map((p) => [p[0], p[1]]));
  const chained = [];

  // Determine current endpoint anchor
  let currentPt = startPoint ? [startPoint[0], startPoint[1]] : pool[0][0];

  while (pool.length > 0) {
    let bestIdx = -1;
    let bestDist = Infinity;
    let shouldReverse = false;

    for (let i = 0; i < pool.length; i++) {
      const seg = pool[i];
      if (!seg || seg.length === 0) continue;

      const startPt = seg[0];
      const endPt = seg[seg.length - 1];

      const dStart = haversineKm(currentPt[0], currentPt[1], startPt[0], startPt[1]);
      const dEnd = haversineKm(currentPt[0], currentPt[1], endPt[0], endPt[1]);

      if (dStart < bestDist) {
        bestDist = dStart;
        bestIdx = i;
        shouldReverse = false;
      }
      if (dEnd < bestDist) {
        bestDist = dEnd;
        bestIdx = i;
        shouldReverse = true;
      }
    }

    if (bestIdx === -1) break;

    let chosenSeg = pool.splice(bestIdx, 1)[0];
    if (shouldReverse) {
      chosenSeg.reverse();
    }

    chained.push(chosenSeg);
    currentPt = chosenSeg[chosenSeg.length - 1];
  }

  return chained;
}

// -------------------------------------------------------------
// 2. validateGeometry(geometry)
// Ensures state integrity, valid coordinate ranges, and point counts.
// -------------------------------------------------------------
function validateGeometry(geometry) {
  if (!geometry || !Array.isArray(geometry) || geometry.length === 0) {
    showToast("Invalid geometry: Trail must contain at least one segment.");
    return false;
  }

  for (let i = 0; i < geometry.length; i++) {
    const seg = geometry[i];
    if (!Array.isArray(seg) || seg.length < 2) {
      showToast(`Invalid segment #${i + 1}: Must contain at least 2 coordinate points.`);
      return false;
    }

    for (let j = 0; j < seg.length; j++) {
      const pt = seg[j];
      if (!Array.isArray(pt) || pt.length < 2) {
        showToast(`Invalid point in segment #${i + 1}: Coordinate pair required.`);
        return false;
      }

      const [lat, lon] = pt;
      if (typeof lat !== "number" || typeof lon !== "number" || isNaN(lat) || isNaN(lon)) {
        showToast("Invalid coordinate value detected.");
        return false;
      }

      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        showToast("Coordinates out of valid geographical bounds.");
        return false;
      }
    }
  }

  return true;
}

function updateStatLine() {
  const total = hikes.reduce((s, h) => s + (h.distance || 0), 0);
  document.getElementById("statLine").textContent = `${hikes.length} hikes logged · ${fmtDist(total)} total`;
}

// ---------- tab switching ----------
const tabs = ["discover", "create", "track", "journal"];
function switchTab(tab) {
  tabs.forEach((t) => {
    document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  if (tab === "track") setTimeout(() => { ensureTrackMap(); trackMap.invalidateSize(); }, 50);
  if (tab === "create") setTimeout(() => { ensureCreateMap(); createMap.invalidateSize(); }, 50);
}
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ---------- modal ----------
const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");

const modalPanel = document.getElementById("modalPanel");
const modalMaximizeBtn = document.getElementById("modalMaximize");
let modalMaximized = false;
let activeModalMap = null; // the Leaflet instance currently shown in the modal, if any

const MODAL_COMPACT_CLASSES = "relative bg-paper w-full sm:max-w-md sm:rounded-3xl rounded-t-3xl max-h-[85vh] overflow-y-auto p-5 transition-all duration-200";
const MODAL_MAX_CLASSES = "relative bg-paper w-full h-[92vh] max-h-[92vh] sm:max-w-2xl rounded-3xl overflow-y-auto p-5 transition-all duration-200";
const MAP_COMPACT_HEIGHT = "300px";
const MAP_MAX_HEIGHT = "calc(92vh - 130px)";

function openModal(title, bodyHtml, options = {}) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalOverlay.classList.remove("hidden");
  modalMaximized = false;
  modalPanel.className = MODAL_COMPACT_CLASSES;
  modalMaximizeBtn.classList.toggle("hidden", !options.mapModal);
  modalMaximizeBtn.textContent = "⤢";
  document.getElementById("modalPencil").classList.toggle("hidden", !options.editable);
  document.getElementById("modalEditPencil").classList.add("hidden");
  document.getElementById("modalEditEraser").classList.add("hidden");
  document.getElementById("modalEditAdd").classList.add("hidden");
}
function closeModal() {
  modalOverlay.classList.add("hidden");
  modalBody.innerHTML = "";
  activeModalMap = null;
  modalMaximized = false;
  if (editMapInstance) { editMapInstance.remove(); editMapInstance = null; }
  modalEditingTrail = null;
  editSegments = [];
  document.getElementById("modalPencil").classList.add("hidden");
  document.getElementById("modalEditPencil").classList.add("hidden");
  document.getElementById("modalEditEraser").classList.add("hidden");
}
document.getElementById("modalClose").addEventListener("click", closeModal);
modalMaximizeBtn.addEventListener("click", () => {
  modalMaximized = !modalMaximized;
  modalPanel.className = modalMaximized ? MODAL_MAX_CLASSES : MODAL_COMPACT_CLASSES;
  modalMaximizeBtn.textContent = modalMaximized ? "⤡" : "⤢";
  const mapEl = document.getElementById("modalMapContainer");
  if (mapEl) mapEl.style.height = modalMaximized ? MAP_MAX_HEIGHT : MAP_COMPACT_HEIGHT;
  setTimeout(() => {
    if (!activeModalMap) return;
    activeModalMap.invalidateSize();
    if (activeModalMap._fitBounds) activeModalMap.fitBounds(activeModalMap._fitBounds, { padding: [20, 20] });
  }, 210);
});
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });

// ================= TRACK =================
let tracking = false;
let distance = 0;
let elapsed = 0;
let path = [];
let lastPoint = null;
let watchId = null;
let timerId = null;
let followedTrail = null; // saved trail currently shown as the target route

const trackBtn = document.getElementById("trackBtn");
const trackBtnIcon = document.getElementById("trackBtnIcon");
const timerDisplay = document.getElementById("timerDisplay");
const distanceDisplay = document.getElementById("distanceDisplay");
const trackState = document.getElementById("trackState");
const gpsNote = document.getElementById("gpsNote");
const statDistance = document.getElementById("statDistance");
const statTime = document.getElementById("statTime");
const statCalories = document.getElementById("statCalories");
const trailPicker = document.getElementById("trailPicker");

const caloriesFromKm = (km) => Math.round(km * 62);

let trackMap = null;
let routeLine = null; // the saved/target trail, drawn once
let walkedLine = null; // the live path you've actually walked
let liveDot = null;

function ensureTrackMap() {
  if (trackMap) return trackMap;
  trackMap = L.map("trackMap", { attributionControl: false }).setView([39.5, -98.35], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(trackMap);
  walkedLine = L.polyline([], { color: "#2563EB", weight: 5 }).addTo(trackMap);
  return trackMap;
}

function populateTrailPicker() {
  const current = trailPicker.value;
  trailPicker.innerHTML = `<option value="">Freestyle (no saved route)</option>` +
    wishlist.filter((w) => w.geometry).map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("");
  if (wishlist.some((w) => w.id === current)) trailPicker.value = current;
}

function selectTrailToFollow(id) {
  followedTrail = wishlist.find((w) => w.id === id) || null;
  const offlineBtn = document.getElementById("trackOfflineBtn");
  offlineBtn.classList.toggle("hidden", !followedTrail);
  offlineBtn.onclick = followedTrail ? (e) => downloadTrailForOffline(followedTrail, e.target) : null;

  setTimeout(() => {
    const map = ensureTrackMap();
    map.invalidateSize();
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }

    if (followedTrail && followedTrail.geometry) {
      const bounds = [];
      const group = L.layerGroup();
      followedTrail.geometry.forEach((seg) => {
        if (seg.length < 2) return;
        L.polyline(seg, { color: "#1B4332", weight: 4 }).addTo(group);
        seg.forEach((pt) => bounds.push(pt));
      });
      routeLine = group.addTo(map);
      if (bounds.length) map.fitBounds(bounds, { padding: [24, 24] });
      trackState.textContent = tracking ? "Tracking" : `Following ${followedTrail.name}`;
    } else {
      trackState.textContent = tracking ? "Tracking" : "Ready when you are";
      map.setView([39.5, -98.35], 4);
    }
  }, 60);
}

trailPicker.addEventListener("change", () => selectTrailToFollow(trailPicker.value));

function updateLiveStats() {
  statDistance.textContent = fmtDist(distance);
  statTime.textContent = fmtTime(elapsed);
  statCalories.textContent = String(caloriesFromKm(distance / 1000));
}

function startTracking() {
  distance = 0; elapsed = 0; path = []; lastPoint = null;
  tracking = true;
  gpsNote.classList.remove("show");
  trackBtn.classList.add("recording");
  trackBtnIcon.textContent = "■";
  trackState.textContent = followedTrail ? `Tracking ${followedTrail.name}` : "Tracking";
  timerDisplay.textContent = fmtTime(0);
  distanceDisplay.textContent = fmtDist(0);
  updateLiveStats();

  const map = ensureTrackMap();
  if (walkedLine) walkedLine.setLatLngs([]);

  timerId = setInterval(() => {
    elapsed += 1;
    timerDisplay.textContent = fmtTime(elapsed);
    updateLiveStats();
  }, 1000);

  if (navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        path.push(p);
        if (lastPoint) {
          const d = haversineKm(lastPoint.lat, lastPoint.lng, p.lat, p.lng) * 1000;
          if (d > 0.5) {
            distance += d;
            distanceDisplay.textContent = fmtDist(distance);
            updateLiveStats();
          }
        }
        lastPoint = p;
        walkedLine.addLatLng([p.lat, p.lng]);
        if (!liveDot) {
          liveDot = L.circleMarker([p.lat, p.lng], { radius: 7, color: "#1e3a8a", fillColor: "#2563EB", fillOpacity: 1, weight: 2 }).addTo(map);
        } else {
          liveDot.setLatLng([p.lat, p.lng]);
        }
        map.panTo([p.lat, p.lng]);
      },
      () => {
        gpsNote.textContent = "Location unavailable — you can still time the hike and log distance by hand.";
        gpsNote.classList.add("show");
      },
      { enableHighAccuracy: true, maximumAge: 1000 }
    );
  } else {
    gpsNote.textContent = "This browser can't share location — timing only.";
    gpsNote.classList.add("show");
  }
}

function stopTracking() {
  tracking = false;
  clearInterval(timerId);
  if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  trackBtn.classList.remove("recording");
  trackBtnIcon.textContent = "▶";
  trackState.textContent = followedTrail ? `Following ${followedTrail.name}` : "Ready when you are";
  openSaveTrackModal();
}

function openSaveTrackModal() {
  openModal("Save this hike", `
    <p class="font-condensed text-lg text-pine flex gap-5 mb-3.5">
      <span>${fmtDist(distance)}</span><span>${fmtTime(elapsed)}</span><span>${caloriesFromKm(distance / 1000)} cal</span>
    </p>
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Name</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="trackName" placeholder="Ridge Trail loop" value="${followedTrail ? escapeHtml(followedTrail.name) : ""}" autofocus /></label>
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Notes</span><textarea class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="trackNotes" rows="3" placeholder="Muddy near the summit, worth it for the view"></textarea></label>
    <div class="flex gap-2 mt-4">
      <button id="discardTrackBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Discard</button>
      <button id="saveTrackBtn" class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition">Save</button>
    </div>
  `);
  document.getElementById("discardTrackBtn").addEventListener("click", () => {
    distance = 0; elapsed = 0; path = [];
    updateLiveStats();
    timerDisplay.textContent = fmtTime(0);
    distanceDisplay.textContent = fmtDist(0);
    closeModal();
  });
  document.getElementById("saveTrackBtn").addEventListener("click", () => {
    const name = document.getElementById("trackName").value.trim() || "Untitled hike";
    const notes = document.getElementById("trackNotes").value.trim();
    hikes = [{ id: uid(), date: new Date().toISOString(), name, distance, duration: elapsed, notes, path, source: "tracked" }, ...hikes];
    saveHikes(hikes);
    distance = 0; elapsed = 0; path = [];
    updateLiveStats();
    timerDisplay.textContent = fmtTime(0);
    distanceDisplay.textContent = fmtDist(0);
    closeModal();
    showToast("Hike saved to your journal");
    updateStatLine();
    renderJournal();
    switchTab("journal");
  });
}

trackBtn.addEventListener("click", () => (tracking ? stopTracking() : startTracking()));

// ================= SHARED TRAIL-EDITING ENGINE =================
const SNAP_RADIUS_PX = 15;

const startIcon = L.divIcon({
  html: `<div style="font-size: 20px; text-shadow: 0 1px 3px rgba(0,0,0,0.5);">🟢</div>`,
  className: "waypoint-marker-start",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

const endIcon = L.divIcon({
  html: `<div style="font-size: 20px; text-shadow: 0 1px 3px rgba(0,0,0,0.5);">🔵</div>`,
  className: "waypoint-marker-end",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

// Option A: Split / Half-and-Half Custom SVG Icon for overlapping start/end points
const startEndSplitIcon = L.divIcon({
  html: `
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0px 2px 4px rgba(0,0,0,0.4));">
      <circle cx="14" cy="14" r="12" fill="white" stroke="#1B4332" stroke-width="2"/>
      <path d="M 14 2 A 12 12 0 0 0 14 26 Z" fill="#22C55E"/>
      <path d="M 14 2 A 12 12 0 0 1 14 26 Z" fill="#3B82F6"/>
    </svg>
  `,
  className: "waypoint-marker-split",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

function makeEditor(map) {
  return {
    map,
    segments: [],
    mode: "pencil",
    polylineLayer: null,
    markerGroup: L.layerGroup().addTo(map),
    waypointGroup: L.layerGroup().addTo(map),
    snapIndicator: null,
    freshSegment: true,
    startCutIndex: 0,
    endCutIndex: null,
    onTrailChange: null,
  };
}

function editorFindSnapCandidate(editor, latlng) {
  if (!editor.map || editor.segments.length === 0) return null;
  const clickPt = editor.map.latLngToContainerPoint(latlng);

  let bestSnap = null;
  let minDistance = SNAP_RADIUS_PX;

  editor.segments.forEach((seg, segIdx) => {
    if (!seg || seg.length === 0) return;

    const endpoints = [
      { point: seg[0], ptIndex: 0, isStart: true },
      { point: seg[seg.length - 1], ptIndex: seg.length - 1, isStart: false },
    ];

    endpoints.forEach(({ point, ptIndex }) => {
      const screenPt = editor.map.latLngToContainerPoint(point);
      const dist = Math.hypot(screenPt.x - clickPt.x, screenPt.y - clickPt.y);

      if (dist <= minDistance) {
        minDistance = dist;
        bestSnap = {
          latlng: point,
          segIndex: segIdx,
          ptIndex: ptIndex,
        };
      }
    });
  });

  return bestSnap;
}

function mergeTopology(segments) {
  if (!segments || segments.length <= 1) return segments;

  let pool = segments.map((s) => [...s]);
  let merged = true;

  while (merged && pool.length > 1) {
    merged = false;

    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const segA = pool[i];
        const segB = pool[j];

        const aStart = segA[0];
        const aEnd = segA[segA.length - 1];
        const bStart = segB[0];
        const bEnd = segB[segB.length - 1];

        if (aEnd[0] === bStart[0] && aEnd[1] === bStart[1]) {
          pool[i] = segA.concat(segB.slice(1));
          pool.splice(j, 1);
          merged = true;
          break;
        } else if (aEnd[0] === bEnd[0] && aEnd[1] === bEnd[1]) {
          pool[i] = segA.concat(segB.slice(0, -1).reverse());
          pool.splice(j, 1);
          merged = true;
          break;
        } else if (aStart[0] === bEnd[0] && aStart[1] === bEnd[1]) {
          pool[i] = segB.concat(segA.slice(1));
          pool.splice(j, 1);
          merged = true;
          break;
        } else if (aStart[0] === bStart[0] && aStart[1] === bStart[1]) {
          pool[i] = segB.reverse().concat(segA.slice(1));
          pool.splice(j, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }

  return pool;
}

function editorRedraw(editor) {
  editor.segments = mergeTopology(editor.segments);

  if (!editor.polylineLayer) {
    editor.polylineLayer = L.polyline(editor.segments, { color: "#1B4332", weight: 5 }).addTo(editor.map);
  } else {
    editor.polylineLayer.setLatLngs(editor.segments);
  }

  editor.markerGroup.clearLayers();
  editor.segments.forEach((seg) => {
    seg.forEach((p, i) => {
      const isEndpoint = i === 0 || i === seg.length - 1;
      L.circleMarker(p, {
        radius: isEndpoint ? 6 : 4,
        color: "#ffffff",
        weight: 2,
        fillColor: "#1B4332",
        fillOpacity: 1,
      }).addTo(editor.markerGroup);
    });
  });

  editorUpdateWaypoints(editor);

  if (editor.onTrailChange) {
    editor.onTrailChange();
  }
}

function editorUpdateWaypoints(editor) {
  editor.waypointGroup.clearLayers();

  const flatPoints = getActiveTrimmedPolyline(editor);
  if (flatPoints.length < 2) return;

  const startPt = flatPoints[0];
  const endPt = flatPoints[flatPoints.length - 1];

  // Option A Solution: Render a single dual-color marker when startLat = endLat and startLng = endLng
  const isOverlapping = startPt[0] === endPt[0] && startPt[1] === endPt[1];

  if (isOverlapping) {
    const splitMarker = L.marker(startPt, { icon: startEndSplitIcon, draggable: true }).addTo(editor.waypointGroup);
    splitMarker.on("dragend", (e) => {
      const snap = editorFindSnapCandidate(editor, e.target.getLatLng());
      const allFlat = editor.segments.flat();

      if (snap) {
        const snapIdx = allFlat.findIndex((p) => p[0] === snap.latlng[0] && p[1] === snap.latlng[1]);
        if (snapIdx !== -1) {
          editor.startCutIndex = snapIdx;
          editor.endCutIndex = snapIdx;
        }
      }

      editorRedraw(editor);
    });
  } else {
    const startMarker = L.marker(startPt, { icon: startIcon, draggable: true }).addTo(editor.waypointGroup);
    const endMarker = L.marker(endPt, { icon: endIcon, draggable: true }).addTo(editor.waypointGroup);

    startMarker.on("dragend", (e) => {
      const snap = editorFindSnapCandidate(editor, e.target.getLatLng());
      const allFlat = editor.segments.flat();

      if (snap) {
        const snapIdx = allFlat.findIndex((p) => p[0] === snap.latlng[0] && p[1] === snap.latlng[1]);
        if (snapIdx !== -1) editor.startCutIndex = snapIdx;
      }

      editorRedraw(editor);
    });

    endMarker.on("dragend", (e) => {
      const snap = editorFindSnapCandidate(editor, e.target.getLatLng());
      const allFlat = editor.segments.flat();

      if (snap) {
        const snapIdx = allFlat.findIndex((p) => p[0] === snap.latlng[0] && p[1] === snap.latlng[1]);
        if (snapIdx !== -1) editor.endCutIndex = snapIdx;
      }

      editorRedraw(editor);
    });
  }
}

function getActiveTrimmedPolyline(editor) {
  const chained = chainSegmentsFromStart(editor.segments);
  const flat = chained.flat();

  if (flat.length === 0) return [];

  let start = editor.startCutIndex || 0;
  let end = editor.endCutIndex !== null && editor.endCutIndex !== undefined ? editor.endCutIndex : flat.length - 1;

  if (start > end) {
    const temp = start;
    start = end;
    end = temp;
  }

  return flat.slice(start, end + 1);
}

function editorClick(editor, latlng) {
  let targetPoint = [latlng.lat, latlng.lng];

  if (editor.mode === "pencil") {
    const snap = editorFindSnapCandidate(editor, latlng);
    if (snap) {
      targetPoint = [snap.latlng[0], snap.latlng[1]];
    }

    if (editor.segments.length === 0 || editor.freshSegment) {
      editor.segments.push([]);
      editor.freshSegment = false;
    }

    editor.segments[editor.segments.length - 1].push(targetPoint);
    editor.endCutIndex = null;
    editorRedraw(editor);
  } else if (editor.mode === "eraser") {
    editorEraseNear(editor, latlng);
  }
}

function editorEraseNear(editor, latlng) {
  const tapPoint = editor.map.latLngToContainerPoint(latlng);
  const RADIUS_PX = 24;
  const isNear = (p) => {
    const pt = editor.map.latLngToContainerPoint(p);
    return Math.hypot(pt.x - tapPoint.x, pt.y - tapPoint.y) <= RADIUS_PX;
  };
  const newSegments = [];
  editor.segments.forEach((seg) => {
    let current = [];
    seg.forEach((p) => {
      if (isNear(p)) {
        if (current.length >= 2) newSegments.push(current);
        current = [];
      } else {
        current.push(p);
      }
    });
    if (current.length >= 2) newSegments.push(current);
  });
  editor.segments = newSegments;
  editor.startCutIndex = 0;
  editor.endCutIndex = null;
  editorRedraw(editor);
}

function editorUndo(editor) {
  if (editor.segments.length === 0) return;
  const last = editor.segments[editor.segments.length - 1];
  last.pop();
  if (last.length === 0) editor.segments.pop();
  editor.startCutIndex = 0;
  editor.endCutIndex = null;
  editorRedraw(editor);
}

function editorClear(editor) {
  editor.segments = [];
  editor.freshSegment = true;
  editor.startCutIndex = 0;
  editor.endCutIndex = null;
  editorRedraw(editor);
}

function editorAddSegments(editor, geometry) {
  if (!geometry) return;
  geometry.forEach((seg) => editor.segments.push(seg.map((p) => [p[0], p[1]])));
  editor.freshSegment = true;
  editor.startCutIndex = 0;
  editor.endCutIndex = null;
  editorRedraw(editor);
  const allPts = editor.segments.flat();
  if (allPts.length) {
    setTimeout(() => { editor.map.invalidateSize(); editor.map.fitBounds(allPts, { padding: [20, 20] }); }, 30);
  }
}

function editorDistanceKm(editor) {
  const activePolyline = getActiveTrimmedPolyline(editor);
  let km = 0;
  for (let i = 1; i < activePolyline.length; i++) {
    km += haversineKm(
      activePolyline[i - 1][0],
      activePolyline[i - 1][1],
      activePolyline[i][0],
      activePolyline[i][1]
    );
  }
  return km;
}

function editorSetMode(editor, mode, pencilBtn, eraserBtn) {
  editor.mode = mode;
  if (mode === "pencil") editor.freshSegment = true;
  pencilBtn.classList.toggle("bg-pine", mode === "pencil");
  pencilBtn.classList.toggle("text-white", mode === "pencil");
  eraserBtn.classList.toggle("bg-pine", mode === "eraser");
  eraserBtn.classList.toggle("text-white", mode === "eraser");
}

function openAddSavedTrailPicker(onPick, container = modalPanel) {
  const savedWithGeometry = wishlist.filter((w) => w.geometry);
  if (savedWithGeometry.length === 0) {
    showToast("No saved trails with map data yet");
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "absolute inset-0 bg-paper z-[1200] p-4 overflow-y-auto rounded-3xl";
  overlay.innerHTML = `
    <p class="font-condensed uppercase tracking-wide text-xs opacity-60 mb-2">Add a saved trail</p>
    <div class="flex flex-col gap-2">
      ${savedWithGeometry.map((w, i) => `
        <button data-pick-idx="${i}" class="text-left bg-card border border-line rounded-xl px-3 py-2.5 hover:bg-chipbg transition">
          <span class="font-condensed font-semibold">${escapeHtml(w.name)}</span>
          <span class="text-xs opacity-60 block">${escapeHtml(w.location || "")}</span>
        </button>
      `).join("")}
    </div>
    <button id="pickCancelBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition mt-3 w-full">Cancel</button>
  `;
  container.appendChild(overlay);
  overlay.querySelector("#pickCancelBtn").addEventListener("click", () => overlay.remove());
  overlay.querySelectorAll("[data-pick-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      onPick(savedWithGeometry[Number(btn.dataset.pickIdx)]);
      overlay.remove();
    });
  });
}

// ================= CREATE =================
let createMap = null;
let createEditor = null;

function ensureCreateMap() {
  if (createMap) return createMap;
  createMap = L.map("createMap").setView([39.5, -98.35], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(createMap);
  createEditor = makeEditor(createMap);
  createEditor.onTrailChange = () => updateCreateStats();
  
  createMap.on("mousemove", (e) => {
    if (createEditor.mode !== "pencil") return;
    const snap = editorFindSnapCandidate(createEditor, e.latlng);

    if (snap) {
      if (!createEditor.snapIndicator) {
        createEditor.snapIndicator = L.circleMarker(snap.latlng, {
          radius: 8,
          color: "#2563EB",
          fillColor: "#60A5FA",
          fillOpacity: 0.8,
          weight: 2,
        }).addTo(createMap);
      } else {
        createEditor.snapIndicator.setLatLng(snap.latlng);
      }
    } else if (createEditor.snapIndicator) {
      createMap.removeLayer(createEditor.snapIndicator);
      createEditor.snapIndicator = null;
    }
  });

  createMap.on("click", (e) => {
    editorClick(createEditor, e.latlng);
    updateCreateStats();
  });
  editorSetMode(createEditor, "pencil", document.getElementById("createPencilModeBtn"), document.getElementById("createEraserModeBtn"));
  return createMap;
}

function updateCreateStats() {
  const activePolyline = getActiveTrimmedPolyline(createEditor);
  document.getElementById("createPointCount").textContent = String(activePolyline.length);
  document.getElementById("createDistance").textContent = fmtDist(editorDistanceKm(createEditor) * 1000);
}

function populateCreateBasePicker() {
  const current = document.getElementById("createBasePicker").value;
  const picker = document.getElementById("createBasePicker");
  picker.innerHTML = `<option value="">Freestyle (blank map)</option>` +
    wishlist.filter((w) => w.geometry).map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("");
  if (wishlist.some((w) => w.id === current)) picker.value = current;
}

document.getElementById("createBasePicker").addEventListener("change", (e) => {
  ensureCreateMap();
  const id = e.target.value;
  editorClear(createEditor);
  if (!id) {
    createMap.setView([39.5, -98.35], 4);
    document.getElementById("createHint").textContent = "Tap the map to add points to your route.";
    updateCreateStats();
    return;
  }
  const base = wishlist.find((w) => w.id === id);
  if (!base || !base.geometry) return;
  editorAddSegments(createEditor, base.geometry);
  document.getElementById("createHint").textContent = `Starting from ${base.name} — tap the map to extend the route.`;
  updateCreateStats();
});

document.getElementById("createPencilModeBtn").addEventListener("click", () => {
  ensureCreateMap();
  editorSetMode(createEditor, "pencil", document.getElementById("createPencilModeBtn"), document.getElementById("createEraserModeBtn"));
});
document.getElementById("createEraserModeBtn").addEventListener("click", () => {
  ensureCreateMap();
  editorSetMode(createEditor, "eraser", document.getElementById("createPencilModeBtn"), document.getElementById("createEraserModeBtn"));
});
document.getElementById("createAddSavedBtn").addEventListener("click", () => {
  ensureCreateMap();
  openAddSavedTrailPicker((picked) => {
    editorAddSegments(createEditor, picked.geometry);
    document.getElementById("createHint").textContent = `Added ${picked.name} — draw or erase to connect them.`;
    updateCreateStats();
  }, document.getElementById("createMapWrap"));
});

document.getElementById("createUndoBtn").addEventListener("click", () => {
  editorUndo(createEditor);
  updateCreateStats();
});

document.getElementById("createClearBtn").addEventListener("click", () => {
  editorClear(createEditor);
  document.getElementById("createBasePicker").value = "";
  document.getElementById("createHint").textContent = "Tap the map to add points to your route.";
  updateCreateStats();
});

document.getElementById("createSaveBtn").addEventListener("click", () => {
  const activePolyline = getActiveTrimmedPolyline(createEditor);
  const activeSegments = [activePolyline];

  if (!validateGeometry(activeSegments)) {
    return;
  }

  const chainedSegments = chainSegmentsFromStart(activeSegments);
  const km = editorDistanceKm(createEditor);
  openModal("Save your route", `
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Name</span><input id="createName" class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" placeholder="My custom loop" autofocus /></label>
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">State</span><select id="createState" class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm">${stateOptionsHtml("Colorado")}</select></label>
    <p class="text-sm opacity-70 mb-3">${(km * 0.621371).toFixed(1)} mi · ${chainedSegments.length} segment${chainedSegments.length !== 1 ? "s" : ""}</p>
    <div class="flex gap-2 mt-4">
      <button id="createCancelBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Cancel</button>
      <button id="createConfirmBtn" class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition w-full">Save</button>
    </div>
  `);
  document.getElementById("createCancelBtn").addEventListener("click", closeModal);
  document.getElementById("createConfirmBtn").addEventListener("click", () => {
    const name = document.getElementById("createName").value.trim() || "Untitled route";
    const state = document.getElementById("createState").value;
    const firstPt = chainedSegments[0][0];
    wishlist = [{
      id: uid(),
      name,
      location: state,
      notes: `${(km * 0.621371).toFixed(1)} mi · custom drawn route`,
      osm_url: null,
      geometry: chainedSegments.map((seg) => seg.map((p) => [p[0], p[1]])),
      lat: firstPt[0],
      lon: firstPt[1],
      distance_km: km,
      custom: true,
    }, ...wishlist];
    saveWishlist(wishlist);
    populateTrailPicker();
    populateCreateBasePicker();
    closeModal();
    showToast("Route saved — find it in Track or your Saved list");
  });
});

// ================= JOURNAL =================
function renderJournal() {
  const list = document.getElementById("journalList");
  if (hikes.length === 0) {
    list.innerHTML = `<div class="text-center text-sm opacity-60 py-8">No hikes logged yet. Track one, or add a past hike by hand.</div>`;
    return;
  }
  list.innerHTML = hikes.map((h) => `
    <div class="relative bg-card border border-line rounded-2xl p-4">
      <button class="absolute top-3 right-3 w-7 h-7 rounded-full bg-chipbg flex items-center justify-center text-sm z-10" data-delete-hike="${h.id}" aria-label="Delete hike">✕</button>
      <p class="font-condensed text-xs uppercase tracking-wide opacity-60">${fmtDate(h.date)}</p>
      <h3>${escapeHtml(h.name)}</h3>
      <div class="flex flex-wrap gap-2 my-2">
        <span>${fmtDist(h.distance || 0)}</span>
        <span>${fmtTime(h.duration || 0)}</span>
      </div>
      ${h.notes ? `<p class="text-sm opacity-70 mt-1">${escapeHtml(h.notes)}</p>` : ""}
    </div>
  `).join("");

  list.querySelectorAll("[data-delete-hike]").forEach((btn) => {
    btn.addEventListener("click", () => {
      hikes = hikes.filter((h) => h.id !== btn.dataset.deleteHike);
      saveHikes(hikes);
      renderJournal();
      updateStatLine();
    });
  });
}

document.getElementById("addHikeBtn").addEventListener("click", () => {
  openModal("Add a hike", `
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Name</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="manName" placeholder="Blue Ridge overlook" autofocus /></label>
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Date</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="manDate" type="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
    <div class="flex gap-2.5">
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Distance (miles)</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="manDist" type="number" step="0.1" placeholder="5.3" /></label>
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Hours</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="manH" type="number" placeholder="2" /></label>
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Min</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="manM" type="number" placeholder="30" /></label>
    </div>
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Notes</span><textarea class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="manNotes" rows="2"></textarea></label>
    <div class="flex gap-2 mt-4">
      <button id="manSaveBtn" class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition w-full">Save hike</button>
    </div>
  `);
  document.getElementById("manSaveBtn").addEventListener("click", () => {
    const name = document.getElementById("manName").value.trim();
    if (!name) return;
    const date = document.getElementById("manDate").value;
    const distMi = Math.max(0, parseFloat(document.getElementById("manDist").value) || 0);
    const h = parseInt(document.getElementById("manH").value) || 0;
    const m = parseInt(document.getElementById("manM").value) || 0;
    const notes = document.getElementById("manNotes").value.trim();
    hikes = [{ id: uid(), date: date ? new Date(date).toISOString() : new Date().toISOString(), name, distance: distMi * 1609.34, duration: h * 3600 + m * 60, notes, path: null, source: "manual" }, ...hikes];
    saveHikes(hikes);
    closeModal();
    showToast("Hike added");
    renderJournal();
    updateStatLine();
  });
});

// ================= DISCOVER =================
let currentView = "search";
let currentDifficulty = "All";
let lastResults = [];
let searchMode = "name";

document.querySelectorAll("#searchModeToggle .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#searchModeToggle .seg").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    searchMode = btn.dataset.mode;
    const input = document.getElementById("query");
    input.placeholder = searchMode === "city" ? "Search a city (e.g. Boulder)"
      : searchMode === "parks" ? "Search park name (optional)"
      : searchMode === "reccons" ? "Search area name (optional)"
      : searchMode === "usa" ? "Search trail name (e.g. Appalachian Trail)"
      : "Search trail name (optional)";
    document.getElementById("difficultyFilters").classList.toggle("hidden", searchMode === "parks" || searchMode === "reccons" || searchMode === "usa");
    document.getElementById("state").classList.toggle("hidden", searchMode === "usa");
  });
});

document.querySelectorAll("#viewToggle .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#viewToggle .seg").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentView = btn.dataset.view;
    document.getElementById("discoverSearch").classList.toggle("hidden", currentView !== "search");
    document.getElementById("discoverSaved").classList.toggle("hidden", currentView !== "saved");
    if (currentView === "saved") renderSaved();
  });
});

let ALL_STATES = [];
async function loadStates() {
  const select = document.getElementById("state");
  try {
    const res = await fetch("/api/states");
    const { states } = await res.json();
    ALL_STATES = states;
    select.innerHTML = states.map((s) => `<option value="${s}">${s}</option>`).join("");
    select.value = "Colorado";
  } catch {
    ALL_STATES = ["Colorado"];
    select.innerHTML = `<option value="Colorado">Colorado</option>`;
  }
}

function renderSearchResults(trails) {
  const filtered = currentDifficulty === "All" ? trails : trails.filter((t) => t.difficulty === currentDifficulty);
  const el = document.getElementById("results");
  if (filtered.length === 0) {
    el.innerHTML = `<div class="text-center text-sm opacity-60 py-8">No trails matched. Try a different state, search term, or difficulty.</div>`;
    return;
  }
  el.innerHTML = filtered.map((t, i) => `
    <div class="relative bg-card border border-line rounded-2xl p-4">
      <p class="font-condensed text-xs uppercase tracking-wide opacity-60">${escapeHtml(t.state)}${t.segments > 1 ? ` · ${t.segments} mapped segments` : ""}</p>
      <h3 class="font-display text-lg cursor-pointer underline decoration-line underline-offset-4 block" data-detail-idx="${i}">${escapeHtml(t.name)}</h3>
      <div class="flex flex-wrap gap-2 my-2">
        <span>${(t.distance_km * 0.621371).toFixed(1)} mi</span>
        <span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${t.difficulty}</span>
        ${t.surface ? `<span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${escapeHtml(t.surface)}</span>` : ""}
      </div>
      <div class="flex gap-2 mt-3 flex-wrap">
        <button class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition" data-map-idx="${i}">Map</button>
        <button class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition" data-save-idx="${i}">Save</button>
        <button class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition" data-log-idx="${i}">Log as hiked</button>
      </div>
      <a class="block text-sm text-pine underline mt-2" href="${t.osm_url}" target="_blank" rel="noopener">View on OpenStreetMap →</a>
    </div>
  `).join("");

  el.querySelectorAll("[data-detail-idx]").forEach((el2) => {
    el2.addEventListener("click", () => openTrailDetail(filtered[Number(el2.dataset.detailIdx)]));
  });
  el.querySelectorAll("[data-map-idx]").forEach((btn) => {
    btn.addEventListener("click", () => openTrailMapModal(filtered[Number(btn.dataset.mapIdx)]));
  });
  el.querySelectorAll("[data-save-idx]").forEach((btn) => {
    btn.addEventListener("click", () => saveToWishlist(filtered[Number(btn.dataset.saveIdx)]));
  });
  el.querySelectorAll("[data-log-idx]").forEach((btn) => {
    btn.addEventListener("click", () => openCompleteModal(filtered[Number(btn.dataset.logIdx)]));
  });
}

function renderRecConsResults(areas) {
  const el = document.getElementById("results");
  if (areas.length === 0) {
    el.innerHTML = `<div class="text-center text-sm opacity-60 py-8">No National Forest or BLM areas matched. Try a different state or search term.</div>`;
    return;
  }
  el.innerHTML = areas.map((a, i) => `
    <div class="relative bg-card border border-line rounded-2xl p-4">
      <p class="font-condensed text-xs uppercase tracking-wide opacity-60">${escapeHtml(a.state)}</p>
      <h3 class="font-display text-lg cursor-pointer underline decoration-line underline-offset-4 block" data-rc-detail-idx="${i}">${escapeHtml(a.name)}</h3>
      <div class="flex flex-wrap gap-2 my-2"><span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${escapeHtml(a.kind)}</span></div>
      <div class="flex gap-2 mt-3 flex-wrap">
        <button class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition" data-rc-map-idx="${i}">Map</button>
        <button class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition" data-rc-save-idx="${i}">Save</button>
      </div>
      <a class="block text-sm text-pine underline mt-2" href="${a.osm_url}" target="_blank" rel="noopener">View on OpenStreetMap →</a>
    </div>
  `).join("");

  el.querySelectorAll("[data-rc-detail-idx]").forEach((el2) => {
    el2.addEventListener("click", () => openParkDetail(areas[Number(el2.dataset.rcDetailIdx)]));
  });
  el.querySelectorAll("[data-rc-map-idx]").forEach((btn) => {
    btn.addEventListener("click", () => openParkMapModal(areas[Number(btn.dataset.rcMapIdx)]));
  });
  el.querySelectorAll("[data-rc-save-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const a = areas[Number(btn.dataset.rcSaveIdx)];
      saveToWishlist({ name: a.name, state: a.state, distance_km: 0, difficulty: a.kind, geometry: null, lat: a.lat, lon: a.lon, osm_url: a.osm_url });
    });
  });
}

function renderParkResults(parks) {
  const el = document.getElementById("results");
  if (parks.length === 0) {
    el.innerHTML = `<div class="text-center text-sm opacity-60 py-8">No parks matched. Try a different state or search term.</div>`;
    return;
  }
  el.innerHTML = parks.map((p, i) => `
    <div class="relative bg-card border border-line rounded-2xl p-4">
      <p class="font-condensed text-xs uppercase tracking-wide opacity-60">${escapeHtml(p.state)}</p>
      <h3 class="font-display text-lg cursor-pointer underline decoration-line underline-offset-4 block" data-park-detail-idx="${i}">${escapeHtml(p.name)}</h3>
      <div class="flex flex-wrap gap-2 my-2"><span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${escapeHtml(p.kind)}</span></div>
      <div class="flex gap-2 mt-3 flex-wrap">
        <button class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition" data-park-map-idx="${i}">Map</button>
        <button class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition" data-park-save-idx="${i}">Save</button>
      </div>
      <a class="block text-sm text-pine underline mt-2" href="${p.osm_url}" target="_blank" rel="noopener">View on OpenStreetMap →</a>
    </div>
  `).join("");

  el.querySelectorAll("[data-park-detail-idx]").forEach((el2) => {
    el2.addEventListener("click", () => openParkDetail(parks[Number(el2.dataset.parkDetailIdx)]));
  });
  el.querySelectorAll("[data-park-map-idx]").forEach((btn) => {
    btn.addEventListener("click", () => openParkMapModal(parks[Number(btn.dataset.parkMapIdx)]));
  });
  el.querySelectorAll("[data-park-save-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = parks[Number(btn.dataset.parkSaveIdx)];
      saveToWishlist({ name: p.name, state: p.state, distance_km: 0, difficulty: p.kind, geometry: null, lat: p.lat, lon: p.lon, osm_url: p.osm_url });
    });
  });
}

function openParkMapModal(park) {
  openModal(park.name, `<div class="w-full h-[300px] rounded-2xl overflow-hidden border border-line mb-3" id="modalMapContainer"></div>`, { mapModal: true });
  setTimeout(() => {
    const map = L.map("modalMapContainer", { attributionControl: false }).setView([park.lat, park.lon], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(map);
    L.marker([park.lat, park.lon]).addTo(map).bindPopup(park.name);
    activeModalMap = map;
  }, 0);
}

function openParkDetail(park) {
  document.getElementById("detailTitle").textContent = park.name;
  document.getElementById("detailBody").innerHTML = `
    <p class="font-condensed text-xs uppercase tracking-wide opacity-60">${escapeHtml(park.state)}</p>
    <div class="flex flex-wrap gap-2 my-2"><span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${escapeHtml(park.kind)}</span></div>
    <div id="parkAlerts"></div>
    <p class="leading-relaxed my-3" id="trailDescriptionText">Location is mapped from OpenStreetMap's park boundary data. Elevation profiles aren't shown for parks since they cover an area rather than a single path — check a specific trail inside the park for that.</p>
    <div class="my-3.5">
      <div class="relative rounded-2xl overflow-hidden cursor-pointer border border-line"><div class="w-full h-[160px] bg-card pointer-events-none" id="detailMiniMap"></div><div class="absolute inset-0 z-[5] cursor-pointer" id="detailMiniMapOverlay"></div></div>
      <p class="text-xs opacity-60 mt-1 text-center">Tap map to expand</p>
    </div>
    <div id="parkTrailsSection"></div>
    <div class="flex gap-2 mt-3.5 flex-wrap">
      <button id="detailSaveBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Save</button>
    </div>
    <a class="block text-sm text-pine underline mt-2" href="${park.osm_url}" target="_blank" rel="noopener">View on OpenStreetMap →</a>
  `;
  document.getElementById("detailSaveBtn").addEventListener("click", () =>
    saveToWishlist({ name: park.name, state: park.state, distance_km: 0, difficulty: park.kind, geometry: null, lat: park.lat, lon: park.lon, osm_url: park.osm_url })
  );
  document.getElementById("trailDetailOverlay").classList.remove("hidden");
  loadRichDescription(park, " Elevation profiles aren't shown for parks since they cover an area rather than a single path — check a specific trail inside the park for that.");
  if (park.kind !== "City / Local Park") {
    loadParkAlerts(park);
  }
  loadTrailsNearPark(park);
  setTimeout(() => {
    const map = L.map("detailMiniMap", {
      attributionControl: false, zoomControl: false, dragging: false,
      scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false,
    }).setView([park.lat, park.lon], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(map);
    L.marker([park.lat, park.lon]).addTo(map);
    document.getElementById("detailMiniMapOverlay").addEventListener("click", () => openParkMapModal(park));
  }, 0);
}

async function loadTrailsNearPark(park) {
  const section = document.getElementById("parkTrailsSection");
  if (!section) return;
  try {
    const params = new URLSearchParams({ state: park.state, lat: park.lat, lon: park.lon });
    const resp = await fetch(`/api/trails?${params.toString()}`);
    const data = await resp.json();
    if (!resp.ok || !data.trails || data.trails.length === 0) return;

    const trails = data.trails.slice(0, 15);
    section.innerHTML = `
      <p class="font-condensed uppercase tracking-wide text-xs opacity-60 mt-4 mb-2">Trails in this area</p>
      <div class="flex flex-col gap-2">
        ${trails.map((t, i) => `
          <button data-park-trail-idx="${i}" class="text-left bg-card border border-line rounded-xl px-3 py-2.5 hover:bg-chipbg transition">
            <span class="font-condensed font-semibold">${escapeHtml(t.name)}</span>
            <span class="text-xs opacity-60 block">${(t.distance_km * 0.621371).toFixed(1)} mi · ${escapeHtml(t.difficulty)}</span>
          </button>
        `).join("")}
      </div>
    `;
    section.querySelectorAll("[data-park-trail-idx]").forEach((btn) => {
      btn.addEventListener("click", () => openTrailDetail(trails[Number(btn.dataset.parkTrailIdx)]));
    });
  } catch (err) {
    console.error("Trails-near-park lookup failed:", err);
  }
}

async function loadParkAlerts(park) {
  try {
    const resp = await fetch(`/api/park-info?name=${encodeURIComponent(park.name)}`);
    const data = await resp.json();
    if (data.available && data.alerts && data.alerts.length) {
      document.getElementById("parkAlerts").innerHTML = data.alerts.map((a) => `
        <div class="bg-[#F3DCC4] text-[#8a5a10] rounded-xl px-3 py-2 text-sm mb-2">
          <strong>${escapeHtml(a.title)}</strong>
          <p class="text-xs mt-0.5">${escapeHtml(a.description)}</p>
        </div>
      `).join("");
    }
  } catch (err) {
    console.error("NPS alerts lookup failed:", err);
  }
}

function openTrailMapModal(trail) {
  const hasGeometry = trail.geometry && trail.geometry.some((seg) => seg.length > 1);
  openModal(trail.name, hasGeometry
    ? `<div class="w-full h-[300px] rounded-2xl overflow-hidden border border-line mb-3" id="modalMapContainer"></div><p class="text-xs opacity-60 mt-1">Path shown is mapped OpenStreetMap data — actual conditions on the ground may differ.</p>`
    : `<p class="text-center text-sm opacity-60 py-8">No mapped path is available for this trail yet.</p>`, { mapModal: hasGeometry, editable: hasGeometry });
  if (!hasGeometry) return;

  setTimeout(() => {
    const map = L.map("modalMapContainer", { attributionControl: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(map);
    const bounds = [];
    trail.geometry.forEach((seg) => {
      if (seg.length < 2) return;
      L.polyline(seg, { color: "#1B4332", weight: 4 }).addTo(map);
      seg.forEach((pt) => bounds.push(pt));
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [20, 20] });
    else map.setView([trail.lat, trail.lon], 12);
    activeModalMap = map;
    activeModalMap._fitBounds = bounds.length ? bounds : null;
  }, 0);

  const pencilBtn = document.getElementById("modalPencil");
  pencilBtn.classList.remove("hidden");
  pencilBtn.onclick = () => enterMapEditMode(trail);
}

let editMapInstance = null;
let modalEditor = null;
let modalEditingTrail = null;

function enterMapEditMode(trail) {
  modalEditingTrail = trail;
  if (activeModalMap) { activeModalMap.remove(); activeModalMap = null; }

  modalMaximized = true;
  modalPanel.className = MODAL_MAX_CLASSES;
  modalTitle.textContent = `Editing ${trail.name}`;
  modalBody.innerHTML = `
    <div class="rounded-2xl overflow-hidden border border-line mb-3">
      <div id="editMap" class="w-full h-[60vh]"></div>
    </div>
    <div class="flex gap-2 flex-wrap">
      <button id="editUndoBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Undo point</button>
      <button id="editClearBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Clear</button>
      <button id="editSaveBtn" class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition w-full">Save route</button>
    </div>
  `;

  document.getElementById("modalPencil").classList.add("hidden");
  modalMaximizeBtn.classList.add("hidden");
  const editPencilBtn = document.getElementById("modalEditPencil");
  const editEraserBtn = document.getElementById("modalEditEraser");
  const editAddBtn = document.getElementById("modalEditAdd");
  editPencilBtn.classList.remove("hidden");
  editEraserBtn.classList.remove("hidden");
  editAddBtn.classList.remove("hidden");

  setTimeout(() => {
    const map = L.map("editMap").setView([39.5, -98.35], 4);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(map);
    map.invalidateSize();
    editMapInstance = map;
    modalEditor = makeEditor(map);
    modalEditor.segments = (trail.geometry || []).map((seg) => seg.map((p) => [p[0], p[1]]));
    editorRedraw(modalEditor);
    const allPts = modalEditor.segments.flat();
    if (allPts.length) map.fitBounds(allPts, { padding: [16, 16] });
    else map.setView([trail.lat, trail.lon], 12);

    map.on("mousemove", (e) => {
      if (modalEditor.mode !== "pencil") return;
      const snap = editorFindSnapCandidate(modalEditor, e.latlng);

      if (snap) {
        if (!modalEditor.snapIndicator) {
          modalEditor.snapIndicator = L.circleMarker(snap.latlng, {
            radius: 8,
            color: "#2563EB",
            fillColor: "#60A5FA",
            fillOpacity: 0.8,
            weight: 2,
          }).addTo(map);
        } else {
          modalEditor.snapIndicator.setLatLng(snap.latlng);
        }
      } else if (modalEditor.snapIndicator) {
        map.removeLayer(modalEditor.snapIndicator);
        modalEditor.snapIndicator = null;
      }
    });

    map.on("click", (e) => editorClick(modalEditor, e.latlng));
    editorSetMode(modalEditor, "pencil", editPencilBtn, editEraserBtn);
  }, 250);

  editPencilBtn.onclick = () => editorSetMode(modalEditor, "pencil", editPencilBtn, editEraserBtn);
  editEraserBtn.onclick = () => editorSetMode(modalEditor, "eraser", editPencilBtn, editEraserBtn);
  editAddBtn.onclick = () => openAddSavedTrailPicker((picked) => editorAddSegments(modalEditor, picked.geometry));

  document.getElementById("editUndoBtn").onclick = () => editorUndo(modalEditor);
  document.getElementById("editClearBtn").onclick = () => editorClear(modalEditor);
  document.getElementById("editSaveBtn").onclick = () => {
    const activePolyline = getActiveTrimmedPolyline(modalEditor);
    const activeSegments = [activePolyline];

    if (!validateGeometry(activeSegments)) {
      return;
    }

    const chainedSegments = chainSegmentsFromStart(activeSegments);
    const km = editorDistanceKm(modalEditor);
    const overlay = document.createElement("div");
    overlay.className = "absolute inset-0 bg-paper z-[1200] p-5 overflow-y-auto rounded-3xl";
    overlay.innerHTML = `
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Name</span><input id="editRouteName" class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" placeholder="${escapeHtml(modalEditingTrail.name)} (edited)" autofocus /></label>
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">State</span><select id="editRouteState" class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm">${stateOptionsHtml(modalEditingTrail.state && ALL_STATES.includes(modalEditingTrail.state) ? modalEditingTrail.state : "Colorado")}</select></label>
      <p class="text-sm opacity-70 mb-3">${(km * 0.621371).toFixed(1)} mi · ${chainedSegments.length} segment${chainedSegments.length !== 1 ? "s" : ""}</p>
      <div class="flex gap-2 mt-4">
        <button id="editSaveCancelBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Back</button>
        <button id="editSaveConfirmBtn" class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition w-full">Save</button>
      </div>
    `;
    modalPanel.appendChild(overlay);
    overlay.querySelector("#editSaveCancelBtn").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#editSaveConfirmBtn").addEventListener("click", () => {
      const name = document.getElementById("editRouteName").value.trim() || `${modalEditingTrail.name} (edited)`;
      const state = document.getElementById("editRouteState").value;
      const firstPt = chainedSegments[0][0];
      wishlist = [{
        id: uid(),
        name,
        location: state,
        notes: `${(km * 0.621371).toFixed(1)} mi · edited from ${modalEditingTrail.name}`,
        osm_url: null,
        geometry: chainedSegments.map((seg) => seg.map((p) => [p[0], p[1]])),
        lat: firstPt[0],
        lon: firstPt[1],
        distance_km: km,
        custom: true,
      }, ...wishlist];
      saveWishlist(wishlist);
      populateTrailPicker();
      populateCreateBasePicker();
      closeModal();
      showToast("Route saved — find it in Track or your Saved list");
    });
  };
}

async function loadBlmInfo(trail) {
  const box = document.getElementById("blmInfoBox");
  if (!box) return;
  try {
    const resp = await fetch(`/api/blm-trail-info?name=${encodeURIComponent(trail.name)}&state=${encodeURIComponent(trail.state || "")}`);
    const data = await resp.json();
    if (!data.available) return;

    const rows = [];
    if (data.designation) rows.push(escapeHtml(data.designation));
    if (data.allowedModes) rows.push(escapeHtml(data.allowedModes.replace(/_/g, " ")));
    if (data.surface) rows.push(`Surface: ${escapeHtml(data.surface.replace(/_/g, " "))}`);
    if (data.miles) rows.push(`${data.miles.toFixed(1)} mi (official)`);
    if (rows.length === 0) return;

    box.innerHTML = `
      <div class="bg-card border border-line rounded-2xl p-3.5 my-3">
        <p class="font-condensed uppercase tracking-wide text-xs opacity-60 mb-1.5">Official BLM trail data</p>
        <p class="text-sm">${rows.join(" · ")}</p>
      </div>
    `;
  } catch (err) {
    console.error("BLM info lookup failed:", err);
  }
}

async function loadUsfsInfo(trail) {
  const box = document.getElementById("usfsInfoBox");
  if (!box) return;
  try {
    const resp = await fetch(`/api/usfs-trail-info?name=${encodeURIComponent(trail.name)}&lat=${trail.lat}&lon=${trail.lon}`);
    const data = await resp.json();
    if (!data.available) return;

    const rows = [];
    if (data.trailNumber) rows.push(`Trail #${escapeHtml(String(data.trailNumber))}`);
    if (data.managingOrg) rows.push(escapeHtml(data.managingOrg));
    if (data.surface) rows.push(`Surface: ${escapeHtml(data.surface)}`);
    if (data.miles) rows.push(`${(data.miles).toFixed(1)} mi (official)`);
    if (data.hikerAllowed) rows.push("Open to hikers");
    if (rows.length === 0) return;

    box.innerHTML = `
      <div class="bg-card border border-line rounded-2xl p-3.5 my-3">
        <p class="font-condensed uppercase tracking-wide text-xs opacity-60 mb-1.5">Official USFS trail data</p>
        <p class="text-sm">${rows.join(" · ")}</p>
      </div>
    `;
  } catch (err) {
    console.error("USFS info lookup failed:", err);
  }
}

async function loadRichDescription(trail, suffix = "") {
  const el = document.getElementById("trailDescriptionText");
  if (trail.osm_description) {
    el.textContent = trail.osm_description + suffix;
    return;
  }
  try {
    const resp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(trail.name)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.extract && data.type !== "disambiguation" && data.content_urls) {
      el.innerHTML = `${escapeHtml(data.extract)}${escapeHtml(suffix)} <a href="${data.content_urls.desktop.page}" target="_blank" rel="noopener">Read more on Wikipedia →</a>`;
    }
  } catch (err) {
    console.error("Wikipedia lookup failed:", err);
  }
}

function buildTrailDescription(trail) {
  const parts = [];
  if (trail.distance_km != null) {
    let p = `This trail runs about ${(trail.distance_km * 0.621371).toFixed(1)} miles`;
    if (trail.segments > 1) p += `, pieced together from ${trail.segments} mapped segments`;
    parts.push(p + ".");
  }
  if (trail.difficulty && trail.difficulty !== "Unknown") {
    parts.push(`OpenStreetMap tagging rates it as ${trail.difficulty.toLowerCase()} difficulty.`);
  } else if (trail.difficulty === "Unknown") {
    parts.push(`Difficulty isn't tagged in OpenStreetMap for this one — check trip reports before you go.`);
  }
  if (trail.surface) parts.push(`Surface is mapped as ${trail.surface}.`);
  if (parts.length === 0) {
    return "Details for this trail are limited in OpenStreetMap's data. Tap through to OpenStreetMap for more context, or check trip-report sites before heading out.";
  }
  return parts.join(" ") + " This description is generated from OpenStreetMap data, not a written guide — always check current conditions before you go.";
}

function openTrailDetail(trail) {
  document.getElementById("detailTitle").textContent = trail.name;
  const hasGeometry = trail.geometry && trail.geometry.some((seg) => seg.length > 1);

  const factsHtml = trail.distance_km != null
    ? `<div class="flex flex-wrap gap-2 my-2">
        <span>${(trail.distance_km * 0.621371).toFixed(1)} mi</span>
        <span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${trail.difficulty}</span>
        ${trail.surface ? `<span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${escapeHtml(trail.surface)}</span>` : ""}
      </div>`
    : trail.savedNotes ? `<p class="text-sm opacity-70 mt-1">${escapeHtml(trail.savedNotes)}</p>` : "";

  document.getElementById("detailBody").innerHTML = `
    <p class="font-condensed text-xs uppercase tracking-wide opacity-60">${escapeHtml(trail.state || "")}${trail.segments > 1 ? ` · ${trail.segments} mapped segments` : ""}</p>
    ${factsHtml}
    <p class="leading-relaxed my-3" id="trailDescriptionText">${buildTrailDescription(trail)}</p>
    <div id="usfsInfoBox"></div>
    <div id="blmInfoBox"></div>
    <div class="my-3.5">
      ${hasGeometry ? `<div class="relative rounded-2xl overflow-hidden cursor-pointer border border-line"><div class="w-full h-[160px] bg-card pointer-events-none" id="detailMiniMap"></div><div class="absolute inset-0 z-[5] cursor-pointer" id="detailMiniMapOverlay"></div></div><p class="text-xs opacity-60 mt-1 text-center">Tap map to expand</p>` : `<p class="text-center text-sm opacity-60 py-8">No mapped path available.</p>`}
    </div>
    <div class="bg-card border border-line rounded-2xl p-3.5 mt-3.5">
      <div class="flex items-center justify-between mb-1">
        <p class="font-condensed uppercase tracking-wide text-xs opacity-60">Elevation profile</p>
        <div class="flex items-center gap-2">
          <p class="font-condensed text-sm text-pine font-semibold" id="elevationReadout">Drag to explore</p>
          <button id="elevationExpandBtn" class="hidden w-7 h-7 rounded-full bg-chipbg flex items-center justify-center text-xs shrink-0">⤢</button>
        </div>
      </div>
      <div class="h-[160px]"><canvas id="elevationChart"></canvas></div>
      <p class="text-xs opacity-60 mt-1" id="elevationNote">Loading elevation data…</p>
    </div>
    <div class="flex gap-2 mt-3.5 flex-wrap">
      <button id="detailSaveBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Save</button>
      <button id="detailLogBtn" class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition">Log as hiked</button>
      ${hasGeometry ? `<button id="detailOfflineBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Download for offline</button>` : ""}
    </div>
    ${trail.osm_url ? `<a class="block text-sm text-pine underline mt-2" href="${trail.osm_url}" target="_blank" rel="noopener">View on OpenStreetMap →</a>` : ""}
  `;

  document.getElementById("detailSaveBtn").addEventListener("click", () => saveToWishlist(trail));
  document.getElementById("detailLogBtn").addEventListener("click", () => openCompleteModal(trail));
  if (hasGeometry) {
    document.getElementById("detailOfflineBtn").addEventListener("click", (e) => downloadTrailForOffline(trail, e.target));
  }
  document.getElementById("trailDetailOverlay").classList.remove("hidden");
  loadRichDescription(trail);
  if (hasGeometry) {
    loadUsfsInfo(trail);
    loadBlmInfo(trail);
  }

  if (hasGeometry) {
    setTimeout(() => {
      const map = L.map("detailMiniMap", {
        attributionControl: false, zoomControl: false, dragging: false,
        scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(map);
      const bounds = [];
      trail.geometry.forEach((seg) => {
        if (seg.length < 2) return;
        L.polyline(seg, { color: "#1B4332", weight: 4 }).addTo(map);
        seg.forEach((pt) => bounds.push(pt));
      });
      if (bounds.length) map.fitBounds(bounds, { padding: [10, 10] });
      document.getElementById("detailMiniMapOverlay").addEventListener("click", () => openTrailMapModal(trail));
      detailMiniMapInstance = map;
      detailScrubMarker.marker = null;
    }, 0);
    loadElevationChart(trail);
  } else {
    document.getElementById("elevationNote").textContent = "No mapped path, so no elevation profile is available.";
  }
}

document.getElementById("detailBack").addEventListener("click", () => {
  document.getElementById("trailDetailOverlay").classList.add("hidden");
});

let elevationChartInstance = null;
let expandedElevationChartInstance = null;
let lastElevationData = null;
let detailMiniMapInstance = null;
const detailScrubMarker = { marker: null };

const scrubDivIcon = L.divIcon({
  html: `<img src="icons/icon-192.png" style="width:28px;height:28px;border-radius:50%;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);object-fit:cover;display:block;" />`,
  className: "",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

function updateScrubMarker(map, markerRef, point) {
  if (!map) return;
  if (!point) {
    if (markerRef.marker) { map.removeLayer(markerRef.marker); markerRef.marker = null; }
    return;
  }
  if (!markerRef.marker) {
    markerRef.marker = L.marker(point, { icon: scrubDivIcon, interactive: false }).addTo(map);
  } else {
    markerRef.marker.setLatLng(point);
  }
}

function buildElevationChart(canvasId, readoutId, sampled, elevations, instanceSetter, height, onScrub) {
  const ctx = document.getElementById(canvasId);
  const readout = document.getElementById(readoutId);
  const gradient = ctx.getContext("2d").createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(27,67,50,0.45)");
  gradient.addColorStop(1, "rgba(27,67,50,0.03)");

  const crosshairPlugin = {
    id: "crosshair",
    afterDraw(chart) {
      const active = chart.tooltip?._active;
      if (!active || !active.length) return;
      const { ctx: c } = chart;
      const point = active[0].element;
      const area = chart.chartArea;
      c.save();
      c.beginPath();
      c.moveTo(point.x, area.top);
      c.lineTo(point.x, area.bottom);
      c.lineWidth = 1;
      c.strokeStyle = "rgba(27,67,50,0.35)";
      c.stroke();
      c.beginPath();
      c.arc(point.x, point.y, 5, 0, Math.PI * 2);
      c.fillStyle = "#1B4332";
      c.fill();
      c.restore();
    },
  };

  const instance = new Chart(ctx, {
    type: "line",
    data: {
      labels: sampled.map((s) => s.mi.toFixed(2)),
      datasets: [{
        data: elevations,
        borderColor: "#1B4332",
        backgroundColor: gradient,
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
        spanGaps: true,
      }],
    },
    plugins: [crosshairPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      events: ["mousemove", "mouseout", "touchstart", "touchmove", "touchend"],
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: { title: { display: true, text: "miles" }, grid: { display: false } },
        y: { title: { display: true, text: "ft elevation" } },
      },
      onHover: (event, elements) => {
        if (!elements || !elements.length) {
          readout.textContent = "Drag to explore";
          if (onScrub) onScrub(null);
          return;
        }
        const idx = elements[0].index;
        const mi = sampled[idx].mi.toFixed(1);
        const ft = elevations[idx];
        readout.textContent = ft == null ? `${mi} mi` : `${mi} mi · ${Math.round(ft).toLocaleString()} ft`;
        if (onScrub) onScrub(sampled[idx].point);
      },
    },
  });
  instanceSetter(instance);
  return instance;
}

function openElevationModal() {
  if (!lastElevationData) return;
  const { sampled, elevations, trailName, geometry, lat, lon } = lastElevationData;
  openModal(`${trailName}`, `
    <div class="rounded-2xl overflow-hidden border border-line mb-3">
      <div id="modalElevationMap" class="w-full h-[30vh]"></div>
    </div>
    <div class="flex items-center justify-between mb-1">
      <p class="font-condensed uppercase tracking-wide text-xs opacity-60">Elevation profile</p>
      <p class="font-condensed text-sm text-pine font-semibold" id="modalElevationReadout">Drag to explore</p>
    </div>
    <div class="h-[30vh]"><canvas id="modalElevationChart"></canvas></div>
  `, { mapModal: false });
  
  modalPanel.className = "bg-paper w-full h-[88vh] max-h-[88vh] sm:max-w-2xl rounded-3xl overflow-y-auto p-5 transition-all duration-200";

  setTimeout(() => {
    const map = L.map("modalElevationMap", { attributionControl: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(map);
    const bounds = [];
    (geometry || []).forEach((seg) => {
      if (seg.length < 2) return;
      L.polyline(seg, { color: "#1B4332", weight: 4 }).addTo(map);
      seg.forEach((pt) => bounds.push(pt));
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [16, 16] });
    else if (lat != null) map.setView([lat, lon], 12);

    const modalScrubMarker = { marker: null };
    if (expandedElevationChartInstance) expandedElevationChartInstance.destroy();
    buildElevationChart("modalElevationChart", "modalElevationReadout", sampled, elevations, (i) => { expandedElevationChartInstance = i; }, window.innerHeight * 0.3,
      (point) => updateScrubMarker(map, modalScrubMarker, point));
  }, 0);
}

// -------------------------------------------------------------
// 3. loadElevationChart(trail) Distance Fix
// Calculates cumulative physical distance without artificial straight-line
// jumps between disconnected segments.
// -------------------------------------------------------------
async function loadElevationChart(trail) {
  const note = document.getElementById("elevationNote");
  try {
    if (!trail.geometry || trail.geometry.length === 0) throw new Error("not enough points");

    const chainedGeometry = chainSegmentsFromStart(trail.geometry);
    const allPoints = [];
    const cum = [];
    let totalKm = 0;

    chainedGeometry.forEach((seg) => {
      for (let i = 0; i < seg.length; i++) {
        const pt = seg[i];
        allPoints.push(pt);

        if (cum.length === 0) {
          cum.push(0);
        } else if (i === 0) {
          // Skip adding distance jump across non-contiguous segment gaps
          cum.push(totalKm);
        } else {
          const prevPt = seg[i - 1];
          const dist = haversineKm(prevPt[0], prevPt[1], pt[0], pt[1]);
          totalKm += dist;
          cum.push(totalKm);
        }
      }
    });

    if (allPoints.length < 2) throw new Error("not enough points");

    const SAMPLES = 20;
    const sampled = [];
    for (let i = 0; i < SAMPLES; i++) {
      const targetDist = (i / (SAMPLES - 1)) * totalKm;
      let idx = cum.findIndex((d) => d >= targetDist);
      if (idx === -1) idx = allPoints.length - 1;
      sampled.push({ point: allPoints[idx], mi: cum[idx] * 0.621371 });
    }

    const locString = sampled.map((s) => `${s.point[0]},${s.point[1]}`).join("|");
    const resp = await fetch(`/api/elevation?locations=${encodeURIComponent(locString)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "elevation API error");
    const elevations = data.elevations;

    const known = elevations.filter((e) => e !== null && e !== undefined);
    if (known.length < 2) throw new Error("not enough elevation data returned");

    let gainFt = 0;
    for (let i = 1; i < elevations.length; i++) {
      if (elevations[i] != null && elevations[i - 1] != null && elevations[i] > elevations[i - 1]) {
        gainFt += elevations[i] - elevations[i - 1];
      }
    }

    lastElevationData = { sampled, elevations, trailName: trail.name, geometry: chainedGeometry, lat: trail.lat, lon: trail.lon };
    if (elevationChartInstance) elevationChartInstance.destroy();
    buildElevationChart("elevationChart", "elevationReadout", sampled, elevations, (i) => { elevationChartInstance = i; }, 160,
      (point) => updateScrubMarker(detailMiniMapInstance, detailScrubMarker, point));
    const expandBtn = document.getElementById("elevationExpandBtn");
    expandBtn.classList.remove("hidden");
    expandBtn.onclick = openElevationModal;
    note.textContent = `Approx. ${Math.round(gainFt)} ft elevation gain, estimated from sampled points. Tap ⤢ to expand.`;
  } catch (err) {
    console.error(err);
    note.textContent = `Elevation data isn't available for this trail right now. (${err.message || err})`;
  }
}

async function runSearch() {
  const state = document.getElementById("state").value;
  const q = document.getElementById("query").value.trim();
  const status = document.getElementById("status");
  const searchBtn = document.getElementById("searchBtn");

  if (searchMode === "city" && !q) {
    status.textContent = "Enter a city name to search near.";
    return;
  }

  if (searchMode === "parks") {
    status.textContent = `Searching live OpenStreetMap data for parks in ${state}…`;
    document.getElementById("results").innerHTML = "";
    searchBtn.disabled = true;
    try {
      const params = new URLSearchParams({ state });
      if (q) params.set("q", q);
      const res = await fetch(`/api/parks?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        status.textContent = `Error: ${data.error || "something went wrong"}`;
        return;
      }
      lastResults = data.parks;
      status.textContent = data.parks.length === 0 && data.note
        ? data.note
        : `${data.parks.length} park${data.parks.length !== 1 ? "s" : ""} found in ${state}${data.cached ? " (cached)" : ""}.`;
      renderParkResults(lastResults);
    } catch (err) {
      status.textContent = "Couldn't reach the server. Is it running?";
      console.error(err);
    } finally {
      searchBtn.disabled = false;
    }
    return;
  }

  if (searchMode === "reccons") {
    status.textContent = `Searching National Forest and BLM lands in ${state}…`;
    document.getElementById("results").innerHTML = "";
    searchBtn.disabled = true;
    try {
      const params = new URLSearchParams({ state });
      if (q) params.set("q", q);
      const res = await fetch(`/api/reccons?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        status.textContent = `Error: ${data.error || "something went wrong"}`;
        return;
      }
      lastResults = data.areas;
      status.textContent = `${data.areas.length} area${data.areas.length !== 1 ? "s" : ""} found in ${state}${data.cached ? " (cached)" : ""}.`;
      renderRecConsResults(lastResults);
    } catch (err) {
      status.textContent = "Couldn't reach the server. Is it running?";
      console.error(err);
    } finally {
      searchBtn.disabled = false;
    }
    return;
  }

  if (searchMode === "usa") {
    if (!q || q.length < 3) {
      status.textContent = "Enter at least 3 characters of a trail name (e.g. Appalachian Trail).";
      return;
    }
    status.textContent = `Searching nationwide for "${q}"…`;
    document.getElementById("results").innerHTML = "";
    searchBtn.disabled = true;
    try {
      const res = await fetch(`/api/usa-trails?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) {
        status.textContent = `Error: ${data.error || "something went wrong"}`;
        return;
      }
      lastResults = data.trails;
      status.textContent = `${data.trails.length} trail${data.trails.length !== 1 ? "s" : ""} found nationwide${data.cached ? " (cached)" : ""}.`;
      renderSearchResults(lastResults);
    } catch (err) {
      status.textContent = "Couldn't reach the server. Is it running?";
      console.error(err);
    } finally {
      searchBtn.disabled = false;
    }
    return;
  }

  status.textContent = searchMode === "city"
    ? `Finding trails near ${q}, ${state}…`
    : `Searching live OpenStreetMap data for ${state}…`;
  document.getElementById("results").innerHTML = "";
  searchBtn.disabled = true;

  try {
    const params = new URLSearchParams({ state });
    if (searchMode === "city") {
      params.set("near", q);
    } else if (q) {
      params.set("q", q);
    }
    const res = await fetch(`/api/trails?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      status.textContent = `Error: ${data.error || "something went wrong"}`;
      return;
    }
    lastResults = data.trails;
    const locationLabel = searchMode === "city" ? `near ${q}` : `in ${state}`;
    status.textContent = `${data.trails.length} named trail${data.trails.length !== 1 ? "s" : ""} found ${locationLabel}${data.cached ? " (cached)" : ""}. Distances are approximate, computed from mapped geometry.`;
    renderSearchResults(lastResults);
  } catch (err) {
    status.textContent = "Couldn't reach the server. Is it running?";
    console.error(err);
  } finally {
    searchBtn.disabled = false;
  }
}

document.getElementById("searchBtn").addEventListener("click", runSearch);
document.getElementById("query").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
document.querySelectorAll("#difficultyFilters .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#difficultyFilters .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    currentDifficulty = chip.dataset.difficulty;
    renderSearchResults(lastResults);
  });
});

// ---- saved / wishlist ----
function saveToWishlist(trail) {
  if (wishlist.some((w) => w.name === trail.name)) { showToast("Already on your list"); return; }
  wishlist = [{
    id: uid(),
    name: trail.name,
    location: trail.state,
    notes: `${(trail.distance_km * 0.621371).toFixed(1)} mi · ${trail.difficulty}`,
    osm_url: trail.osm_url,
    geometry: trail.geometry || null,
    lat: trail.lat,
    lon: trail.lon,
  }, ...wishlist];
  saveWishlist(wishlist);
  showToast("Saved to your list");
  populateTrailPicker();
  populateCreateBasePicker();
}

function renderSaved() {
  const el = document.getElementById("savedList");
  if (wishlist.length === 0) {
    el.innerHTML = `<div class="text-center text-sm opacity-60 py-8">Nothing saved yet — search a state and tap Save on a trail.</div>`;
    return;
  }
  el.innerHTML = wishlist.map((w) => `
    <div class="relative bg-card border border-line rounded-2xl p-4">
      <button class="absolute top-3 right-3 w-7 h-7 rounded-full bg-chipbg flex items-center justify-center text-sm z-10" data-delete-wish="${w.id}" aria-label="Remove">✕</button>
      <h3 class="font-display text-lg cursor-pointer underline decoration-line underline-offset-4 block" data-detail-wish="${w.id}">${escapeHtml(w.name)}</h3>
      <p class="font-condensed text-xs uppercase tracking-wide opacity-60">${escapeHtml(w.location || "")}</p>
      ${w.notes ? `<p class="text-sm opacity-70 mt-1">${escapeHtml(w.notes)}</p>` : ""}
      <div class="flex gap-2 mt-3 flex-wrap">
        ${w.geometry ? `<button class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition" data-track-wish="${w.id}">Track this</button>` : ""}
        <button class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition" data-complete-wish="${w.id}">Mark as hiked</button>
        ${w.custom && w.geometry
          ? w.addedToDb
            ? `<span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium self-center">✓ In shared database</span>`
            : `<button class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition" data-submit-wish="${w.id}">Add to database</button>`
          : ""}
        ${w.osm_url ? `<a class="block text-sm text-pine underline mt-2" href="${w.osm_url}" target="_blank" rel="noopener">Map →</a>` : ""}
      </div>
    </div>
  `).join("");

  el.querySelectorAll("[data-submit-wish]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const w = wishlist.find((x) => x.id === btn.dataset.submitWish);
      btn.textContent = "Adding…";
      btn.disabled = true;
      try {
        const resp = await fetch("/api/community-trails", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: w.name, state: w.location, geometry: w.geometry,
            distance_km: w.distance_km || 0, notes: w.notes, lat: w.lat, lon: w.lon,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          showToast(data.error || "Couldn't add to the shared database");
          btn.textContent = "Add to database";
          btn.disabled = false;
          return;
        }
        w.addedToDb = true;
        saveWishlist(wishlist);
        showToast(`${w.name} added to the shared database — now searchable by everyone`);
        renderSaved();
      } catch (err) {
        console.error(err);
        showToast("Couldn't reach the server");
        btn.textContent = "Add to database";
        btn.disabled = false;
      }
    });
  });

  el.querySelectorAll("[data-detail-wish]").forEach((el2) => {
    el2.addEventListener("click", () => {
      const w = wishlist.find((x) => x.id === el2.dataset.detailWish);
      openTrailDetail({
        name: w.name, state: w.location, distance_km: null, difficulty: null,
        surface: null, segments: null, geometry: w.geometry, lat: w.lat, lon: w.lon,
        osm_url: w.osm_url, savedNotes: w.notes,
      });
    });
  });
  el.querySelectorAll("[data-delete-wish]").forEach((btn) => {
    btn.addEventListener("click", () => {
      wishlist = wishlist.filter((w) => w.id !== btn.dataset.deleteWish);
      saveWishlist(wishlist);
      renderSaved();
      populateTrailPicker();
      populateCreateBasePicker();
    });
  });
  el.querySelectorAll("[data-complete-wish]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const trail = wishlist.find((w) => w.id === btn.dataset.completeWish);
      openCompleteModal({ name: trail.name, state: trail.location, notes: trail.notes, wishId: trail.id });
    });
  });
  el.querySelectorAll("[data-track-wish]").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab("track");
      document.getElementById("trailPicker").value = btn.dataset.trackWish;
      selectTrailToFollow(btn.dataset.trackWish);
    });
  });
}

function openCompleteModal(trail) {
  openModal(`Hiked: ${trail.name}`, `
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Date</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="cDate" type="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
    <div class="flex gap-2.5">
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Distance (km)</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="cDist" type="number" step="0.1" value="${trail.distance_km ? trail.distance_km.toFixed(1) : ""}" /></label>
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Hours</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="cH" type="number" placeholder="2" /></label>
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Min</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="cM" type="number" placeholder="30" /></label>
    </div>
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Notes</span><textarea class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="cNotes" rows="2" placeholder="${escapeHtml(trail.notes || "")}"></textarea></label>
    <div class="flex gap-2 mt-4">
      <button id="cSaveBtn" class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition w-full">Move to journal</button>
    </div>
  `);
  document.getElementById("cSaveBtn").addEventListener("click", () => {
    const date = document.getElementById("cDate").value;
    const distKm = Math.max(0, parseFloat(document.getElementById("cDist").value) || 0);
    const h = parseInt(document.getElementById("cH").value) || 0;
    const m = parseInt(document.getElementById("cM").value) || 0;
    const notes = document.getElementById("cNotes").value.trim() || trail.notes || "";
    hikes = [{ id: uid(), date: date ? new Date(date).toISOString() : new Date().toISOString(), name: trail.name, distance: distKm * 1000, duration: h * 3600 + m * 60, notes, path: null, source: "manual" }, ...hikes];
    saveHikes(hikes);
    if (trail.wishId) {
      wishlist = wishlist.filter((w) => w.id !== trail.wishId);
      saveWishlist(wishlist);
    }
    closeModal();
    showToast("Moved to your journal");
    renderJournal();
    updateStatLine();
    switchTab("journal");
  });
}

// ---------- init ----------
window.addEventListener("beforeunload", () => {
  clearInterval(timerId);
  if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
});

updateStatLine();
renderJournal();
loadStates();
populateTrailPicker();
populateCreateBasePicker();
switchTab("discover");
