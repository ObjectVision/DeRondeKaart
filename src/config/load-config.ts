import { configPath, variantCacheKey } from "@/config/variant";

/**
 * Fetch, parse and memoize one runtime config file.
 *
 * Nine JSON files are fetched at runtime, and each loader used to hand-roll the
 * same fetch/warn/cache dance. Their differences are the parts worth stating,
 * so those are the parameters and everything else is in here:
 *
 * - **Caching** is per file AND per config variant, keyed the way
 *   `variantCacheKey` decides. A per-variant file loaded under 2025 and again
 *   under 2026 is two entries, so switching back is instant and never serves the
 *   wrong year.
 * - **Concurrent calls share one fetch.** Several callers awaiting the same file
 *   before it resolves is the normal case (the variant switch warms two at once,
 *   and several components load layers.json on mount), and without this each one
 *   would fetch and parse independently.
 * - **The failure policy** is the caller's choice, because the two are not
 *   interchangeable — see {@link ConfigLoadOptions.onError}.
 */
export interface ConfigLoadOptions<T> {
  /** File name as served, e.g. `"charts.json"`. Variant prefix is added here. */
  name: string;
  /**
   * Turn the parsed JSON into the shape callers want.
   *
   * May be async, and the memoized value is what it resolves to — layers.json
   * uses that to finish its PMTiles id-property prefetch before any caller sees
   * the configs.
   */
  parse: (data: unknown) => T | Promise<T>;
  /**
   * What to do when the file is missing, unreadable, or not JSON.
   *
   * Return a value to degrade to it — the file is optional and the feature it
   * drives simply stays off. That fits seven of the nine.
   *
   * Omit it to rethrow. `layers.json` and `navigation.json` do, because they are
   * structural: an empty catalogue is indistinguishable from a working app with
   * nothing configured, so failing loudly is the only way the problem surfaces.
   * Callers of those already handle the rejection.
   */
  onError?: (reason: string) => T;
}

/** Parsed values per `<cacheKey>\0<name>`; see the class comment on caching. */
const cached = new Map<string, unknown>();
/** In-flight loads, same keys, so concurrent callers share one fetch. */
const inFlight = new Map<string, Promise<unknown>>();

function cacheKeyFor(name: string): string {
  return `${variantCacheKey(name)}\0${name}`;
}

export async function loadConfig<T>(options: ConfigLoadOptions<T>): Promise<T> {
  const key = cacheKeyFor(options.name);

  const hit = cached.get(key);
  if (hit !== undefined) return hit as T;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  // Resolved now, in the same synchronous step as the cache key above, so the
  // two can never disagree: `configPath` reads the active variant, and a switch
  // between key and fetch would file one variant's file under the other's key.
  const url = configPath(options.name);

  const load = (async (): Promise<T> => {
    let data: unknown;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(response.statusText || `HTTP ${response.status}`);
      data = await response.json();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!options.onError) {
        throw new Error(`Failed to load ${options.name}: ${reason}`, { cause: err });
      }
      console.warn(`${options.name}: ${reason}`);
      return options.onError(reason);
    }
    return options.parse(data);
  })();

  inFlight.set(key, load);
  try {
    const value = await load;
    cached.set(key, value);
    return value;
  } finally {
    // Cleared either way: a rejected load must not be replayed to later callers
    // as a permanently poisoned promise.
    inFlight.delete(key);
  }
}

/**
 * Overwrite the memoized value for a file, so later `loadConfig` calls see it.
 *
 * For a config the app itself revises at runtime: the dashboard's
 * `dashboard-reload` message repoints table URLs, and every later reader must
 * get the repointed model rather than the one that was fetched.
 */
export function setCachedConfig<T>(name: string, value: T): void {
  cached.set(cacheKeyFor(name), value);
}

/**
 * Drop memoized configs. Without a name, every file and every variant.
 *
 * The variant switch does NOT call this — both variants stay cached, which is
 * what makes switching back instant. This is for tests, and for a host that
 * replaces a file underneath a running app.
 */
export function clearConfigCache(name?: string): void {
  if (!name) {
    cached.clear();
    inFlight.clear();
    return;
  }
  for (const key of [...cached.keys()]) {
    if (key.endsWith(`\0${name}`)) cached.delete(key);
  }
  for (const key of [...inFlight.keys()]) {
    if (key.endsWith(`\0${name}`)) inFlight.delete(key);
  }
}
