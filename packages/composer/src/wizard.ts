/**
 * The landing page's "Create your catalog in 3 simple steps" dialog: the same
 * engine as the composer (plan → renderGrid → buildCatalog), but fed from a
 * list typed right here instead of numbered files and a table. Photos become
 * items as they are dropped in; an item needs no photo at all.
 */
import "./style.css";
import "./wizard.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  appLocaleCandidates,
  applyTheme,
  CATALOG_FILE_EXTENSION,
  createTranslator,
  initSqlite,
  pickLocale,
  resolveInitialTheme,
  type MessageParams,
} from "@ecm/shared";
import { COMPOSER_LOCALES, composerMessages } from "./messages.js";
import type { ParsedTable } from "./table.js";
import { makePlan } from "./plan.js";
import { maxTilesPerGrid, newCanvasContext, renderGrid, titleFontSize } from "./render.js";
import { buildCatalog, type BuiltGrid } from "./build.js";

/** Extra key the viewer and its agent tools recognise as the price (see shared/webmcp.ts). */
const PRICE_KEY = "Price";
const PHOTO_TYPE = /^image\//;
const EMBED_BUNDLE = "https://cdn.jsdelivr.net/gh/alexandrkotov/electronic-catalog-maker@main/packages/viewer-embed/dist/ecm-viewer.js";

interface Item {
  id: number;
  file: File | null;
  thumb: string | null;
  name: string;
  price: string;
  description: string;
  link: string;
  /** Description and link are tucked away until asked for. */
  more: boolean;
}

type Step = "items" | "name" | "building" | "done" | "failed";

const locale = pickLocale(appLocaleCandidates(COMPOSER_LOCALES), COMPOSER_LOCALES);
const t = createTranslator({ messages: composerMessages[locale] ?? {}, locale, fallback: composerMessages.en });

let items: Item[] = [];
let nextId = 1;
let catalogName = "";
let step: Step = "items";
let failure = "";
let built: { url: string; fileName: string } | null = null;

const app = document.getElementById("app")!;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function tx(key: string, params?: MessageParams): string {
  return esc(t(key, params));
}

function name(): string {
  return catalogName.trim() || t("settings.nameDefault");
}

/**
 * "oak-chair_2.JPG" -> "oak chair 2": a starting name the user can overtype.
 * Camera and download names ("IMG_4012", "133859667354332876") say nothing
 * about the item, so those start empty and the placeholder asks for a name.
 */
function nameFromFile(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  const words = stem.match(/\p{L}{3,}/gu) ?? [];
  const cameraOnly = words.every((w) => /^(img|dsc|dscn|dscf|pxl|mvimg|photo|image|screenshot|whatsapp|wa)$/i.test(w));
  return cameraOnly ? "" : stem;
}

function unnamed(): number {
  return items.filter((it) => !it.name.trim()).length;
}

function addPhotos(files: Iterable<File>) {
  for (const file of files) {
    if (!PHOTO_TYPE.test(file.type)) continue;
    items.push({ id: nextId++, file, thumb: URL.createObjectURL(file), name: nameFromFile(file.name), price: "", description: "", link: "", more: false });
  }
  render();
}

function removeItem(id: number) {
  const gone = items.find((it) => it.id === id);
  if (gone?.thumb) URL.revokeObjectURL(gone.thumb);
  items = items.filter((it) => it.id !== id);
  render();
}

/** "shop.example/chair" is what people type; a link without a scheme would resolve against the viewer's own address. */
function normalLink(link: string): string {
  const trimmed = link.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// ---------- rendering ----------

function renderSteps(): string {
  const at = step === "items" ? 1 : step === "name" ? 2 : 3;
  return `<ol class="wz-progress">${["wizard.step.items", "wizard.step.name", "wizard.step.done"]
    .map((key, i) => `<li${i + 1 === at ? ' aria-current="step"' : ""}${i + 1 < at ? ' class="past"' : ""}>${tx(key)}</li>`)
    .join("")}</ol>`;
}

function renderItem(it: Item, index: number): string {
  return `
    <li class="wz-item" data-id="${it.id}">
      <div class="wz-thumb">${it.thumb ? `<img src="${it.thumb}" alt="">` : `<span>${index + 1}</span>`}</div>
      <div class="wz-fields">
        <input type="text" data-field="name" value="${esc(it.name)}" placeholder="${tx("wizard.item.name")}" aria-label="${tx("wizard.item.name")}">
        <input type="text" data-field="price" value="${esc(it.price)}" placeholder="${tx("wizard.item.price")}" aria-label="${tx("wizard.item.price")}">
        ${
          it.more
            ? `<textarea data-field="description" rows="2" placeholder="${tx("wizard.item.description")}" aria-label="${tx("wizard.item.description")}">${esc(it.description)}</textarea>
               <input type="url" data-field="link" value="${esc(it.link)}" placeholder="${tx("wizard.item.link")}" aria-label="${tx("wizard.item.link")}">`
            : `<button type="button" class="wz-link" data-act="more">${tx("wizard.item.more")}</button>`
        }
      </div>
      <button type="button" class="wz-remove" data-act="remove" aria-label="${tx("wizard.item.remove")}" title="${tx("wizard.item.remove")}">×</button>
    </li>`;
}

function renderItems(): string {
  return `
    <h1>${tx("wizard.items.title")}</h1>
    <label class="wz-drop" id="drop">
      <strong>${tx("wizard.items.drop")}</strong>
      <span>${tx("wizard.items.dropHint")}</span>
      <input id="photos" type="file" accept="image/*" multiple hidden>
    </label>
    <ul class="wz-list">${items.map(renderItem).join("")}</ul>
    <div class="row">
      <button type="button" class="btn secondary" id="add">${tx("wizard.items.addPlain")}</button>
      <button type="button" class="btn primary" id="next"${items.length ? "" : " disabled"}>${tx("wizard.next")}</button>
    </div>`;
}

function renderName(): string {
  return `
    <h1>${tx("wizard.name.title")}</h1>
    <p class="muted">${tx("wizard.name.hint", { count: items.length })}</p>
    ${unnamed() ? `<div class="box warn">${tx("wizard.name.unnamed", { count: unnamed() })}</div>` : ""}
    <input id="name" class="wz-name" type="text" value="${esc(catalogName)}" placeholder="${tx("settings.nameDefault")}" aria-label="${tx("settings.name")}">
    <div class="row">
      <button type="button" class="btn secondary" id="back">${tx("wizard.back")}</button>
      <button type="button" class="btn primary" id="build">${tx("report.build")}</button>
    </div>`;
}

function renderDone(): string {
  if (step === "building") return `<h1>${tx("wizard.building")}</h1>`;
  if (step === "failed" || !built) {
    return `<div class="box error">${tx("result.failed", { message: failure })}</div>
      <div class="row"><button type="button" class="btn secondary" id="back">${tx("wizard.back")}</button></div>`;
  }
  const src = encodeURIComponent(built.url);
  const lang = locale === "en" ? "" : `&lang=${locale}`;
  return `
    <h1>${tx("wizard.done.title")}</h1>
    <p class="muted">${tx("wizard.done.hint")}</p>
    <div class="wz-preview" id="preview"></div>
    <div class="row">
      <a class="btn primary" href="${built.url}" download="${esc(built.fileName)}">${tx("wizard.done.download")}</a>
      <a class="btn secondary" href="../viewer/?src=${src}${lang}" target="_blank" rel="noopener">${tx("wizard.done.viewer")}</a>
      <a class="btn secondary" href="../editor/?src=${src}${lang}" target="_blank" rel="noopener">${tx("wizard.done.editor")}</a>
    </div>
    <p class="muted">${tx("wizard.done.next")}</p>
    <button type="button" class="wz-link" id="back">${tx("wizard.done.change")}</button>`;
}

function render() {
  document.documentElement.lang = locale;
  app.innerHTML = `<main class="wz">${renderSteps()}${step === "items" ? renderItems() : step === "name" ? renderName() : renderDone()}</main>`;
  wire();
}

// ---------- wiring ----------

function wire() {
  const on = (id: string, type: string, fn: (e: Event) => void) => document.getElementById(id)?.addEventListener(type, fn);

  on("photos", "change", (e) => addPhotos((e.target as HTMLInputElement).files ?? []));
  const drop = document.getElementById("drop");
  if (drop) {
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add("over");
    };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => {
      e.preventDefault();
      addPhotos(e.dataTransfer?.files ?? []);
    };
  }
  on("add", "click", () => {
    items.push({ id: nextId++, file: null, thumb: null, name: "", price: "", description: "", link: "", more: false });
    render();
    document.querySelector<HTMLInputElement>(".wz-item:last-child [data-field=name]")?.focus();
  });
  on("next", "click", () => {
    step = "name";
    render();
    document.getElementById("name")?.focus();
  });
  on("back", "click", () => {
    step = step === "name" ? "items" : step === "failed" ? "name" : "items";
    render();
  });
  on("name", "input", (e) => {
    catalogName = (e.target as HTMLInputElement).value;
  });
  on("name", "keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void build();
  });
  on("build", "click", () => void build());

  document.querySelectorAll<HTMLElement>(".wz-item").forEach((row) => {
    const item = items.find((it) => it.id === Number(row.dataset.id))!;
    // Typing only updates state: a re-render would steal focus mid-word.
    row.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-field]").forEach((input) => {
      input.oninput = () => {
        item[input.dataset.field as "name" | "price" | "description" | "link"] = input.value;
      };
    });
    row.querySelector<HTMLElement>("[data-act=remove]")!.onclick = () => removeItem(item.id);
    const more = row.querySelector<HTMLElement>("[data-act=more]");
    if (more) {
      more.onclick = () => {
        item.more = true;
        render();
        document.querySelector<HTMLElement>(`.wz-item[data-id="${item.id}"] [data-field=description]`)?.focus();
      };
    }
  });

  if (step === "done" && built) showPreview(built.url);
}

/** The catalog itself, live, in the same widget the landing page demos use. */
function showPreview(url: string) {
  const box = document.getElementById("preview")!;
  const mount = () => {
    const el = document.createElement("ecm-viewer");
    el.setAttribute("mode", "showcase");
    el.setAttribute("lang", locale);
    // The first item preselected, so the details card is filled from the first paint.
    el.setAttribute("initial-image", "1");
    el.setAttribute("initial-link", "1");
    el.setAttribute("src", url);
    box.appendChild(el);
  };
  if (customElements.get("ecm-viewer")) return mount();
  const script = document.createElement("script");
  script.src = EMBED_BUNDLE;
  script.onload = mount;
  // Offline or blocked: the buttons under the preview still open the catalog.
  script.onerror = () => box.remove();
  document.head.appendChild(script);
}

// ---------- build ----------

async function build() {
  step = "building";
  render();
  try {
    const table: ParsedTable = {
      extraKeys: [PRICE_KEY, "buy_url"],
      badNumbers: [],
      items: items.map((it, i) => {
        const extra: Record<string, string> = {};
        if (it.price.trim()) extra[PRICE_KEY] = it.price.trim();
        if (normalLink(it.link)) extra.buy_url = normalLink(it.link);
        return { line: i + 1, no: i + 1, folder: "", name: it.name.trim(), sku: "", description: it.description.trim(), extra };
      }),
    };
    // The plan matches photos to rows by numbered file name, so hand it those.
    const photos = new Map<string, File>();
    items.forEach((it, i) => {
      if (it.file) photos.set(`${i + 1}.jpg`, it.file);
    });
    const columns = items.length <= 4 ? 2 : 3;
    const withPrice = items.some((it) => it.price.trim());
    const plan = makePlan(table, [...photos.keys()], maxTilesPerGrid(columns, withPrice), columns);
    const titles = plan.grids.map((g) => (g.parts > 1 ? `${name()} (${g.part}/${g.parts})` : name()));
    const style = {
      columns,
      fit: "contain" as const,
      accent: "#2563eb",
      titleFont: titleFontSize(newCanvasContext(1, 1), titles),
      subtitleKey: withPrice ? PRICE_KEY : "",
      noPhotoLabel: t("tile.noPhoto"),
      widestNumber: String(items.length),
    };
    const loadPhoto = async (key: string) => {
      const file = photos.get(key);
      if (!file) return null;
      try {
        return await createImageBitmap(file);
      } catch {
        return null; // undecodable (e.g. HEIC outside Safari) — drawn as "no photo"
      }
    };
    const grids: BuiltGrid[] = [];
    for (let i = 0; i < plan.grids.length; i++) {
      grids.push({ plan: plan.grids[i]!, title: titles[i]!, rendered: await renderGrid(plan.grids[i]!, titles[i]!, style, loadPhoto) });
    }
    const bytes = await buildCatalog(await initSqlite(wasmUrl), name(), grids);
    // Revoked only on the next build: the preview and the Editor/Viewer tabs fetch this URL.
    if (built) URL.revokeObjectURL(built.url);
    built = {
      url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/x-sqlite3" })),
      fileName: `${name().replace(/[\\/:*?"<>|]+/g, " ").trim() || "catalog"}.${CATALOG_FILE_EXTENSION}`,
    };
    step = "done";
  } catch (err) {
    failure = (err as Error).message;
    step = "failed";
  }
  render();
}

applyTheme(resolveInitialTheme());
render();
