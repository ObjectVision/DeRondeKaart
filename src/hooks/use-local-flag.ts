import { createSignal, type Accessor } from "solid-js";
import { readStorage, writeStorage } from "@/lib/storage";

/**
 * A boolean state that persists for this browser (localStorage).
 *
 * The long-lived sibling of {@link useSessionFlag}: same shape, different
 * lifetime. Reach for this one when the state answers "has this person ever
 * done X" — a one-time welcome screen, a dismissed notice — and for the session
 * hook when it answers "how is the UI arranged right now", which should return
 * to its configured shape on the next visit.
 *
 * Storage access cannot throw here: `readStorage`/`writeStorage` fall back to
 * in-memory state when storage is blocked (private mode, or the sandboxed
 * iframe this app runs in under Power BI). The flag then works for the current
 * page load but does not survive a reload.
 */
export function useLocalFlag(
  key: string,
  initial: boolean,
): [Accessor<boolean>, (next: boolean) => void, () => void] {
  const stored = readStorage(localStorage, key);
  const [value, setValue] = createSignal<boolean>(stored === null ? initial : stored === "1");

  function set(next: boolean) {
    setValue(next);
    writeStorage(localStorage, key, next ? "1" : "0");
  }

  function toggle() {
    set(!value());
  }

  return [value, set, toggle];
}
