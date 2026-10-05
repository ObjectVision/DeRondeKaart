import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";

import {
  buurtCodeOf,
  clearPblPublishedCache,
  createPblSummaryStatus,
  createPblYearAvailability,
  defaultPblSummaryTab,
  pblStatusFromMessage,
  pblSummaryTabs,
  pblSummaryUrl,
  pblYearPublished,
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
    expect(pblSummaryUrl("BU0363FF03", "/pbl-samenvatting.html")).toBe(
      "/pbl-samenvatting.html?bu=BU0363FF03",
    );
  });

  it("builds the URL from the page it is given", () => {
    expect(pblSummaryUrl("BU0363FF03", "/pbl-samenvatting-2026.html")).toBe(
      "/pbl-samenvatting-2026.html?bu=BU0363FF03",
    );
  });
});

/**
 * Which model year each config variant shows.
 *
 * The mapping is skewed on purpose — config variant `2025` shows PBL's 2024
 * viewer — so these cases are the record of that, not an oversight to tidy up.
 */
describe("pblSummaryTabs", () => {
  it("shows PBL 2024 for the 2025 variant", () => {
    const tabs = pblSummaryTabs("2025");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].label).toBe("ASA2025");
    expect(tabs[0].page).toBe("/pbl-samenvatting.html");
    expect(tabs[0].dataUrl).toContain("/startanalyse/2024/");
  });

  it("shows PBL 2026 for the 2026 variant", () => {
    const tabs = pblSummaryTabs("2026");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].label).toBe("ASA2026");
    expect(tabs[0].page).toBe("/pbl-samenvatting-2026.html");
    expect(tabs[0].dataUrl).toContain("/startanalyse/2026/");
  });

  /**
   * The probe is only meaningful if each tab asks about its OWN year. Two tabs
   * sharing one dataUrl would make an unpublished year look published — the
   * failure this whole mechanism exists to catch.
   */
  it("gives each year its own data probe, naming that year's gemeente table", () => {
    const [asa2025, asa2026] = pblSummaryTabs("2025_2026");
    expect(asa2025.dataUrl).toMatch(/\/2024\/samenvatting\/.*gemeenten_2024\.csv$/);
    expect(asa2026.dataUrl).toMatch(/\/2026\/samenvatting\/.*gemeenten_2026\.csv$/);
  });

  it("offers both years for the comparison variant, oldest first", () => {
    expect(pblSummaryTabs("2025_2026").map((tab) => tab.label)).toEqual(["ASA2025", "ASA2026"]);
  });

  // The newer edition is the one being evaluated; the older is there to
  // compare against.
  it("opens the comparison variant on ASA2026", () => {
    expect(defaultPblSummaryTab(pblSummaryTabs("2025_2026")).label).toBe("ASA2026");
  });

  it("uses the only tab as the default when there is one", () => {
    expect(defaultPblSummaryTab(pblSummaryTabs("2026")).label).toBe("ASA2026");
  });

  /**
   * Every project that declares no variants at all lands here, so this is what
   * keeps the feature from changing anything for them.
   */
  it.each([null, "onzin", "2027"])("falls back to PBL 2024 for %j", (variant) => {
    const tabs = pblSummaryTabs(variant);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].page).toBe("/pbl-samenvatting.html");
  });
});

/**
 * The probe exists because PBL published the 2026 viewer's CODE with none of
 * its DATA: every assets/data/** path 404s while 2024's are served, so framing
 * it shows an empty shell with nothing selectable.
 *
 * The direction that matters is the fail-open one. Reading "we could not ask"
 * as "not published" would blank the WORKING 2024 summary whenever the network
 * hiccups — a far worse failure than briefly framing an empty 2026 one, and an
 * invisible one, since an offline user has no way to tell the two apart.
 */
describe("pblYearPublished", () => {
  const URL_A = "https://infographics.pbl.nl/a/gemeenten_2026.csv";

  beforeEach(() => {
    clearPblPublishedCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearPblPublishedCache();
    vi.restoreAllMocks();
  });

  function answer(init: { status: number } | Error) {
    const mock = vi.fn(() =>
      init instanceof Error ? Promise.reject(init) : Promise.resolve({ status: init.status }),
    );
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("reads a 200 as published", async () => {
    answer({ status: 200 });
    await expect(pblYearPublished(URL_A)).resolves.toBe(true);
  });

  it.each([404, 410])("reads a %i as not published", async (status) => {
    answer({ status });
    await expect(pblYearPublished(URL_A)).resolves.toBe(false);
  });

  // Fail open: the server answered, but not with "it is not there".
  it.each([403, 405, 500, 503])("treats %i as published", async (status) => {
    answer({ status });
    await expect(pblYearPublished(URL_A)).resolves.toBe(true);
  });

  // Offline, DNS failure, CORS — fetch rejects rather than answering.
  it("treats an unreachable server as published", async () => {
    answer(new TypeError("Failed to fetch"));
    await expect(pblYearPublished(URL_A)).resolves.toBe(true);
  });

  it("asks with HEAD, not GET — nothing here reads the body", async () => {
    const mock = answer({ status: 200 });
    await pblYearPublished(URL_A);
    expect(mock).toHaveBeenCalledWith(URL_A, { method: "HEAD" });
  });

  /**
   * Switching tabs back and forth must not re-ask: the answer is a property of
   * PBL's server, not of anything the user just did.
   */
  it("asks once per URL", async () => {
    const mock = answer({ status: 404 });
    await Promise.all([pblYearPublished(URL_A), pblYearPublished(URL_A)]);
    await pblYearPublished(URL_A);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("createPblYearAvailability", () => {
  const URL_2024 = "https://infographics.pbl.nl/2024.csv";
  const URL_2026 = "https://infographics.pbl.nl/2026.csv";

  beforeEach(() => {
    clearPblPublishedCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearPblPublishedCache();
    vi.restoreAllMocks();
  });

  /** Let queued Solid effects run and any settled promise continue. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * Resolve each URL with its own status, but only when the test says so, so a
   * probe can be left in flight while the active tab moves on.
   */
  function router(byUrl: Record<string, number>) {
    const pending: Array<{ url: string; answer: () => void }> = [];
    const fetchMock = vi.fn(
      (url: string) =>
        new Promise<{ status: number }>((resolve) => {
          pending.push({ url, answer: () => resolve({ status: byUrl[url] ?? 200 }) });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return {
      /** Answer every request issued so far. */
      release: async () => {
        pending.splice(0).forEach((entry) => entry.answer());
        await tick();
      },
      /** Answer only the request for `url`, so answers can arrive out of order. */
      releaseUrl: async (url: string) => {
        for (let i = pending.length - 1; i >= 0; i -= 1) {
          if (pending[i].url === url) pending.splice(i, 1)[0].answer();
        }
        await tick();
      },
      fetchMock,
    };
  }

  it("is null until the probe answers, then reports it", async () => {
    const net = router({ [URL_2026]: 404 });
    await createRoot(async (dispose) => {
      const available = createPblYearAvailability(() => URL_2026);
      expect(available()).toBeNull();
      await tick();
      // The request is out but unanswered: still nothing to report.
      expect(available()).toBeNull();

      await net.release();
      expect(available()).toBe(false);
      dispose();
    });
  });

  it("re-probes when the tab changes", async () => {
    const net = router({ [URL_2024]: 200, [URL_2026]: 404 });
    await createRoot(async (dispose) => {
      const [url, setUrl] = createSignal(URL_2026);
      const available = createPblYearAvailability(url);
      await tick();
      await net.release();
      expect(available()).toBe(false);

      setUrl(URL_2024);
      await tick();
      expect(available()).toBeNull();
      await net.release();
      expect(available()).toBe(true);
      dispose();
    });
  });

  /**
   * The silent one. A slow probe for the year the user just left must not land
   * on the year they are now looking at — that is how an unpublished year ends
   * up rendering a frame, with nothing on screen to say the answer was stale.
   *
   * The 2024 probe is issued first and answers LAST, so a version that just
   * assigns whatever arrives would end on `true` and frame the empty viewer.
   */
  it("ignores an answer for a tab that is no longer active", async () => {
    const net = router({ [URL_2024]: 200, [URL_2026]: 404 });
    await createRoot(async (dispose) => {
      const [url, setUrl] = createSignal(URL_2024);
      const available = createPblYearAvailability(url);
      await tick();

      setUrl(URL_2026);
      await tick();
      expect(net.fetchMock).toHaveBeenCalledTimes(2);

      // The active tab answers first...
      await net.releaseUrl(URL_2026);
      expect(available()).toBe(false);

      // ...and the abandoned one answers after, with the opposite verdict. It
      // must be dropped: without the guard this flips to true and the empty
      // 2026 viewer gets framed.
      await net.releaseUrl(URL_2024);
      expect(available()).toBe(false);
      dispose();
    });
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
  function setup(initial: string | null, initialPage = "/pbl-samenvatting.html") {
    return createRoot((dispose) => {
      const [pick, setPick] = createSignal<{ code: string | null }>({ code: initial });
      const [page, setPage] = createSignal(initialPage);
      const status = createPblSummaryStatus(() => pick().code, page);
      return {
        status,
        dispose,
        pickAgain: (code: string | null) => setPick({ code }),
        switchTab: setPage,
      };
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
   * Switching model-year tabs reloads the frame while the neighbourhood stays
   * the same. A status keyed on the buurt code alone would hold the previous
   * tab's "ready" and leave the new frame loading uncovered — nothing errors,
   * the user just watches an empty viewer that the app believes has arrived.
   */
  it("re-arms when the tab changes under an unchanged neighbourhood", () => {
    useTimers();
    const { status, switchTab, dispose } = setup("BU05690302");
    report("pbl-summary-ready");
    expect(status()).toBe("ready");

    switchTab("/pbl-samenvatting-2026.html");
    expect(status()).toBe("loading");

    // ...and the new frame's own verdict is still heard, so the splash lifts
    // again rather than sticking on the second tab.
    report("pbl-summary-ready");
    expect(status()).toBe("ready");
    dispose();
    vi.useRealTimers();
  });

  // Re-selecting the tab already on screen leaves the frame untouched, so there
  // is no new load to cover and the verdict must stand.
  it("keeps its verdict when the tab is set to the one already showing", () => {
    useTimers();
    const { status, switchTab, dispose } = setup("BU05690302");
    report("pbl-summary-ready");

    switchTab("/pbl-samenvatting.html");
    expect(status()).toBe("ready");
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
