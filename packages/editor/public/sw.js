// Hand-rolled Service Worker for the editor — no vite-plugin-pwa or other
// build-time PWA tooling, matching this project's "no new dependencies
// unless necessary" preference. Two jobs:
//
// 1. Stale-while-revalidate runtime caching of same-origin GET requests
//    (the app shell's HTML/JS/CSS and the sql.js WASM binary, which loads
//    as its own fetched file here — see main.ts's `wasmUrl` import). The
//    cache builds up as things are actually requested rather than from a
//    precomputed file list (that needs hashed-filename awareness, which is
//    exactly what vite-plugin-pwa would normally generate for us) — so
//    full offline support needs at least one prior successful online
//    visit, same as any cache-as-you-go strategy.
// 2. Blocking GoatCounter analytics requests, but ONLY when the page told
//    us (via postMessage) that it's running as an installed standalone
//    app — see packages/shared/src/pwa.ts for the full two-layer
//    rationale. Ordinary browser-tab visits are never blocked here.
//
// Deliberately does NOT call self.skipWaiting()/clients.claim() on
// install — an already-open tab keeps running its old (already-cached)
// version until it's closed and reopened, rather than switching assets
// out from under it mid-session. Simple, safe default; revisit only if a
// faster update rollout is ever actually needed.

const CACHE_NAME = "ecm-editor-cache-v1";
const GOATCOUNTER_HOSTS = ["ecatm.goatcounter.com", "gc.zgo.at"];

let isStandalone = false;

self.addEventListener("message", (event) => {
  if (event.data?.type === "display-mode") {
    isStandalone = !!event.data.standalone;
  }
});

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

  // Layer 2 of the standalone GoatCounter block (layer 1: pwa.ts never
  // even inserts the <script> tag when standalone). Only kicks in if a
  // request slipped through anyway.
  if (isStandalone && GOATCOUNTER_HOSTS.includes(url.hostname)) {
    event.respondWith(Response.error());
    return;
  }

  // Only cache our own same-origin GETs — never third-party `?src=`
  // catalog URLs (arbitrary hosts; shouldn't grow this cache unbounded)
  // and never non-GET requests.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
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
        .catch(() => cached);
      return cached || network;
    })
  );
});
