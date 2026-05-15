interface MapPillsProps {
  activeA: boolean;
  activeB: boolean;
}

const PILL_BASE =
  "px-3 py-1 rounded-full text-xs font-semibold tracking-wide shadow-sm transition-opacity duration-200";

export function MapPills({ activeA, activeB }: MapPillsProps) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-3 left-3 right-3 z-30 flex justify-between"
    >
      <span
        data-active={activeA}
        className={`${PILL_BASE} border-[1.5px] border-[#3b7dd8] bg-white text-[#3b7dd8] ${
          activeA ? "opacity-100" : "opacity-40"
        }`}
      >
        Kaart A
      </span>
      <span
        data-active={activeB}
        className={`${PILL_BASE} bg-[#2f9a52] text-white ${
          activeB ? "opacity-100" : "opacity-40"
        }`}
      >
        Kaart B
      </span>
    </div>
  );
}
