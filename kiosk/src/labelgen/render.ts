/**
 * Render one label from a template + placeholder values (labels/render.py,
 * with compile.py's dispatch): the pure core the laptop edge prints with.
 *
 * A `code` template is its code with every {token} filled (unknown ->
 * ''). A `design` template is parsed with the template's size in place of
 * its own and compiled at the template's DPI. Only ZPL compiles here
 * (Ruling 7: Android prints only to Zebras): any other language_key throws
 * UnsupportedLanguage, which the caller reports as template_unsupported.
 *
 * Unknown keys are reported, never an error: a code template's tokens, a
 * schema 1 design's tokens in text content and barcode/QR data, a schema 2
 * design's bound field keys, each missing from `values`. Python returns
 * them as a set; here they come once each, in the order they first appear.
 * Pure: no DOM, no Intl, no Node.
 */

import { parseDesign } from './model';
import { isPyDict, type PyDict } from './pyjson';
import { asPy, numberOf, pyTruthy } from './pyValue';
import { TOKEN_RE, applyPlaceholders } from './tokens';
import { compileZpl } from './zpl';

/** A language_key with no compiler here (compile.py `UnsupportedLanguage`). */
export class UnsupportedLanguage extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`unsupported language: ${key}`);
    this.name = 'UnsupportedLanguage';
    this.key = key;
  }
}

export interface TemplateSource {
  kind: 'code' | 'design';
  code: string | null;
  design: unknown;
  language_key: string;
}

export interface RenderOptions {
  width_in: number;
  height_in: number;
  dots: number;
}

export interface Rendered {
  zpl: string;
  /** The keys the label left blank because `values` lacks them. */
  unknown: string[];
}

const has = (values: Readonly<Record<string, string>>, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(values, key)
);

function unknownOf(keys: Iterable<string>, values: Readonly<Record<string, string>>): string[] {
  return [...new Set(keys)].filter((key) => !has(values, key));
}

const tokensIn = (text: string): string[] => [...text.matchAll(TOKEN_RE)].map((m) => m[1]);

/** `{**design_json, "size": {...}}` of render.py, where design_json is
 *  `template.design or {}` (anything else that isn't a dict can't spread). */
function sized(design: unknown, widthIn: number, heightIn: number): PyDict {
  const raw = asPy(design);
  let out: PyDict;
  if (!pyTruthy(raw)) out = new Map();
  else if (isPyDict(raw)) out = new Map(raw);
  else throw new TypeError('the design is not a mapping');
  out.set('size', new Map([['w', numberOf(widthIn)], ['h', numberOf(heightIn)]]));
  return out;
}

/** The ZPL for one label and the keys it left unresolved. */
export function renderTemplate(t: TemplateSource, values: Readonly<Record<string, string>>,
  opts: RenderOptions): Rendered {
  if (t.language_key !== 'zpl') throw new UnsupportedLanguage(t.language_key);
  if (t.kind === 'code') {
    const code = t.code || '';
    return { zpl: applyPlaceholders(code, values), unknown: unknownOf(tokensIn(code), values) };
  }
  const design = parseDesign(sized(t.design, opts.width_in, opts.height_in));
  const zpl = compileZpl(design, opts.dots, values);
  const keys: string[] = [];
  for (const el of design.elements) {
    if (design.schema >= 2) {
      if ((el.type === 'field' || el.type === 'barcode' || el.type === 'qr') && el.field) {
        keys.push(el.field);
      }
    } else if (el.type === 'text') {
      keys.push(...tokensIn(el.content));
    } else if (el.type === 'barcode' || el.type === 'qr') {
      keys.push(...tokensIn(el.data));
    }
  }
  return { zpl, unknown: unknownOf(keys, values) };
}
