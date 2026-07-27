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
const fmtDist = (meters) => (meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`);
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
const tabs = ["discover", "track", "journal"];
function switchTab(tab) {
  tabs.forEach((t) => {
    document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  if (tab === "track") setTimeout(() => { ensureTrackMap(); trackMap.invalidateSize(); }, 50);
}
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ---------- modal ----------
const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");

function openModal(title, bodyHtml) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalOverlay.classList.remove("hidden");
}
function closeModal() {
  modalOverlay.classList.add("hidden");
  modalBody.innerHTML = "";
}
document.getElementById("modalClose").addEventListener("click", closeModal);
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
  walkedLine = L.polyline([], { color: "#1B4332", weight: 5 }).addTo(trackMap);
  return trackMap;
}

function populateTrailPicker() {
  const current = trailPicker.value;
  trailPicker.innerHTML = `<option value="">Freehand (no saved route)</option>` +
    wishlist.filter((w) => w.geometry).map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("");
  if (wishlist.some((w) => w.id === current)) trailPicker.value = current;
}

function selectTrailToFollow(id) {
  const map = ensureTrackMap();
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  followedTrail = wishlist.find((w) => w.id === id) || null;

  if (followedTrail && followedTrail.geometry) {
    const bounds = [];
    const group = L.layerGroup();
    followedTrail.geometry.forEach((seg) => {
      if (seg.length < 2) return;
      L.polyline(seg, { color: "#E3B23C", weight: 4, dashArray: "2 10" }).addTo(group);
      seg.forEach((pt) => bounds.push(pt));
    });
    routeLine = group.addTo(map);
    if (bounds.length) map.fitBounds(bounds, { padding: [24, 24] });
    trackState.textContent = tracking ? "Tracking" : `Following ${followedTrail.name}`;
  } else {
    trackState.textContent = tracking ? "Tracking" : "Ready when you are";
    map.setView([39.5, -98.35], 4);
  }
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
          liveDot = L.circleMarker([p.lat, p.lng], { radius: 7, color: "#8a2f22", fillColor: "#E3B23C", fillOpacity: 1, weight: 2 }).addTo(map);
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
    <p class="condensed" style="font-size:1.1rem;color:var(--pine);display:flex;gap:20px;margin-bottom:14px;">
      <span>${fmtDist(distance)}</span><span>${fmtTime(elapsed)}</span><span>${caloriesFromKm(distance / 1000)} cal</span>
    </p>
    <label class="field"><span class="label">Name</span><input id="trackName" placeholder="Ridge Trail loop" value="${followedTrail ? escapeHtml(followedTrail.name) : ""}" autofocus /></label>
    <label class="field"><span class="label">Notes</span><textarea id="trackNotes" rows="3" placeholder="Muddy near the summit, worth it for the view"></textarea></label>
    <div class="modal-actions">
      <button id="discardTrackBtn" class="pill-btn outline">Discard</button>
      <button id="saveTrackBtn" class="pill-btn pine">Save</button>
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

// ================= JOURNAL =================
function renderJournal() {
  const list = document.getElementById("journalList");
  if (hikes.length === 0) {
    list.innerHTML = `<div class="empty">No hikes logged yet. Track one, or add a past hike by hand.</div>`;
    return;
  }
  list.innerHTML = hikes.map((h) => `
    <div class="card">
      <button class="delete-btn" data-delete-hike="${h.id}" aria-label="Delete hike">✕</button>
      <p class="state">${fmtDate(h.date)}</p>
      <h3>${escapeHtml(h.name)}</h3>
      <div class="stats">
        <span>${fmtDist(h.distance || 0)}</span>
        <span>${fmtTime(h.duration || 0)}</span>
      </div>
      ${h.notes ? `<p class="notes">${escapeHtml(h.notes)}</p>` : ""}
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
    <label class="field"><span class="label">Name</span><input id="manName" placeholder="Blue Ridge overlook" autofocus /></label>
    <label class="field"><span class="label">Date</span><input id="manDate" type="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
    <div class="field-row">
      <label class="field"><span class="label">Distance (km)</span><input id="manDist" type="number" step="0.1" placeholder="8.5" /></label>
      <label class="field"><span class="label">Hours</span><input id="manH" type="number" placeholder="2" /></label>
      <label class="field"><span class="label">Min</span><input id="manM" type="number" placeholder="30" /></label>
    </div>
    <label class="field"><span class="label">Notes</span><textarea id="manNotes" rows="2"></textarea></label>
    <div class="modal-actions">
      <button id="manSaveBtn" class="pill-btn pine" style="width:100%">Save hike</button>
    </div>
  `);
  document.getElementById("manSaveBtn").addEventListener("click", () => {
    const name = document.getElementById("manName").value.trim();
    if (!name) return;
    const date = document.getElementById("manDate").value;
    const distKm = parseFloat(document.getElementById("manDist").value) || 0;
    const h = parseInt(document.getElementById("manH").value) || 0;
    const m = parseInt(document.getElementById("manM").value) || 0;
    const notes = document.getElementById("manNotes").value.trim();
    hikes = [{ id: uid(), date: date ? new Date(date).toISOString() : new Date().toISOString(), name, distance: distKm * 1000, duration: h * 3600 + m * 60, notes, path: null, source: "manual" }, ...hikes];
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
    input.placeholder = searchMode === "city" ? "Search a city (e.g. Boulder)" : "Search trail name (optional)";
  });
});

document.querySelectorAll(".seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentView = btn.dataset.view;
    document.getElementById("discoverSearch").classList.toggle("hidden", currentView !== "search");
    document.getElementById("discoverSaved").classList.toggle("hidden", currentView !== "saved");
    if (currentView === "saved") renderSaved();
  });
});

async function loadStates() {
  const select = document.getElementById("state");
  try {
    const res = await fetch("/api/states");
    const { states } = await res.json();
    select.innerHTML = states.map((s) => `<option value="${s}">${s}</option>`).join("");
    select.value = "Colorado";
  } catch {
    select.innerHTML = `<option value="Colorado">Colorado</option>`;
  }
}

function renderSearchResults(trails) {
  const filtered = currentDifficulty === "All" ? trails : trails.filter((t) => t.difficulty === currentDifficulty);
  const el = document.getElementById("results");
  if (filtered.length === 0) {
    el.innerHTML = `<div class="empty">No trails matched. Try a different state, search term, or difficulty.</div>`;
    return;
  }
  el.innerHTML = filtered.map((t, i) => `
    <div class="card">
      <p class="state">${escapeHtml(t.state)}${t.segments > 1 ? ` · ${t.segments} mapped segments` : ""}</p>
      <h3>${escapeHtml(t.name)}</h3>
      <div class="stats">
        <span>${t.distance_km.toFixed(1)} km</span>
        <span class="badge">${t.difficulty}</span>
        ${t.surface ? `<span class="badge">${escapeHtml(t.surface)}</span>` : ""}
      </div>
      <div class="card-actions">
        <button class="pill-btn outline" data-map-idx="${i}">Map</button>
        <button class="pill-btn outline" data-save-idx="${i}">Save</button>
        <button class="pill-btn pine" data-log-idx="${i}">Log as hiked</button>
      </div>
      <a class="map-link" href="${t.osm_url}" target="_blank" rel="noopener">View on OpenStreetMap →</a>
    </div>
  `).join("");

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

function openTrailMapModal(trail) {
  const hasGeometry = trail.geometry && trail.geometry.some((seg) => seg.length > 1);
  openModal(trail.name, hasGeometry
    ? `<div class="modal-map" id="trailModalMap"></div><p class="fine-print">Path shown is mapped OpenStreetMap data — actual conditions on the ground may differ.</p>`
    : `<p class="empty">No mapped path is available for this trail yet.</p>`);
  if (!hasGeometry) return;

  setTimeout(() => {
    const map = L.map("trailModalMap", { attributionControl: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(map);
    const bounds = [];
    trail.geometry.forEach((seg) => {
      if (seg.length < 2) return;
      L.polyline(seg, { color: "#1B4332", weight: 4 }).addTo(map);
      seg.forEach((pt) => bounds.push(pt));
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [20, 20] });
    else map.setView([trail.lat, trail.lon], 12);
  }, 0);
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
    notes: `${trail.distance_km.toFixed(1)} km · ${trail.difficulty}`,
    osm_url: trail.osm_url,
    geometry: trail.geometry || null,
    lat: trail.lat,
    lon: trail.lon,
  }, ...wishlist];
  saveWishlist(wishlist);
  showToast("Saved to your list");
  populateTrailPicker();
}

function renderSaved() {
  const el = document.getElementById("savedList");
  if (wishlist.length === 0) {
    el.innerHTML = `<div class="empty">Nothing saved yet — search a state and tap Save on a trail.</div>`;
    return;
  }
  el.innerHTML = wishlist.map((w) => `
    <div class="card">
      <button class="delete-btn" data-delete-wish="${w.id}" aria-label="Remove">✕</button>
      <h3>${escapeHtml(w.name)}</h3>
      <p class="state">${escapeHtml(w.location || "")}</p>
      ${w.notes ? `<p class="notes">${escapeHtml(w.notes)}</p>` : ""}
      <div class="card-actions">
        ${w.geometry ? `<button class="pill-btn outline" data-track-wish="${w.id}">Track this</button>` : ""}
        <button class="pill-btn pine" data-complete-wish="${w.id}">Mark as hiked</button>
        ${w.osm_url ? `<a class="map-link" href="${w.osm_url}" target="_blank" rel="noopener">Map →</a>` : ""}
      </div>
    </div>
  `).join("");

  el.querySelectorAll("[data-delete-wish]").forEach((btn) => {
    btn.addEventListener("click", () => {
      wishlist = wishlist.filter((w) => w.id !== btn.dataset.deleteWish);
      saveWishlist(wishlist);
      renderSaved();
      populateTrailPicker();
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
    <label class="field"><span class="label">Date</span><input id="cDate" type="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
    <div class="field-row">
      <label class="field"><span class="label">Distance (km)</span><input id="cDist" type="number" step="0.1" value="${trail.distance_km ? trail.distance_km.toFixed(1) : ""}" /></label>
      <label class="field"><span class="label">Hours</span><input id="cH" type="number" placeholder="2" /></label>
      <label class="field"><span class="label">Min</span><input id="cM" type="number" placeholder="30" /></label>
    </div>
    <label class="field"><span class="label">Notes</span><textarea id="cNotes" rows="2" placeholder="${escapeHtml(trail.notes || "")}"></textarea></label>
    <div class="modal-actions">
      <button id="cSaveBtn" class="pill-btn pine" style="width:100%">Move to journal</button>
    </div>
  `);
  document.getElementById("cSaveBtn").addEventListener("click", () => {
    const date = document.getElementById("cDate").value;
    const distKm = parseFloat(document.getElementById("cDist").value) || 0;
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
switchTab("discover");
