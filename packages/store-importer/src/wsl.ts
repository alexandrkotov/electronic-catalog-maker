import { readFileSync } from "node:fs";

/**
 * True when running as a Linux process inside WSL on Windows — the dev
 * setup (`pnpm dev:store-importer`), where Linux openers (xdg-open, zenity)
 * usually don't exist but Windows' own (explorer.exe, powershell.exe) do.
 */
export const IS_WSL = (() => {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf-8"));
  } catch {
    return false;
  }
})();

/** `wslpath` between the Linux and Windows views of the same file; null if it fails. */
export function wslpath(path: string, to: "windows" | "linux"): string | null {
  const proc = Bun.spawnSync(["wslpath", to === "windows" ? "-w" : "-u", path]);
  const out = proc.stdout.toString().trim();
  return proc.exitCode === 0 && out ? out : null;
}

// Full paths, not bare "powershell.exe"/"explorer.exe": WSL only puts
// Windows' own folders on PATH when `appendWindowsPath` is on, and this
// machine has it off (confirmed live 2026-09-27: Browse… silently did
// nothing because spawning "powershell.exe" failed with ENOENT).
export const WIN_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
export const WIN_EXPLORER = "/mnt/c/Windows/explorer.exe";

/**
 * The path as the person should see it: under WSL the browser (and the
 * person) live on Windows, so /mnt/e/test is shown as E:\test. Anywhere
 * else it's already the host's own path.
 */
export function toDisplayPath(path: string): string {
  return IS_WSL ? (wslpath(path, "windows") ?? path) : path;
}

/** The reverse of toDisplayPath, for a path typed or picked on the Windows side. */
export function fromDisplayPath(path: string): string {
  return IS_WSL && /^[a-z]:[\\/]|^\\\\/i.test(path) ? (wslpath(path, "linux") ?? path) : path;
}
