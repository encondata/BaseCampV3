# Bulk workers import — design

Second Bulk Actions tool: add or update workers from a spreadsheet, on the
pattern of the bulk sites tool (spec `2026-09-22-bulk-sites-import-design.md`).
Closes the parity workbook's "Import team members in bulk" row (Gaps sheet,
row 15; Jimmy pointed at the crew-list gap on 2026-09-22).

Jimmy's decisions (2026-09-22): match keys are **email, phone, and name**
(first + last, or preferred + last); matched rows are **updated or skipped per
row, default skip**; the template carries the **full 20-column set**; the
content-agnostic half of the sites importer is **extracted into a shared core**
first, and workers is built on it.

## What exists

- A worker is three records: a `people` row, an active `person_roles` grant
  of `worker`, and a `worker_profiles` row (partner, trade, level, status,
  status_note). The Workers list keys off the role grant; the kiosk sync keys
  off the profile. Both must be written.
- `people.external_id` ("badge # / employee # / roster ID", indexed, not
  unique) is written by nothing today. `people.email` and `people.rfid_tag`
  each have a partial unique index. `people.phone` is free text; nothing
  normalizes it.
- `POST /users` is the only person-creation endpoint and cannot set the
  address block, `external_id`, `rfid_tag`, `notes`, or any profile field.
  `PUT /workers/{id}/profile` owns the blacklist ⇄ login-access coupling and
  its rank / self guards.
- `sites/bulk_import.py` holds the parse → preview → commit pipeline;
  `logistics/bulk_import.py` (containers) copied its content-agnostic half
  because the parsing functions are entangled with the sites column list.
  `portal/src/components/sites/BulkApplySummary.tsx` hardcodes the Site
  label, the `/sites?open=` link, and the `sites-bulk-summary` filename.
- V2's crew importer (`portal-v4/src/pages/BulkAddTeamMembers.jsx`) took
  first_name, last_name, email, phone, partner_name, role, work_type, rating
  and always inserted. Rating and work type live on the job staffing record
  in V3, not on the person.

## Shared bulk-import core

New module `api/src/serversherpa/imports/bulk.py`, moved verbatim from
`sites/bulk_import.py` and parameterized where sites was hardcoded:

- `BulkImportError(code, **extra)`
- `cell(value) -> str`, `guard_cell(text) -> str`, `FORMULA_LEAD`
- `check_columns(keys, columns)` → `unknown_columns`
- `numbered(rows, first_row, columns)` → 1,000-row cap (`too_many_rows`),
  blank lines dropped
- `number_json_rows(rows, columns)`
- `parse_upload(filename, content, columns, sheet)` → csv / xlsx / json, 5 MB
  cap; `sheet` is the preferred worksheet name ("Sites", "Workers")
- `build_rows_csv(rows, columns)`
- `build_rows_xlsx(rows, columns, sheet, reference)` where `reference` is a
  list of `(title, keys)` pairs written to the Reference sheet, each block
  separated by a blank row, exactly as sites writes "Valid type keys" and
  "Valid status keys" today
- `MAX_ROWS`, `MAX_BYTES`

`sites/bulk_import.py` keeps `COLUMNS`, `SAMPLE_ROWS`, `SITE_ATTR`,
`normalize_address`, `export_rows`, `preview_rows`, `commit_rows`, and its
write helpers, and re-exports `BulkImportError` so the container module's
import line keeps working. Its `build_template_xlsx(type_keys, status_keys)`
and `build_rows_xlsx` signatures stay as they are, delegating to the core.
`logistics/bulk_import.py` drops its private `check_columns`, `_cell`, and
`number_json_rows` for the core's. Both existing suites pass unchanged; the
container and sites tests that exercise parsing keep their assertions.

Portal: `BulkApplySummary` moves to `portal/src/components/bulk/` and takes
`entityLabel`, `linkFor(row) -> string`, `filename`, and `openTo` /
`openLabel` beside `result`. Its result labels gain `skipped: 'Skipped'`.
`SiteBulkUpload` passes the current values. `changesText` stays exported.

## Columns

Twenty columns, in template order. Only `first_name` and `last_name` are
required.

| Column | Accepts | On create |
|---|---|---|
| first_name | text, required | |
| last_name | text, required | |
| preferred_name | text | |
| email | an email address | |
| phone | text with at least 7 digits | stored as typed |
| job_title | text | |
| employee_number | text → `people.external_id` | |
| rfid_tag | text, unique across people | |
| address_line1 | text | |
| address_line2 | text | |
| city | text | |
| region | text (state / province) | |
| postal_code | text | |
| country | two letters | default `US` |
| partner | an existing partner's name | blank = direct hire |
| trade | text | |
| level | a `worker_levels` key (L1 … L6) | |
| status | a worker `status_values` key | default `active` |
| status_note | text, required when status is blacklist | |
| notes | text | |

The xlsx template has a `Workers` sheet with two sample rows and a
`Reference` sheet listing valid levels, valid statuses, and partner names.

Not in the spreadsheet: login accounts (no passwords in a crew list), roles
other than `worker`, certifications, avatars. Anyone who needs a login gets
it from the Users page afterwards.

## Matching

`people/bulk_import.py` loads every non-archived person once and indexes:

- **email**: casefolded `people.email`
- **phone**: `normalize_phone` = digits only; when 11 digits remain and the
  first is `1`, it is dropped. Fewer than 7 digits is not a key.
- **name**: casefolded `first_name last_name`, and `preferred_name last_name`
  when a preferred name exists. A row's `first_name + last_name` and
  `preferred_name + last_name` are both looked up, so "Bob Smith" meets a
  person stored as Robert Smith, preferred Bob.

Resolution, per row, after field validation:

1. Any key hitting more than one person → error naming the key
   (`two people share the email …`, `… the phone …`, `… the name …`).
2. Collect the distinct people hit across all keys. Zero → `create`. One →
   match. Two or more → error naming each key and who it hit
   (`email matches Robert Smith, phone matches Roberta Smith`).
3. `matched_by` lists the keys that agreed, comma-joined in the order
   email, phone, name (`"email, name"`); `matched_name` is the person's
   display name.

A shared name never blocks a row that carries a stronger key: when the row's
email and/or phone lands on exactly one person, name ambiguity — two people
sharing the name in the database, or two rows sharing it in the upload — is
ignored and that key decides the match. Rows carrying neither an email nor a
phone keep the strict rule, so an ambiguous name is still an error for them.

Within the upload the same three keys are indexed, so two rows sharing an
email or phone are both errors (two rows sharing only a name are errors only
when neither carries a stronger key), and two rows resolving to the same
existing person are both errors. Archived people never match. A matched
person who does not hold the worker role (a plain user, a contact) is still a
match: applying the update grants the role and creates the profile, and the
diff shows `worker_role: — → granted`.

## Validation

All row errors, never silent fixes:

- `first_name` and `last_name` required
- `email` must parse as an email (pydantic `EmailStr`)
- `phone`, when given, must contain at least 7 digits
- `rfid_tag` already on a different non-archived person, or repeated within
  the upload → error
- `partner` must name exactly one partner (case-insensitive; two partners
  with one name → `ambiguous partner`)
- `level` must be a key in `worker_levels`; `status` a key in the worker
  vocabulary; `status` blacklist requires a `status_note` (from the row, or
  already on the profile)
- `country`, when given, must be two letters (stored upper-cased)
- A status change on a matched person whose highest active role rank the
  actor cannot manage (`can_touch_rank`) → error `rank too low to edit this
  person`; the same error covers any other change to such a person when they
  hold a login account. A status change on the actor themself → error
  `cannot change your own status` (other self-edits are allowed). These
  mirror `PUT /workers/{id}/profile` and `PATCH /workers/{id}/person`.

## Preview and diff

Preview row: `row, name, action (create | update | unchanged | error),
matched_by, matched_name, errors[], diff, person_id, cells, data`. `name` is
`preferred_name or first_name` + `last_name` from the row. Top level:
`{rows, can_commit}` where `can_commit` is non-empty with no error rows.

`diff` covers every column (person columns against the person, profile
columns against the profile, `partner` compared by name) plus `worker_role`
when the grant is missing. Blank cells mean "no change" on updates; `country`
and `status` take their defaults only on creates, tracked out of band as
sites does. A matched row with an empty diff is `unchanged`. A phone change
whose normalized form is unchanged is not a diff.

## Commit

`commit_rows(db, actor, numbered, *, approved_updates, source_label)` takes
the original `cells`, re-runs the preview, and in one transaction:

- `create`: insert the person (`source="import"`, `source_ref=source_label`,
  `created_by=actor`), grant `worker`, insert the profile. No login account.
- `update` with `person_id` in `approved_updates`: apply the diff to the
  person and profile (creating the profile and granting the role when
  missing). Entering blacklist disables any login account and revokes its
  sessions; leaving blacklist re-enables it, exactly as the profile endpoint.
- `update` not approved: `skipped`, no writes.
- `unchanged`: no writes.

Any error row → `BulkImportError("rows_invalid", rows=…)`, nothing written.
Any database failure rolls everything back. One audit row
(`entity_type="worker"`, `action="bulk_import"`, changes `{created, updated,
skipped, unchanged, source}`) plus a per-person `create` / `update` audit
row. Response: `{created, updated, skipped, unchanged, rows: [{row, name,
person_id, action (created | updated | skipped | unchanged), diff}]}`; a
skipped row carries the diff it would have applied.

Export: every non-archived person holding an active `worker` grant, ordered
by last then first name, in template shape (partner by name, blanks for
nulls), formula-guarded. Re-uploading an export previews all `unchanged` —
which is exactly what the name-ambiguity rule above buys: a workforce with
two people sharing a name still round-trips, because the exported email or
phone identifies each of them.

## API

In `routes/workers.py`, declared above `GET /workers/{person_id}` so the
literal path is not swallowed by the UUID parameter:

- `GET /workers/bulk-import/template?format=csv|xlsx` →
  `workers-template.csv|.xlsx`
- `GET /workers/bulk-import/export?format=csv|xlsx` →
  `workers-export.csv|.xlsx`
- `POST /workers/bulk-import/preview` — multipart `file`, or JSON `{rows}`
- `POST /workers/bulk-import/commit` — JSON `{rows, approved_updates:
  [person_id], source}`

All four: `require_permission("workers", "add")` — the commit additionally
requires `workers:change`, the permission its updates exercise — plus the
sites bulk gate
(global actor, `max_rank >= GATE_BYPASS_RANK`), moved to a shared helper so
both routers use one. `BulkImportError` → 422 `{code, …extra}`;
`unknown_format` → 422.

## Page

`/bulk/workers` — "Add or update workers in bulk", route gated
`resource="workers"` and `minRank=ADMIN_RANK`; second card on Bulk Actions
("Add or update workers in bulk", resource `workers`, action `add`, button
"Open"). Sections, mirroring `/bulk/sites`:

1. **Columns** — table of every template column: name, required, accepts,
   example. Source `WORKER_COLUMN_GUIDE` in `portal/src/lib/workerBulk.ts`,
   pinned by a test to the 20 keys. `WORKER_BULK_ERRORS` maps every error
   code to copy.
2. **Download** — Template (.xlsx), Template (.csv), Current workers (.xlsx),
   Current workers (.csv), and the 1,000-row / 5 MB note.
3. **Upload** — one file input (.csv, .xlsx) and a Preview button.
4. **Preview** — Row, Name, Matched by (`email, name` … or "new worker"),
   Action chip (Add / Update / No change / Error), Details (errors, or the
   diff with an **Update** checkbox, unchecked by default). "Update all" and
   "Skip all" buttons above the table when any update exists. Count line
   "N to add · M to update · S to skip · K unchanged · E errors".
5. **Apply** — "Add N workers and update M workers", enabled when the preview
   has no errors and at least one row will be written (an add or an approved
   update). Skipped rows never block it. The commit posts `cells` for every
   non-error row plus the approved person ids and the filename, and relabels
   returned row numbers to the preview's spreadsheet numbers.
6. **Summary** — the shared `BulkApplySummary`: counts line including
   skipped, table Row / Worker (linked to `/people/workers/<id>`) / Result
   (Added / Updated / Skipped / No change) / Changes, "Download summary
   (.csv)" as `workers-bulk-summary`, "Open Workers" link. Stays until a new
   file is chosen.

Workers list toolbar gets a "Bulk import…" button beside "+ Add worker" for
admin rank with `workers:add`, opening `/bulk/workers`.

## Out of scope

Login account creation; roles other than `worker`; certifications; avatars;
archiving through the upload; staffing people onto jobs (the separate "bulk
assign" tool); the jobs importer; raising the row or size limits.

## Testing

- Shared core: each format parses, unknown columns, row cap, formula guard
  round trip, Reference blocks; sites (45 tests) and container suites pass
  unchanged after the extraction.
- Workers service: `normalize_phone`; each key matching alone; preferred +
  last match; ambiguous name; keys disagreeing; duplicate keys within the
  upload; two rows on one person; archived ignored; non-worker user matched
  and granted the role on approval; rfid collision; partner / level / status
  errors; blacklist without a note; rank and self guards; blank cells never
  clear on update; defaults only on create; skipped rows write nothing;
  all-or-nothing rollback; blacklist disables the account; export round trip.
- Workers routes: staff rank forbidden on all four; template and export
  headers and content; preview via file and JSON; commit end to end with one
  approved and one skipped row.
- Portal: column guide keys and error codes; upload component (Apply
  disabled with errors, skip by default, Update all / Skip all, commit
  payload, summary with Skipped); page renders guide and downloads; Bulk
  Actions shows the card on `workers:add`; Workers toolbar button; shared
  summary props; whole suite, `tsc --noEmit`, build.
- Live: export the dev workers, re-upload unchanged; edit one phone and one
  trade, add a new-name row and a row with an existing user's email;
  preview, approve one update, apply; check the summary and the detail pages.
