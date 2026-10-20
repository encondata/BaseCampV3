/**
 * The label builder's font families, mirrored from the API's labels/fonts.py
 * `FAMILIES` (fonts.test.ts pins the mirror) so the font dropdown renders
 * without a round trip. The printer object names stay on the server.
 *
 * Swiss 721 Condensed Bold is Zebra's resident cut: never served to a
 * browser, so the canvas draws it with Roboto Condensed Bold while every
 * width and baseline comes from the real file's metrics (spec §4.4). It has
 * no Bold file, so Bold on it is faux: the printer overprints one dot, or on
 * an inverted element widens the glyphs 15%.
 */

export type FontWeight = 'regular' | 'bold';

/** A family slug and a weight, as a design stores them. */
export interface FontRef {
  family: string;
  weight: FontWeight;
}

export interface FontFamilyInfo {
  slug: string;
  label: string;
  mono: boolean;
  /** Zebra's own cut: never pushed to a printer or served to a browser. */
  resident: boolean;
  /** The family has a Bold file; without one, Bold is faux. */
  bold: boolean;
}

export const FONT_FAMILIES: readonly FontFamilyInfo[] = [
  { slug: 'swiss721-cond-bold', label: 'Swiss 721 Condensed Bold', mono: false, resident: true, bold: false },
  { slug: 'roboto-condensed', label: 'Roboto Condensed', mono: false, resident: false, bold: true },
  { slug: 'roboto', label: 'Roboto', mono: false, resident: false, bold: true },
  { slug: 'oswald', label: 'Oswald', mono: false, resident: false, bold: true },
  { slug: 'roboto-mono', label: 'Roboto Mono', mono: true, resident: false, bold: true },
  { slug: 'ibm-plex-mono', label: 'IBM Plex Mono', mono: true, resident: false, bold: true },
  { slug: 'atkinson-hyperlegible', label: 'Atkinson Hyperlegible', mono: false, resident: false, bold: true },
  { slug: 'source-sans-3', label: 'Source Sans 3', mono: false, resident: false, bold: true },
];

export const DEFAULT_FAMILY = 'swiss721-cond-bold';

/** What the dropdown renders in each face. */
export const FONT_SAMPLE = '0O 1Il 7';

/** The face the canvas draws a resident family with. */
export const STAND_IN: FontRef = { family: 'roboto-condensed', weight: 'bold' };

/** The printer's width factor for faux Bold on an inverted element. */
export const FAUX_BOLD_INVERTED_WIDEN = 1.15;

export function familyInfo(slug: string): FontFamilyInfo | undefined {
  return FONT_FAMILIES.find((f) => f.slug === slug);
}

/** Bold asked of a family with no Bold file. */
export function fauxBold(font: FontRef): boolean {
  return font.weight === 'bold' && familyInfo(font.family)?.bold === false;
}

/** The library file the printer prints `font` with, and so the one whose
 *  metrics place it: faux Bold prints the Regular file. */
export function metricsFile(font: FontRef): FontRef {
  return fauxBold(font) ? { family: font.family, weight: 'regular' } : { ...font };
}

/** The file the canvas draws `font` with: the stand-in for a resident family. */
export function faceFile(font: FontRef): FontRef {
  return familyInfo(font.family)?.resident ? { ...STAND_IN } : metricsFile(font);
}

/** How much wider than its metrics the printer draws `font`'s glyphs. */
export function glyphWidthScale(font: FontRef, inverted: boolean): number {
  return inverted && fauxBold(font) ? FAUX_BOLD_INVERTED_WIDEN : 1;
}
