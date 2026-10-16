"""`python -m edge serve`: the kiosk (8090) and the tag listener (8091) in ONE
process and one event loop. The SQLite database is opened with exclusive
locking by a single process, so both servers must share `app.state.store`.

The main app's lifespan (background loop, shutdown cleanup) runs once, through
its own server; the listener server runs with `lifespan="off"`.

The listener's request path carries the pairing token, so it must never reach
the access log. uvicorn's `access_log=False` can't do that per server: it clears
the handlers of the one process-wide `uvicorn.access` logger, which would also
silence the kiosk server. So a filter on that logger drops listener requests."""

import asyncio
import contextlib
import logging

import uvicorn

from edge.app import create_app
from edge.config import Settings
from edge.rfid.ingest import create_ingest_app


class DropIngestAccess(logging.Filter):
    """uvicorn access records are (client, method, path, http_version, status)."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        path = args[2] if isinstance(args, tuple) and len(args) >= 3 else ""
        return not str(path).startswith("/rfid/")


def hide_ingest_paths() -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, DropIngestAccess) for f in access.filters):
        access.addFilter(DropIngestAccess())


def ingest_config(app, *, host: str, port: int) -> uvicorn.Config:
    return uvicorn.Config(app, host=host, port=port, lifespan="off")


async def serve(*, host: str = "0.0.0.0", port: int = 8090, ingest_port: int = 8091,
                settings: Settings | None = None, ready: asyncio.Event | None = None) -> None:
    app = create_app(settings)
    ingest_app = create_ingest_app(app.state)
    main = uvicorn.Server(uvicorn.Config(app, host=host, port=port))
    ingest = uvicorn.Server(ingest_config(ingest_app, host=host, port=ingest_port))
    servers = (main, ingest)
    hide_ingest_paths()  # after both Configs: building a Config reconfigures logging

    async def announce() -> None:
        while not all(s.started for s in servers):
            await asyncio.sleep(0.02)
        if ready is not None:
            ready.set()

    async def run(server: uvicorn.Server) -> int:
        # uvicorn calls sys.exit(3) when it can't bind; a SystemExit escaping a task
        # would skip the other server's (and the main app's) shutdown
        try:
            await server.serve()
        except SystemExit as exc:
            return exc.code if isinstance(exc.code, int) else 1
        return 0

    tasks = [asyncio.create_task(run(main)), asyncio.create_task(run(ingest))]
    announcer = asyncio.create_task(announce())
    try:
        # when either server exits (or fails), stop the other
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        announcer.cancel()
        for s in servers:
            s.should_exit = True
        # shield: a cancel of serve() still lets both servers finish shutting down
        results = await asyncio.shield(asyncio.gather(*tasks, return_exceptions=True))
        with contextlib.suppress(asyncio.CancelledError):
            await announcer
    for r in results:
        if isinstance(r, BaseException) and not isinstance(r, asyncio.CancelledError):
            raise r
    code = next((r for r in results if isinstance(r, int) and r), 0)
    if code:
        raise SystemExit(code)  # the process still exits with uvicorn's failure code
