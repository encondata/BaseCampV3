/** Pure helpers for OrgDirectory — the shared page powering both Clients
 *  and Partners (portal/src/pages/{Clients,Partners}.tsx via
 *  OrgDirectory.tsx). The row type lives here (moved out of the page)
 *  so it's shared with this module without a component import, plus the
 *  org-PATCH error map and the god-edit descriptor table. */

import type { GodField } from './godEdit';

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
