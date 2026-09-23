"""FastAPI app: GET /api/summary, GET /healthz, and the built page.
Read-only by construction — no route accepts anything but GET/HEAD."""

import asyncio
import contextlib
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from serversherpa_status.checker import Checker, seed_tracker, utcnow
from serversherpa_status.config import Settings, load_settings
from serversherpa_status.state import StateTracker
from serversherpa_status.store import Store
from serversherpa_status.summary import build_summary

SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
}
USER_AGENT = "ServerSherpa-Status/0.1"


def create_app(settings: Settings | None = None, *, start_checker: bool = True) -> FastAPI:
    settings = settings or load_settings()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store = Store(settings.db_path)
        tracker = StateTracker([s.key for s in settings.services], settings.failure_threshold)
        seed_tracker(tracker, store, settings)
        app.state.store = store
        app.state.tracker = tracker
        client = httpx.AsyncClient(headers={"User-Agent": USER_AGENT})
        task = None
        if start_checker:
            task = asyncio.create_task(Checker(settings, store, tracker, client).run_forever())
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await client.aclose()
            store.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.update(SECURITY_HEADERS)
        return response

    @app.get("/api/summary")
    async def summary(request: Request) -> JSONResponse:
        body = build_summary(settings, request.app.state.store, request.app.state.tracker, utcnow())
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok"}

    static = Path(settings.static_dir)
    if static.is_dir():
        app.mount("/", StaticFiles(directory=static, html=True), name="page")

    return app
