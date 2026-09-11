# Site & Move Survey Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port V2's Site & Move Survey (partner xlsx template fill + optional Transportation Standards and Site Photos sheets) into V3's reports framework with the portal's UI idioms.

**Architecture:** New report module `api/src/serversherpa/reports/site_move_survey/` (gather → context → openpyxl fill → optional sheets → xlsx). Framework generalized to non-PDF results and optional initiatives. Templates are partner attachments of kind `survey_template`; the standards docx is a `report_asset` attachment on the report definition. Portal: per-report options component inside `GenerateReportModal`, plus small additions to the partner Files panel and the definition Edit modal.

**Tech Stack:** FastAPI/SQLAlchemy async/Alembic/openpyxl/Pillow (api), React + TS + Vitest (portal).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-11-site-move-survey-design.md` (authoritative for names, copy, variable catalog). V2 reference for behavior: `/Users/jrh1812/Developer/BaseCampV2-reference/api/reports/site_move_survey.py` and `/Users/jrh1812/Developer/BaseCampV2-reference/docs/site-move-survey/template-annotation-guide.md` (read-only).
- Migration `0052`, `down_revision = "0051"`, single head. Report type string `site_move_survey`. Attachment kinds `survey_template`, `report_asset`; entity type `report_definition`.
- Error codes: `no_survey_template`, `partner_not_logistics`, `partner_not_found`, `template_unreadable`, plus the existing reports/attachments codes.
- American English in all copy/comments. Portal idioms only (ComboBox, `.segmented`, Switch, chips, `.pf-form`, mini-list); typography guardrail green, no new allowlist entries; no raw native `<select>`.
- Tests FOREGROUND, one call, timeout 600000ms: API `PYTHONPATH=src SS_TEST_DB=serversherpa_test_sms /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q <files>` from the worktree's api/; portal `npx vitest run <files> && npx tsc --noEmit -p .` from portal/.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `git add` by explicit path; never `git stash`; `git checkout -- api/src/serversherpa/_dev_reload.py` if it shows modified.
- The generated Champagne survey Jimmy supplied is at `/private/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/59926b80-c4cc-4bb6-b981-82a6cb827a67/scratchpad/champagne_generated.xlsx` (copy it into `api/tests/fixtures/` as `champagne_generated.xlsx` in Task 1 so later tasks and the scripts have a tracked input).

---

### Task 1: Fixtures + framework changes (migration 0052, ReportResult, attachment kinds)

**Files:** Create `api/migrations/versions/0052_site_move_survey.py`, `api/scripts/rebuild_champagne_template.py`, `api/scripts/rebuild_transportation_standards.py`, `api/tests/fixtures/champagne_generated.xlsx` (copied), `api/tests/fixtures/champagne_annotated_template.xlsx` (generated), `api/tests/fixtures/transportation_standards.docx` (generated), `api/tests/test_site_move_survey_fixtures.py`; Modify `api/src/serversherpa/reports/registry.py` (`ReportResult`), `api/src/serversherpa/reports/worker.py`, `api/src/serversherpa/reports/move_report/__init__.py` (construct the new result), `api/src/serversherpa/db/models.py` (`ReportRun.initiative_id` Optional), `api/src/serversherpa/api/routes/attachments.py` (kinds + entity type + auth), `api/src/serversherpa/api/schemas.py` (`ReportRunOut.initiative_id` optional, `initiative_name` optional), tests touched by these shapes.

- [ ] **Scripts.** `rebuild_champagne_template.py <generated.xlsx> <out.xlsx>`: load with openpyxl, delete any sheet whose lowercase title contains "transport", then write the §10 placeholders (spec "Fixtures and tooling" lists every cell; the exact strings are in the V2 guide §10 — e.g. C21 `{{origin.city}}, {{origin.state}}`, C22 (General Questions) `Origin: {{origin.survey.dock_hours}}  |  Destination: {{destination.survey.dock_hours}}`, A8..G8 `{{asset.index}} {{asset.rack}} {{asset.manufacturer}} {{asset.model}} {{asset.u_size}} {{asset.qty}} {{asset.comments}}`), clear stray cells E35/B40/C40, save. `rebuild_transportation_standards.py <generated.xlsx> <out.docx>`: read the "Transportation Standards" sheet top to bottom — headings are rows whose cell font is bold (or matching the known headings list), bullets are rows starting with `•` with leading-space indentation → list level, images from `ws._images` in row order (anchor row) — and write a minimal docx with the stdlib `zipfile` (document.xml with `w:p` runs using `Heading1`/`ListParagraph` styles + `w:numPr ilvl`, and `a:blip` image relationships, `[Content_Types].xml`, `_rels`, `word/_rels/document.xml.rels`, `word/media/*`). Keep it simple: the parser in Task 3 must round-trip it (headings, bullets with levels, images in order).
- [ ] **Migration 0052**: `ALTER TABLE report_runs ALTER COLUMN initiative_id DROP NOT NULL`; insert the system definition `('Site & Move Survey', 'site_move_survey', is_system=true, options {"company_name": "Cumulus Solutions Group", "include_transportation_standards": true, "include_site_photos": true, "condensed_assets": true})` ON CONFLICT DO NOTHING (match how 0046 seeded Move Report); downgrade deletes the definition and restores NOT NULL (only if no null rows — document that).
- [ ] **ReportResult**: `content: bytes`, `filename: str`, `content_type: str = "application/pdf"`; `@property pdf -> bytes` returning content. Move Report constructs `ReportResult(content=pdf, filename=…)`. Worker: key `reports/{run.initiative_id or 'standalone'}/{run_id}{ext}` (ext from filename), `put_object(key, result.content, result.content_type)`, attachment only when `run.initiative_id` is not None (content_type from the result), `run.size_bytes = len(result.content)`; `initiative_name = "—"` when null.
- [ ] **Attachments**: `Kind` += `survey_template`, `report_asset`; `EntityType`/`ENTITY_MODEL` += `report_definition` (model `ReportDefinition`); `_authorize`: `report_definition` → `reports` resource (`view` for view, `change` for add/delete); `survey_template` allowed only for `entity_type == "partner"` (422 `kind_not_allowed` otherwise); `report_asset` only for `report_definition`. Upload accepts `.xlsx` for `survey_template` and `.docx`/`.pdf` for `report_asset` (document size limit).
- [ ] Tests: fixture parity (the annotated template contains every placeholder from the spec list; the docx round-trips through a tiny parser stub — or just contains `word/document.xml` with ≥ 6 images); migration (null initiative allowed; definition seeded); attachments kind rules (partner survey_template ok, site survey_template 422, report_asset on a definition with reports:change ok, worker → 403); worker stores a non-PDF result with its content type (use a stub module registered in the test).
- [ ] Run: `tests/test_site_move_survey_fixtures.py tests/test_report_worker.py tests/test_attachments.py tests/test_reports_api.py tests/test_move_report_render.py`. Commit `feat(reports): non-PDF report results, optional initiative, survey_template/report_asset attachments, Champagne fixtures (migration 0052)`.

---

### Task 2: Fill engine + context (pure, no DB)

**Files:** Create `api/src/serversherpa/reports/site_move_survey/__init__.py` (report_type, options, `build` stub raising NotImplemented until Task 4), `fill.py`, `context.py`, `assets.py`; Tests `api/tests/test_site_move_survey_fill.py`, `test_site_move_survey_context.py`.

**Produces:**
```python
# fill.py
PLACEHOLDER_RE, WHOLE_CELL_RE
def resolve_path(context: dict, path: str)            # '' for missing / None
def substitute(value, context)                          # whole-cell raw, mixed → str
def fill_workbook(wb, context: dict, assets: list[dict], asset_notes: str | None, *, include_transportation_standards: bool) -> None
def expand_asset_rows(ws, row_idx: int, context, assets, asset_notes) -> None
# assets.py
def asset_rows(rows: list[MoveAsset-like], *, condensed: bool) -> list[dict]   # V2 field set
# context.py
@dataclass SiteCtxInput(site: Site | None, survey: dict[str, object])  # survey = registry key → value
def site_context(site, survey) -> dict                  # V3 keys + V2 aliases, yes/no rendering
def build_context(*, partner, company_name, contact: Person | None, client_address: str, initiative: Initiative | None, origin, destination, origin_survey, destination_survey, assets_notes: str) -> dict
```
- [ ] Port `_substitute/_resolve_path/_fill_workbook/_expand_asset_rows` from the V2 module (behavior identical; comments explaining each rule). `site_context` per the spec's mapping table (V3 site columns `address_line1/2, city, region, postal_code, country`; survey values: bool → "yes"/"no", None → "", int → int). Move context from `Initiative` (`scheduled_start` as `%Y-%m-%d %I:%M %p` etc.; `asset_count` = len(assets)).
- [ ] Tests: build an in-memory workbook with the Champagne layout (or load the Task 1 fixture) and assert every documented rule: whole-cell raw int stays int; mixed text keeps literals (`", "` when both empty); merged cells skipped; template row detection; N asset rows written with copied style; trailing rows cleared until the first empty row; zero assets + notes → notes land in the last placeholder column; transport sheet removed when toggle off; condensed vs per-asset rows; context aliases and yes/no.
- [ ] Run the two test files; commit `feat(reports): site & move survey fill engine and context`.

---

### Task 3: Optional sheets (standards + photos) and gather

**Files:** Create `reports/site_move_survey/standards.py`, `photos.py`, `gather.py`; Tests `test_site_move_survey_standards.py`, `test_site_move_survey_gather.py`.

- [ ] `standards.py`: `parse_standards_docx(docx_bytes) -> list[tuple[str, object]]` (port of V2 `_parse_standards_docx`, stdlib), `append_standards_sheet(wb, items)` (port of `_append_transportation_standards` body), per-process cache keyed by attachment id. `photos.py`: `append_site_photos(wb, entries: list[tuple[str, list[bytes]]])`.
- [ ] `gather.py`: `SurveyData` dataclass + `async def gather(db, run) -> SurveyData` per the spec (partner + logistics check, newest `survey_template` attachment bytes via `services.storage.get_object`, initiative (optional), origin/destination resolution (run options override initiative sites), assets via the move report's gather rows for the initiative (reuse `reports/move_report/gather.py` helpers where the shapes fit), contact person, survey answers per site (`SiteSurveyEntry` rows keyed by field), site photos (attachments `kind='photo'`, `entity_type='site'`, newest first, ≤10, bytes via storage), standards docx = newest `report_asset` on the definition whose filename ends `.docx` (bytes) or None.
- [ ] Tests: parser round-trips the reconstructed fixture docx (headings/bullets/images counts); append sheet writes rows and images; gather over a seeded DB (partner with template attachment — put bytes with the storage service's test mode, check how other tests stub storage: grep `put_object` in tests), errors for non-logistics partner / missing template; site override behavior; photos limited to 10.
- [ ] Commit `feat(reports): survey standards/photos sheets and gather`.

---

### Task 4: `build()`, routes, definition option, registry

**Files:** Modify `reports/site_move_survey/__init__.py` (`build`), `reports/registry.py` (register), `api/routes/reports.py` (`GET /reports/site-move-survey/partners` → `[{id, name, has_template}]` for logistics partners, gated `reports:view`; run creation accepts null `initiative_id` when the definition's report type is `site_move_survey`; `validate_options` per-type incl. run-level keys), `api/schemas.py` (`ReportRunCreateIn.initiative_id` optional; `ReportDefinitionPatchIn.options` accepts strings for `company_name`), `api/routes/attachments.py` no change; Tests `test_site_move_survey_build.py`, extend `test_reports_api.py`.

- [ ] `build`: gather → `build_context` → `load_workbook(template)` (`template_unreadable` on failure) → `fill_workbook` → standards sheet (when option on, docx present, no transport sheet) → photos (when option on) → bytes; filename per spec; `ReportResult(content, filename, content_type=XLSX_MIME)`.
- [ ] End-to-end test: seed partner (logistics) + Champagne fixture template attachment + initiative with two assets + sites with survey answers + a contact; run build; open the result with openpyxl and assert cells: C11 company option, C12 contact, C18/C28 site names, C21 "City, ST", General Questions D21 yes/no from survey, C22 dock hours line, Equipment Listing rows 8–9 per asset (and condensed mode: one row with qty 2), Transportation Standards sheet present when the docx asset exists, Site Photos sheet when a photo exists. Run without initiative (partner + sites) works and produces no asset rows. Missing template → run error `no_survey_template`.
- [ ] Commit `feat(reports): Site & Move Survey build + partners endpoint + definition option`.

---

### Task 5: Portal — generate options, partner template upload, definition Files/company field, history

**Files:** Create `portal/src/components/reports/SiteMoveSurveyOptions.tsx` (+ test), `portal/src/components/reports/CompleteSiteSurveyModal.tsx` (+ test), `portal/src/lib/siteMoveSurvey.ts` (+ test: condensed grouping, missing-required-fields, option payload); Modify `portal/src/lib/api.ts` (`listSurveyPartners`, run create with optional initiative + options, definition options typing, attachment upload kinds), `portal/src/components/reports/GenerateReportModal.tsx` (delegate the options step by `definition.report_type`; initiative step allows "No initiative" for this type), `portal/src/components/reports/EditDefinitionModal.tsx` (company field + Files section for `report_asset`), `portal/src/components/NotesFilesPanel.tsx` (partner: upload type choice "Document" / "Survey template" via `.segmented`; list shows a `chip` "Survey template"), `portal/src/components/reports/HistoryTab.tsx` ("—" initiative), `portal/src/pages/Reports.tsx` if the Generate flow needs the type.

- [ ] Build exactly the spec's "Portal" section (steps 1–7, idioms, copy). Survey field rendering by kind in the completion modal uses `GET /sites/survey-schema` and saves via `PUT /sites/{id}/survey/{field_key}` `{value}` for each answered field, then queues the run.
- [ ] Tests per the spec's Testing list. Run `npx vitest run src/components/reports src/lib/siteMoveSurvey.test.ts src/components/NotesFilesPanel.test.tsx src/styles/listTypography.test.ts && npx tsc --noEmit -p .`. Commit `feat(portal): Site & Move Survey generate flow, partner survey templates, definition files`.

---

### Task 6: Verification (controller-led)

- [ ] Full API + portal suites; `alembic upgrade head` on the dev DB.
- [ ] Live: upload `champagne_annotated_template.xlsx` as a survey template on a logistics partner, upload `transportation_standards.docx` on the definition, generate for the demo initiative (and once with no initiative), download and open the xlsx; check history/inbox; then fast-forward `main`, push.
