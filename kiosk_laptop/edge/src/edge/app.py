"""The edge app factory. State is built eagerly (not in lifespan) so tests
driving the app through httpx.ASGITransport — which runs no lifespan — see
the same app the container runs. The lifespan starts the background
probe/drain/sync loop and, on shutdown, stops it and closes the upstream
client and the store.

Routing: the edge's own routers and /config.js come first; the catch-all
proxies /auth, /kiosk and /system to the cloud (never /edge, and never a
path with a `.`/`..` segment, an encoded slash or an encoded `%`) and serves the kiosk's
web files for everything else. Only local Host names are answered."""

import asyncio
import json
from contextlib import asynccontextmanager
from urllib.parse import unquote

from fastapi import FastAPI, Request, Response
from fastapi.responses import PlainTextResponse

from edge import outbox, static
from edge.background import Background
from edge.config import Settings, load_settings
from edge.crypto import load_or_create_keys
from edge.db import Store
from edge.hostnet import DynamicHosts, HostCheckMiddleware, parse_host
from edge.identity import load_or_create
from edge.outbox import OutboxWorker
from edge.routes import auth as auth_routes
from edge.routes import edge as edge_routes
from edge.routes import kiosk as kiosk_routes
from edge.routes import proxy
from edge.routes import rfid as rfid_routes
from edge.rfid.discovery import Discovery
from edge.sync import Syncer
from edge.upstream import Upstream

API_PREFIXES = ("/auth/", "/kiosk/", "/system/", "/edge/")
LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]", "edge.test")  # edge.test: the test client


def escapes(request: Request) -> bool:
    """A `.`/`..` segment (however encoded) or an encoded slash: the cloud
    would resolve it to some other path than the one checked here."""
    raw = request.scope.get("raw_path") or request.url.path.encode()
    raw_path = raw.decode("latin-1").split("?", 1)[0]
    lowered = raw_path.lower()
    # %25 = an encoded "%": a double-encoded escape decoded again downstream
    if "%2f" in lowered or "%5c" in lowered or "%25" in lowered or "\\" in raw_path:
        return True
    return any(unquote(seg) in (".", "..") for seg in raw_path.split("/"))


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
                    await app.state.discovery.aclose()
                    await app.state.upstream.aclose()
                finally:
                    app.state.store.close()

    app = FastAPI(lifespan=lifespan, title="ServerSherpa Kiosk Edge", docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.hosts = DynamicHosts(settings.data_dir, [*LOCAL_HOSTS, *settings.allowed_hosts])
    app.add_middleware(HostCheckMiddleware, hosts=app.state.hosts)
    app.state.settings = settings
    app.state.identity = load_or_create(settings.data_dir)
    app.state.store = Store(settings.data_dir / "edge.db")
    app.state.keys = load_or_create_keys(settings.data_dir)
    app.state.upstream = Upstream(settings, app.state.store, app.state.keys, transport=transport)
    app.state.outbox = OutboxWorker(app.state.store, app.state.upstream,
                                    lambda: app.state.identity.serial)
    app.state.outbox_wake = asyncio.Event()
    outbox.requeue_sending(app.state.store)
    app.state.discovery = Discovery(
        app.state.store, settings.data_dir,
        own_connection=lambda: f"ServerSherpa Kiosk {app.state.identity.serial[-4:]} ")
    app.state.syncer = Syncer(app.state.store, app.state.upstream,
                              lambda: app.state.identity.serial)

    app.include_router(auth_routes.router)
    app.include_router(edge_routes.router)
    app.include_router(kiosk_routes.router)
    app.include_router(rfid_routes.router)

    @app.get("/config.js")
    async def config_js(request: Request) -> Response:
        ident = request.app.state.identity
        name = parse_host(request.headers.get("host", "")) or ""
        lan = name not in ("localhost", "127.0.0.1", "[::1]")
        body = (
            "window.__KIOSK_CONFIG__ = { apiUrl: window.location.origin, "
            f"portalUrl: {json.dumps(settings.portal_url)}, "
            '"mode": "laptop", '
            f'"lanAccess": {json.dumps(lan)}, '
            f'"identity": {json.dumps({"serial": ident.serial, "name": ident.name})} }};\n'
        )
        return PlainTextResponse(body, media_type="application/javascript",
                                 headers={"Cache-Control": "no-store"})

    @app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def catch_all(request: Request, full_path: str) -> Response:
        path = "/" + full_path
        if path.startswith(API_PREFIXES) and escapes(request):
            return Response(status_code=404)  # never proxied
        if path.startswith("/edge/"):
            return Response(status_code=404)  # the laptop's own namespace: never proxied
        if path.startswith(API_PREFIXES):
            return await proxy.forward(request, path)
        if request.method != "GET":
            return Response(status_code=404)
        return static.serve(settings.web_dir, path)

    return app
