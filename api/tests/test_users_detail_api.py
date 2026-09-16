"""GET /users/{id} (aggregated detail), GET /users/{id}/activity,
PUT /users/{id}/access-groups, POST /users/{id}/sessions/revoke-all."""

from sqlalchemy import select

from serversherpa.db.models import (
    AccessGroupMember, AuditLog, AuthSession, Client, NotificationGroup,
    NotificationGroupMember, Person, PersonRole, WorkerProfile,
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
    # staff has users:change and is global -> sessions visible for a
    # touchable (lower-rank) target;
    # a staff whose users:change is overridden off -> sessions null
    low = await _add_user(db, first="Lois", last="Low",
                          email="lois@test.example.com", role="worker")
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    hdrs = await _login(client, "alice@test.example.com")
    assert (await client.get(f"/users/{low.id}", headers=hdrs)).json()["sessions"] == []
    admin = await login_admin(client, db, seeded_user)
    assert (await client.put(f"/access/overrides/{wan.id}", headers=admin,
                             json={"overrides": {"users": {"change": False}}})).status_code == 200
    wan_hdrs = await _login(client, "wan@test.example.com")
    detail = (await client.get(f"/users/{seeded_user.id}", headers=wan_hdrs)).json()
    assert detail["sessions"] is None


async def test_detail_sessions_need_rank_check(client, db, seeded_user):
    # alice (staff, rank 40) can't see a super_admin's (rank 80) sessions,
    # but can see a worker's (rank 10) — the same "can this actor manage
    # this target" rule as edit/reset/disable, so a rank-40 staffer can't
    # read a founder's session IPs and user agents.
    boss = await _add_user(db, first="B", last="Oss",
                           email="boss@test.example.com", role="super_admin")
    worker = await _add_user(db, first="Wor", last="Ker",
                             email="worker@test.example.com", role="worker")
    hdrs = await _login(client, "alice@test.example.com")
    assert (await client.get(f"/users/{boss.id}", headers=hdrs)).json()["sessions"] is None
    assert (await client.get(f"/users/{worker.id}", headers=hdrs)).json()["sessions"] == []


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


async def test_detail_scope_conditions_for_a_self_anchored_actor(client, db, seeded_user):
    # `external` (scope_anchor="self") has no grants of its own — a
    # per-person override is the only way such an actor reaches this
    # endpoint at all (see _require_global's docstring: that "self"
    # visibility exists purely for an external contact to see their own
    # row via users:view; it is not scope-aware for mutating endpoints,
    # but GET /users/{id} filters by scope_conditions instead, so a
    # non-global actor here only ever sees their own row).
    ext = await _add_user(db, first="Ext", last="Ernal",
                          email="ext@test.example.com", role="external")
    other = await _add_user(db, first="Oth", last="Er",
                            email="other@test.example.com", role="worker")
    admin = await login_admin(client, db, seeded_user)
    assert (await client.put(f"/access/overrides/{ext.id}", headers=admin,
                             json={"overrides": {"users": {"view": True}}})).status_code == 200

    ext_hdrs = await _login(client, "ext@test.example.com")
    resp = await client.get(f"/users/{other.id}", headers=ext_hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "user_not_found"

    self_resp = await client.get(f"/users/{ext.id}", headers=ext_hdrs)
    assert self_resp.status_code == 200, self_resp.text
    body = self_resp.json()
    # NOTE: unlike "users", the "access" resource's visible_to never
    # includes "self" (resources.py hard-gates the whole resource to
    # global actors only) — no per-person override can widen that, so
    # a self-anchored actor's access block stays null even for their own
    # row. See report: this differs from the brief's expectation that
    # `access` would be populated here.
    assert body["access"] is None
    assert body["sessions"] is None


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


# ── PUT /users/{id}/access-groups ───────────────────────────────────

async def test_set_access_groups_diffs_and_audits(client, db, seeded_user):
    admin = await login_admin(client, db, seeded_user)
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    g1 = (await client.post("/access/groups", headers=admin, json={"name": "Finance"})).json()["id"]
    g2 = (await client.post("/access/groups", headers=admin, json={"name": "Ops"})).json()["id"]
    assert (await client.put(f"/access/groups/{g1}/members", headers=admin,
                             json={"person_ids": [str(wan.id)]})).status_code == 200

    resp = await client.put(f"/users/{wan.id}/access-groups", headers=admin,
                            json={"group_ids": [g2]})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"group_ids": [g2]}
    members = list(await db.scalars(
        select(AccessGroupMember.group_id).where(AccessGroupMember.person_id == wan.id)))
    assert [str(m) for m in members] == [g2]
    added = await db.scalar(select(AccessGroupMember.added_by)
                            .where(AccessGroupMember.person_id == wan.id))
    assert added == seeded_user.id

    log = await db.scalar(select(AuditLog).where(AuditLog.action == "access_groups.set"))
    assert log.entity_type == "person" and log.entity_id == str(wan.id)
    assert log.changes == {"groups": {"from": ["Finance"], "to": ["Ops"]}}

    # unknown group -> 404, nothing changed
    resp = await client.put(f"/users/{wan.id}/access-groups", headers=admin,
                            json={"group_ids": [g2, "00000000-0000-0000-0000-000000000001"]})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "group_not_found"


async def test_set_access_groups_to_empty_removes_membership(client, db, seeded_user):
    admin = await login_admin(client, db, seeded_user)
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    g1 = (await client.post("/access/groups", headers=admin, json={"name": "Finance"})).json()["id"]
    assert (await client.put(f"/access/groups/{g1}/members", headers=admin,
                             json={"person_ids": [str(wan.id)]})).status_code == 200

    resp = await client.put(f"/users/{wan.id}/access-groups", headers=admin,
                            json={"group_ids": []})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"group_ids": []}
    members = list(await db.scalars(
        select(AccessGroupMember.group_id).where(AccessGroupMember.person_id == wan.id)))
    assert members == []

    log = await db.scalar(select(AuditLog).where(AuditLog.action == "access_groups.set"))
    assert log.entity_type == "person" and log.entity_id == str(wan.id)
    assert log.changes == {"groups": {"from": ["Finance"], "to": []}}


async def test_set_access_groups_guards(client, db, seeded_user):
    admin = await login_admin(client, db, seeded_user)
    gid = (await client.post("/access/groups", headers=admin, json={"name": "Sec"})).json()["id"]
    # self
    resp = await client.put(f"/users/{seeded_user.id}/access-groups", headers=admin,
                            json={"group_ids": [gid]})
    assert resp.json()["detail"]["code"] == "cannot_target_self"
    # outranked target
    boss = await _add_user(db, first="B", last="Oss",
                           email="boss@test.example.com", role="super_admin")
    resp = await client.put(f"/users/{boss.id}/access-groups", headers=admin,
                            json={"group_ids": [gid]})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"


# ── POST /users/{id}/sessions/revoke-all ────────────────────────────

async def test_revoke_all_sessions(client, db, seeded_user):
    admin = await login_admin(client, db, seeded_user)
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    await _token(client, email="wan@test.example.com")
    await _token(client, email="wan@test.example.com")
    live = list(await db.scalars(select(AuthSession).where(
        AuthSession.person_id == wan.id, AuthSession.revoked_at.is_(None))))
    assert len(live) >= 2

    wan_id = wan.id
    resp = await client.post(f"/users/{wan_id}/sessions/revoke-all", headers=admin)
    assert resp.status_code == 204, resp.text
    db.expire_all()
    still_live = list(await db.scalars(select(AuthSession).where(
        AuthSession.person_id == wan_id, AuthSession.revoked_at.is_(None))))
    assert still_live == []
    log = await db.scalar(select(AuditLog).where(AuditLog.action == "session.revoke_all"))
    assert log.entity_type == "auth" and log.entity_id == str(wan_id)

    body = (await client.get(f"/users/{wan_id}", headers=admin)).json()
    assert body["sessions"] == []


async def test_revoke_all_sessions_requires_users_change(client, db, seeded_user):
    target = await _add_user(db, first="Tar", last="Get",
                             email="target@test.example.com", role="staff")
    await _add_user(db, first="Wor", last="Ker",
                    email="worker@test.example.com", role="worker")
    worker_hdrs = await _login(client, "worker@test.example.com")   # no users:change
    resp = await client.post(f"/users/{target.id}/sessions/revoke-all", headers=worker_hdrs)
    assert resp.status_code == 403
