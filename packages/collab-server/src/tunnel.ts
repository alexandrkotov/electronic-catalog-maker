/**
 * Manages the `cloudflared` subprocess that makes this locally-running
 * server reachable from the outside world — see the project's
 * collaboration-hosting design notes for why a tunnel (not raw dynamic DNS)
 * is the right primitive: it terminates real HTTPS/WSS with no port-
 * forwarding or certificate to manage, both of which a browser-served
 * editor page (always https://) would otherwise require.
 *
 * `cloudflared tunnel --url http://localhost:<port>` needs no Cloudflare
 * account for this "quick tunnel" mode — it prints a one-off
 * `https://*.trycloudflare.com` address to its own stdout/stderr once
 * connected, which is all this module is watching for.
 */

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Pulled out as its own function so the parsing logic is unit-testable against real captured cloudflared output, without spawning the actual binary. */
export function extractTunnelUrl(line: string): string | null {
  return line.match(TUNNEL_URL_PATTERN)?.[0] ?? null;
}

export interface Tunnel {
  stop(): void;
}

export interface StartTunnelOptions {
  port: number;
  /** Path to the cloudflared binary — a bundled/embedded one in a packaged build, or just "cloudflared" to resolve it off PATH in dev. */
  cloudflaredPath: string;
  onUrl: (url: string) => void;
  /** Every line of the subprocess's combined output, mainly for a verbose/debug mode — most callers don't need this. */
  onLog?: (line: string) => void;
  onExit?: (code: number | null) => void;
}

export function startTunnel(opts: StartTunnelOptions): Tunnel {
  const proc = Bun.spawn([opts.cloudflaredPath, "tunnel", "--url", `http://localhost:${opts.port}`], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let found = false;
  async function watch(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        opts.onLog?.(line);
        if (!found) {
          const url = extractTunnelUrl(line);
          if (url) {
            found = true;
            opts.onUrl(url);
          }
        }
      }
    }
  }

  void watch(proc.stdout as ReadableStream<Uint8Array> | null);
  void watch(proc.stderr as ReadableStream<Uint8Array> | null);
  void proc.exited.then((code) => opts.onExit?.(code));

  return {
    stop() {
      proc.kill();
    },
  };
}
