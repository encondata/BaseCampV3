"""`python -m loadtest`: starts the load test page."""

from __future__ import annotations

import argparse
import errno
import os
import socket
import sys
from pathlib import Path

DEFAULT_PORT = 8795
DEFAULT_ROUTER_URL = "https://router.project-osrm.org"
DEFAULT_RUNS_DIR = Path(__file__).resolve().parents[2] / "runs"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m loadtest",
        description="Starts the move load test page. Routing service: "
                    "LOADTEST_ROUTER_URL (default %s)." % DEFAULT_ROUTER_URL)
    parser.add_argument("--host", default="0.0.0.0",
                        help="address to listen on (default 0.0.0.0, every network)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"port to listen on (default {DEFAULT_PORT})")
    parser.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR,
                        help="folder for run results (default: the runs folder next to the "
                             "tool)")
    return parser.parse_args(argv)


def lan_address() -> str:
    """This machine's LAN address. Connecting a UDP socket sends nothing."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def bind(host: str, port: int) -> socket.socket:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        sock.listen(128)
    except OSError as exc:
        sock.close()
        if exc.errno == errno.EADDRINUSE:
            sys.exit(f"Port {port} is already in use. Stop the program using it, or start "
                     f"with --port and another number.")
        sys.exit(f"Could not listen on {host} port {port}: {exc.strerror or 'refused'}.")
    return sock


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    sock = bind(args.host, args.port)

    import logging

    import uvicorn

    from .runner import Runner
    from .web.app import create_app

    runs_dir = args.runs_dir.resolve()
    runs_dir.mkdir(parents=True, exist_ok=True)
    runner = Runner(runs_dir=runs_dir,
                    router_url=os.environ.get("LOADTEST_ROUTER_URL") or DEFAULT_ROUTER_URL)
    app = create_app(runner)

    class _PathOnly(logging.Filter):
        """The access log shows the method and path, never a query string."""

        def filter(self, record: logging.LogRecord) -> bool:
            if isinstance(record.args, tuple) and len(record.args) >= 3:
                args = list(record.args)
                args[2] = str(args[2]).split("?", 1)[0]
                record.args = tuple(args)
            return True

    class _Server(uvicorn.Server):
        def handle_exit(self, sig, frame) -> None:
            # end the open event streams now, so shutdown does not wait on them
            loop = getattr(self, "_loop", None)
            if loop is not None:
                loop.call_soon_threadsafe(app.state.stopping.set)
            super().handle_exit(sig, frame)

        async def serve(self, sockets=None) -> None:
            import asyncio
            self._loop = asyncio.get_running_loop()
            await super().serve(sockets=sockets)

    config = uvicorn.Config(app, log_level="info", timeout_graceful_shutdown=5)
    server = _Server(config)
    logging.getLogger("uvicorn.access").addFilter(_PathOnly())

    shown = lan_address() if args.host in ("0.0.0.0", "::") else args.host
    print(f"Move load test: http://{shown}:{args.port}", flush=True)
    print(f"On this machine: http://localhost:{args.port}", flush=True)
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
