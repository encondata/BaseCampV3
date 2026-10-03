"""Migration 0089: email_outbox + password_reset_tokens, and the
password-reset settings defaults."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError

from serversherpa.config import get_settings
from serversherpa.db.models import EmailOutbox, PasswordResetToken


def test_password_reset_settings_defaults():
    s = get_settings()
    assert s.password_reset_ttl_minutes == 15
    assert s.password_reset_rate_limit == 5
    assert s.password_reset_confirm_rate_limit == 20


def test_tests_run_with_smtp_off():
    assert get_settings().smtp_host == ""


async def test_outbox_row_defaults(db, seeded_user):
    row = EmailOutbox(template="t", to_address="a@test.example.com",
                      person_id=seeded_user.id, subject="s",
                      html_body="<p>h</p>", text_body="h")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    assert row.status == "queued"
    assert row.attempts == 0
    assert row.next_attempt_at is not None
    assert row.sent_at is None


async def test_outbox_status_is_checked(db):
    db.add(EmailOutbox(template="t", to_address="a@test.example.com",
                       subject="s", html_body="h", text_body="h", status="bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_reset_token_hash_is_unique(db, seeded_user):
    now = datetime.now(UTC)
    for _ in range(2):
        db.add(PasswordResetToken(person_id=seeded_user.id, token_hash="abc",
                                  created_at=now, expires_at=now + timedelta(minutes=15)))
    with pytest.raises(IntegrityError):
        await db.commit()
