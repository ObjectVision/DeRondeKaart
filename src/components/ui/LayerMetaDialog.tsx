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
}: LayerMetaDialogProps): React.JSX.Element | null {
  // No layer selected yet — nothing to fetch or title the window with.
  if (!layer) return null;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(34rem,calc(100vw-2rem))]">
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
          <LeafMeta layerId={layer.id} />
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
