/**
 * Talks to @ecm/collab-server's WebSocket surface — the live-editing half
 * of collaboration (ops, presence, editing indicators). Knows nothing
 * about what an operation actually *does* — that's main.ts's job (see
 * OP_HANDLERS there) — this module only moves {fn, args} across the wire.
 * The REST half this sits on top of (create/upload/download/delete a room,
 * plus local auto-detect) is shared with the viewer's lightweight "Share
 * view…" — see packages/shared/src/collabClient.ts, re-exported from
 * `@ecm/shared` and imported directly by main.ts rather than through here.
 * See collab-server/src/room.ts's class doc for why the live/REST split is
 * drawn this way.
 */

export interface Op {
  seq: number;
  fn: string;
  args: unknown[];
  ts: string;
}

/** One currently-active participant, as the server's roster broadcast reports them (see collab-server/src/rooms.ts's PresenceEntry — this is its public shape, minus the `active` flag itself, since only active entries are ever included). */
export interface PresenceUser {
  clientId: string;
  name: string;
  color: string;
}

export type EditingMode = "drag" | "form" | "row";

/**
 * One other participant's current "what they're touching" — mirrors
 * collab-server/src/rooms.ts's EditingEntry exactly. `name`/`color` ride
 * along here (stamped on by the server at editing-start time from its own
 * presence map) rather than being looked up fresh against this tab's
 * *active*-only presence roster — that lookup used to be how this worked,
 * and it was a real bug: someone can leave an "Edit link" form open and
 * switch tabs, which correctly drops them out of the active roster (their
 * toolbar avatar disappears) while their editing entry rightfully stays —
 * a live lookup against that same roster then renders a "Someone"/grey
 * fallback for a balloon that's still legitimately theirs. See rooms.ts's
 * EditingEntry for the full story.
 */
export interface EditingEntry {
  clientId: string;
  mode: EditingMode;
  imageId: number;
  name: string;
  color: string;
  linkId?: number;
  url?: string;
}

/** A live position update mid-drag — forwarded by the server, never persisted (see rooms.ts), so a late joiner never gets this replayed; the roster's own entry (no top/left) is what they see until the next one of these arrives. */
export interface EditingMove {
  clientId: string;
  linkId: number;
  top: number;
  left: number;
}

/**
 * Why a session actually ended, as told to this tab explicitly (Phase 6) —
 * distinct from a plain "disconnected" status, which today is also what a
 * momentary network blip looks like and triggers main.ts's endless
 * scheduleReconnect. `room-closed` names whoever closed it, if their tab
 * sent one (see @ecm/shared's deleteRoom()); `server-shutting-down` never does —
 * the whole host process is going away, not necessarily because of
 * anything a currently-connected participant did.
 */
export type CollabClosedReason = { kind: "room-closed"; by: string | null } | { kind: "server-shutting-down" };

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
    private readonly onPresence: (users: PresenceUser[]) => void,
    private readonly onEditingRoster: (editors: EditingEntry[]) => void,
    private readonly onEditingMove: (move: EditingMove) => void,
    private readonly onClosed: (reason: CollabClosedReason) => void,
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
      let parsed: { type?: string; users?: PresenceUser[]; editors?: EditingEntry[]; by?: string | null };
      try {
        parsed = JSON.parse(evt.data as string);
      } catch {
        return; // malformed frame — drop it rather than crash the tab over one bad message
      }
      if (parsed.type === "pong") {
        this.awaitingPong = false;
        return;
      }
      if (parsed.type === "presence-roster") {
        this.onPresence(parsed.users ?? []);
        return;
      }
      if (parsed.type === "editing-roster") {
        this.onEditingRoster(parsed.editors ?? []);
        return;
      }
      if (parsed.type === "editing-move") {
        this.onEditingMove(parsed as unknown as EditingMove);
        return;
      }
      if (parsed.type === "room-closed") {
        this.onClosed({ kind: "room-closed", by: parsed.by ?? null });
        return;
      }
      if (parsed.type === "server-shutting-down") {
        this.onClosed({ kind: "server-shutting-down" });
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

  /** Announces (or re-announces, after a reconnect) this tab's identity to the room — see main.ts's connectAndSync for when this is called. */
  sendPresenceHello(clientId: string, name: string, color: string, active: boolean) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "presence-hello", clientId, name, color, active }));
    }
  }

  /** Reports a visibility/idle transition — see main.ts's activity tracker. Silently dropped if not open, same as sendOp; the next reconnect's hello re-establishes the current state anyway. */
  sendPresenceActive(active: boolean) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "presence-active", active }));
    }
  }

  /** Announces this tab has started touching one hotspot/row — see EditingEntry. main.ts calls this from exactly one place per mode: startDragHotspot (once real movement begins, "drag") and syncCollabEditingState (whenever editingLinkId/editingRowId change to a new non-null value, "form"/"row"). */
  sendEditingStart(mode: EditingMode, imageId: number, linkId?: number, url?: string) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "editing-start", mode, imageId, linkId, url }));
    }
  }

  /** A live position update mid-drag — call this throttled, not on every pointermove (see startDragHotspot). Not meaningful outside "drag" mode; the server forwards it as-is without checking. */
  sendEditingMove(linkId: number, top: number, left: number) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "editing-move", linkId, top, left }));
    }
  }

  /** The counterpart to sendEditingStart — a dropped connection doesn't need this too, the server's close() handler clears it the same way it does presence. */
  sendEditingEnd() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "editing-end" }));
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
