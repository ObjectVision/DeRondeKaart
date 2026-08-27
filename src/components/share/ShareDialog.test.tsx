import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { ShareDialog } from "@/components/share/ShareDialog";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";

/**
 * The dialog mounts a live MapLibre preview, which jsdom cannot run. Stub the
 * preview module: this file is about the shape radios, not the map.
 */
vi.mock("@/components/share/ExportPreviewMap", () => ({
  ExportPreviewMap: () => null,
}));

/**
 * The export-shape radios. `DialogRoot` renders nothing while closed, so the
 * dialog must be OPEN for the download card to exist at all.
 */
function renderDialog() {
  return render(() => (
    <ShareDialog
      open
      onOpenChange={() => {}}
      entries={[]}
      hiddenIds={new Set()}
      hiddenRules={new Map()}
      sides={{
        left: { entries: [], hiddenIds: new Set() },
        right: { entries: [], hiddenIds: new Set() },
      }}
      basemapId="kleur-labels-only"
      viewState={{ longitude: 5, latitude: 52, zoom: 7, pitch: 0, bearing: 0 }}
      title="Titel"
      subtitle=""
      onTitleChange={() => {}}
      onSubtitleChange={() => {}}
    />
  ));
}

/**
 * Located by visible label rather than accessible name: the button's name also
 * absorbs the icon ligature text ("radio_button_checked"), which is decorative.
 */
const radio = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (el) => el.textContent?.includes(label),
  );
  if (!found) throw new Error(`no radio labelled ${label}`);
  return found;
};
const iconOf = (el: HTMLElement) =>
  el.querySelector<HTMLElement>("span.material-symbols-outlined");

describe("ShareDialog export shape", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it("offers both shapes, with rond selected by default", () => {
    renderDialog();

    expect(radio("Rond").getAttribute("aria-checked")).toBe("true");
    expect(radio("Vierkant").getAttribute("aria-checked")).toBe("false");
  });

  it("switches to vierkant on click", () => {
    renderDialog();

    radio("Vierkant").click();

    expect(radio("Vierkant").getAttribute("aria-checked")).toBe("true");
    expect(radio("Rond").getAttribute("aria-checked")).toBe("false");
  });

  // sessionStorage, so the choice survives closing the dialog and a reload.
  it("remembers the choice for the session", () => {
    renderDialog();
    radio("Vierkant").click();
    cleanup();

    renderDialog();

    expect(radio("Vierkant").getAttribute("aria-checked")).toBe("true");
  });

  it("uses the filled glyph for the selected shape only", () => {
    renderDialog();

    expect(iconOf(radio("Rond"))?.textContent).toBe("radio_button_checked");
    expect(iconOf(radio("Vierkant"))?.textContent).toBe("radio_button_unchecked");
  });

  /**
   * Both icons take the configured chrome size, and the selected one the
   * project accent — the same treatment every other icon in this dialog gets.
   * The unselected one stays grey so the two states remain distinguishable.
   */
  it("follows chromeIconSize, and chromeIconColor when selected", () => {
    renderDialog();

    const checked = iconOf(radio("Rond"));
    const unchecked = iconOf(radio("Vierkant"));

    expect(checked?.style.fontSize).toBe(`${chromeIconSize()}px`);
    expect(unchecked?.style.fontSize).toBe(`${chromeIconSize()}px`);

    // jsdom normalises the hex to rgb(), so compare against a probe element.
    const probe = document.createElement("span");
    probe.style.color = chromeIconColor();
    expect(checked?.style.color).toBe(probe.style.color);

    expect(unchecked?.style.color).toBe("");
    expect(unchecked?.className).toContain("text-gray-400");
  });
});
