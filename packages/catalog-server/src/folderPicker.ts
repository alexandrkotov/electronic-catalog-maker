import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Writes the picked path to its own file via .NET's UTF8 (no BOM) writer,
// rather than printing it to stdout — a redirected PowerShell stdout pipe's
// text encoding depends on console-codepage state that turned out to behave
// differently between `-Command` and `-File` invocation (confirmed live,
// 2026-09-22: a Cyrillic folder name came back mangled once this switched to
// `-File` — see pickFolderWindows's own comment for why that switch
// happened). Writing to a file with an explicit .NET encoding sidesteps the
// whole class of console-encoding pitfalls; only cancel/no-selection needs
// stdout at all, and that path never contains non-ASCII text anyway.
const WINDOWS_PICKER_SCRIPT = (resultPath: string) => `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
if ($f.ShowDialog() -eq "OK") {
  [System.IO.File]::WriteAllText("${resultPath}", $f.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))
}
`;

/**
 * Runs the folder-dialog PowerShell script via a real temp .ps1 file
 * (`-File`), not an inline `-Command "..."` string. Confirmed live
 * (2026-09-22): `-Command` with this same script silently never showed the
 * dialog at all — no window, no error, the process just sat there — while
 * `-File` (with `-ExecutionPolicy Bypass`, since this machine's default
 * policy blocks running arbitrary scripts) shows it reliably. Apartment
 * state wasn't the cause (both ways report STA); this seems to be a real
 * quirk of how `-Command` initializes the host for a GUI message pump.
 * Also confirmed this bug pre-dates and is unrelated to MSIX packaging —
 * it reproduces identically on the plain GitHub-Release binary.
 */
async function pickFolderWindows(): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "ecm-folder-picker-"));
  const scriptPath = join(dir, "pick.ps1");
  const resultPath = join(dir, "result.txt");
  try {
    await writeFile(scriptPath, WINDOWS_PICKER_SCRIPT(resultPath), "utf-8");
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { stdout: "ignore", stderr: "ignore", windowsHide: true },
    );
    const code = await proc.exited;
    if (code !== 0) return null;
    const path = (await readFile(resultPath, "utf-8").catch(() => "")).trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
  if (platform === "win32") return pickFolderWindows();
  const command =
    platform === "darwin"
      ? ["osascript", "-e", "POSIX path of (choose folder)"]
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
