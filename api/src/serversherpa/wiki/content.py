"""Page content helpers shared by the tree, page and internal routes: the
empty Tiptap document new pages start from, plain-text extraction
(`doc_text`, for `content_text`/`draft_text` — search and previews), a
canonical comparison of two documents that ignores comment anchors
(`docs_equal`), the stored-size cap
(`MAX_DOC_BYTES`), the embedded-asset walkers page copy uses, the
people a document @mentions (`mention_ids`), and
`strip_reference_labels`, which drops what a link or embed recorded about
ANOTHER node (its title) before a document is stored.

Server-side Python never renders HTML; it only reads the ProseMirror JSON
the editor's shared schema produces.
"""
from __future__ import annotations

import copy
import json
import re
import uuid
from collections.abc import Iterator, Mapping
from typing import Any

# A single empty paragraph — the smallest document Tiptap's schema
# accepts, and what every freshly created page (including a space's home
# page) starts published/drafted from.
EMPTY_DOC: dict[str, Any] = {"type": "doc", "content": [{"type": "paragraph"}]}

# C0 control characters (and DEL) other than tab, newline and carriage
# return — what plain text the wiki stores or shows must not carry
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# the most a stored document (draft or version) may take, as compact JSON
MAX_DOC_BYTES = 5 * 1024 * 1024

# block nodes whose text ends with a newline (plus every details* node)
_BLOCK_TYPES = frozenset({
    "paragraph", "heading", "listItem", "taskItem", "blockquote", "codeBlock",
    "tableCell", "tableHeader", "callout",
})
_END_BLOCK = object()   # stack marker: "a block just ended, add a newline"


def _is_block(node_type: Any) -> bool:
    return isinstance(node_type, str) and (
        node_type in _BLOCK_TYPES or node_type.startswith("details"))


def _attr(node: dict, name: str) -> str | None:
    attrs = node.get("attrs")
    value = attrs.get(name) if isinstance(attrs, dict) else None
    return value if isinstance(value, str) and value else None


def doc_text(doc: dict | None) -> str:
    """Flatten a ProseMirror JSON document to plain text for search and
    previews — not for rendering. Text leaves contribute their text, a
    `hardBreak` a newline, and every block (paragraph, heading, list/task
    item, blockquote, code block, table cell/header, callout, details*)
    ends with a newline. A `mention` contributes `@<label>`. A
    `wikiImage` contributes its alt text and caption (a line each), and
    a `fileEmbed` of the page's own asset its filename (a line). A `pageLink`, or a `fileEmbed` of a file node,
    contributes nothing: what it once recorded about its target (the
    target's title) may name something this page's readers can't see
    (see `strip_reference_labels`). Runs of three or more newlines collapse to two,
    and the result is stripped. Walks iteratively, so a pathologically
    deep document can't exhaust the stack."""
    if not doc:
        return ""
    parts: list[str] = []
    stack: list[Any] = [doc]
    while stack:
        node = stack.pop()
        if node is _END_BLOCK:
            parts.append("\n")
            continue
        if isinstance(node, list):
            stack.extend(reversed(node))
            continue
        if not isinstance(node, dict):
            continue
        node_type = node.get("type")
        if node_type == "text":
            text = node.get("text")
            if isinstance(text, str):
                parts.append(text)
        elif node_type == "hardBreak":
            parts.append("\n")
        elif node_type == "mention":
            label = _attr(node, "label")
            if label:
                parts.append(f"@{label}")
        elif node_type == "wikiImage":
            parts.extend(f"{v}\n" for v in (_attr(node, "alt"), _attr(node, "caption")) if v)
        elif node_type == "fileEmbed" and not _attr(node, "nodeId"):
            filename = _attr(node, "filename")
            if filename:
                parts.append(f"{filename}\n")
        if _is_block(node_type):
            stack.append(_END_BLOCK)
        content = node.get("content")
        if isinstance(content, list):
            stack.extend(reversed(content))
    return re.sub(r"\n{3,}", "\n\n", "".join(parts)).strip()


def _nodes(doc: Any) -> Iterator[dict]:
    """Every node dict in `doc`, in document order (iteratively)."""
    stack = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(reversed(node))
            continue
        if not isinstance(node, dict):
            continue
        yield node
        content = node.get("content")
        if isinstance(content, list):
            stack.extend(reversed(content))


def mention_ids(doc: dict | None) -> set[str]:
    """The people `doc` @mentions: `attrs.personId` of each `mention`
    node, as canonical uuid strings. Ids that aren't uuids are ignored."""
    ids: set[str] = set()
    for node in _nodes(doc) if doc else ():
        if node.get("type") != "mention":
            continue
        person_id = _attr(node, "personId")
        try:
            ids.add(str(uuid.UUID(person_id)))
        except (TypeError, ValueError):
            continue
    return ids


def _references_node(node: dict) -> bool:
    """A pageLink, or a fileEmbed of a wiki file node (not of the page's
    own uploaded asset)."""
    node_type = node.get("type")
    return node_type == "pageLink" or (node_type == "fileEmbed" and bool(_attr(node, "nodeId")))


# what a node that points at another wiki node may have recorded about
# its target when it was inserted — never stored (see strip_reference_labels)
_REFERENCE_LABELS = {"pageLink": ("title",), "fileEmbed": ("filename",)}


def strip_reference_labels(doc: dict) -> dict:
    """A deep copy of `doc` without the target titles its page links
    (`pageLink.title`) and file-node embeds (`fileEmbed.filename` where
    `nodeId` is set) carry. Those attributes are the target's title when
    the link was made, and the target may be behind broken inheritance:
    stored, they'd reach every reader of THIS page through the content
    API, the search index and exports. Viewers resolve the live title of
    what they may see instead. A page's own uploaded asset keeps its
    filename (it's the page's own content)."""
    out = copy.deepcopy(doc)
    stack: list[Any] = [out]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(node)
            continue
        if not isinstance(node, dict):
            continue
        attrs = node.get("attrs")
        if isinstance(attrs, dict) and _references_node(node):
            for name in _REFERENCE_LABELS[node["type"]]:
                attrs.pop(name, None)
        content = node.get("content")
        if isinstance(content, list):
            stack.extend(content)
    return out


def _canonical(doc: Any) -> str:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# the mark that anchors an inline comment thread to text (the editor's
# CommentThread extension) — a comment, not content
COMMENT_MARK = "commentThread"


def _is_text(node: Any) -> bool:
    return isinstance(node, dict) and node.get("type") == "text" \
        and isinstance(node.get("text"), str)


def _without_comment_anchors(doc: dict) -> dict:
    """A deep copy of `doc` without its `commentThread` marks, and with
    the text runs they split apart joined again (text nodes that now
    carry the same marks and attributes), so the result compares equal to
    the same document never commented on."""
    out = copy.deepcopy(doc)
    stack: list[Any] = [out]
    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        content = node.get("content")
        if not isinstance(content, list):
            continue
        joined: list[Any] = []
        for child in content:
            if isinstance(child, dict) and isinstance(child.get("marks"), list):
                kept = [m for m in child["marks"]
                        if not (isinstance(m, dict) and m.get("type") == COMMENT_MARK)]
                if kept:
                    child["marks"] = kept
                else:
                    del child["marks"]
            prev = joined[-1] if joined else None
            if _is_text(child) and _is_text(prev) and \
                    {k: v for k, v in child.items() if k != "text"} == \
                    {k: v for k, v in prev.items() if k != "text"}:
                prev["text"] += child["text"]
                continue
            joined.append(child)
            stack.append(child)
        node["content"] = joined
    return out


def docs_equal(a: dict | None, b: dict | None) -> bool:
    """Do two documents hold the same content? Key order doesn't matter,
    and neither do comment anchors (`commentThread` marks): anchoring a
    comment to published text isn't a change to publish. None only
    equals None."""
    if a is None or b is None:
        return a is b
    return _canonical(_without_comment_anchors(a)) == _canonical(_without_comment_anchors(b))


def doc_bytes(doc: Any) -> int:
    """A document's size as compact UTF-8 JSON — what MAX_DOC_BYTES caps."""
    return len(_canonical(doc).encode())


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


def _is_page_asset_node(node: dict) -> bool:
    """A wikiImage/fileEmbed node that embeds one of the page's own
    uploaded assets (`attrs.assetId`) — the same test `_asset_nodes` uses."""
    attrs = node.get("attrs")
    return (node.get("type") in ASSET_NODE_TYPES and isinstance(attrs, dict)
            and isinstance(attrs.get("assetId"), str) and bool(attrs["assetId"]))


def _drop_nodes(node: dict, predicate) -> dict:
    """`node`, mutated in place, with every descendant matching
    `predicate` removed from its content lists (`node` itself is never
    dropped — only its content is filtered)."""
    content = node.get("content")
    if not isinstance(content, list):
        return node
    node["content"] = [_drop_nodes(child, predicate) for child in content
                       if isinstance(child, dict) and not predicate(child)]
    return node


def strip_asset_nodes(doc: dict) -> dict:
    """A deep copy of `doc` with every wikiImage/fileEmbed node that
    embeds a page's own uploaded asset (`attrs.assetId`) removed
    entirely — used when content becomes a template: templates are
    page-independent, so those assets won't exist for whoever creates a
    page from one. A `fileEmbed` of a wiki file node (`attrs.nodeId`,
    no `assetId`) is kept — that reference is wiki-wide, not tied to the
    source page."""
    return _drop_nodes(copy.deepcopy(doc), _is_page_asset_node)
