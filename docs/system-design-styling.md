# De Ronde kaart — Styling

**Audience:** developers and maintainers. Companion to
[system-design.md](system-design.md) §5.4, which this file replaces in full.

**Start here to change how a layer is styled.** Style is authored once per layer
as GeoStyler rules in `layers.json` and translated per render target — it is
never written as MapLibre paint properties by hand. The shared engine is
[geostyler.ts](../src/layers/geostyler.ts).

---

## One model, three translations

A GeoStyler rule pairs a **filter** (which features it applies to) with
**symbolizers** (how they look). Rules are tested in order and the first match
wins, so specific cases go before catch-alls.

[geostyler.ts](../src/layers/geostyler.ts) holds the shared engine —
`evaluateFilter`, `matchRule` (first match wins), and per-symbolizer extractors.
Filter comparison is deliberately loose (`==`), because JSON config values
arrive as strings or numbers interchangeably and a strict check would silently
fail to match.

**→ MapLibre** ([mvt-style.ts](../src/layers/mvt-style.ts)): rules become
MapLibre filter expressions (`&&`→`all`, `||`→`any`) and symbolizers map by kind
(`Fill`→`fill`, `Line`→`line`, `Mark`→`circle`, `Icon`→`symbol`). Unsupported
kinds warn loudly rather than drawing an invisible layer — an empty layer looks
like a data problem and sends people hunting in the wrong place.

**→ COG** ([cog-style.ts](../src/layers/cog-style.ts)): a per-pixel colour
function where raster bands are exposed as `band0`, `band1`, … and run through
**the same `evaluateFilter`** — so a raster classifies with identical rule
syntax to a vector layer. Registered with the cog-protocol via
`setColorFunction` ([system-design.md](system-design.md) §2).

Authoring style once and translating it has a third payoff beyond the two
renderers: because the rules stay readable data, the legend is generated from
them rather than maintained separately ([legend-style.ts](../src/lib/legend-style.ts)).

---

## Related

| For | Read |
|---|---|
| Which format to reach for, and what each supports | [system-design.md](system-design.md) §5.1 |
| How a layer's style reaches the map at add time | [system-design.md](system-design.md) §5.2 |
| Where a styled layer lands in the draw order | [system-design.md](system-design.md) §5.5 |
| How rules become legend entries and swatches | [legend-style.ts](../src/lib/legend-style.ts) |
| Authoring `style` in a layer config | [system-design.md](system-design.md) §11 |
