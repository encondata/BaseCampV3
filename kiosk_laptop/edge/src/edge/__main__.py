"""`python -m edge serve [--host H] [--port 8090] [--ingest-port 8091]` runs the
kiosk and the tag listener in one process.

`python -m edge reset-key [--data-dir /data]` — replace an unreadable
edge.key. Everything encrypted under the old key (cloud tokens) and every
offline verifier and edge session is deleted; people sign in online again.
Queued work stays and uploads once its owner signs in online."""

import argparse
import asyncio
import contextlib
import sqlite3
import sys
from pathlib import Path

from edge.crypto import KEY_FILE


def _clear_sessions(db: Path) -> None:
    conn = sqlite3.connect(db, timeout=2.0)
    try:
        # the same locking the edge uses: no -shm file on shared folders, and
        # a running edge (which holds the lock) makes this fail fast instead
        conn.execute("PRAGMA locking_mode=EXCLUSIVE")
        with conn:
            for table in ("cloud_sessions", "offline_logins", "edge_sessions"):
                conn.execute(f"DELETE FROM {table}")
            conn.execute("UPDATE outbox SET status = 'needs_sign_in' "
                         "WHERE status IN ('queued', 'sending')")
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(prog="edge")
    parser.add_argument("command", choices=["reset-key", "serve"])
    parser.add_argument("--data-dir", default="/data")
    parser.add_argument("--host", default="0.0.0.0", help="serve: address to listen on")
    parser.add_argument("--port", type=int, default=8090, help="serve: kiosk port")
    parser.add_argument("--ingest-port", type=int, default=8091,
                        help="serve: tag-data listener port")
    args = parser.parse_args()
    if args.command == "serve":
        from edge.serve import serve  # imported here: reset-key needs none of the web stack
        # uvicorn re-raises the captured Ctrl+C after a clean shutdown; SystemExit still propagates
        with contextlib.suppress(KeyboardInterrupt):
            asyncio.run(serve(host=args.host, port=args.port, ingest_port=args.ingest_port))
        return
    data_dir = Path(args.data_dir)
    # DB first, key last: if the cleanup fails, the old key (and the tokens
    # it can read) stay as they were and the command can simply be re-run.
    db = data_dir / "edge.db"
    if db.exists():
        try:
            _clear_sessions(db)
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc):
                raise
            print("The kiosk is running — stop it first (see the README's Troubleshooting) "
                  "and run reset-key again", file=sys.stderr)
            sys.exit(1)
    (data_dir / KEY_FILE).unlink(missing_ok=True)
    print("edge.key removed; a new one is created on the next start. Everyone signs in online again.")


if __name__ == "__main__":
    main()
