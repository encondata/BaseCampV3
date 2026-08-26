"""ENV endpoints: gates, masking, update, restart sentinel."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog

from .test_assets_api import login
from .test_system_api import _developer_headers, _super_admin_headers

SAMPLE = "SS_ENV=development\nSS_LOG_LEVEL=INFO\nSS_JWT_SECRET=abc\n"


def _use_tmp_env(monkeypatch, tmp_path):
    from serversherpa.system import env_file
    path = tmp_path / ".env"
    path.write_text(SAMPLE)
    monkeypatch.setattr(env_file, "default_env_path", lambda: path)
    return path


async def test_env_gates(client, db, seeded_user):
    staff = await login(client)
    assert (await client.get("/system/env", headers=staff)).status_code == 403
    sa = await _super_admin_headers(db, client)
    assert (await client.get("/system/env", headers=sa)).status_code == 403


async def test_env_read_and_update(client, db, seeded_user, monkeypatch,
                                   tmp_path):
    path = _use_tmp_env(monkeypatch, tmp_path)
    dev = await _developer_headers(db, client)

    resp = await client.get("/system/env", headers=dev)
    assert resp.status_code == 200
    entries = {e["key"]: e for e in resp.json()["entries"]}
    assert entries["SS_JWT_SECRET"] == {"key": "SS_JWT_SECRET",
                                        "secret": True, "set": True,
                                        "description": "", "section": ""}
    assert "abc" not in resp.text
    # every entry carries a description field (empty when the .env line
    # has no trailing " # ..." comment)
    assert all("description" in e for e in entries.values())
    # every entry also carries a section field (empty when no standalone
    # comment precedes it)
    assert all("section" in e for e in entries.values())

    resp = await client.put("/system/env", headers=dev,
                            json={"values": {"SS_LOG_LEVEL": "DEBUG"}})
    assert resp.status_code == 200
    assert resp.json() == {"changed": ["SS_LOG_LEVEL"]}
    assert "SS_LOG_LEVEL=DEBUG" in path.read_text()

    entry = await db.scalar(select(AuditLog).where(
        AuditLog.action == "env_update"))
    assert entry.changes == {"changed": ["SS_LOG_LEVEL"]}

    resp = await client.put("/system/env", headers=dev,
                            json={"values": {"SS_DATABASE_URL": "x"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_env_update"


async def test_env_update_rejects_newline_injection(client, db, seeded_user,
                                                     monkeypatch, tmp_path):
    """A value containing \\n could splice a new physical line into .env
    on rewrite, letting a devtools user inject a hidden key (e.g.
    SS_DATABASE_URL) past the classification gate. Must be rejected
    before the file is ever touched."""
    path = _use_tmp_env(monkeypatch, tmp_path)
    dev = await _developer_headers(db, client)
    before = path.read_text()

    resp = await client.put("/system/env", headers=dev, json={
        "values": {"SS_LOG_LEVEL": "INFO\nSS_DATABASE_URL=evil"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_env_update"
    assert path.read_text() == before          # nothing written

    resp = await client.put("/system/env", headers=dev, json={
        "values": {"SS_LOG_LEVEL": "INFO\rSS_DATABASE_URL=evil"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_env_update"
    assert path.read_text() == before


async def test_env_restart_touches_sentinel(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    from serversherpa.system.env_file import SENTINEL_PATH
    before = SENTINEL_PATH.read_text()
    resp = await client.post("/system/env/restart", headers=dev)
    assert resp.status_code == 200
    assert resp.json() == {"restarting": True}
    after = SENTINEL_PATH.read_text()
    assert after != before                       # rewritten with new stamp
    entry = await db.scalar(select(AuditLog).where(
        AuditLog.action == "env_restart"))
    assert entry is not None
