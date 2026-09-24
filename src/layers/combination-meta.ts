import type { FilterLayerDef, ScoreClass } from "@/layers/filter-layers";
import { COMBINATION_STRATEGY } from "@/layers/filter-layers";
import type { GeoStylerRule, LayerConfig } from "@/layers/types";

/** One chosen class of a criterion, with the source layer's rule for it. */
export interface CriterionClass {
  name: string;
  /**
   * The rule the source layer draws this class with, so the metainfo can show
   * the same swatch the legend does. Undefined when the layer or rule is gone.
   */
  rule?: GeoStylerRule;
}

/** One criterion: a source layer and the classes of it that count. */
export interface Criterion {
  layerId: string;
  /** The layer's name; its id when the layer is not in this variant's config. */
  name: string;
  subname?: string;
  /** The frozen timeseries step, for a timeseries layer. */
  year?: number;
  classes: CriterionClass[];
  /**
   * The layer is not in the loaded config — a share link from another variant,
   * say. The criterion is still listed, from the definition alone, rather than
   * silently dropped: it did shape the score grid.
   */
  missing: boolean;
}

/** Everything the generated Toelichting shows, derived from the definition. */
export interface CombinationDescription {
  name: string;
  strategy: string;
  criteria: Criterion[];
  /** The legend in score order, index 0 = score 1. */
  legend: ScoreClass[];
}

/**
 * The metainfo of a combination, generated from its definition — combinations
 * are never in layers.json, so there is no published fragment to fetch.
 *
 * One criterion per source LAYER, in the order the layers were first chosen,
 * mirroring how the score counts: classes of one layer are alternatives, and
 * each layer adds at most one to a cell's score (`layerCountOf`,
 * `scoreInputsFor`). Listing per class would suggest the opposite.
 */
export function describeCombination(
  def: FilterLayerDef,
  configs: LayerConfig[],
): CombinationDescription {
  const criteria: Criterion[] = [];
  for (const layerId of new Set(def.refs.map((ref) => ref.layerId))) {
    const config = configs.find((c) => c.id === layerId);
    const rules = config?.geostyler?.rules ?? [];
    criteria.push({
      layerId,
      name: config?.name ?? layerId,
      subname: config?.subname,
      year: def.steps?.[layerId],
      classes: def.refs
        .filter((ref) => ref.layerId === layerId)
        .map((ref) => ({
          name: ref.ruleName,
          rule: rules.find((rule) => rule.name === ref.ruleName),
        })),
      missing: !config,
    });
  }

  return {
    name: def.name,
    strategy: COMBINATION_STRATEGY,
    criteria,
    legend: def.classes,
  };
}
