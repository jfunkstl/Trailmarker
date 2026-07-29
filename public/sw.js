// Trailseeker service worker.
// Two jobs: (1) let the app itself open with no signal, (2) cache OSM map
// tiles so a trail you've viewed — or explicitly downloaded — stays visible
// offline, since that's the actual point of an offline map for hiking.

const SHELL_CACHE = "trailseeker-shell-v2";
const TILE_CACHE = "trailseeker-tiles-v1";

const SHELL_FILES = [
  "/",
  "/index.html",
  "/app.js",
  "/style.css",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {
      // If a shell file 404s during install, don't block the whole install.
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isTileRequest(url) {
  return /tile\.openstreetmap\.org/.test(url) || /tile\.openstreetmap\.org/.test(url);
}

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Never cache API calls or Nominatim/Overpass/elevation lookups — these
  // need to be live, and caching them would show stale search results.
  if (url.includes("/api/")) return;

  // Map tiles: cache-first, and cache whatever we fetch for next time.
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const resp = await fetch(event.request);
          if (resp && resp.status === 200) cache.put(event.request, resp.clone());
          return resp;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // App shell + same-origin static files + CDN libraries: NETWORK-FIRST.
  // (Cache-first here was the bug — once cached, the app would keep serving
  // old code forever and never pick up updates. Now it always tries the
  // network first, and only falls back to the cached copy when offline.)
  if (event.request.method === "GET") {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type !== "opaque") {
            const copy = resp.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
          }
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
  }
});

// Lets the main app proactively download all tiles for a saved trail's area
// before you lose signal, rather than only caching what you happened to view.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "PREFETCH_TILES") {
    const urls = event.data.urls || [];
    const task = prefetchTiles(urls, event);
    if (event.waitUntil) event.waitUntil(task);
  }
});

async function prefetchTiles(urls, event) {
  const cache = await caches.open(TILE_CACHE);
  let done = 0;
  for (const url of urls) {
    try {
      const already = await cache.match(url);
      if (!already) {
        const resp = await fetch(url);
        if (resp && resp.status === 200) await cache.put(url, resp);
      }
    } catch (err) {
      // Skip tiles that fail (e.g. transient network blip) — best effort.
    }
    done++;
    if (event.source) {
      event.source.postMessage({ type: "PREFETCH_PROGRESS", done, total: urls.length });
    }
  }
  if (event.source) {
    event.source.postMessage({ type: "PREFETCH_DONE", total: urls.length });
  }
}
