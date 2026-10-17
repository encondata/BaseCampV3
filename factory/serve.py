#!/usr/bin/env python3
"""Serve the factory dashboard to this machine only.

  python3 factory/serve.py [port]     default port 8765

Binds 127.0.0.1 (job files include security reviews of unmerged code) and
logs only real errors. 404s are normal here (no board.json before the first
job, review files not written yet), and the dashboard polls every 2 seconds.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class QuietHandler(SimpleHTTPRequestHandler):
    def log_request(self, code="-", size="-"):
        if str(code).isdigit() and int(code) >= 400 and int(code) != 404:
            super().log_request(code, size)

    def log_error(self, format, *args):
        pass  # log_request already reports the failures worth seeing


def main() -> None:
    handler = partial(QuietHandler, directory=str(HERE))
    with ThreadingHTTPServer(("127.0.0.1", PORT), handler) as server:
        print(f"Factory dashboard: http://localhost:{PORT}/dashboard.html  (Ctrl-C to stop)", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
