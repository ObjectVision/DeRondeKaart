import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";
import { pblStatusFromMessage, PBL_SUMMARY_TIMEOUT_MS } from "@/lib/pbl-summary";
import type { PblSummaryStatus } from "@/lib/pbl-summary";

/**
 * The splash logic from PblSummary (feature-info.tsx), extracted verbatim.
 *
 * Rendering the component itself would mean standing up a MapLibre pick result
 * and a live iframe; the behaviour worth protecting is the reactive wiring, and
 * three things about it fail *silently* if they regress:
 *
 *   - not reading buurtCode before the early return -> the effect never re-runs
 *     for the next neighbourhood and the splash stays up forever;
 *   - not resetting to "loading" -> the second click shows the previous
 *     verdict over a blank frame;
 *   - no timeout -> a frame that never reports leaves the splash covering a
 *     page the user could otherwise operate by hand.
 */
function splashLogic(buurtCode: () => string | null) {
  const [status, setStatus] = createSignal<PblSummaryStatus>("loading");

  createEffect(() => {
    const code = buurtCode();
    setStatus("loading");
    if (!code) return;

    function onMessage(event: MessageEvent) {
      const next = pblStatusFromMessage(event);
      if (next) setStatus(next);
    }
    window.addEventListener("message", onMessage);
    const timer = setTimeout(() => setStatus("failed"), PBL_SUMMARY_TIMEOUT_MS);

    onCleanup(() => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    });
  });

  return status;
}

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
      const status = splashLogic(() => "BU0363FF03");
      await settle();
      expect(status()).toBe("loading");
      dispose();
    });
  });

  it("lifts when the frame reports ready", async () => {
    await createRoot(async (dispose) => {
      const status = splashLogic(() => "BU0363FF03");
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
      const status = splashLogic(() => "BU0363FF03");
      await settle();
      send("pbl-summary-failed");
      expect(status()).toBe("failed");
      dispose();
    });
  });

  it("stays covered for a message from another origin", async () => {
    await createRoot(async (dispose) => {
      const status = splashLogic(() => "BU0363FF03");
      await settle();
      send("pbl-summary-ready", "https://evil.example");
      expect(status()).toBe("loading");
      dispose();
    });
  });

  it("lifts on the timeout when the frame never reports", async () => {
    await createRoot(async (dispose) => {
      const status = splashLogic(() => "BU0363FF03");
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
      // eslint-disable-next-line solid/reactivity -- splashLogic reads this inside its own createEffect
      const status = splashLogic(buurtCode);
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
      // eslint-disable-next-line solid/reactivity -- splashLogic reads this inside its own createEffect
      const status = splashLogic(buurtCode);
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

  it("stops listening once disposed", async () => {
    let status!: () => PblSummaryStatus;
    await createRoot(async (dispose) => {
      status = splashLogic(() => "BU0363FF03");
      await settle();
      dispose();
    });
    send("pbl-summary-ready");
    expect(status()).toBe("loading");
  });

  it("shows nothing to lift when the feature has no buurt code", async () => {
    await createRoot(async (dispose) => {
      const status = splashLogic(() => null);
      await settle();
      // No frame is mounted in this case (the component renders the "geen
      // buurtcode" message instead), so no timer may be left running.
      vi.advanceTimersByTime(PBL_SUMMARY_TIMEOUT_MS + 1);
      expect(status()).toBe("loading");
      dispose();
    });
  });
});
