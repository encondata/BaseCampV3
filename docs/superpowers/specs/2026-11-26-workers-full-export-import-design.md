# Workers full export / import — design

Date: 2026-11-26 · Status: draft for Jimmy's review

## Intent

Jimmy wants every worker field exportable from the portal and importable
back. "All fields; if no data then the field is null." On import, **null
(or blank) means leave the field alone**.

## What exists today

Bulk Actions › Workers (`/bulk/workers`, admin rank 60+, `workers:add`;
commit also needs `workers:change`) already round-trips workers:

- `GET /workers/bulk-import/export?format=csv|xlsx`: the live workers in
  the 20-column template shape (`people/bulk_import.py` `COLUMNS`).
- `POST /workers/bulk-import/preview` → per-row create / update /
  unchanged / error, matched by email, phone (digits) or name. Then
  `POST …/commit`, which is all-or-nothing, applies only updates that were
  ticked, and returns `BulkApplySummary`.
- The shared core (`imports/bulk.py`) already parses `.json` uploads (a
  list of row objects). The portal's `BulkUpload` only accepts
  `.csv,.xlsx`.

Missing from the export: travel fields, certifications, person id, and
the read-only record facts (badge, photo, login, source, dates).

## Approaches considered

1. **Extend the existing Bulk Actions › Workers tool** (picked). Add .json
   next to .csv/.xlsx, add every missing field, keep the existing preview
   → review → apply flow and summary.
2. A separate JSON dump/load on the Workers list. It would need its own
   copy of the matching, permission and rank guards and the summary, and
   the two importers would drift apart.
3. A full JSON export, with import extended only to travel fields. Smaller,
   but certifications and the other fields would be one-way.

Jimmy picked 1 (2026-11-26).

## Goals

- One export holds every worker field, in JSON, CSV and xlsx. JSON writes
  `null` for an empty value. CSV and xlsx write an empty cell.
- An unchanged export re-uploads as all "unchanged" (no false diffs from
  the new fields).
- Import accepts the new editable fields in all three formats, and
  certifications in JSON.
- Null or blank on import = leave the field as it is (today's rule,
  unchanged).

## Non-goals

- No clearing of fields through import. There is no way to null a field
  out, by design.
- No deleting or editing of existing certifications through import.
- No creating login accounts or changing roles from a file (an existing
  rule from the original tool).
- No export of archived workers. The export stays "live workers", as now.
- The Workers list's own quick **Export** button (visible rows, 12
  columns) stays as it is.

## Anti-goals

- Secrets in an export: password hashes, TOTP secrets, sign-in IPs and UI
  prefs never leave the API.
- A partial or hand-made file wiping data.
- A file exported from another environment (whose person ids don't exist
  here) refusing to import.

## Fields

**Editable on import** (all formats). These are today's 20 columns plus
four new ones:

| Column | Source | Import rule |
|---|---|---|
| `person_id` | people.id | Match key (see Matching). Never written. |
| `will_travel` | worker_profiles.will_travel | `yes`/`no`/`true`/`false` (any case; JSON booleans too). Blank/null = leave alone. Anything else is a row error. Export writes `yes`/`no`, or blank/null when not set. |
| `travel_region` | worker_profiles.travel_region | Free text. |
| `travel_restrictions` | worker_profiles.travel_restrictions | Free text. |

**Export only** (written on export, accepted and ignored on import, so a
re-uploaded export never trips `unknown_columns`):

| Column | Source |
|---|---|
| `badge_uid` | people.badge_uid |
| `has_photo` | people.avatar_key is set (yes/no). The storage key itself is internal. |
| `source`, `source_ref` | people.source / source_ref |
| `has_login` | a user_accounts row exists |
| `login_email` | user_accounts.email |
| `login_disabled` | user_accounts.disabled_at is set (yes/no) |
| `last_login_at` | user_accounts.last_login_at |
| `roles` | the person's active role grants, comma-separated, natural order |
| `created_at`, `updated_at` | people.created_at / updated_at (ISO 8601 UTC) |
| `profile_updated_at` | worker_profiles.updated_at |
| `certifications` | See below. Export only in CSV/xlsx. Importable in JSON. |

Column order: `person_id` first, then today's 20, then the travel trio,
then the export-only columns, with `certifications` last.

### Certifications

- **JSON** export: `"certifications": [{"name", "issuer", "issued_on",
  "expires_on", "source"}]`, with dates as `YYYY-MM-DD` or `null`. An
  empty list when there are none.
- **CSV/xlsx** export: one text cell, `Name (Issuer) issued → expires`
  joined with `; `, leaving out the parts that are missing. It is ignored
  on import.
- **JSON import:** each listed certification is matched against the
  person's existing ones by name + issuer (case-insensitive, whitespace
  squashed). Unmatched ones are **added** with source `manual`. Matched
  ones are left alone, even when their dates differ. `source` in the file
  is ignored. `name` is required. A date that doesn't parse as
  `YYYY-MM-DD` is a row error. A `certifications` value that isn't a list
  of objects is a row error. `null` or a missing key = leave alone.
- On a create row, every listed certification is added. On an update row,
  they are added only when the row's Update box is ticked, like every
  other change on the row. A row whose only change is new certifications
  is an "update".

## Matching

`person_id` joins the existing keys (email, phone, name) as the
**strongest** key:

- If `person_id` names a live person, that person is the target. Any other
  key that resolves to a *different* person is a row error naming both,
  the same as today's rule for keys that disagree. A shared name never
  blocks a row whose person_id lands on exactly one person.
- If `person_id` is not a valid UUID, it is a row error.
- If it is a valid UUID that names no live person here (another
  environment's export, or an archived person), it is ignored. The row
  matches by email/phone/name as today, and the Details cell says
  "person_id not found here". This keeps exports portable between
  environments.
- Two rows with the same `person_id` are an error for both (same as
  duplicate emails).
- "Matched by" shows `person_id` first, for example `person_id, email`.

## Formats

- `GET /workers/bulk-import/export?format=json` → `workers-export.json`, a
  JSON array of row objects. Each editable or export-only column is a key
  whose value is a string, a boolean for the yes/no facts, or `null`.
  `certifications` is a nested list.
- `GET /workers/bulk-import/template?format=json` → the two sample rows,
  in the same shape.
- CSV and xlsx keep using the shared builders, which guard against
  formula injection and add the Reference sheet.
- Upload: the shared `BulkUpload` gets a configurable `accept`. Workers
  passes `.csv,.xlsx,.json`, and every other tool keeps `.csv,.xlsx`.
- JSON import values may be strings, numbers, booleans or `null`. They are
  normalized to the same text cells as CSV (`null` → blank), except
  `certifications`, which is carried as structured data on the row
  (`cells`), so the commit replays it.

## Portal

- `/bulk/workers` Download list adds **Template (.json)** and **Current
  workers (.json)**, in the existing button style and order (templates,
  then current).
- The hint gains: "Upload .csv, .xlsx or .json. Rows with a person_id
  from an export match that person first."
- `WORKER_COLUMN_GUIDE` lists the new columns. Export-only columns say
  "Export only — ignored on upload." The API/portal parity test keeps the
  two lists in step.
- The preview table and summary are unchanged in layout. The new fields
  show up in the Details diff like any other field. New certifications
  show as `certifications: + Name (Issuer), …`.

## Access

- **The export now also requires `users:view`** (Jimmy, 2026-11-26,
  option C). It carries login facts (`has_login`, `login_email`,
  `login_disabled`, `last_login_at`, `roles`), which the rest of the API
  shows only behind `users:view`. This applies to every format of
  `GET /workers/bulk-import/export`. Without it, the response is a 403
  `forbidden`. The template, preview and commit keep their current gates.
- On `/bulk/workers`, the three **Current workers** buttons are hidden
  when `can('users', 'view')` is false, so nobody hits a 403. The template
  buttons and the upload stay.
- **Adding certifications skips the rank guard** (my call, to match
  `POST /workers/{id}/certifications`, which has none). In the preview,
  the rank-guard check ignores the `certifications` diff key. A row whose
  only change is new certifications never errors with "rank too low", and
  a row with other changes is guarded on those changes, exactly as today.

## Constraints

- The page layout of the existing bulk tools is fixed (memory
  `bulk-tools-match-existing-layout`). No new sections, table columns or
  chips.
- The review summary stays per-row with server-truth diffs
  (`bulk-actions-need-review-summary`).
- The existing guards stay as they are: rank guard, self-status guard,
  blacklist ⇄ account coupling, client-contact/worker mix,
  archived-email/RFID errors, the 1,000-row and 5 MB limits.
- Audit: travel-field changes audit as profile fields, like the other
  profile fields. Each added certification writes the same
  `certification.add` audit entry as `POST /workers/{id}/certifications`.

## Left to the builder

- How certifications travel through `cells` and the commit replay (a
  separate key on the numbered row is fine).
- Whether the export-only columns live in a second list next to `COLUMNS`
  (suggested: `EXPORT_ONLY_COLUMNS`, accepted by `check_columns` and then
  dropped).
- Test layout. The service tests cover: JSON round-trip unchanged; travel
  diff; person_id match, foreign id, invalid id and disagreement; a
  certification added on create and on update; a certification skipped
  when Update is not ticked; an existing certification left alone;
  certification-only rows skip the rank guard; export-only columns
  ignored; and export 403 without `users:view`. Portal tests cover the new
  downloads, the `.json` accept, and the Current workers buttons hidden
  without `users:view`.
