"""services/password_reset.py: issue (email on/off), validate, complete."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, AuthSession, EmailOutbox, Notification, PasswordResetToken, TrustedDevice,
    UserAccount,
)
from serversherpa.security.passwords import verify_password
from serversherpa.config import get_settings
from serversherpa.services import password_reset as svc

from tests.test_status_values_write import _make

EMAIL = "alice@test.example.com"


def _raw_from(row: EmailOutbox) -> str:
    return row.text_body.split("#token=")[1].split()[0]


async def _issue(db, ip="203.0.113.5"):
    await svc.request_reset(db, EMAIL, ip=ip)
    await db.commit()
    db.expire_all()
    row = (await db.scalars(select(EmailOutbox).order_by(EmailOutbox.created_at.desc()))).first()
    return _raw_from(row)


async def test_email_on_issues_hashed_token_and_queues_mail(db, seeded_user, email_on):
    person_id = seeded_user.id
    raw = await _issue(db)
    tok = await db.scalar(select(PasswordResetToken))
    assert tok.token_hash == svc.hash_token(raw) and raw not in tok.token_hash
    assert tok.person_id == person_id and tok.requested_ip == "203.0.113.5"
    ttl = (tok.expires_at - tok.created_at).total_seconds()
    assert ttl == get_settings().password_reset_ttl_minutes * 60
    mail = await db.scalar(select(EmailOutbox))
    assert mail.template == "password_reset" and mail.to_address == EMAIL
    origin = get_settings().portal_origin.rstrip('/')
    assert f"{origin}/reset-password#token={raw}" in mail.text_body
    assert await db.scalar(select(AuditLog).where(AuditLog.action == "password.reset_requested"))


async def test_unknown_and_disabled_accounts_do_nothing(db, seeded_user, email_on):
    await svc.request_reset(db, "nobody@test.example.com", ip=None)
    account = await db.get(UserAccount, seeded_user.id)
    account.disabled_at = datetime.now(UTC)
    await db.commit()
    await svc.request_reset(db, EMAIL, ip=None)
    await db.commit()
    db.expire_all()
    assert await db.scalar(select(EmailOutbox)) is None
    assert await db.scalar(select(PasswordResetToken)) is None


async def test_email_off_opens_admin_card_instead(client, db, seeded_user):
    await _make(db, client, "super_admin", "sa@test.example.com")
    await svc.request_reset(db, EMAIL, ip=None)
    await db.commit()
    db.expire_all()
    assert await db.scalar(select(PasswordResetToken)) is None
    card = await db.scalar(select(Notification).where(
        Notification.kind == "password_reset_request"))
    assert card is not None


async def test_newest_link_wins(db, seeded_user, email_on):
    first = await _issue(db)
    second = await _issue(db)
    assert await svc.find_valid(db, first) is None
    assert await svc.find_valid(db, second) is not None


async def test_expired_and_unknown_tokens_are_invalid(db, seeded_user, email_on):
    raw = await _issue(db)
    tok = await db.scalar(select(PasswordResetToken))
    tok.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    assert await svc.find_valid(db, raw) is None
    assert await svc.find_valid(db, "not-a-token") is None


async def test_token_dies_when_password_changes_another_way(db, seeded_user, email_on):
    person_id = seeded_user.id
    raw = await _issue(db)
    account = await db.get(UserAccount, person_id)
    account.password_updated_at = datetime.now(UTC) + timedelta(seconds=1)
    await db.commit()
    assert await svc.find_valid(db, raw) is None


async def test_complete_applies_everything(client, db, seeded_user, email_on):
    person_id = seeded_user.id
    login = await client.post("/auth/login", json={"email": EMAIL, "password": "CorrectHorse9!"})
    assert login.status_code == 200
    db.add(TrustedDevice(person_id=person_id, token_hash="trust",
                         expires_at=datetime.now(UTC) + timedelta(days=7)))
    account = await db.get(UserAccount, person_id)
    account.failed_login_count = 3
    account.locked_until = datetime.now(UTC) + timedelta(minutes=10)
    await db.commit()
    raw = await _issue(db)

    tok, acct = await svc.find_valid(db, raw)
    token_id = tok.id
    await svc.complete(db, tok, acct, "BrandNewPass9!", ip="203.0.113.5")
    await db.commit()
    db.expire_all()

    acct = await db.get(UserAccount, person_id)
    pepper = get_settings().password_pepper.get_secret_value()
    assert verify_password(acct.password_hash, "BrandNewPass9!", pepper=pepper)
    assert acct.must_change_password is False
    assert acct.failed_login_count == 0 and acct.locked_until is None
    assert (await db.get(PasswordResetToken, token_id)).used_at is not None
    assert await svc.find_valid(db, raw) is None                    # single use
    live = await db.scalars(select(AuthSession).where(
        AuthSession.person_id == person_id, AuthSession.revoked_at.is_(None)))
    assert list(live) == []
    trust = await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == person_id, TrustedDevice.revoked_at.is_(None)))
    assert list(trust) == []
    templates = [m.template for m in await db.scalars(select(EmailOutbox))]
    assert "password_changed" in templates
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "password.reset_self"))
    assert row.entity_id == str(person_id) and row.actor_person_id == person_id


async def test_issue_token_retires_older_ones_and_keeps_only_the_hash(db, seeded_user):
    now = datetime.now(UTC)
    first = await svc.issue_token(db, seeded_user.id, minutes=240, now=now)
    second = await svc.issue_token(db, seeded_user.id, minutes=240, now=now)
    await db.commit()
    rows = list(await db.scalars(select(PasswordResetToken)
                                 .order_by(PasswordResetToken.created_at)))
    assert len(rows) == 2
    assert {r.token_hash for r in rows} == {svc.hash_token(first), svc.hash_token(second)}
    assert all(first not in r.token_hash and second not in r.token_hash for r in rows)
    old = next(r for r in rows if r.token_hash == svc.hash_token(first))
    new = next(r for r in rows if r.token_hash == svc.hash_token(second))
    assert old.used_at is not None and new.used_at is None
    assert (new.expires_at - new.created_at).total_seconds() == 240 * 60
    assert await svc.find_valid(db, second) is not None


def test_portal_url_joins_the_portal_origin():
    origin = get_settings().portal_origin.rstrip("/")
    assert svc.portal_url("/login") == f"{origin}/login"
