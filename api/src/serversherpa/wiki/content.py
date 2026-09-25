"""Page content helpers shared by the tree and page routes: the empty
Tiptap document new pages start from, and plain-text extraction from a
document for `content_text`/`draft_text` (search indexing, previews).

Task 5 extends this module with the editor schema itself and asset-key
rewriting; this Phase-1 slice only needs the empty doc and a flattener.
"""
from __future__ import annotations

import copy
from collections.abc import Iterator, Mapping
from typing import Any

# A single empty paragraph — the smallest document Tiptap's schema
# accepts, and what every freshly created page (including a space's home
# page) starts published/drafted from.
EMPTY_DOC: dict[str, Any] = {"type": "doc", "content": [{"type": "paragraph"}]}


def doc_to_text(doc: dict | None) -> str:
    """Flatten a Tiptap/ProseMirror JSON document to plain text: every
    text leaf, in document order, joined with single spaces. Used to
    populate `content_text`/`draft_text` for search — not for rendering."""
    if not doc:
        return ""
    parts: list[str] = []

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            text = node.get("text")
            if isinstance(text, str):
                parts.append(text)
            for child in node.get("content") or ():
                _walk(child)
        elif isinstance(node, list):
            for child in node:
                _walk(child)

    _walk(doc)
    return " ".join(parts)


# node types whose `attrs.assetId` points at a wiki_page_assets row
ASSET_NODE_TYPES = frozenset({"wikiImage", "fileEmbed"})


def _asset_nodes(doc: Any) -> Iterator[dict]:
    """Every wikiImage/fileEmbed node in `doc` that carries a string
    `attrs.assetId`, in document order."""
    stack = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(reversed(node))
            continue
        if not isinstance(node, dict):
            continue
        attrs = node.get("attrs")
        if (node.get("type") in ASSET_NODE_TYPES and isinstance(attrs, dict)
                and isinstance(attrs.get("assetId"), str) and attrs["assetId"]):
            yield node
        content = node.get("content")
        if isinstance(content, list):
            stack.extend(reversed(content))


def referenced_asset_ids(doc: dict | None) -> set[str]:
    """The page-asset ids `doc` embeds (wikiImage and fileEmbed
    `attrs.assetId`), as the strings stored in the JSON."""
    if not doc:
        return set()
    return {node["attrs"]["assetId"] for node in _asset_nodes(doc)}


def rewrite_asset_ids(doc: dict, mapping: Mapping[str, str]) -> dict:
    """A deep copy of `doc` with every embedded asset id found in
    `mapping` swapped for its value (ids not in `mapping` are kept)."""
    out = copy.deepcopy(doc)
    for node in _asset_nodes(out):
        new_id = mapping.get(node["attrs"]["assetId"])
        if new_id is not None:
            node["attrs"]["assetId"] = new_id
    return out
