"""`python -m edge reset-key [--data-dir /data]` — replace an unreadable
edge.key. Everything encrypted under the old key (cloud tokens) and every
offline verifier and edge session is deleted; people sign in online again.
Queued work stays and uploads once its owner signs in online."""

import argparse
import sqlite3
from pathlib import Path

from edge.crypto import KEY_FILE


def main() -> None:
    parser = argparse.ArgumentParser(prog="edge")
    parser.add_argument("command", choices=["reset-key"])
    parser.add_argument("--data-dir", default="/data")
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    (data_dir / KEY_FILE).unlink(missing_ok=True)
    db = data_dir / "edge.db"
    if db.exists():
        conn = sqlite3.connect(db)
        with conn:
            for table in ("cloud_sessions", "offline_logins", "edge_sessions"):
                conn.execute(f"DELETE FROM {table}")
            conn.execute("UPDATE outbox SET status = 'needs_sign_in' "
                         "WHERE status IN ('queued', 'sending')")
        conn.close()
    print("edge.key removed; a new one is created on the next start. Everyone signs in online again.")


if __name__ == "__main__":
    main()
