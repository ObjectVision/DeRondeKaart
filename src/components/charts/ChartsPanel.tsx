import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { useChartData } from "@/hooks/use-chart-data";
import type { LayerConfig } from "@/layers/types";
import { ChartCard } from "./ChartCard";
import { StatCard } from "./StatCard";

/**
 * "Analyse & statistieken" panel, docked on the right side of the map. Opened
 * by selecting a chart-configured layer in the legend; all charts and
 * kerncijfers aggregate only the rows passing the current area filter.
 * In comparison mode it overlays the right map by design (the panel is
 * closeable and the slider stays usable left of it).
 */
export function ChartsPanel({
  config,
  version,
  onClose,
}: {
  config: LayerConfig;
  version: number;
  onClose: () => void;
}) {
  const { charts, stats, loading } = useChartData(config, version);

  return (
    <div className="absolute bottom-2 right-2 top-2 z-30 w-[min(30rem,90vw)] sm:bottom-4 sm:right-4 sm:top-4">
      <div className="flex h-full flex-col gap-3 overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Analyse &amp; statistieken
            </h3>
            <p className="truncate text-sm text-gray-600">
              Geselecteerde thema:{" "}
              <span className="font-semibold text-orange-500">{config.name}</span>
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="flex-shrink-0 cursor-pointer"
            onClick={onClose}
            title="Sluiten"
          >
            <Icon name="close" size={18} className="text-gray-500" />
          </Button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
            Laden…
          </div>
        ) : (
          <>
            {charts.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-1 gap-2 min-[1400px]:grid-cols-2">
                  {charts.map((chart) => (
                    <ChartCard key={chart.config.id} chart={chart} />
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-gray-400">
                    Maximaal 4 charts per laag
                  </span>
                  <Button variant="outline" size="sm" disabled>
                    + Chart toevoegen
                  </Button>
                </div>
              </div>
            )}

            {stats.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Kerncijfers <span className="normal-case">(binnen huidige filter)</span>
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {stats.map((stat) => (
                    <StatCard key={`${stat.config.field}-${stat.config.stat}`} stat={stat} />
                  ))}
                </div>
              </div>
            )}

            <div className="mt-auto flex items-start gap-2 rounded-lg bg-blue-50 p-2 text-xs text-[#00498D]">
              <Icon name="info" size={16} className="mt-px flex-shrink-0" />
              <span>
                Alle kaarten, grafieken en cijfers worden automatisch gefilterd op basis
                van uw selectie.
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
