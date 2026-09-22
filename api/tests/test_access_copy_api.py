"""POST /access/copy — replace/add semantics per part, skips, dry run, audit."""
import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, AuditLog, Client, PermissionOverride,
    PersonRole, UserAccount,
)
from tests.test_access_roles_api import login_admin
from tests.test_users_api import _add_user


async def _grant(db, person, role, **kw):
    db.add(PersonRole(person_id=person.id, role=role, **kw))
    await db.commit()


async def _group(client, hdrs, name):
    return (await client.post("/access/groups", headers=hdrs,
                              json={"name": name})).json()["id"]


async def _setup(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    src = await _add_user(db, first="Sue", last="Source",
                          email="sue@test.example.com", role="staff")
    tgt = await _add_user(db, first="Tom", last="Target",
                          email="tom@test.example.com", role="worker")
    g_fin = await _group(client, hdrs, "Finance")
    g_ops = await _group(client, hdrs, "Ops")
    await client.put(f"/users/{src.id}/access-groups", headers=hdrs,
                     json={"group_ids": [g_fin]})
    await client.put(f"/users/{tgt.id}/access-groups", headers=hdrs,
                     json={"group_ids": [g_ops]})
    await client.put(f"/access/overrides/{src.id}", headers=hdrs,
                     json={"overrides": {"settings": {"change": True},
                                         "workers": {"delete": False}}})
    await client.put(f"/access/overrides/{tgt.id}", headers=hdrs,
                     json={"overrides": {"workers": {"delete": True},
                                         "sites": {"add": True}}})
    return hdrs, src, tgt, g_fin, g_ops


async def _roles(db, person_id):
    return set(await db.scalars(select(PersonRole.role).where(
        PersonRole.person_id == person_id, PersonRole.revoked_at.is_(None))))


async def _overrides(db, person_id):
    return {(o.resource, o.action): o.allow for o in await db.scalars(
        select(PermissionOverride).where(PermissionOverride.person_id == person_id))}


async def test_dry_run_plans_without_writing(client, db, seeded_user):
    hdrs, src, tgt, g_fin, g_ops = await _setup(client, db, seeded_user)
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["roles", "groups", "overrides"], "mode": "replace",
        "dry_run": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["applied"] is False
    row = body["targets"][0]
    assert row["status"] == "ok"
    assert row["roles"] == {"from": ["worker"], "to": ["staff"]}
    assert row["groups"] == {"from": ["Ops"], "to": ["Finance"]}
    assert row["overrides"] == {"added": 1, "removed": 1, "changed": 1}
    assert await _roles(db, tgt.id) == {"worker"}
    assert await db.scalar(select(AuditLog).where(AuditLog.action == "access.copy")) is None


async def test_replace_applies_every_part_and_audits(client, db, seeded_user):
    hdrs, src, tgt, g_fin, g_ops = await _setup(client, db, seeded_user)
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["roles", "groups", "overrides"], "mode": "replace",
        "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["applied"] is True
    assert await _roles(db, tgt.id) == {"staff"}
    groups = set(await db.scalars(select(AccessGroupMember.group_id).where(
        AccessGroupMember.person_id == tgt.id)))
    assert groups == {uuid.UUID(g_fin)}
    assert await _overrides(db, tgt.id) == {("settings", "change"): True,
                                            ("workers", "delete"): False}
    log = await db.scalar(select(AuditLog).where(AuditLog.action == "access.copy"))
    assert log.entity_type == "person" and log.entity_id == str(tgt.id)
    assert log.changes["source_id"] == str(src.id)
    assert log.changes["mode"] == "replace"
    assert log.changes["roles"] == {"from": ["worker"], "to": ["staff"]}
    assert log.changes["groups"] == {"from": ["Ops"], "to": ["Finance"]}
    assert set(log.changes["overrides"]) == {"settings:change", "workers:delete", "sites:add"}


async def test_add_mode_unions_and_source_wins_conflicts(client, db, seeded_user):
    hdrs, src, tgt, g_fin, g_ops = await _setup(client, db, seeded_user)
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["roles", "groups", "overrides"], "mode": "add",
        "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert await _roles(db, tgt.id) == {"worker", "staff"}
    groups = set(await db.scalars(select(AccessGroupMember.group_id).where(
        AccessGroupMember.person_id == tgt.id)))
    assert groups == {uuid.UUID(g_fin), uuid.UUID(g_ops)}
    assert await _overrides(db, tgt.id) == {("settings", "change"): True,
                                            ("workers", "delete"): False,
                                            ("sites", "add"): True}


async def test_parts_limit_what_changes(client, db, seeded_user):
    hdrs, src, tgt, g_fin, g_ops = await _setup(client, db, seeded_user)
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["groups"], "mode": "replace", "dry_run": False})
    assert resp.status_code == 200, resp.text
    row = resp.json()["targets"][0]
    assert row["roles"] is None and row["overrides"] is None
    assert await _roles(db, tgt.id) == {"worker"}
    log = await db.scalar(select(AuditLog).where(AuditLog.action == "access.copy"))
    assert set(log.changes) == {"source_id", "source_name", "mode", "parts", "groups"}


async def test_org_anchored_roles_are_never_copied_or_revoked(client, db, seeded_user):
    hdrs, src, tgt, *_ = await _setup(client, db, seeded_user)
    c = Client(name="Acme")
    db.add(c)
    await db.flush()
    await _grant(db, src, "client_viewer", client_id=c.id)
    await _grant(db, tgt, "client_admin", client_id=c.id)
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["roles"], "mode": "replace", "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["targets"][0]["roles"] == {"from": ["client_admin", "worker"],
                                                  "to": ["client_admin", "staff"]}
    assert await _roles(db, tgt.id) == {"staff", "client_admin"}
    # the audit row carries the same truthful diff — not the revocable-only
    # slice, which would read as if client_admin had been taken away
    log = await db.scalar(select(AuditLog).where(
        AuditLog.action == "access.copy", AuditLog.entity_id == str(tgt.id)))
    assert log.changes["roles"] == {"from": ["client_admin", "worker"],
                                    "to": ["client_admin", "staff"]}


async def test_skip_reasons(client, db, seeded_user):
    hdrs, src, tgt, *_ = await _setup(client, db, seeded_user)
    boss = await _add_user(db, first="Big", last="Boss",
                           email="boss@test.example.com", role="super_admin")
    no_account = await _add_user(db, first="No", last="Login",
                                 email="nolog@test.example.com", role="worker")
    await db.execute(UserAccount.__table__.delete().where(
        UserAccount.person_id == no_account.id))
    await db.commit()
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id),
        "target_ids": [str(seeded_user.id), str(no_account.id), str(boss.id), str(tgt.id)],
        "parts": ["roles"], "mode": "replace", "dry_run": False})
    assert resp.status_code == 200, resp.text
    by_id = {r["person_id"]: r for r in resp.json()["targets"]}
    assert by_id[str(seeded_user.id)]["reason"] == "cannot_target_self"
    assert by_id[str(no_account.id)]["reason"] == "no_account"
    assert by_id[str(boss.id)]["reason"] == "rank_too_low"
    assert by_id[str(tgt.id)]["status"] == "ok"
    assert await _roles(db, tgt.id) == {"staff"}
    assert await _roles(db, boss.id) == {"super_admin"}


async def test_role_rank_too_low_skips_target(client, db, seeded_user):
    hdrs, src, tgt, *_ = await _setup(client, db, seeded_user)
    # source holds a role the admin actor cannot grant
    await db.execute(PersonRole.__table__.update().where(
        PersonRole.person_id == src.id).values(role="super_admin"))
    await db.commit()
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["roles"], "mode": "replace", "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["targets"][0]["reason"] == "role_rank_too_low"
    assert await _roles(db, tgt.id) == {"worker"}


async def test_validation_and_source_guards(client, db, seeded_user):
    hdrs, src, tgt, *_ = await _setup(client, db, seeded_user)
    base = {"source_id": str(src.id), "target_ids": [str(tgt.id)],
            "parts": ["roles"], "mode": "replace", "dry_run": True}
    r = await client.post("/access/copy", headers=hdrs, json={**base, "target_ids": []})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "no_targets"
    r = await client.post("/access/copy", headers=hdrs, json={**base, "parts": []})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "no_parts"
    r = await client.post("/access/copy", headers=hdrs, json={**base, "parts": ["hats"]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unknown_part"
    r = await client.post("/access/copy", headers=hdrs, json={**base, "mode": "merge"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unknown_mode"
    r = await client.post("/access/copy", headers=hdrs,
                          json={**base, "source_id": str(uuid.uuid4())})
    assert r.status_code == 404 and r.json()["detail"]["code"] == "person_not_found"
    # copying FROM yourself is allowed
    r = await client.post("/access/copy", headers=hdrs,
                          json={**base, "source_id": str(seeded_user.id)})
    assert r.status_code == 200, r.text
    r = await client.post("/access/copy", headers=hdrs, json={
        **base, "target_ids": [str(uuid.uuid4()) for _ in range(201)]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "too_many_targets"


async def test_unknown_target_is_reported_not_dropped(client, db, seeded_user):
    hdrs, src, tgt, *_ = await _setup(client, db, seeded_user)
    ghost = uuid.uuid4()
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(ghost), str(tgt.id)],
        "parts": ["roles"], "mode": "replace", "dry_run": False})
    assert resp.status_code == 200, resp.text
    by_id = {r["person_id"]: r for r in resp.json()["targets"]}
    assert set(by_id) == {str(ghost), str(tgt.id)}
    row = by_id[str(ghost)]
    assert row["status"] == "skipped" and row["reason"] == "person_not_found"
    assert row["display_name"] == "Unknown person" and row["avatar_url"] is None
    assert by_id[str(tgt.id)]["status"] == "ok"
    assert await _roles(db, tgt.id) == {"staff"}
