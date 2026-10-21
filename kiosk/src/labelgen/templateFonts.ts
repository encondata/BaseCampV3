/**
 * Which printer-installed fonts a synced label template references
 * (labels/template_fonts.py, and the edge's generate.py `template_fonts`).
 *
 * Only fonts on the printer's E: drive count. Two ZPL forms reference one:
 * `^A@o,h,w,E:NAME.TTF` (the comma before the drive is optional) and
 * `^CWa,E:NAME.TTF`. Matching ignores case as Python's re.IGNORECASE does
 * (its [A-Z] also takes U+0130, U+0131, U+017F and U+212A, and `\s` is
 * str.isspace); names come back upper-cased. A builder design's fonts come
 * from its text elements instead (its `code` is "").
 *
 * The synced template's schema (`templateSchema`, generate.py
 * `template_schema`) lives here because the font rule reads it. Pure: no
 * DOM, no Intl, no Node.
 */

import { fontObject } from './fonts';
import { DesignError, parseDesign } from './model';
import { PY_SPACE, sortedStrings } from './py';
import { isPyDict, isPyNumber, type PyDict, type PyNumber, type PyValue } from './pyjson';
import { pyTruthy } from './pyValue';

/** One template of the /kiosk/sync/label-templates body, as the reader
 *  gives it. */
export type SyncTemplate = PyDict;

// the letters Python's IGNORECASE [A-Z] takes beyond ASCII
const EXTRA = '\\u0130\\u0131\\u017f\\u212a';
const NAME = `([A-Z0-9_\\-${EXTRA}]+\\.TTF)`;
const SPACE = `[${[...PY_SPACE].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}]`;
// ^A@ then its parameters (no other command in between) then the E: drive
const A_AT_RE = new RegExp(`\\^A@[^\\^~]*?E:${NAME}`, 'gi');
// ^CW, a one-character alias, a comma, the E: drive
const CW_RE = new RegExp(`\\^CW[A-Z0-9${EXTRA}],${SPACE}*E:${NAME}`, 'gi');

/** template_fonts.py `fonts_used`: the E: font object names `code`
 *  references, upper-cased. */
export function fontsUsed(code: string | null | undefined): Set<string> {
  const text = code || '';
  const out = new Set<string>();
  for (const rx of [A_AT_RE, CW_RE]) {
    for (const m of text.matchAll(rx)) out.add(m[1].toUpperCase());
  }
  return out;
}

/** An int, never a bool or a float. */
const isInt = (v: PyValue | undefined): v is PyNumber => isPyNumber(v) && v.kind === 'int';

/** generate.py `_schema`: an int as it is, anything else 1. */
const schemaOf = (v: PyValue | undefined): number => (isInt(v) ? Number(v.text) : 1);

/** template_fonts.py `design_fonts`: one printer object per family and
 *  weight a schema 2 design's static text and text fields use. Nothing for
 *  a schema 1 design or one that doesn't parse. */
export function designFonts(design: PyValue | undefined): Set<string> {
  const names = new Set<string>();
  if (!isPyDict(design)) return names;
  const schema = design.has('schema') ? design.get('schema') : undefined;
  if (schema !== undefined && !isInt(schema)) return names;
  if (schemaOf(schema) < 2) return names;
  let parsed;
  try {
    parsed = parseDesign(design);
  } catch (e) {
    if (e instanceof DesignError) return names;
    throw e;
  }
  for (const el of parsed.elements) {
    if (el.type === 'field' && el.display !== 'text' && el.display !== 'number') continue;
    const font = el.type === 'field' || el.type === 'text' ? el.font : null;
    if (font !== null) names.add(fontObject(font.family, font.weight)[0]);
  }
  return names;
}

/** generate.py `template_schema`: a synced template's design schema, read
 *  like the server's (1 for a code template, or a `schema` that isn't an
 *  int), or its `schema_version` when that says more. */
export function templateSchema(t: SyncTemplate): number {
  const design = t.get('design');
  const schema = t.get('kind') === 'design' && isPyDict(design)
    ? schemaOf(design.has('schema') ? design.get('schema') : undefined) : 1;
  return Math.max(schema, schemaOf(t.has('schema_version') ? t.get('schema_version') : undefined));
}

/** generate.py `template_fonts`: the E: fonts a synced template prints
 *  with, sorted. A builder design's from its text elements, any other
 *  from its compiled code. */
export function templateFonts(t: SyncTemplate | null): string[] {
  if (t === null) return [];
  if (templateSchema(t) >= 2) return sortedStrings(designFonts(t.get('design')));
  // `t.get("code") or ""`: a truthy code that isn't text makes Python's re raise
  const code = t.get('code');
  const text = pyTruthy(code) ? code : '';
  if (typeof text !== 'string') throw new TypeError('the template code is not text');
  return sortedStrings(fontsUsed(text));
}
