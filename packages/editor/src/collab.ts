/**
 * Talks to @ecm/collab-server's HTTP + WebSocket surface. Knows nothing
 * about what an operation actually *does* — that's main.ts's job (see
 * OP_HANDLERS there) — this module only moves {fn, args} across the wire
 * and the snapshot bytes in/out of a room. See collab-server/src/room.ts's
 * class doc for why the split is drawn this way.
 */

export interface Op {
  seq: number;
  fn: string;
  args: unknown[];
  ts: string;
}

export interface RoomCreated {
  roomId: string;
  ownerToken: string;
  createdAt: string;
}

// Comfortably under Workers' request body limits regardless of exactly
// where those sit — a real catalog's images are usually smaller than this
// per-chunk anyway, so most uploads end up as one chunk per image.
const CHUNK_SIZE = 4 * 1024 * 1024;

/** Uploads `bytes` into a brand-new room, in pieces, and returns its id + the private owner token (never share that one). */
export async function createRoom(baseUrl: string, bytes: Uint8Array): Promise<RoomCreated> {
  const createRes = await fetch(`${baseUrl}/rooms`, { method: "POST" });
  if (!createRes.ok) throw new Error(`Could not create a room (${createRes.status}).`);
  const room = (await createRes.json()) as RoomCreated;

  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_SIZE));
  for (let i = 0; i < chunkCount; i++) {
    const chunk = bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const res = await fetch(`${baseUrl}/rooms/${room.roomId}/chunks/${i}`, {
      method: "PUT",
      body: chunk as BodyInit,
    });
    if (!res.ok) throw new Error(`Could not upload piece ${i + 1} of ${chunkCount} (${res.status}).`);
  }

  const finalizeRes = await fetch(`${baseUrl}/rooms/${room.roomId}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chunkCount }),
  });
  if (!finalizeRes.ok) throw new Error(`Could not finish the upload (${finalizeRes.status}).`);
  return room;
}

/** The room's original snapshot — not "current" once live edits have happened; see listOpsSince() for the rest. */
export async function downloadSnapshot(baseUrl: string, roomId: string): Promise<Uint8Array> {
  const res = await fetch(`${baseUrl}/rooms/${roomId}`);
  if (!res.ok) throw new Error(`Could not download the catalog (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Every op logged after `sinceSeq` (0 for the whole log) — replay these locally, in order, to catch a fresh join or a reconnect up to date. */
export async function listOpsSince(baseUrl: string, roomId: string, sinceSeq: number): Promise<Op[]> {
  const res = await fetch(`${baseUrl}/rooms/${roomId}/ops?since=${sinceSeq}`);
  if (!res.ok) throw new Error(`Could not fetch missed changes (${res.status}).`);
  return (await res.json()) as Op[];
}

export type CollabStatus = "connecting" | "connected" | "disconnected";

/**
 * The live connection to one room: sends this tab's own edits as they
 * happen, and delivers everyone else's. Buffers nothing itself — a caller
 * that also wants a fresh join/reconnect's missed history has to combine
 * this with listOpsSince() (see main.ts's connectAndSync for the pattern:
 * every message this delivers from the moment it's constructed onward is
 * either already covered by that REST call or arrives here — there's no
 * gap between the two to fall into either way).
 */
export class CollabConnection {
  private ws: WebSocket;
  status: CollabStatus = "connecting";

  constructor(
    baseUrl: string,
    readonly roomId: string,
    private readonly onOp: (op: Op) => void,
    private readonly onStatusChange: (status: CollabStatus) => void,
  ) {
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/rooms/${roomId}/live`;
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("open", () => this.setStatus("connected"));
    this.ws.addEventListener("close", () => this.setStatus("disconnected"));
    this.ws.addEventListener("error", () => this.setStatus("disconnected"));
    this.ws.addEventListener("message", (evt) => {
      try {
        this.onOp(JSON.parse(evt.data as string) as Op);
      } catch {
        // malformed frame — drop it rather than crash the tab over one bad message
      }
    });
  }

  private setStatus(status: CollabStatus) {
    this.status = status;
    this.onStatusChange(status);
  }

  /** Sends this tab's own edit. Silently dropped if the socket isn't open — the caller already applied it locally either way, this is just best-effort sharing. */
  sendOp(fn: string, args: unknown[]) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ fn, args }));
    }
  }

  close() {
    this.ws.close();
  }
}
