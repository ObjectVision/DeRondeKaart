import { onMount, onCleanup } from "solid-js";

/**
 * Width buckets for small-screen auto-collapse, widest → narrowest. Each bucket
 * lists which windows should be collapsed at that size. Order follows the
 * priority Navigatie → Statistieken (charts) → Kaartlagen (legend): as the
 * viewport shrinks, the next window in that order folds away.
 */
export interface AutoCollapseTargets {
  nav: boolean;
  charts: boolean;
  legend: boolean;
}

/** px thresholds; a width < the threshold collapses that window (and all earlier ones). */
const NAV_BELOW = 1024;
const CHARTS_BELOW = 768;
const LEGEND_BELOW = 520;

function bucketFor(width: number): AutoCollapseTargets {
  return {
    nav: width < NAV_BELOW,
    charts: width < CHARTS_BELOW,
    legend: width < LEGEND_BELOW,
  };
}

/** Stable key for a bucket so we only react when the *bucket* changes, not every px. */
function bucketKey(t: AutoCollapseTargets): string {
  return `${t.nav ? 1 : 0}${t.charts ? 1 : 0}${t.legend ? 1 : 0}`;
}

/**
 * Drives the window minimize flags from the viewport width, but only when the
 * width crosses into a different bucket. Between crossings the user's manual
 * toggles are left untouched ("auto yields to manual"): resizing within the
 * same bucket never overrides a window the user just opened or closed.
 *
 * `apply` receives the collapse targets for the new bucket and should push them
 * into the corresponding session flags. It is called directly rather than
 * through React's useEffectEvent indirection — the listener is registered once
 * on mount, and the closure it captures is the only one there ever is.
 */
export function useAutoCollapse(apply: (targets: AutoCollapseTargets) => void): void {
  let lastKey: string | null = null;

  onMount(() => {
    function evaluate() {
      const targets = bucketFor(window.innerWidth);
      const key = bucketKey(targets);
      if (key === lastKey) return; // same bucket — respect manual state
      lastKey = key;
      apply(targets);
    }

    evaluate(); // apply the initial bucket on mount
    window.addEventListener("resize", evaluate);
    onCleanup(() => window.removeEventListener("resize", evaluate));
  });
}
