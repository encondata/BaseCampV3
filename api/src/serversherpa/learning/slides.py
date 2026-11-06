"""Slides reading style: a document's stored HTML cut into slides.

Each top-level level-2 heading starts a slide; what comes before the first
one is the opening slide (dropped when it is only whitespace). A heading
inside a callout, list or any other container is part of that block, not a
cut. Slides are exact substrings of the input (no re-serialization), so a
presigned image URL or an escaped entity comes through untouched, and the
same function serves stored, translated and presigned HTML alike."""
from html.parser import HTMLParser
from itertools import pairwise

# elements with no end tag, so they never hold the nesting depth above zero
_VOID = frozenset({"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
                   "meta", "param", "source", "track", "wbr"})


class _Cuts(HTMLParser):
    """Collects the offsets of the top-level `<h2>` start tags."""

    def __init__(self, text: str) -> None:
        super().__init__(convert_charrefs=False)
        self._line_starts = [0]
        for line in text.split("\n")[:-1]:
            self._line_starts.append(self._line_starts[-1] + len(line) + 1)
        self._depth = 0
        self.cuts: list[int] = []

    def _offset(self) -> int:
        line, col = self.getpos()
        return self._line_starts[line - 1] + col

    def handle_starttag(self, tag, attrs):
        if tag == "h2" and self._depth == 0:
            self.cuts.append(self._offset())
        if tag not in _VOID:
            self._depth += 1

    def handle_startendtag(self, tag, attrs):
        if tag == "h2" and self._depth == 0:
            self.cuts.append(self._offset())

    def handle_endtag(self, tag):
        if tag not in _VOID and self._depth > 0:
            self._depth -= 1


def split_slides(html: str) -> list[str]:
    """The slides of `html`: at least one item (`[""]` for empty HTML,
    `[html]` when there is no top-level `<h2>`)."""
    parser = _Cuts(html)
    parser.feed(html)
    parser.close()
    if not parser.cuts:
        return [html]
    edges = [*parser.cuts, len(html)]
    slides = [html[start:end] for start, end in pairwise(edges)]
    opening = html[:parser.cuts[0]]
    return ([opening] if opening.strip() else []) + slides


def slide_count(html: str) -> int:
    return len(split_slides(html))
