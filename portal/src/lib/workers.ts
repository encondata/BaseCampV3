/** Pure helpers for the Workers page — the row type (moved out of Workers.tsx
 *  so it's shared with this module without a component import), the
 *  profile-PATCH error map, and the god-edit descriptor table. */

import type { ComboOption } from '../components/ComboBox';
import { apiFetch, type StatusValue } from './api';
import type { GodField } from './godEdit';

export interface PartnerRef { id: string; name: string }

/** The slice of Workers.tsx's page-local LevelDef that workerCellText needs
 *  to render the same "L2 · Journeyman" text the LevelBadge cell shows —
 *  kept minimal so this module doesn't have to import the page's type. */
export interface WorkerLevelLookup { level: string; title: string }

/** Worker level definition (worker_levels), moved out of Workers.tsx so the
 *  extracted worker components (LevelBadge, ProfileForm) and the full-detail
 *  page can share one shape instead of each declaring their own LevelDef. */
export interface WorkerLevelDef {
  level: string;
  rank: number;
  title: string;
  description: string;
  expected_skills: string[];
  color: string | null;
}

// `blacklist` is the one worker status key that is NOT just-another-status,
// and cannot become one by making the vocabulary dynamic:
//   - worker_profiles has a CHECK hardcoding the literal (status != 'blacklist'
//     OR status_note IS NOT NULL), so the reason field is a DB requirement
//   - workers.py enforces a rank rule and a not-yourself rule on it
//   - it disables the login account, which no other status does
// Data-driving this (a requires_note column) is YAGNI until a second status
// needs it — and the CHECK would still name this literal.
export const WORKER_BLACKLIST = 'blacklist';

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
/** Global search-box text — every column's cellText joined, so typing
 *  matches whatever a user can already see in the row. */
export function workerSearchText(w: WorkerItem, levels: WorkerLevelLookup[]): string {
  const def = w.level ? levels.find((l) => l.level === w.level) : undefined;
  return [
    w.display_name, w.trade, w.level, def?.title,
    w.partner?.name ?? 'direct', w.contact_email, w.phone,
  ].filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor (lib/columnMenu.tsx's `CellText<T>`) — one row's
 *  display text for a given column key. Mirrors exactly what the page's own
 *  cell renderer shows: 'level' combines the key with the level's title the
 *  way LevelBadge does, 'certs' shows the same "N expired" vs. bare count
 *  the chip/mono cell shows, and 'primary' is the always-shown name+contact
 *  cell. Needs `levels` (not on the row itself) to resolve the level's
 *  title, so — unlike assetCellText/siteCellText — this isn't a bare
 *  (row, colKey) function; pages close over their loaded `levels` list. */
export function workerCellText(w: WorkerItem, colKey: string, levels: WorkerLevelLookup[]): string {
  switch (colKey) {
    case 'primary': return `${w.display_name} ${w.contact_email ?? w.phone ?? ''}`.trim();
    case 'trade': return w.trade ?? '—';
    case 'level': {
      if (!w.level) return 'unleveled';
      const def = levels.find((l) => l.level === w.level);
      return def ? `${w.level} · ${def.title}` : w.level;
    }
    case 'partner': return w.partner?.name ?? 'Direct';
    case 'status': return w.status_label;
    case 'certs': return w.certs_expired > 0 ? `${w.certs_expired} expired` : String(w.cert_count);
    case 'contact': return w.contact_email ?? w.phone ?? '—';
    default: return '';
  }
}

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

/* ── worker full-detail page ─────────────────────────────────────── */

export interface WorkerInitiativeItem {
  initiative_id: string;
  initiative_name: string;
  type_label: string | null;
  type_color: string | null;
  status_label: string;
  status_color: string;
  work_type_label: string | null;
  work_type_color: string | null;
  site_worked_name: string | null;
  rating: number | null;
  added_at: string;
}

export interface WorkerDetailItem extends WorkerItem {
  preferred_name: string | null;
  job_title: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  // country and badge_uid are otherwise non-null (Person.country has a
  // server default, badge_uid is generated) — nullable here because the
  // API redacts them to null for non-global (partner-anchored) actors,
  // per security-fixes task 5 finding (a).
  country: string | null;
  badge_uid: string | null;
  rfid_tag: string | null;
  person_notes: string | null;
  source: string;
  source_ref: string | null;
  created_at: string;
  level_def: WorkerLevelDef | null;
  initiatives: WorkerInitiativeItem[];
}

export async function getWorker(personId: string): Promise<WorkerDetailItem> {
  const resp = await apiFetch(`/workers/${personId}`);
  if (!resp.ok) throw new Error(`worker_${resp.status}`);
  return await resp.json() as WorkerDetailItem;
}
