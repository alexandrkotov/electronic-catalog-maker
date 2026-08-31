/**
 * The page main.ts auto-opens in the host's default browser on startup —
 * the whole point of it existing is so a non-technical host never has to
 * read raw terminal output to find the address to share. Polls its own
 * /status.json until the tunnel's URL shows up (cloudflared takes a moment
 * to connect), then shows it big with a one-click Copy button.
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
  .waiting { opacity: 0.75; }
</style>
</head>
<body>
  <h1>🤝 Electronic Catalog Maker — Collaboration Server</h1>
  <p>This server is running on your computer. Give the address below to whoever's editing — they'll open it in the "Server settings…" dialog before starting or joining a shared session.</p>
  <div class="card">
    <div class="url-row">
      <input id="url" type="text" readonly value="Waiting for the tunnel to connect…" />
      <button id="copy" disabled>Copy</button>
    </div>
    <p class="hint" id="hint">This can take a few seconds the first time.</p>
  </div>
  <p class="hint">Leave this window open while you're collaborating — closing it (or this app) ends the session for everyone.</p>
<script>
  const urlInput = document.getElementById("url");
  const copyBtn = document.getElementById("copy");
  const hint = document.getElementById("hint");

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

  async function poll() {
    try {
      const res = await fetch("/status.json");
      const data = await res.json();
      if (data.publicUrl) {
        urlInput.value = data.publicUrl;
        copyBtn.disabled = false;
        hint.textContent = "Ready — paste this into the editor's Server settings…";
        return; // stop polling once it's up; a fresh run gets a fresh page anyway
      }
    } catch {
      // server not answering yet — keep trying, same as the "not up yet" case
    }
    setTimeout(poll, 1000);
  }
  poll();
</script>
</body>
</html>`;
}
