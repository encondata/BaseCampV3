"""File uploads (presigned PUT), file versions, and page assets — the
non-HTTP rules behind the upload routes: naming (`sanitize_filename`),
preview/extraction classification (`preview_kind_for`, `needs_extract`,
and the status they start a version at), the signed claim that
authorizes a browser's direct-to-storage PUT (`make_upload_token`/
`read_upload_token`), and queuing background work (`enqueue`).

An upload never passes bytes through the API process: `POST
/wiki/uploads` (routes/wiki/files.py) hands the browser a presigned PUT
URL it writes to directly, then `POST /wiki/uploads/complete` verifies
the object landed (`storage.head_object`) before creating the file
node/version or page-asset row. The upload token is the only state kept
between those two calls — there's no upload table.

Storage keys are not unique to one row: a copied file or page asset, a
restored file version, and a replayed upload token (same person, same
key) all point at the same object — so any future purge must
reference-count a key across `wiki_file_versions` and `wiki_page_assets`
before deleting the object.
"""
from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath
from typing import Any

import jwt
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import WikiJob

UPLOAD_TOKEN_AUD = "wiki-upload"
UPLOAD_TOKEN_TTL = timedelta(hours=1)

# Office formats the worker converts to a PDF for preview (soffice
# --headless --convert-to pdf) — everything else is either rendered
# natively or gets no preview at all.
OFFICE_EXTS = {".doc", ".docx", ".odt", ".rtf", ".xls", ".xlsx", ".ods",
              ".ppt", ".pptx", ".odp"}

# extensions treated as text even when the declared content-type doesn't
# start with "text/" (.md/.json/.csv/.log commonly arrive as
# application/* or with no recognizable browser-supplied type at all)
TEXT_LIKE_EXTS = {".md", ".csv", ".json", ".log"}

# markup a browser would run script from if the bucket served it inline —
# never previewed natively, never served inline (by type or extension,
# whichever says so)
ACTIVE_MARKUP_TYPES = {"image/svg+xml", "text/html", "application/xhtml+xml"}
ACTIVE_MARKUP_EXTS = {".svg", ".html", ".htm", ".xhtml"}

DEFAULT_CONTENT_TYPE = "application/octet-stream"
INLINE_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8"

_UNSAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._ -]")
_MULTI_WS_RE = re.compile(r"\s+")
_MAX_SAFE_FILENAME_LEN = 120
_MAX_TITLE_LEN = 200


class UploadTokenError(Exception):
    """The upload token is missing, expired, garbled, or wasn't minted
    for this purpose — the route turns this into 422 `stale_upload`."""


# ── naming ───────────────────────────────────────────────────────────


def _ext(filename: str) -> str:
    return PurePosixPath((filename or "").replace("\\", "/")).suffix.lower()


def sanitize_filename(name: str) -> str:
    """A safe filename for the storage key: only `[A-Za-z0-9._ -]`, runs
    of whitespace collapsed to one space, at most 120 characters, and
    never empty (falls back to "file"). Path separators — and everything
    before the last one — are dropped first, so a path-traversal attempt
    like "../../etc/passwd" becomes "passwd". This is for the storage
    key only; the node title and the version's display filename keep the
    caller's original name (see `display_filename`)."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    base = _UNSAFE_FILENAME_RE.sub("", base)
    base = _MULTI_WS_RE.sub(" ", base).strip(" .")
    base = base[:_MAX_SAFE_FILENAME_LEN].strip(" .")
    return base or "file"


def display_filename(name: str) -> str:
    """The name shown to users and stored on the version/node: the
    caller's original filename, trimmed to fit `wiki_nodes.title`'s
    200-character cap. Unlike `sanitize_filename` this doesn't restrict
    the character set — only the storage key needs that."""
    trimmed = (name or "").strip()[:_MAX_TITLE_LEN].strip()
    return trimmed or "file"


# ── content types ────────────────────────────────────────────────────


def normalize_content_type(content_type: str | None) -> str:
    """The bare, lowercased media type — parameters (`; charset=…`)
    dropped — or application/octet-stream when none was given. Done once
    at upload start; everything stored and every rule below sees only
    this form, so `image/svg+xml; charset=utf-8` can't slip past a check
    for `image/svg+xml`."""
    bare = (content_type or "").split(";")[0].strip().lower()
    return bare or DEFAULT_CONTENT_TYPE


def _is_active_markup(filename: str, content_type: str) -> bool:
    return (normalize_content_type(content_type) in ACTIVE_MARKUP_TYPES
            or _ext(filename) in ACTIVE_MARKUP_EXTS)


def _is_inline_media(content_type: str) -> bool:
    """Types a browser only ever renders as media: images (never svg —
    see ACTIVE_MARKUP_TYPES), video, audio, and PDF."""
    ct = normalize_content_type(content_type)
    if ct in ACTIVE_MARKUP_TYPES:
        return False
    return ct.startswith(("image/", "video/", "audio/")) or ct == "application/pdf"


# ── preview / extraction classification ─────────────────────────────


def is_text_like(filename: str, content_type: str) -> bool:
    """Previewed/extracted/served as plain text: an explicit `text/*`
    type, or one of the extensions upload clients often mislabel or
    leave generic (.md, .csv, .json, .log)."""
    ct = normalize_content_type(content_type)
    return ct.startswith("text/") or _ext(filename) in TEXT_LIKE_EXTS


def preview_kind_for(filename: str, content_type: str) -> str:
    """'native' (rendered directly: image, pdf, video, audio, text-like),
    'pdf' (an office document the worker converts), or 'none' (icon +
    metadata + download only). Active markup (SVG, HTML, XHTML) is
    'none' even though it's an image or text — shown inline it could run
    script on the bucket's origin."""
    if _is_active_markup(filename, content_type):
        return "none"
    if _is_inline_media(content_type) or is_text_like(filename, content_type):
        return "native"
    if _ext(filename) in OFFICE_EXTS:
        return "pdf"
    return "none"


def inline_content_type(filename: str, content_type: str,
                        preview_kind: str | None = None) -> str | None:
    """The `ResponseContentType` an inline (in-browser) view of this
    object may be served with, or None when it must be an attachment
    (served as application/octet-stream) instead. The one rule for every
    presigned read of an upload: only a native preview is ever inline;
    media (image except svg, video, audio, pdf) keeps its stored type;
    text-like files are forced to `text/plain` so the bucket's origin
    can never serve stored text back as something that runs script.
    `preview_kind` defaults to what `preview_kind_for` says; pass a
    version's stored kind to honor it."""
    if preview_kind is None:
        preview_kind = preview_kind_for(filename, content_type)
    if preview_kind != "native" or _is_active_markup(filename, content_type):
        return None
    if _is_inline_media(content_type):
        return normalize_content_type(content_type)
    if is_text_like(filename, content_type):
        return INLINE_TEXT_CONTENT_TYPE
    return None


def needs_extract(filename: str, content_type: str) -> bool:
    """Does this file get a `file_extract` job? PDFs, office documents
    (converted to a PDF first), and text-like files all carry searchable
    text; images/video/audio/everything else don't."""
    return (normalize_content_type(content_type) == "application/pdf"
            or _ext(filename) in OFFICE_EXTS or is_text_like(filename, content_type))


def preview_status_for(preview_kind: str) -> str:
    """The status a fresh version's `preview_kind` starts at: a native
    render needs no work, a pdf conversion is queued, anything else is
    skipped outright."""
    return {"native": "ready", "pdf": "pending", "none": "skipped"}[preview_kind]


def extract_status_for(filename: str, content_type: str) -> str:
    return "pending" if needs_extract(filename, content_type) else "skipped"


# ── upload tokens ───────────────────────────────────────────────────


def make_upload_token(claims: dict[str, Any]) -> str:
    """Sign `claims` (key, target, space_id, parent_id, node_id, page_id,
    filename, content_type, size, person) as a 1-hour JWT — the only
    state carried between `POST /uploads` and `POST /uploads/complete`."""
    now = datetime.now(UTC)
    payload = {**claims, "aud": UPLOAD_TOKEN_AUD, "iat": now, "exp": now + UPLOAD_TOKEN_TTL}
    secret = get_settings().jwt_secret.get_secret_value()
    return jwt.encode(payload, secret, algorithm="HS256")


def read_upload_token(tok: str) -> dict[str, Any]:
    """The claims `make_upload_token` signed. Raises `UploadTokenError`
    for anything expired, garbled, or minted for a different audience —
    the route turns that into 422 `stale_upload`."""
    secret = get_settings().jwt_secret.get_secret_value()
    try:
        return jwt.decode(tok, secret, algorithms=["HS256"], audience=UPLOAD_TOKEN_AUD,
                          options={"require": ["exp", "iat", "aud"]})
    except jwt.InvalidTokenError as exc:
        raise UploadTokenError(str(exc)) from exc


# ── background jobs ──────────────────────────────────────────────────


async def enqueue(db: AsyncSession, kind: str, *, node_id: uuid.UUID | None = None,
                  file_version_id: uuid.UUID | None = None,
                  payload: dict | None = None) -> WikiJob:
    """Queue background work (`file_preview` / `file_extract` / `purge`)
    for the Task 8 worker to pick up — the API only ever creates the row
    and reports its status; nothing here runs the job."""
    job = WikiJob(kind=kind, node_id=node_id, file_version_id=file_version_id,
                  payload=payload)
    db.add(job)
    await db.flush()
    return job

