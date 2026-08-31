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
   without having to go find a terminal window. On Windows, the compiled
   binary runs with no console window at all (`--windows-hide-console`) —
   the status page is the *only* UI; Ctrl+C isn't an option there since
   there's nothing to Ctrl+C. Linux/macOS builds still show a plain console
   (Ctrl+C works there too, as a second way to stop it).
3. In the editor, click **🤝 Start collaboration** as usual — no separate
   address to paste in anywhere. The editor auto-detects a running copy of
   this app on the local ports it might plausibly be using (see "Port
   auto-detection" below) and picks up its public address on its own. The
   link it hands you to share carries that address (`?collab=<roomId>&
   server=<url>`) — a colleague opening it doesn't need to configure
   anything themselves either. If nothing's found, the editor shows a
   plain-language "can't find a collaboration server" prompt instead of a
   raw connection error, with a manual-address field as a fallback for the
   rare case this app is running somewhere auto-detection can't reach (a
   different computer, or a custom `PORT`).
4. Stop it (the status page's Stop button, or Ctrl+C where there's a
   console) when you're done. The tunnel drops, the room and everything in
   it disappears — there's nothing to clean up. If the status page tab gets
   closed by accident before you're done, ending the process from Task
   Manager (Windows) / Activity Monitor (macOS) / your process manager of
   choice (Linux) — look for `ecm-collab-server-*` — is the fallback; there's
   no way to reopen the same status page instance once its tab is gone.

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
if no tunnel is available the local server still starts and stays usable —
but only for the host's *own* browser tab pointed at `http://127.0.0.1:
<port>`. That specific address is exempt from browsers' mixed-content
block even though the public editor is `https://` (a long-standing
exception for local development); a *colleague's own machine* on the same
network is not exempt, and their editor pointed at your LAN IP (e.g.
`http://192.168.1.50:8787`) will get silently blocked by their browser. To
collaborate over a LAN with no tunnel/public address at all,
everyone — including the host — needs to load the editor itself from a
plain `http://` copy served on that same LAN too (not the public `https://`
site), since `ws://` from an `http://` page is never mixed content.

## Fully offline / LAN-only collaboration (no tunnel, no public address)

Possible, but it means self-hosting the *editor* on the LAN as well, not
just this server — the public `https://` editor can never reach a LAN-only
address due to the mixed-content rule above, no matter what this server
does. In short: serve `packages/editor/dist` (a `pnpm --filter @ecm/editor
build` output) over plain `http://` from anywhere reachable on that LAN
(a simple static file server is enough), and have everyone — including the
host — open the editor from that address rather than the public site.
Genuinely appealing for anyone who doesn't want *any* traffic leaving their
own network (a real motivation for self-hosting in the first place — see
the design notes), but a full walkthrough for this isn't written yet.

## Port auto-detection

Override the local port with `PORT` (default `8787`, matching the
editor's own default auto-detect starting point). If that port's already
taken:

- By **another copy of this same app** (e.g. launched twice by accident)
  — it just opens that instance's already-running status page instead of
  erroring, and doesn't start a second server.
- By **anything else** — it tries the next few ports in sequence
  (`8788`, `8789`, … 9 tries past the requested one) before falling back
  to a fully random one. This range isn't arbitrary: it's exactly what
  the editor's own auto-detect probes (see `packages/editor/src/main.ts`,
  `COLLAB_AUTO_DETECT_PORT_COUNT` — keep the two in sync if either
  changes), since a browser page has no way to scan for a truly random
  port. Land outside that range (every one of those nine also busy, a
  rare case) and the editor's "can't find a collaboration server"
  dialog's manual-address field is the fallback.

Confirmed by hand, not just in theory: started two copies pointed at the
same port (second one opened the first's page, didn't start a second
server); started this app against a port held by an unrelated process
with two more ports past it also occupied (it correctly skipped both and
landed on the third free one); and confirmed the editor's own auto-detect
found a server in exactly that scenario, end to end.

**Not permanently coupled to Cloudflare's free tunnel, either.** It's a
real (if unlikely) dependency risk — Cloudflare's own docs say this
anonymous "quick tunnel" mode carries no uptime guarantee — so the tunnel
command and how this app recognizes a provider's public URL are both
overridable:

- `TUNNEL_COMMAND` — a full command to run instead of the default
  `cloudflared tunnel --url http://localhost:<port>`; write `{port}` where
  the local port belongs, e.g. `TUNNEL_COMMAND="ngrok http {port}"`.
- `TUNNEL_URL_PATTERN` — a regex (as a plain string) matching that
  provider's public URL shape, since the default only recognizes
  `*.trycloudflare.com`.

Confirmed working for real, not just plausible in theory: ran this app
with `TUNNEL_COMMAND` pointed at a `cloudflared` binary outside its normal
`CLOUDFLARED_PATH`/embedded lookup entirely, and it picked up and used that
exact override to get a real public tunnel.

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
`https://*.trycloudflare.com` address. The Windows build was cross-compiled
from this same Linux environment and then actually run by the project's
maintainer on a real Windows machine — a real SmartScreen warning bypassed,
a real `trycloudflare.com` address, a real two-tab collaboration session
including the Stop button, confirmed working end to end. The macOS build
uses the identical mechanism but hasn't been run on a real Mac yet — worth
a real smoke test there before distributing.

`--windows-hide-console` (see the compile script) runs the Windows build
with no console window at all — confirmed by inspecting the compiled
binary directly (`file` reports "PE32+ ... (GUI)" instead of "(console)"),
not just by trusting the flag's documentation. The Windows-only metadata
flags (`--windows-title`, `--windows-publisher`, `--windows-icon`, etc.)
were tried too, but Bun refuses them when cross-compiling from a non-
Windows host ("only available when compiling on Windows") — left out of
`compile:windows-x64` for that reason; worth adding back if this package's
build ever runs on native Windows (e.g. a `windows-latest` CI runner).

## Known gaps to close before real public distribution

- **Binaries are unsigned.** macOS Gatekeeper and Windows SmartScreen will
  warn on first run. See the project's collaboration-hosting design notes
  for the (deliberately deferred) signing plan — macOS isn't being pursued
  at all for now; Windows is waiting on the same Partner Center identity
  verification already in progress for the Store submissions.
- **No system-tray/menu-bar presence.** The status page is the app's real
  UI (see "How it works" above); Windows already has no console window at
  all (`--windows-hide-console`), so there it's *already* a genuinely
  single-window experience. Linux/macOS builds still show a plain console
  alongside the status page — `bun build --compile` has no equivalent
  hide-console flag for those platforms, and going further (a tray icon, no
  window anywhere, on every platform) would need a native app shell (Tauri
  or similar) instead of Bun's single-binary compile. Deliberately not
  built — see the design notes for why that bigger framework was passed
  over.
- `readAll()` buffers a whole reassembled snapshot in memory before
  responding — same simplification the Durable Object version had; fine for
  realistic catalog sizes, revisit with real streaming before relying on
  this for a true multi-hundred-MB one.
