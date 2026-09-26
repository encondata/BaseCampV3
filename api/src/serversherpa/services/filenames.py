"""ASCII-safe filenames for HTTP headers, and the one filename-cleaning
primitive shared with `wiki.files.sanitize_filename`.

`services.storage.content_disposition` needs an ASCII fallback for a
Content-Disposition header's plain `filename=` parameter — RFC 6266
requires that token to be ASCII, so anything else has to be stripped or
replaced. `wiki.files.sanitize_filename` needs the same restricted
character set for storage keys (`[A-Za-z0-9._ -]`, whitespace
collapsed, 120 chars). Both go through `clean_filename` here — the
single source for the regexes and the length cap — kept in `services/`
so storage doesn't have to import the wiki package for it; `wiki.files`
imports this module instead of redefining the rules.

The one behavioral difference from a storage key: when a name's stem is
entirely outside that character set, the header fallback still keeps
the (already-ASCII) extension and falls the stem back to "file", so
"日本.png" reads as "file.png" instead of losing the extension
("png") or the whole name ("file").
"""
from __future__ import annotations

import re
from pathlib import PurePosixPath

_UNSAFE_RE = re.compile(r"[^A-Za-z0-9._ -]")
_MULTI_WS_RE = re.compile(r"\s+")
MAX_CLEAN_FILENAME_LEN = 120


def clean_filename(text: str) -> str:
    """`text` restricted to `[A-Za-z0-9._ -]`, runs of whitespace
    collapsed to one space, surrounding spaces/periods trimmed, and cut
    to `MAX_CLEAN_FILENAME_LEN` characters (trimmed again after the
    cut). May return "" — callers supply their own fallback."""
    text = _UNSAFE_RE.sub("", text)
    text = _MULTI_WS_RE.sub(" ", text).strip(" .")
    return text[:MAX_CLEAN_FILENAME_LEN].strip(" .")


def ascii_header_filename(name: str) -> str:
    """The ASCII-safe `filename=` fallback for a Content-Disposition
    header. Path separators — and anything before the last one — are
    dropped first. The stem and extension are cleaned separately so a
    non-ASCII (or otherwise unsafe) stem falls back to "file" while the
    extension survives; a name with no safe extension is just the
    cleaned stem (or "file")."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    path = PurePosixPath(base)
    suffix = clean_filename(path.suffix)
    stem = clean_filename(path.stem) or "file"
    return f"{stem}.{suffix}" if suffix else stem
