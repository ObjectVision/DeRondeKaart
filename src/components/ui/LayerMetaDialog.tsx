import { Show, type JSX } from "solid-js";
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
export function LayerMetaDialog(props: LayerMetaDialogProps): JSX.Element {
  return (
    // No layer selected yet — nothing to fetch or title the window with.
    <Show when={props.layer}>
      {(layer) => (
        <DialogRoot open={props.open} onOpenChange={props.onOpenChange}>
          {/* Size and position come from DialogContent, which pins every chrome
              dialog between the navigation card's top and the legend's bottom.
              Metainfo is long enough to reach that cap; it scrolls inside the
              window rather than growing past it. */}
          <DialogContent>
            <div class="mb-5 flex items-center justify-between gap-2">
              {/* Same treatment as the "Referentielagen" and "Legenda" headings. */}
              <DialogTitle class="text-xs font-semibold uppercase tracking-wide text-gray-500">
                {layer().name}
              </DialogTitle>
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
            <div class="text-sm leading-relaxed text-gray-600">
              <LeafMeta
                layerId={layer().id}
                onAddLayer={props.onAddLayer}
                isLayerOnMap={props.isLayerOnMap}
              />
            </div>
          </DialogContent>
        </DialogRoot>
      )}
    </Show>
  );
}
