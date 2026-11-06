"""Assign workers from a template (no HTTP): parsing, reference data, matching."""
import pytest
from sqlalchemy import func

from serversherpa.db.models import (
    Client,
    ContactProfile,
    Initiative,
    InitiativePerson,
    Partner,
    Person,
    PersonRole,
    Site,
    WorkerProfile,
)
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people import assign_bulk as ab


async def mk_job(db, name="Move A", archived=False):
    job = Initiative(name=name, initiative_type="move",
                     archived_at=func.now() if archived else None)
    db.add(job)
    await db.commit()
    return job


async def mk_worker(db, first, last, preferred=None, email=None, phone=None, role="worker",
                    archived=False, revoked=False):
    p = Person(first_name=first, last_name=last, preferred_name=preferred, email=email,
               phone=phone, archived_at=func.now() if archived else None)
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role=role,
                      revoked_at=func.now() if revoked else None))
    await db.commit()
    return p


async def mk_site(db, name, archived=False):
    s = Site(name=name, archived_at=func.now() if archived else None)
    db.add(s)
    await db.commit()
    return s


async def assign(db, job, person, site=None, role=None):
    db.add(InitiativePerson(initiative_id=job.id, person_id=person.id,
                            site_worked_id=site.id if site else None, work_type=role))
    await db.commit()


async def mk_partner(db, name, parent=None):
    p = Partner(name=name, parent_id=parent.id if parent else None)
    db.add(p)
    await db.commit()
    return p


async def mk_profile(db, person, partner=None, status="active"):
    db.add(WorkerProfile(person_id=person.id, partner_id=partner.id if partner else None,
                         status=status))
    await db.commit()


async def mk_partner_contact(db, first, last, partner, email=None):
    p = Person(first_name=first, last_name=last, email=email)
    db.add(p)
    await db.flush()
    db.add(ContactProfile(person_id=p.id, partner_id=partner.id))
    await db.commit()
    return p


def cells(first="", last="", preferred="", phone="", email="", role=""):
    return {"first_name": first, "last_name": last, "preferred_name": preferred,
            "phone": phone, "email": email, "role": role}


async def ref_for(db):
    job = await mk_job(db)
    partner = await mk_partner(db, "Vend Picked")
    return await ab.load_reference(db, job.id, partner.id)


# ── shape / parsing ─────────────────────────────────────────────────

def test_columns_pinned():
    assert ab.COLUMNS == ["first_name", "last_name", "preferred_name", "phone", "email", "role"]
    assert ab.SHEET == "Workers"
    assert ab.DEFAULT_ROLE == "tech"


def test_parse_helpers_number_rows():
    csv = b"first_name,last_name,preferred_name,phone,email,role\nPat,Lee,,,,lead\n"
    assert ab.parse_upload("w.csv", csv) == [(2, cells("Pat", "Lee", role="lead"))]
    rows = [{"first_name": "A"}, {"first_name": "B"}]
    assert [n for n, _ in ab.number_json_rows(rows)] == [1, 2]
    assert [n for n, _ in ab.number_posted_rows(rows, [4, 7])] == [4, 7]


def test_parse_decisions_accepts_good_shape():
    assert ab.parse_decisions(None) == {}
    raw = {"2": {"person": "new", "role": "lead", "change": "update",
                 "acknowledged": ["status", "no_contact"]},
           "5": {"change": "ignore"}}
    assert ab.parse_decisions(raw) == {
        2: {"person": "new", "role": "lead", "change": "update",
            "acknowledged": ["status", "no_contact"]},
        5: {"change": "ignore"}}


@pytest.mark.parametrize("bad", [
    {"2": {"change": "maybe"}},
    {"2": {"acknowledged": ["bogus"]}},
    {"x": {}},
    [],
    {"2": []},
    {"2": {"person": ""}},
    {"2": {"role": 3}},
    {"2": {"acknowledged": "status"}},
    {"2": {"other": "x"}},
])
def test_parse_decisions_rejects_bad_shape(bad):
    with pytest.raises(BulkImportError) as exc:
        ab.parse_decisions(bad)
    assert exc.value.code == "invalid_decisions"


# ── reference data ──────────────────────────────────────────────────

async def test_load_reference_shape(db, seeded_user):
    job = await mk_job(db)
    picked = await mk_partner(db, "Vend Picked")
    site = await mk_site(db, "DC East")
    w = await mk_worker(db, "Ana", "Lopez", email="Ana@Example.com")
    await mk_profile(db, w, picked)
    archived = await mk_worker(db, "Old", "Gone", email="old@example.com", archived=True)
    await assign(db, job, w, site, "tech")
    ref = await ab.load_reference(db, job.id, picked.id)
    assert ref["partner"].id == picked.id
    cand = ref["people"][str(w.id)]
    assert cand.is_worker and cand.profile.partner_id == picked.id
    assert cand.partner_name == "Vend Picked"
    assert set(ref["team"]) == {w.id}
    assert ref["emails_all"]["ana@example.com"] == str(w.id)
    assert ref["emails_all"]["old@example.com"] == str(archived.id)
    assert str(archived.id) not in ref["people"]
    assert "tech" in ref["roles"]
    assert ref["role_index"]["tech"] == "tech"
    assert ref["site_names"][site.id] == "DC East"
    assert ref["partner_names"][picked.id] == "Vend Picked"
    missing = await ab.load_reference(db, job.id, job.id)
    assert missing["partner"] is None


# ── matching ────────────────────────────────────────────────────────

async def test_name_beats_email(db, seeded_user):
    a = await mk_worker(db, "Person", "A")
    await mk_worker(db, "Person", "B", email="x@example.com")
    ref = await ref_for(db)
    assert ab.match_row(ref, cells("Person", "A", email="x@example.com")) == (
        str(a.id), "name", "Person A")


async def test_preferred_name_matches(db, seeded_user):
    p = await mk_worker(db, "Patricia", "Stone", preferred="Pat")
    ref = await ref_for(db)
    assert ab.match_row(ref, cells("Pat", "Stone")) == (str(p.id), "name", "Pat Stone")
    assert ab.match_row(ref, cells("Someone", "Stone", preferred="pat"))[:2] == (
        str(p.id), "name")


async def test_email_match_ignores_case(db, seeded_user):
    p = await mk_worker(db, "Person", "B", email="x@example.com")
    ref = await ref_for(db)
    assert ab.match_row(ref, cells("Nobody", "Here", email="X@Example.com")) == (
        str(p.id), "email", "x@example.com")


async def test_phone_match_digits(db, seeded_user):
    p = await mk_worker(db, "Person", "C", phone="+1 512 555 1212")
    ref = await ref_for(db)
    pid, by, value = ab.match_row(ref, cells("Nobody", "Here", phone="(512) 555-1212"))
    assert (pid, by) == (str(p.id), "phone")
    assert value == "(512) 555-1212"


async def test_partner_contact_matches(db, seeded_user):
    vend = await mk_partner(db, "Vend C")
    c = await mk_partner_contact(db, "Casey", "Contact", vend, email="casey@example.com")
    ref = await ref_for(db)
    assert ab.match_row(ref, cells("Casey", "Contact")) == (str(c.id), "name", "Casey Contact")
    cand = ref["people"][str(c.id)]
    assert cand.is_worker is False and cand.profile is None
    assert cand.partner_contact_of == {vend.id}
    assert cand.partner_name == "Vend C"


async def test_excluded_people_never_match(db, seeded_user):
    await mk_worker(db, "Staff", "Only", email="staff@example.com", role="staff")
    await mk_worker(db, "Archived", "Worker", email="arch@example.com", archived=True)
    await mk_worker(db, "Revoked", "Worker", email="rev@example.com", revoked=True)
    client = Client(name="Client Co")
    db.add(client)
    await db.flush()
    cc = Person(first_name="Client", last_name="Contact", email="cc@example.com")
    db.add(cc)
    await db.flush()
    db.add(ContactProfile(person_id=cc.id, client_id=client.id))
    await db.commit()
    ref = await ref_for(db)
    for row in (cells("Staff", "Only"), cells(email="staff@example.com"),
                cells("Archived", "Worker"), cells(email="arch@example.com"),
                cells("Revoked", "Worker"), cells(email="rev@example.com"),
                cells("Client", "Contact"), cells(email="cc@example.com")):
        assert ab.match_row(ref, row) == (None, None, None), row


async def test_duplicate_name_falls_through_to_email(db, seeded_user):
    await mk_worker(db, "Person", "A", email="a1@example.com")
    b = await mk_worker(db, "Person", "A", email="b@example.com")
    ref = await ref_for(db)
    assert ab.match_row(ref, cells("Person", "A", email="b@example.com")) == (
        str(b.id), "email", "b@example.com")
    assert ab.match_row(ref, cells("Person", "A")) == (None, None, None)


async def test_shared_phone_never_matches(db, seeded_user):
    # CITEXT unique index keeps emails unique, so a shared phone is the only
    # duplicate contact key: two people on one phone means phone can't match.
    await mk_worker(db, "One", "Phone", phone="512-555-0000")
    await mk_worker(db, "Two", "Phone", phone="5125550000")
    ref = await ref_for(db)
    assert ab.match_row(ref, cells("No", "Body", phone="512 555 0000")) == (None, None, None)
