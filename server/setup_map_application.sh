#!/usr/bin/env bash
#
# setup_map_application.sh — provision one React/Vite map-application instance.
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
${_C_BOLD}setup_map_application.sh${_C_RESET} — provision a React/Vite map app instance.

Usage: $0 [options]

Options:
$(print_kv "--slug NAME"        "instance id, namespaces all paths (e.g. woonzorglimburg_map)")
$(print_kv "--host HOST"        "hostname (e.g. map.woonzorglimburg.nl)")
$(print_kv "--repo URL"         "git remote of the Vite/React source repo")
$(print_kv "--branch NAME"      "git branch to deploy (default: main)")
$(print_kv "--node-version N"   "Node.js major version to install if missing (default: 20)")
$(print_kv "--frame-ancestors V" "CSP frame-ancestors value; blank = embeddable anywhere (default: blank)")
$(print_kv "--collab-port N"    "proxy /collab to a collab server on 127.0.0.1:N; blank = off (default: blank)")
$(print_kv "--secret HEX"       "GitHub webhook HMAC secret (default: generated)")
$(print_kv "--email ADDR"       "email for Let's Encrypt registration")
$(print_kv "--no-tls"           "skip certbot; serve plain HTTP only")
$(print_kv "-y, --yes"          "non-interactive: accept all defaults")
$(print_kv "-h, --help"         "show this help")
EOF
}

SLUG=""; HOST=""; REPO=""; BRANCH=""; NODE_VERSION=""; FRAME_ANCESTORS=""
SECRET=""; EMAIL=""; NO_TLS=0; FRAME_SET=0; COLLAB_PORT=""; COLLAB_SET=0

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
    --node-version)     NODE_VERSION="$2"; shift 2 ;;
    --node-version=*)   NODE_VERSION="${1#*=}"; shift ;;
    --frame-ancestors)  FRAME_ANCESTORS="$2"; FRAME_SET=1; shift 2 ;;
    --frame-ancestors=*) FRAME_ANCESTORS="${1#*=}"; FRAME_SET=1; shift ;;
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
ask REPO         "Git repository URL (Vite/React source)" ""
ask BRANCH       "Git branch"                             "main"
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
  npx --no-install vite build
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
echo "--- Deploy started: \$(date --iso-8601=seconds) ---"

cd $REPO_DIR
git fetch --prune origin
git reset --hard origin/$BRANCH

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
if [ -n "$FRAME_ANCESTORS" ]; then
  FRAME_HEADER="    add_header Content-Security-Policy \"frame-ancestors $FRAME_ANCESTORS\" always;"
else
  FRAME_HEADER="    # No framing restriction: embeddable in any site/dashboard (Power BI, etc.)."
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

nginx_write_site "$SLUG" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;

    root $WEBROOT;
    index index.html;

    # SPA fallback: unknown URLs serve index.html so the React router takes over.
    location / { try_files \$uri \$uri/ /index.html; }

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

$FRAME_HEADER
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Access-Control-Allow-Origin "*" always;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
EOF
nginx_enable_site "$SLUG"
nginx_test_reload

# --- 8. TLS ---
if [ "$NO_TLS" = "1" ]; then
  warn "TLS skipped (--no-tls). Served over plain HTTP."
else
  tls_obtain "$EMAIL" "$HOST" || true
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
