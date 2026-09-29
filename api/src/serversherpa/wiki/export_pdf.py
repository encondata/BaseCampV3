"""`python -m serversherpa.wiki.export_pdf IN.html OUT.pdf` — WeasyPrint in
a process of its own, so the wiki worker can time a page's conversion out
(and kill it) instead of one pathological page blocking the worker for
good. Run through `convert.run` by `export_html.html_to_pdf`."""
from __future__ import annotations

import os
import sys
from pathlib import Path

# WeasyPrint's own memory use for one page, past which it's killed rather
# than left to slowly starve the worker host
DEFAULT_MAX_MEMORY_MB = 2048


def _apply_memory_limit() -> None:
    """Cap this process's virtual address space (RLIMIT_AS) to
    `WIKI_EXPORT_PDF_MAX_MEMORY_MB` megabytes (default
    DEFAULT_MAX_MEMORY_MB) — read straight from the environment (this is
    a standalone subprocess entry point, not `Settings`), so a
    pathological page's WeasyPrint conversion hits MemoryError and dies
    instead of slowly exhausting the worker host. Best-effort and never
    fatal: the `resource` module doesn't exist on Windows, and even
    where it does, the platform may not honor RLIMIT_AS at all (macOS's
    kernel doesn't enforce it the way Linux's does) — either way, the
    export still runs; the container's own memory limit is the real
    backstop in production."""
    try:
        import resource
    except ImportError:  # pragma: no cover - Windows only
        return
    try:
        megabytes = int(os.environ.get(
            "WIKI_EXPORT_PDF_MAX_MEMORY_MB", str(DEFAULT_MAX_MEMORY_MB)))
    except ValueError:
        megabytes = DEFAULT_MAX_MEMORY_MB
    limit = megabytes * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (ValueError, OSError):
        pass       # not honored on this platform — nothing more to do


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: python -m serversherpa.wiki.export_pdf IN.html OUT.pdf", file=sys.stderr)
        return 2
    _apply_memory_limit()
    from serversherpa.wiki.export_html import render_pdf
    document = Path(argv[1]).read_text(encoding="utf-8")
    Path(argv[2]).write_bytes(render_pdf(document))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
