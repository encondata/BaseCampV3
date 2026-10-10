"""Parent and subsidiary partners: parent_id validation (self / scope /
cycle), the OrgItem fields, the children list, audit, and the cycle lock."""

import asyncio
import uuid

from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, PersonRole
from tests.test_stakeholders import _anchored_login, _headers


async def _mk(client, headers, name, **extra):
    resp = await client.post("/partners", headers=headers,
                             json={"name": name, **extra})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _set_parent(client, headers, child_id, parent_id):
    return await client.patch(f"/partners/{child_id}", headers=headers,
                              json={"parent_id": parent_id})


def _code(resp):
    return resp.json()["detail"]["code"]


async def test_create_with_a_parent(client, seeded_user):
    h = await _headers(client)
    parent = await _mk(client, h, "Parent Co")
    child = await _mk(client, h, "Child Co", parent_id=parent["id"])
    assert child["parent_id"] == parent["id"]
    assert child["parent_name"] == "Parent Co"
    assert child["child_count"] == 0
    got = (await client.get(f"/partners/{parent['id']}", headers=h)).json()
    assert got["parent_id"] is None
    assert got["parent_name"] is None
    assert got["child_count"] == 1


async def test_patch_sets_and_null_clears(client, seeded_user):
    h = await _headers(client)
    parent = await _mk(client, h, "Parent Co")
    child = await _mk(client, h, "Child Co")
    assert child["parent_id"] is None
    resp = await _set_parent(client, h, child["id"], parent["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["parent_name"] == "Parent Co"
    resp = await _set_parent(client, h, child["id"], None)
    assert resp.status_code == 200, resp.text
    assert resp.json()["parent_id"] is None
    assert resp.json()["parent_name"] is None
    assert (await client.get(f"/partners/{parent['id']}",
                             headers=h)).json()["child_count"] == 0


async def test_a_patch_without_parent_leaves_it_alone(client, seeded_user):
    h = await _headers(client)
    parent = await _mk(client, h, "Parent Co")
    child = await _mk(client, h, "Child Co", parent_id=parent["id"])
    resp = await client.patch(f"/partners/{child['id']}", headers=h,
                              json={"city": "Reno"})
    assert resp.status_code == 200
    assert resp.json()["parent_id"] == parent["id"]


async def test_self_parent_is_422(client, seeded_user):
    h = await _headers(client)
    a = await _mk(client, h, "Alpha")
    resp = await _set_parent(client, h, a["id"], a["id"])
    assert resp.status_code == 422
    assert _code(resp) == "self_parent"


async def test_unknown_parent_is_422(client, seeded_user):
    h = await _headers(client)
    a = await _mk(client, h, "Alpha")
    resp = await _set_parent(client, h, a["id"], str(uuid.uuid4()))
    assert resp.status_code == 422
    assert _code(resp) == "parent_not_found"
    resp = await client.post("/partners", headers=h, json={
        "name": "Beta", "parent_id": str(uuid.uuid4())})
    assert resp.status_code == 422
    assert _code(resp) == "parent_not_found"
    # the failed create left nothing behind
    names = [p["name"] for p in (await client.get("/partners", headers=h)).json()]
    assert names == ["Alpha"]


async def test_out_of_scope_parent_is_422(client, db, seeded_user):
    h = await _headers(client)
    mine = await _mk(client, h, "Mine")
    other = await _mk(client, h, "Other")
    owner = await _anchored_login(db, client, "vendor_owner",
                                  "pp-owner@test.example.com",
                                  partner_id=mine["id"])
    resp = await _set_parent(client, owner, mine["id"], other["id"])
    assert resp.status_code == 422
    assert _code(resp) == "parent_not_found"


async def test_direct_and_three_level_cycles_are_422(client, seeded_user):
    h = await _headers(client)
    a = await _mk(client, h, "A")
    b = await _mk(client, h, "B")
    c = await _mk(client, h, "C")
    assert (await _set_parent(client, h, b["id"], a["id"])).status_code == 200
    resp = await _set_parent(client, h, a["id"], b["id"])
    assert resp.status_code == 422
    assert _code(resp) == "circular_parent"
    assert (await _set_parent(client, h, c["id"], b["id"])).status_code == 200
    resp = await _set_parent(client, h, a["id"], c["id"])
    assert resp.status_code == 422
    assert _code(resp) == "circular_parent"
    assert (await client.get(f"/partners/{a['id']}",
                             headers=h)).json()["parent_id"] is None


async def test_deep_chains_have_no_depth_limit_and_archived_parents_work(
        client, seeded_user):
    h = await _headers(client)
    parent = await _mk(client, h, "Retired Parent")
    assert (await client.post(f"/partners/{parent['id']}/archive",
                              headers=h)).status_code == 204
    child = await _mk(client, h, "Under Retired", parent_id=parent["id"])
    assert child["parent_name"] == "Retired Parent"
    prev = child
    for i in range(5):
        prev = await _mk(client, h, f"Level {i}", parent_id=prev["id"])
    assert prev["parent_id"] is not None


async def test_clients_router_rejects_parent_id(client, seeded_user):
    h = await _headers(client)
    org = (await client.post("/clients", headers=h,
                             json={"name": "Acme"})).json()
    resp = await client.patch(f"/clients/{org['id']}", headers=h,
                              json={"parent_id": None})
    assert resp.status_code == 422
    assert _code(resp) == "parent_not_allowed"
    resp = await client.post("/clients", headers=h, json={
        "name": "Bravo", "parent_id": str(uuid.uuid4())})
    assert resp.status_code == 422
    assert _code(resp) == "parent_not_allowed"
    # the client payload is unchanged
    body = (await client.get(f"/clients/{org['id']}", headers=h)).json()
    assert "parent_id" not in body
    assert "parent_name" not in body
    assert "child_count" not in body


async def test_list_carries_parent_fields_set_based(client, seeded_user):
    h = await _headers(client)
    p = await _mk(client, h, "Parent")
    await _mk(client, h, "Kid 1", parent_id=p["id"])
    k2 = await _mk(client, h, "Kid 2", parent_id=p["id"])
    await _mk(client, h, "Grandkid", parent_id=k2["id"])
    rows = {r["name"]: r for r in (await client.get("/partners", headers=h)).json()}
    assert rows["Parent"]["child_count"] == 2
    assert rows["Kid 1"]["parent_name"] == "Parent"
    assert rows["Kid 2"]["child_count"] == 1
    assert rows["Grandkid"]["parent_id"] == k2["id"]
    assert rows["Grandkid"]["parent_name"] == "Kid 2"


async def test_scoped_user_sees_parent_and_children_only_where_in_scope(
        client, db, seeded_user):
    h = await _headers(client)
    p = await _mk(client, h, "Parent")
    c1 = await _mk(client, h, "Child One", parent_id=p["id"])
    c2 = await _mk(client, h, "Child Two", parent_id=p["id"])
    # a viewer of the child alone: the parent is out of scope
    only_child = await _anchored_login(db, client, "vendor_viewer",
                                       "pp-child@test.example.com",
                                       partner_id=c1["id"])
    got = (await client.get(f"/partners/{c1['id']}", headers=only_child)).json()
    assert got["parent_id"] is None
    assert got["parent_name"] is None
    # a viewer of the parent alone: child_count only counts visible children
    only_parent = await _anchored_login(db, client, "vendor_viewer",
                                        "pp-parent@test.example.com",
                                        partner_id=p["id"])
    got = (await client.get(f"/partners/{p['id']}", headers=only_parent)).json()
    assert got["child_count"] == 0
    resp = await client.get(f"/partners/{p['id']}/children", headers=only_parent)
    assert resp.status_code == 200
    assert resp.json() == []
    # a viewer of parent and one child sees exactly that child
    both = await _anchored_login(db, client, "vendor_viewer",
                                 "pp-both@test.example.com",
                                 partner_id=p["id"])
    person_id = await db.scalar(text(
        "SELECT person_id FROM user_accounts WHERE email='pp-both@test.example.com'"))
    db.add(PersonRole(person_id=person_id, role="vendor_viewer",
                      partner_id=uuid.UUID(c2["id"])))
    await db.commit()
    got = (await client.get(f"/partners/{p['id']}", headers=both)).json()
    assert got["child_count"] == 1
    kids = (await client.get(f"/partners/{p['id']}/children", headers=both)).json()
    assert [k["name"] for k in kids] == ["Child Two"]
    listing = {r["name"]: r for r in (await client.get("/partners", headers=both)).json()}
    assert listing["Child Two"]["parent_name"] == "Parent"
    assert set(listing) == {"Parent", "Child Two"}


async def test_children_endpoint_sorted_naturally(client, seeded_user):
    h = await _headers(client)
    p = await _mk(client, h, "Parent")
    for name in ("Crew 10", "Crew 2", "Crew 1"):
        await _mk(client, h, name, parent_id=p["id"])
    await _mk(client, h, "Unrelated")
    kids = (await client.get(f"/partners/{p['id']}/children", headers=h)).json()
    assert [k["name"] for k in kids] == ["Crew 1", "Crew 2", "Crew 10"]
    assert kids[0]["parent_name"] == "Parent"
    assert (await client.get(f"/partners/{kids[0]['id']}/children",
                             headers=h)).json() == []


async def test_children_includes_archived_children(client, seeded_user):
    h = await _headers(client)
    p = await _mk(client, h, "Parent")
    k = await _mk(client, h, "Kid", parent_id=p["id"])
    await client.post(f"/partners/{k['id']}/archive", headers=h)
    kids = (await client.get(f"/partners/{p['id']}/children", headers=h)).json()
    assert [x["name"] for x in kids] == ["Kid"]
    assert kids[0]["archived_at"] is not None
    assert (await client.get(f"/partners/{p['id']}",
                             headers=h)).json()["child_count"] == 1


async def test_children_404_for_missing_or_invisible_partner(client, db, seeded_user):
    h = await _headers(client)
    mine = await _mk(client, h, "Mine")
    other = await _mk(client, h, "Other")
    owner = await _anchored_login(db, client, "vendor_viewer",
                                  "pp-viewer@test.example.com",
                                  partner_id=mine["id"])
    resp = await client.get(f"/partners/{other['id']}/children", headers=owner)
    assert resp.status_code == 404
    resp = await client.get(f"/partners/{uuid.uuid4()}/children", headers=h)
    assert resp.status_code == 404


async def test_parent_change_is_audited(client, db, seeded_user):
    h = await _headers(client)
    parent = await _mk(client, h, "Parent")
    child = await _mk(client, h, "Kid")
    assert (await _set_parent(client, h, child["id"], parent["id"])).status_code == 200
    assert (await _set_parent(client, h, child["id"], None)).status_code == 200
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "partner", AuditLog.entity_id == child["id"],
        AuditLog.action == "update").order_by(AuditLog.at))).all()
    assert [r.changes["parent_id"] for r in rows] == [
        {"from": None, "to": parent["id"]},
        {"from": parent["id"], "to": None},
    ]


async def test_cycle_race_is_serialized_by_the_lock(client, db, seeded_user):
    """A→B committed by a rival while this PATCH (B→A) waits on the lock:
    the check runs after the lock is acquired, so it sees the rival edge."""
    from serversherpa.api.routes.stakeholders import PARTNER_GRAPH_LOCK_KEY
    from serversherpa.db.engine import get_sessionmaker

    h = await _headers(client)
    a = await _mk(client, h, "Alpha")
    b = await _mk(client, h, "Bravo")
    async with get_sessionmaker()() as rival:
        await rival.execute(text("SELECT pg_advisory_xact_lock(:key)"),
                            {"key": PARTNER_GRAPH_LOCK_KEY})
        await rival.execute(text("UPDATE partners SET parent_id=:p WHERE id=:c"),
                            {"p": b["id"], "c": a["id"]})
        task = asyncio.ensure_future(_set_parent(client, h, b["id"], a["id"]))
        await asyncio.sleep(0.3)
        assert not task.done()  # waiting on the lock
        await rival.commit()
    resp = await task
    assert resp.status_code == 422, resp.text
    assert _code(resp) == "circular_parent"
