"""Config endpoints: gates, masking, keep-rule, audit redaction, test."""

import json

from sqlalchemy import select

from serversherpa.db.models import AuditLog, SystemConfig

from .test_assets_api import login
from .test_system_api import _developer_headers, _super_admin_headers


def _remote_body(**over):
    body = {"mode": "local_remote",
            "local_max_rows_per_process": 20000, "local_max_age_days": 14,
            "remote_buffer_rows": 10000, "min_level": "INFO",
            "transport": "loki",
            "loki": {"url": "http://loki:3100", "username": "u",
                     "password": "sekrit", "tenant_id": ""},
            "syslog": {"host": "", "port": 514, "protocol": "udp"}}
    body.update(over)
    return body


async def test_gates(client, db, seeded_user):
    staff = await login(client)
    assert (await client.get("/system/config/logging",
                             headers=staff)).status_code == 403
    sa = await _super_admin_headers(db, client)
    assert (await client.get("/system/config/logging",
                             headers=sa)).status_code == 403


async def test_get_returns_masked_defaults(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    resp = await client.get("/system/config/logging", headers=dev)
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "local"
    assert body["transport"] == "loki"
    assert "password" not in body["loki"]
    assert body["loki"]["password_set"] is False


async def test_put_roundtrip_and_password_keep(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    resp = await client.put("/system/config/logging", headers=dev,
                            json=_remote_body())
    assert resp.status_code == 200, resp.text
    assert "password" not in resp.json()["loki"]
    assert resp.json()["loki"]["password_set"] is True

    stored = await db.get(SystemConfig, "logging")
    await db.refresh(stored)
    assert stored.data["loki"]["password"] == "sekrit"

    # empty password on the next PUT keeps the stored secret
    resp = await client.put("/system/config/logging", headers=dev,
                            json=_remote_body(
                                loki={"url": "http://loki:3100",
                                      "username": "u", "password": "",
                                      "tenant_id": ""}))
    assert resp.status_code == 200
    await db.refresh(stored)
    assert stored.data["loki"]["password"] == "sekrit"


async def test_put_validation_errors(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    resp = await client.put("/system/config/logging", headers=dev,
                            json=_remote_body(loki={"url": "", "username": "",
                                                    "password": "",
                                                    "tenant_id": ""}))
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "invalid_logging_config"
    assert "loki.url" in detail["fields"]


async def test_audit_never_contains_password(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    await client.put("/system/config/logging", headers=dev,
                     json=_remote_body())
    entry = await db.scalar(select(AuditLog).where(
        AuditLog.action == "logging_config_update"))
    assert entry is not None
    assert "sekrit" not in json.dumps(entry.changes)


async def test_test_endpoint(client, db, seeded_user, monkeypatch):
    dev = await _developer_headers(db, client)
    # local mode: logs but does not forward
    resp = await client.post("/system/config/logging/test", headers=dev)
    assert resp.json() == {"logged": True, "forwarded": False, "error": None}

    await client.put("/system/config/logging", headers=dev,
                     json=_remote_body())

    calls = {}

    async def fake_send_loki(cfg, rows, hostname):
        calls["cfg"] = cfg
        calls["rows"] = rows

    from serversherpa.api.routes import system as system_routes
    monkeypatch.setattr(system_routes, "send_loki", fake_send_loki)
    resp = await client.post("/system/config/logging/test", headers=dev)
    assert resp.json()["forwarded"] is True
    assert calls["rows"][0]["message"] == "Test event from System Config"
    assert calls["cfg"]["password"] == "sekrit"     # real secret used

    async def broken(cfg, rows, hostname):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(system_routes, "send_loki", broken)
    resp = await client.post("/system/config/logging/test", headers=dev)
    body = resp.json()
    assert body["forwarded"] is False
    assert "refused" in body["error"]


async def test_put_null_sections_return_422_not_500(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    resp = await client.put("/system/config/logging", headers=dev,
                            json={**_remote_body(), "loki": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_logging_config"
