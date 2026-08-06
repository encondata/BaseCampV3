/**
 * Pure helpers for the External people page — kept dependency-free so
 * they're trivially unit-testable: display aggregation across a person's
 * org links, the facet predicate feed for the shared FilterButton, and
 * the payload shaping for the "new external contact" one-form flow.
 */

import type { ContactUpdatePatch, ExternalLinkItem, ExternalPersonItem, OrgKind, PersonDetail } from './api';
import type { GodField } from './godEdit';

export function typeLabel(links: ExternalLinkItem[]): string {
  const kinds = new Set(links.map((l) => l.kind));
  if (kinds.size === 0) return '—';
  if (kinds.has('client') && kinds.has('partner')) return 'Both';
  return kinds.has('client') ? 'Client' : 'Partner';
}

export function distinctTitles(links: ExternalLinkItem[]): string[] {
  return [...new Set(links.map((l) => l.org_title).filter((t): t is string => !!t))];
}

export function distinctFunctions(links: ExternalLinkItem[]): string[] {
  return [...new Set(links.flatMap((l) => l.functions))];
}

/** Portal-login label/style — moved out of External.tsx so
 *  externalCellText (below) can read the same label the chip renders. */
export const LOGIN_META: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'c-green' },
  disabled: { label: 'Disabled', cls: 'c-red' },
  none: { label: 'No login', cls: 'tag' },
};

export function externalSearchHay(person: ExternalPersonItem): string {
  return (`${person.display_name} ${person.email ?? ''} ${person.phone ?? ''} ` +
    `${person.links.map((l) => l.org_name).join(' ')} ${distinctTitles(person.links).join(' ')} ` +
    `${distinctFunctions(person.links).join(' ')}`).toLowerCase();
}

/** Column-menu accessor (lib/columnMenu.tsx's `CellText<T>`) — one row's
 *  display text for a given column key. Mirrors exactly what the page's own
 *  cell renderer shows: 'orgs' joins each link's "org · tier" the way its
 *  chips do, and 'login' reads the same LOGIN_META label the chip shows.
 *  This replaces the page's old orgType/org/tier/function/login facets —
 *  filtering the 'orgs' column's joined text covers org name, kind (via
 *  the separate 'type' column) and tier all at once; an exact-value
 *  checkbox can't multi-select out of a joined cell, but typing still
 *  substring-matches (same rollup-column tradeoff Sites made for its
 *  'clients' column). 'primary' is the always-shown name+contact cell. */
export function externalCellText(p: ExternalPersonItem, colKey: string): string {
  switch (colKey) {
    case 'primary': return `${p.display_name} ${p.email ?? p.phone ?? ''}`.trim();
    case 'orgs': return p.links.length ? p.links.map((l) => `${l.org_name} · ${l.tier}`).join(', ') : '—';
    case 'type': return typeLabel(p.links);
    case 'title': return distinctTitles(p.links).join(', ') || '—';
    case 'functions': return distinctFunctions(p.links).join(', ') || '—';
    case 'email': return p.email ?? '—';
    case 'phone': return p.phone ?? '—';
    case 'login': return LOGIN_META[p.login_status]?.label ?? p.login_status;
    default: return '';
  }
}

/** A ComboBox that must pick from two org tables at once (clients + partners)
 *  encodes its option value as "kind:orgId" — these two helpers are the only
 *  place that encoding is built/parsed, so it can't drift out of sync. */
export function orgKey(kind: OrgKind, orgId: string): string {
  return `${kind}:${orgId}`;
}

export function parseOrgKey(key: string): { kind: OrgKind; orgId: string } {
  const idx = key.indexOf(':');
  return { kind: key.slice(0, idx) as OrgKind, orgId: key.slice(idx + 1) };
}

/** Only PATCH org_title/functions when the one-form flow actually set one —
 *  an all-empty payload would still be a legal no-op PATCH, but skipping it
 *  saves a request and keeps the audit trail meaningful. */
export function buildLinkMetaPatch(
  orgTitle: string, functions: string[],
): ContactUpdatePatch | null {
  const title = orgTitle.trim();
  if (!title && functions.length === 0) return null;
  const patch: ContactUpdatePatch = {};
  if (title) patch.org_title = title;
  if (functions.length > 0) patch.functions = functions;
  return patch;
}

export interface NewContactForm {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
}

/** Payload for POST /users when creating a person from the External page —
 *  always without a login account (granting portal access is a separate,
 *  later action from the row's Login panel). */
export function buildNewContactPersonPayload(form: NewContactForm): Record<string, unknown> {
  return {
    first_name: form.first_name.trim(),
    last_name: form.last_name.trim(),
    contact_email: form.email.trim() || null,
    phone: form.phone.trim() || null,
    roles: [],
    create_account: false,
  };
}

/* ── External row: is the Edit modal worth opening? ────────────────
 * Each section of the Edit modal is gated by a different permission, so
 * "can this actor edit this person" is NOT a single flag: org links need
 * the org change perms, avatar + account state need users:change, and
 * granting a first login needs users:add. If none of those apply to this
 * particular person, the Edit button is hidden entirely rather than
 * opening a modal with nothing live in it. */

export interface ExternalEditPerms {
  // users:change → enable/disable, and the avatar control (whose upload the
  // API additionally guards with attachments:add + global anchor — the two
  // travel together on every seeded role, so this gate is the practical one)
  canUsers: boolean;
  canClients: boolean;      // clients:change → client org links
  canPartners: boolean;     // partners:change → partner org links
  canCreatePerson: boolean; // users:add     → grant a first login
}

export function canEditExternalPerson(
  perms: ExternalEditPerms,
  person: Pick<ExternalPersonItem, 'login_status'>,
): boolean {
  // avatar upload is always live for users:change, so this alone qualifies
  if (perms.canUsers) return true;
  // the add-link row is offered whenever either org perm is held, even if
  // this person's *existing* links are all of the other kind
  if (perms.canClients || perms.canPartners) return true;
  // users:add only buys anything when there's no account to grant yet
  return perms.canCreatePerson && person.login_status === 'none';
}

/* ── add-contact modal submit planning ─────────────────────────────
 * The modal has two modes (pick existing / create new) and one hard
 * invariant: once POST /users has succeeded for a new person, a retry
 * after a failed link step must NEVER create that person again. These
 * two pure helpers own that state machine so it's unit-testable. */

export interface AddContactAttempt {
  showNew: boolean;          // modal is in create-new mode
  pick: string;              // ComboBox selection ('' = none)
  createdPersonId: string | null; // person created by a previous attempt
}

/** Decide what this submit must do: run the create step first, or link
 *  an already-known person. A created-but-unlinked person always wins —
 *  even if the modal is still showing the create form. */
export function planAddContact(a: AddContactAttempt):
  { needsCreate: boolean; personId: string } {
  if (a.createdPersonId) return { needsCreate: false, personId: a.createdPersonId };
  if (a.showNew) return { needsCreate: true, personId: '' };
  return { needsCreate: false, personId: a.pick };
}

export const CREATED_UNLINKED_MESSAGE =
  'Contact was created but could not be linked — press Add contact to retry linking.';

/** State transition after the link step fails. When the person was just
 *  created, flip the modal to picker mode with them pre-selected and a
 *  message that distinguishes "retry the link" from "retry everything".
 *  Returns null when nothing was created (plain link failure).
 *
 *  `reason` is the caller's code-mapped explanation for the link failure.
 *  Without it a permanent failure (rank_too_low, already-linked) reads as
 *  a bare "press Add contact to retry" and the user loops forever with no
 *  idea why — so append it whenever the caller could map the code. */
export function afterLinkFailure(createdPersonId: string | null, reason?: string):
  { showNew: false; pick: string; message: string } | null {
  if (!createdPersonId) return null;
  const message = reason
    ? `${CREATED_UNLINKED_MESSAGE} ${reason}`
    : CREATED_UNLINKED_MESSAGE;
  return { showNew: false, pick: createdPersonId, message };
}

/* ── god-edit descriptors ──────────────────────────────────────────
 * Only `phone` round-trips through a genuine single-field PATCH — the
 * SAME endpoint the Users page uses, PATCH /users/{person_id}/profile
 * (ProfileUpdateIn, api/src/serversherpa/api/schemas.py:199-216) — so its
 * error map is lib/users.ts's USER_ERRORS; import that directly at the
 * call site rather than duplicating it here. Left read-only, deliberately,
 * with no descriptor:
 *   - `email` maps 1:1 to ProfileUpdateIn's `email` field too, but stays
 *     read-only per the task brief — email changes are a guarded flow,
 *     not a bare inline edit, on every page that has this column;
 *   - `orgs`/`title`/`functions` are per-org-link fields (ContactProfile,
 *     scoped by BOTH org_id and person_id) — PATCH /clients|partners/
 *     {org_id}/contacts/{person_id} (routes/stakeholders.py:update_contact)
 *     needs an org_id this row's single id can't supply, and a person can
 *     hold several links at once (each with its own title/functions), so
 *     there is no single row-level value to inline-edit anyway — that's
 *     exactly why EditPersonModal's org-links editor stays a modal;
 *   - `type` is a derived label (typeLabel over links), no field of its
 *     own to PATCH;
 *   - `login` is portal-lifecycle (grant/enable/disable) — a guarded,
 *     audited flow with its own confirm modal (GrantAccessModal / the
 *     enable-disable buttons), not a row-level PATCH. */
export function EXTERNAL_GOD_FIELDS(): GodField<ExternalPersonItem>[] {
  return [
    { column: 'phone', field: 'phone', kind: 'text',
      fromRow: (p) => p.phone ?? '' },
  ];
}

/** admin_update_profile returns the full PersonDetail — trust the server's
 *  phone value rather than echoing back what was sent, so any server-side
 *  normalisation is reflected. */
export function applyExternalPatch(
  row: ExternalPersonItem, detail: PersonDetail,
): ExternalPersonItem {
  return { ...row, phone: detail.phone };
}
