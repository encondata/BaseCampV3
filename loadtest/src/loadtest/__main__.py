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
                    "LOADTEST_ROUTER_URL (default %s). The page's sign-in: "
                    "LOADTEST_USERNAME and LOADTEST_PASSWORD." % DEFAULT_ROUTER_URL)
    parser.add_argument("--host", default="0.0.0.0",
                        help="address to listen on (default 0.0.0.0, every network)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"port to listen on (default {DEFAULT_PORT})")
    parser.add_argument("--allow-host", action="append", default=[], metavar="NAME",
                        help="a reverse proxy's name the page may be opened by "
                             "(repeatable). The proxy must reach the tool on this machine. "
                             "Everyone then signs in, on this machine too")
    parser.add_argument("--public-url", metavar="ADDRESS",
                        default=os.environ.get("LOADTEST_PUBLIC_URL") or None,
                        help="the address people open the page by when the tool runs in a "
                             "container or behind a proxy, such as "
                             "https://loadtest.example.com or http://10.0.0.5:8795 (or set "
                             "LOADTEST_PUBLIC_URL). Its name is allowed like --allow-host, "
                             "and the printed address is this one")
    parser.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR,
                        help="folder for run results (default: the runs folder next to the "
                             "tool)")
    return parser.parse_args(argv)


DEFAULT_SIGN_IN = ("Sign in with the default username and password, admin and password123. "
                   "Set LOADTEST_USERNAME and LOADTEST_PASSWORD to change them.")
OWN_SIGN_IN = ("Sign in with the username and password set in LOADTEST_USERNAME and "
               "LOADTEST_PASSWORD.")
BAD_PUBLIC_URL = ("--public-url must be the page's address and nothing else, such as "
                  "https://loadtest.example.com or http://10.0.0.5:8795.")


def public_address(value: str) -> tuple[str, str]:
    """A --public-url value as (the address without a trailing slash, its host name).
    Exits when it is anything but http(s)://host[:port]."""
    from urllib.parse import urlsplit
    try:
        parts = urlsplit(value.strip())
        port = parts.port
        host = parts.hostname
    except ValueError:
        sys.exit(BAD_PUBLIC_URL)
    if (parts.scheme not in ("http", "https") or not host or parts.path not in ("", "/")
            or parts.query or parts.fragment or "@" in parts.netloc):
        sys.exit(BAD_PUBLIC_URL)
    shown = f"[{host}]" if ":" in host else host
    return f"{parts.scheme}://{shown}" + (f":{port}" if port else ""), host


def sign_in_from_environment():
    """The page's username and password: LOADTEST_USERNAME and LOADTEST_PASSWORD, else the
    defaults. Returns (sign-in, whether both are the defaults)."""
    from .web.signin import DEFAULT_PASSWORD, DEFAULT_USERNAME, SignIn
    username = os.environ.get("LOADTEST_USERNAME") or DEFAULT_USERNAME
    password = os.environ.get("LOADTEST_PASSWORD") or DEFAULT_PASSWORD
    return (SignIn(username, password),
            username == DEFAULT_USERNAME and password == DEFAULT_PASSWORD)


def lan_address() -> str:
    """This machine's LAN address. Connecting a UDP socket sends nothing."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


WILDCARD = ("0.0.0.0", "::", "")
LOCK_NAME = ".lock"
ANOTHER_COPY = "Another copy of the load test is already using this runs folder."
NO_LOCK = ("This system cannot lock the runs folder, so never start two copies of the load "
           "test with the same runs folder.")


def _fcntl():
    try:
        import fcntl
    except ImportError:     # not on Windows
        return None
    return fcntl


def lock_runs_dir(runs_dir: Path):
    """Holds `<runs_dir>/.lock` for as long as the returned file stays open, so a second
    copy of the tool can never drive the same run. Exits when another copy holds it.
    None (after one printed line) where the system has no file locks."""
    fcntl = _fcntl()
    if fcntl is None:
        print(NO_LOCK, flush=True)
        return None
    try:
        runs_dir.mkdir(parents=True, exist_ok=True)
        handle = open(runs_dir / LOCK_NAME, "a")
    except OSError as exc:
        sys.exit(f"Could not use the runs folder {runs_dir}: {exc.strerror or 'refused'}.")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        sys.exit(ANOTHER_COPY)
    return handle


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
            sys.exit(f"Port {port} is already in use. The load test may already be running "
                     "on this machine; open its page instead, or start this one with --port "
                     "and --runs-dir set to something else.")
        sys.exit(f"Could not listen on {host} port {port}: {exc.strerror or 'refused'}.")
    return sock


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    runs_dir = args.runs_dir.resolve()
    lock = lock_runs_dir(runs_dir)      # held until main returns
    try:
        _serve(args, runs_dir)
    finally:
        if lock is not None:
            lock.close()


def _serve(args: argparse.Namespace, runs_dir: Path) -> None:
    public = public_address(args.public_url) if args.public_url else None
    # a container or a proxy makes everyone arrive the same way, so the public address
    # counts as an allowed proxy name: every visitor then signs in
    proxy_names = list(args.allow_host) + ([public[1]] if public else [])
    sock = bind(args.host, args.port)

    import uvicorn

    from .runner import Runner
    from .web.app import create_app

    runs_dir.mkdir(parents=True, exist_ok=True)
    runner = Runner(runs_dir=runs_dir,
                    router_url=os.environ.get("LOADTEST_ROUTER_URL") or DEFAULT_ROUTER_URL)
    lan = lan_address()
    # a proxy makes everyone arrive from loopback, so --allow-host means everyone signs in
    guarded = not is_loopback(args.host) or bool(proxy_names)
    sign_in, default_sign_in = sign_in_from_environment() if guarded else (None, False)
    app = create_app(runner, allowed_hosts=allowed_hosts(args.host, lan, proxy_names),
                     sign_in=sign_in, cookie_name=f"loadtest_session_{args.port}",
                     local_skip=not proxy_names,
                     secure_cookie=bool(public) and public[0].startswith("https://"))

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

    # no access log: who opened what is nobody's business. No proxy headers: the client
    # address is the real peer, never one a request claims.
    config = uvicorn.Config(app, log_level="info", timeout_graceful_shutdown=5,
                            access_log=False, proxy_headers=False)
    server = _Server(config)

    local = args.host in WILDCARD or is_loopback(args.host)
    if public:
        print(f"Move load test: {public[0]}", flush=True)
        print("Everyone signs in, on this machine too.", flush=True)
    elif args.allow_host:
        shown = "localhost" if local else args.host
        if ":" in shown:
            shown = f"[{shown}]"
        print(f"Move load test: http://{shown}:{args.port}", flush=True)
        print("A proxy name was allowed, so everyone signs in, on this machine too.",
              flush=True)
    else:
        if guarded:
            shown = lan if args.host in WILDCARD else args.host
            if ":" in shown:
                shown = f"[{shown}]"
            print(f"Move load test: http://{shown}:{args.port}", flush=True)
        if local:
            print(f"On this machine: http://localhost:{args.port}" +
                  (" (no sign-in)" if guarded else ""), flush=True)
    if guarded:
        print(DEFAULT_SIGN_IN if default_sign_in else OWN_SIGN_IN, flush=True)
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
