import type { LayerMetaRoutes } from "./types";

/**
 * The metainfo dialog's tabs, in the order they are shown.
 *
 * One list rather than two: `validateMeta` reads the ids to know which keys of
 * the object form of `meta` mean anything, and the dialog reads the labels. A
 * route added in one place and forgotten in the other would either validate and
 * never render, or render under the wrong name.
 */
export const META_ROUTES = [
  { id: "toelichting", label: "Toelichting" },
  { id: "bronnen", label: "Bronnen" },
  { id: "aannames_en_onzekerheden", label: "Aannames en onzekerheden" },
] as const;

export type MetaRouteId = (typeof META_ROUTES)[number]["id"];

/** One tab: its label and the fragments composing it, in order. */
export interface MetaRoute {
  id: MetaRouteId;
  label: string;
  urls: string[];
}

/** A route's `string | string[]` value as a list of URLs; `[]` when it has none. */
function toUrls(value: string | string[] | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}

/**
 * A layer's `meta` as the tabs to show for it.
 *
 * A plain string or array — startanalyse2026's externally hosted documents, and
 * `woningbouwkaart.html` here — is one **Toelichting** tab. That keeps those
 * configs untouched: the composed document they already produce is exactly what
 * that one tab shows.
 *
 * Only routes with at least one URL come back, which is half of "an empty route
 * shows no tab". The other half is a route whose every fragment fails to load;
 * that can only be known after fetching, so LeafMeta drops those.
 */
export function normalizeMetaRoutes(
  meta: string | string[] | LayerMetaRoutes | undefined,
): MetaRoute[] {
  if (!meta) return [];

  if (typeof meta === "string" || Array.isArray(meta)) {
    const urls = toUrls(meta);
    return urls.length > 0
      ? [{ id: "toelichting", label: META_ROUTES[0].label, urls }]
      : [];
  }

  return META_ROUTES.map(({ id, label }) => ({ id, label, urls: toUrls(meta[id]) })).filter(
    (route) => route.urls.length > 0,
  );
}
