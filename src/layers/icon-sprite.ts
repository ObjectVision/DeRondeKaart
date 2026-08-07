/**
 * Sprite-image helpers shared by every layer path that draws an icon.
 *
 * MapLibre draws icons from images registered in the map's sprite, and only
 * SDF images honour `icon-color` — so a tinted icon must be added with
 * `{ sdf: true }` and an untinted one without (an SDF image drawn untinted
 * renders as a flat silhouette). Callers therefore key their sprite ids on
 * tint-ness; see `iconSpriteId` in mvt-style.ts for the config-layer scheme.
 */

/**
 * Rasterize an SVG (or bitmap) URL to an ImageBitmap at the given pixel size.
 * MapLibre's `loadImage` cannot decode SVG, so it goes through an <img> first.
 *
 * `width`/`height` set the RASTERIZATION resolution, which is independent of
 * the drawn size: registering the result with `{ pixelRatio: N }` declares it
 * as N device pixels per logical pixel, so a supersampled bitmap stays crisp
 * on a hi-res capture while `icon-size` still multiplies the logical size.
 */
export async function loadIconBitmap(
  url: string,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  const image = new Image(width, height);
  image.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`could not load icon image: ${url}`));
    image.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2d context to rasterize the icon");
  ctx.drawImage(image, 0, 0, width, height);
  return createImageBitmap(canvas);
}
