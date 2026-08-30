import { DurableObject } from "cloudflare:workers";

/**
 * One Durable Object instance = one shared editing session ("room") for a
 * single catalog snapshot. Phase 1 scope only: create a room, accept an
 * uploaded snapshot in pieces (a real catalog can be 400MB+, well past a
 * single Workers request body), and hand the whole thing back. No live
 * editing yet — that's Phase 2's granular-operations work on top of this.
 *
 * Storage layout (this object's own private SQLite, not shared with anyone
 * else — see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/):
 *   meta(key, value)      — ownerToken, createdAt, uploadComplete, chunkCount
 *   chunks(idx, data)     — the uploaded snapshot, split into pieces on the
 *                            way in; reassembled in idx order on the way out
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
