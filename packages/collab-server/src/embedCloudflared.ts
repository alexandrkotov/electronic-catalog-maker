import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A `bun build --compile`'d executable's `with { type: "file" }` imports
 * resolve to a virtual `$bunfs/...` path — real enough for Bun's own file
 * APIs (`Bun.file`, `fs`) to read, but *not* a real filesystem entry the OS
 * can actually exec: `Bun.spawn` on it fails with ENOENT (confirmed by
 * hand while building this), and the extracted bytes don't carry over the
 * source file's executable permission bit either way. This copies the
 * embedded binary's real bytes out to a genuine temp file and marks it
 * executable, once per process start — that's the file every
 * main.compiled.<platform>.ts entry point actually points CLOUDFLARED_PATH
 * at.
 */
export async function extractEmbeddedBinary(embeddedPath: string, tempName: string): Promise<string> {
  const realPath = join(tmpdir(), tempName);
  await Bun.write(realPath, Bun.file(embeddedPath));
  chmodSync(realPath, 0o755);
  return realPath;
}
