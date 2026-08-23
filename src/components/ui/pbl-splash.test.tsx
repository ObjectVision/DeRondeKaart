import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createPblSummaryStatus, PBL_SUMMARY_TIMEOUT_MS } from "@/lib/pbl-summary";
import type { PblSummaryStatus } from "@/lib/pbl-summary";

/**
 * The splash that covers PBL's iframe while it boots.
 *
 * These drive `createPblSummaryStatus` — the module `PblSummary` calls — rather
 * than a copy of it. An earlier version of this file transcribed the effect out
 * of the component, which meant reordering the two lines that matter left every
 * test green. Rendering the component itself is still out of reach: it needs a
 * MapLibre pick result and a live iframe.
 */

/** Deliver a message event the way the framed viewer would. */
function send(type: string, origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent("message", { data: { type }, origin }));
}

/**
 * Let Solid run its effects. `createEffect` is deferred to after the current
 * batch, so the message listener does not exist until this resolves — the same
 * flush use-map-layers.test.ts does. Fake timers do not patch microtasks, so
 * this still works alongside them.
 */
const settle = () => Promise.resolve();

describe("PBL summary splash", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts covered", async () => {
    await createRoot(async (dispose) => {
      const status = createPblSummaryStatus(() => "BU0363FF03");
      await settle();
      expect(status()).toBe("loading");
      dispose();
    });
  });

  it("lifts when the frame reports ready", async () => {
    await createRoot(async (dispose) => {
      const status = createPblSummaryStatus(() => "BU0363FF03");
      await settle();
      send("pbl-summary-ready");
      expect(status()).toBe("ready");
      dispose();
    });
  });

  // PBL's auto-select fails soft and leaves its own picker usable, so a failure
  // must uncover the frame rather than hold the splash.
  it("lifts when the frame reports failure", async () => {
    await createRoot(async (dispose) => {
      const status = createPblSummaryStatus(() => "BU0363FF03");
      await settle();
      send("pbl-summary-failed");
      expect(status()).toBe("failed");
      dispose();
    });
  });

  it("stays covered for a message from another origin", async () => {
    await createRoot(async (dispose) => {
      const status = createPblSummaryStatus(() => "BU0363FF03");
      await settle();
      send("pbl-summary-ready", "https://evil.example");
      expect(status()).toBe("loading");
      dispose();
    });
  });

  it("lifts on the timeout when the frame never reports", async () => {
    await createRoot(async (dispose) => {
      const status = createPblSummaryStatus(() => "BU0363FF03");
      await settle();
      expect(status()).toBe("loading");
      vi.advanceTimersByTime(PBL_SUMMARY_TIMEOUT_MS + 1);
      expect(status()).toBe("failed");
      dispose();
    });
  });

  it("re-covers for the next neighbourhood and forgets the old verdict", async () => {
    await createRoot(async (dispose) => {
      const [buurtCode, setCode] = createSignal<string | null>("BU0363FF03");
      const status = createPblSummaryStatus(buurtCode);
      await settle();

      send("pbl-summary-ready");
      expect(status()).toBe("ready");

      // A different neighbourhood: a fresh frame is loading, so the splash must
      // come back rather than leave the old verdict standing.
      setCode("BU19040213");
      await settle();
      expect(status()).toBe("loading");

      send("pbl-summary-ready");
      expect(status()).toBe("ready");
      dispose();
    });
  });

  it("does not leave the previous frame's timer armed", async () => {
    await createRoot(async (dispose) => {
      const [buurtCode, setCode] = createSignal<string | null>("BU0363FF03");
      const status = createPblSummaryStatus(buurtCode);
      await settle();

      // Most of the way to the first timeout, then switch.
      vi.advanceTimersByTime(PBL_SUMMARY_TIMEOUT_MS - 10);
      setCode("BU19040213");
      await settle();
      send("pbl-summary-ready");
      expect(status()).toBe("ready");

      // The old timer would have fired by now; it must have been cleared, or it
      // would flip a perfectly good summary back to "failed".
      vi.advanceTimersByTime(20);
      expect(status()).toBe("ready");
      dispose();
    });
  });

  // The read-before-early-return rule, which is the one that fails silently.
  //
  // An effect subscribes only to what its last run actually read. Starting from
  // null the run returns early, so if `buurtCode` is read AFTER that return it
  // was never subscribed to — and the next neighbourhood never re-arms the
  // splash. Switching between two non-null codes cannot catch this: the early
  // return is not taken, so the read happens either way.
  it("re-arms after a feature with no buurt code", async () => {
    await createRoot(async (dispose) => {
      const [buurtCode, setCode] = createSignal<string | null>(null);
      const status = createPblSummaryStatus(buurtCode);
      await settle();
      expect(status()).toBe("loading");

      // A neighbourhood that does have a code: the effect must run again.
      setCode("BU0363FF03");
      await settle();
      send("pbl-summary-ready");
      expect(status()).toBe("ready");
      dispose();
    });
  });

  it("arms the timeout after a feature with no buurt code", async () => {
    await createRoot(async (dispose) => {
      const [buurtCode, setCode] = createSignal<string | null>(null);
      const status = createPblSummaryStatus(buurtCode);
      await settle();

      setCode("BU0363FF03");
      await settle();
      // The backstop belongs to the NEW frame; without a re-run there is none.
      vi.advanceTimersByTime(PBL_SUMMARY_TIMEOUT_MS + 1);
      expect(status()).toBe("failed");
      dispose();
    });
  });

  it("stops listening once disposed", async () => {
    let status!: () => PblSummaryStatus;
    await createRoot(async (dispose) => {
      status = createPblSummaryStatus(() => "BU0363FF03");
      await settle();
      dispose();
    });
    send("pbl-summary-ready");
    expect(status()).toBe("loading");
  });

  it("shows nothing to lift when the feature has no buurt code", async () => {
    await createRoot(async (dispose) => {
      const status = createPblSummaryStatus(() => null);
      await settle();
      // No frame is mounted in this case (the component renders the "geen
      // buurtcode" message instead), so no timer may be left running.
      vi.advanceTimersByTime(PBL_SUMMARY_TIMEOUT_MS + 1);
      expect(status()).toBe("loading");
      dispose();
    });
  });
});
