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

/**
 * One connected person's presence, keyed by their client-chosen id (see
 * server.ts's presence-hello handling). Deliberately not part of opsLog:
 * this is ephemeral, per-connection UI state, not a catalog edit — it never
 * needs to be replayed for a reconnecting client the way an Op does, only
 * ever reflects "right now".
 */
export interface PresenceEntry {
  name: string;
  color: string;
  /** Tab visible + recent mouse/keyboard activity, as judged by that
   * person's own browser (see the editor's activity tracker) — not merely
   * "the socket is open". Only active entries are ever handed back by
   * listActivePresence(), so a forgotten-but-still-connected tab just drops
   * off everyone else's roster instead of looking like it's being worked on. */
  active: boolean;
}

export type EditingMode = "drag" | "form" | "row";

/**
 * One connected person's "what they're currently touching" — as ephemeral as
 * PresenceEntry (not opsLog, never replayed for a reconnecting client, gone
 * the moment the socket closes). Deliberately at most one entry per
 * clientId — dragging a hotspot while a link-edit form for some *other*
 * hotspot is still open locally is a real but rare edge case, and "the most
 * recent action wins" here is the same simplification PresenceEntry's single
 * `active` flag already makes.
 *
 * `name`/`color` ride along here too, stamped on at editing-start time from
 * the room's full presence map (see server.ts's handler) — not just looked
 * up fresh from the *active*-filtered presence roster a client already has.
 * That's deliberate, not incidental duplication: a real bug caught this the
 * hard way (2026-09-07) — someone can leave their "Edit link" form open and
 * switch away to another tab, which drops them out of
 * listActivePresence()'s *active* roster (their avatar disappears from the
 * toolbar, correctly) while their editing entry rightfully stays (the form
 * really is still open) — a viewer whose only source for the name was a
 * live lookup against that same active-only roster would render "Someone" in
 * a fallback grey the moment that happened, or even fail to ever learn who a
 * *newly joining* viewer's editing-roster snapshot refers to if that person
 * had already gone idle before the join. Stamping it once, snapshotted, sidesteps
 * all of that — and it can't go stale mid-edit either, since a display name
 * is fixed for the whole session (see the editor's initPresenceIdentity).
 */
export interface EditingEntry {
  clientId: string;
  mode: EditingMode;
  imageId: number;
  name: string;
  color: string;
  /** Set for "drag"/"form" — a specific hotspot. Unset for "row": a table
   * row's url isn't tied to one hotspot (the same part can be drawn at
   * several positions), so a viewer matches `url` against every hotspot
   * sharing it instead. */
  linkId?: number;
  /** Set for "row" only — see linkId's note above. */
  url?: string;
}

interface RoomState {
  ownerToken: string;
  createdAt: string;
  uploadComplete: boolean;
  chunkCount: number;
  chunks: Map<number, Uint8Array>;
  opsLog: Op[];
  presence: Map<string, PresenceEntry>;
  editing: Map<string, EditingEntry>;
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
  rooms.set(roomId, { ownerToken, createdAt, uploadComplete: false, chunkCount: 0, chunks: new Map(), opsLog: [], presence: new Map(), editing: new Map() });
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

const MAX_PRESENCE_NAME_LENGTH = 60; // matches the editor's <input maxlength>; enforced here too since this is an unauthenticated peer sending it, not just UI hygiene

/** Records (or replaces) one connection's presence — called on its "hello" and again on every reconnect, since a fresh WebSocket is a fresh connection object server-side even though the client kept the same clientId. Silently a no-op if the room's already gone (e.g. a stray late message after deleteRoom()) — nothing to attach it to. */
export function setPresence(roomId: string, clientId: string, name: string, color: string, active: boolean): void {
  const room = rooms.get(roomId);
  if (!room) return;
  room.presence.set(clientId, { name: name.slice(0, MAX_PRESENCE_NAME_LENGTH), color, active });
}

/** Toggles just the active flag — sent far more often than a fresh hello (every visibility/idle transition), so it's its own cheap call rather than resending name+color each time. No-op if this clientId never said hello (e.g. a stray message after close()). */
export function setPresenceActive(roomId: string, clientId: string, active: boolean): void {
  const entry = rooms.get(roomId)?.presence.get(clientId);
  if (entry) entry.active = active;
}

export function removePresence(roomId: string, clientId: string): void {
  rooms.get(roomId)?.presence.delete(clientId);
}

/** The *unfiltered* presence entry for one clientId — active or not. Exists specifically for server.ts's editing-start handler to stamp a name/color onto a fresh EditingEntry (see its doc for why that has to read this, not listActivePresence()'s active-only view). */
export function getPresence(roomId: string, clientId: string): PresenceEntry | undefined {
  return rooms.get(roomId)?.presence.get(clientId);
}

/** Everyone currently marked active, in join order — what actually goes in the toolbar roster. Someone connected but idle/hidden just isn't in this list; see PresenceEntry's active field for why. */
export function listActivePresence(roomId: string): Array<{ clientId: string; name: string; color: string }> {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room.presence.entries()].filter(([, entry]) => entry.active).map(([clientId, entry]) => ({ clientId, name: entry.name, color: entry.color }));
}

/** Records (or replaces) this clientId's current editing target — see EditingEntry for why there's at most one. No-op if the room's already gone (a stray message racing deleteRoom()). */
export function setEditing(roomId: string, entry: EditingEntry): void {
  rooms.get(roomId)?.editing.set(entry.clientId, entry);
}

/** Clears this clientId's editing target (an explicit editing-end, or a disconnect — see server.ts's close()). Returns whether there was actually anything to clear, so a caller can skip a pointless roster broadcast when there wasn't. */
export function clearEditing(roomId: string, clientId: string): boolean {
  return rooms.get(roomId)?.editing.delete(clientId) ?? false;
}

/** Everyone currently touching something in this room, in no particular order — what goes out as `editing-roster`. Unlike listActivePresence, there's no idle filter here: editing state only ever exists for as long as the connection that set it does. */
export function listEditing(roomId: string): EditingEntry[] {
  return [...(rooms.get(roomId)?.editing.values() ?? [])];
}

/** Only the holder of the owner token (from createRoom()'s return, kept secret from collaborators) may do this. */
export function deleteRoom(roomId: string, ownerToken: string): void {
  const room = getOrThrow(roomId);
  if (room.ownerToken !== ownerToken) throw new Error("Wrong owner token.");
  rooms.delete(roomId);
}

/** Every room id currently held — used only for a process-wide broadcast (the whole server shutting down, see server.ts's stop()) right before every connected client is about to be dropped anyway. Nothing else needs to enumerate rooms globally. */
export function listRoomIds(): string[] {
  return [...rooms.keys()];
}

/** Test-only: every real Room instance is this whole process, so tests need a way back to a clean slate between cases instead of restarting a Durable Object. */
export function _resetAllRoomsForTests(): void {
  rooms.clear();
}
