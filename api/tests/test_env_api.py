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
    # default_example_path() derives from default_env_path(), so it now
    # points at tmp_path/.env.example (absent unless a test writes it).
    return path


EXAMPLE = """# Runtime
SS_ENV=production
SS_FEATURE_FLAG=on  # Turns the feature on

# Mail
SS_SMTP_HOST=smtp.example.com  # Relay host
SS_SMTP_PORT=587
SS_SMTP_PASSWORD=hunter2

# db
SS_DATABASE_URL=postgresql+asyncpg://u:p@h/db
"""


def _use_tmp_example(path):
    (path.parent / ".env.example").write_text(EXAMPLE)


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
    assert entry.changes == {"changed": ["SS_LOG_LEVEL"], "added": []}

    resp = await client.put("/system/env", headers=dev,
                            json={"values": {"SS_DATABASE_URL": "x"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_env_update"


async def test_env_lists_missing_settings(client, db, seeded_user,
                                          monkeypatch, tmp_path):
    path = _use_tmp_env(monkeypatch, tmp_path)
    dev = await _developer_headers(db, client)

    # no .env.example next to .env -> nothing missing, nothing addable
    resp = await client.get("/system/env", headers=dev)
    assert resp.json()["missing"] == []
    resp = await client.put("/system/env", headers=dev,
                            json={"values": {"SS_SMTP_HOST": "h"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["unknown"] == ["SS_SMTP_HOST"]

    _use_tmp_example(path)
    resp = await client.get("/system/env", headers=dev)
    body = resp.json()
    assert [e["key"] for e in body["entries"]] == [
        "SS_ENV", "SS_LOG_LEVEL", "SS_JWT_SECRET"]
    assert body["missing"] == [
        {"key": "SS_FEATURE_FLAG", "secret": False, "section": "Runtime",
         "description": "Turns the feature on", "example": "on"},
        {"key": "SS_SMTP_HOST", "secret": False, "section": "Mail",
         "description": "Relay host", "example": "smtp.example.com"},
        {"key": "SS_SMTP_PORT", "secret": False, "section": "Mail",
         "description": "", "example": "587"},
        {"key": "SS_SMTP_PASSWORD", "secret": True, "section": "Mail",
         "description": ""},
    ]
    assert "hunter2" not in resp.text
    assert "SS_DATABASE_URL" not in resp.text


async def test_env_adds_missing_settings(client, db, seeded_user,
                                         monkeypatch, tmp_path):
    path = _use_tmp_env(monkeypatch, tmp_path)
    _use_tmp_example(path)
    dev = await _developer_headers(db, client)

    resp = await client.put("/system/env", headers=dev, json={"values": {
        "SS_LOG_LEVEL": "DEBUG", "SS_SMTP_HOST": "smtp.local",
        "SS_SMTP_PORT": "", "SS_SMTP_PASSWORD": ""}})
    assert resp.status_code == 200
    assert resp.json() == {"changed": ["SS_LOG_LEVEL", "SS_SMTP_HOST",
                                       "SS_SMTP_PORT"]}
    text = path.read_text()
    assert text.endswith(
        "\n# Mail\nSS_SMTP_HOST=smtp.local\nSS_SMTP_PORT=\n")
    assert "SS_SMTP_PASSWORD" not in text          # empty secret skipped
    assert path.with_suffix(".bak").exists()

    entry = await db.scalar(select(AuditLog).where(
        AuditLog.action == "env_update"))
    assert entry.changes == {
        "changed": ["SS_LOG_LEVEL", "SS_SMTP_HOST", "SS_SMTP_PORT"],
        "added": ["SS_SMTP_HOST", "SS_SMTP_PORT"]}

    # the added keys moved from missing to entries
    body = (await client.get("/system/env", headers=dev)).json()
    assert {"SS_SMTP_HOST", "SS_SMTP_PORT"} <= {
        e["key"] for e in body["entries"]}
    assert [m["key"] for m in body["missing"]] == [
        "SS_FEATURE_FLAG", "SS_SMTP_PASSWORD"]


async def test_env_add_rejects_hidden_unknown_and_linebreak(
        client, db, seeded_user, monkeypatch, tmp_path):
    path = _use_tmp_env(monkeypatch, tmp_path)
    _use_tmp_example(path)
    dev = await _developer_headers(db, client)
    before = path.read_text()

    resp = await client.put("/system/env", headers=dev, json={"values": {
        "SS_DATABASE_URL": "x", "SS_NOT_THERE": "y"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_env_update"
    assert resp.json()["detail"]["unknown"] == [
        "SS_DATABASE_URL", "SS_NOT_THERE"]

    resp = await client.put("/system/env", headers=dev, json={"values": {
        "SS_SMTP_HOST": "h\nSS_DATABASE_URL=evil"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_env_update"
    assert path.read_text() == before          # nothing written


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


async def test_env_update_rejects_all_linebreak_separators(client, db,
                                                            seeded_user,
                                                            monkeypatch,
                                                            tmp_path):
    """Rejects values with any line-break char that str.splitlines() would
    treat as a line break, including \\v \\f \\x1c \\x1d \\x1e \\x85, not
    just \\n and \\r. File is byte-unchanged."""
    path = _use_tmp_env(monkeypatch, tmp_path)
    dev = await _developer_headers(db, client)
    before = path.read_text()

    resp = await client.put("/system/env", headers=dev, json={
        "values": {"SS_LOG_LEVEL": "INFO\vSS_DATABASE_URL=evil"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_env_update"
    assert path.read_text() == before


async def test_env_update_descriptions(client, db, seeded_user, monkeypatch,
                                       tmp_path):
    path = _use_tmp_env(monkeypatch, tmp_path)
    dev = await _developer_headers(db, client)

    resp = await client.put("/system/env", headers=dev, json={
        "values": {}, "descriptions": {"SS_ENV": "Deployment mode"}})
    assert resp.status_code == 200
    assert resp.json() == {"changed": ["SS_ENV"]}
    assert "SS_ENV=development  # Deployment mode" in path.read_text()

    entry = await db.scalar(select(AuditLog).where(
        AuditLog.action == "env_update").order_by(AuditLog.id.desc()))
    assert entry.changes == {"changed": ["SS_ENV"], "added": []}

    # empty description removes the trailing comment
    resp = await client.put("/system/env", headers=dev, json={
        "values": {}, "descriptions": {"SS_ENV": ""}})
    assert resp.status_code == 200
    assert resp.json() == {"changed": ["SS_ENV"]}
    assert "SS_ENV=development\n" in path.read_text()
    assert "Deployment mode" not in path.read_text()

    # value + description on the same key in one call -> both applied
    resp = await client.put("/system/env", headers=dev, json={
        "values": {"SS_LOG_LEVEL": "DEBUG"},
        "descriptions": {"SS_LOG_LEVEL": "Verbosity"}})
    assert resp.status_code == 200
    assert resp.json() == {"changed": ["SS_LOG_LEVEL"]}
    assert "SS_LOG_LEVEL=DEBUG  # Verbosity" in path.read_text()


async def test_env_update_descriptions_rejects_linebreak(client, db,
                                                          seeded_user,
                                                          monkeypatch,
                                                          tmp_path):
    path = _use_tmp_env(monkeypatch, tmp_path)
    dev = await _developer_headers(db, client)
    before = path.read_text()

    resp = await client.put("/system/env", headers=dev, json={
        "values": {}, "descriptions": {"SS_ENV": "bad\ndescription"}})
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
