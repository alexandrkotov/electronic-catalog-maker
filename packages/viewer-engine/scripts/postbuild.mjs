// After vite and tsc: put the files a host serves next to the bundle (the
// WASM sql.js needs, the PDF font) and the licenses of what is inside.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../dist");
const repo = resolve(here, "../../..");
const need = (path) => {
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return path;
};

need(resolve(dist, "index.js"));
need(resolve(dist, "server.js"));
need(resolve(dist, "style.css"));
mkdirSync(resolve(dist, "fonts"), { recursive: true });
const sqlJs = resolve(here, "../node_modules/sql.js"); // the package's own devDependency (pnpm links it here)
copyFileSync(need(resolve(sqlJs, "dist/sql-wasm.wasm")), resolve(dist, "sql-wasm.wasm"));
copyFileSync(need(resolve(repo, "packages/shared/assets/fonts/DejaVuSans.ttf")), resolve(dist, "fonts/DejaVuSans.ttf"));
copyFileSync(need(resolve(repo, "packages/shared/assets/fonts/DejaVuSans-LICENSE.txt")), resolve(dist, "fonts/DejaVuSans-LICENSE.txt"));
copyFileSync(need(resolve(repo, "LICENSE")), resolve(dist, "LICENSE"));

// index.ts imports the stylesheet only so vite emits dist/style.css; that line
// points into the source tree and means nothing to a consumer's compiler.
const indexTypes = resolve(dist, "types/viewer-engine/src/index.d.ts");
writeFileSync(indexTypes, readFileSync(indexTypes, "utf8").replace(/^import "[^"]*style\.css";\n/m, ""));
console.log("viewer-engine: dist is complete");
