"""Vocabulary editing is developer-only across all three tabs; reading stays
on the owning entity's view permission."""

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Client, Partner, PermissionOverride, Person, PersonRole, UserAccount,
)
from serversherpa.security.passwords import hash_password
from tests.test_sites_api import login, make_login

PW = "CorrectHorse9!"


async def _make(db, client, role, email):
    p = Person(first_name="R", last_name="X", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    return await login(client, email=email)


async def test_admin_cannot_edit_site_types(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "ada@test.example.com")
    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"label": "Nope"})
    assert resp.status_code == 403


async def test_developer_can_edit_site_types(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"label": "Data Center v2"})
    assert resp.status_code == 200
    assert resp.json()["label"] == "Data Center v2"


async def test_admin_cannot_edit_worker_levels(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "ada2@test.example.com")
    resp = await client.patch("/worker-levels/L3", headers=hdrs,
                              json={"title": "Nope"})
    assert resp.status_code == 403


async def test_developer_can_edit_worker_levels(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev2@test.example.com")
    resp = await client.patch("/worker-levels/L3", headers=hdrs,
                              json={"title": "Tech II"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "Tech II"


async def test_developer_can_read_worker_levels(client, db, seeded_user):
    """The old require_roles('admin','staff','worker') excluded developer by
    name — the Worker levels tab would 403 on its own list."""
    hdrs = await _make(db, client, "developer", "dev3@test.example.com")
    resp = await client.get("/worker-levels", headers=hdrs)
    assert resp.status_code == 200
    assert [r["level"] for r in resp.json()] == [
        "L1", "L2", "L3", "L4", "L5", "L6"]


async def test_staff_still_reads_worker_levels(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/worker-levels", headers=hdrs)
    assert resp.status_code == 200


async def _make_vendor(db, client, email="vend@partner.example.com"):
    """A partner-anchored vendor_owner: workers is visible_to={'global',
    'partner','self'} and vendor_owner holds workers:view by default."""
    partner = Partner(name="Vendor Levels Co")
    db.add(partner)
    await db.flush()
    contact = Person(first_name="V", last_name="Owner")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="vendor_owner",
                      partner_id=partner.id))
    await db.commit()
    return await make_login(db, client, contact, email)


async def test_vendor_owner_can_read_worker_levels(client, db, seeded_user):
    """Intended, not collateral: partners SUPPLY the workers carrying these
    levels (worker_profiles.partner_id), so a vendor staffing an L3 tech needs
    the L3 scale to mean something — reading the level vocabulary is exactly
    what workers:view + visible_to={'global','partner','self'} already grants.
    The old literal require_roles list was the anomaly (it excluded developer
    for the same bad reason)."""
    hdrs = await _make_vendor(db, client)
    resp = await client.get("/worker-levels", headers=hdrs)
    assert resp.status_code == 200
    assert [r["level"] for r in resp.json()] == [
        "L1", "L2", "L3", "L4", "L5", "L6"]


async def test_vendor_owner_cannot_edit_worker_levels(client, db, seeded_user):
    """The load-bearing half of the read widening: reading the scale is fine
    only because writing it stays developer-only. devtools is
    developer_only + visible_to={'global'}, so the resolver hard gate blocks a
    partner-anchored actor before any override is read."""
    hdrs = await _make_vendor(db, client, "vend2@partner.example.com")
    resp = await client.patch("/worker-levels/L3", headers=hdrs,
                              json={"title": "Nope"})
    assert resp.status_code == 403


async def test_non_global_actor_with_devtools_override_is_hard_gated(
        client, db, seeded_user):
    """update_site_type gave up its explicit _require_global(actor) guard in
    this task, so the resolver's hard gate is now the ONLY thing standing on
    that handler — and nothing pinned that shape on THIS router
    (test_status_values_write.py pins it, but against /status-values, a
    different module). An explicit devtools:change override is inert here
    because hard_blocked is evaluated BEFORE overrides are read
    (access/resolver.py:88-93).

    Note this actor is client-anchored, so BOTH halves of that OR block it
    independently — `not (visible_to & anchors)` is True on its own, since
    devtools defaults to visible_to={'global'}. So this test survives either
    single relaxation and only fails if both are undone; it pins the
    conjunction. The single-clause discriminator for developer_only is
    test_global_non_developer_with_devtools_override_is_hard_gated below."""
    acme = Client(name="Acme Devtools")
    db.add(acme)
    await db.flush()
    contact = Person(first_name="C", last_name="Devtools")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_admin", client_id=acme.id))
    db.add(PermissionOverride(person_id=contact.id, resource="devtools",
                              action="change", allow=True))
    await db.commit()
    hdrs = await make_login(db, client, contact, "dt@acme.example.com")

    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"label": "Sneaky"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"

    # free coverage — this handler never had _require_global, but the same
    # override must be just as inert against the worker-levels vocabulary
    resp = await client.patch("/worker-levels/L3", headers=hdrs,
                              json={"title": "Sneaky"})
    assert resp.status_code == 403


async def test_global_non_developer_with_devtools_override_is_hard_gated(
        client, db, seeded_user):
    """The developer_only discriminator. The test above uses a client-anchored
    actor, so BOTH halves of the hard gate's OR block it independently
    (visible_to={'global'} excludes a client anchor on its own) — it therefore
    survives either single relaxation and only fails if both are undone. This
    actor is GLOBAL, which satisfies visible_to, leaving `developer_only` as
    the only thing standing between an explicit devtools:change override and
    the vocabulary. Flip devtools.developer_only to False and this test — and
    only this one — fails."""
    hdrs = await _make(db, client, "admin", "ada3@test.example.com")
    person_id = await db.scalar(
        select(Person.id).where(Person.email == "ada3@test.example.com"))
    db.add(PermissionOverride(person_id=person_id, resource="devtools",
                              action="change", allow=True))
    await db.commit()

    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"label": "Sneaky"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"

    resp = await client.patch("/worker-levels/L3", headers=hdrs,
                              json={"title": "Sneaky"})
    assert resp.status_code == 403
