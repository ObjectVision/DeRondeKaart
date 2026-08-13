import { useEffect, useReducer } from "react";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";

// Module-level caches, read straight through during render so a cached layer
// paints without a state round-trip. `metaUrlCache` maps layer id -> its meta
// URLs (null = the layer has none, or is unknown); `metaCache` maps URL ->
// fetched HTML (null = failed, so a broken path isn't refetched every render).
// `undefined` from either .get() means "not resolved yet".
//
// metaCache is keyed by URL, not by layer, and that is the point: a shared base
// fragment referenced by many layers is fetched once for all of them.
const metaUrlCache = new Map<string, string[] | null>();
const metaCache = new Map<string, string | null>();

interface LeafMetaProps {
  layerId: string;
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
 */
export function LeafMeta({ layerId }: LeafMetaProps): React.JSX.Element | null {
  // Render from the caches; the effects only fill them asynchronously.
  const urls = metaUrlCache.get(layerId);
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  // Resolve layer id -> meta URLs. loadLayerConfigs memoizes its parse, so this
  // is a cache read after the first caller anywhere in the app. A single string is
  // normalized to a one-element array so everything below handles only arrays.
  useEffect(() => {
    if (metaUrlCache.has(layerId)) return;
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

  // Fetch every fragment that isn't cached yet, in parallel. allSettled rather
  // than all: one 404 among several fragments must not discard the others (and
  // one published meta file is a genuine upstream 404 today).
  useEffect(() => {
    const resolved = metaUrlCache.get(layerId);
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
      if (alive) rerender();
    });
    return () => {
      alive = false;
    };
    // `urls` (not just layerId) so the fetch starts as soon as the ids resolve.
  }, [urls, layerId]);

  // Still resolving the layer's meta paths.
  if (urls === undefined) {
    return <span className="text-gray-400">Laden…</span>;
  }
  if (urls) {
    // Any fragment still in flight — wait for all of them, so the dialog doesn't
    // reflow as the second half of a composed document arrives.
    if (urls.some((url) => metaCache.get(url) === undefined)) {
      return <span className="text-gray-400">Laden…</span>;
    }
    const parts = urls
      .map((url) => metaCache.get(url))
      .filter((html): html is string => Boolean(html));
    if (parts.length > 0) {
      return (
        <div
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
          className={
            "prose prose-sm max-w-none [&_a]:text-blue-600 [&_a]:underline " +
            "[&_ul]:my-0 [&_ul]:list-none [&_ul]:pl-0 [&_li]:my-0 [&_li]:pl-0 " +
            "[&_li]:before:hidden " +
            "[&_h5]:mt-4 [&_h5]:mb-1 [&_h5]:font-semibold [&_h5]:text-gray-900"
          }
          dangerouslySetInnerHTML={{ __html: parts.join("\n") }}
        />
      );
    }
  }
  return <>Geen informatie beschikbaar</>;
}
