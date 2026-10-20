/**
 * The request bodies behind the builder's printer-rendered preview (spec
 * §4.7): compile the v2 design with the template's sample values
 * (`POST /labels/templates/compile`), then render that ZPL with the open
 * fonts the design uses embedded (`POST /labels/preview/zpl`, `font_ids`).
 * The resident Swiss cut is never sent: the preview draws it with the
 * printer's font 0, the same face.
 *
 * Pictures never go to Labelary (an outside service): the preview's
 * compile asks for `image_mode: "placeholder"`, so every image element
 * renders as a placeholder; the canvas and Test print use the real
 * pictures (every other compile leaves `image_mode` out: "print"). A
 * badge's samples still carry its sample person (`person:id`) for its
 * text. A big ZPL is past PREVIEW_MAX_CHARS, and the preview route won't
 * take it.
 */

import { familyInfo, fontObject, metricsFile, type FontRef, type FontWeight } from './fonts';
import { serializeDesign, type DesignV2, type ElementV2 } from './model';

/** The longest ZPL POST /labels/preview/zpl renders. */
export const PREVIEW_MAX_CHARS = 250_000;

/** Whether `zpl` is past what the preview renders. */
export function previewTooLarge(zpl: string): boolean {
  return zpl.length > PREVIEW_MAX_CHARS;
}

export interface CompileBody {
  kind: 'design';
  design: DesignV2;
  size_key: string;
  dpi_key: string;
  language_key: 'zpl';
  mode: 'sample';
  /** Field key → sample value: what the design prints with; a badge's
   *  sample person under `person:id`. */
  samples: Record<string, string>;
  /** The template's label type: only its fields take mock values, so a key
   *  of another type previews blank, as it prints. */
  label_type: string;
  /** Images as placeholders: no picture is sent to Labelary. */
  image_mode: 'placeholder';
}

export interface PreviewZplBody {
  zpl: string;
  size_key: string;
  dpi_key: string;
  /** Library fonts to embed for the preview (~DY). */
  font_ids: string[];
}

export interface PreviewRequest {
  compile: CompileBody;
  /** The preview body for the ZPL the compile call returned. */
  preview(zpl: string): PreviewZplBody;
}

/** A font library row (`GET /labels/fonts`, lib/api.ts LabelFont). */
export interface LibraryFont {
  id: string;
  family?: string | null;
  weight?: 'regular' | 'bold' | null;
  resident?: boolean;
}

/** Both bodies for previewing `design` at `dpi` with `samples`, the open
 *  fonts `fontIds` embedded. `sizeKey` and `labelType` are the template's;
 *  the bodies hold copies of what they are given. */
export function previewRequest(design: DesignV2, dpi: number, samples: Readonly<Record<string, string>>,
  fontIds: readonly string[], sizeKey: string, labelType: string): PreviewRequest {
  const dpiKey = String(dpi);
  const ids = [...fontIds];
  return {
    compile: {
      kind: 'design',
      design: serializeDesign(design),
      size_key: sizeKey,
      dpi_key: dpiKey,
      language_key: 'zpl',
      mode: 'sample',
      samples: { ...samples },
      label_type: labelType,
      image_mode: 'placeholder',
    },
    preview: (zpl) => ({ zpl, size_key: sizeKey, dpi_key: dpiKey, font_ids: [...ids] }),
  };
}

/** Static text, and a field shown as text or a number: the elements that
 *  print with a font (a barcode or QR code prints none). */
function printsText(el: ElementV2): el is Extract<ElementV2, { font?: FontRef }> {
  return el.type === 'text' || (el.type === 'field' && (el.display === 'text' || el.display === 'number'));
}

/** One printer object a design's text prints with. `weight` is the file's
 *  (faux Bold prints the Regular file). */
export interface DesignFont {
  family: string;
  weight: FontWeight;
  object: string;
}

/** The printer objects `design`'s text prints with, once each, in order of
 *  first use, resident ones included: the TS side of labels/template_fonts.py
 *  `design_fonts`, for checking a printer has them. A family the builder
 *  doesn't know is left out. */
export function designFonts(design: DesignV2): DesignFont[] {
  const out: DesignFont[] = [];
  for (const el of design.elements) {
    if (!printsText(el) || !el.font) continue;
    const object = fontObject(el.font);
    if (!object || out.some((f) => f.object === object)) continue;
    out.push({ family: el.font.family, weight: metricsFile(el.font).weight, object });
  }
  return out;
}

/** The library files `design`'s text prints with that a preview must embed,
 *  once each, in order of first use: one per family and weight its static
 *  text and text or number fields use (faux Bold prints the Regular file;
 *  a library with no Bold file for a family prints its Regular too), never
 *  a resident font (labels/template_fonts.py `design_fonts`). A font
 *  missing from the library is left out. */
export function fontIdsFor(design: DesignV2, library: readonly LibraryFont[]): string[] {
  const find = (f: FontRef) => library.find((row) => row.family === f.family && row.weight === f.weight);
  const ids: string[] = [];
  for (const el of design.elements) {
    if (!printsText(el)) continue;
    if (!el.font || familyInfo(el.font.family)?.resident) continue;
    const file = metricsFile(el.font);
    const row = find(file) ?? (file.weight === 'bold' ? find({ ...file, weight: 'regular' }) : undefined);
    if (row && !row.resident && !ids.includes(row.id)) ids.push(row.id);
  }
  return ids;
}
