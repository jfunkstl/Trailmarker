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
const tabs = ["track", "journal", "discover"];
function switchTab(tab) {
  tabs.forEach((t) => {
    document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
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

const trackBtn = document.getElementById("trackBtn");
const trackBtnIcon = document.getElementById("trackBtnIcon");
const timerDisplay = document.getElementById("timerDisplay");
const distanceDisplay = document.getElementById("distanceDisplay");
const trackState = document.getElementById("trackState");
const trackHint = document.getElementById("trackHint");
const gpsNote = document.getElementById("gpsNote");

function startTracking() {
  distance = 0; elapsed = 0; path = []; lastPoint = null;
  tracking = true;
  gpsNote.classList.remove("show");
  trackBtn.classList.add("recording");
  trackBtnIcon.textContent = "■";
  trackState.textContent = "Tracking";
  trackHint.textContent = "Tap to stop and save";
  timerDisplay.textContent = fmtTime(0);
  distanceDisplay.textContent = fmtDist(0);

  timerId = setInterval(() => {
    elapsed += 1;
    timerDisplay.textContent = fmtTime(elapsed);
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
          }
        }
        lastPoint = p;
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
  trackState.textContent = "Ready when you are";
  trackHint.textContent = "Tap to start tracking";
  openSaveTrackModal();
}

function openSaveTrackModal() {
  openModal("Save this hike", `
    <p class="condensed" style="font-size:1.1rem;color:var(--pine);display:flex;gap:20px;margin-bottom:14px;">
      <span>${fmtDist(distance)}</span><span>${fmtTime(elapsed)}</span>
    </p>
    <label class="field"><span class="label">Name</span><input id="trackName" placeholder="Ridge Trail loop" autofocus /></label>
    <label class="field"><span class="label">Notes</span><textarea id="trackNotes" rows="3" placeholder="Muddy near the summit, worth it for the view"></textarea></label>
    <div class="modal-actions">
      <button id="discardTrackBtn" class="pill-btn outline">Discard</button>
      <button id="saveTrackBtn" class="pill-btn pine">Save</button>
    </div>
  `);
  document.getElementById("discardTrackBtn").addEventListener("click", () => {
    distance = 0; elapsed = 0; path = [];
    closeModal();
  });
  document.getElementById("saveTrackBtn").addEventListener("click", () => {
    const name = document.getElementById("trackName").value.trim() || "Untitled hike";
    const notes = document.getElementById("trackNotes").value.trim();
    hikes = [{ id: uid(), date: new Date().toISOString(), name, distance, duration: elapsed, notes, path, source: "tracked" }, ...hikes];
    saveHikes(hikes);
    distance = 0; elapsed = 0; path = [];
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
        <button class="pill-btn outline" data-save-idx="${i}">Save</button>
        <button class="pill-btn pine" data-log-idx="${i}">Log as hiked</button>
      </div>
      <a class="map-link" href="${t.osm_url}" target="_blank" rel="noopener">View on OpenStreetMap →</a>
    </div>
  `).join("");

  el.querySelectorAll("[data-save-idx]").forEach((btn) => {
    btn.addEventListener("click", () => saveToWishlist(filtered[Number(btn.dataset.saveIdx)]));
  });
  el.querySelectorAll("[data-log-idx]").forEach((btn) => {
    btn.addEventListener("click", () => openCompleteModal(filtered[Number(btn.dataset.logIdx)]));
  });
}

async function runSearch() {
  const state = document.getElementById("state").value;
  const q = document.getElementById("query").value.trim();
  const status = document.getElementById("status");
  const searchBtn = document.getElementById("searchBtn");
  status.textContent = `Searching live OpenStreetMap data for ${state}…`;
  document.getElementById("results").innerHTML = "";
  searchBtn.disabled = true;

  try {
    const params = new URLSearchParams({ state });
    if (q) params.set("q", q);
    const res = await fetch(`/api/trails?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      status.textContent = `Error: ${data.error || "something went wrong"}`;
      return;
    }
    lastResults = data.trails;
    status.textContent = `${data.trails.length} named trail${data.trails.length !== 1 ? "s" : ""} found in ${state}${data.cached ? " (cached)" : ""}. Distances are approximate, computed from mapped geometry.`;
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
  wishlist = [{ id: uid(), name: trail.name, location: trail.state, notes: `${trail.distance_km.toFixed(1)} km · ${trail.difficulty}`, osm_url: trail.osm_url }, ...wishlist];
  saveWishlist(wishlist);
  showToast("Saved to your list");
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
    });
  });
  el.querySelectorAll("[data-complete-wish]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const trail = wishlist.find((w) => w.id === btn.dataset.completeWish);
      openCompleteModal({ name: trail.name, state: trail.location, notes: trail.notes, wishId: trail.id });
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
