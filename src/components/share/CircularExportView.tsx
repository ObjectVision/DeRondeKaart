import { forwardRef } from "react";
import { ExportPreviewMap, type ExportPreviewHandle } from "@/components/share/ExportPreviewMap";
import type { FilteredStudyArea } from "@/hooks/use-filtered-study-area";
import type { Annotation } from "@/types/annotation";
import type { LayerEntry } from "@/hooks/use-map-layers";
import type { ViewState } from "@/components/map/MapView";
import type { ExportLegendItem } from "@/lib/legend-style";

/**
 * The circular export view: the map clipped to a circle with the title/subtitle
 * card top-left and the mini-legend bottom-left — exactly the composition the
 * PNG mirrors. Shared by the "Delen" dialog (editable title/subtitle) and the
 * standalone `?embed=circular` page + `open-circular` message (fixed display text).
 *
 * The caller owns the map inputs (entries/hidden/basemap/study/annotations) and
 * the legend items; this component only lays them out around the circle.
 */
export const CircularExportView = forwardRef<
  ExportPreviewHandle,
  {
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
  }
>(function CircularExportView(
  {
    entries,
    hiddenIds,
    hiddenRules,
    basemapId,
    studyAreaId,
    filteredStudy,
    annotations,
    initialViewState,
    legendItems,
    title,
    subtitle,
    mode,
    onTitleChange,
    onSubtitleChange,
    exporting,
    size = "preview",
  },
  ref,
) {
  const titleText = title.trim();
  const subtitleText = subtitle.trim();

  return (
    <div
      className={
        size === "fill"
          ? "relative mx-auto aspect-square"
          : "relative mx-auto aspect-square w-full max-w-[30rem]"
      }
      // Fill: largest square fitting the viewport, ~0.5rem margin per side.
      style={
        size === "fill"
          ? { width: "min(calc(100vw - 1rem), calc(100vh - 1rem))" }
          : undefined
      }
    >
      {/* The map itself, clipped to a circle. */}
      <div className="absolute inset-0 overflow-hidden rounded-full ring-1 ring-gray-200">
        <ExportPreviewMap
          ref={ref}
          entries={entries}
          hiddenIds={hiddenIds}
          hiddenRules={hiddenRules}
          basemapId={basemapId}
          studyAreaId={studyAreaId}
          filteredStudy={filteredStudy}
          annotations={annotations}
          initialViewState={initialViewState}
        />
        {exporting && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-full bg-white/70">
            <span className="text-sm font-medium text-gray-700">
              Bezig met exporteren…
            </span>
          </div>
        )}
      </div>

      {/* Title / subtitle — composited into the PNG top-left. Editable inputs in
          the dialog, fixed text cards in the embed/overlay. */}
      {mode === "edit" ? (
        <div className="absolute left-0 top-4 z-10 flex w-64 max-w-[70%] flex-col gap-1">
          <input
            type="text"
            value={title}
            onChange={(e) => onTitleChange?.(e.target.value)}
            placeholder="Titel"
            className="rounded-lg bg-white/95 px-3 py-1.5 text-sm font-semibold text-gray-900 shadow-md outline-none backdrop-blur-sm placeholder:font-normal placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
          />
          <input
            type="text"
            value={subtitle}
            onChange={(e) => onSubtitleChange?.(e.target.value)}
            placeholder="Ondertitel (optioneel)"
            className="rounded-lg bg-white/95 px-3 py-1 text-xs italic text-gray-600 shadow-md outline-none backdrop-blur-sm placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
          />
        </div>
      ) : (
        (titleText || subtitleText) && (
          <div className="absolute left-0 top-4 z-10 flex w-64 max-w-[70%] flex-col gap-1">
            {titleText && (
              <div className="rounded-lg bg-white/95 px-3 py-1.5 text-sm font-semibold text-gray-900 shadow-md backdrop-blur-sm">
                {titleText}
              </div>
            )}
            {subtitleText && (
              <div className="rounded-lg bg-white/95 px-3 py-1 text-xs italic text-gray-600 shadow-md backdrop-blur-sm">
                {subtitleText}
              </div>
            )}
          </div>
        )
      )}

      {/* Mini legend — mirrors the PNG: anchored to the square's bottom-left
          corner, flush with the circle's left/bottom tangent points. */}
      {legendItems.length > 0 && (
        <div className="absolute bottom-0 left-0 z-10 max-w-[60%] rounded-lg bg-white/95 p-2 shadow-md backdrop-blur-sm">
          <ul className="flex flex-col gap-0.5">
            {legendItems.map((item, i) => (
              <li key={i} className="flex items-center gap-1.5">
                {!item.heading && (
                  <span
                    className="inline-block h-2.5 w-2.5 flex-shrink-0 border border-gray-300"
                    style={{ backgroundColor: item.color }}
                  />
                )}
                <span
                  className={
                    item.heading
                      ? "text-xs font-semibold text-gray-800"
                      : "truncate text-xs text-gray-700"
                  }
                >
                  {item.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});
