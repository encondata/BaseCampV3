"""The ProseMirror JSON → Markdown serializer behind Markdown exports
(`wiki/markdown.py`): table-driven over every node and mark the shared
schema has, plus the `MarkdownRefs` hooks an export uses to turn page
links, internal links, images and file embeds into relative paths."""
import pytest

from serversherpa.wiki.markdown import MarkdownRefs, to_markdown


def t(value, *marks):
    node = {"type": "text", "text": value}
    if marks:
        node["marks"] = [m if isinstance(m, dict) else {"type": m} for m in marks]
    return node


def link(href):
    return {"type": "link", "attrs": {"href": href, "target": "_blank"}}


def p(*content, align=None):
    return {"type": "paragraph", "attrs": {"textAlign": align}, "content": list(content)}


def doc(*blocks):
    return {"type": "doc", "content": list(blocks)}


def item(*blocks, kind="listItem", checked=None):
    node = {"type": kind, "content": list(blocks)}
    if kind == "taskItem":
        node["attrs"] = {"checked": checked}
    return node


def cell(value, kind="tableCell"):
    return {"type": kind, "attrs": {"colspan": 1, "rowspan": 1}, "content": [p(t(value))]}


CASES = [
    ("empty document", doc(p()), ""),
    ("paragraphs", doc(p(t("One")), p(t("Two"))), "One\n\nTwo\n"),
    ("headings", doc({"type": "heading", "attrs": {"level": 2}, "content": [t("Setup")]}),
     "## Setup\n"),
    ("bold, italic, code, strike",
     doc(p(t("a", "bold"), t(" "), t("b", "italic"), t(" "), t("c", "code"), t(" "),
           t("d", "strike"))),
     "**a** *b* `c` ~~d~~\n"),
    ("marks without a Markdown form keep their text",
     doc(p(t("u", "underline"), t("h", "highlight"), t("2", "subscript"),
           t("3", "superscript"))),
     "uh23\n"),
    ("adjacent runs share one delimiter",
     doc(p(t("bold ", "bold"), t("both", "bold", "italic"), t(" plain"))),
     "**bold *both*** plain\n"),
    ("whitespace moves outside the delimiters",
     doc(p(t("Check"), t(" the breaker ", "bold"), t("now"))),
     "Check **the breaker** now\n"),
    ("a web link", doc(p(t("guide", link("https://example.com/g")))),
     "[guide](https://example.com/g)\n"),
    ("an internal link without refs keeps only its text",
     doc(p(t("the checklist", link("/n/b7c8d9e0-f1a2-4b3c-9d4e-5f6a7b8c9d0e")))),
     "the checklist\n"),
    ("a code span holding a backtick", doc(p(t("a`b", "code"))), "`` a`b ``\n"),
    ("special characters are escaped",
     doc(p(t("2 * 3 = [6] <ok> _x_ | a\\b"))),
     "2 \\* 3 = \\[6\\] \\<ok\\> \\_x\\_ \\| a\\\\b\n"),
    ("a paragraph that would read as a heading or list",
     doc(p(t("# not a heading")), p(t("- not a list")), p(t("1. not a list"))),
     "\\# not a heading\n\n\\- not a list\n\n1\\. not a list\n"),
    ("a hard break", doc(p(t("one"), {"type": "hardBreak"}, t("two"))), "one\\\ntwo\n"),
    ("a line after a hard break that would read as a list or heading",
     doc(p(t("one"), {"type": "hardBreak"}, t("- two"), {"type": "hardBreak"}, t("# three"))),
     "one\\\n\\- two\\\n\\# three\n"),
    ("a mention", doc(p(t("Ask "), {"type": "mention", "attrs": {"personId": "x",
                                                               "label": "Pat Doe"}})),
     "Ask @Pat Doe\n"),
    ("a page link without refs",
     doc(p({"type": "pageLink", "attrs": {"nodeId": "b7c8", "title": ""}})),
     "(linked page)\n"),
    ("a bullet list",
     doc({"type": "bulletList", "content": [item(p(t("Power off"))), item(p(t("Unplug")))]}),
     "- Power off\n- Unplug\n"),
    ("an ordered list starting at 3",
     doc({"type": "orderedList", "attrs": {"start": 3},
          "content": [item(p(t("c"))), item(p(t("d")))]}),
     "3. c\n4. d\n"),
    ("a nested list",
     doc({"type": "bulletList", "content": [
         item(p(t("outer")), {"type": "orderedList", "attrs": {"start": 1},
                              "content": [item(p(t("inner")))]})]}),
     "- outer\n\n  1. inner\n"),
    ("a task list",
     doc({"type": "taskList", "content": [
         item(p(t("Photos taken")), kind="taskItem", checked=True),
         item(p(t("Ticket closed")), kind="taskItem", checked=False)]}),
     "- [x] Photos taken\n- [ ] Ticket closed\n"),
    ("a table (GFM)",
     doc({"type": "table", "content": [
         {"type": "tableRow", "content": [cell("Port", "tableHeader"),
                                          cell("Device", "tableHeader")]},
         {"type": "tableRow", "content": [cell("A1"), cell("Core | edge")]}]}),
     "| Port | Device |\n| --- | --- |\n| A1 | Core \\| edge |\n"),
    ("a pipe inside a code span in a table",
     doc({"type": "table", "content": [
         {"type": "tableRow", "content": [cell("Command")]},
         {"type": "tableRow", "content": [{"type": "tableCell", "content": [
             p(t("a | b", "code"))]}]}]}),
     "| Command |\n| --- |\n| `a \\| b` |\n"),
    ("a ragged table is padded",
     doc({"type": "table", "content": [
         {"type": "tableRow", "content": [cell("a"), cell("b")]},
         {"type": "tableRow", "content": [cell("c")]}]}),
     "| a | b |\n| --- | --- |\n| c |  |\n"),
    ("a code block with its language",
     doc({"type": "codeBlock", "attrs": {"language": "bash"},
          "content": [t("ipmitool power status")]}),
     "```bash\nipmitool power status\n```\n"),
    ("a code block holding a fence",
     doc({"type": "codeBlock", "attrs": {"language": None}, "content": [t("```\nx")]}),
     "````\n```\nx\n````\n"),
    ("a blockquote", doc({"type": "blockquote", "content": [p(t("Measure")), p(t("twice"))]}),
     "> Measure\n>\n> twice\n"),
    ("a callout", doc({"type": "callout", "attrs": {"variant": "warning"},
                       "content": [p(t("Never hot-swap."))]}),
     "> **Warning**\n>\n> Never hot-swap.\n"),
    ("an unknown callout variant reads as info",
     doc({"type": "callout", "attrs": {"variant": "nope"}, "content": [p(t("x"))]}),
     "> **Info**\n>\n> x\n"),
    ("details",
     doc({"type": "details", "content": [
         {"type": "detailsSummary", "content": [t("Why <not>?")]},
         {"type": "detailsContent", "content": [p(t("No redundant feed."))]}]}),
     "<details>\n<summary>Why &lt;not&gt;?</summary>\n\nNo redundant feed.\n\n</details>\n"),
    ("a horizontal rule", doc(p(t("a")), {"type": "horizontalRule"}, p(t("b"))),
     "a\n\n---\n\nb\n"),
    ("an image without refs",
     doc({"type": "wikiImage", "attrs": {"assetId": "a1", "alt": "Rack", "caption": ""}}),
     "*\\[Image: Rack\\]*\n"),
    ("a file embed without refs",
     doc({"type": "fileEmbed", "attrs": {"assetId": "a2", "nodeId": None,
                                         "filename": "manual.pdf"}}),
     "manual.pdf\n"),
    ("a file-node embed without refs",
     doc({"type": "fileEmbed", "attrs": {"assetId": None, "nodeId": "f1", "filename": ""}}),
     "(linked file)\n"),
    ("comment anchors are just text",
     doc(p(t("spare", {"type": "commentThread", "attrs": {"threadId": "t"}}))),
     "spare\n"),
]


@pytest.mark.parametrize(("name", "value", "expected"), CASES, ids=[c[0] for c in CASES])
def test_to_markdown(name, value, expected):
    assert to_markdown(value) == expected


class ZipRefs(MarkdownRefs):
    """What a zip export resolves: one page in the zip, one hidden."""

    def page_link(self, node_id):
        if node_id == "in-zip":
            return "Cabling standards", "../Standards/Cabling standards.md"
        return "(linked page)", None

    def link_href(self, href):
        if href == "/n/in-zip":
            return "../Standards/Cabling standards.md"
        return super().link_href(href)

    def image(self, asset_id):
        return "../assets/rack.png" if asset_id == "img" else None

    def file_embed(self, *, node_id, asset_id, filename):
        if node_id == "file":
            return "manual.pdf", "manual.pdf"
        return super().file_embed(node_id=node_id, asset_id=asset_id, filename=filename)


REF_CASES = [
    ("a page link in the zip",
     doc(p({"type": "pageLink", "attrs": {"nodeId": "in-zip"}})),
     "[Cabling standards](../Standards/Cabling%20standards.md)\n"),
    ("a page link outside it", doc(p({"type": "pageLink", "attrs": {"nodeId": "gone"}})),
     "(linked page)\n"),
    ("an internal link mark to a page in the zip",
     doc(p(t("the standard", link("/n/in-zip")))),
     "[the standard](../Standards/Cabling%20standards.md)\n"),
    ("an image written into assets/",
     doc({"type": "wikiImage", "attrs": {"assetId": "img", "alt": "Rack [front]",
                                         "caption": "Rack 12"}}),
     "![Rack \\[front\\]](../assets/rack.png)\n*Rack 12*\n"),
    ("a file in the zip", doc({"type": "fileEmbed", "attrs": {"nodeId": "file"}}),
     "[manual.pdf](manual.pdf)\n"),
]


@pytest.mark.parametrize(("name", "value", "expected"), REF_CASES,
                         ids=[c[0] for c in REF_CASES])
def test_to_markdown_with_refs(name, value, expected):
    assert to_markdown(value, refs=ZipRefs()) == expected


def test_title_heads_the_document():
    assert to_markdown(doc(p(t("Body"))), title="Rack # Guide") == "# Rack # Guide\n\nBody\n"


def test_a_pathologically_deep_document_degrades_to_text():
    node = p(t("deep"))
    for _ in range(2000):
        node = {"type": "blockquote", "content": [node]}
    out = to_markdown(doc(node))
    assert "deep" in out


def test_garbage_is_ignored():
    assert to_markdown({"type": "doc", "content": [None, 3, {"type": "paragraph",
                                                             "content": "x"}]}) == ""
    assert to_markdown(None) == ""
