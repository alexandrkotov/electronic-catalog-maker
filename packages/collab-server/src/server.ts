import * as rooms from "./rooms";
import { renderStatusPage } from "./statusPage";

/**
 * The self-hosted collaboration server: a plain Bun HTTP+WebSocket server
 * that relays live edits and hands out a room's history to catch up on —
 * see rooms.ts's class doc for why it never interprets what an op does.
 *
 * Same HTTP+WS surface as the Cloudflare Durable Object version this
 * replaced (POST /rooms, PUT .../chunks/:idx, POST .../finalize, GET
 * /rooms/:id, GET /rooms/:id/live (WS), GET /rooms/:id/ops?since=N, DELETE
 * /rooms/:id) — kept byte-for-byte identical on purpose, so the editor's
 * collab.ts/main.ts client code needed zero changes, only a different base
 * URL to point at.
 *
 * New here: GET /status and /status.json, the page main.ts auto-opens in
 * the host's browser on startup so they never have to read raw terminal
 * output to find the link to share.
 */

// The editor and this server are always different origins (a self-hosted
// server usually isn't even on the same machine as whoever's editing) — CORS
// is required, not optional. `*` is fine: nothing here is cookie/credential-
// authenticated, the room id and owner token in the URL/body/header *are*
// the credentials, same reasoning as the Cloudflare version had.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Owner-Token",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** rooms.ts throws plain Errors on the failures it defines — surfaced here as 4xx instead of a bare 500. */
async function withErrors(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("does not exist") ? 404 : message.includes("token") ? 403 : 409;
    return json({ error: message }, status);
  }
}

export interface ServerHandle {
  /** Where this instance is actually listening — e.g. for building the tunnel's target URL. Patched in right after Bun assigns it (0 means "not started yet"). */
  port: number;
  /** The public URL to share, once the tunnel's up — null until then. Set by main.ts as the tunnel reports it; read by the /status.json route. */
  publicUrl: string | null;
  /** Set by main.ts if the tunnel couldn't be started at all (e.g. cloudflared missing) — lets the status page show a real explanation instead of "waiting" forever. */
  tunnelError: string | null;
  /** Called when the status page's Stop button is used — main.ts wires this to actually tear down the tunnel and exit, the same cleanup the console window's Ctrl+C path runs. Optional only so a caller (e.g. the test suite) that doesn't need it can leave it unset. */
  onShutdownRequested?: () => void;
  stop(): void;
}

/**
 * Starts listening. `port: 0` picks a free ephemeral port (what the test
 * suite uses, so multiple test files can run concurrently without a
 * hardcoded port colliding); main.ts passes a real fixed port instead, since
 * the tunnel needs a stable target and the shown status page needs a stable
 * address to auto-open.
 */
export function startServer(port: number): ServerHandle {
  const handle: ServerHandle = {
    port: 0, // patched below once Bun assigns the real one
    publicUrl: null,
    tunnelError: null,
    stop: () => bunServer.stop(true),
  };

  const bunServer = Bun.serve<{ roomId: string }>({
    port,
    async fetch(request, server) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      const url = new URL(request.url);

      if (url.pathname === "/status") {
        return new Response(renderStatusPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/status.json") {
        return withCors(json({ publicUrl: handle.publicUrl, tunnelError: handle.tunnelError, port: handle.port }));
      }
      // POST /shutdown — the status page's Stop button. Lets a host end the
      // session from the UI they're actually looking at, instead of the
      // console window being the only off-switch (that window still works
      // too — this is additive, not a replacement).
      if (url.pathname === "/shutdown" && request.method === "POST") {
        setTimeout(() => handle.onShutdownRequested?.(), 50); // small delay so this response finishes sending before the process tears down
        return withCors(json({ ok: true }));
      }

      // GET /rooms/:id/live — upgrade to the WebSocket used for live editing.
      // Handled before the generic route() below: a successful upgrade has
      // no Response to return (Bun's own response to the client), and
      // route() only ever deals in ordinary Responses.
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 3 && parts[0] === "rooms" && parts[2] === "live" && request.method === "GET") {
        const roomId = parts[1]!;
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected a WebSocket upgrade.", { status: 426 });
        }
        if (!rooms.roomInfo(roomId).exists) {
          return new Response("Room does not exist.", { status: 404 });
        }
        const upgraded = server.upgrade(request, { data: { roomId } });
        return upgraded ? undefined : new Response("WebSocket upgrade failed.", { status: 500 });
      }

      const response = await route(request, url, parts);
      return withCors(response);
    },
    websocket: {
      open(ws) {
        // Bun's topic-based pub/sub does the "broadcast to everyone else in
        // this room" work for free — publish() never echoes back to the
        // publisher, matching the "never back to the sender" contract the
        // Durable Object version had to implement by hand.
        ws.subscribe(ws.data.roomId);
      },
      message(ws, message) {
        if (typeof message !== "string") return; // ops are JSON text frames; ignore anything else
        let parsed: { type?: string; fn?: string; args?: unknown[] };
        try {
          parsed = JSON.parse(message);
        } catch {
          return; // malformed frame — drop it rather than crash the room over one bad message
        }
        if (parsed.type === "ping") {
          // Client-side heartbeat (see the editor's collab.ts) — nothing to
          // log here, this never touches the ops log.
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (typeof parsed.fn !== "string" || !Array.isArray(parsed.args)) return;
        const op = rooms.appendOp(ws.data.roomId, parsed.fn, parsed.args);
        ws.publish(ws.data.roomId, JSON.stringify(op));
      },
      close(ws) {
        ws.unsubscribe(ws.data.roomId);
      },
    },
  });

  handle.port = bunServer.port ?? port;
  return handle;
}

async function route(request: Request, url: URL, parts: string[]): Promise<Response> {
  if (parts[0] !== "rooms") {
    return new Response("Not found.", { status: 404 });
  }

  // POST /rooms — create a new room, no id yet (the server picks one).
  if (parts.length === 1 && request.method === "POST") {
    const roomId = crypto.randomUUID();
    const ownerToken = crypto.randomUUID();
    const { createdAt } = rooms.createRoom(roomId, ownerToken);
    return json({ roomId, ownerToken, createdAt }, 201);
  }

  const roomId = parts[1];
  if (!roomId) return new Response("Missing room id.", { status: 400 });

  // GET /rooms/:id — the full reassembled snapshot.
  if (parts.length === 2 && request.method === "GET") {
    return withErrors(() => {
      const bytes = rooms.readAll(roomId);
      return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
    });
  }

  // GET /rooms/:id/info — status, without pulling the whole snapshot down.
  if (parts.length === 3 && parts[2] === "info" && request.method === "GET") {
    return json(rooms.roomInfo(roomId));
  }

  // PUT /rooms/:id/chunks/:idx — one piece of the snapshot upload.
  if (parts.length === 4 && parts[2] === "chunks" && request.method === "PUT") {
    const idx = Number(parts[3]);
    if (!Number.isInteger(idx) || idx < 0) return new Response("Bad chunk index.", { status: 400 });
    return withErrors(async () => {
      const data = new Uint8Array(await request.arrayBuffer());
      rooms.putChunk(roomId, idx, data);
      return json({ ok: true });
    });
  }

  // POST /rooms/:id/finalize — declares the upload complete, with how many chunks to expect.
  if (parts.length === 3 && parts[2] === "finalize" && request.method === "POST") {
    return withErrors(async () => {
      const body = (await request.json()) as { chunkCount?: number };
      if (!Number.isInteger(body.chunkCount) || (body.chunkCount as number) < 1) {
        return new Response("Bad or missing chunkCount.", { status: 400 });
      }
      rooms.finalizeUpload(roomId, body.chunkCount as number);
      return json({ ok: true });
    });
  }

  // GET /rooms/:id/ops?since=N — the operation log after seq N, for a new joiner or a reconnecting client to replay locally.
  if (parts.length === 3 && parts[2] === "ops" && request.method === "GET") {
    const since = Number(url.searchParams.get("since") ?? "0");
    if (!Number.isInteger(since) || since < 0) return new Response("Bad since.", { status: 400 });
    return withErrors(() => json(rooms.listOpsSince(roomId, since)));
  }

  // DELETE /rooms/:id — requires the owner token from creation, in a header (never the shareable room id itself).
  if (parts.length === 2 && request.method === "DELETE") {
    return withErrors(() => {
      const ownerToken = request.headers.get("X-Owner-Token");
      if (!ownerToken) return new Response("Missing X-Owner-Token header.", { status: 401 });
      rooms.deleteRoom(roomId, ownerToken);
      return json({ ok: true });
    });
  }

  return new Response("Not found.", { status: 404 });
}
