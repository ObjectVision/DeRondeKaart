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
    <div className="absolute right-2 top-2 z-30 max-h-[calc(100%-1rem)] w-[min(30rem,90vw)] sm:right-4 sm:top-4 sm:max-h-[calc(100%-2rem)]">
      <div className="flex max-h-full flex-col gap-3 overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
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
          <div className="flex items-center justify-center py-10 text-sm text-gray-400">
            Laden…
          </div>
        ) : (
          <>
            {charts.length > 0 && (
              <div className="flex flex-col gap-2">
                {charts.map((chart) => (
                  <ChartCard key={chart.config.id} chart={chart} />
                ))}
              </div>
            )}

            {stats.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Kerncijfers
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {stats.map((stat) => (
                    <StatCard key={`${stat.config.field}-${stat.config.stat}`} stat={stat} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
