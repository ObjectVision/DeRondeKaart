import { describe, expect, it } from "vitest";

import { clampToParent, placeBelowPointer } from "@/components/ui/info-popup";

/**
 * The window's geometry, tested apart from the DOM it is applied to. jsdom
 * reports every layout metric as 0 and ships no ResizeObserver, so rendering
 * InfoPopup would measure nothing — the arithmetic is where the behaviour is.
 *
 * EDGE_MARGIN is 8 and POINTER_OFFSET 12; both are module-private, so the
 * numbers below are written out rather than imported.
 */

/** A roomy parent and a window that fits in it several times over. */
const PARENT = { width: 1000, height: 800 };
const BOX = { width: 300, height: 200 };

describe("clampToParent", () => {
  it("leaves a box that is already inside alone", () => {
    expect(
      clampToParent(100, 100, BOX.width, BOX.height, PARENT.width, PARENT.height),
    ).toEqual({ left: 100, top: 100 });
  });

  it("holds it off the top and left edges", () => {
    expect(
      clampToParent(-50, -50, BOX.width, BOX.height, PARENT.width, PARENT.height),
    ).toEqual({ left: 8, top: 8 });
  });

  it("holds it off the right and bottom edges", () => {
    // 1000 - 300 - 8, and 800 - 200 - 8.
    expect(
      clampToParent(9999, 9999, BOX.width, BOX.height, PARENT.width, PARENT.height),
    ).toEqual({ left: 692, top: 592 });
  });

  /** The header carries the close button and the drag handle, so it wins. */
  it("pins a box larger than its parent to the top-left margin", () => {
    expect(clampToParent(50, 50, 1200, 900, PARENT.width, PARENT.height)).toEqual({
      left: 8,
      top: 8,
    });
  });
});

describe("placeBelowPointer", () => {
  it("opens just below the pointer when there is room", () => {
    expect(
      placeBelowPointer(100, 100, BOX.width, BOX.height, PARENT.width, PARENT.height),
    ).toEqual({ left: 100, top: 112 });
  });

  it("flips above the pointer when it would not fit below", () => {
    // 700 - 12 - 200.
    expect(
      placeBelowPointer(100, 700, BOX.width, BOX.height, PARENT.width, PARENT.height),
    ).toEqual({ left: 100, top: 488 });
  });

  /**
   * Neither side fits — a window nearly as tall as the parent. It settles
   * against the bottom margin rather than hanging off either end.
   */
  it("falls back to the bottom margin when it fits neither above nor below", () => {
    // Parent 250 tall, box 200: below needs 320, above would start at -112.
    expect(placeBelowPointer(100, 100, BOX.width, BOX.height, PARENT.width, 250)).toEqual({
      left: 100,
      top: 42,
    });
  });

  it("clamps horizontally against the pointer's own position", () => {
    expect(
      placeBelowPointer(990, 100, BOX.width, BOX.height, PARENT.width, PARENT.height),
    ).toEqual({ left: 692, top: 112 });
  });
});
