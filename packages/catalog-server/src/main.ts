import { loadConfig } from "./config";
import { openInBrowser } from "./openInBrowser";
import { startServer, type ServerHandle } from "./server";
import { startTunnel, type Tunnel } from "./tunnel";

/**
 * Entry point for the standalone catalog-server app: starts the local
 * server, opens its status page in the host's browser, and — if the
 * persisted mode is "internet" — connects the same kind of Cloudflare Quick
 * Tunnel collab-server uses. See this package's README for the packaged
 * build; see server.ts for the HTTP surface.
 */

// Deliberately not 8787 (collab-server's default) — both apps can run on
// the same machine at once, and each needing its own free port to auto-pick
// from keeps that simple.
const PORT = Number(process.env.PORT ?? 8899);
const CLOUDFLARED_PATH = process.env.CLOUDFLARED_PATH ?? "cloudflared";
const PORT_SCAN_COUNT = 10; // see collab-server/src/main.ts's own doc on this same constant — same reasoning, no auto-discovery contract to preserve here since nothing probes for this server the way the editor probes for collab-server

function resolveTunnelCommand(port: number): string[] {
  const override = process.env.TUNNEL_COMMAND;
  if (!override) return [CLOUDFLARED_PATH, "tunnel", "--url", `http://localhost:${port}`];
  return override.split(/\s+/).map((part) => part.replaceAll("{port}", String(port)));
}

const tunnelUrlPattern = process.env.TUNNEL_URL_PATTERN ? new RegExp(process.env.TUNNEL_URL_PATTERN) : undefined;

function isPortInUse(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EADDRINUSE";
}

async function isOwnServerAlreadyThere(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/status.json`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const data = (await res.json()) as Record<string, unknown>;
    return "folderPath" in data && "mode" in data && "port" in data;
  } catch {
    return false;
  }
}

function startServerNearby(preferredPort: number): ServerHandle {
  for (let port = preferredPort + 1; port < preferredPort + PORT_SCAN_COUNT; port++) {
    try {
      return startServer(port);
    } catch (err) {
      if (!isPortInUse(err)) throw err;
    }
  }
  return startServer(0);
}

async function main() {
  console.log("🗂️  Electronic Catalog Maker — Catalog Server");

  let server: ServerHandle;
  try {
    server = startServer(PORT);
  } catch (err) {
    if (!isPortInUse(err)) throw err;

    if (await isOwnServerAlreadyThere(PORT)) {
      console.log("   Already running on this computer — opening its status page instead of starting a second copy.");
      openInBrowser(`http://localhost:${PORT}/status`);
      return;
    }

    console.log(`   Port ${PORT} is already in use by something else — picking a different one.`);
    server = startServerNearby(PORT);
  }
  console.log(`   Local: http://localhost:${server.port}`);

  const statusUrl = `http://localhost:${server.port}/status`;
  openInBrowser(statusUrl);
  console.log(`   A page has opened in your browser (${statusUrl}) — pick a folder there to start sharing.`);
  console.log("   Use the status page's Stop button to end the session.");

  let tunnel: Tunnel | null = null;

  /** Same missing-cloudflared handling as collab-server's main.ts: caught here so the server (still fully usable on the LAN) doesn't crash over it. */
  function connectTunnel() {
    if (tunnel) return; // already connected — a redundant "internet" mode switch shouldn't spawn a second one
    console.log("   Connecting a public tunnel…");
    try {
      tunnel = startTunnel({
        command: resolveTunnelCommand(server.port),
        urlPattern: tunnelUrlPattern,
        onUrl: (url) => {
          server.publicUrl = url;
          server.tunnelError = null;
          console.log(`   Public address: ${url}`);
        },
        onExit: (code) => {
          tunnel = null;
          server.publicUrl = null;
          if (code !== 0 && code !== null) {
            const message = `The tunnel exited unexpectedly (code ${code}) — the public address no longer works. Switch modes to try again.`;
            server.tunnelError = message;
            console.error(`   ⚠️  ${message}`);
          }
        },
      });
    } catch {
      const message = process.env.TUNNEL_COMMAND
        ? `Could not start the tunnel — is the TUNNEL_COMMAND override ("${process.env.TUNNEL_COMMAND}") actually runnable?`
        : "Could not start the tunnel — is 'cloudflared' installed and on PATH? See this package's README.";
      server.tunnelError = message;
      console.error(`   ⚠️  ${message}`);
    }
  }

  function disconnectTunnel() {
    tunnel?.stop();
    tunnel = null;
    server.publicUrl = null;
    server.tunnelError = null;
  }

  server.onModeChange = (mode) => {
    if (mode === "internet") connectTunnel();
    else disconnectTunnel();
  };

  if (loadConfig().mode === "internet") connectTunnel();

  const shutdown = () => {
    console.log("\nShutting down…");
    void server.stop().then(() => {
      tunnel?.stop();
      process.exit(0);
    });
  };
  server.onShutdownRequested = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
