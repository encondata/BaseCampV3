"""An exported PDF's cover, revision history, contents and comments,
laid out by real WeasyPrint (no database): which page each lands on, the
running footer, the page count with and without the optional sections,
and the outline (bookmarks)."""
from __future__ import annotations

import re
import shutil
import subprocess
from datetime import UTC, datetime

import pytest

from serversherpa.wiki.export_html import page_document
from serversherpa.wiki.export_sections import (
    CommentLine,
    CommentThreadOut,
    CoverInfo,
    RevisionRow,
    comments_html,
    contents_html,
    cover_html,
    footer_css,
    number_headings,
    revision_history_html,
)
from serversherpa.wiki.statement import DEFAULT_CONFIDENTIALITY_STATEMENT

weasyprint = pytest.importorskip("weasyprint")

AT = datetime(2026, 9, 29, 10, 5, tzinfo=UTC)


REVISIONS = [RevisionRow(1, AT, "Ada Lovelace", "First publish"),
             RevisionRow(2, AT, "Grace Hopper", ""),
             RevisionRow(3, AT, "Ada Lovelace", "Clarified the breaker step")]


def _document(body: str, threads: list[CommentThreadOut], *,
              statement: str = DEFAULT_CONFIDENTIALITY_STATEMENT,
              revisions: list[RevisionRow] = REVISIONS) -> str:
    body, headings = number_headings(body)
    cover = cover_html(CoverInfo(
        title="Rack Guide", doc_type="Operating Procedure", author="Linus Torvalds",
        revision=len(revisions), published_at=AT, published_by="Ada Lovelace",
        exported_at=AT, exported_by="Grace Hopper", statement=statement))
    return page_document(title="Rack Guide", breadcrumbs=["Ops", "Runbooks"], published_at=AT,
                         body=body, cover=cover, revisions=revision_history_html(revisions),
                         contents=contents_html(headings), comments=comments_html(threads),
                         footer_css=footer_css("Rack Guide",
                                               confidential=bool(statement.strip())))


def _labels(bookmarks) -> list[str]:
    """The outline's labels, depth first (each bookmark is a tuple of
    label, target, children and state)."""
    out = []
    for label, _, children, *_ in bookmarks:
        out.append(label)
        out.extend(_labels(children))
    return out


def _page_text(pdf_path, page: int) -> str:
    return subprocess.run(["pdftotext", "-f", str(page), "-l", str(page),
                           str(pdf_path), "-"], capture_output=True, text=True,
                          check=True).stdout


THREADS = [
    CommentThreadOut(quote="the breaker", resolved=True, resolved_by="Ada Lovelace",
                     resolved_at=AT, comments=[
                         CommentLine("Grace Hopper", AT, "Is this the right one?"),
                         CommentLine("Ada Lovelace", AT, "Yes, @Grace Hopper")]),
    CommentThreadOut(quote=None, resolved=False, resolved_by=None, resolved_at=None,
                     comments=[CommentLine("Grace Hopper", AT, "Page-level note")]),
]


def _pdftotext() -> None:
    if shutil.which("pdftotext") is None:
        pytest.skip("pdftotext isn't installed")


def test_cover_history_contents_body_and_comments(tmp_path):
    doc = _document("<h2>Power</h2><p>Check the breaker.</p><h2>Cabling</h2><p>Label.</p>"
                    "<h2>Testing</h2><p>Ping it.</p>", THREADS)
    rendered = weasyprint.HTML(string=doc).render()

    assert len(rendered.pages) >= 5
    # the outline: the page's headings, not the cover's or header's title
    labels = _labels(rendered.make_bookmark_tree())
    assert labels == ["Power", "Cabling", "Testing"]

    _pdftotext()
    pdf = tmp_path / "export.pdf"
    pdf.write_bytes(rendered.write_pdf())
    last = len(rendered.pages)
    cover = _page_text(pdf, 1)
    assert "Rack Guide" in cover and "CONFIDENTIAL" in cover
    assert "ServerSherpa" in cover and "A Cumulus Solutions Group product" in cover
    assert "OPERATINGPROCEDURE" in cover.replace(" ", "")   # letter-spaced capitals
    assert "Revision 3" in cover and "Author Linus Torvalds" in cover
    assert "Ops" not in cover                                # no breadcrumb on the cover
    assert "Page 1 of" not in cover                          # no footer on the cover
    history = _page_text(pdf, 2)
    assert "Revision history" in history
    assert "Description of changes" in history and "Clarified the breaker step" in history
    # the running footer closes the page: left, center, right
    lines = [line for line in history.splitlines() if line.strip()]
    assert lines[-3:] == ["CONFIDENTIAL", "Rack Guide", f"Page 2 of {last}"]
    contents = _page_text(pdf, 3)
    assert "Contents" in contents
    for title in ("Power", "Cabling", "Testing"):
        assert title in contents
    assert f"Page 3 of {last}" in contents
    closing = _page_text(pdf, last)
    assert "Comments" in closing
    assert f"Page {last} of {last}" in closing


def test_an_empty_statement_leaves_no_confidential_footer(tmp_path):
    _pdftotext()
    doc = _document("<h2>Power</h2><p>Check.</p><h2>Cabling</h2><p>Label.</p>", THREADS,
                    statement="")
    pdf = tmp_path / "export.pdf"
    rendered = weasyprint.HTML(string=doc).render()
    pdf.write_bytes(rendered.write_pdf())
    for page in range(1, len(rendered.pages) + 1):
        text = _page_text(pdf, page)
        assert "CONFIDENTIAL" not in text
        if page > 1:
            assert f"Page {page} of {len(rendered.pages)}" in text


def test_a_long_history_repeats_its_header_row(tmp_path):
    _pdftotext()
    rows = [RevisionRow(n, AT, "Ada Lovelace", f"Change number {n}") for n in range(1, 41)]
    doc = _document("<p>Text.</p>", [], revisions=rows)
    pdf = tmp_path / "export.pdf"
    rendered = weasyprint.HTML(string=doc).render()
    pdf.write_bytes(rendered.write_pdf())
    first, second = _page_text(pdf, 2), _page_text(pdf, 3)
    assert "Revision history" in first and "Change number 40" in first
    # the history runs onto a second page, header row and all
    assert re.search(r"Change number 1$", second, re.MULTILINE)
    assert "Revision history" not in second
    assert "Description of changes" in second and "Updated by" in second


@pytest.mark.parametrize("statement", [
    ("Long statement words. " * 60)[:1000],
    "\n".join(["A statement line that goes on"] * 40)[:1000],
])
def test_a_long_title_and_statement_share_one_cover(tmp_path, statement):
    """The statement is a footnote: pinned to the cover's foot, it can't
    overlap the title, and it never moves on to the history's page."""
    _pdftotext()
    title = ("Decommissioning and Relocating Every Rack Row in Data Hall 2 " * 3)[:140]
    cover = cover_html(CoverInfo(
        title=title, doc_type="Operating Procedure", author="Linus Torvalds", revision=3,
        published_at=AT, published_by="Ada Lovelace", exported_at=AT,
        exported_by="Grace Hopper", statement=statement))
    doc = page_document(title=title, breadcrumbs=[], published_at=AT, body="<p>Body.</p>",
                        cover=cover, revisions=revision_history_html(REVISIONS),
                        footer_css=footer_css(title, confidential=True))
    pdf = tmp_path / "export.pdf"
    rendered = weasyprint.HTML(string=doc).render()
    pdf.write_bytes(rendered.write_pdf())
    assert len(rendered.pages) == 3
    first = _page_text(pdf, 1)
    assert "Exported" in first and statement.split()[0] in first
    assert "Published September 29, 2026 by Ada Lovelace" in first
    assert "Revision history" in _page_text(pdf, 2)
    assert "Exported" not in _page_text(pdf, 2)
    # the foot sits below the metadata on the page
    boxes = {}

    def walk(box):
        element = getattr(box, "element", None)
        if element is not None and element.get("class") in ("ss-cover-meta",
                                                            "ss-cover-exported"):
            boxes.setdefault(element.get("class"), box)
        for child in getattr(box, "children", []):
            walk(child)
    walk(rendered.pages[0]._page_box)
    meta, exported = boxes["ss-cover-meta"], boxes["ss-cover-exported"]
    assert meta.position_y + meta.margin_height() <= exported.position_y


def test_one_heading_and_no_comments_is_cover_history_and_body():
    doc = _document("<h2>Only</h2><p>Text.</p>", [])
    rendered = weasyprint.HTML(string=doc).render()
    assert len(rendered.pages) == 3
