import { For, Match, Show, Switch, type JSX } from "solid-js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { useChartData } from "@/hooks/use-chart-data";
import type { LayerConfig } from "@/layers/types";
import { ChartCard } from "./ChartCard";
import { StatCard } from "./StatCard";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";

interface ChartsPanelProps {
  config: LayerConfig;
  onClose: () => void;
  /** Whether the "Gebied selecteren" box-select tool is currently armed. */
  areaSelectActive: boolean;
  /** Arm/disarm the box-select tool (drag a rectangle to filter statistics). */
  onToggleAreaSelect: () => void;
}

/**
 * "Analyse & statistieken" panel, docked on the right side of the map. Opened
 * by selecting a chart-configured layer in the legend; all charts and
 * kerncijfers aggregate only the rows passing the current area filter.
 * In comparison mode it overlays the right map by design (the panel is
 * closeable and the slider stays usable left of it).
 *
 * No `memo` wrapper and no `version` prop: `useChartData` subscribes to the
 * filter stores itself, and only the nodes bound to changed values update.
 */
export function ChartsPanel(props: ChartsPanelProps): JSX.Element {
  const { charts, stats, unavailable, loading } = useChartData(() => props.config);

  return (
    <div class="absolute right-2 top-2 z-30 max-h-[calc(100%-1rem)] w-[min(30rem,90vw)] sm:right-4 sm:top-4 sm:max-h-[calc(100%-2rem)]">
      <div class="flex max-h-full flex-col gap-3 overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Analyse &amp; statistieken
            </h3>
            <p class="truncate text-sm text-gray-600">
              Geselecteerde thema:{" "}
              <span class="font-semibold text-orange-500">{props.config.name}</span>
            </p>
          </div>
          <div class="flex flex-shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              class="cursor-pointer"
              onClick={props.onToggleAreaSelect}
              title={
                props.areaSelectActive
                  ? "Gebiedselectie uitschakelen"
                  : "Gebied selecteren (sleep een rechthoek)"
              }
              aria-label="Gebied selecteren"
              aria-pressed={props.areaSelectActive}
            >
              <Icon
                name="select"
                size={chromeIconSize()}
                color={props.areaSelectActive ? chromeIconColor() : undefined}
                class={props.areaSelectActive ? undefined : "text-gray-400"}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="cursor-pointer"
              onClick={props.onClose}
              title="Sluiten"
            >
              <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
            </Button>
          </div>
        </div>

        <Switch>
          <Match when={loading()}>
            <div class="flex items-center justify-center py-10 text-sm text-gray-400">
              Laden…
            </div>
          </Match>
          {/* No attribute table could be loaded. Saying so beats a blank card —
              an unexplained empty panel is what let this go unnoticed after the
              layers moved to pmtiles. */}
          <Match when={unavailable()}>
            <div class="flex items-center justify-center py-10 text-center text-sm text-gray-400">
              Geen gegevens beschikbaar voor dit thema
            </div>
          </Match>
          <Match when={!loading() && !unavailable()}>
            <Show when={charts().length > 0}>
              <div class="flex flex-col gap-2">
                <For each={charts()}>{(chart) => <ChartCard chart={chart} />}</For>
              </div>
            </Show>

            <Show when={stats().length > 0}>
              <div class="flex flex-col gap-2">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Kerncijfers
                </h3>
                <div class="grid grid-cols-2 gap-2">
                  <For each={stats()}>{(stat) => <StatCard stat={stat} />}</For>
                </div>
              </div>
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
