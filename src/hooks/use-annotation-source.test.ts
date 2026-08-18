import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";

import { useAnnotationSource } from "@/hooks/use-annotation-source";

/** Let Solid flush its effect queue. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The overlay effect must subscribe to all of its inputs on every run, even the
 * runs that bail out because the map's style has not loaded.
 *
 * A Solid effect tracks only what it actually read last time. The first runs of
 * this effect happen before MapLibre has a style — if the early return came
 * before the accessor reads, the effect would end up subscribed to the map
 * alone, and turning annotation mode on afterwards would never re-run it. React
 * could not have this bug: its dependency array is declared, not observed.
 */
describe("useAnnotationSource", () => {
  it("keeps tracking its inputs while the map has no loaded style", async () => {
    const [visible, setVisible] = createSignal(false);
    let annotationReads = 0;

    let dispose = () => {};
    createRoot((d) => {
      dispose = d;
      useAnnotationSource(() => null, {
        annotations: () => {
          annotationReads += 1;
          return [];
        },
        draft: () => null,
        selectedId: () => null,
        peers: () => [],
        identityColor: () => "#000000",
        visible,
        zoom: () => 10,
      });
    });

    await tick();
    // The effect read `annotations` despite having no map at all.
    expect(annotationReads).toBeGreaterThan(0);
    const afterMount = annotationReads;

    setVisible(true);
    await tick();
    expect(annotationReads).toBeGreaterThan(afterMount);

    dispose();
  });
});
