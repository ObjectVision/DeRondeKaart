import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  type JSX,
} from "solid-js";
import { DialogContent, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { TabStrip, type Tab } from "@/components/ui/tab-strip";
import { StreetView } from "@/components/ui/street-view";
import { FeatureInfo } from "@/components/ui/feature-info";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";
import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";
import type { LngLat } from "@/hooks/use-click-popup";
import { findLocationInfoPick, withoutLayer } from "@/lib/location-info";
import { resolveTemplate } from "@/layers/featureinfo-template";
import { fetchParquetRow } from "@/layers/parquet-row";
import {
  RESERVED_TAB_ID,
  formatValue,
  renderLocationInfo,
  type RenderedLocationInfo,
} from "@/layers/location-info-template";

export interface LocationInfoDialogProps {
  /** The pick; must contain a `locationinfo` layer (see findLocationInfoPick). */
  result: FeatureInfoResult;
  layerEntries: LayerEntry[];
  /** Where to show Street View, or null when the project has it switched off. */
  streetView: LngLat | null;
  onClose: () => void;
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; rendered: RenderedLocationInfo };

const ERROR_TEXT = "Locatie-informatie kon niet worden geladen";
const EMPTY_TEXT = "Geen locatie-informatie voor deze locatie";

/**
 * "Locatie informatie": the window a click opens when it hits a layer whose
 * featureinfo is `locationinfo`. The feature names one parquet row, which fills
 * the project's template (see location-info-template.ts): a general block beside
 * Street View, then the template's tabs. Whatever else the click hit is shown in
 * an extra "Kaartlagen" tab, with those layers' own templates.
 *
 * The same modal shell as the metainfo window, rather than the draggable Details
 * popup: it is wide, holds tabs, and is read rather than glanced at.
 */
export function LocationInfoDialog(props: LocationInfoDialogProps): JSX.Element {
  const pick = createMemo(() => findLocationInfoPick(props.result, props.layerEntries));
  const others = createMemo(() => {
    const p = pick();
    return p ? withoutLayer(props.result, p.layerId) : null;
  });

  const [state, setState] = createSignal<State>({ status: "loading" });

  createEffect(() => {
    // Read every input before returning early: an effect subscribes only to
    // what its last run read.
    const p = pick();
    if (!p) {
      setState({ status: "error", message: EMPTY_TEXT });
      return;
    }

    const row = Number(p.feature.properties[p.config.rowField ?? "row"]);
    if (!Number.isInteger(row) || row < 0) {
      console.warn(`locatie-informatie: feature of "${p.layerId}" has no valid row index`);
      setState({ status: "error", message: EMPTY_TEXT });
      return;
    }

    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    setState({ status: "loading" });

    void (async () => {
      try {
        const [template, data] = await Promise.all([
          resolveTemplate({ templateUrl: p.config.templateUrl }),
          fetchParquetRow(p.config.source, row),
        ]);
        if (cancelled) return;
        if (!template || !data) {
          setState({ status: "error", message: template ? EMPTY_TEXT : ERROR_TEXT });
          return;
        }
        const key = p.config.keyField;
        if (key && String(data[key]) !== String(p.feature.properties[key])) {
          console.warn(
            `locatie-informatie: row ${row} of ${p.config.source} has ${key}=${String(data[key])}, ` +
              `the clicked feature ${String(p.feature.properties[key])} — tiles and parquet are out of step`,
          );
          setState({ status: "error", message: ERROR_TEXT });
          return;
        }
        setState({ status: "ok", rendered: renderLocationInfo(template, data) });
      } catch (err) {
        if (cancelled) return;
        console.warn("locatie-informatie: loading failed", err);
        setState({ status: "error", message: ERROR_TEXT });
      }
    })();
  });

  const rendered = () => {
    const s = state();
    return s.status === "ok" ? s.rendered : null;
  };

  const tabs = createMemo<Tab[]>(() => {
    const list: Tab[] = (rendered()?.tabs ?? []).map(({ id, label, icon }) => ({ id, label, icon }));
    if (others()) list.push({ id: RESERVED_TAB_ID, label: "Kaartlagen", icon: "layers" });
    return list;
  });

  // Null = "whichever is first", as in LeafMeta: a pure derivation, so a tab
  // list that grows once the row arrives needs no reset.
  const [picked, setPicked] = createSignal<string | null>(null);
  const active = () => {
    const list = tabs();
    return list.find((t) => t.id === picked())?.id ?? list[0]?.id ?? "";
  };
  const panelId = createUniqueId();

  function selectTab(id: string, from: HTMLElement) {
    setPicked(id);
    const win = from.closest('[role="dialog"]');
    if (win) win.scrollTop = 0;
  }

  const activeHtml = () => rendered()?.tabs.find((t) => t.id === active())?.html ?? "";

  /** Accessible name: the window plus the postcode, when the feature has one. */
  const postcode = () => {
    const p = pick();
    const key = p?.config.keyField;
    return key && p ? formatValue(p.feature.properties[key], "postcode") : "";
  };

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent class="w-[min(68rem,calc(100vw-2rem))]">
        <div class="mb-3 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <img src="/favicon.svg" alt="" aria-hidden draggable={false} class="h-6 w-6 shrink-0" />
            <DialogTitle class="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Locatie informatie
              <Show when={postcode()}>
                <span class="absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0,0,0,0)]">
                  : {postcode()}
                </span>
              </Show>
            </DialogTitle>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => props.onClose()}
            title="Sluiten"
            aria-label="Sluiten"
          >
            <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        </div>

        {/* General block beside Street View; stacked on narrow screens. */}
        <div class="mb-3 rounded-2xl border border-gray-200 bg-white p-3">
          <div class="flex flex-col items-stretch justify-between gap-4 sm:flex-row">
            <div
              class={`w-full rounded-xl border border-gray-100 bg-gray-50 p-3 text-sm text-gray-600 ${
                props.streetView ? "sm:w-[30%]" : ""
              }`}
            >
              <Show
                when={rendered()}
                fallback={
                  <p class={state().status === "error" ? "text-red-600" : "text-gray-400"}>
                    {(() => {
                      const s = state();
                      return s.status === "error" ? s.message : "Laden…";
                    })()}
                  </p>
                }
              >
                {(r) => (
                  // Published by whoever deploys the config, like layers.json;
                  // field values in it are escaped by renderLocationInfo.
                  // eslint-disable-next-line solid/no-innerhtml
                  <div innerHTML={r().general ?? ""} />
                )}
              </Show>
            </div>
            <Show when={props.streetView}>
              {(sv) => (
                // Grid, not flex: StreetView's root holds only absolutely
                // positioned content, so as a flex item it shrinks to zero width
                // and the panorama renders into nothing. A grid item stretches
                // to the cell in both directions.
                <div class="relative grid min-h-48 w-full overflow-hidden rounded-[2px] bg-[#e5e3df] shadow-[0_15px_35px_rgba(0,0,0,0.25),0_5px_15px_rgba(0,0,0,0.2)] sm:w-[70%]">
                  <StreetView
                    lng={sv().lng}
                    lat={sv().lat}
                    embedded
                    bodyClass="relative h-full min-h-48 w-full flex-1 overflow-hidden"
                  />
                </div>
              )}
            </Show>
          </div>
        </div>

        <Show when={tabs().length > 0}>
          <TabStrip
            tabs={tabs()}
            active={active()}
            onSelect={selectTab}
            panelId={panelId}
            class="-mx-6 mb-3 flex gap-0 border-b border-gray-200 px-6"
          />
          <div id={panelId} role="tabpanel" class="text-sm text-gray-600 [&_a]:text-blue-600 [&_a]:underline">
            <Show
              when={active() === RESERVED_TAB_ID ? others() : null}
              fallback={
                // eslint-disable-next-line solid/no-innerhtml
                <div class="space-y-4" innerHTML={activeHtml()} />
              }
            >
              {(rest) => <FeatureInfo result={rest()} layerEntries={props.layerEntries} embedded />}
            </Show>
          </div>
        </Show>

        <Show when={rendered()?.footer}>
          {(footer) => (
            // eslint-disable-next-line solid/no-innerhtml
            <div class="mt-2 text-sm italic text-gray-600" innerHTML={footer()} />
          )}
        </Show>
      </DialogContent>
    </DialogRoot>
  );
}
