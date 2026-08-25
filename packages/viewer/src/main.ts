import "./style.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  findRowByUrl,
  initSqlite,
  listImages,
  listLinksForImage,
  listRowsForImage,
  openCatalog,
  readMeta,
  type CatalogLink,
  type CatalogRow,
  type Database,
  type SqlJsStatic,
} from "@ecm/shared";

const app = document.getElementById("app")!;

let SQL: SqlJsStatic;
let db: Database | null = null;
let catalogLabel = "";
let activeImageId: number | null = null;
let selectedUrl: string | null = null;
let statusMessage = "";

async function boot() {
  app.innerHTML = `<p style="padding:1rem">Загружаю SQLite (sql.js)…</p>`;
  SQL = await initSqlite(wasmUrl);

  const params = new URLSearchParams(location.search);
  const src = params.get("src");
  if (src) {
    await loadFromUrl(src);
  } else {
    render();
  }
}

async function loadFromUrl(url: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    openBytes(bytes);
  } catch (err) {
    statusMessage = `Не удалось загрузить «${url}»: ${(err as Error).message}`;
    render();
  }
}

function openBytes(bytes: Uint8Array) {
  db = openCatalog(SQL, bytes);
  const meta = readMeta(db);
  catalogLabel = meta.catalogName;
  activeImageId = listImages(db)[0]?.id ?? null;
  selectedUrl = null;
  statusMessage = `Открыт каталог «${meta.catalogName}».`;
  render();
}

async function actionOpenFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    openBytes(bytes);
  } catch (err) {
    statusMessage = `Не удалось открыть файл: ${(err as Error).message}`;
    render();
  }
}

function actionSelectImage(id: number) {
  activeImageId = id;
  selectedUrl = null;
  render();
}

function actionSelectLink(url: string) {
  selectedUrl = url;
  render();
  document.querySelector(`tr[data-url="${cssEscape(url)}"]`)?.scrollIntoView({ block: "nearest" });
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function render() {
  const images = db ? listImages(db) : [];
  const activeImage = images.find((i) => i.id === activeImageId) ?? null;
  const links = db && activeImage ? listLinksForImage(db, activeImage.id) : [];
  const rows = db && activeImage ? listRowsForImage(db, activeImage.id) : [];

  app.innerHTML = `
    <div class="toolbar">
      <h1>Electronic Catalog Maker — просмотрщик</h1>
      <button id="btn-open">Открыть каталог…</button>
      <input type="file" id="file-open" accept=".sqlite,.db" style="display:none" />
      <span class="spacer"></span>
      <span class="hint">${escapeHtml(catalogLabel)} ${escapeHtml(statusMessage)}</span>
    </div>

    <div class="panel-images">
      ${
        images.length === 0
          ? `<p class="hint">Откройте .sqlite-файл каталога.</p>`
          : `<ul>${images
              .map(
                (img) =>
                  `<li data-id="${img.id}" class="${img.id === activeImageId ? "active" : ""}">${escapeHtml(img.name)}</li>`,
              )
              .join("")}</ul>`
      }
    </div>

    <div class="stage">
      ${
        activeImage
          ? `<div class="stage-inner">
               <img src="data:${activeImage.mimeType};base64,${activeImage.imageData}" width="${activeImage.width}" height="${activeImage.height}" />
               ${links.map((l) => hotspotHtml(l)).join("")}
             </div>`
          : `<p class="hint" style="padding:2rem">Нет выбранной картинки.</p>`
      }
    </div>

    <div class="table-panel">
      ${
        activeImage
          ? `<table>
               <thead><tr><th>Название</th><th>Артикул</th><th>Описание</th><th>Доп.</th></tr></thead>
               <tbody>${rows.map((r) => rowHtml(r)).join("")}</tbody>
             </table>`
          : ""
      }
    </div>
  `;

  wireEvents();
}

function hotspotHtml(l: CatalogLink): string {
  const selected = l.url === selectedUrl ? "selected" : "";
  return `<div class="hotspot ${selected}" style="top:${l.top}px;left:${l.left}px;font-size:${l.fontSize}px" data-url="${escapeHtml(l.url)}" title="${escapeHtml(l.url)}">${escapeHtml(l.name)}</div>`;
}

function rowHtml(r: CatalogRow): string {
  const selected = r.url === selectedUrl ? "selected" : "";
  const extra = Object.entries(r.extra)
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`)
    .join(", ");
  return `<tr data-url="${escapeHtml(r.url)}" class="${selected}"><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.sku)}</td><td>${escapeHtml(r.description)}</td><td>${extra}</td></tr>`;
}

function wireEvents() {
  const fileOpen = document.getElementById("file-open") as HTMLInputElement;
  document.getElementById("btn-open")?.addEventListener("click", () => fileOpen.click());
  fileOpen.addEventListener("change", () => {
    const file = fileOpen.files?.[0];
    if (file) void actionOpenFile(file);
  });

  document.querySelectorAll<HTMLLIElement>(".panel-images li[data-id]").forEach((li) => {
    li.addEventListener("click", () => actionSelectImage(Number(li.dataset.id)));
  });

  document.querySelectorAll<HTMLDivElement>(".hotspot[data-url]").forEach((el) => {
    el.addEventListener("click", () => actionSelectLink(el.dataset.url!));
  });

  document.querySelectorAll<HTMLTableRowElement>("tr[data-url]").forEach((tr) => {
    tr.addEventListener("click", () => actionSelectLink(tr.dataset.url!));
  });

  void findRowByUrl; // used indirectly via listRowsForImage today; kept for future direct-lookup use
}

void boot();
