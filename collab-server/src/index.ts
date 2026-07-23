import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createCollabServer } from "./server.js";

/**
 * Entry point for the Hocuspocus (Yjs) WebSocket server backing collaborative
 * map annotations. All hook logic and the overload/storage guards live in
 * server.ts (createCollabServer); this file only reads env, ensures the DB
 * directory exists, listens, and starts the storage lifecycle.
 *
 * One Y.Doc per room; room names are UUIDv4 minted by the map app's share flow.
 * The unguessable UUID is the only access control (capability-URL model) — see
 * README.md for the security tradeoffs and the abuse/overload guard summary.
 *
 * Environment (limits live in config.ts):
 *   HOST     bind address (default 127.0.0.1 — never expose this port directly;
 *            nginx terminates TLS and proxies /collab. Docker sets 0.0.0.0.)
 *   PORT     listen port (default 5174)
 *   DB_PATH  SQLite file (default ./data/annotations.db)
 */

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 5174);
const database = process.env.DB_PATH ?? "./data/annotations.db";
mkdirSync(dirname(database), { recursive: true });

const { server, startStorage } = createCollabServer(database);

server.listen().then(() => {
  console.log(`collab-server listening on ${host}:${port} (db: ${database})`);
  startStorage();
});
