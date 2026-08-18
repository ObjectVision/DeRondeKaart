import { For, Show, createMemo, createSignal, type JSX } from "solid-js";

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
 * The two separators carry the scoring rule: `/` reads as "or" between classes
 * of one layer, `+` as "and" between layers. Grouping by layer also mirrors the
 * score, which counts layers matched rather than classes ticked.
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
 * State is per-opening: the caller only renders this component while the dialog
 * is open (a `<Show>`), so each opening mounts it fresh and a new combination
 * starts empty rather than inheriting a selection whose layers may since have
 * left the map. That is why there is no reset effect here. (React achieved the
 * same by remounting via a changing `key`.)
 */
export function CombineLayersDialog(props: CombineLayersDialogProps): JSX.Element {
  const [selected, setSelected] = createSignal<ClassRef[]>([]);
  // Every layer starts expanded, so the classes are visible without a click.
  const [expanded, setExpanded] = createSignal<Set<string>>(
    // one-time seed: the dialog is
    // mounted per opening, so this IS the state for this opening
    // eslint-disable-next-line solid/reactivity
    new Set(props.layers.map((layer) => layer.id)),
  );
  const [name, setName] = createSignal("");
  const [nameEdited, setNameEdited] = createSignal(false);

  const generated = createMemo(() => autoName(props.layers, selected()));
  const effectiveName = () => (nameEdited() ? name() : generated());

  const selectedKeys = createMemo(() => new Set(selected().map(refKey)));

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
    if (selected().length === 0) return;
    props.onCreate(effectiveName().trim() || generated(), selected());
    props.onOpenChange(false);
  }

  return (
    <DialogRoot open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="w-[min(34rem,calc(100vw-2rem))]">
        <div class="mb-5 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <Icon name="masked_transitions_add" size={chromeIconSize()} color={chromeIconColor()} />
            {/* Same treatment as the "Themas" and "Legenda" panel headings. */}
            <DialogTitle class="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Lagen combineren
            </DialogTitle>
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

        <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
          Naam nieuwe laag
        </label>
        <input
          type="text"
          value={effectiveName()}
          onInput={(e) => {
            setNameEdited(true);
            setName(e.currentTarget.value);
          }}
          placeholder="Naam nieuwe laag"
          class="mb-5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
        />

        <div class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Geselecteerde lagen
        </div>
        <Show
          when={props.layers.length > 0}
          fallback={
            <p class="mb-5 text-sm text-gray-500">
              Voeg eerst kaartlagen met klassen toe aan de kaart.
            </p>
          }
        >
          <div class="mb-5 flex flex-col gap-2">
            <For each={props.layers}>
              {(layer) => {
                const isOpen = () => expanded().has(layer.id);
                const rules = () => layer.geostyler?.rules ?? [];
                return (
                  <div class="rounded-lg border border-gray-200">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(layer.id)}
                      aria-expanded={isOpen()}
                      class="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left"
                    >
                      <span class="min-w-0">
                        <span class="block truncate text-sm text-gray-900">{layer.name}</span>
                        <Show when={layer.subname}>
                          <span class="block truncate text-xs text-gray-500">
                            {layer.subname}
                          </span>
                        </Show>
                      </span>
                      <Icon
                        name={isOpen() ? "expand_more" : "chevron_right"}
                        size={chromeIconSize()}
                        class="flex-shrink-0 text-gray-400"
                      />
                    </button>
                    <Show when={isOpen()}>
                      <div class="border-t border-gray-100 px-3 py-2">
                        <div class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Klassen
                        </div>
                        <div class="flex flex-wrap gap-x-3 gap-y-1">
                          <For each={rules()}>
                            {(rule) => {
                              const checked = () =>
                                selectedKeys().has(
                                  refKey({ layerId: layer.id, ruleName: rule.name }),
                                );
                              return (
                                <button
                                  type="button"
                                  role="checkbox"
                                  aria-checked={checked()}
                                  onClick={() => toggleClass(layer.id, rule.name)}
                                  class="flex cursor-pointer items-center gap-1.5 rounded p-1 text-left"
                                >
                                  <Icon
                                    name={checked() ? "check_box" : "check_box_outline_blank"}
                                    size={chromeIconSize()}
                                    color={checked() ? chromeIconColor() : undefined}
                                    class={
                                      checked() ? "flex-shrink-0" : "flex-shrink-0 text-gray-400"
                                    }
                                  />
                                  <span class="text-xs text-gray-600">{rule.name}</span>
                                </button>
                              );
                            }}
                          </For>
                        </div>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        <div class="flex justify-end gap-2">
          <Button onClick={handleCreate} disabled={selected().length === 0}>
            Laag maken
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
