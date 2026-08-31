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
// A dead connection doesn't reliably fire the browser's own close/error
// events promptly — an abruptly-gone server (a crash, not a clean
// shutdown) can leave readyState reporting OPEN for a good while, which
// matters here specifically: shareOp() (main.ts) trusts `status` to decide
// whether to send an edit straight through or queue it in the outbox, and
// a stale "connected" reading meant a real edit could get handed to
// ws.send() on a socket that looked open but wasn't, and just vanish —
// never queued, never delivered. Pinging actively catches that instead of
// waiting on the browser to notice on its own.
const HEARTBEAT_INTERVAL_MS = 5000;

export class CollabConnection {
  private ws: WebSocket;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private awaitingPong = false;
  status: CollabStatus = "connecting";

  constructor(
    baseUrl: string,
    readonly roomId: string,
    private readonly onOp: (op: Op) => void,
    private readonly onStatusChange: (status: CollabStatus) => void,
  ) {
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/rooms/${roomId}/live`;
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("open", () => {
      this.setStatus("connected");
      this.startHeartbeat();
    });
    this.ws.addEventListener("close", () => {
      this.stopHeartbeat();
      this.setStatus("disconnected");
    });
    this.ws.addEventListener("error", () => this.setStatus("disconnected"));
    this.ws.addEventListener("message", (evt) => {
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(evt.data as string);
      } catch {
        return; // malformed frame — drop it rather than crash the tab over one bad message
      }
      if (parsed.type === "pong") {
        this.awaitingPong = false;
        return;
      }
      this.onOp(parsed as Op);
    });
  }

  private startHeartbeat() {
    this.heartbeat = setInterval(() => {
      if (this.awaitingPong) {
        // No pong since the last ping — treat it as dead now rather than
        // wait on the browser's own detection, which is exactly what was
        // silently losing edits before this existed.
        this.ws.close();
        return;
      }
      if (this.ws.readyState === WebSocket.OPEN) {
        this.awaitingPong = true;
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
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

  /**
   * Resolves once the socket is genuinely open (immediately, if it already
   * is) — or once it's clear it never will be this attempt (closed/errored
   * first), so a caller waiting on this never hangs forever. connectAndSync
   * (main.ts) awaits this before its REST catch-up call and outbox drain:
   * those and this socket's own handshake have no ordering guarantee
   * between them otherwise, and running the drain first was a real bug —
   * sendOp() on a not-yet-open socket just silently drops the message.
   */
  waitUntilOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => {
      const settle = () => {
        this.ws.removeEventListener("open", settle);
        this.ws.removeEventListener("close", settle);
        this.ws.removeEventListener("error", settle);
        resolve();
      };
      this.ws.addEventListener("open", settle);
      this.ws.addEventListener("close", settle);
      this.ws.addEventListener("error", settle);
    });
  }

  close() {
    this.stopHeartbeat();
    this.ws.close();
  }
}
