import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/nav-icon";

export interface MultiSelectOption {
  code: string;
  label: string;
}

/**
 * Hand-rolled multi-select dropdown (trigger styled like an input + a
 * searchable checkbox-list popover), matching the app's other hand-rolled
 * popovers. Stays open while picking multiple values; closes on outside
 * click or Escape.
 */
export function MultiSelect({
  placeholder,
  options,
  selected,
  onToggle,
  onClear,
}: {
  placeholder: string;
  options: MultiSelectOption[];
  selected: Set<string>;
  onToggle: (code: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options),
    [options, q],
  );

  const selectedLabels = options.filter((o) => selected.has(o.code)).map((o) => o.label);
  const summary =
    selectedLabels.length <= 2
      ? selectedLabels.join(", ")
      : `${selectedLabels.slice(0, 2).join(", ")} +${selectedLabels.length - 2}`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm transition-colors hover:border-gray-300"
      >
        {selectedLabels.length === 0 ? (
          <span className="truncate text-gray-400">{placeholder}</span>
        ) : (
          <span className="truncate text-gray-800" title={selectedLabels.join(", ")}>
            {summary}
          </span>
        )}
        <span className="flex flex-shrink-0 items-center gap-0.5">
          {selectedLabels.length > 0 && (
            <span
              role="button"
              title="Selectie wissen"
              className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
            >
              <Icon name="close" size={16} />
            </span>
          )}
          <Icon name="expand_more" size={18} className="text-gray-400" />
        </span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-64 overflow-y-auto rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
          <div className="sticky top-0 bg-white/95 p-1 backdrop-blur-sm">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Zoeken…"
              className="w-full rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
            />
          </div>
          {filtered.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-gray-400">Geen resultaten</div>
          )}
          {filtered.map((option) => {
            const isSelected = selected.has(option.code);
            return (
              <button
                key={option.code}
                type="button"
                onClick={() => onToggle(option.code)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
              >
                <Icon
                  name={isSelected ? "check_box" : "check_box_outline_blank"}
                  size={18}
                  className={isSelected ? "flex-shrink-0 text-blue-600" : "flex-shrink-0 text-gray-400"}
                />
                <span className="truncate">{option.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
