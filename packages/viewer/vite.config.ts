import { defineConfig } from "vite";

// See packages/editor/vite.config.ts for why sql.js must NOT be excluded
// from optimizeDeps (its CJS/UMD build needs esbuild's default-export interop
// in dev mode).
export default defineConfig(({ command }) => ({
  // GitHub Pages serves this as a project site under /electronic-catalog-
  // maker/viewer/ (see .github/workflows/ci.yml, job deploy-pages) — only
  // applied for the production build, never for local dev, so
  // http://localhost:5174 keeps working exactly as the README documents.
  base: command === "build" ? "/electronic-catalog-maker/viewer/" : "/",
}));
