import { createSignal, type Accessor } from "solid-js";
import { idleFetch, type IdleSource } from "@/lib/idle-fetch";

/**
 * Downloading the two models, in order, without slowing the map down.
 *
 * The sequence is the requirement, not an implementation detail:
 *
 *   idle -> (user opens search) -> Needle -> Vosk
 *
 * Nothing starts on page load. Needle starts when the user first opens the
 * search popover. Vosk is chained off Needle's promise, so it cannot begin
 * early and the two never compete — with each other or with the map, since both
 * go through the idle gate in `idle-fetch.ts`.
 */

export type LoadState = "idle" | "loading" | "ready" | "failed";

export interface ModelProgress {
  state: LoadState;
  /** 0..1, or null before a total is known. */
  fraction: number | null;
}

const START: ModelProgress = { state: "idle", fraction: null };

/**
 * Cache keys carry the model revision. An unpinned key would serve a stale
 * model forever after an upstream republish.
 */
const NEEDLE_CACHE = "needle-2.0";
const VOSK_CACHE = "vosk-nl-0.22";

export interface ModelLoaderOptions {
  /** Consulted before every chunk. Null disables gating (tests). */
  map: () => IdleSource | null;
  textToTool: boolean;
  speechToText: boolean;
  /** Absolute URLs on the data host; see `map.json`'s `modelUrls`. */
  urls: { needleWeights?: string; voskModel?: string };
}

export function createModelLoader(options: ModelLoaderOptions) {
  const [needle, setNeedle] = createSignal<ModelProgress>(START);
  const [vosk, setVosk] = createSignal<ModelProgress>(START);

  let started = false;
  let needleBytes: ArrayBuffer | null = null;
  let voskBytes: ArrayBuffer | null = null;

  async function fetchModel(
    url: string,
    cacheName: string,
    set: (p: ModelProgress) => void,
  ): Promise<ArrayBuffer> {
    set({ state: "loading", fraction: null });
    try {
      const bytes = await idleFetch(url, {
        map: options.map(),
        cacheName,
        onProgress: (loaded, total) =>
          set({ state: "loading", fraction: total > 0 ? loaded / total : null }),
      });
      set({ state: "ready", fraction: 1 });
      return bytes;
    } catch (err) {
      console.error(`Failed to load ${url}:`, err);
      set({ state: "failed", fraction: null });
      throw err;
    }
  }

  /**
   * Begin loading. Safe to call repeatedly — the search popover opens and
   * closes, and only the first call does anything.
   */
  function start(): void {
    const needleUrl = options.urls.needleWeights;
    if (started || !options.textToTool || !needleUrl) return;
    started = true;

    void (async () => {
      try {
        needleBytes = await fetchModel(needleUrl, NEEDLE_CACHE, setNeedle);
      } catch {
        // Needle failed: the bar keeps working as a location search, and Vosk
        // is pointless without a parser to feed, so stop here.
        return;
      }
      const voskUrl = options.urls.voskModel;
      if (!options.speechToText || !voskUrl) return;
      try {
        voskBytes = await fetchModel(voskUrl, VOSK_CACHE, setVosk);
      } catch {
        // Speech stays unavailable; typed commands are unaffected.
      }
    })();
  }

  return {
    start,
    needle: needle as Accessor<ModelProgress>,
    vosk: vosk as Accessor<ModelProgress>,
    /** Ready when the weights are in hand. */
    needleReady: () => needle().state === "ready",
    voskReady: () => vosk().state === "ready",
    needleWeights: () => needleBytes,
    voskWeights: () => voskBytes,
  };
}

export type ModelLoader = ReturnType<typeof createModelLoader>;
