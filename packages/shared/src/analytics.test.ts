import { afterEach, describe, expect, test } from "bun:test";
import { trackEvent } from "./analytics.js";

const g = globalThis as { goatcounter?: unknown };

describe("trackEvent", () => {
  afterEach(() => {
    delete g.goatcounter;
  });

  test("sends only the event name, flagged as an event", () => {
    const calls: unknown[] = [];
    g.goatcounter = { count: (vars: unknown) => calls.push(vars) };
    trackEvent("editor-save");
    expect(calls).toEqual([{ event: true, path: "editor-save", title: "editor-save" }]);
  });

  test("does nothing where the counter isn't loaded", () => {
    expect(() => trackEvent("editor-save")).not.toThrow();
    g.goatcounter = {};
    expect(() => trackEvent("editor-save")).not.toThrow();
  });

  test("a failing counter cannot interrupt the caller", () => {
    g.goatcounter = {
      count: () => {
        throw new Error("blocked");
      },
    };
    expect(() => trackEvent("editor-save")).not.toThrow();
  });
});
