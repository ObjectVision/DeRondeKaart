import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";

import { Button } from "@/components/ui/button";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PrintLayout } from "@/components/dashboard/PrintLayout";
import { loadChartsConfig } from "@/layers/charts";
import { parameters, selection } from "@/dashboard/dashboard-state";
import {
  loadExportLayout,
  loadStandaloneLayout,
  type DashboardExportLayout,
  type DashboardLayout,
} from "@/dashboard/layout-config";
import { useDashboardBridge } from "@/dashboard/postmessage-bridge";
import type { QueryFilter } from "@/dashboard/query-builder";
import { resolveWidgets, type ResolvedWidget } from "@/dashboard/resolve-widgets";
import {
  loadSemanticModel,
  withTableUrls,
  type SemanticModel,
} from "@/dashboard/semantic-model";
import type { DuckDbEngine } from "@/dashboard/duckdb-engine";

/**
 * The standalone dashboard: `?mode=dashboard` on a project whose map.json
 * allows it. No MapView is mounted, so MapLibre and the tile stack never load.
 *
 * DuckDB is pulled in with `await import()` from here — this module is itself
 * only imported dynamically by `main.tsx`, so a map-only visitor downloads
 * neither. See plans/dashboard-capabilities.md §4 for the rules that keep it
 * that way.
 */
export function DashboardApp(): JSX.Element {
  const [layout, setLayout] = createSignal<DashboardLayout | null>(null);
  const [exportLayout, setExportLayout] = createSignal<DashboardExportLayout | null>(null);
  const [widgets, setWidgets] = createSignal<ResolvedWidget[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  // Held across re-queries: the engine is expensive to build and the model is
  // what `dashboard-reload` rewrites.
  let engine: DuckDbEngine | null = null;
  let model: SemanticModel | null = null;
  let reloadEpoch = 0;
  const [epoch, setEpoch] = createSignal(0);

  /**
   * Load everything the page needs and answer every widget.
   *
   * Re-runs whenever the host changes the selection or parameters, and whenever
   * a reload re-points the tables; the engine and the parsed configs are reused
   * across runs because only the filters changed.
   */
  createEffect(() => {
    // Read the reactive inputs first, so this effect subscribes to all of them
    // even on the run that bails out early.
    const currentSelection = selection();
    const currentParameters = parameters();
    epoch();

    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    void (async () => {
      setLoading(true);
      try {
        const [loadedModel, screenLayout, printLayout, charts] = await Promise.all([
          model ? Promise.resolve(model) : loadSemanticModel(),
          loadStandaloneLayout(),
          loadExportLayout(),
          loadChartsConfig(),
        ]);
        if (cancelled) return;
        const firstRun = model === null;
        model = loadedModel;
        setLayout(screenLayout);
        setExportLayout(printLayout);

        if (!engine || firstRun) {
          // The one place DuckDB enters the graph.
          const duckdb = await import("@/dashboard/duckdb-engine");
          if (cancelled) return;
          engine ??= await duckdb.ensureDuckDb();
          await duckdb.registerTables(engine, loadedModel);
        }
        if (cancelled || !engine) return;

        const filters: QueryFilter[] = [];
        if (currentSelection) {
          filters.push({
            kind: "area",
            column: currentSelection.column,
            codes: currentSelection.codes,
          });
        }
        for (const [column, value] of Object.entries(currentParameters)) {
          filters.push({ kind: "value", column, values: [value] });
        }

        const resolved = await resolveWidgets(screenLayout.widgets, {
          engine,
          model: loadedModel,
          charts,
          filters,
        });
        if (cancelled) return;
        setWidgets(resolved);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // Surfaced rather than only logged: a dashboard that silently shows
        // nothing is indistinguishable from one that has no data.
        console.error("Kon het dashboard niet laden", err);
        setError("Kon het dashboard niet laden.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
  });

  useDashboardBridge({
    ready: () => !loading(),
    onReloadTables: (urls) => {
      if (!model) return;
      model = withTableUrls(model, urls);
      // Re-registering the views is part of the next run's setup.
      engine = null;
      reloadEpoch += 1;
      setEpoch(reloadEpoch);
    },
  });

  return (
    <div class="min-h-screen bg-gray-50 p-4">
      <div class="dashboard-screen mx-auto max-w-6xl">
        <div class="mb-4 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <Show when={layout()?.title}>
              {(title) => <h1 class="text-xl font-bold text-gray-900">{title()}</h1>}
            </Show>
            <Show when={layout()?.subtitle}>
              {(subtitle) => <p class="text-sm text-gray-600">{subtitle()}</p>}
            </Show>
          </div>
          <Button variant="ghost" onClick={() => window.print()} title="Exporteren als PDF">
            Exporteren
          </Button>
        </div>

        <Show
          when={!loading()}
          fallback={<p class="text-sm text-gray-500">Gegevens worden geladen…</p>}
        >
          <Show
            when={!error()}
            fallback={<p class="text-sm text-red-600">{error()}</p>}
          >
            <Show
              when={widgets().length > 0}
              fallback={
                <p class="text-sm text-gray-500">
                  Dit dashboard heeft nog geen weergaven. Vul dashboard_standalone.json.
                </p>
              }
            >
              <DashboardGrid columns={layout()?.columns ?? 2} widgets={widgets()} />
            </Show>
          </Show>
        </Show>
      </div>

      <Show when={exportLayout()}>
        {(print) => <PrintLayout layout={print()} widgets={widgets()} />}
      </Show>
    </div>
  );
}
