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
        urls.push(`https://\( {sub}.tile.openstreetmap.org/ \){z}/\( {x}/ \){y}.png`);
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
      buttonEl.textContent = `Downloading… \( {event.data.done}/ \){event.data.total}`;
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
  return h > 0 ? `\( {h}: \){String(m).padStart(2, "0")}:\( {String(sec).padStart(2, "0")}` : ` \){m}:${String(sec).padStart(2, "0")}`;
};
const fmtDist = (meters) => {
  const feet = meters * 3.28084;
  return feet >= 528 ? `\( {(meters / 1609.34).toFixed(2)} mi` : ` \){Math.round(feet)} ft`;
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
  return ALL_STATES.map((s) => `<option value="${s}" \( {s === selected ? "selected" : ""}> \){s}</option>`).join("");
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const la1 = (lat1 * Math.PI) / 180, la2 = (lat2 * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
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
let activeModalMap = null;

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
let followedTrail = null;

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
let routeLine = null;
let walkedLine = null;
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
    wishlist.filter((w) => w.geometry).map((w) => `<option value="\( {w.id}"> \){escapeHtml(w.name)}</option>`).join("");
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
      <span>\( {fmtDist(distance)}</span><span> \){fmtTime(elapsed)}</span><span>${caloriesFromKm(distance / 1000)} cal</span>
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
function makeEditor(map) {
  return { map, segments: [], mode: "pencil", polylineLayer: null, markerGroup: L.layerGroup().addTo(map), freshSegment: true };
}

function editorRedraw(editor) {
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
}

function editorClick(editor, latlng) {
  const point = [latlng.lat, latlng.lng];
  if (editor.mode === "pencil") {
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
    wishlist.filter((w) => w.geometry).map((w) => `<option value="\( {w.id}"> \){escapeHtml(w.name)}</option>`).join("");
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
  const km = editorDistanceKm(createEditor);
  openModal("Save your route", `
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Name</span><input id="createName" class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" placeholder="My custom loop" autofocus /></label>
    <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">State</span><select id="createState" class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm">${stateOptionsHtml("Colorado")}</select></label>
    <p class="text-sm opacity-70 mb-3">${(km * 0.621371).toFixed(1)} mi · \( {createEditor.segments.length} segment \){createEditor.segments.length !== 1 ? "s" : ""}</p>
    <div class="flex gap-2 mt-4">
      <button id="createCancelBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Cancel</button>
      <button id="createConfirmBtn" class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition w-full">Save</button>
    </div>
  `);
  document.getElementById("createCancelBtn").addEventListener("click", closeModal);
  document.getElementById("createConfirmBtn").addEventListener("click", () => {
    const name = document.getElementById("createName").value.trim() || "Untitled route";
    const state = document.getElementById("createState").value;
    const firstPt = createEditor.segments[0][0];
    wishlist = [{
      id: uid(),
      name,
      location: state,
      notes: `${(km * 0.621371).toFixed(1)} mi · custom drawn route`,
      osm_url: null,
      geometry: createEditor.segments.map((seg) => seg.map((p) => [p[0], p[1]])),
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
      \( {h.notes ? `<p class="text-sm opacity-70 mt-1"> \){escapeHtml(h.notes)}</p>` : ""}
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
    select.innerHTML = states.map((s) => `<option value="\( {s}"> \){s}</option>`).join("");
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
      <p class="font-condensed text-xs uppercase tracking-wide opacity-60">\( {escapeHtml(t.state)} \){t.segments > 1 ? ` · ${t.segments} mapped segments` : ""}</p>
      <h3 class="font-display text-lg cursor-pointer underline decoration-line underline-offset-4 block" data-detail-idx="\( {i}"> \){escapeHtml(t.name)}</h3>
      <div class="flex flex-wrap gap-2 my-2">
        <span>${(t.distance_km * 0.621371).toFixed(1)} mi</span>
        <span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${t.difficulty}</span>
        \( {t.surface ? `<span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium"> \){escapeHtml(t.surface)}</span>` : ""}
      </div>
      <div class="flex gap-2 mt-3 flex-
