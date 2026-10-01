import uuid
from datetime import UTC, datetime, timedelta

import pyotp
import pytest
from sqlalchemy import func, select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, AuthSession, TotpBackupCode, User
from sirdar_api.security.passwords import hash_password
from sirdar_api.security.totp import encrypt_secret
from sirdar_api.services import auth
from sirdar_api.services.auth import AuthError, AuthResult, LoginChallenge

from .factories import PASSWORD, make_user


def _key() -> str:
    return get_settings().totp_encryption_key.get_secret_value()


async def _enrolled(db, **kw) -> tuple[User, str]:
    seed = pyotp.random_base32()
    user = await make_user(db, totp_secret_enc=encrypt_secret(seed, key=_key()),
                           totp_confirmed_at=datetime.now(UTC), totp_enabled=True, **kw)
    return user, seed


async def _code(db, user: User, **kw) -> str:
    with pytest.raises(AuthError) as exc:
        await auth.login(db, email=user.email, password=kw.get("password", PASSWORD))
    return exc.value.code


async def test_login_success_returns_session(db):
    user = await make_user(db)
    result = await auth.login(db, email="ALICE@test.example.com", password=PASSWORD)
    assert isinstance(result, AuthResult)
    assert result.user.person_id == user.person_id
    assert result.access.can("users", "view")
    await db.refresh(user)
    assert user.last_login_at is not None and user.failed_login_count == 0


async def test_unknown_email_and_wrong_password_are_the_same_error(db):
    await make_user(db)
    with pytest.raises(AuthError) as a:
        await auth.login(db, email="nobody@test.example.com", password=PASSWORD)
    with pytest.raises(AuthError) as b:
        await auth.login(db, email="alice@test.example.com", password="nope")
    assert a.value.code == b.value.code == "invalid_credentials"


async def test_lockout_after_ten_failures(db):
    user = await make_user(db)
    for _ in range(10):
        with pytest.raises(AuthError):
            await auth.login(db, email=user.email, password="wrong")
    await db.refresh(user)
    assert user.locked_until is not None and user.failed_login_count == 0
    # during the lock every password gets the same answer and adds no strike
    assert await _code(db, user, password="wrong") == "account_locked"
    assert await _code(db, user, password="still wrong") == "account_locked"
    await db.refresh(user)
    assert user.failed_login_count == 0
    assert await _code(db, user) == "account_locked"
    reasons = list(await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "login_failed", AuditLog.entity_id == str(user.person_id))))
    assert {"reason": "account_locked"} in reasons


async def test_concurrent_wrong_passwords_all_count(db):
    """The user row is locked on login, so parallel strikes serialize."""
    import asyncio

    from sirdar_api.db.engine import get_sessionmaker

    user = await make_user(db)

    async def attempt() -> str:
        async with get_sessionmaker()() as session:
            with pytest.raises(AuthError) as exc:
                await auth.login(session, email=user.email, password="wrong")
            return exc.value.code

    codes = await asyncio.gather(*(attempt() for _ in range(10)))
    assert set(codes) == {"invalid_credentials"}
    await db.refresh(user)
    assert user.locked_until is not None and user.failed_login_count == 0


async def test_status_checks_only_after_correct_password(db):
    user = await make_user(db, disabled_at=datetime.now(UTC))
    with pytest.raises(AuthError) as exc:
        await auth.login(db, email=user.email, password="wrong")
    assert exc.value.code == "invalid_credentials"
    assert await _code(db, user) == "account_disabled"


async def test_password_change_required_for_portal_users(db):
    a = await make_user(db, email="a@test.example.com", must_change_password=True)
    b = await make_user(db, email="b@test.example.com",
                        password_expires_at=datetime.now(UTC) - timedelta(days=1))
    assert await _code(db, a) == "password_change_required"
    assert await _code(db, b) == "password_change_required"


async def test_totp_required_but_not_enrolled(db):
    user = await make_user(db, totp_enabled=True, totp_required=True)
    assert await _code(db, user) == "totp_enrollment_required"


async def test_totp_required_confirmed_but_seedless_is_refused(db):
    user = await make_user(db, totp_required=True, totp_enabled=True,
                           totp_confirmed_at=datetime.now(UTC), totp_secret_enc=None)
    assert await _code(db, user) == "totp_enrollment_required"


async def test_refusals_release_the_row_lock(db):
    from sqlalchemy import text

    from sirdar_api.db.engine import get_sessionmaker

    user = await make_user(db)
    first = await auth.login(db, email=user.email, password=PASSWORD)
    async with get_sessionmaker()() as other:
        await other.execute(text("UPDATE auth_sessions SET expires_at = now() - interval '1 hour'"))
        await other.commit()
    with pytest.raises(AuthError) as exc:
        await auth.refresh(db, refresh_token=first.refresh_token)
    assert exc.value.code == "session_expired"
    async with get_sessionmaker()() as other:   # would block forever if the lock were held
        await other.execute(text("SET lock_timeout = '2s'"))
        await other.execute(text("SELECT 1 FROM auth_sessions FOR UPDATE"))


async def test_enrolled_user_gets_challenge_then_verifies(db):
    user, seed = await _enrolled(db)
    result = await auth.login(db, email=user.email, password=PASSWORD)
    assert isinstance(result, LoginChallenge)
    code = pyotp.TOTP(seed).now()
    session = await auth.verify_totp(db, challenge_token=result.challenge_token, code=code)
    assert session.user.person_id == user.person_id
    # the same code again is a replay
    again = await auth.login(db, email=user.email, password=PASSWORD)
    with pytest.raises(AuthError) as exc:
        await auth.verify_totp(db, challenge_token=again.challenge_token, code=code)
    assert exc.value.code == "totp_invalid"


async def test_enrolled_but_site_switch_off_skips_challenge(db):
    user, _ = await _enrolled(db)
    user.totp_enabled = False
    await db.commit()
    assert isinstance(await auth.login(db, email=user.email, password=PASSWORD), AuthResult)


async def test_backup_code_works_once(db):
    user, _ = await _enrolled(db)
    pepper = get_settings().password_pepper.get_secret_value()
    db.add(TotpBackupCode(person_id=user.person_id,
                          code_hash=hash_password("abcdefghjk", pepper=pepper)))
    await db.commit()
    ch = await auth.login(db, email=user.email, password=PASSWORD)
    assert ch.backup_codes_remaining == 1
    await auth.verify_totp(db, challenge_token=ch.challenge_token, code="ABCDE-FGHJK")
    ch2 = await auth.login(db, email=user.email, password=PASSWORD)
    with pytest.raises(AuthError) as exc:
        await auth.verify_totp(db, challenge_token=ch2.challenge_token, code="abcdefghjk")
    assert exc.value.code == "totp_invalid"


async def test_bad_challenge_token(db):
    with pytest.raises(AuthError) as exc:
        await auth.verify_totp(db, challenge_token="garbage", code="123456")
    assert exc.value.code == "invalid_challenge"


async def test_refresh_rotates_and_detects_reuse(db):
    await make_user(db)
    first = await auth.login(db, email="alice@test.example.com", password=PASSWORD)
    second = await auth.refresh(db, refresh_token=first.refresh_token)
    assert second.refresh_token != first.refresh_token
    assert second.session_expires_at == first.session_expires_at   # absolute deadline
    with pytest.raises(AuthError) as exc:
        await auth.refresh(db, refresh_token=first.refresh_token)
    assert exc.value.code == "session_reuse_detected"
    with pytest.raises(AuthError) as revoked:
        await auth.refresh(db, refresh_token=second.refresh_token)   # family revoked
    assert revoked.value.code == "invalid_session"


async def test_refresh_rejects_disabled_user(db):
    user = await make_user(db)
    first = await auth.login(db, email=user.email, password=PASSWORD)
    user.disabled_at = datetime.now(UTC)
    await db.commit()
    with pytest.raises(AuthError) as exc:
        await auth.refresh(db, refresh_token=first.refresh_token)
    assert exc.value.code == "account_disabled"


async def test_logout_and_revoke_sessions(db):
    user = await make_user(db)
    email, person_id = user.email, user.person_id   # a refusal's rollback expires `user`
    a = await auth.login(db, email=email, password=PASSWORD)
    await auth.logout(db, refresh_token=a.refresh_token)
    await auth.logout(db, refresh_token="unknown")          # never fails
    with pytest.raises(AuthError):
        await auth.refresh(db, refresh_token=a.refresh_token)
    await auth.login(db, email=email, password=PASSWORD)
    assert await auth.revoke_sessions(db, person_id, reason="test") == 1
    await db.commit()
    live = await db.scalar(select(func.count()).select_from(AuthSession)
                           .where(AuthSession.revoked_at.is_(None)))
    assert live == 0


async def test_audit_rows_written(db):
    await make_user(db)
    await auth.login(db, email="alice@test.example.com", password=PASSWORD)
    actions = set(await db.scalars(select(AuditLog.action)))
    assert "login" in actions


async def test_unknown_person_challenge(db):
    from sirdar_api.security.tokens import create_challenge_token
    tok = create_challenge_token(person_id=uuid.uuid4(),
                                 secret=get_settings().jwt_secret.get_secret_value())
    with pytest.raises(AuthError) as exc:
        await auth.verify_totp(db, challenge_token=tok, code="123456")
    assert exc.value.code == "invalid_challenge"
