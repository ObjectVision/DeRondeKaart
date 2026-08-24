import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import { Icon } from "@/components/ui/nav-icon";
import { variantId } from "@/config/variant";
import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";
import { resolveTemplate, renderTemplate } from "@/layers";
import { DOWNLOADS, downloadUrl } from "@/lib/downloads";
import { buurtCodeOf, createPblSummaryStatus, pblSummaryUrl } from "@/lib/pbl-summary";

interface PblSummaryProps {
  /** Null when the clicked feature carries no usable `bu_code`. */
  buurtCode: string | null;
}

/**
 * PBL's "Samenvatting Startanalyse" for one neighbourhood, embedded from our own
 * origin (see public/pbl-samenvatting.html for why it is not framed directly).
 */
function PblSummary(props: PblSummaryProps): JSX.Element {
  const status = createPblSummaryStatus(() => props.buurtCode);

  return (
    <Show
      when={props.buurtCode}
      fallback={
        // The layer is configured for the summary but this feature has no code —
        // say so rather than showing an empty frame.
        <p class="text-xs text-gray-400">Geen buurtcode beschikbaar voor deze locatie.</p>
      }
    >
      {(code) => (
        <div class="flex min-h-0 flex-col">
          {/* PBL's content is a fixed 750px wide and grows to whatever height it is
              given, so the frame fills the window and the window is sized to match —
              no inner scrollbar, no empty margins.

              The splash sits over the frame rather than replacing it, so the
              frame keeps loading underneath and the popup never changes height:
              InfoPopup re-places itself on every resize, so a placeholder that
              grew or shrank would make the window jump when it went away. */}
          <div class="relative h-[78vh] w-full">
            <iframe
              src={pblSummaryUrl(code())}
              title="Samenvatting Startanalyse"
              class="h-full w-full border-0"
            />
            <Show when={status() === "loading"}>
              {/* The app's own mark, matching the boot splash. /logo.svg is
                  preloaded in index.html, so it is warm in cache and paints at
                  once — a splash that itself flickered would defeat the point.
                  `pointer-events-none` keeps it purely visual; it covers the
                  frame only while there is nothing there to click. */}
              <div
                class="pointer-events-none absolute inset-0 flex items-center justify-center bg-white"
                role="status"
                aria-label="Samenvatting wordt geladen"
              >
                <img src="/logo.svg" alt="" class="w-[min(60%,320px)]" draggable={false} />
              </div>
            </Show>
          </div>
          {/* Outside the frame wrapper, so the splash never covers the way out. */}
          <a
            href={pblSummaryUrl(code())}
            target="_blank"
            rel="noreferrer"
            class="px-3 py-1 text-right text-xs text-blue-600 underline"
          >
            Openen in nieuw tabblad
          </a>
          <DownloadsSection />
        </div>
      )}
    </Show>
  );
}

/**
 * The dataset archives for the active variant, one flag per strategy.
 *
 * Whole-country files, so they do not depend on the clicked neighbourhood — the
 * section is the same for every feature and its height never changes, which is
 * what keeps InfoPopup from re-placing the window under the cursor.
 *
 * Rendered only where a variant is active: the archives are published per year,
 * and a project without variants (woonzorglimburg) has nowhere to point.
 */
function DownloadsSection(): JSX.Element {
  return (
    <Show when={variantId()}>
      {(variant) => (
        <div class="border-t border-gray-200 px-3 py-2">
          <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Downloads
          </h3>
          <div class="flex flex-wrap items-center gap-2">
            <For each={DOWNLOADS}>
              {(item) => (
                <a
                  href={downloadUrl(variant(), item.file)}
                  // `_blank` is load-bearing, not a preference. The app is
                  // embedded in an iframe on startanalyse2026.nl, whose CSP is
                  // `default-src 'self'` with a frame-src naming only the map
                  // host — so navigating the frame itself to the data host is
                  // blocked ("This content is blocked"). A top-level navigation
                  // is not governed by the parent frame's policy.
                  target="_blank"
                  rel="noreferrer"
                  // Ignored cross-origin, so the save name comes from the data
                  // host's Content-Disposition. Kept as the hint it is.
                  download={item.file}
                  title={`${item.label} (ZIP)`}
                  aria-label={`${item.label} downloaden (ZIP)`}
                  class="rounded transition-opacity hover:opacity-70"
                >
                  <Icon name={item.icon} size={28} />
                </a>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
}

interface FeatureInfoProps {
  result: FeatureInfoResult;
  layerEntries: LayerEntry[];
  onClose?: () => void;
  /** Render bare content (no card chrome/header) inside a parent window. */
  embedded?: boolean;
}

export function FeatureInfo(props: FeatureInfoProps): JSX.Element {
  const layerIds = () => Array.from(props.result.featuresByLayer.keys());
  const [selectedTab, setSelectedTab] = createSignal(layerIds()[0]);
  const [templates, setTemplates] = createSignal<Map<string, string>>(new Map());

  // Derived, not synced through an effect: when a new pick result no longer
  // contains the selected tab, fall back to the first one immediately instead
  // of rendering an empty tab and correcting it afterwards.
  const activeTab = () => {
    const ids = layerIds();
    const selected = selectedTab();
    return props.result.featuresByLayer.has(selected) || ids.length === 0 ? selected : ids[0];
  };

  // Resolve templates for all layers in the result
  createEffect(() => {
    const result = props.result;
    const entries = props.layerEntries;
    let cancelled = false;

    async function load() {
      const resolved = new Map<string, string>();

      for (const configId of result.featuresByLayer.keys()) {
        const entry = entries.find((e) => e.config.id === configId);
        if (!entry?.config.featureinfo) continue;

        const tmpl = await resolveTemplate(entry.config.featureinfo);
        if (tmpl && !cancelled) {
          resolved.set(configId, tmpl);
        }
      }

      if (!cancelled) setTemplates(resolved);
    }

    load();
    onCleanup(() => {
      cancelled = true;
    });
  });

  const features = () => props.result.featuresByLayer.get(activeTab()) ?? [];
  const template = () => templates().get(activeTab());

  // A layer answers a click EITHER with PBL's neighbourhood summary or with its
  // own template — never both (see FeatureInfoConfig.pbl). Resolved here rather
  // than per feature: the mode belongs to the layer, and the popup shows one
  // layer at a time.
  const activeEntry = () => props.layerEntries.find((entry) => entry.config.id === activeTab());
  const pblMode = () => activeEntry()?.config.featureinfo?.pbl === true;
  const buurtCode = () => (pblMode() ? buurtCodeOf(features()[0]) : null);

  return (
    <div
      class={
        props.embedded
          ? "flex min-h-0 flex-col"
          : "max-w-sm max-h-[50vh] flex flex-col rounded-lg bg-white/90 shadow-md backdrop-blur-sm"
      }
    >
      {/* Header — omitted when embedded; the parent window owns the close button */}
      <Show when={!props.embedded}>
        <div class="flex items-center justify-between px-3 pt-2 pb-1">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Details</h3>
          <button
            onClick={() => props.onClose?.()}
            class="text-gray-400 hover:text-gray-600 transition-colors text-sm leading-none px-1"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
      </Show>

      {/* Tabs — only if multiple layers */}
      <Show when={layerIds().length > 1}>
        <div class="flex gap-0 border-b border-gray-200 px-3">
          <For each={layerIds()}>
            {(id) => {
              const name = () =>
                props.layerEntries.find((e) => e.config.id === id)?.config.name ?? id;
              const isActive = () => id === activeTab();
              return (
                <button
                  onClick={() => setSelectedTab(id)}
                  class={`px-2 py-1 text-xs transition-colors ${
                    isActive()
                      ? "border-b-2 border-blue-500 text-blue-600 font-medium"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {name()}
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Content — scrollable. `app-scrollbar` lands on the element that owns the
          overflow, matching the navigation and legend cards' scrollbar.
          The PBL viewer brings its own layout and sizes itself, so it gets no
          padding and no scrolling here: the window is built around it. */}
      <div
        class={
          pblMode()
            ? "flex min-h-0 flex-col"
            : "app-scrollbar overflow-y-auto p-3 flex flex-col gap-2"
        }
      >
        <Switch>
          <Match when={pblMode()}>
            <PblSummary buurtCode={buurtCode()} />
          </Match>
          <Match when={!template()}>
            <p class="text-xs text-gray-400">Loading template...</p>
          </Match>
          <Match when={features().length === 0}>
            <p class="text-xs text-gray-400">No features</p>
          </Match>
          <Match when={template()}>
            {(tmpl) => (
              <For each={features()}>
                {(feature, i) => (
                  <div>
                    <Show when={i() > 0}>
                      <hr class="border-gray-200 mb-2" />
                    </Show>
                    {/* Templates are deployer-authored (same trust model as layers.json) */}
                    <div
                      class="text-sm text-gray-700 [&_b]:font-semibold [&_table]:w-full [&_td]:py-0.5 [&_td]:pr-2"
                      // the template is
                      // an authored fragment from the app's own layers.json, not user input
                      // eslint-disable-next-line solid/no-innerhtml
                      innerHTML={renderTemplate(tmpl(), feature.properties)}
                    />
                  </div>
                )}
              </For>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
