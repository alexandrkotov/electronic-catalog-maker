import { DurableObject } from "cloudflare:workers";

/** One operation, as sent by a client and relayed to everyone else — see room's class doc for why the server doesn't interpret fn/args itself. */
export interface Op {
  seq: number;
  fn: string;
  args: unknown[];
  ts: string;
}

/**
 * One Durable Object instance = one shared editing session ("room") for a
 * single catalog snapshot: Phase 1's create/upload/download, plus Phase 2's
 * live editing on top.
 *
 * The room is a deliberately dumb relay and log, not a participant that
 * understands the catalog's schema — it has no idea what "updateRow" means.
 * Each connected editor already has the real logic (the same @ecm/shared
 * mutation functions it already calls for its own local edits); an
 * operation is just `{fn, args}` naming which of those functions to call
 * and with what, appended to an ordered log and broadcast to everyone else,
 * who apply it with their own copy of that same logic. This was chosen
 * over teaching the server the real schema (which would need a real SQLite
 * engine — sql.js — running inside a Worker, unverified and risky to build
 * blind) — see the project's design notes for the fuller reasoning.
 *
 * A new joiner (or a reconnecting client catching up) doesn't need the
 * server to have "current" state either: the original snapshot plus a
 * replay of every logged op, applied locally with that same shared logic,
 * arrives at the same place — that's what GET /rooms/:id/ops is for.
 *
 * Storage layout (this object's own private SQLite, not shared with anyone
 * else — see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/):
 *   meta(key, value)         — ownerToken, createdAt, uploadComplete, chunkCount
 *   chunks(idx, data)        — the uploaded snapshot, split into pieces on the
 *                               way in; reassembled in idx order on the way out
 *   ops_log(seq, fn, args, ts) — every live edit, in arrival order
 */
export class RoomDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
  }

  /** Tables need re-creating after deleteRoom()'s deleteAll() wipes them, or exists()/readAll() below would crash on "no such table" instead of cleanly reporting not-found. */
  private ensureSchema(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS chunks (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ops_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, fn TEXT NOT NULL, args TEXT NOT NULL, ts TEXT NOT NULL)",
    );
  }

  /** True once create() has run for this room (idFromName gives every roomId *some* stub, even one nobody created yet). */
  exists(): boolean {
    return this.getMeta("ownerToken") !== null;
  }

  /**
   * Creates the room. Idempotent-ish on purpose: calling it again on an
   * already-created room is rejected rather than silently reissuing a new
   * owner token out from under whoever holds the first one.
   */
  create(ownerToken: string): { createdAt: string } {
    if (this.exists()) {
      throw new Error("Room already exists.");
    }
    const createdAt = new Date().toISOString();
    this.setMeta("ownerToken", ownerToken);
    this.setMeta("createdAt", createdAt);
    this.setMeta("uploadComplete", "false");
    return { createdAt };
  }

  /** Stores one piece of the uploaded snapshot. Chunks may arrive out of order; idx is what fixes the order back up on read. */
  putChunk(idx: number, data: ArrayBuffer): void {
    if (!this.exists()) throw new Error("Room does not exist.");
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO chunks (idx, data) VALUES (?, ?)", idx, data);
  }

  /** Marks the upload finished, recording how many chunks to expect on read — called once, after every putChunk() has landed. */
  finalizeUpload(chunkCount: number): void {
    if (!this.exists()) throw new Error("Room does not exist.");
    this.setMeta("chunkCount", String(chunkCount));
    this.setMeta("uploadComplete", "true");
  }

  info(): { exists: boolean; uploadComplete: boolean; chunkCount: number; totalBytes: number } {
    if (!this.exists()) {
      return { exists: false, uploadComplete: false, chunkCount: 0, totalBytes: 0 };
    }
    const totalBytes = [
      ...this.ctx.storage.sql.exec<{ total: number | null }>("SELECT SUM(LENGTH(data)) as total FROM chunks"),
    ][0]?.total ?? 0;
    return {
      exists: true,
      uploadComplete: this.getMeta("uploadComplete") === "true",
      chunkCount: Number(this.getMeta("chunkCount") ?? 0),
      totalBytes,
    };
  }

  /**
   * Reassembles every stored chunk, in order, into one buffer.
   * Simplification flagged on purpose: this holds the *entire* catalog in
   * this Durable Object's memory at once. Fine for proving the mechanism
   * in Phase 1 and for realistic small-to-medium catalogs; a true
   * multi-hundred-MB catalog will need this to stream chunks straight into
   * the Response instead — revisit before relying on this at that size.
   */
  readAll(): ArrayBuffer {
    if (!this.exists()) throw new Error("Room does not exist.");
    if (this.getMeta("uploadComplete") !== "true") throw new Error("Upload not finished yet.");
    const rows = [...this.ctx.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM chunks ORDER BY idx ASC")];
    const totalLength = rows.reduce((sum, r) => sum + r.data.byteLength, 0);
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (const row of rows) {
      out.set(new Uint8Array(row.data), offset);
      offset += row.data.byteLength;
    }
    return out.buffer;
  }

  // ---------- live editing (Phase 2) ----------

  /**
   * Upgrades to a WebSocket for live editing. Uses the Hibernation API
   * (acceptWebSocket, not addEventListener) so an idle connection doesn't
   * keep this Durable Object billed as active — see
   * https://developers.cloudflare.com/durable-objects/best-practices/websockets/
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    if (!this.exists()) {
      return new Response("Room does not exist.", { status: 404 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * One client's edit arrives as `{fn, args}` — fn names one of
   * @ecm/shared's mutation functions (e.g. "updateRow"), args is whatever
   * that function takes after its `db` parameter, which every client
   * supplies locally. Logged for anyone catching up later, then relayed
   * to every *other* connected client — never back to the sender, which
   * already applied its own edit optimistically before sending it.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return; // ops are JSON text frames; ignore anything else
    let parsed: { fn: string; args: unknown[] };
    try {
      parsed = JSON.parse(message);
    } catch {
      return; // malformed frame — drop it rather than crash the room over one bad message
    }
    if (typeof parsed.fn !== "string" || !Array.isArray(parsed.args)) return;

    const op = this.appendOp(parsed.fn, parsed.args);
    const payload = JSON.stringify(op);
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) other.send(payload);
    }
  }

  webSocketClose(): void {
    // Nothing to clean up on our side — ctx.getWebSockets() above already
    // stops including a closed socket on its own, and we don't keep any
    // other per-connection state. Both handlers just need to exist for the
    // Hibernation API; calling ws.close() again here would be redundant
    // (the socket is already closing) and can throw on some close codes.
  }

  webSocketError(): void {}

  /** Everything logged after `sinceSeq` (0 to get the whole log from the start) — how a new joiner or a reconnecting client catches up, both by replaying ops locally with the same shared mutation functions. */
  listOpsSince(sinceSeq: number): Op[] {
    const rows = this.ctx.storage.sql.exec<{ seq: number; fn: string; args: string; ts: string }>(
      "SELECT seq, fn, args, ts FROM ops_log WHERE seq > ? ORDER BY seq ASC",
      sinceSeq,
    );
    return [...rows].map((row) => ({ ...row, args: JSON.parse(row.args) }));
  }

  private appendOp(fn: string, args: unknown[]): Op {
    const ts = new Date().toISOString();
    this.ctx.storage.sql.exec("INSERT INTO ops_log (fn, args, ts) VALUES (?, ?, ?)", fn, JSON.stringify(args), ts);
    const seq = [...this.ctx.storage.sql.exec<{ seq: number }>("SELECT last_insert_rowid() as seq")][0]!.seq;
    return { seq, fn, args, ts };
  }

  // ---------- room lifecycle ----------

  /** Only the holder of the owner token (from create()'s return, kept secret from collaborators) may do this. */
  async deleteRoom(ownerToken: string): Promise<void> {
    if (this.getMeta("ownerToken") !== ownerToken) {
      throw new Error("Wrong owner token.");
    }
    await this.ctx.storage.deleteAll();
    this.ensureSchema(); // back to the same clean slate as a never-created room, not a broken one
  }

  private getMeta(key: string): string | null {
    const row = [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)][0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }
}
