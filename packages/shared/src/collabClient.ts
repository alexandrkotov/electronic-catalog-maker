/**
 * Talks to @ecm/collab-server's plain HTTP surface (POST /rooms, PUT
 * chunks, POST finalize, GET the snapshot back, DELETE) plus its local
 * auto-detect trick — the parts shared by *both* of the server's clients:
 * the editor's full realtime sessions (a WebSocket layered on top for live
 * ops/presence, see packages/editor/src/collab.ts) and the viewer's
 * lightweight "Share view…" (see the OneDrive backlog's QR-viewer item) —
 * a one-time upload with a plain `GET` back, no WebSocket at all. See
 * packages/collab-server/src/server.ts's own doc for why one REST surface
 * serves both uses as-is, with no server-side changes needed for the
 * second one.
 */

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

/** The room's original snapshot — not "current" once live edits have happened; the editor's own listOpsSince() (packages/editor/src/collab.ts) is what catches those up, not this. */
export async function downloadSnapshot(baseUrl: string, roomId: string): Promise<Uint8Array> {
  const res = await fetch(`${baseUrl}/rooms/${roomId}`);
  if (!res.ok) throw new Error(`Could not download the catalog (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Ends the session for everyone, not just this tab — only the holder of
 * `ownerToken` (from createRoom()'s return; a joiner never has it) can do
 * this. `closedByName` rides along as X-Closed-By so still-connected
 * WebSocket participants get told who closed it, not just that it
 * happened — pass "" for a room nobody ever joined live (the viewer's
 * "Share view…" never opens a WebSocket at all, so there's no one to name).
 */
export async function deleteRoom(baseUrl: string, roomId: string, ownerToken: string, closedByName: string): Promise<void> {
  const res = await fetch(`${baseUrl}/rooms/${roomId}`, {
    method: "DELETE",
    headers: { "X-Owner-Token": ownerToken, "X-Closed-By": closedByName },
  });
  if (!res.ok) throw new Error(`Could not end the session (${res.status}).`);
}

// ---------- local auto-detect ----------

export interface DetectedCollabServer {
  /** What to actually use — the server's public tunnel address if it has one, otherwise its bare local address (only reachable from this same browser/machine, but still usable for a local-only "Share view…" snapshot or a same-tab collaboration session). */
  url: string;
  hasPublicUrl: boolean;
}

// Bounded port range this page can auto-detect a locally-running
// @ecm/collab-server app on — must match PORT_SCAN_COUNT in
// packages/collab-server/src/main.ts. A fully random ephemeral port (used
// there only once this whole range is also busy, a rare case) can't be
// scanned for from a web page; the editor's "can't find a collaboration
// server" dialog's manual-address field is the fallback for that.
export const COLLAB_AUTO_DETECT_BASE_PORT = 8787;
export const COLLAB_AUTO_DETECT_PORT_COUNT = 10;

async function probeCollabServerPort(port: number): Promise<DetectedCollabServer | null> {
  try {
    const res = await fetch(`http://localhost:${port}/status.json`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const data = (await res.json()) as { publicUrl?: string | null; tunnelError?: string | null };
    // Something answered, but not shaped like our own status.json — some
    // unrelated local service happens to be on this port. Not our server.
    if (!("publicUrl" in data) || !("tunnelError" in data)) return null;
    return data.publicUrl ? { url: data.publicUrl, hasPublicUrl: true } : { url: `http://localhost:${port}`, hasPublicUrl: false };
  } catch {
    return null; // nothing listening there, or it didn't answer in time
  }
}

/**
 * Scans the bounded port range in parallel for a locally-running
 * collab-server app. Prefers one that already has a public tunnel address
 * (works for someone else too); falls back to one that's up but not yet
 * tunneled — still connecting, or its tunnel failed — since that's still
 * usable locally even before (or without) a share link working.
 */
export async function detectLocalCollabServer(): Promise<DetectedCollabServer | null> {
  const ports = Array.from({ length: COLLAB_AUTO_DETECT_PORT_COUNT }, (_, i) => COLLAB_AUTO_DETECT_BASE_PORT + i);
  const found = (await Promise.all(ports.map(probeCollabServerPort))).filter((r) => r !== null);
  return found.find((r) => r.hasPublicUrl) ?? found[0] ?? null;
}

/**
 * Fallback for detectLocalCollabServer() coming up completely empty — which
 * is the *expected* result on a browser enforcing Chrome 142+'s Local
 * Network Access (LNA), even when a collab-server really is running on the
 * default port: LNA blocks this page's plain fetch() to any loopback
 * address outright (confirmed live — "Permission was denied for this
 * request to access the `loopback` address space", not a timeout or a
 * missing-CORS error), and nothing in the probe above ever asks the user
 * for the permission that would allow it.
 *
 * Works around it rather than asking for that permission: opens the
 * server's own /bridge page in a popup (a top-level navigation, which LNA
 * doesn't restrict) instead of fetching it directly; that page fetches its
 * own /status.json on the server's side of the boundary (same address
 * space — also not restricted) and hands the answer back via postMessage
 * (not fetch/XHR/WebSocket — also not restricted), which is the one
 * three-hop route across this boundary LNA leaves open. See
 * packages/collab-server/src/bridgePage.ts for the other half.
 *
 * Only tried against the default port, not the whole
 * COLLAB_AUTO_DETECT_PORT_COUNT range: a sequence of popups (one per
 * candidate port) risks both a popup-blocker false-refusal (browsers are
 * stingier about repeated window.open() calls) and outrunning the click's
 * own transient user activation, which the very first popup already spends
 * a little of (this only runs after the plain fetch scan above has already
 * awaited every port once). The "server's on a non-default port, or on
 * another machine, or this popup got blocked too" case falls through to
 * whatever the caller does next (the editor's manual-address dialog; the
 * viewer's "Share view…" error message) exactly as before — this is a
 * second automatic attempt layered on top of that, not a replacement.
 */
export async function detectLocalCollabServerViaBridge(port: number): Promise<DetectedCollabServer | null> {
  const returnOrigin = window.location.origin;
  const targetOrigin = `http://localhost:${port}`;
  let popup: Window | null;
  try {
    popup = window.open(`${targetOrigin}/bridge?returnOrigin=${encodeURIComponent(returnOrigin)}`, "_blank", "width=100,height=100,left=-1000,top=-1000");
  } catch {
    popup = null;
  }
  if (!popup) return null; // blocked by a popup blocker (or the browser refused for some other reason) — no different from "not found" to the caller

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DetectedCollabServer | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      try {
        popup?.close(); // harmless if the bridge page already closed itself, or the port had nothing on it and this is still sitting on a connection-refused error page
      } catch {
        // ignore
      }
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== targetOrigin || event.source !== popup) return; // some unrelated message, or the wrong popup — not ours
      const data = event.data as { source?: string; publicUrl?: string | null } | null;
      if (data?.source !== "ecm-collab-server-bridge") return;
      finish(data.publicUrl ? { url: data.publicUrl, hasPublicUrl: true } : { url: targetOrigin, hasPublicUrl: false });
    };
    window.addEventListener("message", onMessage);
    // Loopback round-trips are near-instant when something's actually
    // there (see probeCollabServerPort's own much shorter 800ms budget) —
    // this just needs to also cover a real page load (not just a fetch),
    // hence the larger number. Nothing arriving by then means either the
    // port had nothing listening (the popup's sitting on a connection-
    // refused error page that was never going to message back) or this
    // browser blocked the popup's navigation some other way.
    const timer = setTimeout(() => finish(null), 1500);
  });
}
