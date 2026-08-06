/** Pure helpers for the Users page — the row type (moved out of Users.tsx
 *  so it's shared with this module without a component import), the
 *  profile-PATCH error map, and the god-edit descriptor table. */

import type { PersonDetail } from './api';
import type { GodField } from './godEdit';

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

/** admin_update_profile returns the full PersonDetail — trust the server's
 *  values for the two fields god-edit can touch rather than echoing back
 *  what was sent, so any server-side normalisation is reflected. */
export function applyUserPatch(row: UserItem, detail: PersonDetail): UserItem {
  return { ...row, job_title: detail.job_title, phone: detail.phone };
}
