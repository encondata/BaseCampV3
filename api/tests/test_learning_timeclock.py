"""Learning at the time clock: the `learning` block on the station's status
(open assignments for the station's move, or the general set without one),
"Email me the link", the admin override (an admin's email + password + 2FA
checked at the shared station without opening a session) and the punch it
links to. Punches are never blocked on learning."""
import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text

from serversherpa.api.routes import kiosk as kiosk_routes
from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog,
    AuthSession,
    Device,
    EmailOutbox,
    Person,
    PersonRole,
    Site,
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
BAD = "override_credentials_invalid"


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


async def test_status_survives_a_sql_error_in_learning(client, db, seeded_user, monkeypatch):
    """A real database error inside `outstanding()` rolls back only the
    savepoint: the rest of the status read (today's hours) still runs on
    the same session."""
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)

    async def broken(db, *args, **kwargs):
        await db.execute(text("SELECT * FROM no_such_learning_table"))

    monkeypatch.setattr(learning_timeclock, "day_override_covers", broken)
    r = await _status(client, key, pid)
    assert r.status_code == 200, r.text
    assert r.json()["learning"] is None
    assert r.json()["today_minutes"] == 0
    hdrs = await login(client)
    r = await client.get(f"/kiosk/timeclock/{pid}", headers=hdrs, params={"serial": SERIAL})
    assert r.status_code == 200, r.text
    assert r.json()["learning"] is None


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


async def test_override_bad_password_403_counts_lockout(client, db, seeded_user):
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    admin_id, email = await _account(db)

    def refused(r):
        return r.status_code == 403 and r.json()["detail"]["code"] == BAD

    assert refused(await _override(client, key, pid, "nobody@test.example.com"))
    assert refused(await _override(client, key, pid, email, "wrong-password"))
    assert (await _account_row(db, admin_id)).failed_login_count == 1

    for _ in range(get_settings().max_failed_logins - 1):
        assert refused(await _override(client, key, pid, email, "wrong-password"))
    account = await _account_row(db, admin_id)
    locked_until = account.locked_until
    assert locked_until is not None and locked_until > datetime.now(UTC)
    # locked: the right password answers exactly like a wrong one, and is
    # never another strike
    assert refused(await _override(client, key, pid, email))
    assert refused(await _override(client, key, pid, email, "wrong-password"))
    account = await _account_row(db, admin_id)
    assert (account.failed_login_count, account.locked_until) == (0, locked_until)
    assert await _overrides(db) == []
    assert await _sessions(db, admin_id) == 0

    # a disabled account answers the same
    other_id, other = await _account(db)
    (await _account_row(db, other_id)).disabled_at = datetime.now(UTC)
    await db.commit()
    assert refused(await _override(client, key, pid, other))
    assert await _overrides(db) == []


async def test_override_guesses_rate_limited(client, db, seeded_user, monkeypatch):
    """Refused guesses are capped per kiosk device and per client address
    (429 `rate_limited`, before any check); a real override never counts."""
    device, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    admin_id, email = await _account(db)
    monkeypatch.setattr(kiosk_routes.override_limiter, "limit", 2)

    assert (await _override(client, key, pid, email)).status_code == 200      # not counted
    for _ in range(2):
        assert (await _override(client, key, pid, email, "wrong")).status_code == 403
    r = await _override(client, key, pid, email)
    assert r.status_code == 429 and r.json()["detail"]["code"] == "rate_limited"
    # refused before the password check: no strike past the two
    assert (await _account_row(db, admin_id)).failed_login_count == 2

    # the device's bucket alone: another address at this kiosk is still capped
    kiosk_routes.override_limiter.reset()
    for _ in range(2):
        kiosk_routes.override_limiter.hit(f"device:{device.id}")
    r = await _override(client, key, pid, email)
    assert r.status_code == 429
    # the address alone
    kiosk_routes.override_limiter.reset()
    for _ in range(2):
        kiosk_routes.override_limiter.hit("127.0.0.1")
    r = await _override(client, key, pid, email)
    assert r.status_code == 429


async def test_override_concurrent_guesses_reserve_slots(client, db, seeded_user,
                                                         monkeypatch):
    """Slots are reserved before the credentials are checked, so N wrong
    guesses at once let exactly `limit` through to verify_admin; a success
    gives its slot back."""
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    _, email = await _account(db)
    limiter = kiosk_routes.override_limiter
    monkeypatch.setattr(limiter, "limit", 2)
    calls = 0
    real = learning_timeclock.verify_admin

    async def counting(*args, **kwargs):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)          # let the others pile up meanwhile
        return await real(*args, **kwargs)

    monkeypatch.setattr(learning_timeclock, "verify_admin", counting)
    results = await asyncio.gather(*[_override(client, key, pid, email, "wrong")
                                     for _ in range(5)])
    codes = sorted(r.status_code for r in results)
    assert codes == [403, 403, 429, 429, 429]
    assert calls == 2

    # a success never keeps its slot
    limiter.reset()
    monkeypatch.setattr(limiter, "limit", 1)
    for _ in range(3):
        assert (await _override(client, key, pid, email)).status_code == 200
    assert (await _override(client, key, pid, email, "wrong")).status_code == 403
    assert (await _override(client, key, pid, email)).status_code == 429


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
    assert r.status_code == 403 and r.json()["detail"]["code"] == "totp_required"
    assert (await _account_row(db, admin_id)).failed_login_count == 0
    # a wrong password never learns that 2FA is on
    r = await _override(client, key, pid, email, "wrong-password")
    assert r.status_code == 403 and r.json()["detail"]["code"] == BAD

    r = await _override(client, key, pid, email, totp_code="000000")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "totp_invalid"

    code = _next_code(secret)
    r = await _override(client, key, pid, email, totp_code=code)
    assert r.status_code == 200, r.text
    account = await _account_row(db, admin_id)
    assert account.failed_login_count == 0
    # the replay guard: the same code twice is refused
    r = await _override(client, key, pid, email, totp_code=code)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "totp_invalid"
    assert len(await _overrides(db)) == 1
    assert await _sessions(db, admin_id) == 0

    # required by policy but never enrolled: the station can't enroll them
    other_id, other = await _account(db)
    (await _account_row(db, other_id)).totp_required = True
    await db.commit()
    r = await _override(client, key, pid, other)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "totp_enroll_required"


async def test_override_other_needs_text(client, db, seeded_user):
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    admin_id, email = await _account(db)
    for note in (None, "", "   "):
        extra = {"reason": "other"} if note is None else {"reason": "other", "reason_text": note}
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

    async def clock_out(person_id):
        r = await client.post("/kiosk/station/timeclock/clock-out", headers=_auth(key),
                              json={"serial": SERIAL, "person_id": str(person_id)})
        assert r.status_code == 200, r.text

    async def punch_audit(entry_id):
        return await db.scalar(select(AuditLog).where(
            AuditLog.action == "kiosk_clock_in", AuditLog.entity_id == entry_id)
            .execution_options(populate_existing=True))

    async def rejected_punch(person_id, oid):
        """The punch goes ahead; the id is only recorded."""
        r = await clock_in(person_id, oid)
        assert r.status_code == 200, r.text
        log = await punch_audit(r.json()["entry"]["id"])
        assert log.changes["learning_override_rejected"] == str(oid)
        assert "learning_override_id" not in log.changes
        await clock_out(person_id)

    # someone else's override, an unknown id, a malformed one
    stranger = await _worker(db, "Sam", "Stranger", None)
    await rejected_punch(stranger.id, override_id)
    await rejected_punch(pid, str(uuid.uuid4()))
    await rejected_punch(pid, "not-a-uuid")
    await rejected_punch(pid, 5)                        # not even a string: never a 422
    [row] = await _overrides(db)
    assert row.time_entry_id is None

    r = await clock_in(pid, override_id)
    assert r.status_code == 200, r.text
    entry_id = r.json()["entry"]["id"]
    [row] = await _overrides(db)
    assert str(row.time_entry_id) == entry_id
    log = await punch_audit(entry_id)
    assert log.changes["learning_override_id"] == override_id
    assert "learning_override_rejected" not in log.changes
    await clock_out(pid)

    # one punch per override: a reuse punches, unlinked
    await rejected_punch(pid, override_id)
    [row] = await _overrides(db)
    assert str(row.time_entry_id) == entry_id

    # an override from another day
    other_id = (await _override(client, key, pid, email)).json()["override_id"]
    stale = await db.get(LearningOverride, uuid.UUID(other_id))
    stale.local_day = stale.local_day - timedelta(days=1)
    await db.commit()
    await rejected_punch(pid, other_id)
    assert (await db.get(LearningOverride, uuid.UUID(other_id))).time_entry_id is None


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

    async def link(person_id, **extra):
        return await client.post("/kiosk/station/timeclock/learning-link", headers=_auth(key),
                                 json={"serial": SERIAL, "person_id": str(person_id), **extra})

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


async def test_learning_link_only_when_the_station_would_warn(client, db, seeded_user):
    """Only open items in the station's scope count: another move's or a
    "day" override's covered person gets nothing."""
    _, init, key = await _timeclock_station(db)
    other = await _initiative(db, "Some other move")
    elsewhere = await _worker(db, "Otto", "Other", "otto@test.example.com")
    await _assign(db, elsewhere.id, await _doc(db, "Other move rules"), other)
    pid = await _owing(db, init)
    _, email = await _account(db)

    async def link(person_id, **extra):
        return await client.post("/kiosk/station/timeclock/learning-link", headers=_auth(key),
                                 json={"serial": SERIAL, "person_id": str(person_id), **extra})

    assert (await link(elsewhere.id)).json() == {"sent": False}
    zone = _just_past_midnight_zone()
    r = await _override(client, key, pid, email, scope="day", tz=zone)
    assert r.status_code == 200, r.text
    assert (await link(pid, tz=zone)).json() == {"sent": False}
    mails = await db.scalar(select(func.count()).select_from(EmailOutbox))
    assert mails == 0


async def test_learning_link_cap_counts_only_sends(client, db, seeded_user, monkeypatch):
    """A shift change of people with nothing outstanding never trips the
    per-kiosk cap; only emails actually sent count."""
    _, init, key = await _timeclock_station(db)
    pid = await _owing(db, init)
    fixed = datetime.now(UTC).replace(second=5, microsecond=0)
    monkeypatch.setattr(emails, "_now", lambda: fixed)
    monkeypatch.setattr(kiosk_routes.learning_link_limiter, "limit", 2)

    async def link(person_id):
        return await client.post("/kiosk/station/timeclock/learning-link", headers=_auth(key),
                                 json={"serial": SERIAL, "person_id": str(person_id)})

    idle = await _worker(db, "Ivy", "Idle", "ivy@test.example.com")
    for _ in range(3):
        r = await link(idle.id)
        assert r.status_code == 200 and r.json() == {"sent": False}
    assert (await link(pid)).json() == {"sent": True}                 # 1 of 2
    # the same minute again: nothing sent, so nothing counted
    assert (await link(pid)).json() == {"sent": False}
    monkeypatch.setattr(emails, "_now", lambda: fixed + timedelta(minutes=1))
    assert (await link(pid)).json() == {"sent": True}                 # 2 of 2
    monkeypatch.setattr(emails, "_now", lambda: fixed + timedelta(minutes=2))
    r = await link(pid)
    assert r.status_code == 429 and r.json()["detail"]["code"] == "rate_limited"
