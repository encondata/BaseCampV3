"""Assign workers from a template (no HTTP): parsing, reference data, matching, preview."""
import uuid

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
    UserAccount,
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
                         status=status,
                         status_note="Test note" if status == "blacklist" else None))
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


async def test_archived_partner_contact_never_matches(db, seeded_user):
    vend = await mk_partner(db, "Vend Arch")
    c = await mk_partner_contact(db, "Gone", "Contact", vend, email="gone.c@example.com")
    c.archived_at = func.now()
    await db.commit()
    ref = await ref_for(db)
    assert str(c.id) not in ref["people"]
    assert ab.match_row(ref, cells("Gone", "Contact")) == (None, None, None)
    assert ab.match_row(ref, cells(email="gone.c@example.com")) == (None, None, None)


async def test_worker_without_profile_matches(db, seeded_user):
    w = await mk_worker(db, "No", "Profile")
    ref = await ref_for(db)
    assert ab.match_row(ref, cells("No", "Profile"))[:2] == (str(w.id), "name")
    cand = ref["people"][str(w.id)]
    assert cand.is_worker and cand.profile is None


async def test_revoked_worker_who_is_partner_contact_matches(db, seeded_user):
    vend = await mk_partner(db, "Vend R")
    w = await mk_worker(db, "Rev", "Contact", revoked=True)
    db.add(ContactProfile(person_id=w.id, partner_id=vend.id))
    await db.commit()
    ref = await ref_for(db)
    assert ab.match_row(ref, cells("Rev", "Contact"))[:2] == (str(w.id), "name")
    assert ref["people"][str(w.id)].is_worker is False


# ── preview ─────────────────────────────────────────────────────────

class Setup:
    """An initiative, the picked partner and the picked site."""
    def __init__(self, job, partner, site):
        self.job, self.partner, self.site = job, partner, site


@pytest.fixture
async def ctx(db, seeded_user):
    job = await mk_job(db)
    partner = await mk_partner(db, "Vend Picked")
    site = await mk_site(db, "DC East")
    return Setup(job, partner, site)


async def preview(db, ctx, *rows, decisions=None, actor=None, actor_rank=60):
    numbered = [(i + 2, r) for i, r in enumerate(rows)]
    return await ab.preview_rows(
        db, ctx.job.id, ctx.partner.id, ctx.site.id, numbered,
        actor_id=actor or uuid.uuid4(), actor_rank=actor_rank, decisions=decisions)


def flag(row, kind):
    found = [f for f in row["flags"] if f["kind"] == kind]
    assert len(found) == 1, (kind, row["flags"])
    return found[0]


def kinds(row):
    return sorted(f["kind"] for f in row["flags"])


async def good_worker(db, ctx, first="Ana", last="Lopez", email="ana@example.com",
                      phone="+1 512 555 0102", status="active"):
    w = await mk_worker(db, first, last, email=email, phone=phone)
    await mk_profile(db, w, ctx.partner, status=status)
    return w


async def test_blank_role_is_tech(db, ctx):
    w = await good_worker(db, ctx)
    out = await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com"))
    row = out["rows"][0]
    assert row["role_key"] == "tech" and row["role_label"] == "Tech"
    assert row["flags"] == [] and row["errors"] == []
    assert row["action"] == "assign"
    assert row["table"] == "matched" and row["matched_by"] == "name"
    assert row["person_id"] == str(w.id) and row["person_name"] == "Ana Lopez"
    assert row["create"] is False and row["becomes_worker"] is False
    assert out["counts"] == {"assign": 1, "create": 0, "already_assigned": 0,
                             "attention": 0, "error": 0}
    assert out["can_commit"] is True
    assert {"id": str(w.id), "label": "Ana Lopez", "detail": "Vend Picked"} in out["people"]
    assert [r["key"] for r in out["roles"]][:2] == ["lead", "tech"]
    assert {"key": "tech", "label": "Tech"} in out["roles"]


async def test_unknown_role_flags_until_picked(db, ctx):
    await good_worker(db, ctx)
    row = (await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com",
                                        role="Rigger")))["rows"][0]
    f = flag(row, "role_unknown")
    assert f["decided"] is False
    assert f["lines"] == [{"label": "Role in sheet", "value": "Rigger"}]
    assert row["role_key"] is None and row["action"] == "attention"
    named = (await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com",
                                          role="  LEAD ")))["rows"][0]
    assert named["role_key"] == "lead" and named["flags"] == []
    row = (await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com",
                                        role="Rigger"),
                         decisions={2: {"role": "cabling"}}))["rows"][0]
    assert flag(row, "role_unknown")["decided"] is True
    assert row["role_key"] == "cabling" and row["role_label"] == "Cabling"
    assert row["action"] == "assign"
    # the decision wins over a valid sheet role too
    row = (await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com", role="lead"),
                         decisions={2: {"role": "other"}}))["rows"][0]
    assert row["role_key"] == "other" and row["flags"] == []


async def test_needs_match_then_pick_existing(db, ctx):
    w = await good_worker(db, ctx)
    row = (await preview(db, ctx, cells("Zed", "Nobody", email="zed@example.com")))["rows"][0]
    assert row["table"] == "unmatched" and row["person_id"] is None
    assert row["matched_by"] is None and row["matched_value"] is None
    f = flag(row, "needs_match")
    assert f["decided"] is False and row["action"] == "attention"
    row = (await preview(db, ctx, cells("Zed", "Nobody", email="zed@example.com"),
                         decisions={2: {"person": str(w.id)}}))["rows"][0]
    assert row["table"] == "unmatched"
    assert row["matched_by"] == "pick" and row["person_id"] == str(w.id)
    assert "needs_match" not in kinds(row)
    stale = (await preview(db, ctx, cells("Zed", "Nobody", email="zed@example.com"),
                           decisions={2: {"person": str(uuid.uuid4())}}))["rows"][0]
    assert stale["errors"] == ["The chosen person no longer exists. Pick again."]
    assert stale["action"] == "error"


async def test_create_new(db, ctx):
    row = (await preview(db, ctx, cells("Zed", "Nobody", email="zed@example.com"),
                         decisions={2: {"person": "new"}}))
    assert row["can_commit"] is True
    row = row["rows"][0]
    assert row["create"] is True and row["person_id"] is None
    assert row["flags"] == [] and row["action"] == "create"
    assert row["becomes_worker"] is False


async def test_required_names(db, ctx):
    out = await preview(db, ctx, cells("", "", email="a@example.com"))
    assert out["rows"][0]["errors"][:2] == ["First name is required.", "Last name is required."]
    assert out["rows"][0]["action"] == "error" and out["can_commit"] is False


async def test_name_differs_until_acknowledged(db, ctx):
    w = await good_worker(db, ctx)
    row = (await preview(db, ctx, cells("Annie", "Lopes", email="ANA@example.com")))["rows"][0]
    assert row["matched_by"] == "email" and row["person_id"] == str(w.id)
    f = flag(row, "name_differs")
    assert f["decided"] is False
    assert f["lines"] == [{"label": "Name in sheet", "value": "Annie Lopes"},
                          {"label": "Name on file", "value": "Ana Lopez"}]
    assert row["action"] == "attention"
    row = (await preview(db, ctx, cells("Annie", "Lopes", email="ana@example.com"),
                         decisions={2: {"acknowledged": ["name_differs"]}}))["rows"][0]
    assert flag(row, "name_differs")["decided"] is True and row["action"] == "assign"


async def test_contact_discrepancy_lines_and_change(db, ctx):
    await good_worker(db, ctx, email="ana@example.com", phone="+1 512 555 0102")
    row = (await preview(db, ctx, cells("Ana", "Lopez", phone="512-555-0199",
                                        email="ana.new@example.com")))["rows"][0]
    f = flag(row, "contact")
    assert f["decided"] is False
    assert f["lines"] == [
        {"label": "Phone on file", "value": "+1 512 555 0102"},
        {"label": "Phone in sheet", "value": "+1 512 555 0199"},
        {"label": "Email on file", "value": "ana@example.com"},
        {"label": "Email in sheet", "value": "ana.new@example.com"}]
    assert row["action"] == "attention"
    for change in ("update", "ignore"):
        row = (await preview(db, ctx, cells("Ana", "Lopez", phone="512-555-0199",
                                            email="ana.new@example.com"),
                             decisions={2: {"change": change}}))["rows"][0]
        assert flag(row, "contact")["decided"] is True and row["action"] == "assign"
    # same phone written differently and same email in another case: no flag
    row = (await preview(db, ctx, cells("Ana", "Lopez", phone="(512) 555-0102",
                                        email="ANA@example.com")))["rows"][0]
    assert row["flags"] == []


async def test_contact_phone_on_file_blank_shows_dash(db, ctx):
    await good_worker(db, ctx, phone=None)
    row = (await preview(db, ctx, cells("Ana", "Lopez", phone="512-555-0199",
                                        email="ana@example.com")))["rows"][0]
    assert flag(row, "contact")["lines"] == [
        {"label": "Phone on file", "value": "—"},
        {"label": "Phone in sheet", "value": "+1 512 555 0199"}]


async def test_contact_email_held_by_other_note(db, ctx):
    await good_worker(db, ctx)
    gone = await mk_worker(db, "Old", "Owner", email="taken@example.com", archived=True)
    row = (await preview(db, ctx, cells("Ana", "Lopez", email="taken@example.com")))["rows"][0]
    assert flag(row, "contact")["lines"] == [
        {"label": "Email on file", "value": "ana@example.com"},
        {"label": "Email in sheet", "value": "taken@example.com"},
        {"label": "Email", "value": "Not updated: in use by Old Owner"}]
    # archived, so not matchable: no shared-contact flag
    assert "shared_contact" not in kinds(row)
    assert gone.id


async def test_partner_discrepancy_including_child_partner(db, ctx):
    other = await mk_partner(db, "Vend Other")
    child = await mk_partner(db, "Vend Child", parent=ctx.partner)
    a = await mk_worker(db, "Ana", "Lopez", email="ana@example.com")
    await mk_profile(db, a, other)
    b = await mk_worker(db, "Ben", "Kim", email="ben@example.com")
    await mk_profile(db, b, child)
    out = await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com"),
                        cells("Ben", "Kim", email="ben@example.com"))
    fa, fb = (flag(r, "partner") for r in out["rows"])
    assert fa["lines"] == [{"label": "Partner on file", "value": "Vend Other"},
                           {"label": "Partner picked", "value": "Vend Picked"}]
    assert fb["lines"] == [{"label": "Partner on file", "value": "Vend Child"},
                           {"label": "Partner picked", "value": "Vend Picked"}]
    assert not fa["decided"] and out["rows"][0]["action"] == "attention"
    out = await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com"),
                        decisions={2: {"change": "ignore"}})
    assert flag(out["rows"][0], "partner")["decided"] is True
    assert out["rows"][0]["action"] == "assign"


async def test_status_flag_until_acknowledged(db, ctx):
    await good_worker(db, ctx, status="blacklist")
    row = (await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com")))["rows"][0]
    f = flag(row, "status")
    assert f["decided"] is False
    assert f["lines"] == [{"label": "Status on file", "value": "Blacklist"}]
    assert row["action"] == "attention"
    row = (await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com"),
                         decisions={2: {"acknowledged": ["status"]}}))["rows"][0]
    assert flag(row, "status")["decided"] is True and row["action"] == "assign"


async def test_assignment_flag_update_or_ignore(db, ctx):
    w = await good_worker(db, ctx)
    west = await mk_site(db, "DC West")
    await assign(db, ctx.job, w, west, "lead")
    out = await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com"))
    row = out["rows"][0]
    f = flag(row, "assignment")
    assert f["decided"] is False
    assert f["lines"] == [{"label": "Site on file", "value": "DC West"},
                          {"label": "Site picked", "value": "DC East"},
                          {"label": "Role on file", "value": "Lead"},
                          {"label": "Role picked", "value": "Tech"}]
    assert row["action"] == "attention" and out["can_commit"] is False
    out = await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com"),
                        decisions={2: {"change": "update"}})
    assert out["rows"][0]["action"] == "assign" and out["can_commit"] is True
    out = await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com"),
                        decisions={2: {"change": "ignore"}})
    assert out["rows"][0]["action"] == "already_assigned"
    assert out["can_commit"] is False
    # only the role differs: only the role lines
    out = await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com", role="lead"))
    assert flag(out["rows"][0], "assignment")["lines"] == [
        {"label": "Site on file", "value": "DC West"},
        {"label": "Site picked", "value": "DC East"}]


async def test_already_assigned_same_site_and_role(db, ctx):
    w = await good_worker(db, ctx)
    await assign(db, ctx.job, w, ctx.site, "tech")
    out = await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com"))
    assert out["rows"][0]["action"] == "already_assigned"
    assert out["rows"][0]["flags"] == []
    assert out["counts"]["already_assigned"] == 1
    assert out["can_commit"] is False


async def test_shared_contact_ack(db, ctx):
    await good_worker(db, ctx)
    await good_worker(db, ctx, first="Ben", last="Kim", email="ben@example.com",
                      phone="+1 512 555 0177")
    row = (await preview(db, ctx, cells("Ana", "Lopez", phone="512 555 0177",
                                        email="ana@example.com")))["rows"][0]
    f = flag(row, "shared_contact")
    assert f["decided"] is False and f["other_person"] == "Ben Kim"
    assert row["action"] == "attention"
    row = (await preview(db, ctx, cells("Ana", "Lopez", phone="512 555 0177",
                                        email="ana@example.com"),
                         decisions={2: {"acknowledged": ["shared_contact"], "change": "ignore"}})
           )["rows"][0]
    assert flag(row, "shared_contact")["decided"] is True and row["action"] == "assign"


async def test_no_contact_ack(db, ctx):
    await good_worker(db, ctx)
    row = (await preview(db, ctx, cells("Ana", "Lopez")))["rows"][0]
    assert kinds(row) == ["no_contact"] and row["action"] == "attention"
    assert flag(row, "no_contact")["decided"] is False
    row = (await preview(db, ctx, cells("Ana", "Lopez"),
                         decisions={2: {"acknowledged": ["no_contact"]}}))["rows"][0]
    assert flag(row, "no_contact")["decided"] is True and row["action"] == "assign"


async def test_phone_invalid_ack(db, ctx):
    await good_worker(db, ctx)
    row = (await preview(db, ctx, cells("Ana", "Lopez", phone="12-34",
                                        email="ana@example.com")))["rows"][0]
    f = flag(row, "phone_invalid")
    assert f["lines"] == [{"label": "Phone in sheet", "value": "12-34"}]
    assert kinds(row) == ["phone_invalid"] and row["action"] == "attention"
    row = (await preview(db, ctx, cells("Ana", "Lopez", phone="12-34", email="ana@example.com"),
                         decisions={2: {"acknowledged": ["phone_invalid"]}}))["rows"][0]
    assert flag(row, "phone_invalid")["decided"] is True and row["action"] == "assign"


async def test_create_new_with_taken_email_flags_shared_contact(db, ctx):
    await mk_worker(db, "Old", "Owner", email="taken@example.com", archived=True)
    row = (await preview(db, ctx, cells("New", "Person", email="Taken@example.com"),
                         decisions={2: {"person": "new"}}))["rows"][0]
    f = flag(row, "shared_contact")
    assert f["lines"] == [{"label": "Email",
                           "value": "in use by Old Owner; created without it"}]
    assert f["other_person"] == "Old Owner"
    assert f["decided"] is False and row["action"] == "attention"
    row = (await preview(db, ctx, cells("New", "Person", email="taken@example.com"),
                         decisions={2: {"person": "new", "acknowledged": ["shared_contact"]}})
           )["rows"][0]
    assert row["action"] == "create"


async def test_same_person_two_rows_errors(db, ctx):
    await good_worker(db, ctx)
    out = await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com"),
                        cells("Someone", "Else", email="x@example.com"),
                        cells("Ana", "Lopez", email="ana@example.com"))
    msg = "Ana Lopez appears on more than one row (2, 4)."
    assert out["rows"][0]["errors"] == [msg] and out["rows"][2]["errors"] == [msg]
    assert out["rows"][0]["action"] == out["rows"][2]["action"] == "error"
    assert out["counts"]["error"] == 2


async def test_two_new_rows_same_email_error(db, ctx):
    out = await preview(db, ctx, cells("A", "One", email="dup@example.com"),
                        cells("B", "Two", email="DUP@example.com"),
                        cells("C", "Three"),
                        cells("D", "Four"),
                        decisions={n: {"person": "new", "acknowledged": ["no_contact"]}
                                   for n in (2, 3, 4, 5)})
    msg = "Email dup@example.com appears on more than one new worker (rows 2, 3)."
    assert out["rows"][0]["errors"] == [msg] and out["rows"][1]["errors"] == [msg]
    assert [r["action"] for r in out["rows"]] == ["error", "error", "create", "create"]


async def test_partner_contact_becomes_worker(db, ctx):
    c = await mk_partner_contact(db, "Casey", "Contact", ctx.partner,
                                 email="casey@example.com")
    out = await preview(db, ctx, cells("Casey", "Contact", email="casey@example.com"))
    row = out["rows"][0]
    assert row["person_id"] == str(c.id) and row["becomes_worker"] is True
    assert row["flags"] == [] and row["action"] == "assign"
    assert {"id": str(c.id), "label": "Casey Contact", "detail": "Vend Picked"} in out["people"]


async def test_update_blocked_for_higher_rank_account(db, ctx):
    boss = await good_worker(db, ctx, email="boss@example.com")
    db.add(PersonRole(person_id=boss.id, role="developer"))      # rank 100
    db.add(UserAccount(person_id=boss.id, email="boss@example.com", password_hash="x"))
    await db.commit()
    row_cells = cells("Ana", "Lopez", email="boss.new@example.com")
    blocked = (await preview(db, ctx, row_cells, decisions={2: {"change": "update"}}))["rows"][0]
    assert blocked["errors"] == ["Your rank is too low to update this person."]
    assert blocked["action"] == "error"
    ignored = (await preview(db, ctx, row_cells, decisions={2: {"change": "ignore"}}))["rows"][0]
    assert ignored["action"] == "assign"
    top = (await preview(db, ctx, row_cells, decisions={2: {"change": "update"}},
                         actor_rank=100))["rows"][0]
    assert top["action"] == "assign"
    myself = (await preview(db, ctx, row_cells, decisions={2: {"change": "update"}},
                            actor=boss.id))["rows"][0]
    assert myself["action"] == "assign"


async def test_can_commit_false_until_all_decided(db, ctx):
    await good_worker(db, ctx)
    rows = (cells("Ana", "Lopez", email="ana@example.com"), cells("Zed", "Nobody"))
    out = await preview(db, ctx, *rows)
    assert out["can_commit"] is False
    assert out["counts"]["attention"] == 1
    out = await preview(db, ctx, *rows, decisions={3: {"person": "new"}})
    assert out["can_commit"] is False          # still no contact info on row 3
    out = await preview(db, ctx, *rows,
                        decisions={3: {"person": "new", "acknowledged": ["no_contact"]}})
    assert out["can_commit"] is True
    assert out["counts"] == {"assign": 1, "create": 1, "already_assigned": 0,
                             "attention": 0, "error": 0}
    assert (await preview(db, ctx))["can_commit"] is False


async def test_rows_carry_only_wire_keys(db, ctx):
    await good_worker(db, ctx)
    out = await preview(db, ctx, cells("Ana", "Lopez", email="ana@example.com"),
                        cells("Zed", "Nobody"), cells("Yan", "Other"))
    wire = {"row", "cells", "name", "table", "matched_by", "matched_value", "person_id",
            "person_name", "create", "becomes_worker", "role_key", "role_label", "flags",
            "action", "errors"}
    assert all(set(r) == wire for r in out["rows"])
    assert all(set(f) == {"kind", "decided", "lines", "other_person"}
               for r in out["rows"] for f in r["flags"])


async def test_contact_update_only_row_is_committable(db, ctx):
    w = await good_worker(db, ctx)
    await assign(db, ctx.job, w, ctx.site, "tech")
    row_cells = cells("Ana", "Lopez", email="ana.new@example.com")
    out = await preview(db, ctx, row_cells)
    assert out["rows"][0]["action"] == "attention" and out["can_commit"] is False
    out = await preview(db, ctx, row_cells, decisions={2: {"change": "update"}})
    assert out["rows"][0]["action"] == "already_assigned"
    assert out["can_commit"] is True
    out = await preview(db, ctx, row_cells, decisions={2: {"change": "ignore"}})
    assert out["rows"][0]["action"] == "already_assigned"
    assert out["can_commit"] is False


async def boss_on_team(db, ctx):
    boss = await good_worker(db, ctx, email="boss@example.com")
    db.add(PersonRole(person_id=boss.id, role="developer"))      # rank 100
    db.add(UserAccount(person_id=boss.id, email="boss@example.com", password_hash="x"))
    await db.commit()
    west = await mk_site(db, "DC West")
    await assign(db, ctx.job, boss, west, "tech")
    return boss


async def test_rank_guard_skips_assignment_only_update(db, ctx):
    await boss_on_team(db, ctx)
    row = (await preview(db, ctx, cells("Ana", "Lopez", email="boss@example.com"),
                         decisions={2: {"change": "update"}}))["rows"][0]
    assert kinds(row) == ["assignment"]
    assert row["errors"] == [] and row["action"] == "assign"


async def test_rank_guard_blocks_person_field_update_with_assignment(db, ctx):
    await boss_on_team(db, ctx)
    row = (await preview(db, ctx, cells("Ana", "Lopez", email="boss.new@example.com"),
                         decisions={2: {"change": "update"}}))["rows"][0]
    assert kinds(row) == ["assignment", "contact"]
    assert row["errors"] == ["Your rank is too low to update this person."]
