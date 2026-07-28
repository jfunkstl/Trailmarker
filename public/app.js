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
  followedTrail = wishlist.find((w) => w.id === id) || null;
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
      <label class="block mb-3"><span class="font-condensed uppercase text-xs tracking-wide opacity-60">Distance (km)</span><input class="w-full mt-1 rounded-xl border border-line bg-card px-3 py-2 text-sm" id="manDist" type="number" step="0.1" placeholder="8.5" /></label>
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
    input.placeholder = searchMode === "city" ? "Search a city (e.g. Boulder)"
      : searchMode === "parks" ? "Search park name (optional)"
      : "Search trail name (optional)";
    document.getElementById("difficultyFilters").classList.toggle("hidden", searchMode === "parks");
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
    el.innerHTML = `<div class="text-center text-sm opacity-60 py-8">No trails matched. Try a different state, search term, or difficulty.</div>`;
    return;
  }
  el.innerHTML = filtered.map((t, i) => `
    <div class="relative bg-card border border-line rounded-2xl p-4">
      <p class="font-condensed text-xs uppercase tracking-wide opacity-60">${escapeHtml(t.state)}${t.segments > 1 ? ` · ${t.segments} mapped segments` : ""}</p>
      <h3 class="font-display text-lg cursor-pointer underline decoration-line underline-offset-4 block" data-detail-idx="${i}">${escapeHtml(t.name)}</h3>
      <div class="flex flex-wrap gap-2 my-2">
        <span>${t.distance_km.toFixed(1)} km</span>
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
  openModal(park.name, `<div class="w-full h-[300px] rounded-2xl overflow-hidden border border-line mb-3" id="trailModalMap"></div>`);
  setTimeout(() => {
    const map = L.map("trailModalMap", { attributionControl: false }).setView([park.lat, park.lon], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(map);
    L.marker([park.lat, park.lon]).addTo(map).bindPopup(park.name);
  }, 0);
}

function openParkDetail(park) {
  document.getElementById("detailTitle").textContent = park.name;
  document.getElementById("detailBody").innerHTML = `
    <p class="font-condensed text-xs uppercase tracking-wide opacity-60">${escapeHtml(park.state)}</p>
    <div class="flex flex-wrap gap-2 my-2"><span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${escapeHtml(park.kind)}</span></div>
    <p class="leading-relaxed my-3" id="trailDescriptionText">Location is mapped from OpenStreetMap's park boundary data. Elevation profiles aren't shown for parks since they cover an area rather than a single path — check a specific trail inside the park for that.</p>
    <div class="my-3.5">
      <div class="relative rounded-2xl overflow-hidden cursor-pointer border border-line"><div class="w-full h-[160px] bg-card pointer-events-none" id="detailMiniMap"></div><div class="absolute inset-0 z-[5] cursor-pointer" id="detailMiniMapOverlay"></div></div>
      <p class="text-xs opacity-60 mt-1 text-center">Tap map to expand</p>
    </div>
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

function openTrailMapModal(trail) {
  const hasGeometry = trail.geometry && trail.geometry.some((seg) => seg.length > 1);
  openModal(trail.name, hasGeometry
    ? `<div class="w-full h-[300px] rounded-2xl overflow-hidden border border-line mb-3" id="trailModalMap"></div><p class="text-xs opacity-60 mt-1">Path shown is mapped OpenStreetMap data — actual conditions on the ground may differ.</p>`
    : `<p class="text-center text-sm opacity-60 py-8">No mapped path is available for this trail yet.</p>`);
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

// Tries an OSM-authored description first, then a Wikipedia summary for
// well-known trails, and otherwise leaves the auto-generated fallback
// (already shown) in place.
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
    let p = `This trail runs about ${trail.distance_km.toFixed(1)} km`;
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
        <span>${trail.distance_km.toFixed(1)} km</span>
        <span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${trail.difficulty}</span>
        ${trail.surface ? `<span class="inline-block bg-chipbg rounded-full px-2.5 py-1 text-xs font-medium">${escapeHtml(trail.surface)}</span>` : ""}
      </div>`
    : trail.savedNotes ? `<p class="text-sm opacity-70 mt-1">${escapeHtml(trail.savedNotes)}</p>` : "";

  document.getElementById("detailBody").innerHTML = `
    <p class="font-condensed text-xs uppercase tracking-wide opacity-60">${escapeHtml(trail.state || "")}${trail.segments > 1 ? ` · ${trail.segments} mapped segments` : ""}</p>
    ${factsHtml}
    <p class="leading-relaxed my-3" id="trailDescriptionText">${buildTrailDescription(trail)}</p>
    <div class="my-3.5">
      ${hasGeometry ? `<div class="relative rounded-2xl overflow-hidden cursor-pointer border border-line"><div class="w-full h-[160px] bg-card pointer-events-none" id="detailMiniMap"></div><div class="absolute inset-0 z-[5] cursor-pointer" id="detailMiniMapOverlay"></div></div><p class="text-xs opacity-60 mt-1 text-center">Tap map to expand</p>` : `<p class="text-center text-sm opacity-60 py-8">No mapped path available.</p>`}
    </div>
    <div class="bg-card border border-line rounded-2xl p-3.5 mt-3.5">
      <p class="font-condensed uppercase tracking-wide text-xs opacity-60 mb-1 block">Elevation profile</p>
      <canvas id="elevationChart" height="140"></canvas>
      <p class="text-xs opacity-60 mt-1" id="elevationNote">Loading elevation data…</p>
    </div>
    <div class="flex gap-2 mt-3.5 flex-wrap">
      <button id="detailSaveBtn" class="rounded-full border border-pine text-pine font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:bg-pine hover:text-white transition">Save</button>
      <button id="detailLogBtn" class="rounded-full bg-pine text-white font-condensed font-semibold uppercase text-xs tracking-wide px-4 py-2 hover:opacity-90 transition">Log as hiked</button>
    </div>
    ${trail.osm_url ? `<a class="block text-sm text-pine underline mt-2" href="${trail.osm_url}" target="_blank" rel="noopener">View on OpenStreetMap →</a>` : ""}
  `;

  document.getElementById("detailSaveBtn").addEventListener("click", () => saveToWishlist(trail));
  document.getElementById("detailLogBtn").addEventListener("click", () => openCompleteModal(trail));
  document.getElementById("trailDetailOverlay").classList.remove("hidden");
  loadRichDescription(trail);

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
async function loadElevationChart(trail) {
  const note = document.getElementById("elevationNote");
  try {
    // Flatten geometry into one path with cumulative distance, then sample
    // ~20 evenly spaced points (Open-Elevation is slow with too many points).
    const allPoints = [];
    trail.geometry.forEach((seg) => seg.forEach((pt) => allPoints.push(pt)));
    if (allPoints.length < 2) throw new Error("not enough points");

    const cum = [0];
    for (let i = 1; i < allPoints.length; i++) {
      cum.push(cum[i - 1] + haversineKm(allPoints[i - 1][0], allPoints[i - 1][1], allPoints[i][0], allPoints[i][1]));
    }
    const totalKm = cum[cum.length - 1];
    const SAMPLES = 20;
    const sampled = [];
    for (let i = 0; i < SAMPLES; i++) {
      const targetDist = (i / (SAMPLES - 1)) * totalKm;
      let idx = cum.findIndex((d) => d >= targetDist);
      if (idx === -1) idx = allPoints.length - 1;
      sampled.push({ point: allPoints[idx], km: cum[idx] });
    }

    const locString = sampled.map((s) => `${s.point[0]},${s.point[1]}`).join("|");
    const resp = await fetch(`/api/elevation?locations=${encodeURIComponent(locString)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "elevation API error");
    const elevations = data.elevations;
    const gainM = elevations.reduce((sum, e, i) => (i > 0 && e > elevations[i - 1] ? sum + (e - elevations[i - 1]) : sum), 0);

    if (elevationChartInstance) elevationChartInstance.destroy();
    const ctx = document.getElementById("elevationChart");
    elevationChartInstance = new Chart(ctx, {
      type: "line",
      data: {
        labels: sampled.map((s) => s.km.toFixed(1)),
        datasets: [{
          data: elevations,
          borderColor: "#1B4332",
          backgroundColor: "rgba(27,67,50,0.12)",
          fill: true,
          tension: 0.3,
          pointRadius: 0,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: "km" } },
          y: { title: { display: true, text: "m elevation" } },
        },
      },
    });
    note.textContent = `Approx. ${Math.round(gainM)} m elevation gain, estimated from sampled points.`;
  } catch (err) {
    console.error(err);
    note.textContent = "Elevation data isn't available for this trail right now.";
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
      status.textContent = `${data.parks.length} park${data.parks.length !== 1 ? "s" : ""} found in ${state}${data.cached ? " (cached)" : ""} — national, state, and city parks together.`;
      renderParkResults(lastResults);
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
        ${w.osm_url ? `<a class="block text-sm text-pine underline mt-2" href="${w.osm_url}" target="_blank" rel="noopener">Map →</a>` : ""}
      </div>
    </div>
  `).join("");

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
