import type { LayerEntry } from "@/hooks/use-map-layers";
import type { GeoStylerRule } from "@/layers/types";
import { isChartEligible } from "@/layers/charts";
import { Icon } from "@/components/ui/nav-icon";
import { Button } from "@/components/ui/button";

interface LegendProps {
  entriesA: LayerEntry[];
  entriesB: LayerEntry[];
  hiddenIdsA: Set<string>;
  hiddenIdsB: Set<string>;
  hiddenRulesA: globalThis.Map<string, Set<string>>;
  hiddenRulesB: globalThis.Map<string, Set<string>>;
  onToggleA: (layerId: string) => void;
  onToggleB: (layerId: string) => void;
  onToggleRuleA: (layerId: string, ruleName: string) => void;
  onToggleRuleB: (layerId: string, ruleName: string) => void;
  onRemoveA: (layerId: string) => void;
  onRemoveB: (layerId: string) => void;
  comparisonMode: boolean;
  /** Layer currently shown in the analytics panel (null = panel closed). */
  selectedChartLayerId: string | null;
  /** Select/deselect a layer for the analytics panel. */
  onSelectChartLayer: (layerId: string) => void;
  /** map.json `chartsPanel` gate — false restores plain visibility clicks. */
  chartsEnabled: boolean;
  /** Label of the next basemap (shown in the toggle button's tooltip). */
  nextBasemapLabel: string;
  /** Cycle to the next background basemap. */
  onCycleBasemap: () => void;
}

function colorToCSS(
  color?: [number, number, number] | [number, number, number, number],
): string {
  if (!color) return "rgb(0, 128, 255)";
  const [r, g, b, a] = color;
  return a !== undefined
    ? `rgba(${r}, ${g}, ${b}, ${a / 255})`
    : `rgb(${r}, ${g}, ${b})`;
}

/** Get the display color from the first symbolizer of a GeoStyler rule */
function ruleSwatchColor(rule: GeoStylerRule): string {
  const sym = rule.symbolizers[0];
  if (!sym) return "rgb(0, 128, 255)";
  if (sym.kind === "Fill") return sym.color ?? "#0080ff";
  if (sym.kind === "Line") return sym.color ?? "#0080ff";
  if (sym.kind === "Mark") return sym.color ?? "#0080ff";
  return "#0080ff";
}

function LayerList({
  label,
  entries,
  hiddenIds,
  hiddenRules,
  onToggle,
  onToggleRule,
  onRemove,
  selectedChartLayerId,
  onSelectChartLayer,
  chartsEnabled,
}: {
  label?: string;
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  onToggle: (layerId: string) => void;
  onToggleRule: (layerId: string, ruleName: string) => void;
  onRemove: (layerId: string) => void;
  selectedChartLayerId: string | null;
  onSelectChartLayer: (layerId: string) => void;
  chartsEnabled: boolean;
}) {
  if (entries.length === 0) return null;

  return (
    <div>
      {label && (
        <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
          {label}
        </h4>
      )}
      <ul className="flex flex-col gap-0.5">
        {entries.map(({ config }) => {
          const isVisible = !hiddenIds.has(config.id);
          const rules = config.geostyler?.rules;
          const hasRules = rules && rules.length > 0;
          // A single rule is indistinguishable from the layer itself: the parent
          // row already shows its swatch, so listing it again just duplicates the
          // name. Only break out per-rule class toggles when there are ≥2 rules.
          const showRuleList = rules && rules.length > 1;
          // COG rules are a read-only legend key: the raster is styled per-pixel
          // by a color function, so individual classes can't be toggled the way
          // deck-layer rules can. Render them as non-interactive swatches.
          const isCog = config.format === "cog";
          const layerHiddenRules = hiddenRules.get(config.id);
          const selectable = chartsEnabled && isChartEligible(config);
          const isSelected = selectable && selectedChartLayerId === config.id;

          return (
            <li key={config.id}>
              {/* Layer row: swatch = visibility; name = analytics select on
                  chart-eligible layers, visibility elsewhere; × = remove */}
              <div className="group flex items-center rounded hover:bg-gray-100 transition-colors">
                <button
                  onClick={() => onToggle(config.id)}
                  className="flex-shrink-0 px-1.5 py-1"
                  title="Zichtbaarheid"
                  aria-label={`Zichtbaarheid ${config.name}`}
                >
                  <span
                    className="inline-block h-3 w-3 rounded-none border border-gray-300"
                    style={{
                      backgroundColor: isVisible
                        ? hasRules
                          ? ruleSwatchColor(rules[0])
                          : colorToCSS(config.style.color)
                        : "transparent",
                    }}
                  />
                </button>
                <button
                  onClick={() =>
                    selectable ? onSelectChartLayer(config.id) : onToggle(config.id)
                  }
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1.5 text-left text-sm"
                  title={selectable ? "Statistieken tonen" : "Zichtbaarheid"}
                  aria-pressed={selectable ? isSelected : undefined}
                >
                  <span
                    className={
                      isSelected
                        ? "text-orange-500 font-semibold"
                        : isVisible
                          ? "text-gray-800 font-medium"
                          : "text-gray-400 line-through"
                    }
                  >
                    {config.name}
                  </span>
                  {isSelected && (
                    <Icon name="monitoring" size={14} className="flex-shrink-0 text-orange-500" />
                  )}
                </button>
                <button
                  onClick={() => onRemove(config.id)}
                  className="text-gray-400 hover:text-gray-600 transition-colors text-sm leading-none px-1.5"
                  aria-label={`Verwijder ${config.name}`}
                  title="Laag verwijderen"
                >
                  &times;
                </button>
              </div>

              {/* Per-rule class toggles — only when there's more than one rule */}
              {showRuleList && isVisible && (
                <ul className="ml-5 flex flex-col gap-0.5">
                  {rules.map((rule) => {
                    const isRuleHidden = layerHiddenRules?.has(rule.name) ?? false;
                    const swatch = (
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-none border border-gray-300 flex-shrink-0"
                        style={{
                          backgroundColor: isRuleHidden
                            ? "transparent"
                            : ruleSwatchColor(rule),
                        }}
                      />
                    );

                    // COG: static legend key (no per-class toggle).
                    if (isCog) {
                      return (
                        <li key={rule.name}>
                          <div className="flex w-full items-center gap-2 px-1.5 py-0.5 text-xs">
                            {swatch}
                            <span className="text-gray-600">{rule.name}</span>
                          </div>
                        </li>
                      );
                    }

                    return (
                      <li key={rule.name}>
                        <button
                          onClick={() => onToggleRule(config.id, rule.name)}
                          className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-gray-100 transition-colors"
                        >
                          {swatch}
                          <span
                            className={
                              isRuleHidden
                                ? "text-gray-400 line-through"
                                : "text-gray-600"
                            }
                          >
                            {rule.name}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Legend({
  entriesA,
  entriesB,
  hiddenIdsA,
  hiddenIdsB,
  hiddenRulesA,
  hiddenRulesB,
  onToggleA,
  onToggleB,
  onToggleRuleA,
  onToggleRuleB,
  onRemoveA,
  onRemoveB,
  comparisonMode,
  selectedChartLayerId,
  onSelectChartLayer,
  chartsEnabled,
  nextBasemapLabel,
  onCycleBasemap,
}: LegendProps) {
  const chartProps = { selectedChartLayerId, onSelectChartLayer, chartsEnabled };
  const visibleA = entriesA.filter((e) => !e.config.excludeFromLegend);
  const visibleB = entriesB.filter((e) => !e.config.excludeFromLegend);
  const hasLayers = visibleA.length > 0 || visibleB.length > 0;

  return (
    <div className="w-72 max-h-[50vh] overflow-y-auto rounded-lg bg-white/90 p-2 shadow-md backdrop-blur-sm sm:p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Kaartlagen
        </h3>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onCycleBasemap}
          title={`Achtergrondkaart: ${nextBasemapLabel}`}
          aria-label="Achtergrondkaart wisselen"
        >
          <Icon name="cached" size={20} className="text-gray-400" />
        </Button>
      </div>
      {!hasLayers && (
        <p className="text-xs text-gray-400">Nog geen lagen toegevoegd</p>
      )}
      {comparisonMode ? (
        <div className="flex flex-col gap-2">
          <LayerList
            label="Linker kaart"
            entries={visibleA}
            hiddenIds={hiddenIdsA}
            hiddenRules={hiddenRulesA}
            onToggle={onToggleA}
            onToggleRule={onToggleRuleA}
            onRemove={onRemoveA}
            {...chartProps}
          />
          <LayerList
            label="Rechter kaart"
            entries={visibleB}
            hiddenIds={hiddenIdsB}
            hiddenRules={hiddenRulesB}
            onToggle={onToggleB}
            onToggleRule={onToggleRuleB}
            onRemove={onRemoveB}
            {...chartProps}
          />
        </div>
      ) : (
        <LayerList
          entries={visibleA}
          hiddenIds={hiddenIdsA}
          hiddenRules={hiddenRulesA}
          onToggle={onToggleA}
          onToggleRule={onToggleRuleA}
          onRemove={onRemoveA}
          {...chartProps}
        />
      )}
    </div>
  );
}
