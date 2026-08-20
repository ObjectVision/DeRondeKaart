#!/usr/bin/env bash
#
# common.sh — shared helpers for the northwake server setup scripts.
#
# Sourced by:
#   setup_landing_page.sh   (Hugo landing site)
#   setup_fileserver.sh     (geospatial file server)
#   setup_map_application.sh (SolidJS/Vite SPA)
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
# HSTS
# ---------------------------------------------------------------------------
# Shared Strict-Transport-Security snippet, written once and included by every
# site's HTTPS server block (same pattern as the fileserver's geo-mime.conf).
#
# Without HSTS a browser that has ever seen the site over plain HTTP keeps
# trying port 80 first, and shows the "Je verbinding met deze site is niet
# beveiligd" panel on the http:// hop even though it 301s to https. With it,
# the browser upgrades internally and never touches :80 again.
#
# max-age is 1 year (31536000). Security scanners (e.g. internet.nl) flag
# anything shorter than a year as insufficient — a 300s test value gives
# essentially no protection because the browser forgets within minutes.
# Deliberately NO `preload`: preloading is a one-way commitment for the apex
# plus every subdomain, baked into browser binaries and slow to undo.
# `includeSubDomains` already asserts HTTPS for *.<domain>, so only include
# this on hosts whose siblings are all HTTPS-capable.
HSTS_SNIPPET="/etc/nginx/snippets/hsts.conf"
HSTS_MAX_AGE="${HSTS_MAX_AGE:-31536000}"

ensure_hsts_snippet() {
  # Rewritten every run so a changed HSTS_MAX_AGE actually takes effect.
  write_root_file "$HSTS_SNIPPET" 0644 <<EOF
# Managed by the northwake server setup scripts — edits will be overwritten.
# HTTPS only: browsers ignore this header when served over plain HTTP.
add_header Strict-Transport-Security "max-age=${HSTS_MAX_AGE}; includeSubDomains" always;
EOF
  ok "HSTS snippet ready ($HSTS_SNIPPET, max-age=${HSTS_MAX_AGE})"
}

# ---------------------------------------------------------------------------
# TLS hardening (signature algorithms)
# ---------------------------------------------------------------------------
# The ciphersuite list lives in certbot's options-ssl-nginx.conf, which certbot
# OVERWRITES on update — never edit that file. This snippet is ours and is
# included next to hsts.conf in every TLS server block.
#
# Why: scanners (internet.nl, NCSC 3.3.5) flag SHA224 as "uit te faseren".
# SHA224 is not a ciphersuite property — it comes from OpenSSL's *default* TLS
# 1.2 signature-algorithm list, so tightening ssl_ciphers does nothing. Verified
# on this host before the fix:
#     openssl s_client -tls1_2 -sigalgs 'ECDSA+SHA224'  -> ACCEPTED
# Setting SignatureAlgorithms explicitly drops SHA224 (and SHA1) while keeping
# everything a modern client offers. TLS 1.3 is unaffected (it has its own list).
#
# ECDSA first: the Let's Encrypt certs on this host are ECDSA (P-256), so
# ecdsa_secp256r1_sha256 must remain available or handshakes break outright.
# Requires OpenSSL >= 1.1.1 for ssl_conf_command (host has 3.5.5, nginx 1.28.3).
TLS_SNIPPET="/etc/nginx/snippets/tls-hardening.conf"
TLS_SIGALGS="${TLS_SIGALGS:-ECDSA+SHA256:ECDSA+SHA384:ECDSA+SHA512:rsa_pss_pss_sha256:rsa_pss_rsae_sha256:rsa_pss_rsae_sha384:rsa_pss_rsae_sha512:RSA+SHA256:RSA+SHA384:RSA+SHA512}"

ensure_tls_hardening_snippet() {
  write_root_file "$TLS_SNIPPET" 0644 <<EOF
# Managed by the northwake server setup scripts — edits will be overwritten.
# Explicit TLS 1.2 signature algorithms: excludes SHA224/SHA1 (see common.sh).
ssl_conf_command SignatureAlgorithms ${TLS_SIGALGS};
EOF
  ok "TLS hardening snippet ready ($TLS_SNIPPET)"
}

# ---------------------------------------------------------------------------
# Content-Security-Policy
# ---------------------------------------------------------------------------
# Only ONE Content-Security-Policy header is honoured (the most restrictive
# wins per directive, and a second header cannot loosen the first), so a site
# must emit exactly one — never a strict CSP *and* a separate frame-ancestors
# header. Callers therefore build the whole policy here, frame-ancestors
# included.
#
# render_csp_header <policy> [report-only] [frame-ancestors]
#   policy          : "static" (locked down) | the literal directive string
#   report-only     : "1" -> Content-Security-Policy-Report-Only (observe, do
#                     not enforce). Use while validating a policy on a complex
#                     app; violations appear in the browser console instead of
#                     breaking the page.
#   frame-ancestors : appended as `frame-ancestors <value>`; blank -> omitted
#                     entirely (embeddable anywhere, the existing default).
CSP_STATIC="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"

render_csp_header() {
  local policy="$1" report_only="${2:-}" frame_ancestors="${3:-}"
  [ "$policy" = "static" ] && policy="$CSP_STATIC"
  [ -z "$policy" ] && return 0
  if [ -n "$frame_ancestors" ]; then
    policy="$policy; frame-ancestors $frame_ancestors"
  fi
  local header="Content-Security-Policy"
  [ "$report_only" = "1" ] && header="Content-Security-Policy-Report-Only"
  printf '    add_header %s "%s" always;\n' "$header" "$policy"
}

# ---------------------------------------------------------------------------
# security.txt (RFC 9116)
# ---------------------------------------------------------------------------
# Published at /.well-known/security.txt so researchers have a documented way
# to report vulnerabilities. Scanners (internet.nl, securitytxt.org) check for
# it. RFC 9116 REQUIRES `Contact` and `Expires`; an expired file is treated as
# invalid, so `Expires` is regenerated one year out on every run — re-running
# the setup scripts keeps it fresh.
#
# Deliberately NO `Encryption` field and no PGP signature. Both are RFC 9116
# *recommendations*, not requirements — the file validates without them — and
# both would commit the organisation to publishing and rotating a key. Set
# SECURITYTXT_POLICY to publish a disclosure-policy URL when one exists.
SECURITYTXT_CONTACT="${SECURITYTXT_CONTACT:-mailto:info@objectvision.nl}"
SECURITYTXT_ORG="${SECURITYTXT_ORG:-Object Vision BV}"
SECURITYTXT_POLICY="${SECURITYTXT_POLICY:-}"

# render_security_txt <canonical-url>
render_security_txt() {
  local canonical="$1"
  # RFC 9116 wants an ISO 8601 / RFC 3339 UTC timestamp.
  local expires
  expires="$(date -u -d '+1 year' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
             || date -u -v+1y +%Y-%m-%dT%H:%M:%SZ)"
  local policy_line=""
  [ -n "$SECURITYTXT_POLICY" ] && policy_line="Policy: ${SECURITYTXT_POLICY}"$'\n'
  cat <<EOF
# Managed by the northwake server setup scripts — edits will be overwritten.
Contact: ${SECURITYTXT_CONTACT}
Expires: ${expires}
Preferred-Languages: nl, en
Canonical: ${canonical}/.well-known/security.txt
${policy_line}# ${SECURITYTXT_ORG}
EOF
}

# Write security.txt into a site's webroot.
# ensure_security_txt <webroot> <canonical-url>
ensure_security_txt() {
  local webroot="$1" canonical="$2"
  render_security_txt "$canonical" \
    | write_root_file "$webroot/.well-known/security.txt" 0644
  ok "security.txt written ($canonical/.well-known/security.txt)"
}

# ---------------------------------------------------------------------------
# Post-certbot fixups
# ---------------------------------------------------------------------------
# These scripts write HTTP-only server blocks and let certbot's nginx plugin
# add the TLS listeners. That rewrite has two side effects we undo here:
#
#  1. Certbot turns each alias into its own HTTPS server whose server_name is
#     the alias, so https://www.<host> matches it and 301s to https://www.<host>
#     before the alias redirect applies — two hops instead of one.
#  2. Only the block certbot upgrades in place gets the TLS listeners, so the
#     HSTS include has to be (re-)asserted inside every `listen 443` block.
#
# nginx_post_tls <slug> <primary-host>
nginx_post_tls() {
  local slug="$1" primary="$2"
  local site="/etc/nginx/sites-available/$slug"
  [ -f "$site" ] || { warn "nginx_post_tls: $site not found"; return 0; }

  sudo HSTS_SNIPPET="$HSTS_SNIPPET" TLS_SNIPPET="$TLS_SNIPPET" PRIMARY="$primary" \
    python3 - "$site" <<'PY'
import os, re, sys

path = sys.argv[1]
snippets = [os.environ["HSTS_SNIPPET"], os.environ["TLS_SNIPPET"]]
primary = os.environ["PRIMARY"]
src = open(path, encoding="utf-8").read()

# Split into top-level server blocks (brace depth from each "server {").
blocks, i = [], 0
while True:
    m = re.compile(r"server\s*\{").search(src, i)
    if not m:
        blocks.append((None, src[i:]))
        break
    if m.start() > i:
        blocks.append((None, src[i:m.start()]))
    depth, j = 0, m.start()
    while j < len(src):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                j += 1
                break
        j += 1
    blocks.append(("server", src[m.start():j]))
    i = j

out, changed = [], []
for kind, text in blocks:
    if kind != "server":
        out.append(text)
        continue

    is_tls = re.search(r"listen\s+(\[::\]:)?443\b", text) is not None
    names = re.search(r"server_name\s+([^;]+);", text)
    names = names.group(1).split() if names else []

    if is_tls:
        # 1. Alias HTTPS block redirecting to itself -> straight to the primary.
        if primary not in names and "return 301" in text:
            new = re.sub(r"return\s+301\s+https://[^;]*;",
                         f"return 301 https://{primary}$request_uri;", text)
            if new != text:
                text, _ = new, changed.append(f"alias {' '.join(names)} -> {primary} (1 hop)")

        # 2. Shared snippet includes inside every TLS block (idempotent).
        for snippet in snippets:
            if snippet in text:
                continue
            text = re.sub(r"\n(\s*)(listen\s+(\[::\]:)?443\b)",
                          lambda mm: f"\n{mm.group(1)}include {snippet};\n{mm.group(1)}{mm.group(2)}",
                          text, count=1)
            label = snippet.rsplit("/", 1)[-1].replace(".conf", "")
            changed.append(f"{label} -> {' '.join(names) or '(unnamed)'}")

    out.append(text)

result = "".join(out)
if result != src:
    open(path, "w", encoding="utf-8", newline="\n").write(result)
for c in changed:
    print("  fixed:", c)
PY
  ok "Post-TLS fixups applied to $slug"
}

# ---------------------------------------------------------------------------
# IPv6 reachability check
# ---------------------------------------------------------------------------
# This host already has a global IPv6 address and every nginx site listens on
# [::], so IPv6 readiness is purely a DNS question: without an AAAA record the
# site is IPv4-only and scanners (internet.nl) fail it outright. That record
# lives at the DNS provider, not in these scripts — so warn loudly instead of
# pretending it is fixed. See server/README.md for the records to create.
#
# check_aaaa <host> [host...]
check_aaaa() {
  local h missing=()
  for h in "$@"; do
    [ -n "$h" ] || continue
    # Query DNS directly. `getent ahostsv6` is NOT usable here: it consults
    # /etc/hosts first (on this server that maps the site's own name to the
    # host's IPv6, a false pass) and also returns IPv4-mapped ::ffff: entries,
    # which RFC 4291 says do not provide IPv6 connectivity.
    local answer=""
    if command -v dig >/dev/null 2>&1; then
      answer="$(dig +short AAAA "$h" 2>/dev/null | grep -v '^$' | grep -v '\.$' | head -1)"
    elif command -v host >/dev/null 2>&1; then
      answer="$(host -t AAAA "$h" 2>/dev/null | grep -i 'has IPv6 address' | head -1)"
    else
      continue  # no resolver tool — skip silently rather than warn wrongly
    fi
    [ -z "$answer" ] && missing+=("$h")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    warn "No AAAA (IPv6) DNS record for: ${missing[*]}"
    warn "  The server is IPv6-ready (nginx listens on [::]); only DNS is missing."
    warn "  Publish AAAA records at the DNS provider — but pin a STATIC IPv6 on"
    warn "  the host first: the current address is SLAAC/dynamic, and a changing"
    warn "  address would black-hole IPv6 clients. See server/README.md."
  else
    ok "AAAA (IPv6) DNS records present for: $*"
  fi
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
# Deliberately false: the deploy scripts this daemon launches end with
# \`sudo systemctl restart <service>\` (allow-listed per service in
# /etc/sudoers.d/). NoNewPrivileges=true is inherited by every child, which
# makes that sudo fail with "the no new privileges flag is set" — the deploy
# then updates the files but silently never restarts the service.
# The sudoers entries stay the real privilege boundary: one exact systemctl
# command per service, nothing else.
NoNewPrivileges=false
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
# Deploy build coalescing
# ---------------------------------------------------------------------------
# deploy_lock_preamble <slug>   -> prints the shell prologue for a deploy body
#
# A push storm used to start one detached build per commit, all against the
# same working directory: they exhausted the VM and, worse, could interleave
# (one build compiling while the next ran `git reset --hard` under it, so the
# published dist mixed two commits).
#
# This serialises them into "run one, queue one, drop the rest" using two
# locks. Dropping is safe because every build starts with
# `git reset --hard origin/<branch>`: whenever the queued build finally runs it
# checks out the LATEST commit, not the one that triggered it. So a burst of
# ten pushes ends on the same commit preemption would have reached, without
# ever killing a build mid-`rsync` and leaving a half-published webroot.
#
# Why two locks: one `flock -n` alone would drop pushes arriving during a
# build, so the newest commit might never deploy. One blocking `flock` alone
# would queue every push, recreating the pile-up.
#
# Locks live in /run (tmpfs, cleared on reboot) so a lock held by a build the
# machine lost to a power cut cannot outlive it. flock also releases a lock
# automatically when the fd closes — including on SIGKILL — so an OOM-killed
# build cannot wedge the queue, which matters when resource exhaustion is the
# very thing being fixed.
#
# Caller contract: keep the build body FOREGROUND. flock(1) warns that a forked
# background process inherits the holding fd, which would keep the lock alive
# past the build.
deploy_lock_preamble() {
  local slug="$1"
  cat <<EOF
# Serialise builds: run one, queue at most one, drop the rest.
# See deploy_lock_preamble in server/common.sh for why.
exec 9>/run/${slug}-deploy.pending.lock
if ! flock -n 9; then
  echo "--- Build already queued; dropping this trigger: \$(date --iso-8601=seconds) ---"
  exit 0
fi
exec 8>/run/${slug}-deploy.run.lock
echo "--- Waiting for any in-flight build: \$(date --iso-8601=seconds) ---"
flock 8
# Free the queue slot now that we hold the build lock, so the NEXT push can
# queue behind us. Holding it for the whole build would drop every later
# push and strand the newest commit undeployed.
exec 9>&-
EOF
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
