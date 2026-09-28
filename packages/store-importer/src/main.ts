import { openInBrowser } from "./openInBrowser";
import { startServer, type ServerHandle } from "./server";

/**
 * Entry point for the standalone store-importer app: starts the local
 * server and opens its page in the host's browser — same shape as
 * catalog-server's main.ts, minus the tunnel.
 */

// Not 8787 (collab-server) or 8899 (catalog-server) — all three can run at once.
const PORT = Number(process.env.PORT ?? 8931);
const PORT_SCAN_COUNT = 10;

function isPortInUse(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EADDRINUSE";
}

async function isOwnServerAlreadyThere(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status.json`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const data = (await res.json()) as Record<string, unknown>;
    return data.app === "ecm-store-importer";
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
  console.log("🛒 ECM — Store Importer");

  let server: ServerHandle;
  try {
    server = startServer(PORT);
  } catch (err) {
    if (!isPortInUse(err)) throw err;
    if (await isOwnServerAlreadyThere(PORT)) {
      console.log("   Already running on this computer — opening its page instead of starting a second copy.");
      openInBrowser(`http://localhost:${PORT}/`);
      return;
    }
    console.log(`   Port ${PORT} is already in use by something else — picking a different one.`);
    server = startServerNearby(PORT);
  }

  const pageUrl = `http://localhost:${server.port}/`;
  console.log(`   Local: ${pageUrl}`);
  openInBrowser(pageUrl);
  console.log("   A page has opened in your browser — paste a store's address there to import it.");
  console.log("   Use the page's Quit button to end the session.");

  const shutdown = () => {
    console.log("\nShutting down…");
    server.stop();
    process.exit(0);
  };
  server.onShutdownRequested = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
