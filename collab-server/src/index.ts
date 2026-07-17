import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";

/**
 * Hocuspocus (Yjs) WebSocket server for collaborative map annotations.
 *
 * One Y.Doc per room; room names are UUIDv4 minted by the map app's share
 * flow. The unguessable UUID is the only access control (capability-URL
 * model) — see README.md for the security tradeoffs. Documents persist in
 * SQLite so a share link keeps working after everyone disconnects.
 *
 * Environment:
 *   PORT     listen port (default 5174)
 *   DB_PATH  SQLite file (default ./data/annotations.db)
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const port = Number(process.env.PORT ?? 5174);
const database = process.env.DB_PATH ?? "./data/annotations.db";
mkdirSync(dirname(database), { recursive: true });

const server = new Server({
  port,
  extensions: [new SQLite({ database })],
  async onConnect({ documentName }) {
    // Anything that isn't a UUID room id is rejected — no probing arbitrary
    // document names, and no accidental cross-app doc collisions.
    if (!UUID_RE.test(documentName)) {
      throw new Error(`Invalid room id: ${documentName}`);
    }
  },
});

server.listen().then(() => {
  console.log(`collab-server listening on :${port} (db: ${database})`);
});
