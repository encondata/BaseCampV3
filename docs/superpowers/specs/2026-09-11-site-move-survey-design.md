# Site & Move Survey report — V3 port of V2's `/reports/site-move-survey`

**Date:** 2026-09-11 · **Status:** approved in conversation · **Branch:** `site-move-survey`

Decisions from Jimmy: standards document attached to the report
definition; `customer.company` is an editable definition option (default
"Cumulus Solutions Group"); contact picker keeps V2 behavior (any user
account); a generated Champagne survey was supplied and is reversed into the
annotated test template. American English throughout.

## Purpose

V2 fills a logistics partner's annotated xlsx questionnaire with a move's
sites, contacts, survey answers, and equipment list, appends the company's
Transportation Standards and the sites' photos, and saves a copy on the
initiative. V3 gets the same capability inside the reports framework
(definitions, queued runs, history, inbox notification, Files attachment)
with the portal's UI idioms. Every V2 behavior in §"V2 inventory" of the
conversation is preserved unless listed under "Deliberate differences".

## Framework changes

1. `ReportResult` becomes `{ content: bytes, filename: str, content_type: str }`
   (`pdf` kept as a read-only alias for the move report's callers/tests).
   The worker stores `content` with `content_type`, and the storage key uses
   the filename's extension.
2. `report_runs.initiative_id` becomes nullable (migration 0052) — a survey
   may be generated for a partner + manually chosen sites with no
   initiative. When null: no initiative attachment is created, the run
   history shows "—" for the initiative, and the requester still gets the
   inbox notification + download.
3. Attachments: `Kind` gains `survey_template` and `report_asset`, both
   report-definition-only. Entity type `report_definition` is added to
   `ENTITY_MODEL`/`EntityType`, authorized through `reports:change` for
   add/delete and `reports:view` for view. Templates are company-owned,
   not partner-owned: the xlsx questionnaire template lives on the
   report definition alongside the Transportation Standards docx.
   Several `survey_template`s may exist on a definition (a later version
   may pick one per purpose, e.g. move vs e-waste pickup); for now the
   newest (`created_at` DESC, `id` DESC) is the one a run fills. The
   report definition's Edit modal gets a **Files** section (list/upload/
   delete `survey_template`s and `report_asset`s) — that's where both
   the xlsx template and the Transportation Standards docx go. Migration
   0053 re-points any `survey_template` attachment still sitting on a
   partner (a pre-migration legacy row) onto the seeded "Site & Move
   Survey" definition.
4. Report definitions can carry per-report **option schemas** that aren't
   booleans: `site_move_survey` options are
   `{ company_name: str, include_transportation_standards: bool,
   include_site_photos: bool, condensed_assets: bool }` (definition-level
   defaults; the generate dialog can override the three booleans per run).
   `EditDefinitionModal` renders a text field for `company_name` when the
   report type is `site_move_survey`.

## Report module `reports/site_move_survey/`

- `report_type = "site_move_survey"`; system definition seeded "Site & Move
  Survey" (migration 0052 inserts it like Move Report was).
- `default_options()`, `validate_options()` (definition + run options —
  run options add `partner_id` (required), `contact_person_id?`,
  `source_site_id?`, `destination_site_id?`, `asset_notes?`; unknown keys
  rejected).
- `gather(db, run)`: partner (must have `logistics` in `partner_types`,
  else `partner_not_logistics`), the newest `survey_template` attachment
  on the report definition (`run.definition_id`; else
  `no_survey_template` — a legacy `survey_template` row still on a
  partner is never consulted), the initiative (any
  type; for moves: origin/destination = its `origin_site_id`/
  `destination_site_id`, overridable by run options; other types: sites only
  from options), the initiative's assets via the same rows the Move Report
  uses (`InitiativeAsset` + `Asset` + model), contact person, sites with
  their survey answers (`site_survey_data` joined through `sites/survey.py`'s
  registry), site photos (attachments kind `photo`, entity `site`, newest
  first, up to 10), the definition's newest `report_asset` whose filename
  ends in `.docx` (the standards doc; optional).
- `context.py`: builds the V2-compatible context:
  - `partner.{id,name}`; `customer`/`client`: `{company (option),
    contact_name, phone, email, address (origin site's client address —
    V3 clients have address columns; else ''), id}`;
  - `move.{id,name,scheduled_start,scheduled_start_date,
    scheduled_start_time,asset_count,survey:{}}` from the initiative
    (`scheduled_start` formatted `%Y-%m-%d %I:%M %p`); empty when no
    initiative;
  - `origin`/`destination`: `{id,name,address (address_line1),address_full
    (line1, line2, city, region, postal, country joined), city, state
    (region), zip (postal_code), country, client_id, contact_name/phone/
    email (from survey answers), survey:{…}}` where `survey` holds every
    V3 registry key AND the V2 aliases (`site_contact_name`→`contact_name`,
    `dock_75ft_accessible`→`trailer_75ft_accessible`,
    `ground_level_details`→`entrance_details`); booleans render `yes`/`no`,
    `None` renders ''.
  - `assets_notes`/`asset_notes`: the run's notes when there are zero
    assets, else ''.
- `assets.py`: per-asset rows and condensed (make, model) groups exactly as
  V2 (`index, manufacturer/make, model, u_size/ru_size, weight, qty, rack,
  comments, asset_id (V3 `legacy_id` a.k.a. Asset ID), serial_number, name,
  rfid_tag, location`); `rack` = source rack + RU in per-asset mode.
- `fill.py`: the openpyxl engine ported verbatim in behavior — placeholder
  regexes, whole-cell raw values, merged-cell skipping, template-row
  detection by `{{asset.`, style copy, trailing-row clearing, zero-asset
  notes into the last placeholder column, transport-sheet removal when the
  toggle is off. Pure functions over an openpyxl workbook; unit-tested with
  an in-memory workbook.
- `standards.py`: `parse_standards_docx(bytes)` (stdlib zip/XML, port of
  V2) and `append_standards_sheet(wb, items)`; cached per process by the
  attachment id. Skipped when no docx asset or the template has a
  "transport" sheet.
- `photos.py`: `append_site_photos(wb, entries)` (PIL thumbnails, port).
- `build(db, run)`: gather → context → fill → optional sheets → bytes;
  filename `Site & Move Survey - {partner} - {YYYY-MM-DD HHMM}.xlsx`,
  content type xlsx. Errors raise `OptionsError`-style problems mapped to
  run `error` strings: `no_survey_template`, `partner_not_logistics`,
  `template_unreadable`.

## Portal

- `/reports` Available tab lists the new definition; **Generate** opens
  `GenerateReportModal`, which now delegates the options step to a
  per-report component: `SiteMoveSurveyOptions` for this type (Move Report
  keeps its sections step).
- `SiteMoveSurveyOptions` (all portal idioms):
  1. **Initiative** — the existing picker step (optional for this report:
     a "No initiative — choose sites manually" choice).
  2. **Partner** — `ComboBox` of logistics partners from
     `GET /reports/site-move-survey/partners` (id, name — no per-partner
     template flag, since the template is company-owned). Auto-selects
     the initiative's shipping partner when it is logistics. When the
     report definition itself has no `survey_template` attachment, a
     "no template on this report" notice replaces the old per-partner
     "Template"/"No template" chip and **Generate** stays disabled.
  3. **Company contact** — `ComboBox` of user accounts (`listUsers`),
     default = the signed-in person; shows email/phone under it.
  4. **Sites** — two cards Source / Destination: auto-detected from a move
     (with "Auto-detected" tag) or a `ComboBox` of sites; either may be
     overridden.
  5. **Assets** — mini list preview from the initiative's assets with a
     `.segmented` "Condensed by make/model / Per asset" toggle; when zero
     assets, a textarea "Asset notes" (copy from V2).
  6. **Options** — Switches: Include Transportation Standards (disabled
     with hint when the definition has no docx asset), Include site photos;
     Notify me.
  7. **Generate** enabled when partner is chosen and (initiative or a
     source site) exists. Before queuing, if the source site has missing
     required survey answers, a **Complete source site survey** modal lists
     them (fields rendered by kind: bool → Yes/No segmented, int → number,
     text/textarea, select → ComboBox), saves each via
     `PUT /sites/{id}/survey/{key}`, then queues the run.
- History tab: rows with a null initiative show "—"; download works for
  xlsx (presigned with the filename).
- Report definition Edit modal: `company_name` field + **Files** section
  offering both "Survey template" (xlsx only) and "Report asset" (the
  standards docx/pdf) upload types; several templates may be attached,
  the newest is what a run fills; delete allowed with `reports:change`.
  The partner's own Files panel no longer offers a "Survey template"
  upload type — templates are company-owned, not per partner.

## Fixtures and tooling

- `api/tests/fixtures/champagne_annotated_template.xlsx`: reconstructed
  from the generated survey Jimmy supplied by writing the §10 placeholders
  back into their cells (C11–C15, C18–C25, C28–C35 on sheet 1; D3, D4,
  D19/E19, C20, D21/E21, C22, D23/E23, D24/E24, C25, D26/E26, D27/E27,
  D28/E28, D29/E29 on General Questions; A8–G8 asset row on Equipment
  Listing) and dropping the appended Transportation Standards sheet.
  Built by `api/scripts/rebuild_champagne_template.py <generated.xlsx>` so
  it can be re-derived, and usable as the real template to upload on the
  "Site & Move Survey" report definition.
- `api/tests/fixtures/transportation_standards.docx`: reconstructed from the
  generated survey's Transportation Standards sheet (text hierarchy +
  the 6 embedded images) by `api/scripts/rebuild_transportation_standards.py`,
  so the lost source document exists again and can be uploaded on the
  definition.

## Testing

- API: fill engine unit tests (placeholder resolution incl. whole-cell raw
  types, mixed text, merged cells, asset row expansion in both modes with
  style copy and trailing clear, zero-asset notes, transport sheet removal);
  context tests (V2 aliases, yes/no rendering, address parts, empty move);
  standards parser test on the reconstructed docx; end-to-end build test
  with the Champagne fixture producing a workbook whose cells match
  expected values; run-without-initiative test; partner endpoint test
  (no template flag); attachment kind/authorization tests (survey_template
  and report_asset both definition-only); worker stores xlsx with the
  right content type; migration tests (nullable initiative, seeded
  definition; migration 0053 re-points a legacy partner-scoped
  `survey_template` row onto the definition).
- Portal: options component tests (contact default, site auto-detect vs
  manual, condensed toggle, notes when empty, missing-survey modal saves
  then queues, "no template on this report" notice), Edit modal company
  field + Files (survey template + report asset upload types), history
  "—". Guardrail green.
- Live: upload the Champagne template and the reconstructed standards
  docx on the "Site & Move Survey" report definition's Files section,
  generate for the demo initiative, open the xlsx.

## Deliberate differences from V2

- Runs are queued through the worker (V2 streamed synchronously); the
  download comes from history/inbox like the Move Report.
- The saved copy on the initiative is the run's attachment (no second
  upload).
- Site photos come from V3 photo attachments; V2's `image_associations`
  ordering ("primary first") becomes newest first.
- `customer.company` is configurable per definition.
- The xlsx questionnaire template is company-owned, attached to the
  report definition rather than the partner (V2 kept it per partner).
  Multiple templates may be attached; the newest wins. Per-purpose
  template selection (e.g. move vs e-waste pickup) is deferred — a
  later version may let a run pick which template to fill.

## Out of scope

Editing template placeholders in the portal; conditional placeholders;
multiple repeating lists; per-move survey answers (`move.survey.*` stays
reserved/empty).
