#!/usr/bin/env bash
#
# setup_fileserver.sh — provision one geospatial file-server instance.
#
# Serves .parquet / .arrow / .geoarrow / .pbf(.gz) / .tif(f) over HTTPS with
# open CORS, byte-range support and correct MIME types, for consumption by
# deck.gl, MapLibre, DuckDB-WASM and COG readers in the browser.
#
# Run ON the target server. Any number of file servers can coexist: each is
# namespaced by its own --slug and served on its own --host. Content is put in
# place out-of-band (SFTP/rsync into the data directory); there is no webhook.
#
# Every value can be supplied as a flag or entered at the prompt. A flag value
# is never asked for again. Pass -y/--yes to accept all defaults.
#
# Example:
#   ./setup_fileserver.sh -y \
#       --slug woonzorglimburg_data --host data.woonzorglimburg.nl \
#       --email eoudejans@objectvision.nl

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<EOF
${_C_BOLD}setup_fileserver.sh${_C_RESET} — provision a geospatial file server instance.

Usage: $0 [options]

Options:
$(print_kv "--slug NAME"       "instance id, namespaces all paths (e.g. woonzorglimburg_data)")
$(print_kv "--host HOST"       "hostname (e.g. data.woonzorglimburg.nl)")
$(print_kv "--data-dir PATH"   "directory served (default: /var/www/<slug>)")
$(print_kv "--cors-origin V"   "Access-Control-Allow-Origin value (default: *)")
$(print_kv "--subdirs LIST"    "space-separated data subdirs to create (default: 'parquet arrow tiles cog pmtiles')")
$(print_kv "--autoindex on|off" "directory browsing (default: on)")
$(print_kv "--email ADDR"      "email for Let's Encrypt registration")
$(print_kv "--no-tls"          "skip certbot; serve plain HTTP only")
$(print_kv "-y, --yes"         "non-interactive: accept all defaults")
$(print_kv "-h, --help"        "show this help")
EOF
}

SLUG=""; HOST=""; DATA_DIR=""; CORS_ORIGIN=""; SUBDIRS=""; AUTOINDEX=""
EMAIL=""; NO_TLS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)         SLUG="$2"; shift 2 ;;
    --slug=*)       SLUG="${1#*=}"; shift ;;
    --host)         HOST="$2"; shift 2 ;;
    --host=*)       HOST="${1#*=}"; shift ;;
    --data-dir)     DATA_DIR="$2"; shift 2 ;;
    --data-dir=*)   DATA_DIR="${1#*=}"; shift ;;
    --cors-origin)  CORS_ORIGIN="$2"; shift 2 ;;
    --cors-origin=*) CORS_ORIGIN="${1#*=}"; shift ;;
    --subdirs)      SUBDIRS="$2"; shift 2 ;;
    --subdirs=*)    SUBDIRS="${1#*=}"; shift ;;
    --autoindex)    AUTOINDEX="$2"; shift 2 ;;
    --autoindex=*)  AUTOINDEX="${1#*=}"; shift ;;
    --email)        EMAIL="$2"; shift 2 ;;
    --email=*)      EMAIL="${1#*=}"; shift ;;
    --no-tls)       NO_TLS=1; shift ;;
    -y|--yes)       ASSUME_YES=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

log "File server setup"
require_sudo

ask SLUG "Instance slug" ""
validate_slug "$SLUG"
ask HOST "Hostname" ""
validate_host "$HOST"
ask DATA_DIR    "Data directory"                 "/var/www/$SLUG"
ask CORS_ORIGIN "Access-Control-Allow-Origin"     "*"
ask SUBDIRS     "Data subdirectories to create"   "parquet arrow tiles cog pmtiles"
ask AUTOINDEX   "Directory browsing (on/off)"      "on"
if [ "$NO_TLS" != "1" ]; then
  ask EMAIL "Email for Let's Encrypt" ""
fi

echo
log "Plan"
info "slug         : $SLUG"
info "host         : $HOST"
info "data dir     : $DATA_DIR"
info "subdirs      : $SUBDIRS"
info "CORS origin  : $CORS_ORIGIN"
info "autoindex    : $AUTOINDEX"
info "TLS          : $([ "$NO_TLS" = 1 ] && echo disabled || echo "certbot ($EMAIL)")"
echo
confirm "Proceed?" || die "Aborted."

# --- 1. base packages ---
ensure_base_stack

# --- 2. shared geospatial MIME types ---
GEO_MIME="/etc/nginx/conf.d/geo-mime.conf"
if [ ! -f "$GEO_MIME" ]; then
  log "Writing shared $GEO_MIME"
  write_root_file "$GEO_MIME" 0644 <<'EOF'
types {
    application/vnd.apache.parquet           parquet;
    application/vnd.apache.arrow.file        arrow geoarrow;
    application/vnd.mapbox-vector-tile        pbf;
    application/vnd.pmtiles                   pmtiles;
    image/tiff                                tif tiff;
}
EOF
  ok "geo-mime.conf created"
else
  ok "geo-mime.conf already present (shared)"
fi

# --- 3. data directory ---
log "Creating data directory $DATA_DIR"
sudo mkdir -p "$DATA_DIR"
sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$DATA_DIR"
sudo chmod 2775 "$DATA_DIR"
if [ -n "${SUBDIRS// }" ]; then
  # shellcheck disable=SC2086
  sudo -u "$DEPLOY_USER" mkdir -p $(for d in $SUBDIRS; do printf '%s ' "$DATA_DIR/$d"; done)
fi
ok "Data directory ready. Upload files via SFTP/rsync into $DATA_DIR"

# --- 4. nginx site ---
log "Writing nginx site"
CORS_HEADERS=$(cat <<EOF
        add_header Access-Control-Allow-Origin  "$CORS_ORIGIN"            always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS"      always;
        add_header Access-Control-Allow-Headers "Range, If-None-Match"    always;
        add_header Access-Control-Expose-Headers "Content-Length, Content-Range, ETag, Accept-Ranges" always;
        add_header Accept-Ranges                "bytes"                   always;
EOF
)

nginx_write_site "$SLUG" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;

    root $DATA_DIR;

    autoindex $AUTOINDEX;
    autoindex_exact_size off;
    autoindex_localtime on;

    # Permissive CORS + byte-range support (server-level defaults).
    add_header Access-Control-Allow-Origin  "$CORS_ORIGIN"            always;
    add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS"      always;
    add_header Access-Control-Allow-Headers "Range, If-None-Match"    always;
    add_header Access-Control-Expose-Headers "Content-Length, Content-Range, ETag, Accept-Ranges" always;
    add_header Access-Control-Max-Age       "86400"                   always;
    add_header Accept-Ranges                "bytes"                   always;

    # Cheap CORS preflight
    if (\$request_method = OPTIONS) { return 204; }

    # Vector tiles: serve .pbf, transparently using a co-located .pbf.gz when
    # the client supports gzip.
    location ~* \\.pbf\$ {
        gzip_static always;
        types { application/vnd.mapbox-vector-tile pbf; }
        expires 7d;
    }

    # Direct request for a .pbf.gz — mark it as gzip-encoded MVT.
    location ~* \\.pbf\\.gz\$ {
        types { } default_type application/vnd.mapbox-vector-tile;
        add_header Content-Encoding gzip always;
$CORS_HEADERS
        expires 7d;
    }

    # Large binary geo blobs (incl. Cloud-Optimized GeoTIFFs and PMTiles
    # archives): long cache, range requests, NO runtime gzip (it would disable
    # Range). PMTiles is especially strict here — its tiles, directories and
    # metadata are each gzip-compressed INSIDE the archive, so re-compressing
    # would both break Range reads (the only way it is read) and make clients
    # double-decompress.
    location ~* \\.(parquet|arrow|geoarrow|tif|tiff|pmtiles)\$ {
        expires 30d;
        add_header Cache-Control "public" always;
$CORS_HEADERS
    }

    location / { try_files \$uri \$uri/ =404; }

    # RFC 9116 — served as plain text, not sniffed. Sits outside the geo-mime
    # types and the binary/range location blocks above.
    location = /.well-known/security.txt { default_type text/plain; }

    gzip off;
}
EOF
nginx_enable_site "$SLUG"
nginx_test_reload

# --- 5. TLS ---
if [ "$NO_TLS" = "1" ]; then
  warn "TLS skipped (--no-tls). Served over plain HTTP."
else
  ensure_hsts_snippet
  ensure_tls_hardening_snippet
  tls_obtain "$EMAIL" "$HOST" || true
  nginx_post_tls "$SLUG" "$HOST"
  ensure_security_txt "$DATA_DIR" "https://$HOST"
  check_aaaa "$HOST"
  nginx_test_reload
fi

SCHEME=$([ "$NO_TLS" = 1 ] && echo http || echo https)
echo
ok "File server '$SLUG' is set up."
info "URL       : $SCHEME://$HOST/"
info "Data dir  : $DATA_DIR  (upload via: rsync -av ./local/ $DEPLOY_USER@$HOST-host:$DATA_DIR/)"
info "Subdirs   : $SUBDIRS"
