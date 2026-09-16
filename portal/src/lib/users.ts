/** Pure helpers for the Users page — the row type (moved out of Users.tsx
 *  so it's shared with this module without a component import), the
 *  profile-PATCH error map, and the god-edit descriptor table. */

import type { MemberItem, PersonDetail, UserDetailOut } from './api';
import type { ManagedUser } from '../components/UserAdminModals';
import type { GodField } from './godEdit';
import { longDate, relativeTime } from './format';

/** self = it's you; readonly = they outrank you; manage = full admin actions;
 *  view = you can see the row but hold no users:change / access:change. */
export type DetailMode = 'self' | 'readonly' | 'manage' | 'view';

/** Role chip palette — shared by the Users list and the user detail page. */
export const ROLE_CLS: Record<string, string> = {
  admin: 'c-amber', staff: 'c-blue', worker: 'c-green',
  client: 'c-violet', vendor: 'c-violet', external: 'c-blue',
};

/** The shape UserAdminModals (edit / reset / roles / state) expect. */
export function toManagedUser(d: UserDetailOut): ManagedUser {
  return {
    person_id: d.person.id,
    display_name: d.person.display_name,
    first_name: d.person.first_name,
    last_name: d.person.last_name,
    preferred_name: d.person.preferred_name,
    job_title: d.person.job_title,
    contact_email: d.person.email,
    phone: d.person.phone,
    roles: d.roles.map((r) => r.role),
    status: d.account.status,
    max_rank: d.max_rank,
    avatar_url: d.person.avatar_url,
  };
}

/** The shape OverrideEditor's `member` prop expects. */
export function toMemberItem(d: UserDetailOut): MemberItem {
  return {
    person_id: d.person.id,
    display_name: d.person.display_name,
    job_title: d.person.job_title,
    login_email: d.account.login_email,
    status: d.account.status,
    roles: d.roles.map((r) => r.role),
    max_rank: d.max_rank,
    avatar_url: d.person.avatar_url,
  };
}

export interface UserItem {
  person_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  display_name: string;
  job_title: string | null;
  phone: string | null;
  contact_email: string | null;
  login_email: string | null;
  roles: string[];
  status: string;
  must_change_password: boolean;
  last_login_at: string | null;
  account_created_at: string | null;
  archived_at: string | null;
  avatar_url: string | null;
  max_rank: number;
}

/** Account-status label/style — moved out of Users.tsx so userCellText
 *  (below) can read the same label the status chip renders. */
export const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'c-green' },
  locked: { label: 'Locked', cls: 'c-amber' },
  disabled: { label: 'Disabled', cls: 'c-red' },
};

/** Codes admin_update_profile (PATCH /users/{person_id}/profile, api/src/
 *  serversherpa/api/routes/users.py) can raise, via its own checks and the
 *  _load_target/_require_global helpers it calls, plus the generic 403
 *  every require_permission dependency raises. Verified against users.py:
 *  user_not_found (_load_target), cannot_target_self (_load_target),
 *  rank_too_low (_actor_can_touch), forbidden (_require_global).
 *  email_in_use is defensive — unreachable via the job_title/phone fields
 *  god-edit actually sends (see USER_GOD_FIELDS below), but the same PATCH
 *  can raise it for other callers (AdminEditProfileModal), and the External
 *  page's god-edit adoption shares this exact map for its `phone` field. */
export const USER_ERRORS: Record<string, string> = {
  user_not_found: 'This user no longer exists.',
  cannot_target_self: "That's you — use My profile instead.",
  rank_too_low: 'Their rank is at or above yours.',
  forbidden: 'You do not have permission to change users.',
  email_in_use: 'That contact email is already in use.',
};

/* ── god-edit descriptors ──────────────────────────────────────────
 * Only job_title and phone round-trip through PATCH /users/{person_id}/
 * profile (ProfileUpdateIn, api/src/serversherpa/api/schemas.py:199-216) as
 * a genuine single-field PATCH — the endpoint does `body.model_dump
 * (exclude_unset=True)`, so a one-key body only ever touches that key.
 * Left read-only, deliberately, with no descriptor:
 *   - roles/status/must_change_password are guarded flows (role grants via
 *     PUT /roles, account lifecycle via POST /enable|disable|unlock) with
 *     their own confirm-and-audit modals, not a row-level PATCH at all;
 *   - contact_email maps to ProfileUpdateIn's `email` field and COULD PATCH
 *     singly, but email changes stay read-only per the task brief — the
 *     guarded Edit-profile modal is the only place that field moves;
 *   - last_login/created are server-computed rollups with no PATCH path. */
export function USER_GOD_FIELDS(): GodField<UserItem>[] {
  return [
    { column: 'job_title', field: 'job_title', kind: 'text',
      fromRow: (u) => u.job_title ?? '' },
    { column: 'phone', field: 'phone', kind: 'text',
      fromRow: (u) => u.phone ?? '' },
  ];
}

/** Global search-box text — every column's cellText joined, so typing
 *  matches whatever a user can already see in the row. */
export function userSearchText(u: UserItem): string {
  return [
    u.display_name, u.login_email, u.contact_email, u.job_title, u.phone,
    ...u.roles,
  ].filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor (lib/columnMenu.tsx's `CellText<T>`) — one row's
 *  display text for a given column key. Mirrors exactly what the page's own
 *  cell renderer shows: 'status' reads the same STATUS_META label the chip
 *  shows (not the bare key), 'roles' joins the chip list into one string
 *  (an exact-value checkbox can't multi-select out of a joined cell, but
 *  typing still substring-matches — same rollup-column tradeoff Sites made
 *  for its 'clients' column), and 'last_login'/'created' use the same
 *  relative/long-date formatters the cells render. 'primary' is the
 *  always-shown name+email cell. 'must_change' is a pseudo-column (no
 *  COLUMNS entry, no visible header label) behind the trailing chevron
 *  header's ColumnMenu — mirrors Assets' 'archived' pseudo-column — so the
 *  "Password change required" filter that used to live in the page's
 *  bespoke Filters popover survives as a persisted column filter instead. */
export function userCellText(u: UserItem, colKey: string): string {
  switch (colKey) {
    case 'primary': return `${u.display_name} ${u.login_email ?? u.contact_email ?? ''}`.trim();
    case 'roles': return u.roles.length ? u.roles.join(', ') : 'no roles';
    case 'status': return STATUS_META[u.status]?.label ?? u.status;
    case 'job_title': return u.job_title ?? '—';
    case 'contact_email': return u.contact_email ?? '—';
    case 'phone': return u.phone ?? '—';
    case 'last_login': return relativeTime(u.last_login_at);
    case 'created': return longDate(u.account_created_at);
    case 'must_change': return u.must_change_password ? 'Yes' : 'No';
    default: return '';
  }
}

/** admin_update_profile returns the full PersonDetail — trust the server's
 *  values for the two fields god-edit can touch rather than echoing back
 *  what was sent, so any server-side normalisation is reflected. */
export function applyUserPatch(row: UserItem, detail: PersonDetail): UserItem {
  return { ...row, job_title: detail.job_title, phone: detail.phone };
}
