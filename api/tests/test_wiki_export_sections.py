"""The export's cover, contents and comments builders (pure, no DB)."""
from __future__ import annotations

from datetime import datetime

from serversherpa.wiki.content import COMMENT_MARK
from serversherpa.wiki.export_sections import (
    CommentLine,
    CommentThreadOut,
    CoverInfo,
    Heading,
    anchor_quotes,
    comments_html,
    contents_html,
    cover_html,
    day_time,
    number_headings,
)


def _cover(**over) -> CoverInfo:
    base = dict(
        title="Rack <Guide>", location=["Ops", "Guides"], revision=7,
        published_at=datetime(2026, 9, 30, 9, 0), published_by="Ada Lovelace",
        exported_at=datetime(2026, 10, 1, 14, 0), exported_by="Grace Hopper",
        statement="Line one\nLine two")
    base.update(over)
    return CoverInfo(**base)


def test_cover_shows_title_location_revision_and_export():
    out = cover_html(_cover())
    assert "Rack &lt;Guide&gt;" in out
    assert "Revision 7 · Published September 30, 2026 by Ada Lovelace" in out
    assert "Ops › Guides" in out
    assert "Exported October 1, 2026 by Grace Hopper" in out
    assert 'src="data:image/png;base64,' in out


def test_cover_keeps_statement_line_breaks_and_drops_a_blank_one():
    assert "Line one<br>Line two" in cover_html(_cover())
    assert "ss-cover-statement" not in cover_html(_cover(statement="  "))


def test_cover_without_a_publisher_drops_by():
    out = cover_html(_cover(published_by=None))
    assert "Published September 30, 2026" in out
    assert " by Ada" not in out
    assert "Revision 7 · Published September 30, 2026</div>" in out


def test_number_headings_assigns_ids_and_keeps_other_attributes():
    body, found = number_headings(
        '<h2 id="x" data-text-align="left">A &amp; B</h2><h4>no</h4><h3>C</h3>')
    assert found == [Heading(2, "A & B", "ss-h-1"), Heading(3, "C", "ss-h-2")]
    assert '<h2 id="ss-h-1" data-text-align="left">A &amp; B</h2>' in body
    assert 'id="x"' not in body
    assert "<h4>no</h4>" in body
    assert '<h3 id="ss-h-2">C</h3>' in body


def test_contents_needs_two_headings():
    assert contents_html([]) == ""
    assert contents_html([Heading(1, "Only", "ss-h-1")]) == ""


def test_contents_lists_headings_by_level():
    out = contents_html([Heading(2, "A & B", "ss-h-1"), Heading(3, "C", "ss-h-2")])
    assert "<ol" in out
    assert 'href="#ss-h-1"' in out and 'href="#ss-h-2"' in out
    assert "ss-toc-l2" in out and "ss-toc-l3" in out
    assert "A &amp; B" in out


def _run(text: str, thread: str) -> dict:
    return {"type": "text", "text": text,
            "marks": [{"type": COMMENT_MARK, "attrs": {"threadId": thread}}]}


def test_anchor_quotes_joins_runs_in_document_order():
    doc = {"type": "doc", "content": [
        {"type": "paragraph", "content": [_run("first part", "B-1")]},
        {"type": "paragraph", "content": [{"type": "text", "text": "plain"},
                                          _run("other", "A-2")]},
        {"type": "paragraph", "content": [_run("second part", "b-1")]},
    ]}
    quotes = anchor_quotes(doc)
    assert quotes == {"b-1": "first part second part", "a-2": "other"}
    assert list(quotes) == ["b-1", "a-2"]
    assert anchor_quotes(None) == {}


def _thread(**over) -> CommentThreadOut:
    base = dict(quote=None, resolved=False, resolved_by=None, resolved_at=None,
                comments=[CommentLine("Ada Lovelace", datetime(2026, 9, 30, 16, 5), "Hi")])
    base.update(over)
    return CommentThreadOut(**base)


def test_comments_empty_when_no_thread_has_a_comment():
    assert comments_html([]) == ""
    assert comments_html([_thread(comments=[])]) == ""


def test_comments_resolved_reply_quote_and_line_breaks():
    out = comments_html([_thread(
        quote="<b>x</b>", resolved=True, resolved_by="Ada Lovelace",
        resolved_at=datetime(2026, 9, 30, 12, 0),
        comments=[CommentLine("Ada Lovelace", datetime(2026, 9, 30, 16, 5), "a\nb"),
                  CommentLine("Grace Hopper", datetime(2026, 9, 30, 17, 0), "re")])])
    assert "Resolved by Ada Lovelace on September 30, 2026" in out
    assert "ss-comment ss-reply" in out
    assert out.count("ss-reply") == 1
    assert "&lt;b&gt;x&lt;/b&gt;" in out
    assert "a<br>b" in out
    assert "September 30, 2026 at 4:05 PM" in out


def test_day_time_twelve_hour_clock():
    assert day_time(datetime(2026, 9, 30, 16, 5)) == "September 30, 2026 at 4:05 PM"
    assert day_time(datetime(2026, 9, 30, 0, 30)) == "September 30, 2026 at 12:30 AM"
    assert day_time(datetime(2026, 9, 30, 12, 0)).endswith("12:00 PM")
