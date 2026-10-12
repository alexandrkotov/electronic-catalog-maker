/**
 * PWA plumbing shared by the editor and viewer: registers each app's own
 * hand-rolled Service Worker (see each package's `public/sw.js` — no
 * vite-plugin-pwa or other build-time PWA tooling, kept dependency-free per
 * project convention) and gates GoatCounter analytics so an installed
 * standalone app (Microsoft Store / PWABuilder MSIX) never talks to
 * goatcounter.com at all — only ordinary browser-tab visits to the GitHub
 * Pages site are counted, same as today.
 *
 * Two-layer defense, both driven from here:
 *   1. `loadAnalyticsIfBrowserTab()` never inserts the tracking <script>
 *      tag when running standalone — the browser never even attempts the
 *      request.
 *   2. The current display mode is also pushed to the Service Worker via
 *      `postMessage`, so its own `fetch` handler can block any GoatCounter
 *      request that slips through anyway (see sw.js). Belt and suspenders.
 */

import { analyticsPath, analyticsReferrer } from "./analytics.js";

const GOATCOUNTER_SRC = "//gc.zgo.at/count.js";
const GOATCOUNTER_ENDPOINT = "https://ecatm.goatcounter.com/count";

function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}

function notifyServiceWorker(standalone: boolean) {
  navigator.serviceWorker?.controller?.postMessage({ type: "display-mode", standalone });
}

interface CountJs {
  get_data?: (vars?: unknown) => Record<string, unknown>;
  count?: (vars?: unknown) => void;
}

/**
 * Sends the page view with no query string and a cleaned referrer. count.js
 * builds both inside get_data(), so that is the one place to wrap — events
 * pass through the same function.
 *
 * The server reads `q` only to work out campaigns, and we don't use them. Left
 * alone it did harm: `src` (this site's "which catalog to open" parameter) was
 * taken for a campaign source, so every viewer demo visit had its real
 * referrer replaced by the catalog's address, and `collab` room ids and
 * `blob:` addresses were sent along for nothing.
 */
function countFilteredPageView() {
  const counter = (window as unknown as { goatcounter?: CountJs }).goatcounter;
  const getData = counter?.get_data;
  const count = counter?.count;
  if (!counter || typeof getData !== "function" || typeof count !== "function") return;
  counter.get_data = (vars) => {
    const data = getData(vars);
    data.q = "";
    if (typeof data.r === "string") data.r = analyticsReferrer(data.r);
    return data;
  };
  // What count.js does on its own: not before the tab is actually visible.
  const send = () => count.call(counter);
  if (document.visibilityState === "visible") {
    send();
    return;
  }
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onVisible);
    send();
  };
  document.addEventListener("visibilitychange", onVisible);
}

/** Only for a normal browser tab — an installed standalone app never gets
 * this tag in its DOM at all (layer 1 of the block described above). */
function loadAnalyticsIfBrowserTab() {
  if (isStandalone()) return;
  // count.js picks its settings up from whatever is already on window.goatcounter.
  // `no_onload`: the page view is sent from script.onload below instead, once
  // get_data() is wrapped — by default count.js sends it before that can happen.
  const counter = ((window as unknown as { goatcounter?: Record<string, unknown> }).goatcounter ??= {});
  counter.path = analyticsPath;
  counter.no_onload = true;
  const script = document.createElement("script");
  script.onload = countFilteredPageView;
  script.async = true;
  script.src = GOATCOUNTER_SRC;
  script.dataset.goatcounter = GOATCOUNTER_ENDPOINT;
  document.head.appendChild(script);
}

/** Registered with a plain relative path ("sw.js"), so it resolves under
 * whatever base path Vite applied — the GitHub Pages `/electronic-catalog-
 * maker/editor|viewer/` subpath in production, plain "/" in local dev —
 * without this module needing to know which. */
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    notifyServiceWorker(isStandalone());
    // A fresh SW version only takes control after this tells it again.
    navigator.serviceWorker.addEventListener("controllerchange", () => notifyServiceWorker(isStandalone()));
    // Covers "opened from the Store app, then also opened as a plain tab"
    // (or vice versa) without needing a full reload to pick up the change.
    window.matchMedia("(display-mode: standalone)").addEventListener("change", (event) => {
      notifyServiceWorker(event.matches);
    });
  } catch {
    // Offline caching and the standalone GoatCounter block (layer 2) both
    // degrade gracefully without a working Service Worker — nothing else
    // in the app depends on it.
  }
}

/** Call once at startup from each app's main.ts. */
export function setUpPwa() {
  loadAnalyticsIfBrowserTab();
  void registerServiceWorker();
}
