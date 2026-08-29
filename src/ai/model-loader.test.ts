import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { createModelLoader } from "@/ai/model-loader";

/**
 * A controllable stand-in for the chunked fetch. Each url's promise is resolved
 * by hand, which is how the ORDER of the two downloads is asserted rather than
 * assumed.
 */
function stubIdleFetch() {
  const pending = new Map<
    string,
    { resolve: (v: ArrayBuffer) => void; reject: (e: unknown) => void }
  >();
  const calls: string[] = [];
  const fn = vi.fn(
    (url: string) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        calls.push(url);
        pending.set(url, { resolve, reject });
      }),
  );
  return {
    fn,
    calls,
    finish(match: string) {
      const key = [...pending.keys()].find((k) => k.includes(match));
      if (!key) throw new Error(`nothing pending for ${match}`);
      pending.get(key)!.resolve(new ArrayBuffer(8));
      pending.delete(key);
    },
    fail(match: string) {
      const key = [...pending.keys()].find((k) => k.includes(match));
      if (!key) throw new Error(`nothing pending for ${match}`);
      pending.get(key)!.reject(new Error("download failed"));
      pending.delete(key);
    },
  };
}

const stub = stubIdleFetch();
vi.mock("@/lib/idle-fetch", () => ({
  idleFetch: (url: string) => stub.fn(url),
}));

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function withLoader<T>(
  opts: { textToTool: boolean; speechToText: boolean },
  body: (l: ReturnType<typeof createModelLoader>) => T,
): T {
  return createRoot((dispose) => {
    const l = createModelLoader({
      map: () => null,
      urls: {
        needleWeights: "https://data.example/models/needle2/needle2.cact",
        voskModel: "https://data.example/models/vosk-nl/vosk.tar.gz",
      },
      ...opts,
    });
    try {
      return body(l);
    } finally {
      dispose();
    }
  });
}

describe("createModelLoader", () => {
  afterEach(() => {
    stub.calls.length = 0;
    stub.fn.mockClear();
  });

  // Nothing may download until the user asks for it.
  it("downloads nothing before start()", async () => {
    withLoader({ textToTool: true, speechToText: true }, (l) => {
      expect(l.needle().state).toBe("idle");
      expect(l.vosk().state).toBe("idle");
    });
    await flush();
    expect(stub.calls).toEqual([]);
  });

  // A config that turns the feature on but names no model host has nothing to
  // fetch; it must stay quiet rather than request a relative path that 404s.
  it("downloads nothing when no model URL is configured", async () => {
    createRoot((dispose) => {
      const l = createModelLoader({
        map: () => null,
        textToTool: true,
        speechToText: true,
        urls: {},
      });
      l.start();
      dispose();
    });
    await flush();
    expect(stub.calls).toEqual([]);
  });

  it("downloads nothing when text_to_tool is off", async () => {
    withLoader({ textToTool: false, speechToText: true }, (l) => l.start());
    await flush();
    expect(stub.calls).toEqual([]);
  });

  /**
   * The ordering requirement: speech weights must not begin until the parser's
   * are in hand, so the two never compete for bandwidth.
   */
  it("starts Vosk only after Needle has finished", async () => {
    await withLoader({ textToTool: true, speechToText: true }, async (l) => {
      l.start();
      await flush();

      expect(stub.calls.some((u) => u.includes("needle"))).toBe(true);
      expect(stub.calls.some((u) => u.includes("vosk"))).toBe(false);

      stub.finish("needle");
      await flush();

      expect(l.needleReady()).toBe(true);
      expect(stub.calls.some((u) => u.includes("vosk"))).toBe(true);
      expect(l.voskReady()).toBe(false);

      stub.finish("vosk");
      await flush();
      expect(l.voskReady()).toBe(true);
    });
  });

  it("never fetches the speech model when speech is off", async () => {
    await withLoader({ textToTool: true, speechToText: false }, async (l) => {
      l.start();
      await flush();
      stub.finish("needle");
      await flush();

      expect(l.needleReady()).toBe(true);
      expect(stub.calls.some((u) => u.includes("vosk"))).toBe(false);
    });
  });

  it("is safe to start repeatedly", async () => {
    await withLoader({ textToTool: true, speechToText: false }, async (l) => {
      l.start();
      l.start();
      l.start();
      await flush();
      expect(stub.calls.filter((u) => u.includes("needle"))).toHaveLength(1);
    });
  });

  // Needle failing must not strand the UI in "loading" forever, and must not
  // start a speech download that has nothing to feed.
  it("reports failure and skips speech when the parser fails", async () => {
    await withLoader({ textToTool: true, speechToText: true }, async (l) => {
      l.start();
      await flush();
      stub.fail("needle");
      await flush();

      expect(l.needle().state).toBe("failed");
      expect(stub.calls.some((u) => u.includes("vosk"))).toBe(false);
    });
  });
});
