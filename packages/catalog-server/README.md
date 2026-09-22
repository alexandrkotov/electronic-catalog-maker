# @ecm/catalog-server

A single-binary server that shares a folder of `.ecatm` catalog files from
your own computer — a local drive, a flash drive — with anyone who visits
its address, on your local network or (optionally) over the internet. No
upload to any hosting service, no account.

## How it works

1. Run this app — a compiled binary (see below) for a real end user, or
   `bun run src/main.ts` in dev. It opens a status page in your default
   browser (the app's whole UI — no separate window).
2. On the status page, pick the folder that has your `.ecatm` files
   (**Browse…** opens your OS's own folder dialog; if that's not available
   here, paste the path by hand instead). The page then shows the address to
   share — a local-network address by default, or switch to **Internet**
   mode to connect a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
   (same free "quick tunnel" mode `@ecm/collab-server` uses — no account,
   no port-forwarding, no certificate to manage) and get a public
   `https://*.trycloudflare.com` address instead.
3. Anyone who opens that address sees **Catalogs** — the list of `.ecatm`
   files found in the folder (subfolders included). Each one has two
   buttons:
   - **Copy URL** — the catalog file's own direct address, for pasting into
     an already-installed Editor/Viewer's "Open remote catalog…", or
     anywhere else.
   - **Preview** — opens the catalog right there in a new tab, using the
     same [`<ecm-viewer>`](../viewer-embed) component the project's own
     embedding feature ships, pointed at this same server's copy of the
     file. Always works — LAN or Internet, online or fully offline, no app
     installed required — because the preview page and the file it's
     viewing come from the same origin (see "Why not 'Open in Editor'?"
     below).
4. **Stop** on the status page ends the session (and exits the app). Run it
   again to start over — the last folder and sharing mode are remembered
   (`~/.ecm-catalog-server/config.json`), nothing to reconfigure.

## Why not "Open in Editor/Viewer" as a third button?

It was considered and deliberately dropped. A link to the *hosted* Editor/
Viewer (`https://.../?src=<catalog URL>`) only actually loads the catalog
when the visitor is on the same machine as this server, or this server is
in Internet mode — a browser's mixed-content rule blocks an `https://` page
from fetching a plain `http://<LAN-IP>:<port>` file, and that's exactly the
main scenario this app exists for (a different device, same local network,
no internet at all). Rather than a button that sometimes silently does
nothing — confusing for the non-technical audience this app targets — the
two buttons above are the ones that always behave exactly as they look.

## Folder/mode persistence

Unlike `@ecm/collab-server` (deliberately stateless — see its own README),
this app remembers the chosen folder and LAN/Internet mode across restarts,
in a small JSON file at `~/.ecm-catalog-server/config.json`. Nothing else is
read from or written to disk beyond that and the catalog files themselves
(read-only).

## Running it

```bash
bun install     # first time only
bun run src/main.ts
```

Same mixed-content caveat as collab-server applies to the "Preview" button's
one edge case: it's exempt on `http://localhost:<port>`, not on a LAN IP —
but Preview doesn't rely on that exemption at all (see above), so it's a
non-issue here in practice.

## Building a distributable binary

```bash
bun run compile:linux-x64      # ecm-catalog-server-linux-x64
bun run compile:linux-arm64    # ecm-catalog-server-linux-arm64
bun run compile:macos-arm64    # ecm-catalog-server-macos-arm64
bun run compile:macos-x64      # ecm-catalog-server-macos-x64
bun run compile:windows-x64    # ecm-catalog-server-windows-x64.exe
```

Same `bun build --compile` + embedded-`cloudflared` mechanism as
`@ecm/collab-server` (see its README for the full "why" and the
`$bunfs`/temp-file subtlety) — copied rather than shared, since it's Node/
Bun-specific code that doesn't belong in `@ecm/shared` (browser-only) and
isn't yet worth its own package for ~120 lines. This package additionally
embeds `packages/viewer-embed/dist/ecm-viewer.js` (the same way, via
`with { type: "file" }`) and serves it at `/ecm-viewer.js` for the Preview
page.

## Running the tests

```bash
bun test
```

Currently just `tunnel.test.ts`, copied from collab-server — the URL-
extraction logic is identical and untouched.

## HTTP surface

- `GET /status`, `GET /status.json`, `POST /shutdown` — the control page and
  its state/actions.
- `POST /folder/pick` — opens a native folder-picker dialog; `POST /folder`
  — sets the folder from a typed path instead.
- `POST /mode` — switches between `"lan"` and `"internet"`.
- `GET /browse` — the catalog list.
- `GET /files/<relPath>` — a catalog file's raw bytes.
- `GET /preview/<relPath>` — the inline-viewer page for one catalog.
- `GET /ecm-viewer.js` — the embedded viewer component's script.
