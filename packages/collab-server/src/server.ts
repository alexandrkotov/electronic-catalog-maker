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
 *
 * Also new: presence (Phase 5) — "presence-hello" and "presence-active"
 * text frames alongside the existing op frames, handled the same way pings
 * are (checked by `type` before falling through to the op path). Broadcasts
 * always go through `bunServer.publish`, not `ws.publish`, specifically
 * because a roster update needs to reach the connection that triggered it
 * too (e.g. seeing your own avatar disappear when you go idle) — unlike an
 * op, which the sender already applied locally and shouldn't get echoed.
 *
 * Also new: session-ending notices (Phase 6) — a still-connected client
 * finds out a session ended from an explicit "room-closed" or
 * "server-shutting-down" WS frame, not merely from its connection dying
 * (which the editor would otherwise read as a network blip and retry every
 * few seconds forever — see the editor's scheduleReconnect). "room-closed"
 * goes out on a successful DELETE /rooms/:id, before this process itself
 * has any reason to exit; "server-shutting-down" goes out to every room
 * this process still has, from ServerHandle.stop() itself, so it fires
 * identically whether the host used the status page's Stop button, Ctrl+C,
 * or the process got a SIGTERM — every one of those already funnels into
 * stop() (see main.ts's shutdown()).
 */

// The editor and this server are always different origins (a self-hosted
// server usually isn't even on the same machine as whoever's editing) — CORS
// is required, not optional. `*` is fine: nothing here is cookie/credential-
// authenticated, the room id and owner token in the URL/body/header *are*
// the credentials, same reasoning as the Cloudflare version had.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Owner-Token, X-Closed-By",
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
  /**
   * Broadcasts "server-shutting-down" to every room this process still
   * has, then actually stops listening — resolves once that's genuinely
   * done. Idempotent — a second call is a harmless no-op — since main.ts's
   * shutdown() and a test's own explicit stop() can both end up calling
   * this on the same handle. Async specifically so a caller that's about
   * to exit the whole process (main.ts) can await it first — a broadcast
   * frame is only queued for sending when publish() is called, not
   * necessarily flushed to the OS yet, and calling process.exit()
   * immediately after was confirmed (live, with a real browser tab) to cut
   * it off before it ever reached anyone.
   */
  stop(): Promise<void>;
}

/**
 * Starts listening. `port: 0` picks a free ephemeral port (what the test
 * suite uses, so multiple test files can run concurrently without a
 * hardcoded port colliding); main.ts passes a real fixed port instead, since
 * the tunnel needs a stable target and the shown status page needs a stable
 * address to auto-open.
 */
export function startServer(port: number): ServerHandle {
  let stopped = false;
  const handle: ServerHandle = {
    port: 0, // patched below once Bun assigns the real one
    publicUrl: null,
    tunnelError: null,
    stop: () => {
      if (stopped) return Promise.resolve();
      stopped = true;
      for (const roomId of rooms.listRoomIds()) {
        bunServer.publish(roomId, JSON.stringify({ type: "server-shutting-down" }));
      }
      // publish() only queues the frame for sending — stop(true) force-closes
      // every connection immediately, which can cut a just-queued frame off
      // before it's actually flushed to the socket. This delay gives it a
      // moment first; resolving only once it's actually run is what lets a
      // caller about to process.exit() (main.ts) wait for that instead of
      // racing it — an unawaited version of this exact delay was confirmed,
      // live with a real browser tab, to still lose the message, because
      // process.exit() doesn't wait for pending timers either.
      return new Promise((resolve) => {
        setTimeout(() => {
          bunServer.stop(true);
          resolve();
        }, 100);
      });
    },
  };

  // clientId is unset until this connection's first presence-hello — a
  // socket that only ever sends ops/pings (an old build, or a client that
  // hasn't shipped presence yet) never gets a presence entry, which is fine:
  // it just doesn't show up in the roster, same as anyone who's gone idle.
  const bunServer = Bun.serve<{ roomId: string; clientId?: string }>({
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

      const response = await route(request, url, parts, broadcastRoomClosed);
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
        let parsed: { type?: string; fn?: string; args?: unknown[]; clientId?: string; name?: string; color?: string; active?: boolean };
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
        if (parsed.type === "presence-hello") {
          if (typeof parsed.clientId !== "string" || typeof parsed.name !== "string" || typeof parsed.color !== "string") return;
          ws.data.clientId = parsed.clientId;
          rooms.setPresence(ws.data.roomId, parsed.clientId, parsed.name, sanitizeColor(parsed.color), parsed.active !== false);
          broadcastPresence(ws.data.roomId);
          return;
        }
        if (parsed.type === "presence-active") {
          if (!ws.data.clientId || typeof parsed.active !== "boolean") return;
          rooms.setPresenceActive(ws.data.roomId, ws.data.clientId, parsed.active);
          broadcastPresence(ws.data.roomId);
          return;
        }
        if (typeof parsed.fn !== "string" || !Array.isArray(parsed.args)) return;
        let op;
        try {
          op = rooms.appendOp(ws.data.roomId, parsed.fn, parsed.args);
        } catch {
          // The room was deleted out from under this connection (Phase 6) —
          // its own "room-closed" broadcast already told the client, or is
          // about to; nothing to append this stray, now-orphaned edit to.
          return;
        }
        ws.publish(ws.data.roomId, JSON.stringify(op));
      },
      close(ws) {
        ws.unsubscribe(ws.data.roomId);
        if (ws.data.clientId) {
          rooms.removePresence(ws.data.roomId, ws.data.clientId);
          broadcastPresence(ws.data.roomId);
        }
      },
    },
  });

  /**
   * Sends the room's current active-presence roster to everyone in it,
   * including whoever just triggered the change — `bunServer.publish`
   * (unlike `ws.publish`) has no notion of "sender" to exclude, which is
   * exactly what's wanted here (see this file's class doc). A no-op if the
   * room's gone (deleteRoom() raced a stray presence message).
   */
  function broadcastPresence(roomId: string) {
    if (!rooms.roomInfo(roomId).exists) return;
    bunServer.publish(roomId, JSON.stringify({ type: "presence-roster", users: rooms.listActivePresence(roomId) }));
  }

  /**
   * Tells everyone still connected to `roomId` that it's gone, right after
   * rooms.deleteRoom() actually removed it (see route()'s DELETE handler) —
   * deliberately no existence check here, unlike broadcastPresence above:
   * the room being gone is exactly the point being announced. `by` is
   * whatever the closer's own tab sent as X-Closed-By (its current
   * presence display name), already length-capped by the caller; null if
   * that header was missing.
   */
  function broadcastRoomClosed(roomId: string, by: string | null) {
    bunServer.publish(roomId, JSON.stringify({ type: "room-closed", by }));
  }

  handle.port = bunServer.port ?? port;
  return handle;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** A presence color rides across the wire as plain text and ends up straight in another browser's CSS (see the editor's presence-avatar rendering) — restricted to a strict `#rrggbb` shape rather than merely escaped, so there's no CSS-injection surface even from an unauthenticated peer. Anything else falls back to a neutral grey. */
function sanitizeColor(color: string): string {
  return HEX_COLOR.test(color) ? color : "#6c757d";
}

const MAX_CLOSED_BY_LENGTH = 60; // matches the presence name cap — X-Closed-By is that same name, just carried on a different request

async function route(
  request: Request,
  url: URL,
  parts: string[],
  broadcastRoomClosed: (roomId: string, by: string | null) => void,
): Promise<Response> {
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

  // DELETE /rooms/:id — requires the owner token from creation, in a header
  // (never the shareable room id itself). Ends the session for everyone,
  // not just this request's caller — see broadcastRoomClosed's own doc for
  // what that tells still-connected clients.
  if (parts.length === 2 && request.method === "DELETE") {
    return withErrors(() => {
      const ownerToken = request.headers.get("X-Owner-Token");
      if (!ownerToken) return new Response("Missing X-Owner-Token header.", { status: 401 });
      rooms.deleteRoom(roomId, ownerToken); // throws (→ 403/404 via withErrors) before anything below runs if the token's wrong or the room's already gone
      const closedBy = request.headers.get("X-Closed-By");
      broadcastRoomClosed(roomId, closedBy ? closedBy.slice(0, MAX_CLOSED_BY_LENGTH) : null);
      return json({ ok: true });
    });
  }

  return new Response("Not found.", { status: 404 });
}
