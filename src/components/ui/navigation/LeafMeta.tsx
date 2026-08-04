import { useEffect, useReducer } from "react";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";

// Module-level caches, read straight through during render so a cached layer
// paints without a state round-trip. `metaUrlCache` maps layer id -> its meta
// URL (null = the layer has none, or is unknown); `metaCache` maps URL ->
// fetched HTML (null = failed, so a broken path isn't refetched every render).
// `undefined` from either .get() means "not resolved yet".
const metaUrlCache = new Map<string, string | null>();
const metaCache = new Map<string, string | null>();

/**
 * The meta/description block for a layer: resolves the layer's `meta` path from
 * layers.json, fetches that HTML (cached per URL) and renders it. Used by the
 * sidebar's inline info panel and the top-mode LeafDetail window.
 *
 * Takes a layer id rather than a NavLeaf because `meta` describes the dataset,
 * not the menu entry — layers reachable only via URL command or the legend have
 * no navigation leaf at all.
 */
export function LeafMeta({ layerId }: { layerId: string }) {
  // Render from the caches; the effects only fill them asynchronously.
  const url = metaUrlCache.get(layerId);
  const html = url ? metaCache.get(url) : null;
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  // Resolve layer id -> meta URL. loadLayerConfigs memoizes its parse, so this
  // is a cache read after the first caller anywhere in the app.
  useEffect(() => {
    if (metaUrlCache.has(layerId)) return;
    let alive = true;
    loadLayerConfigs()
      .then((configs) => {
        metaUrlCache.set(layerId, getLayerConfigById(configs, layerId)?.meta ?? null);
        if (alive) rerender();
      })
      .catch((err) => {
        console.warn(`Failed to resolve meta for "${layerId}":`, err);
        metaUrlCache.set(layerId, null);
        if (alive) rerender();
      });
    return () => {
      alive = false;
    };
  }, [layerId]);

  // Fetch the HTML once the URL is known.
  useEffect(() => {
    const resolved = metaUrlCache.get(layerId);
    if (!resolved || metaCache.has(resolved)) return;
    let alive = true;
    fetch(resolved)
      .then((res) => (res.ok ? res.text() : Promise.reject(res.statusText)))
      .then((text) => {
        metaCache.set(resolved, text);
        if (alive) rerender();
      })
      .catch((err) => {
        console.warn(`Failed to load meta for "${layerId}":`, err);
        metaCache.set(resolved, null);
        if (alive) rerender();
      });
    return () => {
      alive = false;
    };
    // `url` (not just layerId) so the fetch starts as soon as the id resolves.
  }, [url, layerId]);

  // Still resolving the id, or the URL is known but its HTML hasn't arrived.
  if (url === undefined || (url && html === undefined)) {
    return <span className="text-gray-400">Laden…</span>;
  }
  if (html) {
    return (
      <div
        className="prose-sm [&_a]:text-blue-600 [&_a]:underline"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <>Geen informatie beschikbaar</>;
}
