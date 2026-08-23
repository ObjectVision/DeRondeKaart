import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";
import { registerVariantScopedCache } from "@/config/variant-scope";

/** Shown when a layer has metainfo but no short description of its own. */
const NO_DESCRIPTION = "Geen omschrijving beschikbaar.";

interface LayerInfo {
  description?: string;
  hasMeta: boolean;
}

// Layer id -> its description/meta presence. Module-level and shared by every
// instance, so a layer already resolved paints immediately. `undefined` from
// .get() means "not resolved yet".
const infoCache = new Map<string, LayerInfo>();

/**
 * Forget every resolved description. Registered as variant-scoped: the same
 * layer id describes a different layer under a different variant.
 */
export function clearLayerInfoCache(): void {
  infoCache.clear();
}

registerVariantScopedCache(clearLayerInfoCache);

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
export function LayerDescription(props: LayerDescriptionProps): JSX.Element {
  // Holds the resolved entry for the CURRENT layer id. React drove this with a
  // `useReducer` counter purely to force a repaint after writing the module
  // cache; a signal carries the value itself.
  const [info, setInfo] = createSignal<LayerInfo | undefined>(
    // cache-warm seed only; the
    // effect below re-resolves whenever `layerId` changes
    // eslint-disable-next-line solid/reactivity
    infoCache.get(props.layerId),
  );

  // loadLayerConfigs memoizes its parse, so this is a cache read after the
  // first caller anywhere in the app.
  createEffect(() => {
    const layerId = props.layerId;
    const cached = infoCache.get(layerId);
    if (cached) {
      setInfo(cached);
      return;
    }
    setInfo(undefined);

    let alive = true;
    loadLayerConfigs()
      .then((configs) => {
        const config = getLayerConfigById(configs, layerId);
        const resolved: LayerInfo = {
          description: config?.description,
          hasMeta: Boolean(config?.meta),
        };
        infoCache.set(layerId, resolved);
        if (alive) setInfo(resolved);
      })
      .catch((err) => {
        console.warn(`Failed to resolve description for "${layerId}":`, err);
        const resolved: LayerInfo = { hasMeta: false };
        infoCache.set(layerId, resolved);
        if (alive) setInfo(resolved);
      });

    onCleanup(() => {
      alive = false;
    });
  });

  const canOpenMeta = () => Boolean(info()?.hasMeta) && props.onOpenMeta !== undefined;

  return (
    <Show when={info()} fallback={<span class="text-gray-400">Laden…</span>}>
      {(resolved) => (
        <div class="flex items-center gap-2">
          {/* `min-w-0` lets the paragraph wrap instead of forcing the row wider than
              its container, which would push the button out of view. */}
          <p class="min-w-0 flex-1">{resolved().description ?? NO_DESCRIPTION}</p>
          {/* Middle right, vertically centred against the text. Disabled rather than
              hidden when the layer has no metainfo, matching the legend row's info
              button. `flex-shrink-0` keeps it square as the text grows. */}
          <Button
            variant="ghost"
            size="icon-sm"
            class="flex-shrink-0"
            disabled={!canOpenMeta()}
            onClick={() => props.onOpenMeta?.(props.layerId, props.layerName ?? props.layerId)}
            title={canOpenMeta() ? "Informatie" : "Metadata (nog niet beschikbaar)"}
            aria-label={`Informatie ${props.layerName ?? props.layerId}`}
          >
            <Icon name="info" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        </div>
      )}
    </Show>
  );
}
