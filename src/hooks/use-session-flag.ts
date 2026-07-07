import { useCallback, useState } from "react";

/**
 * A boolean state that persists for the current browser session (sessionStorage).
 * Used for collapse/minimize UI state so a re-render or hot reload keeps the
 * user's chosen panel layout, per the small-screen persistence requirement.
 */
export function useSessionFlag(
  key: string,
  initial: boolean,
): [boolean, (next: boolean) => void, () => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        sessionStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Ignore storage failures (private mode / quota) — state still works
        // in-memory for this render tree.
      }
    },
    [key],
  );

  const toggle = useCallback(() => set(!value), [set, value]);

  return [value, set, toggle];
}
