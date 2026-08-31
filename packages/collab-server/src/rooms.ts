/**
 * The room registry: everything a shared editing session needs, held in
 * plain JS objects in this process's memory — no database, no disk.
 *
 * This used to be a Cloudflare Durable Object with its own embedded SQLite
 * (see git history / the project's design notes for that version) — that
 * made sense when a room needed to survive across a Worker's own request
 * lifecycle and outlive any single connection. Now that self-hosting is the
 * only model (see the project's collaboration-hosting decision), a room
 * only ever needs to survive as long as this process does: whoever started
 * it just closes the app when they're done, and everything here vanishes
 * with it. That's a real simplification, not just a port — no on-disk
 * chunk storage, no TTL/alarm bookkeeping, no schema migrations. A plain
 * Map is enough.
 *
 * Deliberately dumb, same as the Durable Object version was: this module
 * never interprets what an operation's `fn`/`args` actually do — it just
 * logs and hands them back in order. See server.ts's class doc (and, in
 * the editor, main.ts's OP_HANDLERS) for why the split is drawn this way.
 */

export interface Op {
  seq: number;
  fn: string;
  args: unknown[];
  ts: string;
}

interface RoomState {
  ownerToken: string;
  createdAt: string;
  uploadComplete: boolean;
  chunkCount: number;
  chunks: Map<number, Uint8Array>;
  opsLog: Op[];
}

const rooms = new Map<string, RoomState>();

function getOrThrow(roomId: string): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error("Room does not exist.");
  return room;
}

/** Creates the room. Rejected if roomId is already taken — same "don't reissue a token out from under someone" reasoning the Durable Object version had. */
export function createRoom(roomId: string, ownerToken: string): { createdAt: string } {
  if (rooms.has(roomId)) throw new Error("Room already exists.");
  const createdAt = new Date().toISOString();
  rooms.set(roomId, { ownerToken, createdAt, uploadComplete: false, chunkCount: 0, chunks: new Map(), opsLog: [] });
  return { createdAt };
}

/** Stores one piece of the uploaded snapshot. Chunks may arrive out of order; idx is what fixes the order back up on read. */
export function putChunk(roomId: string, idx: number, data: Uint8Array): void {
  getOrThrow(roomId).chunks.set(idx, data);
}

/** Marks the upload finished, recording how many chunks were declared — called once, after every putChunk() has landed. */
export function finalizeUpload(roomId: string, chunkCount: number): void {
  const room = getOrThrow(roomId);
  room.chunkCount = chunkCount;
  room.uploadComplete = true;
}

export function roomInfo(roomId: string): { exists: boolean; uploadComplete: boolean; chunkCount: number; totalBytes: number } {
  const room = rooms.get(roomId);
  if (!room) return { exists: false, uploadComplete: false, chunkCount: 0, totalBytes: 0 };
  let totalBytes = 0;
  for (const chunk of room.chunks.values()) totalBytes += chunk.byteLength;
  return { exists: true, uploadComplete: room.uploadComplete, chunkCount: room.chunkCount, totalBytes };
}

/** Reassembles every stored chunk, in idx order, into one buffer. Same in-memory-buffering simplification the Durable Object version had — fine for realistic catalog sizes, revisit with real streaming before relying on this for a true multi-hundred-MB one. */
export function readAll(roomId: string): Uint8Array {
  const room = getOrThrow(roomId);
  if (!room.uploadComplete) throw new Error("Upload not finished yet.");
  const indices = [...room.chunks.keys()].sort((a, b) => a - b);
  const totalLength = indices.reduce((sum, i) => sum + room.chunks.get(i)!.byteLength, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const i of indices) {
    const chunk = room.chunks.get(i)!;
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Everything logged after `sinceSeq` (0 for the whole log) — how a new joiner or a reconnecting client catches up, replaying these locally with the same shared mutation functions the sender used. */
export function listOpsSince(roomId: string, sinceSeq: number): Op[] {
  return getOrThrow(roomId).opsLog.filter((op) => op.seq > sinceSeq);
}

export function appendOp(roomId: string, fn: string, args: unknown[]): Op {
  const room = getOrThrow(roomId);
  const op: Op = { seq: room.opsLog.length + 1, fn, args, ts: new Date().toISOString() };
  room.opsLog.push(op);
  return op;
}

/** Only the holder of the owner token (from createRoom()'s return, kept secret from collaborators) may do this. */
export function deleteRoom(roomId: string, ownerToken: string): void {
  const room = getOrThrow(roomId);
  if (room.ownerToken !== ownerToken) throw new Error("Wrong owner token.");
  rooms.delete(roomId);
}

/** Test-only: every real Room instance is this whole process, so tests need a way back to a clean slate between cases instead of restarting a Durable Object. */
export function _resetAllRoomsForTests(): void {
  rooms.clear();
}
