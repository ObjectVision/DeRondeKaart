import { useState, useEffect } from "react";
import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";
import { resolveTemplate, renderTemplate } from "@/layers";
import { buurtCodeOf, pblSummaryUrl } from "@/lib/pbl-summary";

interface PblSummaryProps {
  /** Null when the clicked feature carries no usable `bu_code`. */
  buurtCode: string | null;
}

/**
 * PBL's "Samenvatting Startanalyse" for one neighbourhood, embedded from our own
 * origin (see public/pbl-samenvatting.html for why it is not framed directly).
 */
function PblSummary({ buurtCode }: PblSummaryProps): React.JSX.Element {
  if (!buurtCode) {
    // The layer is configured for the summary but this feature has no code —
    // say so rather than showing an empty frame.
    return (
      <p className="text-xs text-gray-400">
        Geen buurtcode beschikbaar voor deze locatie.
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-col">
      {/* PBL's content is a fixed 750px wide and grows to whatever height it is
          given, so the frame fills the window and the window is sized to match —
          no inner scrollbar, no empty margins. */}
      <iframe
        src={pblSummaryUrl(buurtCode)}
        title="Samenvatting Startanalyse"
        className="h-[78vh] w-full border-0"
        loading="lazy"
      />
      <a
        href={pblSummaryUrl(buurtCode)}
        target="_blank"
        rel="noreferrer"
        className="px-3 py-1 text-right text-xs text-blue-600 underline"
      >
        Openen in nieuw tabblad
      </a>
    </div>
  );
}

interface FeatureInfoProps {
  result: FeatureInfoResult;
  layerEntries: LayerEntry[];
  onClose?: () => void;
  /** Render bare content (no card chrome/header) inside a parent window. */
  embedded?: boolean;
}

export function FeatureInfo({
  result,
  layerEntries,
  onClose,
  embedded = false,
}: FeatureInfoProps): React.JSX.Element {
  const layerIds = Array.from(result.featuresByLayer.keys());
  const [selectedTab, setSelectedTab] = useState(layerIds[0]);
  const [templates, setTemplates] = useState<Map<string, string>>(new Map());

  // Derived, not synced through an effect: when a new pick result no longer
  // contains the selected tab, fall back to the first one during THIS render
  // instead of rendering an empty tab and correcting it in a second pass.
  const activeTab =
    result.featuresByLayer.has(selectedTab) || layerIds.length === 0
      ? selectedTab
      : layerIds[0];

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

  // A layer answers a click EITHER with PBL's neighbourhood summary or with its
  // own template — never both (see FeatureInfoConfig.pbl). Resolved here rather
  // than per feature: the mode belongs to the layer, and the popup shows one
  // layer at a time.
  const activeEntry = layerEntries.find((entry) => entry.config.id === activeTab);
  const pblMode = activeEntry?.config.featureinfo?.pbl === true;
  const buurtCode = pblMode ? buurtCodeOf(features[0]) : null;

  return (
    <div
      className={
        embedded
          ? "flex min-h-0 flex-col"
          : "max-w-sm max-h-[50vh] flex flex-col rounded-lg bg-white/90 shadow-md backdrop-blur-sm"
      }
    >
      {/* Header — omitted when embedded; the parent window owns the close button */}
      {!embedded && (
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Details
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors text-sm leading-none px-1"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
      )}

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
                onClick={() => setSelectedTab(id)}
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

      {/* Content — scrollable. `app-scrollbar` lands on the element that owns the
          overflow, matching the navigation and legend cards' scrollbar.
          The PBL viewer brings its own layout and sizes itself, so it gets no
          padding and no scrolling here: the window is built around it. */}
      <div
        className={
          pblMode
            ? "flex min-h-0 flex-col"
            : "app-scrollbar overflow-y-auto p-3 flex flex-col gap-2"
        }
      >
        {pblMode ? (
          <PblSummary buurtCode={buurtCode} />
        ) : !template ? (
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
