import { BASEMAPS } from "@/components/map/map-view-config";
import { DialogContent, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";

export interface BasemapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Currently selected basemap id — exactly one option is always checked. */
  basemapId: string;
  onSelect: (id: string) => void;
}

/**
 * The background-map picker: every entry of BASEMAPS as a circular preview with
 * a radio label, three per row.
 *
 * The previews are committed PNGs (`Basemap.thumb`), not live mini-maps — six
 * extra WebGL contexts for a chooser is a poor trade. The cost is that they are
 * snapshots: change a style file in public/ and the matching thumbnail silently
 * stops matching what the map draws, so regenerate them alongside such a change.
 *
 * Picking an option applies it immediately and leaves the dialog open, so the
 * user can compare without reopening; the map is visible around the modal.
 */
export function BasemapDialog({
  open,
  onOpenChange,
  basemapId,
  onSelect,
}: BasemapDialogProps): React.JSX.Element {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(34rem,calc(100vw-2rem))]">
        <div className="mb-5 flex items-start justify-between gap-2">
          <DialogTitle>Achtergrondkaart</DialogTitle>
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
        <div role="radiogroup" aria-label="Achtergrondkaart" className="grid grid-cols-3 gap-4">
          {BASEMAPS.map((basemap) => {
            const checked = basemap.id === basemapId;
            return (
              <button
                key={basemap.id}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => onSelect(basemap.id)}
                className="flex cursor-pointer flex-col items-center gap-2 rounded-lg p-2 text-left transition-colors hover:bg-gray-100"
              >
                <img
                  src={basemap.thumb}
                  alt=""
                  aria-hidden
                  draggable={false}
                  className={`aspect-square w-full rounded-full object-cover ${
                    checked ? "ring-2 ring-blue-600" : "ring-1 ring-gray-200"
                  }`}
                />
                <span className="flex items-start gap-1.5 self-start">
                  <Icon
                    name={checked ? "radio_button_checked" : "radio_button_unchecked"}
                    size={18}
                    className={
                      checked ? "flex-shrink-0 text-blue-600" : "flex-shrink-0 text-gray-400"
                    }
                  />
                  <span className="text-sm text-gray-700">{basemap.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
