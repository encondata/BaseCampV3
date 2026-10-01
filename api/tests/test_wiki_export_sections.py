"""The export's cover, revision history, footer, contents and comments
builders (pure, no DB)."""
from __future__ import annotations

from datetime import datetime

from serversherpa.wiki.content import COMMENT_MARK
from serversherpa.wiki.export_sections import (
    CommentLine,
    CommentThreadOut,
    CoverInfo,
    Heading,
    RevisionRow,
    anchor_quotes,
    comments_html,
    contents_html,
    cover_html,
    day_time,
    footer_css,
    number_headings,
    revision_history_html,
)


def _cover(**over) -> CoverInfo:
    base = dict(
        title="Rack <Guide>", doc_type="Operating Procedure", author="Linus <T>", revision=7,
        published_at=datetime(2026, 9, 30, 9, 0), published_by="Ada Lovelace",
        exported_at=datetime(2026, 10, 1, 14, 0), exported_by="Grace Hopper",
        statement="Line one\nLine two")
    base.update(over)
    return CoverInfo(**base)


def test_cover_shows_branding_type_title_metadata_and_export():
    out = cover_html(_cover())
    assert 'src="data:image/png;base64,' in out
    assert '<div class="ss-cover-name">ServerSherpa</div>' in out
    assert '<div class="ss-cover-product">A Cumulus Solutions Group product</div>' in out
    assert '<div class="ss-cover-type">Operating Procedure</div>' in out
    assert '<div class="ss-cover-title">Rack &lt;Guide&gt;</div>' in out
    assert out.count('class="ss-cover-rule"') == 2
    assert "<div>Revision 7</div>" in out
    assert "<div>Author Linus &lt;T&gt;</div>" in out
    assert "<div>Published September 30, 2026 by Ada Lovelace</div>" in out
    assert "Exported October 1, 2026 by Grace Hopper" in out


def test_cover_order_top_to_bottom():
    out = cover_html(_cover())
    marks = ["ss-cover-logo", "ss-cover-name", "ss-cover-product", "ss-cover-type",
             "ss-cover-rule", "ss-cover-title", "ss-cover-meta"]
    at = [out.index(m) for m in marks]
    assert at == sorted(at)
    # the bottom block (a footnote, pinned to the page's foot) comes first
    # in the markup, holding the exported line and then the statement
    foot = out.index('<div class="ss-cover-foot">')
    assert foot < out.index("ss-cover-logo")
    # all on one line: whitespace between its blocks would add blank lines
    foot_html = out[foot:].split("\n", 1)[0]
    assert foot_html.endswith("</div></div>")
    assert foot_html.index("Exported") < foot_html.index("Line one")


def test_a_long_title_or_statement_makes_a_compact_cover():
    assert "ss-cover-compact" not in cover_html(_cover())
    assert "ss-cover-compact" in cover_html(_cover(title="T" * 91))
    assert "ss-cover-compact" in cover_html(_cover(statement="\n".join(["line"] * 8)))
    assert "ss-cover-compact" not in cover_html(_cover(statement="x" * 980))


def test_cover_has_no_location_or_breadcrumb():
    out = cover_html(_cover())
    assert "ss-cover-location" not in out
    assert "›" not in out


def test_cover_omits_a_missing_type_and_author():
    out = cover_html(_cover(doc_type=None, author=None))
    assert "ss-cover-type" not in out
    assert "Author" not in out
    assert "<div>Revision 7</div>" in out


def test_cover_keeps_statement_line_breaks_and_drops_a_blank_one():
    assert "Line one<br>Line two" in cover_html(_cover())
    assert "ss-cover-statement" not in cover_html(_cover(statement="  "))


def test_cover_without_a_publisher_drops_by():
    out = cover_html(_cover(published_by=None))
    assert "<div>Published September 30, 2026</div>" in out
    assert " by Ada" not in out


# ── revision history ─────────────────────────────────────────────────


def _rows() -> list[RevisionRow]:
    return [RevisionRow(1, datetime(2026, 9, 1, 9, 0), "Ada Lovelace", "First <draft>"),
            RevisionRow(2, datetime(2026, 9, 15, 9, 0), "Grace Hopper", "   "),
            RevisionRow(3, datetime(2026, 9, 29, 9, 0), "Unknown", "Fixed\nthe steps")]


def test_revision_history_newest_first_with_a_header():
    out = revision_history_html(_rows())
    assert '<div class="ss-section-title">Revision history</div>' in out
    head = out.index("<thead>")
    assert head < out.index("</thead>") < out.index("<tbody>")
    for label in ("Rev", "Date", "Updated by", "Description of changes"):
        assert f"<th>{label}</th>" in out
    body = out[out.index("<tbody>"):]
    order = [body.index(f"<td>{n}</td>") for n in (3, 2, 1)]
    assert order == sorted(order)
    assert "<td>September 29, 2026</td>" in out
    assert "<td>Grace Hopper</td>" in out


def test_revision_history_notes_are_escaped_trimmed_or_a_dash():
    out = revision_history_html(_rows())
    assert "<td>First &lt;draft&gt;</td>" in out
    assert "<td>—</td>" in out
    assert "<td>Fixed<br>the steps</td>" in out
    assert "<draft>" not in out


def test_revision_history_sorts_whatever_order_it_gets():
    out = revision_history_html(list(reversed(_rows())))
    body = out[out.index("<tbody>"):]
    assert body.index("<td>3</td>") < body.index("<td>2</td>") < body.index("<td>1</td>")


# ── the running footer ───────────────────────────────────────────────


def test_footer_css_escapes_the_title_for_a_css_string():
    out = footer_css('A "quoted" \\ back\nslash </style><b>&', confidential=True)
    assert '"A \\"quoted\\" \\\\ back\\a slash \\3c /style\\3e \\3c b\\3e \\26 "' in out
    assert "</style>" not in out and "back\nslash" not in out and "<" not in out


def test_footer_css_confidential_only_when_asked():
    assert '"CONFIDENTIAL"' in footer_css("T", confidential=True)
    assert "CONFIDENTIAL" not in footer_css("T", confidential=False)
    for css in (footer_css("T", confidential=True), footer_css("T", confidential=False)):
        assert '"Page " counter(page) " of " counter(pages)' in css


def test_footer_css_truncates_a_long_title():
    title = "x" * 69 + "yz" + "q" * 20
    out = footer_css(title, confidential=False)
    assert f'"{"x" * 69}y…"' in out
    assert "z" not in out.split("@bottom-center", 1)[1].split(";", 1)[0]
    exact = "a" * 70
    assert f'"{exact}"' in footer_css(exact, confidential=False)


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


def test_a_quote_split_by_formatting_inside_a_word_stays_one_word():
    t = {"type": "commentThread", "attrs": {"threadId": "T"}}
    doc = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "Hel", "marks": [t]},
        {"type": "text", "text": "lo", "marks": [t, {"type": "bold"}]},
        {"type": "text", "text": ".", "marks": [t]}]}]}
    assert anchor_quotes(doc) == {"t": "Hello."}


def test_heading_text_spaces_line_breaks_and_any_old_id_form_is_dropped():
    out, found = number_headings("<H2 ID='x' data-a=\"1\">A<br>B <strong>C</strong></H2>")
    assert found == [Heading(level=2, text="A B C", anchor="ss-h-1")]
    assert out.count("id=") == 1 and 'data-a="1"' in out


def test_the_bundled_logo_is_small():
    from serversherpa.wiki.export_sections import LOGO_PATH
    assert LOGO_PATH.stat().st_size < 100_000
