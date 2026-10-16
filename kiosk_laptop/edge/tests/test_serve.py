import asyncio
import logging
import signal
import socket
import subprocess
import sys

import httpx
import pytest

from edge import serve as serve_mod
from edge.db import Store


@pytest.fixture(autouse=True)
def keep_signal_handlers():
    saved = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    yield
    for sig, handler in saved.items():
        signal.signal(sig, handler)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _start(settings, **kw):
    port, ingest = free_port(), free_port()
    ready = asyncio.Event()
    task = asyncio.create_task(serve_mod.serve(host="127.0.0.1", port=port, ingest_port=ingest,
                                               settings=settings, ready=ready, **kw))
    waiter = asyncio.create_task(ready.wait())
    await asyncio.wait({task, waiter}, timeout=10, return_when=asyncio.FIRST_COMPLETED)
    if task.done():
        task.result()
    assert ready.is_set()
    return task, port, ingest


async def _stop(task):
    task.cancel()
    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)


async def test_serve_answers_on_both_ports(settings):
    task, port, ingest = await _start(settings)
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(f"http://127.0.0.1:{port}/edge/identity")
            assert r.status_code == 200
            r = await c.post(f"http://127.0.0.1:{ingest}/rfid/x/y", content=b"[]")
            assert r.status_code == 404
    finally:
        await _stop(task)
    assert task.done()


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record):
        self.lines.append(record.getMessage())


async def test_ingest_requests_are_not_access_logged(settings):
    # uvicorn's access logger doesn't propagate, so hook it directly
    task, port, ingest = await _start(settings)
    cap = _Capture()
    access = logging.getLogger("uvicorn.access")
    access.addHandler(cap)
    try:
        async with httpx.AsyncClient() as c:
            await c.post(f"http://127.0.0.1:{ingest}/rfid/SERIAL1/SECRETTOKEN", content=b"[]")
            await c.get(f"http://127.0.0.1:{port}/edge/identity")
    finally:
        access.removeHandler(cap)
        await _stop(task)
    assert any("/edge/identity" in line for line in cap.lines)  # the capture does work
    assert not any("SECRETTOKEN" in line or "/rfid/" in line for line in cap.lines)


def test_ingest_config_has_no_lifespan():
    cfg = serve_mod.ingest_config(object(), host="127.0.0.1", port=1234)
    assert cfg.lifespan == "off"


def test_access_filter_drops_only_ingest_paths():
    f = serve_mod.DropIngestAccess()

    def rec(path):
        return logging.LogRecord("uvicorn.access", logging.INFO, "", 0,
                                 '%s - "%s %s HTTP/%s" %d',
                                 ("1.2.3.4:5", "POST", path, "1.1", 404), None)

    assert not f.filter(rec("/rfid/SER/TOKEN"))
    assert f.filter(rec("/edge/identity"))


def test_cli_has_serve():
    out = subprocess.run([sys.executable, "-m", "edge", "serve", "--help"],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0
    assert "--ingest-port" in out.stdout


@pytest.mark.parametrize("busy", ["ingest", "main"])
async def test_port_in_use_exits_3_after_clean_shutdown(settings, monkeypatch, busy):
    closed = []
    real_close = Store.close
    # the main app's lifespan shutdown ends by closing the store
    monkeypatch.setattr(Store, "close", lambda self: (closed.append(1), real_close(self))[1])
    port, ingest = free_port(), free_port()
    with socket.socket() as blocker:
        blocker.bind(("127.0.0.1", ingest if busy == "ingest" else port))
        blocker.listen()
        with pytest.raises(SystemExit) as exc:
            await asyncio.wait_for(
                serve_mod.serve(host="127.0.0.1", port=port, ingest_port=ingest,
                                settings=settings), 15)
    assert exc.value.code == 3
    assert closed
