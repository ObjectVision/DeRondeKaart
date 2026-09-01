import { Show, createSignal, type JSX } from "solid-js";
import { Icon } from "@/components/ui/nav-icon";

interface SearchBarProps {
  /** Show the search bar. Defaults off (map.json `searchbar`). */
  showSearch?: boolean;
}

/**
 * Top-center "Zoek een kaartlaag…" input (map.json `searchbar`, also togglable
 * by the Power BI host's `map-config` message). The query is not wired to a
 * surface yet: the layer tree lives in the sidebar's Navigatie section, which
 * does its own filtering.
 */
export function SearchBar(props: SearchBarProps): JSX.Element {
  const [query, setQuery] = createSignal("");

  return (
    <Show when={props.showSearch}>
      <div class="absolute left-1/2 top-2 z-30 flex w-[min(96vw,56rem)] -translate-x-1/2 flex-col gap-3 sm:top-4">
        <div class="flex items-center gap-4 rounded-full border border-gray-200/80 bg-white/95 px-7 py-[18px] shadow-md backdrop-blur-sm transition-shadow focus-within:border-gray-300 focus-within:shadow-lg">
          <input
            type="text"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Zoek een kaartlaag…"
            class="min-w-0 flex-1 bg-transparent text-[22px] text-gray-700 outline-none placeholder:text-gray-400"
          />
          <Icon name="send" size={28} class="flex-shrink-0 text-gray-300" />
        </div>
      </div>
    </Show>
  );
}
