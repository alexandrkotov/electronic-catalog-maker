// Starts the real collaboration server for collab.mjs. Bun-only (the server
// uses Bun.serve), so it runs as its own process rather than inside node.
// Port 8791 is inside the range the editor's "Start collaboration" scans.
import { startServer } from "../collab-server/src/server";

const server = startServer(Number(process.env.COLLAB_E2E_PORT ?? 8791));
console.log(`collab server listening on ${server.port}`);
setInterval(() => {}, 1 << 30);
