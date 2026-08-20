# Deployment Guide

## Overview

The map application runs as a Docker container (nginx serving static Vite build). An nginx reverse proxy on the host serves static map data files and proxies requests to the container.

```
Client → Host Nginx → Docker Container (app)
                   ↘ /data/ → /srv/mapdata/ (static files)
```

## Prerequisites

- Docker and Docker Compose
- nginx on the host server
- (Optional) certbot for SSL

## 1. Build and Run the Container

```bash
# Build the image
docker compose build

# Run with default example config
docker compose up -d

# Run on a custom port
MAP_PORT=8081 docker compose up -d
```

The container serves the app on port 80 internally, mapped to `MAP_PORT` (default 8080) on the host.

## 2. Configure the project (config overlay)

The config JSONs (`map.json`, `layers.json`, `filter.json`, `charts.json`,
`navigation.json` and the four `dashboard_*.json`) are selected **at build time** via the `CONFIG_PROJECT` build arg.
It picks a `configs/<project>/` directory that is overlaid on the `public/` defaults
(see [`../configs/README.md`](../configs/README.md)). Files a project omits fall back
to the `public/` default.

```bash
# Build the woonzorglimburg config
CONFIG_PROJECT=woonzorglimburg docker compose build

# Build the public/ defaults (no overlay)
docker compose build
```

`docker-compose.yml` reads `CONFIG_PROJECT` from the environment and passes it as the
build arg. There is no runtime `layers.json` mount any more — all configs are baked into
the image.

The `layers.json` file references data sources. For files served from the same host, use
the `/data/` path prefix:

```json
{
  "layers": [
    {
      "id": "my-layer",
      "name": "My Layer",
      "source": "/data/my-layer.parquet",
      "format": "parquet",
      "geometryType": "polygon",
      "style": { "opacity": 0.8 }
    }
  ]
}
```

## 3. Serve Static Map Data

Place your data files in a directory on the host (e.g., `/srv/mapdata/`):

```
/srv/mapdata/
├── my-layer.parquet
├── another.arrow
└── tiles/
    └── {z}/{x}/{y}.pbf
```

## 4. Configure Host Nginx

```bash
# Copy the site config
sudo cp deploy/nginx-host.conf /etc/nginx/sites-available/maps.example.com

# Edit: replace maps.example.com, /srv/mapdata, localhost:8080
sudo nano /etc/nginx/sites-available/maps.example.com

# Enable the site
sudo ln -s /etc/nginx/sites-available/maps.example.com /etc/nginx/sites-enabled/

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

## 5. Enable SSL (Optional)

```bash
sudo certbot --nginx -d maps.example.com
```

## Multiple Instances

To run multiple app instances with different configs, build each with its own
`CONFIG_PROJECT` (each `configs/<project>/` is committed in the repo):

```yaml
# docker-compose.override.yml
services:
  mapapp-projectA:
    build:
      context: .
      args:
        CONFIG_PROJECT: projectA
    ports:
      - "8081:80"

  mapapp-projectB:
    build:
      context: .
      args:
        CONFIG_PROJECT: projectB
    ports:
      - "8082:80"
```

Then add separate `location` blocks or `server` blocks in the host nginx config for each instance.

## File Reference

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build (Node → nginx) |
| `docker-compose.yml` | Container orchestration; `CONFIG_PROJECT` build arg |
| `deploy/nginx-container.conf` | Nginx config inside the container |
| `deploy/nginx-host.conf` | Host nginx site config (reverse proxy + static data) |
| `configs/<project>/` | Per-project config overlay (see `configs/README.md`) |
