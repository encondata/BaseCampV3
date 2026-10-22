/**
 * The label builder's font families and the printer object each weight
 * prints with (labels/fonts.py). Every family is TrueType under an 8.3
 * object name, which the compiler emits as `^A@…,E:<object>`. Swiss 721
 * (`TT0003M_.TTF`) is Zebra's own resident cut: never pushed to a printer,
 * and with no Bold file, so Bold on it is faux (see `fontObject`).
 *
 * Pure: no DOM, no Intl, no Node.
 */

import { pyRepr } from './py';

export interface FamilyObjects {
  regular: string;
  bold: string | null;
}

export interface Family {
  label: string;
  objects: FamilyObjects;
  resident: boolean;
  mono: boolean;
}

export const WEIGHTS = ['regular', 'bold'] as const;
export const DEFAULT_FAMILY = 'swiss721-cond-bold';
/** The printer's resident font object: never installed. */
export const RESIDENT_FONT = 'TT0003M_.TTF';

function family(label: string, regular: string, bold: string | null,
  { resident = false, mono = false } = {}): Family {
  return { label, objects: { regular, bold }, resident, mono };
}

export const FAMILIES: Readonly<Record<string, Family>> = {
  'swiss721-cond-bold': family('Swiss 721 (printer built-in)', RESIDENT_FONT, null, { resident: true }),
  'roboto-condensed': family('Roboto Condensed', 'ROBOCO_R.TTF', 'ROBOCO_B.TTF'),
  roboto: family('Roboto', 'ROBOTO_R.TTF', 'ROBOTO_B.TTF'),
  oswald: family('Oswald', 'OSWALD_R.TTF', 'OSWALD_B.TTF'),
  'roboto-mono': family('Roboto Mono', 'ROBOMO_R.TTF', 'ROBOMO_B.TTF', { mono: true }),
  'ibm-plex-mono': family('IBM Plex Mono', 'PLEXMO_R.TTF', 'PLEXMO_B.TTF', { mono: true }),
  'atkinson-hyperlegible': family('Atkinson Hyperlegible', 'ATKINS_R.TTF', 'ATKINS_B.TTF'),
  'source-sans-3': family('Source Sans 3', 'SRCSAN_R.TTF', 'SRCSAN_B.TTF'),
};

const hasFamily = (slug: string) => Object.prototype.hasOwnProperty.call(FAMILIES, slug);

/** [family slug, weight] of a builder printer object name, matched without
 *  regard to case, or null for any other font. */
export function objectFamily(name: string | null | undefined): [string, string] | null {
  const upper = (name || '').toUpperCase();
  for (const [slug, fam] of Object.entries(FAMILIES)) {
    for (const weight of WEIGHTS) {
      if (fam.objects[weight] === upper) return [slug, weight];
    }
  }
  return null;
}

/** True for a resident family's printer object name. */
export function residentObject(name: string | null | undefined): boolean {
  const found = objectFamily(name);
  return found !== null && FAMILIES[found[0]].resident;
}

/** [object name, faux bold] for one weight of a family. Bold on a family
 *  with no Bold file prints the regular file with faux bold set. Throws for
 *  an unknown weight (ValueError) or family (KeyError), as Python does. */
export function fontObject(fam: string, weight: string): [string, boolean] {
  if (!(WEIGHTS as readonly string[]).includes(weight)) {
    throw new RangeError(`unknown font weight: ${pyRepr(weight)}`);
  }
  if (!hasFamily(fam)) throw new RangeError(`unknown font family: ${pyRepr(fam)}`);
  const objs = FAMILIES[fam].objects;
  const bold = weight === 'bold' ? objs.bold : null;
  return bold ? [bold, false] : [objs.regular, weight === 'bold'];
}
