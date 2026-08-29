/** Pure helpers for OrgDirectory — the shared page powering both Clients
 *  and Partners (portal/src/pages/{Clients,Partners}.tsx via
 *  OrgDirectory.tsx). The row type lives here (moved out of the page)
 *  so it's shared with this module without a component import, plus the
 *  org-PATCH error map and the god-edit descriptor table. */

import type { StatusValue } from './api';
import type { GodField } from './godEdit';
import { longDate } from './format';

export interface ManagerRef { id: string; display_name: string }

export interface OrgItem {
  id: string;
  name: string;
  code: string | null;
  partner_types: string[];
  status: string;
  tier: string | null;             // clients only; null for partners
  service_region: string | null;   // partners only; null for clients
  phone: string | null;
  website: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
  notes: string | null;
  account_manager: ManagerRef | null;
  contact_count: number;
  logo_url: string | null;
  archived_at: string | null;
  created_at: string;
}

/** Archived orgs don't hide — they surface as a fourth status alongside
 *  the three real `status` values, both in the pill quick-filter and (now)
 *  in the Status column's own text/checkbox filter. Moved out of
 *  OrgDirectory.tsx so orgCellText (below) computes the exact same value
 *  the page's pills/sort/cell already do. */
export function effectiveStatus(o: OrgItem): string {
  return o.archived_at ? 'archived' : o.status;
}

/** Status label/style — moved out of OrgDirectory.tsx so orgCellText can
 *  read the same label the status chip renders. */
export const STATUS_META: Record<string, { label: string; cls: string }> = {
  prospect: { label: 'Prospect', cls: 'c-blue' },
  active: { label: 'Active', cls: 'c-green' },
  dormant: { label: 'In-Active', cls: 'c-amber' },
  archived: { label: 'Archived', cls: 'c-red' },
};

/** Partner-type label map (the Type column, partners only). Partner types
 *  now come from the `partner_type` status-values vocabulary (GET
 *  /status-values?record_type=partner_type — see OrgDirectory.tsx, which
 *  fetches it and builds the `Map<string, StatusValue>` passed to
 *  `partnerTypeLabel`/`partnerTypeColor`/`orgCellText` below). This map is
 *  a last-resort fallback only, for a key the vocabulary no longer knows
 *  about (predates the vocab, or was renamed) — it is never the primary
 *  source again. */
export const TYPE_LABEL: Record<string, string> = {
  staffing: 'Staffing', logistics: 'Logistics', subcontractor: 'Subcontractor',
  consultant: 'Consultant', other: 'Other',
};

/** Resolve one partner_type key's display label: the live vocabulary first,
 *  then TYPE_LABEL, then the raw key itself — so a retired or otherwise
 *  unknown key still renders (by key) instead of vanishing. Pure: the
 *  vocab map is passed in, never fetched here. */
export function partnerTypeLabel(key: string, vocab: Map<string, StatusValue>): string {
  return vocab.get(key)?.label ?? TYPE_LABEL[key] ?? key;
}

/** Resolve one partner_type key's chip colour from the vocabulary. Returns
 *  undefined for a retired/unknown key so callers can leave the `--chip`
 *  inline style unset — directory.css's `@property --chip` then supplies
 *  the `#51606f` fallback automatically. */
export function partnerTypeColor(key: string, vocab: Map<string, StatusValue>): string | undefined {
  return vocab.get(key)?.color;
}

/** Column-menu accessor (lib/columnMenu.tsx's `CellText<T>`) — one row's
 *  display text for a given column key. Mirrors exactly what the page's own
 *  cell renderer shows: 'status' reads effectiveStatus through STATUS_META
 *  (so 'Archived' is a selectable value, same as the pill), 'tier' (clients
 *  only) shows the raw key unlabeled, 'service_region' (partners only) shows
 *  the freeform text, and 'type' joins the partner-types chip list, resolved
 *  through `typeVocab` (see `partnerTypeLabel`). 'primary' is the
 *  always-shown name+code/city cell — no archived pseudo-column is needed
 *  since archived already lives inside 'status'.
 *
 *  `typeVocab` defaults to an empty map so this still satisfies
 *  columnMenu's `CellText<OrgItem>` (a 2-arg callback) wherever the vocab
 *  isn't relevant or hasn't loaded yet — callers that care (OrgDirectory)
 *  bind it via a small wrapper before handing the function to ColumnMenu. */
export function orgCellText(
  o: OrgItem, colKey: string, typeVocab: Map<string, StatusValue> = new Map(),
): string {
  switch (colKey) {
    case 'primary': {
      const secondary = [o.code, [o.city, o.region].filter(Boolean).join(', ')]
        .filter(Boolean).join(' · ');
      return `${o.name} ${secondary}`.trim();
    }
    case 'type': return o.partner_types.length
      ? o.partner_types.map((t) => partnerTypeLabel(t, typeVocab)).join(', ') : '—';
    case 'tier': return o.tier ?? '—';
    case 'service_region': return o.service_region ?? '—';
    case 'status': return STATUS_META[effectiveStatus(o)]?.label ?? effectiveStatus(o);
    case 'manager': return o.account_manager?.display_name ?? '—';
    case 'contacts': return String(o.contact_count);
    case 'website': return o.website ?? '—';
    case 'phone': return o.phone ?? '—';
    case 'location': return [o.city, o.region].filter(Boolean).join(', ') || '—';
    case 'created': return longDate(o.created_at);
    case 'city': return o.city ?? '—';
    case 'region': return o.region ?? '—';
    case 'postal_code': return o.postal_code ?? '—';
    case 'country': return o.country;
    case 'address_line1': return o.address_line1 ?? '—';
    case 'address_line2': return o.address_line2 ?? '—';
    case 'notes': return o.notes || '—';
    default: return '';
  }
}

/** Codes update_org (PATCH /clients|partners/{id}, api/src/serversherpa/
 *  api/routes/stakeholders.py:_make_org_router.update_org) can raise,
 *  plus the generic 403 every require_permission dependency raises
 *  (api/src/serversherpa/api/deps.py:93-93). Verified against the
 *  handler: name_or_code_in_use (_commit_or_409's IntegrityError catch),
 *  manager_not_found (_apply, when account_manager_id doesn't resolve to
 *  a Person), org_not_found (_get_org), {field}_required for
 *  name/status/country (plus tier for clients only) — the OrgUpdateIn
 *  fields the handler refuses to accept a null for once the key is
 *  present in the body — and tier_not_allowed / service_region_not_allowed
 *  when the wrong kind's org sends the other kind's field. */
export const ORG_ERRORS: Record<string, string> = {
  name_or_code_in_use: 'That name or code is already in use.',
  manager_not_found: 'Pick a valid account manager.',
  org_not_found: 'This record no longer exists.',
  name_required: 'Name is required.',
  status_required: 'Status is required.',
  tier_required: 'Tier is required.',
  country_required: 'Country is required.',
  tier_not_allowed: 'Partners do not have a tier.',
  service_region_not_allowed: 'Clients do not have a service region.',
  forbidden: 'You do not have permission to change this.',
};

/* ── god-edit descriptors ──────────────────────────────────────────
 * Every field below round-trips through PATCH /clients|partners/{id} as
 * a genuine single-field patch: OrgUpdateIn (api/src/serversherpa/api/
 * routes/stakeholders.py:367-385) has `extra="forbid"` and every field
 * is optional, and update_org does `body.model_dump(exclude_unset=True)`
 * before applying — a one-key body only ever touches that key. Left
 * read-only, deliberately, with no descriptor:
 *   - `partner_types` (the Type column, partners only) is a multi-select
 *     list — GodField has no multi-value kind, and the checkbox-grid
 *     picker already in OrgFormModal is the right UI for it;
 *   - `account_manager_id` needs a person_id -> display_name lookup this
 *     page doesn't load at mount (only OrgFormModal fetches /people, and
 *     only once opened) — the same reasoning Workers used to leave
 *     `partner` read-only;
 *   - `contact_count` and `logo_url` are server-computed rollups with no
 *     single-field PATCH path at all;
 *   - `archived_at` has its own guarded endpoints (POST .../archive |
 *     .../unarchive), not a PATCH field on OrgUpdateIn. */
export function ORG_GOD_FIELDS(): GodField<OrgItem>[] {
  return [
    { column: 'primary', field: 'name', kind: 'text',
      fromRow: (o) => o.name },
    { column: 'primary2', field: 'code', kind: 'text',
      fromRow: (o) => o.code ?? '' },
    { column: 'tier', field: 'tier', kind: 'select',
      fromRow: (o) => o.tier ?? '',
      options: () => [
        { value: 'standard', label: 'Standard' },
        { value: 'preferred', label: 'Preferred' },
        { value: 'strategic', label: 'Strategic' },
      ] },
    { column: 'service_region', field: 'service_region', kind: 'text',
      fromRow: (o) => o.service_region ?? '' },
    { column: 'status', field: 'status', kind: 'select',
      fromRow: (o) => o.status,
      options: () => [
        { value: 'prospect', label: 'Prospect' },
        { value: 'active', label: 'Active' },
        { value: 'dormant', label: 'In-Active' },
      ] },
    { column: 'phone', field: 'phone', kind: 'text',
      fromRow: (o) => o.phone ?? '' },
    { column: 'website', field: 'website', kind: 'text',
      fromRow: (o) => o.website ?? '' },
    { column: 'city', field: 'city', kind: 'text',
      fromRow: (o) => o.city ?? '' },
    { column: 'region', field: 'region', kind: 'text',
      fromRow: (o) => o.region ?? '' },
    { column: 'postal_code', field: 'postal_code', kind: 'text',
      fromRow: (o) => o.postal_code ?? '' },
    { column: 'country', field: 'country', kind: 'text',
      fromRow: (o) => o.country },
    { column: 'address_line1', field: 'address_line1', kind: 'text',
      fromRow: (o) => o.address_line1 ?? '' },
    { column: 'address_line2', field: 'address_line2', kind: 'text',
      fromRow: (o) => o.address_line2 ?? '' },
    { column: 'notes', field: 'notes', kind: 'text',
      fromRow: (o) => o.notes ?? '' },
  ];
}
