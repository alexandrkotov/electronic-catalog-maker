import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkDictionary } from "../../i18n.js";
import en from "./en.json";
import { VIEWER_LOCALES, viewerMessages } from "./index.js";

// Every string literal shaped like a dictionary key ("toolbar.open") in the
// engine. Plural/mode suffixes live in the dictionary only, so compare on
// the bare group name.
const source = readFileSync(new URL("../../viewerEngine.ts", import.meta.url), "utf8");
const usedKeys = new Set(
  [...source.matchAll(/"([a-zA-Z]+(?:\.[A-Za-z]+)+)"/g)].map((m) => m[1] as string)
    .filter((k) => !/\.(js|ts|json)$/.test(k)), // module specifiers
);
const definedGroups = new Set(
  Object.keys(en).map((k) => k.replace(/@.*$/, "").replace(/\.(zero|one|two|few|many|other)$/, "")),
);

describe("viewer dictionary (en)", () => {
  test("is internally consistent", () => {
    expect(checkDictionary(en, en, "en")).toEqual([]);
  });
  test("every key the engine references exists", () => {
    const missing = [...usedKeys].filter((k) => !definedGroups.has(k));
    expect(missing).toEqual([]);
  });
  test("every key is referenced by the engine (no dead strings to translate)", () => {
    const unused = [...definedGroups].filter((k) => !usedKeys.has(k));
    expect(unused).toEqual([]);
  });
});

describe("translated viewer dictionaries", () => {
  for (const locale of VIEWER_LOCALES.filter((l) => l !== "en")) {
    test(`${locale} matches en (keys, plural forms, placeholders)`, () => {
      expect(checkDictionary(en, viewerMessages[locale]!, locale)).toEqual([]);
    });
  }
});
