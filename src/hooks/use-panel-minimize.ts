import type { Accessor } from "solid-js";
import { useSessionFlag } from "@/hooks/use-session-flag";
import { useAutoCollapse } from "@/hooks/use-auto-collapse";

export interface UsePanelMinimizeResult {
  /** Navigation UI (Filter + Navigatie together). */
  navMinimized: Accessor<boolean>;
  setNavMinimized: (next: boolean) => void;
  toggleNavMinimized: () => void;
  /** Statistics panel. */
  chartsMinimized: Accessor<boolean>;
  setChartsMinimized: (next: boolean) => void;
  toggleChartsMinimized: () => void;
  /** Kaartlagen (legend) window. */
  legendMinimized: Accessor<boolean>;
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
  useAutoCollapse((t) => {
    setNavMinimized(t.nav);
    setChartsMinimized(t.charts);
    setLegendMinimized(t.legend);
  });

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
