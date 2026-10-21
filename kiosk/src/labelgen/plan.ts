/**
 * The station's label work from the synced move, store-free: the logic of
 * the laptop edge's labels/generate.py (`_choice`, `available_dpis`,
 * `build_plan`, `render_job`) on the raw /kiosk/sync/assets and
 * /kiosk/sync/label-templates bodies.
 *
 * Both bodies are read with the number-preserving reader (pyjson.ts), never
 * JSON.parse, and each template's design goes to the compiler as read: a
 * `2.0` must stay a float, as it does in Python.
 *
 * Two value paths, by the picked template's schema (`templateSchema`): a
 * label builder design (schema 2) prints `fieldValues(item, label_context)`
 * kept to the fields the design places; a code template or a schema 1
 * design prints the placeholder catalog (`assetLabelValues`). A schema
 * newer than SUPPORTED_SCHEMA, and (Ruling 7: Android prints only to
 * Zebras) any language but ZPL, is `template_unsupported`.
 *
 * Every job carries a fingerprint of what its label depends on (the
 * edge's parts), hashed with cyrb53: device-local, so it need not equal
 * the laptop's sha256. Pure: no DOM, no Intl, no Node.
 */

import { fieldValues, designFieldKeys } from './fields';
import {
  assetLabelValues, labelAsset, labelMove, type LabelValues,
} from './labelValues';
import { pickTemplate, type LabelKind, type TemplateChoice } from './pick';
import { cpLength, floatRepr, pyInt, pyIntFromStr, pyStr, sortedStrings } from './py';
import { isPyDict, isPyNumber, parsePyJson, type PyDict, type PyValue } from './pyjson';
import { pyTruthy } from './pyValue';
import { UnsupportedLanguage, renderTemplate } from './render';
import { templateFonts, templateSchema, type SyncTemplate } from './templateFonts';

export type { LabelKind } from './pick';

export const NO_TEMPLATE = 'no_template_at_dpi';
export const TEMPLATE_FAILED = 'template_failed';
export const TEMPLATE_UNSUPPORTED = 'template_unsupported';
/** The newest design schema this generator prints (generate.py). */
export const SUPPORTED_SCHEMA = 2;

export type Problem = typeof NO_TEMPLATE | typeof TEMPLATE_FAILED | typeof TEMPLATE_UNSUPPORTED;
export type Outcome = 'ok' | Problem;

export interface PlanInput {
  /** The raw /kiosk/sync/assets body. */
  assetsJson: string;
  /** The raw /kiosk/sync/label-templates body. */
  templatesJson: string;
  kind: LabelKind;
  /** The printer's DPI. */
  dpi: number;
}

export interface PlanJob {
  assetId: string;
  fingerprint: string;
}

export interface Plan {
  templateId: string | null;
  templateFamily: string | null;
  /** One per pick step that had templates only at another DPI. */
  notes: string[];
  /** The E: fonts the picked template prints with (none without one). */
  fonts: string[];
  /** With no template picked: the DPIs at which one would be. */
  availableDpis: number[];
  /** False when the assets body has no usable asset data (none synced, or
   *  no `label_context`): `jobs` is then empty for want of data, not because
   *  the move has no assets, so no stored label may be pruned. */
  hasAssetData: boolean;
  jobs: PlanJob[];
}

export interface RenderResult {
  assetId: string;
  zpl: string | null;
  outcome: Outcome;
  fingerprint: string;
}

// --- the fingerprint ------------------------------------------------------------

/** cyrb53 (a fast, well-mixed 53-bit non-cryptographic hash). */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Deterministic JSON (`json.dumps(sort_keys=True)`'s role): dict keys
 *  sorted, an int and a float of the same value kept apart. */
function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v).toString() : floatRepr(v);
  if (isPyNumber(v)) return v.kind === 'int' ? BigInt(v.text).toString() : floatRepr(Number(v.text));
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPyDict(v)) {
    return `{${sortedStrings(v.keys()).map((k) => `${JSON.stringify(k)}:${canonical(v.get(k))}`).join(',')}}`;
  }
  throw new TypeError('not a fingerprint part');
}

/** The fingerprint of a job's parts (generate.py `_fingerprint`), as 14 hex
 *  digits. Pass dicts as Maps. */
export function fingerprint(parts: readonly unknown[]): string {
  return cyrb53(canonical(parts)).toString(16).padStart(14, '0');
}

// --- reading the sync bodies ------------------------------------------------------

/** A cached sync body: a JSON object, or null (generate.py `cached`). */
function readBody(text: string): PyDict | null {
  let body: PyValue;
  try {
    body = parsePyJson(text);
  } catch {
    return null;
  }
  return isPyDict(body) ? body : null;
}

/** Iterating `x or []` as Python does: a list's items; a str's characters
 *  or a dict's keys (text, so never a template or asset row). Anything else
 *  truthy raises TypeError. */
function iterate(raw: PyValue | undefined, what: string): PyValue[] {
  if (!pyTruthy(raw)) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return Array.from(raw);
  if (isPyDict(raw)) return [...raw.keys()];
  throw new TypeError(`${what} is not iterable`);
}

const REQUIRED = ['id', 'family', 'label_type', 'dpi_key', 'version'] as const;

/** generate.py `_choice`: a synced template as a TemplateChoice, or null
 *  when a key is missing or `version` isn't an int (an infinite float
 *  throws, as Python's OverflowError does). */
function choiceOf(t: PyDict): TemplateChoice | null {
  if (!REQUIRED.every((k) => t.has(k))) return null;
  const version = pyInt(t.get('version'));
  if (version === null || !t.has('updated_at')) return null;
  const scope = t.get('scope');
  return {
    id: pyStr(t.get('id')), family: pyStr(t.get('family')),
    label_type: pyStr(t.get('label_type')), dpi_key: pyStr(t.get('dpi_key')),
    version, updated_at: pyStr(t.get('updated_at')),
    scope: pyTruthy(scope) ? scope! : 'global',
  };
}

interface TemplateSet {
  choices: TemplateChoice[];
  /** id -> the synced template; a later one with the same id wins. */
  byId: Map<string, SyncTemplate>;
}

function readTemplates(templatesJson: string): TemplateSet {
  const body = readBody(templatesJson);
  const choices: TemplateChoice[] = [];
  const byId = new Map<string, SyncTemplate>();
  for (const t of iterate(body?.get('templates'), 'templates')) {
    const choice = isPyDict(t) ? choiceOf(t) : null;
    if (choice !== null) {
      byId.set(choice.id, t as PyDict);
      choices.push(choice);
    }
  }
  return { choices, byId };
}

const ALL_DIGITS = /^\p{Nd}+$/u;

/** generate.py `available_dpis`: the DPIs at which `pickTemplate` finds a
 *  `kind` template among `choices`, in natural order. Here they are ints:
 *  a DPI key that isn't digits (never in the vocabulary) is left out. */
export function availableDpis(choices: readonly TemplateChoice[], kind: LabelKind): number[] {
  const keys = new Set(choices.filter((t) => t.label_type === kind).map((t) => t.dpi_key));
  const out = new Set<number>();
  for (const key of keys) {
    if (!ALL_DIGITS.test(key) || pickTemplate(choices, kind, key)[0] === null) continue;
    const n = pyIntFromStr(key);
    if (n !== null) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** `list(context.get("catalog_keys") or [])`. Keys are text: anything else
 *  (never sent) throws rather than build a dict Python can't fingerprint. */
function catalogKeysOf(context: PyDict): string[] {
  return iterate(context.get('catalog_keys'), 'catalog_keys').map((k) => {
    if (typeof k !== 'string') throw new TypeError('a catalog key is not text');
    return k;
  });
}

// --- the plan ------------------------------------------------------------------

/** A job with the values its label prints. */
export interface ValuedJob extends PlanJob {
  values: LabelValues;
}

export interface FullPlan extends Omit<Plan, 'jobs'> {
  template: TemplateChoice | null;
  templateJson: SyncTemplate | null;
  jobs: ValuedJob[];
}

function checkInput(input: PlanInput): void {
  if (input.kind !== 'top' && input.kind !== 'front') throw new TypeError(`unknown label kind: ${String(input.kind)}`);
  if (!Number.isInteger(input.dpi) || input.dpi <= 0) throw new TypeError(`bad printer DPI: ${String(input.dpi)}`);
}

const asMap = (values: LabelValues): PyDict => new Map(Object.entries(values));

/** generate.py `build_plan` with every job's values. `only` limits the jobs
 *  (and the values computed) to those asset ids. */
export function planWithValues(input: PlanInput, only?: ReadonlySet<string>): FullPlan {
  checkInput(input);
  const { kind, dpi } = input;
  const { choices, byId } = readTemplates(input.templatesJson);
  const [template, notes] = pickTemplate(choices, kind, String(dpi));
  const available = template === null ? availableDpis(choices, kind) : [];
  const templateJson = template !== null ? byId.get(template.id)! : null;
  const rulesRaw = templateJson?.get('generation_rules');
  const rules = pyTruthy(rulesRaw) ? rulesRaw : null;
  const schema = templateJson !== null ? templateSchema(templateJson) : 1;
  // a builder design's fields: the only values its label prints, so the
  // only ones its fingerprint follows (statuses move with every scan)
  const placed = schema >= 2 ? sortedStrings(designFieldKeys(templateJson!.get('design'))) : [];
  let fonts: string[] = [];
  try {
    fonts = templateFonts(templateJson);
  } catch {
    // a template the font rule can't read lists none; its labels fail on their own
  }

  const assets = readBody(input.assetsJson);
  const context = assets?.get('label_context');
  const rows = assets?.get('assets');
  const hasAssetData = isPyDict(context) && Array.isArray(rows);
  const jobs: ValuedJob[] = [];
  if (hasAssetData) {
    const move = labelMove(context);
    const catalogKeys = catalogKeysOf(context);
    for (const a of rows) {
      if (!isPyDict(a) || !pyTruthy(a.get('id'))) continue;
      const assetId = pyStr(a.get('id'));
      if (only && !only.has(assetId)) continue;
      let values: LabelValues;
      let fp: string;
      if (template === null) {
        values = assetLabelValues(labelAsset(a), move, catalogKeys, rules);
        fp = fingerprint(['no_template', dpi, kind]);
      } else if (schema > SUPPORTED_SCHEMA) {
        // nothing to compute: the label is an error until an update
        values = Object.create(null);
        fp = fingerprint(['unsupported', template.id, template.version, schema, SUPPORTED_SCHEMA,
          dpi, kind]);
      } else {
        if (schema >= 2) {
          const every = fieldValues(a, context);
          values = Object.create(null);
          for (const k of placed) {
            if (Object.prototype.hasOwnProperty.call(every, k)) values[k] = every[k];
          }
        } else {
          values = assetLabelValues(labelAsset(a), move, catalogKeys, rules);
        }
        // the size/DPI vocabulary and language ride along: a vocab edit
        // changes the label without bumping the template version
        const tj = templateJson!;
        fp = fingerprint([asMap(values), template.id, template.version, dpi, kind,
          tj.get('width_in'), tj.get('height_in'), tj.get('dots'), tj.get('language_key')]);
      }
      jobs.push({ assetId, values, fingerprint: fp });
    }
  }
  return {
    template, templateJson, templateId: template?.id ?? null, templateFamily: template?.family ?? null,
    notes, fonts, availableDpis: available, hasAssetData, jobs,
  };
}

/** The plan: which template, what it needs, and one fingerprinted job per
 *  asset on the move (rows without an id are skipped). */
export function buildPlan(input: PlanInput): Plan {
  const p = planWithValues(input);
  return {
    templateId: p.templateId, templateFamily: p.templateFamily, notes: p.notes, fonts: p.fonts,
    availableDpis: p.availableDpis, hasAssetData: p.hasAssetData,
    jobs: p.jobs.map(({ assetId, fingerprint: fp }) => ({ assetId, fingerprint: fp })),
  };
}

// --- rendering ------------------------------------------------------------------

/** generate.py `_positive`: an int or float above zero, never a bool. */
const positive = (v: PyValue | undefined): boolean => isPyNumber(v) && Number(v.text) > 0;

const numberIn = (v: PyValue | undefined): number => (isPyNumber(v) ? Number(v.text) : 0);

/** What zpl.py `_esc(value)` prints for a list or dict value, which it
 *  iterates (a dict's keys): each item is escaped like a character when it
 *  is one code point, or "" or a run of `^~_\` (Python's `in` is a
 *  substring test); anything else raises TypeError (null here). */
function escIterated(v: PyValue): string | null {
  const items = Array.isArray(v) ? v : isPyDict(v) ? [...v.keys()] : null;
  if (items === null) return null;
  const ok = items.every((item) => typeof item === 'string'
    && (cpLength(item) === 1 || '^~_\\'.includes(item)));
  return ok ? (items as string[]).join('') : null;
}

/** generate.py `render_job`: the label's ZPL, or why there is none.
 *  Unknown placeholders print blank, as on the portal. A design without
 *  its size or DPI details is template_failed, never rendered at size 0. */
export function renderJob(templateJson: SyncTemplate | null,
  values: LabelValues): { zpl: string | null; outcome: Outcome } {
  if (templateJson === null) return { zpl: null, outcome: NO_TEMPLATE };
  if (templateSchema(templateJson) > SUPPORTED_SCHEMA) return { zpl: null, outcome: TEMPLATE_UNSUPPORTED };
  const kindRaw = templateJson.get('kind');
  const kind = pyTruthy(kindRaw) ? kindRaw : 'code';
  if (kind === 'design' && !['width_in', 'height_in', 'dots'].every((k) => positive(templateJson.get(k)))) {
    return { zpl: null, outcome: TEMPLATE_FAILED };
  }
  const languageRaw = templateJson.get('language_key');
  const language = pyTruthy(languageRaw) ? languageRaw : 'zpl';
  // Values Python would not take as text (never sent) raise TypeError
  // where a label prints them: left out here, then checked below. A design
  // prints a list or dict the way zpl.py `_esc` iterates it.
  const text: Record<string, string> = Object.create(null);
  const odd = new Set<string>();
  for (const [k, v] of Object.entries(values)) {
    const printed = typeof v === 'string' ? v : (kind === 'code' ? null : escIterated(v));
    if (printed !== null) text[k] = printed;
    else odd.add(k);
  }
  try {
    let code: string | null = null;
    if (kind === 'code') {
      const raw = templateJson.get('code');
      if (pyTruthy(raw) && typeof raw !== 'string') throw new TypeError('the template code is not text');
      code = typeof raw === 'string' ? raw : null;
    }
    const rendered = renderTemplate({
      kind: kind === 'code' ? 'code' : 'design', code,
      design: kind === 'design' ? (templateJson.get('design') ?? null) : null,
      language_key: typeof language === 'string' ? language : pyStr(language!),
    }, text, {
      width_in: numberIn(templateJson.get('width_in')),
      height_in: numberIn(templateJson.get('height_in')),
      dots: numberIn(templateJson.get('dots')),
    });
    if (rendered.unknown.some((k) => odd.has(k))) return { zpl: null, outcome: TEMPLATE_FAILED };
    return { zpl: rendered.zpl, outcome: 'ok' };
  } catch (e) {
    return { zpl: null, outcome: e instanceof UnsupportedLanguage ? TEMPLATE_UNSUPPORTED : TEMPLATE_FAILED };
  }
}

/** The labels of `assetIds` (in that order; an id not on the move is left
 *  out), each with the fingerprint `buildPlan` gives it. An asset listed
 *  twice on the move takes its last row, as the edge's store keeps it. */
export function renderLabels(input: PlanInput, assetIds: readonly string[]): RenderResult[] {
  const plan = planWithValues(input, new Set(assetIds));
  const byId = new Map(plan.jobs.map((job) => [job.assetId, job]));
  const out: RenderResult[] = [];
  for (const assetId of assetIds) {
    const job = byId.get(assetId);
    if (!job) continue;
    const { zpl, outcome } = renderJob(plan.templateJson, job.values);
    out.push({ assetId, zpl, outcome, fingerprint: job.fingerprint });
  }
  return out;
}
