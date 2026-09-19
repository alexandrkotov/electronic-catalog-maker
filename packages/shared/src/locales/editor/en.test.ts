import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkDictionary } from "../../i18n.js";
import en from "./en.json";
import { EDITOR_LOCALES, editorMessages } from "./index.js";

// Every string literal shaped like a dictionary key ("toolbar.open") in the
// editor, plus the prefix of any dynamically built key (`collab.error.${x}`).
// Plural/mode suffixes live in the dictionary only, so compare on the bare
// group name.
const source = readFileSync(new URL("../../../../editor/src/main.ts", import.meta.url), "utf8");
const usedKeys = new Set(
  [...source.matchAll(/"([a-zA-Z]+(?:\.[A-Za-z]+)+)"/g)]
    .map((m) => m[1] as string)
    .filter((k) => !/\.(js|ts|json)$/.test(k)), // module specifiers
);
const dynamicPrefixes = [...source.matchAll(/`([a-zA-Z]+(?:\.[A-Za-z]+)*)\.\$\{/g)].map((m) => m[1] as string);
const definedGroups = new Set(
  Object.keys(en).map((k) => k.replace(/@.*$/, "").replace(/\.(zero|one|two|few|many|other)$/, "")),
);
const isUsed = (group: string) => usedKeys.has(group) || dynamicPrefixes.some((p) => group.startsWith(`${p}.`));

describe("editor dictionary (en)", () => {
  test("is internally consistent", () => {
    expect(checkDictionary(en, en, "en")).toEqual([]);
  });
  test("every key the editor references exists", () => {
    expect([...usedKeys].filter((k) => !definedGroups.has(k))).toEqual([]);
  });
  test("every key is referenced by the editor (no dead strings to translate)", () => {
    expect([...definedGroups].filter((k) => !isUsed(k))).toEqual([]);
  });
  test("markup only in keys explicitly named *.html", () => {
    for (const lang of EDITOR_LOCALES) {
      const bad = Object.entries(editorMessages[lang]!).filter(([k, v]) => /[<>]/.test(v) && !/\.html(@|$)/.test(k));
      expect(bad).toEqual([]);
    }
  });
});

describe("translated editor dictionaries", () => {
  for (const locale of EDITOR_LOCALES.filter((l) => l !== "en")) {
    test(`${locale} matches en (keys, plural forms, placeholders)`, () => {
      expect(checkDictionary(en, editorMessages[locale]!, locale)).toEqual([]);
    });
  }
});
