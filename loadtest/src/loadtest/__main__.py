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
# assumes an editable install or a source checkout: loadtest/runs next to src/
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
    parser.add_argument("--allow-host", action="append", default=[], metavar="NAME",
                        help="another name the page may be opened by, such as a reverse "
                             "proxy's (repeatable)")
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


WILDCARD = ("0.0.0.0", "::", "")


def is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    import ipaddress
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def allowed_hosts(host: str, lan: str, extra: list[str]) -> list[str]:
    """Every name the page may be opened by: this machine's names and addresses."""
    names = ["localhost", "127.0.0.1", "::1", lan]
    hostname = socket.gethostname().lower()
    if hostname:
        base = hostname.removesuffix(".local")
        names += [base, base + ".local", hostname]
    if host not in WILDCARD:
        names.append(host)
    names += extra
    return list(dict.fromkeys(n for n in names if n))


def bind(host: str, port: int) -> socket.socket:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        if os.name != "nt":     # on Windows it would let a second server share the port
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

    import secrets

    import uvicorn

    from .runner import Runner
    from .web.app import create_app

    runs_dir = args.runs_dir.resolve()
    runs_dir.mkdir(parents=True, exist_ok=True)
    runner = Runner(runs_dir=runs_dir,
                    router_url=os.environ.get("LOADTEST_ROUTER_URL") or DEFAULT_ROUTER_URL)
    lan = lan_address()
    # a proxy makes everyone arrive from loopback, so --allow-host also needs the key
    keyed = not is_loopback(args.host) or bool(args.allow_host)
    access_key = secrets.token_urlsafe(24) if keyed else None
    app = create_app(runner, allowed_hosts=allowed_hosts(args.host, lan, args.allow_host),
                     access_key=access_key, cookie_name=f"loadtest_key_{args.port}")

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

    # no access log: the printed link's ?key= must never be logged. No proxy headers:
    # the client address is the real peer, never one a request claims.
    config = uvicorn.Config(app, log_level="info", timeout_graceful_shutdown=5,
                            access_log=False, proxy_headers=False)
    server = _Server(config)

    if access_key is not None:
        shown = lan if args.host in WILDCARD else args.host
        if ":" in shown:
            shown = f"[{shown}]"
        print(f"Move load test: http://{shown}:{args.port}/?key={access_key}", flush=True)
    if args.host in WILDCARD or is_loopback(args.host):
        print(f"On this machine: http://localhost:{args.port}", flush=True)
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
