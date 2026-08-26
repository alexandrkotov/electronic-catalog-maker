import { resolve } from "node:path";
import { defineConfig } from "vite";

// See packages/editor/vite.config.ts for why sql.js must NOT be excluded
// from optimizeDeps (its CJS/UMD build needs esbuild's default-export
// interop in dev mode).
//
// build.lib + formats: ["iife"] is the whole point of this package: a
// single self-contained script a page can load with a plain
// <script src="...">, no `type="module"`, no bundler on the consuming
// site's end — see README "Embedding the viewer".
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/ecm-viewer.ts"),
      name: "EcmViewer",
      formats: ["iife"],
      fileName: () => "ecm-viewer.js",
    },
    // Vite's lib mode inlines the sql.js WASM binary as base64 directly
    // into ecm-viewer.js (there's no index.html for a separate asset file
    // to be relative *to*) — the output ends up ~950KB (~430KB gzipped),
    // but genuinely one file, nothing else to host or path-resolve.
  },
});
