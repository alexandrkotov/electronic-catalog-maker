import { defineConfig } from "vite";

// See packages/editor/vite.config.ts for why sql.js must NOT be excluded
// from optimizeDeps (its CJS/UMD build needs esbuild's default-export interop
// in dev mode).
export default defineConfig({});
