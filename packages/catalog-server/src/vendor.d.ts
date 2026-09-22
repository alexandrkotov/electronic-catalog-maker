// The various main.compiled.<platform>.ts entry points import a vendored
// cloudflared binary with `with { type: "file" }` — that resolves to a
// plain string (the file's path) at build/run time, but the file itself
// only exists after scripts/fetch-cloudflared.ts has fetched it (it's
// gitignored, not committed), so plain module resolution can't see it.
// This wildcard ambient declaration is enough for typecheck to pass
// without needing that fetch step to have run first.
declare module "../vendor/*" {
  const path: string;
  export default path;
}

// server.ts embeds packages/viewer-embed/dist/ecm-viewer.js the same way,
// for the /preview page's inline catalog viewer — that file IS committed
// (unlike vendor/), so this declaration is only for TypeScript, which
// doesn't understand import attributes' effect on the resolved type.
declare module "../../viewer-embed/dist/*" {
  const path: string;
  export default path;
}

// server.ts also embeds its own committed favicon this way, for the
// same reason — TypeScript doesn't understand what `with { type: "file" }`
// does to the resolved type.
declare module "../assets/icons/*" {
  const path: string;
  export default path;
}
