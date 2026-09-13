"""FastAPI application factory."""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from serversherpa.api.routes import (
    access, ai, asset_models, assets, attachments, audit, auth, containers,
    devices, devtools, initiatives, kiosk, labels, me, notes, notifications,
    reports, scans, search, sites, stakeholders, status_provenance,
    status_rules, status_values, system, time as time_routes, trucks, users,
    warehouse, workers,
)
from serversherpa.config import get_settings
from serversherpa.db.engine import dispose_engine


@asynccontextmanager
async def _lifespan(app: FastAPI):
    import asyncio

    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    handler = install("api")
    heartbeat = start_heartbeat("api", "service")
    # Wait for the first heartbeat to land before serving traffic: it's the
    # write that creates the registry row (later ones just update it), and
    # without this a process that starts, handles one request, and shuts
    # down again (exactly what the wiring test below does) can race its own
    # first heartbeat and shut down before the row ever exists.
    # A DB blip (or, in tests, an asyncpg pool bound to a different
    # event loop — see test_cors_dev's cross-loop TestClient usage) must
    # never block startup, matching heartbeat_loop's own blanket except.
    # Verify the row is THIS process's fresh beat, by pid, not just existence.
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.db.models import SystemProcess
    for _ in range(50):
        try:
            async with get_sessionmaker()() as _check:
                row = await _check.get(SystemProcess, "api")
                if (row is not None and row.pid == os.getpid()
                        and row.heartbeat_at is not None
                        and row.stopped_at is None):
                    break
        except Exception:
            break
        await asyncio.sleep(0.05)
    try:
        yield
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
        handler.close()
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
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    app.include_router(auth.router)
    app.include_router(access.router)
    app.include_router(ai.router)
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
    app.include_router(trucks.router)
    app.include_router(warehouse.router)
    app.include_router(scans.router)
    app.include_router(status_rules.router)
    app.include_router(devices.router)
    app.include_router(kiosk.router)
    app.include_router(initiatives.router)
    app.include_router(time_routes.router)
    app.include_router(notes.router)
    app.include_router(labels.router)
    app.include_router(reports.router)
    app.include_router(status_values.router)
    app.include_router(status_provenance.router)
    app.include_router(devtools.router)
    app.include_router(audit.router)
    app.include_router(system.router)
    app.include_router(notifications.router)

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict:
        return {"status": "ok"}

    return app
