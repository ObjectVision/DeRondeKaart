import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { DialogRoot, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";
import type { ExportPreviewHandle } from "@/components/share/ExportPreviewMap";
import { CircularExportView } from "@/components/share/CircularExportView";
import type { FilteredStudyArea } from "@/hooks/use-filtered-study-area";
import type { Annotation } from "@/types/annotation";
import { SocialIcon, type SocialPlatform } from "@/components/share/social-icons";
import type { LayerEntry } from "@/hooks/use-map-layers";
import type { ViewState } from "@/components/map/MapView";
import { buildShareUrl } from "@/lib/share-url";
import { legendItemsForEntries } from "@/lib/legend-style";
import {
  captureMapAtResolution,
  composeCircularExport,
  downloadCanvasPng,
  downloadDataUrl,
} from "@/lib/map-capture";

const EXPORT_SIZE = 2048;

/** Platforms with a web share-intent endpoint, and the two clipboard-only ones. */
const SOCIAL_PLATFORMS: SocialPlatform[] = [
  "linkedin",
  "x",
  "instagram",
  "facebook",
  "signal",
  "whatsapp",
  "reddit",
];

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
  facebook: "Facebook",
  signal: "Signal",
  whatsapp: "WhatsApp",
  reddit: "Reddit",
};

/** Share-intent URL for a platform, or null when it has no web endpoint. */
function shareIntentUrl(platform: SocialPlatform, url: string, title: string): string | null {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  switch (platform) {
    case "linkedin":
      return `https://www.linkedin.com/sharing/share-offsite/?url=${u}`;
    case "x":
      return `https://x.com/intent/tweet?url=${u}${title ? `&text=${t}` : ""}`;
    case "facebook":
      return `https://www.facebook.com/sharer/sharer.php?u=${u}`;
    case "whatsapp":
      return `https://wa.me/?text=${encodeURIComponent(title ? `${title} ${url}` : url)}`;
    case "reddit":
      return `https://www.reddit.com/submit?url=${u}${title ? `&title=${t}` : ""}`;
    // No web share endpoint — the button copies the link instead.
    case "instagram":
    case "signal":
      return null;
  }
}

function filenameSlug(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

/**
 * "Delen" dialog: circular map preview (pan/zoom to fine-tune the PNG
 * framing), social-media share intents, share link + QR code, and the
 * circular 2048×2048 PNG download with title + legend composited in.
 */
export function ShareDialog({
  open,
  onOpenChange,
  entries,
  hiddenIds,
  hiddenRules,
  entriesA,
  entriesB,
  hiddenIdsA,
  hiddenIdsB,
  basemapId,
  studyAreaId,
  filteredStudy,
  annotations,
  viewState,
  annotRoomId,
  title,
  subtitle,
  onTitleChange,
  onSubtitleChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Entries of the on-screen map side — drives the preview + PNG legend. */
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  /** Both sides — the share URL reproduces the full A/B session. */
  entriesA: LayerEntry[];
  entriesB: LayerEntry[];
  hiddenIdsA: Set<string>;
  hiddenIdsB: Set<string>;
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
}) {
  const previewRef = useRef<ExportPreviewHandle>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The share URL reflects the live session state (main map's view, both
  // sides' layers) — deliberately NOT the preview framing, so the QR/link
  // don't churn while the user fine-tunes the PNG.
  const shareUrl = useMemo(
    () =>
      buildShareUrl({
        viewState,
        entriesA,
        entriesB,
        hiddenIdsA,
        hiddenIdsB,
        annotRoomId,
      }),
    [viewState, entriesA, entriesB, hiddenIdsA, hiddenIdsB, annotRoomId],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    QRCode.toDataURL(shareUrl, { width: 512, margin: 1, errorCorrectionLevel: "M" })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err) => console.error("QR code generation failed:", err));
    return () => {
      cancelled = true;
    };
  }, [open, shareUrl]);

  const legendItems = useMemo(
    () => legendItemsForEntries(entries, hiddenIds, hiddenRules),
    [entries, hiddenIds, hiddenRules],
  );

  const showCopied = useCallback((key: string) => {
    setCopied(key);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 2000);
  }, []);

  const copyShareUrl = useCallback(
    async (key: string) => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        showCopied(key);
      } catch {
        // Clipboard is unavailable in some embeds (sandboxed iframe) — the
        // readonly input stays manually copyable.
      }
    },
    [shareUrl, showCopied],
  );

  const handleSocialClick = useCallback(
    (platform: SocialPlatform) => {
      const intent = shareIntentUrl(platform, shareUrl, title);
      if (!intent) {
        void copyShareUrl(platform);
        return;
      }
      try {
        window.open(intent, "_blank", "noopener,noreferrer");
      } catch {
        void copyShareUrl(platform);
      }
    },
    [shareUrl, title, copyShareUrl],
  );

  const handleDownloadPng = useCallback(async () => {
    const map = previewRef.current?.getMap();
    if (!map || exporting) return;
    setExporting(true);
    try {
      // Project annotation anchors BEFORE the capture (map.project uses CSS
      // coordinates; project outside the transient pixel-ratio window). Only
      // titled shapes whose center lands inside the circle get a callout.
      const scale = EXPORT_SIZE / Math.max(1, map.getContainer().clientWidth);
      const callouts = (annotations ?? [])
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
        title,
        subtitle,
        legend: legendItems,
        callouts,
      });
      downloadCanvasPng(composed, `${filenameSlug(title, "kaart")}.png`);
    } catch (err) {
      console.error("PNG export failed:", err);
    } finally {
      setExporting(false);
    }
  }, [exporting, title, subtitle, legendItems, annotations]);
  // (title & subtitle are props now — both already listed above.)

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <DialogTitle>Delen</DialogTitle>
            <DialogDescription>
              Maak een ronde kaart om te delen of te downloaden
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onOpenChange(false)}
            title="Sluiten"
            aria-label="Sluiten"
          >
            <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          {/* Left: circular preview */}
          <div className="flex min-w-0 flex-col gap-3">
            {/* Circular map + title/subtitle + legend. Mounted only while the
                dialog is open — a fresh preview instance per open. */}
            {open && (
              <CircularExportView
                ref={previewRef}
                entries={entries}
                hiddenIds={hiddenIds}
                hiddenRules={hiddenRules}
                basemapId={basemapId}
                studyAreaId={studyAreaId}
                filteredStudy={filteredStudy}
                annotations={annotations}
                initialViewState={viewState}
                legendItems={legendItems}
                title={title}
                subtitle={subtitle}
                mode="edit"
                size="preview"
                onTitleChange={onTitleChange}
                onSubtitleChange={onSubtitleChange}
                exporting={exporting}
              />
            )}

            {/* Hint bar */}
            <div className="mx-auto w-full max-w-[30rem] rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <p>
                <span className="font-semibold">Sleep</span> om te verplaatsen
                {" • "}
                <span className="font-semibold">Scroll</span> om in of uit te zoomen
              </p>
              <p className="mt-0.5 text-blue-800/80">
                De legenda, titel en kaartelementen worden meegenomen in het
                exportbestand.
              </p>
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            {/* Social media */}
            <div className="rounded-2xl border border-gray-100 p-4 shadow-sm">
              <h3 className="mb-3 text-sm font-semibold text-gray-900">
                Delen op social media
              </h3>
              <div className="flex flex-wrap items-center gap-1">
                {SOCIAL_PLATFORMS.map((platform) => (
                  <Button
                    key={platform}
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleSocialClick(platform)}
                    title={
                      copied === platform
                        ? "Link gekopieerd!"
                        : `Delen via ${PLATFORM_LABELS[platform]}`
                    }
                    aria-label={`Delen via ${PLATFORM_LABELS[platform]}`}
                    style={{ color: chromeIconColor() }}
                  >
                    <SocialIcon platform={platform} size={chromeIconSize()} />
                  </Button>
                ))}
              </div>
              {(copied === "instagram" || copied === "signal") && (
                <p className="mt-2 text-xs text-gray-500">
                  Link gekopieerd — plak deze in {PLATFORM_LABELS[copied as SocialPlatform]}.
                </p>
              )}
            </div>

            {/* Link + QR */}
            <div className="rounded-2xl border border-gray-100 p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-900">
                Delen via link of QR-code
              </h3>
              <p className="mb-3 mt-1 text-xs text-gray-500">
                Deel deze kaart via link of QR-code
              </p>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  readOnly
                  value={shareUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-700 outline-none"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void copyShareUrl("url")}
                  title={copied === "url" ? "Gekopieerd!" : "Link kopiëren"}
                  aria-label="Link kopiëren"
                >
                  <Icon
                    name={copied === "url" ? "check" : "content_copy"}
                    size={chromeIconSize()}
                    color={chromeIconColor()}
                  />
                </Button>
              </div>
              <div className="mt-3 flex items-center gap-3">
                {qrDataUrl && (
                  <img
                    src={qrDataUrl}
                    alt="QR-code van de kaartlink"
                    className="h-24 w-24 flex-shrink-0"
                  />
                )}
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-gray-600">
                    Scan de QR-code om deze kaart te bekijken
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!qrDataUrl}
                    onClick={() =>
                      qrDataUrl && downloadDataUrl(qrDataUrl, "kaart-qr-code.png")
                    }
                  >
                    <Icon name="download" size={16} color={chromeIconColor()} />
                    Download QR-code
                  </Button>
                </div>
              </div>
            </div>

            {/* PNG download */}
            <div className="rounded-2xl border border-gray-100 p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-900">
                Downloaden als afbeelding
              </h3>
              <p className="mb-3 mt-1 text-xs text-gray-500">
                Download de Ronde kaart als PNG-afbeelding
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={exporting}
                onClick={() => void handleDownloadPng()}
              >
                <Icon name="download" size={16} color={chromeIconColor()} />
                {exporting ? "Bezig met exporteren…" : "Download PNG"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
