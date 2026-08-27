# Site Detail + Survey Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/sites/:id` detail page with Overview/Map/Clients/Notes panels plus two standard survey lists, backed by real rows: `site_survey_data` (current answer per field) + `raw_survey_data` (append-only trail), replacing the `sites.survey_data` blob.

**Architecture:** Migration explodes existing blobs into rows and drops the column; per-field PUT/DELETE endpoints run the write-both flow (append raw → upsert curated, one transaction); the page follows the reviewed AssetDetail/MoveAssetDetail chrome and the survey lists follow the reviewed standard-list recipe. Spec: `docs/superpowers/specs/2026-08-27-site-detail-surveys-design.md`.

**Tech Stack:** Alembic/SQLAlchemy async, FastAPI; React 18 + TS.

## Global Constraints

- House UI vocabulary only (the spec's standing rule): `idet-*` chrome, `init-panel`, `dl.kv`, `chip.custom`, standard-list kit, `NotesFilesPanel`, `SitesMap`, `SurveyForm` (presentation-unchanged).
- Curated rows: registry-validated keys/values, `UNIQUE(site_id, field_key)`. Raw rows: any key, append-only, never mutated. Portal writes do BOTH in one transaction.
- Curated survey list shows EVERY registered field (unanswered = `—`), inline-editable gated on `sites: change` (explicitly NOT god-mode-gated). Raw list read-only, newest first (`id desc`).
- The blob (`sites.survey_data` column, `PUT /sites/{id}/survey` bulk endpoint, `SiteDetail.survey_data` payload field) is fully removed. `GET /sites/survey-schema` unchanged. Registry (`sites/survey.py`) unchanged.
- Suites: API `.venv/bin/python -m pytest -q` from `api/`; portal `npm test` + `npm run build`. EVERYTHING FOREGROUND in one continuous run — never background a suite and stop. Never commit `_dev_reload.py` or `.env`. Trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

### Task 1: Migration `0027_site_survey_rows.py` + models

**Files:**
- Create: `api/migrations/versions/0027_site_survey_rows.py`
- Modify: `api/src/serversherpa/db/models.py` (drop `Site.survey_data`; add `RawSurveyEntry`, `SiteSurveyEntry` classes after `SiteClient`)
- Test: Create `api/tests/test_site_survey_model.py`

**Interfaces:**
- Produces: tables `raw_survey_data` / `site_survey_data` per the spec's column tables (§1, copy exactly: types, nullability, defaults, `UNIQUE(site_id, field_key)` named `site_survey_data_site_field_uniq`, indexes `raw_survey_data_site_idx (site_id, id)` and `site_survey_data_site_idx (site_id)`); ORM classes `RawSurveyEntry` (`__tablename__ = "raw_survey_data"`) and `SiteSurveyEntry` (`__tablename__ = "site_survey_data"`) with fields mirroring the spec (value as `Mapped[dict | list | str | int | bool | None] = mapped_column(JSONB)` — use `Mapped[object | None]`-style typing per how other JSONB columns are declared in models.py; match the house pattern exactly).

- [ ] **Step 1: Failing tests** — create `api/tests/test_site_survey_model.py` with docstring `"""Site survey rows — schema defaults, uniqueness, provenance links."""`, imports `pytest`, `datetime`/`UTC`, `text` from sqlalchemy, `IntegrityError`, and `RawSurveyEntry, Site, SiteSurveyEntry` from `serversherpa.db.models`. Four tests (use `captured_at=datetime.now(UTC)` on every raw entry):
1. `test_raw_entry_defaults`: insert a `RawSurveyEntry` (site, `field_key="dock_available"`, `value=True`, `captured_at=datetime.now(UTC)`) → id is an int, `device_id == ""`, `source == ""`, `submitted_by is None`, `created_at` set. A second entry with a stray key (`field_key="totally_custom"`, `value="x"`) also inserts (no registry FK).
2. `test_curated_unique_per_field`: two `SiteSurveyEntry` rows for the same (site, `"dock_available"`) → second commit raises `IntegrityError`; different field_key on the same site is fine.
3. `test_curated_raw_link`: curated row with `raw_id` pointing at a raw entry commits; `raw_id=999999` (nonexistent) raises `IntegrityError` (FK).
4. `test_survey_blob_column_gone`: `SELECT column_name FROM information_schema.columns WHERE table_name='sites' AND column_name='survey_data'` returns no rows; and `Site` has no `survey_data` attribute (`assert not hasattr(Site, "survey_data")`).

- [ ] **Step 2: Verify failure** — `.venv/bin/python -m pytest tests/test_site_survey_model.py -x -q` → ImportError (`RawSurveyEntry`).

- [ ] **Step 3: Migration** — module docstring explains the upgrade (blob → rows, V2 lineage, write-both flow, promotion deferred). `revision "0027"`, `down_revision "0026"`. Upgrade:

1. `op.create_table("raw_survey_data", ...)` and `op.create_table("site_survey_data", ...)` exactly per the spec §1 (longhand, house style: TIMESTAMP(timezone=True), server_default now() where specified, comments on `field_key` strays / `raw_id` provenance / `device_id`+`source` future feeds).
2. Blob explosion (runs before the drop):

```python
    conn = op.get_bind()
    sites = conn.execute(sa.text(
        "SELECT id, survey_data FROM sites "
        "WHERE survey_data IS NOT NULL AND survey_data != '{}'::jsonb")).all()
    for site_id, blob in sites:
        for key, value in (blob or {}).items():
            raw_id = conn.execute(sa.text(
                "INSERT INTO raw_survey_data "
                "(site_id, field_key, value, captured_at, source) "
                "VALUES (:s, :k, CAST(:v AS jsonb), now(), 'migration') "
                "RETURNING id"),
                {"s": site_id, "k": key, "v": json.dumps(value)}).scalar()
            if key in FIELDS_BY_KEY:
                conn.execute(sa.text(
                    "INSERT INTO site_survey_data "
                    "(site_id, field_key, value, raw_id) "
                    "VALUES (:s, :k, CAST(:v AS jsonb), :r)"),
                    {"s": site_id, "k": key, "v": json.dumps(value), "r": raw_id})
```

with `import json` and `from serversherpa.sites.survey import FIELDS_BY_KEY` at module top (importing app code into a migration is acceptable here: the registry is code-not-data by design; note this in the docstring). Values are inserted as-is — no re-validation (they passed validation when written).
3. `op.drop_column("sites", "survey_data")`.

Downgrade: re-add `survey_data` (JSONB, not null, server_default `'{}'::jsonb`), re-fold curated rows into blobs (`UPDATE sites SET survey_data = agg.blob FROM (SELECT site_id, jsonb_object_agg(field_key, value) AS blob FROM site_survey_data GROUP BY site_id) agg WHERE sites.id = agg.site_id`), drop both tables (curated first — it FKs raw).

- [ ] **Step 4: Models** — remove `survey_data` from `Site`; add the two classes with docstrings ("append-only submission trail — the scans-raw of surveys" / "current answer per (site, field); UNIQUE enforced; raw_id = provenance").

- [ ] **Step 5: Fix the blob's dependents to keep the tree importable/green** — this task ONLY makes the minimal API-side edits required for the suite to pass with the column gone; the real endpoint rework is Task 2. Concretely: in `api/src/serversherpa/api/routes/sites.py` delete the `set_site_survey` endpoint and the `survey_data=` kwarg in `_detail`; in `api/src/serversherpa/api/schemas.py` remove `SiteDetail.survey_data` and `SiteSurveyIn`; in `api/tests/test_sites_links.py` delete the now-obsolete blob-survey tests (`test_survey_save_validates_and_audits` and any sibling asserting `survey_data`) — Task 2 replaces the coverage. Run `grep -rn "survey_data" api/src api/tests` and clear every remaining reference except the migration itself.

- [ ] **Step 6: Migrate + full suite**

```
.venv/bin/alembic upgrade head
.venv/bin/alembic downgrade 0026 && .venv/bin/alembic upgrade head
.venv/bin/python -m pytest tests/test_site_survey_model.py -q
.venv/bin/python -m pytest -q   # foreground, long timeout
```

- [ ] **Step 7: Commit** — `feat(api): site survey rows — raw trail + curated answers, blob removed`

---

### Task 2: API — survey read/write endpoints with the write-both flow

**Files:**
- Modify: `api/src/serversherpa/api/routes/sites.py`
- Modify: `api/src/serversherpa/api/schemas.py`
- Test: Create `api/tests/test_site_survey_api.py`

**Interfaces:**
- Consumes: Task 1's models; `validate_survey`/`FIELDS_BY_KEY`/`survey_schema` from `serversherpa.sites.survey`; `audit`/`diff` from services.
- Produces (Task 3 mirrors field-for-field):
  - `GET /sites/{site_id}/survey` → `list[SiteSurveyRowOut]`: `field_key: str`, `label: str`, `group: str`, `group_label: str`, `kind: str`, `options: list[str]`, `value` (JSON scalar), `raw_id: int | None`, `updated_by: uuid|None`, `updated_by_name: str|None`, `updated_at: datetime | None` (None when unanswered). Ordered by registry order (the SURVEY_FIELDS tuple order).
  - `GET /sites/{site_id}/survey/raw` → `list[RawSurveyRowOut]`: `id: int`, `field_key: str`, `registered: bool`, `value`, `captured_at`, `submitted_by: uuid|None`, `submitted_by_name: str|None`, `device_id: str`, `source: str`, `created_at`. Ordered `id desc`.
  - `PUT /sites/{site_id}/survey/{field_key}` body `SiteSurveyValueIn {value}` (extra=forbid) → the write-both flow → the updated `SiteSurveyRowOut`. Errors: `unknown_survey_field` / `invalid_survey_value` (422), `site_not_found` (404).
  - `DELETE /sites/{site_id}/survey/{field_key}` → clear flow → 204; `survey_value_not_found` 404 when no curated row.
  - Audit: `entity_type="site"`, action `survey.update` with `{field_key: {from, to}}` per write/clear.

- [ ] **Step 1: Failing tests** — `api/tests/test_site_survey_api.py` (helpers `login` from `.test_assets_api`; fixtures `client, db, seeded_user`):

```python
"""Site survey rows API — write-both flow, curated/raw reads, gates."""

from serversherpa.db.models import (
    Person, PersonRole, RawSurveyEntry, Site, SiteSurveyEntry,
)

from .test_assets_api import login, make_login


async def test_put_writes_raw_and_curated(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="WB Site")
    db.add(site)
    await db.commit()

    resp = await client.put(f"/sites/{site.id}/survey/dock_available",
                            headers=hdrs, json={"value": True})
    assert resp.status_code == 200, resp.text
    row = resp.json()
    assert row["value"] is True
    assert row["label"] == "Dock available"
    assert row["updated_by_name"]  # the actor
    assert row["raw_id"] is not None

    # raw trail has exactly one portal-sourced entry pointing the same way
    raws = (await client.get(f"/sites/{site.id}/survey/raw",
                             headers=hdrs)).json()
    assert len(raws) == 1
    assert raws[0]["id"] == row["raw_id"]
    assert raws[0]["source"] == "portal"
    assert raws[0]["registered"] is True

    # second write: curated stays one row (upsert), raw grows to two
    resp = await client.put(f"/sites/{site.id}/survey/dock_available",
                            headers=hdrs, json={"value": False})
    assert resp.json()["value"] is False
    curated = (await client.get(f"/sites/{site.id}/survey",
                                headers=hdrs)).json()
    answered = [r for r in curated if r["value"] is not None]
    assert len(answered) == 1
    raws = (await client.get(f"/sites/{site.id}/survey/raw",
                             headers=hdrs)).json()
    assert len(raws) == 2
    assert raws[0]["value"] is False        # newest first


async def test_curated_list_covers_registry(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="Registry Site")
    db.add(site)
    await db.commit()
    rows = (await client.get(f"/sites/{site.id}/survey", headers=hdrs)).json()
    from serversherpa.sites.survey import SURVEY_FIELDS
    assert [r["field_key"] for r in rows] == [f.key for f in SURVEY_FIELDS]
    assert all(r["value"] is None for r in rows)   # nothing answered yet


async def test_clear_appends_null_raw_and_deletes_curated(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="Clear Site")
    db.add(site)
    await db.commit()
    await client.put(f"/sites/{site.id}/survey/floor",
                     headers=hdrs, json={"value": 3})
    resp = await client.delete(f"/sites/{site.id}/survey/floor", headers=hdrs)
    assert resp.status_code == 204
    curated = (await client.get(f"/sites/{site.id}/survey", headers=hdrs)).json()
    floor = next(r for r in curated if r["field_key"] == "floor")
    assert floor["value"] is None
    raws = (await client.get(f"/sites/{site.id}/survey/raw", headers=hdrs)).json()
    assert len(raws) == 2 and raws[0]["value"] is None

    resp = await client.delete(f"/sites/{site.id}/survey/floor", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "survey_value_not_found"


async def test_validation_errors(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="Val Site")
    db.add(site)
    await db.commit()
    resp = await client.put(f"/sites/{site.id}/survey/not_a_field",
                            headers=hdrs, json={"value": "x"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_survey_field"
    resp = await client.put(f"/sites/{site.id}/survey/dock_available",
                            headers=hdrs, json={"value": "yes"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_survey_value"
    resp = await client.put(
        "/sites/00000000-0000-0000-0000-000000000000/survey/floor",
        headers=hdrs, json={"value": 1})
    assert resp.status_code == 404


async def test_raw_shows_stray_keys(client, db, seeded_user):
    from datetime import UTC, datetime
    hdrs = await login(client)
    site = Site(name="Stray Site")
    db.add(site)
    await db.flush()
    db.add(RawSurveyEntry(site_id=site.id, field_key="legacy_custom_thing",
                          value="hello", captured_at=datetime.now(UTC),
                          source="import"))
    await db.commit()
    raws = (await client.get(f"/sites/{site.id}/survey/raw", headers=hdrs)).json()
    assert raws[0]["registered"] is False
    assert raws[0]["source"] == "import"
```

Plus a `test_survey_audit_written` (PUT then query `/audit?entity_type=site&entity_id={id}` for action `survey.update` with the field in changes) and a worker-role 403 gate test on all four endpoints (same `make_login` pattern as the scans gate tests).

- [ ] **Step 2: Verify failure** — 404s (routes missing).

- [ ] **Step 3: Schemas** (`schemas.py`, near the site schemas): `SiteSurveyRowOut`, `RawSurveyRowOut`, `SiteSurveyValueIn` exactly per the Interfaces block (value fields typed `bool | int | str | None`; `SiteSurveyValueIn.value: bool | int | str | None` with `model_config = ConfigDict(extra="forbid")`).

- [ ] **Step 4: Endpoints** (`routes/sites.py`, in the existing "client links + survey save" section; keep `_require_global` on all four like the other site routes). Implementation notes the code must honor:
  - Curated GET: fetch `SiteSurveyEntry` rows for the site into a dict by field_key; walk `SURVEY_FIELDS` in order emitting one `SiteSurveyRowOut` per registry field (merged values or None); batch-load `updated_by` names with one `Person` query (the scans `_people_names` pattern — write a small local helper). `updated_at` for unanswered fields: use the site's `created_at`? No — make `updated_at: datetime | None` and None when unanswered (adjust the schema accordingly).
  - Raw GET: straight select, `order_by(RawSurveyEntry.id.desc())`, `registered = field_key in FIELDS_BY_KEY`, batch people names.
  - PUT: validate via `FIELDS_BY_KEY` lookup + the module's `_clean` (import it — it is module-private by underscore but same-package use is the pragmatic house call; alternatively call `validate_survey({field_key: value})` and take `out.get(field_key)` — use validate_survey, it's public; a cleaned `None` (empty string) means "treat as clear": run the clear flow instead, returning the emptied row).
  - Write-both in one transaction: `db.add(RawSurveyEntry(...)); await db.flush()` → upsert curated (`select` existing then set fields, or insert) → audit → single `db.commit()`.
  - DELETE: 404 if no curated row; else append null raw + `db.delete(curated)` + audit + commit.

- [ ] **Step 5: Run** — `.venv/bin/python -m pytest tests/test_site_survey_api.py tests/test_sites_links.py tests/test_sites_api.py -q` (check the actual sites test filenames with `ls api/tests | grep site` and run them all), then the full suite once.

- [ ] **Step 6: Commit** — `feat(api): per-field site survey endpoints with raw+curated write flow`

---

### Task 3: Portal plumbing — fetchers, pure logic, modal/list rework

**Files:**
- Modify: `portal/src/lib/api.ts` (sites section)
- Create: `portal/src/lib/siteSurvey.ts` + `portal/src/lib/siteSurvey.test.ts`
- Modify: `portal/src/components/sites/SiteEditModal.tsx`, `portal/src/pages/Sites.tsx`
- Modify (if needed): `portal/src/lib/sites.ts` (where `surveyChanged`/`surveyPayload` live — check imports at SiteEditModal.tsx:37-38)

**Interfaces:**
- Consumes: Task 2's endpoints/shapes.
- Produces:
  - api.ts: `SiteSurveyRow` / `RawSurveyRow` interfaces mirroring `SiteSurveyRowOut`/`RawSurveyRowOut` field-for-field (uuid→string, datetime→string, value `boolean | number | string | null`); `listSiteSurvey(siteId): Promise<SiteSurveyRow[]>`; `listSiteSurveyRaw(siteId): Promise<RawSurveyRow[]>`; `putSiteSurveyValue(siteId, fieldKey, value): Promise<SiteSurveyRow>`; `clearSiteSurveyValue(siteId, fieldKey): Promise<void>`. Remove `saveSiteSurvey` (blob) and `survey_data` from `SiteDetailOut`.
  - siteSurvey.ts: `surveyValueText(row: SiteSurveyRow): string` (bool→'Yes'/'No', null→'—', select/int/text as string); `surveyCellText(row, colKey)` and `surveySearchText(row)` for the curated list; `rawSurveyCellText(row, colKey)` / `rawSurveySearchText(row)`; `SITE_SURVEY_ERRORS` map (`unknown_survey_field`, `invalid_survey_value`, `survey_value_not_found`, `forbidden`); `filledCount(rows): {filled, total}`.
- The curated list's display rows come straight from `GET /sites/{id}/survey` (the server already merges registry+answers) — no client-side schema merge needed.

- [ ] **Step 1: TDD the pure logic** — write `siteSurvey.test.ts` first (fixtures for answered bool/int/select/text rows + unanswered row; pin `surveyValueText` for each kind, cellText `—` fallbacks incl. `updated_by_name`/`updated_at`, searchText contents lowercased, filledCount, raw cellText incl. `registered` Yes/`—` and JSON-ish value rendering `String(value)`). Then implement `siteSurvey.ts`.

- [ ] **Step 2: api.ts** — add the four fetchers + two interfaces (house `apiFetch`/`errorFrom` pattern); delete `saveSiteSurvey` and `SiteDetailOut.survey_data`; `npm run build` will now flag every stale consumer — fix them per Steps 3–4.

- [ ] **Step 3: SiteEditModal** — keep `SurveyForm` (presentation untouched). Replace the load (`detail.survey_data`) with `listSiteSurvey(id)` → `values = Object.fromEntries(rows.filter(r => r.value !== null).map(r => [r.field_key, r.value]))`; baseline likewise. Replace the save block (SiteEditModal.tsx:147-149): for each schema field where `values[key] !== baseline[key]`, `await putSiteSurveyValue(id, key, values[key])` when the new value is non-empty, `await clearSiteSurveyValue(id, key)` when it was cleared (had a baseline value, now empty/undefined) — sequential loop, then reset baseline. Drop `surveyChanged`/`surveyPayload` imports if now unused (delete their lib code + tests only if nothing else imports them — grep first).

- [ ] **Step 4: Sites.tsx expansion** — the per-row survey summary currently fetches `getSite(id).survey_data`; switch it to `listSiteSurvey(id)` + `filledCount` (“12/17 fields filled” text stays). Fix any other `survey_data` references (`grep -rn "survey_data" portal/src`).

- [ ] **Step 5: Suites + commit** — `npm test` + `npm run build` clean. Commit: `feat(portal): site survey client on row endpoints`

---

### Task 4: The `/sites/:id` page

**Files:**
- Create: `portal/src/pages/SiteDetail.tsx`
- Modify: `portal/src/App.tsx` (route `/sites/:siteId` under `ProtectedRoute resource="sites"`, after `/sites`), `portal/src/pages/Sites.tsx` (Full Details ↗ link in the row expansion's detail-actions area), `portal/src/components/Topbar.tsx` (site hits → `/sites/${hit.id}`), `portal/src/lib/auditFormat.ts` (`site` href → `` `/sites/${row.entity_id}` `` — note entityHref currently builds `${base}?open=`; give `site` a detail-page branch like the initiative pattern used in Topbar, keeping other kinds untouched).

**Interfaces:**
- Consumes: `getSite(id): Promise<SiteDetailOut>` (exists), `SitesMap` (`{sites, onSelect}` — pass a one-element array and a no-op onSelect), `NotesFilesPanel`, `SiteEditModal` (check its props in Sites.tsx and reuse), Task 3's fetchers.
- Produces: the page shell with panels 1–4 (Overview, Map, Clients, Notes & files) and TWO stub containers (`<div className="init-panel">` with eyebrows "Site Survey Data" / "Raw Survey Data" and `page-hint` "Loading…" placeholders) that Task 5 fills.

Structural reference: `portal/src/pages/AssetDetail.tsx` (the reviewed house detail page) — clone its chrome/data-flow/not-found/edit-modal wiring with site substitutions: back link "← Sites" → `/sites`; title = site name; hint = type_label · status_label; status + type chips via the local `chip` helper pattern; Edit gated `can('sites','change')` opening `SiteEditModal` (mirror how Sites.tsx invokes it — lookups included) with `onSaved` refetching. Overview `dl.kv`: address_line1/2, city/region/postal, country, timezone, DC provider, partner_name, latitude/longitude (as text, `—` when null), created/updated (check `SiteDetailOut`'s real field names in api.ts and use only those). Map panel: render `<SitesMap sites={[site]} onSelect={() => {}} />` inside the panel when `latitude != null`, else `page-hint` "No coordinates recorded." Clients panel: the detail's client links as `chip`/`dl.kv` names (read-only). Notes panel: `<NotesFilesPanel entityType="site" entityId={site.id} canWrite={can('sites','change')} />`.

Suites + browser sanity (page renders from a Sites-list Full Details click; Edit round-trips; search-everywhere site hit lands on the page). Commit: `feat(portal): site full-details page`

---

### Task 5: The two survey lists

**Files:**
- Create: `portal/src/components/sites/SiteSurveyList.tsx`, `portal/src/components/sites/RawSurveyList.tsx`
- Modify: `portal/src/pages/SiteDetail.tsx` (replace the two stubs)

**Interfaces:**
- Consumes: Task 3's fetchers + siteSurvey.ts logic; the standard-list kit exactly as the reviewed `ProcessedScansTab.tsx` uses it (`usePersistentListState`, `ColumnMenu`, `FilterSummaryChip`, `EmptyClearFilters`, `passesColumnFilters`, `ColumnsButton`, `ExportButton`, `exportCsv`, `applyColumnOrder`, `visibleColumnsFor`, `moveKey`, `useReorderDrag`, `VirtualRows`, `naturalCompare`).
- Produces: `<SiteSurveyList siteId onCount?/>` (curated, editable) and `<RawSurveyList siteId/>` (read-only), each starting at its own `.dir-toolbar` inside the page's panels.

**SiteSurveyList** (curated): columns `field` (primary, 2fr: label bold + group beneath in `.pn`), `group` (1fr, default), `value` (1.4fr, default), `updated_by` (1fr, default), `updated` (1fr, default false); `usePersistentListState('site_survey', {sortKey: 'field', sortDir: 1}, …)` where `sortValueFor('field')` returns the REGISTRY index zero-padded (preserves questionnaire order as the default sort — the rows arrive registry-ordered; compute index from array position at load). Column menus on all columns using `surveyCellText`. No archived column, no row expansion, no god toggle. **Value editing**: when `can('sites','change')`, the value cell renders an edit affordance per `kind` — reuse the `GodCell` machinery by constructing `GodField`-shaped descriptors (`kind: 'text'` for text/textarea/int, `kind: 'combo'` for bool (Yes/No→true/false) and select (options)) with a custom `patch` that calls `putSiteSurveyValue` (empty → `clearSiteSurveyValue`) and maps the response back to a row — BUT always-on (not behind `god.editing`): render the GodCell directly in the value cell. If `GodCell`'s contract fights the always-on usage (check `lib/godEdit.tsx` — it may require the `useGodEdit` context), fall back to a small local `SurveyValueCell` component (input/select + save-on-blur/Enter + error text from `SITE_SURVEY_ERRORS`) styled with the god-edit CSS classes — report which path was taken. Header badge: `filledCount` "12/17 filled" in the panel eyebrow row. CSV `'site-survey'`.

**RawSurveyList**: read-only clone of the RawScansTab standard-list skeleton. Primary column = `field` (the key, mono); data columns: `value` (1.4fr), `registered` (0.8fr, Yes/`—`), `source` (0.8fr), `submitted_by` (1fr), `device` (1fr, mono, default false), `captured` (1.1fr locale string), `ingested` (1fr, default false); `usePersistentListState('raw_survey', {sortKey: 'captured', sortDir: -1}, …)`. `VirtualRows` in both lists (plain branch in practice; threshold handles growth). CSV `'raw-survey'`. Empty state: "No survey submissions yet."

Suites + commit: `feat(portal): site survey standard lists`

---

### Task 6: Full verification + browser pass

No planned code (fix-and-commit small findings inline). API + portal suites; browser: `/sites/:id` from list + search; Overview/Map/Clients/Notes render; curated list — edit a bool, an int, a select, a text field (each round-trips; raw trail grows per edit; clear a value → row shows `—`, raw gains a null entry); registry order default sort; column menus/CSV on both lists; stray-key raw row shows Registered `—` (insert one via psql per Task 2's test pattern); modal SurveyForm still loads/saves; audit log shows `survey.update` entries with the site linking to the new page. Record evidence in `.superpowers/sdd/`.
