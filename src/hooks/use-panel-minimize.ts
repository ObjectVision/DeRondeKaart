import { useCallback } from "react";
import { useSessionFlag } from "@/hooks/use-session-flag";
import { useAutoCollapse } from "@/hooks/use-auto-collapse";

export interface UsePanelMinimizeResult {
  /** Navigation UI (Filter + Navigatie together). */
  navMinimized: boolean;
  setNavMinimized: (next: boolean) => void;
  toggleNavMinimized: () => void;
  /** Statistics panel. */
  chartsMinimized: boolean;
  setChartsMinimized: (next: boolean) => void;
  toggleChartsMinimized: () => void;
  /** Kaartlagen (legend) window. */
  legendMinimized: boolean;
  setLegendMinimized: (next: boolean) => void;
  toggleLegendMinimized: () => void;
}

/**
 * Minimize state for the three floating windows — navigation, statistics and
 * legend — each persisted for the browser session, plus the small-screen
 * auto-collapse that drives them.
 *
 * Grouped because they are one behaviour, not three: `useAutoCollapse` writes all
 * three together in the priority order Navigatie → Statistieken → Kaartlagen, so
 * splitting them would leave that callback reaching across three hooks.
 *
 * The setters and togglers are returned **exactly as `useSessionFlag` produces
 * them**, deliberately not re-wrapped. `toggle` closes over its current value, so
 * its identity changes whenever the flag does — and `toggleNavMinimized` sits in
 * the dependency arrays of App's `sectionToggles` and `sidebarToolbar` memos,
 * which exist so the memoized Sidebar does not re-render on every map frame.
 * Wrapping these in fresh closures here would defeat those memos silently, showing
 * up only as a frame-rate regression while panning.
 */
export function usePanelMinimize(): UsePanelMinimizeResult {
  // Collapsed via the close button inside the navigation window, restored via the
  // "Navigatie tonen" toolbar icon (which only appears while minimized). Only
  // relevant in sidebar mode; `*SectionEnabled` (from map.json) gates availability
  // entirely.
  const [navMinimized, setNavMinimized, toggleNavMinimized] = useSessionFlag(
    "sidebar.nav.min",
    false,
  );
  const [chartsMinimized, setChartsMinimized, toggleChartsMinimized] = useSessionFlag(
    "sidebar.charts.min",
    false,
  );
  // Collapsed via the close button in the window header, restored via the
  // "Kaartlagen tonen" icon in the collapsed bottom-left bar.
  const [legendMinimized, setLegendMinimized, toggleLegendMinimized] = useSessionFlag(
    "legend.min",
    false,
  );

  // On small screens, auto-collapse windows in the priority order
  // Navigatie → Statistieken → Kaartlagen as the viewport narrows. Only fires
  // when the width crosses a breakpoint, so manual toggles within a size band
  // are preserved.
  useAutoCollapse(
    useCallback(
      (t) => {
        setNavMinimized(t.nav);
        setChartsMinimized(t.charts);
        setLegendMinimized(t.legend);
      },
      [setNavMinimized, setChartsMinimized, setLegendMinimized],
    ),
  );

  return {
    navMinimized,
    setNavMinimized,
    toggleNavMinimized,
    chartsMinimized,
    setChartsMinimized,
    toggleChartsMinimized,
    legendMinimized,
    setLegendMinimized,
    toggleLegendMinimized,
  };
}
