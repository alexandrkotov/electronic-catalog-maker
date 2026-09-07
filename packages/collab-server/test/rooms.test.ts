import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetAllRoomsForTests } from "../src/rooms";
import { startServer, type ServerHandle } from "../src/server";

/**
 * Exercises the actual HTTP+WS surface (create → upload chunks → finalize
 * → read back → delete; live op relay) against a real running Bun server
 * on an ephemeral local port — the same sequence a real client would
 * drive, no mocking of fetch/WebSocket needed since this *is* the runtime
 * the real server runs under.
 */
describe("collab-server rooms", () => {
  let server: ServerHandle;
  let base: string;

  beforeEach(() => {
    _resetAllRoomsForTests();
    server = startServer(0); // 0 = pick a free ephemeral port
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("creates a room, accepts a chunked upload, and returns the reassembled snapshot", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    expect(createRes.status).toBe(201);
    const { roomId, ownerToken } = (await createRes.json()) as { roomId: string; ownerToken: string };
    expect(roomId).toBeTruthy();
    expect(ownerToken).toBeTruthy();

    // Split "hello world" across two out-of-order-arriving chunks — idx is what fixes the order.
    const chunkA = new TextEncoder().encode("hello ");
    const chunkB = new TextEncoder().encode("world");

    const putB = await fetch(`${base}/rooms/${roomId}/chunks/1`, { method: "PUT", body: chunkB });
    expect(putB.status).toBe(200);
    const putA = await fetch(`${base}/rooms/${roomId}/chunks/0`, { method: "PUT", body: chunkA });
    expect(putA.status).toBe(200);

    const finalizeRes = await fetch(`${base}/rooms/${roomId}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunkCount: 2 }),
    });
    expect(finalizeRes.status).toBe(200);

    const infoRes = await fetch(`${base}/rooms/${roomId}/info`);
    const info = (await infoRes.json()) as { exists: boolean; uploadComplete: boolean; chunkCount: number; totalBytes: number };
    expect(info).toEqual({ exists: true, uploadComplete: true, chunkCount: 2, totalBytes: 11 });

    const getRes = await fetch(`${base}/rooms/${roomId}`);
    expect(getRes.status).toBe(200);
    const bytes = new Uint8Array(await getRes.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("hello world");

    const badDelete = await fetch(`${base}/rooms/${roomId}`, {
      method: "DELETE",
      headers: { "X-Owner-Token": "not-the-real-token" },
    });
    expect(badDelete.status).toBe(403);

    const goodDelete = await fetch(`${base}/rooms/${roomId}`, {
      method: "DELETE",
      headers: { "X-Owner-Token": ownerToken },
    });
    expect(goodDelete.status).toBe(200);

    const afterDelete = await fetch(`${base}/rooms/${roomId}`);
    expect(afterDelete.status).toBe(404);
  });

  it("rejects reading a room before its upload is finalized", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    const { roomId } = (await createRes.json()) as { roomId: string };

    const getRes = await fetch(`${base}/rooms/${roomId}`);
    expect(getRes.status).toBe(409);
  });

  it("404s for a room id nobody created", async () => {
    const getRes = await fetch(`${base}/rooms/never-created`);
    expect(getRes.status).toBe(404);
  });

  it("relays a live op between two connected clients, but never back to the sender, and logs it for later", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    const { roomId } = (await createRes.json()) as { roomId: string };
    const wsBase = base.replace(/^http/, "ws");

    function connect(): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/rooms/${roomId}/live`);
        ws.addEventListener("open", () => resolve(ws), { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
    }

    const wsA = await connect();
    const wsB = await connect();

    const aMessages: string[] = [];
    wsA.addEventListener("message", (evt) => aMessages.push(evt.data as string));
    const receivedByB = new Promise<string>((resolve) => {
      wsB.addEventListener("message", (evt) => resolve(evt.data as string), { once: true });
    });

    wsA.send(JSON.stringify({ fn: "updateRow", args: [42, { name: "New name" }] }));

    const raw = await receivedByB;
    const op = JSON.parse(raw) as { seq: number; fn: string; args: unknown[]; ts: string };
    expect(op.fn).toBe("updateRow");
    expect(op.args).toEqual([42, { name: "New name" }]);
    expect(op.seq).toBe(1);
    expect(typeof op.ts).toBe("string");

    // Give any (incorrect) echo-back a moment to arrive before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aMessages).toHaveLength(0); // the sender doesn't get its own op echoed back

    const opsRes = await fetch(`${base}/rooms/${roomId}/ops?since=0`);
    expect(opsRes.status).toBe(200);
    const ops = (await opsRes.json()) as Array<{ seq: number; fn: string; args: unknown[]; ts: string }>;
    expect(ops).toEqual([{ seq: 1, fn: "updateRow", args: [42, { name: "New name" }], ts: op.ts }]);

    // catching up from after that seq gets nothing new
    const emptyRes = await fetch(`${base}/rooms/${roomId}/ops?since=1`);
    expect(await emptyRes.json()).toEqual([]);

    wsA.close();
    wsB.close();
  });

  it("replies to a client heartbeat ping with a pong, without logging it as an op", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    const { roomId } = (await createRes.json()) as { roomId: string };
    const wsBase = base.replace(/^http/, "ws");

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${wsBase}/rooms/${roomId}/live`);
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    const pong = new Promise<string>((resolve) => {
      ws.addEventListener("message", (evt) => resolve(evt.data as string), { once: true });
    });
    ws.send(JSON.stringify({ type: "ping" }));
    expect(JSON.parse(await pong)).toEqual({ type: "pong" });

    const opsRes = await fetch(`${base}/rooms/${roomId}/ops?since=0`);
    expect(await opsRes.json()).toEqual([]);
    ws.close();
  });

  it("rejects a non-WebSocket request to the live endpoint", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    const { roomId } = (await createRes.json()) as { roomId: string };
    const res = await fetch(`${base}/rooms/${roomId}/live`);
    expect(res.status).toBe(426);
  });

  it("serves a status page and reports the public URL once the tunnel sets it", async () => {
    type StatusJson = { publicUrl: string | null; tunnelError: string | null; port: number };
    const before = await fetch(`${base}/status.json`);
    expect((await before.json()) as StatusJson).toEqual({ publicUrl: null, tunnelError: null, port: server.port });

    server.publicUrl = "https://example.trycloudflare.com";
    const after = await fetch(`${base}/status.json`);
    expect(((await after.json()) as StatusJson).publicUrl).toBe("https://example.trycloudflare.com");

    const page = await fetch(`${base}/status`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toContain("text/html");
  });

  it("reports a tunnel error via status.json instead of leaving the client polling forever", async () => {
    server.tunnelError = "Could not start the tunnel — is 'cloudflared' installed and on PATH?";
    const res = await fetch(`${base}/status.json`);
    const data = (await res.json()) as { tunnelError: string | null };
    expect(data.tunnelError).toBe("Could not start the tunnel — is 'cloudflared' installed and on PATH?");
  });

  it("broadcasts the active-presence roster on hello, active toggling, and disconnect — including back to whoever triggered it", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    const { roomId } = (await createRes.json()) as { roomId: string };
    const wsBase = base.replace(/^http/, "ws");
    type Roster = { type: string; users: Array<{ clientId: string; name: string; color: string }> };

    function connect(): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/rooms/${roomId}/live`);
        ws.addEventListener("open", () => resolve(ws), { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
    }
    function nextRoster(ws: WebSocket): Promise<Roster> {
      return new Promise((resolve) => {
        ws.addEventListener("message", (evt) => resolve(JSON.parse(evt.data as string) as Roster), { once: true });
      });
    }

    const wsA = await connect();
    const wsB = await connect();

    // A says hello — the roster (with A in it) reaches A itself too, not just B.
    // Every broadcast below is awaited on *every* currently-connected socket
    // before moving on — a copy nobody's listening for when it lands isn't
    // buffered for a later listener to pick up, it's just gone, so leaving
    // any subscriber's copy undrained would make a later, unrelated await
    // resolve with this stale message instead of the one it's actually
    // waiting for (caught exactly that way while first writing this test).
    let [aRoster, bRoster] = await Promise.all([
      nextRoster(wsA),
      nextRoster(wsB),
      Promise.resolve(wsA.send(JSON.stringify({ type: "presence-hello", clientId: "alice", name: "Alice", color: "#ff0000", active: true }))),
    ]);
    expect(aRoster).toEqual({ type: "presence-roster", users: [{ clientId: "alice", name: "Alice", color: "#ff0000" }] });
    expect(bRoster).toEqual(aRoster);

    // B says hello too — an invalid color falls back to the neutral default rather than riding through as arbitrary CSS.
    [aRoster, bRoster] = await Promise.all([
      nextRoster(wsA),
      nextRoster(wsB),
      Promise.resolve(wsB.send(JSON.stringify({ type: "presence-hello", clientId: "bob", name: "Bob", color: "not-a-color; }</style>", active: true }))),
    ]);
    expect(aRoster.users.map((u) => u.clientId).sort()).toEqual(["alice", "bob"]);
    expect(aRoster.users.find((u) => u.clientId === "bob")?.color).toBe("#6c757d");
    expect(bRoster).toEqual(aRoster);

    // A goes idle — drops out of the roster everyone sees, self included.
    [aRoster, bRoster] = await Promise.all([
      nextRoster(wsA),
      nextRoster(wsB),
      Promise.resolve(wsA.send(JSON.stringify({ type: "presence-active", active: false }))),
    ]);
    expect(aRoster.users.map((u) => u.clientId)).toEqual(["bob"]);
    expect(bRoster).toEqual(aRoster);

    // C joins and says hello — reaches everyone, A (idle) included.
    const wsC = await connect();
    let cRoster: Roster;
    [aRoster, bRoster, cRoster] = await Promise.all([
      nextRoster(wsA),
      nextRoster(wsB),
      nextRoster(wsC),
      Promise.resolve(wsC.send(JSON.stringify({ type: "presence-hello", clientId: "carol", name: "Carol", color: "#00ff00", active: true }))),
    ]);
    expect(aRoster.users.map((u) => u.clientId).sort()).toEqual(["bob", "carol"]);
    expect(bRoster).toEqual(aRoster);
    expect(cRoster).toEqual(aRoster);

    // B disconnects entirely — the roster empties out to just C for whoever's left.
    [aRoster, cRoster] = await Promise.all([nextRoster(wsA), nextRoster(wsC), Promise.resolve(wsB.close())]);
    expect(aRoster.users.map((u) => u.clientId)).toEqual(["carol"]);
    expect(cRoster).toEqual(aRoster);

    wsA.close();
    wsC.close();
  });

  it("broadcasts the editing roster on start/end, forwards live moves without persisting them, sends a snapshot to a new joiner, and clears on disconnect", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    const { roomId } = (await createRes.json()) as { roomId: string };
    const wsBase = base.replace(/^http/, "ws");
    type Msg = {
      type: string;
      editors?: Array<{ clientId: string; mode: string; imageId: number; linkId?: number; url?: string }>;
      users?: Array<{ clientId: string; name: string; color: string }>;
      clientId?: string;
      linkId?: number;
      top?: number;
      left?: number;
    };

    // A FIFO queue per socket, not one-shot listeners — a single action here
    // (e.g. one hello) can legitimately produce more than one message to the
    // same socket (its own presence-roster broadcast, then a *separate*
    // targeted editing-roster snapshot), and two once:true listeners
    // registered up front for the same target+event both fire on the first
    // message, not one each — this sidesteps that entirely by always having
    // exactly one listener per socket, queuing whatever it doesn't have a
    // waiting consumer for yet.
    function connect(): Promise<{ ws: WebSocket; next: () => Promise<Msg> }> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/rooms/${roomId}/live`);
        const queue: Msg[] = [];
        const waiters: Array<(msg: Msg) => void> = [];
        ws.addEventListener("message", (evt) => {
          const msg = JSON.parse(evt.data as string) as Msg;
          const waiter = waiters.shift();
          if (waiter) waiter(msg);
          else queue.push(msg);
        });
        const next = () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise<Msg>((r) => waiters.push(r)));
        ws.addEventListener("open", () => resolve({ ws, next }), { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
    }

    const a = await connect();
    const b = await connect();

    // Both say hello first — editing-start requires a clientId. Each hello's
    // presence-roster broadcast (reaching both) is drained here, not
    // asserted on; presence itself is exercised by the test above. No
    // targeted editing-roster snapshot yet — nobody's editing anything, so
    // the server skips sending one (see server.ts's presence-hello handling).
    a.ws.send(JSON.stringify({ type: "presence-hello", clientId: "alice", name: "Alice", color: "#ff0000", active: true }));
    await a.next(); // alice's own presence-roster
    await b.next(); // presence-roster reaching bob too
    b.ws.send(JSON.stringify({ type: "presence-hello", clientId: "bob", name: "Bob", color: "#00ff00", active: true }));
    await a.next(); // presence-roster reaching alice
    await b.next(); // bob's own presence-roster

    // Alice starts dragging hotspot 7 on image 1 — reaches both, including herself.
    a.ws.send(JSON.stringify({ type: "editing-start", mode: "drag", imageId: 1, linkId: 7 }));
    const expectedDragRoster = { type: "editing-roster", editors: [{ clientId: "alice", mode: "drag", imageId: 1, linkId: 7, name: "Alice", color: "#ff0000" }] };
    expect(await a.next()).toEqual(expectedDragRoster);
    expect(await b.next()).toEqual(expectedDragRoster);

    // A live move is forwarded to Bob only (never back to Alice, same as an
    // op) and never shows up in a later roster snapshot — the server never
    // persists it (see rooms.ts's EditingEntry / this file's class doc).
    a.ws.send(JSON.stringify({ type: "editing-move", linkId: 7, top: 120, left: 340 }));
    expect(await b.next()).toEqual({ type: "editing-move", clientId: "alice", linkId: 7, top: 120, left: 340 });

    // Carol joins mid-drag — her own hello's targeted snapshot already shows
    // Alice's still-active drag; nothing extra reaches Alice/Bob from this
    // until Carol's presence-roster broadcast (unrelated to editing).
    const c = await connect();
    c.ws.send(JSON.stringify({ type: "presence-hello", clientId: "carol", name: "Carol", color: "#0000ff", active: true }));
    expect(await c.next()).toEqual({ type: "presence-roster", users: expect.any(Array) });
    expect(await c.next()).toEqual(expectedDragRoster);
    await a.next(); // presence-roster reaching alice for carol joining
    await b.next(); // presence-roster reaching bob for carol joining

    // Alice ends the drag — clears for everyone, including herself.
    a.ws.send(JSON.stringify({ type: "editing-end" }));
    const expectedEmptyRoster = { type: "editing-roster", editors: [] };
    expect(await a.next()).toEqual(expectedEmptyRoster);
    expect(await b.next()).toEqual(expectedEmptyRoster);
    expect(await c.next()).toEqual(expectedEmptyRoster);

    // An editing-end with nothing to clear doesn't trigger a pointless broadcast — confirmed by a subsequent, unrelated action's roster arriving next with nothing extra ahead of it.
    a.ws.send(JSON.stringify({ type: "editing-end" }));

    // Bob opens the "Edit table row" form, then disconnects without an
    // explicit editing-end — close() clears it, same as presence.
    b.ws.send(JSON.stringify({ type: "editing-start", mode: "row", imageId: 1, url: "PART-9" }));
    const expectedRowRoster = { type: "editing-roster", editors: [{ clientId: "bob", mode: "row", imageId: 1, url: "PART-9", name: "Bob", color: "#00ff00" }] };
    expect(await a.next()).toEqual(expectedRowRoster); // confirms editing-end-with-nothing-to-clear above stayed silent
    expect(await b.next()).toEqual(expectedRowRoster);
    expect(await c.next()).toEqual(expectedRowRoster);

    b.ws.close();
    // close() sends the routine presence-roster (bob dropped) first, then a
    // separate editing-roster clearing his still-open row form — same order
    // as server.ts's close() handler.
    expect((await a.next()).type).toBe("presence-roster");
    expect((await c.next()).type).toBe("presence-roster");
    expect(await a.next()).toEqual(expectedEmptyRoster);
    expect(await c.next()).toEqual(expectedEmptyRoster);

    a.ws.close();
    c.ws.close();
  });

  it("keeps an editing entry's real name/color even after that person goes idle (a live bug: it used to fall back to a grey 'Someone')", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    const { roomId } = (await createRes.json()) as { roomId: string };
    const wsBase = base.replace(/^http/, "ws");
    type Msg = { type: string; editors?: Array<{ clientId: string; mode: string; imageId: number; linkId?: number; name?: string; color?: string }> };

    function connect(): Promise<{ ws: WebSocket; next: () => Promise<Msg> }> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/rooms/${roomId}/live`);
        const queue: Msg[] = [];
        const waiters: Array<(msg: Msg) => void> = [];
        ws.addEventListener("message", (evt) => {
          const msg = JSON.parse(evt.data as string) as Msg;
          const waiter = waiters.shift();
          if (waiter) waiter(msg);
          else queue.push(msg);
        });
        const next = () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise<Msg>((r) => waiters.push(r)));
        ws.addEventListener("open", () => resolve({ ws, next }), { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
    }

    const alice = await connect();
    const bob = await connect();

    alice.ws.send(JSON.stringify({ type: "presence-hello", clientId: "alice", name: "Alec - Windows 11", color: "#e63946", active: true }));
    await alice.next(); // alice's own presence-roster
    await bob.next(); // presence-roster reaching bob too
    bob.ws.send(JSON.stringify({ type: "presence-hello", clientId: "bob", name: "Bob", color: "#3a86ff", active: true }));
    await alice.next(); // presence-roster reaching alice
    await bob.next(); // bob's own presence-roster

    // Alice opens "Edit link".
    alice.ws.send(JSON.stringify({ type: "editing-start", mode: "form", imageId: 1, linkId: 7 }));
    await alice.next();
    await bob.next();

    // Alice switches to another browser tab — the same visibility
    // transition the editor's own activity tracker reports as
    // presence-active:false. This used to be exactly what broke it: it
    // drops her out of listActivePresence()'s roster (correct — the toolbar
    // avatar row really should lose her), which name/color used to be
    // looked up *from*.
    alice.ws.send(JSON.stringify({ type: "presence-active", active: false }));
    await alice.next(); // alice's own presence-roster (now excluding herself)
    await bob.next(); // presence-roster reaching bob, alice now excluded

    // Bob drags that same hotspot — a fresh editing-roster goes out. Alice's
    // still-open "Edit link" entry must still carry her real name/color, not
    // a "Someone"/undefined fallback, even though she's no longer in the
    // active presence roster at all.
    bob.ws.send(JSON.stringify({ type: "editing-start", mode: "drag", imageId: 1, linkId: 9 }));
    const [aliceMsg, bobMsg] = await Promise.all([alice.next(), bob.next()]);
    const expected = {
      type: "editing-roster",
      editors: [
        { clientId: "alice", mode: "form", imageId: 1, linkId: 7, name: "Alec - Windows 11", color: "#e63946" },
        { clientId: "bob", mode: "drag", imageId: 1, linkId: 9, name: "Bob", color: "#3a86ff" },
      ],
    };
    expect(aliceMsg).toEqual(expected);
    expect(bobMsg).toEqual(expected);

    alice.ws.close();
    bob.ws.close();
  });

  it("stops the server when the status page's Stop button posts to /shutdown", async () => {
    let shutdownCalled = false;
    server.onShutdownRequested = () => {
      shutdownCalled = true;
    };
    const res = await fetch(`${base}/shutdown`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100)); // onShutdownRequested fires after a short delay, see server.ts
    expect(shutdownCalled).toBe(true);
  });

  it("tells everyone still connected the room is closed (with who closed it) when its owner deletes it, and rejects the wrong token without telling anyone anything", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    const { roomId, ownerToken } = (await createRes.json()) as { roomId: string; ownerToken: string };
    const wsBase = base.replace(/^http/, "ws");

    function connect(): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/rooms/${roomId}/live`);
        ws.addEventListener("open", () => resolve(ws), { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
    }
    function nextMessage(ws: WebSocket): Promise<{ type: string; by?: string | null }> {
      return new Promise((resolve) => {
        ws.addEventListener("message", (evt) => resolve(JSON.parse(evt.data as string)), { once: true });
      });
    }

    const wsA = await connect(); // the initiator's own tab, still connected
    const wsB = await connect(); // a collaborator's tab

    // A wrong token deletes nothing and notifies nobody.
    const badDelete = await fetch(`${base}/rooms/${roomId}`, {
      method: "DELETE",
      headers: { "X-Owner-Token": "not-the-real-token", "X-Closed-By": "Mallory" },
    });
    expect(badDelete.status).toBe(403);
    const infoStillThere = await fetch(`${base}/rooms/${roomId}/info`);
    expect(((await infoStillThere.json()) as { exists: boolean }).exists).toBe(true);

    // The real owner deletes it, naming themselves via X-Closed-By — both
    // still-connected sockets get an explicit room-closed frame, not just a
    // dropped connection to guess at.
    const [aMsg, bMsg] = await Promise.all([
      nextMessage(wsA),
      nextMessage(wsB),
      fetch(`${base}/rooms/${roomId}`, { method: "DELETE", headers: { "X-Owner-Token": ownerToken, "X-Closed-By": "Alex" } }).then((res) =>
        expect(res.status).toBe(200),
      ),
    ]);
    expect(aMsg).toEqual({ type: "room-closed", by: "Alex" });
    expect(bMsg).toEqual(aMsg);

    const infoGone = await fetch(`${base}/rooms/${roomId}/info`);
    expect(((await infoGone.json()) as { exists: boolean }).exists).toBe(false);

    // A stray op arriving right after (a message already in flight when the
    // room vanished) doesn't crash the server — see server.ts's message
    // handler.
    wsA.send(JSON.stringify({ fn: "updateRow", args: [1, {}] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stillUp = await fetch(`${base}/status.json`);
    expect(stillUp.status).toBe(200);

    wsA.close();
    wsB.close();
  });

  it("omits `by` when X-Closed-By wasn't sent", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    const { roomId, ownerToken } = (await createRes.json()) as { roomId: string; ownerToken: string };
    const wsBase = base.replace(/^http/, "ws");
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${wsBase}/rooms/${roomId}/live`);
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const [msg] = await Promise.all([
      new Promise((resolve) => ws.addEventListener("message", (evt) => resolve(JSON.parse(evt.data as string)), { once: true })),
      fetch(`${base}/rooms/${roomId}`, { method: "DELETE", headers: { "X-Owner-Token": ownerToken } }),
    ]);
    expect(msg).toEqual({ type: "room-closed", by: null });
    ws.close();
  });

  it("broadcasts server-shutting-down to every open room right before actually stopping, and stop() is safe to call twice", async () => {
    const createRes = await fetch(`${base}/rooms`, { method: "POST" });
    const { roomId } = (await createRes.json()) as { roomId: string };
    const wsBase = base.replace(/^http/, "ws");
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${wsBase}/rooms/${roomId}/live`);
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const nextMessage = new Promise((resolve) => {
      ws.addEventListener("message", (evt) => resolve(JSON.parse(evt.data as string)), { once: true });
    });

    const stopPromise = server.stop();
    expect(await nextMessage).toEqual({ type: "server-shutting-down" });
    await stopPromise;
    await expect(server.stop()).resolves.toBeUndefined(); // afterEach calls this again too — must be a harmless no-op
    ws.close();
  });
});
