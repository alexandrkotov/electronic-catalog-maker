import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: { exclude: ["sql.js"] },
});
