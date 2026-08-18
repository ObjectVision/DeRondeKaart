import { createSignal, type Accessor } from "solid-js";
import { readStorage, writeStorage } from "@/lib/storage";

/**
 * A boolean state that persists for the current browser session (sessionStorage).
 * Used for collapse/minimize UI state so a re-render or hot reload keeps the
 * user's chosen panel layout, per the small-screen persistence requirement.
 */
export function useSessionFlag(
  key: string,
  initial: boolean,
): [Accessor<boolean>, (next: boolean) => void, () => void] {
  const stored = readStorage(sessionStorage, key);
  const [value, setValue] = createSignal<boolean>(stored === null ? initial : stored === "1");

  function set(next: boolean) {
    setValue(next);
    writeStorage(sessionStorage, key, next ? "1" : "0");
  }

  function toggle() {
    set(!value());
  }

  return [value, set, toggle];
}
