"""Learning at the time clock: the `learning` block on the station's status
(open assignments for the station's move, or the general set without one),
"Email me the link", the admin override (an admin's email + password + 2FA
checked at the shared station without opening a session) and the punch it
links to. Punches are never blocked on learning."""
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog,
    AuthSession,
    Device,
    EmailOutbox,
    Person,
    PersonRole,
    Site,
    TimeEntry,
    UserAccount,
)
from serversherpa.learning import emails
from serversherpa.learning import timeclock as learning_timeclock
from serversherpa.learning.models import LearningAssignment, LearningOverride
from serversherpa.security.passwords import hash_password
from tests.test_kiosk_station_key import SERIAL
from tests.test_kiosk_station_scans import _auth
from tests.test_kiosk_timeclock_api import _just_past_midnight_zone
from tests.test_kiosk_timeclock_station_key import _timeclock_station
from tests.test_learning_assign import _doc, _initiative, _worker
from tests.test_sites_api import login
from tests.test_totp_api import _enroll_direct, _next_code, _security

ADMIN_PW = "Admin-Station-Pass9!"


# ── helpers ──────────────────────────────────────────────────────────


async def _account(db, role="admin", email=None, password=ADMIN_PW):
    email = email or f"tc-{uuid.uuid4().hex[:8]}@test.example.com"
    person = Person(first_name="Ada", last_name="Admin", email=email)
    db.add(person)
    await db.flush()
    db.add(UserAccount(person_id=person.id, email=email, password_hash=hash_password(
        password, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=person.id, role=role))
    await db.commit()
    return person.id, email


async def _assign(db, person_id, doc, initiative=None, *, source="rule", status="assigned"):
    row = LearningAssignment(
        person_id=person_id, initiative_id=initiative.id if initiative else None,
        document_id=doc.id, version_id=doc.current_version_id, source=source, status=status)
    db.add(row)
    await db.commit()
    return row


async def _status(client, key, pid, **params):
    return await client.get(f"/kiosk/station/timeclock/{pid}", headers=_auth(key),
                            params={"serial": SERIAL, **params})


def _override_body(pid, email, password=ADMIN_PW, **extra):
    return {"serial": SERIAL, "person_id": str(pid), "admin_email": email,
            "admin_password": password, "reason": "signed_on_paper", "scope": "punch",
            **extra}


async def _override(client, key, pid, email, password=ADMIN_PW, **extra):
    return await client.post("/kiosk/station/timeclock/learning-override", headers=_auth(key),
                             json=_override_body(pid, email, password, **extra))


async def _account_row(db, person_id):
    return await db.scalar(select(UserAccount).where(UserAccount.person_id == person_id)
                           .execution_options(populate_existing=True))


async def _overrides(db):
    return list(await db.scalars(select(LearningOverride).order_by(LearningOverride.created_at)
                                 .execution_options(populate_existing=True)))


async def _sessions(db, person_id):
    return await db.scalar(select(func.count()).select_from(AuthSession)
                           .where(AuthSession.person_id == person_id))


async def _owing(db, init):
    """A worker (with email) owing one required document on `init`."""
    worker = await _worker(db, "Wes", "Owing", f"wes-{uuid.uuid4().hex[:6]}@test.example.com")
    doc = await _doc(db, "Site safety")
    await _assign(db, worker.id, doc, init)
    return worker.id


# ── status ───────────────────────────────────────────────────────────


async def test_status_learning_null_when_nothing_open(client, db, seeded_user):
    _, init, key = await _timeclock_station(db)
    worker = await _worker(db)
    signed = await _doc(db, "Signed already")
    await _assign(db, worker.id, signed, init, status="signed")

    r = await _status(client, key, worker.id)
    assert r.status_code == 200, r.text
    assert r.json()["learning"] is None


async def test_status_lists_station_initiative_only(client, db, seeded_user):
    _, init, key = await _timeclock_station(db)
    other = await _initiative(db, "Some other move")
    worker = await _worker(db)
    safety, dress, extra, theirs, general = [
        await _doc(db, t) for t in ("Site safety", "Dress code", "Forklift refresher",
                                     "Other move rules", "Company handbook")]
    await _assign(db, worker.id, safety, init)
    await _assign(db, worker.id, dress, init, status="opened")
    await _assign(db, worker.id, extra, init, source="manual")
    await _assign(db, worker.id, theirs, other)
    await _assign(db, worker.id, general, None)

    r = await _status(client, key, worker.id)
    assert r.status_code == 200, r.text
    assert r.json()["learning"] == {
        "outstanding": [{"title": "Dress code", "kind": "required"},
                        {"title": "Site safety", "kind": "required"},
                        {"title": "Forklift refresher", "kind": "extra"}],
        "link_email": True}

    # nobody to email: the block still shows, without the link button
    ned = await _worker(db, "Ned", "Nomail", None)
    await _assign(db, ned.id, safety, init)
    r = await _status(client, key, ned.id)
    assert r.json()["learning"] == {
        "outstanding": [{"title": "Site safety", "kind": "required"}], "link_email": False}


async def test_status_no_move_uses_general_assignments(client, db, seeded_user):
    device, init, key = await _timeclock_station(db)
    live = await db.get(Device, device.id)
    live.current_initiative_id = None
    live.station_key_initiative_id = None
    await db.commit()
    worker = await _worker(db)
    on_move, general = await _doc(db, "Move rules"), await _doc(db, "Company handbook")
    await _assign(db, worker.id, on_move, init)
    await _assign(db, worker.id, general, None)

    r = await _status(client, key, worker.id)
    assert r.status_code == 200, r.text
    assert r.json()["learning"]["outstanding"] == [
        {"title": "Company handbook", "kind": "required"}]


async def test_status_never_500_without_learning_rows(client, db, seeded_user, monkeypatch):
    _, init, key = await _timeclock_station(db)
    worker = await _worker(db)
    # no learning rows at all
    r = await _status(client, key, worker.id)
    assert r.status_code == 200, r.text
    assert r.json()["learning"] is None
    # the session twin too
    hdrs = await login(client)
    r = await client.get(f"/kiosk/timeclock/{worker.id}", headers=hdrs,
                         params={"serial": SERIAL})
    assert r.status_code == 200, r.text
    assert r.json()["learning"] is None

    # learning itself failing never fails the status read or the punch
    await _assign(db, worker.id, await _doc(db, "Site safety"), init)

    async def boom(*args, **kwargs):
        raise RuntimeError("learning is down")

    monkeypatch.setattr(learning_timeclock, "outstanding", boom)
    r = await _status(client, key, worker.id)
    assert r.status_code == 200, r.text
    assert r.json()["learning"] is None
    r = await client.post("/kiosk/station/timeclock/clock-in", headers=_auth(key),
                          json={"serial": SERIAL, "person_id": str(worker.id)})
    assert r.status_code == 200, r.text
    assert r.json()["clocked_in"] is True


async def test_status_session_twin_lists_learning(client, db, seeded_user):
    _, init, _ = await _timeclock_station(db)
    pid = await _owing(db, init)
    hdrs = await login(client)
    r = await client.get(f"/kiosk/timeclock/{pid}", headers=hdrs, params={"serial": SERIAL})
    assert r.status_code == 200, r.text
    assert r.json()["learning"]["outstanding"] == [{"title": "Site safety", "kind": "required"}]
    # punching with things outstanding is never refused
    r = await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                          json={"serial": SERIAL, "person_id": str(pid)})
    assert r.status_code == 200, r.text


async def test_day_override_suppresses_until_local_midnight(client, db, seeded_user):
    device, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    _, email = await _account(db)
    zone = _just_past_midnight_zone()
    local_today = datetime.now(ZoneInfo(zone)).date()

    # a punch-only override leaves the warning up
    r = await _override(client, key, pid, email, tz=zone)
    assert r.status_code == 200, r.text
    assert (await _status(client, key, pid, tz=zone)).json()["learning"] is not None

    r = await _override(client, key, pid, email, scope="day", tz=zone)
    assert r.status_code == 200, r.text
    day = await db.get(LearningOverride, uuid.UUID(r.json()["override_id"]))
    assert day.local_day == local_today
    assert (await _status(client, key, pid, tz=zone)).json()["learning"] is None

    # the next local day it is back
    day.local_day = local_today - timedelta(days=1)
    await db.commit()
    assert (await _status(client, key, pid, tz=zone)).json()["learning"] is not None
    day.local_day = local_today
    await db.commit()

    # it covers that site only
    live = await db.get(Device, device.id)
    elsewhere = Site(name=f"Elsewhere {uuid.uuid4().hex[:6]}")
    db.add(elsewhere)
    await db.flush()
    live.site_id = elsewhere.id
    await db.commit()
    assert (await _status(client, key, pid, tz=zone)).json()["learning"] is not None

    # the service: the day is the caller's local day
    items = await learning_timeclock.outstanding(db, pid, init.id, day.site_id, local_today)
    assert items == []
    items = await learning_timeclock.outstanding(
        db, pid, init.id, day.site_id, local_today + timedelta(days=1))
    assert items == [{"title": "Site safety", "kind": "required"}]


# ── override ─────────────────────────────────────────────────────────


async def test_override_writes_row_and_audit_without_a_session(client, db, seeded_user):
    device, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    admin_id, email = await _account(db)
    r = await _override(client, key, pid, email, reason="other", reason_text="Badge printer down")
    assert r.status_code == 200, r.text
    [row] = await _overrides(db)
    assert r.json() == {"override_id": str(row.id)}
    assert (row.person_id, row.admin_person_id, row.device_id, row.initiative_id) == (
        pid, admin_id, device.id, init.id)
    live = await db.get(Device, device.id)
    assert row.site_id == live.site_id
    assert (row.reason, row.reason_text, row.scope) == ("other", "Badge printer down", "punch")
    assert row.outstanding == [{"title": "Site safety", "kind": "required"}]
    assert row.time_entry_id is None
    log = await db.scalar(select(AuditLog).where(AuditLog.action == "learning_override"))
    assert log.actor_person_id == admin_id and log.entity_id == str(row.id)
    assert log.changes["person_id"] == str(pid)
    assert await _sessions(db, admin_id) == 0


async def test_override_bad_password_401_counts_lockout(client, db, seeded_user):
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    admin_id, email = await _account(db)

    r = await _override(client, key, pid, "nobody@test.example.com")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_credentials"

    r = await _override(client, key, pid, email, "wrong-password")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_credentials"
    assert (await _account_row(db, admin_id)).failed_login_count == 1

    for _ in range(get_settings().max_failed_logins - 1):
        r = await _override(client, key, pid, email, "wrong-password")
        assert r.status_code == 401
    account = await _account_row(db, admin_id)
    assert account.locked_until is not None and account.locked_until > datetime.now(UTC)
    # locked: even the right password is refused
    r = await _override(client, key, pid, email)
    assert r.status_code == 423 and r.json()["detail"]["code"] == "account_locked"
    assert await _overrides(db) == []
    assert await _sessions(db, admin_id) == 0

    # a disabled account fails too
    other_id, other = await _account(db)
    (await _account_row(db, other_id)).disabled_at = datetime.now(UTC)
    await db.commit()
    r = await _override(client, key, pid, other)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "account_disabled"
    assert await _overrides(db) == []


async def test_override_rank_403(client, db, seeded_user):
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    staff_id, email = await _account(db, role="staff")
    r = await _override(client, key, pid, email)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "override_rank"
    assert (await _account_row(db, staff_id)).failed_login_count == 0
    assert await _overrides(db) == []


async def test_override_totp_required(client, db, seeded_user):
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    admin_id, email = await _account(db)
    await _security(db, two_factor_enabled=True)
    secret, _ = await _enroll_direct(db, admin_id)

    r = await _override(client, key, pid, email)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "totp_required"
    assert (await _account_row(db, admin_id)).failed_login_count == 0
    # a wrong password never learns that 2FA is on
    r = await _override(client, key, pid, email, "wrong-password")
    assert r.json()["detail"]["code"] == "invalid_credentials"

    r = await _override(client, key, pid, email, totp_code="000000")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "totp_invalid"

    code = _next_code(secret)
    r = await _override(client, key, pid, email, totp_code=code)
    assert r.status_code == 200, r.text
    account = await _account_row(db, admin_id)
    assert account.failed_login_count == 0
    # the replay guard: the same code twice is refused
    r = await _override(client, key, pid, email, totp_code=code)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "totp_invalid"
    assert len(await _overrides(db)) == 1
    assert await _sessions(db, admin_id) == 0


async def test_override_other_needs_text(client, db, seeded_user):
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    admin_id, email = await _account(db)
    for text in (None, "", "   "):
        extra = {"reason": "other"} if text is None else {"reason": "other", "reason_text": text}
        # checked before the credentials: no lockout strike for a bad form
        r = await _override(client, key, pid, email, "wrong-password", **extra)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "reason_text_required"
    assert (await _account_row(db, admin_id)).failed_login_count == 0
    for bad in ({"reason": "felt_like_it"}, {"scope": "week"}):
        r = await _override(client, key, pid, email, **bad)
        assert r.status_code == 422, bad
    assert await _overrides(db) == []


# ── clock-in linking ─────────────────────────────────────────────────


async def test_clock_in_links_override(client, db, seeded_user):
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    _, email = await _account(db)
    override_id = (await _override(client, key, pid, email)).json()["override_id"]

    async def clock_in(person_id, oid):
        return await client.post("/kiosk/station/timeclock/clock-in", headers=_auth(key),
                                 json={"serial": SERIAL, "person_id": str(person_id),
                                       "learning_override_id": oid})

    # someone else's override is refused, and nothing is punched
    stranger = await _worker(db, "Sam", "Stranger", None)
    r = await clock_in(stranger.id, override_id)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_learning_override"
    assert await db.scalar(select(TimeEntry).where(TimeEntry.person_id == stranger.id)) is None
    r = await clock_in(pid, str(uuid.uuid4()))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_learning_override"

    r = await clock_in(pid, override_id)
    assert r.status_code == 200, r.text
    entry_id = uuid.UUID(r.json()["entry"]["id"])
    [row] = await _overrides(db)
    assert row.time_entry_id == entry_id

    # one punch per override
    r = await client.post("/kiosk/station/timeclock/clock-out", headers=_auth(key),
                          json={"serial": SERIAL, "person_id": str(pid)})
    assert r.status_code == 200, r.text
    r = await clock_in(pid, override_id)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_learning_override"

    # an override from another day is refused
    other_id = (await _override(client, key, pid, email)).json()["override_id"]
    stale = await db.get(LearningOverride, uuid.UUID(other_id))
    stale.local_day = stale.local_day - timedelta(days=1)
    await db.commit()
    r = await clock_in(pid, other_id)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_learning_override"


async def test_session_twins_override_and_link(client, db, seeded_user):
    _, init, _ = await _timeclock_station(db)
    pid = await _owing(db, init)
    admin_id, email = await _account(db)
    hdrs = await login(client)
    body = _override_body(pid, email)
    r = await client.post("/kiosk/timeclock/learning-override", headers=hdrs, json=body)
    assert r.status_code == 200, r.text
    oid = r.json()["override_id"]
    r = await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                          json={"serial": SERIAL, "person_id": str(pid),
                                "learning_override_id": oid})
    assert r.status_code == 200, r.text
    [row] = await _overrides(db)
    assert str(row.time_entry_id) == r.json()["entry"]["id"]
    assert row.admin_person_id == admin_id
    r = await client.post("/kiosk/timeclock/learning-link", headers=hdrs,
                          json={"serial": SERIAL, "person_id": str(pid)})
    assert r.status_code == 200 and r.json() == {"sent": True}


# ── email me the link ────────────────────────────────────────────────


async def test_learning_link_rate_limited(client, db, seeded_user, monkeypatch):
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    fixed = datetime.now(UTC).replace(second=5, microsecond=0)
    monkeypatch.setattr(emails, "_now", lambda: fixed)

    async def link(person_id):
        return await client.post("/kiosk/station/timeclock/learning-link", headers=_auth(key),
                                 json={"serial": SERIAL, "person_id": str(person_id)})

    r = await link(pid)
    assert r.status_code == 200 and r.json() == {"sent": True}
    r = await link(pid)
    assert r.status_code == 200 and r.json() == {"sent": False}     # same minute
    mails = list(await db.scalars(select(EmailOutbox).where(EmailOutbox.person_id == pid)))
    assert [m.template for m in mails] == ["learning_link"]

    monkeypatch.setattr(emails, "_now", lambda: fixed + timedelta(minutes=1))
    assert (await link(pid)).json() == {"sent": True}

    # nothing open, or nobody to email: nothing is sent
    idle = await _worker(db, "Ivy", "Idle", "ivy@test.example.com")
    assert (await link(idle.id)).json() == {"sent": False}
    ned = await _worker(db, "Ned", "Nomail", None)
    await _assign(db, ned.id, await _doc(db, "Dress code"), init)
    assert (await link(ned.id)).json() == {"sent": False}
