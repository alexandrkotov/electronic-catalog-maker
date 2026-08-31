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

  afterEach(() => {
    server.stop();
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
});
