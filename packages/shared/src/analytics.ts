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
