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


async def test_role_grants_override_replaces_one_role(db):
    p = await make_person(db, "staff")
    a = await resolve_access(db, p.id, role_grants_override={
        "staff": {("workers", "view"), ("access", "view")}})
    assert a.perms["workers"] == {"view": True, "add": False,
                                  "change": False, "delete": False}
    # a role the person does not hold is ignored
    b = await resolve_access(db, p.id, role_grants_override={
        "admin": {("settings", "change")}})
    assert b.perms["settings"]["change"] is False
    # no override -> unchanged behavior
    c = await resolve_access(db, p.id)
    assert c.perms["workers"]["delete"] is True


async def test_effective_cells_override_keeps_sourcing(db):
    from serversherpa.access.effective import effective_cells
    p = await make_person(db, "staff")
    db.add(PermissionOverride(person_id=p.id, resource="workers",
                              action="view", allow=True))
    await db.commit()
    eff = await effective_cells(db, p.id, role_grants_override={
        "staff": {("access", "view")}})
    assert eff.cells["workers"]["view"] == {"value": True, "source": "override"}
    assert eff.cells["workers"]["add"] == {"value": False, "source": "role"}


async def test_resolve_access_many_matches_resolve_access_per_person(db):
    """The batch resolver (notification fan-out, the @mention picker) must
    agree with `resolve_access` exactly: roles, anchors, scope sets,
    overrides, group gates and the rank-60 gate bypass."""
    from serversherpa.access.resolver import resolve_access_many

    acme = Client(name="Batch Acme")
    vendor = Partner(name="Batch Vendor")
    db.add_all([acme, vendor])
    await db.flush()
    staff = await make_person(db, "staff")
    admin = await make_person(db, "admin")
    client_user = await make_person(db, "client_viewer", client_id=acme.id)
    vendor_user = await make_person(db, "vendor_viewer", partner_id=vendor.id)
    two_roles = await make_person(db, "staff")
    db.add(PersonRole(person_id=two_roles.id, role="client_admin", client_id=acme.id))
    gated_member = await make_person(db, "staff")
    no_roles = Person(first_name="T", last_name="none")
    db.add(no_roles)
    group = AccessGroup(name="Batch gate")
    db.add(group)
    await db.flush()
    db.add(ResourceGroupGate(resource="clients", group_id=group.id))
    db.add(AccessGroupMember(group_id=group.id, person_id=gated_member.id))
    db.add(PermissionOverride(person_id=staff.id, resource="wiki", action="delete",
                              allow=True))
    db.add(PermissionOverride(person_id=client_user.id, resource="wiki", action="view",
                              allow=False))
    await db.commit()

    people = [staff, admin, client_user, vendor_user, two_roles, gated_member, no_roles]
    batch = await resolve_access_many(db, [p.id for p in people] + [staff.id])
    assert set(batch) == {p.id for p in people}
    for p in people:
        assert batch[p.id] == await resolve_access(db, p.id), p.last_name
    assert await resolve_access_many(db, []) == {}
