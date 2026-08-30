import { RoomDurableObject } from "./room";

export { RoomDurableObject };

/**
 * HTTP surface for Phase 1: create a room, upload a catalog snapshot into
 * it in pieces, read the whole thing back. Deliberately thin — each route
 * just picks the right Durable Object stub by room id (env.ROOMS.getByName,
 * so the room id *is* the stub's identity, no separate lookup table needed)
 * and calls straight through to its RPC methods; all the actual logic
 * lives in room.ts.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // "/rooms/abc/chunks/0" -> ["rooms","abc","chunks","0"]

    if (parts[0] !== "rooms") {
      return new Response("Not found.", { status: 404 });
    }

    // POST /rooms — create a new room, no id yet (the server picks one).
    if (parts.length === 1 && request.method === "POST") {
      const roomId = crypto.randomUUID();
      const ownerToken = crypto.randomUUID();
      const stub = env.ROOMS.getByName(roomId);
      const { createdAt } = await stub.create(ownerToken);
      return json({ roomId, ownerToken, createdAt }, 201);
    }

    const roomId = parts[1];
    if (!roomId) return new Response("Missing room id.", { status: 400 });
    const stub = env.ROOMS.getByName(roomId);

    // GET /rooms/:id — the full reassembled snapshot.
    if (parts.length === 2 && request.method === "GET") {
      return withErrors(async () => {
        const bytes = await stub.readAll();
        return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
      });
    }

    // GET /rooms/:id/info — status, without pulling the whole snapshot down.
    if (parts.length === 3 && parts[2] === "info" && request.method === "GET") {
      return withErrors(async () => json(await stub.info()));
    }

    // PUT /rooms/:id/chunks/:idx — one piece of the snapshot upload.
    if (parts.length === 4 && parts[2] === "chunks" && request.method === "PUT") {
      const idx = Number(parts[3]);
      if (!Number.isInteger(idx) || idx < 0) return new Response("Bad chunk index.", { status: 400 });
      return withErrors(async () => {
        const data = await request.arrayBuffer();
        await stub.putChunk(idx, data);
        return json({ ok: true });
      });
    }

    // POST /rooms/:id/finalize — declares the upload complete, with how many chunks to expect.
    if (parts.length === 3 && parts[2] === "finalize" && request.method === "POST") {
      return withErrors(async () => {
        const body = (await request.json()) as { chunkCount?: number };
        if (!Number.isInteger(body.chunkCount) || (body.chunkCount as number) < 1) {
          return new Response("Bad or missing chunkCount.", { status: 400 });
        }
        await stub.finalizeUpload(body.chunkCount as number);
        return json({ ok: true });
      });
    }

    // DELETE /rooms/:id — requires the owner token from creation, in a header (never the shareable room id itself).
    if (parts.length === 2 && request.method === "DELETE") {
      return withErrors(async () => {
        const ownerToken = request.headers.get("X-Owner-Token");
        if (!ownerToken) return new Response("Missing X-Owner-Token header.", { status: 401 });
        await stub.deleteRoom(ownerToken);
        return json({ ok: true });
      });
    }

    return new Response("Not found.", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Durable Object RPC methods throw plain Errors on the failures defined in room.ts — surface those as 4xx instead of a bare 500. */
async function withErrors(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("does not exist") ? 404 : message.includes("token") ? 403 : 409;
    return json({ error: message }, status);
  }
}
