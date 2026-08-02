import { Icon } from "@/components/ui/nav-icon";
import { Button } from "@/components/ui/button";
import { LeafMeta } from "./LeafMeta";
import type { NavLeaf } from "@/layers/navigation";
import type { NavigationApi } from "@/hooks/use-navigation";

interface LeafDetailProps {
  leaf: NavLeaf;
  /** Breadcrumb path of labels, ending with the leaf label. */
  path: string[];
  nav: NavigationApi;
  onBack: () => void;
}

export function LeafDetail({ leaf, path, nav, onBack }: LeafDetailProps) {
  const onA = nav.isOnMap(leaf.id, "a");
  const onB = nav.isOnMap(leaf.id, "b");
  // The right map can only be added to once the left map holds a layer. Adding is
  // blocked while the left map is empty; removing an existing right-map layer stays allowed.
  const rightDisabled = !nav.leftHasLayers && !onB;

  return (
    <div className="flex flex-col gap-3">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-gray-100"
          title="Terug"
        >
          <Icon name="chevron_left" size={16} />
        </button>
        <span className="truncate">{path.join(" › ")}</span>
      </div>

      <h3 className="text-sm font-semibold text-gray-900">{leaf.label}</h3>

      {/* Description / meta */}
      <div className="text-sm leading-relaxed text-gray-600">
        <LeafMeta leaf={leaf} />
      </div>

      {/* Add to map */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-gray-500">Laag toevoegen aan:</span>
        <div className="flex gap-2">
          <Button
            variant={onA ? "default" : "outline"}
            size="sm"
            onClick={() => nav.toggleOnMap(leaf.id, "a")}
          >
            <Icon name="map" size={16} />
            {onA ? "Linker kaart ✓" : "Linker kaart"}
          </Button>
          <Button
            variant={onB ? "default" : "outline"}
            size="sm"
            disabled={rightDisabled}
            title={
              rightDisabled
                ? "Voeg eerst een laag toe aan de linker kaart"
                : undefined
            }
            onClick={() => nav.toggleOnMap(leaf.id, "b")}
          >
            <Icon name="map" size={16} />
            {onB ? "Rechter kaart ✓" : "Rechter kaart"}
          </Button>
        </div>
      </div>
    </div>
  );
}
