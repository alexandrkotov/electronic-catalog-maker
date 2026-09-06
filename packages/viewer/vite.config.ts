import { defineConfig } from "vite";

// See packages/editor/vite.config.ts for why sql.js must NOT be excluded
// from optimizeDeps (its CJS/UMD build needs esbuild's default-export interop
// in dev mode).
export default defineConfig(({ command }) => ({
  // Relative, not "/electronic-catalog-maker/viewer/" — this build gets
  // served from more than one place (GitHub Pages under that subpath, see
  // .github/workflows/ci.yml deploy-pages job; but also a disaster-recovery
  // static host that may serve it from a plain domain root, see
  // scripts/build-site.sh). A relative base resolves correctly under
  // either, since it's just "wherever this index.html actually is". Only
  // applied for the production build, never local dev, so
  // http://localhost:5174 keeps working exactly as the README documents.
  base: command === "build" ? "./" : "/",
}));
