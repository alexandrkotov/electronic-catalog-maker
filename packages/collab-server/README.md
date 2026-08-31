# @ecm/collab-server

The self-hosted collaboration server for real-time simultaneous editing of a
shared `.ecatm` catalog. A third distributable app alongside the editor and
viewer — whoever wants to start a shared editing session downloads and runs
one file, shares the address it shows, and stops it when they're done.

See the project's collaboration-hosting design notes for the full "why"
behind self-hosting instead of a maintainer-run default server, and the
[Implementation Plan](../../) for how this fits the rest of the feature.

## How it works

1. Run this app — a compiled binary (see below) for a real end user, or
   `bun run src/main.ts` in dev. It starts a local server and connects a
   [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
   ("quick tunnel" mode — no Cloudflare account needed), which is what makes
   `wss://` reachable from outside this machine without any router/port-
   forwarding setup or a certificate to manage.
2. It opens a status page in your default browser once the tunnel's up —
   this page *is* the app's UI (no separate desktop app window): the public
   address with a Copy button, and a **Stop** button to end the session
   without having to go find a terminal window.
3. Paste that address into the editor's **🖥️ Server settings…** dialog, then
   **Start collaboration** as usual. The link the editor hands you to share
   already carries this address (`?collab=<roomId>&server=<url>`) — a
   colleague opening it doesn't need to configure anything themselves.
4. Stop it (the status page's button, or Ctrl+C in the console window —
   either works) when you're done. The tunnel drops, the room and
   everything in it disappears — there's nothing to clean up.

**A room only lives as long as this process does.** Unlike a permanently
hosted server, stopping this app (or the host's laptop going to sleep) ends
the session for everyone connected. That trade-off was made deliberately —
see the design notes for the reasoning.

## Running it

```bash
bun install     # first time only — no other deps beyond TypeScript itself
bun run src/main.ts
```

In dev mode, this resolves `cloudflared` off your PATH (or `CLOUDFLARED_PATH`
if set) — a **compiled** binary instead has a real `cloudflared` embedded
directly inside it, nothing to install separately (see below). Either way,
if no tunnel is available the local server still starts (useful for
same-network collaborators who can already reach this machine directly) —
there's just no public address to hand out until one is.

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
| `GET /status`, `GET /status.json` | The status page main.ts auto-opens (the app's actual UI) and the JSON it polls. `POST /shutdown` is the status page's Stop button. None of these three are part of the collaboration protocol itself. |

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
bun run compile:linux-arm64    # ecm-collab-server-linux-arm64
bun run compile:macos-arm64    # ecm-collab-server-macos-arm64
bun run compile:macos-x64      # ecm-collab-server-macos-x64
bun run compile:windows-x64    # ecm-collab-server-windows-x64.exe
```

Each of these first runs `scripts/fetch-cloudflared.ts` to download the real
`cloudflared` binary for that platform into a gitignored `vendor/`
directory, then compiles a `main.compiled.<platform>.ts` entry point that
embeds it directly into the output via `bun build --compile` — the result
is genuinely one file with nothing to install separately.

A subtlety worth knowing if you touch this: a compiled executable's
`with { type: "file" }` import resolves to a *virtual* `$bunfs/...` path —
real enough for `Bun.file`/`fs` to read, but not a real filesystem entry an
OS `exec` can run, and the extracted bytes don't carry over the source
file's executable permission bit either. `embedCloudflared.ts` copies the
embedded bytes out to a genuine OS temp file and `chmod`s it before
`tunnel.ts` ever spawns it — confirmed necessary and sufficient by hand (a
naive first attempt that spawned the `$bunfs` path directly failed with
ENOENT).

**Verified for real, not just built:** downloaded a real `cloudflared` for
Linux, compiled the Linux target with it embedded, and ran the resulting
single ~120MB executable with *no* `cloudflared` installed anywhere on the
system and no `CLOUDFLARED_PATH` set — it extracted its own embedded copy,
connected a real tunnel, and relayed a real `POST /rooms` over the public
`https://*.trycloudflare.com` address. The macOS/Windows builds use the
identical mechanism but couldn't be *run* and verified from this Linux
environment — worth a real smoke test on each platform before distributing.

## Known gaps to close before real public distribution

- **Binaries are unsigned.** macOS Gatekeeper and Windows SmartScreen will
  warn on first run. See the project's collaboration-hosting design notes
  for the (deliberately deferred) signing plan — macOS isn't being pursued
  at all for now; Windows is waiting on the same Partner Center identity
  verification already in progress for the Store submissions.
- **No system-tray/menu-bar presence.** The status page is the app's real
  UI (see "How it works" above), and its Stop button plus the console
  window's Ctrl+C both actually end the session — but there's still a
  console window at all, which a genuinely zero-terminal experience (a tray
  icon, no visible window ever) would need a native app shell (Tauri or
  similar) to remove. Deliberately not built — see the design notes for why
  a bigger app framework was passed over in favor of Bun's single-binary
  compile.
- `readAll()` buffers a whole reassembled snapshot in memory before
  responding — same simplification the Durable Object version had; fine for
  realistic catalog sizes, revisit with real streaming before relying on
  this for a true multi-hundred-MB one.
