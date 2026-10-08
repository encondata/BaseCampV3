# Note and file visibility — design

**Date:** 2026-10-08
**Tracker:** Platform › "Internal versus customer-visible notes" (Feature Parity row 436, Not built)
**Branch:** `note-visibility`

## Goal

Every note and every file in a record's **Notes & files** panel carries a
visibility level that decides who can see it:

| Level | Label | Who sees it |
|---|---|---|
| `everyone` | Everyone (default) | Anyone who can see the record, including client and partner users |
| `internal` | Internal | Staff only: users with a global role (no client, partner or self-only users) |
| `admin` | Admin | Global users with rank 60 (Admin) or higher |

Jimmy's decisions (2026-10-08):

- **Existing items keep who sees them today.** Nobody gains or loses access
  on ship day (see Backfill).
- **Everyone means everyone.** An Everyone note or file on an initiative,
  person, client or partner becomes visible to the client, partner or
  self-scoped users who can already see that record. New items default to
  Everyone everywhere.
- **Notes and files.** Uploaded files get the same three levels.

## Who sees what

One helper, `serversherpa/access/visibility.py`, is the single rule:

```python
VISIBILITY_LEVELS = ("everyone", "internal", "admin")

def visible_levels(access: AccessInfo) -> tuple[str, ...]:
    if not access.is_global:
        return ("everyone",)
    if access.max_rank >= GATE_BYPASS_RANK:   # 60, Admin
        return ("everyone", "internal", "admin")
    return ("everyone", "internal")
```

- **Reads** (`GET /notes`, `GET /attachments`) filter rows to
  `visibility IN visible_levels(actor)`.
- **Writes on an existing item** (note PATCH/DELETE, attachment PATCH/DELETE)
  return 404 (`note_not_found` / `attachment_not_found`) when the item's level
  is not in the actor's levels — a hidden item does not exist for that actor.
- **Setting a level** (create, upload, PATCH) needs the level to be in the
  actor's levels; otherwise 403 `visibility_not_allowed`. Staff (rank 40)
  can choose Everyone or Internal; Admin and above can also choose Admin.
- Who may write at all is unchanged: host change permission plus a global
  role. Client and partner users stay read-only.

## Opening reads to non-global users

Today non-global users can read notes and files on **assets only**:

- notes: `_authorize_host` hard-denies non-global reads on initiative, person,
  client and partner, and container/truck/site resources are global-only;
- files: only the `asset` view branch reads the host's scope; every other
  host hard-denies non-global actors.

With Everyone meaning everyone, both routers use one host rule for reads:
**host resource `view` + the host row inside the actor's scope** (the rule
notes already use for assets). The host map (`NOTE_HOSTS`) and the person
scope probe (`SCOPE_PROBES`) move from `routes/notes.py` into a shared module,
`serversherpa/access/hosts.py`, with one function:

```python
async def authorize_host_view(db, actor, entity_type, entity_id) -> None
    # 422 unknown_entity_type, 403 forbidden (no host view),
    # 404 entity_not_found (missing row, or outside the actor's scope)
```

- `routes/notes.py` drops the non-global initiative/person/client/partner
  deny and calls the shared function for `view`.
- `routes/attachments.py` `_authorize(..., "view")`: for a **non-global**
  actor on any of the eight panel hosts, call `authorize_host_view` (replacing
  the asset-only branch and the hard deny). Global actors keep today's rule
  (`attachments:view`, asset view via `assets:view`). `report_definition`
  keeps its `reports:*` rule. Add, change and delete keep today's rules.
- Resources whose `visible_to` is global-only (sites, containers, trucks)
  still deny non-global users at `can()`, so nothing changes there.
- Non-global reads of files follow the host rule and ignore `attachments:view`,
  so a deny override on `attachments` does not hide Everyone files from
  client, partner or self users. Global users still need `attachments:view`.
- Avatar and logo rows become listable by anyone who can see the record;
  these images were already exposed through `avatar_url`/`logo_url`.

Net effect for a client user: they now see **Everyone** notes and files on
their own client's initiatives and on their own client record (and keep
seeing Everyone items on their assets). A partner user sees Everyone items
on their own partner record and on workers in their partner. A worker sees
Everyone items on their own person record. All existing items on those
hosts are backfilled to Internal, so nothing becomes visible until staff
choose Everyone.

## Data

Migration **0091** (`0091_note_file_visibility.py`, revises 0090):

- `notes.visibility` and `attachments.visibility`: `text NOT NULL DEFAULT
  'everyone'`, each with a check constraint
  `visibility IN ('everyone','internal','admin')`.
- **Backfill** (keeps today's effective access):
  - notes on `initiative`, `person`, `client`, `partner` → `internal`;
    every other note stays `everyone`;
  - attachments on `initiative`, `person`, `client`, `partner` whose kind is
    not `avatar` → `internal`; everything else stays `everyone`.
- Downgrade drops both columns.

Models: `Note.visibility` and `Attachment.visibility` (`Mapped[str]`,
`server_default="everyone"`). Schemas: `NoteOut.visibility`,
`AttachmentOut.visibility`, `NoteCreateIn.visibility` (default `everyone`),
`NoteUpdateIn` gains optional `visibility` and makes `body` optional (at least
one of the two is required → 422 `nothing_to_update`).

## API changes

- `POST /notes` accepts `visibility`. Audit `note.add` adds
  `"visibility": <level>` to `changes`.
- `PATCH /notes/{id}` accepts `body` and/or `visibility`. A visibility change
  is audited on `note.update` as `{"visibility": {"from": a, "to": b}}`.
- `POST /attachments` accepts a `visibility` form field (default
  `everyone`). Avatars are always `everyone`; sending anything else with
  `kind=avatar` returns 422 `visibility_not_supported`.
- New `PATCH /attachments/{id}` with `{"visibility": level}` (extra fields
  forbidden). Authorized like delete but with action `change`; avatars
  return 422 `visibility_not_supported`. Audited as `attachment.update` with
  `{"filename": name, "visibility": {"from": a, "to": b}}`. Unchanged level
  is a no-op 200 with no audit row.

## Other readers and writers

- **Report worker** (`reports/worker.py`): the file a report run saves to an
  initiative's files is created as `internal`, matching today (clients cannot
  see initiative files). Staff can change it to Everyone in the panel.
- **Site & Move Survey** (`reports/site_move_survey/gather.py`
  `_site_photos`): embeds only site photos whose level the requester could
  see — `everyone` and `internal` always (reports are staff-only), `admin`
  only when `run.requested_rank >= 60`.
- **Report run download** (`GET /reports/runs/{id}/download`) is its own
  gate (reports:view + requested rank) and is unchanged.
- **V2 person import** (`people/v2_import.py`) writes avatars only; the
  column default covers it.
- Avatars and logos presigned directly from `avatar_key`/`logo_key` are not
  panel files and are unaffected.
- Audit rows keep only note ids and filenames. The audit log is admin-only,
  and a person's own activity feed (`/auth/me/activity`) omits `note.*` and
  `attachment.*` rows made by others, so hidden filenames never reach them.
- Report-definition files (`survey_template`, `report_asset`) are fixed at
  Everyone like avatars: the report gather ignores visibility, so upload with
  another level and PATCH both return 422 `visibility_not_supported`.

## Portal

`portal/src/lib/visibility.ts`:

```ts
export type Visibility = 'everyone' | 'internal' | 'admin';
export const VISIBILITY_LABEL: Record<Visibility, string> =
  { everyone: 'Everyone', internal: 'Internal', admin: 'Admin' };
export function visibilityOptions(isGlobal: boolean, maxRank: number): Visibility[]
// non-global → ['everyone']; global < 60 → ['everyone','internal'];
// global ≥ 60 → all three
```

`lib/api.ts`: `visibility` on `NoteOut` and `AttachmentOut`;
`createNote(entityType, entityId, body, visibility)`;
`updateNote(id, { body?, visibility? })`; `uploadAttachmentRequest` gains an
optional `visibility`; new `updateAttachment(id, { visibility })`.

`NotesFilesPanel.tsx` (writers only — `canWrite`):

- **Composer:** a "Visible to" row with the house `segmented` control
  (`role="group"`, `aria-pressed`, `on` class) listing the options the
  actor may choose, default Everyone. The choice applies to both **Add note**
  and **Attach file**. Under it a one-line `page-hint`: "Everyone includes
  client and partner users who can see this record."
- **Chips:** every note, file row and image thumbnail whose level is not
  Everyone shows a `chip tag` with its label ("Internal", "Admin"). Everyone
  items show no chip (it is the default).
- **Editing a note:** the edit form shows the same segmented control,
  preset to the note's level; Save sends body and visibility.
- **Changing a file's level:** each file row and thumbnail caption gets a
  "Visibility" mini-button (not on avatars) that opens the segmented control
  inline in that row; picking a level saves immediately and closes it.
- An Admin-level item is never shown to a staff user (the API filters it),
  so the picker never needs to show a level the user cannot choose.
- Readers (`canWrite` false) see no picker but do see the chips on what
  they can read (for a client user that is only Everyone, so no chips).

## Errors

- 403 `visibility_not_allowed` → "You can't choose that visibility." in the
  panel's existing `pf-error` line.
- 422 `visibility_not_supported` never reaches the panel (no control on
  avatars).
- Any other failure keeps the panel's existing messages.

## Testing

API (pytest):

- `access/visibility.py`: levels for non-global, staff (40), admin (60),
  super admin (80).
- Migration backfill: insert pre-0091 rows, upgrade, check levels (follow the
  existing `test_migration_0068_form_factor.py` pattern).
- Notes: default Everyone; staff cannot create Admin (403); admin can;
  staff list hides Admin notes; staff PATCH/DELETE of an Admin note → 404;
  client user reads Everyone notes on their client's initiative and own
  client record, never Internal; client still cannot write; visibility
  change audited; `nothing_to_update` 422.
- Attachments: upload with visibility; list filtering for client/staff/admin;
  client reads Everyone files on their initiative (previously 403); PATCH
  rules (allowed levels, avatar 422, hidden → 404, audit, no-op); delete of a
  hidden file → 404.
- Report worker: saved initiative document is `internal`.
- Survey gather: Admin photo excluded for a staff-requested run, included for
  an admin-requested run.
- Existing tests that assert a client gets 403 on initiative notes
  (`test_initiative_notes_internal_only`) and on initiative/client/partner
  notes in `test_notes_api.py` are rewritten to the new rule: 200 with
  Everyone items only.

Portal (vitest): `visibilityOptions`; panel shows the picker only to writers,
offers Admin only at rank ≥ 60, sends the chosen level on note create and
upload, shows chips for Internal/Admin, edits a note's level, changes a
file's level through `updateAttachment`, and hides the Visibility button on
avatars.

## Out of scope

- Per-person or per-group sharing lists.
- Visibility on wiki pages or report runs (they have their own rules).
- A bulk "change visibility" action.
