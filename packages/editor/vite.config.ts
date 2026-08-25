import { defineConfig } from "vite";

// Note: sql.js's package.json "browser" export (dist/sql-wasm-browser.js) is a
// CJS/UMD file with no real `export default`. Vite's dev pre-bundler (esbuild)
// synthesizes that default export via its CJS interop, but only if sql.js is
// NOT excluded from optimizeDeps — so don't exclude it here, even though the
// wasm binary itself is loaded separately via an explicit `?url` import.
export default defineConfig({});
