import "./style.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  addImage,
  addLink,
  addRow,
  createEmptyCatalog,
  exportCatalog,
  initSqlite,
  listImages,
  listLinksForImage,
  listRowsForImage,
  openCatalog,
  readMeta,
  UniquenessError,
  type CatalogImage,
  type CatalogLink,
  type Database,
  type SqlJsStatic,
} from "@ecm/shared";

const app = document.getElementById("app")!;

let SQL: SqlJsStatic;
let db: Database | null = null;
let activeImageId: number | null = null;
let pendingHotspot: { top: number; left: number } | null = null;
let statusMessage = "";

async function boot() {
  app.innerHTML = `<p style="padding:1rem">Загружаю SQLite (sql.js)…</p>`;
  SQL = await initSqlite(wasmUrl);
  render();
}

function currentImages(): CatalogImage[] {
  return db ? listImages(db) : [];
}

function setStatus(message: string) {
  statusMessage = message;
  render();
}

// ---------- actions ----------

function actionNewCatalog() {
  const name = prompt("Название нового каталога:", "Untitled catalog");
  if (name === null) return;
  db = createEmptyCatalog(SQL, name || "Untitled catalog");
  activeImageId = null;
  pendingHotspot = null;
  setStatus(`Создан новый каталог «${name}».`);
}

async function actionOpenCatalog(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    db = openCatalog(SQL, bytes);
    const meta = readMeta(db);
    activeImageId = currentImages()[0]?.id ?? null;
    pendingHotspot = null;
    setStatus(`Открыт каталог «${meta.catalogName}».`);
  } catch (err) {
    setStatus(`Не удалось открыть файл: ${(err as Error).message}`);
  }
}

function actionExportCatalog() {
  if (!db) return;
  const bytes = exportCatalog(db);
  const blob = new Blob([bytes as BlobPart], { type: "application/x-sqlite3" });
  const meta = readMeta(db);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${meta.catalogName.replace(/[^\w\-]+/g, "_") || "catalog"}.sqlite`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function actionAddImage(file: File) {
  if (!db) return;
  const dataUrl = await fileToDataUrl(file);
  const [, mimeType, base64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/s) ?? [];
  if (!base64) {
    setStatus("Не удалось прочитать изображение.");
    return;
  }
  const { width, height } = await imageDimensions(dataUrl);
  const id = addImage(db, {
    name: file.name,
    mimeType: mimeType ?? file.type,
    imageData: base64,
    width,
    height,
    sortOrder: currentImages().length,
  });
  activeImageId = id;
  pendingHotspot = null;
  setStatus(`Добавлена картинка «${file.name}».`);
}

function actionSelectImage(id: number) {
  activeImageId = id;
  pendingHotspot = null;
  render();
}

function actionStageClick(evt: MouseEvent, img: HTMLImageElement) {
  const rect = img.getBoundingClientRect();
  const left = Math.round(evt.clientX - rect.left);
  const top = Math.round(evt.clientY - rect.top);
  pendingHotspot = { top, left };
  render();
}

function actionAddLink(name: string, url: string) {
  if (!db || activeImageId === null || !pendingHotspot) return;
  try {
    addLink(db, {
      imageId: activeImageId,
      name,
      url,
      top: pendingHotspot.top,
      left: pendingHotspot.left,
    });
    pendingHotspot = null;
    setStatus(`Ссылка «${name}» добавлена.`);
  } catch (err) {
    if (err instanceof UniquenessError) {
      setStatus(`Ошибка: ${err.message}`);
    } else {
      throw err;
    }
  }
}

function actionAddRow(url: string, name: string, sku: string, description: string, extraText: string) {
  if (!db || activeImageId === null) return;
  let extra: Record<string, string> = {};
  if (extraText.trim()) {
    try {
      extra = JSON.parse(extraText);
    } catch {
      setStatus("Поле «доп. характеристики» должно быть валидным JSON-объектом.");
      return;
    }
  }
  addRow(db, { imageId: activeImageId, url, name, sku, description, extra });
  setStatus(`Строка для «${url}» добавлена.`);
}

// ---------- helpers ----------

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- render ----------

function render() {
  const images = currentImages();
  const activeImage = images.find((i) => i.id === activeImageId) ?? null;
  const links = db && activeImage ? listLinksForImage(db, activeImage.id) : [];
  const rows = db && activeImage ? listRowsForImage(db, activeImage.id) : [];
  const usedUrls = new Set(rows.map((r) => r.url));
  const availableLinks = links.filter((l) => !usedUrls.has(l.url));

  app.innerHTML = `
    <div class="toolbar">
      <h1>Electronic Catalog Maker — редактор</h1>
      <button id="btn-new">Новый каталог</button>
      <button id="btn-open">Открыть каталог…</button>
      <input type="file" id="file-open" accept=".sqlite,.db" style="display:none" />
      <button id="btn-export" ${db ? "" : "disabled"}>Экспорт .sqlite</button>
      <button id="btn-add-image" ${db ? "" : "disabled"}>Добавить картинку…</button>
      <input type="file" id="file-image" accept="image/*" style="display:none" />
      <span class="spacer"></span>
      <span class="hint">${escapeHtml(statusMessage)}</span>
    </div>

    <div class="panel-images">
      ${
        images.length === 0
          ? `<p class="hint">${db ? "В каталоге пока нет картинок." : "Создайте или откройте каталог."}</p>`
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
          ? `<div class="stage-inner" id="stage-inner">
               <img id="stage-img" src="data:${activeImage.mimeType};base64,${activeImage.imageData}" width="${activeImage.width}" height="${activeImage.height}" />
               ${links.map((l) => hotspotHtml(l)).join("")}
               ${pendingHotspot ? `<div class="hotspot pending" style="top:${pendingHotspot.top}px;left:${pendingHotspot.left}px">новая…</div>` : ""}
             </div>`
          : `<p class="hint" style="padding:2rem">Выберите картинку слева, либо добавьте новую.</p>`
      }
    </div>

    <div class="inspector">
      ${activeImage ? renderLinkForm() : ""}
      ${activeImage ? renderLinksSection(links) : ""}
      ${activeImage ? renderRowForm(availableLinks) : ""}
      ${activeImage ? renderRowsSection(rows) : ""}
    </div>
  `;

  wireEvents(activeImage);
}

function hotspotHtml(l: CatalogLink): string {
  return `<div class="hotspot" style="top:${l.top}px;left:${l.left}px" title="${escapeHtml(l.url)}">${escapeHtml(l.name)}</div>`;
}

function renderLinkForm(): string {
  return `
    <section>
      <h2>Новая ссылка (хотспот)</h2>
      ${
        pendingHotspot
          ? `<p class="hint">Позиция: top=${pendingHotspot.top}, left=${pendingHotspot.left}</p>
             <form id="form-link">
               <div class="field"><label>Имя ссылки</label><input name="name" required /></div>
               <div class="field"><label>Адрес (url), уникален по всему каталогу</label><input name="url" required /></div>
               <button type="submit" class="primary">Добавить ссылку</button>
             </form>`
          : `<p class="hint">Кликните по картинке, чтобы поставить хотспот.</p>`
      }
    </section>
  `;
}

function renderLinksSection(links: CatalogLink[]): string {
  return `
    <section>
      <h2>Ссылки на этой картинке (${links.length})</h2>
      <table>
        <thead><tr><th>Имя</th><th>URL</th></tr></thead>
        <tbody>
          ${links.map((l) => `<tr><td>${escapeHtml(l.name)}</td><td>${escapeHtml(l.url)}</td></tr>`).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function renderRowForm(availableLinks: CatalogLink[]): string {
  return `
    <section>
      <h2>Новая строка таблицы</h2>
      ${
        availableLinks.length === 0
          ? `<p class="hint">Сначала добавьте ссылку без строки данных.</p>`
          : `<form id="form-row">
               <div class="field"><label>URL (совпадает со ссылкой)</label>
                 <select name="url">${availableLinks.map((l) => `<option value="${escapeHtml(l.url)}">${escapeHtml(l.url)} (${escapeHtml(l.name)})</option>`).join("")}</select>
               </div>
               <div class="field"><label>Название</label><input name="name" /></div>
               <div class="field"><label>Артикул</label><input name="sku" /></div>
               <div class="field"><label>Описание</label><input name="description" /></div>
               <div class="field"><label>Доп. характеристики (JSON)</label><textarea name="extra" rows="3" placeholder='{"вес": "2.3 кг"}'></textarea></div>
               <button type="submit" class="primary">Добавить строку</button>
             </form>`
      }
    </section>
  `;
}

function renderRowsSection(rows: ReturnType<typeof listRowsForImage>): string {
  return `
    <section>
      <h2>Таблица (${rows.length} строк)</h2>
      <table>
        <thead><tr><th>URL</th><th>Название</th><th>Артикул</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr><td>${escapeHtml(r.url)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.sku)}</td></tr>`).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function wireEvents(activeImage: CatalogImage | null) {
  document.getElementById("btn-new")?.addEventListener("click", actionNewCatalog);

  const fileOpen = document.getElementById("file-open") as HTMLInputElement;
  document.getElementById("btn-open")?.addEventListener("click", () => fileOpen.click());
  fileOpen.addEventListener("change", () => {
    const file = fileOpen.files?.[0];
    if (file) void actionOpenCatalog(file);
  });

  document.getElementById("btn-export")?.addEventListener("click", actionExportCatalog);

  const fileImage = document.getElementById("file-image") as HTMLInputElement;
  document.getElementById("btn-add-image")?.addEventListener("click", () => fileImage.click());
  fileImage.addEventListener("change", () => {
    const file = fileImage.files?.[0];
    if (file) void actionAddImage(file);
  });

  document.querySelectorAll<HTMLLIElement>(".panel-images li[data-id]").forEach((li) => {
    li.addEventListener("click", () => actionSelectImage(Number(li.dataset.id)));
  });

  const stageImg = document.getElementById("stage-img") as HTMLImageElement | null;
  stageImg?.addEventListener("click", (evt) => actionStageClick(evt, stageImg));

  document.getElementById("form-link")?.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const fd = new FormData(evt.target as HTMLFormElement);
    actionAddLink(String(fd.get("name") ?? ""), String(fd.get("url") ?? ""));
  });

  document.getElementById("form-row")?.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const fd = new FormData(evt.target as HTMLFormElement);
    actionAddRow(
      String(fd.get("url") ?? ""),
      String(fd.get("name") ?? ""),
      String(fd.get("sku") ?? ""),
      String(fd.get("description") ?? ""),
      String(fd.get("extra") ?? ""),
    );
  });

  void activeImage; // reserved for future per-image controls
}

void boot();
