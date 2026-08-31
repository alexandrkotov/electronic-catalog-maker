import { openInBrowser } from "./openInBrowser";
import { startServer, type ServerHandle } from "./server";
import { startTunnel } from "./tunnel";

/**
 * Entry point for the standalone collaboration-server app: starts the
 * local server, opens a tunnel so it's reachable from outside this
 * machine, and points the host at a friendly status page instead of
 * leaving them reading raw terminal output — see the project's
 * collaboration-hosting design notes for the full "why".
 *
 * Meant to be run either directly (`bun run src/main.ts`, for dev) or as
 * the entry point of a `bun build --compile` single-file executable — see
 * this package's README for the packaged build.
 */

const PORT = Number(process.env.PORT ?? 8787); // matches the base port the editor's auto-detect starts scanning from, so a fresh install of both just works together
const CLOUDFLARED_PATH = process.env.CLOUDFLARED_PATH ?? "cloudflared"; // resolved off PATH unless a packaged build injects a bundled one

// How many sequential ports past PORT to try before giving up and taking a
// fully random one (see startServerNearby below). Keep this in sync with
// the editor's own auto-detect probe range (packages/editor/src/main.ts,
// COLLAB_AUTO_DETECT_PORT_COUNT) — a random ephemeral port can be anything
// from 1024-65535, which a browser page has no way to scan for, so the
// editor can only auto-discover a server that landed *somewhere in this
// bounded range*. Past it, a person has to paste the address in by hand
// (see the editor's "can't find a server" dialog) — a deliberate, accepted
// limit rather than trying to make literally any port discoverable.
const PORT_SCAN_COUNT = 10;

/**
 * Which tunnel provider to run — defaults to Cloudflare's free quick-tunnel
 * mode via `cloudflared`, but not hard-wired to it: `TUNNEL_COMMAND` lets
 * anyone swap in a different provider (e.g. `TUNNEL_COMMAND="ngrok http
 * {port}"`) without touching code, and `TUNNEL_URL_PATTERN` (a regex
 * source string) tells this app how to recognize *that* provider's public
 * URL in its output instead of cloudflared's `*.trycloudflare.com` one.
 * Exists specifically so this app isn't permanently coupled to one
 * third-party free tier — see the project's collaboration-hosting design
 * notes for the "what if this specific free service goes away" reasoning.
 */
function resolveTunnelCommand(port: number): string[] {
  const override = process.env.TUNNEL_COMMAND;
  if (!override) return [CLOUDFLARED_PATH, "tunnel", "--url", `http://localhost:${port}`];
  // A simple whitespace split plus a {port} substitution is enough for
  // swapping in another single tunnel CLI — anything needing real
  // quoting/escaping should wrap itself in a small script and point
  // TUNNEL_COMMAND at that script instead of trying to express it here.
  return override.split(/\s+/).map((part) => part.replaceAll("{port}", String(port)));
}

const tunnelUrlPattern = process.env.TUNNEL_URL_PATTERN ? new RegExp(process.env.TUNNEL_URL_PATTERN) : undefined;

/** True for the specific "something's already listening on this port" failure Bun.serve() throws — confirmed by hand (`code: "EADDRINUSE"`), not guessed at. */
function isPortInUse(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EADDRINUSE";
}

/**
 * A very plausible real scenario: the host double-clicks the app again
 * (thinking the first launch didn't work, or just forgot it's still
 * running) and hits this exact port already in use — by *this same app*.
 * Rather than erroring, checking whether whatever's on the port answers
 * like our own /status.json lets that case just open the already-running
 * instance's status page instead, no error at all.
 */
async function isOwnServerAlreadyThere(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status.json`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const data = (await res.json()) as Record<string, unknown>;
    return "publicUrl" in data && "tunnelError" in data && "port" in data;
  } catch {
    return false; // not answering, or not answering like this app does — treat as "someone else's port"
  }
}

/** Tries each port after `preferredPort`, up to PORT_SCAN_COUNT of them, before falling back to a fully random one — see PORT_SCAN_COUNT's own comment for why the range is bounded at all. */
function startServerNearby(preferredPort: number): ServerHandle {
  for (let port = preferredPort + 1; port < preferredPort + PORT_SCAN_COUNT; port++) {
    try {
      return startServer(port);
    } catch (err) {
      if (!isPortInUse(err)) throw err;
      // busy too — try the next candidate
    }
  }
  // Every port in the scannable range was also taken (rare) — the editor's
  // auto-detect can't find this app either way past that point, so a fully
  // random port is no worse; the status page still shows the real address
  // for manual copy-paste, which covers this case.
  return startServer(0);
}

async function main() {
  console.log("🤝 Electronic Catalog Maker — Collaboration Server");

  let server: ServerHandle;
  try {
    server = startServer(PORT);
  } catch (err) {
    if (!isPortInUse(err)) throw err; // an unexpected failure to listen at all — let it surface rather than papering over something unknown

    if (await isOwnServerAlreadyThere(PORT)) {
      console.log(`   Already running on this computer — opening its status page instead of starting a second copy.`);
      openInBrowser(`http://127.0.0.1:${PORT}/status`);
      return;
    }

    // Occupied by something unrelated — try nearby ports first (still
    // auto-discoverable by the editor's probe) before giving up to a fully
    // random one.
    console.log(`   Port ${PORT} is already in use by something else — picking a different one.`);
    server = startServerNearby(PORT);
  }
  console.log(`   Local: http://127.0.0.1:${server.port}`);
  console.log("   Connecting a public tunnel…");

  const statusUrl = `http://127.0.0.1:${server.port}/status`;
  openInBrowser(statusUrl);
  console.log(`   A page has opened in your browser (${statusUrl}) with the link to share.`);
  // The Windows build compiles with --windows-hide-console (see package.json)
  // for exactly the "unprepared user" reason the status page exists at all —
  // so on Windows there's no console window to reference at all, only the
  // status page's own Stop button. This line still prints (console.log is
  // harmless with no console attached), but phrasing it as "close this
  // window" would be actively wrong there; kept platform-neutral instead.
  console.log("   Use the status page's Stop button to end the session.");

  // A missing `cloudflared` binary (not installed, or a packaged build that
  // failed to bundle one) throws synchronously right out of Bun.spawn — the
  // exact kind of raw stack trace this app exists to spare a non-technical
  // host from. Caught here so the local server stays usable instead of the
  // whole app just crashing — useful on its own for the host's own tab
  // (http://127.0.0.1:<port> is exempt from the browser's mixed-content
  // block even though the editor itself is https://; a *different* machine
  // on the same LAN is not exempt and would still need either a real
  // tunnel, or the editor served over plain http:// on that same LAN too —
  // see the README), and as a fallback local address for a manually-run
  // tunnel pointed at this port.
  let tunnel: ReturnType<typeof startTunnel> | null = null;
  try {
    tunnel = startTunnel({
      command: resolveTunnelCommand(server.port),
      urlPattern: tunnelUrlPattern,
      onUrl: (url) => {
        server.publicUrl = url;
        console.log(`   Public address: ${url}`);
      },
      onExit: (code) => {
        // A vanished tunnel mid-session (network blip, cloudflared crashed)
        // isn't fatal to the server itself — collaborators just can't reach
        // it until it's back. Surface it loudly rather than silently leaving
        // the status page showing a now-dead URL with no explanation.
        if (code !== 0 && code !== null) {
          const message = `The tunnel exited unexpectedly (code ${code}) — the public address above no longer works. Restart this app to try again.`;
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
    console.error("      The server itself is still running (useful on a shared local network),");
    console.error("      but there's no public address to share until a tunnel is available.");
  }

  const shutdown = () => {
    console.log("\nShutting down…");
    tunnel?.stop();
    // Awaited, not fire-and-forget — server.stop() broadcasts a
    // "server-shutting-down" notice to every connected client before it
    // actually stops listening (see its own doc), and process.exit()
    // doesn't wait for anything, pending timers included, so calling it
    // right away was confirmed (live) to cut that broadcast off before it
    // ever reached anyone.
    void server.stop().then(() => process.exit(0));
  };
  server.onShutdownRequested = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
