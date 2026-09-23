/** Pure helpers for the Sites page — filtering, search text, and the
 *  payload builders. Kept out of the component so they're unit-testable. */

import type { ComboOption } from '../components/ComboBox';
import type { SiteItem, SurveySchema } from './api';
import { numberToPatch, type GodField } from './godEdit';
import type { ColumnDef } from './listTools';

// The always-shown name+code cell — a fixed leading track outside the
// column registry (same shape as the page's header markup), so it needs
// its own ColumnDef for listGridStyle/ColHead. Lives here rather than in
// Sites.tsx so the columns test doesn't drag in the page's leaflet-based
// SitesMap import (see lib/initiatives.ts for the same pattern).
export const PRIMARY_COL: ColumnDef = {
  key: 'primary', label: 'Name', width: '2.2fr', default: true, min: 180,
};

// Fit: default columns + trailing ≤ LIST_FIT.page
// (1172px — .portal-page at a 1512px window, nav expanded).
export const SITE_COLUMNS: ColumnDef[] = [
  { key: 'type', label: 'Type', width: '1.1fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'clients', label: 'Clients', width: '1.7fr', default: true },
  { key: 'city', label: 'City', width: '1.1fr', default: true },
  { key: 'country', label: 'Country', width: '0.8fr', default: false },
  { key: 'dc_provider', label: 'DC provider', width: '1.2fr', default: false },
  { key: 'coords', label: 'Coords', width: '1.4fr', default: false },
  {
    key: 'address_line1', label: 'Address line 1', short: 'Address 1',
    width: '1.4fr', default: false, godOnly: true,
  },
  {
    key: 'address_line2', label: 'Address line 2', short: 'Address 2',
    width: '1.4fr', default: false, godOnly: true,
  },
  { key: 'region', label: 'Region', width: '1fr', default: false, godOnly: true },
  { key: 'postal_code', label: 'Postal code', width: '1fr', default: false, godOnly: true },
  { key: 'timezone', label: 'Timezone', width: '1.2fr', default: false, godOnly: true },
  { key: 'notes', label: 'Notes', width: '1.6fr', default: false, godOnly: true },
  { key: 'latitude', label: 'Latitude', width: '0.9fr', default: false, godOnly: true },
  { key: 'longitude', label: 'Longitude', width: '0.9fr', default: false, godOnly: true },
];

export const SITE_ERRORS: Record<string, string> = {
  invalid_coordinates: 'Latitude and longitude must both be set, and within range.',
  unknown_site_type: 'That site type no longer exists — pick another.',
  unknown_status: 'That status no longer exists — pick another.',
  unknown_survey_field: 'A survey field is no longer valid — reload and retry.',
  invalid_survey_value: 'A survey answer has the wrong format.',
  survey_value_not_found: 'That answer was already cleared — reload and retry.',
  client_not_found: 'One of the selected clients no longer exists.',
  site_not_found: 'This site no longer exists.',
  forbidden: 'You do not have permission to change sites.',
  name_required: 'Name is required.',
  status_required: 'Status is required.',
  country_required: 'Country is required.',
};

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

/** Column-menu accessor (lib/columnMenu.tsx's `CellText<T>`) — one row's
 *  display text for a given column key. Mirrors exactly what the page's own
 *  cell renderer shows (including the '—' fallback and the coords display
 *  string), so the filter checkbox list and the grid cell never disagree.
 *  'primary' is the always-shown name+code cell; there's no archived
 *  pseudo-column here — Sites has never hidden or facet-filtered archived
 *  rows (they just carry an inline "Archived" chip), so column menus don't
 *  introduce that behavior either. */
export function siteCellText(site: SiteItem, colKey: string): string {
  switch (colKey) {
    case 'primary': return `${site.name} ${site.code ?? ''}`.trim();
    case 'type': return site.type_label ?? '';
    case 'status': return site.status_label;
    case 'clients': return site.clients.length ? site.clients.map((c) => c.name).join(', ') : '—';
    case 'city': return site.city ?? '—';
    case 'country': return site.country;
    case 'dc_provider': return site.dc_provider ?? '—';
    case 'coords': return formatCoords(site.latitude, site.longitude);
    case 'address_line1': return site.address_line1 ?? '—';
    case 'address_line2': return site.address_line2 ?? '—';
    case 'region': return site.region ?? '—';
    case 'postal_code': return site.postal_code ?? '—';
    case 'timezone': return site.timezone ?? '—';
    case 'notes': return site.notes || '—';
    case 'latitude': return site.latitude === null ? '—' : String(site.latitude);
    case 'longitude': return site.longitude === null ? '—' : String(site.longitude);
    default: return '';
  }
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
      // tri-state: explicit Yes/No both persist; ''/undefined = unanswered
      if (raw === true || raw === false) out[key] = raw;
      continue;
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

/** Diffs the survey form's current values against the loaded baseline and
 *  decides, per field, what to send — driving SiteEditModal's per-field
 *  save loop. Comparison happens on CLEANED values (run through
 *  `surveyPayload`, one key at a time) rather than raw form state: an edit
 *  that round-trips to the same cleaned value (trailing whitespace on text,
 *  a cosmetic int-string difference like "007" vs 7) must not produce a
 *  PUT — it isn't a real change, and sending it grows the raw trail and
 *  audit log with `{from: X, to: X}` noise. A field clears only when the
 *  baseline had a cleaned (answered) value and the new cleaned value is
 *  undefined; an untouched or still-unanswered field produces neither. */
export function surveySaveOps(
  baseline: Record<string, unknown>,
  values: Record<string, unknown>,
  schema: SurveySchema,
): { put: [string, boolean | number | string][]; clear: string[] } {
  const put: [string, boolean | number | string][] = [];
  const clear: string[] = [];
  for (const group of schema.groups) {
    for (const field of group.fields) {
      const key = field.key;
      const cleanedNew = surveyPayload({ [key]: values[key] }, schema)[key];
      const cleanedBase = surveyPayload({ [key]: baseline[key] }, schema)[key];
      if (cleanedNew === cleanedBase) continue;
      if (cleanedNew !== undefined) {
        put.push([key, cleanedNew as boolean | number | string]);
      } else if (cleanedBase !== undefined) {
        clear.push(key);
      }
    }
  }
  return { put, clear };
}

/** Compare two client-id sets for equality regardless of order — lets the
 *  edit-mode Save skip the PUT to /sites/{id}/clients when nothing changed. */
export function sameClientSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((id) => sa.has(id));
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

/* ── god-edit descriptors ──────────────────────────────────────────
 * Factory, not a static table: the type/status combos come from the
 * page's own loaded lookup lists, so the page builds the descriptor
 * table from its current state via these getters, memoized on those
 * dependencies. See lib/godEdit.tsx for the GodField contract. The
 * `clients` rollup and `coords` display column stay read-only — no
 * descriptor here, so god-editing never touches them. */

export interface SiteGodLookups {
  types: () => ComboOption[];
  statuses: () => ComboOption[];
}

const numStr = (v: number | null): string => (v === null ? '' : String(v));

export function SITE_GOD_FIELDS(lookups: SiteGodLookups): GodField<SiteItem>[] {
  return [
    { column: 'primary', field: 'name', kind: 'text',
      fromRow: (s) => s.name },
    { column: 'primary2', field: 'code', kind: 'text',
      fromRow: (s) => s.code ?? '' },
    { column: 'type', field: 'site_type', kind: 'combo',
      fromRow: (s) => s.site_type ?? '', options: lookups.types },
    { column: 'status', field: 'status', kind: 'combo',
      fromRow: (s) => s.status, options: lookups.statuses },
    { column: 'city', field: 'city', kind: 'text',
      fromRow: (s) => s.city ?? '' },
    { column: 'country', field: 'country', kind: 'text',
      fromRow: (s) => s.country },
    { column: 'dc_provider', field: 'dc_provider', kind: 'text',
      fromRow: (s) => s.dc_provider ?? '' },
    // God-only columns: hidden from the column picker until god mode is on.
    { column: 'address_line1', field: 'address_line1', kind: 'text',
      fromRow: (s) => s.address_line1 ?? '' },
    { column: 'address_line2', field: 'address_line2', kind: 'text',
      fromRow: (s) => s.address_line2 ?? '' },
    { column: 'region', field: 'region', kind: 'text',
      fromRow: (s) => s.region ?? '' },
    { column: 'postal_code', field: 'postal_code', kind: 'text',
      fromRow: (s) => s.postal_code ?? '' },
    { column: 'timezone', field: 'timezone', kind: 'text',
      fromRow: (s) => s.timezone ?? '' },
    { column: 'notes', field: 'notes', kind: 'text',
      fromRow: (s) => s.notes ?? '' },
    { column: 'latitude', field: 'latitude', kind: 'number',
      fromRow: (s) => numStr(s.latitude), toPatch: numberToPatch },
    { column: 'longitude', field: 'longitude', kind: 'number',
      fromRow: (s) => numStr(s.longitude), toPatch: numberToPatch },
  ];
}
