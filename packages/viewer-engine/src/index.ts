// The public face of @ecm/viewer-engine: what a host application needs to
// show a catalog and drive it, and nothing else (the shared package's own
// barrel also carries the editor's database code, the PWA and collaboration
// clients, which a host has no use for).
import rawViewerCss from "../../viewer/src/style.css?inline";
import "../../viewer/src/style.css"; // also emitted as dist/style.css, for a host that wants the file
import { mountViewer, type MountViewerOptions, type ViewerController } from "../../shared/src/viewerEngine.js";

export { mountViewer, VIEW_EVENT_INTERVAL_MS } from "../../shared/src/viewerEngine.js";
export type { MountViewerOptions, ViewerController, ViewerEventType, ViewerToolbarAction } from "../../shared/src/viewerEngine.js";
export {
  FIT_PADDING,
  MAX_ABSOLUTE_ZOOM,
  REGION_PADDING,
  fitScale,
  normalizeRegion,
  normalizeView,
  parseViewGeometry,
  placeView,
  readView,
  setViewGeometryParams,
  viewKey,
} from "../../shared/src/view.js";
export type { EcatmView, Size, ViewGeometry, ViewPlacement, ViewRegion } from "../../shared/src/view.js";
export { VIEWER_LOCALES, VIEWER_LOCALE_NAMES } from "../../shared/src/locales/viewer/index.js";
export { matchLocale, pickLocale } from "../../shared/src/i18n.js";
export type { PdfExportOptions } from "../../shared/src/pdfExportOptions.js";
export type { Database } from "sql.js";
export { createPdfExporter } from "./pdf.js";
export type { PdfFontSource } from "./pdf.js";

// The stylesheet is written for a whole page (`:root` custom properties, html/body
// rules); inside a shadow root the same rules apply to the host element instead.
// `[data-theme=dark]` has no `:host` twin without the functional form — see
// packages/viewer-embed/src/ecm-viewer.ts, which does the same swap.
const shadowCss = rawViewerCss.replace(/:root(\[data-theme=[^\]]*\])/g, ":host($1)").replace(/:root/g, ":host");

/** The viewer's stylesheet as text (the same as style.css), for a host that injects it itself. */
export const viewerCss: string = rawViewerCss;

/**
 * Mounts the viewer inside a shadow root on `host`, so its stylesheet (which
 * restyles every `button`, `table` and `select`) cannot leak into the host
 * application, nor the host's into the viewer. The host element should be
 * sized by the host application; the viewer fills it. The theme attribute goes
 * on `host`. Use plain `mountViewer` with `viewerCss` instead to share the
 * page's own DOM.
 */
export function mountViewerInShadow(host: HTMLElement, options: Omit<MountViewerOptions, "container" | "root" | "themeTarget">): ViewerController {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `${shadowCss}\n:host { display: block; overflow: hidden; }`;
  const mount = document.createElement("div");
  mount.style.height = "100%";
  shadow.append(style, mount);
  const controller = mountViewer({ ...options, container: mount, root: shadow, themeTarget: host });
  return {
    ...controller,
    destroy() {
      controller.destroy();
      mount.remove();
      style.remove();
    },
  };
}
