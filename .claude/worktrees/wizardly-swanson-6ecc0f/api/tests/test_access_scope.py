import pytest

from serversherpa.access.resolver import resolve_access
from serversherpa.access.scope import scope_conditions
from serversherpa.db.models import Client, Partner, Person, PersonRole, WorkerProfile
from sqlalchemy import select


async def test_global_actor_unrestricted(db):
    p = Person(first_name="A", last_name="Admin")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="admin"))
    await db.commit()
    access = await resolve_access(db, p.id)
    assert scope_conditions("workers", access, p.id) is None


async def test_partner_actor_sees_only_their_workers(db):
    pa, pb = Partner(name="VendA"), Partner(name="VendB")
    db.add_all([pa, pb])
    await db.flush()
    contact = Person(first_name="V", last_name="Contact")
    w1 = Person(first_name="W", last_name="One")
    w2 = Person(first_name="W", last_name="Two")
    db.add_all([contact, w1, w2])
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="vendor_admin", partner_id=pa.id))
    db.add(WorkerProfile(person_id=w1.id, partner_id=pa.id))
    db.add(WorkerProfile(person_id=w2.id, partner_id=pb.id))
    await db.commit()
    access = await resolve_access(db, contact.id)
    cond = scope_conditions("workers", access, contact.id)
    assert cond is not None
    rows = list(await db.scalars(select(WorkerProfile.person_id).where(cond)))
    assert rows == [w1.id]


async def test_self_actor_sees_own_worker_row(db):
    w1 = Person(first_name="W", last_name="One")
    w2 = Person(first_name="W", last_name="Two")
    db.add_all([w1, w2])
    await db.flush()
    db.add(PersonRole(person_id=w1.id, role="worker"))
    db.add(WorkerProfile(person_id=w1.id))
    db.add(WorkerProfile(person_id=w2.id))
    await db.commit()
    access = await resolve_access(db, w1.id)
    cond = scope_conditions("workers", access, w1.id)
    rows = list(await db.scalars(select(WorkerProfile.person_id).where(cond)))
    assert rows == [w1.id]


async def test_client_actor_scope_on_clients(db):
    ca, cb = Client(name="Acme"), Client(name="Bcme")
    db.add_all([ca, cb])
    await db.flush()
    contact = Person(first_name="C", last_name="Contact")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=ca.id))
    await db.commit()
    access = await resolve_access(db, contact.id)
    cond = scope_conditions("clients", access, contact.id)
    rows = list(await db.scalars(select(Client.id).where(cond)))
    assert rows == [ca.id]


async def test_client_anchored_actor_has_no_self_anchor_on_users(db):
    """SCOPE_COLUMNS["users"] only ever carries a `self` key. A person whose
    only grant is client-anchored (no `self` anchor) must get sa.false() —
    an empty directory, never the whole one — even if `users:view` were
    ever true for them (e.g. via a per-person override)."""
    c = Client(name="Acme")
    db.add(c)
    await db.flush()
    contact = Person(first_name="C", last_name="Contact")
    other = Person(first_name="O", last_name="Other")
    db.add_all([contact, other])
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=c.id))
    await db.commit()
    access = await resolve_access(db, contact.id)
    assert "self" not in access.anchors
    cond = scope_conditions("users", access, contact.id)
    assert cond is not None  # not unrestricted
    rows = list(await db.scalars(select(Person.id).where(cond)))
    assert rows == []  # sa.false() -> empty, not the whole directory


async def test_self_anchored_actor_sees_only_own_person_row_on_users(db):
    """A worker (self-anchored) with `users:view` (e.g. via override) sees
    only their own row via the `self` scope key — never the full directory."""
    w1 = Person(first_name="W", last_name="One")
    w2 = Person(first_name="W", last_name="Two")
    db.add_all([w1, w2])
    await db.flush()
    db.add(PersonRole(person_id=w1.id, role="worker"))
    await db.commit()
    access = await resolve_access(db, w1.id)
    assert "self" in access.anchors and not access.is_global
    cond = scope_conditions("users", access, w1.id)
    assert cond is not None
    rows = list(await db.scalars(select(Person.id).where(cond)))
    assert rows == [w1.id]
