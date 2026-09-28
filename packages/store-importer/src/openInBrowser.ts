import { IS_WSL, WIN_EXPLORER, wslpath } from "./wsl";

/** Best-effort "open this in the default browser" (or, given a folder path, the file manager — same OS openers) — the URL is always printed to the console too, so a failure here never strands the user without a way to find it. */
export function openInBrowser(url: string): void {
  const platform = process.platform;
  // Inside WSL (the dev setup) hand it to Windows itself: explorer.exe opens
  // both a URL (in the default browser) and a folder (given its Windows path).
  const wslTarget = IS_WSL ? (/^https?:/.test(url) ? url : wslpath(url, "windows")) : null;
  const command = wslTarget
    ? [WIN_EXPLORER, wslTarget]
    : platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(command, {
      stdout: "ignore",
      stderr: "ignore",
      // Same reasoning as tunnel.ts's spawn: on Windows, `cmd.exe` is a
      // console-subsystem app, so spawning it from this console-less
      // (--windows-hide-console) process makes Windows flash a fresh
      // console window for the instant `cmd /c start` takes to run —
      // confirmed live (a real, if brief, window appeared and vanished),
      // not just a theoretical gap left over from the cloudflared fix.
      // windowsHide is a no-op on the non-Windows branches above.
      windowsHide: true,
    });
  } catch {
    // No graphical opener available (e.g. a headless box) — the console
    // message main.ts prints already has the same localhost URL.
  }
}
