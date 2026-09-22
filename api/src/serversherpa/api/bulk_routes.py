"""Shared pieces of every bulk-import router (sites, workers, …): the rank
gate, the BulkImportError → 422 mapping, and the multipart-or-JSON row
reader. Each router keeps its own four endpoints because the template
reference lists and the commit signature are importer-specific."""

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException, Request

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.api.deps import AuthContext
from serversherpa.imports.bulk import BulkImportError


def require_bulk_rank(actor: AuthContext) -> None:
    """Bulk import is admin-and-up: the resource's `add` alone (staff hold
    it) is not enough — the blast radius of a thousand-row write warrants
    the same bar as the other rank-gated admin tooling."""
    if not actor.access.is_global or actor.access.max_rank < GATE_BYPASS_RANK:
        raise HTTPException(status_code=403, detail={"code": "forbidden"})


def bulk_http_error(exc: BulkImportError) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": exc.code, **exc.extra})


async def rows_from_request(
    request: Request, *,
    parse_upload: Callable[[str, bytes], list[tuple[int, dict]]],
    number_json_rows: Callable[[Any], list[tuple[int, dict]]],
) -> list[tuple[int, dict]]:
    """Multipart `file` → the importer's parse_upload; otherwise a JSON body
    `{"rows": [...]}` → its number_json_rows."""
    ctype = request.headers.get("content-type", "")
    try:
        if ctype.startswith("multipart/"):
            form = await request.form()
            upload = form.get("file")
            if upload is None or isinstance(upload, str):
                raise BulkImportError("missing_file")
            return parse_upload(upload.filename or "", await upload.read())
        body = await request.json()
        return number_json_rows(body.get("rows"))
    except BulkImportError as exc:
        raise bulk_http_error(exc) from None
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail={"code": "invalid_json"}) from None
