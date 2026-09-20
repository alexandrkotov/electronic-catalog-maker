import { describe, expect, test } from "bun:test";
import { appLocaleCandidates, checkDictionary, createTranslator, matchLocale, pickLocale, urlLocale } from "./i18n.js";

const en = {
  "cart.label": "Cart",
  "cart.label@education": "Collection",
  "greet": "Hello, {name}!",
  "items.one": "{count} item",
  "items.other": "{count} items",
};
const ru = {
  "cart.label": "Корзина",
  "cart.label@education": "Коллекция",
  "greet": "Здравствуйте, {name}!",
  "items.one": "{count} товар",
  "items.few": "{count} товара",
  "items.many": "{count} товаров",
  "items.other": "{count} товара",
};

describe("createTranslator", () => {
  test("interpolates and does not re-expand substituted values", () => {
    const t = createTranslator({ messages: en, locale: "en" });
    expect(t("greet", { name: "{name}" })).toBe("Hello, {name}!");
    expect(t("greet")).toBe("Hello, {name}!");
  });

  test("Russian plural categories", () => {
    const t = createTranslator({ messages: ru, locale: "ru", fallback: en });
    expect([1, 2, 5, 21, 22, 25].map((n) => t("items", { count: n }))).toEqual([
      "1 товар", "2 товара", "5 товаров", "21 товар", "22 товара", "25 товаров",
    ]);
  });

  test("mode override wins, falls back to the plain key", () => {
    const edu = createTranslator({ messages: en, locale: "en", mode: "education" });
    expect(edu("cart.label")).toBe("Collection");
    expect(edu("greet", { name: "A" })).toBe("Hello, A!");
    expect(createTranslator({ messages: en, locale: "en" })("cart.label")).toBe("Cart");
  });

  test("falls back to English, then to the key, reporting once", () => {
    const missing: string[] = [];
    const t = createTranslator({ messages: {}, locale: "de", fallback: en, onMissing: (k) => missing.push(k) });
    expect(t("cart.label")).toBe("Cart");
    expect(t("nope")).toBe("nope");
    t("nope");
    expect(missing).toEqual(["nope"]);
  });

  test("English fallback uses English plural rules under a Russian locale", () => {
    const t = createTranslator({ messages: {}, locale: "ru", fallback: en });
    expect(t("items", { count: 1 })).toBe("1 item");
    expect(t("items", { count: 5 })).toBe("5 items");
  });
});

describe("locale selection", () => {
  const supported = ["en", "ru", "uk"];
  test("matchLocale maps regions and case", () => {
    expect(matchLocale("ru-RU", supported)).toBe("ru");
    expect(matchLocale("UK", supported)).toBe("uk");
    expect(matchLocale("fr", supported)).toBeUndefined();
  });
  test("pickLocale takes the first supported candidate", () => {
    expect(pickLocale([undefined, "fr", "uk-UA", "ru"], supported)).toBe("uk");
    expect(pickLocale(["fr", ""], supported)).toBe("en");
  });
});

describe("checkDictionary", () => {
  test("clean dictionaries pass", () => {
    expect(checkDictionary(en, en, "en")).toEqual([]);
    expect(checkDictionary(en, ru, "ru")).toEqual([]);
  });
  test("reports missing, extra, plural, and placeholder problems", () => {
    const bad = {
      "cart.label": "Корзина",
      "greet": "Здравствуйте!",
      "items.one": "{count} товар {oops}",
      "items.other": "{count} товара",
      "stray": "x",
    };
    expect(checkDictionary(en, bad, "ru").sort()).toEqual([
      "extra (not in base): stray",
      "missing plural form: items.few",
      "missing plural form: items.many",
      "missing: cart.label@education",
      "placeholder {name} missing in greet",
      "unknown placeholder {oops} in items.one",
    ]);
  });
  test("Japanese needs only `other`", () => {
    const ja = { "cart.label": "カート", "cart.label@education": "コレクション", greet: "{name}さん、こんにちは", "items.other": "{count}点" };
    expect(checkDictionary(en, ja, "ja")).toEqual([]);
  });
});

describe("language from the page URL", () => {
  const withSearch = (search: string, fn: () => void) => {
    (globalThis as { location?: unknown }).location = { search };
    try { fn(); } finally { delete (globalThis as { location?: unknown }).location; }
  };
  test("?lang= is read and comes first among the app candidates", () => {
    withSearch("?src=x.ecatm&lang=uk", () => {
      expect(urlLocale()).toBe("uk");
      expect(pickLocale(appLocaleCandidates(["en", "ru", "uk"]), ["en", "ru", "uk"])).toBe("uk");
    });
  });
  test("no ?lang= (or no location at all) means no URL preference", () => {
    withSearch("?src=x.ecatm", () => expect(urlLocale()).toBeUndefined());
    expect(urlLocale()).toBeUndefined();
  });
  test("an unsupported ?lang= falls through to the next candidate", () => {
    withSearch("?lang=xx", () => expect(pickLocale(["xx", "ru"], ["en", "ru"])).toBe("ru"));
  });
});
