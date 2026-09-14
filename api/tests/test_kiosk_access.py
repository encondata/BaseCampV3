"""Kiosk: the `kiosk` permission resource (view only) and the
kiosk_pair_requests model round-trip (migration 0061)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.access.defaults import _ALL, DEFAULT_GRANTS
from serversherpa.access.resources import REGISTRY
from serversherpa.db.models import Client, KioskPairRequest, Person, PersonRole
from tests.test_sites_api import make_login
from tests.test_status_values_write import _make

KIOSK_ROLES = ("developer", "founder", "super_admin", "admin", "staff", "worker")
NO_KIOSK_ROLES = ("client_owner", "client_admin", "client_viewer", "vendor_owner",
                  "vendor_admin", "vendor_viewer", "external")


def test_kiosk_resource_registered():
    assert "kiosk" in REGISTRY
    assert REGISTRY["kiosk"].label == "Kiosk"
    assert REGISTRY["kiosk"].visible_to == frozenset({"global", "self"})
    assert REGISTRY["kiosk"].routes == ()


def test_kiosk_default_grants_are_view_only():
    assert "kiosk" in _ALL
    for role in KIOSK_ROLES:
        assert DEFAULT_GRANTS[role]["kiosk"] == ("view",), role
    for role in NO_KIOSK_ROLES:
        assert "kiosk" not in DEFAULT_GRANTS[role], role
    # worker gains exactly one thing
    assert DEFAULT_GRANTS["worker"] == {
        "dashboard": ("view",), "workers": ("view",), "kiosk": ("view",)}


async def test_session_payload_carries_kiosk_perm(client, db, seeded_user):
    worker = await _make(db, client, "worker", "w@test.example.com")
    me = await client.get("/auth/me", headers=worker)
    assert me.status_code == 200
    assert me.json()["perms"]["kiosk"]["view"] is True

    # client_viewer is client-scoped (person_roles_client_scope_check
    # requires a client_id), unlike the roles _make() covers, so build it
    # by hand: an org, a contact anchored to it, then a login.
    org = Client(name="Acme Co")
    db.add(org)
    await db.flush()
    contact = Person(first_name="C", last_name="Viewer", email="cv@test.example.com")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=org.id))
    await db.commit()
    viewer = await make_login(db, client, contact, "cv@test.example.com")
    me = await client.get("/auth/me", headers=viewer)
    assert me.json()["perms"].get("kiosk", {}).get("view", False) is False


async def test_pair_request_round_trip(db):
    row = KioskPairRequest(
        code="ABCD2345", poll_token_hash="x" * 64, serial="kiosk-web-1",
        kiosk_name="Dock 3", expires_at=datetime.now(UTC) + timedelta(minutes=5))
    db.add(row)
    await db.commit()
    got = await db.scalar(select(KioskPairRequest).where(KioskPairRequest.code == "ABCD2345"))
    assert got.status == "pending"
    assert got.approved_by is None
    assert got.created_at is not None and got.updated_at is not None
    # serial is citext: a differently-cased lookup finds the same row
    same = await db.scalar(select(KioskPairRequest).where(
        KioskPairRequest.serial == "KIOSK-WEB-1"))
    assert same is not None and same.id == got.id
