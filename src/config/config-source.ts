/**
 * Where the runtime config files come from, when not this origin.
 *
 * `?config=<base-url>` points the nine config JSONs at a folder somewhere else
 * — typically a folder in another GitHub repository, served by
 * `raw.githubusercontent.com`, which sends `Access-Control-Allow-Origin: *` so
 * the browser may read it. A project then needs new JSON, not a new build.
 *
 * **Why this is allowlisted rather than open.** A config decides the HTML this
 * app assigns to `innerHTML` (click templates in feature-info, the about
 * dialog's fragments, layer metainfo) and every data URL it fetches. Whoever
 * controls the config therefore controls script execution ON THIS ORIGIN, with
 * access to everything the page can reach. An unrestricted `?config=` would
 * mean that anyone who gets a link into someone's address bar runs code as this
 * site, which is a cross-site-scripting hole with a nicer name.
 *
 * So the parameter is only honoured when it matches `configSources` in the
 * BUILT map.json — the one served from this origin, fetched before any remote
 * config is considered. Putting the allowlist in the remote config instead
 * would let a hostile config widen its own permissions, which is no allowlist
 * at all.
 */

/** URL parameter naming the folder to load the config files from. */
export const CONFIG_PARAM = "config";

/**
 * Canonical form of a config base, or null when it is not usable as one.
 *
 * Rejections are deliberate rather than tidy-ups:
 * - non-`https:` keeps the config off plaintext transport, where anyone on the
 *   path could rewrite the very HTML this app will inject;
 * - credentials in the URL would be sent to the config host and shared with
 *   every copy of the link;
 * - a query or fragment means the caller is pointing at something other than a
 *   folder, and `configPath` appends `/<name>.json` to this string.
 *
 * The trailing slash goes so that concatenation in `configPath` cannot double
 * it, and so prefix matching below has exactly one spelling to compare.
 */
function canonicalBase(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  return url.href.replace(/\/+$/, "");
}

/**
 * Whether `base` sits at or under the allowlist entry `entry`.
 *
 * The `/` in the prefix test is load-bearing: a bare `startsWith` would let the
 * entry `https://host/ObjectVision` admit `https://host/ObjectVisionEvil/...`,
 * which is a different account and the whole point of the check.
 */
function matchesEntry(base: string, entry: string): boolean {
  const allowed = canonicalBase(entry);
  if (!allowed) {
    console.warn(`map.json: unusable "configSources" entry ${JSON.stringify(entry)}; ignoring`);
    return false;
  }
  return base === allowed || base.startsWith(`${allowed}/`);
}

/**
 * The config base to actually use, or null to stay with this origin's own.
 *
 * Every refusal falls back rather than failing: a link carrying a config this
 * deployment does not accept should open the deployment's own map, not a broken
 * page. The warning is what tells an operator their allowlist needs widening.
 */
export function resolveConfigBase(
  requested: string | null | undefined,
  allowed: readonly string[],
): string | null {
  if (!requested) return null;

  const base = canonicalBase(requested);
  if (!base) {
    console.warn(`?${CONFIG_PARAM}=${requested}: not a usable https folder URL; ignoring`);
    return null;
  }
  if (allowed.length === 0) {
    console.warn(
      `?${CONFIG_PARAM} given but map.json lists no "configSources"; ignoring. ` +
        `Add the config's URL prefix there to allow it.`,
    );
    return null;
  }
  if (!allowed.some((entry) => matchesEntry(base, entry))) {
    console.warn(
      `?${CONFIG_PARAM}=${base} is not in map.json's "configSources"; ignoring.`,
    );
    return null;
  }
  return base;
}

/** The raw `?config=` value from a query string, or null when absent. */
export function requestedConfigBase(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get(CONFIG_PARAM);
}
