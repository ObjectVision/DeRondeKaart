import { For, Match, Show, Switch, type JSX } from "solid-js";

import { ChartCard } from "@/components/charts/ChartCard";
import { StatCard } from "@/components/charts/StatCard";
import type { ResolvedWidget } from "@/dashboard/resolve-widgets";

interface DashboardGridProps {
  columns: number;
  widgets: ResolvedWidget[];
}

type WidgetOf<K extends ResolvedWidget["kind"]> = Extract<ResolvedWidget, { kind: K }>;

/**
 * Narrowing helpers: `<Match when={…}>` passes its truthy value on as an
 * accessor, so returning the widget itself (or undefined) is what gives the
 * child a typed member of the union without a cast.
 */
function asKind<K extends ResolvedWidget["kind"]>(
  widget: ResolvedWidget,
  kind: K,
): WidgetOf<K> | undefined {
  return widget.kind === kind ? (widget as WidgetOf<K>) : undefined;
}

/**
 * The widget grid, shared by the screen view and the print view.
 *
 * Tiles are the analytics panel's own `ChartCard` / `StatCard`, so a dashboard
 * chart and a map-panel chart of the same measure render identically.
 */
export function DashboardGrid(props: DashboardGridProps): JSX.Element {
  return (
    <div
      class="grid gap-3"
      style={{ "grid-template-columns": `repeat(${props.columns}, minmax(0, 1fr))` }}
    >
      <For each={props.widgets}>
        {(widget) => (
          <div style={{ "grid-column": `span ${Math.min(widget.span, props.columns)}` }}>
            <Switch>
              <Match when={asKind(widget, "chart")}>
                {(chartWidget) => <ChartCard chart={chartWidget().chart} />}
              </Match>
              <Match when={asKind(widget, "statistic")}>
                {(statWidget) => <StatCard stat={statWidget().stat} />}
              </Match>
              <Match when={asKind(widget, "text")}>
                {(textWidget) => (
                  <div class="rounded-xl border border-gray-200 bg-white p-2.5">
                    <Show when={textWidget().title}>
                      {(title) => (
                        <h4 class="mb-1 text-xs font-semibold text-gray-700">{title()}</h4>
                      )}
                    </Show>
                    <p class="text-sm text-gray-600">{textWidget().body}</p>
                  </div>
                )}
              </Match>
              <Match when={asKind(widget, "unavailable")}>
                <div class="flex h-24 items-center justify-center rounded-xl border border-dashed border-gray-200 px-2 text-center text-xs text-gray-400">
                  Deze weergave is niet beschikbaar
                </div>
              </Match>
            </Switch>
          </div>
        )}
      </For>
    </div>
  );
}
