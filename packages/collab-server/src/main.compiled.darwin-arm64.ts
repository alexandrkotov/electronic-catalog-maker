/** See main.compiled.linux-x64.ts's doc comment — same idea, Apple Silicon macOS binary. */
import { extractEmbeddedBinary } from "./embedCloudflared";
import cloudflaredEmbedded from "../vendor/cloudflared-darwin-arm64" with { type: "file" };

process.env.CLOUDFLARED_PATH ??= await extractEmbeddedBinary(cloudflaredEmbedded, "ecm-collab-server-cloudflared");
await import("./main");
