"""ProseMirror JSON → Markdown, for Markdown exports (spec §8).

`to_markdown(doc, refs=..., title=...)` writes GitHub-flavored Markdown
for the shared schema's nodes and marks: headings, paragraphs with bold /
italic / code / strike / links (underline, highlight, sub- and
superscript have no Markdown form and keep just their text), bullet /
ordered / task lists, GFM tables, fenced code blocks with their
language, callouts as a blockquote under a bold label line, details as a
`<details>` HTML block, images, @mentions as `@label`, page links and
file embeds.

What a document says about things outside itself — another page, an
internal `/n/<id>` link, an uploaded image, an embedded file — is asked
of a `MarkdownRefs`; the default knows nothing (links become their text,
images a placeholder), and an export's subclass answers with relative
paths inside its zip. Text is escaped so it never reads as Markdown it
wasn't. A document nested deeper than MAX_DEPTH degrades to its plain
text below that depth rather than exhausting the stack."""
from __future__ import annotations

import html
import re
from typing import Any
from urllib.parse import quote

from serversherpa.wiki.content import PUBLIC_FILE_TEXT, PUBLIC_PAGE_TEXT, doc_text

# how deep blocks nest before the rest is written as plain text
MAX_DEPTH = 100

CALLOUT_LABELS = {"info": "Info", "tip": "Tip", "warning": "Warning", "danger": "Danger"}

# the only link targets kept as links when nothing resolves them
_WEB_HREF = re.compile(r"^(https?:|mailto:|tel:)", re.IGNORECASE)

# characters that could start Markdown syntax anywhere in a line
_ESCAPE = re.compile(r"([\\`*_\[\]<>|~])")
# ...or only at the start of one
_LINE_START = re.compile(r"^(\s*)([#>+=-]|\d+[.)])")

# emphasis marks, outermost first (a link wraps them; code is innermost)
_EMPHASIS = {"bold": "**", "italic": "*", "strike": "~~"}
_MARK_ORDER = ("link", "bold", "italic", "strike", "code")


class MarkdownRefs:
    """How references to things outside the document read. Override any
    of these; each returns the text to show and, optionally, the target
    to link it to (a URL or a relative path — the serializer encodes it)."""

    def page_link(self, node_id: str | None) -> tuple[str, str | None]:
        """A `pageLink` to `node_id`: (text, href or None)."""
        return PUBLIC_PAGE_TEXT, None

    def link_href(self, href: str) -> str | None:
        """Where a `link` mark to `href` points, or None to keep only its
        text. By default web, mail and phone links stay; internal `/n/`
        routes don't (they mean nothing outside the wiki)."""
        return href if _WEB_HREF.match(href) else None

    def image(self, asset_id: str | None) -> str | None:
        """Where the page's image `asset_id` is, or None for a placeholder."""
        return None

    def file_embed(self, *, node_id: str | None, asset_id: str | None,
                   filename: str) -> tuple[str, str | None]:
        """A `fileEmbed` of a wiki file node (`node_id`) or of the page's
        own upload (`asset_id`, named `filename`): (text, href or None)."""
        if node_id:
            return PUBLIC_FILE_TEXT, None
        return filename or PUBLIC_FILE_TEXT, None


def _attr(node: dict, name: str) -> Any:
    attrs = node.get("attrs")
    return attrs.get(name) if isinstance(attrs, dict) else None


def _str_attr(node: dict, name: str) -> str:
    value = _attr(node, name)
    return value if isinstance(value, str) else ""


def _children(node: dict) -> list[dict]:
    content = node.get("content")
    if not isinstance(content, list):
        return []
    return [c for c in content if isinstance(c, dict)]


def escape(text: str) -> str:
    """`text` with every character that could start Markdown escaped."""
    return _ESCAPE.sub(r"\\\1", text)


def _escape_line_start(text: str) -> str:
    """Escape what would make a paragraph read as a heading, quote, list
    item or setext underline."""
    match = _LINE_START.match(text)
    if not match:
        return text
    lead, marker = match.groups()
    return f"{lead}{marker[:-1]}\\{marker[-1]}{text[match.end():]}" if marker[-1] in ".)" \
        else f"{lead}\\{text[len(lead):]}"


def md_url(href: str) -> str:
    """`href` safe inside `(…)`: spaces, parentheses and non-ASCII
    percent-encoded; anything already encoded kept."""
    return quote(href, safe="/:?#[]@!$&'*+,;=%~")


def _code_span(text: str) -> str:
    runs = [len(r) for r in re.findall(r"`+", text)]
    fence = "`" * (max(runs) + 1 if runs else 1)
    pad = " " if runs or text.startswith(" ") or text.endswith(" ") else ""
    return f"{fence}{pad}{text}{pad}{fence}"


class _Writer:
    def __init__(self, refs: MarkdownRefs):
        self.refs = refs

    # ── inline ──────────────────────────────────────────────────────

    def _marks(self, node: dict) -> list[tuple[str, str | None]]:
        """The node's markdown-relevant marks as (kind, href), outermost
        first. A link whose target resolves to nothing is left out."""
        found: dict[str, str | None] = {}
        for mark in node.get("marks") or []:
            if not isinstance(mark, dict):
                continue
            kind = mark.get("type")
            if kind == "link":
                href = _str_attr(mark, "href")
                target = self.refs.link_href(href) if href else None
                if target:
                    found["link"] = target
            elif kind in _EMPHASIS or kind == "code":
                found[kind] = None
        return [(k, found[k]) for k in _MARK_ORDER if k in found]

    def inline(self, nodes: list[dict], *, in_table: bool = False) -> str:
        """Inline content: text runs with their marks opened and closed
        as a stack (so adjacent runs share delimiters), whitespace kept
        outside the delimiters, atoms (mentions, page links, breaks)."""
        out: list[str] = []
        active: list[tuple[str, str | None]] = []
        pending = ""                      # trailing whitespace of the last run

        def close_to(depth: int) -> None:
            while len(active) > depth:
                kind, href = active.pop()
                if kind == "link":
                    out.append(f"]({md_url(href or '')})")
                elif kind == "code":
                    pass                  # a code span closes with its text
                else:
                    out.append(_EMPHASIS[kind])

        def open_marks(marks: list[tuple[str, str | None]]) -> None:
            for kind, href in marks[len(active):]:
                if kind == "link":
                    out.append("[")
                elif kind in _EMPHASIS:
                    out.append(_EMPHASIS[kind])
                if kind != "code":
                    active.append((kind, href))

        def emit(text: str, marks: list[tuple[str, str | None]], *, raw: bool = False) -> None:
            nonlocal pending
            code = any(k == "code" for k, _ in marks)
            marks = [m for m in marks if m[0] != "code"]
            stripped = text.strip()
            if not stripped:                      # whitespace keeps the current marks
                pending += text
                return
            lead = text[:len(text) - len(text.lstrip())]
            trail = text[len(text.rstrip()):]
            common = 0
            while common < min(len(active), len(marks)) and active[common] == marks[common]:
                common += 1
            close_to(common)
            out.append(pending)
            pending = ""
            out.append(lead)
            open_marks(marks)
            if code:
                # GFM splits table cells on `|` before reading code spans
                out.append(_code_span(stripped.replace("|", "\\|") if in_table else stripped))
            else:
                out.append(stripped if raw else escape(stripped))
            pending = trail

        for node in nodes:
            kind = node.get("type")
            if kind == "text":
                text = node.get("text")
                if isinstance(text, str) and text:
                    emit(text, self._marks(node))
            elif kind == "hardBreak":
                close_to(0)
                out.append(pending)
                pending = ""
                out.append("<br>" if in_table else "\\\n")
            elif kind == "mention":
                emit(f"@{_str_attr(node, 'label')}", self._marks(node))
            elif kind == "pageLink":
                label, href = self.refs.page_link(_attr(node, "nodeId") or None)
                marks = [m for m in self._marks(node) if m[0] != "link"]
                if href:
                    marks = [("link", href), *marks]
                emit(label, marks)
        close_to(0)
        out.append(pending)
        return "".join(out)

    # ── blocks ──────────────────────────────────────────────────────

    def blocks(self, nodes: list[dict], depth: int) -> str:
        parts = [self.block(n, depth) for n in nodes]
        return "\n\n".join(p for p in parts if p)

    def block(self, node: dict, depth: int) -> str:
        if depth > MAX_DEPTH:
            return escape(doc_text(node))
        kind = node.get("type")
        content = _children(node)
        if kind == "paragraph":
            # every line: a hard break starts a new one
            return "\n".join(_escape_line_start(line)
                             for line in self.inline(content).split("\n"))
        if kind == "heading":
            level = _attr(node, "level")
            level = level if isinstance(level, int) and 1 <= level <= 6 else 1
            text = self.inline(content)
            return f"{'#' * level} {text}" if text else ""
        if kind in ("bulletList", "orderedList", "taskList"):
            return self.list(node, kind, depth)
        if kind == "blockquote":
            return _prefix(self.blocks(content, depth + 1), "> ")
        if kind == "callout":
            variant = _str_attr(node, "variant")
            label = CALLOUT_LABELS.get(variant, CALLOUT_LABELS["info"])
            body = self.blocks(content, depth + 1)
            return _prefix(f"**{label}**" + (f"\n\n{body}" if body else ""), "> ")
        if kind == "codeBlock":
            text = "".join(c.get("text", "") for c in content
                           if c.get("type") == "text" and isinstance(c.get("text"), str))
            runs = [len(r) for r in re.findall(r"`{3,}", text)]
            fence = "`" * (max(runs) + 1 if runs else 3)
            language = _str_attr(node, "language").strip()
            language = language if re.fullmatch(r"[\w+#.-]+", language) else ""
            return f"{fence}{language}\n{text}\n{fence}"
        if kind == "horizontalRule":
            return "---"
        if kind == "table":
            return self.table(node)
        if kind == "details":
            return self.details(node, depth)
        if kind == "wikiImage":
            return self.image(node)
        if kind == "fileEmbed":
            label, href = self.refs.file_embed(
                node_id=_attr(node, "nodeId") or None, asset_id=_attr(node, "assetId") or None,
                filename=_str_attr(node, "filename"))
            return f"[{escape(label)}]({md_url(href)})" if href else escape(label)
        # an unknown block: whatever it holds
        return self.blocks(content, depth + 1)

    def list(self, node: dict, kind: str, depth: int) -> str:
        start = _attr(node, "start")
        number = start if isinstance(start, int) and start >= 0 else 1
        lines: list[str] = []
        for entry in _children(node):
            if kind == "orderedList":
                marker = f"{number}. "
                number += 1
            elif kind == "taskList":
                marker = f"- [{'x' if _attr(entry, 'checked') else ' '}] "
            else:
                marker = "- "
            body = self.blocks(_children(entry), depth + 1)
            indent = " " * (2 if kind == "taskList" else len(marker))
            item_lines = body.split("\n") if body else [""]
            lines.append(marker + item_lines[0])
            lines.extend(indent + line if line else "" for line in item_lines[1:])
        return "\n".join(lines)

    def table(self, node: dict) -> str:
        rows = []
        for row in _children(node):
            cells = []
            for cell in _children(row):
                text = "<br>".join(filter(None, (
                    self.inline(_children(b), in_table=True) if b.get("type") in (
                        "paragraph", "heading") else escape(doc_text(b))
                    for b in _children(cell))))
                cells.append(text)
            rows.append(cells)
        if not rows:
            return ""
        width = max(len(r) for r in rows) or 1
        lines = []
        for i, cells in enumerate(rows):
            cells = cells + [""] * (width - len(cells))
            lines.append("| " + " | ".join(cells) + " |")
            if i == 0:
                lines.append("|" + " --- |" * width)
        return "\n".join(lines)

    def details(self, node: dict, depth: int) -> str:
        summary = ""
        body = ""
        for child in _children(node):
            if child.get("type") == "detailsSummary":
                summary = html.escape(doc_text(child), quote=False)
            elif child.get("type") == "detailsContent":
                body = self.blocks(_children(child), depth + 1)
        parts = ["<details>", f"<summary>{summary}</summary>"]
        return "\n".join(parts) + (f"\n\n{body}" if body else "") + "\n\n</details>"

    def image(self, node: dict) -> str:
        alt = _str_attr(node, "alt")
        caption = _str_attr(node, "caption")
        src = self.refs.image(_attr(node, "assetId") or None)
        line = f"![{escape(alt)}]({md_url(src)})" if src \
            else f"*{escape(f'[Image: {alt}]' if alt else '[Image]')}*"
        return f"{line}\n*{escape(caption)}*" if caption else line


def _prefix(text: str, prefix: str) -> str:
    """Every line of `text` prefixed (blank lines get the prefix trimmed)."""
    return "\n".join((prefix + line) if line else prefix.rstrip()
                     for line in text.split("\n"))


def to_markdown(doc: Any, *, refs: MarkdownRefs | None = None,
                title: str | None = None) -> str:
    """The document as Markdown, ending with a newline ("" when there is
    nothing to write). `title`, when given, heads it as a level-1 heading."""
    writer = _Writer(refs or MarkdownRefs())
    body = writer.blocks(_children(doc), 1) if isinstance(doc, dict) else ""
    if title:
        body = f"# {escape(title)}" + (f"\n\n{body}" if body else "")
    return f"{body}\n" if body else ""
