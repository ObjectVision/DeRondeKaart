# De Ronde kaart — Power BI integration

**Audience:** developers and maintainers. Companion to
[system-design.md](system-design.md) §11, which this file replaces in full.

**This integration is optional and peripheral.** The app neither knows nor cares
whether it is embedded, beyond a `postMessage` listener and a snapshot hook.
Nothing in the core system depends on it, and a deployment that never touches
Power BI carries no cost for its existence.

---

## What it is

[powerbi-visual/](../powerbi-visual/) is a thin custom visual that embeds the
hosted app in an iframe and drives it via `postMessage`. It renders no map
itself, and data flows one way (Power BI → map, no cross-filtering back).

## What leaks into the app

Two things, and both are worth knowing before touching the code they live in:

- **The `geojson` layer format exists for this.** Power BI data is already in
  memory in the host, so there is nothing to fetch: features arrive on
  `config.data` instead of being loaded from `source`
  ([system-design.md](system-design.md) §6.1), pushed by
  [use-embed-data.ts](../src/hooks/use-embed-data.ts). It is deliberately absent
  from `VALID_FORMATS`, so it can never appear in a `layers.json` — outside the
  embed there would be no data to render.
- **The snapshot bridge** ([use-map-snapshot.ts](../src/hooks/use-map-snapshot.ts))
  pushes a JPEG of the canvas to the parent, because Power BI's PDF/PowerPoint
  export does not rasterize cross-origin sandboxed iframes — without it the map
  exports blank. Gated on being embedded, not on the `share` flag, so export
  works even where the share UI is off.

## Where the rest is documented

The message protocol, the WKB column mapping, and the two hosting gates (host
`WebAccess` privilege, and no `X-Frame-Options`/`frame-ancestors` at all) are
documented where they are maintained. Both hosting gates must pass or the
iframe never loads:

| For | Read |
|---|---|
| Building, publishing, field wells, format pane | [powerbi-visual/README.md](../powerbi-visual/README.md) |
| Hosting gotchas and known failures | [powerbi-visual/known_issues.md](../powerbi-visual/known_issues.md) |
| The `geojson` format in the format matrix | [system-design.md](system-design.md) §6.1 |
