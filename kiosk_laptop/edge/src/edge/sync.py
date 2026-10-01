"""Pull the move this laptop is set up for into SQLite: the same reads the
kiosk makes after Kiosk Setup, stored as the cache entries the proxy serves
offline, plus the move's hashed password (so a move sign-in works with no
internet). All-or-nothing: every read must succeed before any is written,
in one transaction, so a dropped connection never leaves mixed data.

The move password is sent back as `have=<version>`; when the cloud says
it is `unchanged`, the stored row stays. Any other refusal also keeps the
stored row and records `move_passwords_http_<status>`."""

import json
from collections.abc import Callable
from urllib.parse import quote

from edge.db import Store, now_iso
from edge.upstream import CloudOffline, Upstream


def sync_paths(initiative_id: str) -> list[str]:
    q = f"initiative_id={quote(initiative_id, safe='')}"
    return [f"/kiosk/sync/assets?{q}", "/kiosk/sync/people", f"/kiosk/sync/containers?{q}",
            f"/kiosk/sync/trucks?{q}", "/kiosk/labels/vocab", "/kiosk/setup-options"]


class Syncer:
    def __init__(self, store: Store, upstream: Upstream, serial_getter: Callable[[], str]) -> None:
        self.store = store
        self.upstream = upstream
        self.serial = serial_getter
        store.run("INSERT OR IGNORE INTO sync_meta (id) VALUES (1)")

    def set_target(self, initiative_id: str, actor_person_id: str) -> None:
        self.store.run("UPDATE sync_meta SET initiative_id = ?, actor_person_id = ? WHERE id = 1",
                       (initiative_id, actor_person_id))

    def meta(self) -> dict:
        row = self.store.one("SELECT initiative_id, actor_person_id, synced_at, last_error "
                             "FROM sync_meta WHERE id = 1")
        return dict(row)

    def _error(self, code: str) -> dict:
        self.store.run("UPDATE sync_meta SET last_error = ? WHERE id = 1", (code,))
        return self.meta()

    async def run(self) -> dict:
        meta = self.meta()
        initiative = meta["initiative_id"]
        if not initiative:
            return meta
        actor = self._actor(meta["actor_person_id"])
        if actor is None:
            return self._error("needs_sign_in")
        pulled: list[tuple[str, str]] = []
        try:
            for path in sync_paths(initiative):
                resp = await self.upstream.as_person(actor, "GET", path)
                if resp is None:
                    return self._error("needs_sign_in")
                if resp.status_code != 200:
                    return self._error(f"http_{resp.status_code}:{path}")
                pulled.append((path, resp.text))
            moves = await self.upstream.as_person(actor, "GET", self._moves_path(initiative))
        except CloudOffline:
            return self._error("offline")
        rows: list[tuple] | None = None
        error: str | None = None
        if moves is not None and moves.status_code == 200:
            try:
                data = moves.json()
                if not data.get("unchanged"):
                    rows = [(str(m["initiative_id"]), m["name"], m["argon2_hash"],
                             json.dumps(m["session"]), now_iso(), m.get("version"))
                            for m in data.get("moves", [])]
            except (ValueError, KeyError, TypeError, AttributeError):
                error = "bad_move_passwords"
        elif moves is not None:
            error = f"move_passwords_http_{moves.status_code}"
        with self.store.tx() as c:
            for path, body in pulled:
                c.execute("INSERT INTO cache (key, status, body, stored_at) VALUES (?, 200, ?, ?) "
                          "ON CONFLICT(key) DO UPDATE SET status = 200, body = excluded.body, "
                          "stored_at = excluded.stored_at", (path, body, now_iso()))
            if rows is not None:
                c.execute("DELETE FROM move_passwords")
                for row in rows:
                    c.execute("INSERT INTO move_passwords (initiative_id, name, verifier, "
                              "session_json, updated_at, version) VALUES (?, ?, ?, ?, ?, ?)", row)
            c.execute("UPDATE sync_meta SET synced_at = ?, last_error = ? WHERE id = 1",
                      (now_iso(), error))
        return self.meta()

    def _actor(self, configured: str | None) -> str | None:
        """Who the sync acts as: whoever is signed in on the laptop NOW with
        a usable cloud session (the cloud hands the move password only to the
        person signed in on that kiosk), else the person who ran Kiosk Setup,
        else the latest cloud session."""
        row = self.store.one(
            "SELECT e.person_id FROM edge_sessions e JOIN cloud_sessions c "
            "ON c.person_id = e.person_id AND c.ending = 0 "
            "WHERE e.revoked_at IS NULL AND e.expires_at > ? "
            "ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1", (now_iso(),))
        if row is not None:
            return row["person_id"]
        if configured and self.upstream.has_session(configured):
            return configured
        return self.upstream.latest_session_person()

    def _moves_path(self, initiative: str) -> str:
        path = f"/kiosk/edge/move-passwords?serial={quote(self.serial(), safe='')}"
        row = self.store.one("SELECT version FROM move_passwords WHERE initiative_id = ?",
                             (initiative,))
        if row is not None and row["version"]:
            path += f"&have={quote(row['version'], safe='')}"
        return path
