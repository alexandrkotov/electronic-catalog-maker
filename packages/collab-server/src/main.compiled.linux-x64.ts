/**
 * Entry point used only by `compile:linux-x64` — embeds the real
 * cloudflared binary (fetched into vendor/ by scripts/fetch-cloudflared.ts
 * right before this compiles) directly into the resulting single-file
 * executable, so a person running it never needs cloudflared installed
 * separately. See embedCloudflared.ts for why this can't just point
 * CLOUDFLARED_PATH at the embedded asset's own path directly.
 *
 * Plain `bun run src/main.ts` (dev mode) never imports this file, so dev
 * mode has no dependency on vendor/ existing at all — see main.ts's own
 * CLOUDFLARED_PATH fallback to a plain PATH-resolved "cloudflared".
 */
import { extractEmbeddedBinary } from "./embedCloudflared";
import cloudflaredEmbedded from "../vendor/cloudflared-linux-x64" with { type: "file" };

process.env.CLOUDFLARED_PATH ??= await extractEmbeddedBinary(cloudflaredEmbedded, "ecm-collab-server-cloudflared");
await import("./main");
