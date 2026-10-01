"""The edge app factory. State is built eagerly (not in lifespan) so tests
driving the app through httpx.ASGITransport — which runs no lifespan — see
the same app the container runs; lifespan only starts background work."""

import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import PlainTextResponse

from edge import static
from edge.config import Settings, load_settings
from edge.crypto import load_or_create_keys
from edge.db import Store
from edge.identity import load_or_create
from edge.routes import edge as edge_routes
from edge.upstream import Upstream

API_PREFIXES = ("/auth/", "/kiosk/", "/system/")


def create_app(settings: Settings | None = None, *, transport=None) -> FastAPI:
    settings = settings or load_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await app.state.upstream.aclose()
        app.state.store.close()

    app = FastAPI(lifespan=lifespan, title="ServerSherpa Kiosk Edge", docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.settings = settings
    app.state.identity = load_or_create(settings.data_dir)
    app.state.store = Store(settings.data_dir / "edge.db")
    app.state.keys = load_or_create_keys(settings.data_dir)
    app.state.upstream = Upstream(settings, app.state.store, app.state.keys, transport=transport)

    app.include_router(edge_routes.router)

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
        if path.startswith(API_PREFIXES):
            return Response(status_code=404)  # replaced by the proxy in Task 6
        if request.method != "GET":
            return Response(status_code=404)
        return static.serve(settings.web_dir, path)

    return app
