"""The edge app factory. State is built eagerly (not in lifespan) so tests
driving the app through httpx.ASGITransport — which runs no lifespan — see
the same app the container runs; lifespan closes the upstream client and store on shutdown (and, later, runs background work)."""

import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import PlainTextResponse

from edge import outbox, static
from edge.background import Background
from edge.config import Settings, load_settings
from edge.crypto import load_or_create_keys
from edge.db import Store
from edge.identity import load_or_create
from edge.outbox import OutboxWorker
from edge.routes import auth as auth_routes
from edge.routes import edge as edge_routes
from edge.routes import kiosk as kiosk_routes
from edge.routes import proxy
from edge.sync import Syncer
from edge.upstream import Upstream

API_PREFIXES = ("/auth/", "/kiosk/", "/system/", "/edge/")


def create_app(settings: Settings | None = None, *, transport=None) -> FastAPI:
    settings = settings or load_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runner = Background(app.state) if settings.background else None
        app.state.background = runner
        try:
            if runner:
                runner.start()
            yield
        finally:
            try:
                if runner:
                    await runner.stop()
            finally:
                try:
                    await app.state.upstream.aclose()
                finally:
                    app.state.store.close()

    app = FastAPI(lifespan=lifespan, title="ServerSherpa Kiosk Edge", docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.settings = settings
    app.state.identity = load_or_create(settings.data_dir)
    app.state.store = Store(settings.data_dir / "edge.db")
    app.state.keys = load_or_create_keys(settings.data_dir)
    app.state.upstream = Upstream(settings, app.state.store, app.state.keys, transport=transport)
    app.state.outbox = OutboxWorker(app.state.store, app.state.upstream,
                                    lambda: app.state.identity.serial)
    app.state.outbox_wake = asyncio.Event()
    outbox.requeue_sending(app.state.store)
    app.state.syncer = Syncer(app.state.store, app.state.upstream,
                              lambda: app.state.identity.serial)

    app.include_router(auth_routes.router)
    app.include_router(edge_routes.router)
    app.include_router(kiosk_routes.router)

    @app.get("/config.js")
    async def config_js(request: Request) -> Response:
        ident = request.app.state.identity
        body = (
            "window.__KIOSK_CONFIG__ = { apiUrl: window.location.origin, "
            f"portalUrl: {json.dumps(settings.portal_url)}, "
            '"mode": "laptop", '
            f'"identity": {json.dumps({"serial": ident.serial, "name": ident.name})} }};\n'
        )
        return PlainTextResponse(body, media_type="application/javascript",
                                 headers={"Cache-Control": "no-store"})

    @app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def catch_all(request: Request, full_path: str) -> Response:
        path = "/" + full_path
        if path.startswith("/edge/"):
            return Response(status_code=404)  # the laptop's own namespace: never proxied
        if path.startswith(API_PREFIXES):
            return await proxy.forward(request, path)
        if request.method != "GET":
            return Response(status_code=404)
        return static.serve(settings.web_dir, path)

    return app
