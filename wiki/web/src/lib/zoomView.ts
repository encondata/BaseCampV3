/** Zoom and pan for the image viewer. A view is a scale over the image's
 *  fitted size (1 = fit to the screen) plus a pan offset in screen pixels,
 *  measured from the stage's center — the image is drawn as
 *  `translate(x, y) scale(scale)` around its own center. */

export type ZoomView = { scale: number; x: number; y: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

export const FIT: ZoomView = { scale: 1, x: 0, y: 0 };
export const MAX_SCALE = 8;

/** Zooms to `scale`, keeping the image point under `point` (from the
 *  stage's center) where it is on screen. */
export function zoomAt(view: ZoomView, scale: number, point: Point): ZoomView {
  const next = Math.min(MAX_SCALE, Math.max(1, scale));
  if (next === 1) return FIT;
  const k = next / view.scale;
  return { scale: next, x: point.x - k * (point.x - view.x), y: point.y - k * (point.y - view.y) };
}

/** Keeps the image covering the stage while zoomed: it pans only until its
 *  edge meets the stage's edge, and a dimension that fits stays centered.
 *  `image` is the image's fitted size (at scale 1). */
export function clampView(view: ZoomView, image: Size, stage: Size): ZoomView {
  if (view.scale <= 1) return FIT;
  const spareX = Math.max(0, (image.width * view.scale - stage.width) / 2);
  const spareY = Math.max(0, (image.height * view.scale - stage.height) / 2);
  const clamp = (v: number, spare: number) => (spare === 0 ? 0 : Math.min(spare, Math.max(-spare, v)));
  return { scale: view.scale, x: clamp(view.x, spareX), y: clamp(view.y, spareY) };
}
