import { defineConfig } from "vite";

// Same setup as the editor/viewer (see packages/editor/vite.config.ts): a
// relative base for the production build, so it works under /composer/ on
// tapalog.com and from the disaster-recovery host alike.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "./" : "/",
}));
