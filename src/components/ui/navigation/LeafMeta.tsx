import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import {
  buildMetaLayerIndex,
  decorateMetaLayerLinks,
  parseMetaLayerLink,
  type MetaLayerIndex,
} from "@/lib/meta-layer-links";

// Module-level caches shared by every instance, so a layer already resolved
// paints immediately. `metaUrlCache` maps layer id -> its meta URLs (null = the
// layer has none, or is unknown); `metaCache` maps URL -> fetched HTML (null =
// failed, so a broken path isn't refetched). `undefined` from either .get()
// means "not resolved yet".
//
// metaCache is keyed by URL, not by layer, and that is the point: a shared base
// fragment referenced by many layers is fetched once for all of them.
const metaUrlCache = new Map<string, string[] | null>();
const metaCache = new Map<string, string | null>();

/**
 * Forget the layer-id → meta-URL mapping. Called on a config-variant switch:
 * ids are reused between variants, so an id resolved under the old variant
 * would otherwise keep pointing at the old year's meta pages.
 *
 * `metaCache` is deliberately kept — it is keyed by URL, and a URL means the
 * same document whichever variant asked for it.
 */
export function clearMetaUrlCache(): void {
  metaUrlCache.clear();
}

interface LeafMetaProps {
  layerId: string;
  /**
   * Add `id` to the left map when a legacy mapviewer link inside the meta HTML is
   * clicked. Omitted, those links keep their default (dead) navigation.
   */
  onAddLayer?: (id: string) => void;
  /** Whether `id` is on the left map, for the add-button's state icon. */
  isLayerOnMap?: (id: string) => boolean;
}

/**
 * The meta/description block for a layer: resolves the layer's `meta` path(s)
 * from layers.json, fetches that HTML (cached per URL) and renders it. Used by
 * the sidebar's inline info panel and the top-mode LeafDetail window.
 *
 * `meta` may name one fragment or several (see LayerConfig.meta). Several are
 * concatenated **verbatim** in array order — nothing is stripped or rewritten, so
 * a fragment's own `<link>`/`<head>`/`<footer>` boilerplate is repeated. That is
 * deliberate: the fragments are published documents, and rewriting them here
 * would silently diverge from what the publisher serves.
 *
 * Takes a layer id rather than a NavLeaf because `meta` describes the dataset,
 * not the menu entry — layers reachable only via URL command or the legend have
 * no navigation leaf at all.
 *
 * The fragments link their layer cross-references to the retired 2025 mapviewer.
 * Those links are intercepted (see `onAddLayer`) and turned into "add to the left
 * map" instead — by delegation and DOM decoration rather than by rewriting the
 * HTML, so the published document is still rendered exactly as served.
 */
export function LeafMeta(props: LeafMetaProps): JSX.Element {
  // The resolved meta URLs for the CURRENT layer, and a counter bumped when a
  // fragment lands. React drove both with a `useReducer` counter purely to force
  // a repaint after writing the module caches.
  const [urls, setUrls] = createSignal<string[] | null | undefined>(
    // cache-warm seed only; the
    // effect below re-resolves whenever `layerId` changes
    // eslint-disable-next-line solid/reactivity
    metaUrlCache.get(props.layerId),
  );
  const [fetchedAt, setFetchedAt] = createSignal(0);
  let container!: HTMLDivElement;
  // Shared with the click handler so a click resolves rows the same way the
  // decoration pass did. Null until the configs have loaded.
  let layerIndex: MetaLayerIndex | null = null;

  // Resolve layer id -> meta URLs. loadLayerConfigs memoizes its parse, so this
  // is a cache read after the first caller anywhere in the app. A single string is
  // normalized to a one-element array so everything below handles only arrays.
  createEffect(() => {
    const layerId = props.layerId;
    if (metaUrlCache.has(layerId)) {
      setUrls(metaUrlCache.get(layerId));
      return;
    }
    setUrls(undefined);

    let alive = true;
    loadLayerConfigs()
      .then((configs) => {
        const meta = getLayerConfigById(configs, layerId)?.meta;
        let resolved: string[] | null = null;
        if (typeof meta === "string") {
          resolved = [meta];
        } else if (Array.isArray(meta) && meta.length > 0) {
          resolved = meta;
        }
        metaUrlCache.set(layerId, resolved);
        if (alive) setUrls(resolved);
      })
      .catch((err) => {
        console.warn(`Failed to resolve meta for "${layerId}":`, err);
        metaUrlCache.set(layerId, null);
        if (alive) setUrls(null);
      });

    onCleanup(() => {
      alive = false;
    });
  });

  // Fetch every fragment that isn't cached yet, in parallel. allSettled rather
  // than all: one 404 among several fragments must not discard the others (and
  // one published meta file is a genuine upstream 404 today).
  createEffect(() => {
    const resolved = urls();
    const layerId = props.layerId;
    if (!resolved) return;
    const missing = resolved.filter((url) => !metaCache.has(url));
    if (missing.length === 0) return;

    let alive = true;
    Promise.allSettled(
      missing.map((url) =>
        fetch(url)
          .then((res) => (res.ok ? res.text() : Promise.reject(new Error(res.statusText))))
          .then((text) => {
            metaCache.set(url, text);
          })
          .catch((err) => {
            console.warn(`Failed to load meta "${url}" for "${layerId}":`, err);
            metaCache.set(url, null);
          }),
      ),
    ).then(() => {
      if (alive) setFetchedAt((n) => n + 1);
    });

    onCleanup(() => {
      alive = false;
    });
  });

  /** True while any of the layer's fragments is still in flight. */
  const pending = createMemo(() => {
    fetchedAt(); // re-evaluate once fetches settle
    const resolved = urls();
    return Boolean(resolved && resolved.some((url) => metaCache.get(url) === undefined));
  });

  // The composed document, or null when nothing usable resolved.
  const html = createMemo(() => {
    fetchedAt();
    const resolved = urls();
    if (!resolved || pending()) return null;
    const parts = resolved
      .map((url) => metaCache.get(url))
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("\n") : null;
  });

  // Point the fragments' legacy mapviewer links at the current viewer: give the
  // buttons a glyph reflecting whether the layer is on the map, and mark the ids
  // this viewer doesn't publish.
  //
  // This mutates DOM that Solid does not manage, and survives because Solid only
  // reassigns `innerHTML` when the string itself changes: unchanged HTML leaves
  // the subtree alone, so the decorations stay put and this effect re-runs to
  // update them whenever the map's contents change.
  createEffect(() => {
    const composed = html();
    const isLayerOnMap = props.isLayerOnMap;
    if (!composed || !isLayerOnMap) return;

    let alive = true;
    loadLayerConfigs()
      .then((configs) => {
        if (!alive) return;
        const knownIds = new Set(configs.map((config) => config.id));
        const index = buildMetaLayerIndex(configs);
        layerIndex = index;
        decorateMetaLayerLinks(container, knownIds, isLayerOnMap, index);
      })
      .catch((err) => {
        // Decoration is cosmetic; failing to load the configs leaves the links
        // as published, and the click handler still guards on the parse.
        console.warn("Failed to decorate meta layer links:", err);
      });

    onCleanup(() => {
      alive = false;
    });
  });

  // One delegated handler rather than a listener per anchor: a composed document
  // holds dozens of these links, and the markup is re-injected wholesale.
  function handleMetaClick(event: MouseEvent): void {
    if (!props.onAddLayer) return;
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    const link = parseMetaLayerLink(anchor, layerIndex ?? undefined);
    // Not a legacy viewer link — an ordinary outbound link, leave it navigating.
    if (!link) return;
    // Always suppress the navigation: the target viewer is retired, so following
    // the link is never right, even when the layer isn't available here.
    event.preventDefault();
    if (!link.layerId) return;
    props.onAddLayer(link.layerId);
  }

  return (
    // Still resolving the layer's meta paths, or any fragment still in flight —
    // wait for all of them, so the dialog doesn't reflow as the second half of a
    // composed document arrives.
    <Show
      when={urls() !== undefined && !pending()}
      fallback={<span class="text-gray-400">Laden…</span>}
    >
      <Show when={html()} fallback={<>Geen informatie beschikbaar</>}>
        {(composed) => (
          <div
            ref={container}
            onClick={handleMetaClick}
            // `prose` must accompany `prose-sm`: the latter is only a size modifier
            // and styles nothing on its own. `max-w-none` drops prose's 65ch cap so
            // the text still fills the dialog. The link overrides come last so they
            // win over prose's own anchor colour, keeping links the app blue.
            //
            // The list overrides undo prose's treatment of "Gerelateerde kaartlagen":
            // those <li>s hold a thumbnail plus a link, not running text, so prose's
            // bullet markers and generous item spacing pushed the six entries off
            // screen. Headings and paragraphs keep prose's styling.
            //
            // `prose` styles h1-h4 but leaves h5 at body size and weight, so the
            // "Uitgangspunten" / "Temperatuurniveaus" labels in the PBL strategy
            // fragments would not read as headings — styled explicitly here.
            class={
              "prose prose-sm max-w-none [&_a]:text-blue-600 [&_a]:underline " +
              "[&_ul]:my-0 [&_ul]:list-none [&_ul]:pl-0 [&_li]:my-0 [&_li]:pl-0 " +
              "[&_li]:before:hidden " +
              "[&_h5]:mt-4 [&_h5]:mb-1 [&_h5]:font-semibold [&_h5]:text-gray-900 " +
              // The "Gerelateerde kaartlagen" rows are marked up for Bootstrap
              // (`d-flex justify-content-between`), which the app doesn't load, so
              // the add button wrapped onto its own line below the label. Restore
              // the row the publisher intended: label left, button right, and drop
              // the inherited block margins that spread six rows down the dialog.
              "[&_li.list-group-item]:flex [&_li.list-group-item]:items-center " +
              "[&_li.list-group-item]:justify-between [&_li.list-group-item]:gap-3 " +
              "[&_li.list-group-item]:py-0.5 [&_li.list-group-item_div]:my-0 " +
              // prose puts 24px above and below every image, which is two thirds of
              // each row's height when the image is a small inline thumbnail.
              "[&_li.list-group-item_img]:my-0"
            }
            // published metainfo
            // fragments fetched from our own origin; see the component doc above
            // eslint-disable-next-line solid/no-innerhtml
            innerHTML={composed()}
          />
        )}
      </Show>
    </Show>
  );
}
