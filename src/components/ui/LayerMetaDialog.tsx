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
          {/* Same width as BasemapDialog ("Referentielagen") so the chrome dialogs
              read as one family. DialogContent owns the `overflow-y-auto`, so
              `app-scrollbar` has to land here — it styles the popup's own scrollbar
              to match the navigation and legend cards.

              The top quarter of the screen stays clear: metainfo is long enough to
              hit the shell's default `max-h-[calc(100vh-2rem)]`, which on a centred
              dialog reaches to ~1rem from the top. Anchoring the top edge at 25vh
              and capping the height at the remaining space (less the same 1rem
              bottom margin the shell uses) keeps that band free at every viewport
              height, rather than depending on the content being short enough. */}
          <DialogContent class="app-scrollbar top-[25vh] max-h-[calc(75vh-1rem)] w-[min(40rem,calc(100vw-2rem))] translate-y-0">
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
