import { openInBrowser } from "./openInBrowser";
import { startServer } from "./server";
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

const PORT = Number(process.env.PORT ?? 8787); // matches the editor's own default Server settings value, so a fresh install of both just works together
const CLOUDFLARED_PATH = process.env.CLOUDFLARED_PATH ?? "cloudflared"; // resolved off PATH unless a packaged build injects a bundled one

async function main() {
  const server = startServer(PORT);
  console.log("🤝 Electronic Catalog Maker — Collaboration Server");
  console.log(`   Local: http://127.0.0.1:${server.port}`);
  console.log("   Connecting a public tunnel…");

  const statusUrl = `http://127.0.0.1:${server.port}/status`;
  openInBrowser(statusUrl);
  console.log(`   A page has opened in your browser (${statusUrl}) with the link to share.`);
  console.log("   Close this window to stop.");

  // A missing `cloudflared` binary (not installed, or a packaged build that
  // failed to bundle one) throws synchronously right out of Bun.spawn — the
  // exact kind of raw stack trace this app exists to spare a non-technical
  // host from. Caught here so the local server stays usable (e.g. for
  // same-network collaborators, or a manually-run tunnel pointed at this
  // port) instead of the whole app just crashing.
  let tunnel: ReturnType<typeof startTunnel> | null = null;
  try {
    tunnel = startTunnel({
      port: server.port,
      cloudflaredPath: CLOUDFLARED_PATH,
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
          console.error(`   ⚠️  The tunnel exited unexpectedly (code ${code}) — the public address above no longer works.`);
          console.error(`      Is 'cloudflared' installed? Set CLOUDFLARED_PATH if it's not on PATH. Restart this app to try again.`);
        }
      },
    });
  } catch {
    console.error("   ⚠️  Could not start the tunnel — is 'cloudflared' installed and on PATH?");
    console.error("      The server itself is still running (useful on a shared local network),");
    console.error("      but there's no public address to share until a tunnel is available.");
    console.error("      See this package's README for how to install cloudflared.");
  }

  const shutdown = () => {
    console.log("\nShutting down…");
    tunnel?.stop();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
