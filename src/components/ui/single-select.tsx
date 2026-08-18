import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { Icon } from "@/components/ui/nav-icon";

export interface SingleSelectOption {
  code: string;
  label: string;
}

interface SingleSelectProps {
  placeholder: string;
  options: SingleSelectOption[];
  selectedCode: string | null;
  onSelect: (code: string | null) => void;
  disabled?: boolean;
}

/**
 * Hand-rolled single-selection combobox: a trigger styled like an input that
 * expands into a searchable popover. Only one option can be selected at a time
 * (radio-button rows); picking one replaces the previous choice and closes the
 * popover. The "Alle …" row (or the trigger's clear button) clears the level.
 * Closes on outside click or Escape. `disabled` (a cascading dependency isn't
 * set yet) makes the trigger un-openable.
 */
export function SingleSelect(props: SingleSelectProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let root!: HTMLDivElement;

  createEffect(() => {
    if (!open()) return;
    function onPointerDown(e: PointerEvent) {
      if (!root.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  const q = () => query().trim().toLowerCase();
  const filtered = createMemo(() => {
    const needle = q();
    return needle
      ? props.options.filter((o) => o.label.toLowerCase().includes(needle))
      : props.options;
  });

  const selectedLabel = () =>
    props.selectedCode !== null
      ? (props.options.find((o) => o.code === props.selectedCode)?.label ?? props.selectedCode)
      : null;

  function choose(code: string | null) {
    props.onSelect(code);
    setOpen(false);
  }

  return (
    <div ref={root} class="relative">
      <button
        type="button"
        aria-expanded={open()}
        disabled={props.disabled}
        onClick={() => {
          setQuery(""); // fresh search each time the popover opens
          setOpen((v) => !v);
        }}
        class="flex w-full items-center justify-between gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-left text-sm transition-colors hover:border-gray-300 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 disabled:hover:border-gray-200 enabled:cursor-pointer"
      >
        <Show
          when={selectedLabel()}
          fallback={<span class="truncate text-gray-400">{props.placeholder}</span>}
        >
          {(label) => (
            <span class="truncate text-gray-800" title={label()}>
              {label()}
            </span>
          )}
        </Show>
        <span class="flex flex-shrink-0 items-center gap-0.5">
          <Show when={selectedLabel() !== null && !props.disabled}>
            <span
              role="button"
              title="Selectie wissen"
              class="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              onClick={(e) => {
                e.stopPropagation();
                props.onSelect(null);
              }}
            >
              <Icon name="close" size={16} />
            </span>
          </Show>
          <Icon name="expand_more" size={18} class="text-gray-400" />
        </span>
      </button>

      <Show when={open() && !props.disabled}>
        <div class="absolute left-0 right-0 top-full z-40 mt-1 max-h-64 overflow-y-auto rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
          <div class="sticky top-0 bg-white/95 p-1 backdrop-blur-sm">
            <input
              type="text"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Zoeken…"
              class="w-full rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
            />
          </div>
          {/* "Alle …" clears the level; hidden while searching to keep results clean. */}
          <Show when={!q()}>
            <OptionRow
              label={props.placeholder}
              checked={props.selectedCode === null}
              muted
              onSelect={() => choose(null)}
            />
          </Show>
          <Show when={filtered().length === 0}>
            <div class="px-2 py-1.5 text-sm text-gray-400">Geen resultaten</div>
          </Show>
          <For each={filtered()}>
            {(option) => (
              <OptionRow
                label={option.label}
                checked={props.selectedCode === option.code}
                onSelect={() => choose(option.code)}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

interface OptionRowProps {
  label: string;
  checked: boolean;
  onSelect: () => void;
  muted?: boolean;
}

function OptionRow(props: OptionRowProps): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      onClick={() => props.onSelect()}
      class="flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-gray-100"
    >
      <Icon
        name={props.checked ? "radio_button_checked" : "radio_button_unchecked"}
        size={18}
        class={props.checked ? "flex-shrink-0 text-blue-600" : "flex-shrink-0 text-gray-400"}
      />
      <span class={`truncate ${props.muted && !props.checked ? "text-gray-400" : "text-gray-700"}`}>
        {props.label}
      </span>
    </button>
  );
}
