import pytest
from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, PersonRole, Role


async def login_admin(client, db, seeded_user):
    """Upgrade alice to admin, then log in."""
    await db.execute(text(
        "UPDATE person_roles SET role='admin' WHERE person_id=:p"),
        {"p": seeded_user.id})
    await db.commit()
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    d = resp.json()
    return {"Authorization": f"Bearer {d['access_token']}"}


def full_matrix(*, workers_delete=True):
    from serversherpa.access.defaults import DEFAULT_GRANTS
    from serversherpa.access.resources import ACTIONS, REGISTRY
    grants = DEFAULT_GRANTS["staff"]
    m = {res: {a: a in grants.get(res, ()) for a in ACTIONS} for res in REGISTRY}
    m["workers"]["delete"] = workers_delete
    return m


async def test_admin_edits_staff_matrix_and_audits(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.put("/access/roles/staff/matrix", headers=hdrs,
                            json={"matrix": full_matrix(workers_delete=False)})
    assert resp.status_code == 200, resp.text
    n = (await db.execute(text(
        "SELECT count(*) FROM role_permissions "
        "WHERE role='staff' AND resource='workers' AND action='delete'"
    ))).scalar_one()
    assert n == 0
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "matrix.update"))
    assert row is not None and row.entity_id == "staff"


async def test_admin_cannot_edit_own_or_higher_rank_role(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    for role in ("admin", "super_admin"):
        resp = await client.put(f"/access/roles/{role}/matrix", headers=hdrs,
                                json={"matrix": full_matrix()})
        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "rank_too_low"


async def test_devtools_and_access_view_locked(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    m = full_matrix()
    m["devtools"]["view"] = True
    resp = await client.put("/access/roles/staff/matrix", headers=hdrs,
                            json={"matrix": m})
    assert resp.json()["detail"]["code"] == "developer_only_resource"
    m = full_matrix()
    m["access"]["view"] = False
    resp = await client.put("/access/roles/staff/matrix", headers=hdrs,
                            json={"matrix": m})
    assert resp.json()["detail"]["code"] == "access_view_locked"


async def test_clone_and_delete_custom_role(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/access/roles", headers=hdrs, json={
        "source": "staff", "name": "ops_lead", "label": "Ops lead", "rank": 45})
    assert resp.status_code == 201, resp.text
    role = await db.get(Role, "ops_lead")
    assert role.rank == 45 and role.scope_anchor == "global" and not role.is_system
    # clone above own rank rejected
    resp = await client.post("/access/roles", headers=hdrs, json={
        "source": "staff", "name": "boss", "label": "Boss", "rank": 60})
    assert resp.status_code == 403
    # delete blocked while granted
    db.add(PersonRole(person_id=seeded_user.id, role="ops_lead"))
    await db.commit()
    resp = await client.delete("/access/roles/ops_lead", headers=hdrs)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "role_in_use"
    # soft-revoke (the app's revoke path keeps the row for history) —
    # historical grants still block deletion
    await db.execute(text(
        "UPDATE person_roles SET revoked_at=now() WHERE role='ops_lead'"))
    await db.commit()
    resp = await client.delete("/access/roles/ops_lead", headers=hdrs)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "role_in_use"
    # a never-granted clone deletes cleanly
    resp = await client.post("/access/roles", headers=hdrs, json={
        "source": "staff", "name": "temp_role", "label": "Temp", "rank": 30})
    assert resp.status_code == 201, resp.text
    resp = await client.delete("/access/roles/temp_role", headers=hdrs)
    assert resp.status_code == 204
    resp = await client.delete("/access/roles/staff", headers=hdrs)
    assert resp.json()["detail"]["code"] == "system_role"
