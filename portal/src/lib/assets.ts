/**
 * Assets page logic — pure functions the components delegate to, so the
 * behaviour is unit-testable without jsdom (the lib/sites.ts pattern).
 */
import type { AssetItem, AssetModelItem } from './api';
import { passesFacets, type FacetState } from './listTools';

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
  return [a.serial_number, a.name, a.rfid_tag, a.location_detail,
          a.client_name, a.site_name, a.model?.make, a.model?.model]
    .filter(Boolean).join(' ').toLowerCase();
}

export function matchesAssetFacets(a: AssetItem, state: FacetState): boolean {
  return passesFacets(state, (group) => {
    switch (group) {
      case 'status': return [a.status];
      case 'category': return a.model?.category ? [a.model.category] : [];
      case 'client': return a.client_id ? [a.client_id] : [];
      case 'site': return a.site_id ? [a.site_id] : [];
      case 'model': return a.model_id ? [a.model_id] : [];
      case 'archived': return [a.archived_at ? 'yes' : 'no'];
      default: return [];
    }
  });
}

export function modelSearchText(m: AssetModelItem): string {
  return [m.make, m.model, m.rail_type, ...m.aliases].filter(Boolean).join(' ').toLowerCase();
}

export function matchesModelFacets(m: AssetModelItem, state: FacetState): boolean {
  return passesFacets(state, (group) => {
    switch (group) {
      case 'category': return m.category ? [m.category] : [];
      case 'mount': return m.mount_type ? [m.mount_type] : [];
      case 'knowledge': return [m.knowledge.trim() ? 'yes' : 'no'];
      default: return [];
    }
  });
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

/* ── asset edit/create form ────────────────────────────────────── */

export interface AssetFormState {
  serial_number: string; name: string; rfid_tag: string;
  model_id: string; client_id: string; site_id: string;
  location_detail: string; status: string;
  has_rails: '' | 'yes' | 'no';        // tri-state: '' = unknown
}

export function formFromAsset(a: AssetItem | null): AssetFormState {
  return {
    serial_number: a?.serial_number ?? '',
    name: a?.name ?? '',
    rfid_tag: a?.rfid_tag ?? '',
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

/* ── model edit/create form ────────────────────────────────────── */

export interface ModelFormState {
  make: string; model: string; category: string; ru_size: string;
  weight_lbs: string; weight_kg: string;
  length_in: string; width_in: string; height_in: string;
  length_cm: string; width_cm: string; height_cm: string;
  mount_type: string; rail_type: string; knowledge: string;
}

const numStr = (v: number | null): string => (v === null ? '' : String(v));

export function formFromModel(m: AssetModelItem | null): ModelFormState {
  return {
    make: m?.make ?? '', model: m?.model ?? '',
    category: m?.category ?? '', ru_size: numStr(m?.ru_size ?? null),
    weight_lbs: numStr(m?.weight_lbs ?? null), weight_kg: numStr(m?.weight_kg ?? null),
    length_in: numStr(m?.length_in ?? null), width_in: numStr(m?.width_in ?? null),
    height_in: numStr(m?.height_in ?? null),
    length_cm: numStr(m?.length_cm ?? null), width_cm: numStr(m?.width_cm ?? null),
    height_cm: numStr(m?.height_cm ?? null),
    mount_type: m?.mount_type ?? '', rail_type: m?.rail_type ?? '',
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
