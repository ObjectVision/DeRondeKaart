import { Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { DialogRoot, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";
import type { ExportPreviewHandle } from "@/components/share/ExportPreviewMap";
import { CircularExportView } from "@/components/share/CircularExportView";
import type { FilteredStudyArea } from "@/hooks/use-filtered-study-area";
import type { Annotation } from "@/types/annotation";
import type { LayerEntry } from "@/hooks/use-map-layers";
import type { ViewState } from "@/components/map/map-view-config";
import { buildShareUrl, type ShareUrlSide } from "@/lib/share-url";
import type { MapSidePair } from "@/lib/map-side";
import { legendItemsForEntries } from "@/lib/legend-style";
import {
  captureMapAtResolution,
  composeCircularExport,
  downloadCanvasPng,
} from "@/lib/map-capture";

const EXPORT_SIZE = 2048;

function filenameSlug(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Entries of the on-screen map side — drives the preview + PNG legend. */
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  /** Both sides — the share URL reproduces the full A/B session. */
  /** Both maps' layer state, as the link serializes it. */
  sides: MapSidePair<ShareUrlSide>;
  basemapId: string;
  studyAreaId?: string;
  /** Gebiedsfilter-driven studyarea; replaces the configured one when set. */
  filteredStudy?: FilteredStudyArea | null;
  /** Active annotations to include in the preview/PNG (empty/omitted = none). */
  annotations?: Annotation[];
  /** The MAIN map's view — seeds the preview and is what the share URL encodes. */
  viewState: ViewState;
  /** Collaborative annotation room — carried in the link as `annot`. */
  annotRoomId?: string | null;
  /** Controlled title/subtitle — lifted to App so a host `open-circular` can prefill them. */
  title: string;
  subtitle: string;
  onTitleChange: (value: string) => void;
  onSubtitleChange: (value: string) => void;
}

/**
 * "Delen" dialog: circular map preview (pan/zoom to fine-tune the PNG
 * framing), the share link, and the circular 2048×2048 PNG download with
 * title + legend composited in.
 */
export function ShareDialog(props: ShareDialogProps): JSX.Element {
  let preview: ExportPreviewHandle | null = null;
  const [copied, setCopied] = createSignal<string | null>(null);
  const [exporting, setExporting] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  onCleanup(() => {
    if (copiedTimer) clearTimeout(copiedTimer);
  });

  // The share URL reflects the live session state (main map's view, both
  // sides' layers) — deliberately NOT the preview framing, so the link
  // doesn't churn while the user fine-tunes the PNG.
  const shareUrl = createMemo(() =>
    buildShareUrl({
      viewState: props.viewState,
      sides: props.sides,
      annotRoomId: props.annotRoomId,
      basemapId: props.basemapId,
    }),
  );

  const legendItems = createMemo(() =>
    legendItemsForEntries(props.entries, props.hiddenIds, props.hiddenRules),
  );

  function showCopied(key: string) {
    setCopied(key);
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setCopied(null), 2000);
  }

  async function copyShareUrl(key: string) {
    try {
      await navigator.clipboard.writeText(shareUrl());
      showCopied(key);
    } catch {
      // Clipboard is unavailable in some embeds (sandboxed iframe) — the
      // readonly input stays manually copyable.
    }
  }

  async function handleDownloadPng() {
    const map = preview?.getMap();
    if (!map || exporting()) return;
    setExporting(true);
    try {
      // Project annotation anchors BEFORE the capture (map.project uses CSS
      // coordinates; project outside the transient pixel-ratio window). Only
      // titled shapes whose center lands inside the circle get a callout.
      const scale = EXPORT_SIZE / Math.max(1, map.getContainer().clientWidth);
      const callouts = (props.annotations ?? [])
        .filter((a) => a.title.trim())
        .map((a) => {
          const p = map.project([a.center.lng, a.center.lat]);
          return { title: a.title, color: a.color, x: p.x * scale, y: p.y * scale };
        })
        .filter(
          (c) =>
            Math.hypot(c.x - EXPORT_SIZE / 2, c.y - EXPORT_SIZE / 2) < EXPORT_SIZE / 2,
        );

      const mapCanvas = await captureMapAtResolution(map, EXPORT_SIZE);
      const composed = await composeCircularExport({
        mapCanvas,
        size: EXPORT_SIZE,
        title: props.title,
        subtitle: props.subtitle,
        legend: legendItems(),
        callouts,
      });
      downloadCanvasPng(composed, `${filenameSlug(props.title, "kaart")}.png`);
    } catch (err) {
      console.error("PNG export failed:", err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <DialogRoot open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        {/* Header */}
        <div class="mb-4 flex items-start justify-between gap-2">
          <div>
            <DialogTitle>Delen</DialogTitle>
            <DialogDescription>
              Maak een ronde kaart om te delen of te downloaden
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => props.onOpenChange(false)}
            title="Sluiten"
            aria-label="Sluiten"
          >
            <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        </div>

        <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          {/* Left: circular preview */}
          <div class="flex min-w-0 flex-col gap-3">
            {/* Circular map + title/subtitle + legend. Mounted only while the
                dialog is open — a fresh preview instance per open. */}
            <Show when={props.open}>
              <CircularExportView
                ref={(handle) => (preview = handle)}
                entries={props.entries}
                hiddenIds={props.hiddenIds}
                hiddenRules={props.hiddenRules}
                basemapId={props.basemapId}
                studyAreaId={props.studyAreaId}
                filteredStudy={props.filteredStudy}
                annotations={props.annotations}
                initialViewState={props.viewState}
                legendItems={legendItems()}
                title={props.title}
                subtitle={props.subtitle}
                mode="edit"
                size="preview"
                onTitleChange={props.onTitleChange}
                onSubtitleChange={props.onSubtitleChange}
                exporting={exporting()}
              />
            </Show>

            {/* Hint bar */}
            <div class="mx-auto w-full max-w-[30rem] rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <p>
                <span class="font-semibold">Sleep</span> om te verplaatsen
                {" • "}
                <span class="font-semibold">Scroll</span> om in of uit te zoomen
              </p>
              <p class="mt-0.5 text-blue-800/80">
                De legenda, titel en kaartelementen worden meegenomen in het
                exportbestand.
              </p>
            </div>
          </div>

          {/* Right column */}
          <div class="flex flex-col gap-4">
            {/* Link */}
            <div class="rounded-2xl border border-gray-100 p-4 shadow-sm">
              <h3 class="text-sm font-semibold text-gray-900">Delen via link</h3>
              <p class="mb-3 mt-1 text-xs text-gray-500">Deel deze kaart via een link</p>
              <div class="flex items-center gap-1">
                <input
                  type="text"
                  readOnly
                  value={shareUrl()}
                  onFocus={(e) => e.currentTarget.select()}
                  class="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-700 outline-none"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void copyShareUrl("url")}
                  title={copied() === "url" ? "Gekopieerd!" : "Link kopiëren"}
                  aria-label="Link kopiëren"
                >
                  <Icon
                    name={copied() === "url" ? "check" : "content_copy"}
                    size={chromeIconSize()}
                    color={chromeIconColor()}
                  />
                </Button>
              </div>
            </div>

            {/* PNG download */}
            <div class="rounded-2xl border border-gray-100 p-4 shadow-sm">
              <h3 class="text-sm font-semibold text-gray-900">
                Downloaden als afbeelding
              </h3>
              <p class="mb-3 mt-1 text-xs text-gray-500">
                Download de Ronde kaart als PNG-afbeelding
              </p>
              <Button
                variant="outline"
                size="sm"
                class="w-full"
                disabled={exporting()}
                onClick={() => void handleDownloadPng()}
              >
                <Icon name="download" size={16} color={chromeIconColor()} />
                {exporting() ? "Bezig met exporteren…" : "Download PNG"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
