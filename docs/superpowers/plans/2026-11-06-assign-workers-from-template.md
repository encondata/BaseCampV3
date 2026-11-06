# Assign Workers from a Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bulk Actions tool where an admin uploads a partner's short worker sheet, picks Initiative / Site / Partner, reviews every match and flag in two collapsible tables, and assigns everyone in one all-or-nothing import, creating missing workers on the way.

**Architecture:**
- **API:** a new service `people/assign_bulk.py` built on the shared bulk core (`imports/bulk.py`) and the identity helpers in `people/bulk_import.py`. Phone formatting is new: `people/contact_format.py`, on the `phonenumbers` library.
- **Shape:** preview is stateless. The client re-posts the parsed cells plus per-row **decisions**, and commit re-runs the preview and refuses anything undecided.
- **Portal:** a new page on `BulkToolPage`, with its own upload pane modeled on `TeamBulkUpload`.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest (API); React + TypeScript, vitest + Testing Library (portal); `phonenumbers` (new).

**Spec:** `docs/superpowers/specs/2026-11-06-assign-workers-from-template-design.md` (read it first; this plan argues from it). Mockup: `.superpowers/brainstorm/86646-1793982628/content/assign-workers-role.html`.

## Global Constraints

**Template and the values it writes**
- Template columns, in order: `first_name`, `last_name`, `preferred_name`, `phone`, `email`, `role`. Only `first_name` and `last_name` are required.
- Phones written by this tool use the international format with spaces: `+1 555 555 1212`, `+44 20 1234 5678`. A number without a leading `+` is parsed as US.
- Emails written by this tool are lowercase. Email comparisons ignore case.
- A blank `role` means **Tech** (`initiative_work_type` key `tech`).

**Matching and gating**
- Match order: name (`name_keys`), then email, then phone (`normalize_phone` digits). Only live workers and partner contacts (`contact_profiles.partner_id` set, person not archived) can match.
- Every flag needs a decision. The import button stays disabled until every row is decided, and the server re-checks on commit (`rows_invalid`).
- Update never writes a value another person holds (email uniqueness). Nobody is removed from an initiative.
- Access matches the team tool: `require_bulk_rank` + `_require_global` + `initiatives:change`, and also `workers:add` + `workers:change`.

**Page and copy**
- Page title "Assign workers from a template", route `/bulk/assign-workers`, launcher card in `BULK_TOOLS`.
- The layout copies the sibling bulk tools exactly: Columns → Download → Upload sections and preview columns Row / Name / Matched by / Action / Details. Controls go in the Details cell, never in new columns (memory: bulk-tools-match-existing-layout).
- All copy is American English. Every modal and menu follows light/dark, and nothing forces a theme.

## Review Focus

1. **Same person on two rows** (two rows match or are picked as the same person): both rows error "appears on more than one row (2, 5)". Commit refuses.
2. **Two "Create new" rows sharing an email:** both rows error, rather than the commit failing on `people_email_uniq`.
3. **The picked partner, site or initiative is archived or deleted between preview and commit:** 409/404 with a clear code, and nothing is written.
4. **Sheet role that matches no active role:** a `role_unknown` flag, resolved by picking a role in the row's Role dropdown, never silently set to Tech.
5. **Re-upload of the same sheet after a successful import:** every row is "Already assigned" and the button is disabled. Nothing is duplicated.

Each one has a test in the task that owns it. They're marked **(RF n)**.

---

## File map

| File | Responsibility |
|---|---|
| `api/pyproject.toml` | add `phonenumbers>=8.13` |
| `api/src/serversherpa/people/contact_format.py` (new) | `format_phone`, `lower_email` |
| `api/src/serversherpa/people/assign_bulk.py` (new) | parse, reference, match, flags, preview, commit, template |
| `api/src/serversherpa/api/routes/initiatives.py` | preview + commit routes (beside the team bulk routes) |
| `api/src/serversherpa/api/routes/workers.py` | template route (above `/{person_id}`) |
| `api/tests/test_contact_format.py`, `test_assign_bulk_service.py`, `test_assign_bulk_api.py` (new) | tests |
| `portal/src/lib/api.ts` | types + four client calls |
| `portal/src/lib/assignBulk.ts` (+ `.test.ts`) (new) | column guide, error copy, flag copy |
| `portal/src/components/workers/AssignBulkUpload.tsx` (+ test) (new) | pickers-aware upload → preview → decisions → commit pane |
| `portal/src/components/workers/AssignBulkRowDetails.tsx` (new) | one row's Details cell |
| `portal/src/pages/BulkAssignWorkers.tsx` (+ test) (new) | page shell + pickers |
| `portal/src/App.tsx`, `portal/src/pages/BulkActions.tsx` | route + launcher card |

## Wire contract (Tasks 3–7 all use this)

**Preview request.** A multipart first preview carries `file`, `partner_id` and `site_id`. A JSON re-preview or commit carries:
```json
{"rows": [...cells], "row_numbers": [2,3,...], "partner_id": "uuid", "site_id": "uuid",
 "decisions": {"3": {"person": "<uuid>|new", "role": "tech", "change": "update|ignore",
                     "acknowledged": ["name_differs", "status", "shared_contact", "no_contact", "phone_invalid"]}},
 "source": "file.xlsx"}
```
- Every key inside a decision is optional.
- `person` overrides the match. `"new"` means create a new worker.
- `change` answers `contact`, `partner` and `assignment` flags together: one choice per row.

**Preview response.**
```json
{"rows": [AssignRow], "counts": {"assign": n, "create": n, "already_assigned": n, "attention": n, "error": n},
 "people": [{"id", "label", "detail"}],  "roles": [{"key", "label"}], "can_commit": bool}
```
- `people` holds every matchable person. `label` is "First Last", and `detail` is the partner name, or "" when there isn't one.
- `roles` holds the active `initiative_work_type` values, in sort order.

**AssignRow:**
```json
{"row": 3, "cells": {...}, "name": "Person B", "table": "matched|unmatched",
 "matched_by": "name|email|phone|pick|null", "matched_value": "person.b@example.com|null",
 "person_id": "uuid|null", "person_name": "str|null", "create": false, "becomes_worker": false,
 "role_key": "tech", "role_label": "Tech",
 "flags": [{"kind": "...", "decided": bool, "lines": [{"label": "Phone on file", "value": "+1 555 555 0102"}],
            "other_person": "str|null"}],
 "action": "assign|create|already_assigned|attention|error", "errors": ["..."]}
```
- `table` comes from the **automatic** match only. A row that started unmatched stays in "unmatched" after a pick, so rows never jump between tables.
- `action` is `attention` while any flag has `decided: false`.

**Flag kinds and what decides them:**

| kind | decided by |
|---|---|
| `needs_match` | `decisions.person` |
| `role_unknown` | `decisions.role` |
| `contact`, `partner`, `assignment` | `decisions.change` |
| `name_differs`, `status`, `shared_contact`, `no_contact`, `phone_invalid` | the kind in `decisions.acknowledged` |

**Commit response:** `{"assigned": n, "created": n, "updated": n, "already_assigned": n, "rows": [{"row", "name", "person_id", "action", "diff"}]}`. It's shaped for `BulkApplySummary`.

**Error codes:** reuse the core's (`unknown_columns`, `too_many_rows`, `file_too_large`, `invalid_csv`, `invalid_xlsx`, `unsupported_file`, `missing_file`, `invalid_json`, `invalid_row_numbers`, `rows_invalid`) plus these:

| Code | HTTP status | Raised by |
|---|---|---|
| `invalid_decisions` | 422 | `parse_decisions` |
| `partner_not_found` | 404 | partner check |
| `partner_archived` | 409 | partner check |
| `site_not_found` | 404 | site check |
| `site_archived` | 409 | site check |
| `initiative_archived` | 409 | existing `_bulk_job` |

---

### Task 1: Phone and email formatting

**Files:**
- Modify: `api/pyproject.toml` (dependencies: `"phonenumbers>=8.13",  # country-standard phone format (people/contact_format.py)`)
- Create: `api/src/serversherpa/people/contact_format.py`
- Test: `api/tests/test_contact_format.py`

**Interfaces:**
- Produces: `format_phone(text: str, default_region: str = "US") -> str | None`. It returns `""` for blank input, `None` when the text can't be parsed or isn't a valid number, and otherwise the formatted number.
- Produces: `lower_email(text: str) -> str`, which strips the text and lowercases it.

- [ ] **Step 1: Write the failing tests**

```python
import pytest
from serversherpa.people.contact_format import format_phone, lower_email

@pytest.mark.parametrize("raw,want", [
    ("5125551212", "+1 512 555 1212"), ("(512) 555-1212", "+1 512 555 1212"),
    ("+1 512-555-1212", "+1 512 555 1212"), ("1-512-555-1212", "+1 512 555 1212"),
    ("+44 20 1234 5678", "+44 20 1234 5678"), ("+442012345678", "+44 20 1234 5678"),
    ("", ""), ("   ", ""),
])
def test_format_phone(raw, want):
    assert format_phone(raw) == want

@pytest.mark.parametrize("raw", ["abc", "12", "+999 1234"])
def test_format_phone_unparseable(raw):
    assert format_phone(raw) is None

def test_lower_email():
    assert lower_email("  Person.A@Example.COM ") == "person.a@example.com"
```

- [ ] **Step 2: Install the dependency and run the tests to see them fail**

Run: `cd api && .venv/bin/pip install -e '.[dev]' -q && .venv/bin/python -m pytest tests/test_contact_format.py -q`
Expected: FAIL (`ModuleNotFoundError: serversherpa.people.contact_format`).

- [ ] **Step 3: Implement both functions**

Use `phonenumbers.parse(text, default_region)`, reject the number unless `is_valid_number`, then `format_number(..., PhoneNumberFormat.INTERNATIONAL)` and replace `-` with a space. Catch `NumberParseException` and return `None`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_contact_format.py -q`. Expected: all pass. If a UK sample fails validity, pick a different valid sample from libphonenumber's examples rather than relaxing validation.

- [ ] **Step 5: Commit**

```bash
git add api/pyproject.toml api/src/serversherpa/people/contact_format.py api/tests/test_contact_format.py
git commit -m "feat(people): country-standard phone format and lowercase email helpers"
```

---

### Task 2: Parsing, reference data and matching

**Files:**
- Create: `api/src/serversherpa/people/assign_bulk.py`
- Test: `api/tests/test_assign_bulk_service.py`. Copy the `mk_job` / `mk_worker` / `mk_site` / `assign` helpers from `tests/test_team_bulk_service.py`, and add `mk_partner(db, name, parent=None)`, `mk_profile(db, person, partner=None, status="active")` and `mk_partner_contact(db, first, last, partner, email=None)`.

**Interfaces:**
- Consumes: `imports.bulk` (`parse_upload`, `number_json_rows`, `renumber`, `BulkImportError`), `bulk_import.name_keys`, `bulk_import.normalize_phone`, `bulk_import._worker_query`, and `contact_format` from Task 1.
- Produces:
  - `COLUMNS = ["first_name", "last_name", "preferred_name", "phone", "email", "role"]`, `SHEET = "Workers"`, `DEFAULT_ROLE = "tech"`.
  - `parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]`, `number_json_rows(rows) -> list[tuple[int, dict]]` and `number_posted_rows(rows, row_numbers) -> list[tuple[int, dict]]`.
  - `parse_decisions(raw) -> dict[int, dict]`. It raises `BulkImportError("invalid_decisions")` on a bad shape. A valid shape has keys from {person, role, change, acknowledged}, `change` is "update" or "ignore", and `acknowledged` is a list of known kinds.
  - `async load_reference(db, initiative_id: uuid.UUID, partner_id: uuid.UUID) -> dict` with these keys:
    - `people`: dict id → `Candidate`. `Candidate` is a dataclass with `person`, `profile` (`WorkerProfile` or None), `is_worker`, `partner_contact_of` (set of partner ids), and `partner_name`.
    - `by_name`, `by_email`, `by_phone`: dict key → list of ids.
    - `roles`: key → `StatusValue`.
    - `role_index`: squashed key or label → key.
    - `team`: person_id → `InitiativePerson`.
    - `emails_all`: lowercased email → person id, covering **every** person, archived included, because the unique index is.
    - `partner`: the picked `Partner`.
    - `site_names` and `partner_names`.
  - `match_row(ref: dict, cells: dict) -> tuple[str | None, str | None, str | None]` returns (person_id, matched_by, matched_value). It uses name first, then email, then phone. A key that hits 2+ people counts as no match for that key, and the search moves on to the next key.

- [ ] **Step 1: Write the failing tests**
  - `test_columns_pinned`: assert `COLUMNS` equals the list above.
  - `test_name_beats_email`: worker A is named "Person A"; worker B has the email `x@example.com`. The row "Person A" with email `x@example.com` gives `(A.id, "name", "Person A")`.
  - `test_preferred_name_matches`: preferred "Pat" + last matches.
  - `test_email_match_ignores_case`: the row's email is `X@Example.com` and the stored one is `x@example.com`. Result: `("email", "x@example.com")`.
  - `test_phone_match_digits`: stored `+1 512 555 1212`, row `(512) 555-1212`. Result: `"phone"`.
  - `test_partner_contact_matches`: a non-worker with a `contact_profiles` row for a partner can match.
  - `test_excluded_people_never_match`: a staff-only person, an archived worker, a revoked worker and a client contact are all `(None, None, None)`.
  - `test_duplicate_name_falls_through_to_email`: two workers named "Person A". A row with B's email matches B by email.
  - `test_parse_decisions_rejects_bad_shape`: `{"2": {"change": "maybe"}}`, `{"2": {"acknowledged": ["bogus"]}}` and `{"x": {}}` each raise `invalid_decisions`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_assign_bulk_service.py -q`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement the parse helpers, `parse_decisions`, `load_reference` and `match_row` in `assign_bulk.py`**
  - **Matchable people:** the union of `_worker_query()` rows and non-archived people joined to `ContactProfile` where `partner_id IS NOT NULL`.
  - **Name index:** `name_keys(first, last, preferred)`.
  - **Email and phone indexes:** `lower_email` and `normalize_phone`.

- [ ] **Step 4: Run them to see them pass.** Run the command from Step 2. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/people/assign_bulk.py api/tests/test_assign_bulk_service.py
git commit -m "feat(people): assign-from-template parsing, reference data and name→email→phone matching"
```

---

### Task 3: Flags, decisions and preview

**Files:**
- Modify: `api/src/serversherpa/people/assign_bulk.py`
- Test: `api/tests/test_assign_bulk_service.py`

**Interfaces:**
- Consumes: Task 2.
- Produces: `async preview_rows(db, initiative_id: uuid.UUID, partner_id: uuid.UUID, site_id: uuid.UUID, numbered: list[tuple[int, dict]], *, actor_id: uuid.UUID, actor_rank: int, decisions: dict[int, dict] | None = None, ref: dict | None = None) -> dict`. Its response shape is in the wire contract.

**Rules per row, in order:**
1. **Required cells and the person.** A blank `first_name` or `last_name` is a row error: "First name is required." / "Last name is required."
   - Person = `decisions.person` if set. A stale id is an error: "The chosen person no longer exists. Pick again."
   - Otherwise person = `match_row`.
   - `table` = "matched" if `match_row` found someone, else "unmatched".
   - `matched_by` = "pick" when the decision overrode the match.
2. **No person and no "new":** flag `needs_match` (undecided).
3. **Role.**
   - Blank → `tech`.
   - A name matching `role_index` → that role.
   - Otherwise flag `role_unknown`, undecided until `decisions.role` is set.
   - `decisions.role` always wins over the sheet.
4. **Phone.** If the phone is present and `format_phone` returns None, flag `phone_invalid`. Its line is `{"label": "Phone in sheet", "value": raw}`.
5. **No contact info.** No phone and no email gives flag `no_contact`.
6. **Existing person only** (not `new`):
   - **`name_differs`:** matched by email or phone, and none of the row's `name_keys` equals the person's name keys. Lines: "Name in sheet" / "Name on file".
   - **`contact`:** one line pair per differing field.
     - Phone: the row has a valid phone whose digits differ from the person's. The line pair is "Phone on file" (stored value, or "—") and "Phone in sheet" (formatted).
     - Email: the row has an email that differs, ignoring case. The line pair is "Email on file" and "Email in sheet".
     - If the sheet's email belongs to another person (`emails_all`), add the line `{"label": "Email", "value": "Not updated: in use by <name>"}`.
   - **`partner`:** the person has a worker profile whose `partner_id` ≠ the picked partner. That includes a child partner (spec: still a discrepancy). Lines: "Partner on file" / "Partner picked".
   - **`status`:** `profile.status` is set and isn't `"active"`. Line: "Status on file".
   - **`assignment`:** the person is already on the initiative, and the site or role differs from the picked site or the row role. Lines: "Site on file" / "Site picked" and/or "Role on file" / "Role picked".
   - **`shared_contact`:** the row's email or phone digits point at a different matchable person than the chosen one. Set `other_person` to that person's name.
7. **Create new** (`decisions.person == "new"`): if the row's email is held by anyone in `emails_all`, flag `shared_contact` with the line "Email: in use by <name>; created without it".
8. **Decided flags.** Use the "decided by" column of the wire contract. `change` decides all three of `contact`, `partner` and `assignment`.
9. **Action.**
   - `error` if there are errors.
   - Else `attention` if any flag is undecided.
   - Else `create` for "new".
   - Else `already_assigned` if the person is already on the initiative and either no `assignment` flag was raised or `change == "ignore"`.
   - Else `assign`.
   - `becomes_worker` = the chosen person exists and isn't a live worker.
10. **Duplicates across rows** (after the above):
    - Two or more rows with the same `person_id` all get the error "<name> appears on more than one row (2, 5)." **(RF 1)**
    - Two or more `new` rows sharing a non-blank email all get the error "Email <email> appears on more than one new worker (rows 2, 5)." **(RF 2)**
11. **Rank guard** (mirrors the workers import): if `change == "update"` and the chosen person holds a login account and outranks `actor_rank`, the row errors "Your rank is too low to update this person." Use the same account and rank lookup as `bulk_import.preview_rows`. Test: `test_update_blocked_for_higher_rank_account`.
12. **can_commit** = there's at least one row, no `attention` and no `error` rows, and at least one `assign` or `create` row, or an `assignment` flag decided `update`.

- [ ] **Step 1: Write the failing tests**

Use these names, each building only what it needs. Assert the flag kinds, `decided`, the exact line labels and values, and `action`:
- `test_blank_role_is_tech`
- `test_unknown_role_flags_until_picked` **(RF 4)**
- `test_needs_match_then_pick_existing` (the table stays "unmatched", `matched_by == "pick"`)
- `test_create_new`
- `test_name_differs_until_acknowledged`
- `test_contact_discrepancy_lines_and_change` (phone `+1 512 555 0102` on file vs `512-555-0199` in the sheet → line value `+1 512 555 0199`)
- `test_contact_email_held_by_other_note`
- `test_partner_discrepancy_including_child_partner`
- `test_status_flag_until_acknowledged` (`blacklist`)
- `test_assignment_flag_update_or_ignore`
- `test_already_assigned_same_site_and_role`
- `test_shared_contact_ack`
- `test_no_contact_ack`
- `test_phone_invalid_ack`
- `test_create_new_with_taken_email_flags_shared_contact`
- `test_same_person_two_rows_errors` **(RF 1)**
- `test_two_new_rows_same_email_error` **(RF 2)**
- `test_partner_contact_becomes_worker`
- `test_can_commit_false_until_all_decided`

- [ ] **Step 2: Run them to see them fail.**

Run: `cd api && .venv/bin/python -m pytest tests/test_assign_bulk_service.py -q -k "not columns_pinned"`. Expected: the new tests fail.

- [ ] **Step 3: Implement `preview_rows`, applying the rules above.**

- [ ] **Step 4: Run the file to see it pass.**

Run: `cd api && .venv/bin/python -m pytest tests/test_assign_bulk_service.py -q`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/people/assign_bulk.py api/tests/test_assign_bulk_service.py
git commit -m "feat(people): assign-from-template preview — flags, decisions, duplicates, can_commit"
```

---

### Task 4: Commit

**Files:**
- Modify: `api/src/serversherpa/people/assign_bulk.py`
- Test: `api/tests/test_assign_bulk_service.py`

**Interfaces:**
- Consumes: `preview_rows` (Task 3), `learning_assign.assign_on_add`, `audit` / `snapshot` / `diff`, and `format_phone` / `lower_email`.
- Produces: `async commit_rows(db, actor_id: uuid.UUID, initiative_id: uuid.UUID, partner_id: uuid.UUID, site_id: uuid.UUID, numbered, *, actor_rank: int, decisions: dict[int, dict], source_label: str) -> dict`. The return shape is in the wire contract.

**Behavior.** Load `ref` once and re-run `preview_rows`. If `can_commit` is false, raise `BulkImportError("rows_invalid", rows=...)`. Then, in one transaction:
- **`create`:**
  - Create a `Person` with first, last and preferred names, `phone=format_phone(...)` (omitted when invalid or blank), and `email=lower_email(...)` (omitted when blank or held by anyone). Set `source="import"` and `source_ref=source_label`.
  - Add a `WorkerProfile(partner_id=picked partner, status="active")` and a `PersonRole("worker")`.
  - Write the audit entry `entity_type="worker"`, `action="create"`, the way `bulk_import._create_worker` does.
- **Existing person with `change == "update"`:**
  - Write the differing phone (formatted) and email (lowercased), skipping an email held by another person.
  - Set `profile.partner_id` to the picked partner, creating the profile if it's missing.
  - Write the audit entry `worker` `update` with from/to values.
  - Status is never changed.
- **`becomes_worker`:** add a `PersonRole("worker")`, and a `WorkerProfile` with the picked partner if it's missing. Audit `worker_role: granted`.
- **`assign`, new to the initiative:** add an `InitiativePerson(site_worked_id=site_id, work_type=role_key)`, flush, call `assign_on_add`, and audit `person_add`. Copy the team tool.
- **`assign` with an `assignment` flag and `change == "update"`:** set the existing row's `site_worked_id` and `work_type`, and audit `person_update`.
- **`already_assigned`:** nothing is written.
- **Wrap-up:** `initiative.updated_at = now`, a `bulk_import` audit with the counts and source, then commit.
- **Database errors:** on an `IntegrityError`, roll back. Map `initiative_people_uniq` to `rows_invalid` with reason `duplicate_worker`, and `people_email_uniq` to reason `email_taken`. Re-raise anything else.

- [ ] **Step 1: Write the failing tests**
  - `test_commit_refuses_undecided` (`rows_invalid`, nothing written)
  - `test_commit_creates_worker_formatted_phone_lower_email`: the row has `Person.D@Example.com` and `(512) 555-1212`. Stored: `person.d@example.com` and `+1 512 555 1212`. The profile has the picked partner, there's an active worker role, and an `InitiativePerson` with the site and `tech`.
  - `test_commit_update_writes_contact_and_partner`
  - `test_commit_ignore_leaves_record`
  - `test_commit_update_skips_email_held_by_other`
  - `test_commit_partner_contact_becomes_worker`
  - `test_commit_assignment_update_moves_site_and_role`
  - `test_commit_status_never_changes`
  - `test_reupload_is_all_already_assigned` **(RF 5)**: commit, then preview the same rows. Every row is `already_assigned` and `can_commit` is false.
  - `test_commit_audits`: `bulk_import` has the counts, and there's a `person_add` per assign.

- [ ] **Step 2: Run them to see them fail.** Run: `cd api && .venv/bin/python -m pytest tests/test_assign_bulk_service.py -q -k commit`.

- [ ] **Step 3: Implement `commit_rows`.**

- [ ] **Step 4: Run the whole file to see it pass.** Run: `cd api && .venv/bin/python -m pytest tests/test_assign_bulk_service.py tests/test_team_bulk_service.py -q`.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/people/assign_bulk.py api/tests/test_assign_bulk_service.py
git commit -m "feat(people): assign-from-template commit — create, update, grant worker, assign, all-or-nothing"
```

---

### Task 5: Template and HTTP routes

**Files:**
- Modify: `api/src/serversherpa/people/assign_bulk.py`, adding `async build_template_xlsx(db) -> bytes`. It has one blank-safe sample row, `{"first_name": "Person", "last_name": "A", "preferred_name": "", "phone": "+1 555 555 0101", "email": "person.a@example.com", "role": ""}`, and a Reference sheet `("Roles", [active role labels])` built with `core.build_rows_xlsx(rows, COLUMNS, SHEET, refs)`.
- Modify: `api/src/serversherpa/api/routes/workers.py`. Add `GET /workers/bulk-import/assign-template` (xlsx only) **above** `@router.get("/{person_id}")`, gated by `require_permission("workers", "add")` + `require_bulk_rank`.
- Modify: `api/src/serversherpa/api/routes/initiatives.py`. Add `POST /{initiative_id}/people/assign/preview` and `POST /{initiative_id}/people/assign/commit` beside the team bulk routes.
- Test: `api/tests/test_assign_bulk_api.py`. Copy the client and login fixtures from `tests/test_team_bulk_api.py`.

**Interfaces:**
- Consumes: Tasks 2–4, `_bulk_job`, `bulk_http_error` and `require_bulk_rank`.
- Produces: the routes and wire contract above.

**Route behavior:**
- **Gates:** `_bulk_job` (rank, global, initiative exists and isn't archived), plus `actor.access.can("workers", "add")` and `actor.access.can("workers", "change")`, as in `workers.bulk_import_commit`. Failing either gives 403 `forbidden`. Pass `actor_rank=actor.access.max_rank` to `preview_rows` and `commit_rows`.
- **Body helper:** `_assign_body(request) -> (numbered, partner_id, site_id, decisions, body)`. It handles multipart (`file`, `partner_id`, `site_id`) and JSON, and a bad UUID gives `invalid_json`.
- **Partner and site checks:** the partner must exist (404 `partner_not_found`) and not be archived (409 `partner_archived`). The site gets the same checks with `site_not_found` / `site_archived`. **(RF 3)**
- **Commit:** requires `application/json`, like `team_bulk_commit`.

- [ ] **Step 1: Write the failing tests**
  - `test_template_columns_and_roles_sheet`: open the xlsx with openpyxl. Row 1 equals `COLUMNS`, and the Reference sheet has "Tech".
  - `test_preview_file_then_json`
  - `test_preview_requires_rank_and_worker_perms` (403)
  - `test_archived_partner_or_site_409` **(RF 3)**
  - `test_missing_partner_404`
  - `test_commit_round_trip` (multipart preview → JSON commit with decisions → 200, counts)
  - `test_commit_rows_invalid_422`
  - `test_template_route_not_shadowed_by_person_id`

- [ ] **Step 2: Run them to see them fail.** Run: `cd api && .venv/bin/python -m pytest tests/test_assign_bulk_api.py -q`.

- [ ] **Step 3: Implement the template builder and the routes.**

- [ ] **Step 4: Run the tests, plus the workers and team API tests, to see them pass.**

Run: `cd api && .venv/bin/python -m pytest tests/test_assign_bulk_api.py tests/test_team_bulk_api.py tests/test_workers_bulk_import_api.py -q`

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/people/assign_bulk.py api/src/serversherpa/api/routes/workers.py api/src/serversherpa/api/routes/initiatives.py api/tests/test_assign_bulk_api.py
git commit -m "feat(api): assign-workers-from-template template, preview and commit routes"
```

---

### Task 6: Portal client, copy and page shell

**Files:**
- Modify: `portal/src/lib/api.ts`. Add the types `AssignFlagKind`, `AssignFlag`, `AssignRow`, `AssignPreview`, `AssignDecision`, `AssignDecisions` and `AssignCommitResult`, mirroring the wire contract, plus four calls:
  - `downloadAssignTemplate(): Promise<void>`
  - `previewAssignBulkFile(jobId: string, file: File, partnerId: string, siteId: string): Promise<AssignPreview>`
  - `previewAssignBulk(jobId: string, body: AssignPosted): Promise<AssignPreview>`
  - `commitAssignBulk(jobId: string, body: AssignPosted & { source: string }): Promise<AssignCommitResult>`
  - Here `AssignPosted = { rows; row_numbers; partner_id; site_id; decisions }`. Copy the team-bulk call bodies' error handling.
- Create: `portal/src/lib/assignBulk.ts` and `assignBulk.test.ts`.
  - `ASSIGN_COLUMN_GUIDE`: six entries whose keys equal the API `COLUMNS`; only `first_name` and `last_name` are required. The `role` "accepts" text reads "A role name (case does not matter). Blank means Tech. Unknown names can be set in the preview."
  - `ASSIGN_BULK_ERRORS`: the team tool's map plus the new codes, worded like the siblings. For example, `partner_archived`: "That partner is archived — pick another."
  - `FLAG_TEXT: Record<AssignFlagKind, string>`. The sentence for each kind, exactly:

| Kind | Text |
|---|---|
| `needs_match` | "No worker matched. Pick one or create a new worker." |
| `role_unknown` | "The role in the sheet is not a known role. Pick one." |
| `name_differs` | "Name differs: matched by email or phone to someone with another name." |
| `contact` | "Discrepancy: the sheet's contact details differ from the person on file." |
| `partner` | "Discrepancy: this worker is with a different partner." |
| `status` | "This worker's status is not Active." |
| `assignment` | "Already on this initiative with a different site or role." |
| `shared_contact` | "Contact details shared with another person." |
| `no_contact` | "No phone or email in the sheet." |
| `phone_invalid` | "The phone number could not be read." |

- Create: `portal/src/pages/BulkAssignWorkers.tsx` and `.test.tsx`.
  - Use `BulkToolPage` with title "Assign workers from a template".
  - The hint (exact): "Send the template to the partner, then upload the file they return. Pick the initiative, site and partner, review each worker's match and role, and import. Rows are matched to existing workers by name, then email, then phone. A row with no match can be matched by hand or created as a new worker. Nobody is removed."
  - The intro is three `ComboBox` pickers (`inputId` `assign-initiative`, `assign-site`, `assign-partner`) in a `bulk-intro` wrapper. Add a `.bulk-intro.bulk-intro-3` grid rule in `bulk.css`: `display:grid; grid-template-columns: repeat(3, minmax(180px, 260px)); gap: 12px; max-width: none`.
  - Options: non-archived initiatives (labels via `jobOptionLabel` / `jobOptionDetail`), non-archived sites, and non-archived partners.
  - Downloads: one entry, `Template (.xlsx)`, always enabled.
  - Children: `<AssignBulkUpload jobId siteId partnerId />` from Task 7, keyed on the three ids. In this task, leave a stub that renders `null` so the page test passes. Task 7 replaces it.
- Modify: `portal/src/App.tsx`. Add a route `/bulk/assign-workers` with `ProtectedRoute resource="initiatives" minRank={ADMIN_RANK}`.
- Modify: `portal/src/pages/BulkActions.tsx`. Add a `BULK_TOOLS` entry after `initiative-people`: key `assign-workers`, title "Assign workers from a template", description "Upload a partner's worker sheet. Workers match by name, then email, then phone; review every match and create anyone new.", `resource: 'initiatives'`, `action: 'change'`, `also: [['workers','add'], ['workers','change']]`, `to: '/bulk/assign-workers'`, `button: 'Open'`.

- [ ] **Step 1: Write the failing tests**
  - `assignBulk.test.ts`: the guide's keys equal `['first_name','last_name','preferred_name','phone','email','role']`, and only the first two are required. Every `AssignFlagKind` has `FLAG_TEXT`.
  - `BulkAssignWorkers.test.tsx`:
    - It renders the title and the three labeled pickers.
    - The Template button calls `downloadAssignTemplate`.
    - The launcher shows the card for a user with the permissions.

- [ ] **Step 2: Run them to see them fail.** Run: `cd portal && npx vitest run src/lib/assignBulk.test.ts src/pages/BulkAssignWorkers.test.tsx`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them to see them pass, and typecheck.** Run: `cd portal && npx vitest run src/lib/assignBulk.test.ts src/pages/BulkAssignWorkers.test.tsx src/pages/BulkActions && npx tsc --noEmit -p .`. Expected: pass, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/assignBulk.ts portal/src/lib/assignBulk.test.ts portal/src/pages/BulkAssignWorkers.tsx portal/src/pages/BulkAssignWorkers.test.tsx portal/src/App.tsx portal/src/pages/BulkActions.tsx portal/src/styles/bulk.css portal/src/components/workers/AssignBulkUpload.tsx
git commit -m "feat(portal): Assign workers from a template page, launcher card and API client"
```

---

### Task 7: Upload pane, two collapsible tables and row decisions

**Files:**
- Create (replacing the Task 6 stub): `portal/src/components/workers/AssignBulkUpload.tsx` and `AssignBulkUpload.test.tsx`
- Create: `portal/src/components/workers/AssignBulkRowDetails.tsx`

**Interfaces:**
- Consumes: Task 6's client and copy. Also `FileDropzone`, `CollapsePanel`, `DataTable`, `ComboBox` (`portal`, `ariaLabel`), `BulkApplySummary` and `bulk.css` row classes.
- Produces: `AssignBulkUpload({ jobId, siteId, partnerId }: { jobId: string | null; siteId: string | null; partnerId: string | null })`.

**Pane behavior:**
- **The dropzone** is always visible. It's disabled until all three pickers are set; its hint is "Excel spreadsheet — .xlsx".
- **Preview.** When a file is chosen and all three ids are set, call `previewAssignBulkFile` automatically, with no Preview button. Store the base cells and row numbers. Changing any picker re-previews by JSON with the same cells and decisions.
- **Re-preview requests:**
  - Every decision change re-previews by JSON.
  - A newer request wins, using the `seq` ref pattern from `TeamBulkUpload`.
- **Above the tables:**
  - The button reads ``Assign ${n} workers (${created} new)``, where n is the count of `assign` and `create` rows plus assignment updates. It's disabled unless `can_commit` is true and nothing is pending.
  - Then a `set-note` line: "`a` matched · `d` discrepancies · `c` to create · `m` need a match · `k` already assigned · `e` errors". Here `d` = rows with an undecided `contact`, `partner` or `assignment` flag, and the words are singular when the count is 1.
- **Two `CollapsePanel`s:**
  - "Matched" (badge = number of rows) and "No match found", filtered by `row.table`. Both start open.
  - Each is a `DataTable` with `className="bulk-preview"`, columns Row (64px, mono) / Name / Matched by / Action / Details.
  - `Matched by` shows `matched_by`, with `matched_value` under it in a `set-note`-colored mono span ("—" when null).
  - Rows get `bulk-row-create` for assign and create, `bulk-row-update` when an undecided discrepancy is present, `bulk-row-error` for attention and error, and `bulk-row-unchanged` for already assigned.
  - Action labels: Assign · Create · Already assigned · Discrepancy (`contact`, `partner` or `assignment` undecided) · Needs a match · Error. "(becomes a worker)" is appended when `becomes_worker` is set.
- **`AssignBulkRowDetails`**, in order:
  1. Errors as `pf-error` spans.
  2. For each flag: its `FLAG_TEXT` (amber for discrepancies, red for needs a match), its `lines` as "Label: value" spans in `.bulk-diff`, and `other_person` when set.
  3. Buttons, as `mini-btn`s that show a pressed state when chosen:
     - `contact`, `partner` or `assignment` present → **Update** / **Ignore** (sets `change`).
     - `name_differs` → **Accept**.
     - `status`, `shared_contact`, `no_contact`, `phone_invalid` → **Ignore** (adds to `acknowledged`).
  4. The worker `ComboBox`, always shown. Its options are `+ Create new worker "<name>"` (value `new`) followed by `preview.people`, with the partner as the sub-label.
  5. A "Role" label and the role `ComboBox` (`preview.roles`). Picking one sets `decisions.role`.
- **Import:** `commitAssignBulk`, then reset the pane and show `BulkApplySummary` (`entityLabel="Worker"`, `openTo={`/initiatives/${jobId}`}`, `openLabel="Open the initiative"`, `filename="assign-workers-summary"`). On an error, map the code through `ASSIGN_BULK_ERRORS` and clear the preview.

- [ ] **Step 1: Write the failing tests** (mock the client as `TeamBulkUpload.test.tsx` does):
  - `disables the dropzone until initiative, site and partner are picked`
  - `previews automatically and splits rows into Matched and No match found`
  - `collapsing a panel hides its table`
  - `shows discrepancy lines and Update/Ignore; Update re-previews with change=update`
  - `Accept on name differs adds acknowledged`
  - `picking Create new sends person=new`
  - `role dropdown sends the picked role`
  - `Assign button disabled until can_commit, label counts new workers`
  - `commit shows the apply summary`

- [ ] **Step 2: Run them to see them fail.** Run: `cd portal && npx vitest run src/components/workers/AssignBulkUpload.test.tsx`.

- [ ] **Step 3: Implement the pane and the row details.**

- [ ] **Step 4: Run them to see them pass, plus the portal guardrails.**

Run: `cd portal && npx vitest run src/components/workers src/pages/BulkAssignWorkers.test.tsx src/styles && npx tsc --noEmit -p .`. Expected: pass. The `styles` tests include the list-typography, modal-corners and scrollbar guardrails.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/workers/AssignBulkUpload.tsx portal/src/components/workers/AssignBulkUpload.test.tsx portal/src/components/workers/AssignBulkRowDetails.tsx
git commit -m "feat(portal): assign-workers preview — Matched / No match found panels, per-row decisions, import"
```

---

### Task 8: Live check against the dev stack

**Files:** none, unless a bug is found. Fix those in the owning task's files, with a regression test.

- [ ] **Step 1:** Start the API (`--host 0.0.0.0`) and the portal from the worktree on free ports, following the live-verify recipe in memory `bulk-workers-import.md`. Sign in as the dev user on localhost.
- [ ] **Step 2:** Download the template. Check the columns, and that the Reference sheet lists the roles.
- [ ] **Step 3:** Build an .xlsx that exercises each kind of row: a name match, an email match with a different name, a phone discrepancy, a partner discrepancy, no match → Create new (mixed-case email, `(512) 555-1212`), a blank role, and an unknown role.
- [ ] **Step 4:** Upload it with dev Initiative / Site / Partner picked. Screenshot both themes.
  - Check that the button stays disabled until every flag is decided.
  - Decide each flag, import, and confirm on the initiative page that each person is on the right site with the right role.
  - Confirm the new worker's phone is `+1 512 555 1212` and the email is lowercase.
- [ ] **Step 5:** Re-upload the same file. Every row should be "Already assigned", with the button disabled **(RF 5)**.
- [ ] **Step 6:** Archive the test people you created (with notes saying so), and remove their test assignments.
- [ ] **Step 7:** Run the full API suite in the background to a log file (about 22 minutes) and the full portal suite. Report the pass and fail counts.
