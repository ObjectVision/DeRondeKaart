# Setting up a collaborative-annotation server

Provisions one **Hocuspocus (Yjs)** WebSocket server instance backing the map
app's collaborative annotation feature (shared circles + live cursors), built
from the map repo's `collab-server/` package and auto-redeployed on every push.
Automated by [`setup_collab_server.sh`](setup_collab_server.sh).

The server runs on **127.0.0.1 only** and gets **no nginx site, hostname or
certificate of its own**: map application instances expose it at a path on
their existing domain — `wss://<map-host>/collab` — by re-running
`setup_map_application.sh` with `--collab-port <port>`. The map host's
Let's Encrypt certificate then covers the WebSocket; no extra DNS record is
needed. One collab instance can serve several map apps (rooms are
client-minted UUIDs), or run one per map app on separate ports for isolation.

Annotation documents persist in SQLite, so a shared room survives everyone
disconnecting and server restarts.

> **Security model:** access to a room is capability-URL only — the
> unguessable room UUID in the share link is the key, and every holder gets
> read+write. Read `collab-server/README.md` in the map repo before exposing.

---

## What it produces

| Path | Purpose |
|---|---|
| `/srv/<slug>` | cloned map source repo (only `collab-server/` is built) |
| `/var/lib/<slug>/annotations.db` | SQLite room storage |
| `/etc/systemd/system/collab-<slug>.service` | the server daemon (`Restart=always`) |
| `/usr/local/bin/deploy-<slug>.sh` | deploy script (pull → `npm ci` → `tsc` → restart) |
| `/var/log/<slug>-deploy.log` | deploy log |
| `/etc/sudoers.d/collab-<slug>` | lets the deploy user restart the service |
| hook `deploy-<slug>` in `/etc/webhook/hooks.json` | GitHub push trigger |

Shared, installed once: nginx, git, **Node.js**, `build-essential`/`python3`
(the SQLite driver builds natively), and the webhook daemon on `127.0.0.1:9000`.

---

## Parameters

| Flag | Prompt | Default |
|---|---|---|
| `--slug NAME` | Instance slug | *(required)* |
| `--port N` | Listen port on 127.0.0.1 | `5174` |
| `--repo URL` | Git remote of the map repo | *(required)* |
| `--branch NAME` | Git branch to deploy | `main` |
| `--node-version N` | Node.js major version to install if missing | `20` |
| `--secret HEX` | GitHub webhook HMAC secret | *generated* |

---

## Process

1. **Base stack** — nginx/git/jq/rsync plus `build-essential` and `python3`.
2. **Node.js** — via NodeSource if not already present.
3. **Data directory** — `/var/lib/<slug>` (deploy user, 750).
4. **Clone + first build** — clone the map repo, `npm ci && tsc` inside
   `collab-server/`.
5. **systemd service** — `collab-<slug>` running
   `node collab-server/dist/index.js` with `PORT` and `DB_PATH` set,
   `Restart=always`; enabled and started.
6. **Deploy script** — backgrounded (`setsid -f`) pull → build → service
   restart, logging to `/var/log/<slug>-deploy.log`. A sudoers drop-in allows
   the passwordless restart.
   Builds coalesce (**run one, queue one, drop the rest**) via two `flock` locks
   under `/run`, so a burst of commits cannot pile up concurrent builds. The
   queued build re-runs `git reset --hard`, so it lands on the newest commit.
7. **Webhook** — register hook id `deploy-<slug>` with the shared daemon.

---

## After running

1. **Expose it through a map app** (idempotent re-run adds the `/collab`
   proxy location and reloads nginx):

   ```bash
   ./setup_map_application.sh -y \
     --slug woonzorglimburg_map --host map.woonzorglimburg.nl \
     --repo git@github.com:ObjectVision/northwake.git \
     --email eoudejans@objectvision.nl \
     --collab-port 5174
   ```

2. **Enable the feature in the app**: set `"annotations": true` in the
   instance's `map.json`.

3. **Connect GitHub** — the collab instance has no hostname, so point the
   webhook at any map app host: Payload URL
   `https://<map-host>/hooks/deploy-<slug>`, content type `application/json`,
   the printed secret, push events only.

Check the service with `systemctl status collab-<slug>` and
`journalctl -u collab-<slug> -f`.

---

## Examples

```bash
# Interactive
./setup_collab_server.sh

# Non-interactive
./setup_collab_server.sh -y \
  --slug woonzorglimburg_collab --port 5174 \
  --repo git@github.com:ObjectVision/northwake.git
```
