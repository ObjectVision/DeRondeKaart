import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";

import {
  buurtCodeOf,
  createPblSummaryStatus,
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

/**
 * The splash must not come back down over a summary that is already on screen.
 *
 * `PblSummary` binds the iframe's `src` to the buurt code, so a repeat pick of
 * the same neighbourhood leaves the frame untouched — no reload, no script run,
 * no verdict. Re-arming here would mean the full backstop of logo over finished
 * content, which is the bug this guards: clicking a highlighted feature's own
 * red outline picks the same neighbourhood straight back.
 */
describe("createPblSummaryStatus", () => {
  /**
   * Set the hook up and hand back its controls.
   *
   * Solid flushes effects at the END of `createRoot`, not during its body, so
   * everything the effect installs — the message listener, the backstop timer —
   * only exists once this has returned. Acting inside the body would race it.
   *
   * The code is derived from a PICK OBJECT rather than held as a string signal,
   * because that is what drives the real thing: `FeatureInfo` recomputes
   * `buurtCode()` from `props.result`, so every click re-runs this effect even
   * when it names the same neighbourhood. A plain string signal would compare
   * equal and never re-run — hiding the exact case under test.
   */
  function setup(initial: string | null) {
    return createRoot((dispose) => {
      const [pick, setPick] = createSignal<{ code: string | null }>({ code: initial });
      const status = createPblSummaryStatus(() => pick().code);
      return { status, dispose, pickAgain: (code: string | null) => setPick({ code }) };
    });
  }

  /** The frame's own verdict, as pbl-buurt-select.js posts it. */
  function report(type: string) {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type }, origin: window.location.origin }),
    );
  }

  // Only the timer: faking microtasks too would stall Solid's own scheduling.
  const useTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  it("falls back to failed when the frame never reports", () => {
    useTimers();
    const { status, dispose } = setup("BU05690302");
    expect(status()).toBe("loading");
    vi.advanceTimersByTime(PBL_SUMMARY_TIMEOUT_MS);
    expect(status()).toBe("failed");
    dispose();
    vi.useRealTimers();
  });

  it("leaves the status alone on a repeat pick of the same neighbourhood", () => {
    useTimers();
    const { status, pickAgain, dispose } = setup("BU05690302");

    report("pbl-summary-ready");
    expect(status()).toBe("ready");

    // A fresh pick result naming the same neighbourhood. The iframe src is
    // unchanged, so nothing reloads and nothing may reset.
    pickAgain("BU05690302");
    expect(status()).toBe("ready");

    // And no second backstop is waiting to knock it back to "failed".
    vi.advanceTimersByTime(PBL_SUMMARY_TIMEOUT_MS * 2);
    expect(status()).toBe("ready");
    dispose();
    vi.useRealTimers();
  });

  /** The backstop exists for silence; a frame that answered must not be overruled. */
  it("cancels the backstop once a verdict arrives", () => {
    useTimers();
    const { status, dispose } = setup("BU05690302");
    report("pbl-summary-ready");
    expect(status()).toBe("ready");

    vi.advanceTimersByTime(PBL_SUMMARY_TIMEOUT_MS * 2);

    expect(status()).toBe("ready");
    dispose();
    vi.useRealTimers();
  });

  it("re-arms for a different neighbourhood", () => {
    useTimers();
    const { status, pickAgain, dispose } = setup("BU05690302");
    report("pbl-summary-ready");
    expect(status()).toBe("ready");

    pickAgain("BU03630001");
    expect(status()).toBe("loading");
    dispose();
    vi.useRealTimers();
  });

  /**
   * A repeat pick lands MID-LOAD, before the frame has reported.
   *
   * Solid tears an effect's cleanups down before re-running it, so anything that
   * re-runs the effect and then declines to re-register leaves the load with no
   * listener and no backstop — the verdict arrives to nobody and the splash
   * never lifts. That is strictly worse than the bug the guard was added for,
   * and clicking a still-loading feature's own outline is an easy way to hit it.
   */
  it("still hears the verdict after a repeat pick mid-load", () => {
    useTimers();
    const { status, pickAgain, dispose } = setup("BU05690302");
    expect(status()).toBe("loading");

    pickAgain("BU05690302");
    report("pbl-summary-ready");

    expect(status()).toBe("ready");
    dispose();
    vi.useRealTimers();
  });

  it("keeps its backstop after a repeat pick mid-load", () => {
    useTimers();
    const { status, pickAgain, dispose } = setup("BU05690302");

    pickAgain("BU05690302");
    vi.advanceTimersByTime(PBL_SUMMARY_TIMEOUT_MS);

    expect(status()).toBe("failed");
    dispose();
    vi.useRealTimers();
  });

  it("re-arms after the selection is cleared and the same code returns", () => {
    useTimers();
    const { status, pickAgain, dispose } = setup("BU05690302");
    report("pbl-summary-ready");
    expect(status()).toBe("ready");

    // Clearing unmounts the frame, so the same code afterwards is a genuine
    // reload and must wait for a fresh verdict.
    pickAgain(null);
    pickAgain("BU05690302");
    expect(status()).toBe("loading");
    dispose();
    vi.useRealTimers();
  });
});
