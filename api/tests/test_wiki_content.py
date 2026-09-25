"""Unit tests for `serversherpa.wiki.content`: the plain-text flattener
and the embedded-asset walkers used by page copy."""
from serversherpa.wiki.content import referenced_asset_ids, rewrite_asset_ids

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
