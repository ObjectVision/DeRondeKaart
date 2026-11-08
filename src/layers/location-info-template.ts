/**
 * Renders the "Locatie informatie" template (see LocationInfoConfig) for one
 * parquet row.
 *
 * The template is published HTML, edited outside the app like the metainfo
 * fragments, and injected with innerHTML — so no script in it would run. What a
 * script would have done (pies, sparklines, colouring distances) is expressed as
 * declarative widgets instead: elements whose `data-*` attributes name the row's
 * fields, filled in here. Attributes hold field NAMES, never values, so the only
 * user data that reaches the markup goes through `escapeHtml`.
 *
 * Template structure:
 *
 *   <div data-locationinfo="general">…</div>         the block beside Street View
 *   <section data-tab="id" data-label="…" data-icon="…">…</section>   one per tab
 *   <p data-locationinfo="footer">…</p>
 *
 * Placeholders: `[[ field ]]` or `[[ field | format ]]`, formats in FORMATS.
 * Widgets: `data-pie`, `data-distance`, `data-sparkline` — see their renderers.
 */

export type LocationInfoRow = Record<string, unknown>;

export interface LocationInfoTab {
  id: string;
  label: string;
  icon?: string;
  html: string;
}

export interface RenderedLocationInfo {
  general: string | null;
  tabs: LocationInfoTab[];
  footer: string | null;
}

/** The tab the window adds itself for the other layers that were hit. */
export const RESERVED_TAB_ID = "kaartlagen";

/** Shown for a field the row does not have or holds null. */
const MISSING = "–";

const nl = (digits: number) =>
  new Intl.NumberFormat("nl-NL", { maximumFractionDigits: digits });

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const FORMATS: Record<string, (value: unknown) => string | null> = {
  text: (v) => (v === null || v === undefined || v === "" ? null : String(v)),
  int: (v) => {
    const n = asNumber(v);
    return n === null ? null : nl(0).format(n);
  },
  dec1: (v) => {
    const n = asNumber(v);
    return n === null ? null : nl(1).format(n);
  },
  /** A share already expressed in percent (0–100). */
  pct: (v) => {
    const n = asNumber(v);
    return n === null ? null : `${nl(1).format(n)}%`;
  },
  m: (v) => {
    const n = asNumber(v);
    return n === null ? null : `${nl(0).format(n)} meter`;
  },
  /** `6211AB` → `6211 AB`; anything else unchanged. */
  postcode: (v) => {
    if (v === null || v === undefined || v === "") return null;
    const s = String(v).replace(/\s+/g, "").toUpperCase();
    return /^\d{4}[A-Z]{2}$/.test(s) ? `${s.slice(0, 4)} ${s.slice(4)}` : String(v);
  },
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format one field for display; `–` when missing. Unknown formats fall back to text. */
export function formatValue(value: unknown, format = "text"): string {
  const formatter = FORMATS[format] ?? FORMATS.text;
  return formatter(value) ?? MISSING;
}

/** Substitute `[[ field ]]` / `[[ field | format ]]`, HTML-escaping every value. */
export function renderEscapedTemplate(template: string, row: LocationInfoRow): string {
  return template.replace(
    /\[\[\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\]\]/g,
    (_, key: string, format?: string) => escapeHtml(formatValue(row[key], format)),
  );
}

// --- widgets ---------------------------------------------------------------

/**
 * `<div data-pie data-pie-label="Geschiktheid">` with children
 * `<i data-slice="field" data-color="rgb(…)" data-name="Nultrede"></i>`.
 *
 * Becomes a conic-gradient over the slices, normalised to their sum so rounding
 * in the data cannot leave a gap. The colour sits on the child rather than in a
 * list because `rgb(…)` contains the commas a list would split on.
 */
function renderPies(root: ParentNode, row: LocationInfoRow) {
  for (const pie of Array.from(root.querySelectorAll<HTMLElement>("[data-pie]"))) {
    const slices = Array.from(pie.querySelectorAll<HTMLElement>("[data-slice]")).map((el) => ({
      value: Math.max(0, asNumber(row[el.dataset.slice ?? ""]) ?? 0),
      color: el.dataset.color ?? "#ccc",
      name: el.dataset.name ?? el.dataset.slice ?? "",
    }));
    for (const el of Array.from(pie.querySelectorAll("[data-slice]"))) el.remove();

    const label = pie.dataset.pieLabel ?? "";
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    pie.setAttribute("role", "img");
    if (total <= 0) {
      pie.style.background = "#f3f4f6";
      pie.setAttribute("aria-label", `${label}: geen gegevens`);
      continue;
    }

    let at = 0;
    const stops = slices.map((s) => {
      const from = at;
      at += (s.value / total) * 100;
      return `${s.color} ${from.toFixed(2)}% ${at.toFixed(2)}%`;
    });
    pie.style.background = `conic-gradient(${stops.join(", ")})`;
    const parts = slices.map((s) => `${s.name} ${nl(1).format((s.value / total) * 100)}%`);
    pie.setAttribute("aria-label", `${label}: ${parts.join(", ")}`);
  }
}

const DISTANCE_CLASSES = ["text-green-600", "text-orange-600", "text-red-600"];

/**
 * `<td data-distance="huisarts_afstand" data-breaks="400 1000">` — the text
 * becomes "580 meter", coloured green below the first break, orange below the
 * second, red from there on.
 */
function renderDistances(root: ParentNode, row: LocationInfoRow) {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-distance]"))) {
    const meters = asNumber(row[el.dataset.distance ?? ""]);
    if (meters === null) {
      el.textContent = MISSING;
      el.classList.add("text-gray-400");
      continue;
    }
    const breaks = (el.dataset.breaks ?? "")
      .split(/\s+/)
      .map(Number)
      .filter((b) => Number.isFinite(b));
    const index = breaks.filter((b) => meters >= b).length;
    el.textContent = formatValue(meters, "m");
    el.classList.add(DISTANCE_CLASSES[Math.min(index, DISTANCE_CLASSES.length - 1)]);
  }
}

/** `"2026-2040"` → [2026, …, 2040]; empty for anything malformed. */
function parseYears(spec: string | undefined): number[] {
  const match = /^\s*(\d{4})\s*-\s*(\d{4})\s*$/.exec(spec ?? "");
  if (!match) return [];
  const [from, to] = [Number(match[1]), Number(match[2])];
  if (to < from) return [];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * `<div data-sparkline="aandeel_0_17_{year}" data-years="2026-2040"
 *   data-color="rgb(…)" data-label="0-17 jaar">` — a small card with the trend
 * line and its first and last value (as percentages). Years the row lacks are
 * skipped; with fewer than two points there is no line to draw.
 */
function renderSparklines(root: ParentNode, row: LocationInfoRow) {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-sparkline]"))) {
    const pattern = el.dataset.sparkline ?? "";
    const color = escapeHtml(el.dataset.color ?? "currentColor");
    const label = escapeHtml(el.dataset.label ?? "");
    const points = parseYears(el.dataset.years)
      .map((year) => ({ year, value: asNumber(row[pattern.replace("{year}", String(year))]) }))
      .filter((p): p is { year: number; value: number } => p.value !== null);

    const header =
      `<div class="flex items-center gap-1.5 leading-tight">` +
      `<span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:${color}"></span>` +
      `<span class="text-xs text-gray-500">${label}</span></div>`;

    if (points.length < 2) {
      el.innerHTML = `${header}<div class="my-0.5 text-xs text-gray-400">${MISSING}</div>`;
      continue;
    }

    const values = points.map((p) => p.value);
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    const first = points[0];
    const last = points[points.length - 1];
    const polyline = points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * 100;
        const y = 36 - ((p.value - min) / span) * 32;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const fmt = (v: number) => formatValue(v, "pct");
    const aria = escapeHtml(
      `${el.dataset.label ?? ""}: van ${fmt(first.value)} in ${first.year} naar ${fmt(last.value)} in ${last.year}`,
    );

    el.innerHTML =
      header +
      `<svg viewBox="0 0 100 40" preserveAspectRatio="none" class="my-0.5 h-8 w-full" role="img" aria-label="${aria}">` +
      `<polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="2" ` +
      `stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>` +
      `<div class="flex justify-between text-[11px] font-semibold leading-tight text-gray-900">` +
      `<span>${escapeHtml(fmt(first.value))}</span><span>${escapeHtml(fmt(last.value))}</span></div>`;
  }
}

// --- assembly --------------------------------------------------------------

/** Split a rendered template into the window's parts and fill its widgets. */
export function renderLocationInfo(template: string, row: LocationInfoRow): RenderedLocationInfo {
  const holder = document.createElement("template");
  holder.innerHTML = renderEscapedTemplate(template, row);
  const root = holder.content;

  // innerHTML would not run them anyway; removed so they cannot be mistaken
  // for something that works.
  for (const script of Array.from(root.querySelectorAll("script"))) script.remove();

  renderPies(root, row);
  renderDistances(root, row);
  renderSparklines(root, row);

  const part = (name: string) => {
    const el = root.querySelector<HTMLElement>(`[data-locationinfo="${name}"]`);
    return el ? el.innerHTML : null;
  };

  const tabs: LocationInfoTab[] = [];
  for (const section of Array.from(root.querySelectorAll<HTMLElement>("[data-tab]"))) {
    const id = section.dataset.tab ?? "";
    if (id === "" || id === RESERVED_TAB_ID || tabs.some((t) => t.id === id)) {
      console.warn(`locatie-informatie template: skipping tab "${id}" (empty, reserved or duplicate id)`);
      continue;
    }
    tabs.push({
      id,
      label: section.dataset.label ?? id,
      icon: section.dataset.icon || undefined,
      html: section.innerHTML,
    });
  }

  return { general: part("general"), tabs, footer: part("footer") };
}
