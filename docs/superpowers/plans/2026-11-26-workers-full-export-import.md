# Workers Full Export / Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bulk Actions › Workers exports every worker field (JSON, CSV, xlsx; JSON writes `null` for empty) and re-imports the editable ones, including travel fields and JSON certifications, with null/blank = leave alone.

**Architecture:** Extend `people/bulk_import.py`. `COLUMNS` grows by `person_id` and the travel fields. A new `EXPORT_ONLY_COLUMNS` list is accepted on upload and dropped. JSON rows carry a structured `certifications` value beside the text cells. Export rows become typed (None/bool/list), and a `flatten_row` turns them into text for CSV/xlsx. The portal's shared `BulkUpload` learns a configurable file-type list, and the workers page adds .json downloads.

**Tech Stack:** FastAPI + SQLAlchemy async (Postgres), pytest; React + TypeScript + Vitest.

**Spec:** `docs/superpowers/specs/2026-11-26-workers-full-export-import-design.md`. Read it before any task.

## Global Constraints

- Null or blank on import = leave the field alone. Import never clears a field and never deletes or edits a certification.
- `GET /workers/bulk-import/export` (every format) additionally requires `users:view`. Without it the response is 403 `{"code": "forbidden"}`. Template, preview and commit keep their current gates.
- Adding certifications skips the rank guard. Every other guard stays exactly as it is.
- Never export: password hashes, TOTP data, sign-in IPs, `ui_prefs`, `avatar_key`.
- The page layout of the bulk tools is fixed: no new sections, table columns or chips.
- All copy is American English.
- Work in the worktree `.claude/worktrees/workers-export` on branch `workers-full-export`, cut from `main`. Never `git checkout --` a file in the main checkout.
- API tests: `cd .claude/worktrees/workers-export/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_wfexport /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest <files> -q`. Run them in the FOREGROUND with a 600000 ms timeout. Never background a test run.
- Portal: in the worktree, `portal/node_modules` is a symlink to the main checkout's. Never run `npm install`. Tests: `cd portal && npx vitest run <files>`.

## Review Focus

1. **An unchanged JSON export re-uploads as all "unchanged"**, including rows with certifications, `will_travel` true/false and null, and numeric-looking postal codes. Pinned in Task 2.
2. **An unchanged CSV/xlsx export re-uploads as all "unchanged"** with every export-only header present. A `yes`/`no` will_travel and a filled certifications text cell must not trip `unknown_columns` or read as a diff. Pinned in Task 3.
3. **The commit replays `cells`, so certifications must survive the round-trip through JSON** (`cells` → POST → `number_json_rows`) and be added exactly once. Pinned in Task 2.
4. **A JSON file whose `certifications` is a string, an object, or a list holding a non-object** is a row error, not a 500. Pinned in Task 1.
5. **An export from another environment** (valid person_ids that don't exist here) previews as creates, or as matches by email, never as errors. Pinned in Task 2.

---

### Task 1: Columns and parsing

**Files:**
- Modify: `api/src/serversherpa/people/bulk_import.py` (constants, `SAMPLE_ROWS`, `number_json_rows`, `parse_upload`)
- Test: `api/tests/test_workers_bulk_import_service.py`

**Interfaces:**
- Produces:
  - `COLUMNS: list[str]` = `["person_id", <today's 20 in today's order>, "will_travel", "travel_region", "travel_restrictions"]`
  - `EXPORT_ONLY_COLUMNS: list[str]` = `["badge_uid", "has_photo", "source", "source_ref", "has_login", "login_email", "login_disabled", "last_login_at", "roles", "created_at", "updated_at", "profile_updated_at", "certifications"]`
  - `EXPORT_COLUMNS = COLUMNS + EXPORT_ONLY_COLUMNS`
  - `number_json_rows(rows: Any) -> list[tuple[int, dict]]`: each row dict has every `COLUMNS` key as text. JSON rows also carry `"certifications"`: the raw value when the key is present and not null, otherwise the key is absent.
  - `parse_upload(filename, content) -> list[tuple[int, dict]]`: same shape. CSV/xlsx rows never carry `certifications`.

- [ ] **Step 0: Create the worktree.** Run `git worktree add .claude/worktrees/workers-export -b workers-full-export main`, then `ln -s /Users/jrh1812/Developer/BaseCampV3/portal/node_modules .claude/worktrees/workers-export/portal/node_modules`. Copy the spec and this plan into the worktree and commit them there (`docs: workers full export/import design + plan`).

- [ ] **Step 1: Write failing tests**

```python
def test_columns_match_canonical_shape():
    assert bi.COLUMNS == [
        "person_id", "first_name", "last_name", "preferred_name", "email", "phone",
        "job_title", "employee_number", "rfid_tag", "address_line1",
        "address_line2", "city", "region", "postal_code", "country",
        "partner", "trade", "level", "status", "status_note", "notes",
        "will_travel", "travel_region", "travel_restrictions"]
    assert bi.EXPORT_ONLY_COLUMNS[-1] == "certifications"
    assert not set(bi.COLUMNS) & set(bi.EXPORT_ONLY_COLUMNS)

def test_export_only_columns_are_accepted_and_dropped():
    [(n, row)] = bi.number_json_rows([{"first_name": "A", "last_name": "B",
                                       "badge_uid": "x", "has_login": True, "roles": "admin"}])
    assert "badge_uid" not in row and "has_login" not in row and row["first_name"] == "A"

def test_csv_certifications_cell_is_dropped():
    csv = "first_name,last_name,certifications\nA,B,OSHA 10 (OSHA)\n".encode()
    [(_, row)] = bi.parse_upload("w.csv", csv)
    assert "certifications" not in row

def test_json_certifications_ride_along_raw():
    certs = [{"name": "OSHA 10", "issuer": "OSHA"}]
    [(_, row)] = bi.number_json_rows([{"first_name": "A", "last_name": "B", "certifications": certs}])
    assert row["certifications"] == certs
    [(_, row)] = bi.number_json_rows([{"first_name": "A", "last_name": "B", "certifications": None}])
    assert "certifications" not in row

def test_json_upload_file_path_keeps_certifications():
    body = json.dumps([{"first_name": "A", "last_name": "B", "will_travel": True,
                        "certifications": [{"name": "CPR"}]}]).encode()
    [(_, row)] = bi.parse_upload("w.json", body)
    assert row["will_travel"] == "True" and row["certifications"] == [{"name": "CPR"}]

def test_json_nulls_read_as_blank():
    [(_, row)] = bi.number_json_rows([{"first_name": "A", "last_name": "B", "email": None,
                                       "travel_region": None}])
    assert row["email"] == "" and row["travel_region"] == ""

def test_unknown_column_still_rejected():
    with pytest.raises(bi.BulkImportError) as exc:
        bi.number_json_rows([{"first_name": "A", "bogus": 1}])
    assert exc.value.code == "unknown_columns"
```

Also add a test that a malformed `certifications` value (`"x"`, `{"name": "a"}`, `[1]`) still parses: the raw value is carried, and Task 2 turns it into a row error. Update any existing test that pins `SAMPLE_ROWS` keys or the old `COLUMNS`.

- [ ] **Step 2: Run them. Expected: FAIL** (old `COLUMNS`; no `EXPORT_ONLY_COLUMNS`).

- [ ] **Step 3: Implement.**
  - Pull the `certifications` value out of each raw JSON row *by index* before calling `core.numbered(..., columns=EXPORT_COLUMNS)`. Row n = 1 + index for JSON. Core skips fully blank rows but numbers by index.
  - Then drop the `EXPORT_ONLY_COLUMNS` keys and re-attach `certifications` when it is not None.
  - `parse_upload`: for a `.json` filename, apply the size check (`core.MAX_BYTES` → `file_too_large`), `json.loads(content.decode("utf-8-sig"))` (decode/JSON errors → `invalid_json`), then call the workers `number_json_rows`. Other extensions go through `core.parse_upload(..., EXPORT_COLUMNS, SHEET)` and then drop the export-only keys.
  - `SAMPLE_ROWS` gains `person_id: ""`, `will_travel` (`"yes"` for Robert, `""` for Maria), and `travel_region` / `travel_restrictions` (`""`).

- [ ] **Step 4: Run** `tests/test_workers_bulk_import_service.py tests/test_bulk_core.py`. **Expected: PASS.** Some preview tests may fail on the new keys. If any do, fix them only by adding the new keys. Never by changing behavior.

- [ ] **Step 5: Commit** `feat(workers-bulk): person_id, travel and export-only columns; JSON certifications`

---

### Task 2: Preview and commit (person_id, travel, certifications)

**Files:**
- Modify: `api/src/serversherpa/people/bulk_import.py` (`_reference_data`, `preview_rows`, `_diff_row`, `commit_rows`, `_create_worker`, `_apply_update`)
- Test: `api/tests/test_workers_bulk_import_service.py`

**Interfaces:**
- Consumes: Task 1's row shape.
- Produces:
  - Each preview row result gains `notes: list[str]` (empty by default).
  - The diff key `certifications` has the shape `{"add": ["Name (Issuer)", …]}` (issuer part omitted when blank). The portal's `describeDiff` already renders `add` lists.
  - The diff for `will_travel` has the shape `{"old": "yes"|"no"|None, "new": "yes"|"no"}`.
  - Helpers: `parse_will_travel(text: str) -> bool | None` (raises `ValueError` on anything but blank/yes/no/true/false, any case) and `cert_key(name: str, issuer: str | None) -> str` (`_squash(name) + "|" + _squash(issuer or "")`).

Rules (spec § Matching, § Certifications, § Access):
- `person_id`:
  - A non-UUID value → error `person_id '<v>' is not valid`.
  - The same value in two upload rows → error `duplicate person_id within the import` on both.
  - A UUID that names a live (non-archived) person → the hit `hits["person_id"] = [person]`. It is the strongest key: it counts in the "strong" list that exempts a shared name, and it comes first in `matched_by` order `person_id, email, phone, name`.
  - A UUID that names no live person → no hit, plus `notes.append("person_id not found here")`.
- `will_travel`: invalid → error `will_travel must be yes or no`. `data["will_travel"]` is normalized to `"yes"`, `"no"` or `""`. The diff compares against `profile.will_travel` mapped to `"yes"`/`"no"`/None. Apply and create convert to a bool.
- `travel_region` and `travel_restrictions` join `PROFILE_COLUMNS` (plain text, blank = leave alone).
- Certifications (only when the row carries the key):
  - Errors:
    - `certifications must be a list` when the value isn't a list of objects.
    - `certification <i>: name is required`, with `i` 1-based.
    - `certification <i>: <field> '<v>' is not a date (YYYY-MM-DD)` for `issued_on`/`expires_on` values that aren't null or a full `YYYY-MM-DD`.
  - Accepted keys are name, issuer, issued_on and expires_on. Others (`source`, ids) are ignored.
  - Duplicate `cert_key`s within one row's list collapse to the first.
  - `data["certifications"]` = the normalized list (strings, dates kept as `YYYY-MM-DD` strings), minus those whose `cert_key` the target already holds.
  - On an update row, a non-empty list adds the diff key.
  - `_reference_data` gains `cert_keys: dict[uuid.UUID, set[str]]` from `worker_certifications`.
- Rank guard: compute `guarded` and the `can_touch_rank` check over `changes` *without* the `certifications` key, so a certification-only row is never `rank too low to edit this person`. Self-status and the client-contact mix are unchanged.
- Writes: each added certification is a `WorkerCertification(person_id, name, issuer, issued_on, expires_on, created_by=actor)` with `source` left at its default `manual`. Each also gets an `audit(entity_type="worker", entity_id=str(person_id), action="certification.add", changes={"name": {"from": None, "to": name}})`.
  - On create rows, add every listed certification.
  - On approved update rows, add the ones in `data["certifications"]`.
  - The `certifications` diff key is not passed through the generic `setattr` loop.

- [ ] **Step 1: Write failing tests** (one preview per scenario, using `mk_worker` and the existing `preview`/`one`/`commit` helpers):

```python
async def test_person_id_matches_first(db, admin):
    p = await mk_worker(db, email="r@x.example.com")
    r = await one(db, admin, {"person_id": str(p.id), "first_name": "Robert", "last_name": "Smith"})
    assert r["action"] == "unchanged" and r["matched_by"].startswith("person_id")

async def test_person_id_disagreeing_with_email_is_an_error(db, admin):
    a = await mk_worker(db, "Ann", "One", email="a@x.example.com")
    await mk_worker(db, "Bea", "Two", email="b@x.example.com")
    r = await one(db, admin, {"person_id": str(a.id), "first_name": "Bea", "last_name": "Two",
                              "email": "b@x.example.com"})
    assert r["action"] == "error"

async def test_foreign_person_id_is_ignored_with_a_note(db, admin):
    r = await one(db, admin, {"person_id": str(uuid.uuid4()), "first_name": "New", "last_name": "Person"})
    assert r["action"] == "create" and r["notes"] == ["person_id not found here"] and not r["errors"]

async def test_invalid_person_id_is_an_error(db, admin):
    r = await one(db, admin, {"person_id": "nope", "first_name": "A", "last_name": "B"})
    assert r["errors"] == ["person_id 'nope' is not valid"]

async def test_will_travel_diff_and_apply(db, admin):
    p = await mk_worker(db, email="t@x.example.com", profile={})
    row = {"email": "t@x.example.com", "first_name": "Robert", "last_name": "Smith",
           "will_travel": "No", "travel_region": "West"}
    r = await one(db, admin, row)
    assert r["diff"]["will_travel"] == {"old": None, "new": "no"}
    await commit(db, admin, [r["cells"]], approved=[str(p.id)])
    prof = await db.get(WorkerProfile, p.id); await db.refresh(prof)
    assert prof.will_travel is False and prof.travel_region == "West"

async def test_will_travel_invalid(db, admin):
    r = await one(db, admin, {"first_name": "A", "last_name": "B", "will_travel": "maybe"})
    assert "will_travel must be yes or no" in r["errors"]

async def test_certifications_added_on_create(db, admin):
    res = await commit(db, admin, [{"first_name": "C", "last_name": "D",
        "certifications": [{"name": "CPR", "issuer": "Red Cross", "expires_on": "2027-01-31"}]}])
    pid = uuid.UUID(res["rows"][0]["person_id"])
    certs = list(await db.scalars(select(WorkerCertification).where(WorkerCertification.person_id == pid)))
    assert [(c.name, c.issuer, str(c.expires_on), c.source) for c in certs] == [("CPR", "Red Cross", "2027-01-31", "manual")]

async def test_certifications_on_update_need_the_tick_and_skip_existing(db, admin):
    p = await mk_worker(db, email="c@x.example.com", profile={})
    db.add(WorkerCertification(person_id=p.id, name="CPR", issuer="Red Cross")); await db.commit()
    row = {"email": "c@x.example.com", "first_name": "Robert", "last_name": "Smith",
           "certifications": [{"name": "cpr", "issuer": "red  cross"}, {"name": "OSHA 10"}]}
    r = await one(db, admin, row)
    assert r["action"] == "update" and r["diff"] == {"certifications": {"add": ["OSHA 10"]}}
    await commit(db, admin, [r["cells"]])                       # not ticked → skipped
    assert await _cert_count(db, p.id) == 1
    await commit(db, admin, [r["cells"]], approved=[str(p.id)])
    assert await _cert_count(db, p.id) == 2
    assert (await one(db, admin, row))["action"] == "unchanged"  # re-run adds nothing

async def test_certification_only_row_skips_rank_guard(db, admin):
    boss = await mk_worker(db, "Big", "Boss", email="boss@x.example.com", account=True, profile={})
    db.add(PersonRole(person_id=boss.id, role="founder")); await db.commit()
    r = await one(db, admin, {"email": "boss@x.example.com", "first_name": "Big", "last_name": "Boss",
                              "certifications": [{"name": "CPR"}]})
    assert r["action"] == "update" and not r["errors"]
    r2 = await one(db, admin, {"email": "boss@x.example.com", "first_name": "Big", "last_name": "Boss",
                               "job_title": "CEO", "certifications": [{"name": "CPR"}]})
    assert "rank too low to edit this person" in r2["errors"]

@pytest.mark.parametrize("value, error", [
    ("x", "certifications must be a list"), ({"name": "a"}, "certifications must be a list"),
    ([1], "certifications must be a list"), ([{"issuer": "X"}], "certification 1: name is required"),
    ([{"name": "A", "issued_on": "3/1/25"}], "certification 1: issued_on '3/1/25' is not a date (YYYY-MM-DD)"),
])
async def test_bad_certifications_are_row_errors(db, admin, value, error):
    r = await one(db, admin, {"first_name": "A", "last_name": "B", "certifications": value})
    assert error in r["errors"]
```

Use whatever higher-rank role exists in `access/defaults.py` for `boss` (founder or developer) if `founder` isn't a role name. Add `_cert_count` as a small helper. Also add the Review Focus #1/#3/#5 tests:
- `test_json_export_round_trips_unchanged`: build workers with a cert, `will_travel` True/False/None and `postal_code="02134"`. Call `bi.export_rows(db)`, `json.dumps`, `parse_upload("w.json", …)`, preview → every row `unchanged`. **This test needs Task 3's `export_rows`.** Write it here as `xfail(strict=True)` and remove the mark in Task 3.
- `test_commit_replays_certifications_once`: preview → commit `[r["cells"]]` → exactly one cert row.
- `test_foreign_ids_match_by_email`: person_id random plus the email of an existing worker → `update`/`unchanged`, `matched_by == "email"`, note present.

- [ ] **Step 2: Run. Expected: FAIL.**
- [ ] **Step 3: Implement** the rules above. Keep the existing structure. Put cert validation in a helper `_check_certifications(value) -> tuple[list[dict], list[str]]` (normalized list, errors).
- [ ] **Step 4: Run** `tests/test_workers_bulk_import_service.py tests/test_workers_bulk_import_api.py tests/test_client_worker_conflict.py`. **Expected: PASS.**
- [ ] **Step 5: Commit** `feat(workers-bulk): match by person_id, import travel fields and JSON certifications`

---

### Task 3: Full export, JSON downloads, users:view gate

**Files:**
- Modify: `api/src/serversherpa/people/bulk_import.py` (`export_rows`, new builders)
- Modify: `api/src/serversherpa/api/routes/workers.py` (`bulk_import_template`, `bulk_import_export`)
- Test: `api/tests/test_workers_bulk_import_service.py`, `api/tests/test_workers_bulk_import_api.py`

**Interfaces:**
- Produces:
  - `export_rows(db) -> list[dict]`: typed rows keyed by `EXPORT_COLUMNS`. Each value is a `str`, `bool` or `None`, except `certifications`, which is a `list[dict]` with keys `name, issuer, issued_on, expires_on, source` (dates `YYYY-MM-DD` or None), ordered like `GET /workers/{id}/certifications` (expires_on asc, nulls last, then natural name).
  - Empty strings from the DB export as `None`. `status` still defaults to `"active"`.
  - Booleans: `will_travel` (None when not set), `has_photo`, `has_login`, `login_disabled` (None when there's no login).
  - `roles` is the active role names, comma-joined in natural order, or None.
  - Datetimes are ISO 8601 in UTC (`dt.astimezone(UTC).isoformat()`).
  - `flatten_row(row: dict) -> dict[str, str]`: None → `""`, bool → `"yes"`/`"no"`, certifications → `"; "`-joined `Name (Issuer) issued → expires`, leaving out missing parts (`CPR (Red Cross) → 2027-01-31`, `OSHA 10`, `First Aid 2025-03-01 →`).
  - `build_export_json(rows) -> str` (`json.dumps(rows, indent=2, ensure_ascii=False)`); `build_export_csv(rows) -> str`; `build_export_xlsx(rows, levels, statuses, partners) -> bytes`. The last two use the core builders with `EXPORT_COLUMNS` over `flatten_row`.
  - `build_template_json() -> str`: `SAMPLE_ROWS` with `""` → null, Robert's `will_travel` → `true`, and one sample certification on Robert: `{"name": "OSHA 10", "issuer": "OSHA", "issued_on": "2025-03-01", "expires_on": null}`. Maria gets `[]`.
  - The CSV/xlsx templates keep `COLUMNS` only.
  - Routes:
    - `template?format=json` → `application/json`, `workers-template.json`.
    - `export?format=json` → `workers-export.json`.
    - The export checks `actor.access.can("users", "view")` right after `require_bulk_rank`, before the format. Failure → `_err(403, "forbidden")`.

- [ ] **Step 1: Write failing tests**
  - Service: `test_export_rows_full_shape`. A worker with a login account (with `disabled_at` set), roles worker+staff, a cert and travel fields gives exactly `EXPORT_COLUMNS` keys and the right typed values. A bare worker has `email is None`, `has_login is False`, `login_disabled is None`, `certifications == []`.
  - Service: `test_export_never_leaks_secrets`. The JSON text contains none of `password_hash`, `totp`, `last_login_ip`, `ui_prefs`, `avatar_key`.
  - Service: `test_flatten_row`, with the three cert strings above.
  - Service: `test_csv_and_xlsx_export_round_trip_unchanged` (Review Focus #2). Export → `parse_upload("w.csv"/"w.xlsx")` → preview → all `unchanged`.
  - Remove the `xfail` from Task 2's `test_json_export_round_trips_unchanged`.
  - API: extend `test_export_formats` with `format=json` (status 200, `application/json`, a list) and `test_template_formats` with `json`.
  - API: `test_export_requires_users_view`. Add `PermissionOverride(person_id=admin.id, resource="users", action="view", allow=False)`. Then the export (csv, xlsx, json) is 403 `forbidden`, and `template?format=csv` is still 200.
  - Update the existing tests that asserted `""` values from `export_rows`.
- [ ] **Step 2: Run. Expected: FAIL.**
- [ ] **Step 3: Implement.** Load accounts, active roles, and certs in three queries keyed by person_id (no per-row queries).
- [ ] **Step 4: Run** both worker bulk test files plus `tests/test_bulk_core.py`. **Expected: PASS.**
- [ ] **Step 5: Commit** `feat(workers-bulk): full export in JSON/CSV/xlsx behind users:view`

---

### Task 4: Portal

**Files:**
- Modify: `portal/src/components/bulk/BulkUpload.tsx`: add `fileTypes?: string[]` to `BulkUploadConfig` (default `['.csv', '.xlsx']`). It drives `accept` (joined with `,`) and the label. The label is `Upload a file (.csv or .xlsx)` for two types and `Upload a file (.csv, .xlsx or .json)` for three. Add `notes?: string[]` to `BulkPreviewRow` and render each note as a plain `<span className="muted">` in the Details cell for any action. Widen `cells` to `Record<string, unknown>`.
- Modify: `portal/src/components/workers/WorkerBulkUpload.tsx`: `fileTypes: ['.csv', '.xlsx', '.json']`.
- Modify: `portal/src/lib/api.ts`: `downloadWorkerTemplate` / `downloadWorkerExport` take `'csv' | 'xlsx' | 'json'`. `WorkerBulkRowResult` gains `notes: string[]` and `cells: Record<string, unknown>`.
- Modify: `portal/src/pages/BulkWorkers.tsx`:
  - The downloads are, in order: Template (.xlsx), Template (.csv), Template (.json), then Current workers (.xlsx/.csv/.json).
  - The Current workers buttons are hidden unless `useAuth().can('users', 'view')`.
  - The hint gains the sentence: "Upload .csv, .xlsx or .json. Rows with a person_id from an export match that person first."
  - Replace "Rows match existing people by email, phone, or name" with "Rows match existing people by person_id, email, phone, or name".
- Modify: `portal/src/lib/workerBulk.ts`: `WORKER_COLUMN_GUIDE` follows `EXPORT_COLUMNS` order.
  - Each new editable column gets an accepts text:
    - person_id: `From an export. Matches that person first; ignored if no such person exists here.`
    - will_travel: `yes or no. Blank leaves it as it is.`
    - travel_region: `Free text.`
    - travel_restrictions: `Free text.`
  - Each export-only column gets `Export only — ignored on upload.`, except certifications: `JSON uploads: a list of {name, issuer, issued_on, expires_on} — new ones are added, existing ones left alone. In .csv/.xlsx: export only.`
  - Examples are `''` except will_travel `yes`.
- Test: `portal/src/pages/BulkWorkers.test.tsx`, `portal/src/lib/workerBulk.test.ts`, and the BulkUpload test file if one exists (`portal/src/components/bulk/BulkUpload.test.tsx`).

- [ ] **Step 1: Write failing tests**
  - BulkWorkers:
    - Six download buttons. Clicking `Current workers (.json)` calls `downloadWorkerExport('json')`, and `Template (.json)` calls `downloadWorkerTemplate('json')`.
    - With `can` mocked as `(r, a) => !(r === 'users' && a === 'view')`, the three Current workers buttons are absent and the three templates remain.
    - The file input's `accept` is `.csv,.xlsx,.json`.
  - BulkUpload: with no `fileTypes`, `accept` is `.csv,.xlsx` and the label is "Upload a file (.csv or .xlsx)". A preview row with `notes: ['person_id not found here']` shows that text.
  - workerBulk.test: the guide keys equal the API's `EXPORT_COLUMNS` list (copy the literal list into the test, as the existing test does for `COLUMNS`).
- [ ] **Step 2: Run** `npx vitest run src/pages/BulkWorkers.test.tsx src/lib/workerBulk.test.ts src/components/bulk`. **Expected: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same files plus every `src/pages/Bulk*.test.tsx` (the other tools share BulkUpload), then `npx tsc -b --noEmit` (or the repo's `npm run build`). **Expected: PASS / clean.**
- [ ] **Step 5: Commit** `feat(portal): workers bulk JSON downloads, file types, notes, users:view gate`

---

### Task 5: Verify, merge, push

- [ ] Run every `api/tests/test_*bulk*.py` file, plus `test_workers*.py`, `test_cert_worker.py` and `test_client_worker_conflict.py`, in the foreground. Then run the portal's full `npx vitest run` and `npm run build`. Record the summary lines.
- [ ] Live check against the dev stack (main's portal on 5173 / API on 8000 belong to other sessions; run the worktree's API on 8001 and portal on 5175 per the memory `bulk-workers-import` recipe):
  - Download Current workers (.json) and re-upload it → every row unchanged (the known duplicate Jimmy Henderson row excepted).
  - Download and re-upload the .xlsx → every row unchanged, same exception.
  - Upload a one-row JSON with a new certification for an existing worker → an update row showing `certifications: +…`. Do not apply it.
  - Screenshot the page.
- [ ] Final whole-branch review, then fix anything it finds.
- [ ] Merge `workers-full-export` into main (`--no-ff`) in the main checkout. Leave its unrelated uncommitted files alone. Remove the worktree. **Do not push.** Pushing waits for Jimmy's say-so (then fetch and merge `github/main` first, per memory `github-push-merge-first`).
