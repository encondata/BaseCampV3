from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.api.routes.notifications import capabilities
from serversherpa.db.models import (
    AuditLog, NotificationGroup, NotificationGroupMember, Person, UserAccount,
)
from tests.test_access_roles_api import login_admin

# the delivery settings a group no longer has (Phase 1): who gets email, and when,
# is a person's own switches and schedule now
DELIVERY_VALUES = [
    ("channels", ["email"]),
    ("quiet_start", "22:00:00"),
    ("quiet_end", "06:00:00"),
    ("timezone", "America/Chicago"),
    ("active_days", ["mon"]),
    ("dnd_behavior", "skip"),
    ("urgent_bypass", False),
]
DELIVERY_FIELDS = tuple(field for field, _ in DELIVERY_VALUES)

GROUP_KEYS = {"id", "name", "description", "categories", "enabled", "member_count",
              "created_at"}
MEMBER_KEYS = {"person_id", "display_name", "job_title", "avatar_url", "email", "phone",
               "has_account", "added_at"}


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
    assert body["categories"] == []
    assert body["enabled"] is True
    assert body["member_count"] == 0

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "group.create"))
    assert row is not None and row.entity_id == body["id"]
    assert row.changes["name"] == {"from": None, "to": "On-call"}
    assert not set(DELIVERY_FIELDS) & row.changes.keys()


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


async def test_patch_round_trip(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Escalations"})
    gid = resp.json()["id"]

    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"name": "Escalation desk",
                                    "description": "Who gets paged",
                                    "enabled": False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "Escalation desk"
    assert body["description"] == "Who gets paged"
    assert body["enabled"] is False

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "group.update"))
    assert row is not None and row.entity_id == gid
    assert set(row.changes) == {"name", "description", "enabled"}


async def test_patch_with_nothing_changed_writes_no_audit(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Steady", "description": "Same"})
    gid = resp.json()["id"]

    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"description": "Same", "enabled": True})
    assert resp.status_code == 200, resp.text
    assert await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "group.update")) is None


async def test_patch_explicit_null_non_nullable_field_rejected(
        client, db, seeded_user):
    """An explicit null for a NOT NULL column must 422 up front, not
    reach the DB and 500 with an IntegrityError."""
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Null guard"})
    gid = resp.json()["id"]
    for field in ("name", "description", "categories", "enabled"):
        resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                                  json={field: None})
        assert resp.status_code == 422, f"{field}: {resp.text}"
        assert resp.json()["detail"]["code"] == "invalid"


# ── no delivery settings on a group ──────────────────────────────────

async def test_group_out_has_no_delivery_fields(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    created = await client.post("/notifications/groups", headers=hdrs,
                                json={"name": "Ops"})
    assert created.status_code == 201, created.text
    gid = created.json()["id"]
    listed = await client.get("/notifications/groups", headers=hdrs)
    detail = await client.get(f"/notifications/groups/{gid}", headers=hdrs)
    patched = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                                 json={"description": "Pager rota"})
    assert patched.status_code == 200, patched.text

    shown = {"POST": created.json(), "GET list": listed.json()[0],
             "GET one": detail.json(), "PATCH": patched.json()}
    for label, body in shown.items():
        assert not set(DELIVERY_FIELDS) & body.keys(), label
        assert set(body) == GROUP_KEYS | ({"members"} if label == "GET one" else set()), label


@pytest.mark.parametrize("field,value", DELIVERY_VALUES)
async def test_create_rejects_delivery_fields(client, db, seeded_user, field, value):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Ops", field: value})
    assert resp.status_code == 422, resp.text
    [error] = resp.json()["detail"]
    assert (error["type"], error["loc"]) == ("extra_forbidden", ["body", field])
    # nothing was created
    assert (await client.get("/notifications/groups", headers=hdrs)).json() == []


@pytest.mark.parametrize("field,value", DELIVERY_VALUES)
async def test_patch_rejects_delivery_fields(client, db, seeded_user, field, value):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Ops"})
    gid = resp.json()["id"]
    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"description": "changed", field: value})
    assert resp.status_code == 422, resp.text
    [error] = resp.json()["detail"]
    assert (error["type"], error["loc"]) == ("extra_forbidden", ["body", field])
    # the rest of the patch was not applied either
    assert (await client.get(f"/notifications/groups/{gid}",
                             headers=hdrs)).json()["description"] == ""


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


# ── members and recipients ───────────────────────────────────────────

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
    person = await _person(db, "Emma", "Emailer", email="emma@test.example.com")

    resp = await client.post(f"/notifications/groups/{gid}/members",
                             headers=hdrs, json={"person_id": str(person.id)})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["person_id"] == str(person.id)
    assert body["display_name"] == "Emma Emailer"
    assert body["email"] == "emma@test.example.com"
    assert body["has_account"] is False

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "member.add"))
    assert row is not None and row.entity_id == gid

    detail = await client.get(f"/notifications/groups/{gid}", headers=hdrs)
    assert detail.status_code == 200
    assert [m["person_id"] for m in detail.json()["members"]] == [str(person.id)]
    assert detail.json()["member_count"] == 1


async def test_member_out_has_only_who_they_are(client, db, seeded_user):
    """A member is a person on a list: no overrides, no effective settings, no
    channel capabilities (those are the recipients picker's, GET /recipients)."""
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Plain list"})
    gid = resp.json()["id"]
    person = await _person(db, "Pia", "Plain", email="pia@test.example.com",
                           phone="555-0101")

    added = await client.post(f"/notifications/groups/{gid}/members", headers=hdrs,
                              json={"person_id": str(person.id)})
    assert added.status_code == 201, added.text
    detail = await client.get(f"/notifications/groups/{gid}", headers=hdrs)
    [listed] = detail.json()["members"]
    for label, member in (("POST", added.json()), ("GET", listed)):
        assert set(member) == MEMBER_KEYS, label
        assert (member["email"], member["phone"]) == ("pia@test.example.com", "555-0101")


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


async def test_member_override_route_is_gone(client, db, seeded_user):
    """Overrides ended with the group delivery settings: the member path only
    deletes now, and a PATCH to it changes nothing."""
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "No overrides"})
    gid = resp.json()["id"]
    person = await _person(db, "Olive", "Override", email="olive@test.example.com")
    await client.post(f"/notifications/groups/{gid}/members", headers=hdrs,
                      json={"person_id": str(person.id)})

    for body in ({"channels": ["email"]}, {"quiet_mode": "none"}, {}):
        resp = await client.patch(
            f"/notifications/groups/{gid}/members/{person.id}", headers=hdrs, json=body)
        assert resp.status_code in (404, 405), resp.text
    # and the member is still there, unchanged
    detail = await client.get(f"/notifications/groups/{gid}", headers=hdrs)
    [member] = detail.json()["members"]
    assert member["person_id"] == str(person.id)
    assert set(member) == MEMBER_KEYS
    assert await db.get(NotificationGroupMember, (gid, person.id)) is not None


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


async def test_member_with_only_a_login_email(client, db, seeded_user):
    """A person with no profile email but an account joins like anyone else, and the
    recipients picker still says they can be emailed: the sender falls back to the
    sign-in email (spec section 8)."""
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Login only"})
    gid = resp.json()["id"]
    person = await _person(db, "Lou", "Login")          # no profile email
    db.add(UserAccount(person_id=person.id, email="lou@test.example.com",
                       password_hash="x"))
    await db.commit()

    resp = await client.post(f"/notifications/groups/{gid}/members",
                             headers=hdrs, json={"person_id": str(person.id)})
    assert resp.status_code == 201, resp.text
    assert (resp.json()["email"], resp.json()["has_account"]) == (None, True)

    detail = await client.get(f"/notifications/groups/{gid}", headers=hdrs)
    [member] = detail.json()["members"]
    assert (member["email"], member["has_account"]) == (None, True)

    recipients = await client.get("/notifications/recipients", headers=hdrs)
    lou = {row["person_id"]: row for row in recipients.json()}[str(person.id)]
    assert (lou["email"], lou["can_email"]) == (None, True)


def test_capabilities_needs_the_sign_in_email_by_name():
    """A caller can't leave the sign-in email out (that was the login-only
    bug: a person with only a sign-in email read as unreachable) or pass it
    by position."""
    person = Person(first_name="Lou", last_name="Login")         # no profile email
    with pytest.raises(TypeError):
        capabilities(person, True)
    with pytest.raises(TypeError):
        capabilities(person, True, "lou@test.example.com")
    assert capabilities(person, True, account_email="lou@test.example.com")["can_email"] is True
    assert capabilities(person, False, account_email=None)["can_email"] is False


# ── categories ───────────────────────────────────────────────────────

async def test_create_group_categories_deduped_in_registry_order(
        client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs, json={
        "name": "Cats", "categories": ["wiki", "reports", "wiki"]})
    assert resp.status_code == 201, resp.text
    assert resp.json()["categories"] == ["reports", "wiki"]

    resp = await client.get("/notifications/groups", headers=hdrs)
    assert resp.json()[0]["categories"] == ["reports", "wiki"]
    resp = await client.get(f"/notifications/groups/{resp.json()[0]['id']}",
                            headers=hdrs)
    assert resp.json()["categories"] == ["reports", "wiki"]


async def test_create_group_categories_default_empty(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "No cats"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["categories"] == []


async def test_patch_group_categories_and_audit(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs, json={
        "name": "Patchy", "categories": ["wiki"]})
    gid = resp.json()["id"]

    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"categories": ["security", "approvals"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["categories"] == ["approvals", "security"]
    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "group.update"))
    assert row is not None
    assert row.changes["categories"] == {
        "from": ["wiki"], "to": ["approvals", "security"]}

    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"categories": []})
    assert resp.status_code == 200, resp.text
    assert resp.json()["categories"] == []


async def test_bad_category_rejected(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs, json={
        "name": "Bogus", "categories": ["bogus"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_category"

    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Ok"})
    gid = resp.json()["id"]
    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"categories": ["wiki", "bogus"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_category"


async def test_patch_explicit_null_categories_rejected(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/notifications/groups", headers=hdrs,
                             json={"name": "Nully"})
    gid = resp.json()["id"]
    resp = await client.patch(f"/notifications/groups/{gid}", headers=hdrs,
                              json={"categories": None})
    assert resp.status_code == 422
