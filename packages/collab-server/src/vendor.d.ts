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
