"""FastAPI app: GET /api/summary, GET /healthz, and the built page.
Read-only by construction — no route accepts anything but GET/HEAD."""

import asyncio
import contextlib
import time
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from serversherpa_status.checker import Checker, seed_tracker, utcnow
from serversherpa_status.config import Settings, load_settings, stale_after_seconds
from serversherpa_status.state import StateTracker
from serversherpa_status.store import Store
from serversherpa_status.summary import build_summary

SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
}
USER_AGENT = "ServerSherpa-Status/0.1"
# Unauthenticated public traffic can call /api/summary as fast as it likes;
# cache the built JSON briefly so it can't hammer SQLite. Invalidated early
# whenever a checker cycle completes, so cached data is never more than a
# beat behind a real state change.
SUMMARY_TTL_SECONDS = 5


def create_app(settings: Settings | None = None, *, start_checker: bool = True) -> FastAPI:
    settings = settings or load_settings()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store = Store(settings.db_path)
        tracker = StateTracker([s.key for s in settings.services], settings.failure_threshold)
        seed_tracker(tracker, store, settings)
        app.state.store = store
        app.state.tracker = tracker
        app.state.checker = None
        app.state.started_at = utcnow()
        app.state.summary_cache = None  # (monotonic_built_at, cycle_marker, body)
        client = httpx.AsyncClient(headers={"User-Agent": USER_AGENT})
        task = None
        if start_checker:
            checker = Checker(settings, store, tracker, client)
            app.state.checker = checker
            task = asyncio.create_task(checker.run_forever())
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

    @app.api_route("/api/summary", methods=["GET", "HEAD"])
    async def summary(request: Request) -> JSONResponse:
        state = request.app.state
        checker = state.checker
        cycle_marker = checker.last_cycle_at if checker is not None else None
        now_mono = time.monotonic()
        cached = state.summary_cache
        if cached is not None:
            built_at, cached_marker, body = cached
            if now_mono - built_at < SUMMARY_TTL_SECONDS and cached_marker == cycle_marker:
                return JSONResponse(body, headers={"Cache-Control": "no-store"})
        body = build_summary(settings, state.store, state.tracker, utcnow())
        state.summary_cache = (now_mono, cycle_marker, body)
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

    @app.api_route("/healthz", methods=["GET", "HEAD"])
    async def healthz(request: Request) -> JSONResponse:
        checker = request.app.state.checker
        if checker is None:
            return JSONResponse({"status": "ok"})
        now = utcnow()
        reference = checker.last_cycle_at or request.app.state.started_at
        if (now - reference).total_seconds() > stale_after_seconds(settings):
            return JSONResponse({"status": "stale"}, status_code=503)
        if not checker.store_ok:
            return JSONResponse({"status": "store_error"}, status_code=503)
        return JSONResponse({"status": "ok"})

    static = Path(settings.static_dir)
    if static.is_dir():
        app.mount("/", StaticFiles(directory=static, html=True), name="page")

    return app
