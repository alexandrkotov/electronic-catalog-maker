import { afterEach, describe, expect, test } from "bun:test";
import { analyticsPath, analyticsReferrer, trackEvent } from "./analytics.js";

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

describe("analyticsPath", () => {
  test("a blob: catalog handed over by the wizard becomes one path", () => {
    expect(analyticsPath("/editor/?src=blob%3Ahttps%3A%2F%2Ftapalog.com%2F7b1c-4e")).toBe("/editor/?src=blob");
    expect(analyticsPath("/viewer/?image=1&src=blob%3Ahttps%3A%2F%2Ftapalog.com%2F7b1c-4e")).toBe("/viewer/?image=1&src=blob");
    expect(analyticsPath("/editor/?lang=ru&src=blob:https://tapalog.com/7b1c&x=1")).toBe("/editor/?lang=ru&src=blob&x=1");
  });

  test("shared-session links lose their room id and server address", () => {
    expect(analyticsPath("/editor/?collab=k3x9&server=https%3A%2F%2Fabc.trycloudflare.com")).toBe(
      "/editor/?collab=room&server=custom",
    );
  });

  test("which demo was opened stays visible", () => {
    expect(analyticsPath("/viewer/?src=..%2Fdemo%2Fliving-room.ecatm")).toBe("/viewer/?src=..%2Fdemo%2Fliving-room.ecatm");
    expect(analyticsPath("/viewer/?image=9&src=..%2Fdemo%2Fauto-spare-parts.ecatm&link=580")).toBe(
      "/viewer/?image=9&src=..%2Fdemo%2Fauto-spare-parts.ecatm&link=580",
    );
  });

  test("leaves plain paths and malformed input alone", () => {
    expect(analyticsPath("/")).toBe("/");
    expect(analyticsPath("/editor/")).toBe("/editor/");
    expect(analyticsPath("/editor/?src=%E0%A4%A&flag")).toBe("/editor/?src=%E0%A4%A&flag");
  });
});

describe("analyticsReferrer", () => {
  test("a same-site referrer loses its per-visit parts, others are untouched", () => {
    expect(analyticsReferrer("https://tapalog.com/editor/?collab=k3x9&server=https%3A%2F%2Fx.test")).toBe(
      "https://tapalog.com/editor/?collab=room&server=custom",
    );
    expect(analyticsReferrer("https://www.linkedin.com/")).toBe("https://www.linkedin.com/");
    expect(analyticsReferrer("")).toBe("");
  });
});
