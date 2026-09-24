import type { ClassRef } from "@/components/ui/CombineLayersDialog";
import type { FilterLayerDef, ScoreClass } from "@/layers/filter-layers";

/**
 * The `combi` share-link parameter: every combination on the map, plus the
 * combinations those are built on (sources first), as one base64url-encoded
 * JSON array.
 *
 * Combinations are built in-session and have no entry in `layers.json`, so a
 * link can only carry them by carrying their whole definition — name, the
 * layer/rule references, the legend the user edited, and the timeseries step
 * each source raster was read at. The recipient rebuilds the score grid from
 * that (`useFilterLayers.restore`).
 *
 * One param for the whole set rather than one per combination: the array keeps
 * its own order, and there is a single thing to validate before handing it to
 * the rebuild. The cost is that a truncated param loses every combination
 * instead of one — deliberate, because a half-restored set would leave some
 * `cmd=add` commands resolving and others warning, and a map that looks
 * complete but is not.
 */

/** Hash parameter holding the whole set. Named in one place, read in two. */
export const COMBI_PARAM = "combi";

/** Encode the definitions for one `combi` param. */
export function encodeFilterLayerParam(defs: FilterLayerDef[]): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(defs)));
}

/**
 * Read a `combi` param back.
 *
 * Returns `null` rather than throwing or half-decoding: the input is an
 * arbitrary string out of someone else's URL, so every field is checked before
 * it becomes a definition. A rejected param is warned about and skipped by the
 * caller, the way a bad `annot` or `basemap` already is.
 */
export function parseFilterLayerParam(raw: string): FilterLayerDef[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  const defs: FilterLayerDef[] = [];
  for (const item of parsed) {
    const def = toDef(item);
    // One bad element rejects the whole param — see the module comment.
    if (!def) return null;
    defs.push(def);
  }
  return defs;
}

/**
 * Base64url, not base64: `+` and `/` are meaningful in a URL and `=` is noise
 * that URLSearchParams would percent-encode into `%3D`.
 *
 * Goes through TextEncoder rather than `btoa(JSON.stringify(...))` because
 * `btoa` is Latin-1 only and throws InvalidCharacterError above U+00FF. A
 * combination name is free text the user can paste a `€`, an `–` or an emoji
 * into, so the naive form passes every ASCII test and breaks on real input.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** One array element, validated field by field, or `null`. */
function toDef(item: unknown): FilterLayerDef | null {
  if (!isRecord(item)) return null;
  if (!nonEmptyString(item.id) || typeof item.name !== "string") return null;

  const refs = toRefs(item.refs);
  const classes = toClasses(item.classes);
  if (!refs || !classes) return null;

  const def: FilterLayerDef = { id: item.id, name: item.name, refs, classes };
  const steps = toSteps(item.steps);
  if (steps === null) return null;
  if (steps) def.steps = steps;
  return def;
}

function toRefs(value: unknown): ClassRef[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const refs: ClassRef[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (!nonEmptyString(item.layerId) || !nonEmptyString(item.ruleName)) return null;
    // Present only on a class of a combination used as a criterion. Links from
    // before that existed carry none, and still parse.
    if (item.score === undefined) {
      refs.push({ layerId: item.layerId, ruleName: item.ruleName });
      continue;
    }
    if (typeof item.score !== "number" || !Number.isInteger(item.score) || item.score < 1) {
      return null;
    }
    refs.push({ layerId: item.layerId, ruleName: item.ruleName, score: item.score });
  }
  return refs;
}

function toClasses(value: unknown): ScoreClass[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const classes: ScoreClass[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (typeof item.label !== "string" || !nonEmptyString(item.color)) return null;
    classes.push({ label: item.label, color: item.color });
  }
  return classes;
}

/**
 * `undefined` when absent (a combination over layers without a timeseries),
 * `null` when present but malformed — which rejects the whole param, since a
 * dropped step would silently score the wrong year.
 */
function toSteps(value: unknown): Record<string, number> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const steps: Record<string, number> = {};
  for (const [layerId, step] of Object.entries(value)) {
    if (typeof step !== "number" || !Number.isFinite(step)) return null;
    steps[layerId] = step;
  }
  return steps;
}
