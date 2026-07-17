/**
 * Area filter: server-configured Gemeente/Wijk/Buurt filters (filter.json)
 * plus a module-level selection store shared by both maps.
 *
 * Layers are filtered per level iff their arrow table carries that level's
 * key column (exact match), or — hierarchy fallback — any other known CBS
 * code column (digit-prefix match). Non-matching features render transparent
 * and are skipped during picking.
 */

/** One dropdown in the Filter section, as configured in filter.json. */
export interface AreaFilterEntry {
  /** Display name of the filter, e.g. "Gemeente". */
  name: string;
  /** Parquet source holding the filter's options. */
  source: string;
  /** Field with the code used to filter layers, e.g. "gm_code". */
  key: string;
  /** Field used as the option's display text, e.g. "statnaam". */
  label: string;
  /** Text shown when nothing is selected, e.g. "Alle gemeenten". */
  placeholder: string;
  /**
   * Names of coarser filters this one cascades from. The filter stays disabled
   * until every listed dependency has a selection. Empty/absent = always usable.
   * e.g. "Buurt" -> ["Gemeente", "Wijk"].
   */
  dependsOn?: string[];
}

let cachedEntries: AreaFilterEntry[] | null = null;

function isValidEntry(value: unknown): value is AreaFilterEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const requiredOk = (["name", "source", "key", "label", "placeholder"] as const).every(
    (field) => typeof obj[field] === "string" && obj[field] !== "",
  );
  if (!requiredOk) return false;
  // `dependsOn`, when present, must be an array of strings.
  if (obj.dependsOn !== undefined) {
    if (!Array.isArray(obj.dependsOn) || obj.dependsOn.some((d) => typeof d !== "string")) {
      return false;
    }
  }
  return true;
}

/**
 * Load `public/filter.json`. Never throws: a missing or invalid file yields
 * `[]` (the Filter section is simply not shown). File order is the cascade
 * order, coarse to fine.
 */
export async function loadAreaFilterConfig(): Promise<AreaFilterEntry[]> {
  if (cachedEntries) return cachedEntries;

  let data: unknown;
  try {
    const response = await fetch("/filter.json");
    if (!response.ok) {
      console.warn(`filter.json: failed to load (${response.statusText}); no filters shown`);
      return (cachedEntries = []);
    }
    data = await response.json();
  } catch (err) {
    console.warn("filter.json: not found or invalid JSON; no filters shown", err);
    return (cachedEntries = []);
  }

  if (!Array.isArray(data)) {
    console.warn("filter.json: expected a top-level array; no filters shown");
    return (cachedEntries = []);
  }

  cachedEntries = data.filter((entry) => {
    if (isValidEntry(entry)) return true;
    console.warn(`filter.json: dropping invalid entry ${JSON.stringify(entry)}`);
    return false;
  });
  return cachedEntries;
}

// ---------------------------------------------------------------------------
// Shared selection store (module-level: both maps and picking read it).
// ---------------------------------------------------------------------------

interface AreaFilterLevel {
  /** The level's own key column, e.g. "wk_code". */
  key: string;
  /** Selected raw codes, e.g. "WK088200". */
  codes: Set<string>;
  /** The codes with leading non-digits stripped, e.g. "088200". */
  digits: string[];
}

const store: { version: number; levels: AreaFilterLevel[] } = {
  version: 0,
  levels: [],
};

/** Known CBS code columns for the hierarchy fallback, finest first. */
const CODE_FIELDS = ["bu_code", "wk_code", "gm_code"];

/** Strip leading non-digits: "GM0882" -> "0882". */
function digitsOf(code: string): string {
  return code.replace(/^\D+/, "");
}

/** Hierarchical comparability: either digit string is a prefix of the other. */
function digitsMatch(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Replace the active selection (key field -> selected codes). Empty sets are
 * dropped; an empty overall selection deactivates the filter. Returns the new
 * store version (used for deck.gl updateTriggers).
 */
export function setAreaFilterSelection(selection: Map<string, Set<string>>): number {
  const levels: AreaFilterLevel[] = [];
  for (const [key, codes] of selection) {
    if (codes.size === 0) continue;
    levels.push({ key, codes, digits: [...codes].map(digitsOf) });
  }
  store.levels = levels;
  store.version += 1;
  return store.version;
}

export function getAreaFilterVersion(): number {
  return store.version;
}

export function isAreaFilterActive(): boolean {
  return store.levels.length > 0;
}

// ---------------------------------------------------------------------------
// Arrow-row predicate, used by the layer-factory color accessors.
// ---------------------------------------------------------------------------

interface ArrowColumn {
  get(index: number): unknown;
}

interface ArrowBatch {
  getChild(name: string): ArrowColumn | null;
}

/** Accessor info shape passed by @geoarrow/deck.gl-layers accessors. */
export interface ArrowFilterInfo {
  index: number;
  data: { data: ArrowBatch };
}

interface ResolvedColumn {
  col: ArrowColumn;
  /** true: exact code equality against the level's own key; false: digit-prefix. */
  exact: boolean;
}

/** Per-record-batch memo of resolved test columns, invalidated per version. */
const batchColumnCache = new WeakMap<
  object,
  { version: number; cols: (ResolvedColumn | null)[] }
>();

function resolveColumns(batch: ArrowBatch): (ResolvedColumn | null)[] {
  const cached = batchColumnCache.get(batch);
  if (cached && cached.version === store.version) return cached.cols;

  const cols = store.levels.map<ResolvedColumn | null>((level) => {
    const exact = batch.getChild(level.key);
    if (exact) return { col: exact, exact: true };
    for (const field of CODE_FIELDS) {
      if (field === level.key) continue;
      const fallback = batch.getChild(field);
      if (fallback) return { col: fallback, exact: false };
    }
    return null; // level not applicable to this layer
  });
  batchColumnCache.set(batch, { version: store.version, cols });
  return cols;
}

/**
 * Whether the arrow row behind an accessor `info` passes the active filter.
 * AND across levels, OR within a level; inapplicable levels are skipped;
 * an empty selection passes everything.
 */
export function arrowRowMatchesAreaFilter(info: ArrowFilterInfo): boolean {
  if (store.levels.length === 0) return true;
  const cols = resolveColumns(info.data.data);
  for (let i = 0; i < store.levels.length; i++) {
    const resolved = cols[i];
    if (!resolved) continue;
    const value = resolved.col.get(info.index);
    if (value === null || value === undefined) return false;
    const code = String(value);
    const level = store.levels[i];
    if (resolved.exact) {
      if (!level.codes.has(code)) return false;
    } else {
      const valueDigits = digitsOf(code);
      if (!level.digits.some((d) => digitsMatch(d, valueDigits))) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Plain-props predicate, used by feature picking.
// ---------------------------------------------------------------------------

/** Same semantics as {@link arrowRowMatchesAreaFilter}, over picked props. */
export function featureMatchesAreaFilter(props: Record<string, unknown>): boolean {
  if (store.levels.length === 0) return true;
  for (const level of store.levels) {
    let value = props[level.key];
    let exact = true;
    if (value === undefined) {
      const fallbackField = CODE_FIELDS.find(
        (field) => field !== level.key && props[field] !== undefined,
      );
      if (!fallbackField) continue; // level not applicable
      value = props[fallbackField];
      exact = false;
    }
    if (value === null) return false;
    const code = String(value);
    if (exact) {
      if (!level.codes.has(code)) return false;
    } else if (!level.digits.some((d) => digitsMatch(d, digitsOf(code)))) {
      return false;
    }
  }
  return true;
}
