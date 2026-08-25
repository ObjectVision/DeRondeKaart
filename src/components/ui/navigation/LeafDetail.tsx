import { Show, type JSX } from "solid-js";
import { Icon } from "@/components/ui/nav-icon";
import { Button } from "@/components/ui/button";
import { LayerDescription } from "./LayerDescription";
import { leafPair, type NavLeaf } from "@/layers/navigation";
import type { NavigationApi } from "@/hooks/use-navigation";

interface LeafDetailProps {
  leaf: NavLeaf;
  /** Breadcrumb path of labels, ending with the leaf label. */
  path: string[];
  nav: NavigationApi;
  onBack: () => void;
  /** Opens the layer's metainfo dialog from the info button under the description. */
  onOpenMeta?: (layerId: string, layerName: string) => void;
}

export function LeafDetail(props: LeafDetailProps): JSX.Element {
  const pair = () => leafPair(props.leaf);
  const onLeft = () => props.nav.isOnMap(props.leaf.id, "left");
  const onRight = () => props.nav.isOnMap(props.leaf.id, "right");
  // The right map can only be added to once the left map holds a layer. Adding is
  // blocked while the left map is empty; removing an existing right-map layer stays allowed.
  const rightDisabled = () => !props.nav.leftHasLayers() && !onRight();
  // "Partial" counts as applied, so the button offers to clear the leftover half.
  const pairOn = () => {
    const p = pair();
    return p ? props.nav.pairState(p) !== "none" : false;
  };

  return (
    <div class="flex flex-col gap-3">
      {/* Breadcrumb */}
      <div class="flex items-center gap-1.5 text-xs text-gray-500">
        <button
          onClick={() => props.onBack?.()}
          class="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-gray-100"
          title="Terug"
        >
          <Icon name="chevron_left" size={16} />
        </button>
        <span class="truncate">{props.path.join(" › ")}</span>
      </div>

      <h3 class="text-sm font-semibold text-gray-900">{props.leaf.label}</h3>

      {/* Short description + info button opening the full metainfo. Omitted for
          a pair: the leaf names two layers, and showing one layer's description
          would read as if it covered both. */}
      <Show when={!pair()}>
        <div class="text-sm leading-relaxed text-gray-600">
          <LayerDescription
            layerId={props.leaf.id}
            layerName={props.leaf.label}
            onOpenMeta={props.onOpenMeta}
          />
        </div>
      </Show>

      {/* Add to map. A pair decides its own sides, so it gets one button rather
          than the per-side choice — and no `rightDisabled` guard, because
          togglePair fills the left map itself before touching the right. */}
      <Show
        when={pair()}
        fallback={
          <div class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-gray-500">Laag toevoegen aan:</span>
            <div class="flex gap-2">
              <Button
                variant={onLeft() ? "default" : "outline"}
                size="sm"
                onClick={() => props.nav.toggleOnMap(props.leaf.id, "left")}
              >
                <Icon name="map" size={16} />
                {onLeft() ? "Linker kaart ✓" : "Linker kaart"}
              </Button>
              <Button
                variant={onRight() ? "default" : "outline"}
                size="sm"
                disabled={rightDisabled()}
                title={rightDisabled() ? "Voeg eerst een laag toe aan de linker kaart" : undefined}
                onClick={() => props.nav.toggleOnMap(props.leaf.id, "right")}
              >
                <Icon name="map" size={16} />
                {onRight() ? "Rechter kaart ✓" : "Rechter kaart"}
              </Button>
            </div>
          </div>
        }
      >
        {(p) => (
          <div class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-gray-500">Vergelijking:</span>
            <Button
              variant={pairOn() ? "default" : "outline"}
              size="sm"
              class="self-start"
              onClick={() => void props.nav.togglePair(p())}
            >
              <Icon name="compare_arrows" size={16} />
              {pairOn() ? "Vergelijking verwijderen" : "Vergelijking tonen"}
            </Button>
          </div>
        )}
      </Show>
    </div>
  );
}
