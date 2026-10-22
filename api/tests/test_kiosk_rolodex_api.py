"""Kiosk Rolodex: the worker list, the worker page and the pickers' options
for admins on the native kiosk apps (GET /kiosk/rolodex/workers,
/workers/{person_id}, /options), plus the writes: the duplicate check
(POST /duplicates), New worker (POST /workers) and edits
(PATCH /workers/{person_id}).

Only a person session of rank 60+ with a global role gets in: staff,
workers, move-password sessions and station keys are refused. The list is
cached offline, so it never carries email or phone; the worker page does.
Spec: docs/superpowers/specs/2026-10-22-kiosk-rolodex-design.md (§3, §4.1).
"""

import hashlib
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select, update

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog,
    AuthSession,
    Initiative,
    Partner,
    PermissionOverride,
    Person,
    PersonRole,
    Role,
    StatusValue,
    UserAccount,
    WorkerProfile,
)
from serversherpa.security.passwords import hash_password
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from tests.test_kiosk_station_scans import _auth
from tests.test_kiosk_timeclock_station_key import _timeclock_station
from tests.test_move_password_lock import _move, _move_session
from tests.test_status_values_write import _make
from tests.test_system_admin_api import _admin

PW = "CorrectHorse9!"
BASE = "/kiosk/rolodex"

ROW_FIELDS = {
    "person_id", "first_name", "last_name", "preferred_name", "display_name",
    "job_title", "company", "trade", "level", "level_color", "status",
    "status_label", "status_color", "has_photo", "photo_url", "photo_version",
    "rfid_enrolled", "has_account",
}
DETAIL_FIELDS = ROW_FIELDS | {
    "email", "phone", "external_id", "status_note", "can_edit",
    "can_change_status", "edit_block_reason", "status_block_reason",
}


def _code(r):
    return r.json()["detail"]["code"]


def _version(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:16]


async def _add_account(db, person_id, email):
    db.add(UserAccount(
        person_id=person_id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))


async def _kiosk_user(db, client, email, *roles, first="Rhea", last="Admin"):
    """A person with a login and `roles`, signed in on a KIOSK session.
    -> (person_id, headers)"""
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.flush()
    pid = person.id
    await _add_account(db, pid, email)
    for role in roles:
        db.add(PersonRole(person_id=pid, role=role))
    await db.commit()
    r = await client.post("/auth/login", json={
        "email": email, "password": PW, "client": "kiosk"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok", r.text
    return pid, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _kiosk_admin(db, client, *, worker=False):
    roles = ("admin", "worker") if worker else ("admin",)
    return await _kiosk_user(db, client, "rhea@test.example.com", *roles)


async def _worker(db, first, last, *, preferred_name=None, email=None, phone=None,
                  job_title=None, external_id=None, avatar_key=None, rfid_tag=None,
                  account=False, roles=(), profile=True, partner_id=None, trade=None,
                  level=None, status="active", status_note=None, archived=False,
                  revoked=False, source="manual"):
    """A person holding the worker role (plus `roles`), with a worker
    profile unless `profile=False`. -> person_id"""
    now = datetime.now(UTC)
    person = Person(
        first_name=first, last_name=last, preferred_name=preferred_name,
        email=email, phone=phone, job_title=job_title, external_id=external_id,
        avatar_key=avatar_key, rfid_tag=rfid_tag, source=source,
        archived_at=now if archived else None)
    db.add(person)
    await db.flush()
    pid = person.id
    if account:
        await _add_account(db, pid, f"login-{pid.hex[:10]}@test.example.com")
    db.add(PersonRole(person_id=pid, role="worker", revoked_at=now if revoked else None))
    for role in roles:
        db.add(PersonRole(person_id=pid, role=role))
    if profile:
        db.add(WorkerProfile(person_id=pid, partner_id=partner_id, trade=trade,
                             level=level, status=status, status_note=status_note))
    await db.commit()
    return pid


def _paths(person_id):
    return (f"{BASE}/workers", f"{BASE}/workers/{person_id}", f"{BASE}/options")


# ── list ─────────────────────────────────────────────────────────────

async def test_admin_kiosk_session_lists_workers_by_last_name(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    for first, last in (("Zed", "Adams"), ("Amy", "Zane"), ("Bo", "Núñez")):
        await _worker(db, first, last)

    r = await client.get(f"{BASE}/workers", headers=hdrs)
    assert r.status_code == 200, r.text
    body = r.json()
    assert datetime.fromisoformat(body["generated_at"]).tzinfo is not None
    # the staff user and the admin hold no worker role, so they're not listed
    assert [w["last_name"] for w in body["workers"]] == ["Adams", "Núñez", "Zane"]
    assert [w["display_name"] for w in body["workers"]] == [
        "Zed Adams", "Bo Núñez", "Amy Zane"]


async def test_list_has_no_email_or_phone(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    partner = Partner(name="Summit Crew")
    db.add(partner)
    await db.flush()
    partner_id = partner.id
    await db.commit()
    key = "attachments/person/marcus/avatar/one.jpg"
    marcus = await _worker(
        db, "Marcus", "Reed", preferred_name="Marc", email="marcus.reed@example.com",
        phone="555-867-5309", job_title="Rigger", external_id="E-1", avatar_key=key,
        rfid_tag="E200-0001", account=True, partner_id=partner_id, trade="Rigging",
        level="L4", status="standby", status_note="Back Monday")
    bare = await _worker(db, "Nia", "Bare", profile=False)
    standby_color = await db.scalar(select(StatusValue.color).where(
        StatusValue.record_type == "worker", StatusValue.key == "standby"))
    active_color = await db.scalar(select(StatusValue.color).where(
        StatusValue.record_type == "worker", StatusValue.key == "active"))

    r = await client.get(f"{BASE}/workers", headers=hdrs)
    assert r.status_code == 200, r.text
    for private in ("marcus.reed@example.com", "555-867-5309", "Back Monday", "E-1"):
        assert private not in r.text
    rows = {w["person_id"]: w for w in r.json()["workers"]}
    assert set(rows) == {str(marcus), str(bare)}
    for row in rows.values():
        assert set(row) == ROW_FIELDS

    m = rows[str(marcus)]
    assert key in m.pop("photo_url")          # presigned, short-lived
    assert m == {
        "person_id": str(marcus), "first_name": "Marcus", "last_name": "Reed",
        "preferred_name": "Marc", "display_name": "Marc Reed", "job_title": "Rigger",
        "company": {"id": str(partner_id), "name": "Summit Crew"},
        "trade": "Rigging", "level": "L4", "level_color": "#3ddc84",
        "status": "standby", "status_label": "Standby", "status_color": standby_color,
        "has_photo": True, "photo_version": _version(key),
        "rfid_enrolled": True, "has_account": True,
    }
    # a worker with no profile row reads as Active, unleveled, no company
    assert rows[str(bare)] == {
        "person_id": str(bare), "first_name": "Nia", "last_name": "Bare",
        "preferred_name": None, "display_name": "Nia Bare", "job_title": None,
        "company": None, "trade": None, "level": None, "level_color": None,
        "status": "active", "status_label": "Active", "status_color": active_color,
        "has_photo": False, "photo_url": None, "photo_version": None,
        "rfid_enrolled": False, "has_account": False,
    }


async def test_archived_and_move_identity_are_hidden(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    kept = await _worker(db, "Kim", "Kept")
    archived = await _worker(db, "Ari", "Archived", archived=True)
    move_identity = await _worker(db, "Kiosk", "Dock Move", source=KIOSK_MOVE_SOURCE,
                                  account=True, profile=False)
    revoked = await _worker(db, "Rex", "Revoked", revoked=True)

    r = await client.get(f"{BASE}/workers", headers=hdrs)
    assert r.status_code == 200, r.text
    assert [w["person_id"] for w in r.json()["workers"]] == [str(kept)]

    assert (await client.get(f"{BASE}/workers/{kept}", headers=hdrs)).status_code == 200
    # archived, the hidden move identity, a revoked worker role, a person
    # who isn't a worker at all, and an id that doesn't exist all look alike
    for pid in (archived, move_identity, revoked, seeded_user.id, uuid.uuid4()):
        r = await client.get(f"{BASE}/workers/{pid}", headers=hdrs)
        assert r.status_code == 404, (pid, r.text)
        assert _code(r) == "person_not_found"


# ── gates ────────────────────────────────────────────────────────────

async def test_staff_and_worker_sessions_are_refused(client, db, seeded_user):
    target = await _worker(db, "Tia", "Target")
    r = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": PW, "client": "kiosk"})
    staff = {"Authorization": f"Bearer {r.json()['access_token']}"}
    _, worker = await _kiosk_user(db, client, "wes@test.example.com", "worker",
                                  first="Wes", last="Worker")

    for who, hdrs in (("staff", staff), ("worker", worker)):
        for path in _paths(target):
            r = await client.get(path, headers=hdrs)
            assert r.status_code == 403, (who, path, r.text)
            assert _code(r) == "forbidden", (who, path, r.text)


async def test_high_rank_without_a_global_role_is_refused(client, db, seeded_user):
    """A custom role cloned from a partner-anchored one can carry rank 60+;
    with the worker role for kiosk:view it would pass a rank check alone."""
    target = await _worker(db, "Tia", "Target")
    db.add(Role(name="crew_boss", description="Crew boss", rank=70, scope_anchor="partner"))
    await db.commit()
    _, hdrs = await _kiosk_user(db, client, "boss@test.example.com", "worker", "crew_boss")

    for path in _paths(target):
        r = await client.get(path, headers=hdrs)
        assert r.status_code == 403, (path, r.text)
        assert _code(r) == "forbidden", (path, r.text)


async def test_move_password_session_is_refused(client, db, seeded_user):
    target = await _worker(db, "Tia", "Target")
    admin = await _make(db, client, "admin", "move-admin@test.example.com")
    init = await _move(db, "Rolodex move")
    r = await client.patch(f"/initiatives/{init.id}", headers=admin,
                           json={"kiosk_password": "Crew-2026!"})
    assert r.status_code == 200, r.text
    hdrs = await _move_session(client)

    for path in _paths(target):
        r = await client.get(path, headers=hdrs)
        assert r.status_code == 403, (path, r.text)

    # even if the move's hidden identity somehow held an admin role, a
    # move-locked session stays out
    identity = await db.scalar(
        select(Initiative.kiosk_person_id).where(Initiative.id == init.id))
    db.add(PersonRole(person_id=identity, role="admin"))
    await db.commit()
    for path in _paths(target):
        r = await client.get(path, headers=hdrs)
        assert r.status_code == 403, (path, r.text)
        assert _code(r) == "move_locked", (path, r.text)


async def test_station_key_is_refused(client, db, seeded_user):
    _, _, key = await _timeclock_station(db)
    target = await _worker(db, "Tia", "Target")
    for path in _paths(target):
        r = await client.get(path, headers=_auth(key))
        assert r.status_code in (401, 403), (path, r.text)


async def test_list_works_in_read_only_mode(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    target = await _worker(db, "Tia", "Target")
    super_admin = await _admin(db, client)
    r = await client.put("/system/admin", headers=super_admin, json={"read_only": True})
    assert r.status_code == 200, r.text

    for path in _paths(target):
        r = await client.get(path, headers=hdrs)
        assert r.status_code == 200, (path, r.text)


# ── worker page ──────────────────────────────────────────────────────

async def test_detail_flags(client, db, seeded_user):
    me, hdrs = await _kiosk_admin(db, client, worker=True)
    plain = await _worker(
        db, "Paz", "Plain", email="paz@example.com", phone="555-0100",
        external_id="E-77", status="blacklist", status_note="No-show twice")
    lead = await _worker(db, "Lou", "Lead", account=True, roles=("staff",))
    boss = await _worker(db, "Sue", "Boss", account=True, roles=("super_admin",))
    peer = await _worker(db, "Pia", "Peer", account=True, roles=("admin",))

    r = await client.get(f"{BASE}/workers/{plain}", headers=hdrs)
    assert r.status_code == 200, r.text
    d = r.json()
    assert set(d) == DETAIL_FIELDS
    assert (d["email"], d["phone"], d["external_id"]) == (
        "paz@example.com", "555-0100", "E-77")
    assert (d["status"], d["status_label"], d["status_note"]) == (
        "blacklist", "Blacklist", "No-show twice")
    # no portal login
    assert d["has_account"] is False
    assert (d["can_edit"], d["edit_block_reason"]) == (True, None)
    assert (d["can_change_status"], d["status_block_reason"]) == (True, None)

    # a login ranked below yours
    d = (await client.get(f"{BASE}/workers/{lead}", headers=hdrs)).json()
    assert d["has_account"] is True
    assert (d["can_edit"], d["edit_block_reason"]) == (True, None)
    assert (d["can_change_status"], d["status_block_reason"]) == (True, None)

    # a login ranked above yours, or level with it
    for target in (boss, peer):
        d = (await client.get(f"{BASE}/workers/{target}", headers=hdrs)).json()
        assert (d["can_edit"], d["edit_block_reason"]) == (False, "rank_too_low")
        assert (d["can_change_status"], d["status_block_reason"]) == (False, "rank_too_low")

    # your own row: edit yes, status no
    d = (await client.get(f"{BASE}/workers/{me}", headers=hdrs)).json()
    assert d["has_account"] is True
    assert (d["can_edit"], d["edit_block_reason"]) == (True, None)
    assert (d["can_change_status"], d["status_block_reason"]) == (False, "self")


async def test_status_flag_follows_the_profile_guard_without_a_login(client, db, seeded_user):
    """The status guard ranks the target whether or not they can sign in,
    so an account-less person holding a high role reads as locked, the
    same answer the portal's profile route gives."""
    _, hdrs = await _kiosk_admin(db, client)
    ranked = await _worker(db, "Ray", "Ranked", roles=("super_admin",))

    d = (await client.get(f"{BASE}/workers/{ranked}", headers=hdrs)).json()
    assert (d["can_edit"], d["edit_block_reason"]) == (True, None)
    assert (d["can_change_status"], d["status_block_reason"]) == (False, "rank_too_low")

    portal_admin = await _make(db, client, "admin", "portal-admin@test.example.com")
    r = await client.put(f"/workers/{ranked}/profile", headers=portal_admin,
                         json={"status": "standby"})
    assert r.status_code == 403 and _code(r) == "rank_too_low", r.text


async def test_photo_version_changes_with_key(client, db, seeded_user):
    from serversherpa.api.routes.kiosk_rolodex import photo_version

    key_a = "attachments/person/pat/avatar/a.jpg"
    key_b = "attachments/person/pat/avatar/b.jpg"
    assert photo_version(None) is None
    assert photo_version(key_a) == _version(key_a)
    assert len(photo_version(key_a)) == 16
    assert photo_version(key_a) != photo_version(key_b)

    _, hdrs = await _kiosk_admin(db, client)
    pat = await _worker(db, "Pat", "Photo", avatar_key=key_a)

    async def both():
        detail = (await client.get(f"{BASE}/workers/{pat}", headers=hdrs)).json()
        rows = (await client.get(f"{BASE}/workers", headers=hdrs)).json()["workers"]
        row = next(w for w in rows if w["person_id"] == str(pat))
        assert row["photo_version"] == detail["photo_version"]
        assert row["has_photo"] == detail["has_photo"]
        return detail

    d = await both()
    assert d["has_photo"] is True
    assert d["photo_version"] == _version(key_a)
    assert key_a in d["photo_url"]

    # a new upload repoints avatar_key, so the version moves with it
    await db.execute(update(Person).where(Person.id == pat).values(avatar_key=key_b))
    await db.commit()
    d = await both()
    assert d["photo_version"] == _version(key_b)
    assert key_b in d["photo_url"]

    await db.execute(update(Person).where(Person.id == pat).values(avatar_key=None))
    await db.commit()
    d = await both()
    assert (d["has_photo"], d["photo_url"], d["photo_version"]) == (False, None, None)


# ── options ──────────────────────────────────────────────────────────

async def test_options(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    crew10, crew2, gone = (Partner(name="Crew 10"), Partner(name="crew 2"),
                           Partner(name="Gone Co", archived_at=datetime.now(UTC)))
    db.add_all([crew10, crew2, gone])
    db.add(StatusValue(record_type="worker", key="retired", label="Retired",
                       color="#123456", sort_order=9, is_active=False))
    await db.flush()
    ids = {p.name: str(p.id) for p in (crew10, crew2, gone)}
    await db.commit()
    seeded = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "worker"))}

    r = await client.get(f"{BASE}/options", headers=hdrs)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"levels", "statuses", "partners"}
    assert body["levels"] == [
        {"level": "L1", "title": "Apprentice", "color": "#8a93a6"},
        {"level": "L2", "title": "Junior Tech", "color": "#4dd0ff"},
        {"level": "L3", "title": "Technician", "color": "#35e0c8"},
        {"level": "L4", "title": "Senior Tech", "color": "#3ddc84"},
        {"level": "L5", "title": "Specialist", "color": "#a78bfa"},
        {"level": "L6", "title": "Master", "color": "#ffb84d"},
    ]
    # active statuses only, in their sort order
    assert body["statuses"] == [
        {"key": key, "label": seeded[key][0], "color": seeded[key][1]}
        for key in ("active", "standby", "blacklist")]
    assert [s["label"] for s in body["statuses"]] == ["Active", "Standby", "Blacklist"]
    # non-archived partners, natural order
    assert body["partners"] == [
        {"id": ids["crew 2"], "name": "crew 2"},
        {"id": ids["Crew 10"], "name": "Crew 10"},
    ]

    # a worker whose company was archived later still shows it
    held = await _worker(db, "Hal", "Held", partner_id=uuid.UUID(ids["Gone Co"]))
    rows = (await client.get(f"{BASE}/workers", headers=hdrs)).json()["workers"]
    row = next(w for w in rows if w["person_id"] == str(held))
    assert row["company"] == {"id": ids["Gone Co"], "name": "Gone Co"}


# ── writes: helpers ──────────────────────────────────────────────────

MATCH_FIELDS = {
    "person_id", "display_name", "job_title", "company", "is_worker",
    "has_account", "photo_url", "photo_version", "matched_on",
}


async def _bind_serial(db, person_id, serial):
    """What the kiosk's first check-in does: bind the session to its device."""
    await db.execute(update(AuthSession).where(AuthSession.person_id == person_id)
                     .values(kiosk_serial=serial))
    await db.commit()


async def _person(db, first, last, *, email=None, phone=None, preferred_name=None,
                  role=None, account=False, archived=False, source="manual",
                  job_title=None):
    """A person who is NOT a worker (staff, a portal user, a contact)."""
    person = Person(first_name=first, last_name=last, email=email, phone=phone,
                    preferred_name=preferred_name, job_title=job_title, source=source,
                    archived_at=datetime.now(UTC) if archived else None)
    db.add(person)
    await db.flush()
    pid = person.id
    if account:
        await _add_account(db, pid, f"login-{pid.hex[:10]}@test.example.com")
    if role:
        db.add(PersonRole(person_id=pid, role=role))
    await db.commit()
    return pid


async def _partner(db, name, *, archived=False):
    partner = Partner(name=name, archived_at=datetime.now(UTC) if archived else None)
    db.add(partner)
    await db.flush()
    pid = partner.id
    await db.commit()
    return pid


async def _fresh(db, model, key):
    """The row as the API left it (the test session may hold a stale copy)."""
    return await db.get(model, key, populate_existing=True)


async def _people_count(db):
    return await db.scalar(select(func.count()).select_from(Person))


async def _audits(db, entity_type, entity_id, action):
    return (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == entity_type, AuditLog.entity_id == str(entity_id),
        AuditLog.action == action))).all()


# ── duplicates ───────────────────────────────────────────────────────

async def test_duplicates_by_name_email_phone(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    ana = await _person(db, "Ana", "Ortiz", email="ana.ortiz@example.com",
                        phone="(312) 555-0142", role="staff", account=True,
                        job_title="Coordinator")
    # an archived twin and a move's hidden identity never match, and
    # sharing only the last name isn't a name match
    await _person(db, "Ana", "Ortiz", email="ana.old@example.com", archived=True)
    await _person(db, "Ana", "Ortiz", source=KIOSK_MOVE_SOURCE)
    bob = await _person(db, "Bob", "Ortiz", preferred_name="Bobby", role="staff")

    async def check(body):
        r = await client.post(f"{BASE}/duplicates", headers=hdrs, json=body)
        assert r.status_code == 200, r.text
        return r.json()["matches"]

    # name: case- and whitespace-insensitive; Bob Ortiz isn't Ana Ortiz
    matches = await check({"first_name": "ana", "last_name": " ORTIZ "})
    assert len(matches) == 1
    assert str(bob) not in {x["person_id"] for x in matches}
    m = matches[0]
    assert set(m) == MATCH_FIELDS
    assert m == {
        "person_id": str(ana), "display_name": "Ana Ortiz", "job_title": "Coordinator",
        "company": None, "is_worker": False, "has_account": True,
        "photo_url": None, "photo_version": None, "matched_on": ["name"],
    }

    # the same email, any case
    matches = await check({"first_name": "Zed", "last_name": "Nobody",
                           "email": "ANA.Ortiz@example.com"})
    assert [(x["person_id"], x["matched_on"]) for x in matches] == [(str(ana), ["email"])]
    matches = await check({"first_name": "Ana", "last_name": "Ortiz",
                           "email": "ana.ortiz@example.com"})
    assert [(x["person_id"], x["matched_on"]) for x in matches] == [
        (str(ana), ["name", "email"])]

    # the same phone, however it's punctuated, with or without the US 1
    for phone in ("312.555.0142", "+1 312 555 0142"):
        matches = await check({"first_name": "Zed", "last_name": "Nobody", "phone": phone})
        assert [(x["person_id"], x["matched_on"]) for x in matches] == [
            (str(ana), ["phone"])], phone
    matches = await check({"first_name": "Ana", "last_name": "Ortiz",
                           "email": "ana.ortiz@example.com", "phone": "3125550142"})
    assert matches[0]["matched_on"] == ["name", "email", "phone"]

    # nothing in common, or too few phone digits to be a key
    assert await check({"first_name": "Zed", "last_name": "Nobody"}) == []
    assert await check({"first_name": "Zed", "last_name": "Nobody", "phone": "0142"}) == []


async def test_duplicates_match_preferred_names_and_workers(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    crew = await _partner(db, "Summit Crew")
    key = "attachments/person/beto/avatar/one.jpg"
    beto = await _worker(db, "Roberto", "Díaz", preferred_name="Beto", avatar_key=key,
                         job_title="Rigger", partner_id=crew)
    await _worker(db, "Roberto", "Díaz Jr")    # a different last name

    for first in ("Beto", "roberto"):
        r = await client.post(f"{BASE}/duplicates", headers=hdrs,
                              json={"first_name": first, "last_name": "DÍAZ"})
        assert r.status_code == 200, r.text
        (m,) = r.json()["matches"]
        assert m["person_id"] == str(beto)
        assert m["display_name"] == "Beto Díaz"
        assert (m["is_worker"], m["has_account"]) == (True, False)
        assert (m["job_title"], m["company"]) == ("Rigger", "Summit Crew")
        assert m["photo_version"] == _version(key)
        assert key in m["photo_url"]
        assert m["matched_on"] == ["name"]

    # the new worker's preferred name counts too
    r = await client.post(f"{BASE}/duplicates", headers=hdrs, json={
        "first_name": "Bob", "preferred_name": "Beto", "last_name": "Díaz"})
    assert [x["person_id"] for x in r.json()["matches"]] == [str(beto)]


async def test_duplicates_match_names_split_differently(client, db, seeded_user):
    """name_keys compares the whole "given last" string, so a two-word
    given name or surname matches however the form split it."""
    _, hdrs = await _kiosk_admin(db, client)
    mary = await _worker(db, "Mary Ann", "Smith")
    jo = await _person(db, "Joanne", "de la  Cruz", preferred_name="Jo Ann", role="staff")

    for body, expected in (
            ({"first_name": "Mary", "last_name": "Ann Smith"}, mary),
            ({"first_name": "mary  ann", "last_name": "SMITH"}, mary),
            ({"first_name": "Jo", "last_name": "Ann de la Cruz"}, jo),
            ({"first_name": "Joanne", "last_name": "De La Cruz"}, jo)):
        r = await client.post(f"{BASE}/duplicates", headers=hdrs, json=body)
        assert r.status_code == 200, r.text
        assert [(m["person_id"], m["matched_on"]) for m in r.json()["matches"]] == [
            (str(expected), ["name"])], body

    for body in ({"first_name": "Mary", "last_name": "Smith"},
                 {"first_name": "Ann", "last_name": "Smith"}):
        r = await client.post(f"{BASE}/duplicates", headers=hdrs, json=body)
        assert r.json()["matches"] == [], body


async def test_duplicates_survive_casefold_only_letters(client, db, seeded_user):
    """name_keys casefolds (ß → ss, final ς → σ, İ → i̇) but Postgres only
    lowercases, so the SQL prefilter must never drop a person the Python
    rule would match: the same spelling, or one that casefolds alike."""
    _, hdrs = await _kiosk_admin(db, client)
    weiss = await _person(db, "Ana", "Weiß", role="staff")
    strauss = await _worker(db, "Lena", "STRAUSS")
    nikos = await _worker(db, "Νίκος", "Παπαδόπουλος")
    ibrahim = await _person(db, "İbrahim", "Yılmaz", role="staff")

    for body, expected in (
            ({"first_name": "Ana", "last_name": "Weiß"}, weiss),
            ({"first_name": "ana", "last_name": "WEISS"}, weiss),
            ({"first_name": "Lena", "last_name": "Strauß"}, strauss),
            ({"first_name": "Νίκος", "last_name": "Παπαδόπουλος"}, nikos),
            ({"first_name": "ΝΊΚΟΣ", "last_name": "ΠΑΠΑΔΌΠΟΥΛΟΣ"}, nikos),
            ({"first_name": "İbrahim", "last_name": "Yılmaz"}, ibrahim)):
        r = await client.post(f"{BASE}/duplicates", headers=hdrs, json=body)
        assert r.status_code == 200, r.text
        assert [(m["person_id"], m["matched_on"]) for m in r.json()["matches"]] == [
            (str(expected), ["name"])], body

    # so New worker stops before creating a second Ana Weiß
    r = await client.post(f"{BASE}/workers", headers=hdrs,
                          json={"first_name": "Ana", "last_name": "Weiß"})
    assert r.status_code == 409 and _code(r) == "possible_duplicate", r.text
    # ...and an accented name that isn't a match stays out
    r = await client.post(f"{BASE}/duplicates", headers=hdrs,
                          json={"first_name": "Ana", "last_name": "Weißmann"})
    assert r.json()["matches"] == []


async def test_duplicates_body_is_checked(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    for body in ({"first_name": "  ", "last_name": "Ortiz"},
                 {"first_name": "Ana"},
                 {"first_name": "Ana", "last_name": "Ortiz", "rfid_tag": "E200"}):
        r = await client.post(f"{BASE}/duplicates", headers=hdrs, json=body)
        assert r.status_code == 422, (body, r.text)


# ── create ───────────────────────────────────────────────────────────

async def test_create_makes_a_time_clock_worker(client, db, seeded_user):
    admin_id, hdrs = await _kiosk_admin(db, client)
    await _bind_serial(db, admin_id, "KIOSK-0042")
    crew = await _partner(db, "Summit Crew")

    r = await client.post(f"{BASE}/workers", headers=hdrs, json={
        "first_name": "  Marcus ", "last_name": " Reed", "preferred_name": "Marc",
        "job_title": "Rigger", "phone": "312-555-0199",
        "email": "marcus.reed@example.com", "partner_id": str(crew),
        "trade": "Rigging", "level": "L3", "photo_skipped": True})
    assert r.status_code == 201, r.text
    d = r.json()
    assert set(d) == DETAIL_FIELDS
    pid = uuid.UUID(d["person_id"])
    assert (d["first_name"], d["last_name"], d["preferred_name"], d["display_name"]) == (
        "Marcus", "Reed", "Marc", "Marc Reed")
    assert (d["job_title"], d["phone"], d["email"]) == (
        "Rigger", "312-555-0199", "marcus.reed@example.com")
    assert d["company"] == {"id": str(crew), "name": "Summit Crew"}
    assert (d["trade"], d["level"], d["status"], d["status_label"]) == (
        "Rigging", "L3", "active", "Active")
    assert (d["has_photo"], d["photo_url"], d["photo_version"]) == (False, None, None)
    assert (d["has_account"], d["rfid_enrolled"], d["external_id"]) == (False, False, None)
    assert (d["can_edit"], d["can_change_status"]) == (True, True)

    person = await _fresh(db, Person, pid)
    assert person.source == "manual"
    assert person.source_ref == "kiosk-rolodex:KIOSK-0042"
    assert person.created_by == admin_id
    roles = (await db.scalars(select(PersonRole).where(PersonRole.person_id == pid))).all()
    assert [(pr.role, pr.revoked_at, pr.granted_by) for pr in roles] == [
        ("worker", None, admin_id)]
    profile = await _fresh(db, WorkerProfile, pid)
    assert (profile.status, profile.partner_id, profile.trade, profile.level) == (
        "active", crew, "Rigging", "L3")
    assert profile.created_by == admin_id
    assert await _fresh(db, UserAccount, pid) is None

    # the Time Clock's roster picks the new worker up
    r = await client.get("/kiosk/sync/people", headers=hdrs)
    assert r.status_code == 200, r.text
    synced = {p["id"]: p for p in r.json()["people"]}
    assert synced[str(pid)]["is_worker"] is True
    assert synced[str(pid)]["has_account"] is False
    # ...and so does the Rolodex list
    rows = (await client.get(f"{BASE}/workers", headers=hdrs)).json()["workers"]
    assert str(pid) in {w["person_id"] for w in rows}

    (row,) = await _audits(db, "person", pid, "create")
    assert row.actor_person_id == admin_id
    c = row.changes
    assert c["via"] == "kiosk_rolodex"
    assert c["device"] == "KIOSK-0042"
    assert c["photo_skipped"] == {"from": None, "to": True}
    assert c["first_name"] == {"from": None, "to": "Marcus"}
    assert c["email"] == {"from": None, "to": "marcus.reed@example.com"}
    assert c["roles"] == {"from": None, "to": ["worker"]}
    assert c["account"] == {"from": None, "to": False}
    assert c["level"] == {"from": None, "to": "L3"}
    assert c["partner_id"] == {"from": None, "to": str(crew)}


async def test_create_minimal_without_a_bound_kiosk(client, db, seeded_user):
    """Only the names are required; a session no kiosk has bound yet (or a
    portal session) records the device as unknown, and photo_skipped is
    only recorded when it's sent."""
    _, hdrs = await _kiosk_admin(db, client)
    r = await client.post(f"{BASE}/workers", headers=hdrs,
                          json={"first_name": "Nia", "last_name": "New"})
    assert r.status_code == 201, r.text
    d = r.json()
    pid = uuid.UUID(d["person_id"])
    assert (d["preferred_name"], d["job_title"], d["company"], d["level"], d["trade"]) == (
        None, None, None, None, None)
    assert (d["email"], d["phone"]) == (None, None)
    assert (await _fresh(db, Person, pid)).source_ref == "kiosk-rolodex:unknown"
    (row,) = await _audits(db, "person", pid, "create")
    assert "photo_skipped" not in row.changes
    assert row.changes["device"] is None
    assert row.changes["via"] == "kiosk_rolodex"


async def test_create_refuses_possible_duplicate(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    marcus = await _worker(db, "Marcus", "Reed", phone="312-555-0199")
    body = {"first_name": "marcus", "last_name": "REED"}
    before = await _people_count(db)

    r = await client.post(f"{BASE}/workers", headers=hdrs, json=body)
    assert r.status_code == 409, r.text
    assert _code(r) == "possible_duplicate"
    # the matches ride along, so a race shows the same sheet
    assert [(m["person_id"], m["matched_on"]) for m in r.json()["detail"]["matches"]] == [
        (str(marcus), ["name"])]
    # a phone match alone counts too
    r = await client.post(f"{BASE}/workers", headers=hdrs, json={
        "first_name": "Zed", "last_name": "Nobody", "phone": "(312) 555-0199"})
    assert r.status_code == 409 and _code(r) == "possible_duplicate", r.text
    assert await _people_count(db) == before

    r = await client.post(f"{BASE}/workers", headers=hdrs,
                          json={**body, "allow_duplicate": True})
    assert r.status_code == 201, r.text
    assert r.json()["person_id"] != str(marcus)
    assert await _people_count(db) == before + 1


async def test_create_email_in_use(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    await _person(db, "Ana", "Ortiz", email="ana.ortiz@example.com")
    # the unique index covers archived people too
    await _person(db, "Old", "Timer", email="old.timer@example.com", archived=True)
    before = await _people_count(db)

    for email in ("ANA.ORTIZ@example.com", "old.timer@example.com"):
        for allow in (False, True):     # Create anyway can't reuse an email
            r = await client.post(f"{BASE}/workers", headers=hdrs, json={
                "first_name": "Zed", "last_name": "Nobody", "email": email,
                "allow_duplicate": allow})
            assert r.status_code == 409, (email, allow, r.text)
            assert _code(r) == "email_in_use", (email, allow, r.text)
    assert await _people_count(db) == before


async def test_create_validation(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    gone = await _partner(db, "Gone Co", archived=True)
    before = await _people_count(db)
    base = {"first_name": "Nia", "last_name": "New"}

    for extra, code in (({"level": "L9"}, "unknown_level"),
                        ({"partner_id": str(gone)}, "partner_archived"),
                        ({"partner_id": str(uuid.uuid4())}, "partner_not_found")):
        r = await client.post(f"{BASE}/workers", headers=hdrs, json={**base, **extra})
        assert r.status_code == 422, (extra, r.text)
        assert _code(r) == code, (extra, r.text)

    for body in ({"first_name": "  ", "last_name": "New"},
                 {"first_name": "Nia", "last_name": ""},
                 {"last_name": "New"},
                 {**base, "email": "not-an-email"},
                 {**base, "status": "standby"},          # status isn't a create field
                 {**base, "rfid_tag": "E200-0001"}):     # nor is anything read-only
        r = await client.post(f"{BASE}/workers", headers=hdrs, json=body)
        assert r.status_code == 422, (body, r.text)
    assert await _people_count(db) == before


async def test_email_race_maps_to_email_in_use(client, db, seeded_user, monkeypatch):
    """Two kiosks saving the same email at once both pass the pre-check;
    the unique index catches the second, and it still reads as
    email_in_use. On PATCH the clash surfaces inside the profile helper
    (its first query autoflushes the person row), not at commit."""
    from serversherpa.api.routes import kiosk_rolodex

    async def never_taken(db, email, *, exclude=None):
        return False

    monkeypatch.setattr(kiosk_rolodex, "_email_taken", never_taken)
    _, hdrs = await _kiosk_admin(db, client)
    await _person(db, "Ana", "Ortiz", email="ana.ortiz@example.com")
    paz = await _worker(db, "Paz", "Plain", email="paz@example.com")

    r = await client.post(f"{BASE}/workers", headers=hdrs, json={
        "first_name": "Zed", "last_name": "Nobody", "email": "ana.ortiz@example.com",
        "allow_duplicate": True})       # past the duplicate check's email match
    assert r.status_code == 409 and _code(r) == "email_in_use", r.text

    r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs, json={
        "email": "ana.ortiz@example.com", "job_title": "Rigger", "trade": "Rigging"})
    assert r.status_code == 409 and _code(r) == "email_in_use", r.text
    person = await _fresh(db, Person, paz)
    assert (person.email, person.job_title) == ("paz@example.com", None)
    assert (await _fresh(db, WorkerProfile, paz)).trade is None

    # a worker with no profile row: the clash surfaces in get_or_create_profile,
    # with or without profile fields in the body, and no profile is left behind
    nia = await _worker(db, "Nia", "Bare", email="nia@example.com", profile=False)
    for body in ({"email": "ana.ortiz@example.com", "job_title": "Rigger"},
                 {"email": "ana.ortiz@example.com", "trade": "Rigging"}):
        r = await client.patch(f"{BASE}/workers/{nia}", headers=hdrs, json=body)
        assert r.status_code == 409 and _code(r) == "email_in_use", (body, r.text)
        person = await _fresh(db, Person, nia)
        assert (person.email, person.job_title) == ("nia@example.com", None)
        assert await _fresh(db, WorkerProfile, nia) is None


async def test_only_the_email_index_reads_as_email_in_use():
    from sqlalchemy.exc import IntegrityError

    from serversherpa.api.routes.kiosk_rolodex import _is_email_clash

    class Cause(Exception):
        def __init__(self, constraint_name):
            self.constraint_name = constraint_name

    def clash(name):
        orig = Exception("duplicate key")
        orig.__cause__ = Cause(name)
        return IntegrityError("INSERT …", {}, orig)

    assert _is_email_clash(clash("people_email_uniq")) is True
    assert _is_email_clash(clash("people_rfid_uniq")) is False
    assert _is_email_clash(IntegrityError("INSERT …", {}, Exception("x"))) is False


# ── edit ─────────────────────────────────────────────────────────────

async def test_patch_returns_detail(client, db, seeded_user):
    admin_id, hdrs = await _kiosk_admin(db, client)
    await _bind_serial(db, admin_id, "KIOSK-0042")
    crew = await _partner(db, "Summit Crew")
    paz = await _worker(db, "Paz", "Plain", email="paz@example.com", phone="555-0100",
                        account=True, roles=("staff",))

    r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs, json={
        "preferred_name": "Pazzy", "job_title": "Rigger", "email": "PAZ.NEW@example.com",
        "partner_id": str(crew), "trade": "Rigging", "level": "L2",
        "status": "standby", "status_note": "Back Monday"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert set(d) == DETAIL_FIELDS
    assert (d["display_name"], d["job_title"], d["email"], d["phone"]) == (
        "Pazzy Plain", "Rigger", "PAZ.NEW@example.com", "555-0100")
    assert d["company"] == {"id": str(crew), "name": "Summit Crew"}
    assert (d["trade"], d["level"], d["status"], d["status_label"], d["status_note"]) == (
        "Rigging", "L2", "standby", "Standby", "Back Monday")
    assert (d["has_account"], d["can_edit"], d["can_change_status"]) == (True, True, True)

    # one audit row per part, both naming the kiosk
    (person_row,) = await _audits(db, "person", paz, "update")
    (profile_row,) = await _audits(db, "worker", paz, "profile.update")
    for row in (person_row, profile_row):
        assert row.actor_person_id == admin_id
        assert (row.changes["via"], row.changes["device"]) == ("kiosk_rolodex", "KIOSK-0042")
    assert person_row.changes["job_title"] == {"from": None, "to": "Rigger"}
    assert profile_row.changes["status"] == {"from": "active", "to": "standby"}

    # an empty body changes nothing and still answers with the page
    r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs, json={})
    assert r.status_code == 200, r.text
    assert r.json() == d
    assert len(await _audits(db, "person", paz, "update")) == 1


async def test_patch_person_and_profile_in_one_transaction(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    paz = await _worker(db, "Paz", "Plain", job_title="Mover")

    r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs,
                           json={"job_title": "Rigger", "level": "L9"})
    assert r.status_code == 422, r.text
    assert _code(r) == "unknown_level"
    assert (await _fresh(db, Person, paz)).job_title == "Mover"
    assert await _audits(db, "person", paz, "update") == []

    r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs,
                           json={"job_title": "Rigger", "level": "L3"})
    assert r.status_code == 200, r.text
    assert (await _fresh(db, Person, paz)).job_title == "Rigger"
    assert (await _fresh(db, WorkerProfile, paz)).level == "L3"


async def test_edit_keeps_a_profileless_worker_on_the_time_clock(client, db, seeded_user):
    """/kiosk/sync/people reads a worker profile as "is a worker", and the
    apps put a saved worker into the Time Clock's roster, so every save
    makes sure the profile row exists, even one that only changes a name."""
    _, hdrs = await _kiosk_admin(db, client)
    nia = await _worker(db, "Nia", "Bare", profile=False)
    noe = await _worker(db, "Noe", "Bare", profile=False)
    r = await client.get("/kiosk/sync/people", headers=hdrs)
    assert str(nia) not in {p["id"] for p in r.json()["people"]}

    r = await client.patch(f"{BASE}/workers/{nia}", headers=hdrs,
                           json={"job_title": "Rigger"})
    assert r.status_code == 200, r.text
    assert (r.json()["job_title"], r.json()["status"]) == ("Rigger", "active")
    r = await client.patch(f"{BASE}/workers/{noe}", headers=hdrs, json={})
    assert r.status_code == 200, r.text

    for pid in (nia, noe):
        profile = await _fresh(db, WorkerProfile, pid)
        assert profile is not None
        assert (profile.status, profile.trade, profile.level, profile.partner_id) == (
            "active", None, None, None)
    r = await client.get("/kiosk/sync/people", headers=hdrs)
    synced = {p["id"]: p for p in r.json()["people"]}
    for pid in (nia, noe):
        assert synced[str(pid)]["is_worker"] is True
        assert synced[str(pid)]["has_account"] is False

    # a refused save leaves no profile behind, whether it's refused before
    # the profile is flushed or after (unknown_level is checked once the
    # new row exists)
    ray = await _worker(db, "Ray", "Bare", profile=False)
    for body, code in (({"first_name": None}, "first_name_required"),
                       ({"level": "L9"}, "unknown_level"),
                       ({"job_title": "Rigger", "level": "L9"}, "unknown_level")):
        r = await client.patch(f"{BASE}/workers/{ray}", headers=hdrs, json=body)
        assert r.status_code == 422 and _code(r) == code, (body, r.text)
        assert await _fresh(db, WorkerProfile, ray) is None, body
    assert (await _fresh(db, Person, ray)).job_title is None


async def test_patch_clears_with_null(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    crew = await _partner(db, "Summit Crew")
    paz = await _worker(db, "Paz", "Plain", preferred_name="Pazzy", phone="555-0100",
                        email="paz@example.com", job_title="Rigger", partner_id=crew,
                        trade="Rigging", level="L2")

    r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs, json={"phone": None})
    assert r.status_code == 200, r.text
    assert r.json()["phone"] is None
    assert r.json()["email"] == "paz@example.com"     # absent = unchanged
    assert (await _fresh(db, Person, paz)).phone is None

    r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs, json={
        "preferred_name": None, "email": None, "job_title": "  ",
        "partner_id": None, "trade": None, "level": None})
    assert r.status_code == 200, r.text
    d = r.json()
    assert (d["display_name"], d["email"], d["job_title"]) == ("Paz Plain", None, None)
    assert (d["company"], d["trade"], d["level"], d["level_color"]) == (
        None, None, None, None)

    for field in ("first_name", "last_name"):
        r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs, json={field: None})
        assert r.status_code == 422, r.text
        assert _code(r) == f"{field}_required"
    r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs, json={"first_name": " "})
    assert r.status_code == 422, r.text
    assert (await _fresh(db, Person, paz)).first_name == "Paz"


async def test_patch_rules(client, db, seeded_user):
    me, hdrs = await _kiosk_admin(db, client, worker=True)
    boss = await _worker(db, "Sue", "Boss", account=True, roles=("super_admin",))
    plain = await _worker(db, "Paz", "Plain")
    lead = await _worker(db, "Lou", "Lead", account=True, roles=("staff",))

    # a login ranked above yours
    for body in ({"job_title": "Rigger"}, {"status": "standby"}):
        r = await client.patch(f"{BASE}/workers/{boss}", headers=hdrs, json=body)
        assert r.status_code == 403, (body, r.text)
        assert _code(r) == "rank_too_low", (body, r.text)

    # your own row: details yes, status no
    r = await client.patch(f"{BASE}/workers/{me}", headers=hdrs, json={"job_title": "Lead"})
    assert r.status_code == 200, r.text
    r = await client.patch(f"{BASE}/workers/{me}", headers=hdrs, json={"status": "standby"})
    assert r.status_code == 403, r.text
    assert _code(r) == "cannot_target_self"

    for body, code in (({"status": "blacklist"}, "blacklist_requires_note"),
                       ({"status": "blacklist", "status_note": "   "},
                        "blacklist_requires_note"),
                       ({"status": "retired-ish"}, "unknown_status"),
                       ({"status": None}, "status_required"),
                       ({"partner_id": str(uuid.uuid4())}, "partner_not_found")):
        r = await client.patch(f"{BASE}/workers/{plain}", headers=hdrs, json=body)
        assert r.status_code == 422, (body, r.text)
        assert _code(r) == code, (body, r.text)

    # blacklisting an account holder disables the login and ends their sessions
    r = await client.post("/auth/login", json={
        "email": f"login-{lead.hex[:10]}@test.example.com", "password": PW})
    assert r.status_code == 200, r.text
    r = await client.patch(f"{BASE}/workers/{lead}", headers=hdrs, json={
        "status": "blacklist", "status_note": "Walked off the job"})
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["status_note"]) == ("blacklist", "Walked off the job")
    assert (await _fresh(db, UserAccount, lead)).disabled_at is not None
    live = await db.scalar(select(func.count()).select_from(AuthSession).where(
        AuthSession.person_id == lead, AuthSession.revoked_at.is_(None)))
    assert live == 0

    # people the Rolodex doesn't show can't be edited either
    archived = await _worker(db, "Ari", "Archived", archived=True)
    move_identity = await _worker(db, "Kiosk", "Dock Move", source=KIOSK_MOVE_SOURCE,
                                  profile=False)
    for pid in (archived, move_identity, seeded_user.id, uuid.uuid4()):
        r = await client.patch(f"{BASE}/workers/{pid}", headers=hdrs,
                               json={"job_title": "Rigger"})
        assert r.status_code == 404, (pid, r.text)
        assert _code(r) == "person_not_found"


async def test_patch_partner_rules(client, db, seeded_user):
    """A worker keeps a company archived after they joined it, but can't be
    newly linked to one; the picker only offers non-archived partners."""
    _, hdrs = await _kiosk_admin(db, client)
    gone = await _partner(db, "Gone Co", archived=True)
    crew = await _partner(db, "Summit Crew")
    held = await _worker(db, "Hal", "Held", partner_id=gone)
    plain = await _worker(db, "Paz", "Plain")
    bare = await _worker(db, "Nia", "Bare", profile=False)

    for pid in (plain, bare):
        r = await client.patch(f"{BASE}/workers/{pid}", headers=hdrs,
                               json={"partner_id": str(gone)})
        assert r.status_code == 422, r.text
        assert _code(r) == "partner_archived"

    r = await client.patch(f"{BASE}/workers/{held}", headers=hdrs,
                           json={"partner_id": str(gone), "trade": "Rigging"})
    assert r.status_code == 200, r.text
    assert r.json()["company"] == {"id": str(gone), "name": "Gone Co"}

    r = await client.patch(f"{BASE}/workers/{held}", headers=hdrs,
                           json={"partner_id": str(crew)})
    assert r.status_code == 200, r.text
    assert r.json()["company"] == {"id": str(crew), "name": "Summit Crew"}


# ── writes: gates ────────────────────────────────────────────────────

async def test_writes_frozen_in_read_only_mode(client, db, seeded_user):
    _, hdrs = await _kiosk_admin(db, client)
    paz = await _worker(db, "Paz", "Plain")
    super_admin = await _admin(db, client)
    r = await client.put("/system/admin", headers=super_admin, json={"read_only": True})
    assert r.status_code == 200, r.text
    before = await _people_count(db)

    for method, path, body in (
            ("POST", f"{BASE}/duplicates", {"first_name": "Paz", "last_name": "Plain"}),
            ("POST", f"{BASE}/workers", {"first_name": "Nia", "last_name": "New"}),
            ("PATCH", f"{BASE}/workers/{paz}", {"job_title": "Rigger"})):
        r = await client.request(method, path, headers=hdrs, json=body)
        assert r.status_code == 423, (path, r.text)
        assert _code(r) == "read_only_mode", (path, r.text)
    assert await _people_count(db) == before
    assert (await _fresh(db, Person, paz)).job_title is None


async def test_write_routes_need_their_own_permission(client, db, seeded_user):
    """Every rank-60 global role holds workers:add and workers:change, so
    deny them per person to prove each route checks its own."""
    admin_id, hdrs = await _kiosk_admin(db, client)
    paz = await _worker(db, "Paz", "Plain")
    create = {"first_name": "Nia", "last_name": "New"}
    dupes = {"first_name": "Paz", "last_name": "Plain"}

    db.add(PermissionOverride(person_id=admin_id, resource="workers", action="add",
                              allow=False))
    await db.commit()
    for path, body in ((f"{BASE}/duplicates", dupes), (f"{BASE}/workers", create)):
        r = await client.post(path, headers=hdrs, json=body)
        assert r.status_code == 403, (path, r.text)
        assert _code(r) == "forbidden", (path, r.text)
    r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs, json={"trade": "Rigging"})
    assert r.status_code == 200, r.text

    await db.execute(update(PermissionOverride).where(
        PermissionOverride.person_id == admin_id).values(action="change"))
    await db.commit()
    r = await client.patch(f"{BASE}/workers/{paz}", headers=hdrs, json={"trade": "Crane"})
    assert r.status_code == 403, r.text
    assert _code(r) == "forbidden"
    assert (await _fresh(db, WorkerProfile, paz)).trade == "Rigging"
    for path, body in ((f"{BASE}/duplicates", dupes), (f"{BASE}/workers", create)):
        r = await client.post(path, headers=hdrs, json=body)
        assert r.status_code in (200, 201), (path, r.text)
    # reading needs neither
    assert (await client.get(f"{BASE}/workers/{paz}", headers=hdrs)).status_code == 200


async def test_write_routes_refuse_staff_and_workers(client, db, seeded_user):
    paz = await _worker(db, "Paz", "Plain")
    r = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": PW, "client": "kiosk"})
    staff = {"Authorization": f"Bearer {r.json()['access_token']}"}
    _, worker = await _kiosk_user(db, client, "wes@test.example.com", "worker",
                                  first="Wes", last="Worker")
    before = await _people_count(db)

    for who, hdrs in (("staff", staff), ("worker", worker)):
        for method, path, body in (
                ("POST", f"{BASE}/duplicates", {"first_name": "Paz", "last_name": "Plain"}),
                ("POST", f"{BASE}/workers", {"first_name": "Nia", "last_name": "New"}),
                ("PATCH", f"{BASE}/workers/{paz}", {"job_title": "Rigger"})):
            r = await client.request(method, path, headers=hdrs, json=body)
            assert r.status_code == 403, (who, path, r.text)
            assert _code(r) == "forbidden", (who, path, r.text)
    assert await _people_count(db) == before
