import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { mountViewer, type ViewerController } from "@ecm/shared";
// Reused as-is rather than copied — a second hand-maintained stylesheet
// would inevitably drift from the real one. `:root` (targets a page's
// <html>) doesn't mean anything inside a shadow tree; `:host` is the
// shadow-DOM equivalent (the tree's own scoping root for cascaded custom
// properties), so it's swapped in at runtime below instead.
import rawViewerCss from "../../viewer/src/style.css?inline";

// `:root[data-theme="dark"]` (bare attribute selector chained directly)
// has no equivalent for `:host` — confirmed empirically (a minimal repro
// with `:host[data-theme="dark"]` silently never matched, in a real
// browser, not just a lint concern): combining `:host` with anything
// requires its *functional* form, `:host(<selector>)`. So this one
// selector needs its own rewrite before the generic :root -> :host swap —
// matching `[data-theme=...]` without assuming quotes, since the `?inline`
// CSS import already strips them (`[data-theme="dark"]` becomes
// `[data-theme=dark]` by the time this string shows up here).
const shadowCss = rawViewerCss
  .replace(/:root(\[data-theme=[^\]]*\])/g, ":host($1)")
  .replace(/:root/g, ":host");

// Sizing/border are the one thing genuinely specific to being embedded
// (the standalone viewer fills a whole browser tab; this fills whatever
// box the host page gives it) — a plain page author's own CSS on the
// `ecm-viewer` element overrides these safely: per the CSS Scoping spec, a
// selector from *outside* a shadow tree wins over an equal-specificity
// `:host` rule defined *inside* it.
const HOST_DEFAULTS_CSS = `
  :host {
    display: block;
    height: 600px;
    border: 1px solid #d0d5dd;
    border-radius: 6px;
    overflow: hidden;
  }
`;

/**
 * `<ecm-viewer src="https://.../catalog.ecatm">` — drop this in any page
 * (even a plain static HTML file, no bundler/build step needed on the
 * consuming site) to embed a live, clickable Electronic Catalog Maker
 * viewer. See README "Embedding the viewer" for the full attribute list
 * and mode comparison; the actual viewing behavior lives in
 * packages/shared/src/viewerEngine.ts, shared with the standalone viewer
 * app so there's exactly one implementation to keep working, not two.
 *
 * Attributes:
 * - `src` — URL of a `.ecatm` (or legacy `.sch`) file to load on mount.
 * - `mode` — "lite" (default: image + hotspots + table + zoom/pan, no
 *   toolbar chrome, fixed to `src`) or "full" (the standalone viewer's
 *   entire toolbar — Open catalog…/Open remote catalog…/Search…/theme —
 *   `src` just becomes what's shown initially, visitors can open a
 *   different catalog from there).
 */
class EcmViewerElement extends HTMLElement {
  private controller: ViewerController | null = null;

  connectedCallback() {
    if (this.controller) return; // already mounted (e.g. moved to a different spot in the DOM)

    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = shadowCss + HOST_DEFAULTS_CSS;
    shadow.appendChild(style);

    const mount = document.createElement("div");
    shadow.appendChild(mount);

    const mode = this.getAttribute("mode") === "full" ? "full" : "lite";
    this.controller = mountViewer({
      container: mount,
      root: shadow,
      mode,
      initialSrc: this.getAttribute("src") ?? undefined,
      // Never rewrite the *embedding* page's address bar.
      updateAddressBar: false,
      // Apply data-theme to this element itself (the shadow host), never
      // to the embedding page's own <html> — :host([data-theme="dark"])
      // above is what picks this up.
      themeTarget: this,
      wasmUrl,
    });
  }

  disconnectedCallback() {
    this.controller?.destroy();
    this.controller = null;
  }
}

if (!customElements.get("ecm-viewer")) {
  customElements.define("ecm-viewer", EcmViewerElement);
}
