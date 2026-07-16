import { memo } from "react";
import type { LayerEntry } from "@/hooks/use-map-layers";
import { Icon } from "@/components/ui/nav-icon";
import { Button } from "@/components/ui/button";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";
import { colorToCSS, ruleSwatchColor } from "@/lib/legend-style";

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
  /**
   * The right map is mounted full-width on top of the left map (it has
   * comparable layers while the left map has none). Outside comparison mode
   * the legend then lists map B — that's the map actually on screen.
   */
  mapBOnTop: boolean;
  /** Label of the next basemap (shown in the toggle button's tooltip). */
  nextBasemapLabel: string;
  /** Cycle to the next background basemap. */
  onCycleBasemap: () => void;
  /** Collapse the Kaartlagen window (restored from the bottom-left bar). */
  onClose?: () => void;
}

function LayerList({
  label,
  entries,
  hiddenIds,
  hiddenRules,
  onToggle,
  onToggleRule,
  onRemove,
}: {
  label?: string;
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  onToggle: (layerId: string) => void;
  onToggleRule: (layerId: string, ruleName: string) => void;
  onRemove: (layerId: string) => void;
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

          return (
            <li key={config.id}>
              {/* Layer row: swatch = visibility; name = visibility; × = remove */}
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
                  onClick={() => onToggle(config.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1.5 text-left text-sm"
                  title="Zichtbaarheid"
                >
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
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onRemove(config.id)}
                  aria-label={`Verwijder ${config.name}`}
                  title="Laag verwijderen"
                >
                  <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
                </Button>
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

/**
 * Memoized: App re-renders ~60×/sec during a pan (view state), and every
 * Legend prop is referentially stable across those renders.
 */
export const Legend = memo(function Legend({
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
  mapBOnTop,
  nextBasemapLabel,
  onCycleBasemap,
  onClose,
}: LegendProps) {
  const visibleA = entriesA.filter((e) => !e.config.excludeFromLegend);
  const visibleB = entriesB.filter((e) => !e.config.excludeFromLegend);
  const hasLayers = visibleA.length > 0 || visibleB.length > 0;

  return (
    <div className="w-72 max-h-[50vh] overflow-y-auto rounded-lg bg-white/90 p-2 shadow-md backdrop-blur-sm sm:p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Kaartlagen
        </h3>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCycleBasemap}
            title={`Achtergrondkaart: ${nextBasemapLabel}`}
            aria-label="Achtergrondkaart wisselen"
          >
            <Icon name="cached" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              title="Kaartlagen verbergen"
              aria-label="Kaartlagen verbergen"
            >
              <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
            </Button>
          )}
        </div>
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
          />
          <LayerList
            label="Rechter kaart"
            entries={visibleB}
            hiddenIds={hiddenIdsB}
            hiddenRules={hiddenRulesB}
            onToggle={onToggleB}
            onToggleRule={onToggleRuleB}
            onRemove={onRemoveB}
          />
        </div>
      ) : mapBOnTop ? (
        <LayerList
          entries={visibleB}
          hiddenIds={hiddenIdsB}
          hiddenRules={hiddenRulesB}
          onToggle={onToggleB}
          onToggleRule={onToggleRuleB}
          onRemove={onRemoveB}
        />
      ) : (
        <LayerList
          entries={visibleA}
          hiddenIds={hiddenIdsA}
          hiddenRules={hiddenRulesA}
          onToggle={onToggleA}
          onToggleRule={onToggleRuleA}
          onRemove={onRemoveA}
        />
      )}
    </div>
  );
});
