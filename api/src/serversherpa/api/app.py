"""FastAPI application factory."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from serversherpa.api.routes import (
    access, asset_models, assets, attachments, auth, devtools, me, search,
    sites, stakeholders, status_values, users, workers,
)
from serversherpa.config import get_settings
from serversherpa.db.engine import dispose_engine


@asynccontextmanager
async def _lifespan(app: FastAPI):
    yield
    await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    is_prod = settings.env == "production"

    app = FastAPI(
        title="ServerSherpa API",
        version="0.1.0",
        lifespan=_lifespan,
        # interactive docs are a dev/staging tool, not a production surface
        docs_url=None if is_prod else "/docs",
        redoc_url=None,
        openapi_url=None if is_prod else "/openapi.json",
    )

    origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]
    # dev/staging: also accept any private-LAN origin so phones/laptops on the
    # local network can hit the dev servers; production stays allowlist-only
    origin_regex = None if is_prod else (
        r"^https?://(localhost|127\.0\.0\.1"
        r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
        r"|192\.168\.\d{1,3}\.\d{1,3}"
        r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$"
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=origin_regex,
        allow_credentials=True,  # refresh cookie on /auth/*
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    app.include_router(auth.router)
    app.include_router(access.router)
    app.include_router(users.router)
    app.include_router(me.router)
    app.include_router(search.router)
    app.include_router(attachments.router)
    app.include_router(stakeholders.clients_router)
    app.include_router(stakeholders.partners_router)
    app.include_router(stakeholders.people_router)
    app.include_router(stakeholders.external_router)
    app.include_router(workers.router)
    app.include_router(workers.levels_router)
    app.include_router(sites.router)
    app.include_router(sites.lookups_router)
    app.include_router(asset_models.router)
    app.include_router(asset_models.categories_router)
    app.include_router(assets.router)
    app.include_router(status_values.router)
    app.include_router(devtools.router)

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict:
        return {"status": "ok"}

    return app
