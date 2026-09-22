import { networkInterfaces } from "node:os";
import { statSync } from "node:fs";
import { listCatalogs, resolveCatalogPath } from "./catalogListing";
import { loadConfig, saveConfig, type Config } from "./config";
import { pickFolderNative } from "./folderPicker";
import { renderListingPage } from "./listingPage";
import { renderPreviewPage } from "./previewPage";
import { renderStatusPage } from "./statusPage";
import ecmViewerJsPath from "../../viewer-embed/dist/ecm-viewer.js" with { type: "file" };
import faviconPath from "../assets/icons/icon-192.png" with { type: "file" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * "Copy URL" is meant to be pasted into an already-installed/hosted
 * Editor/Viewer's "Open remote catalog…" — that's a cross-origin fetch from
 * whatever origin the app is served from (e.g. https://tapalog.com) to this
 * server's own origin, so it needs real CORS. It also needs to survive
 * Chrome's Private Network Access check, which preflights a request from a
 * public site to a private/loopback target (localhost or a LAN IP) and
 * blocks it unless the preflight response explicitly allows it. Confirmed
 * live (2026-09-22): every "Open remote catalog" attempt failed with
 * "Failed to fetch" — localhost, LAN IP, and the cloudflared tunnel URL
 * alike — because /files/* sent no CORS headers at all.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Private-Network": "true",
};

/** First non-internal IPv4 address this machine has — what a LAN visitor would actually type in, as opposed to "localhost" which only means something on this machine. Falls back to "localhost" (still correct for same-machine use) if none is found, e.g. no network adapter at all. */
function getLanAddress(): string {
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "localhost";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface ServerHandle {
  port: number;
  /** Set by main.ts once the tunnel reports its address — mirrors collab-server's ServerHandle. */
  publicUrl: string | null;
  tunnelError: string | null;
  onShutdownRequested?: () => void;
  /** Fired right after a mode switch is persisted, so main.ts can start/stop the tunnel to match — the tunnel subprocess itself is main.ts's concern, same split as collab-server. */
  onModeChange?: (mode: Config["mode"]) => void;
  stop(): Promise<void>;
}

export function startServer(port: number): ServerHandle {
  let config = loadConfig();
  let stopped = false;

  const handle: ServerHandle = {
    port: 0,
    publicUrl: null,
    tunnelError: null,
    stop: () => {
      if (stopped) return Promise.resolve();
      stopped = true;
      bunServer.stop(true);
      return Promise.resolve();
    },
  };

  // Picking a folder is a slow, human-driven step (the user can sit in the
  // native dialog for a while) — without this, Bun's default ~10s idle
  // timeout can kill the connection mid-pick. 255 is Bun's own hard max for
  // this option, not an arbitrary choice. Confirmed live (2026-09-22): the
  // default caused the Windows folder dialog to appear to "not work",
  // leading to repeated clicks that each spawned another native dialog
  // (each dialog opens without stealing focus from the browser — a normal
  // Windows background-process restriction, not a bug in this app — so the
  // earlier ones were invisible, not actually gone).
  let pickInProgress = false;

  const bunServer = Bun.serve({
    port,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      if (url.pathname === "/") {
        return Response.redirect("/status", 302);
      }

      if (url.pathname === "/status") {
        return new Response(renderStatusPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/status.json") {
        return json({
          folderPath: config.folderPath,
          mode: config.mode,
          localUrl: `http://${getLanAddress()}:${handle.port}`,
          publicUrl: handle.publicUrl,
          tunnelError: handle.tunnelError,
          port: handle.port,
        });
      }

      if (url.pathname === "/folder/pick" && request.method === "POST") {
        // A second click (or a retried request) while one dialog is still
        // open must not spawn a second native process — that's exactly how
        // the dialogs-piling-up bug above happened. Reject outright rather
        // than queuing, so the page can tell the person a dialog is already
        // open instead of silently waiting behind it.
        if (pickInProgress) return json({ ok: false, path: null, alreadyPicking: true }, 409);
        pickInProgress = true;
        try {
          const path = await pickFolderNative();
          if (path && isDirectory(path)) {
            config = { ...config, folderPath: path };
            saveConfig(config);
            return json({ ok: true, path });
          }
          return json({ ok: false, path: null });
        } finally {
          pickInProgress = false;
        }
      }

      if (url.pathname === "/folder" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { path?: string } | null;
        const path = body?.path?.trim();
        if (!path) return json({ ok: false, error: "Missing path." }, 400);
        if (!isDirectory(path)) return json({ ok: false, error: "That folder doesn't exist." }, 400);
        config = { ...config, folderPath: path };
        saveConfig(config);
        return json({ ok: true, path });
      }

      if (url.pathname === "/mode" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { mode?: string } | null;
        if (body?.mode !== "lan" && body?.mode !== "internet") return json({ ok: false, error: "Bad mode." }, 400);
        config = { ...config, mode: body.mode };
        saveConfig(config);
        handle.onModeChange?.(config.mode);
        return json({ ok: true });
      }

      if (url.pathname === "/shutdown" && request.method === "POST") {
        setTimeout(() => handle.onShutdownRequested?.(), 50);
        return json({ ok: true });
      }

      if (url.pathname === "/ecm-viewer.js") {
        return new Response(Bun.file(ecmViewerJsPath), { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
      }

      if (url.pathname === "/favicon.png") {
        return new Response(Bun.file(faviconPath), { headers: { "Content-Type": "image/png" } });
      }

      if (url.pathname === "/browse") {
        if (!config.folderPath) return new Response(renderListingPage([]), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        return new Response(renderListingPage(listCatalogs(config.folderPath)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (parts[0] === "files" && request.method === "OPTIONS") {
        // The preflight Private Network Access itself sends before the real
        // GET — must be answered for a cross-origin "Open remote catalog"
        // fetch (see CORS_HEADERS above) to get anywhere at all.
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (parts[0] === "files" && request.method === "GET") {
        if (!config.folderPath) return new Response("No folder selected.", { status: 404 });
        const relPath = decodeURIComponent(parts.slice(1).join("/"));
        const resolved = resolveCatalogPath(config.folderPath, relPath);
        if (!resolved) return new Response("Not found.", { status: 404 });
        return new Response(Bun.file(resolved), { headers: CORS_HEADERS });
      }

      if (parts[0] === "preview" && request.method === "GET") {
        if (!config.folderPath) return new Response("No folder selected.", { status: 404 });
        const relPath = decodeURIComponent(parts.slice(1).join("/"));
        const resolved = resolveCatalogPath(config.folderPath, relPath);
        if (!resolved) return new Response("Not found.", { status: 404 });
        const fileUrl = `/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
        return new Response(renderPreviewPage(relPath, fileUrl), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response("Not found.", { status: 404 });
    },
  });

  handle.port = bunServer.port ?? port;
  return handle;
}
