import type { LayerEntry } from "@/components/map/MapView";

interface LegendProps {
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  onToggle: (layerId: string) => void;
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

export function Legend({ entries, hiddenIds, onToggle }: LegendProps) {
  if (entries.length === 0) return null;

  return (
    <div className="absolute bottom-4 left-4 z-10 rounded-lg bg-white/90 p-3 shadow-md backdrop-blur-sm">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Layers
      </h3>
      <ul className="flex flex-col gap-1.5">
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
