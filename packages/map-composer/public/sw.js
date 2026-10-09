// Hand-rolled Service Worker for the map composer — same approach as the
// editor's and viewer's (no build-time PWA tooling), minus their analytics
// blocking: the map composer has no analytics at all, so there is nothing to
// block. Its only job is offline support: stale-while-revalidate runtime
// caching of same-origin GETs (app shell, JS/CSS, the sql.js WASM binary),
// with page navigations network-first so a cached page never stands in for
// a newer deploy while online. Full offline use needs one prior online
// visit, as with any cache-as-you-go strategy — and the map itself always
// needs the network: its tiles are cross-origin and deliberately not cached.
//
// No skipWaiting()/clients.claim() on install: an already-open tab keeps its
// version until closed and reopened rather than swapping assets mid-session.

const CACHE_NAME = "ecm-map-composer-cache-v1";

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        fetch(event.request)
          .then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          })
          .catch(async () => (await cache.match(event.request)) || Response.error())
      )
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        // Offline and never cached: an explicit network error, not `undefined` (which a fetch handler may not answer with).
        .catch(() => cached || Response.error());
      return cached || network;
    })
  );
});
