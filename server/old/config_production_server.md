# Stepplan — Production server for landing + React app + geodata fileserver

## Context

The Hugo landing page is the only thing currently planned for `37.97.169.242`
(see [config_landing_production_server.md](../../../Documents/dev/woonzorglimburg_landing/config_landing_production_server.md)).
We now need the same VM to also host:

1. The Hugo landing site (already documented).
2. A browser-friendly fileserver for geospatial data (`.geoarrow`, `.parquet`,
   `.arrow`, `.pbf`, `.pbf.gz`, `.tif`, `.tiff`) consumed from the browser by
   MapLibre, deck.gl, DuckDB-WASM, and COG readers (e.g. GeoTIFF.js).
3. A Vite-built React SPA, auto-deployed from its own GitHub repo.

Decisions made up-front (locked via clarifying Q&A):

| Item | Choice |
|---|---|
| Apex domain | `woonzorglimburg.nl` |
| Routing | Subdomains (clean per-service CORS + cert) |
| TLS | Let's Encrypt, auto-renewed |
| React build tool | Vite (`npm run build` → `dist/`) |
| File server access | Public read-only, no auth, SFTP uploads |
| Webhook listener | Reuse the existing `adnanh/webhook` instance on `127.0.0.1:9000`; add a second hook entry rather than running a second daemon |

### Subdomain → service map

| Hostname | Service | Webroot / upstream | Notes |
|---|---|---|---|
| `woonzorglimburg.nl`, `www.woonzorglimburg.nl` | Hugo landing | `/var/www/woonzorglimburg_landing` | `www` 301-redirects to apex |
| `map.woonzorglimburg.nl` | React SPA | `/var/www/woonzorglimburg_map` | SPA fallback to `/index.html` |
| `data.woonzorglimburg.nl` | Geo file server | `/var/www/woonzorglimburg_data` | CORS open, byte-range, `gzip_static` for `.pbf.gz` |

All three listen on `:80` (redirect) and `:443` (TLS). No exotic ports.

---

## Step 1 — DNS (do this first, before certbot can issue)

In your DNS provider, create three A records, all pointing at `37.97.169.242`:

```
woonzorglimburg.nl.        A   37.97.169.242
www.woonzorglimburg.nl.    A   37.97.169.242
map.woonzorglimburg.nl.    A   37.97.169.242
data.woonzorglimburg.nl.   A   37.97.169.242
```

Wait until `dig +short woonzorglimburg.nl` (and the others) returns the IP from
your laptop before running certbot in Step 8.

---

## Step 2 — Base server (skip parts already done)

Sections 2.1, 2.2, 2.3 of the existing landing-page roadmap (apt update, nginx
+ git, Hugo extended) cover what's needed for the landing site. **Add** to that:

```bash
# Node.js 20 LTS for the React build
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# certbot for Let's Encrypt
sudo apt-get install -y certbot python3-certbot-nginx

# UFW — allow ssh + web only (skipped for now)
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # opens 80 + 443
sudo ufw enable
```

---

## Step 3 — Directory layout

```bash
# Sources (cloned repos)
sudo mkdir -p /srv/woonzorglimburg_landing /srv/woonzorglimburg_map
sudo chown cicada:cicada /srv/woonzorglimburg_landing /srv/woonzorglimburg_map

# Webroots (what nginx serves)
sudo mkdir -p /var/www/woonzorglimburg_landing \
              /var/www/woonzorglimburg_map \
              /var/www/woonzorglimburg_data
sudo chown cicada:www-data /var/www/woonzorglimburg_landing \
                            /var/www/woonzorglimburg_map \
                            /var/www/woonzorglimburg_data
sudo chmod 755 /var/www/woonzorglimburg_landing \
               /var/www/woonzorglimburg_map \
               /var/www/woonzorglimburg_data

# Geo data subdirs (suggestion — adjust to your real layout)
sudo -u cicada mkdir -p /var/www/woonzorglimburg_data/{tiles,parquet,arrow,rasters}
```

`cicada` owns the writable side (clones, builds, SFTP uploads); `www-data` only
needs read+traverse, which the `:www-data` group + `755` already grants.

---

## Step 4 — Landing site (already documented)

Follow Sections 3, 4, 5, 6 of [config_landing_production_server.md](../../../Documents/dev/woonzorglimburg_landing/config_landing_production_server.md) **with these changes**:

- Replace `--baseURL "http://37.97.169.242/"` with `--baseURL "https://woonzorglimburg.nl/"` in both the first build (3.4) and the deploy script (Section 6).
- Use the corrected nginx config from Step 7 below instead of the one in §4 (the
  original points the symlink at the wrong filename and uses the bare IP as
  `server_name`).
- Hooks file path stays `/etc/webhook/hooks.json` — it gains a second entry in
  Step 6 below.

---

## Step 5 — React SPA setup

### 5.1 Clone and first build

Replace `<REACT_REPO_SSH_URL>` with the actual git URL:

```bash
git clone <REACT_REPO_SSH_URL> /srv/woonzorglimburg_map
cd /srv/woonzorglimburg_map
npm ci
npm run build
rsync -a --delete dist/ /var/www/woonzorglimburg_map/
```

### 5.2 Deploy script

Create `/usr/local/bin/deploy-woonzorglimburg_map.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/srv/woonzorglimburg_map"
WEBROOT="/var/www/woonzorglimburg_map"
LOG="/var/log/woonzorglimburg_map-deploy.log"

exec >> "$LOG" 2>&1
echo "--- Deploy started: $(date --iso-8601=seconds) ---"

cd "$REPO_DIR"
git fetch --prune origin
git reset --hard origin/main

npm ci
npm run build

rsync -a --delete dist/ "$WEBROOT/"

echo "--- Deploy finished: $(date --iso-8601=seconds) ---"
```

```bash
sudo chmod +x /usr/local/bin/deploy-woonzorglimburg_map.sh
sudo touch /var/log/woonzorglimburg_map-deploy.log
sudo chown cicada:cicada /var/log/woonzorglimburg_map-deploy.log
```

If the SPA needs a build-time API base URL, put it in
`/srv/woonzorglimburg_map/.env.production` (gitignored on the server) — Vite
picks it up automatically.

---

## Step 6 — Extend the existing webhook listener (don't add a second one)

Edit `/etc/webhook/hooks.json` to hold **both** hooks. Generate a second secret
(`openssl rand -hex 32`) for the React repo, or reuse the landing one if you
prefer a single shared secret per repo (GitHub configures the secret per webhook):

```json
[
  {
    "id": "deploy-landing",
    "execute-command": "/usr/local/bin/deploy-woonzorglimburg_landing.sh",
    "command-working-directory": "/srv/woonzorglimburg_landing",
    "response-message": "Landing deployment triggered.",
    "trigger-rule": {
      "and": [
        { "match": { "type": "payload-hmac-sha256",
                     "secret": "LANDING_SECRET",
                     "parameter": { "source": "header", "name": "X-Hub-Signature-256" } } },
        { "match": { "type": "value", "value": "refs/heads/main",
                     "parameter": { "source": "payload", "name": "ref" } } }
      ]
    }
  },
  {
    "id": "deploy-map",
    "execute-command": "/usr/local/bin/deploy-woonzorglimburg_map.sh",
    "command-working-directory": "/srv/woonzorglimburg_map",
    "response-message": "Map deployment triggered.",
    "trigger-rule": {
      "and": [
        { "match": { "type": "payload-hmac-sha256",
                     "secret": "MAP_SECRET",
                     "parameter": { "source": "header", "name": "X-Hub-Signature-256" } } },
        { "match": { "type": "value", "value": "refs/heads/main",
                     "parameter": { "source": "payload", "name": "ref" } } }
      ]
    }
  }
]
```

Restart the existing service:

```bash
sudo systemctl restart webhook
```

The hook IDs are also the URL path segments. Configure two GitHub webhooks:

| Repo | Payload URL | Secret |
|---|---|---|
| `woonzorglimburg_landing` | `https://woonzorglimburg.nl/hooks/deploy-landing` | `LANDING_SECRET` |
| (the React repo) | `https://map.woonzorglimburg.nl/hooks/deploy-map` | `MAP_SECRET` |

(The original doc's path `/hooks/deploy` becomes `/hooks/deploy-landing` because
we renamed the hook id; update GitHub or keep the id as `deploy` to avoid
churn.)

---

## Step 7 — nginx server blocks

Each subdomain gets its own file in `/etc/nginx/sites-available/`. After
writing all three, symlink them into `sites-enabled/`, remove `default`,
`nginx -t`, reload.

### 7.1 `/etc/nginx/sites-available/woonzorglimburg_landing`

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name woonzorglimburg.nl www.woonzorglimburg.nl;
    return 301 https://woonzorglimburg.nl$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name www.woonzorglimburg.nl;
    # certbot fills in ssl_certificate / ssl_certificate_key
    return 301 https://woonzorglimburg.nl$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name woonzorglimburg.nl;

    root /var/www/woonzorglimburg_landing;
    index index.html;

    location / { try_files $uri $uri/ =404; }

    # Webhook proxy (kept on the landing host for backward compat)
    location /hooks/ {
        proxy_pass http://127.0.0.1:9000/hooks/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    error_page 404 /404.html;
    location = /404.html { internal; }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/plain text/css application/javascript image/svg+xml;
    gzip_min_length 1024;
}
```

### 7.2 `/etc/nginx/sites-available/woonzorglimburg_map`

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name map.woonzorglimburg.nl;
    return 301 https://map.woonzorglimburg.nl$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name map.woonzorglimburg.nl;

    root /var/www/woonzorglimburg_map;
    index index.html;

    # SPA fallback — unknown URLs serve index.html so the React router takes over
    location / { try_files $uri $uri/ /index.html; }

    # Hashed Vite assets are immutable
    location ^~ /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable" always;
        try_files $uri =404;
    }

    # Webhook proxy for the React deploy
    location /hooks/ {
        proxy_pass http://127.0.0.1:9000/hooks/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    # Landing site (woonzorglimburg.nl) embeds the map in an iframe on /kaart/,
    # so X-Frame-Options is replaced with the modern CSP frame-ancestors
    # directive. frame-ancestors supersedes X-Frame-Options in all modern
    # browsers and — unlike X-Frame-Options — supports an explicit allowlist
    # of origins. Keep `'self'` so the map app can still iframe itself.
    add_header Content-Security-Policy "frame-ancestors 'self' https://woonzorglimburg.nl https://www.woonzorglimburg.nl" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
```

### 7.3 `/etc/nginx/sites-available/woonzorglimburg_data`

The geo server has subtle requirements: byte-range support (DuckDB-WASM,
GeoParquet, Arrow IPC random access), CORS from the app subdomain, and correct
handling of pre-compressed `.pbf.gz`. **Do not** put parquet/arrow into
`gzip_types` — runtime gzip would disable Range responses on those large
binary blobs.

First, extend MIME mappings. Create
`/etc/nginx/conf.d/geo-mime.conf`:

```nginx
types {
    application/vnd.apache.parquet           parquet;
    application/vnd.apache.arrow.file        arrow geoarrow;
    application/vnd.mapbox-vector-tile       pbf;
    image/tiff                               tif tiff;
}
```

Then `/etc/nginx/sites-available/woonzorglimburg_data`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name data.woonzorglimburg.nl;
    return 301 https://data.woonzorglimburg.nl$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name data.woonzorglimburg.nl;

    root /var/www/woonzorglimburg_data;

    # Browse the file tree at the root. Remove if undesired.
    autoindex off;

    # Permissive CORS — restrict origin if you want to lock to the map subdomain.
    # Use `always` so headers are also added for 304 / range responses.
    add_header Access-Control-Allow-Origin  "*"                       always;
    add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS"      always;
    add_header Access-Control-Allow-Headers "Range, If-None-Match"    always;
    add_header Access-Control-Expose-Headers "Content-Length, Content-Range, ETag, Accept-Ranges" always;
    add_header Access-Control-Max-Age       "86400"                   always;
    add_header Accept-Ranges                "bytes"                   always;

    # Cheap CORS preflight
    if ($request_method = OPTIONS) { return 204; }

    # Vector tiles: serve .pbf, transparently using a co-located .pbf.gz when
    # the client supports gzip. nginx adds Content-Encoding for us.
    location ~* \.pbf$ {
        gzip_static always;
        types { application/vnd.mapbox-vector-tile pbf; }
        expires 7d;
    }

    # If a client requests the .pbf.gz URL directly, mark it as gzip-encoded MVT.
    location ~* \.pbf\.gz$ {
        types { } default_type application/vnd.mapbox-vector-tile;
        add_header Content-Encoding gzip always;
        # Re-emit the CORS headers (add_header in nested locations replaces parent set)
        add_header Access-Control-Allow-Origin  "*"                       always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS"      always;
        add_header Access-Control-Allow-Headers "Range, If-None-Match"    always;
        add_header Access-Control-Expose-Headers "Content-Length, Content-Range, ETag, Accept-Ranges" always;
        add_header Accept-Ranges                "bytes"                   always;
        expires 7d;
    }

    # Big binary geo blobs (incl. Cloud-Optimized GeoTIFFs) — long cache,
    # range requests, NO runtime gzip.
    location ~* \.(parquet|arrow|geoarrow|tif|tiff)$ {
        expires 30d;
        add_header Cache-Control "public" always;
        # CORS re-emitted (same reason as above)
        add_header Access-Control-Allow-Origin  "*"                       always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS"      always;
        add_header Access-Control-Allow-Headers "Range, If-None-Match"    always;
        add_header Access-Control-Expose-Headers "Content-Length, Content-Range, ETag, Accept-Ranges" always;
        add_header Accept-Ranges                "bytes"                   always;
    }

    location / { try_files $uri $uri/ =404; }

    # Do NOT set gzip on; for parquet/arrow it would disable Range. Vector
    # tiles are pre-compressed via gzip_static, no runtime gzip needed.
    gzip off;
}
```

### 7.4 Enable

```bash
sudo ln -sf /etc/nginx/sites-available/woonzorglimburg_landing /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/woonzorglimburg_map     /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/woonzorglimburg_data    /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

---

## Step 8 — Let's Encrypt certificates

DNS from Step 1 must already resolve. Issue all four hostnames in one cert
(or split — single cert is simpler):

```bash
sudo certbot --nginx \
  -d woonzorglimburg.nl \
  -d www.woonzorglimburg.nl \
  -d map.woonzorglimburg.nl \
  -d data.woonzorglimburg.nl \
  --redirect --agree-tos -m eoudejans@objectvision.nl --no-eff-email
```

certbot edits each `:443` server block to fill in `ssl_certificate` /
`ssl_certificate_key` and installs a renewal timer
(`systemctl status certbot.timer`).

Verify auto-renewal works:

```bash
sudo certbot renew --dry-run
```

---

## Step 9 — Verification (end-to-end)

```bash
# 1. Each subdomain answers and redirects http→https
for host in woonzorglimburg.nl www.woonzorglimburg.nl \
            map.woonzorglimburg.nl data.woonzorglimburg.nl; do
  echo "== $host =="
  curl -sI "http://$host/"  | head -1
  curl -sI "https://$host/" | head -1
done

# 2. Webhook endpoints proxy correctly (400 = signature missing = correct)
curl -s -o /dev/null -w "%{http_code}\n" https://woonzorglimburg.nl/hooks/deploy-landing
curl -s -o /dev/null -w "%{http_code}\n" https://map.woonzorglimburg.nl/hooks/deploy-map

# 3. Range requests work on a parquet sample
curl -sI -H "Range: bytes=0-1023" \
  https://data.woonzorglimburg.nl/parquet/<sample>.parquet | head
# Expect: HTTP/2 206, Content-Range: bytes 0-1023/...

# 4. CORS works from the map subdomain
curl -sI -H "Origin: https://map.woonzorglimburg.nl" \
  https://data.woonzorglimburg.nl/parquet/<sample>.parquet | grep -i access-control

# 5. .pbf gzip negotiation
curl -sI -H "Accept-Encoding: gzip" \
  https://data.woonzorglimburg.nl/tiles/<z>/<x>/<y>.pbf | grep -iE 'content-(encoding|type|length)'
# Expect Content-Encoding: gzip when a .pbf.gz neighbor exists.

# 6. Push trivial commits to main on each repo, then on the server:
sudo journalctl -u webhook -f
tail -f /var/log/woonzorglimburg_landing-deploy.log
tail -f /var/log/woonzorglimburg_map-deploy.log

# 7. Services healthy
systemctl status nginx webhook
```

In the browser, load `https://map.woonzorglimburg.nl` and confirm the React
SPA fetches a parquet/arrow/tile from `https://data.woonzorglimburg.nl` with
no CORS or mixed-content errors (DevTools → Network).

---

## Critical files to be created or modified

- `/etc/nginx/conf.d/geo-mime.conf` — geo MIME mappings (new)
- `/etc/nginx/sites-available/woonzorglimburg_landing` — replace existing
- `/etc/nginx/sites-available/woonzorglimburg_map` — new
- `/etc/nginx/sites-available/woonzorglimburg_data` — new
- `/etc/webhook/hooks.json` — extend with `deploy-map`, rename id to
  `deploy-landing`
- `/usr/local/bin/deploy-woonzorglimburg_landing.sh` — adjust `BASE_URL` to
  `https://woonzorglimburg.nl/`
- `/usr/local/bin/deploy-woonzorglimburg_map.sh` — new
- `/var/log/woonzorglimburg_map-deploy.log` — new
- DNS zone for `woonzorglimburg.nl` — four A records
- GitHub webhook on the React repo

## Reused, unchanged

- adnanh/webhook binary + `webhook.service` (already present from Section 5 of
  the existing roadmap) — only `hooks.json` changes; service just needs a
  restart.
- The Hugo install, repo clone pattern, deploy-script pattern, and security
  headers / gzip config are reused verbatim from
  [config_landing_production_server.md](../../../Documents/dev/woonzorglimburg_landing/config_landing_production_server.md).
