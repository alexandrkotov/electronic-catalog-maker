import { createTranslator, type Messages, type Translate } from "../../i18n.js";
import en from "./en.json";
import ru from "./ru.json";
import uk from "./uk.json";
import de from "./de.json";
import es from "./es.json";

/**
 * Languages the viewer UI is translated into, English first (the source of
 * truth and the fallback for any missing key). Adding a language = drop its
 * `<tag>.json` next to en.json, import it here, and list it in both places
 * below; en.test.ts checks every listed language against en.json.
 */
export const VIEWER_LOCALES = ["en", "ru", "uk", "de", "es"] as const;

/** Each language's own name for itself — shown in the language picker, never translated. */
export const VIEWER_LOCALE_NAMES: Record<string, string> = { en: "English", ru: "Русский", uk: "Українська", de: "Deutsch", es: "Español" };

export const viewerMessages: Record<string, Messages> = { en, ru, uk, de, es };

/** Translator for chrome outside mountViewer (e.g. the host page's <title>), default wording. */
export function viewerTranslator(locale: string): Translate {
  return createTranslator({ messages: viewerMessages[locale] ?? {}, locale, fallback: viewerMessages.en });
}
