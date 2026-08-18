import { For, type JSX } from "solid-js";
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
 * Switching base clears the options: only the active column can have ticked boxes,
 * so the id fully describes the dialog and nothing needs remembering per base.
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
export function BasemapDialog(props: BasemapDialogProps): JSX.Element {
  const active = () => basemapOptionsOf(props.basemapId);

  /**
   * The options to show for a base. Only the ACTIVE base can have any ticked:
   * switching basemap clears the previous one's boxes, so an inactive column is
   * always unticked.
   *
   * This is why the component needs no state of its own — `basemapId` carries the
   * active base's options and every other base is empty by definition.
   */
  function optionsFor(baseId: BasemapBaseId): BasemapOptions {
    const current = active();
    if (baseId === current.baseId) return current.options;
    return emptyOptions();
  }

  /** Switch base, starting it with no options ticked. */
  function handleSelectBase(baseId: BasemapBaseId) {
    if (baseId === active().baseId) return;
    props.onSelect(basemapIdFor(baseId, emptyOptions()));
  }

  /**
   * Toggle one checkbox. Ticking a box under an inactive base also switches to
   * that base — the checkbox belongs to its own column, so acting on a different
   * base than the one clicked would be the surprising behaviour. Since the boxes of
   * an inactive base are always clear, such a click starts from empty and turns on
   * only the one clicked.
   */
  function handleToggleOption(baseId: BasemapBaseId, key: BasemapOptionKey) {
    const current = optionsFor(baseId);
    const next: BasemapOptions = { ...current, [key]: !current[key] };
    props.onSelect(basemapIdFor(baseId, next));
  }

  return (
    <DialogRoot open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="w-[min(40rem,calc(100vw-2rem))]">
        <div class="mb-5 flex items-center justify-between gap-2">
          {/* Same treatment as the "Themas" and "Legenda" panel headings. */}
          <DialogTitle class="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Referentielagen
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
        <div role="radiogroup" aria-label="Referentielagen" class="grid grid-cols-3 gap-4">
          <For each={BASEMAP_BASES}>
            {(base) => {
              const selected = () => base.id === active().baseId;
              const options = () => optionsFor(base.id);
              return (
                <div
                  role="radio"
                  aria-checked={selected()}
                  aria-label={base.label}
                  class="flex flex-col gap-2 rounded-lg p-2 transition-colors"
                  // The selected column is tinted with the chrome accent rather than
                  // a Tailwind class: chromeIconColor is a runtime map.json value.
                  style={selected() ? { "background-color": `${chromeIconColor()}14` } : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSelectBase(base.id)}
                    title={base.label}
                    class="flex cursor-pointer flex-col items-center gap-2 rounded-lg text-left"
                  >
                    <img
                      src={base.thumb}
                      alt=""
                      aria-hidden
                      draggable={false}
                      class="aspect-square w-full rounded-full object-cover"
                      style={
                        selected()
                          ? { "box-shadow": `0 0 0 2px ${chromeIconColor()}` }
                          : { "box-shadow": "0 0 0 1px rgb(229 231 235)" }
                      }
                    />
                    <span
                      class="self-start text-sm"
                      style={
                        selected() ? { color: chromeIconColor(), "font-weight": 600 } : undefined
                      }
                    >
                      {base.label}
                    </span>
                  </button>
                  <div class="flex flex-col gap-1">
                    <For each={base.supports}>
                      {(key) => (
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={options()[key]}
                          onClick={() => handleToggleOption(base.id, key)}
                          class="flex cursor-pointer items-start gap-1.5 rounded p-1 text-left"
                        >
                          <Icon
                            name={options()[key] ? "check_box" : "check_box_outline_blank"}
                            size={chromeIconSize()}
                            color={options()[key] ? chromeIconColor() : undefined}
                            class={options()[key] ? "flex-shrink-0" : "flex-shrink-0 text-gray-400"}
                          />
                          <span class="text-xs text-gray-600">{OPTION_LABELS[key]}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
