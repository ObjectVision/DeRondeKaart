import type { LayerEntry } from "@/hooks/use-map-layers";
import type { GeoStylerRule } from "@/layers/types";

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
  comparisonMode: boolean;
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
}: {
  label?: string;
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  onToggle: (layerId: string) => void;
  onToggleRule: (layerId: string, ruleName: string) => void;
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
          const hasRules = rules && rules.length > 0 && config.format !== "cog";
          const layerHiddenRules = hiddenRules.get(config.id);

          return (
            <li key={config.id}>
              {/* Layer-level toggle */}
              <button
                onClick={() => onToggle(config.id)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-gray-100 transition-colors"
              >
                <span
                  className="inline-block h-3 w-3 rounded-sm border border-gray-300 flex-shrink-0"
                  style={{
                    backgroundColor: isVisible
                      ? hasRules
                        ? ruleSwatchColor(rules[0])
                        : colorToCSS(config.style.color)
                      : "transparent",
                  }}
                />
                <span
                  className={
                    isVisible
                      ? "text-gray-800 font-medium"
                      : "text-gray-400 line-through"
                  }
                >
                  {config.name}
                </span>
              </button>

              {/* Per-rule class toggles */}
              {hasRules && isVisible && (
                <ul className="ml-5 flex flex-col gap-0.5">
                  {rules.map((rule) => {
                    const isRuleHidden = layerHiddenRules?.has(rule.name) ?? false;
                    return (
                      <li key={rule.name}>
                        <button
                          onClick={() => onToggleRule(config.id, rule.name)}
                          className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-gray-100 transition-colors"
                        >
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-sm border border-gray-300 flex-shrink-0"
                            style={{
                              backgroundColor: isRuleHidden
                                ? "transparent"
                                : ruleSwatchColor(rule),
                            }}
                          />
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
  comparisonMode,
}: LegendProps) {
  const visibleA = entriesA.filter((e) => !e.config.excludeFromLegend);
  const visibleB = entriesB.filter((e) => !e.config.excludeFromLegend);
  if (visibleA.length === 0 && visibleB.length === 0) return null;

  return (
    <div className="max-h-[50vh] overflow-y-auto rounded-lg bg-white/90 p-2 shadow-md backdrop-blur-sm sm:p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Kaartlagen
      </h3>
      {comparisonMode ? (
        <div className="flex flex-col gap-2">
          <LayerList
            label="Map A"
            entries={visibleA}
            hiddenIds={hiddenIdsA}
            hiddenRules={hiddenRulesA}
            onToggle={onToggleA}
            onToggleRule={onToggleRuleA}
          />
          <LayerList
            label="Map B"
            entries={visibleB}
            hiddenIds={hiddenIdsB}
            hiddenRules={hiddenRulesB}
            onToggle={onToggleB}
            onToggleRule={onToggleRuleB}
          />
        </div>
      ) : (
        <LayerList
          entries={visibleA}
          hiddenIds={hiddenIdsA}
          hiddenRules={hiddenRulesA}
          onToggle={onToggleA}
          onToggleRule={onToggleRuleA}
        />
      )}
    </div>
  );
}
