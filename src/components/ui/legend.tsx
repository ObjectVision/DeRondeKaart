import { memo } from "react";
import type { LayerEntry } from "@/hooks/use-map-layers";
import { Icon } from "@/components/ui/nav-icon";
import { Button } from "@/components/ui/button";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";
import { colorToCSS, ruleSwatchColor } from "@/lib/legend-style";

/**
 * Play/pause + scrub control for a timeseries layer, shown under its legend
 * classes. Dragging the slider pauses playback: scrubbing and playing at the
 * same time would fight over the rendered step.
 */
function TimeseriesControl({
  config,
  step,
  playing,
  onTogglePlay,
  onSetStep,
}: {
  config: LayerEntry["config"];
  step: number;
  playing: boolean;
  onTogglePlay: (layerId: string) => void;
  onSetStep: (layerId: string, value: number) => void;
}) {
  const ts = config.timeseries;
  if (!ts) return null;

  return (
    <div className="ml-5 flex items-center gap-2 px-1.5 py-1">
      <button
        onClick={() => onTogglePlay(config.id)}
        className="flex-shrink-0 leading-none text-gray-600 hover:text-gray-900 transition-colors"
        title={playing ? "Pauzeer" : "Afspelen"}
        aria-label={playing ? `Pauzeer ${config.name}` : `Speel ${config.name} af`}
      >
        {/* Two literal `name` props, not a ternary inside one: the icon-font
            subsetter scans for `name="…"` and would miss the second string. */}
        {playing ? (
          <Icon name="pause_circle" size={chromeIconSize()} color={chromeIconColor()} />
        ) : (
          <Icon name="play_circle" size={chromeIconSize()} color={chromeIconColor()} />
        )}
      </button>
      <input
        type="range"
        min={ts.start}
        max={ts.end}
        step={ts.step}
        value={step}
        onChange={(e) => onSetStep(config.id, Number(e.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-gray-200 accent-blue-600"
        aria-label={`Jaar ${config.name}`}
      />
      <span className="w-10 flex-shrink-0 text-right text-xs tabular-nums text-gray-600">
        {step}
      </span>
    </div>
  );
}

interface LegendProps {
  /** Layers for the map this legend represents. */
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  /** Timeseries: current step per layer id, and which layers are playing. */
  layerSteps: globalThis.Map<string, number>;
  playingIds: Set<string>;
  onToggle: (layerId: string) => void;
  onToggleRule: (layerId: string, ruleName: string) => void;
  onTogglePlay: (layerId: string) => void;
  onSetStep: (layerId: string, value: number) => void;
  onRemove: (layerId: string) => void;
  /**
   * Move a layer to the other map. Direction ("right" from the left legend,
   * "left" from the right legend) picks the arrow_circle icon; omit to hide the
   * button (e.g. when there is no second map to move to).
   */
  onMove?: (layerId: string) => void;
  moveDirection?: "right" | "left";
  /**
   * Grey out (disable) the move button — e.g. the left map holds only this one
   * layer, so moving it to the right map would leave the left map empty (the
   * right map cannot hold layers without a left map to anchor the comparison).
   */
  moveDisabled?: boolean;
  /**
   * Header chrome (basemap toggle + collapse button) is shown only when these
   * are provided — the left-map legend hosts them; the right-map legend renders
   * a title-only header. Its position (bottom-left vs bottom-right) identifies
   * which map it belongs to, so no per-map label is needed.
   */
  nextBasemapLabel?: string;
  onCycleBasemap?: () => void;
  /** Collapse the Kaartlagen window (restored from the bottom-left bar). */
  onClose?: () => void;
}

function LayerList({
  entries,
  hiddenIds,
  hiddenRules,
  layerSteps,
  playingIds,
  onToggle,
  onToggleRule,
  onTogglePlay,
  onSetStep,
  onRemove,
  onMove,
  moveDirection,
  moveDisabled,
}: {
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  layerSteps: globalThis.Map<string, number>;
  playingIds: Set<string>;
  onToggle: (layerId: string) => void;
  onToggleRule: (layerId: string, ruleName: string) => void;
  onTogglePlay: (layerId: string) => void;
  onSetStep: (layerId: string, value: number) => void;
  onRemove: (layerId: string) => void;
  onMove?: (layerId: string) => void;
  moveDirection?: "right" | "left";
  moveDisabled?: boolean;
}) {
  if (entries.length === 0) return null;

  return (
    <div>
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
                {onMove && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={moveDisabled}
                    onClick={() => onMove(config.id)}
                    aria-label={
                      moveDirection === "left"
                        ? `Verplaats ${config.name} naar linker kaart`
                        : `Verplaats ${config.name} naar rechter kaart`
                    }
                    title={
                      moveDisabled
                        ? "Voeg eerst een laag toe aan de linker kaart"
                        : moveDirection === "left"
                          ? "Naar linker kaart"
                          : "Naar rechter kaart"
                    }
                  >
                    <Icon
                      name={moveDirection === "left" ? "arrow_circle_left" : "arrow_circle_right"}
                      size={chromeIconSize()}
                      color={moveDisabled ? undefined : chromeIconColor()}
                      className={moveDisabled ? "text-gray-300" : undefined}
                    />
                  </Button>
                )}
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

              {/* Timeseries playback, under the classes it animates */}
              {config.timeseries && isVisible && (
                <TimeseriesControl
                  config={config}
                  step={layerSteps.get(config.id) ?? config.timeseries.start}
                  playing={playingIds.has(config.id)}
                  onTogglePlay={onTogglePlay}
                  onSetStep={onSetStep}
                />
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
  entries,
  hiddenIds,
  hiddenRules,
  layerSteps,
  playingIds,
  onToggle,
  onToggleRule,
  onTogglePlay,
  onSetStep,
  onRemove,
  onMove,
  moveDirection,
  moveDisabled,
  nextBasemapLabel,
  onCycleBasemap,
  onClose,
}: LegendProps) {
  const visible = entries.filter((e) => !e.config.excludeFromLegend);
  // Only the left-map legend hosts the basemap toggle + collapse button.
  const showChrome = Boolean(onCycleBasemap);

  return (
    <div className="w-72 max-h-[50vh] overflow-y-auto rounded-lg bg-white/90 p-2 shadow-md backdrop-blur-sm sm:p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Kaartlagen
        </h3>
        {showChrome && (
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
                <Icon name="remove" size={chromeIconSize()} color={chromeIconColor()} />
              </Button>
            )}
          </div>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="text-xs text-gray-400">Nog geen lagen toegevoegd</p>
      ) : (
        <LayerList
          entries={visible}
          hiddenIds={hiddenIds}
          hiddenRules={hiddenRules}
          layerSteps={layerSteps}
          playingIds={playingIds}
          onToggle={onToggle}
          onToggleRule={onToggleRule}
          onTogglePlay={onTogglePlay}
          onSetStep={onSetStep}
          onRemove={onRemove}
          onMove={onMove}
          moveDirection={moveDirection}
          moveDisabled={moveDisabled}
        />
      )}
    </div>
  );
});
