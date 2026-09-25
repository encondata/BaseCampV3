"""Page content helpers shared by the tree and page routes: the empty
Tiptap document new pages start from, and plain-text extraction from a
document for `content_text`/`draft_text` (search indexing, previews).

Task 5 extends this module with the editor schema itself and asset-key
rewriting; this Phase-1 slice only needs the empty doc and a flattener.
"""
from __future__ import annotations

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
