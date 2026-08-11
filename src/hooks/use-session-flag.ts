import { useCallback, useState } from "react";
import { readStorage, writeStorage } from "@/lib/storage";

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
    const stored = readStorage(sessionStorage, key);
    return stored === null ? initial : stored === "1";
  });

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      writeStorage(sessionStorage, key, next ? "1" : "0");
    },
    [key],
  );

  const toggle = useCallback(() => set(!value), [set, value]);

  return [value, set, toggle];
}
