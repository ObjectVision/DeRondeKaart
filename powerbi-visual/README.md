# Northwake Kaart — Power BI custom visual

A thin Power BI custom visual that embeds the northwake map application in an
iframe and drives it via postMessage. Power BI data (points via lng/lat, lines
and polygons via WKT) renders as a dynamic layer on the **left map**; predefined
layers from the app's `layers.json` can be added by id to either map.

## Architecture

```
Power BI ──update()──► visual.ts ──postMessage──► iframe (hosted map app)
                          │  { type: "map-command", commands, view }   ← existing app protocol
                          │  { type: "map-data", dataset }             ← dynamic PBI data (GeoJSON)
                          │  { type: "map-data-remove", id }
                          ◄── { type: "map-ready", v: 1 }              ← handshake, app is booted
```

- The visual converts DataView rows to **GeoJSON** before posting (WKT is parsed
  with `wellknown` inside the visual), so the app protocol stays format-agnostic.
- The app renders the dataset with the in-memory `"geojson"` layer format
  (`src/hooks/use-embed-data.ts` + `createGeoJsonLayers`), participating in the
  app legend like any other layer.
- Messages are queued visual-side until the app posts `map-ready`; on an iframe
  reload the desired state (layers + dataset) is re-sent in full.

## Field wells (Gegevens)

| Well | Purpose |
|---|---|
| **Lengtegraad (X)** / **Breedtegraad (Y)** | WGS84 coordinates → point features |
| **Geometrie (WKT)** | WKT column (`POINT`/`LINESTRING`/`POLYGON`, incl. `MULTI*`) → takes precedence over lng/lat |
| **Knopinfo** | Extra columns carried along as feature properties |

Rows without valid geometry are skipped (count logged to the console). Data is
capped at 30 000 rows (`dataReductionAlgorithm.top`).

## Format pane (Visual opmaken)

- **Kaart**: app URL (default `https://data.woonzorglimburg.nl/app/` — adjust to
  the real hosting path), comma-separated `layers.json` ids for the left/right
  map, auto-zoom toggle.
- **Puntstijl / Lijnstijl / Polygoonstijl**: color, size/width, opacity for the
  dynamic Power BI data layer. The card matching the dominant geometry type of
  the bound data is applied. `layers.json` layers keep their server-defined style.

## Build

```bash
cd powerbi-visual
npm ci
npx pbiviz package        # → dist/*.pbiviz
```

Requires Node 18+. The `pbiviz start` dev-server additionally needs a local
certificate (`pbiviz install-cert`, requires PowerShell 7 / `pwsh` on Windows);
packaging does not.

## Import into Power BI

1. Power BI Desktop → *Visualisaties* → **…** → *Een visual importeren uit een
   bestand* → select `dist/*.pbiviz`.
2. On first use Power BI asks consent for the visual's **WebAccess** privilege
   (`https://data.woonzorglimburg.nl`, `http://localhost:5173` for dev).
3. Bind fields, set the app URL in the format pane if it differs from the default.

## Hosting requirements (nested iframe = two separate gates)

Power BI runs custom visuals in a sandbox iframe with **only `allow-scripts`**
(no `allow-same-origin`), so this visual has a **`null` origin**, and Power BI
applies a Content-Security-Policy whose allow-list is exactly the WebAccess
`parameters`. A nested iframe to the app must pass **both** gates, or you get
"This content is blocked. Contact the site owner to fix the issue":

1. **Power BI CSP (visual side).** The app URL host **must** be listed in the
   `WebAccess` privilege in `capabilities.json` — WebAccess updates the CSP
   `default-src`/`frame-src`. If the format-pane **App-URL** points at a host
   that isn't whitelisted, the iframe is blocked before any request is made.
   Current whitelist: `https://map.woonzorglimburg.nl`,
   `https://data.woonzorglimburg.nl`, `https://*.woonzorglimburg.nl`,
   `http://localhost:5173`. **Add your host here and repackage if it differs.**
   (Also: a tenant admin must enable custom-visual web access in the admin
   portal for WebAccess to take effect.)
2. **App server (target side).** The app must allow being framed from a null
   origin:
   - Do **not** send `X-Frame-Options: DENY/SAMEORIGIN`.
   - If a CSP is set on the app, include `frame-ancestors *` (a null origin
     cannot be named explicitly, so the wildcard is required here).
   - Serve over **HTTPS** (mixed content is blocked); `http://localhost:5173`
     works only in local `pbiviz start` dev.

Quick check: open the app URL directly in a browser tab — if it loads there but
shows "content is blocked" in Power BI, the cause is gate #1 (host not in
WebAccess) or an `X-Frame-Options`/`frame-ancestors` header on the app (gate #2).

## Known v1 limitations

- Dynamic data renders on the left map only; no cross-filtering from map clicks
  back into Power BI (one-directional PBI → map).
- Removing the "Power BI data" layer via the app legend's ✕ is undone by the
  next Power BI update (the dataset is re-sent in full).
- One style is applied per update, chosen by the dominant geometry type of the
  bound data.
