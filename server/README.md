# northwake — server provisioning

Automated, **multi-instance** provisioning for the three services that run on the
production VM (`cicada@37.97.169.242`):

| Service | Script | Description doc |
|---|---|---|
| Hugo landing page | [`setup_landing_page.sh`](setup_landing_page.sh) | [setup_landing_page.md](setup_landing_page.md) |
| Geospatial file server | [`setup_fileserver.sh`](setup_fileserver.sh) | [setup_fileserver.md](setup_fileserver.md) |
| React/Vite map application | [`setup_map_application.sh`](setup_map_application.sh) | [setup_map_application.md](setup_map_application.md) |

All three source [`common.sh`](common.sh) for shared helpers.

## Multi-instance model

Every service is provisioned as a named **instance** identified by a `--slug`.
Nothing is hard-coded to `woonzorglimburg`, so you can run any number of landing
pages, file servers and map apps side by side on one host. Each instance owns its
own namespace:

```
/srv/<slug>                         cloned git repo        (landing + map)
/var/www/<slug>                     nginx webroot / data root
/etc/nginx/sites-available/<slug>   nginx server block     (+ symlink enabled)
/usr/local/bin/deploy-<slug>.sh     deploy script          (landing + map)
/var/log/<slug>-deploy.log          deploy log             (landing + map)
hook id "deploy-<slug>"             entry in /etc/webhook/hooks.json (landing + map)
```

Shared infrastructure is installed once and reused by every instance:

- **nginx**, **git**, **jq**, **rsync**, **certbot**
- the **adnanh/webhook** daemon on `127.0.0.1:9000`; each instance adds/updates
  only *its own* entry in `hooks.json` (never touching the others) and restarts
  the daemon so the change is picked up
- `/etc/nginx/conf.d/geo-mime.conf` (geospatial MIME types, used by file servers)

## Running

Copy this `server/` directory to the target host and run a script there as a user
with passwordless sudo (e.g. `cicada`). Each script either **prompts** for the
values it needs, or takes them as **flags** — any value passed as a flag is not
prompted for. `-y`/`--yes` runs fully non-interactively using defaults.

```bash
# interactive
./setup_landing_page.sh

# fully non-interactive
./setup_map_application.sh -y \
  --slug woonzorglimburg_map --host map.woonzorglimburg.nl \
  --repo git@github.com:ObjectVision/northwake.git \
  --email eoudejans@objectvision.nl
```

Each script prints its own `--help`.

## Prerequisites

- Ubuntu 22.04+ / Debian 11+ (validated on Ubuntu 26.04, nginx 1.28).
- DNS **A records** for every hostname pointing at the server *before* running, so
  certbot can issue certificates. Verify with `dig +short <host>`. Use `--no-tls`
  to defer TLS and serve plain HTTP for now.
- For private git repos, an SSH deploy key on the server (see the per-service docs).

Re-running a script is safe (idempotent): it updates the repo, rebuilds, rewrites
the nginx site (backing up the old one), refreshes the webhook entry, and renews
the certificate.
