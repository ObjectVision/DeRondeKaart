import { useMemo, useState } from "react";

import { DialogContent, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";
import type { LayerConfig } from "@/layers";

/** One chosen class: a layer plus the name of one of its GeoStyler rules. */
export interface ClassRef {
  layerId: string;
  ruleName: string;
}

export interface CombineLayersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The layers offered for combining — the currently active ones that carry
   * GeoStyler rules. The caller filters; this component only presents.
   */
  layers: LayerConfig[];
  /** Create the combined layer from the chosen classes. */
  onCreate: (name: string, refs: ClassRef[]) => void;
}

/**
 * Stable key for a class checkbox, since rule names are only unique per layer.
 *
 * The separator is a pipe: neither a layer id nor a rule name contains one, so
 * the key stays unambiguous while staying readable in source and in devtools.
 */
function refKey(ref: ClassRef): string {
  return `${ref.layerId}|${ref.ruleName}`;
}

/**
 * Auto-generated layer name: each layer contributes `"<layer> <a / b>"`, and the
 * layers are joined with `" + "` — e.g.
 * `"Supermarkt binnen 500 m + 3-30-300 goed/zeer goed"`.
 *
 * Grouped by layer rather than listing every class flat, because the interesting
 * part of a combination is which layers meet, not the class count.
 */
function autoName(layers: LayerConfig[], selected: ClassRef[]): string {
  const parts: string[] = [];
  for (const layer of layers) {
    const names = selected
      .filter((ref) => ref.layerId === layer.id)
      .map((ref) => ref.ruleName);
    if (names.length === 0) continue;
    parts.push(`${layer.name} ${names.join(" / ")}`);
  }
  return parts.join(" + ");
}

/**
 * "Lagen combineren" — pick classes across the active layers and turn them into
 * one scored layer, where a cell's class is how many of the chosen filters it
 * passes.
 *
 * Only classes that layers **already define** are offerable: the checkboxes come
 * from `geostyler.rules[].name`, the same source the legend renders, so a
 * combination is always expressible in terms the user has already seen on the
 * map. There is deliberately no free-text attribute/value entry.
 *
 * The name field auto-fills from the selection until the user types in it, after
 * which it is left alone — an edited name surviving the next checkbox click is
 * the point of making it editable.
 *
 * State is per-opening: the caller remounts this component each time it opens
 * (a `key`), so a fresh combination starts empty rather than inheriting a
 * selection whose layers may since have left the map. That is why there is no
 * reset effect here.
 */
export function CombineLayersDialog({
  open,
  onOpenChange,
  layers,
  onCreate,
}: CombineLayersDialogProps): React.JSX.Element {
  const [selected, setSelected] = useState<ClassRef[]>([]);
  // Every layer starts expanded, so the classes are visible without a click.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(layers.map((layer) => layer.id)),
  );
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);

  const generated = useMemo(() => autoName(layers, selected), [layers, selected]);
  const effectiveName = nameEdited ? name : generated;

  const selectedKeys = useMemo(
    () => new Set(selected.map(refKey)),
    [selected],
  );

  function toggleClass(layerId: string, ruleName: string) {
    const key = refKey({ layerId, ruleName });
    setSelected((prev) => {
      if (prev.some((ref) => refKey(ref) === key)) {
        return prev.filter((ref) => refKey(ref) !== key);
      }
      return [...prev, { layerId, ruleName }];
    });
  }

  function toggleExpanded(layerId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) {
        next.delete(layerId);
      } else {
        next.add(layerId);
      }
      return next;
    });
  }

  function handleCreate() {
    if (selected.length === 0) return;
    onCreate(effectiveName.trim() || generated, selected);
    onOpenChange(false);
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(34rem,calc(100vw-2rem))]">
        <div className="mb-5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon name="masked_transitions_add" size={chromeIconSize()} color={chromeIconColor()} />
            {/* Same treatment as the "Themas" and "Legenda" panel headings. */}
            <DialogTitle className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Lagen combineren
            </DialogTitle>
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

        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
          Naam nieuwe laag
        </label>
        <input
          type="text"
          value={effectiveName}
          onChange={(e) => {
            setNameEdited(true);
            setName(e.target.value);
          }}
          placeholder="Naam nieuwe laag"
          className="mb-5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
        />

        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Geselecteerde lagen
        </div>
        {layers.length === 0 ? (
          <p className="mb-5 text-sm text-gray-500">
            Voeg eerst kaartlagen met klassen toe aan de kaart.
          </p>
        ) : (
          <div className="mb-5 flex flex-col gap-2">
            {layers.map((layer) => {
              const isOpen = expanded.has(layer.id);
              const rules = layer.geostyler?.rules ?? [];
              return (
                <div key={layer.id} className="rounded-lg border border-gray-200">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(layer.id)}
                    aria-expanded={isOpen}
                    className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-gray-900">{layer.name}</span>
                      {layer.subname ? (
                        <span className="block truncate text-xs text-gray-500">
                          {layer.subname}
                        </span>
                      ) : null}
                    </span>
                    <Icon
                      name={isOpen ? "expand_more" : "chevron_right"}
                      size={chromeIconSize()}
                      className="flex-shrink-0 text-gray-400"
                    />
                  </button>
                  {isOpen && (
                    <div className="border-t border-gray-100 px-3 py-2">
                      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Klassen
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {rules.map((rule, index) => {
                          // Rule names are the legend's labels and can repeat
                          // within a layer, so the index disambiguates the key.
                          const ruleName = rule.name;
                          const checked = selectedKeys.has(
                            refKey({ layerId: layer.id, ruleName }),
                          );
                          return (
                            <button
                              key={`${ruleName}-${index}`}
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              onClick={() => toggleClass(layer.id, ruleName)}
                              className="flex cursor-pointer items-center gap-1.5 rounded p-1 text-left"
                            >
                              <Icon
                                name={checked ? "check_box" : "check_box_outline_blank"}
                                size={chromeIconSize()}
                                color={checked ? chromeIconColor() : undefined}
                                className={
                                  checked ? "flex-shrink-0" : "flex-shrink-0 text-gray-400"
                                }
                              />
                              <span className="text-xs text-gray-600">{ruleName}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Annuleren
          </Button>
          <Button onClick={handleCreate} disabled={selected.length === 0}>
            Laag maken
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
