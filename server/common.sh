#!/usr/bin/env bash
#
# common.sh — shared helpers for the northwake server setup scripts.
#
# Sourced by:
#   setup_landing_page.sh   (Hugo landing site)
#   setup_fileserver.sh     (geospatial file server)
#   setup_map_application.sh (React/Vite SPA)
#
# These scripts are meant to be run ON the target server (e.g. cicada@37.97.169.242)
# by a user with passwordless sudo. Everything is namespaced by an instance SLUG so
# that any number of landing pages, file servers and map apps can coexist on one host.
#
# Shared, installed once (idempotent):
#   - nginx, git, curl, jq, rsync, certbot
#   - the adnanh/webhook daemon on 127.0.0.1:${WEBHOOK_PORT} (-hotreload)
#   - /etc/nginx/conf.d/geo-mime.conf (geospatial MIME types)
#
# Per instance (namespaced by <slug>):
#   /srv/<slug>                           cloned git repo (landing + map only)
#   /var/www/<slug>                       nginx webroot / data root
#   /etc/nginx/sites-available/<slug>     nginx server block (+ symlink in sites-enabled)
#   /usr/local/bin/deploy-<slug>.sh       deploy script (landing + map only)
#   /var/log/<slug>-deploy.log            deploy log (landing + map only)
#   hook id "deploy-<slug>" in /etc/webhook/hooks.json (landing + map only)

# ---------------------------------------------------------------------------
# Strictness
# ---------------------------------------------------------------------------
set -euo pipefail

# ---------------------------------------------------------------------------
# Pinned versions / constants
# ---------------------------------------------------------------------------
WEBHOOK_VERSION="${WEBHOOK_VERSION:-2.8.1}"
WEBHOOK_PORT="${WEBHOOK_PORT:-9000}"
WEBHOOK_BIN="/usr/local/bin/webhook"
WEBHOOK_HOOKS="/etc/webhook/hooks.json"
WEBHOOK_SERVICE="/etc/systemd/system/webhook.service"

# The system user that owns clones/builds and that the webhook daemon runs as.
DEPLOY_USER="${DEPLOY_USER:-$(id -un)}"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  _C_RESET=$'\033[0m'; _C_BOLD=$'\033[1m'; _C_BLUE=$'\033[34m'
  _C_GREEN=$'\033[32m'; _C_YELLOW=$'\033[33m'; _C_RED=$'\033[31m'
else
  _C_RESET=""; _C_BOLD=""; _C_BLUE=""; _C_GREEN=""; _C_YELLOW=""; _C_RED=""
fi

log()  { printf '%s\n' "${_C_BLUE}${_C_BOLD}==>${_C_RESET} ${_C_BOLD}$*${_C_RESET}"; }
info() { printf '%s\n' "    $*"; }
ok()   { printf '%s\n' "${_C_GREEN}  ✓ ${_C_RESET}$*"; }
warn() { printf '%s\n' "${_C_YELLOW}  ! ${_C_RESET}$*" >&2; }
err()  { printf '%s\n' "${_C_RED}  ✗ ${_C_RESET}$*" >&2; }
die()  { err "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Prompt / parameter helpers
#
# ASSUME_YES=1 (set via -y/--yes) makes every ask() take its default without
# prompting. A value already provided on the command line is never re-prompted.
# ---------------------------------------------------------------------------
ASSUME_YES="${ASSUME_YES:-0}"

# ask VARNAME "Prompt text" ["default"]
# If VARNAME is already non-empty (e.g. set by a CLI flag) it is left as-is.
ask() {
  local __var="$1" __prompt="$2" __default="${3-}" __input=""
  local __current="${!__var-}"
  [ -n "$__current" ] && return 0
  if [ "$ASSUME_YES" = "1" ]; then
    [ -n "$__default" ] || die "Missing required value for --${__var,,} (running non-interactively)"
    printf -v "$__var" '%s' "$__default"
    return 0
  fi
  if [ -n "$__default" ]; then
    read -r -p "  $__prompt [$__default]: " __input || true
    printf -v "$__var" '%s' "${__input:-$__default}"
  else
    while [ -z "$__input" ]; do
      read -r -p "  $__prompt: " __input || true
    done
    printf -v "$__var" '%s' "$__input"
  fi
}

# ask_secret VARNAME "Prompt text"
# Same as ask() but the default is a freshly generated 32-byte hex secret.
ask_secret() {
  local __var="$1" __prompt="$2"
  local __current="${!__var-}"
  [ -n "$__current" ] && return 0
  local __gen; __gen="$(openssl rand -hex 32)"
  ask "$__var" "$__prompt" "$__gen"
}

# confirm "Question" -> returns 0 for yes. Auto-yes under ASSUME_YES.
confirm() {
  local __prompt="$1" __reply=""
  [ "$ASSUME_YES" = "1" ] && return 0
  read -r -p "  $__prompt [y/N]: " __reply || true
  [[ "$__reply" =~ ^[Yy]$ ]]
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
validate_slug() {
  local slug="$1"
  [[ "$slug" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
    || die "Invalid slug '$slug' — use lowercase letters, digits, '_' and '-' (must start alphanumeric)."
}

validate_host() {
  local host="$1"
  [[ "$host" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] \
    || die "Invalid hostname '$host'."
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) die "Unsupported architecture: $(uname -m)" ;;
  esac
}

# ---------------------------------------------------------------------------
# System bootstrap
# ---------------------------------------------------------------------------
require_sudo() {
  command -v sudo >/dev/null 2>&1 || die "sudo is required."
  sudo -n true 2>/dev/null || warn "sudo may prompt for a password."
}

# ensure_packages pkg...
ensure_packages() {
  local missing=()
  local pkg
  for pkg in "$@"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    log "Installing packages: ${missing[*]}"
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  fi
}

# The base packages every service relies on.
# The brotli modules give nginx `brotli`/`brotli_static` (used by the map site's
# compression block) — the WASM/font assets are otherwise served uncompressed.
# They auto-enable via /etc/nginx/modules-enabled/; harmless for other services.
ensure_base_stack() {
  ensure_packages nginx git curl jq rsync ca-certificates \
    libnginx-mod-http-brotli-filter libnginx-mod-http-brotli-static
  sudo systemctl enable --now nginx >/dev/null 2>&1 || true
}

ensure_certbot() {
  ensure_packages certbot python3-certbot-nginx
}

# ---------------------------------------------------------------------------
# File writing (system paths, owned by root)
# ---------------------------------------------------------------------------
# write_root_file <path> <mode> <<<"content"   (content on stdin)
write_root_file() {
  local path="$1" mode="$2"
  sudo install -D -m "$mode" /dev/stdin "$path"
}

# ---------------------------------------------------------------------------
# nginx
# ---------------------------------------------------------------------------
# nginx_write_site <slug>   (server block on stdin)
nginx_write_site() {
  local slug="$1"
  local dest="/etc/nginx/sites-available/$slug"
  if [ -f "$dest" ]; then
    sudo cp -a "$dest" "${dest}.bak.$(date +%Y%m%d-%H%M%S)"
    info "Backed up existing $dest"
  fi
  write_root_file "$dest" 0644
  ok "Wrote nginx site $dest"
}

nginx_enable_site() {
  local slug="$1"
  sudo ln -sfn "/etc/nginx/sites-available/$slug" "/etc/nginx/sites-enabled/$slug"
  ok "Enabled nginx site $slug"
}

nginx_test_reload() {
  sudo nginx -t
  sudo systemctl reload nginx
  ok "nginx configuration reloaded"
}

# Emit an HTTP redirect server block that 301s <aliases...> to https://<primary>.
render_redirect_block() {
  local primary="$1"; shift
  local aliases="$*"
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${aliases};
    return 301 https://${primary}\$request_uri;
}
EOF
}

# ---------------------------------------------------------------------------
# TLS via certbot (nginx plugin). Idempotent: safe to re-run.
# tls_obtain <email> <host> [host...]
# The nginx site must already be enabled and serving :80 for these hosts.
# ---------------------------------------------------------------------------
tls_obtain() {
  local email="$1"; shift
  local hosts=("$@")
  ensure_certbot
  local dflags=()
  local h
  for h in "${hosts[@]}"; do dflags+=(-d "$h"); done
  log "Requesting/renewing Let's Encrypt certificate for: ${hosts[*]}"
  if sudo certbot --nginx --non-interactive --agree-tos --redirect \
        -m "$email" --no-eff-email "${dflags[@]}"; then
    ok "TLS configured for ${hosts[*]}"
  else
    warn "certbot failed. The site is still served over HTTP."
    warn "Check that DNS for ${hosts[*]} resolves to this server, then re-run."
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Shared webhook daemon (adnanh/webhook)
# ---------------------------------------------------------------------------
ensure_webhook_daemon() {
  # Binary
  if [ ! -x "$WEBHOOK_BIN" ]; then
    local arch; arch="$(detect_arch)"
    log "Installing adnanh/webhook ${WEBHOOK_VERSION} (${arch})"
    local tmp; tmp="$(mktemp -d)"
    curl -fsSL "https://github.com/adnanh/webhook/releases/download/${WEBHOOK_VERSION}/webhook-linux-${arch}.tar.gz" \
      -o "$tmp/webhook.tar.gz"
    tar -xzf "$tmp/webhook.tar.gz" -C "$tmp"
    sudo install -m 0755 "$tmp/webhook-linux-${arch}/webhook" "$WEBHOOK_BIN"
    rm -rf "$tmp"
    ok "Installed $WEBHOOK_BIN"
  fi

  # Hooks file (start empty; entries are upserted per instance)
  if [ ! -f "$WEBHOOK_HOOKS" ]; then
    sudo mkdir -p "$(dirname "$WEBHOOK_HOOKS")"
    printf '[]\n' | write_root_file "$WEBHOOK_HOOKS" 0644
    ok "Created empty $WEBHOOK_HOOKS"
  fi

  # systemd unit (created once; -hotreload picks up hooks.json changes)
  if [ ! -f "$WEBHOOK_SERVICE" ]; then
    log "Creating webhook systemd service (runs as ${DEPLOY_USER}, 127.0.0.1:${WEBHOOK_PORT})"
    write_root_file "$WEBHOOK_SERVICE" 0644 <<EOF
[Unit]
Description=adnanh webhook listener (shared deploy hooks)
After=network.target

[Service]
Type=simple
User=${DEPLOY_USER}
Group=${DEPLOY_USER}
ExecStart=${WEBHOOK_BIN} \\
    -hooks ${WEBHOOK_HOOKS} \\
    -ip 127.0.0.1 \\
    -port ${WEBHOOK_PORT} \\
    -hotreload \\
    -verbose
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now webhook
    ok "webhook service enabled and started"
  else
    sudo systemctl start webhook 2>/dev/null || true
  fi
}

# webhook_upsert_hook <id> <execute-command> <working-dir> <secret> [branch]
# Adds or replaces the hook entry with the given id, leaving all others intact.
webhook_upsert_hook() {
  local id="$1" cmd="$2" wd="$3" secret="$4" branch="${5:-main}"
  local entry
  entry="$(jq -n \
    --arg id "$id" --arg cmd "$cmd" --arg wd "$wd" \
    --arg secret "$secret" --arg ref "refs/heads/$branch" '
    {
      id: $id,
      "execute-command": $cmd,
      "command-working-directory": $wd,
      "response-message": ("Deploy " + $id + " triggered."),
      "trigger-rule": {
        "and": [
          { "match": { "type": "payload-hmac-sha256", "secret": $secret,
                       "parameter": { "source": "header", "name": "X-Hub-Signature-256" } } },
          { "match": { "type": "value", "value": $ref,
                       "parameter": { "source": "payload", "name": "ref" } } }
        ]
      }
    }')"
  local current tmp
  current="$(sudo cat "$WEBHOOK_HOOKS")"
  tmp="$(mktemp)"
  jq --arg id "$id" --argjson entry "$entry" \
    'map(select(.id != $id)) + [$entry]' <<<"$current" > "$tmp"
  write_root_file "$WEBHOOK_HOOKS" 0644 < "$tmp"
  rm -f "$tmp"
  # Restart the daemon so it re-reads hooks.json. We do NOT rely on -hotreload:
  # writing the file atomically (new inode) leaves the fsnotify watch stale, so
  # hotreload can silently miss the change. A restart is fast and reliable.
  sudo systemctl restart webhook
  ok "Registered webhook hook id '$id' and reloaded the webhook daemon"
}

# ---------------------------------------------------------------------------
# Git repo clone/update as the deploy user
# ---------------------------------------------------------------------------
ensure_repo() {
  local repo_url="$1" branch="$2" dest="$3"
  sudo mkdir -p "$dest"
  sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$dest"
  if [ -d "$dest/.git" ]; then
    log "Updating existing repo at $dest"
    git -C "$dest" remote set-url origin "$repo_url"
    git -C "$dest" fetch --prune origin
    git -C "$dest" checkout "$branch"
    git -C "$dest" reset --hard "origin/$branch"
  else
    log "Cloning $repo_url -> $dest"
    git clone --branch "$branch" "$repo_url" "$dest"
  fi
  ok "Repository ready at $dest ($branch)"
}

# ---------------------------------------------------------------------------
# Usage banner helper
# ---------------------------------------------------------------------------
# print_kv "  --slug NAME" "description"
print_kv() { printf '  %-26s %s\n' "$1" "$2"; }
