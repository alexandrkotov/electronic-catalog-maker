/**
 * Minimal i18n core shared by the editor, viewer, and the embeddable viewer
 * component. Dictionaries are flat `key -> message` maps (plain JSON), so a
 * translated language is a diff-friendly file and the consistency check
 * below can compare them mechanically.
 *
 * Key conventions (all in the key string itself, no nesting):
 *   - `{name}` in a message is replaced by `params.name`.
 *   - Plural forms: `items.one`, `items.few`, `items.many`, `items.other` —
 *     picked by `Intl.PluralRules` from `params.count`. `other` is required
 *     in every language; which of the other categories a language needs is
 *     whatever `Intl.PluralRules` reports for it (ru/uk need one/few/many/
 *     other, en needs one/other, ja needs only other).
 *   - Catalog-mode overrides: `cart.label@education` beats `cart.label`
 *     when the translator is created with `mode: "education"`. The mode
 *     picks a *concept* per language; the words are never patched in after
 *     translation. Combines with plurals: `items.one@education`.
 *
 * Whole sentences are always one message — never assemble one from
 * separately translated fragments, word order differs between languages.
 */

export type Messages = Readonly<Record<string, string>>;
export type MessageParams = Readonly<Record<string, string | number>>;
export type Translate = (key: string, params?: MessageParams) => string;

export interface TranslatorOptions {
  /** The dictionary for the active language (may be empty for the fallback language itself). */
  messages: Messages;
  /** BCP 47 tag of `messages`, used for plural rules. */
  locale: string;
  /** Dictionary tried when `messages` lacks a key — normally English. */
  fallback?: Messages;
  /** Locale of `fallback`, for its plural rules. Defaults to "en". */
  fallbackLocale?: string;
  /** Catalog mode for `key@mode` overrides. Omit for the default (commercial) wording. */
  mode?: string;
  /** Called once per missing key, with the key — a hook for dev warnings. */
  onMissing?: (key: string) => void;
}

/**
 * Keys tried, most specific first, for one lookup. Mode variants beat plain
 * ones; an exact plural category beats `other`; a non-plural key is the last
 * resort so a plain `items` message still works when no forms are defined.
 */
function candidateKeys(key: string, category: string | undefined, mode: string | undefined): string[] {
  const stems: string[] = [];
  if (category !== undefined) {
    stems.push(`${key}.${category}`);
    if (category !== "other") stems.push(`${key}.other`);
  }
  stems.push(key);
  const out: string[] = [];
  for (const s of stems) {
    if (mode) out.push(`${s}@${mode}`);
    out.push(s);
  }
  return out;
}

function pluralCategory(locale: string, count: number): string {
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    return "other"; // unknown/invalid locale tag
  }
}

function interpolate(message: string, params: MessageParams | undefined): string {
  if (!params) return message;
  // Single pass over the *template* only, so a substituted value that
  // happens to contain "{other}" is never expanded a second time.
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

export function createTranslator(opts: TranslatorOptions): Translate {
  const { messages, locale, fallback, mode, onMissing } = opts;
  const fallbackLocale = opts.fallbackLocale ?? "en";
  const reported = new Set<string>();

  return (key, params) => {
    const count = typeof params?.count === "number" ? params.count : undefined;
    const tryDict = (dict: Messages, dictLocale: string): string | undefined => {
      const category = count === undefined ? undefined : pluralCategory(dictLocale, count);
      for (const k of candidateKeys(key, category, mode)) {
        const m = dict[k];
        if (m !== undefined) return m;
      }
      return undefined;
    };
    const found = tryDict(messages, locale) ?? (fallback ? tryDict(fallback, fallbackLocale) : undefined);
    if (found === undefined) {
      if (onMissing && !reported.has(key)) {
        reported.add(key);
        onMissing(key);
      }
      return key; // a visible key beats a blank UI
    }
    return interpolate(found, params);
  };
}

// ---------------------------------------------------------------------------
// Language selection
// ---------------------------------------------------------------------------

/**
 * Maps a BCP 47 tag onto one of `supported`: exact (case-insensitive) match
 * first, then the primary subtag ("de-AT" -> "de"). Returns undefined when
 * neither is supported.
 */
export function matchLocale(tag: string | null | undefined, supported: readonly string[]): string | undefined {
  if (!tag) return undefined;
  const lower = tag.trim().replace(/_/g, "-").toLowerCase();
  if (!lower) return undefined;
  const exact = supported.find((s) => s.toLowerCase() === lower);
  if (exact) return exact;
  const primary = lower.split("-")[0];
  return supported.find((s) => s.toLowerCase() === primary);
}

/**
 * First candidate that maps onto a supported language wins; `fallback`
 * (English) otherwise. The *caller* orders the candidates, because the chain
 * differs per surface (see below) — this function only encodes "skip what we
 * can't serve and move on".
 *
 *   Apps (editor, standalone viewer):
 *     [savedChoice, ...navigator.languages]
 *   Embedded viewer:
 *     [componentLangAttribute, hostPageHtmlLang, ...navigator.languages]
 *
 * The embed deliberately ignores the saved choice: a language picked in the
 * app must not change a demo embedded on somebody else's page.
 */
export function pickLocale(
  candidates: ReadonlyArray<string | null | undefined>,
  supported: readonly string[],
  fallback = "en",
): string {
  for (const c of candidates) {
    const m = matchLocale(c, supported);
    if (m) return m;
  }
  return fallback;
}

const LANG_STORAGE_KEY = "ecm-lang";

/** The language explicitly chosen in an app on a previous visit, if any. */
export function readSavedLocale(supported: readonly string[]): string | undefined {
  try {
    return matchLocale(localStorage.getItem(LANG_STORAGE_KEY), supported);
  } catch {
    return undefined; // localStorage unavailable (privacy mode, etc.)
  }
}

export function saveLocale(locale: string): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, locale);
  } catch {
    // Language still applies for this page load, just won't persist.
  }
}

/** Candidates for the standalone apps: saved choice, then the browser's list. */
export function appLocaleCandidates(supported: readonly string[]): Array<string | undefined> {
  return [readSavedLocale(supported), ...(typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [])];
}

/** Candidates for the embedded viewer: attribute, host page, then the browser's list. */
export function embedLocaleCandidates(attr: string | null | undefined): Array<string | undefined | null> {
  const pageLang = typeof document !== "undefined" ? document.documentElement.lang : undefined;
  return [attr, pageLang, ...(typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [])];
}

// ---------------------------------------------------------------------------
// Dictionary consistency check (used by the CI script)
// ---------------------------------------------------------------------------

const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

interface ParsedKey {
  /** Key without plural category, including any `@mode`: the unit a translator translates. */
  group: string;
  category?: string;
}

function parseKey(key: string): ParsedKey {
  const at = key.indexOf("@");
  const head = at === -1 ? key : key.slice(0, at);
  const modeSuffix = at === -1 ? "" : key.slice(at);
  const dot = head.lastIndexOf(".");
  const tail = dot === -1 ? "" : head.slice(dot + 1);
  if (PLURAL_CATEGORIES.includes(tail)) {
    return { group: head.slice(0, dot) + modeSuffix, category: tail };
  }
  return { group: key };
}

function placeholders(message: string): Set<string> {
  return new Set([...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string));
}

function requiredCategories(locale: string): string[] {
  try {
    return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    return ["other"];
  }
}

function groupBy(dict: Messages): Map<string, Map<string | undefined, string>> {
  const groups = new Map<string, Map<string | undefined, string>>();
  for (const [key, msg] of Object.entries(dict)) {
    const { group, category } = parseKey(key);
    let g = groups.get(group);
    if (!g) groups.set(group, (g = new Map()));
    g.set(category, msg);
  }
  return groups;
}

/**
 * Compares `dict` (language `locale`) against the base dictionary and
 * returns human-readable problems; empty means consistent. Checks:
 *   - every base translation unit exists (missing), and none is invented (extra);
 *   - plural units have every category this language's plural rules use;
 *   - `{placeholders}` match the base (per plural form, a subset of the
 *     base's — a language may drop `{count}` from "one" — but never a new one).
 * Run the base against itself (`checkDictionary(en, en, "en")`) to validate
 * its own plural forms.
 */
export function checkDictionary(base: Messages, dict: Messages, locale: string): string[] {
  const problems: string[] = [];
  const baseGroups = groupBy(base);
  const groups = groupBy(dict);
  const needed = requiredCategories(locale);

  for (const [group, baseForms] of baseGroups) {
    const forms = groups.get(group);
    if (!forms) {
      problems.push(`missing: ${group}`);
      continue;
    }
    const basePlural = [...baseForms.keys()].some((c) => c !== undefined);
    if (basePlural) {
      for (const c of needed) {
        if (!forms.has(c)) problems.push(`missing plural form: ${group}.${c}`);
      }
    }
    const baseAllowed = new Set([...baseForms.values()].flatMap((m) => [...placeholders(m)]));
    for (const [category, msg] of forms) {
      const label = category ? `${group}.${category}` : group;
      const ph = placeholders(msg);
      if (!basePlural) {
        const want = placeholders(baseForms.get(undefined) ?? "");
        for (const p of want) if (!ph.has(p)) problems.push(`placeholder {${p}} missing in ${label}`);
      }
      for (const p of ph) if (!baseAllowed.has(p)) problems.push(`unknown placeholder {${p}} in ${label}`);
    }
  }
  for (const group of groups.keys()) {
    if (!baseGroups.has(group)) problems.push(`extra (not in base): ${group}`);
  }
  return problems;
}
