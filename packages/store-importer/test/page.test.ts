import { expect, test } from "bun:test";
import { renderPage } from "../src/page";

// The page's script lives inside a TS template literal, where a stray `\`
// or `"` silently turns into broken JS — happened twice while building it.
test("the page's inline scripts parse", () => {
  const html = renderPage();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(scripts.length).toBeGreaterThan(0);
  for (const js of scripts) expect(() => new Function(js)).not.toThrow();
});
