/**
 * Shared types for the annotation tool and its collaborative session.
 *
 * Annotations live in a Yjs document (Y.Map keyed by annotation id), so every
 * value here must be plain JSON — no Map/Set/class instances. The converters
 * below flatten the area filter's Map<string, Set<string>> selection shape.
 */

/** JSON-safe snapshot of the session state captured when a circle is placed. */
export interface AnnotationSnapshot {
  /** areaFilter.selections (Map<string, Set<string>>) flattened to JSON. */
  areaFilterSelections: Array<{ key: string; codes: string[] }>;
  mapA: { layerIds: string[]; hiddenIds: string[] };
  mapB: { layerIds: string[]; hiddenIds: string[] };
  view: { longitude: number; latitude: number; zoom: number };
}

export interface Annotation {
  /** crypto.randomUUID() — also the Y.Map key. */
  id: string;
  center: { lng: number; lat: number };
  /** Circle radius in meters. */
  radiusM: number;
  title: string;
  description: string;
  /** Author's identity color (hex) — tints the circle. */
  color: string;
  /** Author display name. */
  author: string;
  createdAt: number;
  snapshot: AnnotationSnapshot;
}

/** Per-connection ephemeral state broadcast via the Yjs Awareness protocol. */
export interface CollabPresence {
  user: { name: string; color: string };
  /** Geographic cursor position, or null while the pointer is off the map. */
  cursor: { lng: number; lat: number } | null;
  /** Annotation this peer last selected — highlights its circle for others. */
  activeAnnotationId: string | null;
}

/** Flatten the area filter's selection map into the JSON snapshot shape. */
export function selectionsToJson(
  selections: Map<string, Set<string>>,
): AnnotationSnapshot["areaFilterSelections"] {
  return [...selections.entries()].map(([key, codes]) => ({ key, codes: [...codes] }));
}

/** Rebuild the area filter's selection map from a JSON snapshot. */
export function selectionsFromJson(
  json: AnnotationSnapshot["areaFilterSelections"],
): Map<string, Set<string>> {
  return new Map(json.map(({ key, codes }) => [key, new Set(codes)]));
}
