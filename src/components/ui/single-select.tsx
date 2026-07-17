import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/nav-icon";

export interface SingleSelectOption {
  code: string;
  label: string;
}

/**
 * Hand-rolled single-selection combobox: a trigger styled like an input that
 * expands into a searchable popover. Only one option can be selected at a time
 * (radio-button rows); picking one replaces the previous choice and closes the
 * popover. The "Alle …" row (or the trigger's clear button) clears the level.
 * Closes on outside click or Escape. `disabled` (a cascading dependency isn't
 * set yet) makes the trigger un-openable.
 */
export function SingleSelect({
  placeholder,
  options,
  selectedCode,
  onSelect,
  disabled = false,
}: {
  placeholder: string;
  options: SingleSelectOption[];
  selectedCode: string | null;
  onSelect: (code: string | null) => void;
  disabled?: boolean;
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

  const selectedLabel =
    selectedCode !== null
      ? (options.find((o) => o.code === selectedCode)?.label ?? selectedCode)
      : null;

  function choose(code: string | null) {
    onSelect(code);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setQuery(""); // fresh search each time the popover opens
          setOpen((v) => !v);
        }}
        className="flex w-full items-center justify-between gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-left text-sm transition-colors hover:border-gray-300 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 disabled:hover:border-gray-200 enabled:cursor-pointer"
      >
        {selectedLabel === null ? (
          <span className="truncate text-gray-400">{placeholder}</span>
        ) : (
          <span className="truncate text-gray-800" title={selectedLabel}>
            {selectedLabel}
          </span>
        )}
        <span className="flex flex-shrink-0 items-center gap-0.5">
          {selectedLabel !== null && !disabled && (
            <span
              role="button"
              title="Selectie wissen"
              className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(null);
              }}
            >
              <Icon name="close" size={16} />
            </span>
          )}
          <Icon name="expand_more" size={18} className="text-gray-400" />
        </span>
      </button>

      {open && !disabled && (
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
          {/* "Alle …" clears the level; hidden while searching to keep results clean. */}
          {!q && (
            <OptionRow
              label={placeholder}
              checked={selectedCode === null}
              muted
              onSelect={() => choose(null)}
            />
          )}
          {filtered.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-gray-400">Geen resultaten</div>
          )}
          {filtered.map((option) => (
            <OptionRow
              key={option.code}
              label={option.label}
              checked={selectedCode === option.code}
              onSelect={() => choose(option.code)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OptionRow({
  label,
  checked,
  onSelect,
  muted = false,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className="flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-gray-100"
    >
      <Icon
        name={checked ? "radio_button_checked" : "radio_button_unchecked"}
        size={18}
        className={checked ? "flex-shrink-0 text-blue-600" : "flex-shrink-0 text-gray-400"}
      />
      <span className={`truncate ${muted && !checked ? "text-gray-400" : "text-gray-700"}`}>
        {label}
      </span>
    </button>
  );
}
