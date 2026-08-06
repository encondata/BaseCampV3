/** Pure helpers for the Workers page — the row type (moved out of Workers.tsx
 *  so it's shared with this module without a component import), the
 *  profile-PATCH error map, and the god-edit descriptor table. */

import type { ComboOption } from '../components/ComboBox';
import type { StatusValue } from './api';
import type { GodField } from './godEdit';

export interface PartnerRef { id: string; name: string }

export interface WorkerItem {
  person_id: string;
  display_name: string;
  first_name: string;
  last_name: string;
  contact_email: string | null;
  phone: string | null;
  avatar_url: string | null;
  has_account: boolean;
  trade: string | null;
  level: string | null;
  status: string;
  status_label: string;
  status_color: string;
  status_note: string | null;
  partner: PartnerRef | null;
  cert_count: number;
  certs_expired: number;
}

/** Codes upsert_profile (PUT /workers/{id}/profile, api/src/serversherpa/api/
 *  routes/workers.py) can raise, plus the generic 403 every require_permission
 *  dependency raises (api/src/serversherpa/api/deps.py:93). Verified against
 *  workers.py: person_not_found / not_a_worker (_require_worker helper),
 *  status_required (NON_NULLABLE_PROFILE_FIELDS), blacklist_requires_note,
 *  rank_too_low, cannot_target_self, unknown_level, partner_not_found,
 *  unknown_status. */
export const WORKER_ERRORS: Record<string, string> = {
  person_not_found: 'This worker no longer exists.',
  not_a_worker: 'This person no longer holds the worker role.',
  status_required: 'Status is required.',
  blacklist_requires_note: 'Blacklisting requires a reason — use Edit profile.',
  rank_too_low: 'Their rank is at or above yours.',
  cannot_target_self: 'You cannot blacklist yourself.',
  unknown_level: 'That level no longer exists — pick another.',
  partner_not_found: 'That partner no longer exists.',
  unknown_status: 'That status no longer exists — pick another.',
  forbidden: 'You do not have permission to change workers.',
};

/* ── god-edit descriptors ──────────────────────────────────────────
 * Only trade/level/status round-trip through PUT /workers/{id}/profile as a
 * genuine single-field PATCH — the endpoint does `body.model_dump
 * (exclude_unset=True)`, so a one-key body only ever touches that key,
 * despite the PUT verb. Left read-only, deliberately, with no descriptor:
 *   - the name cell (`display_name`) is sourced from the Person record and
 *     edited via PUT /users/{id}/profile — a different endpoint entirely;
 *   - `partner` would need a partner_id -> name lookup this page doesn't
 *     otherwise load (ProfileForm in Workers.tsx only fetches the partner
 *     list lazily inside the edit modal), and the profile endpoint's 204
 *     response means the row can't be reconstructed from a server reply
 *     either — god-editing it would either show a stale name or force
 *     loading the full partner list just for this;
 *   - cert_count/certs_expired are rollups computed server-side from a
 *     different table (worker_certifications), with no single-field PATCH
 *     path at all. */
export interface WorkerGodLookups {
  levels: () => ComboOption[];
  statuses: () => ComboOption[];
}

export function WORKER_GOD_FIELDS(lookups: WorkerGodLookups): GodField<WorkerItem>[] {
  return [
    { column: 'trade', field: 'trade', kind: 'text',
      fromRow: (w) => w.trade ?? '' },
    { column: 'level', field: 'level', kind: 'combo',
      fromRow: (w) => w.level ?? '', options: lookups.levels },
    { column: 'status', field: 'status', kind: 'combo',
      fromRow: (w) => w.status, options: lookups.statuses },
  ];
}

/** PUT .../profile returns 204 — no updated row — so after a successful save
 *  the page must reconstruct the row itself rather than trust a response
 *  body. God-edit only ever sends ONE field per commit (see godEdit.tsx's
 *  GodCell), so this only has to merge that field in and, for `status`,
 *  re-denormalise the label/colour the list projection would carry (the row
 *  otherwise only stores the bare key — see routes/workers.py's
 *  `status_fields()`). `level` needs no such lookup: the row never stores a
 *  level label/colour of its own — LevelBadge resolves it at render time
 *  from the page's own `levels` list, so a bare key merge is already
 *  correct, and `trade` is plain text with nothing to denormalise. */
export function applyWorkerPatch(
  row: WorkerItem, body: Record<string, unknown>, statuses: StatusValue[],
): WorkerItem {
  const next: WorkerItem = { ...row, ...body } as WorkerItem;
  if (typeof body.status === 'string') {
    const match = statuses.find((s) => s.key === body.status);
    if (match) {
      next.status_label = match.label;
      next.status_color = match.color;
    }
  }
  return next;
}
