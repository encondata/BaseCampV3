"""The parts of an exported PDF around the page body (spec 2026-09-30
export cover, Revision 2): the cover page, the revision history, the
contents page and the comments page, as HTML for the print template
(`export_html.page_document`), and the running footer as CSS. Pure: plain
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
_BR = re.compile(r"<br\s*/?>", re.I)
_ID_ATTR = re.compile(r"""\s+id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)""", re.I)


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
    return "<br>".join(html.escape(line) for line in text.splitlines())


@dataclass(frozen=True)
class CoverInfo:
    title: str
    doc_type: str | None           # "Operating Procedure", …, or None for none
    author: str | None             # the page's creator, None when unknown
    revision: int
    published_at: datetime | None
    published_by: str | None
    exported_at: datetime
    exported_by: str
    statement: str


# A title this long (three or more lines at 26pt), or a statement of more
# than this many lines (at about STATEMENT_LINE_CHARS a line), tightens
# the cover's spacing so it still fits on one page. The estimate only
# picks the spacing: the layout can't overlap either way (see cover_html).
COVER_COMPACT_TITLE_CHARS = 90
COVER_COMPACT_STATEMENT_LINES = 7
STATEMENT_LINE_CHARS = 140


def _statement_lines(statement: str) -> int:
    return sum(max(1, -(-len(line) // STATEMENT_LINE_CHARS))
               for line in statement.splitlines())


def _compact_cover(title: str, statement: str) -> bool:
    return (len(title) > COVER_COMPACT_TITLE_CHARS
            or _statement_lines(statement) > COVER_COMPACT_STATEMENT_LINES)


def cover_html(info: CoverInfo) -> str:
    """The cover (spec Revision 2): the branding block, the document type,
    the title between two rules, the revision / author / published lines,
    and — pinned to the bottom — the exported line and the statement. No
    breadcrumb, and no running footer (`@page cover`).

    The bottom block is a footnote (`float: footnote`): WeasyPrint pins it
    to the foot of the page and shrinks the room above it, so a long
    title and a long statement can never overlap — past a page, the rest
    of the cover moves on to the next one. It comes first in the markup:
    a footnote lands on the page of its call, and one called at the end
    of a full page would be pushed on to the next section's. (A page-high table, flex or
    grid column doesn't lay out on one page in WeasyPrint.)"""
    esc = html.escape
    published = ""
    if info.published_at is not None:
        published = f"Published {day(info.published_at)}"
        if info.published_by:
            published += f" by {esc(info.published_by)}"
    statement = info.statement.strip()
    compact = _compact_cover(info.title, statement)
    parts = [
        f'<section class="ss-cover{" ss-cover-compact" if compact else ""}">',
        # first, so the footnote claims the cover's own page before the rest;
        # in one piece (whitespace between its blocks would add blank lines)
        '<div class="ss-cover-foot">'
        f'<div class="ss-cover-exported">Exported {day(info.exported_at)} by '
        f'{esc(info.exported_by)}</div>'
        + (f'<div class="ss-cover-statement">{_lines(statement)}</div>' if statement else "")
        + "</div>",
        '<div class="ss-cover-brand">',
        f'<img class="ss-cover-logo" src="{logo_data_uri()}" alt="">',
        '<div class="ss-cover-name">ServerSherpa</div>',
        '<div class="ss-cover-product">A Cumulus Solutions Group product</div>',
        "</div>",
        '<div class="ss-cover-main">',
        f'<div class="ss-cover-type">{esc(info.doc_type)}</div>' if info.doc_type else "",
        '<hr class="ss-cover-rule">',
        f'<div class="ss-cover-title">{esc(info.title)}</div>',
        '<hr class="ss-cover-rule">',
        '<div class="ss-cover-meta">',
        f"<div>Revision {info.revision}</div>",
        f"<div>Author {esc(info.author)}</div>" if info.author else "",
        f"<div>{published}</div>" if published else "",
        "</div>",
        "</div>",
        "</section>",
    ]
    return "\n".join(p for p in parts if p)


@dataclass(frozen=True)
class RevisionRow:
    rev: int                       # the ordinal among the page's published versions
    at: datetime                   # in report_timezone()
    by: str                        # the publisher's name, or "Unknown"
    note: str                      # the publish note ("" for none)


def revision_history_html(rows: list[RevisionRow]) -> str:
    """The revision history page: one row per published version, newest
    first. The header row repeats on each page a long table runs onto
    (`thead` is a table-header-group). "" when there are no rows."""
    if not rows:
        return ""
    esc = html.escape
    body = "\n".join(
        f"<tr><td>{r.rev}</td><td>{day(r.at)}</td><td>{esc(r.by)}</td>"
        f"<td>{_lines(r.note.strip()) or '—'}</td></tr>"
        for r in sorted(rows, key=lambda r: r.rev, reverse=True))
    return ('<section class="ss-history"><div class="ss-section-title">Revision history</div>\n'
            '<table class="ss-revisions">\n<colgroup><col class="ss-rev-n"><col class="ss-rev-at">'
            '<col class="ss-rev-by"><col></colgroup>\n'
            "<thead><tr><th>Rev</th><th>Date</th><th>Updated by</th>"
            "<th>Description of changes</th></tr></thead>\n"
            f"<tbody>\n{body}\n</tbody>\n</table></section>")


FOOTER_TITLE_MAX = 70
_CSS_ESCAPE = {"\\": "\\\\", '"': '\\"'}


def _css_string(text: str) -> str:
    """`text` as the inside of a double-quoted CSS string: backslash and
    quote escaped, and control characters, `<`, `>` and `&` as hex escapes
    (so nothing in it can end the string, the rule or the <style>)."""
    out = []
    for ch in text:
        if ch in _CSS_ESCAPE:
            out.append(_CSS_ESCAPE[ch])
        elif ch in "<>&" or ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append(f"\\{ord(ch):x} ")
        else:
            out.append(ch)
    return "".join(out)


def footer_css(title: str, confidential: bool) -> str:
    """The running footer of every page but the cover, as `@page` margin
    boxes: "CONFIDENTIAL" on the left (only when `confidential` — the
    effective statement isn't empty), the title in the middle (cut to
    FOOTER_TITLE_MAX characters plus "…"), "Page n of N" on the right."""
    if len(title) > FOOTER_TITLE_MAX:
        title = title[:FOOTER_TITLE_MAX].rstrip() + "…"
    left = ('  @bottom-left { content: "CONFIDENTIAL"; font-weight: 700; '
            "color: #475467; }\n") if confidential else ""
    return ("\n@page {\n"
            + left
            + f'  @bottom-center {{ content: "{_css_string(title)}"; }}\n'
            '  @bottom-right { content: "Page " counter(page) " of " counter(pages); }\n'
            "}\n")


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
        text = " ".join(html.unescape(_TAG.sub("", _BR.sub(" ", inner))).split())
        attrs = _ID_ATTR.sub("", attrs)
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
    """Each comment thread's marked text in `doc`, keyed by thread id
    (lowercased), in the order the threads first appear. A thread's runs
    inside one block join as written (a bold word stays one word); runs
    in separate blocks are joined with a space."""
    quotes: dict[str, list[str]] = {}

    def walk(node: Any) -> None:
        if not isinstance(node, dict):
            return
        content = node.get("content")
        if not isinstance(content, list):
            return
        in_block: dict[str, list[str]] = {}
        for child in content:
            if isinstance(child, dict) and child.get("type") == "text" \
                    and isinstance(child.get("text"), str):
                for mark in child.get("marks") or []:
                    if isinstance(mark, dict) and mark.get("type") == COMMENT_MARK:
                        thread = (mark.get("attrs") or {}).get("threadId")
                        if isinstance(thread, str) and thread:
                            quotes.setdefault(thread.lower(), [])
                            in_block.setdefault(thread.lower(), []).append(child["text"])
            else:
                walk(child)
        for thread, runs in in_block.items():
            quotes[thread].append("".join(runs))

    walk(doc or {})
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
