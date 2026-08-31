/** See main.compiled.linux-x64.ts's doc comment — same idea, ARM64 binary. */
import { extractEmbeddedBinary } from "./embedCloudflared";
import cloudflaredEmbedded from "../vendor/cloudflared-linux-arm64" with { type: "file" };

process.env.CLOUDFLARED_PATH ??= await extractEmbeddedBinary(cloudflaredEmbedded, "ecm-collab-server-cloudflared");
await import("./main");
