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


async def test_apply_password_records_history_and_trims(db, seeded_user):
    account = await db.get(UserAccount, seeded_user.id)
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
    account = await db.get(UserAccount, seeded_user.id)
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
    account = await db.get(UserAccount, seeded_user.id)
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
