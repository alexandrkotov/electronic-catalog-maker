import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import maplibregl from "maplibre-gl";
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
import { MAP_COMPOSER_LOCALES, MAP_COMPOSER_LOCALE_NAMES, mapComposerMessages } from "./messages.js";
import {
  fileStem,
  isInside,
  labelFontSize,
  mapMeta,
  mapPixelRatio,
  pointLabel,
  previewFontSize,
  toImagePixels,
  type ImageSize,
  type LabelKind,
  type LabelSize,
  type MapPoint,
} from "./geo.js";
import { renderMap, renderPhoto, renderPlaceholder, type RenderedImage } from "./render.js";
import { buildCatalog, type BuiltPoint } from "./build.js";
import { searchPlaces, type Place } from "./search.js";

// ---------- state ----------

const STYLES = ["liberty", "bright", "positron"] as const;
type MapStyle = (typeof STYLES)[number];
/** Width / height of the exported picture. */
const SHAPES = { wide: 3 / 2, classic: 4 / 3, square: 1, tall: 3 / 4 } as const;
type Shape = keyof typeof SHAPES;

const ACCENT = "#2563eb";
const VIEW_KEY = "ecm-map-composer-view";

let locale = pickLocale(appLocaleCandidates(MAP_COMPOSER_LOCALES), MAP_COMPOSER_LOCALES);
let t = translator(locale);

const settings = {
  name: "",
  style: "liberty" as MapStyle,
  shape: "wide" as Shape,
  labelKind: "name" as LabelKind,
  labelSize: "medium" as LabelSize,
};

interface Point extends MapPoint {
  photo: File | null;
  thumbUrl: string | null;
  marker: maplibregl.Marker;
}
let points: Point[] = [];
let nextPointId = 1;

type Search = { kind: "searching" } | { kind: "done"; places: Place[] } | { kind: "failed"; message: string };
let search: Search | null = null;
let searchQuery = "";

type Result =
  | { kind: "building" }
  | { kind: "done"; url: string; fileName: string; points: number; bytes: number; previews: string[]; skipped: string[]; badPhotos: string[] }
  | { kind: "failed"; message: string };
let result: Result | null = null;

function translator(loc: string) {
  return createTranslator({ messages: mapComposerMessages[loc] ?? {}, locale: loc, fallback: mapComposerMessages.en });
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

function styleUrl(style: MapStyle): string {
  return `https://tiles.openfreemap.org/styles/${style}`;
}

// ---------- map ----------

// Lives outside the re-rendered markup: a language or theme switch rebuilds
// the page around it and puts this same element back.
const mapEl = document.createElement("div");
mapEl.className = "map";

function savedView(): { center: [number, number]; zoom: number } {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as { center?: unknown; zoom?: unknown } | null;
    if (v && Array.isArray(v.center) && v.center.length === 2 && v.center.every(Number.isFinite) && Number.isFinite(v.zoom)) {
      return { center: v.center as [number, number], zoom: v.zoom as number };
    }
  } catch {
    // no storage (private mode) or a stale value — start from the world view
  }
  return { center: [10, 30], zoom: 1.4 };
}

/** The map needs WebGL; without it there is nothing to compose, so the page says so instead of staying blank. */
function createMap(): maplibregl.Map {
  try {
    return new maplibregl.Map({
      container: mapEl,
      style: styleUrl(settings.style),
      ...savedView(),
      // Set from the map's own width (see mapPixelRatio), so the picture doesn't depend on the device.
      pixelRatio: mapPixelRatio(0),
      // Lets the finished frame be read back from the canvas at export time.
      canvasContextAttributes: { preserveDrawingBuffer: true },
      // North-up and flat only: the picture is described by a plain bbox.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
    });
  } catch (err) {
    document.getElementById("app")!.innerHTML = `<main><div class="box error">${tx("map.unsupported")}</div></main>`;
    throw err;
  }
}

const map = createMap();
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

function containerSize(): ImageSize {
  return { width: mapEl.clientWidth, height: mapEl.clientHeight };
}

function canvasSize(): ImageSize {
  const canvas = map.getCanvas();
  return { width: canvas.width, height: canvas.height };
}

function insideMap(p: MapPoint): boolean {
  return isInside(map.project([p.lng, p.lat]), containerSize());
}

/** Markers look like the viewer's hotspots at the size they'll have on the picture. */
function syncMarkers() {
  const container = containerSize();
  const image = canvasSize();
  const cssFont = previewFontSize(labelFontSize(image.width, settings.labelSize), container.width, image.width);
  points.forEach((p, i) => {
    const el = p.marker.getElement();
    el.textContent = pointLabel(p, i + 1, settings.labelKind);
    el.style.fontSize = `${cssFont}px`;
  });
}

function addPoint(lng: number, lat: number, name?: string): Point {
  const el = document.createElement("div");
  el.className = "point-marker";
  const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: "center" }).setLngLat([lng, lat]).addTo(map);
  const point: Point = { id: nextPointId++, name: name ?? t("points.defaultName", { n: points.length + 1 }), lng, lat, photo: null, thumbUrl: null, marker };
  marker.on("dragend", () => {
    const at = marker.getLngLat();
    point.lng = at.lng;
    point.lat = at.lat;
    changed();
  });
  el.addEventListener("click", (e) => {
    // A click on a marker selects its row; it must not add a second point under it.
    e.stopPropagation();
    focusPoint(point.id);
  });
  points.push(point);
  changed();
  focusPoint(point.id);
  return point;
}

/**
 * Puts the caret into a point's name without scrolling to its row: the map
 * stays in place for the next click, and the marker shows the name as typed.
 */
function focusPoint(id: number) {
  const input = document.querySelector<HTMLInputElement>(`.point[data-id="${id}"] input[type="text"]`);
  input?.focus({ preventScroll: true });
  input?.select();
}

function setPhoto(point: Point, file: File | null) {
  if (point.thumbUrl) URL.revokeObjectURL(point.thumbUrl);
  point.photo = file;
  point.thumbUrl = file ? URL.createObjectURL(file) : null;
  changed();
}

/** Points or their look changed: any finished catalog is out of date. */
function changed() {
  result = null;
  syncMarkers();
  renderPoints();
  renderResult();
}

map.on("click", (e) => addPoint(e.lngLat.lng, e.lngLat.lat));
/** Ids of the points the current view leaves outside the picture — the list marks them, the build skips them. */
function outsideKey(): string {
  return points
    .filter((p) => !insideMap(p))
    .map((p) => p.id)
    .join(",");
}
let shownOutside = "";

// "move" rather than "moveend": the list follows the map while it is dragged,
// and is rebuilt only when a point actually crosses the picture's edge.
map.on("move", () => {
  if (outsideKey() === shownOutside) return;
  if (result?.kind !== "building") result = null;
  renderPoints();
  renderResult();
});
map.on("idle", () => {
  try {
    const c = map.getCenter();
    localStorage.setItem(VIEW_KEY, JSON.stringify({ center: [c.lng, c.lat], zoom: map.getZoom() }));
  } catch {
    // see savedView()
  }
});
map.on("resize", () => {
  const ratio = mapPixelRatio(mapEl.clientWidth);
  // setPixelRatio resizes the canvas, which fires "resize" again — hence the guard.
  if (ratio !== map.getPixelRatio()) map.setPixelRatio(ratio);
  syncMarkers();
});

// ---------- rendering ----------

const app = document.getElementById("app")!;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function options<T extends string>(values: readonly T[], selected: T, label: (v: T) => string): string {
  return values.map((v) => `<option value="${v}"${v === selected ? " selected" : ""}>${esc(label(v))}</option>`).join("");
}

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
          ${MAP_COMPOSER_LOCALES.map((l) => `<option value="${l}"${l === locale ? " selected" : ""}>${MAP_COMPOSER_LOCALE_NAMES[l]}</option>`).join("")}
        </select>
        <button id="theme" class="neutral" title="${tx("theme.toggle")}">${currentTheme() === "dark" ? tx("theme.light") : tx("theme.dark")}</button>
      </div>
    </header>
    <main>
      <section class="card">
        <h2>${tx("settings.heading")}</h2>
        <div class="form">
          <label>${tx("settings.name")}
            <input id="name" type="text" value="${esc(settings.name)}" placeholder="${tx("settings.nameDefault")}">
          </label>
          <label>${tx("settings.style")}
            <select id="style">${options(STYLES, settings.style, (v) => t(`settings.style.${v}`))}</select>
          </label>
          <label>${tx("settings.shape")}
            <select id="shape">${options(Object.keys(SHAPES) as Shape[], settings.shape, (v) => t(`settings.shape.${v}`))}</select>
          </label>
          <label>${tx("settings.label")}
            <select id="label-kind">${options(["name", "number"] as const, settings.labelKind, (v) => t(`settings.label.${v}`))}</select>
          </label>
          <label>${tx("settings.labelSize")}
            <select id="label-size">${options(["small", "medium", "large"] as const, settings.labelSize, (v) => t(`settings.labelSize.${v}`))}</select>
          </label>
        </div>
      </section>
      <section class="card">
        <h2>${tx("map.heading")}</h2>
        <p class="muted">${tx("map.hint")}</p>
        <form id="search" class="row search">
          <input id="search-q" type="text" value="${esc(searchQuery)}" placeholder="${tx("search.placeholder")}" autocomplete="off">
          <button class="secondary">${tx("search.button")}</button>
        </form>
        <div id="search-results"></div>
        <div id="map-slot" class="map-slot"></div>
      </section>
      <section class="card">
        <h2>${tx("points.heading")}</h2>
        <p class="muted">${tx("points.photoHint")}</p>
        <div id="points"></div>
      </section>
      <section class="card">
        <h2>${tx("result.heading")}</h2>
        <div id="result"></div>
      </section>
    </main>`;
  const slot = $("map-slot");
  slot.style.setProperty("--shape", String(SHAPES[settings.shape]));
  slot.appendChild(mapEl);
  map.resize();
  wire();
  renderSearch();
  renderPoints();
  renderResult();
}

function renderSearch() {
  const box = $("search-results");
  if (!search) box.innerHTML = "";
  else if (search.kind === "searching") box.innerHTML = `<p class="status">${tx("search.searching")}</p>`;
  else if (search.kind === "failed") box.innerHTML = `<div class="box error">${tx("search.failed", { message: search.message })}</div>`;
  else if (!search.places.length) box.innerHTML = `<p class="status">${tx("search.none")}</p>`;
  else {
    box.innerHTML = `
      <ul class="places">${search.places
        .map(
          (p, i) => `
          <li>
            <button class="place link" data-i="${i}">${esc(p.label)}</button>
            <button class="place-add secondary" data-i="${i}">${tx("search.addPoint")}</button>
          </li>`,
        )
        .join("")}</ul>
      <p class="status small">${tx("search.credit")}</p>`;
    const places = search.places;
    box.querySelectorAll<HTMLButtonElement>(".place").forEach((b) => (b.onclick = () => showPlace(places[Number(b.dataset.i)]!)));
    box.querySelectorAll<HTMLButtonElement>(".place-add").forEach(
      (b) =>
        (b.onclick = () => {
          const place = places[Number(b.dataset.i)]!;
          // Only move the map if the place isn't on it already — the user may have framed the area.
          if (!isInside(map.project([place.lng, place.lat]), containerSize())) map.jumpTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 14) });
          addPoint(place.lng, place.lat, place.name);
        }),
    );
  }
}

function showPlace(place: Place) {
  if (place.bounds) {
    const [west, south, east, north] = place.bounds;
    map.fitBounds([west, south, east, north], { padding: 30, maxZoom: 16, duration: 600 });
  } else map.flyTo({ center: [place.lng, place.lat], zoom: 15, duration: 600 });
}

function renderPoints() {
  const box = document.getElementById("points");
  if (!box) return;
  // Typing a name re-labels the marker only; rebuilding the list would drop the caret.
  const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".point")?.dataset.id;
  shownOutside = outsideKey();
  if (!points.length) {
    box.innerHTML = `<p class="status">${tx("points.none")}</p>`;
    return;
  }
  box.innerHTML = `<ol class="points">${points
    .map((p, i) => {
      const outside = !insideMap(p);
      return `
      <li class="point${outside ? " outside" : ""}" data-id="${p.id}">
        <span class="point-no">${i + 1}</span>
        <input type="text" value="${esc(p.name)}" aria-label="${tx("points.name")}">
        ${p.thumbUrl ? `<img class="thumb" src="${p.thumbUrl}" alt="">` : `<span class="thumb empty">${tx("points.noPhoto")}</span>`}
        <label class="btn secondary">${tx(p.photo ? "points.photoChange" : "points.photo")}<input type="file" accept="image/*" hidden></label>
        ${p.photo ? `<button class="neutral" data-act="unphoto" title="${tx("points.photoRemove")}">✕</button>` : ""}
        <button class="neutral" data-act="show" title="${tx("points.show")}">◎</button>
        <button class="neutral" data-act="delete" title="${tx("points.delete")}">🗑</button>
        ${outside ? `<span class="point-note">${tx("points.outside")}</span>` : ""}
      </li>`;
    })
    .join("")}</ol>`;

  box.querySelectorAll<HTMLElement>(".point").forEach((row) => {
    const point = points.find((p) => p.id === Number(row.dataset.id))!;
    const name = row.querySelector<HTMLInputElement>('input[type="text"]')!;
    name.oninput = () => {
      point.name = name.value;
      result = null;
      syncMarkers();
      renderResult();
    };
    row.querySelector<HTMLInputElement>('input[type="file"]')!.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) setPhoto(point, file);
    };
    row.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => {
      b.onclick = () => {
        if (b.dataset.act === "unphoto") setPhoto(point, null);
        else if (b.dataset.act === "show") map.flyTo({ center: [point.lng, point.lat], zoom: Math.max(map.getZoom(), 13), duration: 600 });
        else {
          point.marker.remove();
          if (point.thumbUrl) URL.revokeObjectURL(point.thumbUrl);
          points = points.filter((p) => p !== point);
          changed();
        }
      };
    });
    row.ondragover = (e) => {
      e.preventDefault();
      row.classList.add("drop");
    };
    row.ondragleave = () => row.classList.remove("drop");
    row.ondrop = (e) => {
      e.preventDefault();
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) setPhoto(point, file);
      else row.classList.remove("drop");
    };
  });
  if (focusedId) box.querySelector<HTMLInputElement>(`.point[data-id="${focusedId}"] input[type="text"]`)?.focus({ preventScroll: true });
}

function formatSize(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function renderResult() {
  const box = document.getElementById("result");
  if (!box) return;
  const ready = points.some(insideMap);
  let body = `
    ${ready ? "" : `<p class="status">${tx("result.needPoints")}</p>`}
    <div class="row">
      <button id="build" class="primary"${!ready || result?.kind === "building" ? " disabled" : ""}>${tx("result.build")}</button>
    </div>`;
  if (result?.kind === "building") body += `<p class="status">${tx("result.building")}</p>`;
  else if (result?.kind === "failed") body += `<div class="box error">${tx("result.failed", { message: result.message })}</div>`;
  else if (result?.kind === "done") {
    const src = encodeURIComponent(result.url);
    body += `
      <p class="status">${tx("result.done", { points: result.points, size: formatSize(result.bytes) })}</p>
      ${result.skipped.length ? `<div class="box warn">${tx("result.skipped", { list: result.skipped.join(", ") })}</div>` : ""}
      ${result.badPhotos.length ? `<div class="box warn">${tx("result.badPhotos", { list: result.badPhotos.join(", ") })}</div>` : ""}
      <div class="row">
        <a class="btn primary" href="${result.url}" download="${esc(result.fileName)}">${tx("result.download")}</a>
        <a class="btn secondary" href="../editor/?src=${src}" target="_blank" rel="noopener">${tx("result.openEditor")}</a>
        <a class="btn secondary" href="../viewer/?src=${src}" target="_blank" rel="noopener">${tx("result.openViewer")}</a>
      </div>
      <div class="previews">${result.previews.map((p) => `<img src="${p}" alt="">`).join("")}</div>`;
  }
  box.innerHTML = body;
  document.getElementById("build")?.addEventListener("click", () => void actionBuild());
}

// ---------- wiring ----------

function wire() {
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

  $<HTMLInputElement>("name").oninput = (e) => {
    settings.name = (e.target as HTMLInputElement).value;
    if (result?.kind !== "building") result = null;
    renderResult();
  };
  $<HTMLSelectElement>("style").onchange = (e) => {
    settings.style = (e.target as HTMLSelectElement).value as MapStyle;
    map.setStyle(styleUrl(settings.style));
    changed();
  };
  $<HTMLSelectElement>("shape").onchange = (e) => {
    settings.shape = (e.target as HTMLSelectElement).value as Shape;
    $("map-slot").style.setProperty("--shape", String(SHAPES[settings.shape]));
    map.resize();
    changed();
  };
  $<HTMLSelectElement>("label-kind").onchange = (e) => {
    settings.labelKind = (e.target as HTMLSelectElement).value as LabelKind;
    changed();
  };
  $<HTMLSelectElement>("label-size").onchange = (e) => {
    settings.labelSize = (e.target as HTMLSelectElement).value as LabelSize;
    changed();
  };

  const q = $<HTMLInputElement>("search-q");
  q.oninput = () => {
    searchQuery = q.value;
  };
  // A submit only (Enter or the button): Nominatim's policy rules out search-as-you-type.
  $<HTMLFormElement>("search").onsubmit = (e) => {
    e.preventDefault();
    void actionSearch();
  };
}

async function actionSearch() {
  const query = searchQuery.trim();
  if (!query || search?.kind === "searching") return;
  search = { kind: "searching" };
  renderSearch();
  try {
    search = { kind: "done", places: await searchPlaces(query, locale) };
  } catch (err) {
    search = { kind: "failed", message: (err as Error).message };
  }
  renderSearch();
}

// ---------- build ----------

let lastUrl: string | null = null;
let lastPreviews: string[] = [];

/** Resolves once every tile and label of the current view is drawn (or after a wait, on a stalled network). */
function mapSettled(): Promise<void> {
  if (map.loaded() && !map.isMoving()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 15000);
    map.once("idle", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function actionBuild() {
  if (result?.kind === "building") return;
  result = { kind: "building" };
  renderResult();
  try {
    await mapSettled();
    const container = containerSize();
    const mapImage = await renderMap(map.getCanvas());
    const bounds = map.getBounds();
    const center = map.getCenter();

    const built: BuiltPoint[] = [];
    const skipped: string[] = [];
    const badPhotos: string[] = [];
    const pages: RenderedImage[] = [];
    for (const [i, point] of points.entries()) {
      const label = pointLabel(point, i + 1, settings.labelKind);
      const pos = map.project([point.lng, point.lat]);
      if (!isInside(pos, container)) {
        skipped.push(point.name.trim() || label);
        continue;
      }
      let page = point.photo ? await renderPhoto(point.photo) : null;
      if (point.photo && !page) badPhotos.push(point.name.trim() || label);
      page ??= await renderPlaceholder(point.name.trim() || label, t("page.placeholderHint"), ACCENT);
      pages.push(page);
      built.push({ point, label, ...toImagePixels(pos, container, mapImage), page });
    }

    const SQL = await initSqlite(wasmUrl);
    const bytes = await buildCatalog(SQL, {
      catalogName: catalogName(),
      map: mapImage,
      mapMeta: mapMeta({
        style: settings.style,
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
        centerLng: center.lng,
        centerLat: center.lat,
        zoom: map.getZoom(),
        image: mapImage,
      }),
      labelFont: labelFontSize(mapImage.width, settings.labelSize),
      points: built,
    });
    // Revoked only on the next build: the Editor/Viewer tabs fetch this URL after we hand it over.
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    for (const p of lastPreviews) URL.revokeObjectURL(p);
    lastUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/x-sqlite3" }));
    result = {
      kind: "done",
      url: lastUrl,
      fileName: `${fileStem(catalogName())}.${CATALOG_FILE_EXTENSION}`,
      points: built.length,
      bytes: bytes.length,
      previews: (lastPreviews = [mapImage, ...pages].map((img) => URL.createObjectURL(img.blob))),
      skipped,
      badPhotos,
    };
  } catch (err) {
    result = { kind: "failed", message: (err as Error).message };
  }
  renderResult();
}

applyTheme(resolveInitialTheme());
render();

// Relative path, so it resolves under whatever base Vite applied (/map-composer/ in production).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
