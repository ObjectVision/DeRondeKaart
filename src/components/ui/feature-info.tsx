import { useState, useEffect } from "react";
import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";
import { resolveTemplate, renderTemplate } from "@/layers";

interface FeatureInfoProps {
  result: FeatureInfoResult;
  layerEntries: LayerEntry[];
  onClose: () => void;
}

export function FeatureInfo({ result, layerEntries, onClose }: FeatureInfoProps) {
  const layerIds = Array.from(result.featuresByLayer.keys());
  const [activeTab, setActiveTab] = useState(layerIds[0]);
  const [templates, setTemplates] = useState<Map<string, string>>(new Map());

  // Reset active tab when result changes
  useEffect(() => {
    const ids = Array.from(result.featuresByLayer.keys());
    if (ids.length > 0 && !result.featuresByLayer.has(activeTab)) {
      setActiveTab(ids[0]);
    }
  }, [result, activeTab]);

  // Resolve templates for all layers in the result
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const resolved = new Map<string, string>();

      for (const configId of result.featuresByLayer.keys()) {
        const entry = layerEntries.find((e) => e.config.id === configId);
        if (!entry?.config.featureinfo) continue;

        const tmpl = await resolveTemplate(entry.config.featureinfo);
        if (tmpl && !cancelled) {
          resolved.set(configId, tmpl);
        }
      }

      if (!cancelled) setTemplates(resolved);
    }

    load();
    return () => { cancelled = true; };
  }, [result, layerEntries]);

  const features = result.featuresByLayer.get(activeTab) ?? [];
  const template = templates.get(activeTab);

  return (
    <div className="absolute top-2 right-2 z-30 max-w-sm max-h-[50vh] flex flex-col rounded-lg bg-white/90 shadow-md backdrop-blur-sm sm:top-4 sm:right-4">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Feature Info
        </h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 transition-colors text-sm leading-none px-1"
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      {/* Tabs — only if multiple layers */}
      {layerIds.length > 1 && (
        <div className="flex gap-0 border-b border-gray-200 px-3">
          {layerIds.map((id) => {
            const entry = layerEntries.find((e) => e.config.id === id);
            const name = entry?.config.name ?? id;
            const isActive = id === activeTab;
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`px-2 py-1 text-xs transition-colors ${
                  isActive
                    ? "border-b-2 border-blue-500 text-blue-600 font-medium"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}

      {/* Content — scrollable */}
      <div className="overflow-y-auto p-3 flex flex-col gap-2">
        {!template ? (
          <p className="text-xs text-gray-400">Loading template...</p>
        ) : features.length === 0 ? (
          <p className="text-xs text-gray-400">No features</p>
        ) : (
          features.map((feature, i) => (
            <div key={i}>
              {i > 0 && <hr className="border-gray-200 mb-2" />}
              {/* Templates are deployer-authored (same trust model as layers.json) */}
              <div
                className="text-sm text-gray-700 [&_b]:font-semibold [&_table]:w-full [&_td]:py-0.5 [&_td]:pr-2"
                dangerouslySetInnerHTML={{
                  __html: renderTemplate(template, feature.properties),
                }}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
