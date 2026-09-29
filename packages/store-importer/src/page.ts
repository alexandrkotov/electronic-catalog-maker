import { THEME_INIT_SCRIPT, THEME_TOGGLE_BUTTON_HTML, THEME_TOGGLE_SCRIPT, THEME_VARS_CSS } from "./theme";

const COMPOSER_URL = "https://tapalog.com/composer/";

/**
 * The app's whole UI: store address -> platform -> import (with progress)
 * -> report + hand-off to Grid Composer. Plain template-literal page like
 * catalog-server's, so the compiled binary needs no bundler step.
 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
${THEME_INIT_SCRIPT}
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/png" href="/favicon.png" />
<title>ECM — Store Importer</title>
<style>
${THEME_VARS_CSS}
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 44rem;
    margin: 3rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
    background: var(--bg-page);
    color: var(--text);
  }
  .page-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  h1 { font-size: 1.3rem; margin: 0; }
  h2 { font-size: 1rem; margin: 0 0 0.5rem; }
  .flow { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin: 1rem 0 0.25rem; }
  .flow .step { border: 1px solid var(--border); background: var(--bg-panel); border-radius: 999px; padding: 0.3rem 0.8rem; font-weight: 600; font-size: 0.95rem; white-space: nowrap; }
  .flow .arrow { color: var(--muted); font-weight: 600; }
  .card { border: 1px solid var(--border); background: var(--bg-panel); border-radius: 12px; padding: 1.25rem; margin-top: 1.5rem; }
  .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.75rem; }
  label.field { display: block; font-weight: 600; margin-bottom: 0.25rem; }
  input[type=text], select {
    font-size: 0.95rem; padding: 0.6rem 0.8rem; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text);
  }
  input[type=text] { flex: 1; min-width: 14rem; }
  #output-root { font-family: ui-monospace, monospace; }
  button {
    font-size: 1rem; padding: 0.6rem 1rem; border-radius: 8px; border: 1px solid var(--border);
    cursor: pointer; background: var(--accent); color: var(--on-accent); white-space: nowrap;
  }
  button.secondary { background: transparent; color: var(--text); }
  button:disabled { opacity: 0.5; cursor: default; }
  a.button { display: inline-block; text-decoration: none; font-size: 1rem; padding: 0.6rem 1rem; border-radius: 8px; background: var(--accent); color: var(--on-accent); }
  a { color: var(--accent); }
  .hint { opacity: 0.75; font-size: 0.92rem; }
  .error { color: var(--danger); }
  .consent { display: flex; gap: 0.5rem; align-items: flex-start; margin: 0.25rem 0 0.9rem; cursor: pointer; }
  .consent input { margin-top: 0.3rem; flex-shrink: 0; }
  .notice { border-left: 4px solid var(--accent); padding-left: 0.9rem; }
  #stop { background: var(--danger); }
  progress { width: 100%; height: 0.9rem; }
  table.report { border-collapse: collapse; margin: 0.5rem 0 1rem; }
  table.report td { padding: 0.2rem 1rem 0.2rem 0; vertical-align: top; }
  table.report td:first-child { opacity: 0.75; }
  code { font-family: ui-monospace, monospace; font-size: 0.9em; word-break: break-all; }
  ol { padding-left: 1.3rem; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div class="page-header">
    <h1>🛒 ECM — Store Importer</h1>
    ${THEME_TOGGLE_BUTTON_HTML}
  </div>
  <div class="flow" aria-label="Your store, then photos and a table, then Grid Composer, then a catalog">
    <span class="step">🛒 Your store</span><span class="arrow">→</span>
    <span class="step">📁 Photos + table</span><span class="arrow">→</span>
    <span class="step">🧩 Grid Composer</span><span class="arrow">→</span>
    <span class="step">📖 Catalog</span>
  </div>
  <p>Pulls the products out of an online store and saves them as a folder of photos plus a table — exactly what <a href="${COMPOSER_URL}" target="_blank" rel="noopener">Grid Composer</a> needs to build a tile catalog.</p>

  <div class="card">
    <label class="field" for="store-url">Store address</label>
    <div class="row">
      <input type="text" id="store-url" placeholder="yourstore.com" autocomplete="url" spellcheck="false" />
    </div>
    <label class="field" for="preset">Platform</label>
    <div class="row">
      <select id="preset"><option value="auto">Detect automatically</option></select>
    </div>
    <p class="hint">Leave it on <strong>Detect automatically</strong> unless detection fails and you know which platform the store runs on.</p>
    <div id="saved-pages" hidden>
      <label class="field" for="saved-files">Saved store pages</label>
      <p class="hint" id="how-to-save-intro"></p>
      <ol class="hint" id="how-to-save-steps"></ol>
      <div class="row"><input type="file" id="saved-files" multiple accept=".html,.htm,text/html" /></div>
    </div>
    <label class="consent"><input type="checkbox" id="skip-sku" /> <span>Don't import SKUs — leave the SKU column empty (for stores whose SKU field holds something else, like stock counts).</span></label>
    <label class="field" for="output-root">Save imports in this folder</label>
    <div class="row">
      <input type="text" id="output-root" spellcheck="false" />
      <button type="button" class="secondary" id="pick-root">Browse…</button>
      <button type="button" class="secondary" id="open-root">Open</button>
      <button type="button" id="save-root" hidden>Save</button>
    </div>
    <p class="hint">Click <strong>Browse…</strong> to choose a different folder (or type its path and press Save). Each store gets its own subfolder inside it, named after the store — for example <code>Documents\\ECM Store Importer\\yourstore.com</code> on Windows, <code>~/Documents/ECM Store Importer/yourstore.com</code> on macOS and Linux. Importing the same store again replaces its previous snapshot.</p>
    <label class="consent"><input type="checkbox" id="consent" /> <span>This is my store, or I have the owner's permission to use its photos and texts.</span></label>
    <div class="row"><button type="button" id="import" disabled>Import</button></div>
    <p id="form-error" class="error" hidden></p>
  </div>

  <div class="card" id="progress-card" hidden>
    <h2 id="progress-title">Importing…</h2>
    <progress id="progress-bar"></progress>
    <p id="progress-text" class="hint"></p>
  </div>

  <div class="card" id="report-card" hidden>
    <h2>Done</h2>
    <table class="report"><tbody id="report-rows"></tbody></table>
    <div class="row">
      <button type="button" id="open-folder" class="secondary">Open folder</button>
      <a class="button" href="${COMPOSER_URL}" target="_blank" rel="noopener">Open Grid Composer</a>
    </div>
    <p>In Grid Composer:</p>
    <ol>
      <li><strong>Photos</strong> → choose the <code>photos</code> folder above.</li>
      <li><strong>Table</strong> → open <code>catalog.csv</code>.</li>
      <li>Check the settings, then <strong>Build catalog</strong>.</li>
    </ol>
  </div>

  <div class="card notice">
    <p><strong>A snapshot, not a live link.</strong> Prices and names are copied as of the import, and Grid Composer draws them into the tile pictures. When the store changes, import again and rebuild the catalog. Each <strong>Buy</strong> button opens the product's own page in the store, so checkout always uses the store's current price.</p>
    <p><strong>Only publish what you own.</strong> Photos and texts belong to the store. Importing your own store is fine. A catalog made from someone else's store is for showing to that store's owner only: don't publish it.</p>
  </div>

  <div class="row" style="margin-top:1.5rem"><button type="button" id="stop">Quit Store Importer</button></div>
  <p class="hint" id="quit-hint">Closing this tab doesn't stop the app — it keeps running in the background. Use this button when you're done.</p>
  <p id="stopped" class="hint" hidden>Store Importer has quit — you can close this tab.</p>

<script>
${THEME_TOGGLE_SCRIPT}
  var $ = function (id) { return document.getElementById(id); };
  var savedRoot = "";
  var importBusy = false;

  // Import stays off until the person confirms the content is theirs to use (see the notice below the form).
  function updateImportButton() { $("import").disabled = importBusy || !$("consent").checked; }
  $("consent").addEventListener("change", updateImportButton);
  var polling = null;

  function showError(msg) { $("form-error").textContent = msg; $("form-error").hidden = !msg; }

  function postJson(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); });
  }

  function listNos(nos) {
    if (!nos.length) return "none";
    var shown = nos.slice(0, 15).join(", ");
    return nos.length + " (No. " + shown + (nos.length > 15 ? ", …" : "") + ")";
  }

  function addRow(label, value) {
    var tr = document.createElement("tr");
    var a = document.createElement("td"); a.textContent = label;
    var b = document.createElement("td"); b.textContent = value;
    tr.appendChild(a); tr.appendChild(b);
    $("report-rows").appendChild(tr);
  }

  function addPagesRow(pages) {
    var tr = document.createElement("tr");
    var a = document.createElement("td"); a.textContent = "Store pages";
    var b = document.createElement("td");
    var text = "Saved: " + pages.saved.join(", ") + ".";
    if (pages.missing.length) text += " Missing: ";
    b.appendChild(document.createTextNode(text));
    pages.missing.forEach(function (m, i) {
      if (i) b.appendChild(document.createTextNode(", "));
      if (m.href) {
        var link = document.createElement("a");
        link.href = m.href; link.target = "_blank"; link.rel = "noopener"; link.textContent = String(m.number);
        b.appendChild(link);
      } else b.appendChild(document.createTextNode(String(m.number)));
    });
    var last = pages.missing.length ? pages.missing[pages.missing.length - 1].number : pages.moreAfter;
    if (pages.missing.length || pages.moreAfter) {
      var warn = document.createElement("div");
      warn.className = "error";
      warn.textContent = (pages.missing.length ? "Save the missing pages too, then import all the files together." : "Page " + pages.moreAfter + " still has a Next link — more pages follow it.")
        + " The store only lists a few page numbers at a time, so check page " + last + " for a Next link and keep going until there isn't one.";
      b.appendChild(warn);
    }
    tr.appendChild(a); tr.appendChild(b);
    $("report-rows").appendChild(tr);
  }

  function renderProgress(p) {
    var bar = $("progress-bar"), text = $("progress-text");
    if (!p || p.stage === "detecting") { bar.removeAttribute("value"); text.textContent = "Recognizing the store's platform…"; return; }
    if (p.stage === "listing") { bar.removeAttribute("value"); text.textContent = "Reading the product list: page " + p.page + ", " + p.products + " products so far…"; return; }
    if (p.stage === "photos") { bar.max = Math.max(p.total, 1); bar.value = p.done; text.textContent = "Downloading photos: " + p.done + " of " + p.total + "…"; return; }
    bar.removeAttribute("value"); text.textContent = "Writing the table…";
  }

  function renderJob(job) {
    var busy = job.running;
    importBusy = busy;
    updateImportButton();
    $("progress-card").hidden = !busy;
    if (busy) renderProgress(job.progress);
    if (job.error) showError(job.error);
    $("report-card").hidden = !job.report;
    if (job.report) {
      var r = job.report;
      $("report-rows").innerHTML = "";
      addRow("Store", r.origin + " (" + r.platform + ")");
      addRow("Products", String(r.products));
      addRow("Folders", r.folders.map(function (f) { return f || "(root)"; }).join(", "));
      if (r.pages) addPagesRow(r.pages);
      addRow("No photo in the store", listNos(r.noPhoto));
      addRow("Photo failed to download", listNos(r.photoFailed));
      addRow("No category in the store (moved to Other)", listNos(r.noFolder));
      if (r.skuSkipped) addRow("SKU", "not imported (as requested)");
      else addRow("No SKU", listNos(r.noSku));
      addRow("No price", listNos(r.noPrice));
      addRow("Saved to", r.outDir);
    }
    return busy;
  }

  function poll() {
    fetch("/job.json").then(function (r) { return r.json(); }).then(function (job) {
      if (!renderJob(job)) { clearInterval(polling); polling = null; }
    });
  }

  function startPolling() { if (!polling) polling = setInterval(poll, 700); poll(); }

  var presets = [];

  /** The saved-page preset in effect: picked by hand, or implied by the address (payhip.com/...). */
  function savedPagePreset() {
    var chosen = $("preset").value;
    if (chosen !== "auto") return presets.filter(function (p) { return p.id === chosen && p.kind === "saved-page"; })[0] || null;
    var host = "";
    try { host = new URL(/^https?:/i.test($("store-url").value.trim()) ? $("store-url").value.trim() : "https://" + $("store-url").value.trim()).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) {}
    return presets.filter(function (p) { return p.kind === "saved-page" && p.hosts.indexOf(host) >= 0; })[0] || null;
  }

  function updateSavedPages() {
    var p = savedPagePreset();
    $("saved-pages").hidden = !p;
    if (!p) return;
    $("how-to-save-intro").textContent = p.howToSave.intro;
    var ol = $("how-to-save-steps");
    ol.innerHTML = "";
    p.howToSave.steps.forEach(function (step) {
      var li = document.createElement("li"); li.textContent = step; ol.appendChild(li);
    });
  }
  $("preset").addEventListener("change", updateSavedPages);
  $("store-url").addEventListener("input", updateSavedPages);

  fetch("/status.json").then(function (r) { return r.json(); }).then(function (s) {
    setRoot(s.outputRoot);
    presets = s.presets;
    // Alphabetical here; detection still probes in the server's own order (most common platform first).
    s.presets.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (p) {
      var o = document.createElement("option"); o.value = p.id; o.textContent = p.name; $("preset").appendChild(o);
    });
  });
  poll();

  $("output-root").addEventListener("input", function () { $("save-root").hidden = $("output-root").value.trim() === savedRoot; });
  function setRoot(path) {
    savedRoot = path;
    $("output-root").value = path;
    $("save-root").hidden = true;
  }

  $("pick-root").addEventListener("click", function () {
    var btn = $("pick-root");
    btn.disabled = true;
    // On Windows the dialog can open behind this tab, without focus.
    btn.textContent = "Check your taskbar for the dialog…";
    postJson("/output-root/pick").then(function (res) {
      if (res.ok) { showError(""); setRoot(res.path); }
      else if (res.error) showError(res.error);
    }).finally(function () { btn.disabled = false; btn.textContent = "Browse…"; });
  });

  $("open-root").addEventListener("click", function () { postJson("/open-folder", { which: "root" }); });

  $("save-root").addEventListener("click", function () {
    postJson("/output-root", { path: $("output-root").value }).then(function (res) {
      if (!res.ok) return showError(res.error);
      showError(""); setRoot(res.path);
    });
  });

  function startImport() {
    showError("");
    if ($("output-root").value.trim() !== savedRoot) return showError("Press Save to use the folder you typed (or click Browse… instead).");
    var saved = savedPagePreset();
    var files = saved ? Array.prototype.slice.call($("saved-files").files) : [];
    if (saved && !files.length) return showError("Pick the saved " + saved.name + " page (or pages) first.");
    Promise.all(files.map(function (f) { return f.text(); })).then(function (pages) {
      var body = { url: $("store-url").value, preset: saved ? saved.id : $("preset").value, ownerConfirmed: $("consent").checked, skipSku: $("skip-sku").checked };
      if (saved) body.pages = pages;
      return postJson("/import", body);
    }).then(function (res) {
      if (!res.ok) return showError(res.error);
      $("report-card").hidden = true;
      $("progress-card").hidden = false;
      renderProgress(null);
      startPolling();
    });
  }
  $("import").addEventListener("click", startImport);
  $("store-url").addEventListener("keydown", function (e) { if (e.key === "Enter" && !$("import").disabled) startImport(); });

  $("open-folder").addEventListener("click", function () { postJson("/open-folder", { which: "store" }); });

  $("stop").addEventListener("click", function () {
    postJson("/shutdown").finally(function () { $("stop").disabled = true; $("quit-hint").hidden = true; $("stopped").hidden = false; });
  });
</script>
</body>
</html>`;
}
