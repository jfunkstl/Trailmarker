/* ==========================================================================
   Trail App - public/app.js
   ========================================================================== */

let wishlist = [];
let tracked = [];
let activeTab = "track";

// Maps & Map State
let trackMap = null;
let trailLayersGroup = null;
let userMarker = null;
let currentPos = null;

// Modal Maps / Editors
let createEditor = null;
let modalEditor = null;

/* --------------------------------------------------------------------------
   UTILITY & GEOMETRY HELPERS
   -------------------------------------------------------------------------- */

function uid() {
  return "id_" + Math.random().toString(36).substr(2, 9);
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateSegmentDistance(segment) {
  let dist = 0;
  for (let i = 0; i < segment.length - 1; i++) {
    dist += haversineDistance(
      segment[i][0],
      segment[i][1],
      segment[i + 1][0],
      segment[i + 1][1]
    );
  }
  return dist;
}

function editorDistanceKm(editor) {
  if (!editor || !editor.segments) return 0;
  return editor.segments.reduce(
    (acc, seg) => acc + calculateSegmentDistance(seg),
    0
  );
}

/**
 * Re-orders and flips multi-line segments to construct a single continuous route.
 */
function chainSegmentsFromStart(segments, startLatLng) {
  if (!segments || segments.length === 0) return [];
  let remaining = segments.map((s) => [...s]);
  let chained = [];

  // Find nearest segment endpoint to start position
  let bestIdx = 0;
  let bestReverse = false;
  let minDist = Infinity;

  remaining.forEach((seg, idx) => {
    const dStart = haversineDistance(
      startLatLng.lat,
      startLatLng.lng,
      seg[0][0],
      seg[0][1]
    );
    const dEnd = haversineDistance(
      startLatLng.lat,
      startLatLng.lng,
      seg[seg.length - 1][0],
      seg[seg.length - 1][1]
    );

    if (dStart < minDist) {
      minDist = dStart;
      bestIdx = idx;
      bestReverse = false;
    }
    if (dEnd < minDist) {
      minDist = dEnd;
      bestIdx = idx;
      bestReverse = true;
    }
  });

  let currentSeg = remaining.splice(bestIdx, 1)[0];
  if (bestReverse) currentSeg.reverse();
  chained.push(currentSeg);

  // Chain remaining segments
  while (remaining.length > 0) {
    const lastPoint = chained[chained.length - 1][chained[chained.length - 1].length - 1];
    let nextIdx = 0;
    let nextReverse = false;
    let minGap = Infinity;

    remaining.forEach((seg, idx) => {
      const dStart = haversineDistance(lastPoint[0], lastPoint[1], seg[0][0], seg[0][1]);
      const dEnd = haversineDistance(lastPoint[0], lastPoint[1], seg[seg.length - 1][0], seg[seg.length - 1][1]);

      if (dStart < minGap) {
        minGap = dStart;
        nextIdx = idx;
        nextReverse = false;
      }
      if (dEnd < minGap) {
        minGap = dEnd;
        nextIdx = idx;
        nextReverse = true;
      }
    });

    let nextSeg = remaining.splice(nextIdx, 1)[0];
    if (nextReverse) nextSeg.reverse();
    chained.push(nextSeg);
  }

  return chained;
}

/**
 * Validates route continuity and checks for massive gaps.
 */
function validateGeometry(segments) {
  if (!segments || segments.length === 0) {
    return { valid: false, reason: "No segment data available" };
  }

  const MAX_ALLOWED_GAP_KM = 2.0;

  for (let i = 0; i < segments.length - 1; i++) {
    const endCurrent = segments[i][segments[i].length - 1];
    const startNext = segments[i + 1][0];
    const gap = haversineDistance(
      endCurrent[0],
      endCurrent[1],
      startNext[0],
      startNext[1]
    );

    if (gap > MAX_ALLOWED_GAP_KM) {
      return {
        valid: false,
        reason: `Disconnected gap of ${gap.toFixed(1)} km detected between segments.`,
      };
    }
  }

  return { valid: true };
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.innerText = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3000);
}

/* --------------------------------------------------------------------------
   STORAGE HANDLERS
   -------------------------------------------------------------------------- */

function loadSavedData() {
  try {
    const w = localStorage.getItem("trail_wishlist");
    const t = localStorage.getItem("trail_tracked");
    wishlist = w ? JSON.parse(w) : [];
    tracked = t ? JSON.parse(t) : [];
  } catch (e) {
    console.error("Failed to load local storage data:", e);
    wishlist = [];
    tracked = [];
  }
}

function saveWishlist(data) {
  wishlist = data;
  localStorage.setItem("trail_wishlist", JSON.stringify(wishlist));
}

function saveTracked(data) {
  tracked = data;
  localStorage.setItem("trail_tracked", JSON.stringify(tracked));
}

/* --------------------------------------------------------------------------
   MAP & EDITOR HELPERS
   -------------------------------------------------------------------------- */

function initEditorState(mapInstance) {
  return {
    map: mapInstance,
    segments: [], // Array of coordinate arrays [[lat, lon], ...]
    polylineGroup: L.layerGroup().addTo(mapInstance),
    startMarker: null,
    endMarker: null,
  };
}

function editorRedraw(editor) {
  if (!editor || !editor.map) return;
  editor.polylineGroup.clearLayers();

  editor.segments.forEach((seg) => {
    L.polyline(seg, { color: "#2563eb", weight: 4, opacity: 0.8 }).addTo(
      editor.polylineGroup
    );
  });

  editorUpdateEndpoints(editor);
}

function editorUpdateEndpoints(editor) {
  const allPoints = editor.segments.flat();
  if (allPoints.length < 2) {
    if (editor.startMarker) {
      editor.map.removeLayer(editor.startMarker);
      editor.startMarker = null;
    }
    if (editor.endMarker) {
      editor.map.removeLayer(editor.endMarker);
      editor.endMarker = null;
    }
    return;
  }

  const startPt = editor.segments[0][0];
  const lastSeg = editor.segments[editor.segments.length - 1];
  const endPt = lastSeg[lastSeg.length - 1];

  const startIcon = L.divIcon({
    className: "custom-endpoint-icon start-icon",
    html: `<div style="background-color:#22c55e; color:white; font-weight:bold; border-radius:50%; width:24px; height:24px; display:flex; align-items:center; justify-content:center; border:2px solid white; box-shadow:0 2px 4px rgba(0,0,0,0.3);">S</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

  const endIcon = L.divIcon({
    className: "custom-endpoint-icon end-icon",
    html: `<div style="background-color:#2563eb; color:white; font-weight:bold; border-radius:50%; width:24px; height:24px; display:flex; align-items:center; justify-content:center; border:2px solid white; box-shadow:0 2px 4px rgba(0,0,0,0.3);">E</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

  if (!editor.startMarker) {
    editor.startMarker = L.marker(startPt, {
      icon: startIcon,
      draggable: true,
      zIndexOffset: 1000,
    }).addTo(editor.map);
    editor.startMarker.on("dragend", (e) => {
      const newPos = e.target.getLatLng();
      editor.segments[0][0] = [newPos.lat, newPos.lng];
      editorRedraw(editor);
    });
  } else {
    editor.startMarker.setLatLng(startPt);
  }

  if (!editor.endMarker) {
    editor.endMarker = L.marker(endPt, {
      icon: endIcon,
      draggable: true,
      zIndexOffset: 1000,
    }).addTo(editor.map);
    editor.endMarker.on("dragend", (e) => {
      const newPos = e.target.getLatLng();
      const seg = editor.segments[editor.segments.length - 1];
      seg[seg.length - 1] = [newPos.lat, newPos.lng];
      editorRedraw(editor);
    });
  } else {
    editor.endMarker.setLatLng(endPt);
  }
}

/* --------------------------------------------------------------------------
   UI CONTROLS & TAB NAVIGATION
   -------------------------------------------------------------------------- */

function switchTab(tabName) {
  activeTab = tabName;
  document
    .querySelectorAll(".tab-btn")
    .forEach((btn) => btn.classList.remove("active"));
  document
    .querySelectorAll(".tab-content")
    .forEach((content) => content.classList.remove("active"));

  const targetBtn = document.getElementById(`tabBtn-${tabName}`);
  const targetContent = document.getElementById(`tabContent-${tabName}`);

  if (targetBtn) targetBtn.classList.add("active");
  if (targetContent) targetContent.classList.add("active");

  if (tabName === "track" && trackMap) {
    setTimeout(() => trackMap.invalidateSize(), 200);
  }
}

function closeModal() {
  const modal = document.getElementById("modalOverlay");
  if (modal) modal.style.display = "none";
}

/* --------------------------------------------------------------------------
   TRACK TAB & MAP INITIALIZATION
   -------------------------------------------------------------------------- */

function initTrackMap() {
  const mapElem = document.getElementById("trackMap");
  if (!mapElem) return;

  trackMap = L.map("trackMap").setView([37.7749, -122.4194], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(trackMap);

  trailLayersGroup = L.layerGroup().addTo(trackMap);

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        currentPos = [pos.coords.latitude, pos.coords.longitude];
        trackMap.setView(currentPos, 13);

        userMarker = L.circleMarker(currentPos, {
          radius: 8,
          fillColor: "#2563eb",
          color: "#ffffff",
          weight: 2,
          opacity: 1,
          fillOpacity: 0.9,
        })
          .addTo(trackMap)
          .bindPopup("You are here");
      },
      (err) => console.warn("Geolocation warning/error:", err.message),
      { enableHighAccuracy: true }
    );
  }
}

function renderTrackMapTrails() {
  if (!trailLayersGroup) return;
  trailLayersGroup.clearLayers();

  wishlist.forEach((trail) => {
    if (trail.geometry && trail.geometry.length > 0) {
      trail.geometry.forEach((seg) => {
        L.polyline(seg, { color: "#16a34a", weight: 4, opacity: 0.7 })
          .addTo(trailLayersGroup)
          .bindPopup(`<b>${trail.name}</b><br>${trail.notes || ""}`);
      });
    }
  });
}

function populateTrailPicker() {
  const picker = document.getElementById("trailPicker");
  if (!picker) return;

  picker.innerHTML = `<option value="">Select a saved trail to display...</option>`;
  wishlist.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `${t.name} (${t.location || "Custom"})`;
    picker.appendChild(opt);
  });
}

function populateCreateBasePicker() {
  const picker = document.getElementById("createBaseTrailSelect");
  if (!picker) return;

  picker.innerHTML = `<option value="">Start from scratch OR pick saved base trail...</option>`;
  wishlist.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    picker.appendChild(opt);
  });
}

/* --------------------------------------------------------------------------
   CREATE TAB IMPLEMENTATION
   -------------------------------------------------------------------------- */

function initCreateEditor() {
  const mapElem = document.getElementById("createMap");
  if (!mapElem) return;

  const cMap = L.map("createMap").setView([37.7749, -122.4194], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(cMap);

  createEditor = initEditorState(cMap);

  cMap.on("click", (e) => {
    const pt = [e.latlng.lat, e.latlng.lng];
    if (createEditor.segments.length === 0) {
      createEditor.segments.push([pt]);
    } else {
      createEditor.segments[createEditor.segments.length - 1].push(pt);
    }
    editorRedraw(createEditor);
  });
}

function saveEditedTrail(editorInstance, targetTrail) {
  if (!editorInstance.segments || editorInstance.segments.length === 0) {
    showToast("Route cannot be empty");
    return;
  }

  const startLatLng = editorInstance.startMarker
    ? editorInstance.startMarker.getLatLng()
    : L.latLng(editorInstance.segments[0][0]);

  const chainedSegments = chainSegmentsFromStart(
    editorInstance.segments,
    startLatLng
  );

  const validation = validateGeometry(chainedSegments);
  if (!validation.valid) {
    showToast(`Validation error: ${validation.reason}`);
    return;
  }

  const finalKm = editorDistanceKm({ segments: chainedSegments });
  const firstPt = chainedSegments[0][0];

  targetTrail.geometry = chainedSegments.map((seg) =>
    seg.map((p) => [p[0], p[1]])
  );
  targetTrail.distance_km = finalKm;
  targetTrail.lat = firstPt[0];
  targetTrail.lon = firstPt[1];

  saveWishlist(wishlist);
  closeModal();
  renderTrackMapTrails();
  showToast("Trail route updated successfully");
}

/* --------------------------------------------------------------------------
   SAVED & TRACKED LIST RENDERING
   -------------------------------------------------------------------------- */

function renderSavedList() {
  const container = document.getElementById("savedListContainer");
  if (!container) return;

  if (wishlist.length === 0) {
    container.innerHTML = `<p class="empty-msg">No saved trails yet. Explore or create one!</p>`;
    return;
  }

  container.innerHTML = wishlist
    .map(
      (t) => `
    <div class="trail-card" data-id="${t.id}">
      <div class="trail-card-header">
        <h3>${t.name}</h3>
        <span class="badge">${t.location || "Custom"}</span>
      </div>
      <p class="trail-notes">${t.notes || "No extra notes available."}</p>
      <div class="trail-card-actions">
        <button class="btn btn-sm btn-primary" onclick="openTrailMapModal('${
          t.id
        }')">Edit Route</button>
        <button class="btn btn-sm btn-danger" onclick="deleteWishlistItem('${
          t.id
        }')">Delete</button>
      </div>
    </div>
  `
    )
    .join("");
}

function deleteWishlistItem(id) {
  wishlist = wishlist.filter((t) => t.id !== id);
  saveWishlist(wishlist);
  renderSavedList();
  populateTrailPicker();
  populateCreateBasePicker();
  renderTrackMapTrails();
  showToast("Trail removed from saved list");
}

/* --------------------------------------------------------------------------
   MODAL TRAIL EDITOR
   -------------------------------------------------------------------------- */

function openTrailMapModal(trailId) {
  const trail = wishlist.find((t) => t.id === trailId);
  if (!trail) return;

  const modal = document.getElementById("modalOverlay");
  const modalBody = document.getElementById("modalBody");
  if (!modal || !modalBody) return;

  modalBody.innerHTML = `
    <h2>Edit Trail Route: ${trail.name}</h2>
    <div id="modalMap" style="height: 400px; width: 100%; border-radius: 8px; margin-top: 10px;"></div>
    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="saveModalTrailBtn">Save Changes</button>
    </div>
  `;

  modal.style.display = "flex";

  setTimeout(() => {
    const center =
      trail.lat && trail.lon ? [trail.lat, trail.lon] : [37.7749, -122.4194];
    const mMap = L.map("modalMap").setView(center, 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    }).addTo(mMap);

    modalEditor = initEditorState(mMap);

    if (trail.geometry && trail.geometry.length > 0) {
      modalEditor.segments = JSON.parse(JSON.stringify(trail.geometry));
      editorRedraw(modalEditor);
      const bounds = L.polyline(modalEditor.segments.flat()).getBounds();
      if (bounds.isValid()) mMap.fitBounds(bounds);
    }

    mMap.on("click", (e) => {
      const pt = [e.latlng.lat, e.latlng.lng];
      if (modalEditor.segments.length === 0) {
        modalEditor.segments.push([pt]);
      } else {
        modalEditor.segments[modalEditor.segments.length - 1].push(pt);
      }
      editorRedraw(modalEditor);
    });

    document
      .getElementById("saveModalTrailBtn")
      .addEventListener("click", () => {
        saveEditedTrail(modalEditor, trail);
      });
  }, 100);
}

/* --------------------------------------------------------------------------
   EVENT BINDINGS & INIT
   -------------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  loadSavedData();

  initTrackMap();
  initCreateEditor();

  populateTrailPicker();
  populateCreateBasePicker();
  renderSavedList();
  renderTrackMapTrails();

  // Tab switching listeners
  document
    .getElementById("tabBtn-track")
    ?.addEventListener("click", () => switchTab("track"));
  document
    .getElementById("tabBtn-explore")
    ?.addEventListener("click", () => switchTab("explore"));
  document
    .getElementById("tabBtn-create")
    ?.addEventListener("click", () => switchTab("create"));
  document
    .getElementById("tabBtn-saved")
    ?.addEventListener("click", () => {
      renderSavedList();
      switchTab("saved");
    });

  // Save Custom Route Button in Create Tab
  document
    .getElementById("createConfirmBtn")
    ?.addEventListener("click", () => {
      if (
        !createEditor ||
        !createEditor.segments ||
        createEditor.segments.length === 0
      ) {
        showToast("Please draw a route on the map before saving.");
        return;
      }

      const name =
        document.getElementById("createName").value.trim() || "Untitled route";
      const state = document.getElementById("createState").value;

      const startLatLng = createEditor.startMarker
        ? createEditor.startMarker.getLatLng()
        : L.latLng(createEditor.segments[0][0]);

      const chainedSegments = chainSegmentsFromStart(
        createEditor.segments,
        startLatLng
      );

      const validation = validateGeometry(chainedSegments);
      if (!validation.valid) {
        showToast(`Cannot save route: ${validation.reason}`);
        return;
      }

      const finalKm = editorDistanceKm({ segments: chainedSegments });
      const firstPt = chainedSegments[0][0];

      wishlist = [
        {
          id: uid(),
          name,
          location: state,
          notes: `${(finalKm * 0.621371).toFixed(1)} mi · custom drawn route`,
          osm_url: null,
          geometry: chainedSegments.map((seg) => seg.map((p) => [p[0], p[1]])),
          lat: firstPt[0],
          lon: firstPt[1],
          distance_km: finalKm,
          custom: true,
        },
        ...wishlist,
      ];

      saveWishlist(wishlist);
      populateTrailPicker();
      populateCreateBasePicker();
      renderTrackMapTrails();
      showToast("Route saved — find it in Track or your Saved list");
    });
});
