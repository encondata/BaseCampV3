"""FastAPI application factory."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from serversherpa.api.routes import (
    access, asset_models, assets, attachments, audit, auth, containers,
    devtools, initiatives, me, notes, search, sites, stakeholders,
    status_values, users, workers,
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
    # dev/staging: accept ANY origin — Jimmy reaches the dev stack from
    # phones/laptops via LAN IPs, .local mDNS names, and tunnel hostnames,
    # and the old private-IP-only regex silently blocked the non-RFC-1918
    # ones. The regex path echoes the caller's Origin (never "*"), so it
    # stays compatible with allow_credentials. Production stays
    # allowlist-only via SS_ALLOWED_ORIGINS.
    origin_regex = None if is_prod else r"^https?://.+$"
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
    app.include_router(containers.router)
    app.include_router(initiatives.router)
    app.include_router(notes.router)
    app.include_router(status_values.router)
    app.include_router(devtools.router)
    app.include_router(audit.router)

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict:
        return {"status": "ok"}

    return app
