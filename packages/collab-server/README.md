# @ecm/collab-server

Phase 1 of the simultaneous-editing plan: the backend foundation for a shared
editing session ("room"). One Cloudflare Durable Object per room, each with
its own private SQLite storage. This phase only proves the mechanism — a
room can be created, a catalog snapshot uploaded into it in pieces (so a
400MB+ catalog never needs a single oversized request), and the whole thing
read back out. No live editing yet; that's Phase 2.

See the full design and phased plan in the project's
`Simultaneous SQLite editing/` notes (Implementation Plan, both languages)
for how this fits into the rest of the feature.

## HTTP surface

| | |
|---|---|
| `POST /rooms` | Creates a room. Returns `{ roomId, ownerToken, createdAt }`. `roomId` is shareable; `ownerToken` is not — it's the only thing `DELETE` accepts. |
| `PUT /rooms/:id/chunks/:idx` | Uploads one piece of the snapshot (raw bytes as the body). Chunks can arrive in any order. |
| `POST /rooms/:id/finalize` | Body `{ "chunkCount": N }` — declares the upload done, after every chunk has landed. |
| `GET /rooms/:id` | The full reassembled snapshot, once finalized (409 before that). |
| `GET /rooms/:id/info` | `{ exists, uploadComplete, chunkCount, totalBytes }`, without pulling the snapshot itself. |
| `DELETE /rooms/:id` | Requires `X-Owner-Token: <ownerToken>`. Wrong or missing token → 401/403. |

## Running the tests

No Cloudflare account needed — `@cloudflare/vitest-plugin` runs everything
against a real local `workerd`:

```bash
pnpm --filter @ecm/collab-server test
```

## Deploying for real (not done yet — needs a human)

This was built and tested entirely from an environment with no Cloudflare
credentials, so none of the following has actually been run against the
real platform:

1. `wrangler login` (needs a browser).
2. Pick a real `name` in `wrangler.jsonc` — `ecm-collab-server` is a
   placeholder.
3. Bump `compatibility_date` to something current — it's set conservatively
   in the past on purpose (a date guaranteed to already exist).
4. Double-check the `durable_objects`/`migrations` block in `wrangler.jsonc`
   against [Cloudflare's current Durable Objects docs](https://developers.cloudflare.com/durable-objects/) —
   the config format for declaring a new SQLite-backed class has been
   evolving on Cloudflare's side, and this was written from documentation,
   not verified against a real deploy.
5. `pnpm --filter @ecm/collab-server deploy`.

## Known simplification to revisit before real 400MB+ catalogs

`readAll()` reassembles every chunk into one in-memory buffer before
responding. Fine for proving the mechanism and for realistic small/medium
catalogs; a true multi-hundred-MB one should stream chunks straight into the
response instead of buffering the whole thing in the Durable Object's memory
first.
