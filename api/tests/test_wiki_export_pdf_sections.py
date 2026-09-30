"""An exported PDF's cover, contents and comments, laid out by real
WeasyPrint (no database): which page each lands on, the page count with
and without the optional sections, and the outline (bookmarks)."""
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
    comments_html,
    contents_html,
    cover_html,
    number_headings,
)
from serversherpa.wiki.statement import DEFAULT_CONFIDENTIALITY_STATEMENT

weasyprint = pytest.importorskip("weasyprint")

AT = datetime(2026, 9, 29, 10, 5, tzinfo=UTC)


def _document(body: str, threads: list[CommentThreadOut]) -> str:
    body, headings = number_headings(body)
    cover = cover_html(CoverInfo(
        title="Rack Guide", location=["Ops", "Runbooks"], revision=3, published_at=AT,
        published_by="Ada Lovelace", exported_at=AT, exported_by="Grace Hopper",
        statement=DEFAULT_CONFIDENTIALITY_STATEMENT))
    return page_document(title="Rack Guide", breadcrumbs=["Ops", "Runbooks"], published_at=AT,
                         body=body, cover=cover, contents=contents_html(headings),
                         comments=comments_html(threads))


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


def test_cover_contents_body_and_comments(tmp_path):
    doc = _document("<h2>Power</h2><p>Check the breaker.</p><h2>Cabling</h2><p>Label.</p>"
                    "<h2>Testing</h2><p>Ping it.</p>", THREADS)
    rendered = weasyprint.HTML(string=doc).render()

    assert len(rendered.pages) >= 4
    # the outline: the page's headings, not the cover's or header's title
    labels = _labels(rendered.make_bookmark_tree())
    assert labels == ["Power", "Cabling", "Testing"]

    if shutil.which("pdftotext") is None:
        pytest.skip("pdftotext isn't installed")
    pdf = tmp_path / "export.pdf"
    pdf.write_bytes(rendered.write_pdf())
    last = len(rendered.pages)
    cover = _page_text(pdf, 1)
    assert "Rack Guide" in cover and "CONFIDENTIAL" in cover
    assert "Revision 3" in cover
    assert not re.search(r"\d+\s*/\s*\d+", cover)            # no page number on the cover
    contents = _page_text(pdf, 2)
    assert "Contents" in contents
    for title in ("Power", "Cabling", "Testing"):
        assert title in contents
    closing = _page_text(pdf, last)
    assert "Comments" in closing
    assert re.search(rf"{last}\s*/\s*{last}", closing)


def test_one_heading_and_no_comments_is_cover_and_body():
    doc = _document("<h2>Only</h2><p>Text.</p>", [])
    rendered = weasyprint.HTML(string=doc).render()
    assert len(rendered.pages) == 2
