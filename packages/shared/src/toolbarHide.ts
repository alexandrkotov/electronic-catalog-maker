import type { MountViewerOptions } from "./viewerEngine.js";

/** The names the widget's `hide` attribute takes, and the toolbar control each one removes. */
const HIDE_NAMES = {
  title: "title",
  open: "open",
  "open-remote": "openRemote",
  refresh: "refresh",
  language: "language",
  theme: "theme",
} as const;

/**
 * Reads the `<ecm-viewer hide="open open-remote refresh">` attribute: the
 * "full" toolbar's controls a page doesn't want (a demo of one catalog has no
 * use for opening another). Names are separated by spaces or commas, case
 * doesn't matter, unknown names are ignored. Undefined when nothing is hidden,
 * so the engine's defaults stay as they are.
 */
export function toolbarFromHideAttr(attr: string | null | undefined): MountViewerOptions["toolbar"] {
  const toolbar: NonNullable<MountViewerOptions["toolbar"]> = {};
  for (const name of (attr ?? "").toLowerCase().split(/[\s,]+/)) {
    const key = HIDE_NAMES[name as keyof typeof HIDE_NAMES];
    if (key) toolbar[key] = false;
  }
  return Object.keys(toolbar).length ? toolbar : undefined;
}
