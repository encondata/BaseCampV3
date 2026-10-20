/**
 * The request bodies behind the builder's printer-rendered preview (spec
 * §4.7): compile the v2 design with the template's sample values
 * (`POST /labels/templates/compile`), then render that ZPL with the open
 * fonts the design uses embedded (`POST /labels/preview/zpl`, `font_ids`).
 * The resident Swiss cut is never sent: the preview draws it with the
 * printer's font 0, the same face.
 */

import { familyInfo, metricsFile, type FontRef } from './fonts';
import { serializeDesign, type DesignV2 } from './model';

export interface CompileBody {
  kind: 'design';
  design: DesignV2;
  size_key: string;
  dpi_key: string;
  language_key: 'zpl';
  mode: 'sample';
  /** Field key → sample value: what the design prints with. */
  samples: Record<string, string>;
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
 *  fonts `fontIds` embedded. `sizeKey` is the template's size; the bodies
 *  hold copies of what they are given. */
export function previewRequest(design: DesignV2, dpi: number, samples: Readonly<Record<string, string>>,
  fontIds: readonly string[], sizeKey: string): PreviewRequest {
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
    },
    preview: (zpl) => ({ zpl, size_key: sizeKey, dpi_key: dpiKey, font_ids: [...ids] }),
  };
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
    if (el.type !== 'text' && !(el.type === 'field' && (el.display === 'text' || el.display === 'number'))) continue;
    if (!el.font || familyInfo(el.font.family)?.resident) continue;
    const file = metricsFile(el.font);
    const row = find(file) ?? (file.weight === 'bold' ? find({ ...file, weight: 'regular' }) : undefined);
    if (row && !row.resident && !ids.includes(row.id)) ids.push(row.id);
  }
  return ids;
}
