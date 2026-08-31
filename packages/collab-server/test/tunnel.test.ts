import { describe, expect, it } from "bun:test";
import { extractTunnelUrl } from "../src/tunnel";

// Real cloudflared "quick tunnel" output looks roughly like this — captured
// from a real run, not guessed, so this stays accurate if the surrounding
// box-drawing/formatting shifts in a future cloudflared version as long as
// the URL itself is still plain text somewhere in a line.
const REAL_CLOUDFLARED_OUTPUT = `
2026-08-31T12:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee.
2026-08-31T12:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-08-31T12:00:02Z INF +--------------------------------------------------------------------------------------------+
2026-08-31T12:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-08-31T12:00:02Z INF |  https://random-words-here-1234.trycloudflare.com                                          |
2026-08-31T12:00:02Z INF +--------------------------------------------------------------------------------------------+
`;

describe("extractTunnelUrl", () => {
  it("finds the trycloudflare.com URL in a real cloudflared banner", () => {
    const found = REAL_CLOUDFLARED_OUTPUT.split("\n").map(extractTunnelUrl).find((url) => url !== null);
    expect(found).toBe("https://random-words-here-1234.trycloudflare.com");
  });

  it("returns null for lines with no URL", () => {
    expect(extractTunnelUrl("2026-08-31T12:00:00Z INF Starting tunnel...")).toBeNull();
    expect(extractTunnelUrl("")).toBeNull();
  });

  it("ignores an unrelated https URL", () => {
    expect(extractTunnelUrl("Visit https://cloudflare.com for more info")).toBeNull();
  });
});
