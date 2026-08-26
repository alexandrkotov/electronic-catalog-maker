import type { Database, SqlJsStatic } from "sql.js";
import { addImage, addLink, addRow, createEmptyCatalog } from "./db.js";

/**
 * Read-only import of the previous generation's `.sch` catalog format (a
 * SQLite database in its own right, from the desktop app this project
 * continues — see project memory for the full lineage). Confirmed against
 * real fixture files: every `.sch` file shares the same four tables
 * regardless of product (the table is literally named `gearbox` even in an
 * AXLE.sch or BATTERY.sch — evidently cloned from an early template and
 * never renamed):
 *
 * - `gearbox`   — one row per exploded-view diagram (num, brandname,
 *                 series, specification, gearboxgroup, ...). Becomes one
 *                 `images` row; `gearboxgroup` maps onto our `images.folder`.
 * - `infobase`  — one row per `gearbox.num`, with `html` (the diagram page:
 *                 one `<img src="data:image/jpg;base64,...">` plus one
 *                 `<a href="#N" style="position:absolute;top:...;left:...">`
 *                 per hotspot — N is not zero-padded consistently, so it's
 *                 parsed as an integer, not matched as a string) and `jpg`
 *                 (a separate, differently-sized preview image — NOT used
 *                 here, since hotspot coordinates are only valid against the
 *                 exact image embedded in `html`).
 * - `linktable` — the parts data, one row per (num, fig) *or more*: a fig
 *                 can have several rows (alternate/superseding part
 *                 numbers for the same position) — the primary one becomes
 *                 the row's name/sku/description, the rest are folded into
 *                 `extra.alternates` rather than dropped, since our schema
 *                 has no room for more than one row per url.
 * - `expdate`   — a single license-expiry date row from the old paid
 *                 desktop app. Not meaningful here, ignored entirely.
 *
 * One `.sch` file's `gearbox` rows routinely reuse one `fig` across many
 * `<a>` tags on one diagram (the same bolt drawn a dozen times) — this is
 * exactly the many-to-one hotspot pattern our schema already supports, and
 * in fact is *why* it supports it (see schema.ts).
 */

export interface ImportSchResult {
  db: Database;
  imageCount: number;
  /** Diagrams whose html/image couldn't be parsed — skipped, not fatal. */
  skippedDiagrams: number;
}

export async function importSchCatalog(
  SQL: SqlJsStatic,
  bytes: Uint8Array,
  catalogName: string,
): Promise<ImportSchResult> {
  const legacy = new SQL.Database(bytes);
  const db = createEmptyCatalog(SQL, catalogName);
  let imageCount = 0;
  let skippedDiagrams = 0;

  try {
    const diagramsStmt = legacy.prepare(
      "SELECT num, brandname, series, gearboxgroup FROM gearbox ORDER BY num",
    );
    while (diagramsStmt.step()) {
      const d = diagramsStmt.getAsObject();
      const num = Number(d.num);
      const name =
        [str(d.brandname), str(d.series)].filter(Boolean).join(" — ") || `Diagram ${num}`;
      const folder = str(d.gearboxgroup);

      const htmlStmt = legacy.prepare("SELECT html FROM infobase WHERE num = ?");
      htmlStmt.bind([num]);
      const htmlValue = htmlStmt.step() ? htmlStmt.getAsObject().html : null;
      htmlStmt.free();
      if (htmlValue == null) {
        skippedDiagrams++;
        continue;
      }

      const parsed = parseInfobaseHtml(toText(htmlValue));
      if (!parsed.imageDataUrl) {
        skippedDiagrams++;
        continue;
      }
      const match = /^data:([^;]+);base64,(.*)$/s.exec(parsed.imageDataUrl);
      if (!match) {
        skippedDiagrams++;
        continue;
      }
      const [, mimeType, base64] = match;
      if (!base64) {
        skippedDiagrams++;
        continue;
      }

      let dims: { width: number; height: number };
      try {
        dims = await loadImageDimensions(parsed.imageDataUrl);
      } catch {
        skippedDiagrams++;
        continue;
      }

      const imageId = addImage(db, {
        name,
        mimeType: normalizeMimeType(mimeType),
        imageData: base64,
        width: dims.width,
        height: dims.height,
        sortOrder: imageCount,
        folder,
      });
      imageCount++;

      importPartsForDiagram(legacy, db, imageId, num, parsed.hotspots);
    }
    diagramsStmt.free();
  } finally {
    legacy.close();
  }

  return { db, imageCount, skippedDiagrams };
}

function importPartsForDiagram(
  legacy: Database,
  db: Database,
  imageId: number,
  num: number,
  hotspots: ParsedHotspot[],
): void {
  const partsStmt = legacy.prepare(
    "SELECT fig, ourno, partno, description, notes, qty FROM linktable WHERE num = ? ORDER BY fig, rowid",
  );
  partsStmt.bind([num]);
  const byFig = new Map<number, Record<string, unknown>[]>();
  while (partsStmt.step()) {
    const r = partsStmt.getAsObject();
    const fig = Number(r.fig);
    const list = byFig.get(fig);
    if (list) list.push(r);
    else byFig.set(fig, [r]);
  }
  partsStmt.free();

  for (const [fig, parts] of byFig) {
    const primary = parts[0];
    if (!primary) continue;
    // Distinct catalog-wide even though `fig` resets to 1 for every diagram.
    const url = `sch-${num}-${fig}`;
    const description = str(primary.description);
    const sku = str(primary.partno) || str(primary.ourno);
    const extra: Record<string, string> = {};
    if (str(primary.notes)) extra.notes = str(primary.notes);
    if (str(primary.qty)) extra.qty = str(primary.qty);
    if (str(primary.ourno) && str(primary.ourno) !== sku) extra.internal_code = str(primary.ourno);
    if (parts.length > 1) {
      extra.alternates = parts
        .slice(1)
        .map((p) => `${str(p.partno) || str(p.ourno) || "?"} — ${str(p.description)}`)
        .join("; ");
    }

    addRow(db, { imageId, url, name: description, sku, description, extra });

    // The hotspot's own label is just the fig number, matching the original
    // <a href="#N">N</a> markup — the full part name lives in the row
    // instead. Dense real diagrams have 40-70+ hotspots on one image; full
    // names as labels bury the picture (found via the user's own testing).
    for (const h of hotspots) {
      if (h.fig !== fig) continue;
      addLink(db, { imageId, name: String(fig), url, top: h.top, left: h.left });
    }
  }
}

interface ParsedHotspot {
  fig: number;
  top: number;
  left: number;
}

interface ParsedDiagram {
  imageDataUrl: string | null;
  hotspots: ParsedHotspot[];
}

function parseInfobaseHtml(html: string): ParsedDiagram {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const imageDataUrl = doc.querySelector("img")?.getAttribute("src") ?? null;

  const hotspots: ParsedHotspot[] = [];
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    const fig = Number.parseInt(href.replace(/^#/, ""), 10);
    if (!Number.isFinite(fig)) return;
    const style = a.getAttribute("style") ?? "";
    const top = Number(/top:\s*(-?[\d.]+)px/.exec(style)?.[1] ?? NaN);
    const left = Number(/left:\s*(-?[\d.]+)px/.exec(style)?.[1] ?? NaN);
    if (!Number.isFinite(top) || !Number.isFinite(left)) return;
    hotspots.push({ fig, top, left });
  });

  return { imageDataUrl, hotspots };
}

function loadImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not decode embedded image"));
    img.src = dataUrl;
  });
}

/** The legacy format writes the non-standard "image/jpg"; normalize it. */
function normalizeMimeType(mimeType: string | undefined): string {
  return mimeType === "image/jpg" ? "image/jpeg" : (mimeType ?? "image/jpeg");
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** `html`/similar BINARY-declared columns come back as bytes (SQLite's manifest typing stored them as a BLOB, not TEXT). */
function toText(v: unknown): string {
  if (v instanceof Uint8Array) return new TextDecoder("utf-8").decode(v);
  return String(v ?? "");
}

/**
 * Sniffs a raw catalog file's actual table names rather than trusting its
 * extension — both formats are plain SQLite files, so a `.ecatm` renamed to
 * `.sch` (or vice versa, or a URL with no extension at all) still opens
 * correctly.
 */
export function detectFileKind(SQL: SqlJsStatic, bytes: Uint8Array): "ecatm" | "legacy-sch" | "unknown" {
  const probe = new SQL.Database(bytes);
  try {
    const rows = probe.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values ?? [];
    const tables = new Set(rows.map((r) => String(r[0])));
    if (tables.has("images") && tables.has("links") && tables.has("rows")) return "ecatm";
    if (tables.has("gearbox") && tables.has("infobase") && tables.has("linktable")) return "legacy-sch";
    return "unknown";
  } finally {
    probe.close();
  }
}
