import { describe, expect, it } from "vitest";
import { isInsideExportFrame } from "@/lib/map-capture";

/**
 * Which annotations get a callout label in the exported PNG.
 *
 * The two shapes disagree only at the corners, and getting it wrong is silent:
 * a square export using the round test would show an annotation in the PNG with
 * its label missing, and a round export using the square test would draw a
 * leader line to a point the circle cropped away.
 */
const SIZE = 2048;

describe("isInsideExportFrame", () => {
  it("keeps the centre for either shape", () => {
    expect(isInsideExportFrame(SIZE / 2, SIZE / 2, SIZE)).toBe(true);
    expect(isInsideExportFrame(SIZE / 2, SIZE / 2, SIZE, true)).toBe(true);
  });

  // The whole point of the distinction: a corner is inside the square frame and
  // outside the inscribed circle.
  it("splits on the corners", () => {
    expect(isInsideExportFrame(10, 10, SIZE)).toBe(false);
    expect(isInsideExportFrame(10, 10, SIZE, true)).toBe(true);

    expect(isInsideExportFrame(SIZE - 10, SIZE - 10, SIZE)).toBe(false);
    expect(isInsideExportFrame(SIZE - 10, SIZE - 10, SIZE, true)).toBe(true);
  });

  it("drops a point outside the frame under either shape", () => {
    expect(isInsideExportFrame(-50, SIZE / 2, SIZE)).toBe(false);
    expect(isInsideExportFrame(-50, SIZE / 2, SIZE, true)).toBe(false);
    expect(isInsideExportFrame(SIZE + 50, SIZE / 2, SIZE, true)).toBe(false);
  });

  it("keeps a point just inside the rim, and drops one just outside", () => {
    // Straight up from the centre: r = size/2 exactly on the rim.
    expect(isInsideExportFrame(SIZE / 2, 1, SIZE)).toBe(true);
    expect(isInsideExportFrame(SIZE / 2, -1, SIZE)).toBe(false);
  });
});
