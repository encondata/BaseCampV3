# External People Page — Design Spec

**Date:** 2026-07-14 · **Status:** Approved (user waived written review)
**Scope:** Third People page ("External") — combined directory + full management of client/partner contact people, with per-org-link metadata (org title + function tags) and login lifecycle.

## Decisions (from brainstorm)

- Full management in BOTH places: External page AND the org-row contacts panels (consistent controls).
- One combined list (not tabs), standard Filters/Columns/Export toolbar.
- Login lifecycle on External: grant portal access (email + temp password), enable/disable; has-login indicator.
- Per org link, two metadata fields: `org_title` (free text — their title at their company, e.g. "VP Sales") and `functions` (free tags with type-to-filter suggestions from tags already in use, e.g. billing, scheduling, escalation).
- Page gated by the existing `users` resource (people management) — no new registry resource, no matrix migration.

## Data — migration 0010

`contact_profiles`: `person_id` FK people, `client_id` FK clients NULL, `partner_id` FK partners NULL (exactly one set — same check pattern as person_roles), `org_title` text NULL, `functions` jsonb NOT NULL default `[]`, `updated_by` FK people, `created_at`/`updated_at`. PK `(person_id, coalesce-org)` → implement as unique partial indexes per org column. Independent of person_roles so tier revoke+regrant never touches it. Model class `ContactProfile` in db/models.py.

## API

- `GET /external` (stakeholders router, guard `require_permission("users","view")` + scope: non-global actors see only themselves): one row per person holding ≥1 active client/partner-anchored grant OR the `external` role. Shape: `{person_id, display_name, first_name, last_name, email, phone, avatar_url, has_login, login_status: none|active|disabled, links: [{kind, org_id, org_name, tier, org_title, functions}], }` plus top-level `function_tags: [distinct strings in use]`.
- `PATCH /clients|/partners/{org_id}/contacts/{person_id}` gains optional `org_title: str|null`, `functions: list[str]` alongside existing `tier` — any subset; upserts the `contact_profiles` row; audit `contact.update` with field diff (tier changes keep the existing `contact.tier` action).
- `GET .../contacts` includes `org_title` + `functions` per contact.
- `DELETE .../contacts/{person_id}` also deletes the contact_profiles row for that org (metadata dies with the link; audit unchanged).
- No other new writes — page reuses `POST .../contacts`, `POST /users` (create person and/or login), `/users/{id}/enable|disable`.

## Portal

- New page `portal/src/pages/External.tsx`, route `/people/external` (resource `users`), nav item under People. ROUTE_RESOURCE + CommandPalette entries.
- Table columns: Member (avatar+name), Orgs (chips "Acme · admin"), Type (client/partner/both), Title, Functions (chips), Email, Phone, Login (none/active/disabled badge). Toolbar filters: org type, org (ComboBox), tier, function, has-login. CSV export. listTools.tsx patterns (Workers.tsx is the reference consumer).
- Row expand panel: org links editor (add link: org ComboBox + tier select; per link: tier select, org_title input, functions tag-input, remove) + login actions (Grant portal access modal mirroring Users' add-account fields; enable/disable when account exists).
- "New external contact" button: first*/last*/email/phone + org + tier + optional title/functions in one form (POST /users create_account:false → POST contacts → PATCH metadata).
- Tag input: free text + suggestions from `function_tags` (type-to-filter behavior per standing rule).
- Org-row ContactsPanel (OrgDirectory.tsx): shows tier (existing) + org_title + functions, all editable inline via the same PATCH.
- Rank rules as everywhere; controls disabled when `!can('users','change')` / `!can(resource,'change')` per surface.

## Testing

API: /external shape + scoping + has_login/login_status + multi-org person appears once + function_tags distinct; PATCH metadata upsert + audit diff + delete-cascade-on-unlink; rank rules unchanged. Portal: build + vitest for pure helpers (payload builders, filter predicates). No dev-DB seeding.

## Amendment 2026-07-15 — simplified org-row ContactsPanel

User feedback (screenshot review): the org-row contacts panel had too many inline controls. New design:
- Panel = read-mostly list: avatar, name, email/phone, tier (text chip, not a select), org_title + functions (plain text/chips), login badge, and a remove (X) button. NO inline tier dropdowns, NO inline title/function inputs.
- One "Add contact" button → modal: type-to-filter ComboBox person picker + tier select + optional "create new contact" toggle (first/last/email/phone) — reusing the existing add + create flows.
- Deep editing (tier changes, title, functions, login lifecycle) lives on People → External; the panel links there ("Manage in External").

## Amendment 2026-07-15 (2) — read-only expansions, edit modal (External page)

Standing UI rule established (memory: expand-read-edit-modal): row expansions display information ONLY. External page rework:
- Expanded row = read-only: org links (org name, kind, tier chip, org_title text, functions chips), portal login status badge. NO selects, NO inputs, NO action buttons except one **Edit** button (gated: users:change or the relevant org change perm).
- Edit button → modal containing everything editable: org links editor (add link ComboBox + tier; per link tier select, title input, functions tag input, remove) AND login lifecycle (grant portal access fields / enable / disable).
- Same rule applies to future list pages.
- Avatar upload (decided 2026-07-15): the Edit modal includes the shared `AvatarUpload` component (`entityType="person"`, entityId=person_id, editable per permission). Same control is added to the Users admin modal and the Worker profile editor — avatar upload previously existed only on Profile (self) and org logos.
