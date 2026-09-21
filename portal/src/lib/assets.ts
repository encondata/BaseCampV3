/**
 * Assets page logic — pure functions the components delegate to, so the
 * behaviour is unit-testable without jsdom (the lib/sites.ts pattern).
 */
import type { ComboOption } from '../components/ComboBox';
import type { AssetItem, AssetModelItem } from './api';
import { displayRfid } from './format';
import type { StoredListPrefs } from './columnMenu';
import { boolTriToPatch, numberToPatch, type GodField } from './godEdit';
import type { ColumnDef } from './listTools';

export const LB_TO_KG = 0.453592;
export const IN_TO_CM = 2.54;

/** Convert one side of a dual-unit pair; toMetric=true means value×factor. */
export function partnerFor(
  value: number | null, factor: number, toMetric: boolean,
): number | null {
  if (value === null || Number.isNaN(value)) return null;
  const v = toMetric ? value * factor : value / factor;
  return Math.round(v * 100) / 100;
}

/** "32 x 1.5 x 18.5" | "32×1.5×18.5" | "32, 1.5, 18.5" → [L, W, H]. */
export function parseDims(input: string): [number, number, number] | null {
  const parts = input.split(/[x×,]/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => Number.isNaN(n) || n < 0)) return null;
  return [nums[0]!, nums[1]!, nums[2]!];
}

export function formatDims(
  l: number | null, w: number | null, h: number | null, unit: string,
): string {
  if (l === null || w === null || h === null) return '—';
  return `${l} × ${w} × ${h} ${unit}`;
}

export function assetSearchText(a: AssetItem): string {
  return [a.legacy_id != null ? String(a.legacy_id) : null, a.serial_number, a.name, a.rfid_tag, a.location_detail,
          a.client_name, a.site_name, a.model?.make, a.model?.model]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor (lib/columnMenu.tsx's `CellText<T>`) — one row's
 *  display text for a given column key. Mirrors exactly what the page's
 *  own cell renderer shows (including its '—' fallback), so the filter
 *  checkbox list and the grid cell never disagree. 'primary' is the
 *  combined serial+name cell (a real, default-on column); 'serial' and
 *  'name' are its selectable split halves. 'archived' isn't a real
 *  COLUMNS entry — it's the pseudo-column behind the chevron header's
 *  ColumnMenu that drives the archived-visibility rule. */
export function assetCellText(a: AssetItem, colKey: string): string {
  switch (colKey) {
    case 'primary': return `${a.serial_number ?? ''} ${a.name ?? ''}`.trim();
    case 'serial': return a.serial_number ?? '—';
    case 'name': return a.name ?? '—';
    case 'asset_id': return a.legacy_id != null ? String(a.legacy_id) : '—';
    case 'status': return a.status_label;
    case 'category': return a.model?.category_label ?? '';
    case 'client': return a.client_name ?? '';
    case 'site': return a.site_name ?? '';
    case 'model': return a.model ? `${a.model.make} ${a.model.model}` : '';
    case 'location': return a.location_detail || '—';
    case 'rfid': return displayRfid(a.rfid_tag);
    case 'pod': return a.pod_number ?? '—';
    case 'ru': return a.model?.ru_size != null ? String(a.model.ru_size) : '—';
    case 'last_seen': return a.last_seen_at ? new Date(a.last_seen_at).toLocaleDateString() : '—';
    case 'has_rails': return a.has_rails === null ? '—' : a.has_rails ? 'Yes' : 'No';
    case 'archived': return a.archived_at ? 'Yes' : 'No';
    default: return '';
  }
}

/* ── identity columns: saved-layout compatibility ──────────────────
 * 'primary' (Serial / Name), 'serial' and 'name' became real, selectable
 * columns after people had already saved Assets layouts. Those saved
 * entries mention none of the three — the combined cell used to be
 * hardcoded, always first, outside the column registry. Visibility needs
 * no help (usePersistentListState surfaces never-seen default columns),
 * but the column order does: applyColumnOrder parks unknown keys last.
 * Pure function so the rule is unit-testable without jsdom. */

export const IDENTITY_KEYS = ['primary', 'serial', 'name'] as const;

/** Identity columns the saved order doesn't mention go FIRST (they were
 *  always first), not last where applyColumnOrder parks unknown keys. */
export function identityFirst(cols: ColumnDef[], order: string[]): ColumnDef[] {
  const unplaced = new Set<string>(IDENTITY_KEYS.filter((k) => !order.includes(k)));
  return [...cols.filter((c) => unplaced.has(c.key)), ...cols.filter((c) => !unplaced.has(c.key))];
}

/** Layouts saved while 'primary' was only a pseudo-key (between the Asset ID
 *  change and the identity-columns change) carry it in `seen` but not in
 *  `visible`; `seen` can't yet mention 'serial'/'name'. Turn the combined
 *  column back on for exactly those, and nothing else — a layout saved
 *  before `seen` existed is handled by usePersistentListState's never-seen
 *  surfacing, and one saved after the split with all three off is the
 *  user's deliberate choice. */
export function migrateIdentityColumns(stored: StoredListPrefs): StoredListPrefs {
  const seen = Array.isArray(stored.seen) ? stored.seen : null;
  const visible = Array.isArray(stored.visible) ? stored.visible : null;
  if (!seen || !visible) return stored;
  const legacy = seen.includes('primary') && !seen.includes('serial') && !seen.includes('name');
  const hasIdentity = IDENTITY_KEYS.some((k) => visible.includes(k));
  return legacy && !hasIdentity ? { ...stored, visible: [...visible, 'primary'] } : stored;
}

export function modelSearchText(m: AssetModelItem): string {
  return [m.make, m.model, m.rail_type, m.form_factor, ...m.aliases]
    .filter(Boolean).join(' ').toLowerCase();
}

export const titleCase = (v: string | null): string =>
  v ? v[0].toUpperCase() + v.slice(1) : '—';

export const FORM_FACTORS = [
  { value: 'standalone', label: 'Standalone' },
  { value: 'chassis', label: 'Chassis' },
  { value: 'node', label: 'Node' },
];

/** "Chassis" / "Node" / "Standalone", or a dash when unset. */
export const formFactorLabel = (v: string | null): string =>
  FORM_FACTORS.find((f) => f.value === v)?.label ?? '—';

/** Column-menu accessor (lib/columnMenu.tsx's `CellText<T>`) for the
 *  AssetModels page. Mirrors the page's own cell renderer exactly —
 *  'weight'/'dims' are the combined display strings the grid shows, while
 *  the godOnly per-unit columns (weight_lbs, length_in, ...) show the bare
 *  number. 'primary' is the always-shown make+model cell; there's no
 *  archived pseudo-column here — the catalog has no archive concept. */
export function modelCellText(m: AssetModelItem, colKey: string): string {
  switch (colKey) {
    case 'primary': return `${m.make} ${m.model}`.trim();
    case 'category': return m.category_label ?? '';
    case 'ru': return m.ru_size !== null ? String(m.ru_size) : '—';
    case 'weight': return m.weight_lbs !== null ? `${m.weight_lbs} lb / ${m.weight_kg} kg` : '—';
    case 'dims': return formatDims(m.length_in, m.width_in, m.height_in, 'in');
    case 'mount': return titleCase(m.mount_type);
    case 'form': return formFactorLabel(m.form_factor);
    case 'rail': return m.rail_type ?? '—';
    case 'aliases': return m.aliases.length ? m.aliases.join(', ') : '—';
    case 'weight_lbs': return m.weight_lbs !== null ? String(m.weight_lbs) : '—';
    case 'weight_kg': return m.weight_kg !== null ? String(m.weight_kg) : '—';
    case 'length_in': return m.length_in !== null ? String(m.length_in) : '—';
    case 'width_in': return m.width_in !== null ? String(m.width_in) : '—';
    case 'height_in': return m.height_in !== null ? String(m.height_in) : '—';
    case 'length_cm': return m.length_cm !== null ? String(m.length_cm) : '—';
    case 'width_cm': return m.width_cm !== null ? String(m.width_cm) : '—';
    case 'height_cm': return m.height_cm !== null ? String(m.height_cm) : '—';
    case 'knowledge': return m.knowledge || '—';
    default: return '';
  }
}

/** Serials appearing on 2+ assets (case-insensitive, blanks ignored). */
export function duplicateSerials(assets: AssetItem[]): Set<string> {
  const seen = new Map<string, number>();
  for (const a of assets) {
    const s = a.serial_number?.trim().toLowerCase();
    if (!s) continue;
    seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([s]) => s));
}

export const ASSET_ERRORS: Record<string, string> = {
  rfid_tag_in_use: 'That RFID tag is already on another asset.',
  asset_model_not_found: 'Pick a model from the catalog list.',
  client_not_found: 'Pick a client from the list.',
  site_not_found: 'Pick a site from the list.',
  unknown_status: 'Pick a status from the list.',
  location_detail_required: 'Location cannot be null.',
  status_required: 'Status is required.',
  forbidden: 'You do not have permission to change assets.',
};

/* ── asset edit/create form ────────────────────────────────────── */

export interface AssetFormState {
  serial_number: string; name: string; rfid_tag: string; pod_number: string;
  model_id: string; client_id: string; site_id: string;
  location_detail: string; status: string;
  has_rails: '' | 'yes' | 'no';        // tri-state: '' = unknown
}

export function formFromAsset(a: AssetItem | null): AssetFormState {
  return {
    serial_number: a?.serial_number ?? '',
    name: a?.name ?? '',
    rfid_tag: a?.rfid_tag ?? '',
    pod_number: a?.pod_number ?? '',
    model_id: a?.model_id ?? '',
    client_id: a?.client_id ?? '',
    site_id: a?.site_id ?? '',
    location_detail: a?.location_detail ?? '',
    status: a?.status ?? 'unknown',
    has_rails: a?.has_rails === true ? 'yes' : a?.has_rails === false ? 'no' : '',
  };
}

/** Payload for create AND patch: trimmed, empty strings become null for
 *  clearable FKs/text (patch) or are omitted (create handles via API's
 *  exclude_none — we just always send null and let create drop them). */
export function assetPayload(form: AssetFormState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, raw: string) => {
    const v = raw.trim();
    if (v) out[key] = v;
    else out[key] = null;
  };
  put('serial_number', form.serial_number);
  put('name', form.name);
  put('rfid_tag', form.rfid_tag);
  put('pod_number', form.pod_number);
  put('model_id', form.model_id);
  put('client_id', form.client_id);
  put('site_id', form.site_id);
  out.location_detail = form.location_detail.trim();
  out.status = form.status;
  out.has_rails = form.has_rails === '' ? null : form.has_rails === 'yes';
  // Nulls stay in: PATCH needs them to clear fields, and POST drops them
  // server-side (create_asset uses model_dump(exclude_none=True)).
  return out;
}

export const MODEL_ERRORS: Record<string, string> = {
  duplicate_model: 'A model with this make + model already exists.',
  unknown_category: 'Pick a category from the list.',
  unknown_mount_type: 'Mount type must be rails, ears, shelf, or custom.',
  unknown_form_factor: 'Form factor must be standalone, chassis, or node.',
  alias_in_use: 'One of these aliases already belongs to another model.',
  make_required: 'Make is required.',
  model_required: 'Model is required.',
  forbidden: 'You do not have permission to change the catalog.',
};

/* ── model edit/create form ────────────────────────────────────── */

export interface ModelFormState {
  make: string; model: string; category: string; ru_size: string;
  weight_lbs: string; weight_kg: string;
  length_in: string; width_in: string; height_in: string;
  length_cm: string; width_cm: string; height_cm: string;
  mount_type: string; rail_type: string; form_factor: string; knowledge: string;
}

const numStr = (v: number | null): string => (v === null ? '' : String(v));

export function formFromModel(
  m: AssetModelItem | null, initial?: { make: string; model: string },
): ModelFormState {
  return {
    make: m?.make ?? initial?.make ?? '', model: m?.model ?? initial?.model ?? '',
    category: m?.category ?? '', ru_size: numStr(m?.ru_size ?? null),
    weight_lbs: numStr(m?.weight_lbs ?? null), weight_kg: numStr(m?.weight_kg ?? null),
    length_in: numStr(m?.length_in ?? null), width_in: numStr(m?.width_in ?? null),
    height_in: numStr(m?.height_in ?? null),
    length_cm: numStr(m?.length_cm ?? null), width_cm: numStr(m?.width_cm ?? null),
    height_cm: numStr(m?.height_cm ?? null),
    mount_type: m?.mount_type ?? '', rail_type: m?.rail_type ?? '',
    form_factor: m?.form_factor ?? '',
    knowledge: m?.knowledge ?? '',
  };
}

const UNIT_FIELDS: [keyof ModelFormState, keyof ModelFormState][] = [
  ['weight_lbs', 'weight_kg'],
  ['length_in', 'length_cm'],
  ['width_in', 'width_cm'],
  ['height_in', 'height_cm'],
];

/**
 * Build the write payload. Unit-pair rule: send ONLY the side the user
 * changed (the API computes the partner); if both sides blanked, send null
 * to clear; untouched pairs are omitted entirely.
 */
export function modelPayload(
  form: ModelFormState, original: AssetModelItem | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const orig = (key: string): unknown => {
    if (original === null) return null;
    return (original as unknown as Record<string, unknown>)[key];
  };
  const changedStr = (key: keyof ModelFormState, origVal: unknown) => {
    const v = form[key].trim();
    const before = (origVal ?? '') as string;
    if (v !== before) out[key] = v || null;
  };

  changedStr('make', orig('make'));
  changedStr('model', orig('model'));
  changedStr('category', orig('category'));
  changedStr('mount_type', orig('mount_type'));
  changedStr('rail_type', orig('rail_type'));
  changedStr('form_factor', orig('form_factor'));
  if (form.knowledge !== ((orig('knowledge') ?? '') as string)) {
    out.knowledge = form.knowledge;
  }
  const ru = form.ru_size.trim();
  if (ru !== numStr((orig('ru_size') as number | null) ?? null)) {
    out.ru_size = ru === '' ? null : Number(ru);
  }

  for (const [imp, met] of UNIT_FIELDS) {
    const impStr = form[imp].trim();
    const metStr = form[met].trim();
    const impOrig = numStr((orig(imp) as number | null) ?? null);
    const metOrig = numStr((orig(met) as number | null) ?? null);
    const impChanged = impStr !== impOrig;
    const metChanged = metStr !== metOrig;
    if (!impChanged && !metChanged) continue;         // untouched pair
    if (impStr === '' && metStr === '') {
      out[imp] = null;                                // clearing clears both
      out[met] = null;
    } else if (impChanged && !metChanged) {
      out[imp] = impStr === '' ? null : Number(impStr);   // null clears the pair server-side
    } else if (metChanged && !impChanged) {
      out[met] = metStr === '' ? null : Number(metStr);
    } else {
      out[imp] = impStr === '' ? null : Number(impStr);
      out[met] = metStr === '' ? null : Number(metStr);
    }
  }
  // create mode: drop nulls (nothing to clear yet)
  if (original === null) {
    for (const key of Object.keys(out)) {
      if (out[key] === null) delete out[key];
    }
  }
  return out;
}

/* ── create-mode save trap ───────────────────────────────────────────
 * Mirrors sites.ts's needsSiteCreate: once createAssetModel has
 * succeeded for this modal session, a retry (e.g. after the
 * setAssetModelAliases step fails) must NEVER call createAssetModel
 * again — it must PATCH the model that already exists. This pure
 * helper owns that decision so it's testable without a live API. */

export interface ModelSaveState {
  isCreateMode: boolean;      // the modal opened with model=null
  createdId: string | null;   // set once createAssetModel has succeeded this session
}

/** Does this Save press need to POST a new model, or PATCH one that
 *  already exists (editing, or a previous attempt already created it)? */
export function needsModelCreate(state: ModelSaveState): boolean {
  return state.isCreateMode && state.createdId === null;
}

/* ── god-edit descriptors ──────────────────────────────────────────
 * Factories, not static tables: combo options come from the page's own
 * loaded lookup lists (models/clients/sites/statuses; categories), so each
 * page builds the descriptor table from its current state via these
 * getters, memoized on those dependencies. See lib/godEdit.tsx for the
 * GodField contract. */

export interface AssetGodLookups {
  models: () => ComboOption[];
  clients: () => ComboOption[];
  sites: () => ComboOption[];
  statuses: () => ComboOption[];
}

export function ASSET_GOD_FIELDS(lookups: AssetGodLookups): GodField<AssetItem>[] {
  return [
    { column: 'primary', field: 'serial_number', kind: 'text',
      fromRow: (a) => a.serial_number ?? '' },
    { column: 'primary2', field: 'name', kind: 'text',
      fromRow: (a) => a.name ?? '' },
    { column: 'rfid', field: 'rfid_tag', kind: 'text',
      fromRow: (a) => a.rfid_tag ?? '' },
    { column: 'pod', field: 'pod_number', kind: 'text',
      fromRow: (a) => a.pod_number ?? '' },
    { column: 'location', field: 'location_detail', kind: 'text',
      fromRow: (a) => a.location_detail },
    { column: 'model', field: 'model_id', kind: 'combo',
      fromRow: (a) => a.model_id ?? '', options: lookups.models },
    { column: 'client', field: 'client_id', kind: 'combo',
      fromRow: (a) => a.client_id ?? '', options: lookups.clients },
    { column: 'site', field: 'site_id', kind: 'combo',
      fromRow: (a) => a.site_id ?? '', options: lookups.sites },
    { column: 'status', field: 'status', kind: 'combo',
      fromRow: (a) => a.status, options: lookups.statuses },
    { column: 'has_rails', field: 'has_rails', kind: 'bool',
      fromRow: (a) => (a.has_rails === true ? 'yes' : a.has_rails === false ? 'no' : ''),
      toPatch: boolTriToPatch },
  ];
}

export interface ModelGodLookups {
  categories: () => ComboOption[];
}

const GOD_MOUNT_OPTIONS: ComboOption[] = [
  { value: 'rails', label: 'Rails' },
  { value: 'ears', label: 'Ears' },
  { value: 'shelf', label: 'Shelf' },
  { value: 'custom', label: 'Custom' },
];

export function MODEL_GOD_FIELDS(lookups: ModelGodLookups): GodField<AssetModelItem>[] {
  const num = (column: string, field: keyof AssetModelItem): GodField<AssetModelItem> => ({
    column, field, kind: 'number',
    fromRow: (m) => numStr(m[field] as number | null),
    toPatch: numberToPatch,
  });
  return [
    { column: 'primary', field: 'make', kind: 'text', fromRow: (m) => m.make },
    { column: 'primary2', field: 'model', kind: 'text', fromRow: (m) => m.model },
    { column: 'category', field: 'category', kind: 'combo',
      fromRow: (m) => m.category ?? '', options: lookups.categories },
    num('ru', 'ru_size'),
    num('weight_lbs', 'weight_lbs'),
    num('weight_kg', 'weight_kg'),
    num('length_in', 'length_in'),
    num('width_in', 'width_in'),
    num('height_in', 'height_in'),
    num('length_cm', 'length_cm'),
    num('width_cm', 'width_cm'),
    num('height_cm', 'height_cm'),
    { column: 'mount', field: 'mount_type', kind: 'select',
      fromRow: (m) => m.mount_type ?? '', options: () => GOD_MOUNT_OPTIONS },
    { column: 'form', field: 'form_factor', kind: 'select',
      fromRow: (m) => m.form_factor ?? '', options: () => FORM_FACTORS },
    { column: 'rail', field: 'rail_type', kind: 'text',
      fromRow: (m) => m.rail_type ?? '' },
    { column: 'knowledge', field: 'knowledge', kind: 'text',
      fromRow: (m) => m.knowledge },
  ];
}
