"""Pull the move this laptop is set up for into SQLite: the same reads the
kiosk makes after Kiosk Setup, stored as the cache entries the proxy serves
offline, plus the move's hashed password (so a move sign-in works with no
internet). All-or-nothing: every read must succeed before any is written,
in one transaction, so a dropped connection never leaves mixed data."""

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
        actor = meta["actor_person_id"]
        if not actor or not self.upstream.has_session(actor):
            actor = self.upstream.latest_session_person()
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
            moves = await self.upstream.as_person(
                actor, "GET", f"/kiosk/edge/move-passwords?serial={quote(self.serial(), safe='')}")
        except CloudOffline:
            return self._error("offline")
        with self.store.tx() as c:
            for path, body in pulled:
                c.execute("INSERT INTO cache (key, status, body, stored_at) VALUES (?, 200, ?, ?) "
                          "ON CONFLICT(key) DO UPDATE SET status = 200, body = excluded.body, "
                          "stored_at = excluded.stored_at", (path, body, now_iso()))
            if moves is not None and moves.status_code == 200:
                c.execute("DELETE FROM move_passwords")
                for m in moves.json().get("moves", []):
                    c.execute("INSERT INTO move_passwords (initiative_id, name, verifier, "
                              "session_json, updated_at) VALUES (?, ?, ?, ?, ?)",
                              (str(m["initiative_id"]), m["name"], m["argon2_hash"],
                               json.dumps(m["session"]), now_iso()))
            c.execute("UPDATE sync_meta SET synced_at = ?, last_error = NULL WHERE id = 1",
                      (now_iso(),))
        return self.meta()
