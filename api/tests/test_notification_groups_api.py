from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, NotificationGroup, NotificationGroupMember, Person, UserAccount,
)
from tests.test_access_roles_api import login_admin


async def login_staff(client, seeded_user):
    """seeded_user is already role 'staff' — just log in, no upgrade."""
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    d = resp.json()
    return {"Authorization": f"Bearer {d['access_token']}"}


async def _person(db, first="Terry", last="Tech", *, email=None, phone=None,
                   archived=False):
    p = Person(first_name=first, last_name=last, email=email, phone=phone,
               archived_at=datetime.now(UTC) if archived else None)
    db.add(p)
    await db.commit()
    return p


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


# ── members, overrides, recipients (Task 2) ─────────────────────────

async def test_group_detail_not_found(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.get(
        "/notifications/groups/00000000-0000-0000-0000-000000000000",
        headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "group_not_found"


async def test_add_member_email_only_person(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Email only"})
    gid = resp.json()["id"]
    group = resp.json()
    person = await _person(db, "Emma", "Emailer", email="emma@test.example.com")

    resp = await client.post(f"/notifications/groups/{gid}/members",
                             headers=hdrs, json={"person_id": str(person.id)})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["person_id"] == str(person.id)
    assert body["can_email"] is True
    assert body["can_text"] is False
    assert body["can_push"] is False
    assert body["can_web"] is False
    assert body["has_account"] is False
    assert body["overrides"] == {
        "channels": None, "quiet_mode": None, "quiet_start": None,
        "quiet_end": None, "timezone": None, "active_days": None,
        "dnd_behavior": None, "urgent_bypass": None}
    assert set(body["effective"]["channels"]) == set(group["channels"])
    assert body["effective"]["timezone"] == group["timezone"]
    assert set(body["effective"]["active_days"]) == set(group["active_days"])
    assert body["effective"]["dnd_behavior"] == group["dnd_behavior"]
    assert body["effective"]["urgent_bypass"] == group["urgent_bypass"]
    assert body["effective"]["quiet_start"] is None
    assert body["effective"]["quiet_end"] is None

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "member.add"))
    assert row is not None and row.entity_id == gid

    detail = await client.get(f"/notifications/groups/{gid}", headers=hdrs)
    assert detail.status_code == 200
    assert [m["person_id"] for m in detail.json()["members"]] == [str(person.id)]


async def test_add_duplicate_member_conflicts(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Dup"})
    gid = resp.json()["id"]
    person = await _person(db, "Dana", "Duplicate")

    resp = await client.post(f"/notifications/groups/{gid}/members",
                             headers=hdrs, json={"person_id": str(person.id)})
    assert resp.status_code == 201
    resp = await client.post(f"/notifications/groups/{gid}/members",
                             headers=hdrs, json={"person_id": str(person.id)})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "member_exists"


async def test_add_archived_person_not_found(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Archived"})
    gid = resp.json()["id"]
    person = await _person(db, "Archie", "Archived", archived=True)

    resp = await client.post(f"/notifications/groups/{gid}/members",
                             headers=hdrs, json={"person_id": str(person.id)})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "person_not_found"


async def test_override_channels_unavailable_for_phoneless_person(
        client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "No phone"})
    gid = resp.json()["id"]
    person = await _person(db, "Noah", "Nophone")
    await client.post(f"/notifications/groups/{gid}/members", headers=hdrs,
                      json={"person_id": str(person.id)})

    resp = await client.patch(
        f"/notifications/groups/{gid}/members/{person.id}", headers=hdrs,
        json={"channels": ["text"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "channel_unavailable"


async def test_override_empty_channels_means_muted(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Muted"})
    gid = resp.json()["id"]
    person = await _person(db, "Mia", "Muted", email="mia@test.example.com")
    await client.post(f"/notifications/groups/{gid}/members", headers=hdrs,
                      json={"person_id": str(person.id)})

    resp = await client.patch(
        f"/notifications/groups/{gid}/members/{person.id}", headers=hdrs,
        json={"channels": []})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["overrides"]["channels"] == []
    assert body["effective"]["channels"] == []


async def test_override_quiet_mode_custom_without_times_rejected(
        client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Custom no times"})
    gid = resp.json()["id"]
    person = await _person(db, "Cora", "Custom")
    await client.post(f"/notifications/groups/{gid}/members", headers=hdrs,
                      json={"person_id": str(person.id)})

    resp = await client.patch(
        f"/notifications/groups/{gid}/members/{person.id}", headers=hdrs,
        json={"quiet_mode": "custom"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_quiet_hours"


async def test_override_quiet_mode_none_nulls_effective_quiet_hours(
        client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Quiet group",
                                   "quiet_start": "22:00:00",
                                   "quiet_end": "06:00:00"})
    gid = resp.json()["id"]
    person = await _person(db, "Quinn", "Quiet")
    await client.post(f"/notifications/groups/{gid}/members", headers=hdrs,
                      json={"person_id": str(person.id)})

    resp = await client.patch(
        f"/notifications/groups/{gid}/members/{person.id}", headers=hdrs,
        json={"quiet_mode": "none"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["effective"]["quiet_start"] is None
    assert body["effective"]["quiet_end"] is None


async def test_override_explicit_null_clears_channel_override(
        client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Clear override"})
    gid = resp.json()["id"]
    group = resp.json()
    person = await _person(db, "Cleo", "Clear", email="cleo@test.example.com")
    await client.post(f"/notifications/groups/{gid}/members", headers=hdrs,
                      json={"person_id": str(person.id)})

    resp = await client.patch(
        f"/notifications/groups/{gid}/members/{person.id}", headers=hdrs,
        json={"channels": ["email"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["effective"]["channels"] == ["email"]

    resp = await client.patch(
        f"/notifications/groups/{gid}/members/{person.id}", headers=hdrs,
        json={"channels": None})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["overrides"]["channels"] is None
    assert set(body["effective"]["channels"]) == set(group["channels"])

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "member.update"))
    assert row is not None and row.entity_id == gid


async def test_patch_member_not_found(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "No such member"})
    gid = resp.json()["id"]
    resp = await client.patch(
        f"/notifications/groups/{gid}/members/"
        "00000000-0000-0000-0000-000000000000",
        headers=hdrs, json={"channels": []})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "member_not_found"


async def test_remove_member(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Removable"})
    gid = resp.json()["id"]
    person = await _person(db, "Remy", "Removed")
    await client.post(f"/notifications/groups/{gid}/members", headers=hdrs,
                      json={"person_id": str(person.id)})

    resp = await client.delete(
        f"/notifications/groups/{gid}/members/{person.id}", headers=hdrs)
    assert resp.status_code == 204

    detail = await client.get(f"/notifications/groups/{gid}", headers=hdrs)
    assert detail.json()["members"] == []
    assert await db.get(NotificationGroupMember, (gid, person.id)) is None

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "member.remove"))
    assert row is not None and row.entity_id == gid


async def test_remove_member_not_found(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Nothing to remove"})
    gid = resp.json()["id"]
    resp = await client.delete(
        f"/notifications/groups/{gid}/members/"
        "00000000-0000-0000-0000-000000000000", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "member_not_found"


async def test_recipients_endpoint_capability_flags(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    full = await _person(db, "Frank", "Full", email="frank@test.example.com",
                         phone="555-0100")
    db.add(UserAccount(person_id=full.id, email="frank@test.example.com",
                       password_hash="x"))
    await db.commit()
    bare = await _person(db, "Bea", "Bare")

    resp = await client.get("/notifications/recipients", headers=hdrs)
    assert resp.status_code == 200
    by_id = {row["person_id"]: row for row in resp.json()}

    frank = by_id[str(full.id)]
    assert frank["can_email"] is True
    assert frank["can_text"] is True
    assert frank["can_push"] is True
    assert frank["can_web"] is True
    assert frank["has_account"] is True
    assert frank["phone"] == "555-0100"

    bea = by_id[str(bare.id)]
    assert bea["can_email"] is False
    assert bea["can_text"] is False
    assert bea["can_push"] is False
    assert bea["can_web"] is False
    assert bea["has_account"] is False


async def test_staff_forbidden_from_recipients(client, db, seeded_user):
    hdrs = await login_staff(client, seeded_user)
    resp = await client.get("/notifications/recipients", headers=hdrs)
    assert resp.status_code == 403
