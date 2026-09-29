import { mkdirSync } from "node:fs";
import { loadConfig, saveConfig } from "./config";
import { pickFolderNative } from "./folderPicker";
import { runImport, type ImportReport, type Progress } from "./importer";
import { openInBrowser } from "./openInBrowser";
import { renderPage } from "./page";
import { fromDisplayPath, toDisplayPath } from "./wsl";
import { createPoliteFetch } from "./politeFetch";
import { PRESETS } from "./presets";
import faviconPath from "../assets/icons/icon-192.png" with { type: "file" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Job {
  running: boolean;
  input: string;
  progress: Progress | null;
  report: ImportReport | null;
  error: string | null;
}

export interface ServerHandle {
  port: number;
  onShutdownRequested?: () => void;
  stop(): void;
}

/**
 * Unlike catalog-server, nothing here is meant for other devices — it
 * writes to this computer's disk and opens its file manager — so it binds
 * to loopback only instead of checking who's asking per request.
 */
export function startServer(port: number): ServerHandle {
  let config = loadConfig();
  let job: Job = { running: false, input: "", progress: null, report: null, error: null };

  // See catalog-server's server.ts: a second click while the native dialog
  // is still open (it can open behind the browser) must not stack another.
  let pickInProgress = false;

  function setOutputRoot(path: string): string | null {
    try {
      mkdirSync(path, { recursive: true });
    } catch {
      return "Can't create or use that folder.";
    }
    config = { ...config, outputRoot: path };
    saveConfig(config);
    return null;
  }

  const handle: ServerHandle = { port: 0, stop: () => bunServer.stop(true) };

  function startJob(input: string, presetId: string, savedHtml: string[] | undefined, skipSku: boolean) {
    job = { running: true, input, progress: null, report: null, error: null };
    const current = job;
    runImport({
      input,
      presetId,
      savedHtml,
      outputRoot: config.outputRoot,
      skipSku,
      // One request every 300 ms, 3 photo downloads in flight at most —
      // a few hundred products take a minute or two, which is fine for a
      // one-off import and invisible in any store's traffic.
      pf: createPoliteFetch({ minGapMs: 300, retries: 3 }),
      photoConcurrency: 3,
      onProgress: (p) => (current.progress = p),
    })
      .then((report) => (current.report = report))
      .catch((err: unknown) => (current.error = err instanceof Error ? err.message : String(err)))
      .finally(() => (current.running = false));
  }

  const bunServer = Bun.serve({
    port,
    hostname: "127.0.0.1",
    // The person can sit in the folder dialog for a while — Bun's default
    // ~10 s idle timeout would drop the request mid-pick (255 = Bun's max).
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/") {
        return new Response(renderPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // Also the "is it already running?" probe main.ts uses.
      if (url.pathname === "/status.json") {
        return json({
          app: "ecm-store-importer",
          outputRoot: toDisplayPath(config.outputRoot),
          presets: PRESETS.map((p) =>
            p.kind === "saved-page"
              ? { id: p.id, name: p.name, kind: p.kind, hosts: p.hosts, howToSave: p.howToSave }
              : { id: p.id, name: p.name, kind: p.kind },
          ),
        });
      }

      if (url.pathname === "/job.json") {
        return json(job.report ? { ...job, report: { ...job.report, outDir: toDisplayPath(job.report.outDir) } } : job);
      }

      if (url.pathname === "/import" && request.method === "POST") {
        if (job.running) return json({ ok: false, error: "An import is already running." }, 409);
        const body = (await request.json().catch(() => null)) as { url?: string; preset?: string; pages?: unknown; ownerConfirmed?: unknown; skipSku?: unknown } | null;
        if (body?.ownerConfirmed !== true) return json({ ok: false, error: "Confirm that this is your store, or that you have the owner's permission." }, 400);
        const pages = Array.isArray(body?.pages) ? body.pages.filter((p): p is string => typeof p === "string") : undefined;
        if (!body?.url?.trim() && !pages?.length) return json({ ok: false, error: "Enter the store's address." }, 400);
        startJob(body?.url ?? "", body?.preset || "auto", pages, body?.skipSku === true);
        return json({ ok: true });
      }

      if (url.pathname === "/output-root" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { path?: string } | null;
        const typed = body?.path?.trim();
        if (!typed) return json({ ok: false, error: "Missing folder." }, 400);
        const path = fromDisplayPath(typed);
        const error = setOutputRoot(path);
        return error ? json({ ok: false, error }, 400) : json({ ok: true, path: toDisplayPath(path) });
      }

      if (url.pathname === "/output-root/pick" && request.method === "POST") {
        if (pickInProgress) return json({ ok: false, alreadyPicking: true }, 409);
        pickInProgress = true;
        try {
          const path = await pickFolderNative();
          if (!path) return json({ ok: false, path: null });
          const error = setOutputRoot(path);
          return error ? json({ ok: false, error }, 400) : json({ ok: true, path: toDisplayPath(path) });
        } finally {
          pickInProgress = false;
        }
      }

      if (url.pathname === "/open-folder" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { which?: string } | null;
        const target = body?.which === "root" ? config.outputRoot : job.report?.outDir;
        if (!target) return json({ ok: false, error: "Nothing imported yet." }, 400);
        mkdirSync(target, { recursive: true });
        openInBrowser(target);
        return json({ ok: true });
      }

      if (url.pathname === "/shutdown" && request.method === "POST") {
        setTimeout(() => handle.onShutdownRequested?.(), 50);
        return json({ ok: true });
      }

      if (url.pathname === "/favicon.png") {
        return new Response(Bun.file(faviconPath), { headers: { "Content-Type": "image/png" } });
      }

      return new Response("Not found.", { status: 404 });
    },
  });

  handle.port = bunServer.port ?? port;
  return handle;
}
