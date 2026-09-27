import "./style.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  appLocaleCandidates,
  applyTheme,
  CATALOG_FILE_EXTENSION,
  currentTheme,
  createTranslator,
  initSqlite,
  pickLocale,
  resolveInitialTheme,
  saveLocale,
  toggleTheme,
  type MessageParams,
} from "@ecm/shared";
import { COMPOSER_LOCALES, COMPOSER_LOCALE_NAMES, composerMessages } from "./messages.js";
import { parseTable, templateCsv, type ParsedTable } from "./table.js";
import { isBlocking, makePlan, type GridPlan, type Plan, type Report } from "./plan.js";
import { maxTilesPerGrid, newCanvasContext, renderGrid, titleFontSize, type PhotoFit } from "./render.js";
import { buildCatalog, type BuiltGrid } from "./build.js";

// ---------- state ----------

let locale = pickLocale(appLocaleCandidates(COMPOSER_LOCALES), COMPOSER_LOCALES);
let t = translator(locale);

const settings = {
  name: "",
  columns: 3,
  fit: "contain" as PhotoFit,
  subtitleKey: "sku",
  accent: "#2563eb",
};
let photos = new Map<string, File>();
let tableText = "";
let table: ParsedTable | null = null;
let plan: Plan | null = null;

type Result =
  | { kind: "building"; n: number; total: number }
  | { kind: "done"; url: string; fileName: string; grids: number; items: number; bytes: number; previews: string[] }
  | { kind: "failed"; message: string };
let result: Result | null = null;

function translator(loc: string) {
  return createTranslator({ messages: composerMessages[loc] ?? {}, locale: loc, fallback: composerMessages.en });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function tx(key: string, params?: MessageParams): string {
  return esc(t(key, params));
}

function catalogName(): string {
  return settings.name.trim() || t("settings.nameDefault");
}

function gridTitle(g: GridPlan): string {
  const base = g.folder || catalogName();
  return g.parts > 1 ? `${base} (${g.part}/${g.parts})` : base;
}

function replan() {
  const ceiling = maxTilesPerGrid(settings.columns, settings.subtitleKey !== "");
  plan = table && photos.size + table.items.length > 0 ? makePlan(table, [...photos.keys()], ceiling, settings.columns) : null;
  result = null;
}

// ---------- rendering ----------

const app = document.getElementById("app")!;

function render() {
  document.documentElement.lang = locale;
  document.title = `ECM ${t("app.title")}`;
  app.innerHTML = `
    <header class="top">
      <div>
        <h1>ECM <span>${tx("app.title")}</span></h1>
        <p class="muted">${tx("app.tagline")}</p>
      </div>
      <div class="top-actions">
        <select id="lang" aria-label="Language">
          ${COMPOSER_LOCALES.map((l) => `<option value="${l}"${l === locale ? " selected" : ""}>${COMPOSER_LOCALE_NAMES[l]}</option>`).join("")}
        </select>
        <button id="theme" class="neutral" title="${tx("theme.toggle")}">${currentTheme() === "dark" ? tx("theme.light") : tx("theme.dark")}</button>
      </div>
    </header>
    <main>
      ${renderSettings()}
      ${renderPhotos()}
      ${renderTable()}
      ${renderReport()}
      ${renderResult()}
    </main>`;
  wire();
}

function renderSettings(): string {
  const keys = table?.extraKeys ?? [];
  const subtitleOptions = [
    ["", t("settings.subtitle.none")],
    ["sku", t("settings.subtitle.sku")],
    ...keys.map((k) => [k, k]),
  ];
  if (!subtitleOptions.some(([v]) => v === settings.subtitleKey)) settings.subtitleKey = "sku";
  return `
    <section class="card">
      <h2>${tx("settings.heading")}</h2>
      <div class="form">
        <label>${tx("settings.name")}
          <input id="name" type="text" value="${esc(settings.name)}" placeholder="${tx("settings.nameDefault")}">
        </label>
        <label>${tx("settings.columns")}
          <select id="columns">${[2, 3, 4, 5, 6].map((n) => `<option${n === settings.columns ? " selected" : ""}>${n}</option>`).join("")}</select>
        </label>
        <label>${tx("settings.fit")}
          <select id="fit">
            <option value="contain"${settings.fit === "contain" ? " selected" : ""}>${tx("settings.fit.contain")}</option>
            <option value="cover"${settings.fit === "cover" ? " selected" : ""}>${tx("settings.fit.cover")}</option>
          </select>
        </label>
        <label>${tx("settings.subtitle")}
          <select id="subtitle">${subtitleOptions
            .map(([v, label]) => `<option value="${esc(v!)}"${v === settings.subtitleKey ? " selected" : ""}>${esc(label!)}</option>`)
            .join("")}</select>
          <small class="muted">${tx(!table ? "settings.subtitleHintNoTable" : keys.length ? "settings.subtitleHint" : "settings.subtitleHintNoExtra")}</small>
        </label>
        <label>${tx("settings.accent")}
          <input id="accent" type="color" value="${settings.accent}">
          <small class="muted">${tx("settings.accentHint")}</small>
        </label>
      </div>
    </section>`;
}

function renderPhotos(): string {
  return `
    <section class="card">
      <h2>${tx("photos.heading")}</h2>
      <p class="muted">${tx("photos.hint")}</p>
      <div class="row">
        <label class="btn">${tx("photos.chooseFolder")}<input id="photo-folder" type="file" webkitdirectory multiple hidden></label>
        <label class="btn secondary">${tx("photos.chooseFiles")}<input id="photo-files" type="file" accept="image/*" multiple hidden></label>
        <span class="status">${photos.size ? tx("photos.count", { count: photos.size }) : tx("photos.none")}</span>
      </div>
    </section>`;
}

function renderTable(): string {
  const status = table
    ? tx("table.loaded", { count: table.items.length, keys: table.extraKeys.join(", ") || t("table.noExtra") })
    : tx("table.none");
  return `
    <section class="card">
      <h2>${tx("table.heading")}</h2>
      <p class="muted">${tx("table.hint")}</p>
      <div class="row">
        <label class="btn">${tx("table.chooseFile")}<input id="table-file" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" hidden></label>
        <button id="template" class="secondary">${tx("table.template")}</button>
        <span class="status">${status}</span>
      </div>
      <label class="paste">${tx("table.pasteLabel")}
        <textarea id="paste" rows="5" spellcheck="false" placeholder="${tx("table.pastePlaceholder")}">${esc(tableText)}</textarea>
      </label>
    </section>`;
}

function list(values: Array<string | number>): string {
  const max = 20;
  const shown = values.slice(0, max).join(", ");
  return values.length > max ? `${shown}, … (+${values.length - max})` : shown;
}

function reportLines(r: Report): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (r.noItems) errors.push(t("report.noItems"));
  for (const b of r.badNumbers) errors.push(t("report.badNumber", { line: b.line, value: b.value }));
  for (const d of r.duplicateNumbers) errors.push(t("report.duplicateNumber", { no: d.no, lines: d.lines.join(", ") }));
  if (r.missingPhotos.length) warnings.push(t("report.missingPhotos", { list: list(r.missingPhotos) }));
  if (r.orphanPhotos.length) warnings.push(t("report.orphanPhotos", { list: list(r.orphanPhotos) }));
  if (r.duplicatePhotos.length) warnings.push(t("report.duplicatePhotos", { list: list(r.duplicatePhotos) }));
  if (r.unrecognizedFiles.length) warnings.push(t("report.unrecognized", { list: list(r.unrecognizedFiles) }));
  for (const d of r.duplicateSkus) warnings.push(t("report.duplicateSku", { sku: d.sku, list: d.nos.join(", ") }));
  if (r.emptyNames.length) warnings.push(t("report.emptyNames", { list: list(r.emptyNames) }));
  return { errors, warnings };
}

function renderReport(): string {
  if (!plan) {
    return `<section class="card"><h2>${tx("report.heading")}</h2><p class="muted">${tx("report.waiting")}</p></section>`;
  }
  const { errors, warnings } = reportLines(plan.report);
  const blocking = isBlocking(plan.report);
  const ul = (items: string[]) => `<ul>${items.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
  return `
    <section class="card">
      <h2>${tx("report.heading")}</h2>
      ${
        plan.grids.length
          ? `<h3>${tx("report.grids")}</h3>${ul(
              plan.grids.map((g) =>
                t("report.gridLine", {
                  title: g.folder ? gridTitle(g) : `${gridTitle(g)} ${t("report.root")}`,
                  count: g.items.length,
                }),
              ),
            )}`
          : ""
      }
      ${errors.length ? `<div class="box error"><h3>${tx("report.errors")}</h3>${ul(errors)}</div>` : ""}
      ${warnings.length ? `<div class="box warn"><h3>${tx("report.warnings")}</h3>${ul(warnings)}</div>` : ""}
      ${!errors.length && !warnings.length ? `<div class="box ok">${tx("report.ok")}</div>` : ""}
      ${table && !table.extraKeys.includes("buy_url") ? `<div class="box info">${tx("report.noBuyUrl")}</div>` : ""}
      <div class="row">
        <button id="build" class="primary"${blocking || result?.kind === "building" ? " disabled" : ""}>${tx("report.build")}</button>
      </div>
    </section>`;
}

function formatSize(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function renderResult(): string {
  if (!result) return "";
  let body = "";
  if (result.kind === "building") body = `<p class="status">${tx("result.building", { n: result.n, total: result.total })}</p>`;
  else if (result.kind === "failed") body = `<div class="box error">${tx("result.failed", { message: result.message })}</div>`;
  else {
    const src = encodeURIComponent(result.url);
    body = `
      <p class="status">${tx("result.done", { grids: result.grids, items: result.items, size: formatSize(result.bytes) })}</p>
      <div class="row">
        <a class="btn primary" href="${result.url}" download="${esc(result.fileName)}">${tx("result.download")}</a>
        <a class="btn secondary" href="../editor/?src=${src}" target="_blank" rel="noopener">${tx("result.openEditor")}</a>
        <a class="btn secondary" href="../viewer/?src=${src}" target="_blank" rel="noopener">${tx("result.openViewer")}</a>
      </div>
      <div class="previews">${result.previews.map((p) => `<img src="${p}" alt="">`).join("")}</div>`;
  }
  return `<section class="card"><h2>${tx("result.heading")}</h2>${body}</section>`;
}

// ---------- wiring ----------

function wire() {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  $<HTMLSelectElement>("lang").onchange = (e) => {
    locale = (e.target as HTMLSelectElement).value;
    saveLocale(locale);
    t = translator(locale);
    render();
  };
  $("theme").onclick = () => {
    toggleTheme();
    render();
  };

  // Plain text inputs only update state; a re-render would steal focus mid-typing.
  $<HTMLInputElement>("name").oninput = (e) => {
    settings.name = (e.target as HTMLInputElement).value;
  };
  $<HTMLInputElement>("name").onchange = () => {
    result = null;
    render();
  };
  $<HTMLSelectElement>("columns").onchange = (e) => {
    settings.columns = Number((e.target as HTMLSelectElement).value);
    replan();
    render();
  };
  $<HTMLSelectElement>("fit").onchange = (e) => {
    settings.fit = (e.target as HTMLSelectElement).value as PhotoFit;
    result = null;
    render();
  };
  $<HTMLSelectElement>("subtitle").onchange = (e) => {
    settings.subtitleKey = (e.target as HTMLSelectElement).value;
    replan();
    render();
  };
  $<HTMLInputElement>("accent").onchange = (e) => {
    settings.accent = (e.target as HTMLInputElement).value;
    result = null;
    render();
  };

  const takePhotos = (e: Event) => {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    // A folder pick lists subfolders' files too — only the folder's own photos count.
    photos = new Map(
      files
        .filter((f) => !f.webkitRelativePath || f.webkitRelativePath.split("/").length <= 2)
        .map((f) => [f.name, f]),
    );
    replan();
    render();
  };
  $<HTMLInputElement>("photo-folder").onchange = takePhotos;
  $<HTMLInputElement>("photo-files").onchange = takePhotos;

  $<HTMLInputElement>("table-file").onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    setTable(await readText(file));
  };
  const paste = $<HTMLTextAreaElement>("paste");
  paste.onchange = () => setTable(paste.value);
  // Report right after a paste, not only once the box loses focus.
  paste.onpaste = () => setTimeout(() => setTable(paste.value), 0);
  $("template").onclick = () => {
    // BOM so Excel opens the UTF-8 file with the right encoding.
    const blob = new Blob(["﻿" + templateCsv()], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "grid-composer-template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  document.getElementById("build")?.addEventListener("click", () => void actionBuild());
}

/** UTF-8 unless that produces replacement characters — then the Windows ANSI code page Excel uses for CSV. */
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  return new TextDecoder(locale === "en" ? "windows-1252" : "windows-1251").decode(buf);
}

function setTable(text: string) {
  tableText = text;
  table = text.trim() ? parseTable(text) : null;
  replan();
  render();
}

// ---------- build ----------

let lastUrl: string | null = null;
let lastPreviews: string[] = [];

async function actionBuild() {
  if (!plan || isBlocking(plan.report)) return;
  const grids = plan.grids;
  const titles = grids.map(gridTitle);
  const widestNumber = String(Math.max(...grids.flatMap((g) => g.items.map((i) => i.item.no))));
  const style = {
    columns: settings.columns,
    fit: settings.fit,
    accent: settings.accent,
    titleFont: titleFontSize(newCanvasContext(1, 1), titles),
    subtitleKey: settings.subtitleKey,
    noPhotoLabel: t("tile.noPhoto"),
    widestNumber,
  };
  const loadPhoto = async (name: string) => {
    const file = photos.get(name);
    if (!file) return null;
    try {
      return await createImageBitmap(file);
    } catch {
      return null; // undecodable (e.g. HEIC outside Safari) — drawn as "no photo"
    }
  };

  try {
    const built: BuiltGrid[] = [];
    for (let i = 0; i < grids.length; i++) {
      result = { kind: "building", n: i + 1, total: grids.length };
      render();
      built.push({ plan: grids[i]!, title: titles[i]!, rendered: await renderGrid(grids[i]!, titles[i]!, style, loadPhoto) });
    }
    const SQL = await initSqlite(wasmUrl);
    const bytes = await buildCatalog(SQL, catalogName(), built);
    // Revoked only on the next build: the Editor/Viewer tabs fetch this URL after we hand it over.
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    for (const p of lastPreviews) URL.revokeObjectURL(p);
    lastUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/x-sqlite3" }));
    result = {
      kind: "done",
      url: lastUrl,
      fileName: `${fileStem(catalogName())}.${CATALOG_FILE_EXTENSION}`,
      grids: built.length,
      items: built.reduce((n, g) => n + g.plan.items.length, 0),
      bytes: bytes.length,
      previews: (lastPreviews = built.map((g) => URL.createObjectURL(g.rendered.jpeg))),
    };
  } catch (err) {
    result = { kind: "failed", message: (err as Error).message };
  }
  render();
}

function fileStem(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "catalog";
}

applyTheme(resolveInitialTheme());
render();

// Relative path, so it resolves under whatever base Vite applied (/composer/ in production).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
