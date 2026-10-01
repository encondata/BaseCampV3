# Wiki PDF export — cover redesign, revision history, footers, document type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement "Revision 2" of `docs/superpowers/specs/2026-09-30-wiki-pdf-export-cover-contents-comments-design.md`:
a centered branded cover, a revision-history table, a running confidentiality footer, and a
per-page Document type field.

**Architecture:**
- **API:** migration 0085 adds `wiki_pages.doc_type`, with an edit endpoint, a payload field and the
  SOP-template default.
- **SPA:** a "Document type…" dialog in the ⋯ menu.
- **Export:** `export_sections.py` gains the new cover, a revision-history builder and
  footer-string helpers. `export_html.page_document` gains the per-document footer CSS.
  `export.py` gathers doc_type, the author, and every published version's metadata inside
  `_gather`.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, WeasyPrint 70, React/Vitest.

## Global Constraints

- **Source of truth:** the spec's "Revision 2" section. Its copy, sizes, colors, order and rules are
  binding, and everything in the earlier sections not replaced there still holds.
- **Colors and sizes:** teal rule `#0f766e`, 0.75pt, 60% width. Logo 1.4in wide. "ServerSherpa"
  20pt bold. "A Cumulus Solutions Group product" 9.5pt muted. Title 26pt bold.
- **Document types (exact strings):** "Operating Procedure", "Work Instruction", "Guide", "Policy",
  "Reference", plus null for none. Error codes: 422 `bad_doc_type`, 422 `not_a_page`.
- **Footer, every page except the cover:**
  - Left: "CONFIDENTIAL", only when the effective statement isn't empty.
  - Center: the title, truncated to 70 characters plus "…".
  - Right: "Page n of N".
- **Revision history:**
  - Newest first. Columns: "Rev", "Date", "Updated by", "Description of changes".
  - An empty note shows "—". Rev is the ordinal among published versions.
  - The table header repeats on continuation pages.
- **Page order:** cover, revision history, contents (≥ 2 headings), header and body, comments (if
  any).
- **Escaping:** everything user-provided is HTML-escaped. The footer title goes into CSS, so it must
  be CSS-string-escaped: backslash, double quote, newlines and `<`.
- **Test DB:** `SS_TEST_DB=serversherpa_test_wiki_pdf` (Task 1),
  `SS_TEST_DB=serversherpa_test_wiki_pdf2` (Task 3). Never write to the dev DB, and never sign in.
- **Suites that must stay green:**
  - `cd api && SS_TEST_DB=<yours> PYTHONPATH=src .venv/bin/python -m pytest tests/test_wiki_*.py -q -p no:cacheprovider`
  - `cd wiki && npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json`
- **Style:** American English, and no "space" in UI strings. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `_dev_reload.py`. Stage
  explicit paths only.

---

### Task 1: API — document type

**Files:**
- Create: `api/migrations/versions/0085_wiki_page_doc_type.py`. It has `revision="0085"`,
  `down_revision="0084"`, adds `wiki_pages.doc_type TEXT NULL` on upgrade, and drops it on
  downgrade.
- Modify: `api/src/serversherpa/db/models.py`, adding `WikiPage.doc_type: Mapped[str | None]`.
- Create: `api/src/serversherpa/wiki/doc_types.py`, containing:
  - `DOC_TYPES = ("Operating Procedure", "Work Instruction", "Guide", "Policy", "Reference")`;
  - `TEMPLATE_DOC_TYPES = {"SOP": "Operating Procedure"}`.
- Modify: the node routes (`api/src/serversherpa/api/routes/wiki/nodes.py`), adding
  `PATCH /nodes/{node_id}/doc-type`:
  - The body is `DocTypeIn(doc_type: StrictStr | None, extra="forbid")`.
  - Order of checks: `require_node_level(..., "edit")` (404 or 403 as usual), then 422
    `not_a_page` unless `kind == "page"`, then 422 `bad_doc_type` unless the value is None or in
    `DOC_TYPES`.
  - Set `page.doc_type`.
  - On a real change, write an audit row (`entity_type="wiki_node"`, `action="doc_type"`, with a
    from/to change).
  - Return `NodeOut`.
- Modify: node creation from a template (`nodes.py`, ~line 102). When the template is built-in
  (`is_builtin`) and its name is in `TEMPLATE_DOC_TYPES`, set the new page's `doc_type`.
- Modify: `tree.copy_subtree`. A page's copy keeps `doc_type`.
- Modify: `schemas.py` and `serialize.py`, so the node payload's page object carries
  `doc_type: str | None`. Find where `published_version_id` is serialized and add it next to it.
- Modify: `wiki/web/src/lib/types.ts`, adding `doc_type: string | null` to the page payload type.
  Types only; the SPA dialog is Task 2.
- Test: `api/tests/test_wiki_doc_type.py` (new).

- [ ] **Step 1: Write failing tests:**
  - An editor sets and clears the type, and the payload reflects it.
  - A viewer gets 403, and someone who can't see the page gets 404.
  - A folder gets 422 `not_a_page`.
  - "Memo" gets 422 `bad_doc_type`.
  - An audit row is written on change and not on a no-op.
  - A page from the built-in SOP template has "Operating Procedure"; a page from another template
    has None.
  - A copied page keeps its type.
  - Alembic has a single head, `0085`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the wiki API suite.**
- [ ] **Step 5: Commit** with the message `feat(wiki): per-page document type (migration 0085) for the export cover`.

---

### Task 2: SPA — Document type dialog

**Files:**
- Modify: `wiki/web/src/lib/wikiApi.ts`, adding
  `setNodeDocType(nodeId: string, docType: string | null): Promise<NodeOut>`.
- Create: `wiki/web/src/components/DocTypeDialog.tsx` and its test.
  - Use the modal header pattern: eyebrow "Export", title "Document type", description "Shown on
    the cover of an exported PDF."
  - Offer the five types plus "None" as the wiki's existing tap-to-pick choice idiom. Use the
    segmented control or the ChoiceCard/radio list already in the wiki, whichever fits six options.
  - The current value is preselected.
  - Save calls `setNodeDocType`, refreshes the node the same way other node changes do, toasts
    "Saved.", and closes.
  - An error appears in the dialog's error spot.
- Modify: `wiki/web/src/components/RowMenu.tsx`, adding "Document type…" for pages when the caller
  can edit (`is_edit(my_level)`). Open the dialog through the shell, the same way Permissions… is
  opened.
- Modify: the shell's dialog plumbing (`WikiShell.tsx` and shellContext), mirroring
  `requestPermissions`.
- Test: `DocTypeDialog.test.tsx`, and the RowMenu tests.

- [ ] **Step 1: Write failing tests:**
  - The menu item shows for editors on pages only (not for viewers, folders or files).
  - The dialog preselects the current type.
  - Choosing "Policy" and saving calls `setNodeDocType('n1', 'Policy')`.
  - "None" sends null.
  - The error state works.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run vitest and both tsc checks.**
- [ ] **Step 5: Commit** with the message `feat(wiki): Document type dialog in the page menu`.

---

### Task 3: Export — new cover, revision history, running footer

**Files:**
- Modify: `api/src/serversherpa/wiki/export_sections.py`:
  - `CoverInfo` loses `location` and gains `doc_type: str | None` and `author: str | None`.
  - `cover_html` produces the Revision 2 cover.
  - New `RevisionRow(rev: int, at: datetime, by: str, note: str)`.
  - New `revision_history_html(rows: list[RevisionRow]) -> str`. The table uses `<thead>`, and
    `thead { display: table-header-group }` repeats the header row.
  - New `footer_css(title: str, confidential: bool) -> str`. It returns the `@page`
    margin-box rules with the title as an escaped CSS string, and "CONFIDENTIAL" only when
    `confidential`.
- Modify: `api/src/serversherpa/wiki/export_html.py`:
  - `PRINT_CSS`: the cover styles for Revision 2. The default `@page` bottom boxes are removed
    from `PRINT_CSS`; they come from `footer_css`. `@page cover` stays footer-less.
  - `page_document(..., revisions="", footer_css="")` emits `<style>{footer_css}</style>` and
    places `revisions` after the cover.
- Modify: `api/src/serversherpa/wiki/export.py`, in `_pdf_sections`:
  - Gather `doc_type` from `WikiPage`.
  - Gather `author` as the name of the node's `created_by`. `_Node` needs the node's
    `created_by`, taken from the rows.
  - Gather every published version (id, created_at, created_by, note) per page in ONE query,
    ordered by `created_at`, with ordinals computed in Python.
  - Keep revision = the count.
  - Batch all the names together.
  - `_page_html` passes the new pieces.
- Test: `api/tests/test_wiki_export_sections.py`, `test_wiki_export_worker.py` and
  `test_wiki_export_pdf_sections.py` (update and extend).

- [ ] **Step 1: Write failing tests:**
  - **Cover:** the ServerSherpa name and product line, the doc type in the HTML (omitted when None),
    "Author X" (omitted when None), no location or breadcrumb on the cover, and the exported line
    and statement at the bottom.
  - **Revision history:**
    - Rows are newest first, with the right ordinals, "—" for an empty note, escaped notes, and a
      `<thead>`.
    - With 40 rows, a real WeasyPrint render repeats the header on page 2 of the history.
  - **`footer_css`:**
    - A title with `"`, `\` and a newline is escaped.
    - "CONFIDENTIAL" only when `confidential` is set.
    - The title is truncated at 70 characters with "…".
  - **Real PDF (`pdftotext`):**
    - Page 1 has no "Page 1 of".
    - Page 2 has "Revision history" and ends with "Page 2 of N" and "CONFIDENTIAL".
    - The contents page follows.
    - An empty statement leaves no "CONFIDENTIAL" in the footers.
  - **Worker:** with two publishes that have notes, the history rows carry the notes and publisher
    names, and the doc type from the DB appears on the cover.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Render a sample PDF to the scratchpad as `sample-export-v2.pdf` and report the
  `pdftotext` of each page.
- [ ] **Step 5: Run the wiki API suite and commit** with the message `feat(wiki): export cover redesign, revision history and a confidential running footer`.
