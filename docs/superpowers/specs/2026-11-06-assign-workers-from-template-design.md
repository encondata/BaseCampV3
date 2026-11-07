# Assign workers from a template — design

**Date:** 2026-11-06
**Mockup:** `.superpowers/brainstorm/86646-1793982628/content/assign-workers-role.html` (built from the portal's real stylesheets; neutral placeholders)

## Why

When a partner supplies workers for an initiative, Jimmy asks them for their people and sends them a short template. Today, getting those people onto an initiative takes two existing tools:
- **Add or update workers** (`/bulk/workers`): its 20-column sheet is too much to send to a partner.
- **Add or update a job's team** (`/bulk/initiative-people`): it only assigns people who are already workers and never creates anyone.

This tool closes that gap. The partner fills in a short sheet, and one import finds or creates each worker under that partner and assigns them to the chosen initiative at the chosen site, with their role.

## The flow (Jimmy's)

1. Ask the partner for workers and send them the template.
2. Get the list back and check that the fields look right.
3. Open **Assign workers from a template** in Bulk Actions.
4. Load the .xlsx by drag-and-drop or by clicking and picking it in the file browser.
5. Pick the **Initiative**, **Site** and **Partner** from dropdowns.
6. The file is parsed and each row is matched to an existing worker by **name, then email, then phone**.
7. Review the two match tables, change any match, and settle every flag.
8. For rows with no match, pick a worker by hand or choose **+ Create new worker**.
9. Click the import button. Each worker is added to the initiative at the site with their role.

## Goals

- A short partner-facing template.
- One page that matches, creates and assigns in a single pass.
- Every row is reviewed before anything is written, and the import stays blocked until every flag has a decision.
- It looks and works exactly like the other Bulk Actions tools.

## Non-goals

- **Not this round:** a "marked for review" flag on workers created by this import (Jimmy: "we will add a marked for review later").
- No review form when creating a worker. The worker is created from the sheet's row as-is.
- No partner, initiative or site columns in the sheet. Those come from the page's dropdowns.
- Nobody is removed from the initiative. This tool adds people, and it changes an existing assignment's site or role only when someone clicks Update on that row.
- No login accounts are created (same rule as the workers import).

## Anti-goals

- **A page that looks different from its siblings.** It must use the same title, hint, sections, buttons and preview table as the existing Bulk Actions tools. See "Page layout".
- **Silent changes.** A worker's phone, email or partner never changes unless someone clicked **Update** on that row.

## Template

One .xlsx download, **Template (.xlsx)**. Columns, in order:

| Column | Required | Accepts | Notes |
|---|---|---|---|
| `first_name` | yes *(my call)* | text | |
| `last_name` | yes *(my call)* | text | |
| `preferred_name` | no | text | |
| `phone` | no | phone number | Stored in the country's standard format (see "Phone and email format"). Compared as digits only, using the existing `normalize_phone` key rule. |
| `email` | no | email address | Always imported lowercase. |
| `role` | no | a role name | Matched by key or label, ignoring case, against active `initiative_work_type` status values. Blank → **Tech**. A name that matches no role flags the row until a role is picked in its Role dropdown *(my call; never silently Tech)*. |

The template carries a Reference sheet listing the active role names, like the other bulk templates do (`build_rows_xlsx` with `(title, keys)` blocks).

Uploads follow the shared bulk limits: 1,000 rows and 5 MB. The page accepts .xlsx. *(Builder's call whether .csv is also accepted. The shared parser handles both.)*

## Page layout

Route `/bulk/assign-workers` *(name is the builder's call)*. It gets a `BULK_TOOLS` card on the Bulk Actions launcher, and the same access as the team tool: bulk rank plus the initiatives and workers permissions a create and an assign need.

The page is built from the shared `BulkToolPage` shell:
- **Title:** "Assign workers from a template" *(my call)*.
- **Hint:** explains the flow and that rows match by name, then email, then phone.
- **Intro:** three `ComboBox` pickers in a row: **Initiative** (non-archived), **Site** (non-archived), **Partner**. The upload and preview stay disabled until all three are picked.
- **Columns, Download and Upload** sections, the same as the siblings.
- **Upload box:** the drag-and-drop / click-to-browse `FileDropzone` (the From-To import's box), not the plain file input.

**After upload:** the file is previewed. Whether it previews automatically once the file and all three pickers are set, or through a Preview button like the siblings, is the builder's call.
- The import button sits above the tables and reads "Assign N workers (M new)".
- A summary line follows: "… matched · … discrepancies · … to create · … need a match · … already assigned · … errors".
- **Two collapsible tables** use the existing `CollapsePanel`, with an eyebrow title, a count badge and a chevron:
  1. **Matched:** rows that found a worker.
  2. **No match found:** rows that didn't.
- Both tables use the siblings' preview columns, **Row / Name / Matched by / Action / Details**, with the `bulk-row-*` tinting. Per-row controls go in the Details cell, never in new columns.
- **Matched by** shows the key that hit (name, email or phone) and the matched value under it.
- **Details** shows:
  - The worker match `ComboBox` (portaled menu, type to filter, worker name with partner as the sub-label). Its options are every live worker plus **+ Create new worker "<name>"**.
  - A **Role** `ComboBox` under it, filled from the sheet's role. When the sheet's role is blank it shows Tech.
  - Any flag (below), with its buttons.
- After import, the shared `BulkApplySummary` shows the per-row results, with a link to the initiative.

## Phone and email format

Jimmy is particular about phone formats. Every phone this tool writes, whether on a new worker or through **Update**, is stored in its country's standard international format, with spaces as separators:
- US: `+1 555 555 1212`
- UK: `+44 20 1234 5678`

The dev data already looks like this, for example `+1 702 689 0711`.
- **How:** use the `phonenumbers` library (the libphonenumber port) to parse the number and format it INTERNATIONAL, then replace dashes with spaces. US numbers otherwise come out as `+1 555-555-1212`.
- **No country code:** a number without a leading `+` is read as a US number *(my call)*.
- **Unparseable number:** the row gets a **Phone not recognized** flag. Its only choice is **Ignore**, which imports the row without the phone *(my call)*.
- **In the preview:** the "Phone in sheet" values in discrepancy notes show the formatted number, so it compares like-for-like with the number on file.

Every email this tool writes is lowercased, and email comparisons ignore case.

## Matching

**Who can match:**
- Live workers: a non-revoked `worker` PersonRole, `Person.archived_at IS NULL`, and a `worker_profiles` row. Reuse `_worker_query()`.
- **Partner contacts:** non-archived people with a `contact_profiles` row that has a `partner_id`. These are the partner people on People › External.

Nobody else matches: staff, client contacts, people whose worker role was revoked, and archived people. A row whose email belongs to one of those people can't be created with that email, because emails are unique (see "Create new worker").

When a partner contact who is not yet a worker is matched and assigned, the import also makes them a worker: an active `worker` PersonRole plus a `worker_profiles` row with the picked partner. This is the same thing the workers import does when it matches a non-worker *(my call)*. The Action column says "Assign (becomes a worker)" so it's visible.

Reuse `name_keys()` for names.

The order is fixed: **name first, then email, then phone.**
- **Name:** first+last, or preferred+last (`name_keys`), with spaces squashed and case ignored.
- If the name finds exactly one worker, that worker is the match. Email and phone are then only compared against that worker for discrepancies (below).
- If the name finds nobody, try email, then phone. A match found this way always gets the **Name differs** flag.
- If no key finds anyone, the row goes to **No match found**.
- *(Builder's call:)* when a key finds two or more workers (two people with the same name), the row goes to No match found as "needs a match", with those people listed first in the dropdown.

## Flags and decisions

Every flag needs a decision, and **the import button stays disabled until every row is decided**. The server checks this again on commit.

| Flag | When | Shown | Choices |
|---|---|---|---|
| **Needs a match** | No worker found | "No worker matched. Pick one or create a new worker." | Pick a worker, or **+ Create new worker** |
| **Discrepancy: contact** | The match's phone or email on file differs from the sheet | A note saying which field differs, then "Phone on file: … / Phone in sheet: …" | **Update** (write the sheet's value to the worker) · **Ignore** (keep what's on file, still assign) · pick a different person · create new |
| **Discrepancy: partner** | The matched worker's `worker_profiles.partner_id` differs from the picked Partner | "Partner on file: … / Partner picked: …" | **Update** (move the worker to the picked partner) · **Ignore** · pick a different person · create new |
| **Name differs** | No name match; the row matched by email or phone to a person with a different name | "Name in sheet: … / Name on file: …" | **Accept** (use this person; their name on file is not changed) · pick a different person · create new |
| **Status** | The matched worker's `worker_profiles.status` is anything other than active, for example inactive or blacklist | "Status on file: …" | **Ignore** (assign anyway; status is not changed) · pick a different person · create new *(the choices are my call)* |
| **Already on the initiative** | The match is already on the initiative at a different site, or with a different role (one row per person per initiative: `initiative_people_uniq`) | "Site on file: … / Site picked: …" and/or "Role on file: … / Role picked: …" | **Update** (move their site and role to the picked ones) · **Ignore** (leave the assignment as it is) |
| **Shared contact** | The sheet's email or phone belongs to a different person than the one matched by name | A note naming the other person | **Ignore** (bypass, continue) |
| **No contact info** | The row has neither phone nor email | A note | **Ignore** (bypass, continue) |
| **Phone not recognized** | The phone can't be parsed | A note with the raw value | **Ignore** (import without the phone) |

- When a row has more than one discrepancy, each field gets its own line in the note. One Update/Ignore choice covers the whole row *(my call)*.
- Shared-contact, no-contact and phone flags only need **Ignore** clicked. After that they don't block anything.
- **Update never writes a value someone else holds** *(my call)*. If the sheet's email belongs to another person, Update leaves the email alone and writes the other fields, and the note says so. That way the all-or-nothing commit can't fail on the unique email index.
- **Rank guard:** Update on a person who holds a login account and outranks the importer is a row error, the same rule the workers import uses.
- **Partner hierarchy:** a worker whose partner is a child of the picked Partner (`partners.parent_id`) still counts as a partner discrepancy. Ignore covers it *(my call)*.

**Already assigned:** the match is already on the initiative at the picked site with the same role. The row is listed in Matched as "Already assigned", and nothing is written. It needs no decision. Unless it also has a contact or partner discrepancy, it raises no flags at all: no contact, an unreadable phone, a name difference, a status or an unknown role are not asked about, because nothing would be written for that row.

## Create new worker

The worker is created from the sheet's row (first, last, preferred, phone, email) under the picked Partner, with no form. It is written the same way the workers import writes one: a `people` row, an active `worker` PersonRole and a `worker_profiles` row with `partner_id`.

Email addresses are unique across people. If the row's email already belongs to someone, creating with it would fail. The row shows the shared-contact note, and once it's ignored the worker is created without that email *(my call)*.

## Assign

For every decided row that isn't already assigned:
- **New to the initiative:** create an `InitiativePerson` with `initiative_id` set to the picked initiative, `site_worked_id` set to the picked site, and `work_type` set to the row's role (Tech if blank).
- **Already on it with Update clicked:** change that `InitiativePerson`'s `site_worked_id` and `work_type`.
- **Already on it with Ignore clicked:** nothing is written.

The commit is all-or-nothing, like the team tool. It replays the uploaded cells and the row decisions (overrides, Update/Ignore choices, roles), and never the client's rendering. It writes the usual audit entries: person created, worker updated and `person_add`.

## What exists (reuse)

**API**
- `imports/bulk.py`: parse, limits, template builders.
- `api/bulk_routes.py`: `require_bulk_rank`, `bulk_http_error`, `rows_from_request`.
- `people/bulk_import.py`: `name_keys`, `_worker_query`, phone digits, and the worker create path.
- `people/team_bulk.py`: per-row overrides, preview/commit shape, role resolution, `initiative_people_uniq`.

**Portal**
- `BulkToolPage`, `FileDropzone`, `ComboBox` (`portal`, `inputId`, `ariaLabel`).
- `CollapsePanel`, `DataTable` with `bulk-preview`, `BulkApplySummary`.
- `TeamBulkUpload` / `TeamBulkRowDetails`: the pane to model on.
- `listWorkerOptions`, `listSites`, `listInitiativeWorkTypes`, `listInitiatives`.

**New dependency:** `phonenumbers` in `api/pyproject.toml`. Nothing in the repo parses phones by country today; `normalize_phone` only strips to digits for matching.

## Left to the builder

- Route path and API paths.
- Auto-preview versus a Preview button.
- Whether .csv is also accepted.
- How a name that hits two or more workers is presented.
- How to share code with `team_bulk.py` and `people/bulk_import.py`.
- Error codes and copy for parse failures, which follow the siblings.
