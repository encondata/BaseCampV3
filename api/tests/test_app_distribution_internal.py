"""HTTP tests for the app-distribution internal API the Devices service
calls: the service-token gate, `authorize`, and `audit`."""
import os

import pytest
from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import AuditLog
from tests.wiki_helpers import PASSWORD, login_as

TOKEN = "devices-service-token-for-tests"
ENV = "SS_DEVICES_SERVICE_TOKEN"
BASE = "/app-distribution/internal"
SVC = {"X-Devices-Service-Token": TOKEN}


def _set_token(value):
    if value is None:
        os.environ.pop(ENV, None)
    else:
        os.environ[ENV] = value
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def service_token():
    before = os.environ.get(ENV)
    _set_token(TOKEN)
    yield TOKEN
    _set_token(before)


async def _authorize(client, user_headers, expect=200):
    resp = await client.get(f"{BASE}/authorize", headers={**SVC, **(user_headers or {})})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def test_service_token_is_required_and_compared(client, db):
    user, _ = await login_as(client, db)
    url = f"{BASE}/authorize"

    resp = await client.get(url, headers=user)
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "bad_service_token"
    resp = await client.get(url, headers={"X-Devices-Service-Token": "nope", **user})
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "bad_service_token"
    assert (await client.get(url, headers={**SVC, **user})).status_code == 200

    _set_token("")
    resp = await client.get(url, headers={**SVC, **user})
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "internal_disabled"


async def test_authorize_portal_staff(client, db):
    hdrs, person_id = await login_as(client, db, roles=("staff",))
    body = await _authorize(client, hdrs)
    assert body["person_id"] == str(person_id)
    assert body["client"] == "portal"
    assert body["actions"] == ["view"]
    assert body["kiosk_serial"] is None
    assert body["display_name"].startswith("Wiki Tester")
    assert body["email"].endswith("@test.example.com")
    assert body["password_change_required"] is False
    assert body["read_only"] is False and body["read_only_message"] is None


async def test_authorize_admin_has_all_actions(client, db):
    hdrs, _ = await login_as(client, db, roles=("admin",))
    assert (await _authorize(client, hdrs))["actions"] == [
        "view", "add", "change", "delete"]


async def test_authorize_without_a_grant_has_no_actions(client, db):
    hdrs, _ = await login_as(client, db, roles=("worker",))
    assert (await _authorize(client, hdrs))["actions"] == []


async def test_authorize_kiosk_session(client, db):
    _, _ = await login_as(client, db, roles=("staff",), email="appdist-kiosk@test.example.com")
    resp = await client.post("/auth/login", json={
        "email": "appdist-kiosk@test.example.com", "password": PASSWORD,
        "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    body = await _authorize(client, hdrs)
    assert body["client"] == "kiosk"


async def test_authorize_missing_or_revoked_session_401(client, db):
    body = await _authorize(client, None, expect=401)
    assert body["detail"]["code"] == "unauthenticated"
    hdrs, _ = await login_as(client, db)
    await _authorize(client, hdrs)
    assert (await client.post("/auth/logout", headers=hdrs)).status_code in (200, 204)
    body = await _authorize(client, hdrs, expect=401)
    assert body["detail"]["code"] == "unauthenticated"


async def test_authorize_reports_read_only(client, db, monkeypatch):
    async def _read_only(_db):
        return {"read_only": True, "read_only_message": "Down for maintenance."}
    monkeypatch.setattr(
        "serversherpa.api.routes.app_distribution_internal.read_admin_config", _read_only)
    staff, _ = await login_as(client, db, roles=("staff",))
    dev, _ = await login_as(client, db, roles=("developer",))
    body = await _authorize(client, staff)
    assert body["read_only"] is True
    assert body["read_only_message"] == "Down for maintenance."
    body = await _authorize(client, dev)
    assert body["read_only"] is False and body["read_only_message"] is None


async def test_audit_writes_row(client, db):
    _, person_id = await login_as(client, db)
    resp = await client.post(f"{BASE}/audit", headers=SVC, json={
        "actor_person_id": str(person_id), "entity_type": "appdist_version",
        "entity_id": "v-123", "action": "make_current",
        "changes": {"version": "1.2.3"}, "ip": "10.0.0.5"})
    assert resp.status_code == 204
    row = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "appdist_version",
        AuditLog.entity_id == "v-123"))).one()
    assert row.actor_person_id == person_id
    assert row.action == "make_current"
    assert row.changes == {"version": "1.2.3"}


async def test_audit_rejects_unknown_entity_type(client):
    resp = await client.post(f"{BASE}/audit", headers=SVC, json={
        "entity_type": "device", "entity_id": "x", "action": "a"})
    assert resp.status_code == 422


async def test_audit_requires_service_token(client):
    resp = await client.post(f"{BASE}/audit", json={
        "entity_type": "appdist_app", "entity_id": "x", "action": "a"})
    assert resp.status_code == 401
