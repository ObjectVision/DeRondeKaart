import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/nav-icon";
import { Button } from "@/components/ui/button";
import type { NavLeaf } from "@/layers/navigation";
import type { NavigationApi } from "@/hooks/use-navigation";

interface LeafDetailProps {
  leaf: NavLeaf;
  /** Breadcrumb path of labels, ending with the leaf label. */
  path: string[];
  nav: NavigationApi;
  onBack: () => void;
}

// Module-level cache of fetched meta HTML, keyed by path.
const metaCache = new Map<string, string>();

export function LeafDetail({ leaf, path, nav, onBack }: LeafDetailProps) {
  const [html, setHtml] = useState<string | null>(
    leaf.meta ? metaCache.get(leaf.meta) ?? null : null,
  );
  const [loading, setLoading] = useState<boolean>(Boolean(leaf.meta) && !html);
  const reqId = useRef(0);

  useEffect(() => {
    if (!leaf.meta) {
      setHtml(null);
      setLoading(false);
      return;
    }
    const cached = metaCache.get(leaf.meta);
    if (cached !== undefined) {
      setHtml(cached);
      setLoading(false);
      return;
    }

    const id = ++reqId.current;
    setLoading(true);
    fetch(leaf.meta)
      .then((res) => (res.ok ? res.text() : Promise.reject(res.statusText)))
      .then((text) => {
        metaCache.set(leaf.meta!, text);
        if (id === reqId.current) {
          setHtml(text);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.warn(`Failed to load meta for "${leaf.id}":`, err);
        if (id === reqId.current) {
          setHtml(null);
          setLoading(false);
        }
      });
  }, [leaf.meta, leaf.id]);

  const onA = nav.isOnMap(leaf.id, "a");
  const onB = nav.isOnMap(leaf.id, "b");

  return (
    <div className="flex flex-col gap-3">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-gray-100"
          title="Terug"
        >
          <Icon name="arrow_back" size={16} />
        </button>
        <span className="truncate">{path.join(" › ")}</span>
      </div>

      <h3 className="text-sm font-semibold text-gray-900">{leaf.label}</h3>

      {/* Description / meta */}
      <div className="text-sm leading-relaxed text-gray-600">
        {loading ? (
          <span className="text-gray-400">Laden…</span>
        ) : html ? (
          <div
            className="prose-sm [&_a]:text-blue-600 [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          "Geen informatie beschikbaar"
        )}
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
            {onA ? "linker kaart ✓" : "linker kaart"}
          </Button>
          <Button
            variant={onB ? "default" : "outline"}
            size="sm"
            onClick={() => nav.toggleOnMap(leaf.id, "b")}
          >
            <Icon name="map" size={16} />
            {onB ? "rechter kaart ✓" : "rechter kaart"}
          </Button>
        </div>
      </div>
    </div>
  );
}
