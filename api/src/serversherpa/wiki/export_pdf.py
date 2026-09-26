"""`python -m serversherpa.wiki.export_pdf IN.html OUT.pdf` — WeasyPrint in
a process of its own, so the wiki worker can time a page's conversion out
(and kill it) instead of one pathological page blocking the worker for
good. Run through `convert.run` by `export_html.html_to_pdf`."""
from __future__ import annotations

import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: python -m serversherpa.wiki.export_pdf IN.html OUT.pdf", file=sys.stderr)
        return 2
    from serversherpa.wiki.export_html import render_pdf
    document = Path(argv[1]).read_text(encoding="utf-8")
    Path(argv[2]).write_bytes(render_pdf(document))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
