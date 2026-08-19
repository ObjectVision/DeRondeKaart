/**
 * Module store of what the dashboard is currently showing: the area selection
 * and the host-supplied parameters every widget query filters on.
 *
 * A module-level signal rather than a context, mirroring `src/layers/area-filter.ts`:
 * the postMessage bridge writes to it from outside any component tree, and
 * widgets subscribe by reading the accessor. Setters always build a fresh
 * object, so identity changes exactly when the content does.
 */
import { createSignal } from "solid-js";

export interface DashboardSelection {
  /** CBS codes, at any level; empty means "everything". */
  codes: string[];
  /** Column the codes apply to, e.g. `"bu_code"`. */
  column: string;
}

export type DashboardParameters = Record<string, string | number>;

const [selection, setSelectionSignal] = createSignal<DashboardSelection | null>(null);
const [parameters, setParametersSignal] = createSignal<DashboardParameters>({});

export { selection, parameters };

export function setSelection(next: DashboardSelection | null): void {
  setSelectionSignal(next && next.codes.length > 0 ? { ...next, codes: [...next.codes] } : null);
}

/** Merge into the current parameters; `null` for a value drops that key. */
export function mergeParameters(patch: Record<string, string | number | null>): void {
  setParametersSignal((prev) => {
    const next = { ...prev };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    return next;
  });
}

/** Reset both, for tests and for a host that clears its state. */
export function resetDashboardState(): void {
  setSelectionSignal(null);
  setParametersSignal({});
}
