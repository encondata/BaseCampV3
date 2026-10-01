"""Sirdar API. Every route lives under /api; the built SPA (when
SIRDAR_STATIC_DIR is set) is served from / — see _mount_spa."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text

from sirdar_api.config import get_settings
from sirdar_api.db.engine import dispose_engine, get_sessionmaker


@asynccontextmanager
async def _lifespan(app: FastAPI):
    yield
    await dispose_engine()


async def _db_ok() -> bool:
    try:
        async with get_sessionmaker()() as session:
            await session.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001 — health is a yes/no answer
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

    from sirdar_api.api.routes import access, audit, auth, system, users
    from sirdar_api.api.routes import settings as settings_routes

    api.include_router(auth.router)
    api.include_router(system.router)
    api.include_router(users.router)
    api.include_router(access.router)
    api.include_router(audit.router)
    api.include_router(settings_routes.router)

    app.include_router(api)

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        ok = await _db_ok()
        return JSONResponse({"status": "ok" if ok else "db_unreachable"},
                            status_code=200 if ok else 503)

    if settings.static_dir:
        _mount_spa(app, settings.static_dir)
    return app
