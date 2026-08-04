import { useEffect, useEffectEvent, useRef } from "react";

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
 * into the corresponding session flags.
 */
export function useAutoCollapse(apply: (targets: AutoCollapseTargets) => void): void {
  // useEffectEvent keeps `apply` out of the dep array without a ref mirror, so
  // the resize listener is wired once but always calls the latest callback.
  const onApply = useEffectEvent(apply);

  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    function evaluate() {
      const targets = bucketFor(window.innerWidth);
      const key = bucketKey(targets);
      if (key === lastKeyRef.current) return; // same bucket — respect manual state
      lastKeyRef.current = key;
      onApply(targets);
    }

    evaluate(); // apply the initial bucket on mount
    window.addEventListener("resize", evaluate);
    return () => window.removeEventListener("resize", evaluate);
  }, []);
}
