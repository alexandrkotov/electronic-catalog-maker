import type { Messages } from "../../i18n.js";
import en from "./en.json";

/**
 * Languages the viewer UI is translated into, English first (the source of
 * truth and the fallback for any missing key). Adding a language = drop its
 * `<tag>.json` next to en.json, import it here, and list it in both places
 * below; the dictionary check (`checkDictionary`) keeps it consistent with en.
 */
export const VIEWER_LOCALES = ["en"] as const;

export const viewerMessages: Record<string, Messages> = { en };
