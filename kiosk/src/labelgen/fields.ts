/**
 * The label builder's field catalog and the text each field prints
 * (labels/fields.py): what a schema 2 design prints. `fieldValues(payload,
 * context)` turns one /kiosk/sync/assets item (or a container item) plus
 * the move's `label_context` into {key: text}; From-To columns are the
 * dynamic keys `ft:<header>`.
 *
 * Only the keys of the catalog are ported (the builder's labels and kinds
 * are the portal's business), and not the ID badge's `person_values`: a
 * badge never reaches a kiosk. Pure: no DOM, no Intl, no Node.
 */

import { cpSlice, moveDates, pyText, ruText, sortedStrings } from './py';
import { isPyDict, isPyNumber, type PyDict, type PyValue } from './pyjson';
import { pyTruthy } from './pyValue';
import { LABEL_TAG_LABELS } from './tags';

export const ASSET_LABEL_TYPES = ['top', 'front', 'rail'];
export const CONTAINER_LABEL_TYPES = ['container', 'container_info'];
export const ALL_LABEL_TYPES = [...ASSET_LABEL_TYPES, ...CONTAINER_LABEL_TYPES];
/** Label types that describe a person (an ID badge). */
export const PERSON_LABEL_TYPES = ['id_badge'];

export const FT_PREFIX = 'ft:';

/** label_values.py: the word an untagged container prints in its tag bar. */
export const UNTAGGED_LABEL = 'CONTAINER';

/** fields.py `PLACEHOLDER_MOCK_VALUES` (api/routes/kiosk.py serves them as
 *  its MOCK_VALUES): the mock-data test label of a code template or a
 *  schema 1 design. */
export const PLACEHOLDER_MOCK_VALUES: Readonly<Record<string, string>> = {
    "asset_id": "100000",
    "asset_name": "SAMPLE-SERVER-01",
    "serial_number": "SN0000001",
    "make": "Dell",
    "model": "PowerEdge R740",
    "make_model": "Dell PowerEdge R740",
    "source_raw": "A1.R01.U12",
    "source_ru": "U12",
    "source_site": "Sample Site A",
    "destination_raw": "B2.R04.U12",
    "destination_ru": "U12",
    "destination_site": "Sample Site B",
    "move_name": "Sample Move",
    "move_date": "09/01/2026",
    "move_date_long": "01-SEP-2026",
    "container_name": "SAMPLE-CRATE-01",
    "container_id": "200000",
    "label_tag": "PRIORITY",
};

/** fields.py `MOCK_VALUES`, copied verbatim: one fixed sample per builder
 *  field, what the mock-data test label of a schema 2 design prints. */
export const MOCK_VALUES: Readonly<Record<string, string>> = {
    // Asset
    "asset_id": "100000",
    "asset_name": "SAMPLE-SERVER-01",
    "serial_number": "SN0000001",
    "rfid_tag": "000000000000000000100000",
    "pod_number": "P4",
    "asset_status": "Racked",
    "has_rails": "Yes",
    "location_detail": "F01 U18",
    // Make & model
    "make_model": "Dell PowerEdge R740",
    // On this move
    "source_rack": "09.01.05D.02.10",
    "source_ru": "12",
    "source_position": "Front",
    "source_pod": "P4",
    "destination_rack": "14.01.07C.02.03",
    "destination_ru": "12",
    "destination_position": "Front",
    "destination_pod": "D4",
    "priority_wave": "Wave 1",
    "disposition": "Relocate",
    "owner": "Data Services",
    "cable_data_1": "SW01/01",
    "cable_data_2": "SW01/02",
    "cable_data_3": "SW01/03",
    "cable_data_4": "SW01/04",
    "cable_data_5": "SW01/05",
    "cable_data_6": "SW01/06",
    "cable_mgmt_1": "MGMT01/01",
    "cable_mgmt_2": "MGMT01/02",
    "vendor_involved": "No",
    "roster_status": "Labeled",
    // Move
    "move_name": "Sample Move",
    "move_code": "SMPL",
    "move_date": "09/01/2026",
    "move_date_long": "01-SEP-2026",
    // Sites
    "origin_site_name": "Sample Site A",
    "origin_site_code": "SITE-A",
    "destination_site_name": "Sample Site B",
    "destination_site_code": "SITE-B",
    // Container
    "container_name": "SAMPLE-CRATE-01",
    "container_id": "200000",
    "label_tag": "PRIORITY",
    "container_rfid_tag": "000000000000000000200000",
    "container_type": "D-container",
    "container_status": "Available",
    // Person (an ID badge): a plausible worker
    "person_name": "Jordan Rivera",
    "first_name": "Jordan",
    "last_name": "Rivera",
    "preferred_name": "Jordan",
    "person_type": "Worker",
    "company": "Rivera Electric",
    "parent_company": "Rivera Holdings",
    "job_title": "Lead Electrician",
    "roles": "Admin, Staff",
    "trade": "Electrician",
    "level": "L3 Technician",
    "worker_status": "Active",
    "employee_id": "E-10482",
    "email": "jordan.rivera@example.com",
    "phone": "(555) 010-4821",
    "person_rfid_tag": "100418",
    "badge_id": "3f2a9c1e-7b4d-4e21-9a0c-5d6e7f809a1b",
    "badge_short": "3f2a9c1e",
};

const cable = (n: number) => Array.from({ length: n }, (_, i) => `cable_data_${i + 1}`);

/** fields.py `_CATALOG`'s keys: [group key, label types, field keys]. */
const CATALOG: readonly (readonly [string, readonly string[], readonly string[]])[] = [
  ['asset', ASSET_LABEL_TYPES, ['asset_id', 'asset_name', 'serial_number', 'rfid_tag', 'pod_number',
    'asset_status', 'has_rails', 'location_detail']],
  ['model', ASSET_LABEL_TYPES, ['make_model']],
  ['move_row', ASSET_LABEL_TYPES, ['source_rack', 'source_ru', 'source_position', 'source_pod',
    'destination_rack', 'destination_ru', 'destination_position', 'destination_pod',
    'priority_wave', 'disposition', 'owner', ...cable(6), 'cable_mgmt_1', 'cable_mgmt_2',
    'vendor_involved', 'roster_status']],
  ['move', ALL_LABEL_TYPES, ['move_name', 'move_code', 'move_date', 'move_date_long']],
  ['sites', ALL_LABEL_TYPES, ['origin_site_name', 'origin_site_code', 'destination_site_name',
    'destination_site_code']],
  ['container', CONTAINER_LABEL_TYPES, ['container_name', 'container_id', 'label_tag',
    'container_rfid_tag', 'container_type', 'container_status']],
  ['person', PERSON_LABEL_TYPES, ['person_name', 'first_name', 'last_name', 'preferred_name',
    'person_type', 'company', 'parent_company', 'job_title', 'roles', 'trade', 'level',
    'worker_status', 'employee_id', 'email', 'phone', 'person_rfid_tag', 'badge_id', 'badge_short']],
];

type Group = (typeof CATALOG)[number];

const PERSON_GROUPS = new Set(CATALOG
  .filter(([, types]) => types.every((t) => PERSON_LABEL_TYPES.includes(t)))
  .map(([key]) => key));

/** fields.py `groups_for`: every group for no type; the Person group alone
 *  for an ID badge; every group but Person for a custom type. */
function groupsFor(labelType: string | null): Group[] {
  if (labelType === null) return [...CATALOG];
  if (!ALL_LABEL_TYPES.includes(labelType) && !PERSON_LABEL_TYPES.includes(labelType)) {
    return CATALOG.filter(([key]) => !PERSON_GROUPS.has(key));
  }
  return CATALOG.filter(([, types]) => types.includes(labelType));
}

/** fields.py `allows_from_to`: not a container label, not an ID badge. */
export function allowsFromTo(labelType: string | null): boolean {
  return labelType === null
    || (!CONTAINER_LABEL_TYPES.includes(labelType) && !PERSON_LABEL_TYPES.includes(labelType));
}

/** fields.py `catalog_keys`: every catalog key a template of the type places. */
export function catalogKeys(labelType: string | null): string[] {
  return groupsFor(labelType).flatMap(([, , keys]) => keys);
}

const ASSET_KEYS = catalogKeys('top');
const CONTAINER_KEYS = catalogKeys('container');

/** model.py's int test: an int, never a bool or a float. */
const isInt = (v: PyValue | undefined): boolean => isPyNumber(v) && v.kind === 'int';

/** fields.py `design_field_keys`: every field key a schema 2 or 3 design's
 *  elements place (catalog and `ft:` keys alike), read straight off the
 *  JSON. An image element places none; a schema 1 design none either. */
export function designFieldKeys(design: PyValue | undefined): Set<string> {
  const out = new Set<string>();
  if (!isPyDict(design)) return out;
  const schema = design.has('schema') ? design.get('schema') : { kind: 'int', text: '1' } as const;
  if (!isInt(schema) || Number((schema as { text: string }).text) < 2) return out;
  const elements = design.get('elements');
  for (const el of Array.isArray(elements) ? elements : []) {
    if (!isPyDict(el) || el.get('type') === 'image') continue;
    const field = el.get('field');
    if (typeof field === 'string' && field) out.add(field);
  }
  return out;
}

/** fields.py `mock_field_values`: MOCK_VALUES for every catalog key of the
 *  type, and each `ft:<header>` key in `fieldKeys` printing its header
 *  (none for a container label or an ID badge). */
export function mockFieldValues(labelType: string | null, fieldKeys?: Iterable<string> | null): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const key of catalogKeys(labelType)) out[key] = MOCK_VALUES[key];
  if (!allowsFromTo(labelType)) return out;
  for (const key of sortedStrings(fieldKeys ?? [])) {
    if (key.startsWith(FT_PREFIX)) out[key] = key.slice(FT_PREFIX.length);
  }
  return out;
}

const getText = (d: PyDict, key: string): string => pyText(d.get(key));

/** fields.py `_status`: a status prints its label, or its key. */
function status(p: PyDict, key: string): string {
  const label = p.get(`${key}_label`);
  return pyText(pyTruthy(label) ? label : p.get(key));
}

/** `p.get(a) or p.get(b)`. */
function either(p: PyDict, a: string, b: string): PyValue | undefined {
  const first = p.get(a);
  return pyTruthy(first) ? first : p.get(b);
}

/** fields.py `_day` + `move_dates`: only the first ten characters count. */
function contextDates(raw: PyValue | undefined): [string, string] {
  return moveDates(typeof raw === 'string' && raw ? cpSlice(raw, 0, 10) : null);
}

function moveValues(context: PyDict): Record<string, string> {
  const [moveDate, moveDateLong] = contextDates(context.get('move_day'));
  return {
    move_name: getText(context, 'move_name'),
    move_code: getText(context, 'move_code'),
    move_date: moveDate,
    move_date_long: moveDateLong,
    origin_site_name: getText(context, 'source_site'),
    origin_site_code: getText(context, 'source_site_code'),
    destination_site_name: getText(context, 'destination_site'),
    destination_site_code: getText(context, 'destination_site_code'),
  };
}

function assetValues(p: PyDict): Record<string, string> {
  const rawCable = p.get('cable_info');
  const cableInfo: PyDict = isPyDict(rawCable) ? rawCable : new Map();
  const out: Record<string, string> = {
    asset_id: getText(p, 'asset_id'),
    asset_name: getText(p, 'name'),
    serial_number: getText(p, 'serial_number'),
    rfid_tag: getText(p, 'rfid'),
    pod_number: getText(p, 'pod_number'),
    asset_status: status(p, 'asset_status'),
    has_rails: getText(p, 'has_rails'),
    location_detail: getText(p, 'location_detail'),
    make_model: getText(p, 'make_model'),
    source_rack: getText(p, 'source_rack'),
    source_ru: ruText(either(p, 'source_ru_raw', 'source_ru')),
    source_position: getText(p, 'source_position'),
    source_pod: getText(p, 'source_pod'),
    destination_rack: getText(p, 'destination_rack'),
    destination_ru: ruText(either(p, 'destination_ru_raw', 'destination_ru')),
    destination_position: getText(p, 'destination_position'),
    destination_pod: getText(p, 'destination_pod'),
    priority_wave: getText(p, 'priority_wave'),
    disposition: getText(p, 'disposition'),
    owner: getText(p, 'owner'),
    vendor_involved: getText(p, 'vendor_involved'),
    roster_status: status(p, 'roster_status'),
  };
  // free-text cable info ({"text": ...}) has no Data/Mgmt parts to print
  for (let i = 1; i <= 6; i += 1) out[`cable_data_${i}`] = getText(cableInfo, `data_${i}`);
  for (let i = 1; i <= 2; i += 1) out[`cable_mgmt_${i}`] = getText(cableInfo, `mgmt_${i}`);
  return out;
}

function containerValues(p: PyDict): Record<string, string> {
  const rawTag = p.get('label_tag');
  const tag = pyTruthy(rawTag) ? rawTag! : '';
  // LABEL_TAG_LABELS.get(tag, tag) then .upper(): Python raises on a tag
  // that isn't text
  if (typeof tag !== 'string') throw new TypeError('label_tag is not text');
  const known = Object.prototype.hasOwnProperty.call(LABEL_TAG_LABELS, tag)
    ? LABEL_TAG_LABELS[tag as keyof typeof LABEL_TAG_LABELS] : tag;
  return {
    container_name: getText(p, 'name'),
    container_id: getText(p, 'legacy_id'),
    label_tag: (known || UNTAGGED_LABEL).toUpperCase(),
    container_rfid_tag: getText(p, 'rfid_tag'),
    container_type: pyText(either(p, 'container_type_label', 'container_type')),
    container_status: status(p, 'status'),
  };
}

/** fields.py `field_values`: {key: text} for every catalog key of the
 *  payload's type (an item without `asset_id` is a container), plus
 *  `ft:<header>` for each column of an asset's From-To row. Missing data
 *  is ''; Split, Strip and the other per-element rules are the compiler's. */
export function fieldValues(payload: PyValue, context: PyValue | undefined): Record<string, string> {
  if (!isPyDict(payload)) throw new TypeError('the payload is not a mapping');
  // `context or {}`: a falsy context is none; anything else must be a dict
  const ctx: PyDict = pyTruthy(context) ? (context as PyDict) : new Map();
  if (!isPyDict(ctx)) throw new TypeError('label_context is not a mapping');
  const computed: Record<string, string> = moveValues(ctx);
  const out: Record<string, string> = Object.create(null);
  if (payload.has('asset_id')) {
    Object.assign(computed, assetValues(payload));
    for (const key of ASSET_KEYS) out[key] = computed[key];
    const rawFt = payload.get('raw_ft');
    if (isPyDict(rawFt)) {
      for (const [header, value] of rawFt) out[`${FT_PREFIX}${header}`] = pyText(value);
    }
    return out;
  }
  Object.assign(computed, containerValues(payload));
  for (const key of CONTAINER_KEYS) out[key] = computed[key];
  return out;
}
