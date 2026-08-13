import { useEffect, useRef } from "react";
import type { BasemapBaseId, BasemapOptionKey, BasemapOptions } from "@/components/map/map-view-config";
import {
  BASEMAP_BASES,
  basemapIdFor,
  basemapOptionsOf,
} from "@/components/map/map-view-config";
import { DialogContent, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";

export interface BasemapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Currently selected basemap id — exactly one circle is always checked. */
  basemapId: string;
  onSelect: (id: string) => void;
}

/** Dutch labels for the option checkboxes. */
const OPTION_LABELS: Record<BasemapOptionKey, string> = {
  labels: "Labels",
  roads: "Wegen en water op voorgrond",
};

/** Every base starts with nothing promoted above user data. */
function emptyOptions(): BasemapOptions {
  return { labels: false, roads: false };
}

/**
 * The background-map picker: three circular previews, each with the checkboxes
 * its base supports.
 *
 * The base and the checkbox states are two independent choices, but the app
 * persists them as ONE basemap id (sessionStorage, share URLs, map.json). So this
 * dialog holds no selection state of its own — it derives the active base and
 * options from the `basemapId` prop and reports every change back as a new id via
 * `onSelect`. That keeps it correct when the id changes from outside (a
 * `#basemap=` share link, or the other map).
 *
 * There is no radio control: the thumbnail and each checkbox all select their own
 * base, so the whole column is the target and a separate radio would be a fourth
 * way to do the same thing. The column still carries `role="radio"` for assistive
 * tech, since exactly one base is active at a time.
 *
 * Selecting does NOT close the dialog: the point of the checkboxes is to try a
 * combination and adjust it, which is impossible if the window disappears on the
 * first click.
 *
 * The previews are committed PNGs (`BasemapBase.thumb`), not live mini-maps —
 * three extra WebGL contexts for a chooser is a poor trade. The cost is that they
 * are snapshots: change a style file in public/ and the matching thumbnail
 * silently stops matching what the map draws, so regenerate them alongside such a
 * change.
 */
export function BasemapDialog({
  open,
  onOpenChange,
  basemapId,
  onSelect,
}: BasemapDialogProps): React.JSX.Element {
  const active = basemapOptionsOf(basemapId);

  // Checkbox states for the bases that are NOT active, so switching away and back
  // restores what the user had ticked. Only the active base's options live in
  // `basemapId`; without this, returning to Kleur would silently reset it.
  //
  // A ref rather than state: it is read at click time and never rendered (the
  // checkboxes shown under an inactive base come from this map, but any write to
  // it is always accompanied by an onSelect that re-renders anyway).
  const rememberedRef = useRef<Record<BasemapBaseId, BasemapOptions>>({
    luchtfoto: emptyOptions(),
    kleur: emptyOptions(),
    grijs: emptyOptions(),
  });

  // Keep the active base's remembered options in step with the incoming id, so an
  // externally applied basemap (share link) is what a later switch-back restores.
  // Keyed on `basemapId`: `active` is rebuilt on every render, so depending on it
  // would re-run this each time.
  useEffect(() => {
    const { baseId, options } = basemapOptionsOf(basemapId);
    rememberedRef.current[baseId] = options;
  }, [basemapId]);

  /** The options to show for a base: live ones for the active base, remembered otherwise. */
  function optionsFor(baseId: BasemapBaseId): BasemapOptions {
    if (baseId === active.baseId) return active.options;
    return rememberedRef.current[baseId];
  }

  function handleSelectBase(baseId: BasemapBaseId) {
    onSelect(basemapIdFor(baseId, optionsFor(baseId)));
  }

  /**
   * Toggle one checkbox. Ticking a box under an inactive base also switches to
   * that base — the checkbox belongs to its own column, so acting on a different
   * base than the one clicked would be the surprising behaviour.
   */
  function handleToggleOption(baseId: BasemapBaseId, key: BasemapOptionKey) {
    const current = optionsFor(baseId);
    const next: BasemapOptions = { ...current, [key]: !current[key] };
    rememberedRef.current[baseId] = next;
    onSelect(basemapIdFor(baseId, next));
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(40rem,calc(100vw-2rem))]">
        <div className="mb-5 flex items-center justify-between gap-2">
          {/* Same treatment as the "Themas" and "Legenda" panel headings. */}
          <DialogTitle className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Achtergrondkaart
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
        <div role="radiogroup" aria-label="Achtergrondkaart" className="grid grid-cols-3 gap-4">
          {BASEMAP_BASES.map((base) => {
            const selected = base.id === active.baseId;
            const options = optionsFor(base.id);
            return (
              <div
                key={base.id}
                role="radio"
                aria-checked={selected}
                aria-label={base.label}
                className="flex flex-col gap-2 rounded-lg p-2 transition-colors"
                // The selected column is tinted with the chrome accent rather than
                // a Tailwind class: chromeIconColor is a runtime map.json value.
                style={selected ? { backgroundColor: `${chromeIconColor()}14` } : undefined}
              >
                <button
                  type="button"
                  onClick={() => handleSelectBase(base.id)}
                  title={base.label}
                  className="flex cursor-pointer flex-col items-center gap-2 rounded-lg text-left"
                >
                  <img
                    src={base.thumb}
                    alt=""
                    aria-hidden
                    draggable={false}
                    className="aspect-square w-full rounded-full object-cover"
                    style={
                      selected
                        ? { boxShadow: `0 0 0 2px ${chromeIconColor()}` }
                        : { boxShadow: "0 0 0 1px rgb(229 231 235)" }
                    }
                  />
                  <span
                    className="self-start text-sm"
                    style={selected ? { color: chromeIconColor(), fontWeight: 600 } : undefined}
                  >
                    {base.label}
                  </span>
                </button>
                <div className="flex flex-col gap-1">
                  {base.supports.map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="checkbox"
                      aria-checked={options[key]}
                      onClick={() => handleToggleOption(base.id, key)}
                      className="flex cursor-pointer items-start gap-1.5 rounded p-1 text-left"
                    >
                      <Icon
                        name={options[key] ? "check_box" : "check_box_outline_blank"}
                        size={chromeIconSize()}
                        color={options[key] ? chromeIconColor() : undefined}
                        className={options[key] ? "flex-shrink-0" : "flex-shrink-0 text-gray-400"}
                      />
                      <span className="text-xs text-gray-600">{OPTION_LABELS[key]}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
