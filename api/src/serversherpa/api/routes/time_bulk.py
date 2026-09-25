"""Bulk Actions › Add time punches in bulk: template, preview, commit.
Admin rank and up (require_bulk_rank, which also requires a global actor)
plus time:add. The work lives in people/time_bulk.py."""

from fastapi import APIRouter, HTTPException, Request, Response

from serversherpa.api.bulk_routes import bulk_http_error, require_bulk_rank
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people import time_bulk

router = APIRouter(prefix="/time/bulk", tags=["time"])

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _attachment(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


async def _body(request: Request) -> tuple[list, dict, set, dict]:
    """(numbered rows, overrides, skip, raw body). Multipart is the first
    file preview, with no picks yet. JSON is a re-preview or the commit,
    re-posting the preview's cells with the spreadsheet row numbers."""
    try:
        if request.headers.get("content-type", "").startswith("multipart/"):
            form = await request.form()
            upload = form.get("file")
            if upload is None or isinstance(upload, str):
                raise BulkImportError("missing_file")
            numbered = time_bulk.parse_upload(upload.filename or "", await upload.read())
            return numbered, {}, set(), {}
        body = await request.json()
        if not isinstance(body, dict):
            raise BulkImportError("invalid_json")
        numbered = time_bulk.number_posted_rows(body.get("rows"), body.get("row_numbers"))
        overrides = time_bulk.parse_overrides(body.get("overrides"))
        skip = time_bulk.parse_row_list(body.get("skip"), "invalid_skip")
        return numbered, overrides, skip, body
    except BulkImportError as exc:
        raise bulk_http_error(exc) from None
    except ValueError:
        raise _err(422, "invalid_json") from None


@router.get("/template")
async def time_bulk_template(
    db: DbSession, format: str = "csv",
    actor: AuthContext = require_permission("time", "add"),
):
    require_bulk_rank(actor)
    if format == "csv":
        return Response(time_bulk.build_template_csv(), media_type="text/csv",
                        headers=_attachment("time-template.csv"))
    if format == "xlsx":
        return Response(await time_bulk.build_template_xlsx(db), media_type=_XLSX,
                        headers=_attachment("time-template.xlsx"))
    raise _err(422, "unknown_format")


@router.post("/preview")
async def time_bulk_preview(
    request: Request, db: DbSession,
    actor: AuthContext = require_permission("time", "add"),
) -> dict:
    require_bulk_rank(actor)
    numbered, overrides, skip, _ = await _body(request)
    return await time_bulk.preview_rows(db, numbered, overrides=overrides, skip=skip)


@router.post("/commit")
async def time_bulk_commit(
    request: Request, db: DbSession,
    actor: AuthContext = require_permission("time", "add"),
) -> dict:
    require_bulk_rank(actor)
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise _err(422, "invalid_json")
    numbered, overrides, skip, body = await _body(request)
    try:
        return await time_bulk.commit_rows(
            db, actor.person.id, numbered, overrides=overrides, skip=skip,
            source_label=str(body.get("source") or "upload"))
    except BulkImportError as exc:
        raise bulk_http_error(exc) from None
