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

Or via the repo's `docker-compose.yml` (`collab` service), or provisioned on a
bare host with `../server/setup_collab_server.sh` (systemd unit + nginx proxy
location via `setup_map_application.sh --collab-port`).

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
  read-only mode); rooms never expire, so a leaked link stays valid
  indefinitely; author names are unverified pseudonyms; the SQLite file is
  plaintext, readable by the server admin. There is no per-room deletion or
  garbage collection — the database grows with every room ever created.
- **Hardening path (not implemented):** an `onAuthenticate` token next to the
  UUID (read-only vs edit links, revocation) and TTL-based room cleanup.
