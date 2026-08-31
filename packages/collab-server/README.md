# @ecm/collab-server

The self-hosted collaboration server for real-time simultaneous editing of a
shared `.ecatm` catalog. A third distributable app alongside the editor and
viewer — whoever wants to start a shared editing session runs this on their
own machine, shares the address it prints, and closes it when they're done.

See the project's collaboration-hosting design notes for the full "why"
behind self-hosting instead of a maintainer-run default server, and the
[Implementation Plan](../../) for how this fits the rest of the feature.

## How it works

1. Run this app (`bun run src/main.ts` in dev, or a compiled binary — see
   below). It starts a local server and connects a
   [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
   ("quick tunnel" mode — no Cloudflare account needed), which is what makes
   `wss://` reachable from outside this machine without any router/port-
   forwarding setup or a certificate to manage.
2. It opens a small status page in your default browser once the tunnel's
   up, showing the public address with a Copy button.
3. Paste that address into the editor's **⚙️ Server settings…** dialog, then
   **Start collaboration** as usual. The link the editor hands you to share
   already carries this address (`?collab=<roomId>&server=<url>`) — a
   colleague opening it doesn't need to configure anything themselves.
4. Close this app when you're done. The tunnel drops, the room and
   everything in it disappears — there's nothing to clean up.

**A room only lives as long as this process does.** Unlike a permanently
hosted server, closing this app (or the host's laptop going to sleep) ends
the session for everyone connected. That trade-off was made deliberately —
see the design notes for the reasoning.

## Running it

```bash
bun install     # first time only — no other deps beyond TypeScript itself
bun run src/main.ts
```

Requires [`cloudflared`](https://github.com/cloudflare/cloudflared/releases)
on your PATH (or point `CLOUDFLARED_PATH` at wherever you put it). Without
it, the local server still starts (useful for same-network collaborators
who can already reach this machine directly), but there's no public address
to hand out.

Override the local port with `PORT` (default `8787`, matching the editor's
own default in Server settings).

## HTTP + WebSocket surface

Identical to what earlier phases built against a Cloudflare Durable Object
— kept byte-for-byte the same on purpose so the editor's client code
(`collab.ts`/`main.ts`) needed zero changes when this package was rewritten
onto a plain self-hosted server; only the base URL it's pointed at changed.

| | |
|---|---|
| `POST /rooms` | Creates a room. Returns `{ roomId, ownerToken, createdAt }`. `roomId` is shareable; `ownerToken` is not — it's the only thing `DELETE` accepts. |
| `PUT /rooms/:id/chunks/:idx` | Uploads one piece of the snapshot (raw bytes as the body). Chunks can arrive in any order. |
| `POST /rooms/:id/finalize` | Body `{ "chunkCount": N }` — declares the upload done, after every chunk has landed. |
| `GET /rooms/:id` | The full reassembled snapshot, once finalized (409 before that). |
| `GET /rooms/:id/info` | `{ exists, uploadComplete, chunkCount, totalBytes }`, without pulling the snapshot itself. |
| `GET /rooms/:id/live` | Upgrades to the WebSocket used for live editing — relays an incoming op to every other connected client and logs it. |
| `GET /rooms/:id/ops?since=N` | Every op logged after seq N — how a fresh joiner or reconnecting client catches up. |
| `DELETE /rooms/:id` | Requires `X-Owner-Token: <ownerToken>`. Wrong or missing token → 401/403. |
| `GET /status`, `GET /status.json` | The human-friendly status page main.ts auto-opens, and the JSON it polls. Not part of the collaboration protocol itself. |

## Running the tests

Runs under Bun's own built-in test runner (no extra test framework needed):

```bash
bun test
```

Spins up a real instance of this server on an ephemeral local port for each
test and drives it with real `fetch`/`WebSocket` calls — no mocking of the
runtime. `tunnel.test.ts` unit-tests just the URL-parsing logic against a
captured real `cloudflared` output sample, without spawning the actual
binary.

## Building a distributable binary

```bash
bun run compile:linux-x64      # ecm-collab-server-linux-x64
bun run compile:macos-arm64    # ecm-collab-server-macos-arm64
bun run compile:macos-x64      # ecm-collab-server-macos-x64
bun run compile:windows-x64    # ecm-collab-server-windows-x64.exe
```

Each produces a single native executable via `bun build --compile` — no
Node/Bun install required on the machine running it. Verified working on
Linux from this environment (the compiled binary starts, listens, and
serves `/status` with no runtime installed alongside it); the macOS/Windows
builds use the same well-established `bun build --compile` mechanism but
couldn't be *run* and verified from this Linux sandbox — worth a real smoke
test on each platform before distributing.

## Known gaps to close before real public distribution

- **`cloudflared` isn't bundled into the compiled binary yet** — right now
  it must already be installed separately and on PATH (or pointed at via
  `CLOUDFLARED_PATH`). The plan is to fetch the correct platform binary at
  build time into a gitignored `vendor/` directory and embed it into the
  compiled executable via Bun's `with { type: "file" }` import (so it
  extracts to a temp file and gets spawned from there) — keeping the "one
  file to download" promise instead of shipping a second binary alongside.
  Not yet implemented; large per-platform binaries aren't checked into this
  repo, and a fetch-at-build-time step needs a place to actually run it
  (this repo's CI, or a release workflow) before it's real.
- **Binaries are unsigned.** macOS Gatekeeper and Windows SmartScreen will
  warn on first run. See the project's collaboration-hosting design notes
  for the (deliberately deferred) signing plan — macOS isn't being pursued
  at all for now; Windows is waiting on the same Partner Center identity
  verification already in progress for the Store submissions.
- `readAll()` buffers a whole reassembled snapshot in memory before
  responding — same simplification the Durable Object version had; fine for
  realistic catalog sizes, revisit with real streaming before relying on
  this for a true multi-hundred-MB one.
