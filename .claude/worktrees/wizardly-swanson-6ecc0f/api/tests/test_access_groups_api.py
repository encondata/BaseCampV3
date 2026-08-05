import pytest
from sqlalchemy import select, text

from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, Person, PersonRole, ResourceGroupGate,
)
from tests.test_access_roles_api import login_admin


async def test_group_crud_members_gates(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/access/groups", headers=hdrs,
                             json={"name": "Finance", "icon": "dollar"})
    assert resp.status_code == 201, resp.text
    gid = resp.json()["id"]

    staffer = Person(first_name="S", last_name="Member")
    db.add(staffer)
    await db.flush()
    db.add(PersonRole(person_id=staffer.id, role="staff"))
    await db.commit()

    resp = await client.put(f"/access/groups/{gid}/members", headers=hdrs,
                            json={"person_ids": [str(staffer.id)]})
    assert resp.status_code == 200
    members = list(await db.scalars(select(AccessGroupMember.person_id)))
    assert members == [staffer.id]

    resp = await client.put("/access/resources/clients/gates", headers=hdrs,
                            json={"group_ids": [gid]})
    assert resp.status_code == 200
    gates = list(await db.scalars(select(ResourceGroupGate.resource)))
    assert gates == ["clients"]

    resp = await client.put("/access/resources/access/gates", headers=hdrs,
                            json={"group_ids": [gid]})
    assert resp.json()["detail"]["code"] == "resource_not_gateable"

    resp = await client.delete(f"/access/groups/{gid}", headers=hdrs)
    assert resp.status_code == 204
    assert (await db.execute(select(ResourceGroupGate))).first() is None  # cascaded


async def test_membership_rank_rule(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/access/groups", headers=hdrs, json={"name": "Sec"})
    gid = resp.json()["id"]
    boss = Person(first_name="B", last_name="Oss")
    db.add(boss)
    await db.flush()
    db.add(PersonRole(person_id=boss.id, role="super_admin"))
    await db.commit()
    resp = await client.put(f"/access/groups/{gid}/members", headers=hdrs,
                            json={"person_ids": [str(boss.id)]})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"
