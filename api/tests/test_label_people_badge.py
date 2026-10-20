"""Whose badge, whose logo (labels/people_badge.py, spec
2026-10-20-badge-templates §4.2, §4.4, §4.11): the person payload that
fields.person_values prints, the staff/worker rule (a global-anchored role
wins over the worker role), the photo, and the logo walk up a worker's
partner chain."""

import uuid
from datetime import UTC, datetime

from serversherpa.db.models import (
    Client,
    Partner,
    Person,
    PersonRole,
    Role,
    SystemConfig,
    WorkerProfile,
)
from serversherpa.labels import people_badge
from serversherpa.labels.fields import PERSON_KEYS, person_values
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE

NOW = datetime.now(UTC)


async def _person(db, *, roles=(), revoked=(), profile=None, **over) -> Person:
    fields = {"first_name": "Jordan", "last_name": "Rivera"}
    fields.update(over)
    p = Person(**fields)
    db.add(p)
    await db.flush()
    for role in roles:
        db.add(PersonRole(person_id=p.id, role=role))
    for role in revoked:
        db.add(PersonRole(person_id=p.id, role=role, revoked_at=NOW))
    if profile is not None:
        db.add(WorkerProfile(person_id=p.id, **profile))
    await db.commit()
    return p


async def _partner(db, name, *, parent=None, logo=None, archived=False) -> Partner:
    row = Partner(name=f"{name} {uuid.uuid4().hex[:4]}", logo_key=logo,
                  parent_id=parent.id if parent else None,
                  archived_at=NOW if archived else None)
    db.add(row)
    await db.commit()
    return row


async def _branding(db, **data):
    db.add(SystemConfig(section="branding", data=data))
    await db.commit()


async def _worker(db, partner, **profile):
    return await _person(db, roles=("worker",),
                         profile={"partner_id": partner.id if partner else None, **profile})


# ── staff or worker ──────────────────────────────────────────────────

async def test_staff_by_a_global_role_even_with_the_worker_role(db, seeded_user):
    await _branding(db, company_logo_key="branding/cumulus.png")
    acme = await _partner(db, "Acme", logo="partners/acme.png")
    p = await _person(db, roles=("staff", "worker", "admin"), revoked=("super_admin",),
                      profile={"partner_id": acme.id, "trade": "Electrician"})
    payload = await people_badge.person_payload(db, p.id)
    assert payload["person_type"] == "Staff"
    assert payload["company"] == "Cumulus Solutions Group"     # the branding default
    assert payload["parent_company"] is None
    # active global roles only, as their labels: never worker, never a revoked one
    assert sorted(payload["roles"]) == ["Administrator", "Staff"]
    assert await people_badge.logo_key(db, p) == "branding/cumulus.png"


async def test_the_staff_rule_reads_the_role_anchor(db, seeded_user):
    """Not a hard-coded role list: a custom global role makes staff, a
    client or vendor role doesn't."""
    db.add(Role(name="dispatcher", description="Dispatch desk", rank=30,
                scope_anchor="global", label="Dispatcher"))
    await db.commit()
    p = await _person(db, roles=("dispatcher",))
    payload = await people_badge.person_payload(db, p.id)
    assert (payload["person_type"], payload["roles"]) == ("Staff", ["Dispatcher"])
    client_org = Client(name=f"Client {uuid.uuid4().hex[:4]}")
    vendor = await _partner(db, "Vendor", logo="partners/vendor.png")
    db.add(client_org)
    await db.flush()
    contact = await _person(db)
    db.add_all([PersonRole(person_id=contact.id, role="client_viewer", client_id=client_org.id),
                PersonRole(person_id=contact.id, role="vendor_admin", partner_id=vendor.id)])
    await db.commit()
    payload = await people_badge.person_payload(db, contact.id)
    assert (payload["person_type"], payload["roles"], payload["company"]) == ("", [], None)
    assert await people_badge.logo_key(db, contact) is None
    # a revoked global role makes no one staff
    gone = await _person(db, revoked=("staff",))
    assert (await people_badge.person_payload(db, gone.id))["person_type"] == ""


async def test_staff_company_and_logo_come_from_branding(db, seeded_user):
    p = await _person(db, roles=("staff",))
    assert await people_badge.logo_key(db, p) is None      # no company logo yet
    await _branding(db, company_name="Cumulus East", company_logo_key="branding/east.png")
    payload = await people_badge.person_payload(db, p.id)
    assert payload["company"] == "Cumulus East"
    assert await people_badge.logo_key(db, p) == "branding/east.png"


async def test_a_worker_by_role_or_by_profile(db, seeded_user):
    by_role = await _person(db, roles=("worker",))
    payload = await people_badge.person_payload(db, by_role.id)
    assert payload["person_type"] == "Worker"
    assert (payload["company"], payload["parent_company"], payload["trade"],
            payload["level"]) == (None, None, None, None)
    assert await people_badge.logo_key(db, by_role) is None
    by_profile = await _person(db, profile={"trade": "Rigger", "level": "L3",
                                            "status": "standby"})
    payload = await people_badge.person_payload(db, by_profile.id)
    assert payload["person_type"] == "Worker"
    assert payload["trade"] == "Rigger"
    assert payload["level"] == {"key": "L3", "title": "Technician"}
    assert (payload["worker_status"], payload["worker_status_label"]) == ("standby", "Standby")


async def test_worker_values_end_to_end(db, seeded_user):
    """The payload is exactly what fields.person_values prints from."""
    top = await _partner(db, "Rivera Holdings")
    crew = await _partner(db, "Rivera Electric", parent=top)
    p = await _person(db, roles=("worker",), preferred_name="Jo", job_title="Lead",
                      external_id="E-17", email="jo@example.com", phone="555-0100",
                      rfid_tag="000000000000000000ABC123",
                      profile={"partner_id": crew.id, "trade": "Electrician", "level": "L3"})
    values = person_values(await people_badge.person_payload(db, p.id))
    assert set(values) == set(PERSON_KEYS)
    assert values == {
        "person_name": "Jo Rivera", "first_name": "Jordan", "last_name": "Rivera",
        "preferred_name": "Jo", "person_type": "Worker", "company": crew.name,
        "parent_company": top.name, "job_title": "Lead", "roles": "",
        "trade": "Electrician", "level": "L3 Technician", "worker_status": "Active",
        "employee_id": "E-17", "email": "jo@example.com", "phone": "555-0100",
        "person_rfid_tag": "ABC123", "badge_id": str(p.id), "badge_short": str(p.id)[:8],
    }


# ── the logo walk ────────────────────────────────────────────────────

async def test_the_logo_is_the_top_most_ancestor_with_one(db, seeded_user):
    grand = await _partner(db, "Grand", logo="partners/grand.png")
    mid = await _partner(db, "Mid", parent=grand)
    own = await _partner(db, "Own", parent=mid, logo="partners/own.png")
    w = await _worker(db, own)
    assert await people_badge.logo_key(db, w) == "partners/grand.png"
    payload = await people_badge.person_payload(db, w.id)
    assert (payload["company"], payload["parent_company"]) == (own.name, grand.name)


async def test_an_archived_ancestor_is_skipped(db, seeded_user):
    # the archived top's logo is never used; the top non-archived one names the parent
    gone = await _partner(db, "Gone", logo="partners/gone.png", archived=True)
    mid = await _partner(db, "Mid", parent=gone, logo="partners/mid.png")
    own = await _partner(db, "Own", parent=mid)
    w = await _worker(db, own)
    assert await people_badge.logo_key(db, w) == "partners/mid.png"
    assert (await people_badge.person_payload(db, w.id))["parent_company"] == mid.name
    # an archived partner in the middle is skipped, and the walk goes on above it
    top = await _partner(db, "Top")
    hidden = await _partner(db, "Hidden", parent=top, logo="partners/hidden.png",
                            archived=True)
    own2 = await _partner(db, "Own2", parent=hidden, logo="partners/own2.png")
    w2 = await _worker(db, own2)
    assert await people_badge.logo_key(db, w2) == "partners/own2.png"
    assert (await people_badge.person_payload(db, w2.id))["parent_company"] == top.name


async def test_no_logo_in_the_chain_falls_back_to_the_own_partner(db, seeded_user):
    """The worker's own partner (archived itself, so not in the chain) still
    lends its logo when nothing above has one."""
    parent = await _partner(db, "Parent")
    own = await _partner(db, "Own", parent=parent, logo="partners/own.png", archived=True)
    w = await _worker(db, own)
    assert await people_badge.logo_key(db, w) == "partners/own.png"
    payload = await people_badge.person_payload(db, w.id)
    assert (payload["company"], payload["parent_company"]) == (own.name, parent.name)


async def test_no_logo_anywhere_is_none(db, seeded_user):
    parent = await _partner(db, "Parent")
    own = await _partner(db, "Own", parent=parent)
    assert await people_badge.logo_key(db, await _worker(db, own)) is None
    # no parent: the partner is its own top
    solo = await _partner(db, "Solo")
    w = await _worker(db, solo)
    assert await people_badge.logo_key(db, w) is None
    assert (await people_badge.person_payload(db, w.id))["parent_company"] == solo.name
    # no partner at all
    assert await people_badge.logo_key(db, await _worker(db, None)) is None


async def test_a_parent_loop_ends(db, seeded_user):
    """The API refuses loops, but a walk never trusts that."""
    a = await _partner(db, "A")
    b = await _partner(db, "B", parent=a, logo="partners/b.png")
    a.parent_id = b.id
    await db.commit()
    w = await _worker(db, a)
    assert await people_badge.logo_key(db, w) == "partners/b.png"
    assert (await people_badge.person_payload(db, w.id))["parent_company"] in (a.name, b.name)


# ── who can be looked up ─────────────────────────────────────────────

async def test_find_person_refuses_unknown_and_hidden_people(db, seeded_user):
    hidden = await _person(db, source=KIOSK_MOVE_SOURCE)
    archived = await _person(db, archived_at=NOW, avatar_key="people/a.jpg")
    for bad in ("nope", "", None, str(uuid.uuid4()), hidden.id, str(hidden.id)):
        assert await people_badge.find_person(db, bad) is None, bad
        assert await people_badge.person_payload(db, bad) is None, bad
    # an archived person still has a badge (a template's sample may name one)
    assert (await people_badge.find_person(db, str(archived.id))).id == archived.id
    assert (await people_badge.person_payload(db, archived.id))["person"]["id"] == archived.id


def test_photo_key_is_the_avatar():
    assert people_badge.photo_key(Person(first_name="A", last_name="B",
                                         avatar_key="people/a.jpg")) == "people/a.jpg"
    assert people_badge.photo_key(Person(first_name="A", last_name="B")) is None
    assert people_badge.photo_key(Person(first_name="A", last_name="B", avatar_key="")) is None
