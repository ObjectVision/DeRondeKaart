# Setting up a map application

Provisions one **React/Vite** map-application instance behind nginx, built from a
GitHub repo and auto-redeployed on every push to a branch. Automated by
[`setup_map_application.sh`](setup_map_application.sh).

The SPA is **embeddable by default** (open framing + open CORS) so it can be
dropped into websites and dashboards such as Power BI, matching the project goal
in `CLAUDE.md`.

Any number of map apps can run on the same host — each is identified by a `--slug`
and served on its own hostname. See [README.md](README.md) for the shared
multi-instance model.

---

## What it produces

| Path | Purpose |
|---|---|
| `/srv/<slug>` | cloned Vite/React source repo |
| `/var/www/<slug>` | nginx webroot (built `dist/`) |
| `/etc/nginx/sites-available/<slug>` | nginx server block (symlinked into `sites-enabled/`) |
| `/usr/local/bin/deploy-<slug>.sh` | deploy script (pull → `npm ci` → `vite build` → rsync) |
| `/var/log/<slug>-deploy.log` | deploy log |
| hook `deploy-<slug>` in `/etc/webhook/hooks.json` | GitHub push trigger |

Shared, installed once: nginx, git, **Node.js**, the webhook daemon on
`127.0.0.1:9000`, and (unless `--no-tls`) a Let's Encrypt certificate.

---

## Notable nginx / deploy behaviour

- **SPA fallback** — unknown URLs serve `/index.html` so the React router handles
  routing client-side.
- **Immutable assets** — `^~ /assets/` (hashed Vite output) is cached one year,
  `Cache-Control: public, immutable`.
- **Embeddable** — by default no framing header is set, so the app can be iframed
  anywhere; pass `--frame-ancestors "'self' https://foo.nl"` to lock framing with
  a CSP `frame-ancestors` directive. `Access-Control-Allow-Origin *` is set.
- **Deploy resilience** — the deploy script backgrounds the work with `setsid -f`
  so the webhook answers within GitHub's 10 s timeout. A **non-blocking** `tsc -b`
  logs type errors without aborting; only a genuine `vite build` failure aborts,
  so a broken/empty `dist` is never published.

---

## Parameters

| Flag | Prompt | Default |
|---|---|---|
| `--slug NAME` | Instance slug | *(required)* |
| `--host HOST` | Hostname | *(required)* |
| `--repo URL` | Git remote of the Vite/React source | *(required)* |
| `--branch NAME` | Git branch to deploy | `main` |
| `--node-version N` | Node.js major version to install if missing | `20` |
| `--frame-ancestors V` | CSP `frame-ancestors` value | *(blank — embeddable anywhere)* |
| `--secret HEX` | GitHub webhook HMAC secret | *generated* |
| `--email ADDR` | Let's Encrypt email | *(required unless `--no-tls`)* |
| `--no-tls` | Serve plain HTTP, skip certbot | off |

---

## Process

1. **Base stack** — install nginx/git/jq/rsync; enable nginx.
2. **Node.js** — install the requested Node major version via NodeSource if `node`
   is not already present.
3. **Directories** — create `/srv/<slug>` (deploy user) and `/var/www/<slug>`
   (`<user>:www-data`, 755).
4. **Clone + first build** — clone the repo, `npm ci`, `vite build`, and
   `rsync -a --delete dist/ /var/www/<slug>/`.
5. **Deploy script** — write the backgrounded `/usr/local/bin/deploy-<slug>.sh`
   described above, logging to `/var/log/<slug>-deploy.log`.
6. **Webhook** — ensure the shared webhook daemon exists, then **generate/register
   the HMAC secret** as hook id `deploy-<slug>` (other instances' hooks untouched;
   the daemon is restarted so it re-reads `hooks.json`).
7. **nginx** — write and enable the SPA server block (fallback, asset caching,
   `/hooks/` proxy, framing/CORS headers, gzip).
8. **TLS** — `certbot --nginx --redirect` for the host, unless `--no-tls`.
9. **Output** — print the GitHub webhook settings, **including the secret**.

---

## After running: connect GitHub

On the source repo, **Settings → Webhooks → Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `https://<host>/hooks/deploy-<slug>` |
| Content type | `application/json` |
| Secret | *the secret printed by the script* |
| Events | Just the push event |

Push to the tracked branch and watch `tail -f /var/log/<slug>-deploy.log`. The
webhook returns immediately; the build finishes in the background a few minutes
later.

For **private repositories**, add a deploy key first (see the same section in
[setup_landing_page.md](setup_landing_page.md#private-repositories)).

---

## Examples

```bash
# Interactive
./setup_map_application.sh

# Non-interactive, matching the current production instance
./setup_map_application.sh -y \
  --slug woonzorglimburg_map --host map.woonzorglimburg.nl \
  --repo git@github.com:ObjectVision/northwake.git \
  --email eoudejans@objectvision.nl

# A second map app, framing locked to one parent site
./setup_map_application.sh -y \
  --slug acme_map --host map.acme.com \
  --repo git@github.com:acme/map.git \
  --frame-ancestors "'self' https://acme.com" \
  --email ops@acme.com
```
