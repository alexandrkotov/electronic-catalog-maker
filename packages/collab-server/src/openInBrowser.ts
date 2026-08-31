/** Best-effort "open this in the default browser" — the URL is always printed to the console too, so a failure here never strands the host without a way to find it. */
export function openInBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // No graphical opener available (e.g. a headless box) — the console
    // message main.ts prints already has the same localhost URL.
  }
}
