import { resolve } from "node:path";
import { defineConfig } from "vite";

// The engine as an ES module for a host application (Tapalog Reader and
// the like) to bundle or serve as it is: no bare imports in the output, so
// the files work straight from a folder. sql.js is bundled in; its WASM is
// not — the host serves dist/sql-wasm.wasm and passes the URL as `wasmUrl`.
// The PDF writer (pdf-lib and its font engine, over a megabyte) is a
// separate chunk that only loads when an export is asked for (src/pdf.ts).
// See packages/viewer-embed for the other build of the same engine: one
// self-contained script for <ecm-viewer>.
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "style",
    },
    target: "es2022",
    cssCodeSplit: false,
    rollupOptions: {
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
