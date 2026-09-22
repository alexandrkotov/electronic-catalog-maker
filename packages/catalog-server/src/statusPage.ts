/**
 * The page main.ts auto-opens in the host's default browser on startup —
 * same reasoning as collab-server's statusPage.ts (this *is* the app's UI,
 * no native app shell). Adds folder selection and a LAN/internet mode
 * switch on top of that page's address+Copy+Stop shape.
 */
export function renderStatusPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Electronic Catalog Maker — Catalog Server</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 40rem;
    margin: 3rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
  }
  h1 { font-size: 1.3rem; }
  h2 { font-size: 1rem; margin-bottom: 0.5rem; }
  .card {
    border: 1px solid #8884;
    border-radius: 12px;
    padding: 1.25rem;
    margin-top: 1.5rem;
  }
  .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.5rem; }
  input[type=text] {
    flex: 1;
    min-width: 14rem;
    font-family: ui-monospace, monospace;
    font-size: 0.95rem;
    padding: 0.6rem 0.8rem;
    border-radius: 8px;
    border: 1px solid #8884;
    background: #8881;
  }
  input[readonly] { opacity: 0.9; }
  button {
    font-size: 1rem;
    padding: 0.6rem 1rem;
    border-radius: 8px;
    border: 1px solid #8884;
    cursor: pointer;
    background: #0969da;
    color: white;
    white-space: nowrap;
  }
  button.secondary { background: transparent; color: inherit; }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint { opacity: 0.75; font-size: 0.92rem; }
  .error { color: #b91c1c; }
  .card-actions { display: flex; justify-content: space-between; margin-top: 1rem; gap: 0.5rem; flex-wrap: wrap; }
  #stop { background: #b91c1c; }
  #stopped-banner { display: none; }
  #stopped-banner.show { display: block; }
  .mode-row label { display: flex; align-items: center; gap: 0.35rem; font-weight: normal; }
  a.browse-link { font-weight: 600; }
</style>
</head>
<body>
  <h1>🗂️ Electronic Catalog Maker — Catalog Server</h1>
  <p id="intro">This server shares the catalogs in a folder on your computer with anyone who visits its address below — on your local network, or (if you switch to Internet mode) anywhere.</p>

  <div id="stopped-banner" class="card">
    <strong>Stopped.</strong> Run the app again to start sharing.
  </div>

  <div class="card" id="live-card">
    <h2>Folder</h2>
    <div class="row">
      <input id="folder-path" type="text" readonly value="No folder selected yet" />
      <button id="pick-folder" class="secondary" type="button">Browse…</button>
    </div>
    <div class="row" id="manual-folder-row" style="display:none">
      <input id="manual-folder-input" type="text" placeholder="Paste a folder path…" />
      <button id="manual-folder-set" class="secondary" type="button">Set</button>
    </div>
    <p class="hint" id="folder-hint">Pick the folder that contains your .ecatm catalog files.</p>

    <h2>Sharing</h2>
    <div class="row mode-row">
      <label><input type="radio" name="mode" value="lan" /> Local network</label>
      <label><input type="radio" name="mode" value="internet" /> Internet</label>
    </div>
    <div class="row">
      <input id="url" type="text" readonly value="Select a folder to start sharing" />
      <button id="copy" disabled>Copy</button>
    </div>
    <p class="hint" id="hint"></p>

    <div class="card-actions">
      <a class="browse-link" href="/browse" target="_blank" id="browse-link" style="display:none">Open catalog list →</a>
      <button id="stop" type="button">Stop</button>
    </div>
  </div>
  <p class="hint" id="leave-hint">Leave this open while sharing — stopping it (or closing this app) ends the session.</p>
<script>
  const folderPathEl = document.getElementById("folder-path");
  const pickFolderBtn = document.getElementById("pick-folder");
  const manualRow = document.getElementById("manual-folder-row");
  const manualInput = document.getElementById("manual-folder-input");
  const manualSetBtn = document.getElementById("manual-folder-set");
  const folderHint = document.getElementById("folder-hint");
  const modeRadios = document.querySelectorAll("input[name=mode]");
  const urlInput = document.getElementById("url");
  const copyBtn = document.getElementById("copy");
  const browseLink = document.getElementById("browse-link");
  const stopBtn = document.getElementById("stop");
  const hint = document.getElementById("hint");
  const intro = document.getElementById("intro");
  const liveCard = document.getElementById("live-card");
  const leaveHint = document.getElementById("leave-hint");
  const stoppedBanner = document.getElementById("stopped-banner");
  let stopped = false;
  let settingMode = false;

  pickFolderBtn.addEventListener("click", async () => {
    pickFolderBtn.disabled = true;
    pickFolderBtn.textContent = "Check your taskbar for the dialog…";
    try {
      const res = await fetch("/folder/pick", { method: "POST" });
      if (res.status === 409) {
        // Someone already clicked this and a dialog is still open — a
        // second click must not spawn a second one (see server.ts's
        // pickInProgress guard). On Windows especially, the dialog can open
        // without stealing focus from this browser tab, so it's easy to
        // miss — the button label above already points at the taskbar.
        folderHint.textContent = "A folder dialog is already open — look for it in your taskbar (it may not have popped to the front).";
        return;
      }
      const data = await res.json();
      if (!data.path) {
        // Native dialog unavailable or cancelled — offer the manual fallback rather than doing nothing.
        manualRow.style.display = "flex";
        folderHint.textContent = "Couldn't open a folder dialog here — paste the full path instead.";
      }
    } catch {
      folderHint.textContent = "Couldn't reach the server to open a dialog — try again, or paste the path instead.";
      manualRow.style.display = "flex";
    } finally {
      pickFolderBtn.disabled = false;
      pickFolderBtn.textContent = "Browse…";
    }
  });

  manualSetBtn.addEventListener("click", async () => {
    const path = manualInput.value.trim();
    if (!path) return;
    manualSetBtn.disabled = true;
    try {
      const res = await fetch("/folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      const data = await res.json();
      if (!data.ok) folderHint.textContent = data.error || "Couldn't use that folder.";
    } finally {
      manualSetBtn.disabled = false;
    }
  });

  for (const radio of modeRadios) {
    radio.addEventListener("change", async () => {
      settingMode = true;
      await fetch("/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: radio.value }) });
      settingMode = false;
    });
  }

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(urlInput.value);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    } catch {
      urlInput.select();
      hint.textContent = "Couldn't copy automatically — the address is selected, copy it yourself (Ctrl/Cmd+C).";
    }
  });

  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    stopBtn.textContent = "Stopping…";
    try {
      await fetch("/shutdown", { method: "POST" });
    } catch {
      // the process tearing itself down can race the response — the banner below is what matters
    }
    stopped = true;
    intro.style.display = "none";
    liveCard.style.display = "none";
    leaveHint.style.display = "none";
    stoppedBanner.classList.add("show");
  });

  async function poll() {
    if (stopped) return;
    try {
      const res = await fetch("/status.json");
      const data = await res.json();

      folderPathEl.value = data.folderPath || "No folder selected yet";
      folderHint.textContent = data.folderPath ? "" : "Pick the folder that contains your .ecatm catalog files.";
      browseLink.style.display = data.folderPath ? "" : "none";

      if (!settingMode) {
        for (const radio of modeRadios) radio.checked = radio.value === data.mode;
      }

      if (!data.folderPath) {
        urlInput.value = "Select a folder to start sharing";
        copyBtn.disabled = true;
      } else if (data.mode === "lan") {
        urlInput.value = data.localUrl;
        copyBtn.disabled = false;
        hint.textContent = "Anyone on this same local network/Wi-Fi can open this address.";
        hint.classList.remove("error");
      } else if (data.publicUrl) {
        urlInput.value = data.publicUrl;
        copyBtn.disabled = false;
        hint.textContent = "Anyone with this address can open it, from anywhere.";
        hint.classList.remove("error");
      } else if (data.tunnelError) {
        urlInput.value = data.localUrl;
        copyBtn.disabled = false;
        hint.textContent = data.tunnelError + " Showing the local-network address instead.";
        hint.classList.add("error");
      } else {
        urlInput.value = "Connecting…";
        copyBtn.disabled = true;
        hint.textContent = "This can take a few seconds the first time.";
        hint.classList.remove("error");
      }
    } catch {
      // server not answering yet (or just stopped) — keep trying
    }
    setTimeout(poll, 1000);
  }
  poll();
</script>
</body>
</html>`;
}
