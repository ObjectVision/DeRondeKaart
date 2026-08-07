import type { Map as MapLibreMap } from "maplibre-gl";
import { loadIconBitmap } from "./icon-sprite";
import { ANNOT_ICON_IDS } from "./annotation-style";

/**
 * Register the annotation overlay's sprite images.
 *
 * All four glyphs are single-color masks (deck drew them with `mask: true`),
 * so they are added as **SDF** images — only SDF images honour `icon-color`,
 * which is what tints a pin to its author's identity color and a cursor to its
 * peer's. The label box is SDF for the same reason, plus `stretchX`/`stretchY`
 * so `icon-text-fit` can stretch it around a title without distorting the
 * rounded corners.
 *
 * `scale` supersamples the rasterization and is declared back to MapLibre as
 * `pixelRatio`, which decouples texture resolution from drawn size exactly as
 * deck's icon atlas did: `icon-size` still multiplies the logical 24px, so the
 * hi-res PNG export can rasterize at 8× and stay crisp without drawing bigger.
 */

const ICON_BASE_PX = 24;

/** The label pill: a 20×20 rounded rect, corners preserved by the stretch box. */
const LABEL_BOX_ID = "annot-label-box";
const LABEL_BOX_PX = 20;
/** Stretch only the middle band, so the 6px corners stay square-ish. */
const LABEL_BOX_STRETCH: [number, number][] = [[8, 12]];
/** Text is placed inside this content box. */
const LABEL_BOX_CONTENT: [number, number, number, number] = [6, 6, 14, 14];

const MASK_ICONS: Array<{ id: string; url: string }> = [
  { id: ANNOT_ICON_IDS.pin, url: "/location-pin.svg" },
  { id: ANNOT_ICON_IDS.circle, url: "/annotation-circle.svg" },
  { id: ANNOT_ICON_IDS.polygon, url: "/annotation-polygon.svg" },
  { id: ANNOT_ICON_IDS.cursor, url: "/cursor-arrow.svg" },
];

/** In-flight registrations per map, so concurrent callers don't double-add. */
const pending = new WeakMap<MapLibreMap, Promise<void>>();

/**
 * Ensure every annotation sprite image is on the map. Idempotent, and safe to
 * call again after a basemap swap — `setStyle()` wipes the sprite, so
 * `hasImage` is re-checked on every call rather than cached.
 *
 * Returns null when everything is already registered, so the caller can stay
 * synchronous (deferring an add by even a microtask reorders it against the
 * z-order anchors).
 */
export function registerAnnotationIcons(
  map: MapLibreMap,
  scale = 4,
): Promise<void> | null {
  const missing = MASK_ICONS.filter((i) => !map.hasImage(i.id));
  const needsBox = !map.hasImage(LABEL_BOX_ID);
  if (missing.length === 0 && !needsBox) return null;

  const inFlight = pending.get(map);
  if (inFlight) return inFlight;

  const work: Promise<void>[] = missing.map((icon) =>
    loadIconBitmap(icon.url, ICON_BASE_PX * scale, ICON_BASE_PX * scale).then((bitmap) => {
      // Another call (or a style swap) may have registered it meanwhile.
      if (map.hasImage(icon.id)) return;
      map.addImage(icon.id, bitmap, { sdf: true, pixelRatio: scale });
    }),
  );

  if (needsBox) {
    work.push(
      loadIconBitmap("/label-box.png", LABEL_BOX_PX * scale, LABEL_BOX_PX * scale).then(
        (bitmap) => {
          if (map.hasImage(LABEL_BOX_ID)) return;
          map.addImage(LABEL_BOX_ID, bitmap, {
            sdf: true,
            pixelRatio: scale,
            stretchX: LABEL_BOX_STRETCH,
            stretchY: LABEL_BOX_STRETCH,
            content: LABEL_BOX_CONTENT,
          });
        },
      ),
    );
  }

  const all = Promise.all(work)
    .then(() => undefined)
    .catch((err) => {
      console.error("Failed to register annotation icons:", err);
    })
    .finally(() => {
      pending.delete(map);
    });

  pending.set(map, all);
  return all;
}
