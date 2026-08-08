import { memo, useCallback, useRef } from "react";
import type { LayerEntry } from "@/hooks/use-map-layers";
import { Icon } from "@/components/ui/nav-icon";
import { Button } from "@/components/ui/button";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";
import { useRowDrag } from "@/components/ui/use-row-drag";
import { foregroundRank } from "@/components/map/map-view-config";
import { ruleSwatchSpec, styleSwatchSpec } from "@/lib/legend-style";
import { Swatch } from "@/components/ui/swatch";
import { compositeLegendRules } from "@/layers";
import type { GeoStylerRule } from "@/layers";

/** One class row in the legend, from either a layer's own rules or a composite's children. */
interface LegendRow {
  rule: GeoStylerRule;
  /** Identity passed to onToggleRule — a bare rule name, or "<childIndex>:<name>". */
  key: string;
  /** False when the layer type can't hide a single class (COG). */
  interactive: boolean;
}

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
  /**
   * Height cap for the card. Defaults to half the viewport, which suits the
   * right-map legend in the bottom-right stack (an unbounded parent, so the
   * card must cap itself). The left-map legend lives in the left column, whose
   * flex parent has already been sized to the space left over below the
   * navigation — there it passes `max-h-full` so that parent binds instead.
   */
  maxHeightClass?: string;
  /**
   * Reorder draw order by dragging a row's handle. `toIndex` is in DRAW-ORDER
   * space (0 = bottom), already converted from the reversed display order.
   * Omit to render the list without drag handles.
   */
  onReorder?: (layerId: string, toIndex: number) => void;
}

/** Stable identity, so a drag-less list doesn't re-bind the drag effect. */
const noop = () => {};

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
  onReorder,
  scrollRef,
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
  onReorder?: (layerId: string, toDisplayIndex: number) => void;
  scrollRef?: React.RefObject<HTMLElement | null>;
}) {
  // `entries` is display order (top of map first). The hook reports the slot in
  // that same space; Legend converts to draw order.
  const drag = useRowDrag(
    entries.map((e) => e.config.id),
    onReorder ?? noop,
    scrollRef,
  );

  if (entries.length === 0) return null;

  return (
    <div>
      <ul className="flex flex-col gap-0.5">
        {entries.map(({ config }, rowIndex) => {
          const isVisible = !hiddenIds.has(config.id);
          const isDragging = drag.draggingId === config.id;
          // COG rules are a read-only legend key: the raster is styled per-pixel
          // by a color function, so individual classes can't be toggled the way
          // deck-layer rules can. Render them as non-interactive swatches.
          const isCog = config.format === "cog";
          // Two sources of legend classes, normalized to one shape:
          //  - the layer's own geostyler rules (keyed by bare rule name), or
          //  - for a composite WITHOUT its own geostyler, each child's rules in
          //    order, keyed "<childIndex>:<name>" so same-named classes in
          //    different children stay independent.
          const ownRules = config.geostyler?.rules;
          const rows: LegendRow[] = ownRules?.length
            ? ownRules.map((rule) => ({ rule, key: rule.name, interactive: !isCog }))
            : compositeLegendRules(config).map((ref) => ({
                rule: ref.rule,
                key: ref.key,
                interactive: ref.interactive,
              }));
          const hasRules = rows.length > 0;
          // A single rule is indistinguishable from the layer itself: the parent
          // row already shows its swatch, so listing it again just duplicates the
          // name. Only break out per-rule class toggles when there are ≥2 rules.
          const showRuleList = rows.length > 1;
          const layerHiddenRules = hiddenRules.get(config.id);

          return (
            <li key={config.id} ref={drag.rowRef(config.id)}>
              {/* Where the dragged row would land. Rendered inside the row it
                  precedes so it needs no extra list item. */}
              {drag.overIndex === rowIndex && (
                <div className="-mt-px mb-px h-0.5 rounded-full bg-[#3E74A7]" />
              )}
              {/* Layer row: swatch = visibility; name = visibility; × = remove */}
              <div
                className={`group flex items-center rounded transition-colors ${
                  isDragging ? "bg-gray-100 opacity-60" : "hover:bg-gray-100"
                }`}
              >
                {onReorder && (
                  <span
                    // A dedicated handle: the rest of the row toggles visibility,
                    // so dragging from anywhere would fight that. Not a <button>
                    // — it has no click action and must not take Enter/Space.
                    role="separator"
                    aria-label={`Versleep ${config.name} om de tekenorde te wijzigen`}
                    title="Versleep om de tekenorde te wijzigen"
                    className="flex-shrink-0 cursor-grab touch-none pl-0.5 pr-0.5 text-gray-300 hover:text-gray-500 active:cursor-grabbing"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      drag.start(config.id, e.clientY);
                    }}
                    onTouchStart={(e) => drag.start(config.id, e.touches[0].clientY)}
                  >
                    <Icon name="drag_indicator" size={14} />
                  </span>
                )}
                <button
                  onClick={() => onToggle(config.id)}
                  className="flex-shrink-0 px-1.5 py-1"
                  title="Zichtbaarheid"
                  aria-label={`Zichtbaarheid ${config.name}`}
                >
                  <Swatch
                    spec={
                      hasRules
                        ? ruleSwatchSpec(rows[0].rule)
                        : styleSwatchSpec(config.style, config.geometryType)
                    }
                    size={12}
                    hidden={!isVisible}
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
                  {rows.map((row) => {
                    const isRuleHidden = layerHiddenRules?.has(row.key) ?? false;
                    const swatch = (
                      <Swatch spec={ruleSwatchSpec(row.rule)} size={10} hidden={isRuleHidden} />
                    );

                    // Static legend key (no per-class toggle) for layer types
                    // that can't hide one class — COG rasters.
                    if (!row.interactive) {
                      return (
                        <li key={row.key}>
                          <div className="flex w-full items-center gap-2 px-1.5 py-0.5 text-xs">
                            {swatch}
                            <span className="text-gray-600">{row.rule.name}</span>
                          </div>
                        </li>
                      );
                    }

                    return (
                      <li key={row.key}>
                        <button
                          onClick={() => onToggleRule(config.id, row.key)}
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
                            {row.rule.name}
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
        {/* Drop slot past the last row = the bottom of the draw order. */}
        {drag.overIndex === entries.length && (
          <li aria-hidden className="-mt-px h-0.5 rounded-full bg-[#3E74A7]" />
        )}
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
  maxHeightClass = "max-h-[50vh]",
  onReorder,
}: LegendProps) {
  // Top-of-map first, so reading the legend top-down matches what covers what.
  //
  // `entries` is bottom-to-top draw order, hence the reverse. The extra sort
  // mirrors restackNativeLayers, which restacks in two passes split at the
  // basemap's label overlay so labels and roads keep drawing over ordinary data:
  // a `foreground-layers` config always paints above a default-band one, whatever
  // their array positions. Array order still decides everything within a group,
  // which is what a drag changes. Array .sort is stable, so the reverse supplies
  // that within-group ordering.
  const visible = entries
    .filter((e) => !e.config.excludeFromLegend)
    .reverse()
    .sort((a, b) => foregroundRank(b.config) - foregroundRank(a.config));
  // Only the left-map legend hosts the basemap toggle + collapse button.
  const showChrome = Boolean(onCycleBasemap);
  // Shared with LayerList so a drag can auto-scroll the card.
  const cardRef = useRef<HTMLDivElement>(null);

  /**
   * Translate a drop slot in display space (0 = top row) into an index in
   * `entries`' draw-order space (0 = bottom).
   *
   * Three things to undo at once: the display list is reversed; it can be shorter
   * than `entries` (excludeFromLegend rows are filtered out), so the slot is
   * resolved via a neighbouring visible row's real position rather than by
   * arithmetic; and reorderLayer splices into the array with the dragged entry
   * already removed, so both spaces are computed without it. Exhaustively checked
   * against reorderLayer's semantics for every list size and drop slot.
   */
  const handleReorder = useCallback(
    (layerId: string, toDisplayIndex: number) => {
      if (!onReorder) return;
      const displayIds = visible.map((e) => e.config.id);
      const fromDisplay = displayIds.indexOf(layerId);
      // Dropping below your own row shifts every slot up by one once you're gone.
      const slot = toDisplayIndex > fromDisplay ? toDisplayIndex - 1 : toDisplayIndex;

      const without = entries.filter((e) => e.config.id !== layerId);
      const below = displayIds.filter((id) => id !== layerId)[slot];
      // The row that will sit just below the dragged one fixes the target; no row
      // means it was dropped past the last display row, i.e. the map's bottom.
      const target = below
        ? without.findIndex((e) => e.config.id === below) + 1
        : 0;
      onReorder(layerId, target);
    },
    [onReorder, visible, entries],
  );

  return (
    <div
      ref={cardRef}
      className={`app-scrollbar w-72 ${maxHeightClass} overflow-y-auto rounded-2xl bg-white/90 p-2 shadow-md backdrop-blur-sm sm:p-3`}
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Legenda
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
          onReorder={onReorder ? handleReorder : undefined}
          scrollRef={cardRef}
        />
      )}
    </div>
  );
});
