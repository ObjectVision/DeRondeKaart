/**
 * Web Storage access that cannot throw.
 *
 * `localStorage`/`sessionStorage` throw on access in private mode, when a quota
 * is exhausted, and when the embedding page blocks third-party storage — which
 * this app hits routinely, since it runs inside an iframe in Power BI. Every
 * caller wants the same thing: fall back to in-memory state rather than break.
 *
 * These stay at the string level. Callers parse and validate their own values
 * (a boolean flag, a JSON blob), so they keep their own shape checks and only
 * hand the unavailability problem here.
 */

/** The stored string, or null when absent or storage is unavailable. */
export function readStorage(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Persist a string, silently doing nothing when storage is unavailable. */
export function writeStorage(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Unavailable storage is not an error: the caller's in-memory state still
    // works for this session, it just won't survive a reload.
  }
}
