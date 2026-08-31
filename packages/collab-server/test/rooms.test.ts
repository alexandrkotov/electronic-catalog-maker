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
    const before = await fetch(`${base}/status.json`);
    expect((await before.json()) as { publicUrl: string | null; port: number }).toEqual({
      publicUrl: null,
      port: server.port,
    });

    server.publicUrl = "https://example.trycloudflare.com";
    const after = await fetch(`${base}/status.json`);
    expect(((await after.json()) as { publicUrl: string | null; port: number }).publicUrl).toBe(
      "https://example.trycloudflare.com",
    );

    const page = await fetch(`${base}/status`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toContain("text/html");
  });
});
