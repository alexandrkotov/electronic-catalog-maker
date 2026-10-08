/**
 * WebMCP (https://webmachinelearning.github.io/webmcp/): lets an AI agent
 * running in the visitor's browser work with the open catalog through
 * declared tools instead of reading the DOM. Pure progressive enhancement —
 * a browser without the API registers nothing and the viewer behaves exactly
 * as before. Nothing here touches the network.
 *
 * The tools are built from a ViewerAgentHost (the few things mountViewer
 * exposes of itself), so they can be tested without a DOM.
 *
 * Rules the tool set follows:
 * - A locked (password-protected) catalog has no tools at all — the engine
 *   only calls set() once a catalog is actually open.
 * - A quiz gets get_catalog_info only: every other tool reads rows, and the
 *   right answers live in them (extra.correct, and free-text search matches it).
 * - Descriptions are static. Catalog content is data, returned in results
 *   (flagged untrustedContentHint), never part of a description.
 * - No image bytes in any result.
 * - Opening an item's link is the one consequential action. The tool call
 *   alone never opens anything: it puts a dialog on the page
 *   (host.confirmOpen) and waits. That dialog is a visible step, not a
 *   barrier — an agent that also drives the page's pointer can press it,
 *   exactly as it could press the Buy button itself (seen with ChatGPT's
 *   built-in browser); such an agent's own permission prompts are the gate.
 */
import { listAllRows, listImages, listLinksForImage, listRowsForImage, readMeta } from "./db.js";
import { navTargetImageId } from "./navLink.js";
import { searchRows } from "./search.js";
import type { CatalogImage, CatalogMode, CatalogRow } from "./types.js";
import type { Database } from "sql.js";

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; untrustedContentHint?: boolean; consequentialHint?: boolean };
  /** Resolves to a plain JSON-serializable object; failures are `{ error }`, not rejections. */
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export interface ViewerAgentHost {
  /** The open catalog, or null while none is open (or it is still locked). */
  db(): Database | null;
  state(): {
    catalogMode: CatalogMode;
    /** The viewer shows a cart/collection the visitor can review (see viewerEngine.ts cartItems). */
    listEnabled: boolean;
    activeImageId: number | null;
    /** rows.url of the selected item, if any. */
    selectedUrl: string | null;
    /** rows.url of everything in the cart/collection. */
    list: string[];
  };
  /** The item link's on-screen name in this catalog: "Buy", "Learn more", "Book", ... */
  actionLabel(): string;
  openScreen(imageId: number): void;
  openItem(imageId: number, url: string): void;
  addToList(url: string): void;
  /** Asks the visitor, and opens `url` in a new tab on their own click. Resolves false when they decline. */
  confirmOpen(request: { name: string; url: string }, signal?: AbortSignal): Promise<boolean>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function limitOf(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

function buyUrlOf(row: CatalogRow): string | null {
  const v = row.extra.buy_url;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** An item link is only ever opened as a web page — never a `javascript:` or other scheme a catalog file might carry. */
export function safeWebUrl(url: string, base?: string): string | null {
  try {
    const parsed = new URL(url, base);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Price isn't a column of its own (see CatalogRow.extra) — by convention it's an extra key starting with "price". */
function priceOf(row: CatalogRow): string | undefined {
  const key = Object.keys(row.extra).find((k) => /^price/i.test(k));
  const value = key === undefined ? "" : String(row.extra[key]).trim();
  return value || undefined;
}

export function buildViewerTools(host: ViewerAgentHost): AgentTool[] {
  const fail = (error: string) => Promise.resolve({ error });
  const NO_CATALOG = "No catalog is open.";

  /** hotspot labels per rows.url, in hotspot order — "14" on the diagram is a label, not a row field. */
  const labelsByUrl = (db: Database, images: CatalogImage[]): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const image of images) {
      for (const l of listLinksForImage(db, image.id)) {
        if (navTargetImageId(l.url) !== null) continue;
        const labels = out.get(l.url) ?? [];
        if (!labels.includes(l.name)) labels.push(l.name);
        out.set(l.url, labels);
      }
    }
    return out;
  };

  const summary = (row: CatalogRow, labels: Map<string, string[]>, screenNames: Map<number, string>) => ({
    id: row.url,
    name: row.name,
    sku: row.sku || undefined,
    price: priceOf(row),
    labels: labels.get(row.url) ?? [],
    screen: row.imageId,
    screenName: screenNames.get(row.imageId),
    hasAction: buyUrlOf(row) !== null,
  });

  const findRow = (db: Database, id: unknown): CatalogRow | null => {
    if (typeof id !== "string" && typeof id !== "number") return null;
    return listAllRows(db).find((r) => r.url === String(id)) ?? null;
  };

  const ID_PROP = { type: "string", description: "Item id, as returned by list_items or find_item, e.g. 'LR-101'." };

  const info: AgentTool = {
    name: "get_catalog_info",
    description:
      "Describe the catalog open in the viewer: its name, kind, screens (images) and which one is on screen now. Call this first.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute() {
      const db = host.db();
      if (!db) return fail(NO_CATALOG);
      const state = host.state();
      const images = listImages(db);
      const quiz = state.catalogMode === "quiz";
      return Promise.resolve({
        name: readMeta(db).catalogName,
        kind: state.catalogMode,
        itemAction: quiz ? undefined : host.actionLabel(),
        listEnabled: state.listEnabled,
        note: quiz ? "This catalog is a self-test. Its questions are answered by the person, so no item tools are offered." : undefined,
        currentScreen: state.activeImageId,
        selectedItem: quiz ? undefined : (state.selectedUrl ?? undefined),
        screenCount: images.length,
        screens: images.slice(0, MAX_LIMIT).map((i) => ({ id: i.id, name: i.name, folder: i.folder || undefined })),
      });
    },
  };
  if (host.state().catalogMode === "quiz") return [info];

  const tools: AgentTool[] = [
    info,
    {
      name: "list_items",
      description:
        "List the items on one screen of the catalog (default: the screen shown now), plus the screens its navigation markers lead to.",
      inputSchema: {
        type: "object",
        properties: {
          screen: { type: "integer", description: "Screen id from get_catalog_info, e.g. 3. Omit for the current screen." },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Max items to return, default ${DEFAULT_LIMIT}.` },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        const db = host.db();
        if (!db) return fail(NO_CATALOG);
        const images = listImages(db);
        const screenId = input.screen === undefined || input.screen === null ? host.state().activeImageId : Number(input.screen);
        const image = images.find((i) => i.id === screenId);
        if (!image) return fail(`No screen with id ${String(input.screen ?? screenId)}.`);
        const names = new Map(images.map((i) => [i.id, i.name]));
        const labels = labelsByUrl(db, [image]);
        const rows = listRowsForImage(db, image.id);
        const limit = limitOf(input.limit);
        const navigation: Array<{ label: string; screen: number; screenName: string }> = [];
        for (const l of listLinksForImage(db, image.id)) {
          const target = navTargetImageId(l.url);
          const targetName = target === null ? undefined : names.get(target);
          if (target !== null && targetName !== undefined && !navigation.some((n) => n.screen === target)) {
            navigation.push({ label: l.name, screen: target, screenName: targetName });
          }
        }
        return Promise.resolve({
          screen: image.id,
          screenName: image.name,
          total: rows.length,
          items: rows.slice(0, limit).map((r) => summary(r, labels, names)),
          navigation: navigation.slice(0, MAX_LIMIT),
        });
      },
    },
    {
      name: "find_item",
      description:
        "Search every screen of the catalog for items by name, SKU / part number, description, any other field, or the label printed on the image.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to look for, e.g. 'brake pad', 'LR-101' or the marker label '14'." },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Max items to return, default ${DEFAULT_LIMIT}.` },
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        const db = host.db();
        if (!db) return fail(NO_CATALOG);
        const query = typeof input.query === "string" || typeof input.query === "number" ? String(input.query).trim() : "";
        if (!query) return fail("query is required.");
        const images = listImages(db);
        const names = new Map(images.map((i) => [i.id, i.name]));
        const labels = labelsByUrl(db, images);
        const all = listAllRows(db);
        // An exact marker label is the most specific thing a person can ask for ("part 14"), so those come first.
        const q = query.toLowerCase();
        const byLabel = all.filter((r) => (labels.get(r.url) ?? []).some((label) => label.trim().toLowerCase() === q));
        const seen = new Set(byLabel.map((r) => r.url));
        const hits = [...byLabel, ...searchRows(all, query, "all").filter((r) => !seen.has(r.url))];
        return Promise.resolve({
          total: hits.length,
          items: hits.slice(0, limitOf(input.limit)).map((r) => summary(r, labels, names)),
        });
      },
    },
    {
      name: "get_item_details",
      description: "Get everything the catalog says about one item: description, all fields, its link and where it is shown.",
      inputSchema: { type: "object", properties: { id: ID_PROP }, required: ["id"] },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        const db = host.db();
        if (!db) return fail(NO_CATALOG);
        const row = findRow(db, input.id);
        if (!row) return fail(`No item with id ${JSON.stringify(input.id)}.`);
        const images = listImages(db);
        const image = images.find((i) => i.id === row.imageId);
        const buyUrl = buyUrlOf(row);
        const state = host.state();
        const { buy_url: _buyUrl, ...fields } = row.extra;
        return Promise.resolve({
          id: row.url,
          name: row.name,
          sku: row.sku || undefined,
          description: row.description || undefined,
          fields,
          labels: labelsByUrl(db, image ? [image] : []).get(row.url) ?? [],
          screen: row.imageId,
          screenName: image?.name,
          action: buyUrl ? { label: host.actionLabel(), url: buyUrl } : undefined,
          inList: state.listEnabled ? state.list.includes(row.url) : undefined,
        });
      },
    },
    {
      name: "open_item",
      description: "Show an item to the person: opens its screen in the viewer and highlights the item there.",
      inputSchema: { type: "object", properties: { id: ID_PROP }, required: ["id"] },
      annotations: {},
      execute(input) {
        const db = host.db();
        if (!db) return fail(NO_CATALOG);
        const row = findRow(db, input.id);
        if (!row) return fail(`No item with id ${JSON.stringify(input.id)}.`);
        host.openItem(row.imageId, row.url);
        return Promise.resolve({ ok: true, screen: row.imageId });
      },
    },
    {
      name: "open_screen",
      description: "Show one screen (image) of the catalog to the person.",
      inputSchema: {
        type: "object",
        properties: { screen: { type: "integer", description: "Screen id from get_catalog_info, e.g. 3." } },
        required: ["screen"],
      },
      annotations: {},
      execute(input) {
        const db = host.db();
        if (!db) return fail(NO_CATALOG);
        const image = listImages(db).find((i) => i.id === Number(input.screen));
        if (!image) return fail(`No screen with id ${String(input.screen)}.`);
        host.openScreen(image.id);
        return Promise.resolve({ ok: true, screen: image.id });
      },
    },
    {
      name: "go_home",
      description: "Go back to the catalog's first screen (its overview or cover).",
      inputSchema: { type: "object", properties: {} },
      annotations: {},
      execute() {
        const db = host.db();
        if (!db) return fail(NO_CATALOG);
        const first = listImages(db)[0];
        if (!first) return fail("The catalog has no screens.");
        host.openScreen(first.id);
        return Promise.resolve({ ok: true, screen: first.id });
      },
    },
    {
      name: "perform_action",
      description:
        "Open an item's own link (buy, book or learn more) in a new tab. The viewer shows the person a dialog and this call waits for their answer; nothing opens if they decline. The dialog is the person's decision: do not press its buttons yourself.",
      inputSchema: { type: "object", properties: { id: ID_PROP }, required: ["id"] },
      annotations: { consequentialHint: true },
      async execute(input, signal) {
        const db = host.db();
        if (!db) return fail(NO_CATALOG);
        const row = findRow(db, input.id);
        if (!row) return fail(`No item with id ${JSON.stringify(input.id)}.`);
        const url = safeWebUrl(buyUrlOf(row) ?? "", typeof location === "undefined" ? undefined : location.href);
        if (!url) return fail("This item has no link to open.");
        const confirmed = await host.confirmOpen({ name: row.name || row.url, url }, signal);
        return confirmed ? { ok: true, opened: url } : { ok: false, reason: "The person declined." };
      },
    },
  ];

  if (host.state().listEnabled) {
    tools.push(
      {
        name: "add_to_list",
        description:
          "Add an item to the person's list in the viewer (a cart, collection, workout or picks, depending on the catalog). Does not buy or open anything.",
        inputSchema: { type: "object", properties: { id: ID_PROP }, required: ["id"] },
        annotations: {},
        execute(input) {
          const db = host.db();
          if (!db) return fail(NO_CATALOG);
          const row = findRow(db, input.id);
          if (!row) return fail(`No item with id ${JSON.stringify(input.id)}.`);
          if (!buyUrlOf(row)) return fail("This item can't be added to the list.");
          const already = host.state().list.includes(row.url);
          if (!already) host.addToList(row.url);
          return Promise.resolve({ ok: true, alreadyInList: already, listSize: host.state().list.length });
        },
      },
      {
        name: "get_list",
        description: "Show what is in the person's list (cart, collection, workout or picks) in the viewer.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute() {
          const db = host.db();
          if (!db) return fail(NO_CATALOG);
          const inList = new Set(host.state().list);
          const images = listImages(db);
          const names = new Map(images.map((i) => [i.id, i.name]));
          const labels = labelsByUrl(db, images);
          const rows = listAllRows(db).filter((r) => inList.has(r.url));
          return Promise.resolve({ total: rows.length, items: rows.slice(0, MAX_LIMIT).map((r) => summary(r, labels, names)) });
        },
      },
    );
  }
  return tools;
}

// ---------- registration ----------

/**
 * The API moved while this was being written: the current draft exposes
 * `document.modelContext`, unregisters through an AbortSignal and serializes
 * whatever execute() resolves to; earlier Chrome builds and the MCP-B
 * polyfill expose `navigator.modelContext` with unregisterTool() and expect
 * an MCP-style `{ content: [...] }` result. Both are served.
 */
interface ModelContextLike {
  registerTool(tool: unknown, options?: { signal?: AbortSignal }): unknown;
  unregisterTool?(name: string): unknown;
}

function findModelContext(): { api: ModelContextLike; legacy: boolean } | null {
  const usable = (v: unknown): v is ModelContextLike => !!v && typeof (v as ModelContextLike).registerTool === "function";
  try {
    const current = typeof document === "undefined" ? undefined : (document as unknown as { modelContext?: unknown }).modelContext;
    if (usable(current)) return { api: current, legacy: false };
    const legacy = typeof navigator === "undefined" ? undefined : (navigator as unknown as { modelContext?: unknown }).modelContext;
    if (usable(legacy)) return { api: legacy, legacy: true };
  } catch {
    // e.g. blocked by the page's Permissions-Policy
  }
  return null;
}

function register(tools: AgentTool[]): () => void {
  const found = findModelContext();
  if (!found) return () => {};
  const { api, legacy } = found;
  const abort = new AbortController();
  const names: string[] = [];
  for (const tool of tools) {
    const descriptor = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      async execute(input: unknown, client?: { signal?: AbortSignal; requestUserInteraction?: (cb: () => Promise<unknown>) => Promise<unknown> }) {
        const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        const run = () => tool.execute(args, client?.signal);
        let result: Record<string, unknown>;
        try {
          // The earlier API's own way to say "waiting for the person" (see perform_action).
          result =
            tool.annotations.consequentialHint && typeof client?.requestUserInteraction === "function"
              ? ((await client.requestUserInteraction(run)) as Record<string, unknown>)
              : await run();
        } catch (err) {
          result = { error: (err as Error).message };
        }
        return legacy ? { content: [{ type: "text", text: JSON.stringify(result) }] } : result;
      },
    };
    try {
      const pending = api.registerTool(descriptor, { signal: abort.signal });
      // A rejected registration (e.g. another script on the page owns this name) just leaves that tool out.
      if (pending instanceof Promise) pending.catch(() => {});
      names.push(tool.name);
    } catch {
      // same as above, for the synchronous flavour of the API
    }
  }
  return () => {
    abort.abort();
    if (typeof api.unregisterTool !== "function") return;
    for (const name of names) {
      try {
        api.unregisterTool(name);
      } catch {
        // already gone
      }
    }
  };
}

/**
 * One viewer on the page owns the tools at a time — tool names are global to
 * the page, and "the catalog" has to mean one thing to an agent. The first
 * viewer with an open catalog gets them; another one (a second <ecm-viewer>
 * on the same page) takes over when that one closes its catalog or is removed.
 */
export interface AgentToolsHandle {
  /** Offer this viewer's tools (replacing what it offered before). */
  set(tools: AgentTool[]): void;
  /** This viewer has nothing to offer any more: no catalog, a locked one, or it was destroyed. */
  clear(): void;
}

let owner: Handle | null = null;
const waiting: Handle[] = [];

class Handle implements AgentToolsHandle {
  private tools: AgentTool[] = [];
  private registeredKey = "";
  private unregister: (() => void) | null = null;

  set(tools: AgentTool[]) {
    this.tools = tools;
    if (owner === null) owner = this;
    if (owner === this) this.sync();
    else if (!waiting.includes(this)) waiting.push(this);
  }

  clear() {
    this.tools = [];
    const at = waiting.indexOf(this);
    if (at !== -1) waiting.splice(at, 1);
    if (owner !== this) return;
    this.sync();
    owner = waiting.shift() ?? null;
    owner?.sync();
  }

  /**
   * Tools read the viewer's live state when called, so the same set of names
   * never needs registering twice (a refresh, or another catalog of the same
   * kind) — which also avoids un- and re-registering a name in one breath.
   */
  private sync() {
    const key = this.tools.map((t) => t.name).join(",");
    if (key === this.registeredKey) return;
    this.unregister?.();
    this.unregister = this.tools.length > 0 ? register(this.tools) : null;
    this.registeredKey = key;
  }
}

export function createAgentToolsHandle(): AgentToolsHandle {
  return new Handle();
}
