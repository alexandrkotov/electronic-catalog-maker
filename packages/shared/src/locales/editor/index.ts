import type { Messages } from "../../i18n.js";
import en from "./en.json";
import ru from "./ru.json";
import uk from "./uk.json";

/**
 * Languages the editor UI is translated into — same scheme as the viewer's
 * (see ../viewer/index.ts): English first, the source of truth and fallback.
 */
export const EDITOR_LOCALES = ["en", "ru", "uk"] as const;

/** Each language's own name for itself — shown in the language picker, never translated. */
export const EDITOR_LOCALE_NAMES: Record<string, string> = { en: "English", ru: "Русский", uk: "Українська" };

export const editorMessages: Record<string, Messages> = { en, ru, uk };
