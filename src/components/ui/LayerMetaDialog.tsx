import { DialogContent, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { LeafMeta } from "@/components/ui/navigation/LeafMeta";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";

export interface LayerMetaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Layer whose `meta` HTML is shown; null while the dialog is closed. */
  layer: { id: string; name: string } | null;
  /** Add `id` to the left map when a layer link inside the meta HTML is clicked. */
  onAddLayer?: (id: string) => void;
  /** Whether `id` is on the left map, for those links' state icons. */
  isLayerOnMap?: (id: string) => boolean;
}

/**
 * A layer's metainfo (its `meta` HTML fragment) as a modal window, opened from
 * the legend's info button or from under the navigation description.
 *
 * Same shell as BasemapDialog — the two are the app's "chrome" dialogs and are
 * meant to read as one family.
 *
 * The body is LeafMeta, which already owns the fetch, the per-URL cache and the
 * loading/empty states. This component adds only the window around it.
 */
export function LayerMetaDialog({
  open,
  onOpenChange,
  layer,
  onAddLayer,
  isLayerOnMap,
}: LayerMetaDialogProps): React.JSX.Element | null {
  // No layer selected yet — nothing to fetch or title the window with.
  if (!layer) return null;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      {/* Same width as BasemapDialog ("Referentielagen") so the chrome dialogs
          read as one family. DialogContent owns the `overflow-y-auto`, so
          `app-scrollbar` has to land here — it styles the popup's own scrollbar
          to match the navigation and legend cards. */}
      <DialogContent className="app-scrollbar w-[min(40rem,calc(100vw-2rem))]">
        <div className="mb-5 flex items-center justify-between gap-2">
          {/* Same treatment as the "Referentielagen" and "Legenda" headings. */}
          <DialogTitle className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {layer.name}
          </DialogTitle>
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
        <div className="text-sm leading-relaxed text-gray-600">
          <LeafMeta layerId={layer.id} onAddLayer={onAddLayer} isLayerOnMap={isLayerOnMap} />
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
