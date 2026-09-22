import { readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

/**
 * Deliberately does NOT open/parse the `.ecatm` files themselves (that
 * needs sql.js + a full SQLite read just to read `meta.catalogName` — see
 * viewerEngine.ts's readMeta) — the display name is just the filename.
 * Keeps this server's own dependency footprint at zero beyond Bun's
 * built-ins, and listing a folder stays a cheap `readdir`, not a per-file
 * database open. Nicer titles/covers are a possible later enhancement, not
 * needed for the core "find and open a catalog" job.
 */
const CATALOG_EXTENSIONS = [".ecatm", ".sch"];

export interface CatalogEntry {
  /** Relative to the served folder, forward-slash separated regardless of OS — this is what shows up in /files/<relPath> and /preview/<relPath>. */
  relPath: string;
  /** Just the filename, for display. */
  name: string;
}

/** Recursively lists every catalog file under `folderPath`. Silently skips a subfolder it can't read (permissions, a broken symlink) rather than failing the whole listing over one bad entry. */
export function listCatalogs(folderPath: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];

  function walk(dir: string) {
    let items: import("node:fs").Dirent[];
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (CATALOG_EXTENSIONS.includes(extname(item.name).toLowerCase())) {
        entries.push({ relPath: relative(folderPath, full).split(sep).join("/"), name: item.name });
      }
    }
  }

  walk(folderPath);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return entries;
}

/**
 * Resolves a `relPath` (as sent back by the browser in /files/<relPath> or
 * /preview/<relPath>) against `folderPath`, refusing anything that escapes
 * it (`..` segments, an absolute path baked into the URL, a symlink
 * resolved outside — the `resolve()` + prefix check catches all of these
 * the same way). Returns null rather than throwing so callers can turn that
 * straight into a 404 without a try/catch.
 */
export function resolveCatalogPath(folderPath: string, relPath: string): string | null {
  const root = resolve(folderPath);
  const candidate = resolve(root, relPath);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  if (!CATALOG_EXTENSIONS.includes(extname(candidate).toLowerCase())) return null;
  return candidate;
}
