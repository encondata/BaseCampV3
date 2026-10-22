/**
 * The placeholder catalog for one asset label (labels/label_values.py):
 * what a code template or a schema 1 design prints. The asset and move
 * come from the sync JSON as the laptop edge reads them (generate.py
 * `_label_asset`, `_decimal`, `_day`).
 *
 * Python never checks that a field is text. A value the server never sends
 * as text (a number where a name belongs) stays its JSON value here, as it
 * does there: the length limits skip it, and the label that prints it
 * fails (plan.ts). Pure: no DOM, no Intl, no Node.
 */

import { cpLength, cpSlice, formatRu, moveDates, pyInt, pyStr } from './py';
import { isPyDict, type PyDict, type PyValue } from './pyjson';
import { pyTruthy } from './pyValue';

/** label_values.py `LabelAsset`. The RUs are the text `Decimal()` reads
 *  (the edge's `_decimal`): null for none. */
export interface LabelAsset {
  legacyId: PyValue | undefined;
  name: PyValue | undefined;
  serialNumber: PyValue | undefined;
  make: PyValue | undefined;
  model: PyValue | undefined;
  sourceRack: PyValue | undefined;
  sourceRu: string | null;
  sourcePosition: PyValue | undefined;
  destinationRack: PyValue | undefined;
  destinationRu: string | null;
  destinationPosition: PyValue | undefined;
}

/** label_values.py `LabelMove`. `day` is the ISO text the edge's `_day`
 *  reads whole (null for none). */
export interface LabelMove {
  name: PyValue | undefined;
  day: string | null;
  sourceSite: PyValue | undefined;
  destinationSite: PyValue | undefined;
}

/** Label values: text, or (never from the server) a JSON value that isn't. */
export type LabelValues = Record<string, PyValue>;

/** `a or b`. */
const or = (a: PyValue | undefined, b: PyValue): PyValue => (pyTruthy(a) ? a! : b);

/** label_values.py `make_model_text` (f-string = str() of each part). */
export function makeModelText(make: PyValue, model: PyValue): PyValue {
  if (pyTruthy(make) && pyTruthy(model)) return `${pyStr(make)} ${pyStr(model)}`;
  return or(make, model);
}

/** label_values.py `_apply_position_rules`: split the raw location on "."
 *  into the template's named tokens (1-based positions); a position with no
 *  part stays unset. Throws where Python does (rules or a location that
 *  isn't the right type). */
export function applyPositionRules(out: LabelValues, rules: PyDict,
  sourceRaw: PyValue, destinationRaw: PyValue): void {
  for (const [side, raw] of [['source', sourceRaw], ['destination', destinationRaw]] as const) {
    const mapping = rules.get(side);
    if (!isPyDict(mapping) || !pyTruthy(raw)) continue;
    if (typeof raw !== 'string') throw new TypeError(`${side} location is not text`);
    const parts = raw.split('.');
    for (const [posKey, name] of mapping) {
      const pos = pyInt(posKey);
      if (pos === null) continue;
      if (typeof name !== 'string' || !name) continue;
      const idx = pos - 1;
      if (idx >= 0 && idx < parts.length) out[name] = parts[idx];
    }
  }
}

/** label_values.py `_apply_length_limits` (lengths in code points). */
export function applyLengthLimits(out: LabelValues, rules: PyDict): void {
  const limits = rules.get('length_limits');
  if (!isPyDict(limits)) return;
  for (const [field, maxLen] of limits) {
    if (!Object.prototype.hasOwnProperty.call(out, field)) continue;
    const value = out[field];
    if (typeof value !== 'string') continue;
    const limit = pyInt(maxLen);
    if (limit === null) continue;
    if (limit > 0 && cpLength(value) > limit) out[field] = cpSlice(value, 0, limit);
  }
}

/** `generation_rules` applied as asset_label_values applies them: nothing
 *  when falsy, AttributeError (a throw) when truthy but not a dict. */
export function applyGenerationRules(out: LabelValues, rules: PyValue | undefined,
  sourceRaw: PyValue, destinationRaw: PyValue): void {
  if (!pyTruthy(rules)) return;
  if (!isPyDict(rules)) throw new TypeError('generation_rules is not a mapping');
  applyPositionRules(out, rules, sourceRaw, destinationRaw);
  applyLengthLimits(out, rules);
}

/** label_values.py `asset_label_values`: every requested catalog key
 *  (unrecognized or missing data -> ''), then the template's generation
 *  rules, whose named tokens are added on top. */
export function assetLabelValues(asset: LabelAsset, move: LabelMove, catalogKeys: readonly string[],
  generationRules?: PyValue): LabelValues {
  const make = or(asset.make, '');
  const model = or(asset.model, '');
  const sourceRaw = or(asset.sourcePosition, or(asset.sourceRack, ''));
  const destinationRaw = or(asset.destinationPosition, or(asset.destinationRack, ''));
  const [moveDate, moveDateLong] = moveDates(move.day);
  const legacy = asset.legacyId;
  const computed = new Map<string, PyValue>([
    ['asset_id', legacy !== null && legacy !== undefined ? pyStr(legacy) : ''],
    ['asset_name', or(asset.name, '')],
    ['serial_number', or(asset.serialNumber, '')],
    ['make', make],
    ['model', model],
    ['make_model', makeModelText(make, model)],
    ['source_raw', sourceRaw],
    ['source_ru', formatRu(asset.sourceRu)],
    ['source_site', or(move.sourceSite, '')],
    ['destination_raw', destinationRaw],
    ['destination_ru', formatRu(asset.destinationRu)],
    ['destination_site', or(move.destinationSite, '')],
    ['move_name', or(move.name, '')],
    ['move_date', moveDate],
    ['move_date_long', moveDateLong],
    // an asset row never carries container fields
    ['container_name', ''],
    ['container_id', ''],
  ]);
  const out: LabelValues = Object.create(null);
  for (const key of catalogKeys) out[key] = computed.has(key) ? computed.get(key)! : '';
  applyGenerationRules(out, generationRules, sourceRaw, destinationRaw);
  return out;
}

/** generate.py `_decimal(raw)` as text: None or "" -> null, else str(raw)
 *  (formatRu gives '' for text Decimal refuses). */
export function decimalText(raw: PyValue | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  return pyStr(raw);
}

/** generate.py `_label_asset`: a synced asset row as a LabelAsset. */
export function labelAsset(a: PyDict): LabelAsset {
  return {
    legacyId: a.get('legacy_id'), name: a.get('name'), serialNumber: a.get('serial_number'),
    make: a.get('make'), model: a.get('model'), sourceRack: a.get('source_rack'),
    sourceRu: decimalText(a.get('source_ru_raw')), sourcePosition: a.get('source_position'),
    destinationRack: a.get('destination_rack'),
    destinationRu: decimalText(a.get('destination_ru_raw')),
    destinationPosition: a.get('destination_position'),
  };
}

/** generate.py's LabelMove from `label_context` (`_day` reads the whole
 *  text; anything but a str is no day). */
export function labelMove(context: PyDict): LabelMove {
  const day = context.get('move_day');
  return {
    name: context.get('move_name'), day: typeof day === 'string' ? day : null,
    sourceSite: context.get('source_site'), destinationSite: context.get('destination_site'),
  };
}
