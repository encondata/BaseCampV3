"""services/first_admin.py: the first admin of a fresh environment — a typed
password (account ready, change-password link) or an invite (no password,
set-password link). Mail goes through the outbox; nothing is committed."""

import logging
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog, EmailOutbox, PasswordResetToken, Person, PersonRole, UserAccount,
)
from serversherpa.security.passwords import verify_password
from serversherpa.services import password_reset
from serversherpa.services.first_admin import FirstAdminError, create_admin, ttl_text

EMAIL = "ada@test.example.com"
TYPED = "Correct-Horse-Battery-9"
NOW = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)


async def _make(db, **kw):
    # the real clock: find_valid() compares the link's expiry with now
    args = dict(email=EMAIL, first_name="Ada", last_name="Lovelace", role="super_admin",
                password=TYPED, link_minutes=240)
    result = await create_admin(db, **{**args, **kw})
    await db.commit()
    return result


def _raw(mail: EmailOutbox) -> str:
    return mail.text_body.split("#token=")[1].split()[0]


def test_ttl_text():
    assert (ttl_text(240), ttl_text(60), ttl_text(90), ttl_text(1)) == (
        "4 hours", "1 hour", "90 minutes", "1 minute")


async def test_typed_password_creates_a_super_admin_and_mails_a_change_link(db, email_on):
    result = await _make(db)
    account = await db.scalar(select(UserAccount).where(UserAccount.email == EMAIL))
    assert account.person_id == result.person_id and result.emailed is True
    pepper = get_settings().password_pepper.get_secret_value()
    assert verify_password(account.password_hash, TYPED, pepper=pepper)
    assert account.must_change_password is False
    roles = list(await db.scalars(select(PersonRole.role)
                                  .where(PersonRole.person_id == account.person_id)))
    assert roles == ["super_admin"]
    mail = await db.scalar(select(EmailOutbox))
    assert (mail.template, mail.to_address) == ("account_ready", EMAIL)
    assert "4 hours" in mail.text_body and TYPED not in mail.text_body + mail.html_body
    token = await db.scalar(select(PasswordResetToken))
    assert (token.expires_at - token.created_at).total_seconds() == 240 * 60
    assert token.token_hash == password_reset.hash_token(_raw(mail))
    assert await password_reset.find_valid(db, _raw(mail)) is not None
    audit = await db.scalar(select(AuditLog).where(AuditLog.action == "user.bootstrap"))
    assert audit.changes == {"role": "super_admin", "invite": False, "emailed": True}
    assert TYPED not in repr(audit.changes)


async def test_invite_has_no_password_and_a_set_password_link_that_works(db, email_on):
    result = await _make(db, password=None)
    account = await db.get(UserAccount, result.person_id)
    assert account.password_hash is None
    mail = await db.scalar(select(EmailOutbox))
    assert mail.template == "account_invite"
    found = await password_reset.find_valid(db, _raw(mail))
    assert found is not None and found[1].person_id == result.person_id
    await password_reset.complete(db, *found, "A-New-Password-77", ip=None)
    await db.commit()
    account = await db.get(UserAccount, result.person_id, populate_existing=True)
    pepper = get_settings().password_pepper.get_secret_value()
    assert verify_password(account.password_hash, "A-New-Password-77", pepper=pepper)


async def test_typed_password_without_mail_still_creates_the_account(db):
    result = await _make(db)
    assert result.emailed is False
    assert await db.scalar(select(EmailOutbox)) is None
    assert await db.scalar(select(PasswordResetToken)) is None
    assert await db.get(UserAccount, result.person_id) is not None


async def test_typed_password_without_a_link_sends_nothing(db, email_on):
    result = await _make(db, link_minutes=None)
    assert result.emailed is False and await db.scalar(select(EmailOutbox)) is None


@pytest.mark.parametrize("kw, code", [
    ({"password": "short"}, "password_too_short"),
    ({"role": "no_such_role"}, "role_unknown"),
    ({"password": None, "link_minutes": None}, "link_required"),
])
async def test_refusals_create_nothing(db, email_on, kw, code):
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email=EMAIL, first_name="Ada", last_name="Lovelace",
                           role=kw.get("role", "super_admin"),
                           password=kw.get("password", TYPED),
                           link_minutes=kw.get("link_minutes", 240), now=NOW)
    await db.rollback()
    assert e.value.code == code
    if code == "password_too_short":
        assert e.value.extra == {"min_length": get_settings().password_min_length}
    assert await db.scalar(select(UserAccount)) is None


async def test_invite_needs_mail(db):
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email=EMAIL, first_name="Ada", last_name="Lovelace",
                           role="super_admin", password=None, link_minutes=240, now=NOW)
    assert e.value.code == "mail_not_configured"


async def test_an_existing_account_is_refused(db, email_on, seeded_user):
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email="alice@test.example.com", first_name="A",
                           last_name="B", role="super_admin", password=TYPED,
                           link_minutes=240, now=NOW)
    assert e.value.code == "account_exists"


async def test_the_password_never_reaches_the_logs(db, email_on, caplog):
    caplog.set_level(logging.DEBUG)
    await _make(db)
    await _make(db, email="ada2@test.example.com", password=None)
    assert TYPED not in caplog.text


async def test_an_existing_account_with_different_case_is_refused(db, email_on, seeded_user):
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email="Alice@Test.Example.COM", first_name="A",
                           last_name="B", role="super_admin", password=TYPED,
                           link_minutes=240, now=NOW)
    assert e.value.code == "account_exists"


async def test_account_exists_is_checked_before_the_password_and_role(db, seeded_user):
    # a re-run is idempotent: the account is there, whatever else is wrong now
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email="alice@test.example.com", first_name="A",
                           last_name="B", role="no_such_role", password="short",
                           link_minutes=240, now=NOW)
    assert e.value.code == "account_exists"


async def test_a_person_with_that_email_but_no_account_is_refused(db, email_on):
    db.add(Person(first_name="Ada", last_name="Lovelace", email=EMAIL.upper()))
    await db.commit()
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email=EMAIL, first_name="Ada", last_name="Lovelace",
                           role="super_admin", password=TYPED, link_minutes=240, now=NOW)
    await db.rollback()
    assert e.value.code == "person_exists"
    assert await db.scalar(select(UserAccount)) is None


async def test_a_person_with_that_email_and_an_account_is_account_exists(db, seeded_user):
    # alice's login email differs from her people.email
    account = await db.get(UserAccount, seeded_user.id)
    account.email = "alice.login@test.example.com"
    await db.commit()
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email="alice@test.example.com", first_name="A",
                           last_name="B", role="super_admin", password=TYPED,
                           link_minutes=240, now=NOW)
    assert e.value.code == "account_exists"


async def test_a_client_anchored_role_is_refused(db, email_on):
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email=EMAIL, first_name="Ada", last_name="Lovelace",
                           role="client_admin", password=TYPED, link_minutes=240, now=NOW)
    await db.rollback()
    assert e.value.code == "role_unknown"
    assert await db.scalar(select(UserAccount)) is None


async def test_an_empty_password_is_refused(db, email_on):
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email=EMAIL, first_name="Ada", last_name="Lovelace",
                           role="super_admin", password="", link_minutes=240, now=NOW)
    assert e.value.code == "password_too_short"


async def test_a_failure_after_the_first_writes_leaves_nothing(db, email_on, monkeypatch):
    from serversherpa.services import first_admin

    async def boom(*a, **kw):
        raise RuntimeError("smtp template exploded")

    monkeypatch.setattr(first_admin, "enqueue", boom)
    with pytest.raises(RuntimeError):
        await create_admin(db, email=EMAIL, first_name="Ada", last_name="Lovelace",
                           role="super_admin", password=TYPED, link_minutes=240, now=NOW)
    await db.rollback()
    for model in (UserAccount, Person, PersonRole, PasswordResetToken, EmailOutbox):
        assert await db.scalar(select(model)) is None, model


@pytest.mark.parametrize("bad", ["ada@corp.local", "ada@box.test", "not-an-email", "ada@"])
async def test_an_email_the_portal_cant_sign_in_with_is_refused(db, email_on, bad):
    # the portal's LoginIn.email is an EmailStr: the same rules, before any write
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email=bad, first_name="Ada", last_name="Lovelace",
                           role="super_admin", password=TYPED, link_minutes=240, now=NOW)
    await db.rollback()
    assert e.value.code == "email_invalid" and e.value.extra["reason"]
    assert TYPED not in e.value.extra["reason"]
    assert await db.scalar(select(Person)) is None
