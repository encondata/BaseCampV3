"""Sirdar API. Every route lives under /api; the built SPA (when
SIRDAR_STATIC_DIR is set) is served from / — see _mount_spa."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text

from sirdar_api.config import get_settings
from sirdar_api.db.engine import dispose_engine, get_sessionmaker

log = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    from sirdar_api.deploy import pipeline

    try:
        await pipeline.recover_orphans()     # runs a previous process left "running"
    # A database hiccup must not stop the app starting.
    except Exception as e:  # noqa: BLE001
        log.warning("couldn't mark interrupted deployments at startup: %s", type(e).__name__)
    try:
        await pipeline.sweep_runs()          # run folders a crash left on disk
    # A disk problem must not stop the app starting.
    except Exception as e:  # noqa: BLE001
        log.warning("couldn't sweep stale runner folders at startup: %s", type(e).__name__)
    try:
        await pipeline.sweep_snapshots()     # half-written uploads (maybe plaintext keys)
    # A disk problem must not stop the app starting.
    except Exception as e:  # noqa: BLE001
        log.warning("couldn't sweep stale snapshot uploads at startup: %s", type(e).__name__)
    yield
    await pipeline.shutdown(timeout=pipeline.SHUTDOWN_SECONDS)   # runs end "interrupted"
    await dispose_engine()


async def _db_ok() -> bool:
    try:
        async with get_sessionmaker()() as session:
            await session.execute(text("SELECT 1"))
        return True
    # Health is a yes/no answer.
    except Exception:  # noqa: BLE001
        return False


def _mount_spa(app: FastAPI, static_dir: str) -> None:
    root = Path(static_dir).resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(root / "index.html")


async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI's default 422, minus each item's "input" and "ctx": those echo
    what the client sent (passwords included) back into the response."""
    errors = [{k: v for k, v in err.items() if k not in ("input", "ctx")}
              for err in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


def create_app() -> FastAPI:
    settings = get_settings()
    prod = settings.env == "production"
    app = FastAPI(
        title="Sirdar API",
        lifespan=_lifespan,
        docs_url=None if prod else "/api/docs",
        redoc_url=None,
        openapi_url=None if prod else "/api/openapi.json",
    )

    app.add_exception_handler(RequestValidationError, _validation_error)

    if settings.allowed_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.allowed_origin_list,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "X-Totp-Challenge"],
        )

    api = APIRouter(prefix="/api")

    @api.get("/healthz")
    async def api_healthz():
        ok = await _db_ok()
        return JSONResponse({"status": "ok" if ok else "db_unreachable"},
                            status_code=200 if ok else 503)

    from sirdar_api.api.routes import access, audit, auth, dashboard, deploy, me, system, users
    from sirdar_api.api.routes import integrations as integration_routes
    from sirdar_api.api.routes import settings as settings_routes

    api.include_router(auth.router)
    api.include_router(me.router)
    api.include_router(system.router)
    api.include_router(users.router)
    api.include_router(access.router)
    api.include_router(audit.router)
    api.include_router(settings_routes.router)
    api.include_router(deploy.router)
    api.include_router(integration_routes.router)
    api.include_router(dashboard.router)

    app.include_router(api)

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        ok = await _db_ok()
        return JSONResponse({"status": "ok" if ok else "db_unreachable"},
                            status_code=200 if ok else 503)

    if settings.static_dir:
        _mount_spa(app, settings.static_dir)
    return app
