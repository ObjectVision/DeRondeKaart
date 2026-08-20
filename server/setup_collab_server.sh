#!/usr/bin/env bash
#
# setup_collab_server.sh — provision one collaborative-annotation server instance.
#
# Builds the Hocuspocus (Yjs) WebSocket server from the map repo's
# collab-server/ package and runs it as a systemd service on 127.0.0.1:<port>.
# It gets NO nginx site and NO hostname of its own: map application instances
# expose it at a path on their existing domain (wss://<map-host>/collab) via
# setup_map_application.sh --collab-port <port> — so the map host's TLS cert
# covers the WebSocket and no extra DNS record is needed. One collab instance
# can serve several map apps (rooms are client-minted UUIDs).
#
# Access control is the capability-URL model (the unguessable room UUID in a
# share link is the only key) — read collab-server/README.md before exposing.
#
# Run ON the target server. Auto-deploys on push via the shared webhook
# daemon; since this instance has no nginx site, point the GitHub webhook at
# any map app host: https://<map-host>/hooks/deploy-<slug>.
#
# Example:
#   ./setup_collab_server.sh -y \
#       --slug woonzorglimburg_collab --port 5174 \
#       --repo git@github.com:ObjectVision/northwake.git \
#       --email eoudejans@objectvision.nl

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<EOF
${_C_BOLD}setup_collab_server.sh${_C_RESET} — provision a collaborative-annotation (Yjs) server.

Usage: $0 [options]

Options:
$(print_kv "--slug NAME"      "instance id, namespaces all paths (e.g. woonzorglimburg_collab)")
$(print_kv "--port N"         "localhost port the server listens on (default: 5174)")
$(print_kv "--repo URL"       "git remote of the map repo (contains collab-server/)")
$(print_kv "--branch NAME"    "git branch to deploy (default: main)")
$(print_kv "--node-version N" "Node.js major version to install if missing (default: 20)")
$(print_kv "--secret HEX"     "GitHub webhook HMAC secret (default: generated)")
$(print_kv "-y, --yes"        "non-interactive: accept all defaults")
$(print_kv "-h, --help"       "show this help")
EOF
}

SLUG=""; PORT=""; REPO=""; BRANCH=""; NODE_VERSION=""; SECRET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)           SLUG="$2"; shift 2 ;;
    --slug=*)         SLUG="${1#*=}"; shift ;;
    --port)           PORT="$2"; shift 2 ;;
    --port=*)         PORT="${1#*=}"; shift ;;
    --repo)           REPO="$2"; shift 2 ;;
    --repo=*)         REPO="${1#*=}"; shift ;;
    --branch)         BRANCH="$2"; shift 2 ;;
    --branch=*)       BRANCH="${1#*=}"; shift ;;
    --node-version)   NODE_VERSION="$2"; shift 2 ;;
    --node-version=*) NODE_VERSION="${1#*=}"; shift ;;
    --secret)         SECRET="$2"; shift 2 ;;
    --secret=*)       SECRET="${1#*=}"; shift ;;
    -y|--yes)         ASSUME_YES=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

log "Collaborative-annotation server setup"
require_sudo

ask SLUG "Instance slug" ""
validate_slug "$SLUG"
ask PORT         "Listen port (127.0.0.1)"           "5174"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "Invalid port '$PORT'."
ask REPO         "Git repository URL (map repo)"     ""
ask BRANCH       "Git branch"                        "main"
ask NODE_VERSION "Node.js major version"             "20"
ask_secret SECRET "GitHub webhook secret (HMAC)"

REPO_DIR="/srv/$SLUG"
DATA_DIR="/var/lib/$SLUG"
SERVICE_NAME="collab-$SLUG"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
DEPLOY_SCRIPT="/usr/local/bin/deploy-$SLUG.sh"
DEPLOY_LOG="/var/log/$SLUG-deploy.log"
HOOK_ID="deploy-$SLUG"

echo
log "Plan"
info "slug            : $SLUG"
info "repo / branch   : $REPO ($BRANCH)"
info "repo dir        : $REPO_DIR"
info "listen          : 127.0.0.1:$PORT (no nginx site — proxied by map apps)"
info "data (SQLite)   : $DATA_DIR/annotations.db"
info "systemd service : $SERVICE_NAME"
info "deploy script   : $DEPLOY_SCRIPT"
info "webhook hook id : $HOOK_ID  ->  https://<map-host>/hooks/$HOOK_ID"
echo
confirm "Proceed?" || die "Aborted."

# --- 1. base packages ---
ensure_base_stack
# better-sqlite3 (bundled by @hocuspocus/extension-sqlite) builds natively.
ensure_packages build-essential python3

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
sudo mkdir -p "$DATA_DIR"
sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$DATA_DIR"
sudo chmod 750 "$DATA_DIR"
ok "Data directory ready ($DATA_DIR)"

# --- 4. clone repo + first build ---
ensure_repo "$REPO" "$BRANCH" "$REPO_DIR"
log "First build (npm ci && tsc in collab-server/)"
(
  cd "$REPO_DIR/collab-server"
  npm ci
  npx --no-install tsc
)
ok "Built collab server"

# --- 5. systemd service ---
log "Writing systemd unit $SERVICE_FILE"
write_root_file "$SERVICE_FILE" 0644 <<EOF
[Unit]
Description=Collaborative-annotation (Hocuspocus/Yjs) server — $SLUG
After=network.target

[Service]
Type=simple
User=${DEPLOY_USER}
Group=${DEPLOY_USER}
WorkingDirectory=${REPO_DIR}/collab-server
Environment=PORT=${PORT}
Environment=DB_PATH=${DATA_DIR}/annotations.db
# Overload / storage guards — all optional; safe finite defaults apply if unset.
# To tune, uncomment and re-run this script (it rewrites the unit), or edit here
# and \`systemctl daemon-reload && systemctl restart ${SERVICE_NAME}\`. The
# webhook deploy only rebuilds+restarts; it never rewrites this unit. See
# collab-server/README.md "Abuse & overload guards" for the full list.
#Environment=MAX_DOC_BYTES=2097152
#Environment=MAX_ANNOTATIONS=300
#Environment=MAX_SNAPSHOT_BYTES=131072
#Environment=ROOM_TTL_DAYS=90
#Environment=DB_SIZE_WARN_BYTES=536870912
ExecStart=$(command -v node) ${REPO_DIR}/collab-server/dist/index.js
Restart=always
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"
ok "Service $SERVICE_NAME enabled and started"

# --- 6. deploy script (backgrounded so the webhook answers within GitHub's 10s timeout) ---
log "Writing deploy script $DEPLOY_SCRIPT"
write_root_file "$DEPLOY_SCRIPT" 0755 <<EOF
#!/usr/bin/env bash
# Detach the actual work so the webhook responds within GitHub's 10s timeout.
setsid -f bash -c '
set -euo pipefail
exec >> $DEPLOY_LOG 2>&1
echo "--- Deploy triggered: \$(date --iso-8601=seconds) ---"

$(deploy_lock_preamble "$SLUG")

echo "--- Deploy started: \$(date --iso-8601=seconds) ---"

cd $REPO_DIR
git fetch --prune origin
git reset --hard origin/$BRANCH

cd collab-server
npm ci
npx --no-install tsc

sudo systemctl restart $SERVICE_NAME

echo "--- Deploy finished: \$(date --iso-8601=seconds) ---"
' < /dev/null > /dev/null 2>&1
echo "Deploy started in background (see $DEPLOY_LOG)"
EOF
sudo touch "$DEPLOY_LOG"
sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_LOG"
# The deploy script restarts the service — allow that without a password.
write_root_file "/etc/sudoers.d/$SERVICE_NAME" 0440 <<EOF
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${SERVICE_NAME}
EOF
ok "Deploy script and log ready"

# --- 7. shared webhook daemon + this instance's hook ---
ensure_webhook_daemon
webhook_upsert_hook "$HOOK_ID" "$DEPLOY_SCRIPT" "$REPO_DIR" "$SECRET" "$BRANCH"

echo
ok "Collab server '$SLUG' is set up."
info "Listening     : 127.0.0.1:$PORT"
info "Expose it via : ./setup_map_application.sh ... --collab-port $PORT"
info "                (adds the /collab proxy location to the map app's nginx site)"
echo
log "Configure the GitHub webhook on the source repo:"
info "Payload URL  : https://<map-host>/hooks/$HOOK_ID   (any map app instance's host)"
info "Content type : application/json"
info "Secret       : $SECRET"
info "Events       : Just the push event"
