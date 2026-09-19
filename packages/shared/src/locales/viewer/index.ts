import type { Messages } from "../../i18n.js";
import en from "./en.json";
import ru from "./ru.json";

/**
 * Languages the viewer UI is translated into, English first (the source of
 * truth and the fallback for any missing key). Adding a language = drop its
 * `<tag>.json` next to en.json, import it here, and list it in both places
 * below; en.test.ts checks every listed language against en.json.
 */
export const VIEWER_LOCALES = ["en", "ru"] as const;

export const viewerMessages: Record<string, Messages> = { en, ru };
