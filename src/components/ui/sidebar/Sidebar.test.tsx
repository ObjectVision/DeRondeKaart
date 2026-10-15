import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

import { LeafInfoButton } from "@/components/ui/sidebar/Sidebar";
import type { LayerInfoButtonMode } from "@/config/map-config";
import type { NavigationApi } from "@/hooks/use-navigation";
import type { NavLeaf } from "@/layers/navigation";

afterEach(cleanup);

const META = new Map([
  ["strat1", "Strategie 1"],
  ["strat1_2026", "Strategie 1 (2026)"],
]);

/** A NavigationApi whose on-map state is a signal the test can flip. */
function stubNav(onMap: () => Set<string>) {
  const toggleOnMap = vi.fn();
  const nav = {
    isOnMap: (id: string) => onMap().has(id),
    toggleOnMap,
    togglePair: vi.fn(),
    pairState: () => "none",
    leftHasLayers: () => false,
  } as unknown as NavigationApi;
  return { nav, toggleOnMap };
}

function renderButton(
  leaf: NavLeaf,
  mode: LayerInfoButtonMode,
  onMap: () => Set<string> = () => new Set(),
) {
  const { nav, toggleOnMap } = stubNav(onMap);
  const onOpenMeta = vi.fn();
  render(() => (
    <LeafInfoButton leaf={leaf} nav={nav} mode={mode} metaLayers={META} onOpenMeta={onOpenMeta} />
  ));
  return { onOpenMeta, toggleOnMap };
}

const query = () => screen.queryByTitle("Informatie");

describe("LeafInfoButton (map.json layerInfoButton)", () => {
  it("renders nothing when off, even for a layer on the map", () => {
    renderButton({ id: "strat1", label: "Strategie 1" }, "off", () => new Set(["strat1"]));
    expect(query()).toBeNull();
  });

  it("checked: follows the layer's on-map state", () => {
    const [onMap, setOnMap] = createSignal(new Set<string>());
    // the accessor itself is handed over and read inside the component's tracked scope
    // eslint-disable-next-line solid/reactivity
    renderButton({ id: "strat1", label: "Strategie 1" }, "checked", onMap);
    expect(query()).toBeNull();
    setOnMap(new Set(["strat1"]));
    expect(query()).not.toBeNull();
    setOnMap(new Set<string>());
    expect(query()).toBeNull();
  });

  it("always: shown off-map, and opens the metainfo without toggling the layer", () => {
    const { onOpenMeta, toggleOnMap } = renderButton(
      { id: "strat1", label: "Strategie 1" },
      "always",
    );
    fireEvent.click(screen.getByLabelText("Informatie: Strategie 1"));
    expect(onOpenMeta).toHaveBeenCalledWith("strat1", "Strategie 1");
    expect(toggleOnMap).not.toHaveBeenCalled();
  });

  it("is hidden for a layer without meta", () => {
    renderButton({ id: "zonder_meta", label: "Zonder meta" }, "always");
    expect(query()).toBeNull();
  });

  it("is hidden for a paired comparison leaf", () => {
    renderButton(
      { id: "vergelijk", label: "Vergelijk", left: "strat1", right: "strat1_2026" },
      "always",
    );
    expect(query()).toBeNull();
  });

  it("opens the layer a sided leaf applies, not its own id", () => {
    const { onOpenMeta } = renderButton(
      {
        id: "vergelijk",
        label: "Strategie 1",
        left: "strat1",
        right: "strat1_2026",
        side: "right",
      },
      "always",
    );
    fireEvent.click(screen.getByLabelText("Informatie: Strategie 1"));
    expect(onOpenMeta).toHaveBeenCalledWith("strat1_2026", "Strategie 1 (2026)");
  });
});
