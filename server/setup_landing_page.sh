#!/usr/bin/env bash
#
# setup_landing_page.sh — provision one Hugo landing-page instance.
#
# Run ON the target server. Any number of landing pages can coexist: each is
# namespaced by its own --slug and served on its own --host.
#
# Every value can be supplied as a flag (non-interactive) or entered at the
# prompt. A value passed as a flag is never asked for again. Pass -y/--yes to
# accept all defaults without prompting.
#
# Example (fully non-interactive):
#   ./setup_landing_page.sh -y \
#       --slug woonzorglimburg_landing \
#       --host woonzorglimburg.nl --alias www.woonzorglimburg.nl \
#       --repo git@github.com:ObjectVision/woonzorglimburg_landing.git \
#       --email eoudejans@objectvision.nl

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<EOF
${_C_BOLD}setup_landing_page.sh${_C_RESET} — provision a Hugo landing page instance.

Usage: $0 [options]

Options:
$(print_kv "--slug NAME"          "instance id, namespaces all paths (e.g. woonzorglimburg_landing)")
$(print_kv "--host HOST"          "primary hostname (e.g. woonzorglimburg.nl)")
$(print_kv "--alias HOST"         "extra hostname that 301s to primary; repeatable (e.g. www.woonzorglimburg.nl)")
$(print_kv "--embed-host URL"     "origin this page may <iframe> (CSP frame-src); repeatable (e.g. https://map.startanalyse2026.nl)")
$(print_kv "--repo URL"           "git remote of the Hugo source repo")
$(print_kv "--branch NAME"        "git branch to deploy (default: main)")
$(print_kv "--hugo-version VER"   "Hugo extended version to install (default: 0.161.1)")
$(print_kv "--secret HEX"         "GitHub webhook HMAC secret (default: generated)")
$(print_kv "--email ADDR"         "email for Let's Encrypt registration")
$(print_kv "--no-tls"             "skip certbot; serve plain HTTP only")
$(print_kv "-y, --yes"            "non-interactive: accept all defaults")
$(print_kv "-h, --help"           "show this help")
EOF
}

# --- defaults / parameter holders ---
SLUG=""; HOST=""; ALIASES=(); REPO=""; BRANCH=""; HUGO_VERSION=""
SECRET=""; EMAIL=""; NO_TLS=0; EMBED_HOSTS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)          SLUG="$2"; shift 2 ;;
    --slug=*)        SLUG="${1#*=}"; shift ;;
    --host)          HOST="$2"; shift 2 ;;
    --host=*)        HOST="${1#*=}"; shift ;;
    --alias)         ALIASES+=("$2"); shift 2 ;;
    --alias=*)       ALIASES+=("${1#*=}"); shift ;;
    --embed-host)    EMBED_HOSTS+=("$2"); shift 2 ;;
    --embed-host=*)  EMBED_HOSTS+=("${1#*=}"); shift ;;
    --repo)          REPO="$2"; shift 2 ;;
    --repo=*)        REPO="${1#*=}"; shift ;;
    --branch)        BRANCH="$2"; shift 2 ;;
    --branch=*)      BRANCH="${1#*=}"; shift ;;
    --hugo-version)  HUGO_VERSION="$2"; shift 2 ;;
    --hugo-version=*) HUGO_VERSION="${1#*=}"; shift ;;
    --secret)        SECRET="$2"; shift 2 ;;
    --secret=*)      SECRET="${1#*=}"; shift ;;
    --email)         EMAIL="$2"; shift 2 ;;
    --email=*)       EMAIL="${1#*=}"; shift ;;
    --no-tls)        NO_TLS=1; shift ;;
    -y|--yes)        ASSUME_YES=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

log "Landing page setup"
require_sudo

# --- gather parameters ---
ask SLUG   "Instance slug"                     ""
validate_slug "$SLUG"
ask HOST   "Primary hostname"                  ""
validate_host "$HOST"
# Aliases: only prompt if none were given as flags.
if [ "${#ALIASES[@]}" -eq 0 ] && [ "$ASSUME_YES" != "1" ]; then
  _al=""
  ask _al "Alias hostnames that redirect to primary (space-separated, blank for none)" " "
  read -r -a ALIASES <<<"$_al"
fi
ask REPO   "Git repository URL (Hugo source)"  ""
ask BRANCH "Git branch"                        "main"
ask HUGO_VERSION "Hugo extended version"        "0.161.1"
ask_secret SECRET "GitHub webhook secret (HMAC)"
if [ "$NO_TLS" != "1" ]; then
  ask EMAIL "Email for Let's Encrypt"          ""
fi

REPO_DIR="/srv/$SLUG"
WEBROOT="/var/www/$SLUG"
DEPLOY_SCRIPT="/usr/local/bin/deploy-$SLUG.sh"
DEPLOY_LOG="/var/log/$SLUG-deploy.log"
HOOK_ID="deploy-$SLUG"
if [ "$NO_TLS" = "1" ]; then BASE_URL="http://$HOST/"; else BASE_URL="https://$HOST/"; fi

echo
log "Plan"
info "slug            : $SLUG"
info "primary host    : $HOST"
info "aliases         : ${ALIASES[*]:-(none)}"
info "embeds (frame-src): ${EMBED_HOSTS[*]:-(none — page embeds nothing)}"
info "repo / branch   : $REPO ($BRANCH)"
info "webroot         : $WEBROOT"
info "repo dir        : $REPO_DIR"
info "deploy script   : $DEPLOY_SCRIPT"
info "webhook hook id : $HOOK_ID  ->  https://$HOST/hooks/$HOOK_ID"
info "base URL        : $BASE_URL"
info "TLS             : $([ "$NO_TLS" = 1 ] && echo disabled || echo "certbot ($EMAIL)")"
echo
confirm "Proceed?" || die "Aborted."

# --- 1. base packages ---
ensure_base_stack

# --- 2. Hugo extended ---
install_hugo() {
  if command -v hugo >/dev/null 2>&1 && [ "$(hugo version 2>/dev/null | grep -o "v[0-9.]*" | head -1)" = "v$HUGO_VERSION" ]; then
    ok "Hugo v$HUGO_VERSION already installed"
    return
  fi
  local arch; arch="$(detect_arch)"
  log "Installing Hugo extended $HUGO_VERSION ($arch)"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-${arch}.tar.gz" \
    -o "$tmp/hugo.tar.gz"
  tar -xzf "$tmp/hugo.tar.gz" -C "$tmp"
  sudo install -m 0755 "$tmp/hugo" /usr/local/bin/hugo
  rm -rf "$tmp"
  ok "Installed $(hugo version)"
}
install_hugo

# --- 3. directories ---
log "Creating directories"
sudo mkdir -p "$REPO_DIR" "$WEBROOT"
sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$REPO_DIR"
sudo chown "$DEPLOY_USER:www-data" "$WEBROOT"
sudo chmod 755 "$WEBROOT"
ok "Directories ready"

# --- 4. clone repo + first build ---
ensure_repo "$REPO" "$BRANCH" "$REPO_DIR"
log "First Hugo build"
( cd "$REPO_DIR" && hugo --minify --baseURL "$BASE_URL" --destination "$WEBROOT" )
ok "Built site into $WEBROOT"

# --- 5. deploy script ---
log "Writing deploy script $DEPLOY_SCRIPT"
write_root_file "$DEPLOY_SCRIPT" 0755 <<EOF
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$REPO_DIR"
WEBROOT="$WEBROOT"
BASE_URL="$BASE_URL"
BRANCH="$BRANCH"
LOG="$DEPLOY_LOG"

exec >> "\$LOG" 2>&1
echo "--- Deploy triggered: \$(date --iso-8601=seconds) ---"

$(deploy_lock_preamble "$SLUG")

echo "--- Deploy started: \$(date --iso-8601=seconds) ---"

cd "\$REPO_DIR"
git fetch --prune origin
git reset --hard "origin/\$BRANCH"

hugo --minify --baseURL "\$BASE_URL" --destination "\$WEBROOT"

echo "--- Deploy finished: \$(date --iso-8601=seconds) ---"
EOF
sudo touch "$DEPLOY_LOG"
sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_LOG"
ok "Deploy script and log ready"

# --- 6. shared webhook daemon + this instance's hook ---
ensure_webhook_daemon
webhook_upsert_hook "$HOOK_ID" "$DEPLOY_SCRIPT" "$REPO_DIR" "$SECRET" "$BRANCH"

# --- 7. nginx site (HTTP first; certbot adds TLS in step 8) ---
#
# Content-Security-Policy.
#
# NOT the shared `static` policy. That one assumes a self-contained page, and
# this landing page is the opposite: its entire content is an <iframe> of the
# map application, driven by an inline year-toggle script. Under `static` the
# page renders as an empty grey box — `default-src 'self'` blocks the frame
# (there is no frame-src to fall back to) and `script-src 'self'` blocks the
# toggle. Verified: the map iframe became chrome-error://chromewebdata/.
#
# So two deliberate additions on top of `static`:
#
#   frame-src   whatever --embed-host was given (the map application). With no
#               --embed-host the directive is omitted and the policy is exactly
#               `static`, so a landing page that embeds nothing stays locked down.
#
#   'unsafe-inline' on script-src, for Hugo's inline toggle script. A sha256
#               hash would be stricter, but the script lives in the content
#               team's layouts/index.html and every edit would silently break
#               the year switcher until someone regenerated the hash here. The
#               page takes no user input and reflects nothing, so the XSS
#               surface this protects against does not exist.
#
# frame-ancestors stays 'none': this page embeds others, it is not embedded.
CSP_LANDING="default-src 'self'; \
script-src 'self' 'unsafe-inline'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data:; \
font-src 'self' data:; \
connect-src 'self'; \
object-src 'none'; base-uri 'self'; form-action 'self'"
if [ "${#EMBED_HOSTS[@]}" -gt 0 ]; then
  CSP_LANDING="$CSP_LANDING; frame-src ${EMBED_HOSTS[*]}"
fi

log "Writing nginx site"
{
  # Redirect block for aliases (only over HTTP until certbot runs; then it upgrades it).
  if [ "${#ALIASES[@]}" -gt 0 ]; then
    render_redirect_block "$HOST" "${ALIASES[@]}"
  fi
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;

    root $WEBROOT;
    index index.html;

    location / { try_files \$uri \$uri/ =404; }

    # RFC 9116 — served as plain text, not sniffed.
    location = /.well-known/security.txt { default_type text/plain; }

    # Proxy deploy webhooks to the shared listener on 127.0.0.1:$WEBHOOK_PORT
    location /hooks/ {
        proxy_pass http://127.0.0.1:$WEBHOOK_PORT/hooks/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    error_page 404 /404.html;
    location = /404.html { internal; }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    # no-referrer: scanners (NCSC) advise against strict-origin-when-cross-origin,
    # and nothing here needs an outbound Referer.
    add_header Referrer-Policy "no-referrer" always;
$(render_csp_header "$CSP_LANDING" "" "'none'")

    # HTTP compression is intentionally ON. Scanners flag it as a BREACH risk;
    # BREACH requires a secret (session token, CSRF token) reflected into a
    # COMPRESSED response body, and this is a static site with no per-user
    # secrets in any response. Do not disable without re-checking that premise.
    gzip on;
    gzip_types text/plain text/css application/javascript image/svg+xml;
    gzip_min_length 1024;
}
EOF
} | nginx_write_site "$SLUG"
nginx_enable_site "$SLUG"
nginx_test_reload

# --- 8. TLS ---
if [ "$NO_TLS" = "1" ]; then
  warn "TLS skipped (--no-tls). Site is served over plain HTTP."
else
  ensure_hsts_snippet
  ensure_tls_hardening_snippet
  tls_obtain "$EMAIL" "$HOST" "${ALIASES[@]}" || true
  # Adds HSTS to the TLS blocks and collapses the alias's extra redirect hop
  # that certbot's rewrite introduces (see nginx_post_tls in common.sh).
  nginx_post_tls "$SLUG" "$HOST"
  ensure_security_txt "$WEBROOT" "https://$HOST"
  check_aaaa "$HOST" "${ALIASES[@]}"
  nginx_test_reload
fi

echo
ok "Landing page '$SLUG' is set up."
info "URL          : $BASE_URL"
info "Deploy hook  : https://$HOST/hooks/$HOOK_ID"
echo
log "Configure the GitHub webhook on the source repo:"
info "Payload URL  : https://$HOST/hooks/$HOOK_ID"
info "Content type : application/json"
info "Secret       : $SECRET"
info "Events       : Just the push event"
