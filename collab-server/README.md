# collab-server

Hocuspocus (Yjs) WebSocket server backing the map app's **collaborative
annotation** feature: shared circles + titles/descriptions synced through a
Y.Doc per room, live cursors via the Yjs Awareness protocol.

## How it fits

- The map app (with `"annotations": true` in `map.json`) mints a **UUIDv4 room
  id** when a user shares an annotation session; the link carries it as
  `#annot=<uuid>`.
- Recipients' browsers connect to `wss://<map-host>/collab` — nginx proxies
  that path to this server on `127.0.0.1:$PORT`. The server never gets its own
  hostname; the map host's TLS certificate covers the WebSocket.
- Documents persist in SQLite (`@hocuspocus/extension-sqlite`), so a room
  survives everyone disconnecting and a server restart.

## Running

```bash
npm ci
npm run build
PORT=5174 DB_PATH=./data/annotations.db npm start
```

Or provisioned on a bare host with `../server/setup_collab_server.sh` (systemd
unit + nginx proxy location via `setup_map_application.sh --collab-port`).

## Security model (v1 — read before exposing)

Access control is the **capability-URL model**: the unguessable room UUID in
the share link is the only key. Concretely:

- UUIDv4 = 122 random bits; brute-forcing over the WebSocket is infeasible.
  `onConnect` rejects any non-UUID document name, and there is **no endpoint
  that lists rooms**.
- The room id travels in the URL **hash fragment**, which browsers never send
  in HTTP requests — it stays out of nginx access logs and Referer headers.
  Hocuspocus carries the document name inside the (TLS-encrypted) WebSocket
  messages, not the connection URL.
- **Accepted limitations:** anyone holding the link has full read+write (no
  read-only mode); author names are unverified pseudonyms; the SQLite file is
  plaintext, readable by the server admin.
- **Hardening path (not implemented):** an `onAuthenticate` token next to the
  UUID (read-only vs edit links, revocation).

## Abuse & overload guards

Because access is just possession of the room UUID (no per-user auth) and a
client can call the Yjs API directly — bypassing every browser-side throttle —
all enforcement is **server-side**. The guards live in a Hocuspocus extension
(`src/guard-extension.ts`) plus a storage-lifecycle module (`src/storage.ts`);
every limit is env-tunable with a safe, finite default (`src/config.ts`).

| Guard | What it does | Env (default) |
|---|---|---|
| **Doc-size cap** | Rejects persisting a room whose encoded Y.Doc exceeds the cap — the single check that bounds per-room storage growth regardless of cause. | `MAX_DOC_BYTES` (2 MB) |
| **Content caps** | Per-room annotation count, `title`/`description` length, polygon vertex count, and embedded-snapshot size. | `MAX_ANNOTATIONS` (300), `MAX_TITLE_LEN` (200), `MAX_DESC_LEN` (2000), `MAX_POLY_POINTS` (500), `MAX_SNAPSHOT_BYTES` (128 KB) |
| **Flood limiter** | Per-connection sliding window on inbound bytes + message count; a breach closes the socket (protects the event loop from synchronous SQLite writes). | `RATE_WINDOW_MS` (10 s), `RATE_MAX_BYTES_PER_WINDOW` (8 MB), `RATE_MAX_MSGS_PER_WINDOW` (2000) |
| **Room TTL + GC** | A sidecar `room_activity` table records last write; a periodic job deletes rooms idle past the TTL (skipping any currently connected) and `VACUUM`s so the file actually shrinks. | `ROOM_TTL_DAYS` (90), `GC_INTERVAL_MS` (1 day) |
| **Size monitoring** | Logs a warning when the SQLite file exceeds a threshold. | `DB_SIZE_WARN_BYTES` (512 MB) |

**Ordering note (important if you touch the store path):** the size/content
validation is an extension with a high `priority` so its `onStoreDocument` runs
*before* the SQLite persistence extension — throwing there aborts the write. A
server-config `onStoreDocument` would run *after* SQLite (config hooks are
appended last), so SQLite would already have written the bad document.

Defaults are safe if unset. To change a value in production, set the env var on
the service (a systemd `Environment=` line) — see below. `npm test` covers the validators, the flood limiter, the TTL GC, and
an end-to-end "oversized room is not persisted" check.
