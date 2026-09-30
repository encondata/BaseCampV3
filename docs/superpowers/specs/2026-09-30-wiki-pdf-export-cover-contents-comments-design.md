# Wiki PDF export: cover page, contents and comments — design

Status: approved by Jimmy 2026-09-30. Branch `wiki` (worktree `.claude/worktrees/wiki`).

## Goal

Make an exported PDF read like a controlled document: a standard cover page, a contents list,
the body, and a closing comments page. This changes **the export only**: nothing the wiki shows
on screen changes. Word export is removed.

## Formats

- **PDF**: gets the new structure (below).
- **Word (.docx) export is removed everywhere.** That covers:
  - the Export dialog's format choice;
  - `POST /wiki/exports` (a `docx` format, or `zip_format: "docx"`, is refused with a 422, the same way any unknown format is);
  - folder and library zips, which offer PDF or Markdown only;
  - the export code path (`convert.html_to_docx` and the export's docx branch), which goes too.

  Word **import** (.docx → page) is unchanged.
- **Markdown**: unchanged.

## PDF structure

1. **Cover page** — always page 1, with no page number in the footer. It shows:
   - The ServerSherpa logo (the bundled `serversherpa-logo.png`, copied into the API package so
     the worker needs nothing from the portal).
   - The page title, with its location underneath: library › folders.
   - **Revision N**, where N is the number of the page's versions with kind `published`. Every
     publish, including publishing a restored or approved version, adds exactly one; a
     `restored` version is only a draft snapshot and doesn't count. Next to it: "Published <Month D, YYYY>
     by <Name>" from the version currently published. If the publisher is unknown, it reads just
     "Published <date>".
   - "Exported <Month D, YYYY> by <Name>": the person who asked for the export.
   - The **confidentiality statement**, at the bottom of the cover. It's omitted if the effective
     statement is empty.
2. **Contents** — page 2, only when the published page has **at least two** headings of
   levels 1–3.
   - One line per heading, indented by level, with its PDF page number
     (`target-counter`). Each line links to the heading.
   - The PDF also gets an outline (bookmarks) built from the same headings.
3. **Body** — the page as it exports today, starting on a new page. The existing header block
   (breadcrumbs, title, published date) stays above the body.
4. **Comments** — a new page at the end, only when the page has at least one non-deleted
   comment.
   - Threads appear in the order their anchors occur in the published page. Page-level
     comments follow, oldest first.
   - Each comment shows the author, the date and time, and the text. Mentions render as
     "@Name", and replies are indented under their thread.
   - A resolved thread is labeled **Resolved** (with who resolved it and when, when known).
   - A comment on selected text shows that text as a quote above the thread when it can be
     found in the published page. If it can't be found, the quote is omitted, not guessed.

Page numbers ("n / total") stay in the footer of every page except the cover.

## Confidentiality statement

- **Standard statement**:
  - Stored in the system configuration as a new `wiki` section, key `confidentiality_statement`,
    with the default below (`system/config_store.DEFAULTS`). No migration is needed.
  - Wiki administrators edit it on the wiki's Admin page, in a new "Exports" section with a
    textarea and a Save button.
  - Default: "CONFIDENTIAL — This document contains proprietary information of Cumulus Solutions
    Group. It is intended solely for authorized recipients and may not be copied, distributed or
    disclosed without written permission."
- **Library override**:
  - A new library setting `confidentiality_statement` (string, default empty) in
    `wiki/space_settings.py`.
  - Library managers edit it in Library settings, under a "Confidentiality statement" textarea
    with the help text "Leave empty to use the standard statement."
  - A non-empty override replaces the standard statement for that library's exports.
- **Limits:** both are plain text, trimmed, and at most 1,000 characters. Line breaks are kept.

## Folder and library exports

A zip in PDF format gives every page PDF inside it the same cover, contents and comments. The
Private and Allow printing rules are unchanged: what the requester can't see or can't print is
left out as today. A page's comments go with the page.

## Architecture

- **`wiki/export_html.py`**:
  - `page_document` gains the cover, contents and comments sections.
  - Headings in the rendered fragment get stable ids, so the contents can link to them.
  - `PRINT_CSS` gains named pages: `@page cover` has no footer, and each section starts on a
    new page. It also gains `bookmark-level` for the outline.
  - All the new sections are plain HTML and CSS, rendered by the existing WeasyPrint step.
- **`wiki/export.py`**:
  - `_gather` reads what the new sections need, inside the existing "all DB reads first" phase:
    - the revision count and the current publisher;
    - the requester's name;
    - the effective statement;
    - the page's comments with author names.
  - The docx branch is removed.
- **A new focused module**, `wiki/export_sections.py`, builds the cover, contents and comments
  HTML from plain data. It's easy to unit-test without the database or WeasyPrint.
- **SPA**:
  - The Export dialog drops Word.
  - The Admin page gets the "Exports" section.
  - Library settings get the override field.
  - The README export section is updated.

## Testing

- **`export_sections`**:
  - Cover fields.
  - Revision wording.
  - An empty statement is omitted.
  - Contents appear only with at least two headings, with the right indentation and links.
  - Comments ordering, replies, the Resolved label, the quote found or omitted, and deleted
    comments left out.
- **Revision count**: `published` versions only (autosave, restored, imported and submitted
  versions don't count).
- **Statement resolution**: standard, library override, and an empty override falling back.
- **A real PDF rendered in the test**:
  - Page 1 contains the title and the statement.
  - Page 2 is the contents when there are headings.
  - The last page is the comments page.
  - The outline has the headings.
  - Page count checks: no contents page with fewer than two headings; no comments page without
    comments.
- **Word export is gone**:
  - The API refuses `docx` and `zip_format: "docx"` (422).
  - The dialog no longer offers Word.
- **Settings**:
  - The admin statement save and read, gated to wiki administrators.
  - The library override save, gated to library managers.
