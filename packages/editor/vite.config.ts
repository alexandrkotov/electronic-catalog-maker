import { defineConfig } from "vite";

// Note: sql.js's package.json "browser" export (dist/sql-wasm-browser.js) is a
// CJS/UMD file with no real `export default`. Vite's dev pre-bundler (esbuild)
// synthesizes that default export via its CJS interop, but only if sql.js is
// NOT excluded from optimizeDeps — so don't exclude it here, even though the
// wasm binary itself is loaded separately via an explicit `?url` import.
export default defineConfig(({ command }) => ({
  // GitHub Pages serves this as a project site under /electronic-catalog-
  // maker/editor/ (see .github/workflows/ci.yml, job deploy-pages) — only
  // applied for the production build, never for local dev, so
  // http://localhost:5173 keeps working exactly as the README documents.
  base: command === "build" ? "/electronic-catalog-maker/editor/" : "/",
}));
