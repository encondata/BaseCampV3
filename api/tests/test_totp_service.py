"""services/totp: secrets at rest, policy resolver, code verification with
replay guard, backup codes, trusted browsers, challenge tokens."""

import uuid
from datetime import UTC, datetime, timedelta

import pyotp
import pytest
from sqlalchemy import select, update

from serversherpa.db.models import (
    AccessGroup,
    AccessGroupMember,
    PersonRole,
    Role,
    SystemConfig,
    TrustedDevice,
    UserAccount,
)
from serversherpa.security.tokens import TokenError
from serversherpa.services import totp
from serversherpa.services.auth import AuthError


async def _account(db, person):
    return await db.get(UserAccount, person.id)


async def _set_security(db, **flags):
    row = await db.get(SystemConfig, "security")
    if row is None:
        row = SystemConfig(section="security", data={})
        db.add(row)
    row.data = {"two_factor_enabled": False, "two_factor_required": False, **flags}
    await db.commit()


async def _enroll(db, account):
    secret, _uri = await totp.begin_enrollment(db, account, actor_id=account.person_id, ip=None)
    codes = await totp.confirm_enrollment(
        db, account, pyotp.TOTP(secret).now(), actor_id=account.person_id, ip=None)
    return secret, codes


def test_secret_round_trip():
    blob = totp.encrypt_secret("JBSWY3DPEHPK3PXP")
    assert blob != b"JBSWY3DPEHPK3PXP"
    assert totp.decrypt_secret(blob) == "JBSWY3DPEHPK3PXP"


def test_challenge_token_round_trip_and_purpose():
    pid = uuid.uuid4()
    tok = totp.make_challenge_token(pid, "verify")
    assert totp.decode_challenge_token(tok) == (pid, "verify")
    with pytest.raises(TokenError):
        totp.decode_challenge_token(tok + "x")


def test_format_backup_code():
    assert totp.format_backup_code("abcdefghjk") == "abcde-fghjk"


async def test_policy_master_switch_off_means_nothing(db, seeded_user):
    account = await _account(db, seeded_user)
    account.totp_required = True
    await db.commit()
    await _set_security(db, two_factor_enabled=False)
    assert await totp.policy_for(db, account) == totp.TotpPolicy(enabled=False, required=False)


async def test_policy_each_or_branch(db, seeded_user):
    account = await _account(db, seeded_user)
    await _set_security(db, two_factor_enabled=True)
    assert (await totp.policy_for(db, account)).required is False

    await _set_security(db, two_factor_enabled=True, two_factor_required=True)
    assert (await totp.policy_for(db, account)).required is True
    await _set_security(db, two_factor_enabled=True)

    account.totp_required = True
    await db.commit()
    assert (await totp.policy_for(db, account)).required is True
    account.totp_required = False
    await db.commit()

    group = AccessGroup(name="Finance", totp_required=True)
    db.add(group)
    await db.flush()
    db.add(AccessGroupMember(group_id=group.id, person_id=seeded_user.id))
    await db.commit()
    assert (await totp.policy_for(db, account)).required is True
    group.totp_required = False
    await db.commit()
    assert (await totp.policy_for(db, account)).required is False

    role = await db.get(Role, "staff")
    role.totp_required = True
    await db.commit()
    assert (await totp.policy_for(db, account)).required is True
    # a revoked grant does not count
    await db.execute(update(PersonRole).where(PersonRole.person_id == seeded_user.id)
                     .values(revoked_at=datetime.now(UTC)))
    await db.commit()
    assert (await totp.policy_for(db, account)).required is False
    # roles are seed data that survives between tests (clean_db only drops
    # non-system rows) — restore the flag so a later run starts clean
    role.totp_required = False
    await db.commit()


async def test_enroll_confirm_and_verify(db, seeded_user):
    account = await _account(db, seeded_user)
    secret, uri = await totp.begin_enrollment(db, account, actor_id=account.person_id, ip=None)
    assert uri.startswith("otpauth://totp/ServerSherpa:alice%40test.example.com?")
    assert "issuer=ServerSherpa" in uri
    assert account.totp_confirmed_at is None and account.totp_secret_enc is not None

    with pytest.raises(AuthError) as exc:
        await totp.confirm_enrollment(db, account, "000000", actor_id=account.person_id, ip=None)
    assert exc.value.code == "totp_invalid"
    assert account.totp_confirmed_at is None

    codes = await totp.confirm_enrollment(
        db, account, pyotp.TOTP(secret).now(), actor_id=account.person_id, ip=None)
    assert len(codes) == 8 and all(len(c) == 11 and c[5] == "-" for c in codes)
    assert account.totp_confirmed_at is not None
    assert await totp.backup_codes_remaining(db, account.person_id) == 8

    # the confirm code itself is now a replay
    with pytest.raises(AuthError):
        await totp.verify_code(db, account, pyotp.TOTP(secret).now(), ip=None)
    # a code from the next step verifies (drift window)
    nxt = pyotp.TOTP(secret).at(datetime.now(UTC) + timedelta(seconds=30))
    assert await totp.verify_code(db, account, nxt, ip=None) == "totp"


async def test_begin_enrollment_refuses_confirmed_account(db, seeded_user):
    account = await _account(db, seeded_user)
    await _enroll(db, account)
    with pytest.raises(AuthError) as exc:
        await totp.begin_enrollment(db, account, actor_id=account.person_id, ip=None)
    assert exc.value.code == "totp_already_enrolled"


async def test_backup_code_single_use_and_regenerate(db, seeded_user):
    account = await _account(db, seeded_user)
    _secret, codes = await _enroll(db, account)
    assert await totp.verify_code(db, account, codes[0].upper(), ip=None) == "backup"
    assert await totp.backup_codes_remaining(db, account.person_id) == 7
    with pytest.raises(AuthError):
        await totp.verify_code(db, account, codes[0], ip=None)

    fresh = await totp.regenerate_backup_codes(db, account, actor_id=account.person_id, ip=None)
    assert len(fresh) == 8 and not set(fresh) & set(codes)
    with pytest.raises(AuthError):
        await totp.verify_code(db, account, codes[1], ip=None)
    assert await totp.verify_code(db, account, fresh[0], ip=None) == "backup"


async def test_failed_codes_lock_the_account(db, seeded_user, monkeypatch):
    from serversherpa.config import get_settings

    # Settings is frozen; model_copy(update=…) is the supported way to vary it
    tight = get_settings().model_copy(update={"max_failed_logins": 2})
    monkeypatch.setattr(totp, "get_settings", lambda: tight)
    account = await _account(db, seeded_user)
    await _enroll(db, account)
    for _ in range(2):
        with pytest.raises(AuthError) as exc:
            await totp.verify_code(db, account, "000000", ip=None)
        assert exc.value.code == "totp_invalid"
    assert account.locked_until is not None
    with pytest.raises(AuthError) as exc:
        await totp.verify_code(db, account, "000000", ip=None)
    assert exc.value.code == "account_locked"


async def test_trust_issue_check_revoke(db, seeded_user):
    account = await _account(db, seeded_user)
    token = await totp.issue_trust(db, account, user_agent="UA", ip=None)
    assert await totp.check_trust(db, account, token) is True
    assert await totp.check_trust(db, account, token + "x") is False
    row = await db.scalar(select(TrustedDevice).where(TrustedDevice.person_id == account.person_id))
    assert row.last_used_at is not None and row.user_agent == "UA"
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    assert await totp.check_trust(db, account, token) is False
    row.expires_at = datetime.now(UTC) + timedelta(days=1)
    await db.commit()
    await totp.revoke_trust(db, account.person_id)
    await db.commit()
    assert await totp.check_trust(db, account, token) is False


async def test_reset_clears_everything(db, seeded_user):
    account = await _account(db, seeded_user)
    await _enroll(db, account)
    await totp.issue_trust(db, account, user_agent=None, ip=None)
    await totp.reset(db, account, actor_id=None, ip=None)
    await db.commit()
    assert account.totp_secret_enc is None and account.totp_confirmed_at is None
    assert account.totp_last_counter is None
    assert await totp.backup_codes_remaining(db, account.person_id) == 0
    live = list(await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == account.person_id, TrustedDevice.revoked_at.is_(None))))
    assert live == []
