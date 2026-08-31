/**
 * The page main.ts auto-opens in the host's default browser on startup —
 * the whole point of it existing is so a non-technical host never has to
 * read raw terminal output to find the address to share, or a terminal
 * window to know how to stop the session. This *is* the app's real UI —
 * see the project's collaboration-hosting design notes for why a native
 * app shell (Electron/Tauri) was deliberately not built instead.
 *
 * Polls its own /status.json until the tunnel's URL shows up (cloudflared
 * takes a moment to connect), then shows it big with a one-click Copy
 * button; a Stop button ends the session from right here instead of
 * requiring the host to go find and close a separate console window
 * (which still works too, as a backup — see main.ts).
 *
 * Deliberately plain, dependency-free HTML/CSS/JS — this is served by the
 * collab server itself, not built by any bundler.
 */
export function renderStatusPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Electronic Catalog Maker — Collaboration Server</title>
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
  .card {
    border: 1px solid #8884;
    border-radius: 12px;
    padding: 1.25rem;
    margin-top: 1.5rem;
  }
  .url-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  #url {
    flex: 1;
    min-width: 16rem;
    font-family: ui-monospace, monospace;
    font-size: 1.05rem;
    padding: 0.6rem 0.8rem;
    border-radius: 8px;
    border: 1px solid #8884;
    background: #8881;
  }
  button {
    font-size: 1rem;
    padding: 0.6rem 1rem;
    border-radius: 8px;
    border: 1px solid #8884;
    cursor: pointer;
    background: #0969da;
    color: white;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint { opacity: 0.75; font-size: 0.92rem; }
  .error { color: #b91c1c; }
  .card-actions { display: flex; justify-content: flex-end; margin-top: 1rem; }
  #stop { background: #b91c1c; }
  #leave-hint { margin-top: 1.5rem; }
  #stopped-banner { display: none; }
  #stopped-banner.show { display: block; }
</style>
</head>
<body>
  <h1>🤝 Electronic Catalog Maker — Collaboration Server</h1>
  <p id="intro">This server is running on your computer. In the editor, just click <strong>Start collaboration</strong> — it finds this automatically, nothing to copy in the usual case.</p>
  <div id="stopped-banner" class="card">
    <strong>Stopped.</strong> The session has ended — you can close this tab now.
  </div>
  <div class="card" id="live-card">
    <div class="url-row">
      <input id="url" type="text" readonly value="Waiting for the tunnel to connect…" />
      <button id="copy" disabled>Copy</button>
    </div>
    <p class="hint" id="hint">This can take a few seconds the first time.</p>
    <div class="card-actions">
      <button id="stop" type="button">Stop</button>
    </div>
  </div>
  <p class="hint" id="leave-hint">Leave this open while you're collaborating — stopping it (or closing this app) ends the session for everyone.</p>
<script>
  const urlInput = document.getElementById("url");
  const copyBtn = document.getElementById("copy");
  const stopBtn = document.getElementById("stop");
  const hint = document.getElementById("hint");
  const intro = document.getElementById("intro");
  const liveCard = document.getElementById("live-card");
  const leaveHint = document.getElementById("leave-hint");
  const stoppedBanner = document.getElementById("stopped-banner");
  let stopped = false;

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
      // The process tearing itself down can race the response — that's fine,
      // the banner below is what actually matters to the person watching.
    }
    stopped = true;
    intro.style.display = "none";
    liveCard.style.display = "none"; // takes the Stop button with it, it lives inside this card now
    leaveHint.style.display = "none";
    stoppedBanner.classList.add("show");
  });

  async function poll() {
    if (stopped) return;
    try {
      const res = await fetch("/status.json");
      const data = await res.json();
      if (data.publicUrl) {
        urlInput.value = data.publicUrl;
        copyBtn.disabled = false;
        hint.textContent =
          "Ready — go click Start collaboration in the editor. You normally don't need to copy this: only paste it in by hand if a colleague's editor says it can't find a collaboration server automatically.";
        return; // stop polling once it's up; a fresh run gets a fresh page anyway
      }
      if (data.tunnelError) {
        urlInput.value = "No public address available";
        hint.textContent = data.tunnelError;
        hint.classList.add("error");
        return; // stop polling — this state won't resolve itself without a restart
      }
    } catch {
      // server not answering yet (or just stopped) — keep trying, same as the "not up yet" case
    }
    setTimeout(poll, 1000);
  }
  poll();
</script>
</body>
</html>`;
}
