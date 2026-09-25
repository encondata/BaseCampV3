"""ASCII-safe filenames for HTTP headers.

`services.storage.content_disposition` needs an ASCII fallback for a
Content-Disposition header's plain `filename=` parameter — RFC 6266
requires that token to be ASCII, so anything else has to be stripped or
replaced. This is the same restricted character set `wiki.files.
sanitize_filename` uses for storage keys (`[A-Za-z0-9._ -]`, whitespace
collapsed), kept in `services/` so storage doesn't have to import the
wiki package just for this — `wiki.files` may import it back if useful.

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
_MAX_LEN = 120


def _clean(text: str) -> str:
    text = _UNSAFE_RE.sub("", text)
    text = _MULTI_WS_RE.sub(" ", text).strip(" .")
    return text[:_MAX_LEN].strip(" .")


def ascii_header_filename(name: str) -> str:
    """The ASCII-safe `filename=` fallback for a Content-Disposition
    header. Path separators — and anything before the last one — are
    dropped first. The stem and extension are cleaned separately so a
    non-ASCII (or otherwise unsafe) stem falls back to "file" while the
    extension survives; a name with no safe extension is just the
    cleaned stem (or "file")."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    path = PurePosixPath(base)
    suffix = _clean(path.suffix)
    stem = _clean(path.stem) or "file"
    return f"{stem}.{suffix}" if suffix else stem
