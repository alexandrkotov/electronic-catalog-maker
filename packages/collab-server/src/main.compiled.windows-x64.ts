/** See main.compiled.linux-x64.ts's doc comment — same idea, Windows binary. Needs a real ".exe" name (unlike the other platforms) for Windows to actually run it. */
import { extractEmbeddedBinary } from "./embedCloudflared";
import cloudflaredEmbedded from "../vendor/cloudflared-windows-x64.exe" with { type: "file" };

process.env.CLOUDFLARED_PATH ??= await extractEmbeddedBinary(cloudflaredEmbedded, "ecm-collab-server-cloudflared.exe");
await import("./main");
