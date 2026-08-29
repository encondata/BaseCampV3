import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, NotificationGroup
from tests.test_access_roles_api import login_admin


async def login_staff(client, seeded_user):
    """seeded_user is already role 'staff' — just log in, no upgrade."""
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    d = resp.json()
    return {"Authorization": f"Bearer {d['access_token']}"}


async def test_create_group_defaults_echoed(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "On-call"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "On-call"
    assert body["description"] == ""
    assert set(body["channels"]) == {"email", "web"}
    assert body["quiet_start"] is None and body["quiet_end"] is None
    assert body["timezone"] == "America/Chicago"
    assert set(body["active_days"]) == {"mon", "tue", "wed", "thu", "fri",
                                        "sat", "sun"}
    assert body["dnd_behavior"] == "defer"
    assert body["urgent_bypass"] is True
    assert body["enabled"] is True
    assert body["member_count"] == 0

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "group.create"))
    assert row is not None and row.entity_id == body["id"]


async def test_duplicate_name_conflicts(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Ops"})
    assert resp.status_code == 201
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Ops"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "group_exists"


async def test_list_shows_member_count_zero(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await client.post("/notifications/groups", headers=hdrs, json={"name": "A"})
    resp = await client.get("/notifications/groups", headers=hdrs)
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    assert items[0]["member_count"] == 0


async def test_patch_settings_round_trip(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Escalations"})
    gid = resp.json()["id"]

    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"quiet_start": "22:00:00",
                                    "quiet_end": "06:00:00",
                                    "active_days": ["mon", "tue", "wed"],
                                    "dnd_behavior": "skip",
                                    "enabled": False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["quiet_start"] == "22:00:00"
    assert body["quiet_end"] == "06:00:00"
    assert body["active_days"] == ["mon", "tue", "wed"]
    assert body["dnd_behavior"] == "skip"
    assert body["enabled"] is False

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "group.update"))
    assert row is not None and row.entity_id == gid


async def test_patch_bad_channel_rejected(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Bad channel"})
    gid = resp.json()["id"]
    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"channels": ["email", "carrier_pigeon"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid"


async def test_patch_bad_timezone_rejected(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Bad tz"})
    gid = resp.json()["id"]
    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"timezone": "Mars/Olympus_Mons"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_timezone"


async def test_patch_quiet_start_without_end_rejected(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Half quiet"})
    gid = resp.json()["id"]
    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"quiet_start": "10:00:00"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_quiet_hours"


async def test_patch_equal_quiet_times_rejected(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Equal quiet"})
    gid = resp.json()["id"]
    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"quiet_start": "10:00:00",
                                    "quiet_end": "10:00:00"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_quiet_hours"


async def test_patch_partial_quiet_start_against_existing_end_allowed(
        client, db, seeded_user):
    """A PATCH that supplies only quiet_start must be validated against the
    MERGED state (existing quiet_end), not treated as if quiet_end were
    being cleared."""
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Merged quiet",
                                   "quiet_start": "22:00:00",
                                   "quiet_end": "06:00:00"})
    gid = resp.json()["id"]

    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"quiet_start": "23:00:00"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["quiet_start"] == "23:00:00"
    assert body["quiet_end"] == "06:00:00"


async def test_patch_quiet_start_against_no_existing_quiet_hours_rejected(
        client, db, seeded_user):
    """Same partial-field PATCH, but the group has no quiet hours set at
    all — merged state is start-only, still invalid."""
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "No quiet yet"})
    gid = resp.json()["id"]

    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"quiet_start": "10:00:00"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_quiet_hours"


async def test_patch_explicit_null_quiet_start_alone_rejected(
        client, db, seeded_user):
    """Explicitly nulling only quiet_start (leaving quiet_end untouched)
    on a group with both set must still 422 — clearing requires nulling
    both fields together."""
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Explicit null quiet",
                                   "quiet_start": "22:00:00",
                                   "quiet_end": "06:00:00"})
    gid = resp.json()["id"]

    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"quiet_start": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_quiet_hours"


async def test_delete_group(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Gone soon"})
    gid = resp.json()["id"]
    resp = await client.delete(f"/notifications/groups/{gid}", headers=hdrs)
    assert resp.status_code == 204

    resp = await client.get("/notifications/groups", headers=hdrs)
    assert all(item["id"] != gid for item in resp.json())
    assert await db.get(NotificationGroup, gid) is None

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "group.delete"))
    assert row is not None and row.entity_id == gid


async def test_staff_forbidden_from_creating_group(client, db, seeded_user):
    hdrs = await login_staff(client, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Nope"})
    assert resp.status_code == 403
