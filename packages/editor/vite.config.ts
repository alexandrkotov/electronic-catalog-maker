import { defineConfig } from "vite";

// Note: sql.js's package.json "browser" export (dist/sql-wasm-browser.js) is a
// CJS/UMD file with no real `export default`. Vite's dev pre-bundler (esbuild)
// synthesizes that default export via its CJS interop, but only if sql.js is
// NOT excluded from optimizeDeps — so don't exclude it here, even though the
// wasm binary itself is loaded separately via an explicit `?url` import.
export default defineConfig(({ command }) => ({
  // Relative, not "/electronic-catalog-maker/editor/" — this build gets
  // served from more than one place (GitHub Pages under that subpath, see
  // .github/workflows/ci.yml deploy-pages job; but also a disaster-recovery
  // static host that may serve it from a plain domain root, see
  // scripts/build-site.sh). A relative base resolves correctly under
  // either, since it's just "wherever this index.html actually is". Only
  // applied for the production build, never local dev, so
  // http://localhost:5173 keeps working exactly as the README documents.
  base: command === "build" ? "./" : "/",
}));
