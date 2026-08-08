// Deliberately minimal: this app's data (leads, inspection progress, live
// job status) must always be fresh, so this service worker ONLY caches the
// static app shell (HTML/CSS/JS/icons) for installability and a faster
// repeat load - it never intercepts or caches anything under /api/, and
// always prefers the network over the cache when both are available.
const CACHE_NAME = "prospect-shell-v1";
const SHELL_ASSETS = ["/", "/login", "/style.css", "/app.js", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {
      // Best-effort - if a particular asset 404s (e.g. app not logged in
      // yet redirects "/" elsewhere) don't fail the whole install.
    }))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never touch API calls or anything non-GET - always go straight to the
  // network, no caching, no offline fallback. Stale lead/job data would be
  // actively misleading, not just inconvenient.
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") {
    return;
  }

  // Network-first for the app shell itself: try the network so any
  // deployed update is picked up immediately, only falling back to the
  // cached shell if the network is genuinely unavailable (offline).
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
