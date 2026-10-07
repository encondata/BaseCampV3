"""mail/: template rendering and the transactional outbox writer."""

import pytest
from sqlalchemy import func, select

from serversherpa.db.models import EmailOutbox
from serversherpa.mail import email_enabled, enqueue
from serversherpa.mail.render import render

LINK = "https://portal.example.com/reset-password#token=abc"


def test_render_password_reset_has_subject_html_and_text():
    r = render("password_reset", name="Alice", link=LINK, ttl_minutes=15)
    assert r.subject == "Reset your ServerSherpa password"
    assert LINK in r.html and LINK in r.text
    assert "15 minutes" in r.html and "15 minutes" in r.text
    assert "Hi Alice" in r.text
    assert r.html.lstrip().lower().startswith("<!doctype html>")


def test_render_escapes_html_but_not_text():
    r = render("password_reset", name="<b>Eve</b>", link=LINK, ttl_minutes=15)
    assert "&lt;b&gt;Eve&lt;/b&gt;" in r.html
    assert "<b>Eve</b>" not in r.html
    assert "Hi <b>Eve</b>" in r.text


def test_render_password_changed():
    r = render("password_changed", name="Alice", login_url="https://p/login")
    assert r.subject == "Your ServerSherpa password was changed"
    assert "https://p/login" in r.html and "https://p/login" in r.text
    assert "contact your administrator" in r.text


def test_email_enabled_off_in_tests():
    assert email_enabled() is False


def test_email_enabled_with_host_and_from(email_on):
    assert email_enabled() is True


async def test_enqueue_adds_without_committing(db, seeded_user):
    row = await enqueue(db, "password_reset", "alice@test.example.com",
                        person_id=seeded_user.id, name="Alice", link=LINK, ttl_minutes=15)
    assert row.id is not None and row.status == "queued"
    assert row.subject == "Reset your ServerSherpa password"
    await db.rollback()
    count = await db.scalar(select(func.count()).select_from(EmailOutbox))
    assert count == 0


async def test_enqueue_persists_when_caller_commits(db, seeded_user):
    await enqueue(db, "password_changed", "alice@test.example.com",
                  person_id=seeded_user.id, name="Alice", login_url="https://p/login")
    await db.commit()
    row = await db.scalar(select(EmailOutbox))
    assert row.template == "password_changed"
    assert row.to_address == "alice@test.example.com"
    assert row.person_id == seeded_user.id


READY = dict(name="Ada", email="ada@test.example.com", link=LINK, ttl_text="4 hours",
             login_url="https://portal.example.com/login")


def test_render_account_ready_has_the_change_password_link():
    r = render("account_ready", **READY)
    assert r.subject == "Your ServerSherpa account is ready"
    for part in (r.html, r.text):
        assert LINK in part and "https://portal.example.com/login" in part
        assert "4 hours" in part and "ada@test.example.com" in part
    assert "Hi Ada" in r.text
    assert "change your password" in r.text.lower()
    assert r.html.lstrip().lower().startswith("<!doctype html>")


def test_render_account_invite_has_the_set_password_link():
    r = render("account_invite", **READY)
    assert r.subject == "Your ServerSherpa account is ready: set your password"
    for part in (r.html, r.text):
        assert LINK in part and "4 hours" in part and "ada@test.example.com" in part
    assert "set your password" in r.text.lower()


@pytest.mark.parametrize("template", ["account_ready", "account_invite"])
def test_account_emails_never_take_a_password(template):
    """A typo'd context key fails (StrictUndefined); a password key is simply
    never used by the template, so it can't reach the inbox."""
    r = render(template, **READY, password="Never-In-Mail-123")
    assert "Never-In-Mail-123" not in r.html and "Never-In-Mail-123" not in r.text
    with pytest.raises(Exception):
        render(template, name="Ada", email="ada@test.example.com", link=LINK)
