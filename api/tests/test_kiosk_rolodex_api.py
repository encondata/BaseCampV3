"""Kiosk Rolodex: the worker list, the worker page and the pickers' options
for admins on the native kiosk apps (GET /kiosk/rolodex/workers,
/workers/{person_id}, /options).

Only a person session of rank 60+ with a global role gets in: staff,
workers, move-password sessions and station keys are refused. The list is
cached offline, so it never carries email or phone; the worker page does.
Spec: docs/superpowers/specs/2026-10-22-kiosk-rolodex-design.md (§3, §4.1).
"""

import hashlib
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Initiative,
    Partner,
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
