/**
 * Pops a native "choose a folder" dialog, by shelling out to whatever the
 * OS already ships — same platform-branching pattern as openInBrowser.ts.
 * There's no Bun/Node API for this (the browser's own `showDirectoryPicker`
 * doesn't exist here — this runs in a compiled server binary, not a page),
 * so the OS's own tool is the only option.
 *
 * Returns null on cancel *or* on any failure (tool missing, unsupported
 * platform, non-zero exit) — the status page's own text field is the
 * fallback for typing a path by hand either way, so the caller doesn't need
 * to distinguish "cancelled" from "couldn't ask at all".
 */
export async function pickFolderNative(): Promise<string | null> {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? ["osascript", "-e", "POSIX path of (choose folder)"]
      : platform === "win32"
        ? [
            "powershell",
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; " +
              "$f = New-Object System.Windows.Forms.FolderBrowserDialog; " +
              "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }",
          ]
        : ["zenity", "--file-selection", "--directory"];

  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", windowsHide: true });
    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;
    const path = output.trim();
    return code === 0 && path.length > 0 ? path : null;
  } catch {
    return null; // tool not installed/on PATH (e.g. zenity missing on a minimal Linux/Chromebook install), or spawn otherwise failed
  }
}
