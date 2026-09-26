"""Page content helpers shared by the tree, page and internal routes: the
empty Tiptap document new pages start from, plain-text extraction
(`doc_text`, for `content_text`/`draft_text` — search and previews), a
canonical comparison of two documents that ignores comment anchors
(`docs_equal`), dropping those anchors from content that leaves its page
(`strip_comment_marks`), the stored-size cap
(`MAX_DOC_BYTES`), the embedded-asset walkers page copy uses, the
people a document @mentions (`mention_ids`), and
`strip_reference_labels`, which drops what a link or embed recorded about
ANOTHER node (its title) before a document is stored, and `public_doc`,
the form a page's published content takes behind a public share link.

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


def strip_comment_marks(doc: dict) -> dict:
    """A deep copy of `doc` without its `commentThread` marks, and with
    the text runs they split apart joined again (text nodes that now
    carry the same marks and attributes), so the result compares equal to
    the same document never commented on. An anchor belongs to one page's
    threads: use this wherever content leaves its page — a template, a
    copy, and (Phase 3) a public share or an export."""
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
    return _canonical(strip_comment_marks(a)) == _canonical(strip_comment_marks(b))


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


# ── public share links ───────────────────────────────────────────────

# what a public reader sees in place of a link to (or embed of) another
# wiki node — never its title or id: the target may not be shared at all
PUBLIC_PAGE_TEXT = "(linked page)"
PUBLIC_FILE_TEXT = "(linked file)"

# the only hrefs a public copy keeps as links: the editor also allows
# internal `/n/<id>` routes, which name a node and lead to a sign-in
_PUBLIC_HREF = re.compile(r"^(https?:|mailto:|tel:)", re.IGNORECASE)


def _public_marks(marks: Any) -> list | None:
    """`marks` without links that aren't web/mail/phone links."""
    if not isinstance(marks, list):
        return None
    kept = []
    for mark in marks:
        if isinstance(mark, dict) and mark.get("type") == "link":
            attrs = mark.get("attrs")
            href = attrs.get("href") if isinstance(attrs, dict) else None
            if not (isinstance(href, str) and _PUBLIC_HREF.match(href)):
                continue
        kept.append(mark)
    return kept


def _public_text(text: str, marks: list | None) -> dict:
    node: dict[str, Any] = {"type": "text", "text": text}
    if marks:
        node["marks"] = marks
    return node


def public_doc(doc: dict, *, node_id: str | uuid.UUID, title: str) -> dict:
    """A deep copy of a page's published `doc` as a public share link
    serves it — nothing in it names or leads to another part of the wiki:

    - a `pageLink` becomes plain text: the shared page's own `title` when
      it links to itself (`node_id`), else PUBLIC_PAGE_TEXT;
    - a `fileEmbed` of a wiki file node becomes a paragraph of
      PUBLIC_FILE_TEXT (an embed of the page's own asset is kept — its
      `assetId` is what the public response's `asset_urls` are keyed by);
    - `link` marks other than web, mail and phone links are dropped (their
      text stays);
    - a `mention` keeps its label but not the person's id;
    - comment anchors are dropped (`strip_comment_marks`), which also
      joins the text runs all of the above split apart."""
    self_id = str(node_id).lower()
    out = copy.deepcopy(doc)
    stack: list[Any] = [out]
    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        content = node.get("content")
        if not isinstance(content, list):
            continue
        rebuilt: list[Any] = []
        for child in content:
            if not isinstance(child, dict):
                rebuilt.append(child)
                continue
            child_type = child.get("type")
            if child_type == "pageLink":
                target = (_attr(child, "nodeId") or "").lower()
                text = title if target and target == self_id else PUBLIC_PAGE_TEXT
                rebuilt.append(_public_text(text, _public_marks(child.get("marks"))))
                continue
            if child_type == "fileEmbed" and _attr(child, "nodeId"):
                rebuilt.append({"type": "paragraph",
                                "content": [_public_text(PUBLIC_FILE_TEXT, None)]})
                continue
            if "marks" in child:
                marks = _public_marks(child["marks"])
                if marks:
                    child["marks"] = marks
                else:
                    del child["marks"]
            if child_type == "mention" and isinstance(child.get("attrs"), dict):
                child["attrs"]["personId"] = None
            rebuilt.append(child)
            stack.append(child)
        node["content"] = rebuilt
    return strip_comment_marks(out)
