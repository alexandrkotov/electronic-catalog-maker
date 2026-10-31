import { resolve } from "node:path";
import { defineConfig } from "vite";

// The server half of the package (src/server.ts) → dist/server.js, run by
// vite after the browser build (which cleans dist/, this one must not).
// sql.js stays an import of the host's own install: its Node build reads the
// WASM itself, and a bundled copy would have lost that to the browser stubs.
// Readable on purpose — it is code to run, not to download.
export default defineConfig({
  build: {
    lib: { entry: resolve(__dirname, "src/server.ts"), formats: ["es"], fileName: () => "server.js" },
    emptyOutDir: false,
    minify: false,
    target: "es2022",
    rollupOptions: { external: ["sql.js"] },
  },
});
