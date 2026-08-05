"""Unit tests for effective-permission resolution — precedence, hard gates,
group gating, floor, multi-role union, scope sets, rank rules."""
import pytest
from sqlalchemy import text

from serversherpa.access.resolver import can_touch_rank, resolve_access
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, Client, Partner, PermissionOverride,
    Person, PersonRole, ResourceGroupGate,
)


async def make_person(db, role, *, client_id=None, partner_id=None):
    p = Person(first_name="T", last_name=role)
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role=role,
                      client_id=client_id, partner_id=partner_id))
    await db.commit()
    return p


async def test_role_grants_flow_through(db):
    p = await make_person(db, "staff")
    a = await resolve_access(db, p.id)
    assert a.perms["workers"] == {"view": True, "add": True,
                                  "change": True, "delete": True}
    assert a.perms["settings"]["change"] is False
    assert a.max_rank == 40 and a.is_global


async def test_override_beats_role(db):
    p = await make_person(db, "staff")
    db.add(PermissionOverride(person_id=p.id, resource="workers",
                              action="delete", allow=False))
    db.add(PermissionOverride(person_id=p.id, resource="settings",
                              action="change", allow=True))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["workers"]["delete"] is False   # deny beats role grant
    assert a.perms["settings"]["change"] is True   # allow beats role absence


async def test_group_gate_blocks_nonmembers_below_rank_60(db):
    p = await make_person(db, "staff")
    g = AccessGroup(name="Finance")
    db.add(g)
    await db.flush()
    db.add(ResourceGroupGate(resource="clients", group_id=g.id))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["clients"]["view"] is False     # staff (40) gated off
    db.add(AccessGroupMember(group_id=g.id, person_id=p.id))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["clients"]["view"] is True      # member again


async def test_rank_60_bypasses_gate(db):
    p = await make_person(db, "admin")
    g = AccessGroup(name="Finance")
    db.add(g)
    await db.flush()
    db.add(ResourceGroupGate(resource="clients", group_id=g.id))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["clients"]["view"] is True


async def test_override_beats_group_gate(db):
    p = await make_person(db, "staff")
    g = AccessGroup(name="Finance")
    db.add(g)
    await db.flush()
    db.add(ResourceGroupGate(resource="clients", group_id=g.id))
    db.add(PermissionOverride(person_id=p.id, resource="clients",
                              action="view", allow=True))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["clients"]["view"] is True


async def test_developer_only_immune_to_matrix_and_overrides(db):
    p = await make_person(db, "founder")
    db.add(PermissionOverride(person_id=p.id, resource="devtools",
                              action="view", allow=True))
    await db.execute(text(
        "INSERT INTO role_permissions (role, resource, action) "
        "VALUES ('founder','devtools','view') ON CONFLICT DO NOTHING"))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["devtools"]["view"] is False    # hard gate wins
    d = await make_person(db, "developer")
    ad = await resolve_access(db, d.id)
    assert ad.perms["devtools"]["view"] is True


async def test_always_viewable_floor_and_anchor_gate(db):
    staff = await make_person(db, "staff")
    a = await resolve_access(db, staff.id)
    assert a.perms["access"]["view"] is True       # floor for global anchor
    c = Client(name="Acme")
    db.add(c)
    await db.flush()
    ext = await make_person(db, "client_viewer", client_id=c.id)
    ae = await resolve_access(db, ext.id)
    assert ae.perms["access"]["view"] is False     # anchor gate beats floor
    assert ae.perms["users"]["view"] is False      # users invisible to client anchor
    assert ae.perms["clients"]["view"] is True
    assert ae.client_ids == {c.id} and not ae.is_global


async def test_multi_role_union(db):
    c = Client(name="Acme")
    db.add(c)
    await db.flush()
    p = await make_person(db, "worker")
    db.add(PersonRole(person_id=p.id, role="client_viewer", client_id=c.id))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["workers"]["view"] is True      # from worker
    assert a.perms["clients"]["view"] is True      # from client_viewer
    assert a.anchors == {"self", "client"}
    assert a.max_rank == 10


async def test_revoked_grants_ignored(db):
    from datetime import UTC, datetime
    p = await make_person(db, "admin")
    await db.execute(text(
        "UPDATE person_roles SET revoked_at = :now WHERE person_id = :pid"),
        {"now": datetime.now(UTC), "pid": p.id})
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.max_rank == 0
    assert a.perms["users"]["view"] is False


def test_can_touch_rank():
    assert can_touch_rank(100, 100) is True    # top rank manages peers
    assert can_touch_rank(100, 60) is True
    assert can_touch_rank(80, 60) is True
    assert can_touch_rank(60, 60) is False     # strictly below only
    assert can_touch_rank(40, 60) is False
    assert can_touch_rank(60, 100) is False
