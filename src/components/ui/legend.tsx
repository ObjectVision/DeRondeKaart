import type { LayerEntry } from "@/hooks/use-map-layers";

interface LegendProps {
  entriesA: LayerEntry[];
  entriesB: LayerEntry[];
  hiddenIdsA: Set<string>;
  hiddenIdsB: Set<string>;
  onToggleA: (layerId: string) => void;
  onToggleB: (layerId: string) => void;
  comparisonMode: boolean;
}

function colorToCSS(
  color?: [number, number, number] | [number, number, number, number],
): string {
  if (!color) return "rgb(0, 128, 255)";
  const [r, g, b, a] = color;
  return a !== undefined
    ? `rgba(${r}, ${g}, ${b}, ${a / 255})`
    : `rgb(${r}, ${g}, ${b})`;
}

function LayerList({
  label,
  entries,
  hiddenIds,
  onToggle,
}: {
  label?: string;
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  onToggle: (layerId: string) => void;
}) {
  if (entries.length === 0) return null;

  return (
    <div>
      {label && (
        <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
          {label}
        </h4>
      )}
      <ul className="flex flex-col gap-1">
        {entries.map(({ config }) => {
          const isVisible = !hiddenIds.has(config.id);
          return (
            <li key={config.id}>
              <button
                onClick={() => onToggle(config.id)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-gray-100 transition-colors"
              >
                <span
                  className="inline-block h-3 w-3 rounded-sm border border-gray-300 flex-shrink-0"
                  style={{
                    backgroundColor: isVisible
                      ? colorToCSS(config.style.color)
                      : "transparent",
                  }}
                />
                <span
                  className={
                    isVisible ? "text-gray-800" : "text-gray-400 line-through"
                  }
                >
                  {config.name}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Legend({
  entriesA,
  entriesB,
  hiddenIdsA,
  hiddenIdsB,
  onToggleA,
  onToggleB,
  comparisonMode,
}: LegendProps) {
  if (entriesA.length === 0 && entriesB.length === 0) return null;

  return (
    <div className="absolute bottom-2 left-2 z-30 max-h-[50vh] overflow-y-auto rounded-lg bg-white/90 p-2 shadow-md backdrop-blur-sm sm:bottom-4 sm:left-4 sm:p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Layers
      </h3>
      {comparisonMode ? (
        <div className="flex flex-col gap-2">
          <LayerList
            label="Map A"
            entries={entriesA}
            hiddenIds={hiddenIdsA}
            onToggle={onToggleA}
          />
          <LayerList
            label="Map B"
            entries={entriesB}
            hiddenIds={hiddenIdsB}
            onToggle={onToggleB}
          />
        </div>
      ) : (
        <LayerList
          entries={entriesA}
          hiddenIds={hiddenIdsA}
          onToggle={onToggleA}
        />
      )}
    </div>
  );
}
