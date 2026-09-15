"""GET /users/{id} (aggregated detail), GET /users/{id}/activity,
PUT /users/{id}/access-groups, POST /users/{id}/sessions/revoke-all."""

from serversherpa.db.models import (
    AuditLog, Client, NotificationGroup, NotificationGroupMember, Person, PersonRole, WorkerProfile,
)
from tests.test_access_roles_api import login_admin
from tests.test_users_api import _add_user, _token

H = lambda token: {"Authorization": f"Bearer {token}"}  # noqa: E731


async def _login(client, email):
    return H(await _token(client, email=email))


# ── GET /users/{id} ─────────────────────────────────────────────────

async def test_detail_full_payload_for_admin(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)          # alice -> admin (rank 60)
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    # a client-anchored grant with an org name + a granter
    acme = Client(name="Acme")
    db.add(acme)
    await db.flush()
    db.add(PersonRole(person_id=wan.id, role="client_admin", client_id=acme.id,
                      granted_by=seeded_user.id))
    # worker profile
    db.add(WorkerProfile(person_id=wan.id, trade="Cabling", status="active"))
    # notification group membership
    ng = NotificationGroup(name="Ops", description="", channels=["email"],
                           timezone="America/New_York", active_days=["mon"],
                           dnd_behavior="defer", urgent_bypass=False, enabled=True)
    db.add(ng)
    await db.flush()
    db.add(NotificationGroupMember(group_id=ng.id, person_id=wan.id, channels=["web"]))
    await db.commit()
    # access group via the real endpoint (adds added_by)
    gid = (await client.post("/access/groups", headers=hdrs,
                             json={"name": "Finance"})).json()["id"]
    assert (await client.put(f"/access/groups/{gid}/members", headers=hdrs,
                             json={"person_ids": [str(wan.id)]})).status_code == 200
    assert (await client.put("/access/resources/clients/gates", headers=hdrs,
                             json={"group_ids": [gid]})).status_code == 200
    # an override
    assert (await client.put(f"/access/overrides/{wan.id}", headers=hdrs,
                             json={"overrides": {"sites": {"delete": True}}})).status_code == 200
    # wan signs in once so a live session exists
    await _token(client, email="wan@test.example.com")

    resp = await client.get(f"/users/{wan.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["person"]["display_name"] == "Wan Worker"
    assert body["person"]["source"] == "manual"
    assert body["account"]["login_email"] == "wan@test.example.com"
    assert body["account"]["status"] == "active"
    assert body["account"]["last_login_at"] is not None

    roles = {r["role"]: r for r in body["roles"]}
    assert set(roles) == {"staff", "client_admin"}
    assert roles["client_admin"]["org"] == {"kind": "client", "id": str(acme.id), "name": "Acme"}
    assert roles["client_admin"]["granted_by"]["display_name"] == "Alice Anderson"
    assert roles["staff"]["org"] is None
    assert body["max_rank"] == 40

    assert body["worker"]["trade"] == "Cabling"
    assert body["worker"]["status_label"]            # vocabulary label resolved
    assert body["worker"]["partner"] is None

    assert body["notification_groups"] == [
        {"id": str(ng.id), "name": "Ops", "channels": ["web"],
         "added_at": body["notification_groups"][0]["added_at"]}]

    acc = body["access"]
    assert acc is not None
    assert [g["name"] for g in acc["groups"]] == ["Finance"]
    assert acc["groups"][0]["gate_count"] == 1
    assert acc["groups"][0]["gated_pages"] == ["Clients"]
    assert acc["groups"][0]["added_by"]["display_name"] == "Alice Anderson"
    assert acc["overrides"] == [{
        "resource": "sites", "resource_label": "Sites", "action": "delete", "allow": True,
        "set_by": acc["overrides"][0]["set_by"], "set_at": acc["overrides"][0]["set_at"]}]
    assert acc["overrides"][0]["set_by"]["display_name"] == "Alice Anderson"
    assert acc["scope"]["client_ids"] == [str(acme.id)]
    assert acc["scope_orgs"] == [{"kind": "client", "id": str(acme.id), "name": "Acme"}]
    assert acc["cells"]["sites"]["delete"] == {"value": True, "source": "override"}

    assert len(body["sessions"]) == 1
    assert body["sessions"][0]["family_id"]


async def test_detail_access_block_follows_rank_60_rule(client, db, seeded_user):
    # alice stays staff (rank 40): other -> access null, self -> populated
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    hdrs = await _login(client, "alice@test.example.com")
    other = (await client.get(f"/users/{wan.id}", headers=hdrs)).json()
    assert other["access"] is None
    me = (await client.get(f"/users/{seeded_user.id}", headers=hdrs)).json()
    assert me["access"] is not None
    assert me["access"]["groups"] == []


async def test_detail_sessions_need_users_change(client, db, seeded_user):
    # staff has users:change and is global -> sessions visible;
    # a staff whose users:change is overridden off -> sessions null
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    hdrs = await _login(client, "alice@test.example.com")
    assert (await client.get(f"/users/{wan.id}", headers=hdrs)).json()["sessions"] == []
    admin = await login_admin(client, db, seeded_user)
    assert (await client.put(f"/access/overrides/{wan.id}", headers=admin,
                             json={"overrides": {"users": {"change": False}}})).status_code == 200
    wan_hdrs = await _login(client, "wan@test.example.com")
    detail = (await client.get(f"/users/{seeded_user.id}", headers=wan_hdrs)).json()
    assert detail["sessions"] is None


async def test_detail_404_without_account_and_403_for_worker(client, db, seeded_user):
    hdrs = await _login(client, "alice@test.example.com")
    ghost = Person(first_name="No", last_name="Account")
    db.add(ghost)
    await db.commit()
    resp = await client.get(f"/users/{ghost.id}", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "user_not_found"

    await _add_user(db, first="Wan", last="Worker",
                    email="wan@test.example.com", role="worker")
    wan_hdrs = await _login(client, "wan@test.example.com")
    assert (await client.get(f"/users/{seeded_user.id}", headers=wan_hdrs)).status_code == 403


# ── GET /users/{id}/activity ────────────────────────────────────────

async def test_activity_requires_audit_view(client, db, seeded_user):
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    staff = await _login(client, "alice@test.example.com")     # staff has no audit:view
    assert (await client.get(f"/users/{wan.id}/activity", headers=staff)).status_code == 403


async def test_activity_rows_acted_and_about(client, db, seeded_user):
    admin = await login_admin(client, db, seeded_user)
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    # about-wan row (actor = alice) via the real roles endpoint
    assert (await client.put(f"/users/{wan.id}/roles", headers=admin,
                             json={"roles": ["staff", "worker"]})).status_code == 200
    # acted-by-wan row
    db.add(AuditLog(actor_person_id=wan.id, entity_type="site", entity_id=None,
                    action="site.create", changes={}))
    await db.commit()

    resp = await client.get(f"/users/{wan.id}/activity", headers=admin)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    by_action = {r["action"]: r for r in rows}
    assert by_action["role.set"]["by_me"] is False
    assert by_action["role.set"]["actor_name"] == "Alice Anderson"
    assert by_action["site.create"]["by_me"] is True
    assert by_action["site.create"]["actor_name"] is None

    ghost = Person(first_name="No", last_name="Account")
    db.add(ghost)
    await db.commit()
    assert (await client.get(f"/users/{ghost.id}/activity", headers=admin)).status_code == 404
