// Practical Cyrillic -> Latin transliteration (Russian + Ukrainian-specific letters),
// used only to propose a default URL from a link's name. The user can always
// override the URL field by hand.
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  // Ukrainian-specific
  і: "i", ї: "yi", є: "ye", ґ: "g",
};

/** "Прокладка ГБЦ" -> "prokladka-gbts", "Coolant Pump #2" -> "coolant-pump-2" */
export function slugify(input: string): string {
  const transliterated = Array.from(input.toLowerCase())
    .map((ch) => CYRILLIC_TO_LATIN[ch] ?? ch)
    .join("");
  return transliterated
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
