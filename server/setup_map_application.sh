#!/usr/bin/env bash
#
# setup_map_application.sh — provision one SolidJS/Vite map-application instance.
#
# Builds a Vite SPA from a GitHub repo, serves it over HTTPS with SPA fallback
# and immutable hashed-asset caching, and auto-deploys on push to the tracked
# branch via the shared webhook daemon. The SPA is embeddable (open framing +
# open CORS) so it can be dropped into dashboards / Power BI by default.
#
# Run ON the target server. Any number of map apps can coexist: each is
# namespaced by its own --slug and served on its own --host.
#
# Every value can be supplied as a flag or entered at the prompt. A flag value
# is never asked for again. Pass -y/--yes to accept all defaults.
#
# Example:
#   ./setup_map_application.sh -y \
#       --slug woonzorglimburg_map --host map.woonzorglimburg.nl \
#       --repo git@github.com:ObjectVision/northwake.git \
#       --email eoudejans@objectvision.nl

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<EOF
${_C_BOLD}setup_map_application.sh${_C_RESET} — provision a SolidJS/Vite map app instance.

Usage: $0 [options]

Options:
$(print_kv "--slug NAME"        "instance id, namespaces all paths (e.g. woonzorglimburg_map)")
$(print_kv "--host HOST"        "hostname (e.g. map.woonzorglimburg.nl)")
$(print_kv "--repo URL"         "git remote of the Vite/SolidJS source repo")
$(print_kv "--branch NAME"      "git branch to deploy (default: main)")
$(print_kv "--config-project S" "config overlay to build (configs/<S>/ over public/); blank = defaults")
$(print_kv "--node-version N"   "Node.js major version to install if missing (default: 20)")
$(print_kv "--frame-ancestors V" "CSP frame-ancestors value; blank = embeddable anywhere (default: blank)")
$(print_kv "--csp-enforce"      "enforce the CSP (default: report-only — validate the console first)")
$(print_kv "--csp-report-only"  "ship CSP as Report-Only (default)")
$(print_kv "--collab-port N"    "proxy /collab to a collab server on 127.0.0.1:N; blank = off (default: blank)")
$(print_kv "--secret HEX"       "GitHub webhook HMAC secret (default: generated)")
$(print_kv "--email ADDR"       "email for Let's Encrypt registration")
$(print_kv "--no-tls"           "skip certbot; serve plain HTTP only")
$(print_kv "-y, --yes"          "non-interactive: accept all defaults")
$(print_kv "-h, --help"         "show this help")
EOF
}

SLUG=""; HOST=""; REPO=""; BRANCH=""; NODE_VERSION=""; FRAME_ANCESTORS=""
# CSP starts in report-only mode; --csp-enforce flips it once validated.
CSP_REPORT_ONLY=1
SECRET=""; EMAIL=""; NO_TLS=0; FRAME_SET=0; COLLAB_PORT=""; COLLAB_SET=0
CONFIG_PROJECT=""; CONFIG_PROJECT_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)             SLUG="$2"; shift 2 ;;
    --slug=*)           SLUG="${1#*=}"; shift ;;
    --host)             HOST="$2"; shift 2 ;;
    --host=*)           HOST="${1#*=}"; shift ;;
    --repo)             REPO="$2"; shift 2 ;;
    --repo=*)           REPO="${1#*=}"; shift ;;
    --branch)           BRANCH="$2"; shift 2 ;;
    --branch=*)         BRANCH="${1#*=}"; shift ;;
    --config-project)   CONFIG_PROJECT="$2"; CONFIG_PROJECT_SET=1; shift 2 ;;
    --config-project=*) CONFIG_PROJECT="${1#*=}"; CONFIG_PROJECT_SET=1; shift ;;
    --node-version)     NODE_VERSION="$2"; shift 2 ;;
    --node-version=*)   NODE_VERSION="${1#*=}"; shift ;;
    --frame-ancestors)  FRAME_ANCESTORS="$2"; FRAME_SET=1; shift 2 ;;
    --frame-ancestors=*) FRAME_ANCESTORS="${1#*=}"; FRAME_SET=1; shift ;;
    --csp-enforce)      CSP_REPORT_ONLY=0; shift ;;
    --csp-report-only)  CSP_REPORT_ONLY=1; shift ;;
    --collab-port)      COLLAB_PORT="$2"; COLLAB_SET=1; shift 2 ;;
    --collab-port=*)    COLLAB_PORT="${1#*=}"; COLLAB_SET=1; shift ;;
    --secret)           SECRET="$2"; shift 2 ;;
    --secret=*)         SECRET="${1#*=}"; shift ;;
    --email)            EMAIL="$2"; shift 2 ;;
    --email=*)          EMAIL="${1#*=}"; shift ;;
    --no-tls)           NO_TLS=1; shift ;;
    -y|--yes)           ASSUME_YES=1; shift ;;
    -h|--help)          usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

log "Map application setup"
require_sudo

ask SLUG "Instance slug" ""
validate_slug "$SLUG"
ask HOST "Hostname" ""
validate_host "$HOST"
ask REPO         "Git repository URL (Vite/SolidJS source)" ""
ask BRANCH       "Git branch"                             "main"
# config-project: blank means build the default configs from public/. A value
# selects configs/<value>/ to overlay (VITE_CONFIG_PROJECT at build time).
if [ "$CONFIG_PROJECT_SET" != "1" ] && [ "$ASSUME_YES" != "1" ]; then
  ask CONFIG_PROJECT "Config project overlay (blank = public/ defaults)" " "
  CONFIG_PROJECT="${CONFIG_PROJECT# }"
fi
ask NODE_VERSION "Node.js major version"                  "20"
# frame-ancestors: blank means "no CSP frame header" = embeddable anywhere.
if [ "$FRAME_SET" != "1" ] && [ "$ASSUME_YES" != "1" ]; then
  ask FRAME_ANCESTORS "CSP frame-ancestors (blank = embeddable anywhere)" " "
  FRAME_ANCESTORS="${FRAME_ANCESTORS# }"
fi
# collab-port: blank means no /collab proxy (collaborative annotation off).
# The port is a collab server instance provisioned by setup_collab_server.sh.
if [ "$COLLAB_SET" != "1" ] && [ "$ASSUME_YES" != "1" ]; then
  ask COLLAB_PORT "Collab server port on 127.0.0.1 (blank = no collaboration)" " "
  COLLAB_PORT="${COLLAB_PORT# }"
fi
if [ -n "$COLLAB_PORT" ]; then
  [[ "$COLLAB_PORT" =~ ^[0-9]+$ ]] || die "Invalid --collab-port '$COLLAB_PORT'."
fi
ask_secret SECRET "GitHub webhook secret (HMAC)"
if [ "$NO_TLS" != "1" ]; then
  ask EMAIL "Email for Let's Encrypt" ""
fi

REPO_DIR="/srv/$SLUG"
WEBROOT="/var/www/$SLUG"
DEPLOY_SCRIPT="/usr/local/bin/deploy-$SLUG.sh"
DEPLOY_LOG="/var/log/$SLUG-deploy.log"
HOOK_ID="deploy-$SLUG"

echo
log "Plan"
info "slug            : $SLUG"
info "host            : $HOST"
info "repo / branch   : $REPO ($BRANCH)"
info "config project  : ${CONFIG_PROJECT:-<public/ defaults>}"
info "webroot         : $WEBROOT"
info "repo dir        : $REPO_DIR"
info "deploy script   : $DEPLOY_SCRIPT"
info "webhook hook id : $HOOK_ID  ->  https://$HOST/hooks/$HOOK_ID"
info "frame-ancestors : ${FRAME_ANCESTORS:-(none — embeddable anywhere)}"
info "collab proxy    : $([ -n "$COLLAB_PORT" ] && echo "/collab -> 127.0.0.1:$COLLAB_PORT" || echo "(off)")"
info "TLS             : $([ "$NO_TLS" = 1 ] && echo disabled || echo "certbot ($EMAIL)")"
echo
confirm "Proceed?" || die "Aborted."

# --- 1. base packages ---
ensure_base_stack

# --- 2. Node.js ---
install_node() {
  if command -v node >/dev/null 2>&1; then
    ok "Node.js already installed: $(node -v)"
    return
  fi
  log "Installing Node.js ${NODE_VERSION} LTS"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
  ensure_packages nodejs
  ok "Installed Node.js $(node -v), npm $(npm -v)"
}
install_node

# --- 3. directories ---
log "Creating directories"
sudo mkdir -p "$REPO_DIR" "$WEBROOT"
sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$REPO_DIR"
sudo chown "$DEPLOY_USER:www-data" "$WEBROOT"
sudo chmod 755 "$WEBROOT"
ok "Directories ready"

# --- 4. clone repo + first build ---
ensure_repo "$REPO" "$BRANCH" "$REPO_DIR"
log "First build (npm ci && vite build)"
(
  cd "$REPO_DIR"
  npm ci
  VITE_CONFIG_PROJECT="$CONFIG_PROJECT" npx --no-install vite build
  rsync -a --delete dist/ "$WEBROOT/"
)
ok "Built SPA into $WEBROOT"

# --- 5. deploy script (backgrounded so the webhook answers within GitHub's 10s timeout) ---
log "Writing deploy script $DEPLOY_SCRIPT"
write_root_file "$DEPLOY_SCRIPT" 0755 <<EOF
#!/usr/bin/env bash
# Detach the actual work so the webhook responds within GitHub's 10s timeout.
# The build takes a few minutes; output goes to the log. A non-blocking
# 'tsc -b' surfaces type errors without aborting; only a real 'vite build'
# failure (set -e) aborts, so a broken/empty dist is never published.
setsid -f bash -c '
set -euo pipefail
exec >> $DEPLOY_LOG 2>&1
echo "--- Deploy triggered: \$(date --iso-8601=seconds) ---"

$(deploy_lock_preamble "$SLUG")

echo "--- Deploy started: \$(date --iso-8601=seconds) ---"

cd $REPO_DIR
git fetch --prune origin
git reset --hard origin/$BRANCH

# Config overlay to build (configs/<slug>/ over public/); empty = public/ defaults.
export VITE_CONFIG_PROJECT="$CONFIG_PROJECT"

npm ci

echo "--- Type check (tsc -b, non-blocking) ---"
if npx --no-install tsc -b; then
  echo "Type check: OK"
else
  echo "Type check: FAILED (continuing with deploy anyway; see errors above)"
fi

echo "--- Build (vite build) ---"
npx --no-install vite build

rsync -a --delete dist/ $WEBROOT/

echo "--- Deploy finished: \$(date --iso-8601=seconds) ---"
' < /dev/null > /dev/null 2>&1
echo "Deploy started in background (see $DEPLOY_LOG)"
EOF
sudo touch "$DEPLOY_LOG"
sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_LOG"
ok "Deploy script and log ready"

# --- 6. shared webhook daemon + this instance's hook ---
ensure_webhook_daemon
webhook_upsert_hook "$HOOK_ID" "$DEPLOY_SCRIPT" "$REPO_DIR" "$SECRET" "$BRANCH"

# --- 7. nginx site ---
log "Writing nginx site"
# Content-Security-Policy.
#
# Only ONE CSP header is honoured, so frame-ancestors and the resource policy
# must be a single header (render_csp_header builds it).
#
# Shipped as Content-Security-Policy-REPORT-ONLY by default: this app pulls
# from several third-party origins and needs 'wasm-unsafe-eval' (parquet-wasm)
# and blob: (workers + the PNG export in src/lib/map-capture.ts). Enforcing a
# policy with one origin missing breaks map rendering silently, so violations
# are reported to the browser console first. Promote with --csp-enforce once
# the console is clean under real use (add parquet + pmtiles layers, open
# StreetView, export a PNG).
#
# Origins below were read out of configs/*/layers.json + map.json and src/.
#
# infographics.pbl.nl appears in FIVE directives, all for ONE feature: the
# neighbourhood summary shown when a buurt is clicked.
#
# public/pbl-samenvatting.html is OUR page serving PBL's "Samenvatting
# Startanalyse" viewer. It carries a cross-origin <base href> pointing at PBL, so
# every relative script, stylesheet and data path in it loads from PBL while the
# document itself stays same-origin (which is what lets us script it).
#
#   base-uri    THE LOAD-BEARING ONE. `base-uri 'self'` makes the browser reject
#               that <base> tag outright, and every relative URL then resolves
#               against THIS origin instead: css/style.css becomes
#               map.<host>/css/style.css, which the SPA fallback answers with
#               index.html, and the console fills with "MIME type ('text/html')
#               is not a supported stylesheet MIME type". Adding PBL to the other
#               four directives does nothing while this one is 'self' — the base
#               is rejected before any PBL URL is ever constructed.
#               Do NOT "tidy" this back to 'self'.
#
#   script-src  the viewer's own scripts, stylesheets and data fetches, all
#   style-src   pulled from PBL via that <base>. Without these the summary loads
#   connect-src blank. (img-src already allows https:, and the page's Web Worker
#               is a blob:, covered by worker-src.)
#
#   frame-src   the Details popup frames pbl-samenvatting.html. Note this is OUR
#               page, not PBL's — but the redirect chain and the viewer's own
#               framing both need PBL allowed here too.
#
# font-src additionally needs https://data.pbl.nl — a SECOND PBL host. Their
# stylesheets pull the Rijksoverheid webfonts (ROsansweb*, ROserifweb*) from
# data.pbl.nl, not infographics.pbl.nl. Without it the summary renders in a
# fallback font and logs seven console errors.
#
# The page's own two scripts (public/pbl-worker-shim.js, pbl-buurt-select.js)
# are external files under 'self' on purpose: inline blocks would force
# 'unsafe-inline' on script-src app-wide, or sha256 hashes that silently break
# the summary on any future edit to that page.
#
# script-src also carries 'unsafe-eval' — NOT for our own code, which never
# evaluates strings, but because PBL's viewer vendors d3.v5.js and turf.min.js,
# both of which call eval(). Without it kaartenbak_init() throws immediately,
# the gemeente dropdown is never built, and the summary sits blank with a single
# EvalError. We cannot patch their libraries: they are fetched from PBL at run
# time so their page stays the single source of truth. ('wasm-unsafe-eval' is
# separate and still needed for parquet-wasm; it does not permit string eval.)
#
# Note: the layer metainfo does NOT embed a PBL iframe. All 122 meta/2025 docs on
# the data host were checked; none contains an <iframe>, and the only
# infographics.pbl.nl reference is a plain <a> in _footer.html.
#
# connect-src carries BOTH geocoders, because mapControls.searchProvider picks
# between them per project: api.pdok.nl (Locatieserver — suggest + lookup) and
# nominatim.openstreetmap.org. Note that nominatim was missing here while it was
# the only backend, so the location search could not have worked in a deployed
# build at all; adding it fixes that, independently of the PDOK work.
# service.pdok.nl is a different host and stays — it serves the luchtfoto tiles.
CSP_MAP="default-src 'self'; \
script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://maps.googleapis.com https://maps.gstatic.com https://infographics.pbl.nl; \
worker-src 'self' blob:; \
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://infographics.pbl.nl; \
font-src 'self' data: https://fonts.gstatic.com https://data.pbl.nl; \
img-src 'self' data: blob: https: ; \
connect-src 'self' blob: https://tiles.openfreemap.org https://data.woonzorglimburg.nl https://data.startanalyse2026.nl https://service.pdok.nl https://api.pdok.nl https://nominatim.openstreetmap.org https://tiles.mapgallery.io https://startanalyse2025.files.mapgallery.io https://tiles.basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://maps.googleapis.com https://infographics.pbl.nl; \
frame-src 'self' https://www.google.com https://maps.googleapis.com https://infographics.pbl.nl; \
object-src 'none'; base-uri 'self' https://infographics.pbl.nl; form-action 'self'"

if [ -n "$FRAME_ANCESTORS" ]; then
  FRAME_HEADER="$(render_csp_header "$CSP_MAP" "$CSP_REPORT_ONLY" "$FRAME_ANCESTORS")"
else
  # No framing restriction: embeddable in any site/dashboard (Power BI, etc.).
  FRAME_HEADER="$(render_csp_header "$CSP_MAP" "$CSP_REPORT_ONLY" "")"
fi

# Collaborative-annotation WebSocket proxy. Same pattern as /hooks/: a path on
# this host forwarded to a localhost daemon — certbot's TLS then covers wss://
# with no extra subdomain or certificate.
if [ -n "$COLLAB_PORT" ]; then
  COLLAB_BLOCK="    location /collab {
        proxy_pass http://127.0.0.1:$COLLAB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \$host;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }"
else
  COLLAB_BLOCK="    # No collab server proxied (re-run with --collab-port to enable)."
fi

# Startanalyse tile CDN proxy. The tile host serves vector tiles with NO
# Access-Control-Allow-Origin header, so a cross-origin fetch() from MapLibre is
# blocked by CORS. Proxying through this origin (/sa-tiles/ -> the CDN) makes the
# request same-origin. Gated to the startanalyse2026 config project so no other
# instance carries this block. Mirrors the /sa-tiles Vite dev proxy.
if [ "$CONFIG_PROJECT" = "startanalyse2026" ]; then
  SA_TILES_BLOCK="    location /sa-tiles/ {
        # Resolve the tile CDN at request time (variable proxy_pass + resolver)
        # so a transient DNS failure cannot fail nginx startup/-t and take down
        # every site on this host. A literal hostname is resolved at load time,
        # so a CDN DNS blip during an nginx restart would 'emerg' the whole box.
        resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;
        set \$sa_tiles_host startanalyse2025.files.mapgallery.io;
        rewrite ^/sa-tiles/(.*)\$ /\$1 break;
        proxy_pass https://\$sa_tiles_host;
        proxy_set_header Host startanalyse2025.files.mapgallery.io;
        proxy_ssl_server_name on;
        proxy_hide_header Access-Control-Allow-Origin;
        add_header Access-Control-Allow-Origin \"*\" always;
        proxy_cache_valid 200 1h;
    }"
else
  SA_TILES_BLOCK="    # No startanalyse tile proxy (only emitted for --config-project startanalyse2026)."
fi

nginx_write_site "$SLUG" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;

    root $WEBROOT;
    index index.html;

    # SPA fallback: unknown URLs serve index.html. The app has no router — this
    # exists so a deep-linked share URL (?cmd=/#basemap=) reaches the bundle
    # instead of 404ing on a path nginx has no file for.
    location / { try_files \$uri \$uri/ /index.html; }

    # RFC 9116. Explicit block so the SPA fallback can never answer it with
    # index.html (a 200 of HTML would look "present but malformed" to scanners),
    # and so it is served as plain text rather than sniffed.
    location = /.well-known/security.txt {
        default_type text/plain;
        try_files \$uri =404;
    }

    # Hashed Vite assets are immutable.
    location ^~ /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable" always;
        add_header Access-Control-Allow-Origin "*" always;
        try_files \$uri =404;
    }

    # Proxy deploy webhooks to the shared listener on 127.0.0.1:$WEBHOOK_PORT
    location /hooks/ {
        proxy_pass http://127.0.0.1:$WEBHOOK_PORT/hooks/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

$COLLAB_BLOCK

$SA_TILES_BLOCK

$FRAME_HEADER
    add_header X-Content-Type-Options "nosniff" always;
    # no-referrer: scanners (NCSC) advise against strict-origin-when-cross-origin.
    # Nothing here depends on an outbound Referer — the Google Maps/StreetView
    # embed authenticates by API key, not by referrer.
    add_header Referrer-Policy "no-referrer" always;
    add_header Access-Control-Allow-Origin "*" always;

    # --- Compression (gzip + brotli) ---
    # Intentionally ON despite scanners flagging BREACH. BREACH needs a secret
    # (session/CSRF token) reflected into a COMPRESSED response body; this app
    # serves static assets and public map data with no per-user secrets in any
    # response. The bundles are large (WASM + MapLibre), so disabling this would
    # be a real performance regression for a public site. The fileserver
    # separately sets `gzip off` for range-read binaries — for a different
    # reason (Range support), see setup_fileserver.sh.
    # Text types compress on the fly; the big wins are WASM (parquet reader) and
    # the icon font, previously served uncompressed. Requires the brotli modules
    # (installed by ensure_base_stack in common.sh). brotli_static/gzip_static
    # serve the precompressed .br/.gz the build emits (brotli q11 — better than
    # the on-the-fly level below), falling back to live compression otherwise.
    gzip on;
    gzip_vary on;
    gzip_static on;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/xml
        application/javascript
        application/json
        application/wasm
        application/xml
        image/svg+xml
        font/ttf
        font/otf
        font/woff
        font/woff2;

    brotli on;
    brotli_comp_level 5;
    brotli_static on;
    brotli_types
        text/plain
        text/css
        text/xml
        application/javascript
        application/json
        application/wasm
        application/xml
        image/svg+xml
        font/ttf
        font/otf
        font/woff
        font/woff2;
}
EOF
nginx_enable_site "$SLUG"
nginx_test_reload

# --- 8. TLS ---
if [ "$NO_TLS" = "1" ]; then
  warn "TLS skipped (--no-tls). Served over plain HTTP."
else
  ensure_hsts_snippet
  ensure_tls_hardening_snippet
  tls_obtain "$EMAIL" "$HOST" || true
  nginx_post_tls "$SLUG" "$HOST"
  ensure_security_txt "$WEBROOT" "https://$HOST"
  check_aaaa "$HOST"
  nginx_test_reload
fi

SCHEME=$([ "$NO_TLS" = 1 ] && echo http || echo https)
echo
ok "Map application '$SLUG' is set up."
info "URL          : $SCHEME://$HOST/"
info "Deploy hook  : $SCHEME://$HOST/hooks/$HOOK_ID"
echo
log "Configure the GitHub webhook on the source repo:"
info "Payload URL  : $SCHEME://$HOST/hooks/$HOOK_ID"
info "Content type : application/json"
info "Secret       : $SECRET"
info "Events       : Just the push event"
