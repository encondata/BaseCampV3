/**
 * Image elements in the builder core (spec 2026-10-20-badge-templates
 * §4.3, §4.5, §4.12). The canvas never decodes a picture: it asks the
 * server for the element's gray raster (POST /labels/images/raster, the
 * same prep the compiler's pictures get), dithers it with dither.ts and
 * paints the dots, so it shows exactly what prints.
 *
 * - The picture fits the element's unrotated w x h box in whole dots
 *   (labels/zpl.py `image_box_dots`), then turns with the element by exact
 *   transposition, so the raster is the footprint: h wide and w tall at 90
 *   and 270. The compiler puts it at the footprint's top-left (^FO x, y).
 * - A photo or a logo is the sample person's: the template's samples hold
 *   the person under the reserved key `person:id`. With no sample person
 *   there is nothing to ask for; a static image needs its library id.
 * - A raster depends on the picture, the box in dots, the fit, the turn and
 *   the DPI, never on the look (brightness, contrast, threshold, mode,
 *   invert): those are the canvas's own dither, so changing them never
 *   asks the server again.
 * - Black dots paint opaque black and white ones transparent: a printer
 *   can't print white over black, so what lies under a picture shows
 *   through its white.
 */

import { bytesPerRow } from './dither';
import { IMAGE_DEFAULTS, imageFit, type ImageElement, type ImageFit, type ImageSource, type Rotation } from './model';
import { toDots } from './units';

/** The samples' reserved key for the sample person (Load from person…). */
export const PERSON_SAMPLE_KEY = 'person:id';

/** The 2-dot ^GB outline an empty picture prints with hide-when-empty off
 *  (labels/zpl.py EMPTY_IMAGE_STROKE). */
export const EMPTY_IMAGE_STROKE_DOTS = 2;

/** A new image's box in inches: a photo portrait, a logo or a static
 *  picture landscape. */
export const IMAGE_SIZES: Readonly<Record<ImageSource, { w: number; h: number }>> = {
  photo: { w: 0.8, h: 1 },
  logo: { w: 1, h: 0.5 },
  static: { w: 1, h: 0.5 },
};

const NAMES: Readonly<Record<ImageSource, string>> = { photo: 'Photo', logo: 'Logo', static: 'Image' };

/** What the builder calls an image: Photo, Logo or Image (a static one). */
export function imageName(el: ImageElement): string {
  return NAMES[el.source] ?? 'Image';
}

/** The unrotated box the picture is fitted to, in dots. */
export function imageBoxDots(el: ImageElement, dpi: number): { w: number; h: number } {
  return { w: toDots(el.w, dpi), h: toDots(el.h, dpi) };
}

/** The raster's size: the box, turned with the element. */
export function imageRasterSize(el: ImageElement, dpi: number): { width: number; height: number } {
  const { w, h } = imageBoxDots(el, dpi);
  return el.rotation === 90 || el.rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

/** The sample person's id as stored, or null when the template has none.
 *  Never trimmed: the server reads `person:id` as it is (only "" is no
 *  one), so the canvas asks for the person the preview and Test print
 *  print; Load from person… only ever writes a clean id. */
export function samplePersonId(samples: Readonly<Record<string, string>>): string | null {
  const id = Object.hasOwn(samples, PERSON_SAMPLE_KEY) ? samples[PERSON_SAMPLE_KEY] : '';
  return typeof id === 'string' && id ? id : null;
}

/** POST /labels/images/raster's body (lib/api.ts LabelImageRasterBody). */
export interface RasterRequest {
  source: ImageSource;
  image_id?: string;
  person_id?: string;
  w_in: number;
  h_in: number;
  dpi: number;
  fit: ImageFit;
  rotation: Rotation;
}

/** What the canvas asks the server for to draw `el` at `dpi`, or null when
 *  there is nothing to ask: a photo or logo with no sample person, a static
 *  image with no picture picked, a box under a dot. */
export function rasterRequest(el: ImageElement, dpi: number, personId: string | null): RasterRequest | null {
  const { w, h } = imageBoxDots(el, dpi);
  if (!(w > 0 && h > 0)) return null;
  const source = Object.hasOwn(IMAGE_DEFAULTS, el.source) ? el.source : null;
  if (!source) return null;
  const base = { w_in: el.w, h_in: el.h, dpi, fit: imageFit(el), rotation: el.rotation };
  if (source === 'static') {
    return typeof el.imageId === 'string' && el.imageId ? { source, image_id: el.imageId, ...base } : null;
  }
  return personId ? { source, person_id: personId, ...base } : null;
}

/** The cache key of a request's raster: what the server's picture depends
 *  on, the box in whole dots (a hair inside the same dot is the same
 *  picture). */
export function rasterKey(req: RasterRequest): string {
  const subject = req.source === 'static' ? req.image_id : req.person_id;
  return JSON.stringify([req.source, subject ?? null, toDots(req.w_in, req.dpi), toDots(req.h_in, req.dpi),
    req.dpi, req.fit, req.rotation]);
}

/** Packed 1-bit rows (dither.ts) as RGBA for a canvas ImageData: a black
 *  dot opaque black, a white one transparent; pad bits never show. */
export function bitsToRgba(bits: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const stride = bytesPerRow(width);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      if (bits[row + (x >> 3)] & (0x80 >> (x & 7))) out[(y * width + x) * 4 + 3] = 255;
    }
  }
  return out;
}
