"""Help links (spec §8): the rules behind `routes/wiki/help_links.py`.

A help context names a screen in another app — `portal:/bulk/time`,
`kiosk:/enroll` — as `<app>:<route path>`. Both sides go through
`normalize_context` (stored contexts on write, the requested one on
lookup), so the portal and the kiosk can send `location.pathname` as it
is: lowercased, query and hash dropped, repeated slashes collapsed, the
trailing slash dropped (except the root `/`), and every path segment
that is a UUID or all digits replaced with `:id` — so
`portal:/sites/5f0c…/` and `portal:/sites/:id` are one context.

A lookup matches the longest stored context that equals the requested
one or is a path prefix of it at a segment boundary (`context_prefixes`):
`portal:/bulk` covers `portal:/bulk/time` but not `portal:/bulkx`."""
from __future__ import annotations

import re

from serversherpa.config import get_settings

CONTEXT_MAX_LENGTH = 300   # wiki_help_links.context is CHECKed to 1-300 characters

# what a stored context may look like once normalized
CONTEXT_RE = re.compile(r"^(portal|kiosk):/[a-z0-9/_:-]*$")

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_DIGITS_RE = re.compile(r"^[0-9]+$")
_SLASHES_RE = re.compile(r"/{2,}")


def _segment(seg: str) -> str:
    return ":id" if _UUID_RE.match(seg) or _DIGITS_RE.match(seg) else seg


def normalize_context(raw: str) -> str:
    """The canonical form of a context (see the module docstring). Only
    the part after the first `:` is treated as a path; something with no
    `:` comes back lowercased and trimmed, and fails `is_valid_context`."""
    text = raw.strip().lower().split("#", 1)[0].split("?", 1)[0]
    app, sep, path = text.partition(":")
    if not sep:
        return text
    path = _SLASHES_RE.sub("/", path)
    if len(path) > 1:
        path = path.rstrip("/")
    return f"{app}:{'/'.join(_segment(s) for s in path.split('/'))}"


def is_valid_context(context: str) -> bool:
    """Whether an already-normalized context may be stored."""
    return len(context) <= CONTEXT_MAX_LENGTH and CONTEXT_RE.match(context) is not None


def context_prefixes(context: str) -> list[str]:
    """Every context a normalized `context` falls under, longest first:
    itself, then each shorter path at a segment boundary, down to the
    app's root (`portal:/bulk/time` → `portal:/bulk/time`, `portal:/bulk`,
    `portal:/`). Empty when it isn't `<app>:/<path>` at all."""
    app, sep, path = context.partition(":")
    if not sep or not app or not path.startswith("/"):
        return []
    segments = [s for s in path.split("/") if s]
    paths = ["/" + "/".join(segments[:n]) for n in range(len(segments), 0, -1)]
    return [f"{app}:{p}" for p in [*paths, "/"]]


def guide_url(node_id: object) -> str:
    """Where the wiki SPA shows a node: `/n/<id>`."""
    return f"{get_settings().wiki_origin.rstrip('/')}/n/{node_id}"
