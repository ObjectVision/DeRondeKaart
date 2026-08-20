import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";

import { Button } from "@/components/ui/button";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";
import { loadChartsConfig } from "@/layers/charts";
import { compareSelections, compareSlotColor } from "@/layers/compare-slots";
import type { ComplementaryConfig } from "@/dashboard/complementary-config";
import { loadSemanticModel } from "@/dashboard/semantic-model";
import { resolveWidgets, type ResolvedWidget } from "@/dashboard/resolve-widgets";
import type { QueryFilter } from "@/dashboard/query-builder";
import type { DuckDbEngine } from "@/dashboard/duckdb-engine";

interface ComparePanelProps {
  config: ComplementaryConfig;
  /** Code column of the level the selections were made at. */
  codeColumn: string;
  onClose: () => void;
  onRemove: (slot: number) => void;
}

/**
 * The "meer informatie" comparison: one column per selected area, each rendered
 * with the same widget grid the standalone dashboard uses.
 *
 * Mounted only while open, so the engine import below happens on the user's
 * first click and never during an ordinary map session.
 */
export function ComparePanel(props: ComparePanelProps): JSX.Element {
  const [columns, setColumns] = createSignal<Array<{ label: string; slot: number; widgets: ResolvedWidget[] }>>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  let engine: DuckDbEngine | null = null;

  createEffect(() => {
    // Read first, so the effect tracks the selection even on an early return.
    const selections = compareSelections();
    const codeColumn = props.codeColumn;
    const widgets = props.config.widgets;

    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    void (async () => {
      setLoading(true);
      try {
        const [model, charts] = await Promise.all([loadSemanticModel(), loadChartsConfig()]);
        if (cancelled) return;

        if (!engine) {
          // The one place the map application touches DuckDB — an await import
          // inside a handler-driven panel, so the map bundle never carries it.
          const duckdb = await import("@/dashboard/duckdb-engine");
          if (cancelled) return;
          engine = await duckdb.ensureDuckDb();
          await duckdb.registerTables(engine, model);
        }
        if (cancelled || !engine) return;

        const resolved: Array<{ label: string; slot: number; widgets: ResolvedWidget[] }> = [];
        for (const selection of selections) {
          const filters: QueryFilter[] = [
            { kind: "area", column: codeColumn, codes: [selection.code] },
          ];
          resolved.push({
            label: selection.label,
            slot: selection.slot,
            widgets: await resolveWidgets(widgets, { engine, model, charts, filters }),
          });
          if (cancelled) return;
        }
        setColumns(resolved);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        console.error("Kon de vergelijking niet laden", err);
        setError("Kon de vergelijking niet laden.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
  });

  return (
    <div class="pointer-events-auto max-h-[60vh] overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Gebieden vergelijken
        </h3>
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

      <Show
        when={!loading()}
        fallback={<p class="text-sm text-gray-500">Gegevens worden geladen…</p>}
      >
        <Show when={!error()} fallback={<p class="text-sm text-red-600">{error()}</p>}>
          <Show
            when={columns().length > 0}
            fallback={
              <p class="text-sm text-gray-500">
                Klik een gebied op de kaart aan om het te vergelijken.
              </p>
            }
          >
            <div
              class="grid gap-3"
              style={{
                "grid-template-columns": `repeat(${columns().length}, minmax(0, 1fr))`,
              }}
            >
              <For each={columns()}>
                {(column) => (
                  <div class="min-w-0">
                    <div class="mb-2 flex items-center gap-1.5">
                      <span
                        class="inline-block h-3 w-3 flex-shrink-0 rounded-sm"
                        style={{ "background-color": compareSlotColor(column.slot) }}
                      />
                      <span class="min-w-0 truncate text-sm font-semibold text-gray-900">
                        {column.label}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => props.onRemove(column.slot)}
                        title="Uit vergelijking halen"
                        aria-label={`${column.label} uit vergelijking halen`}
                      >
                        <Icon name="close" size={16} class="text-gray-400" />
                      </Button>
                    </div>
                    <DashboardGrid columns={1} widgets={column.widgets} />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
