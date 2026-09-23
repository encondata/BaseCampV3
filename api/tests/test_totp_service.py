"""services/totp: secrets at rest, policy resolver, code verification with
replay guard, backup codes, trusted browsers, challenge tokens."""

import asyncio
import threading
import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pyotp
import pytest
from pydantic import SecretStr
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AccessGroup,
    AccessGroupMember,
    PersonRole,
    Role,
    SystemConfig,
    TotpBackupCode,
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


def test_challenge_token_round_trip_rejects_tampering():
    pid = uuid.uuid4()
    tok = totp.make_challenge_token(pid, "verify")
    assert totp.decode_challenge_token(tok) == (pid, "verify")
    with pytest.raises(TokenError):
        totp.decode_challenge_token(tok + "x")


def test_challenge_token_enroll_purpose():
    pid = uuid.uuid4()
    tok = totp.make_challenge_token(pid, "enroll")
    assert totp.decode_challenge_token(tok) == (pid, "enroll")


def _mint_raw_token(**claim_overrides):
    now = datetime.now(UTC)
    claims = {
        "iss": totp.JWT_ISSUER, "sub": str(uuid.uuid4()), "purpose": "verify",
        "iat": now, "exp": now + timedelta(seconds=60), "typ": "totp",
    }
    claims.update(claim_overrides)
    return jwt.encode(claims, get_settings().jwt_secret.get_secret_value(), algorithm="HS256")


def test_decode_challenge_token_rejects_wrong_typ():
    tok = _mint_raw_token(typ="access")
    with pytest.raises(TokenError):
        totp.decode_challenge_token(tok)


def test_decode_challenge_token_rejects_bogus_purpose():
    tok = _mint_raw_token(purpose="bogus")
    with pytest.raises(TokenError):
        totp.decode_challenge_token(tok)


def test_decode_challenge_token_rejects_non_uuid_sub():
    tok = _mint_raw_token(sub="not-a-uuid")
    with pytest.raises(TokenError):
        totp.decode_challenge_token(tok)


def test_decode_challenge_token_rejects_expired(monkeypatch):
    monkeypatch.setattr(totp, "CHALLENGE_TTL_SECONDS", -60)
    tok = totp.make_challenge_token(uuid.uuid4(), "verify")
    with pytest.raises(TokenError):
        totp.decode_challenge_token(tok)


def test_encrypt_secret_rejects_invalid_fernet_key(monkeypatch):
    bad = get_settings().model_copy(update={"totp_encryption_key": SecretStr("not-a-key")})
    monkeypatch.setattr(totp, "get_settings", lambda: bad)
    with pytest.raises(RuntimeError) as exc:
        totp.encrypt_secret("JBSWY3DPEHPK3PXP")
    assert str(exc.value) == "SS_TOTP_ENCRYPTION_KEY is not a valid Fernet key"


def test_decrypt_secret_rejects_blob_from_a_different_key(monkeypatch):
    from cryptography.fernet import Fernet

    blob = totp.encrypt_secret("JBSWY3DPEHPK3PXP")
    other = get_settings().model_copy(
        update={"totp_encryption_key": SecretStr(Fernet.generate_key().decode())})
    monkeypatch.setattr(totp, "get_settings", lambda: other)
    with pytest.raises(RuntimeError):
        totp.decrypt_secret(blob)


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

    # Capture the code (and the timestamp it belongs to) once: confirm
    # runs 8 Argon2 hashes to build the backup codes, slow enough that a
    # second pyotp.TOTP(secret).now() call afterward can land in the next
    # 30s step and flake.
    ts = datetime.now(UTC)
    code = pyotp.TOTP(secret).at(ts)
    codes = await totp.confirm_enrollment(
        db, account, code, actor_id=account.person_id, ip=None)
    assert len(codes) == 8 and all(len(c) == 11 and c[5] == "-" for c in codes)
    assert account.totp_confirmed_at is not None
    assert await totp.backup_codes_remaining(db, account.person_id) == 8

    # the confirm code itself is now a replay
    with pytest.raises(AuthError):
        await totp.verify_code(db, account, code, ip=None)
    # a code from the next step verifies (drift window)
    nxt = pyotp.TOTP(secret).at(ts + timedelta(seconds=30))
    assert await totp.verify_code(db, account, nxt, ip=None) == "totp"


async def test_verify_code_accepts_code_with_internal_space(db, seeded_user):
    """A code split as an authenticator app renders it ("123 456") is still
    routed to the TOTP branch, not misread as a backup code."""
    account = await _account(db, seeded_user)
    secret, _codes = await _enroll(db, account)
    nxt = pyotp.TOTP(secret).at(datetime.now(UTC) + timedelta(seconds=30))
    spaced = f"{nxt[:3]} {nxt[3:]}"
    assert await totp.verify_code(db, account, spaced, ip=None) == "totp"


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


async def test_backup_code_consumption_is_conditional_on_still_being_unused(
        db, seeded_user, monkeypatch):
    """Deterministic proxy for the concurrent-request race: verify_code's
    UPDATE is conditioned on used_at still being NULL. The row is still
    unused when verify_code's SELECT finds it; a "concurrent" request marks
    it used, from a second session, between that SELECT and verify_code's
    own UPDATE — so verify_code's UPDATE affects zero rows and it falls
    through to the failure path instead of double-accepting it.

    The concurrent write has to land while verify_code is still holding the
    match, and it has to be a real commit visible to verify_code's own
    session — a plain `await` from here can't interleave with code that
    isn't awaited at the call site, so it runs on a second AsyncSession
    from a background thread with its own event loop. That session uses a
    dedicated, NullPool engine rather than the app's cached one
    (get_sessionmaker()'s): asyncpg connections are bound to the loop that
    created them, and handing the background loop a connection out of the
    main loop's pool blows up with "attached to a different loop"."""
    account = await _account(db, seeded_user)
    _secret, codes = await _enroll(db, account)
    before = await totp.backup_codes_remaining(db, account.person_id)

    real_verify_password = totp.verify_password
    fired = False

    def _race_then_verify(code_hash, candidate, *, pepper):
        nonlocal fired
        ok = real_verify_password(code_hash, candidate, pepper=pepper)
        if ok and not fired:
            fired = True

            async def _consume_concurrently():
                engine = create_async_engine(
                    get_settings().database_url.get_secret_value(), poolclass=NullPool)
                try:
                    async with async_sessionmaker(engine)() as other:
                        row = await other.scalar(select(TotpBackupCode).where(
                            TotpBackupCode.person_id == account.person_id,
                            TotpBackupCode.used_at.is_(None)))
                        assert row is not None
                        row.used_at = datetime.now(UTC)
                        await other.commit()
                finally:
                    await engine.dispose()

            outcome: dict = {}

            def _runner():
                try:
                    asyncio.run(_consume_concurrently())
                except Exception as exc:  # pragma: no cover - surfaced below
                    outcome["error"] = exc

            thread = threading.Thread(target=_runner)
            thread.start()
            thread.join()
            if "error" in outcome:
                raise outcome["error"]
        return ok

    monkeypatch.setattr(totp, "verify_password", _race_then_verify)

    with pytest.raises(AuthError) as exc:
        await totp.verify_code(db, account, codes[0], ip=None)
    assert exc.value.code == "totp_invalid"
    assert await totp.backup_codes_remaining(db, account.person_id) == before - 1


async def test_failed_codes_lock_the_account(db, seeded_user, monkeypatch):
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
    row = await db.scalar(select(TrustedDevice).where(TrustedDevice.person_id == account.person_id))
    assert row.user_agent == "UA"
    issued_last_used_at = row.last_used_at
    assert issued_last_used_at is not None

    assert await totp.check_trust(db, account, token) is True
    await db.refresh(row)
    assert row.last_used_at is not None and row.last_used_at > issued_last_used_at
    assert await totp.check_trust(db, account, token + "x") is False
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
