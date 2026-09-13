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
 *
 * The temp filename includes this process's own pid: a fixed shared name
 * across launches means a second launch's `Bun.write` (open+truncate)
 * collides with a still-running earlier instance's cloudflared holding
 * that same file open for execution, and fails with `ETXTBSY: text file
 * is busy` — caught live running the collab-server snap package twice in
 * a row (2026-09-13), not specific to snap/Linux packaging.
 */
export async function extractEmbeddedBinary(embeddedPath: string, tempName: string): Promise<string> {
  // Insert the pid before any extension (rather than just appending it)
  // so Windows keeps its literal ".exe" tempName suffix at the real end
  // of the filename.
  const dot = tempName.lastIndexOf(".");
  const uniqueName = dot > 0 ? `${tempName.slice(0, dot)}-${process.pid}${tempName.slice(dot)}` : `${tempName}-${process.pid}`;
  const realPath = join(tmpdir(), uniqueName);
  await Bun.write(realPath, Bun.file(embeddedPath));
  chmodSync(realPath, 0o755);
  return realPath;
}
