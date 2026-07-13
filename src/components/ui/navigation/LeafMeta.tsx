import { useEffect, useReducer } from "react";
import type { NavLeaf } from "@/layers/navigation";

// Module-level cache of fetched meta HTML, keyed by URL. `null` marks a
// failed fetch so it isn't retried on every render.
const metaCache = new Map<string, string | null>();

/**
 * The meta/description block of a navigation leaf: fetches the leaf's `meta`
 * HTML (cached per URL) and renders it. Used by the sidebar's inline info
 * panel and the top-mode LeafDetail window.
 */
export function LeafMeta({ leaf }: { leaf: NavLeaf }) {
  // Render straight from the cache; the effect only fills it asynchronously.
  const cached = leaf.meta ? metaCache.get(leaf.meta) : null;
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const url = leaf.meta;
    if (!url || metaCache.has(url)) return;
    let alive = true;
    fetch(url)
      .then((res) => (res.ok ? res.text() : Promise.reject(res.statusText)))
      .then((text) => {
        metaCache.set(url, text);
        if (alive) rerender();
      })
      .catch((err) => {
        console.warn(`Failed to load meta for "${leaf.id}":`, err);
        metaCache.set(url, null);
        if (alive) rerender();
      });
    return () => {
      alive = false;
    };
  }, [leaf.meta, leaf.id]);

  if (leaf.meta && cached === undefined) {
    return <span className="text-gray-400">Laden…</span>;
  }
  if (cached) {
    return (
      <div
        className="prose-sm [&_a]:text-blue-600 [&_a]:underline"
        dangerouslySetInnerHTML={{ __html: cached }}
      />
    );
  }
  return <>Geen informatie beschikbaar</>;
}
