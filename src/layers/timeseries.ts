import type { LayerConfig } from "@/layers/types";

/**
 * Substitute a timeseries layer's placeholder into one of its templated fields.
 *
 * `split`/`join` rather than `replace`, so every occurrence goes — matching
 * `timeseriesSourceLayer` in `use-map-layers.ts`, which resolves the same
 * placeholder for `sourceLayer`.
 */
function substituteStep(template: string, placeholder: string, step: number): string {
  return template.split(placeholder).join(String(step));
}

/**
 * A layer's companion class raster for one timeseries step.
 *
 * Resolved at the point of use rather than rewritten into the config the way
 * `sourceLayer` is: a combination is a snapshot of the step the legend showed
 * when it was created, so the config has to keep the template available for the
 * next combination at a different step.
 *
 * `step` is what the legend currently shows for this layer; `undefined` (the
 * layer has never been stepped) falls back to the configured start, the same
 * default the slider and `advanceStep` use.
 */
export function filterRasterForStep(
  config: LayerConfig,
  step: number | undefined,
): string | undefined {
  const template = config.filterRaster;
  if (!template) return undefined;

  const ts = config.timeseries;
  if (!ts) return template;

  return substituteStep(template, ts.placeholder, step ?? ts.start);
}
