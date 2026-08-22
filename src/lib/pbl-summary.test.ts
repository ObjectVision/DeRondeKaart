import { describe, expect, it } from "vitest";

import {
  buurtCodeOf,
  pblStatusFromMessage,
  pblSummaryUrl,
  PBL_SUMMARY_TIMEOUT_MS,
} from "@/lib/pbl-summary";

/**
 * The code shape is the whole point of these tests. `buurtCodeOf` gates whether
 * a click opens PBL's summary or the "geen buurtcode" message, and it used to
 * require eight digits — which rejected every Amsterdam neighbourhood, all 517
 * of which carry letters (BU0363FF03 is Bedrijvenpark Lutkemeer).
 *
 * The gemeente half must stay numeric: pbl-buurt-select.js slices it out to
 * build the GM code, so a non-numeric one would pick the wrong gemeente rather
 * than fail.
 */

/** A picked feature carrying `properties`, as feature-info passes them in. */
function feature(properties: Record<string, unknown>) {
  return { properties };
}

describe("buurtCodeOf", () => {
  it("accepts an alphanumeric buurt half", () => {
    expect(buurtCodeOf(feature({ bu_code: "BU0363FF03" }))).toBe("BU0363FF03");
    expect(buurtCodeOf(feature({ bu_code: "BU0363AA01" }))).toBe("BU0363AA01");
  });

  it("accepts an all-digit code", () => {
    expect(buurtCodeOf(feature({ bu_code: "BU19040213" }))).toBe("BU19040213");
  });

  it("rejects a non-numeric gemeente half", () => {
    expect(buurtCodeOf(feature({ bu_code: "BUAB63FF03" }))).toBeNull();
  });

  it("rejects a code that is not uppercase", () => {
    expect(buurtCodeOf(feature({ bu_code: "bu0363ff03" }))).toBeNull();
  });

  it("rejects a wrong-length code", () => {
    expect(buurtCodeOf(feature({ bu_code: "BU0363FF0" }))).toBeNull();
    expect(buurtCodeOf(feature({ bu_code: "BU0363FF033" }))).toBeNull();
  });

  it("rejects a missing or non-string property", () => {
    expect(buurtCodeOf(undefined)).toBeNull();
    expect(buurtCodeOf(feature({}))).toBeNull();
    expect(buurtCodeOf(feature({ bu_code: 363_0003 }))).toBeNull();
    expect(buurtCodeOf(feature({ bu_code: null }))).toBeNull();
  });
});

describe("pblSummaryUrl", () => {
  it("passes the code as the bu parameter", () => {
    expect(pblSummaryUrl("BU0363FF03")).toBe("/pbl-samenvatting.html?bu=BU0363FF03");
  });
});

/**
 * The frame reports its own readiness because the iframe's native `load` event
 * fires while PBL's gemeente picker is still on screen — far too early to lift
 * the splash. These guard the two things that can go wrong with that: acting on
 * a message from somewhere else, and never lifting the splash at all.
 */
describe("pblStatusFromMessage", () => {
  /** A message event as the framed viewer sends it, from a given origin. */
  function message(data: unknown, origin = window.location.origin): MessageEvent {
    return { origin, data } as MessageEvent;
  }

  it("reads the ready verdict", () => {
    expect(pblStatusFromMessage(message({ type: "pbl-summary-ready" }))).toBe("ready");
  });

  it("reads the failed verdict", () => {
    expect(pblStatusFromMessage(message({ type: "pbl-summary-failed" }))).toBe("failed");
  });

  // This window also receives postMessage traffic from an embedding host, so a
  // message from anywhere but our own origin must not move the splash.
  it("ignores a message from another origin", () => {
    expect(
      pblStatusFromMessage(message({ type: "pbl-summary-ready" }, "https://evil.example")),
    ).toBeNull();
  });

  it.each([
    { type: "map-command" },
    { type: "open-circular" },
    { type: "set-variant", id: "2026" },
    { type: "pbl-summary-something-else" },
    {},
    null,
    "pbl-summary-ready",
    42,
  ])("ignores the unrelated payload %j", (data) => {
    expect(pblStatusFromMessage(message(data))).toBeNull();
  });

  it("caps the wait well under the frame's own two-stage 60s deadline", () => {
    expect(PBL_SUMMARY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PBL_SUMMARY_TIMEOUT_MS).toBeLessThan(60000);
  });
});
