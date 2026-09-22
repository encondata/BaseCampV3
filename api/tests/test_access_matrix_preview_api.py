"""POST /access/roles/{name}/matrix/preview — who a matrix change affects."""
from sqlalchemy import select, text

from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, PermissionOverride, Person, PersonRole,
    ResourceGroupGate, RolePermission,
)
from tests.test_access_roles_api import full_matrix, login_admin


async def _staffer(db, first):
    p = Person(first_name=first, last_name="Staff")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="staff"))
    await db.commit()
    return p


async def test_preview_lists_flips_and_masks(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    plain = await _staffer(db, "Plain")
    overridden = await _staffer(db, "Over")
    db.add(PermissionOverride(person_id=overridden.id, resource="workers",
                              action="delete", allow=True))
    await db.commit()

    matrix = full_matrix(workers_delete=False)
    matrix["settings"]["change"] = True
    resp = await client.post("/access/roles/staff/matrix/preview", headers=hdrs,
                             json={"matrix": matrix})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == "staff"
    assert body["granted"] == ["settings:change"]
    assert body["revoked"] == ["workers:delete"]
    assert body["member_count"] == 2
    assert body["affected_count"] == 2
    by_name = {m["display_name"]: m for m in body["members"]}
    p = by_name["Plain Staff"]
    assert {(f["resource"], f["action"], f["to"]) for f in p["flips"]} == {
        ("workers", "delete", False), ("settings", "change", True)}
    assert p["masked"] == []
    o = by_name["Over Staff"]
    assert [(f["resource"], f["action"]) for f in o["flips"]] == [("settings", "change")]
    assert o["masked"] == [{"resource": "workers", "action": "delete", "by": "override"}]
    # nothing was written
    n = (await db.execute(text(
        "SELECT count(*) FROM role_permissions WHERE role='staff' "
        "AND resource='workers' AND action='delete'"))).scalar_one()
    assert n == 1


async def test_preview_masks_gate_and_other_role(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    gated = await _staffer(db, "Gated")
    g = AccessGroup(name="Finance")
    db.add(g)
    await db.flush()
    db.add(ResourceGroupGate(resource="settings", group_id=g.id))
    two = await _staffer(db, "Two")
    db.add(PersonRole(person_id=two.id, role="worker"))
    await db.commit()

    matrix = full_matrix()
    matrix["settings"]["change"] = True          # gated for Gated (not a member)
    matrix["workers"]["view"] = False            # worker still grants workers:view for Two
    resp = await client.post("/access/roles/staff/matrix/preview", headers=hdrs,
                             json={"matrix": matrix})
    assert resp.status_code == 200, resp.text
    by_name = {m["display_name"]: m for m in resp.json()["members"]}
    assert {"resource": "settings", "action": "change", "by": "gate"} in by_name["Gated Staff"]["masked"]
    assert {"resource": "workers", "action": "view", "by": "role"} in by_name["Two Staff"]["masked"]


async def test_preview_empty_role_and_guards(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/access/roles/staff/matrix/preview", headers=hdrs,
                             json={"matrix": full_matrix()})
    assert resp.status_code == 200, resp.text
    assert resp.json()["member_count"] == 0 and resp.json()["members"] == []
    assert resp.json()["granted"] == [] and resp.json()["revoked"] == []
    # same guards as the PUT
    resp = await client.post("/access/roles/admin/matrix/preview", headers=hdrs,
                             json={"matrix": full_matrix()})
    assert resp.status_code == 403
    m = full_matrix()
    m["access"]["view"] = False
    resp = await client.post("/access/roles/staff/matrix/preview", headers=hdrs,
                             json={"matrix": m})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "access_view_locked"
