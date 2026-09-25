# northwake — server provisioning

Automated, **multi-instance** provisioning for the three services that run on the
production VM (`cicada@37.97.169.242`):

| Service | Script | Description doc |
|---|---|---|
| Hugo landing page | [`setup_landing_page.sh`](setup_landing_page.sh) | [setup_landing_page.md](setup_landing_page.md) |
| Geospatial file server | [`setup_fileserver.sh`](setup_fileserver.sh) | [setup_fileserver.md](setup_fileserver.md) |
| SolidJS/Vite map application | [`setup_map_application.sh`](setup_map_application.sh) | [setup_map_application.md](setup_map_application.md) |
| Collaborative-annotation server | [`setup_collab_server.sh`](setup_collab_server.sh) | [setup_collab_server.md](setup_collab_server.md) |

All scripts source [`common.sh`](common.sh) for shared helpers.

The collab server is the odd one out: it listens on `127.0.0.1:<port>` only
and has no nginx site or hostname — map app instances expose it at
`wss://<map-host>/collab` via `setup_map_application.sh --collab-port <port>`.

A fifth service lives in a different repo and follows the same localhost-only
pattern: the **Power BI embed-token service**
(`service_principal/setup_service_principal.sh` in `DeRondeKaart_powerbi`),
which landing pages expose at `https://<landing-host>/api/embed-config` via
`setup_landing_page.sh --embed-port <port>`. That repo carries its own copy of
`common.sh`; this one is canonical, so fix shared helpers here first.

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
/etc/nginx/.htpasswd-<slug>         basic-auth users       (map, --auth-user only)
```

The map app runs as **one instance** for this project, serving both config
variants; the two landing pages each embed their own:

| slug | host | builds / branch | embeds |
|---|---|---|---|
| `woonzorglimburg_map` | `map.woonzorglimburg.nl` | `configs/woonzorglimburg/` (variants `publiek`, `ontwikkel`), `main` | — |
| `woonzorglimburg_landing_publiek` | `woonzorglimburg.nl` | landing repo `main` | map, `?variant=publiek` |
| `woonzorglimburg_landing_ontwikkel` | *(not documented; see the nginx site on the server)* | landing repo `ontwikkel` | map, `?variant=ontwikkel` |

All are public: the staging (`ontwikkel`) variant is served by the same site as
`publiek`, so it cannot be put behind basic auth — see `configs/README.md`.
Until September 2026 staging was a separate, password-protected map instance
(`woonzorglimburg_map_dev`, `map.dev.woonzorglimburg.nl`).

The ontwikkel landing's host name is deliberately kept out of this repository.

`dev.woonzorglimburg.nl` is retired and deliberately **not** redirected to its
successor; no site serves it. Names no site serves are refused at the TLS
handshake by the `000_catch_all` default server, rather than answered with
another site's certificate.

**woonzorglimburg.nl is in maintenance** (`woonzorglimburg_maintenance`, a 503 page
that also proxies `/hooks/`, so pushes to `main` still deploy the landing).
`woonzorglimburg_landing_publiek` is provisioned but its site is **not enabled and
has no 443 block**: certbot installed its certificate (`woonzorglimburg.nl-0001`)
into the maintenance site, the one holding the domain at the time. To go live,
do not just symlink it — re-run the setup instead, which installs TLS into it:

```bash
sudo rm /etc/nginx/sites-enabled/woonzorglimburg_maintenance && sudo systemctl reload nginx
./setup_landing_page.sh -y --slug woonzorglimburg_landing_publiek \
  --host woonzorglimburg.nl --alias www.woonzorglimburg.nl \
  --repo git@github.com:ObjectVision/woonzorglimburg_landing.git --branch main \
  --embed-host https://map.woonzorglimburg.nl --embed-host https://app.powerbi.com \
  --embed-port 5176 --secret <its current hook secret> --email info@objectvision.nl
```

Pass the current secret (from `/etc/webhook/hooks.json`), or the GitHub webhook
stops validating.

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
- DNS **AAAA records** — see [IPv6](#ipv6) below. Not required for the scripts to
  run, but their absence is a hard failure in security scans (internet.nl).
- For private git repos, an SSH deploy key on the server (see the per-service docs).

Re-running a script is safe (idempotent): it updates the repo, rebuilds, rewrites
the nginx site (backing up the old one), refreshes the webhook entry, and renews
the certificate.

## Security posture

The scripts emit these automatically (see `common.sh`):

| Control | Where | Notes |
|---|---|---|
| HSTS `max-age=1y; includeSubDomains` | `/etc/nginx/snippets/hsts.conf` | Included in every TLS block. No `preload` — that is a one-way, browser-baked commitment. |
| TLS signature algorithms | `/etc/nginx/snippets/tls-hardening.conf` | Excludes SHA224/SHA1. Ciphers themselves come from certbot's `options-ssl-nginx.conf`, which certbot overwrites — never edit that file. |
| `security.txt` (RFC 9116) | `<webroot>/.well-known/` | `Expires` regenerates 1 year out on every run. Unsigned and without `Encryption` by design. |
| CSP | per site | Enforced on static sites; **report-only** on the map app. |
| `Referrer-Policy: no-referrer`, `X-Content-Type-Options` | per site | |
| `X-Frame-Options: SAMEORIGIN` | per site | Landing pages only, and **only when nothing may frame them**. Omitted on a page provisioned with `--frame-ancestors`: the header cannot name a third-party origin (`ALLOW-FROM` is obsolete), so leaving it would block the framing the CSP permits. The map app never sets it — it is embeddable by design. |
| CSP `frame-ancestors` | per site | `'none'` on landing pages by default. `startanalyse2026.nl` names `https://startanalyse.pbl.nl` because **PBL embeds that page** — do not "tidy" it back to `'none'`. See [setup_landing_page.md](setup_landing_page.md#embedding). |

### Promoting the map app's CSP to enforcing

The map app ships `Content-Security-Policy-Report-Only` because it loads several
third-party origins plus WebAssembly and `blob:` workers; a policy that is one
origin short breaks map rendering *silently*. To promote it:

1. Load the site, then exercise the risky paths: add a **parquet** layer and a
   **pmtiles** layer, open **StreetView**, and **export a PNG**.
2. Watch DevTools for `[Report Only]` violations and add any missing origin to
   `CSP_MAP` in `setup_map_application.sh`.
3. Once the console is clean, re-run with `--csp-enforce`.

> **A deployed instance keeps the CSP it was provisioned with.** `CSP_MAP` lives in
> the script, not in a shared snippet, so origins added to the repo since an instance
> was set up are *not* on that host until it is re-provisioned. Checked 2026-09-16:
> `map.startanalyse2026.nl` was missing `api.pdok.nl`,
> `nominatim.openstreetmap.org` and `maptiles.projectatlas.app` — the two geocoder
> backends among them, so location search would break the moment that instance is
> promoted to enforcing. Compare before promoting any instance:
>
> ```bash
> curl -sSI https://<map-host>/ | grep -i content-security-policy
> ```
>
> Re-provision with the instance's original flags — `--config-project` especially
> (it gates the `/sa-tiles/` proxy block, and omitting it also ships the neutral
> `public/` configs).

### HTTP compression and BREACH

gzip/brotli stay **on**. Scanners flag compression as a BREACH risk, but BREACH
needs a secret (session or CSRF token) reflected into a *compressed response
body*; these sites serve static assets and public map data with no per-user
secrets. The map app's bundles are large (WASM + MapLibre), so disabling it would
be a real regression. (`setup_fileserver.sh` sets `gzip off` for a different
reason: runtime gzip breaks HTTP Range requests.)

## IPv6

The server has a global IPv6 address and **every nginx site listens on `[::]`**,
so IPv6 support is purely a **DNS** matter. AAAA records are in place and
verified serving HTTPS over IPv6 (`curl -6 -sI https://<host>` → 200). The
`www.*` names are CNAMEs to their apex, which inherits the AAAA.

`check_aaaa` in `common.sh` re-checks this on every run and warns if a record
disappears. It queries DNS with `dig`/`host` rather than `getent`, because
`getent ahostsv6` consults `/etc/hosts` first — on this server that maps the
site's own name to the host's address and yields a false pass.

If a hostname is ever added, create the matching record at the DNS provider:

```
kanskaartthuisgeven.nl.       AAAA  <server IPv6>
www.kanskaartthuisgeven.nl.   AAAA  <server IPv6>
woonzorglimburg.nl.           AAAA  <server IPv6>
www.woonzorglimburg.nl.       AAAA  <server IPv6>
map.woonzorglimburg.nl.       AAAA  <server IPv6>
data.woonzorglimburg.nl.      AAAA  <server IPv6>
```

Read the current address with `ip -6 addr show scope global`.

> ⚠️ **The host's IPv6 is SLAAC/`dynamic mngtmpaddr`, not statically pinned.**
> The published AAAA records point at that address. If it ever changes, IPv6
> clients are black-holed while IPv4 keeps working — a failure mode that is easy
> to miss. Either pin the address (netplan) or confirm with the provider that
> the prefix and interface identifier are stable. `check_aaaa` only proves a
> record *exists*, not that it still matches `ip -6 addr`.
