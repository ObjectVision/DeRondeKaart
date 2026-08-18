import { For, Show, type JSX } from "solid-js";
import { ExportPreviewMap, type ExportPreviewHandle } from "@/components/share/ExportPreviewMap";
import type { FilteredStudyArea } from "@/hooks/use-filtered-study-area";
import type { Annotation } from "@/types/annotation";
import type { LayerEntry } from "@/hooks/use-map-layers";
import type { ViewState } from "@/components/map/map-view-config";
import type { ExportLegendItem } from "@/lib/legend-style";
import { Swatch } from "@/components/ui/swatch";

/**
 * The circular export view: the map clipped to a circle with the title/subtitle
 * card top-left and the mini-legend bottom-left — exactly the composition the
 * PNG mirrors. Shared by the "Delen" dialog (editable title/subtitle) and the
 * standalone `?embed=circular` page + `open-circular` message (fixed display text).
 *
 * The caller owns the map inputs (entries/hidden/basemap/study/annotations) and
 * the legend items; this component only lays them out around the circle.
 */
interface CircularExportViewProps {
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  basemapId: string;
  studyAreaId?: string;
  filteredStudy?: FilteredStudyArea | null;
  annotations?: Annotation[];
  initialViewState: ViewState;
  legendItems: ExportLegendItem[];
  title: string;
  subtitle: string;
  /**
   * "edit" renders editable title/subtitle inputs (the dialog); "display"
   * renders them as fixed text cards, matching the PNG (the embed/overlay).
   * In display mode the onChange handlers are ignored.
   */
  mode: "edit" | "display";
  onTitleChange?: (value: string) => void;
  onSubtitleChange?: (value: string) => void;
  /** Overlaid over the circle while a PNG export is running (dialog only). */
  exporting?: boolean;
  /**
   * "preview" (default): capped at 30rem for the dialog's grid column.
   * "fill": sized to the largest square that fits the viewport (smaller of
   * width/height) with a small margin — for the full-bleed circular embed.
   * Only safe when this view owns the whole `#root` viewport (never the dialog).
   */
  size?: "preview" | "fill";
  ref?: (handle: ExportPreviewHandle) => void;
}

/**
 * The circular export view: the map clipped to a circle with the title/subtitle
 * card top-left and the mini-legend bottom-left — exactly the composition the
 * PNG mirrors. Shared by the "Delen" dialog (editable title/subtitle) and the
 * standalone `?embed=circular` page + `open-circular` message (fixed display text).
 *
 * The caller owns the map inputs (entries/hidden/basemap/study/annotations) and
 * the legend items; this component only lays them out around the circle.
 */
export function CircularExportView(props: CircularExportViewProps): JSX.Element {
  const titleText = () => props.title.trim();
  const subtitleText = () => props.subtitle.trim();
  const fill = () => props.size === "fill";

  return (
    <div
      class={
        fill()
          ? "relative mx-auto aspect-square"
          : "relative mx-auto aspect-square w-full max-w-[30rem]"
      }
      // Fill: largest square fitting the viewport, ~0.5rem margin per side.
      style={fill() ? { width: "min(calc(100vw - 1rem), calc(100vh - 1rem))" } : undefined}
    >
      {/* The map itself, clipped to a circle. */}
      <div class="absolute inset-0 overflow-hidden rounded-full ring-1 ring-gray-200">
        <ExportPreviewMap
          ref={props.ref}
          entries={props.entries}
          hiddenIds={props.hiddenIds}
          hiddenRules={props.hiddenRules}
          basemapId={props.basemapId}
          studyAreaId={props.studyAreaId}
          filteredStudy={props.filteredStudy}
          annotations={props.annotations}
          initialViewState={props.initialViewState}
        />
        <Show when={props.exporting}>
          <div class="absolute inset-0 z-20 flex items-center justify-center rounded-full bg-white/70">
            <span class="text-sm font-medium text-gray-700">Bezig met exporteren…</span>
          </div>
        </Show>
      </div>

      {/* Title / subtitle — composited into the PNG top-left. Editable inputs in
          the dialog, fixed text cards in the embed/overlay. */}
      <Show
        when={props.mode === "edit"}
        fallback={
          <Show when={titleText() || subtitleText()}>
            <div class="absolute left-0 top-4 z-10 flex w-64 max-w-[70%] flex-col gap-1">
              <Show when={titleText()}>
                <div class="rounded-lg bg-white/95 px-3 py-1.5 text-sm font-semibold text-gray-900 shadow-md backdrop-blur-sm">
                  {titleText()}
                </div>
              </Show>
              <Show when={subtitleText()}>
                <div class="rounded-lg bg-white/95 px-3 py-1 text-xs italic text-gray-600 shadow-md backdrop-blur-sm">
                  {subtitleText()}
                </div>
              </Show>
            </div>
          </Show>
        }
      >
        <div class="absolute left-0 top-4 z-10 flex w-64 max-w-[70%] flex-col gap-1">
          <input
            type="text"
            value={props.title}
            onInput={(e) => props.onTitleChange?.(e.currentTarget.value)}
            placeholder="Titel"
            class="rounded-lg bg-white/95 px-3 py-1.5 text-sm font-semibold text-gray-900 shadow-md outline-none backdrop-blur-sm placeholder:font-normal placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
          />
          <input
            type="text"
            value={props.subtitle}
            onInput={(e) => props.onSubtitleChange?.(e.currentTarget.value)}
            placeholder="Ondertitel (optioneel)"
            class="rounded-lg bg-white/95 px-3 py-1 text-xs italic text-gray-600 shadow-md outline-none backdrop-blur-sm placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
          />
        </div>
      </Show>

      {/* Mini legend — mirrors the PNG: anchored to the square's bottom-left
          corner, flush with the circle's left/bottom tangent points. */}
      <Show when={props.legendItems.length > 0}>
        <div class="absolute bottom-0 left-0 z-10 max-w-[60%] rounded-lg bg-white/95 p-2 shadow-md backdrop-blur-sm">
          <ul class="flex flex-col gap-0.5">
            <For each={props.legendItems}>
              {(item) => (
                // items-start, not items-center: a row carrying a sublabel is two
                // lines tall and its swatch must stay level with the first one.
                <li class="flex items-start gap-1.5">
                  <Show when={!item.heading && item.spec}>
                    {(spec) => (
                      <span class="mt-0.5 flex-shrink-0">
                        <Swatch spec={spec()} size={10} />
                      </span>
                    )}
                  </Show>
                  <span class="flex min-w-0 flex-col">
                    <span
                      class={
                        item.heading
                          ? "text-xs font-semibold text-gray-800"
                          : "truncate text-xs text-gray-700"
                      }
                    >
                      {item.label}
                    </span>
                    <Show when={item.sublabel}>
                      <span class="truncate text-[10px] text-gray-500">{item.sublabel}</span>
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  );
}
