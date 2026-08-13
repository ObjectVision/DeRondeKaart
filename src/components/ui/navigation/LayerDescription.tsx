import { useEffect, useReducer } from "react";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";

/** Shown when a layer has metainfo but no short description of its own. */
const NO_DESCRIPTION = "Geen omschrijving beschikbaar.";

// Layer id -> its description/meta presence. Module-level and read straight
// through during render, mirroring LeafMeta: a layer already resolved paints
// without a state round-trip. `undefined` from .get() means "not resolved yet".
const infoCache = new Map<string, { description?: string; hasMeta: boolean }>();

interface LayerDescriptionProps {
  layerId: string;
  /** Opens the metainfo dialog. Omit to render the info button disabled. */
  onOpenMeta?: (layerId: string, layerName: string) => void;
  /** Dialog title. Falls back to the layer's own name from layers.json. */
  layerName?: string;
}

/**
 * A layer's short description, with an info button beneath it that opens the
 * full metainfo dialog.
 *
 * Shared by both navigation modes — the sidebar's inline panel and the top-mode
 * LeafDetail window — so the two cannot drift apart.
 *
 * Callers decide *whether* to render this at all: a layer with neither a
 * description nor meta shows no panel (see Sidebar.handleRowClick). What this
 * component decides is the content of a panel that is already open.
 */
export function LayerDescription({
  layerId,
  onOpenMeta,
  layerName,
}: LayerDescriptionProps): React.JSX.Element {
  const info = infoCache.get(layerId);
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  // loadLayerConfigs memoizes its parse, so this is a cache read after the
  // first caller anywhere in the app.
  useEffect(() => {
    if (infoCache.has(layerId)) return;
    let alive = true;
    loadLayerConfigs()
      .then((configs) => {
        const config = getLayerConfigById(configs, layerId);
        infoCache.set(layerId, {
          description: config?.description,
          hasMeta: Boolean(config?.meta),
        });
        if (alive) rerender();
      })
      .catch((err) => {
        console.warn(`Failed to resolve description for "${layerId}":`, err);
        infoCache.set(layerId, { hasMeta: false });
        if (alive) rerender();
      });
    return () => {
      alive = false;
    };
  }, [layerId]);

  if (info === undefined) {
    return <span className="text-gray-400">Laden…</span>;
  }

  const canOpenMeta = info.hasMeta && onOpenMeta !== undefined;

  return (
    <div className="flex items-center gap-2">
      {/* `min-w-0` lets the paragraph wrap instead of forcing the row wider than
          its container, which would push the button out of view. */}
      <p className="min-w-0 flex-1">{info.description ?? NO_DESCRIPTION}</p>
      {/* Middle right, vertically centred against the text. Disabled rather than
          hidden when the layer has no metainfo, matching the legend row's info
          button. `flex-shrink-0` keeps it square as the text grows. */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="flex-shrink-0"
        disabled={!canOpenMeta}
        onClick={() => onOpenMeta?.(layerId, layerName ?? layerId)}
        title={canOpenMeta ? "Informatie" : "Metadata (nog niet beschikbaar)"}
        aria-label={`Informatie ${layerName ?? layerId}`}
      >
        <Icon name="info" size={chromeIconSize()} color={chromeIconColor()} />
      </Button>
    </div>
  );
}
