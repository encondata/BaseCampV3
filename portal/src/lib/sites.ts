/** Pure helpers for the Sites page — filtering, search text, and the
 *  payload builders. Kept out of the component so they're unit-testable. */

import type { SiteItem, SurveySchema } from './api';

export interface SiteFilters {
  type: string[];
  status: string[];
  client: string[];
  country: string[];
  coords: string[];        // 'yes' | 'no'
}

export const EMPTY_SITE_FILTERS: SiteFilters = {
  type: [], status: [], client: [], country: [], coords: [],
};

export function matchesSiteFilters(site: SiteItem, f: SiteFilters): boolean {
  if (f.type.length && !f.type.includes(site.site_type ?? '')) return false;
  if (f.status.length && !f.status.includes(site.status)) return false;
  if (f.client.length && !site.clients.some((c) => f.client.includes(c.client_id))) {
    return false;
  }
  if (f.country.length && !f.country.includes(site.country)) return false;
  if (f.coords.length) {
    const has = site.latitude !== null && site.longitude !== null;
    if (!f.coords.includes(has ? 'yes' : 'no')) return false;
  }
  return true;
}

export function siteSearchText(site: SiteItem): string {
  return [
    site.name, site.code, site.type_label, site.status_label, site.city,
    site.region, site.country, site.dc_provider, site.partner_name,
    ...site.clients.map((c) => c.name),
  ].filter(Boolean).join(' ').toLowerCase();
}

export function formatCoords(lat: number | null, lon: number | null): string {
  if (lat === null || lon === null) return '—';
  return `${lat}, ${lon}`;
}

export interface SiteFormState {
  name: string; code: string; site_type: string; status: string;
  address_line1: string; address_line2: string; city: string; region: string;
  postal_code: string; country: string; latitude: string; longitude: string;
  timezone: string; dc_provider: string; partner_id: string; notes: string;
}

export function formFromSite(site: SiteItem | null): SiteFormState {
  return {
    name: site?.name ?? '',
    code: site?.code ?? '',
    site_type: site?.site_type ?? '',
    status: site?.status ?? '',
    address_line1: site?.address_line1 ?? '',
    address_line2: site?.address_line2 ?? '',
    city: site?.city ?? '',
    region: site?.region ?? '',
    postal_code: site?.postal_code ?? '',
    country: site?.country ?? 'US',
    latitude: site?.latitude != null ? String(site.latitude) : '',
    longitude: site?.longitude != null ? String(site.longitude) : '',
    timezone: site?.timezone ?? '',
    dc_provider: site?.dc_provider ?? '',
    partner_id: site?.partner_id ?? '',
    notes: site?.notes ?? '',
  };
}

const TEXT_FIELDS: (keyof SiteFormState)[] = [
  'name', 'code', 'site_type', 'status', 'address_line1', 'address_line2',
  'city', 'region', 'postal_code', 'country', 'timezone', 'dc_provider',
  'partner_id', 'notes',
];

export function sitePayload(form: SiteFormState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TEXT_FIELDS) {
    const value = form[key].trim();
    if (value) out[key] = value;
  }
  // Coordinates travel together: both set, or both explicitly cleared.
  const lat = form.latitude.trim();
  const lon = form.longitude.trim();
  if (lat && lon) {
    out.latitude = Number(lat);
    out.longitude = Number(lon);
  } else if (!lat && !lon) {
    out.latitude = null;
    out.longitude = null;
  } else {
    // half a coordinate — send it and let the server say invalid_coordinates
    out.latitude = lat ? Number(lat) : null;
    out.longitude = lon ? Number(lon) : null;
  }
  return out;
}

export function surveyPayload(
  values: Record<string, unknown>, schema: SurveySchema,
): Record<string, unknown> {
  const kinds = new Map<string, string>();
  for (const group of schema.groups) {
    for (const field of group.fields) kinds.set(field.key, field.kind);
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const kind = kinds.get(key);
    if (!kind) continue;                       // unknown key — never send it
    if (kind === 'bool') {
      if (raw === true) out[key] = true;
      continue;                                // false/undefined = unanswered
    }
    if (kind === 'int') {
      const n = Number(String(raw ?? '').trim());
      if (String(raw ?? '').trim() !== '' && Number.isInteger(n)) out[key] = n;
      continue;
    }
    const text = String(raw ?? '').trim();
    if (text) out[key] = text;
  }
  return out;
}

/** Compare two client-id sets for equality regardless of order — lets the
 *  edit-mode Save skip the PUT to /sites/{id}/clients when nothing changed. */
export function sameClientSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((id) => sa.has(id));
}

/** Deep-compare two survey answer sets after normalizing both through
 *  surveyPayload (drops unknown keys, coerces by kind) — so re-rendering
 *  the same answers back never triggers a needless PUT. */
export function surveyChanged(
  original: Record<string, unknown>, next: Record<string, unknown>, schema: SurveySchema,
): boolean {
  const a = surveyPayload(original, schema);
  const b = surveyPayload(next, schema);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return true;
  return false;
}

/* ── create-mode save trap ───────────────────────────────────────────
 * Mirrors external.ts's planAddContact/afterLinkFailure: once createSite
 * has succeeded for this modal session, a retry (e.g. after the
 * client-link step fails) must NEVER call createSite again — it must
 * PATCH the site that already exists. These two pure helpers own that
 * decision so it's testable without a live API. */

export interface SiteSaveState {
  isCreateMode: boolean;      // the modal opened with site=null
  createdId: string | null;   // set once createSite has succeeded this session
}

/** Does this Save press need to POST a new site, or PATCH one that
 *  already exists (editing, or a previous attempt already created it)? */
export function needsSiteCreate(state: SiteSaveState): boolean {
  return state.isCreateMode && state.createdId === null;
}

export const SITE_CREATED_UNLINKED_MESSAGE =
  'Site created — the client links could not be saved. Press Save to retry.';

/** State transition after setSiteClients fails right after a successful
 *  createSite: the site now exists, so no future retry may re-create it —
 *  only the message needs to explain what's left to retry. Returns null
 *  when nothing was created (a plain, unrelated failure).
 *
 *  `reason` is the caller's code-mapped explanation for the link failure —
 *  appended so a permanent failure (e.g. client_not_found) doesn't read as
 *  a bare "press Save to retry" that loops forever with no explanation. */
export function afterSiteClientsFailure(createdId: string | null, reason?: string): string | null {
  if (!createdId) return null;
  return reason ? `${SITE_CREATED_UNLINKED_MESSAGE} ${reason}` : SITE_CREATED_UNLINKED_MESSAGE;
}

/** Natural, case-insensitive ordering for list columns: da1 < da2 < da10
 *  (plain string compare puts da10 between da1 and da2). One shared
 *  collator — constructing one per comparison is measurably slow. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}
