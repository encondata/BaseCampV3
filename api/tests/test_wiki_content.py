"""Unit tests for `serversherpa.wiki.content`: the plain-text flattener
and the embedded-asset walkers used by page copy."""
from serversherpa.wiki.content import (
    EMPTY_DOC,
    doc_text,
    docs_equal,
    referenced_asset_ids,
    rewrite_asset_ids,
    strip_reference_labels,
)


def _t(text):
    return {"type": "text", "text": text}


def _p(*content):
    return {"type": "paragraph", "content": list(content)}


FIXTURE = {"type": "doc", "content": [
    {"type": "heading", "attrs": {"level": 1}, "content": [_t("Restart the API")]},
    _p(_t("First "), {"type": "text", "text": "bold", "marks": [{"type": "bold"}]},
       _t(" then"), {"type": "hardBreak"}, _t("next line")),
    {"type": "bulletList", "content": [
        {"type": "listItem", "content": [
            _p(_t("outer")),
            {"type": "orderedList", "content": [
                {"type": "listItem", "content": [_p(_t("inner"))]}]}]}]},
    {"type": "taskList", "content": [
        {"type": "taskItem", "attrs": {"checked": True}, "content": [_p(_t("done"))]}]},
    {"type": "table", "content": [
        {"type": "tableRow", "content": [
            {"type": "tableHeader", "content": [_p(_t("Host"))]},
            {"type": "tableHeader", "content": [_p(_t("Port"))]}]},
        {"type": "tableRow", "content": [
            {"type": "tableCell", "content": [_p(_t("api"))]},
            {"type": "tableCell", "content": [_p(_t("8000"))]}]}]},
    {"type": "callout", "attrs": {"variant": "warning"}, "content": [_p(_t("Careful"))]},
    {"type": "codeBlock", "attrs": {"language": "bash"},
     "content": [_t("systemctl restart api")]},
    {"type": "blockquote", "content": [_p(_t("quoted"))]},
    {"type": "details", "content": [
        {"type": "detailsSummary", "content": [_t("More")]},
        {"type": "detailsContent", "content": [_p(_t("hidden"))]}]},
    {"type": "wikiImage", "attrs": {"assetId": "a1", "alt": "Rack photo",
                                    "caption": "Row 4"}},
    {"type": "wikiImage", "attrs": {"assetId": "a2", "alt": None, "caption": ""}},
    _p(_t("See "), {"type": "pageLink", "attrs": {"nodeId": "n1", "title": "Runbook"}},
       _t(".")),
    {"type": "fileEmbed", "attrs": {"assetId": "a3", "filename": "spec.pdf"}},
    {"type": "horizontalRule"},
    _p(),
]}


def test_doc_text_flattens_every_kind_of_block():
    assert doc_text(FIXTURE) == (
        "Restart the API\n"
        "First bold then\nnext line\n"
        "outer\ninner\n\n"
        "done\n\n"
        "Host\n\nPort\n\napi\n\n8000\n\n"
        "Careful\n\n"
        "systemctl restart api\n"
        "quoted\n\n"
        "More\nhidden\n\n"
        "Rack photo\nRow 4\n"
        "See .\n"
        "spec.pdf")


# A link or file embed to another node records nothing about the target
# that a reader of THIS page might not be allowed to see: the target's
# title is looked up live, per viewer.
LINKED = {"type": "doc", "content": [
    _p(_t("See "), {"type": "pageLink", "attrs": {"nodeId": "n1", "title": "Q4 reduction plan"}}),
    {"type": "fileEmbed", "attrs": {"nodeId": "n2", "assetId": None,
                                    "filename": "layoffs.xlsx", "contentType": "x"}},
    {"type": "fileEmbed", "attrs": {"nodeId": None, "assetId": "a1",
                                    "filename": "own-asset.pdf", "contentType": "y"}},
]}


def test_doc_text_leaves_out_what_links_and_file_node_embeds_name():
    text = doc_text(LINKED)
    assert "Q4 reduction plan" not in text
    assert "layoffs.xlsx" not in text
    # the page's own uploaded asset is its own content
    assert "own-asset.pdf" in text


def test_strip_reference_labels_drops_target_titles_and_keeps_the_rest():
    stripped = strip_reference_labels(LINKED)
    link = stripped["content"][0]["content"][1]
    assert link == {"type": "pageLink", "attrs": {"nodeId": "n1"}}
    node_embed, asset_embed = stripped["content"][1:]
    assert node_embed["attrs"] == {"nodeId": "n2", "assetId": None, "contentType": "x"}
    assert asset_embed["attrs"]["filename"] == "own-asset.pdf"
    # a copy: the input is untouched
    assert LINKED["content"][0]["content"][1]["attrs"]["title"] == "Q4 reduction plan"


def test_doc_text_handles_empty_and_odd_input():
    assert doc_text(None) == ""
    assert doc_text({}) == ""
    assert doc_text(EMPTY_DOC) == ""
    assert doc_text({"type": "doc", "content": [
        "junk", 7, {"type": "text", "text": 5}, _p(_t("ok"))]}) == "ok"


def test_doc_text_survives_very_deep_nesting():
    node = _p(_t("bottom"))
    for _ in range(5000):
        node = {"type": "blockquote", "content": [node]}
    assert doc_text({"type": "doc", "content": [node]}) == "bottom"


def test_docs_equal_ignores_key_order():
    a = {"type": "doc", "content": [{"type": "paragraph", "attrs": {"x": 1, "y": 2}}]}
    b = {"content": [{"attrs": {"y": 2, "x": 1}, "type": "paragraph"}], "type": "doc"}
    assert docs_equal(a, b)
    assert not docs_equal(a, EMPTY_DOC)
    assert docs_equal(None, None)
    assert not docs_equal(None, EMPTY_DOC)
    assert not docs_equal(EMPTY_DOC, None)

ASSET_DOC = {"type": "doc", "content": [
    {"type": "wikiImage", "attrs": {"assetId": "a1", "alt": "one"}},
    {"type": "bulletList", "content": [{"type": "listItem", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "x"}]},
        {"type": "fileEmbed", "attrs": {"assetId": "a2", "nodeId": None}},
    ]}]},
    {"type": "fileEmbed", "attrs": {"assetId": None, "nodeId": "n1"}},
    {"type": "paragraph", "attrs": {"assetId": "not-an-asset-node"}},
]}


def test_referenced_asset_ids_walks_nested_image_and_file_embeds():
    assert referenced_asset_ids(ASSET_DOC) == {"a1", "a2"}
    assert referenced_asset_ids(None) == set()
    assert referenced_asset_ids({"type": "doc"}) == set()


def test_rewrite_asset_ids_returns_a_rewritten_copy():
    out = rewrite_asset_ids(ASSET_DOC, {"a1": "b1"})
    assert referenced_asset_ids(out) == {"b1", "a2"}
    assert out["content"][0]["attrs"] == {"assetId": "b1", "alt": "one"}
    assert referenced_asset_ids(ASSET_DOC) == {"a1", "a2"}   # input untouched
