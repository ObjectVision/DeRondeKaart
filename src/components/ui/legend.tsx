import { For, Show, createSignal, type JSX } from "solid-js";
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

interface TimeseriesControlProps {
  config: LayerEntry["config"];
  step: number;
  playing: boolean;
  onTogglePlay: (layerId: string) => void;
  onSetStep: (layerId: string, value: number) => void;
}

/**
 * Play/pause + scrub control for a timeseries layer, shown under its layer name
 * and above its legend classes. Dragging the slider pauses playback: scrubbing
 * and playing at the same time would fight over the rendered step.
 */
function TimeseriesControl(props: TimeseriesControlProps): JSX.Element {
  return (
    <Show when={props.config.timeseries}>
      {(ts) => (
        <div class="ml-5 flex items-center gap-2 px-1.5 py-1">
          <button
            onClick={() => props.onTogglePlay(props.config.id)}
            class="flex-shrink-0 leading-none text-gray-600 hover:text-gray-900 transition-colors"
            title={props.playing ? "Pauzeer" : "Afspelen"}
            aria-label={
              props.playing ? `Pauzeer ${props.config.name}` : `Speel ${props.config.name} af`
            }
          >
            {/* Two literal `name` props, not a ternary inside one: the icon-font
                subsetter scans for `name="…"` and would miss the second string. */}
            <Show
              when={props.playing}
              fallback={
                <Icon name="play_circle" size={chromeIconSize()} color={chromeIconColor()} />
              }
            >
              <Icon name="pause_circle" size={chromeIconSize()} color={chromeIconColor()} />
            </Show>
          </button>
          <input
            type="range"
            min={ts().start}
            max={ts().end}
            step={ts().step}
            value={props.step}
            onInput={(e) => props.onSetStep(props.config.id, Number(e.currentTarget.value))}
            class="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-gray-200"
            // accent-color inline rather than Tailwind's `accent-*`: the brand
            // blue is a runtime value (map.json `chromeIconColor`), so it cannot
            // be a static utility class.
            style={{ "accent-color": chromeIconColor() }}
            aria-label={`Jaar ${props.config.name}`}
          />
          <span class="w-10 flex-shrink-0 text-right text-xs tabular-nums text-gray-600">
            {props.step}
          </span>
        </div>
      )}
    </Show>
  );
}

interface LegendProps {
  /** Layers for the map this legend represents. */
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  /** Layers dimmed by the transparency tool. */
  dimmedIds: Set<string>;
  /** Timeseries: current step per layer id, and which layers are playing. */
  layerSteps: globalThis.Map<string, number>;
  playingIds: Set<string>;
  onToggle: (layerId: string) => void;
  /** Dim the layer to 30%, or restore its configured opacity. */
  onToggleDim: (layerId: string) => void;
  onToggleRule: (layerId: string, ruleName: string) => void;
  onTogglePlay: (layerId: string) => void;
  onSetStep: (layerId: string, value: number) => void;
  onRemove: (layerId: string) => void;
  /**
   * Open the layer's metainfo dialog. Omitted (or a layer without `meta`)
   * renders the info button disabled rather than hiding it.
   */
  onOpenMeta?: (layerId: string, layerName: string) => void;
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
  /** Opens the basemap picker. Its presence also gates the whole chrome row. */
  onOpenBasemaps?: () => void;
  /**
   * Opens the "Criteria combineren" dialog. Omit to hide the button entirely (the
   * `combinations` map.json flag is off, or this is the right-map legend).
   */
  onOpenCombine?: () => void;
  /**
   * Whether any layer currently in the legend can take part in a combination —
   * i.e. has both GeoStyler rules and a `filterRaster`. False greys the button
   * out rather than hiding it, so the feature stays discoverable when there is
   * simply nothing to combine yet.
   */
  canCombine?: boolean;
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

function noop() {}

interface LayerListProps {
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  dimmedIds: Set<string>;
  layerSteps: globalThis.Map<string, number>;
  playingIds: Set<string>;
  onToggle: (layerId: string) => void;
  onToggleDim: (layerId: string) => void;
  onToggleRule: (layerId: string, ruleName: string) => void;
  onTogglePlay: (layerId: string) => void;
  onSetStep: (layerId: string, value: number) => void;
  onRemove: (layerId: string) => void;
  onOpenMeta?: (layerId: string, layerName: string) => void;
  onMove?: (layerId: string) => void;
  moveDirection?: "right" | "left";
  moveDisabled?: boolean;
  onReorder?: (layerId: string, toDisplayIndex: number) => void;
  scrollEl?: () => HTMLElement | null | undefined;
}

function LayerList(props: LayerListProps): JSX.Element {
  // `entries` is display order (top of map first). The hook reports the slot in
  // that same space; Legend converts to draw order.
  const drag = useRowDrag(
    () => props.entries.map((e) => e.config.id),
    (id, to) => (props.onReorder ?? noop)(id, to),
    () => props.scrollEl?.(),
  );

  // Which row has its actions revealed. A single id rather than a set: only one
  // row expands at a time, so opening another implicitly closes the previous one.
  // A removed row unmounts, leaving a stale id that matches nothing — no cleanup.
  const [expandedId, setExpandedId] = createSignal<string | null>(null);

  const moveTitle = () => {
    if (props.moveDisabled) return "Voeg eerst een laag toe aan de linker kaart";
    if (props.moveDirection === "left") return "Naar linker kaart";
    return "Naar rechter kaart";
  };

  return (
    <Show when={props.entries.length > 0}>
      <div>
        {/* gap-1 between LAYERS, against no gap between a layer's class rows —
            that difference is what groups the classes under their layer. */}
        <ul class="flex flex-col gap-1">
          <For each={props.entries}>
            {(entry, rowIndex) => {
              const config = entry.config;
              const isVisible = () => !props.hiddenIds.has(config.id);
              const isDimmed = () => props.dimmedIds.has(config.id);
              const isDragging = () => drag.draggingId() === config.id;
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
              const layerHiddenRules = () => props.hiddenRules.get(config.id);
              const isExpanded = () => expandedId() === config.id;

              return (
                <li ref={drag.rowRef(config.id)}>
                  {/* Where the dragged row would land. Rendered inside the row it
                      precedes so it needs no extra list item. */}
                  <Show when={drag.overIndex() === rowIndex()}>
                    <div class="-mt-px mb-px h-0.5 rounded-full bg-[#3E74A7]" />
                  </Show>
                  {/* Layer row: swatch = visibility; name = visibility; × = remove */}
                  <div
                    class={`group flex items-center rounded transition-colors ${
                      isDragging() ? "bg-gray-100 opacity-60" : "hover:bg-gray-100"
                    }`}
                  >
                    <Show when={props.onReorder}>
                      <span
                        // A dedicated handle: the rest of the row toggles visibility,
                        // so dragging from anywhere would fight that. Not a <button>
                        // — it has no click action and must not take Enter/Space.
                        role="separator"
                        aria-label={`Versleep ${config.name} om de tekenorde te wijzigen`}
                        title="Versleep om de tekenorde te wijzigen"
                        class="flex-shrink-0 cursor-grab touch-none pl-0.5 pr-0.5 text-gray-300 hover:text-gray-500 active:cursor-grabbing"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          drag.start(config.id, e.clientY);
                        }}
                        onTouchStart={(e) => drag.start(config.id, e.touches[0].clientY)}
                      >
                        <Icon name="drag_indicator" size={14} />
                      </span>
                    </Show>
                    {/* No swatch when the class list is shown below: the row is a
                        heading for those classes, and painting it with the FIRST
                        rule's colour reads as if that class were the layer. A
                        single-rule layer keeps its swatch — there the rule and the
                        layer are the same thing (see showRuleList above). */}
                    <Show
                      when={showRuleList}
                      fallback={
                        <button
                          onClick={() => props.onToggle(config.id)}
                          class="flex-shrink-0 px-1.5 py-1"
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
                            hidden={!isVisible()}
                          />
                        </button>
                      }
                    >
                      <span class="flex-shrink-0 pl-1.5" />
                    </Show>
                    <button
                      onClick={() => props.onToggle(config.id)}
                      // flex-col: the optional subname sits UNDER the name, so the
                      // two stack. `items-start` keeps them left-aligned once the
                      // row is taller than a single line.
                      class="flex min-w-0 flex-1 flex-col items-start justify-center py-1 pr-1.5 text-left text-sm"
                      title="Zichtbaarheid"
                    >
                      <span
                        // truncate: with the actions expanded the row has less room,
                        // so a long name must ellipsize rather than push them out.
                        class={`max-w-full truncate ${
                          isVisible() ? "text-gray-800 font-medium" : "text-gray-400 line-through"
                        }`}
                      >
                        {config.name}
                      </span>
                      {/* The unit the layer's values are measured in. Same greyed
                          treatment as the name when the layer is hidden, so the row
                          reads as one unit rather than a live subtitle under a
                          struck-through name. */}
                      <Show when={config.subname}>
                        <span
                          class={`max-w-full truncate text-xs ${
                            isVisible() ? "text-gray-500" : "text-gray-400 line-through"
                          }`}
                        >
                          {config.subname}
                        </span>
                      </Show>
                    </button>
                    {/* Layer actions, revealed to the LEFT of the chevron so it keeps
                        its place at the row's right edge. The name (min-w-0 flex-1)
                        truncates to make room, so the row never grows wider than the
                        card (see --width-panel in index.css). */}
                    <Show when={isExpanded()}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => props.onToggleDim(config.id)}
                        aria-label={`Transparantie ${config.name}`}
                        aria-pressed={isDimmed()}
                        title={isDimmed() ? "Transparantie opheffen" : "50% transparantie activeren"}
                      >
                        {/* Two literal name= strings rather than one expression: the
                            build-time subsetter scans for `name="…"` and would miss
                            a computed one, dropping the glyph from the font. */}
                        <Show
                          when={isDimmed()}
                          fallback={
                            <Icon
                              name="opacity"
                              size={chromeIconSize()}
                              color={chromeIconColor()}
                            />
                          }
                        >
                          <Icon
                            name="format_color_reset"
                            size={chromeIconSize()}
                            color={chromeIconColor()}
                          />
                        </Show>
                      </Button>
                      {/* Disabled rather than hidden when the layer has no `meta`,
                          so every row keeps the same set of actions. */}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!config.meta || !props.onOpenMeta}
                        onClick={() => props.onOpenMeta?.(config.id, config.name)}
                        aria-label={`Informatie ${config.name}`}
                        title={
                          config.meta && props.onOpenMeta
                            ? "Informatie"
                            : "Metadata (nog niet beschikbaar)"
                        }
                      >
                        <Icon name="info" size={chromeIconSize()} color={chromeIconColor()} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => props.onRemove(config.id)}
                        aria-label={`Verwijder ${config.name}`}
                        title="Laag verwijderen"
                      >
                        <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
                      </Button>
                      <Show when={props.onMove}>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={props.moveDisabled}
                          onClick={() => props.onMove?.(config.id)}
                          aria-label={
                            props.moveDirection === "left"
                              ? `Verplaats ${config.name} naar linker kaart`
                              : `Verplaats ${config.name} naar rechter kaart`
                          }
                          title={moveTitle()}
                        >
                          <Show
                            when={props.moveDirection === "left"}
                            fallback={
                              <Icon
                                name="arrow_circle_right"
                                size={chromeIconSize()}
                                color={props.moveDisabled ? undefined : chromeIconColor()}
                                class={props.moveDisabled ? "text-gray-300" : undefined}
                              />
                            }
                          >
                            <Icon
                              name="arrow_circle_left"
                              size={chromeIconSize()}
                              color={props.moveDisabled ? undefined : chromeIconColor()}
                              class={props.moveDisabled ? "text-gray-300" : undefined}
                            />
                          </Show>
                        </Button>
                      </Show>
                    </Show>
                    {/* Toggles those actions, so removal and the cross-map move
                        aren't a stray click away in a narrow card. */}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setExpandedId((cur) => (cur === config.id ? null : config.id))}
                      aria-expanded={isExpanded()}
                      aria-label={`Acties voor ${config.name}`}
                      title={isExpanded() ? "Acties verbergen" : "Acties tonen"}
                    >
                      {/* Kebab rather than a chevron: the actions appear beside it
                          rather than in a panel it points at, so a directional arrow
                          misdescribed the gesture. Same glyph either way — the
                          aria-expanded state carries open/closed. */}
                      <Icon name="more_vert" size={chromeIconSize()} color={chromeIconColor()} />
                    </Button>
                  </div>

                  {/* Timeseries playback, directly under the layer name: the step
                      it scrubs applies to the whole layer, not to the individual
                      classes, so it reads as part of the layer's own header rather
                      than as a trailer to the class list. */}
                  <Show when={config.timeseries && isVisible()}>
                    <TimeseriesControl
                      config={config}
                      step={props.layerSteps.get(config.id) ?? config.timeseries!.start}
                      playing={props.playingIds.has(config.id)}
                      onTogglePlay={props.onTogglePlay}
                      onSetStep={props.onSetStep}
                    />
                  </Show>

                  {/* Per-rule class toggles — only when there's more than one rule */}
                  <Show when={showRuleList && isVisible()}>
                    {/* No gap between class rows: they belong to the layer above and
                        should read as one block. The space that separates LAYERS
                        comes from the outer list instead (see gap-1 there). */}
                    <ul class="ml-5 flex flex-col">
                      <For each={rows}>
                        {(row) => {
                          const isRuleHidden = () => layerHiddenRules()?.has(row.key) ?? false;
                          return (
                            <li>
                              {/* Static legend key (no per-class toggle) for layer
                                  types that can't hide one class — COG rasters. */}
                              <Show
                                when={row.interactive}
                                fallback={
                                  <div class="flex w-full items-center gap-2 px-1.5 py-px text-xs">
                                    <Swatch
                                      spec={ruleSwatchSpec(row.rule)}
                                      size={10}
                                      hidden={isRuleHidden()}
                                    />
                                    <span class="text-gray-600">{row.rule.name}</span>
                                  </div>
                                }
                              >
                                <button
                                  onClick={() => props.onToggleRule(config.id, row.key)}
                                  class="flex w-full items-center gap-2 rounded px-1.5 py-px text-left text-xs hover:bg-gray-100 transition-colors"
                                >
                                  <Swatch
                                    spec={ruleSwatchSpec(row.rule)}
                                    size={10}
                                    hidden={isRuleHidden()}
                                  />
                                  <span
                                    class={
                                      isRuleHidden()
                                        ? "text-gray-400 line-through"
                                        : "text-gray-600"
                                    }
                                  >
                                    {row.rule.name}
                                  </span>
                                </button>
                              </Show>
                            </li>
                          );
                        }}
                      </For>
                    </ul>
                  </Show>
                </li>
              );
            }}
          </For>
          {/* Drop slot past the last row = the bottom of the draw order. */}
          <Show when={drag.overIndex() === props.entries.length}>
            <li aria-hidden class="-mt-px h-0.5 rounded-full bg-[#3E74A7]" />
          </Show>
        </ul>
      </div>
    </Show>
  );
}

/**
 * No memo wrapper: App's camera updates no longer re-render this at all — only
 * the DOM nodes bound to a changed signal update.
 */
export function Legend(props: LegendProps): JSX.Element {
  // Top-of-map first, so reading the legend top-down matches what covers what.
  //
  // `entries` is bottom-to-top draw order, hence the reverse. The extra sort
  // mirrors restackNativeLayers, which restacks in two passes split at the
  // basemap's label overlay so labels and roads keep drawing over ordinary data:
  // a `foreground-layers` config always paints above a default-band one, whatever
  // their array positions. Array order still decides everything within a group,
  // which is what a drag changes. Array .sort is stable, so the reverse supplies
  // that within-group ordering. (`.filter` already returns a fresh array, so the
  // in-place `.reverse()`/`.sort()` never touch the caller's own.)
  const visible = () =>
    props.entries
      .filter((e) => !e.config.excludeFromLegend)
      .reverse()
      .sort((a, b) => foregroundRank(b.config) - foregroundRank(a.config));

  // Only the left-map legend hosts the basemap picker + collapse button.
  const showChrome = () => Boolean(props.onOpenBasemaps);
  // Shared with LayerList so a drag can auto-scroll the card.
  let card: HTMLDivElement | undefined;

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
  function handleReorder(layerId: string, toDisplayIndex: number) {
    if (!props.onReorder) return;
    const displayIds = visible().map((e) => e.config.id);
    const fromDisplay = displayIds.indexOf(layerId);
    // Dropping below your own row shifts every slot up by one once you're gone.
    const slot = toDisplayIndex > fromDisplay ? toDisplayIndex - 1 : toDisplayIndex;

    const without = props.entries.filter((e) => e.config.id !== layerId);
    const below = displayIds.filter((id) => id !== layerId)[slot];
    // The row that will sit just below the dragged one fixes the target; no row
    // means it was dropped past the last display row, i.e. the map's bottom.
    const target = below ? without.findIndex((e) => e.config.id === below) + 1 : 0;
    props.onReorder(layerId, target);
  }

  return (
    <div
      ref={card}
      class={`app-scrollbar w-panel ${props.maxHeightClass ?? "max-h-[50vh]"} overflow-y-auto rounded-2xl bg-white/90 p-2 shadow-md backdrop-blur-sm sm:p-3`}
    >
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Legenda</h3>
        <Show when={showChrome()}>
          <div class="flex items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={props.onOpenBasemaps}
              title="Referentielagen kiezen"
              aria-label="Referentielagen kiezen"
            >
              <Icon name="map" size={chromeIconSize()} color={chromeIconColor()} />
            </Button>
            <Show when={props.onOpenCombine}>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={props.onOpenCombine}
                disabled={!props.canCombine}
                title={
                  props.canCombine
                    ? "Criteria combineren"
                    : "Geen van de actieve lagen levert criteria om te combineren"
                }
                aria-label="Criteria combineren"
              >
                {/* Greyed out rather than hidden when nothing can be combined:
                    the button disappearing as layers come and go would read as
                    the feature breaking. */}
                <Icon
                  name="masked_transitions_add"
                  size={chromeIconSize()}
                  color={props.canCombine ? chromeIconColor() : "#9CA3AF"}
                />
              </Button>
            </Show>
            <Show when={props.onClose}>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={props.onClose}
                title="Kaartlagen verbergen"
                aria-label="Kaartlagen verbergen"
              >
                <Icon name="remove" size={chromeIconSize()} color={chromeIconColor()} />
              </Button>
            </Show>
          </div>
        </Show>
      </div>
      <Show
        when={visible().length > 0}
        fallback={<p class="text-xs text-gray-400">Nog geen lagen toegevoegd</p>}
      >
        <LayerList
          entries={visible()}
          hiddenIds={props.hiddenIds}
          hiddenRules={props.hiddenRules}
          dimmedIds={props.dimmedIds}
          layerSteps={props.layerSteps}
          playingIds={props.playingIds}
          onToggle={props.onToggle}
          onToggleDim={props.onToggleDim}
          onToggleRule={props.onToggleRule}
          onTogglePlay={props.onTogglePlay}
          onSetStep={props.onSetStep}
          onRemove={props.onRemove}
          onOpenMeta={props.onOpenMeta}
          onMove={props.onMove}
          moveDirection={props.moveDirection}
          moveDisabled={props.moveDisabled}
          onReorder={props.onReorder ? handleReorder : undefined}
          scrollEl={() => card}
        />
      </Show>
    </div>
  );
}
