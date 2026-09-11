# Survey templates — portal half (report definition Files)

Design change: the Site & Move Survey's xlsx template moved off partners and
onto the report definition, as an attachment of kind `survey_template`
(entity_type `report_definition`), alongside the existing `report_asset`
docx (Transportation Standards). Several templates may exist on a
definition; the newest is the one a run fills. Partners are still chosen
per run but no longer carry a template.

## Changes

- `portal/src/lib/api.ts`
  - `SurveyPartnerOption` dropped `has_template` — now just `{ id, name }`.
  - Comments on `uploadAttachmentRequest` and `SurveyPartnerOption` updated
    to say `survey_template` belongs to `report_definition`, not partners.
  - Upload kinds themselves (`avatar | photo | document | survey_template |
    report_asset`) are unchanged — only which entity type may use
    `survey_template` changed (API-side 422 enforces it; portal just no
    longer offers the choice on partners).

- `portal/src/components/reports/EditDefinitionModal.tsx`
  - Files section now lists every definition attachment (both kinds), each
    row showing a `chip tag` kind label ("Survey template" / "Document").
  - Upload control gained a `.segmented` choice — "Survey template" (accept
    `.xlsx`, kind `survey_template`, default-selected) / "Document" (accept
    `.docx,.pdf`, kind `report_asset`).
  - Empty state and a `page-hint` below the list ("The newest survey
    template is the one a run fills.") added per spec.
  - Header comment updated.

- `portal/src/components/reports/SiteMoveSurveyOptions.tsx`
  - Removed the per-partner Template/No template chip and all
    `has_template` use.
  - Added `hasTemplate` state, computed from the report definition's
    attachments (already fetched for `hasStandardsDoc`):
    `files.some(f => f.kind === 'survey_template')`.
  - When `!hasTemplate`, a `pf-notice` shows at the top of the Options body:
    "This report has no survey template yet. Upload an .xlsx template
    under Edit report › Files." and `canGenerate` now also requires
    `hasTemplate`.
  - Removed the now-unused `selectedPartner` local.

- `portal/src/components/NotesFilesPanel.tsx`
  - Removed the partner-only Document/Survey template `.segmented`
    upload-type choice, the `uploadKind` state, the `isPartner` local, and
    the `.xlsx` accept switch. Partners upload document/photo like every
    other host now (kind decided purely by `file.type`).
  - `kindLabel`/`KIND_LABEL` untouched — `survey_template` still renders as
    "Survey template" so old rows don't crash or show a raw enum value.

## Tests updated

- `EditDefinitionModal.test.tsx`: added `templateFile()` fixture; replaced
  the single "lists + uploads" test with three — lists both kinds with the
  correct chip, uploads as `survey_template` with the segmented default,
  uploads as `report_asset` after switching the segment to Document.
  Existing Download/Delete/company-field tests untouched and still green.
- `SiteMoveSurveyOptions.test.tsx`: `PARTNERS` fixture dropped
  `has_template`; `beforeEach` now defaults `listAttachments` to include a
  `TEMPLATE_FILE` (`kind: 'survey_template'`) so Generate stays reachable
  in the existing scenario tests; replaced the old Template-chip test with
  two — notice shown + Generate disabled with no template attachment,  no
  notice + Generate enabled with one. Partner-auto-select assertions that
  used to key off the removed chip now use
  `screen.findByDisplayValue('Acme Logistics')` against the ComboBox input.
- `GenerateReportModal.survey.test.tsx`: dropped `has_template` from its
  inline partner fixture; `listAttachments` now defaults to
  `[TEMPLATE_FILE]` so the Escape/nested-modal flow can still reach
  Generate.
- `NotesFilesPanel.test.tsx`: replaced the four 2026-09-11 survey-template
  tests with one — a partner upload sends `document` (or `photo` for an
  image) and no `tablist` renders. The three original tests (collapsed
  default, thumbnail/lightbox split, lightbox open/close) are untouched.

## Verification

Foreground run (single command, as instructed):

```
npx vitest run src/components/reports src/components/NotesFilesPanel.test.tsx \
  src/lib/siteMoveSurvey.test.ts src/styles/listTypography.test.ts && npx tsc --noEmit -p .
```

Result: 9 test files / 57 tests passed; `tsc --noEmit` clean (exit 0).

## Deviations / notes

- Spec's empty-state copy and the "newest template" `page-hint` are both
  implemented; the hint renders unconditionally below the list (not only
  when files exist) since the spec just said "below the list."
- No new listTypography allowlist entries were needed — only pre-existing
  house classes (`chip tag`, `.segmented`/`role=tablist`, `pf-notice`,
  `page-hint`, `mini-list`/`nf-*`) were reused.
- Grepped `has_template`/`survey_template` across `portal/src` after the
  change — no stray references remain outside the files above (and their
  tests); HistoryTab/Reports needed no change, as expected.
