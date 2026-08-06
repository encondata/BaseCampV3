/** Pure helpers for OrgDirectory — the shared page powering both Clients
 *  and Partners (portal/src/pages/{Clients,Partners}.tsx via
 *  OrgDirectory.tsx). The row type lives here (moved out of the page)
 *  so it's shared with this module without a component import, plus the
 *  org-PATCH error map and the god-edit descriptor table. */

import type { GodField } from './godEdit';
import { longDate } from './format';

export interface ManagerRef { id: string; display_name: string }

export interface OrgItem {
  id: string;
  name: string;
  code: string | null;
  partner_types: string[];
  status: string;
  tier: string;
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
  dormant: { label: 'Dormant', cls: 'c-amber' },
  archived: { label: 'Archived', cls: 'c-red' },
};

/** Partner-type label map (the Type column, partners only) — moved out of
 *  OrgDirectory.tsx so orgCellText and the OrgFormModal type picker share
 *  one copy. */
export const TYPE_LABEL: Record<string, string> = {
  staffing: 'Staffing', logistics: 'Logistics', subcontractor: 'Subcontractor',
  consultant: 'Consultant', other: 'Other',
};

/** Column-menu accessor (lib/columnMenu.tsx's `CellText<T>`) — one row's
 *  display text for a given column key. Mirrors exactly what the page's own
 *  cell renderer shows: 'status' reads effectiveStatus through STATUS_META
 *  (so 'Archived' is a selectable value, same as the pill), 'tier' shows
 *  the raw key (the cell renders it unlabeled), and 'type' joins the
 *  partner-types chip list. 'primary' is the always-shown name+code/city
 *  cell — no archived pseudo-column is needed since archived already lives
 *  inside 'status'. */
export function orgCellText(o: OrgItem, colKey: string): string {
  switch (colKey) {
    case 'primary': {
      const secondary = [o.code, [o.city, o.region].filter(Boolean).join(', ')]
        .filter(Boolean).join(' · ');
      return `${o.name} ${secondary}`.trim();
    }
    case 'type': return o.partner_types.length
      ? o.partner_types.map((t) => TYPE_LABEL[t] ?? t).join(', ') : '—';
    case 'tier': return o.tier;
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
 *  a Person), org_not_found (_get_org), and {field}_required for
 *  name/status/tier/country — the four OrgUpdateIn fields the handler
 *  refuses to accept a null for once the key is present in the body. */
export const ORG_ERRORS: Record<string, string> = {
  name_or_code_in_use: 'That name or code is already in use.',
  manager_not_found: 'Pick a valid account manager.',
  org_not_found: 'This record no longer exists.',
  name_required: 'Name is required.',
  status_required: 'Status is required.',
  tier_required: 'Tier is required.',
  country_required: 'Country is required.',
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
      fromRow: (o) => o.tier,
      options: () => [
        { value: 'standard', label: 'Standard' },
        { value: 'preferred', label: 'Preferred' },
        { value: 'strategic', label: 'Strategic' },
      ] },
    { column: 'status', field: 'status', kind: 'select',
      fromRow: (o) => o.status,
      options: () => [
        { value: 'prospect', label: 'Prospect' },
        { value: 'active', label: 'Active' },
        { value: 'dormant', label: 'Dormant' },
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
