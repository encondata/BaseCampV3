"""Password expiry policy (To-Do #32): security-config keys, expiry math,
the sign-in gate, reuse history and the reminder sweep."""

from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.db.models import AuditLog

from tests.test_status_values_write import _make


async def _admin(db, client):
    return await _make(db, client, "super_admin", "pw-admin@test.example.com")


# ── config ──────────────────────────────────────────────────────────

async def test_security_config_carries_policy_defaults(client, db, seeded_user):
    hdrs = await _admin(db, client)
    body = (await client.get("/system/security", headers=hdrs)).json()
    assert body["password_expiry_enabled"] is False
    assert body["password_expiry_days"] == 90
    assert body["password_history_count"] == 3
    assert body["password_expiry_since"] is None


async def test_policy_ranges_are_enforced(client, db, seeded_user):
    hdrs = await _admin(db, client)
    for patch, code in [
        ({"password_expiry_days": 0}, "password_expiry_days_out_of_range"),
        ({"password_expiry_days": 366}, "password_expiry_days_out_of_range"),
        ({"password_history_count": -1}, "password_history_count_out_of_range"),
        ({"password_history_count": 25}, "password_history_count_out_of_range"),
    ]:
        resp = await client.put("/system/security", headers=hdrs, json=patch)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == code
    ok = await client.put("/system/security", headers=hdrs,
                          json={"password_expiry_days": 60, "password_history_count": 0})
    assert ok.status_code == 200, ok.text
    assert ok.json()["password_expiry_days"] == 60
    assert ok.json()["password_history_count"] == 0


async def test_since_cannot_be_set_through_the_api(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/security", headers=hdrs,
                            json={"password_expiry_since": "2020-01-01T00:00:00+00:00"})
    assert resp.status_code == 422, resp.text     # extra fields are forbidden
    body = (await client.get("/system/security", headers=hdrs)).json()
    assert body["password_expiry_since"] is None


async def test_enabling_stamps_since_and_disabling_clears_it(client, db, seeded_user):
    hdrs = await _admin(db, client)
    before = datetime.now(UTC)
    on = await client.put("/system/security", headers=hdrs, json={"password_expiry_enabled": True})
    assert on.status_code == 200, on.text
    since = datetime.fromisoformat(on.json()["password_expiry_since"])
    assert since >= before
    # a plain number change keeps the stamp
    again = await client.put("/system/security", headers=hdrs, json={"password_expiry_days": 30})
    assert again.json()["password_expiry_since"] == on.json()["password_expiry_since"]
    off = await client.put("/system/security", headers=hdrs, json={"password_expiry_enabled": False})
    assert off.json()["password_expiry_since"] is None
    back = await client.put("/system/security", headers=hdrs, json={"password_expiry_enabled": True})
    assert datetime.fromisoformat(back.json()["password_expiry_since"]) >= since
    rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "system", AuditLog.entity_id == "security")))
    assert rows and all(r.action == "security_config_update" for r in rows)
    assert "password_expiry_since" in rows[0].changes


# ── expiry math and history ─────────────────────────────────────────

from datetime import timedelta  # noqa: E402

from serversherpa.config import get_settings  # noqa: E402
from serversherpa.db.models import PasswordHistory, UserAccount  # noqa: E402
from serversherpa.security.passwords import verify_password  # noqa: E402
from serversherpa.services.password_policy import (  # noqa: E402
    HISTORY_KEEP, PasswordPolicy, PasswordReused, apply_password, assert_not_reused,
    change_reason, expires_at, load_policy,
)

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


def _account(**over) -> UserAccount:
    base = dict(password_hash="x", must_change_password=False,
                password_updated_at=NOW - timedelta(days=100))
    base.update(over)
    return UserAccount(**base)


def test_expiry_math():
    off = PasswordPolicy(enabled=False, days=90, history_count=3, since=None)
    assert expires_at(off, _account()) is None
    since = NOW - timedelta(days=10)
    on = PasswordPolicy(enabled=True, days=90, history_count=3, since=since)
    # the switch went on after the last change: the clock starts at the switch
    assert expires_at(on, _account()) == since + timedelta(days=90)
    # changed after the switch: the clock starts at the change
    fresh = _account(password_updated_at=NOW - timedelta(days=1))
    assert expires_at(on, fresh) == NOW - timedelta(days=1) + timedelta(days=90)
    # no password at all → nothing to expire
    assert expires_at(on, _account(password_hash=None)) is None
    # never-changed password (NULL timestamp) counts from the switch
    assert expires_at(on, _account(password_updated_at=None)) == since + timedelta(days=90)


def test_change_reason_precedence():
    on = PasswordPolicy(enabled=True, days=30, history_count=3,
                        since=NOW - timedelta(days=60))
    assert change_reason(on, _account(), NOW) == "expired"
    assert change_reason(on, _account(must_change_password=True), NOW) == "temporary"
    assert change_reason(on, _account(password_updated_at=NOW - timedelta(days=5)), NOW) is None
    off = PasswordPolicy(enabled=False, days=30, history_count=3, since=None)
    assert change_reason(off, _account(), NOW) is None


async def test_load_policy_reads_the_section(client, db, seeded_user):
    hdrs = await _admin(db, client)
    assert (await load_policy(db)).enabled is False
    await client.put("/system/security", headers=hdrs,
                     json={"password_expiry_enabled": True, "password_expiry_days": 45})
    db.expire_all()
    policy = await load_policy(db)
    assert policy.enabled is True and policy.days == 45 and policy.history_count == 3
    assert policy.since is not None and policy.since.tzinfo is not None


async def _account_set_before_now(db, person_id) -> UserAccount:
    """The seeded user's account with its password dated before NOW. The
    fixture stamps password_updated_at with the wall clock, and the first
    apply_password files the replaced password under that stamp; left as
    is, it sorts after every NOW-based rotation once the clock passes NOW."""
    account = await db.get(UserAccount, person_id)
    account.password_updated_at = NOW - timedelta(days=1)
    await db.flush()
    return account


async def test_apply_password_records_history_and_trims(db, seeded_user):
    account = await _account_set_before_now(db, seeded_user.id)
    pepper = get_settings().password_pepper.get_secret_value()
    for i in range(HISTORY_KEEP + 3):
        await apply_password(db, account, f"Rotation-{i:02d}-pw", must_change=False,
                             now=NOW + timedelta(minutes=i))
    await db.commit()
    rows = list(await db.scalars(
        select(PasswordHistory).where(PasswordHistory.person_id == seeded_user.id)
        .order_by(PasswordHistory.created_at.desc())))
    assert len(rows) == HISTORY_KEEP
    assert verify_password(rows[0].password_hash, f"Rotation-{HISTORY_KEEP + 2:02d}-pw", pepper=pepper)
    assert account.password_updated_at == NOW + timedelta(minutes=HISTORY_KEEP + 2)
    assert account.must_change_password is False
    assert verify_password(account.password_hash, f"Rotation-{HISTORY_KEEP + 2:02d}-pw", pepper=pepper)


async def test_first_change_keeps_the_password_being_replaced(db, seeded_user):
    account = await _account_set_before_now(db, seeded_user.id)
    pepper = get_settings().password_pepper.get_secret_value()
    await apply_password(db, account, "Second-pw-22", must_change=False, now=NOW)
    await db.commit()
    rows = list(await db.scalars(
        select(PasswordHistory).where(PasswordHistory.person_id == seeded_user.id)
        .order_by(PasswordHistory.created_at)))
    assert len(rows) == 2
    assert verify_password(rows[0].password_hash, "CorrectHorse9!", pepper=pepper)
    assert verify_password(rows[1].password_hash, "Second-pw-22", pepper=pepper)
    # the current password counts even before any history exists
    fresh = UserAccount(person_id=seeded_user.id, password_hash=account.password_hash)
    on = PasswordPolicy(enabled=True, days=90, history_count=1, since=NOW)
    try:
        await assert_not_reused(db, on, fresh, "Second-pw-22")
    except PasswordReused:
        pass
    else:
        raise AssertionError("the current password must count as recently used")


async def test_assert_not_reused_checks_only_the_last_n(db, seeded_user):
    account = await _account_set_before_now(db, seeded_user.id)
    for i in range(4):
        await apply_password(db, account, f"Old-pw-{i}", must_change=False,
                             now=NOW + timedelta(minutes=i))
    await db.commit()
    on = PasswordPolicy(enabled=True, days=90, history_count=3, since=NOW)
    for recent in ("Old-pw-1", "Old-pw-2", "Old-pw-3"):
        try:
            await assert_not_reused(db, on, account, recent)
        except PasswordReused as exc:
            assert exc.count == 3
        else:
            raise AssertionError(f"{recent} should have been refused")
    await assert_not_reused(db, on, account, "Old-pw-0")      # older than the window
    await assert_not_reused(db, on, account, "CorrectHorse9!")  # kept at the first change, older still
    await assert_not_reused(db, on, account, "Brand-new-pw")
    off = PasswordPolicy(enabled=False, days=90, history_count=3, since=None)
    await assert_not_reused(db, off, account, "Old-pw-3")
    zero = PasswordPolicy(enabled=True, days=90, history_count=0, since=NOW)
    await assert_not_reused(db, zero, account, "Old-pw-3")


# ── reuse at every intake ───────────────────────────────────────────

from serversherpa.db.models import Person, PersonRole  # noqa: E402
from tests.test_sites_api import login, make_login  # noqa: E402


async def _enable_policy(client, db, **over):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/security", headers=hdrs,
                            json={"password_expiry_enabled": True, **over})
    assert resp.status_code == 200, resp.text
    return hdrs


async def _change(client, hdrs, current, new):
    return await client.post("/auth/me/password", headers=hdrs,
                             json={"current_password": current, "new_password": new})


async def test_self_change_refuses_a_recent_password(client, db, seeded_user):
    await _enable_policy(client, db)
    hdrs = await login(client)
    assert (await _change(client, hdrs, "CorrectHorse9!", "Second-pw-22")).status_code == 204
    hdrs = await login(client, pw="Second-pw-22")
    assert (await _change(client, hdrs, "Second-pw-22", "Third-pw-333")).status_code == 204
    hdrs = await login(client, pw="Third-pw-333")
    back = await _change(client, hdrs, "Third-pw-333", "CorrectHorse9!")
    assert back.status_code == 422, back.text
    assert back.json()["detail"] == {"code": "password_recently_used", "count": 3}
    # the current one still reads as same_as_current, not reuse
    same = await _change(client, hdrs, "Third-pw-333", "Third-pw-333")
    assert same.json()["detail"]["code"] == "same_as_current"


async def test_reuse_is_not_checked_when_off_or_zero(client, db, seeded_user):
    hdrs = await login(client)
    assert (await _change(client, hdrs, "CorrectHorse9!", "Second-pw-22")).status_code == 204
    hdrs = await login(client, pw="Second-pw-22")
    assert (await _change(client, hdrs, "Second-pw-22", "CorrectHorse9!")).status_code == 204
    await _enable_policy(client, db, password_history_count=0)
    hdrs = await login(client)
    assert (await _change(client, hdrs, "CorrectHorse9!", "Second-pw-22")).status_code == 204


async def test_admin_reset_refuses_a_recent_password(client, db, seeded_user):
    admin = await _enable_policy(client, db)
    resp = await client.post(f"/users/{seeded_user.id}/reset-password", headers=admin,
                             json={"temp_password": "CorrectHorse9!"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "password_recently_used"
    refused = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "user_account", AuditLog.entity_id == str(seeded_user.id),
        AuditLog.action == "password.reset_refused")))
    assert len(refused) == 1
    assert refused[0].changes == {"reason": "password_recently_used"}
    ok = await client.post(f"/users/{seeded_user.id}/reset-password", headers=admin,
                           json={"temp_password": "Temp-pw-9999"})
    assert ok.status_code == 204, ok.text
    rows = list(await db.scalars(select(PasswordHistory).where(
        PasswordHistory.person_id == seeded_user.id)))
    assert len(rows) == 2   # the replaced password (kept at the first change) + the reset


async def test_new_accounts_record_history_without_a_check(client, db, seeded_user):
    admin = await _enable_policy(client, db)
    contact = Person(first_name="New", last_name="Contact", email="newc-pw@test.example.com")
    db.add(contact)
    await db.commit()
    resp = await client.post(f"/users/{contact.id}/account", headers=admin, json={
        "login_email": "newc-pw@test.example.com", "temp_password": "Temp-pw-9999",
        "must_change_password": True})
    assert resp.status_code in (200, 201), resp.text
    rows = list(await db.scalars(select(PasswordHistory).where(
        PasswordHistory.person_id == contact.id)))
    assert len(rows) == 1


async def test_new_user_with_account_records_one_history_row(client, db, seeded_user):
    admin = await _enable_policy(client, db)
    resp = await client.post("/users", headers=admin, json={
        "first_name": "Hank", "last_name": "History", "roles": ["worker"],
        "create_account": True, "login_email": "hank-pw@test.example.com",
        "temp_password": "Temp-pw-9999", "must_change_password": True})
    assert resp.status_code == 201, resp.text
    account = await db.scalar(select(UserAccount).where(
        UserAccount.email == "hank-pw@test.example.com"))
    assert account is not None
    rows = list(await db.scalars(select(PasswordHistory).where(
        PasswordHistory.person_id == account.person_id)))
    assert len(rows) == 1
    assert rows[0].password_hash == account.password_hash


# ── the sign-in gate ────────────────────────────────────────────────

from sqlalchemy import update  # noqa: E402


async def _backdate(db, person_id, *, days):
    await db.execute(update(UserAccount).where(UserAccount.person_id == person_id)
                     .values(password_updated_at=datetime.now(UTC) - timedelta(days=days)))
    await db.commit()


async def _backdate_since(db, *, days):
    from serversherpa.db.models import SystemConfig
    row = await db.get(SystemConfig, "security")
    row.data = {**row.data,
                "password_expiry_since": (datetime.now(UTC) - timedelta(days=days)).isoformat()}
    await db.commit()


async def test_expired_password_forces_a_change_at_sign_in(client, db, seeded_user):
    await _enable_policy(client, db, password_expiry_days=30)
    await _backdate(db, seeded_user.id, days=100)
    # the switch went on just now: the clock starts today, so alice is fine
    resp = await client.post("/auth/login", json={"email": "alice@test.example.com",
                                                  "password": "CorrectHorse9!"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["must_change_password"] is False
    assert resp.json()["must_change_reason"] is None
    assert resp.json()["password_expires_at"] is not None
    # …until the switch itself is older than the window
    await _backdate_since(db, days=31)
    resp = await client.post("/auth/login", json={"email": "alice@test.example.com",
                                                  "password": "CorrectHorse9!"})
    body = resp.json()
    assert body["must_change_password"] is True
    assert body["must_change_reason"] == "expired"
    hdrs = {"Authorization": f"Bearer {body['access_token']}"}
    me = (await client.get("/auth/me", headers=hdrs)).json()
    assert me["must_change_password"] is True and me["must_change_reason"] == "expired"
    refreshed = await client.post("/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["must_change_reason"] == "expired"
    # changing the password clears it
    change = await _change(client, hdrs, "CorrectHorse9!", "Fresh-pw-2026")
    assert change.status_code == 204, change.text
    me = (await client.get("/auth/me", headers=hdrs)).json()
    assert me["must_change_password"] is False and me["must_change_reason"] is None


async def test_policy_off_means_nothing_expires(client, db, seeded_user):
    await _backdate(db, seeded_user.id, days=400)
    resp = await client.post("/auth/login", json={"email": "alice@test.example.com",
                                                  "password": "CorrectHorse9!"})
    assert resp.json()["must_change_password"] is False
    assert resp.json()["password_expires_at"] is None


async def test_temporary_wins_over_expired(client, db, seeded_user):
    await _enable_policy(client, db, password_expiry_days=1)
    await _backdate_since(db, days=2)
    await db.execute(update(UserAccount).where(UserAccount.person_id == seeded_user.id)
                     .values(must_change_password=True))
    await db.commit()
    resp = await client.post("/auth/login", json={"email": "alice@test.example.com",
                                                  "password": "CorrectHorse9!"})
    assert resp.json()["must_change_reason"] == "temporary"


async def test_kiosk_login_reports_expiry_too(client, db, seeded_user):
    worker = Person(first_name="Kay", last_name="Kiosk", email="kay-pw@test.example.com")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()
    await make_login(db, client, worker, "kay-pw@test.example.com")
    await _enable_policy(client, db, password_expiry_days=1)
    await _backdate_since(db, days=2)
    await _backdate(db, worker.id, days=5)
    resp = await client.post("/auth/login", json={
        "email": "kay-pw@test.example.com", "password": "CorrectHorse9!", "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["must_change_password"] is True
    assert resp.json()["must_change_reason"] == "expired"


async def test_kiosk_pairing_session_reports_expiry_too(client, db, seeded_user):
    from tests.test_kiosk_pairing_api import _create, _poll

    await _enable_policy(client, db, password_expiry_days=1)
    await _backdate_since(db, days=2)
    await _backdate(db, seeded_user.id, days=5)
    d = await _create(client)
    hdrs = await login(client)            # alice, expired — approving is exempt
    approve = await client.post(f"/kiosk/pair/{d['code']}/approve", headers=hdrs)
    assert approve.status_code == 204, approve.text
    resp = await _poll(client, d)
    assert resp.status_code == 200, resp.text
    session = resp.json()["session"]
    assert session["must_change_password"] is True
    assert session["must_change_reason"] == "expired"


# ── the API gate ────────────────────────────────────────────────────
# The sign-in response only reports expiry; these prove the API itself
# holds a session that signed in with an expired password to the
# change-password routes, anchored to the session's sign-in time.

from serversherpa.db.models import AuthSession  # noqa: E402


async def _backdate_since_by(db, delta: timedelta):
    from serversherpa.db.models import SystemConfig
    row = await db.get(SystemConfig, "security")
    row.data = {**row.data,
                "password_expiry_since": (datetime.now(UTC) - delta).isoformat()}
    await db.commit()


async def _signed_in_ago(db, person_id, delta: timedelta):
    """Move this person's sessions so they read as signed in `delta` ago.
    The gate recovers the sign-in time as expires_at - session_ttl, so
    shifting the absolute deadline shifts the sign-in time with it (and
    the session stays live as long as delta < session_ttl)."""
    ttl = timedelta(seconds=get_settings().session_ttl_seconds)
    assert delta < ttl
    await db.execute(update(AuthSession).where(AuthSession.person_id == person_id)
                     .values(expires_at=datetime.now(UTC) - delta + ttl))
    await db.commit()


def _bearer(body):
    return {"Authorization": f"Bearer {body['access_token']}"}


async def test_expired_session_is_refused_by_the_api(client, db, seeded_user):
    await _enable_policy(client, db, password_expiry_days=1)
    await _backdate_since(db, days=2)
    await _backdate(db, seeded_user.id, days=5)
    resp = await client.post("/auth/login", json={"email": "alice@test.example.com",
                                                  "password": "CorrectHorse9!"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["must_change_reason"] == "expired"
    hdrs = _bearer(body)
    # non-exempt routes are refused
    for path in ("/auth/me/activity", "/auth/me/profile"):
        blocked = await client.get(path, headers=hdrs)
        assert blocked.status_code == 403, (path, blocked.text)
        assert blocked.json()["detail"] == {"code": "password_change_required"}
    # a refreshed token inherits the sign-in time, so it is refused too
    refreshed = await client.post("/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    hdrs = _bearer(refreshed.json())
    assert (await client.get("/auth/me/activity", headers=hdrs)).status_code == 403
    # the exempt routes still work
    assert (await client.get("/auth/me", headers=hdrs)).status_code == 200
    assert (await client.get("/auth/me/sessions", headers=hdrs)).status_code == 200
    change = await _change(client, hdrs, "CorrectHorse9!", "Fresh-pw-2026")
    assert change.status_code == 204, change.text
    # the change lifts the block at once, inside the same session
    assert (await client.get("/auth/me/activity", headers=hdrs)).status_code == 200


async def test_session_that_started_before_expiry_keeps_working(client, db, seeded_user):
    ttl_hours = get_settings().session_ttl_seconds / 3600
    assert ttl_hours > 13                       # the numbers below need a 13 h+ session
    hdrs = await login(client)                  # policy off: nothing owed
    await _enable_policy(client, db, password_expiry_days=1)
    await _backdate(db, seeded_user.id, days=5)  # expiry now runs from `since`
    # alice's session signed in 12 h ago
    await _signed_in_ago(db, seeded_user.id, timedelta(hours=12))
    # since = now - 1 d 11 h → password expires at since + 1 d = now - 11 h:
    # expired now, but AFTER this session signed in (now - 12 h) → allowed
    await _backdate_since_by(db, timedelta(days=1, hours=11))
    ok = await client.get("/auth/me/activity", headers=hdrs)
    assert ok.status_code == 200, ok.text
    # since = now - 1 d 13 h → expires at now - 13 h, before the sign-in
    # at now - 12 h → this session signed in with an expired password
    await _backdate_since_by(db, timedelta(days=1, hours=13))
    refused = await client.get("/auth/me/activity", headers=hdrs)
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"] == {"code": "password_change_required"}
    # and turning the policy off lifts it (written directly: the back-dated
    # `since` has expired the admin's own password too)
    await _set_policy_direct(db, enabled=False, since=None)
    assert (await client.get("/auth/me/activity", headers=hdrs)).status_code == 200


async def test_websocket_log_tail_refuses_expired_session(client, db, seeded_user):
    """The log-tail WS authenticates outside get_current_user, so it
    applies the same rule: a session that signed in with an expired
    password closes 4403, while the same person's session that signed in
    before the password expired still streams."""
    dev = Person(first_name="Dev", last_name="Expired")
    db.add(dev)
    await db.flush()
    db.add(PersonRole(person_id=dev.id, role="developer"))
    await db.commit()
    early = await make_login(db, client, dev, "dev-pw@test.example.com")
    early_token = early["Authorization"].removeprefix("Bearer ")
    await _enable_policy(client, db, password_expiry_days=1)
    await _backdate(db, dev.id, days=5)
    await _signed_in_ago(db, dev.id, timedelta(hours=12))     # the early session
    await _backdate_since_by(db, timedelta(days=1, hours=11))  # expired at now - 11 h
    late = await client.post("/auth/login", json={"email": "dev-pw@test.example.com",
                                                  "password": "CorrectHorse9!"})
    assert late.json()["must_change_reason"] == "expired"
    late_token = late.json()["access_token"]

    from serversherpa.db.engine import dispose_engine
    await db.close()
    await dispose_engine()

    import pytest
    from sqlalchemy import create_engine
    from sqlalchemy import text as sql_text
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from serversherpa.api.app import create_app

    sync = create_engine(get_settings().sync_database_url)
    with TestClient(create_app()) as tc:
        with (pytest.raises(WebSocketDisconnect) as exc,
              tc.websocket_connect("/system/processes/api/logs/stream",
                                   subprotocols=["ss-bearer", late_token]) as ws):
            ws.receive_json()
        assert exc.value.code == 4403
        # control: the session that signed in before expiry still streams
        with tc.websocket_connect(
                "/system/processes/api/logs/stream",
                subprotocols=["ss-bearer", early_token]) as ws:
            with sync.begin() as conn:
                conn.execute(sql_text(
                    "INSERT INTO log_entries (process, level, levelno, logger, message) "
                    "VALUES ('api', 'INFO', 20, 't', 'still streaming')"))
            msg = ws.receive_json()
            while "entries" not in msg:
                msg = ws.receive_json()
            assert [e["message"] for e in msg["entries"]] == ["still streaming"]
    sync.dispose()


# ── reminders ───────────────────────────────────────────────────────

from serversherpa.db.models import Notification  # noqa: E402
from serversherpa.notifications.password_reminders import (  # noqa: E402
    KIND, run_password_reminders, run_reminders_once,
)


async def _set_policy_direct(db, *, enabled=True, days=90, since):
    from serversherpa.db.models import SystemConfig
    row = await db.get(SystemConfig, "security")
    data = dict(row.data) if row else {}
    data.update({"password_expiry_enabled": enabled, "password_expiry_days": days,
                 "password_history_count": 3,
                 "password_expiry_since": since.isoformat() if since else None})
    if row is None:
        db.add(SystemConfig(section="security", data=data))
    else:
        row.data = data
    await db.commit()


async def _reminders(db, person_id):
    return list(await db.scalars(select(Notification).where(
        Notification.person_id == person_id, Notification.kind == KIND)
        .order_by(Notification.created_at)))


async def _sweep(db):
    """Run a reminder sweep with `now` sampled fresh, after whatever
    fixture arrangement just ran — never a `now` captured earlier, which
    can land a hair past a whole-day boundary and throw off ceil()."""
    return await run_password_reminders(db, datetime.now(UTC))


async def _with_days_left(db, person_id, days_left: float, *, policy_days=90):
    """Arrange the policy so the seeded user's password expires `days_left`
    days from now (fractional allowed)."""
    since = datetime.now(UTC) - timedelta(days=policy_days) + timedelta(days=days_left)
    await _set_policy_direct(db, days=policy_days, since=since)
    await db.execute(update(UserAccount).where(UserAccount.person_id == person_id)
                     .values(password_updated_at=since - timedelta(days=1)))
    await db.commit()


async def test_reminders_fire_once_per_stage(db, seeded_user):
    await _set_policy_direct(db, enabled=False, since=None)
    assert await _sweep(db) == 0
    await _with_days_left(db, seeded_user.id, 10)
    assert await _sweep(db) == 0
    await _with_days_left(db, seeded_user.id, 6)
    assert await _sweep(db) == 1
    assert await _sweep(db) == 0          # dedup
    rows = await _reminders(db, seeded_user.id)
    assert rows[0].payload["stage"] == 7 and rows[0].payload["days_left"] == 6
    assert rows[0].title == "Your password expires in 6 days"
    assert rows[0].link == "/me"
    assert "before" in rows[0].body and "My Profile" in rows[0].body
    await _with_days_left(db, seeded_user.id, 2.5)
    assert await _sweep(db) == 1
    await _with_days_left(db, seeded_user.id, 0.5)
    assert await _sweep(db) == 1
    rows = await _reminders(db, seeded_user.id)
    assert [r.payload["stage"] for r in rows] == [7, 3, 1]
    assert rows[-1].title == "Your password expires in 1 day"
    await _with_days_left(db, seeded_user.id, -1)
    assert await _sweep(db) == 0          # expired: the gate handles it


async def test_reminders_skip_disabled_accounts_and_jump_to_the_urgent_stage(db, seeded_user):
    now = datetime.now(UTC)
    other = Person(first_name="Dee", last_name="Disabled", email="dee-pw@test.example.com")
    db.add(other)
    await db.flush()
    db.add(UserAccount(person_id=other.id, email="dee-pw@test.example.com",
                       password_hash="x", disabled_at=now))
    await db.commit()
    await _with_days_left(db, seeded_user.id, 2)     # inside the 7- and 3-day windows at once
    await db.execute(update(UserAccount).where(UserAccount.person_id == other.id)
                     .values(password_updated_at=datetime.now(UTC) - timedelta(days=200)))
    await db.commit()
    assert await _sweep(db) == 1
    rows = await _reminders(db, seeded_user.id)
    assert [r.payload["stage"] for r in rows] == [3]
    assert await _reminders(db, other.id) == []


async def test_reminders_skip_accounts_on_a_temporary_password(db, seeded_user):
    await _with_days_left(db, seeded_user.id, 2)
    await db.execute(update(UserAccount).where(UserAccount.person_id == seeded_user.id)
                     .values(must_change_password=True))
    await db.commit()
    assert await _sweep(db) == 0
    assert await _reminders(db, seeded_user.id) == []
    # control: the same account without the temporary flag is reminded
    await db.execute(update(UserAccount).where(UserAccount.person_id == seeded_user.id)
                     .values(must_change_password=False))
    await db.commit()
    assert await _sweep(db) == 1


async def test_run_reminders_once_swallows_errors(db, seeded_user, caplog, monkeypatch):
    import logging

    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.notifications import password_reminders

    async def boom(*_a, **_k):
        raise RuntimeError("db is on fire")

    monkeypatch.setattr(password_reminders, "run_password_reminders", boom)
    caplog.set_level(logging.ERROR, logger="serversherpa.notifications.password_reminders")
    assert await run_reminders_once(get_sessionmaker()) == 0
    assert "db is on fire" in caplog.text
