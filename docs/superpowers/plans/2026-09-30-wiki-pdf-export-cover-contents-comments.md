# Wiki PDF export: cover, contents and comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every exported wiki PDF gets a cover page, a contents page and a closing comments page, and Word export is removed. Nothing the wiki shows on screen changes.

**Architecture:**
- **Built with the existing print path.** The new sections are plain HTML and CSS added to the page's print document (`wiki/export_html.page_document`), which the existing WeasyPrint step turns into the PDF.
- **Pure builders in their own module.** A new `wiki/export_sections.py` builds the cover, contents and comments HTML from plain dataclasses, so it can be unit-tested without the database or WeasyPrint.
- **Data read up front.** `wiki/export.py` reads the extra data (revision count, names, statement, comments) inside its existing "all DB reads first" `_gather` phase.
- **Where the confidentiality statement lives:**
  - The standard statement is in `system_config`, in a new `wiki` section. No migration is needed.
  - A library override is the new space setting `confidentiality_statement`.

**Tech Stack:** FastAPI + SQLAlchemy async (api/), WeasyPrint 70 (PDF), React + Vitest (wiki/web), pytest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-09-30-wiki-pdf-export-cover-contents-comments-design.md`. It's the source of truth for behavior and copy.
- **Export only:** nothing the wiki renders on screen changes. Only the export pipeline, the Export dialog, the wiki Admin page (new "Exports" section) and Library settings (new field) change in the SPA.
- **Formats:**
  - PDF gets cover, contents, body and comments.
  - Word (.docx) export is removed everywhere (API, zip `zip_format`, worker, dialog, README).
  - Markdown is unchanged.
  - Word **import** is unchanged.
- **Cover:**
  - The ServerSherpa logo, embedded as a data URI. WeasyPrint uses a data-only fetcher, so nothing may be fetched by URL.
  - The title.
  - The location: library › folders (the existing `crumbs`, with `…` for hidden ones).
  - "Revision N · Published <Month D, YYYY> by <Name>". If the publisher is unknown, drop " by <Name>".
  - "Exported <Month D, YYYY> by <Name>".
  - The statement at the bottom, omitted when empty.
  - The cover has no page number.
- **Revision N:** the count of the page's `WikiPageVersion` rows with `kind == "published"`.
- **Contents:**
  - Only when the page has **≥ 2** headings of levels 1–3.
  - Entries are indented by level. Each has a PDF page number via `target-counter` and links to its heading.
  - The PDF outline (bookmarks) holds levels 1–3 only.
- **Comments page:**
  - Only when at least one non-deleted comment exists.
  - Thread order: anchored threads whose `commentThread` mark is found in the published content come first, in document order. The rest (page-level and orphaned) follow, oldest first.
  - Replies are indented. Each comment shows the author, "<Month D, YYYY> at <h:mm AM/PM>" in the company time zone (`services.timezone.report_timezone()`), and the text.
  - Comment text keeps its literal "@Name" mentions and its line breaks.
  - A resolved thread shows **Resolved** plus "by <Name> on <date>" when known.
  - The quote is the marked text found in the published content. When it isn't found, there's no quote.
  - Deleted comments are left out. A thread with no remaining comments is left out.
- **Statement default** (verbatim): "CONFIDENTIAL — This document contains proprietary information of Cumulus Solutions Group. It is intended solely for authorized recipients and may not be copied, distributed or disclosed without written permission."
- **Statement rules:**
  - Plain text, trimmed, at most **1000** characters, line breaks kept.
  - A library's non-empty `confidentiality_statement` overrides the standard one; an empty one falls back to it.
- **Who edits what:**
  - The standard statement: wiki administrators only (`principal.is_admin`).
  - The library override: library managers, through the existing `PATCH /wiki/spaces/{key}` settings path.
- **UI copy:**
  - Admin section title: "Exports". Field label: "Confidentiality statement".
  - Library settings field: "Confidentiality statement". Help text: "Leave empty to use the standard statement."
  - The uiCopy guard forbids the word "space" in UI strings; use "library".
- **Test databases:** API tests run with `SS_TEST_DB=serversherpa_test_wiki_pdf` (their own DB). Never write to the dev DB (localhost:5433/serversherpa), and never sign in anywhere.
- **Suites that must stay green:**
  - `cd api && SS_TEST_DB=serversherpa_test_wiki_pdf PYTHONPATH=src .venv/bin/python -m pytest tests/test_wiki_*.py -q -p no:cacheprovider`
  - `cd wiki && npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json`
- **Style:** American English. Match the surrounding comment density and naming. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `api/src/serversherpa/_dev_reload.py`.

---

### Task 1: Remove Word export

**Files:**
- Modify: `api/src/serversherpa/wiki/export.py`
  - `FORMATS`, `PAGE_FORMATS`, `EXTENSIONS` and `CONTENT_TYPES` drop `docx`.
  - Delete `_docx_all`, plus the docx branches in `_single` and `_zip`.
  - Update the module docstring.
- Modify: `api/src/serversherpa/api/routes/wiki/schemas.py`. The export request's `format` / `zip_format` types drop `"docx"`.
- Modify: `api/src/serversherpa/api/routes/wiki/exports.py`. Update the docstring or messages that mention Word.
- Modify: `api/src/serversherpa/wiki/convert.py`.
  - Delete `html_to_docx` and the constants only it uses (`DOCX_BATCH`, `DOCX_BASE_TIMEOUT`, `DOCX_PER_FILE_TIMEOUT`, if nothing else uses them; grep first).
  - Keep `office_to_pdf`.
- Modify: `api/src/serversherpa/config.py`, only if it holds docx-export-only settings (grep `docx`).
- Modify: `wiki/web/src/components/ExportDialog.tsx`. `FORMATS` becomes PDF and Markdown, and the header comment says "a PDF or Markdown".
- Modify: `wiki/web/src/lib/types.ts`: `ExportPageFormat = 'pdf' | 'md'`.
- Modify: `wiki/README.md`. The export section no longer mentions Word or .docx export. Word import text stays.
- Test:
  - `api/tests/test_wiki_export_api.py`
  - `api/tests/test_wiki_export_worker.py`
  - the `convert` tests (grep `html_to_docx` in `api/tests`)
  - `wiki/web/src/components/ExportDialog.test.tsx`

**Interfaces:**
- Produces: `export.PAGE_FORMATS == ("pdf", "md")`. `export.FORMATS` has no `"docx"`.

- [ ] **Step 1: Write the failing tests.**
  - **API:** `POST /wiki/exports` with `{"node_id": <published page>, "format": "docx"}` gets 422. With `{"space_id": …, "format": "zip", "zip_format": "docx"}` it also gets 422. Pydantic's validation 422 is fine; assert only the status.
  - **Worker:** a payload with `format: "docx"` fails with `ExportError`.
  - **SPA:** the Export dialog's format choices are exactly "PDF" and "Markdown", with no "Word".
- [ ] **Step 2: Run them to see them fail.**
  - `cd api && SS_TEST_DB=serversherpa_test_wiki_pdf PYTHONPATH=src .venv/bin/python -m pytest tests/test_wiki_export_api.py tests/test_wiki_export_worker.py -q -p no:cacheprovider`
  - `cd wiki && npx vitest run web/src/components/ExportDialog.test.tsx`
- [ ] **Step 3: Implement.**
  - Remove the docx paths listed above.
  - Delete or rewrite existing tests that exported to Word. Rewrite a test to PDF when it was really testing zip layout; delete it when it only tested docx conversion.
  - `grep -rn "docx" api/src/serversherpa/wiki api/src/serversherpa/api/routes/wiki wiki/web/src/components/ExportDialog* wiki/web/src/lib/types.ts` must show only import-related uses afterwards.
- [ ] **Step 4: Run the wiki suites** from Global Constraints. Expected: pass.
- [ ] **Step 5: Commit** with the message `feat(wiki): remove Word export (PDF and Markdown remain; Word import unchanged)`.

---

### Task 2: The confidentiality statement settings

**Files:**
- Modify: `api/src/serversherpa/system/config_store.py`. `DEFAULTS["wiki"] = {"confidentiality_statement": DEFAULT_CONFIDENTIALITY_STATEMENT}`.
- Create: `api/src/serversherpa/wiki/statement.py` with the code below.
- Modify: `api/src/serversherpa/wiki/space_settings.py`.
  - `ALLOWED["confidentiality_statement"] = str`, `DEFAULTS["confidentiality_statement"] = ""`.
  - `validate` also rejects a string whose `.strip()` is longer than `MAX_STATEMENT_LENGTH`.
  - A new `normalize(key, value)` returns `value.strip()` for `confidentiality_statement` and `value` otherwise. The PATCH route stores `normalize(...)`.
- Modify: `api/src/serversherpa/api/routes/wiki/spaces.py`. Call `space_settings.normalize` before storing each validated setting.
- Create or modify: an admin route file for `GET` and `PUT /wiki/admin/export-settings`. Put it in `api/src/serversherpa/api/routes/wiki/exports.py` next to the export routes.
  - GET returns `{"confidentiality_statement": str}`.
  - PUT takes `{"confidentiality_statement": str}` (StrictStr, `extra="forbid"`). It trims the value; after trimming it must be ≤ 1000 characters, else 422 `bad_setting`.
  - PUT upserts `SystemConfig(section="wiki")`, following the `system.py` admin-config write pattern (`row.data`, `updated_at`, `updated_by`).
  - PUT writes an audit row, `entity_type="system"`, `entity_id="wiki"`, `action="wiki_config_update"`, with a from/to change.
  - Both routes return 403 `forbidden` unless `ctx.principal.is_admin`.
- Modify: `wiki/web/src/lib/spaceSettings.ts`. `SPACE_SETTING_DEFAULTS.confidentiality_statement = ''`. The spaceSettings test parses the Python `DEFAULTS`; extend its parser for a `""` string literal if it can't read one.
- Modify: `wiki/web/src/lib/wikiApi.ts`: `getExportSettings(): Promise<{ confidentiality_statement: string }>` and `saveExportSettings(statement: string): Promise<{ confidentiality_statement: string }>`.
- Modify: `wiki/web/src/pages/AdminPage.tsx`. A new `<section className="wiki-admin-section" aria-label="Exports">` with the title "Exports". It holds a labeled textarea "Confidentiality statement" (maxLength 1000), a Save button disabled until the text changes, a toast "Saved." on success, and the API error message on failure. Follow the existing sections' markup.
- Modify: `wiki/web/src/pages/SpaceSettings.tsx`. In the Sharing section (next to Allow printing), add a "Confidentiality statement" textarea with the help text "Leave empty to use the standard statement.", maxLength 1000, saved through the existing `useSettingSaver` on blur or with a Save button, whichever matches that page's text-field idiom.
- Test:
  - `api/tests/test_wiki_export_statement.py` (new)
  - `wiki/web/src/pages/AdminPage.test.tsx`
  - `wiki/web/src/pages/SpaceSettings.test.tsx`
  - `wiki/web/src/lib/spaceSettings.test.ts`

`api/src/serversherpa/wiki/statement.py`:

```python
"""The confidentiality statement on an exported PDF's cover (spec
2026-09-30 export cover): the wiki's standard statement (system_config
section `wiki`, edited by wiki administrators), unless the library sets
its own non-empty `confidentiality_statement`."""
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.system.config_store import read_section

SECTION = "wiki"
MAX_STATEMENT_LENGTH = 1000
DEFAULT_CONFIDENTIALITY_STATEMENT = (
    "CONFIDENTIAL — This document contains proprietary information of Cumulus "
    "Solutions Group. It is intended solely for authorized recipients and may not "
    "be copied, distributed or disclosed without written permission.")


async def standard_statement(db: AsyncSession) -> str:
    return str((await read_section(db, SECTION)).get("confidentiality_statement") or "").strip()


def effective_statement(standard: str, space_settings: dict | None) -> str:
    """The library's own statement when it set a non-empty one, else the
    standard one ("" when neither says anything)."""
    own = str((space_settings or {}).get("confidentiality_statement") or "").strip()
    return own or standard.strip()
```

`config_store.py` imports `DEFAULT_CONFIDENTIALITY_STATEMENT` from `serversherpa.wiki.statement`, unless that makes an import cycle. In that case, define the constant in `config_store.py` and import it into `statement.py` from there.

**Interfaces:**
- Produces:
  - `statement.standard_statement(db) -> str`
  - `statement.effective_statement(standard: str, space_settings: dict | None) -> str`
  - `statement.MAX_STATEMENT_LENGTH == 1000`
  - `statement.DEFAULT_CONFIDENTIALITY_STATEMENT`

- [ ] **Step 1: Write the failing tests.**
  - **API:**
    - With no `wiki` row, `standard_statement` returns the default verbatim.
    - `effective_statement("std", {"confidentiality_statement": "  own  "}) == "own"`.
    - `effective_statement("std", {"confidentiality_statement": "   "}) == "std"`, and `effective_statement("std", None) == "std"`.
    - `PUT /wiki/admin/export-settings` as a wiki admin trims and saves, GET returns it, and an audit row exists.
    - A non-admin gets 403 on both GET and PUT.
    - A 1001-character value gets 422 `bad_setting`.
    - An empty string is allowed (it means no statement).
    - `PATCH /wiki/spaces/{key}` with `{"settings": {"confidentiality_statement": " x "}}` stores `"x"`.
    - A 1001-character override gets 422 `bad_setting`, and a non-string gets 422 `bad_setting`.
  - **SPA:**
    - The Admin page shows the Exports section with the loaded statement. Editing and clicking Save calls `saveExportSettings` with the new text.
    - Library settings show the field with the help text, and saving calls the space PATCH with `confidentiality_statement`.
    - `SPACE_SETTING_DEFAULTS` matches the Python `DEFAULTS`.
- [ ] **Step 2: Run them to see them fail.**
  - `cd api && SS_TEST_DB=serversherpa_test_wiki_pdf PYTHONPATH=src .venv/bin/python -m pytest tests/test_wiki_export_statement.py -q -p no:cacheprovider`
  - `cd wiki && npx vitest run web/src/pages/AdminPage.test.tsx web/src/pages/SpaceSettings.test.tsx web/src/lib/spaceSettings.test.ts`
- [ ] **Step 3: Implement** as listed under Files.
- [ ] **Step 4: Run the wiki suites** from Global Constraints. Expected: pass.
- [ ] **Step 5: Commit** with the message `feat(wiki): confidentiality statement for exports — wiki-wide standard text and a library override`.

---

### Task 3: The section builders (`export_sections.py`) and print CSS

**Files:**
- Create: `api/src/serversherpa/wiki/assets/serversherpa-logo.png`, copied from `portal/public/images/serversherpa-logo.png` (`cp`). Make sure the API package ships it: check `api/pyproject.toml` package-data or the Dockerfile's COPY of `src/` so non-.py files are included, and add the png pattern if needed.
- Create: `api/src/serversherpa/wiki/export_sections.py`, with the code below.
- Modify: `api/src/serversherpa/wiki/export_html.py`. Add the CSS below to `PRINT_CSS`.
- Test: `api/tests/test_wiki_export_sections.py` (new; pure, no DB).

`api/src/serversherpa/wiki/export_sections.py`:

```python
"""The parts of an exported PDF around the page body (spec 2026-09-30
export cover): the cover page, the contents page and the comments page,
as HTML for the print template (`export_html.page_document`). Pure: plain
data in, HTML out — the export gathers the data, WeasyPrint lays it out
(page numbers through `target-counter`, the outline from `bookmark-level`)."""
from __future__ import annotations

import base64
import html
import re
from dataclasses import dataclass, field
from datetime import datetime
from functools import cache
from pathlib import Path
from typing import Any

from serversherpa.wiki.content import COMMENT_MARK

LOGO_PATH = Path(__file__).parent / "assets" / "serversherpa-logo.png"
MIN_CONTENTS_HEADINGS = 2
_HEADING = re.compile(r"<h([1-3])(\s[^>]*)?>(.*?)</h\1>", re.S | re.I)
_TAG = re.compile(r"<[^>]+>")


@cache
def logo_data_uri() -> str:
    return "data:image/png;base64," + base64.b64encode(LOGO_PATH.read_bytes()).decode()


def day(at: datetime) -> str:
    return f"{at.strftime('%B')} {at.day}, {at.year}"


def day_time(at: datetime) -> str:
    hour = at.hour % 12 or 12
    return f"{day(at)} at {hour}:{at.minute:02d} {'AM' if at.hour < 12 else 'PM'}"


def _lines(text: str) -> str:
    """Plain text as HTML, line breaks kept."""
    return "<br>".join(html.escape(line) for line in text.split("\n"))


@dataclass(frozen=True)
class CoverInfo:
    title: str
    location: list[str]            # the library, then each folder ("…" when hidden)
    revision: int
    published_at: datetime | None
    published_by: str | None
    exported_at: datetime
    exported_by: str
    statement: str


def cover_html(info: CoverInfo) -> str:
    esc = html.escape
    published = ""
    if info.published_at is not None:
        published = f" · Published {day(info.published_at)}"
        if info.published_by:
            published += f" by {esc(info.published_by)}"
    location = " › ".join(esc(part) for part in info.location if part)
    parts = [
        '<section class="ss-cover">',
        f'<img class="ss-cover-logo" src="{logo_data_uri()}" alt="ServerSherpa">',
        '<div class="ss-cover-main">',
        f'<div class="ss-cover-title">{esc(info.title)}</div>',
        f'<div class="ss-cover-location">{location}</div>' if location else "",
        f'<div class="ss-cover-revision">Revision {info.revision}{published}</div>',
        f'<div class="ss-cover-exported">Exported {day(info.exported_at)} by '
        f'{esc(info.exported_by)}</div>',
        "</div>",
        f'<div class="ss-cover-statement">{_lines(info.statement)}</div>'
        if info.statement.strip() else "",
        "</section>",
    ]
    return "\n".join(p for p in parts if p)


@dataclass(frozen=True)
class Heading:
    level: int                     # 1–3
    text: str
    anchor: str                    # the id given to the heading in the body


def number_headings(fragment: str) -> tuple[str, list[Heading]]:
    """The rendered body with an id on every h1–h3 (`ss-h-1`, `ss-h-2`,
    …, replacing any id it had), and those headings in order."""
    found: list[Heading] = []

    def tag(match: re.Match) -> str:
        level, attrs, inner = int(match.group(1)), match.group(2) or "", match.group(3)
        anchor = f"ss-h-{len(found) + 1}"
        text = html.unescape(_TAG.sub("", inner)).strip()
        attrs = re.sub(r'\s+id="[^"]*"', "", attrs)
        found.append(Heading(level=level, text=text, anchor=anchor))
        return f'<h{level} id="{anchor}"{attrs}>{inner}</h{level}>'

    return _HEADING.sub(tag, fragment), found


def contents_html(headings: list[Heading]) -> str:
    """The contents page, or "" when there are fewer than two headings."""
    shown = [h for h in headings if h.text]
    if len(shown) < MIN_CONTENTS_HEADINGS:
        return ""
    rows = "\n".join(
        f'<li class="ss-toc-l{h.level}"><a href="#{h.anchor}">{html.escape(h.text)}</a></li>'
        for h in shown)
    return (f'<nav class="ss-contents"><div class="ss-section-title">Contents</div>\n'
            f'<ol class="ss-toc">\n{rows}\n</ol></nav>')


@dataclass(frozen=True)
class CommentLine:
    author: str
    at: datetime
    text: str


@dataclass(frozen=True)
class CommentThreadOut:
    quote: str | None
    resolved: bool
    resolved_by: str | None
    resolved_at: datetime | None
    comments: list[CommentLine] = field(default_factory=list)   # first, then replies


def anchor_quotes(doc: dict | None) -> dict[str, str]:
    """Each comment thread's marked text in `doc`, keyed by thread id,
    in the order the threads first appear (text runs of one thread are
    joined; separate blocks with a space)."""
    quotes: dict[str, list[str]] = {}
    stack: list[Any] = [doc or {}]
    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        if node.get("type") == "text" and isinstance(node.get("text"), str):
            for mark in node.get("marks") or []:
                if isinstance(mark, dict) and mark.get("type") == COMMENT_MARK:
                    thread = (mark.get("attrs") or {}).get("threadId")
                    if isinstance(thread, str) and thread:
                        quotes.setdefault(thread.lower(), []).append(node["text"])
        content = node.get("content")
        if isinstance(content, list):
            stack.extend(reversed(content))
    return {k: " ".join(" ".join(v).split()) for k, v in quotes.items()}


def comments_html(threads: list[CommentThreadOut]) -> str:
    """The comments page, or "" when no thread has a comment left."""
    shown = [t for t in threads if t.comments]
    if not shown:
        return ""
    esc = html.escape
    out = ['<section class="ss-comments"><div class="ss-section-title">Comments</div>']
    for t in shown:
        out.append('<div class="ss-thread">')
        if t.quote:
            out.append(f'<blockquote class="ss-quote">{esc(t.quote)}</blockquote>')
        if t.resolved:
            by = f" by {esc(t.resolved_by)}" if t.resolved_by else ""
            when = f" on {day(t.resolved_at)}" if t.resolved_at else ""
            out.append(f'<div class="ss-resolved">Resolved{by}{when}</div>')
        for i, c in enumerate(t.comments):
            cls = "ss-comment" if i == 0 else "ss-comment ss-reply"
            out.append(f'<div class="{cls}"><div class="ss-comment-meta"><b>{esc(c.author)}</b>'
                       f' · {day_time(c.at)}</div>'
                       f'<div class="ss-comment-text">{_lines(c.text)}</div></div>')
        out.append("</div>")
    out.append("</section>")
    return "\n".join(out)
```

CSS appended to `PRINT_CSS`:

```css
@page cover { @bottom-right { content: none; } }
.ss-cover { page: cover; page-break-after: always; height: 240mm; position: relative; }
.ss-cover-logo { height: 18mm; }
.ss-cover-main { margin-top: 60mm; }
.ss-cover-title { font-size: 28pt; line-height: 1.2; font-weight: 700; bookmark-level: none; }
.ss-cover-location { font-size: 11pt; color: #667085; margin-top: 3mm; }
.ss-cover-revision { font-size: 11pt; margin-top: 10mm; }
.ss-cover-exported { font-size: 9.5pt; color: #667085; margin-top: 1.5mm; }
.ss-cover-statement { position: absolute; bottom: 0; left: 0; right: 0; font-size: 8.5pt;
                      color: #475467; border-top: 1px solid #e4e8ee; padding-top: 3mm; }
.ss-section-title { font-size: 16pt; font-weight: 700; margin-bottom: 4mm; }
.ss-contents { page-break-after: always; }
.ss-toc { list-style: none; padding: 0; margin: 0; }
.ss-toc li { margin: 0 0 1.5mm; }
.ss-toc a { color: #1b2129; text-decoration: none; }
.ss-toc a::after { content: leader('.') target-counter(attr(href), page); }
.ss-toc-l2 { padding-left: 6mm; }
.ss-toc-l3 { padding-left: 12mm; }
.ss-comments { page-break-before: always; }
.ss-thread { border-top: 1px solid #e4e8ee; padding-top: 3mm; margin-top: 3mm;
             page-break-inside: avoid; }
.ss-quote { font-style: italic; }
.ss-resolved { font-size: 8.5pt; font-weight: 700; color: #16a34a; margin-bottom: 1mm; }
.ss-comment { margin-bottom: 2mm; }
.ss-reply { margin-left: 8mm; }
.ss-comment-meta { font-size: 8.5pt; color: #667085; }
h4, h5, h6 { bookmark-level: none; }
.ss-title { bookmark-level: none; }
```

**Interfaces:**
- Produces: `CoverInfo`, `cover_html`, `Heading`, `number_headings`, `contents_html`, `CommentLine`, `CommentThreadOut`, `anchor_quotes`, `comments_html`, `logo_data_uri`, `day`, `day_time`. Signatures are exactly as in the code above.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_wiki_export_sections.py`:
  - **`cover_html`:**
    - It contains the escaped title and "Revision 7 · Published September 30, 2026 by Ada Lovelace".
    - The location reads "Ops › Guides".
    - "Exported October 1, 2026 by Grace Hopper".
    - The statement keeps its line breaks.
    - `statement="  "` leaves out `ss-cover-statement`.
    - `published_by=None` leaves out " by".
    - The logo `src` starts with `data:image/png;base64,`.
  - **`number_headings`:**
    - `'<h2 id="x" data-text-align="left">A &amp; B</h2><h4>no</h4><h3>C</h3>'` gives the ids `ss-h-1` and `ss-h-2`.
    - It keeps `data-text-align`, drops the old id, and returns `[Heading(2, "A & B", "ss-h-1"), Heading(3, "C", "ss-h-2")]`.
    - The h4 is untouched.
  - **`contents_html`:** "" for zero or one heading. For two, an `<ol>` with `href="#ss-h-1"`, the classes `ss-toc-l2` and `ss-toc-l3`, and escaped text.
  - **`anchor_quotes`:** a doc with one thread's mark split across two runs and two paragraphs joins them with a space. Threads come back in document order, and keys are lowercased.
  - **`comments_html`:**
    - "" for `[]`, and "" when every thread has an empty `comments` list.
    - A resolved thread shows "Resolved by Ada Lovelace on September 30, 2026".
    - A reply has class `ss-reply`.
    - The quote is escaped.
    - Text with "\n" becomes `<br>`.
    - `day_time` of 16:05 reads "4:05 PM", and of 00:30 reads "12:30 AM".
- [ ] **Step 2: Run them to see them fail.** `cd api && PYTHONPATH=src .venv/bin/python -m pytest tests/test_wiki_export_sections.py -q -p no:cacheprovider` fails with an import error.
- [ ] **Step 3: Implement.** Copy the logo, create the module, and append the CSS.
- [ ] **Step 4: Run it again.** Expected: pass.
- [ ] **Step 5: Commit** with the message `feat(wiki): export section builders — cover, contents and comments HTML, print CSS`.

---

### Task 4: Wire the sections into PDF export

**Files:**
- Modify: `api/src/serversherpa/wiki/export.py`.
  - `_Node` gains `revision: int = 0`, `published_by: str | None = None` and `threads: list[export_sections.CommentThreadOut] = field(default_factory=list)`.
  - `_Plan` gains `exported_by: str = ""`, `exported_at: datetime | None = None` and `statement: str = ""`.
  - In `_gather`, while every DB read is still done up front:
    - `plan.exported_by`: the requester's display name, read the same way the rest of the wiki names people (grep `display_name` / `person_ref`).
    - `plan.exported_at`: now, in `report_timezone()`.
    - `plan.statement`: `effective_statement(await standard_statement(db), space.settings)`, computed once per export. The export is one library.
    - For each exported page:
      - `revision`: one grouped query, `count(*)` of `WikiPageVersion` with `kind == "published"` per node.
      - `published_by`: the name of the `created_by` of the currently published version. Extend `_published` to also return `created_by`.
      - `threads`: one query for all the pages' non-deleted `WikiComment` rows, plus the author and resolver names, in one batched person lookup. Group by `thread_id`, and set `quote` from `export_sections.anchor_quotes(page.content)`, with the content still carrying its marks (read it before `strip_comment_marks`).
      - Ordering: anchored threads found in the quotes come first, in the quotes' order. Then the rest, oldest first by the first comment's `created_at`.
      - Comment times are converted to `report_timezone()`.
      - A thread's resolved state comes from its first comment (`resolved_at`, `resolved_by`), even when that first comment is deleted.
      - A deleted first comment is not listed, but its replies are.
      - The author name is "Unknown" when the person is gone.
  - `_page_html` is only used for PDF (a single page and every page PDF in a zip), so it becomes PDF-specific:
    - Run `export_sections.number_headings` on the finished body.
    - Build `cover_html` from the node and plan fields, plus `contents_html(headings)` and `comments_html(page.threads)`.
    - Pass them to `page_document`.
- Modify: `api/src/serversherpa/wiki/export_html.py`. `page_document(*, title, breadcrumbs, published_at, body, cover="", contents="", comments="")` emits the three extra blocks. `cover` and `contents` go before the existing `<header class="ss-head">`, and `comments` goes after `</main>`. The defaults keep old callers working.
- Test: `api/tests/test_wiki_export_worker.py` (extend) and `api/tests/test_wiki_export_pdf_sections.py` (new).

**Interfaces:**
- Consumes:
  - Task 3's builders.
  - Task 2's `standard_statement` and `effective_statement`.
  - `services.timezone.report_timezone()`.

- [ ] **Step 1: Write the failing tests.**
  - **Worker level.** Use the existing export worker test fixtures. They mock the render server, so follow how they stub `render_fragment` and `html_to_pdf`. Capture the HTML document passed to `html_to_pdf`, and assert:
    - It contains `ss-cover`, the page title, and "Revision 2". Publish the page twice in the fixture.
    - It contains the library's override statement when one is set, and the standard default otherwise.
    - It contains "Exported … by <requester name>".
    - `ss-contents` is present with two or more headings in the published content and absent with one.
    - `ss-comments` is present with the comments in order: an anchored thread (a mark in the content) before a page-level one.
    - A resolved thread shows "Resolved".
    - A deleted comment's text is absent.
    - `ss-comments` is absent when the page has no comments.
    - A Markdown export is byte-identical to before: no cover text.
  - **Real PDF** (`test_wiki_export_pdf_sections.py`, no DB):
    - Build a document with `page_document(..., cover=cover_html(...), contents=contents_html(h), comments=comments_html(t))`, where the body has three h2 headings.
    - Render it with `weasyprint.HTML(string=doc).render()`.
    - Assert there are at least four pages, and that `make_bookmark_tree()` holds the three headings' titles, not the cover title.
    - If `pdftotext` is on PATH (else `pytest.skip`), write the PDF and check: page 1 text contains the title and "CONFIDENTIAL"; page 2 contains "Contents" and the heading text; the last page contains "Comments".
    - A second case with one heading and no comments has exactly two pages (cover and body).
- [ ] **Step 2: Run them to see them fail.** `cd api && SS_TEST_DB=serversherpa_test_wiki_pdf PYTHONPATH=src .venv/bin/python -m pytest tests/test_wiki_export_worker.py tests/test_wiki_export_pdf_sections.py -q -p no:cacheprovider`
- [ ] **Step 3: Implement** as listed under Files.
- [ ] **Step 4: Update the README.** In `wiki/README.md`'s export section, describe the PDF's cover (logo, title, location, revision, published/exported lines, statement), contents, comments page, and where the statement is set. Use plain English and no code identifiers except endpoints.
- [ ] **Step 5: Run the full wiki suites** from Global Constraints. Expected: pass.
- [ ] **Step 6: Commit** with the message `feat(wiki): exported PDFs get a cover page, contents and a comments page`.
