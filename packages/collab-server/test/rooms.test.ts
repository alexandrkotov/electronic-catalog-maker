import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

/** ExportedHandler's fetch() takes (request, env) — env isn't auto-injected when calling the worker's export directly like this, unlike the ambient `exports.default` proxy. */
function call(request: Request) {
  return worker.fetch(request, env);
}

/**
 * Exercises the actual HTTP surface (create → upload chunks → finalize →
 * read back → delete), the same sequence a real client would drive, all
 * running fully locally against workerd — no Cloudflare account needed.
 */
describe("collab-server rooms", () => {
  it("creates a room, accepts a chunked upload, and returns the reassembled snapshot", async () => {

    const createRes = await call(new Request("https://example.com/rooms", { method: "POST" }));
    expect(createRes.status).toBe(201);
    const { roomId, ownerToken } = (await createRes.json()) as { roomId: string; ownerToken: string };
    expect(roomId).toBeTruthy();
    expect(ownerToken).toBeTruthy();

    // Split "hello world" across two out-of-order-arriving chunks — idx is what fixes the order.
    const chunkA = new TextEncoder().encode("hello ");
    const chunkB = new TextEncoder().encode("world");

    const putB = await call(
      new Request(`https://example.com/rooms/${roomId}/chunks/1`, { method: "PUT", body: chunkB }),
    );
    expect(putB.status).toBe(200);
    const putA = await call(
      new Request(`https://example.com/rooms/${roomId}/chunks/0`, { method: "PUT", body: chunkA }),
    );
    expect(putA.status).toBe(200);

    const finalizeRes = await call(
      new Request(`https://example.com/rooms/${roomId}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkCount: 2 }),
      }),
    );
    expect(finalizeRes.status).toBe(200);

    const infoRes = await call(new Request(`https://example.com/rooms/${roomId}/info`));
    const info = (await infoRes.json()) as { exists: boolean; uploadComplete: boolean; totalBytes: number };
    expect(info).toEqual({ exists: true, uploadComplete: true, chunkCount: 2, totalBytes: 11 });

    const getRes = await call(new Request(`https://example.com/rooms/${roomId}`));
    expect(getRes.status).toBe(200);
    const bytes = new Uint8Array(await getRes.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("hello world");

    const badDelete = await call(
      new Request(`https://example.com/rooms/${roomId}`, {
        method: "DELETE",
        headers: { "X-Owner-Token": "not-the-real-token" },
      }),
    );
    expect(badDelete.status).toBe(403);

    const goodDelete = await call(
      new Request(`https://example.com/rooms/${roomId}`, {
        method: "DELETE",
        headers: { "X-Owner-Token": ownerToken },
      }),
    );
    expect(goodDelete.status).toBe(200);

    const afterDelete = await call(new Request(`https://example.com/rooms/${roomId}`));
    expect(afterDelete.status).toBe(404);
  });

  it("rejects reading a room before its upload is finalized", async () => {
    const createRes = await call(new Request("https://example.com/rooms", { method: "POST" }));
    const { roomId } = (await createRes.json()) as { roomId: string };

    const getRes = await call(new Request(`https://example.com/rooms/${roomId}`));
    expect(getRes.status).toBe(409);
  });

  it("404s for a room id nobody created", async () => {
    const getRes = await call(new Request("https://example.com/rooms/never-created"));
    expect(getRes.status).toBe(404);
  });

  it("relays a live op between two connected clients, but never back to the sender, and logs it for later", async () => {
    const createRes = await call(new Request("https://example.com/rooms", { method: "POST" }));
    const { roomId } = (await createRes.json()) as { roomId: string };

    async function connect(): Promise<WebSocket> {
      const res = await call(
        new Request(`https://example.com/rooms/${roomId}/live`, { headers: { Upgrade: "websocket" } }),
      );
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      if (!ws) throw new Error("Response had no WebSocket.");
      ws.accept();
      return ws;
    }

    const wsA = await connect();
    const wsB = await connect();

    const aMessages: string[] = [];
    wsA.addEventListener("message", (evt) => aMessages.push(evt.data as string));
    const receivedByB = new Promise<string>((resolve) => {
      wsB.addEventListener("message", (evt) => resolve(evt.data as string));
    });

    wsA.send(JSON.stringify({ fn: "updateRow", args: [42, { name: "New name" }] }));

    const raw = await receivedByB;
    const op = JSON.parse(raw) as { seq: number; fn: string; args: unknown[]; ts: string };
    expect(op.fn).toBe("updateRow");
    expect(op.args).toEqual([42, { name: "New name" }]);
    expect(op.seq).toBe(1);
    expect(typeof op.ts).toBe("string");
    expect(aMessages).toHaveLength(0); // the sender doesn't get its own op echoed back

    const opsRes = await call(new Request(`https://example.com/rooms/${roomId}/ops?since=0`));
    expect(opsRes.status).toBe(200);
    const ops = (await opsRes.json()) as Array<{ seq: number; fn: string; args: unknown[] }>;
    expect(ops).toEqual([{ seq: 1, fn: "updateRow", args: [42, { name: "New name" }], ts: op.ts }]);

    // catching up from after that seq gets nothing new
    const emptyRes = await call(new Request(`https://example.com/rooms/${roomId}/ops?since=1`));
    expect(await emptyRes.json()).toEqual([]);

    wsA.close();
    wsB.close();
  });

  it("rejects a non-WebSocket request to the live endpoint", async () => {
    const createRes = await call(new Request("https://example.com/rooms", { method: "POST" }));
    const { roomId } = (await createRes.json()) as { roomId: string };
    const res = await call(new Request(`https://example.com/rooms/${roomId}/live`));
    expect(res.status).toBe(426);
  });
});
