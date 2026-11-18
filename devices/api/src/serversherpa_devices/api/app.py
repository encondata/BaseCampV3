"""Devices API. JSON routes live under /api; enrollment, iOS manifests and
downloads get their own top-level prefixes (/enroll, /ota, /dl). The built
SPA (when DEVICES_STATIC_DIR is set) is served from / — see _mount_spa."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text

from serversherpa_devices.api.body_limit import BodyLimitMiddleware
from serversherpa_devices.api.routes import apple, apps, devices, enroll, install, updates, uploads
from serversherpa_devices.config import get_settings
from serversherpa_devices.db.engine import dispose_engine, get_sessionmaker
from serversherpa_devices.services import storage

log = logging.getLogger(__name__)

# Paths the SPA never answers: a miss under these is a 404, not index.html.
_NOT_SPA = ("api", "enroll", "ota", "dl")


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # The bucket is created on first start (a new stack has none). Never
    # fatal: the API still answers, and uploads fail until storage is back.
    # ensure_bucket logs its own storage errors; anything else is logged by
    # class only (messages can carry the endpoint URL).
    try:
        await storage.ensure_bucket()
    except Exception as exc:  # noqa: BLE001
        log.error("storage: ensure_bucket failed: %s", type(exc).__name__)
    yield
    await dispose_engine()


async def _db_ok() -> bool:
    try:
        async with get_sessionmaker()() as session:
            await session.execute(text("SELECT 1"))
        return True
    # Health is a yes/no answer.
    except Exception:  # noqa: BLE001
        return False


async def _health() -> JSONResponse:
    ok = await _db_ok()
    return JSONResponse({"status": "ok" if ok else "db_unreachable"},
                        status_code=200 if ok else 503)


def _mount_spa(app: FastAPI, static_dir: str) -> None:
    root = Path(static_dir).resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        first = path.split("/", 1)[0]
        if first in _NOT_SPA:
            raise HTTPException(status_code=404)
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(root / "index.html")


async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI's default 422, minus each item's "input" and "ctx": those echo
    what the client sent (secrets included) back into the response."""
    errors = [{k: v for k, v in err.items() if k not in ("input", "ctx")}
              for err in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


def create_app() -> FastAPI:
    settings = get_settings()
    prod = settings.env == "production"
    app = FastAPI(
        title="ServerSherpa Devices API",
        lifespan=_lifespan,
        docs_url=None if prod else "/api/docs",
        redoc_url=None,
        openapi_url=None if prod else "/api/openapi.json",
    )

    app.add_exception_handler(RequestValidationError, _validation_error)
    # Before routing, so before sign-in: form bodies are read before route deps run.
    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.max_request_body_bytes)

    api = APIRouter(prefix="/api")

    @api.get("/healthz")
    async def api_healthz():
        return await _health()

    api.include_router(apps.router)
    api.include_router(uploads.router)
    api.include_router(apple.router)
    api.include_router(devices.router)
    api.include_router(enroll.router)
    api.include_router(install.router)
    api.include_router(updates.router)
    app.include_router(api)
    app.include_router(enroll.public_router)
    app.include_router(install.public_router)

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        return await _health()

    if settings.static_dir:
        _mount_spa(app, settings.static_dir)
    return app
