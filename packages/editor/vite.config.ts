import { defineConfig } from "vite";

export default defineConfig({
  // sql.js ships its own wasm binary that we load via an explicit ?url import,
  // so it doesn't need to go through esbuild's dependency pre-bundling.
  optimizeDeps: { exclude: ["sql.js"] },
});
