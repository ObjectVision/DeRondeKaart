# Setting up a file server

Provisions one **geospatial file-server** instance behind nginx: a static,
read-only HTTPS host tuned for browser-side geodata consumed by
MapLibre, DuckDB-WASM and COG readers. Automated by
[`setup_fileserver.sh`](setup_fileserver.sh).

Any number of file servers can run on the same host — each is identified by a
`--slug` and served on its own hostname. See [README.md](README.md) for the
shared multi-instance model.

---

## What it produces

| Path | Purpose |
|---|---|
| `/var/www/<slug>` (or `--data-dir`) | data root, served directly |
| `/var/www/<slug>/{parquet,arrow,tiles,cog}` | default subdirectories |
| `/etc/nginx/sites-available/<slug>` | nginx server block (symlinked into `sites-enabled/`) |
| `/etc/nginx/conf.d/geo-mime.conf` | **shared** geospatial MIME types (created once) |

There is **no git repo and no webhook** — content is uploaded out-of-band via
SFTP/rsync into the data directory.

---

## Why the nginx config looks the way it does

The geo formats have subtle serving requirements:

- **Byte-range requests** (`Accept-Ranges: bytes`) — DuckDB-WASM, GeoParquet and
  Arrow IPC do random-access reads; COG readers fetch tile windows. Runtime gzip
  would disable `Range`, so **gzip is off** for `.parquet/.arrow/.geoarrow/.tif`.
- **Open CORS** — the map app is served from a different subdomain, so
  `Access-Control-Allow-Origin` (default `*`, override with `--cors-origin`) plus
  `Access-Control-Expose-Headers` for `Content-Range`/`ETag`/`Accept-Ranges`.
- **Pre-compressed vector tiles** — `.pbf` is served with `gzip_static`, using a
  co-located `.pbf.gz` when the client accepts gzip; a direct `.pbf.gz` request is
  labelled `Content-Encoding: gzip` with the MVT content type.
- **Long immutable caching** on the large binary blobs.
- **Correct MIME types** via the shared `geo-mime.conf`
  (`parquet`, `arrow`/`geoarrow`, `pbf`, `tif`/`tiff`).

---

## Parameters

| Flag | Prompt | Default |
|---|---|---|
| `--slug NAME` | Instance slug | *(required)* |
| `--host HOST` | Hostname | *(required)* |
| `--data-dir PATH` | Directory served | `/var/www/<slug>` |
| `--cors-origin V` | `Access-Control-Allow-Origin` | `*` |
| `--subdirs LIST` | Data subdirs to create | `parquet arrow tiles cog` |
| `--autoindex on\|off` | Directory browsing | `on` |
| `--email ADDR` | Let's Encrypt email | *(required unless `--no-tls`)* |
| `--no-tls` | Serve plain HTTP, skip certbot | off |

---

## Process

1. **Base stack** — install nginx/git/jq/rsync; enable nginx.
2. **MIME types** — create the shared `/etc/nginx/conf.d/geo-mime.conf` if absent.
3. **Data directory** — create `--data-dir` (owned by the deploy user, `setgid`
   mode 2775) and the requested subdirectories.
4. **nginx** — write and enable the server block with the CORS / range / gzip_static
   / caching rules described above.
5. **TLS** — `certbot --nginx --redirect` for the host, unless `--no-tls`.
6. **Output** — print the URL and an example upload command.

---

## Uploading data

The deploy user owns the data directory, so upload over SSH:

```bash
rsync -av ./local_parquet/ cicada@<server>:/var/www/<slug>/parquet/
# or drop files with any SFTP client into /var/www/<slug>/...
```

Files are immediately live. Reference them from the map app as
`https://<host>/parquet/<file>.parquet`, `https://<host>/tiles/{z}/{x}/{y}.pbf`, etc.

---

## Verifying

```bash
# Range request returns 206 with Content-Range
curl -sI -H "Range: bytes=0-1023" https://<host>/parquet/<sample>.parquet | head

# CORS headers present
curl -sI -H "Origin: https://map.example.com" \
  https://<host>/parquet/<sample>.parquet | grep -i access-control

# .pbf gzip negotiation (needs a co-located .pbf.gz)
curl -sI -H "Accept-Encoding: gzip" \
  https://<host>/tiles/<z>/<x>/<y>.pbf | grep -iE 'content-(encoding|type)'
```

---

## Examples

```bash
# Interactive
./setup_fileserver.sh

# Non-interactive, matching the current production instance
./setup_fileserver.sh -y \
  --slug woonzorglimburg_data --host data.woonzorglimburg.nl \
  --email eoudejans@objectvision.nl

# A second, origin-locked file server on the same host
./setup_fileserver.sh -y \
  --slug acme_data --host data.acme.com \
  --cors-origin "https://map.acme.com" \
  --subdirs "parquet cog" --email ops@acme.com
```
