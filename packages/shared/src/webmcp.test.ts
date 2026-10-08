import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { addImage, addLink, addRow, createEmptyCatalog, initSqlite, updateStoreSettings } from "./db.js";
import { navLinkUrl } from "./navLink.js";
import { DEFAULT_CART_CHECKOUT_BASE_URL, DEFAULT_CART_ID_PATTERN, DEFAULT_CART_ITEM_PARAM } from "./schema.js";
import type { CatalogMode } from "./types.js";
import { buildViewerTools, createAgentToolsHandle, safeWebUrl, type AgentTool, type ViewerAgentHost } from "./webmcp.js";
import type { Database } from "sql.js";

const SQL = await initSqlite(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"));
const IMAGE_BYTES = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";

function setMode(db: Database, catalogMode: CatalogMode) {
  updateStoreSettings(db, {
    catalogMode,
    storeUrl: "",
    cartMode: "accumulate",
    cartIdPattern: DEFAULT_CART_ID_PATTERN,
    cartItemParam: DEFAULT_CART_ITEM_PARAM,
    cartCheckoutBaseUrl: DEFAULT_CART_CHECKOUT_BASE_URL,
    defaultView: "images",
  });
}

/** An overview with a marker into a diagram that has two parts; part 14 is drawn twice. */
function partsCatalog() {
  const db = createEmptyCatalog(SQL, "Axle");
  const image = { mimeType: "image/jpeg", imageData: IMAGE_BYTES, width: 100, height: 100 };
  const overview = addImage(db, { ...image, name: "Overview" });
  const diagram = addImage(db, { ...image, name: "Rear axle" });
  addLink(db, { imageId: overview, name: "Axle", url: navLinkUrl(diagram), top: 1, left: 1 });
  addLink(db, { imageId: diagram, name: "14", url: "#9-14", top: 1, left: 1 });
  addLink(db, { imageId: diagram, name: "14", url: "#9-14", top: 5, left: 5 });
  addLink(db, { imageId: diagram, name: "2", url: "#9-2", top: 9, left: 9 });
  addRow(db, { imageId: diagram, url: "#9-14", name: "Seeger ring", sku: "100292", description: "T.2,50 mm", extra: { Price: "$4", buy_url: "https://shop.example/buy?link=abc" } });
  addRow(db, { imageId: diagram, url: "#9-2", name: "Grooved nut", sku: "100314", description: "", extra: { qty: "1" } });
  return { db, overview, diagram };
}

function hostFor(db: Database | null, catalogMode: CatalogMode = "commercial", listEnabled = true) {
  const calls: string[] = [];
  const list: string[] = [];
  let confirmAnswer = false;
  const host: ViewerAgentHost = {
    db: () => db,
    state: () => ({ catalogMode, listEnabled, activeImageId: 2, selectedUrl: null, list: [...list] }),
    actionLabel: () => "Buy",
    openScreen: (id) => void calls.push(`screen:${id}`),
    openItem: (imageId, url) => void calls.push(`item:${imageId}:${url}`),
    addToList: (url) => void list.push(url),
    confirmOpen: ({ url }) => {
      calls.push(`confirm:${url}`);
      return Promise.resolve(confirmAnswer);
    },
  };
  const tools = buildViewerTools(host);
  const call = (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute(input) as Promise<any>;
  };
  return { tools, call, calls, list, answer: (v: boolean) => void (confirmAnswer = v) };
}

describe("viewer tools", () => {
  test("every tool has a static description and an object input schema; results carry no image bytes", async () => {
    const { db } = partsCatalog();
    const { tools, call } = hostFor(db);
    expect(tools.map((t) => t.name)).toEqual([
      "get_catalog_info", "list_items", "find_item", "get_item_details", "open_item", "open_screen", "go_home", "perform_action", "add_to_list", "get_list",
    ]);
    for (const t of tools) {
      expect(t.description).not.toContain("Seeger");
      expect(t.inputSchema.type).toBe("object");
      expect(t.name.length).toBeLessThanOrEqual(128);
    }
    for (const out of [await call("get_catalog_info"), await call("list_items"), await call("find_item", { query: "ring" }), await call("get_item_details", { id: "#9-14" })]) {
      expect(JSON.stringify(out)).not.toContain(IMAGE_BYTES);
    }
  });

  test("get_catalog_info names the catalog, its screens and the current one", async () => {
    const { db, overview, diagram } = partsCatalog();
    const info = await hostFor(db).call("get_catalog_info");
    expect(info).toMatchObject({ name: "Axle", kind: "commercial", itemAction: "Buy", listEnabled: true, currentScreen: 2, screenCount: 2 });
    expect(info.screens).toEqual([{ id: overview, name: "Overview" }, { id: diagram, name: "Rear axle" }]);
  });

  test("find_item puts the item whose marker is labelled with the query ahead of text matches", async () => {
    const { db, diagram } = partsCatalog();
    const found = await hostFor(db).call("find_item", { query: "14" });
    // "#9-2" only matches through its SKU (100314) — a text match, so it comes second.
    expect(found.items.map((i: any) => i.id)).toEqual(["#9-14", "#9-2"]);
    expect(found.items[0]).toEqual({ id: "#9-14", name: "Seeger ring", sku: "100292", price: "$4", labels: ["14"], screen: diagram, screenName: "Rear axle", hasAction: true });
    expect((await hostFor(db).call("find_item", { query: "14", limit: 1 })).items).toHaveLength(1);
    expect(await hostFor(db).call("find_item", { query: " " })).toEqual({ error: "query is required." });
  });

  test("list_items lists a screen's items, and an overview's navigation targets", async () => {
    const { db, overview, diagram } = partsCatalog();
    const { call } = hostFor(db);
    expect((await call("list_items")).items.map((i: any) => i.id)).toEqual(["#9-14", "#9-2"]);
    expect(await call("list_items", { screen: overview })).toEqual({
      screen: overview, screenName: "Overview", total: 0, items: [], navigation: [{ label: "Axle", screen: diagram, screenName: "Rear axle" }],
    });
    expect((await call("list_items", { screen: 99 })).error).toBeDefined();
  });

  test("get_item_details returns the fields and the link separately", async () => {
    const { db } = partsCatalog();
    const details = await hostFor(db).call("get_item_details", { id: "#9-14" });
    expect(details.fields).toEqual({ Price: "$4" });
    expect(details.action).toEqual({ label: "Buy", url: "https://shop.example/buy?link=abc" });
    expect(details.inList).toBe(false);
    expect((await hostFor(db).call("get_item_details", { id: "nope" })).error).toBeDefined();
  });

  test("navigation tools drive the viewer", async () => {
    const { db, overview, diagram } = partsCatalog();
    const { call, calls } = hostFor(db);
    await call("open_item", { id: "#9-2" });
    await call("open_screen", { screen: diagram });
    await call("go_home");
    expect(calls).toEqual([`item:${diagram}:#9-2`, `screen:${diagram}`, `screen:${overview}`]);
  });

  test("add_to_list adds once, refuses an item without a link, and is absent when the viewer has no list", async () => {
    const { db } = partsCatalog();
    const { call, list } = hostFor(db);
    expect(await call("add_to_list", { id: "#9-14" })).toEqual({ ok: true, alreadyInList: false, listSize: 1 });
    expect(await call("add_to_list", { id: "#9-14" })).toEqual({ ok: true, alreadyInList: true, listSize: 1 });
    expect((await call("add_to_list", { id: "#9-2" })).error).toBeDefined();
    expect(list).toEqual(["#9-14"]);
    expect((await call("get_list")).items.map((i: any) => i.id)).toEqual(["#9-14"]);
    expect(hostFor(db, "commercial", false).tools.map((t) => t.name)).not.toContain("add_to_list");
  });

  test("perform_action opens nothing unless the person confirms", async () => {
    const { db } = partsCatalog();
    const { call, calls, answer } = hostFor(db);
    expect(await call("perform_action", { id: "#9-14" })).toEqual({ ok: false, reason: "The person declined." });
    answer(true);
    expect(await call("perform_action", { id: "#9-14" })).toEqual({ ok: true, opened: "https://shop.example/buy?link=abc" });
    expect((await call("perform_action", { id: "#9-2" })).error).toBeDefined(); // no link: the person is not even asked
    expect(calls.filter((c) => c.startsWith("confirm:"))).toHaveLength(2);
  });

  test("only web links are ever opened", () => {
    expect(safeWebUrl("https://shop.example/a")).toBe("https://shop.example/a");
    expect(safeWebUrl("javascript:alert(1)")).toBeNull();
    expect(safeWebUrl("data:text/html,x")).toBeNull();
    expect(safeWebUrl("")).toBeNull();
  });

  test("a quiz offers get_catalog_info only, and it gives no answer away", async () => {
    const db = createEmptyCatalog(SQL, "Civics");
    const q = addImage(db, { name: "Question 1", mimeType: "image/jpeg", imageData: IMAGE_BYTES, width: 10, height: 10 });
    addLink(db, { imageId: q, name: "A", url: "q1-A", top: 1, left: 1 });
    addLink(db, { imageId: q, name: "B", url: "q1-B", top: 2, left: 2 });
    addRow(db, { imageId: q, url: "q1-A", name: "The Declaration", sku: "A", description: "", extra: {} });
    addRow(db, { imageId: q, url: "q1-B", name: "The Constitution", sku: "B", description: "Because it is the supreme law.", extra: { correct: "1" } });
    setMode(db, "quiz");
    const { tools, call } = hostFor(db, "quiz", false);
    expect(tools.map((t) => t.name)).toEqual(["get_catalog_info"]);
    const out = JSON.stringify(await call("get_catalog_info"));
    for (const secret of ["correct", "Constitution", "supreme law", "q1-B"]) expect(out).not.toContain(secret);
  });

  test("without an open catalog every tool answers with an error instead of throwing", async () => {
    const closed = hostFor(null);
    expect(closed.tools.length).toBeGreaterThan(1);
    for (const t of closed.tools) {
      expect(await closed.call(t.name, { id: "x", query: "x", screen: 1 })).toEqual({ error: "No catalog is open." });
    }
  });
});

describe("registration", () => {
  interface Registered { name: string; execute: (input: unknown, client?: unknown) => Promise<any> }
  const g = globalThis as any;
  afterEach(() => {
    delete g.document;
    delete g.navigator;
  });

  const tool = (name: string): AgentTool => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => Promise.resolve({ from: name }),
  });

  /** The current draft: document.modelContext, unregistering through the signal. */
  function currentApi() {
    const registered = new Map<string, Registered>();
    g.document = {
      modelContext: {
        registerTool(t: Registered, options?: { signal?: AbortSignal }) {
          if (registered.has(t.name)) return Promise.reject(new Error("duplicate"));
          registered.set(t.name, t);
          options?.signal?.addEventListener("abort", () => registered.delete(t.name));
          return Promise.resolve();
        },
      },
    };
    return registered;
  }

  test("nothing happens in a browser without the API", () => {
    const handle = createAgentToolsHandle();
    handle.set([tool("a")]);
    handle.clear();
  });

  test("tools are registered, replaced when the set changes, and withdrawn", async () => {
    const registered = currentApi();
    const handle = createAgentToolsHandle();
    handle.set([tool("a"), tool("b")]);
    expect([...registered.keys()]).toEqual(["a", "b"]);
    expect(await registered.get("a")!.execute({})).toEqual({ from: "a" });
    const sameObject = registered.get("a");
    handle.set([tool("a"), tool("b")]); // a refresh: same names, nothing re-registered
    expect(registered.get("a")).toBe(sameObject);
    handle.set([tool("a")]);
    expect([...registered.keys()]).toEqual(["a"]);
    handle.clear();
    expect(registered.size).toBe(0);
  });

  test("one viewer owns the tools; the next one takes over when it lets go", async () => {
    const registered = currentApi();
    const first = createAgentToolsHandle();
    const second = createAgentToolsHandle();
    first.set([tool("a")]);
    second.set([tool("a"), tool("b")]);
    expect([...registered.keys()]).toEqual(["a"]);
    first.clear();
    expect([...registered.keys()]).toEqual(["a", "b"]);
    second.clear();
    expect(registered.size).toBe(0);
  });

  test("the earlier navigator.modelContext API gets MCP-shaped results and unregisterTool", async () => {
    const registered = new Map<string, Registered>();
    g.navigator = {
      modelContext: {
        registerTool: (t: Registered) => void registered.set(t.name, t),
        unregisterTool: (name: string) => void registered.delete(name),
      },
    };
    const handle = createAgentToolsHandle();
    handle.set([tool("a")]);
    expect(await registered.get("a")!.execute({})).toEqual({ content: [{ type: "text", text: '{"from":"a"}' }] });
    handle.clear();
    expect(registered.size).toBe(0);
  });

  test("a tool that throws answers with an error", async () => {
    const registered = currentApi();
    const handle = createAgentToolsHandle();
    handle.set([{ ...tool("a"), execute: () => Promise.reject(new Error("boom")) }]);
    expect(await registered.get("a")!.execute(null)).toEqual({ error: "boom" });
    handle.clear();
  });
});
