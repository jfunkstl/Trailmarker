// ---------- on-page error reporting ----------
// Registered before anything else runs. Shows a red banner across the top
// of the screen for ANY problem this app can detect — a thrown JS error, an
// unhandled promise rejection, OR (critically) an expected HTML element
// that's missing, which previously only logged to console.error and did
// nothing else. A silent console.error is invisible on a phone with no
// devtools access, and produces exactly the symptom "nothing happens, no
// crash, no visible error" — this makes that class of problem impossible
// to miss instead.
function showFatalError(msg) {
  console.error(msg);
  let banner = document.getElementById("jsErrorBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "jsErrorBanner";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#8a2f22;color:#fff;padding:10px 14px;font-family:monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;";
    document.body.appendChild(banner);
  }
  banner.textContent = banner.textContent ? `${banner.textContent}\n---\n${msg}` : msg;
}
window.addEventListener("error", (e) => {
  showFatalError(`JS Error: ${e.message} (line ${e.lineno}, col ${e.colno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  showFatalError(`Unhandled promise rejection: ${e.reason && e.reason.message ? e.reason.message : e.reason}`);
});

// Immediate startup check — verifies every element this redesign depends on
// actually exists the instant the page loads, rather than only surfacing a
// problem later when some specific function happens to be called. If
// index.html and app.js are ever out of sync (stale cache, partial deploy,
// etc.) this shows a banner within the first moment of page load instead of
// presenting as "nothing happens, nothing works, no visible error."
(function checkRequiredElements() {
  const required = [
    "discoverMapView", "discoverMap", "searchThisAreaBtn", "discoverMapHint",
    "tab-discover", "tab-create", "tab-track", "tab-journal",
    "viewToggle", "discoverSearch", "discoverSaved",
  ];
  const missing = required.filter((id) => !document.getElementById(id));
  if (missing.length > 0) {
    showFatalError(`Startup check failed — index.html is missing: ${missing.map((id) => "#" + id).join(", ")}. This page is running an old/mismatched index.html — try a hard refresh or clear this site's data completely (not just "clear cache").`);
  }
})();

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

// ---------- storage ----------
const HIKES_KEY = "trailmark-hikes";
const WISHLIST_KEY = "trailmark-wishlist";

const loadHikes = () => JSON.parse(localStorage.getItem(HIKES_KEY) || "[]");
const saveHikes = (hikes) => localStorage.setItem(HIKES_KEY, JSON.stringify(hikes));
const loadWishlist = () => JSON.parse(localStorage.getItem(WISHLIST_KEY) || "[]");
const saveWishlist = (list) => localStorage.setItem(WISHLIST_KEY, JSON.stringify(list));

let hikes = loadHikes();
let wishlist = loadWishlist();

// ---------- helpers ----------
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

// ---------- directed-path chaining & validation ----------
// Reorders possibly-disconnected segments into the order a hiker would
// actually walk them, starting from startPoint. Greedily attaches whichever
// remaining segment endpoint is closest to the current chain's end,
// reversing that segment if needed so the matched endpoint connects first.
// This matters for combined/edited custom routes: segments were previously
// stored in whatever order they were drawn or added via "+", which could
// make the sampled elevation chart jump around geographically instead of
// reading as one continuous walk.
function chainSegmentsFromStart(segments, startPoint) {
  const remaining = segments
    .filter((seg) => Array.isArray(seg) && seg.length >= 2)
    .map((seg) => seg.slice());
  if (remaining.length === 0) return [];
  if (remaining.length === 1) return remaining;

  const dist = (a, b) => haversineKm(a[0], a[1], b[0], b[1]);

  let startIdx = 0, startReversed = false, bestD = Infinity;
  remaining.forEach((seg, i) => {
    const dStart = dist(startPoint, seg[0]);
    const dEnd = dist(startPoint, seg[seg.length - 1]);
    if (dStart < bestD) { bestD = dStart; startIdx = i; startReversed = false; }
    if (dEnd < bestD) { bestD = dEnd; startIdx = i; startReversed = true; }
  });

  const used = new Array(remaining.length).fill(false);
  let firstSeg = remaining[startIdx];
  if (startReversed) firstSeg = firstSeg.slice().reverse();
  const chain = [firstSeg];
  used[startIdx] = true;
  let chainEnd = firstSeg[firstSeg.length - 1];

  for (let step = 1; step < remaining.length; step++) {
    let nextIdx = -1, nextReversed = false, nextD = Infinity;
    remaining.forEach((seg, i) => {
      if (used[i]) return;
      const dStart = dist(chainEnd, seg[0]);
      const dEnd = dist(chainEnd, seg[seg.length - 1]);
      if (dStart < nextD) { nextD = dStart; nextIdx = i; nextReversed = false; }
      if (dEnd < nextD) { nextD = dEnd; nextIdx = i; nextReversed = true; }
    });
    if (nextIdx === -1) break;
    let nextSeg = remaining[nextIdx];
    if (nextReversed) nextSeg = nextSeg.slice().reverse();
    chain.push(nextSeg);
    used[nextIdx] = true;
    chainEnd = nextSeg[nextSeg.length - 1];
  }
  return chain;
}

// Structural sanity check before a route gets saved — catches empty
// segments, malformed points, and out-of-range coordinates before they
// reach localStorage or the shared database, where a bad point can
// silently break the elevation chart or map bounds later.
function validateGeometry(geometry) {
  if (!Array.isArray(geometry) || geometry.length === 0) {
    return { valid: false, error: "Route has no segments to save." };
  }
  let totalPoints = 0;
  for (const seg of geometry) {
    if (!Array.isArray(seg) || seg.length < 2) {
      return { valid: false, error: "Route has a segment with fewer than 2 points." };
    }
    for (const p of seg) {
      if (!Array.isArray(p) || p.length < 2) {
        return { valid: false, error: "Route has a malformed point." };
      }
      const [lat, lon] = p;
      if (typeof lat !== "number" || typeof lon !== "number" || Number.isNaN(lat) || Number.isNaN(lon)) {
        return { valid: false, error: "Route has a non-numeric coordinate." };
      }
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return { valid: false, error: "Route has a coordinate out of valid range." };
      }
    }
    totalPoints += seg.length;
  }
  if (totalPoints < 2) {
    return { valid: false, error: "Add at least two points before saving." };
  }
  return { valid: true, error: null };
}

// Finds whichever segment endpoint (a segment's first or last point) is
// closest to a given point. Used both to snap a dragged Start/End marker
// onto a real point in the route, and to figure out which segment+end a
// marker currently represents when building the final chained geometry.
function findClosestSegmentEndpoint(segments, point) {
  let best = null;
  segments.forEach((seg, segIdx) => {
    if (!Array.isArray(seg) || seg.length < 2) return;
    const startP = seg[0];
    const endP = seg[seg.length - 1];
    const dStart = haversineKm(point[0], point[1], startP[0], startP[1]);
    const dEnd = haversineKm(point[0], point[1], endP[0], endP[1]);
    if (!best || dStart < best.dist) best = { segIdx, end: "start", point: startP, dist: dStart };
    if (!best || dEnd < best.dist) best = { segIdx, end: "end", point: endP, dist: dEnd };
  });
  return best;
}

// Chains segments into walking order using explicit start/end points chosen
// by the user (the draggable S/E markers), rather than guessing. The
// segment touching the start marker is placed first (oriented so that
// endpoint comes first); the segment touching the end marker is placed
// last (oriented so that endpoint comes last); everything else in between
// is chained via nearest-neighbor, same approach as before. This removes
// the ambiguity that made chainSegmentsFromStart's automatic guess
// sometimes pick a technically-valid but unintended order for combined
// routes.
function chainSegmentsWithEndpoints(segments, startPoint, endPoint) {
  const valid = segments
    .filter((seg) => Array.isArray(seg) && seg.length >= 2)
    .map((seg) => seg.slice());
  if (valid.length === 0) return [];

  if (valid.length === 1) {
    const seg = valid[0];
    const dStart = startPoint ? haversineKm(startPoint[0], startPoint[1], seg[0][0], seg[0][1]) : 0;
    const dEndAsStart = startPoint ? haversineKm(startPoint[0], startPoint[1], seg[seg.length - 1][0], seg[seg.length - 1][1]) : 0;
    return dEndAsStart < dStart ? [seg.slice().reverse()] : [seg];
  }

  const effectiveStart = startPoint || valid[0][0];
  const effectiveEnd = endPoint || valid[valid.length - 1][valid[valid.length - 1].length - 1];

  const startMatch = findClosestSegmentEndpoint(valid, effectiveStart);
  let endMatch = findClosestSegmentEndpoint(valid, effectiveEnd);

  // If both markers snapped to the same segment (e.g. only that segment's
  // endpoints are close to both), pick the best DISTINCT-segment match for
  // the end marker instead, so start and end don't collapse onto one piece.
  if (endMatch.segIdx === startMatch.segIdx) {
    let best = null;
    valid.forEach((seg, segIdx) => {
      if (segIdx === startMatch.segIdx) return;
      const startP = seg[0];
      const endP = seg[seg.length - 1];
      const dStart = haversineKm(effectiveEnd[0], effectiveEnd[1], startP[0], startP[1]);
      const dEnd = haversineKm(effectiveEnd[0], effectiveEnd[1], endP[0], endP[1]);
      if (!best || dStart < best.dist) best = { segIdx, end: "start", point: startP, dist: dStart };
      if (!best || dEnd < best.dist) best = { segIdx, end: "end", point: endP, dist: dEnd };
    });
    if (best) endMatch = best;
  }

  let firstSeg = valid[startMatch.segIdx].slice();
  if (startMatch.end === "end") firstSeg = firstSeg.reverse();

  let lastSeg = valid[endMatch.segIdx].slice();
  if (endMatch.end === "start") lastSeg = lastSeg.reverse();

  const middleSegments = valid.filter((_, i) => i !== startMatch.segIdx && i !== endMatch.segIdx);
  const used = new Array(middleSegments.length).fill(false);
  const chain = [firstSeg];
  let chainEnd = firstSeg[firstSeg.length - 1];

  for (let step = 0; step < middleSegments.length; step++) {
    let nextIdx = -1, nextReversed = false, nextD = Infinity;
    middleSegments.forEach((seg, i) => {
      if (used[i]) return;
      const dStart = haversineKm(chainEnd[0], chainEnd[1], seg[0][0], seg[0][1]);
      const dEnd = haversineKm(chainEnd[0], chainEnd[1], seg[seg.length - 1][0], seg[seg.length - 1][1]);
      if (dStart < nextD) { nextD = dStart; nextIdx = i; nextReversed = false; }
      if (dEnd < nextD) { nextD = dEnd; nextIdx = i; nextReversed = true; }
    });
    if (nextIdx === -1) break;
    let nextSeg = middleSegments[nextIdx];
    if (nextReversed) nextSeg = nextSeg.slice().reverse();
    chain.push(nextSeg);
    used[nextIdx] = true;
    chainEnd = nextSeg[nextSeg.length - 1];
  }

  chain.push(lastSeg);
  return chain;
}

function updateStatLine() {
  const total = hikes.reduce((s, h) => s + (h.distance || 0), 0);
  document.getElementById("statLine").textContent = `${hikes.length} hikes logged · ${fmtDist(total)} total`;
}

// ---------- tab switching ----------
// Small helper used throughout the new map-view wiring: attaches a click
// listener only if the element actually exists, logging a clear console
// error instead of throwing. A single missing/mismatched element used to
// be able to crash the whole script at load time (an uncaught exception in
// top-level code halts everything after it) — this contains that failure
// to just the one broken feature instead of taking down every button.
function safeOnClick(id, handler) {
  const el = document.getElementById(id);
  if (!el) {
    showFatalError(`Missing element #${id} — index.html and app.js are out of sync (try a hard refresh / clear site data).`);
    return;
  }
  el.addEventListener("click", handler);
}

const tabs = ["discover", "create", "track", "journal"];

function switchTab(tab) {
  tabs.forEach((t) => {
    const section = document.getElementById(`tab-${t}`);
    if (section) section.classList.toggle("hidden", t !== tab);
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  if (tab === "track") setTimeout(() => { ensureTrackMap(); trackMap.invalidateSize(); }, 50);
  if (tab === "create") setTimeout(() => { ensureCreateMap(); createMap.invalidateSize(); }, 50);
  if (tab === "discover" && currentView === "map") setTimeout(() => {
    ensureDiscoverMap();
    if (discoverMap) discoverMap.invalidateSize();
    updateSearchThisAreaButton();
  }, 50);
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

// Rough general estimate, not personalized: about 62 kcal per km of hiking
// (roughly the commonly-cited ~100 kcal/mile average for a moderate pace).
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
  // Deferred so this always runs after the tab's own layout/map-init settles,
  // whether we got here by switching tabs or just changing the dropdown.
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
// Both the Create tab and the "edit this trail's map" feature (from a trail's
// detail page) need the same core abilities: draw point-to-point, erase
// nearby points (can leave a gap mid-trail), undo, clear, and merge in
// another saved trail as an extra piece. One shared engine avoids having to
// keep two copies of this logic in sync.
function makeEditor(map, onEndpointChange) {
  return {
    map, segments: [], mode: "pencil", polylineLayer: null,
    markerGroup: L.layerGroup().addTo(map), freshSegment: true,
    endpointGroup: L.layerGroup().addTo(map),
    startPoint: null, endPoint: null, startMarker: null, endMarker: null,
    onEndpointChange: onEndpointChange || null,
  };
}

const START_MARKER_ICON = L.divIcon({
  html: `<div style="width:26px;height:26px;border-radius:50%;background:#2f9e44;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-family:sans-serif;font-weight:700;font-size:12px;">S</div>`,
  className: "", iconSize: [26, 26], iconAnchor: [13, 13],
});
const END_MARKER_ICON = L.divIcon({
  html: `<div style="width:26px;height:26px;border-radius:50%;background:#2563EB;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-family:sans-serif;font-weight:700;font-size:12px;">E</div>`,
  className: "", iconSize: [26, 26], iconAnchor: [13, 13],
});

// Renders (or refreshes) the draggable Start/End markers a person uses to
// tell the editor exactly which end of a combined/edited route is the real
// trailhead and which is the real finish — resolving the ambiguity that a
// fully-automatic guess can't. Markers snap onto real segment endpoints
// only (not arbitrary map taps), and dragging one re-chains the route via
// chainSegmentsWithEndpoints so the order/orientation always matches
// what's shown. If the point a marker was on gets erased/undone, it
// falls back to a sensible default instead of pointing at nothing.
function editorUpdateEndpoints(editor) {
  const validSegs = editor.segments.filter((seg) => Array.isArray(seg) && seg.length >= 2);
  if (validSegs.length === 0) {
    editor.endpointGroup.clearLayers();
    editor.startMarker = null;
    editor.endMarker = null;
    editor.startPoint = null;
    editor.endPoint = null;
    return;
  }

  const allEndpoints = [];
  validSegs.forEach((seg) => { allEndpoints.push(seg[0]); allEndpoints.push(seg[seg.length - 1]); });
  const pointExists = (p) => p && allEndpoints.some((ep) => ep[0] === p[0] && ep[1] === p[1]);
  if (!pointExists(editor.startPoint)) editor.startPoint = validSegs[0][0];
  if (!pointExists(editor.endPoint)) editor.endPoint = validSegs[validSegs.length - 1][validSegs[validSegs.length - 1].length - 1];

  editor.endpointGroup.clearLayers();
  editor.startMarker = L.marker(editor.startPoint, { icon: START_MARKER_ICON, draggable: true, zIndexOffset: 1000 }).addTo(editor.endpointGroup);
  editor.endMarker = L.marker(editor.endPoint, { icon: END_MARKER_ICON, draggable: true, zIndexOffset: 1000 }).addTo(editor.endpointGroup);

  editor.startMarker.on("dragend", () => {
    const dragged = editor.startMarker.getLatLng();
    const match = findClosestSegmentEndpoint(editor.segments.filter((s) => s.length >= 2), [dragged.lat, dragged.lng]);
    if (match) {
      editor.startPoint = match.point;
      editor.startMarker.setLatLng(match.point);
    }
    if (editor.onEndpointChange) editor.onEndpointChange();
  });
  editor.endMarker.on("dragend", () => {
    const dragged = editor.endMarker.getLatLng();
    const match = findClosestSegmentEndpoint(editor.segments.filter((s) => s.length >= 2), [dragged.lat, dragged.lng]);
    if (match) {
      editor.endPoint = match.point;
      editor.endMarker.setLatLng(match.point);
    }
    if (editor.onEndpointChange) editor.onEndpointChange();
  });
}

function editorRedraw(editor) {
  if (!editor.polylineLayer) {
    editor.polylineLayer = L.polyline(editor.segments, { color: "#1B4332", weight: 5 }).addTo(editor.map);
  } else {
    editor.polylineLayer.setLatLngs(editor.segments);
  }
  // Small visible dot at every point, Google-Maps-measure-tool style — makes
  // it clear exactly where each tap landed and where segment breaks are.
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
  editorUpdateEndpoints(editor);
}

// Looks for an existing point (from any segment already on the map — a
// saved trail you started from, one added via "+", or your own earlier
// drawing) within ~20 screen pixels of a tap. Used so a newly hand-drawn
// connector can lock exactly onto a real trail's endpoint instead of
// landing a few feet off — a gap that small still reads as "not merged"
// and silently leaves that stretch out of the mileage total, since two
// trails that meet at roughly the same trailhead almost never share an
// exact coordinate in the source map data.
function editorFindNearbyVertex(editor, latlng, radiusPx) {
  const tapPoint = editor.map.latLngToContainerPoint(latlng);
  let best = null;
  editor.segments.forEach((seg) => {
    seg.forEach((p) => {
      const pt = editor.map.latLngToContainerPoint(p);
      const d = Math.hypot(pt.x - tapPoint.x, pt.y - tapPoint.y);
      if (d <= radiusPx && (!best || d < best.dist)) best = { point: p, dist: d };
    });
  });
  return best ? best.point : null;
}

function editorClick(editor, latlng) {
  if (editor.mode === "pencil") {
    const SNAP_RADIUS_PX = 20;
    const nearby = editorFindNearbyVertex(editor, latlng, SNAP_RADIUS_PX);
    const point = nearby ? [nearby[0], nearby[1]] : [latlng.lat, latlng.lng];
    if (editor.segments.length === 0 || editor.freshSegment) {
      editor.segments.push([]);
      editor.freshSegment = false;
    }
    editor.segments[editor.segments.length - 1].push(point);
    editorRedraw(editor);
  } else if (editor.mode === "eraser") {
    editorEraseNear(editor, latlng);
  }
}

// Erases points within ~24 screen pixels of the touch point — measured in
// pixels (not meters) so it feels consistent at any zoom level, and can
// split a segment in two (leaving a real visual gap) rather than just
// straight-lining across the erased portion.
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
  editorRedraw(editor);
}

function editorUndo(editor) {
  if (editor.segments.length === 0) return;
  const last = editor.segments[editor.segments.length - 1];
  last.pop();
  if (last.length === 0) editor.segments.pop();
  editorRedraw(editor);
}

function editorClear(editor) {
  editor.segments = [];
  editor.freshSegment = true;
  editorRedraw(editor);
}

// Adds another saved trail's geometry as its own separate piece (not
// connected by a straight line) — used both for Create's "Start from" and
// the new "+" add-saved-trail button, and for combining multiple trails
// into one custom route (e.g. stitching West Maroon + Maroon-Snowmass Trail
// together into your own Four Pass Loop).
function editorAddSegments(editor, geometry) {
  if (!geometry) return;
  geometry.forEach((seg) => editor.segments.push(seg.map((p) => [p[0], p[1]])));
  editor.freshSegment = true;
  editorRedraw(editor);
  const allPts = editor.segments.flat();
  if (allPts.length) {
    setTimeout(() => { editor.map.invalidateSize(); editor.map.fitBounds(allPts, { padding: [20, 20] }); }, 30);
  }
}

function editorDistanceKm(editor) {
  let km = 0;
  editor.segments.forEach((seg) => {
    for (let i = 1; i < seg.length; i++) km += haversineKm(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]);
  });
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

// Shows a scrollable list of saved trails to pick from, for the "+" button.
// Uses an overlay rather than replacing modalBody's content, since the
// editor's live Leaflet map instance lives inside modalBody and would be
// destroyed (detached from the DOM) if we replaced its HTML wholesale.
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
  createEditor = makeEditor(createMap, updateCreateStats);
  createMap.on("click", (e) => {
    editorClick(createEditor, e.latlng);
    updateCreateStats();
  });
  editorSetMode(createEditor, "pencil", document.getElementById("createPencilModeBtn"), document.getElementById("createEraserModeBtn"));
  return createMap;
}

function updateCreateStats() {
  const pointCount = createEditor.segments.reduce((s, seg) => s + seg.length, 0);
  document.getElementById("createPointCount").textContent = String(pointCount);
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
  const pointCount = createEditor.segments.reduce((s, seg) => s + seg.length, 0);
  if (pointCount < 2) {
    showToast("Add at least two points first");
    return;
  }

  const chainedGeometry = chainSegmentsWithEndpoints(createEditor.segments, createEditor.startPoint, createEditor.endPoint);
  const validation = validateGeometry(chainedGeometry);
  if (!validation.valid) {
    showToast(validation.error);
    return;
  }

  const km = chainedGeometry.reduce((sum, seg) => {
    for (let i = 1; i < seg.length; i++) sum += haversineKm(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]);
    return sum;
  }, 0);

  openModal("Save your route", `
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Name</span><input id="createName" class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" placeholder="My custom loop" autofocus /></label>
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">State</span><select id="createState" class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm">${stateOptionsHtml("Colorado")}</select></label>
    <p class="text-sm opacity-70 mb-3">${(km * 0.621371).toFixed(1)} mi · ${chainedGeometry.length} segment${chainedGeometry.length !== 1 ? "s" : ""}</p>
    <div class="flex gap-2 mt-4">
      <button id="createCancelBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Cancel</button>
      <button id="createConfirmBtn" class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition w-full">Save</button>
    </div>
  `);
  document.getElementById("createCancelBtn").addEventListener("click", closeModal);
  document.getElementById("createConfirmBtn").addEventListener("click", () => {
    const name = document.getElementById("createName").value.trim() || "Untitled route";
    const state = document.getElementById("createState").value;
    const firstPt = chainedGeometry[0][0];
    wishlist = [{
      id: uid(),
      name,
      location: state,
      notes: `${(km * 0.621371).toFixed(1)} mi · custom drawn route`,
      osm_url: null,
      geometry: chainedGeometry.map((seg) => seg.map((p) => [p[0], p[1]])),
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
    const distMi = parseFloat(document.getElementById("manDist").value) || 0;
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
let currentView = "map";
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

// Shared by the toggle row — keeps the Map/Search/Saved sub-views in sync.
function setDiscoverView(view) {
  currentView = view;
  document.querySelectorAll("#viewToggle .seg").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  const mapEl = document.getElementById("discoverMapView");
  const searchEl = document.getElementById("discoverSearch");
  const savedEl = document.getElementById("discoverSaved");
  if (mapEl) mapEl.classList.toggle("hidden", view !== "map");
  if (searchEl) searchEl.classList.toggle("hidden", view !== "search");
  if (savedEl) savedEl.classList.toggle("hidden", view !== "saved");
  if (view === "saved") renderSaved();
  if (view === "map") {
    setTimeout(() => {
      ensureDiscoverMap();
      if (discoverMap) discoverMap.invalidateSize();
      updateSearchThisAreaButton();
    }, 50);
  }
}

document.querySelectorAll("#viewToggle .seg").forEach((btn) => {
  btn.addEventListener("click", () => setDiscoverView(btn.dataset.view));
});

// ---- Map-first Discover landing view ----
// Deliberately does NOT fetch on every pan/zoom — Overpass is free, shared
// infrastructure and rate-limits aggressively. Pins load on initial view
// (if already zoomed in enough) and via the "Search this area" button,
// same pattern most map apps use for exactly this reason.
let discoverMap = null;
let discoverMapMarkers = null;
let lastFetchedBounds = null;
const MAP_PINS_MAX_SPAN_DEG = 1.5; // mirrors the server-side guard in /api/map-pins

// Colorado Front Range as a starting view — provisional default that
// happens to have good COTREX/OSM trail coverage so first load shows real
// pins immediately rather than an empty "zoom in" prompt. Worth revisiting
// later (e.g. geolocation-based centering) if that'd serve users better.
const DISCOVER_MAP_DEFAULT_CENTER = [39.1, -105.4];
const DISCOVER_MAP_DEFAULT_ZOOM = 10;

const TRAIL_PIN_ICON = L.divIcon({
  html: `<div style="width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#1B4332;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;"><span style="transform:rotate(45deg);font-size:14px;">🥾</span></div>`,
  className: "", iconSize: [30, 30], iconAnchor: [15, 30],
});
const PARK_PIN_ICON = L.divIcon({
  html: `<div style="width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#E3B23C;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;"><span style="transform:rotate(45deg);font-size:14px;">🏞️</span></div>`,
  className: "", iconSize: [30, 30], iconAnchor: [15, 30],
});
const AREA_PIN_ICON = L.divIcon({
  html: `<div style="width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#8a2f22;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;"><span style="transform:rotate(45deg);font-size:14px;">🌲</span></div>`,
  className: "", iconSize: [30, 30], iconAnchor: [15, 30],
});

function ensureDiscoverMap() {
  if (discoverMap) return discoverMap;
  const mapEl = document.getElementById("discoverMap");
  if (!mapEl) {
    showFatalError("Missing #discoverMap — index.html and app.js are out of sync (try a hard refresh / clear site data).");
    return null;
  }
  discoverMap = L.map("discoverMap", { attributionControl: false }).setView(DISCOVER_MAP_DEFAULT_CENTER, DISCOVER_MAP_DEFAULT_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(discoverMap);
  discoverMapMarkers = L.layerGroup().addTo(discoverMap);
  discoverMap.on("moveend zoomend", updateSearchThisAreaButton);
  // First load: if the default view is already zoomed in enough, load pins
  // right away instead of making the person tap the button unnecessarily.
  setTimeout(() => loadMapPins(), 100);
  return discoverMap;
}

function discoverMapBoundsSpan(bounds) {
  return { latSpan: bounds.getNorth() - bounds.getSouth(), lonSpan: bounds.getEast() - bounds.getWest() };
}

function updateSearchThisAreaButton() {
  const btn = document.getElementById("searchThisAreaBtn");
  const hint = document.getElementById("discoverMapHint");
  if (!discoverMap || !btn || !hint) return;
  const { latSpan, lonSpan } = discoverMapBoundsSpan(discoverMap.getBounds());
  const tooWide = latSpan > MAP_PINS_MAX_SPAN_DEG || lonSpan > MAP_PINS_MAX_SPAN_DEG;
  if (tooWide) {
    btn.classList.add("hidden");
    hint.textContent = "Zoom in a bit more to load trails and parks here.";
    hint.classList.remove("hidden");
  } else {
    btn.classList.remove("hidden");
  }
}

async function loadMapPins() {
  if (!discoverMap) return;
  const bounds = discoverMap.getBounds();
  const { latSpan, lonSpan } = discoverMapBoundsSpan(bounds);
  if (latSpan > MAP_PINS_MAX_SPAN_DEG || lonSpan > MAP_PINS_MAX_SPAN_DEG) {
    updateSearchThisAreaButton();
    return;
  }

  const hint = document.getElementById("discoverMapHint");
  const btn = document.getElementById("searchThisAreaBtn");
  if (!hint || !btn) {
    showFatalError("Missing #discoverMapHint or #searchThisAreaBtn — index.html and app.js are out of sync (try a hard refresh / clear site data).");
    return;
  }
  hint.textContent = "Loading trails and parks…";
  hint.classList.remove("hidden");
  btn.classList.add("hidden");

  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  try {
    const params = new URLSearchParams({ swLat: sw.lat, swLon: sw.lng, neLat: ne.lat, neLon: ne.lng });
    // Render's free tier can take 30-60s to wake from idle. Without a
    // timeout, a slow/hanging first request leaves "Loading…" stuck with
    // no visible signal that anything is wrong — this guarantees a message
    // appears either way instead of hanging indefinitely.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    let resp;
    try {
      resp = await fetch(`/api/map-pins?${params.toString()}`, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    const data = await resp.json();
    if (!resp.ok) {
      hint.textContent = data.error || "Couldn't load this area.";
      btn.classList.remove("hidden");
      return;
    }
    renderMapPins(data);
    lastFetchedBounds = bounds;
    const parkAndAreaCount = data.parks.length + data.areas.length;
    hint.textContent = (data.trails.length === 0 && parkAndAreaCount === 0)
      ? "Nothing found in this area. Try panning or zooming out a bit."
      : `${data.trails.length} trail${data.trails.length !== 1 ? "s" : ""} · ${parkAndAreaCount} park${parkAndAreaCount !== 1 ? "s" : ""}/area${parkAndAreaCount !== 1 ? "s" : ""} shown.`;
  } catch (err) {
    console.error("Map pins load failed:", err);
    hint.textContent = err.name === "AbortError"
      ? "Timed out waiting for the server (it may be waking up from idle) — tap Search this area to retry."
      : "Couldn't reach the server. Is it running?";
    btn.classList.remove("hidden");
  }
}

function renderMapPins(data) {
  discoverMapMarkers.clearLayers();

  data.trails.forEach((t) => {
    const marker = L.marker([t.lat, t.lon], { icon: TRAIL_PIN_ICON }).addTo(discoverMapMarkers);
    marker.bindTooltip(`${escapeHtml(t.name)} · ${(t.distance_km * 0.621371).toFixed(1)} mi`, { direction: "top", offset: [0, -28] });
    marker.on("click", () => openTrailDetail({
      name: t.name,
      state: "",
      distance_km: t.distance_km,
      difficulty: t.difficulty,
      surface: t.surface,
      segments: t.segments,
      geometry: t.geometry,
      lat: t.lat,
      lon: t.lon,
      osm_url: null,
    }));
  });

  data.parks.forEach((p) => {
    const marker = L.marker([p.lat, p.lon], { icon: PARK_PIN_ICON }).addTo(discoverMapMarkers);
    marker.bindTooltip(escapeHtml(p.name), { direction: "top", offset: [0, -28] });
    marker.on("click", () => openParkDetail({
      name: p.name,
      state: "",
      kind: p.kind,
      lat: p.lat,
      lon: p.lon,
      osm_url: `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=13/${p.lat}/${p.lon}`,
    }));
  });

  data.areas.forEach((a) => {
    const marker = L.marker([a.lat, a.lon], { icon: AREA_PIN_ICON }).addTo(discoverMapMarkers);
    marker.bindTooltip(escapeHtml(a.name), { direction: "top", offset: [0, -28] });
    marker.on("click", () => openParkDetail({
      name: a.name,
      state: "",
      kind: a.kind,
      lat: a.lat,
      lon: a.lon,
      osm_url: `https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lon}#map=12/${a.lat}/${a.lon}`,
    }));
  });
}

safeOnClick("searchThisAreaBtn", loadMapPins);



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
    activeModalMap._fitBounds = bounds.length ? bounds : null; // reused on maximize/minimize resize
  }, 0);

  const pencilBtn = document.getElementById("modalPencil");
  pencilBtn.classList.remove("hidden");
  pencilBtn.onclick = () => enterMapEditMode(trail);
}

// ---- Trail-detail map editor: erase/redraw/combine an existing trail into
// your own custom route, without leaving the trail detail page. ----
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

  // Swap header: hide the entry pencil + maximize, show pencil/eraser/+ editing controls.
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
    modalEditor = makeEditor(map, null);
    // Start from a copy of the trail's existing geometry, not a live reference.
    modalEditor.segments = (trail.geometry || []).map((seg) => seg.map((p) => [p[0], p[1]]));
    editorRedraw(modalEditor);
    const allPts = modalEditor.segments.flat();
    if (allPts.length) map.fitBounds(allPts, { padding: [16, 16] });
    else map.setView([trail.lat, trail.lon], 12);

    map.on("click", (e) => editorClick(modalEditor, e.latlng));
    editorSetMode(modalEditor, "pencil", editPencilBtn, editEraserBtn);
  }, 250);

  editPencilBtn.onclick = () => editorSetMode(modalEditor, "pencil", editPencilBtn, editEraserBtn);
  editEraserBtn.onclick = () => editorSetMode(modalEditor, "eraser", editPencilBtn, editEraserBtn);
  editAddBtn.onclick = () => openAddSavedTrailPicker((picked) => editorAddSegments(modalEditor, picked.geometry));

  document.getElementById("editUndoBtn").onclick = () => editorUndo(modalEditor);
  document.getElementById("editClearBtn").onclick = () => editorClear(modalEditor);
  document.getElementById("editSaveBtn").onclick = () => {
    const pointCount = modalEditor.segments.reduce((s, seg) => s + seg.length, 0);
    if (pointCount < 2) { showToast("Add at least two points first"); return; }

    const chainedGeometry = chainSegmentsWithEndpoints(modalEditor.segments, modalEditor.startPoint, modalEditor.endPoint);
    const validation = validateGeometry(chainedGeometry);
    if (!validation.valid) {
      showToast(validation.error);
      return;
    }

    const km = chainedGeometry.reduce((sum, seg) => {
      for (let i = 1; i < seg.length; i++) sum += haversineKm(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]);
      return sum;
    }, 0);

    const overlay = document.createElement("div");
    overlay.className = "absolute inset-0 bg-paper z-[1200] p-5 overflow-y-auto rounded-3xl";
    overlay.innerHTML = `
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Name</span><input id="editRouteName" class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" placeholder="${escapeHtml(modalEditingTrail.name)} (edited)" autofocus /></label>
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">State</span><select id="editRouteState" class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm">${stateOptionsHtml(modalEditingTrail.state && ALL_STATES.includes(modalEditingTrail.state) ? modalEditingTrail.state : "Colorado")}</select></label>
      <p class="text-sm opacity-70 mb-3">${(km * 0.621371).toFixed(1)} mi · ${chainedGeometry.length} segment${chainedGeometry.length !== 1 ? "s" : ""}</p>
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
      const firstPt = chainedGeometry[0][0];
      wishlist = [{
        id: uid(),
        name,
        location: state,
        notes: `${(km * 0.621371).toFixed(1)} mi · edited from ${modalEditingTrail.name}`,
        osm_url: null,
        geometry: chainedGeometry.map((seg) => seg.map((p) => [p[0], p[1]])),
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

// Tries an OSM-authored description first, then a Wikipedia summary for
// well-known trails, and otherwise leaves the auto-generated fallback
// (already shown) in place.
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
    // leave the auto-generated/default description as-is
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
let lastElevationData = null; // { sampled, elevations, trailName, geometry, lat, lon } — reused by the expand modal
let detailMiniMapInstance = null;
const detailScrubMarker = { marker: null };

// Small circular marker using the app icon, used to show where you are along
// the trail as you drag your finger across the elevation chart.
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
  // Force this one open large immediately — a split map+chart view benefits
  // from more room right away rather than requiring a separate maximize tap.
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

async function loadElevationChart(trail) {
  const note = document.getElementById("elevationNote");
  try {
    // Flatten geometry, tracking which points start a new segment.
    // Combined/edited custom routes can have segments that don't
    // physically touch (stitched trails, eraser gaps) — the distance
    // "between" segments isn't real walked distance and must NOT be
    // added to cumulative mileage, or sample spacing and the scrub
    // marker both get thrown off by a fake multi-mile jump.
    const allPoints = [];
    const isSegmentStart = [];
    trail.geometry.forEach((seg) => {
      seg.forEach((pt, i) => {
        allPoints.push(pt);
        isSegmentStart.push(i === 0);
      });
    });
    if (allPoints.length < 2) throw new Error("not enough points");

    const cum = [0];
    for (let i = 1; i < allPoints.length; i++) {
      if (isSegmentStart[i]) {
        cum.push(cum[i - 1]);
      } else {
        cum.push(cum[i - 1] + haversineKm(allPoints[i - 1][0], allPoints[i - 1][1], allPoints[i][0], allPoints[i][1]));
      }
    }
    const totalKm = cum[cum.length - 1];
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
    const elevations = data.elevations; // feet, may contain nulls for points with no data

    const known = elevations.filter((e) => e !== null && e !== undefined);
    if (known.length < 2) throw new Error("not enough elevation data returned");

    let gainFt = 0;
    for (let i = 1; i < elevations.length; i++) {
      if (elevations[i] != null && elevations[i - 1] != null && elevations[i] > elevations[i - 1]) {
        gainFt += elevations[i] - elevations[i - 1];
      }
    }

    lastElevationData = { sampled, elevations, trailName: trail.name, geometry: trail.geometry, lat: trail.lat, lon: trail.lon };
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

  status.textContent = searchMode === "city
