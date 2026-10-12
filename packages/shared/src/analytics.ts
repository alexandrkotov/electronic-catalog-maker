/**
 * Anonymous "this action happened" counters for the site's own analytics
 * (GoatCounter — see pwa.ts for how its script gets loaded). Only the event
 * *name* is sent: never a catalog's contents, file names, or anything the
 * person typed. The names are listed in landing/privacy.html.
 *
 * Silent no-op wherever the counter isn't running: an installed standalone
 * app never loads the script (see pwa.ts), and count.js itself skips
 * localhost, file:// and browsers flagged with #toggle-goatcounter. Analytics
 * must never be able to break an edit, hence the try/catch.
 */
interface GoatCounterGlobal {
  count?: (vars: { event: boolean; path: string; title: string }) => void;
}

export function trackEvent(name: string): void {
  try {
    const counter = (globalThis as { goatcounter?: GoatCounterGlobal }).goatcounter;
    counter?.count?.({ event: true, path: name, title: name });
  } catch {
    // never let analytics interrupt the app
  }
}

/**
 * The path a page view is filed under — the address with its query string,
 * minus the parts that are unique to each visit and would turn the dashboard's
 * Pages list into one row per visitor:
 *
 *   src=blob:https://…/<uuid>  (the wizard handing its result to the editor)
 *                              → src=blob
 *   collab=<room id>           → collab=room
 *   server=<url>               → server=custom
 *
 * Everything else is left as it came, notably `src=../demo/<name>.ecatm`:
 * which demo was opened is exactly what the list is for. Used as
 * `window.goatcounter.path` (see pwa.ts), which count.js applies to page
 * views only — event names are sent as given.
 */
export function analyticsPath(path: string): string {
  const q = path.indexOf("?");
  if (q === -1) return path;
  const pairs = path
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const key = decode(pair.slice(0, eq));
      if (key === "src" && /^blob:/i.test(decode(pair.slice(eq + 1)))) return "src=blob";
      if (key === "collab") return "collab=room";
      if (key === "server") return "server=custom";
      return pair;
    });
  return path.slice(0, q + 1) + pairs.join("&");
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The referrer, with the same per-visit parts taken out of a same-site
 * address (a visit that came from `/editor/?collab=<room>` on this site).
 * Cross-site referrers arrive without a query string already.
 */
export function analyticsReferrer(referrer: string): string {
  return typeof referrer === "string" && referrer ? analyticsPath(referrer) : referrer;
}
