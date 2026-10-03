# Email Service + Self-Service Password Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the API a queued, templated email service and use it for a self-service password-reset flow that falls back to admin inbox cards when SMTP isn't configured.

**Architecture:** `mail/` renders Jinja2 templates into an `email_outbox` row inside the caller's transaction; the existing `notification-worker` claims rows with `FOR UPDATE SKIP LOCKED` and sends them over stdlib `smtplib` (or marks them `skipped` when SMTP is unset). Password reset stores SHA-256-hashed single-use tokens in `password_reset_tokens`, applies passwords through `apply_password`, revokes sessions and 2FA trust, and is fronted by `/auth/password-reset/*` routes plus a portal modal and `/reset-password` page.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, Jinja2, stdlib smtplib, pytest; React + TypeScript + Vitest.

Spec: `docs/superpowers/specs/2026-10-03-email-and-password-reset-design.md`.

## Global Constraints

- American English in all copy, comments and docs (color, canceled, …).
- Email is enabled iff `settings.smtp_host.strip()` and `settings.smtp_from.strip()` are both non-empty.
- New env settings and defaults, verbatim: `SS_PASSWORD_RESET_TTL_MINUTES=15`, `SS_PASSWORD_RESET_RATE_LIMIT=5` (request calls per IP per hour), `SS_PASSWORD_RESET_CONFIRM_RATE_LIMIT=20` (check + confirm calls per IP per hour, one shared counter).
- `POST /auth/password-reset/request` always answers `202 {"status": "accepted"}` (or 429 `rate_limited`) — never anything that depends on whether the account exists.
- Every invalid-token case answers 400 `{"code": "reset_token_invalid"}`.
- Admin cards show the person's name, never the typed email.
- Never log email addresses or tokens; log outbox row id + template only.
- `enqueue()`, `notify()`, `audit()` and the reset service helpers never commit; routes commit.
- Migration number is **0089** (`down_revision = "0088"`).
- API tests: run from `api/` with `.venv/bin/pytest`. Use a per-branch test DB to avoid colliding with other sessions: prefix every pytest command with `SS_TEST_DB=serversherpa_test_email_reset`. Run the suite in the foreground.
- Portal: run `npm ci` in `portal/` once if `portal/node_modules` is missing (worktrees don't share it). Tests: `npx vitest run <path>` from `portal/`.
- Commit after each task; commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

API (`api/src/serversherpa/`):
- `config.py` — modify: three password-reset settings.
- Note: the password reuse/history rule runs only while the password-expiry policy is enabled (`assert_not_reused` is a no-op otherwise) — the reset flow inherits that as-is.
- `db/models.py` — modify: `EmailOutbox`, `PasswordResetToken`.
- `migrations/versions/0089_email_outbox_password_reset.py` — create (path is `api/migrations/versions/`).
- `mail/__init__.py` — create: re-exports `enqueue`, `email_enabled`.
- `mail/render.py` — create: Jinja2 rendering.
- `mail/outbox.py` — create: `email_enabled()`, `enqueue()`.
- `mail/transport.py` — create: build + send over SMTP.
- `mail/delivery.py` — create: claim, send, retry, skip, stale sweep.
- `mail/templates/_base.html`, `password_reset.{html,txt,subject.txt}`, `password_changed.{html,txt,subject.txt}` — create.
- `notifications/worker.py` — modify: call `deliver_once` each poll.
- `notifications/reset_requests.py` — create: admin card open/bump/resolve.
- `services/sessions.py` — modify: `revoke_all_sessions()`.
- `services/password_reset.py` — create: token issue/validate/complete.
- `api/routes/users.py` — modify: use shared `revoke_all_sessions`, resolve cards on admin reset.
- `api/routes/auth.py` — modify: three `/password-reset/*` routes + limiters.
- `api/routes/system.py`, `api/schemas.py` — modify: `/system/status` fields; request/confirm schemas.

Portal (`portal/src/`):
- `lib/systemStatus.ts` — modify: new status fields.
- `lib/api.ts` — modify: three reset calls.
- `components/login/ForgotPasswordCard.tsx` — create: the modal.
- `pages/Login.tsx` — modify: use the card, `?forgot=1`.
- `components/AuthCard.tsx` — create: dark-shell card shared by forced change + reset.
- `components/ForceChangePassword.tsx` — modify: use `AuthCard`.
- `components/ChangePasswordForm.tsx` — modify: reset variant.
- `pages/ResetPassword.tsx` — create.
- `App.tsx` — modify: `/reset-password` route.
- `components/NotificationsPanel.tsx` — modify: icon + outcome line for `password_reset_request`.

Config/docs: `.env.example`, dev `.env` (local only, not committed if ignored), `deploy/stack/api/compose.yml`, `api/tests/conftest.py`.

---

### Task 1: Settings, migration 0089, models, test harness

**Files:**
- Modify: `api/src/serversherpa/config.py` (after `lockout_seconds`, ~line 56)
- Modify: `api/src/serversherpa/db/models.py` (after `PasswordHistory`, ~line 107)
- Create: `api/migrations/versions/0089_email_outbox_password_reset.py`
- Modify: `api/tests/conftest.py` (`_prepare_environment`, the TRUNCATE list)
- Modify: `.env.example`, `deploy/stack/api/compose.yml`
- Test: `api/tests/test_email_reset_schema.py`

**Interfaces:**
- Produces: `Settings.password_reset_ttl_minutes: int = 15`, `Settings.password_reset_rate_limit: int = 5`, `Settings.password_reset_confirm_rate_limit: int = 20`; models `EmailOutbox`, `PasswordResetToken` (columns below); tests run with `SS_SMTP_HOST=""` unless a test opts in.

- [ ] **Step 1: Write the failing test**

`api/tests/test_email_reset_schema.py`:

```python
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
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `api/`): `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_email_reset_schema.py -v`
Expected: collection error — `ImportError: cannot import name 'EmailOutbox'`.

- [ ] **Step 3: Add the settings**

In `config.py`, directly after `lockout_seconds: int = 900 ...`:

```python
    # self-service password reset (POST /auth/password-reset/*)
    password_reset_ttl_minutes: int = 15          # reset link lifetime
    password_reset_rate_limit: int = 5            # /request calls per IP per hour
    password_reset_confirm_rate_limit: int = 20   # /check + /confirm calls per IP per hour
```

- [ ] **Step 4: Add the models**

In `db/models.py`, after `class PasswordHistory`:

```python
class PasswordResetToken(Base):
    """A self-service reset link. Only the SHA-256 of the raw token is
    stored; the raw token lives only in the email. Single use: used_at is
    stamped on success, and on every older unused token when a newer link
    is requested (services/password_reset.py)."""
    __tablename__ = "password_reset_tokens"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_accounts.person_id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(unique=True)
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    expires_at: Mapped[datetime]
    used_at: Mapped[datetime | None]
    requested_ip: Mapped[str | None]


class EmailOutbox(Base):
    """One outbound email, fully rendered at enqueue time (mail/outbox.py)
    and delivered by notification-worker (mail/delivery.py). status:
    queued → sending → sent | failed | skipped (no SMTP configured)."""
    __tablename__ = "email_outbox"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    template: Mapped[str]
    to_address: Mapped[str] = mapped_column(CITEXT)
    person_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id", ondelete="SET NULL"))
    subject: Mapped[str]
    html_body: Mapped[str]
    text_body: Mapped[str]
    status: Mapped[str] = mapped_column(server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    next_attempt_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    last_error: Mapped[str | None]
    worker_id: Mapped[str | None]
    heartbeat_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    sent_at: Mapped[datetime | None]
```

- [ ] **Step 5: Write the migration**

`api/migrations/versions/0089_email_outbox_password_reset.py`:

```python
"""Email outbox + password reset tokens.

`email_outbox` — every outbound email, rendered at enqueue time and
delivered by notification-worker (status queued/sending/sent/failed/
skipped). `password_reset_tokens` — SHA-256 hashes of self-service reset
links (single use, short-lived).

Revision ID: 0089
Revises: 0088
Create Date: 2026-10-03
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0089"
down_revision: str | None = "0088"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.TIMESTAMP(timezone=True)


def upgrade() -> None:
    op.create_table(
        "email_outbox",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("template", sa.Text, nullable=False),
        sa.Column("to_address", CITEXT, nullable=False),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True),
        sa.Column("subject", sa.Text, nullable=False),
        sa.Column("html_body", sa.Text, nullable=False),
        sa.Column("text_body", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("next_attempt_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.Column("last_error", sa.Text, nullable=True),
        sa.Column("worker_id", sa.Text, nullable=True),
        sa.Column("heartbeat_at", TS, nullable=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.Column("sent_at", TS, nullable=True),
        sa.CheckConstraint(
            "status IN ('queued', 'sending', 'sent', 'failed', 'skipped')",
            name="ck_email_outbox_status"),
    )
    op.create_index("ix_email_outbox_due", "email_outbox", ["status", "next_attempt_at"])

    op.create_table(
        "password_reset_tokens",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("user_accounts.person_id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("token_hash", sa.Text, nullable=False, unique=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("used_at", TS, nullable=True),
        sa.Column("requested_ip", sa.Text, nullable=True),
    )
    op.create_index("ix_password_reset_tokens_person", "password_reset_tokens", ["person_id"])


def downgrade() -> None:
    op.drop_index("ix_password_reset_tokens_person", table_name="password_reset_tokens")
    op.drop_table("password_reset_tokens")
    op.drop_index("ix_email_outbox_due", table_name="email_outbox")
    op.drop_table("email_outbox")
```

- [ ] **Step 6: Pin SMTP off in tests and truncate the new tables**

In `api/tests/conftest.py` `_prepare_environment()`, next to the other `os.environ[...]` pins (before `get_settings.cache_clear()`):

```python
    # Tests never send real mail: email is "not configured" unless a test
    # opts in with the `email_on` fixture (which still uses a fake sender).
    os.environ["SS_SMTP_HOST"] = ""
    os.environ["SS_SMTP_FROM"] = ""
```

In the `TRUNCATE` statement inside `clean_db`, add `email_outbox, password_reset_tokens, ` right after `TRUNCATE auth_sessions, `.

Append a shared fixture at the end of `conftest.py`:

```python
@pytest.fixture
def email_on(monkeypatch):
    """Email 'configured' for one test. Nothing reaches a real server:
    delivery tests pass a fake `send` to deliver_once."""
    from serversherpa.config import get_settings

    monkeypatch.setenv("SS_SMTP_HOST", "smtp.test.invalid")
    monkeypatch.setenv("SS_SMTP_FROM", "noreply@test.example.com")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_email_reset_schema.py -v`
Expected: 5 passed.

- [ ] **Step 8: Document the settings**

`.env.example`, under `# ── Login lockout ──` after `SS_TOTP_TRUST_DAYS=7 ...`:

```
SS_PASSWORD_RESET_TTL_MINUTES=15          # self-service reset link lifetime
SS_PASSWORD_RESET_RATE_LIMIT=5            # reset requests per IP per hour
SS_PASSWORD_RESET_CONFIRM_RATE_LIMIT=20   # reset link checks + submissions per IP per hour
```

Also append the same three lines (same section) to the repo-root `.env` of this worktree and of the main checkout `/Users/jrh1812/Developer/BaseCampV3/.env` (gitignored — never commit them; the main checkout's `.env` is what the running dev stack reads), so the Developer › System config › Environment tab lists them. Append only; touch no other line.

`deploy/stack/api/compose.yml`, in `x-ss-env` after `SS_SMTP_FROM: ...`:

```yaml
  SS_PASSWORD_RESET_TTL_MINUTES: ${SS_PASSWORD_RESET_TTL_MINUTES:-15}
  SS_PASSWORD_RESET_RATE_LIMIT: ${SS_PASSWORD_RESET_RATE_LIMIT:-5}
  SS_PASSWORD_RESET_CONFIRM_RATE_LIMIT: ${SS_PASSWORD_RESET_CONFIRM_RATE_LIMIT:-20}
```

Then run the env-file and stack-config tests to confirm nothing pins the old key list:
`SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_env_file.py tests/test_env_api.py -q` and, from the repo root, `api/.venv/bin/pytest deploy/tests/test_stack_config.py -q`.
Expected: all pass (fix any test that enumerates keys exhaustively by adding the new keys).

- [ ] **Step 9: Commit**

```bash
git add api/src/serversherpa/config.py api/src/serversherpa/db/models.py \
  api/migrations/versions/0089_email_outbox_password_reset.py api/tests/conftest.py \
  api/tests/test_email_reset_schema.py .env.example deploy/stack/api/compose.yml
git commit -m "feat(api): email_outbox + password_reset_tokens (0089), reset settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Templates, rendering and `enqueue`

**Files:**
- Create: `api/src/serversherpa/mail/__init__.py`, `mail/render.py`, `mail/outbox.py`
- Create: `api/src/serversherpa/mail/templates/_base.html`, `password_reset.html`, `password_reset.txt`, `password_reset.subject.txt`, `password_changed.html`, `password_changed.txt`, `password_changed.subject.txt`
- Modify: `api/pyproject.toml` only if package data isn't picked up (see Step 5)
- Test: `api/tests/test_mail_outbox.py`

**Interfaces:**
- Consumes: `EmailOutbox` (Task 1).
- Produces:
  - `mail.render.render(template: str, **ctx) -> Rendered` where `Rendered(subject: str, html: str, text: str)` (frozen dataclass).
  - `mail.outbox.email_enabled() -> bool`.
  - `mail.outbox.enqueue(db: AsyncSession, template: str, to: str, *, person_id: uuid.UUID | None = None, **ctx) -> EmailOutbox` — adds + flushes, never commits.
  - `mail/__init__.py` re-exports `enqueue`, `email_enabled`.
  - Template contexts: `password_reset(name: str, link: str, ttl_minutes: int)`, `password_changed(name: str, login_url: str)`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_mail_outbox.py`:

```python
"""mail/: template rendering and the transactional outbox writer."""

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
```

- [ ] **Step 2: Run to verify failure**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_mail_outbox.py -v`
Expected: `ModuleNotFoundError: No module named 'serversherpa.mail'`.

- [ ] **Step 3: Write the templates**

`mail/templates/_base.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ subject }}</title>
</head>
<body style="margin:0;padding:0;background:#f2f4f7;font-family:Helvetica,Arial,sans-serif;color:#1b2129;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;">
<tr><td style="font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:#d97a06;padding-bottom:16px;">ServerSherpa</td></tr>
<tr><td style="font-size:15px;line-height:1.6;">
{% block content %}{% endblock %}
</td></tr>
</table>
<p style="max-width:520px;font-size:12px;line-height:1.5;color:#667085;margin:16px auto 0;">
You're receiving this because of activity on your ServerSherpa account. This mailbox isn't monitored.
</p>
</td></tr>
</table>
</body>
</html>
```

`mail/templates/password_reset.subject.txt`:

```
Reset your ServerSherpa password
```

`mail/templates/password_reset.html`:

```html
{% extends "_base.html" %}
{% block content %}
<p style="margin:0 0 16px;">Hi {{ name }},</p>
<p style="margin:0 0 24px;">Someone asked to reset the password for your ServerSherpa account. If it was you, choose a new password with the button below. The link works once and expires in {{ ttl_minutes }} minutes.</p>
<p style="margin:0 0 24px;"><a href="{{ link }}" style="display:inline-block;background:#ffa12e;color:#0c1117;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">Choose a new password</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#667085;">If the button doesn't work, paste this address into your browser:</p>
<p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="{{ link }}" style="color:#1b2129;">{{ link }}</a></p>
<p style="margin:0;font-size:13px;color:#667085;">If you didn't ask for this, you can ignore this email. Your password won't change.</p>
{% endblock %}
```

`mail/templates/password_reset.txt`:

```
Hi {{ name }},

Someone asked to reset the password for your ServerSherpa account. If it was you, open this link to choose a new password. It works once and expires in {{ ttl_minutes }} minutes:

{{ link }}

If you didn't ask for this, you can ignore this email. Your password won't change.
```

`mail/templates/password_changed.subject.txt`:

```
Your ServerSherpa password was changed
```

`mail/templates/password_changed.html`:

```html
{% extends "_base.html" %}
{% block content %}
<p style="margin:0 0 16px;">Hi {{ name }},</p>
<p style="margin:0 0 16px;">The password for your ServerSherpa account was just changed with a reset link, and every device was signed out.</p>
<p style="margin:0 0 24px;"><a href="{{ login_url }}" style="color:#1b2129;">Sign in</a></p>
<p style="margin:0;font-size:13px;color:#667085;">If this wasn't you, contact your administrator right away.</p>
{% endblock %}
```

`mail/templates/password_changed.txt`:

```
Hi {{ name }},

The password for your ServerSherpa account was just changed with a reset link, and every device was signed out.

Sign in: {{ login_url }}

If this wasn't you, contact your administrator right away.
```

- [ ] **Step 4: Write `render.py`, `outbox.py`, `__init__.py`**

`mail/render.py`:

```python
"""Email templates → (subject, html, text). Each email is three files in
templates/: <name>.subject.txt, <name>.html (extends _base.html) and
<name>.txt. Autoescape is on for .html only; StrictUndefined makes a
missing context key an error at enqueue time, not a blank in the inbox."""

from dataclasses import dataclass
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

TEMPLATES_DIR = Path(__file__).parent / "templates"

_env = Environment(
    loader=FileSystemLoader(TEMPLATES_DIR),
    autoescape=select_autoescape(enabled_extensions=("html",), default_for_string=False),
    undefined=StrictUndefined,
    keep_trailing_newline=True,
)


@dataclass(frozen=True)
class Rendered:
    subject: str
    html: str
    text: str


def render(template: str, **ctx) -> Rendered:
    subject = _env.get_template(f"{template}.subject.txt").render(**ctx).strip()
    html = _env.get_template(f"{template}.html").render(subject=subject, **ctx)
    text = _env.get_template(f"{template}.txt").render(**ctx).strip() + "\n"
    return Rendered(subject=subject, html=html, text=text)
```

`mail/outbox.py`:

```python
"""The outbox writer. `enqueue()` renders an email and adds it to the
caller's session — never commits — so mail goes out only if the request
that caused it commits (same contract as notify() and audit()). Rows are
written even when SMTP isn't configured; notification-worker records
those as `skipped`."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import EmailOutbox
from serversherpa.mail.render import render


def email_enabled() -> bool:
    s = get_settings()
    return bool(s.smtp_host.strip() and s.smtp_from.strip())


async def enqueue(db: AsyncSession, template: str, to: str, *,
                  person_id: uuid.UUID | None = None, **ctx) -> EmailOutbox:
    rendered = render(template, **ctx)
    now = datetime.now(UTC)
    row = EmailOutbox(
        template=template, to_address=to, person_id=person_id,
        subject=rendered.subject, html_body=rendered.html, text_body=rendered.text,
        status="queued", attempts=0, next_attempt_at=now, created_at=now)
    db.add(row)
    await db.flush()
    return row
```

`mail/__init__.py`:

```python
"""Outbound email: templates (render.py), the transactional outbox
(outbox.py), SMTP transport (transport.py) and the worker-side delivery
loop (delivery.py). Named `mail`, not `email`, so it never shadows the
stdlib `email` package."""

from serversherpa.mail.outbox import email_enabled, enqueue

__all__ = ["email_enabled", "enqueue"]
```

- [ ] **Step 5: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_mail_outbox.py -v`
Expected: 7 passed.

Then confirm templates ship in the built package: `grep -n "package-data\|include\|packages" api/pyproject.toml`. If the build config lists package data explicitly (e.g. for `wiki` or `reports` templates), add `"mail/templates/*"` the same way; if it uses setuptools defaults with `include-package-data`, check `api/Dockerfile` copies `src/` wholesale (it does if it `COPY src/ ...`). Note what you found in the commit message body.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/mail api/tests/test_mail_outbox.py
git commit -m "feat(api): mail package — Jinja2 email templates + transactional outbox

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: SMTP transport and outbox delivery

**Files:**
- Create: `api/src/serversherpa/mail/transport.py`, `api/src/serversherpa/mail/delivery.py`
- Test: `api/tests/test_mail_delivery.py`

**Interfaces:**
- Consumes: `EmailOutbox`, `email_enabled()`, `enqueue()` (Tasks 1–2).
- Produces:
  - `mail.transport.build_message(*, sender: str, to: str, subject: str, html: str, text: str) -> email.message.EmailMessage`
  - `mail.transport.send_email(*, to: str, subject: str, html: str, text: str) -> Awaitable[None]` (raises on failure)
  - `mail.delivery.deliver_once(maker, *, send=send_email) -> int` — number of rows processed this pass.
  - `mail.delivery.requeue_stale(db) -> int`; constants `MAX_ATTEMPTS = 5`, `BACKOFF_MINUTES = (1, 5, 15, 60)`, `STALE_MINUTES = 15`, `BATCH_SIZE = 20`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_mail_delivery.py`:

```python
"""mail/delivery.py + transport.py: claim, send, retry with backoff, give
up, skip when SMTP is off, stale-row sweep. Never touches a real server —
`send` is a fake."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import EmailOutbox
from serversherpa.mail import enqueue
from serversherpa.mail.delivery import (
    BACKOFF_MINUTES, MAX_ATTEMPTS, deliver_once, requeue_stale,
)
from serversherpa.mail.transport import build_message


class FakeSend:
    def __init__(self, fail_with: Exception | None = None):
        self.calls: list[dict] = []
        self.fail_with = fail_with

    async def __call__(self, **kw):
        self.calls.append(kw)
        if self.fail_with:
            raise self.fail_with


async def _queue(db, **over):
    row = await enqueue(db, "password_changed", "alice@test.example.com",
                        name="Alice", login_url="https://p/login")
    for k, v in over.items():
        setattr(row, k, v)
    await db.commit()
    return row.id


async def _get(row_id):
    async with get_sessionmaker()() as s:
        return await s.get(EmailOutbox, row_id)


def test_build_message_is_multipart_alternative():
    msg = build_message(sender="noreply@x.test", to="a@x.test", subject="Hi",
                        html="<p>Hello</p>", text="Hello\n")
    assert msg["From"] == "noreply@x.test" and msg["To"] == "a@x.test"
    assert msg["Subject"] == "Hi" and msg["Message-ID"]
    assert msg.get_content_type() == "multipart/alternative"
    parts = [p.get_content_type() for p in msg.iter_parts()]
    assert parts == ["text/plain", "text/html"]


async def test_sends_and_marks_sent(db, email_on):
    row_id = await _queue(db)
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls[0]["to"] == "alice@test.example.com"
    assert send.calls[0]["subject"] == "Your ServerSherpa password was changed"
    row = await _get(row_id)
    assert row.status == "sent" and row.sent_at is not None and row.attempts == 1
    # nothing left to do
    assert await deliver_once(get_sessionmaker(), send=send) == 0


async def test_skips_when_smtp_not_configured(db):
    row_id = await _queue(db)
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    assert (await _get(row_id)).status == "skipped"


async def test_failure_requeues_with_backoff(db, email_on):
    row_id = await _queue(db)
    before = datetime.now(UTC)
    await deliver_once(get_sessionmaker(), send=FakeSend(OSError("connection refused")))
    row = await _get(row_id)
    assert row.status == "queued" and row.attempts == 1
    assert "connection refused" in row.last_error
    assert row.next_attempt_at >= before + timedelta(minutes=BACKOFF_MINUTES[0]) - timedelta(seconds=5)
    # not due yet → not claimed again
    assert await deliver_once(get_sessionmaker(), send=FakeSend()) == 0


async def test_gives_up_after_max_attempts(db, email_on):
    row_id = await _queue(db, attempts=MAX_ATTEMPTS - 1)
    await deliver_once(get_sessionmaker(), send=FakeSend(OSError("nope")))
    row = await _get(row_id)
    assert row.status == "failed" and row.attempts == MAX_ATTEMPTS


async def test_future_rows_wait(db, email_on):
    await _queue(db, next_attempt_at=datetime.now(UTC) + timedelta(minutes=10))
    assert await deliver_once(get_sessionmaker(), send=FakeSend()) == 0


async def test_requeue_stale_sending_rows(db):
    old = datetime.now(UTC) - timedelta(minutes=30)
    stale_id = await _queue(db, status="sending", heartbeat_at=old)
    fresh_id = await _queue(db, status="sending", heartbeat_at=datetime.now(UTC))
    async with get_sessionmaker()() as s:
        assert await requeue_stale(s) == 1
    assert (await _get(stale_id)).status == "queued"
    assert (await _get(fresh_id)).status == "sending"


async def test_never_logs_the_address(db, email_on, caplog):
    import logging
    caplog.set_level(logging.DEBUG, logger="serversherpa.mail")
    await _queue(db)
    await deliver_once(get_sessionmaker(), send=FakeSend(OSError("x")))
    assert "alice@test.example.com" not in caplog.text
```

- [ ] **Step 2: Run to verify failure**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_mail_delivery.py -v`
Expected: `ModuleNotFoundError: No module named 'serversherpa.mail.delivery'`.

- [ ] **Step 3: Write `transport.py`**

```python
"""SMTP transport: stdlib smtplib in a worker thread. STARTTLS when
SS_SMTP_STARTTLS is on; AUTH only when SS_SMTP_USERNAME is set (mailpit
needs neither). A fresh SSL context per connection — never a shared one
across threads (see the 2026-09-29 storage TLS segfault)."""

import asyncio
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from serversherpa.config import get_settings

TIMEOUT_SECONDS = 20


def build_message(*, sender: str, to: str, subject: str, html: str, text: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=False)
    domain = sender.rpartition("@")[2] or None
    msg["Message-ID"] = make_msgid(domain=domain)
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    return msg


def _send_sync(msg: EmailMessage) -> None:
    s = get_settings()
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=TIMEOUT_SECONDS) as smtp:
        if s.smtp_starttls:
            smtp.starttls(context=ssl.create_default_context())
        if s.smtp_username:
            smtp.login(s.smtp_username, s.smtp_password.get_secret_value())
        smtp.send_message(msg)


async def send_email(*, to: str, subject: str, html: str, text: str) -> None:
    msg = build_message(sender=get_settings().smtp_from, to=to, subject=subject,
                        html=html, text=text)
    await asyncio.to_thread(_send_sync, msg)
```

- [ ] **Step 4: Write `delivery.py`**

```python
"""Worker-side outbox delivery, called from notification-worker's loop.
The table is the queue: due `queued` rows are claimed with FOR UPDATE
SKIP LOCKED (→ `sending`), then each is sent in its own session. Outcomes:
sent; a send error → back to `queued` with backoff, `failed` after
MAX_ATTEMPTS; SMTP not configured → `skipped`. Nothing raises out of a
row. Logs carry the row id and template — never the address."""

import logging
import os
import socket
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import EmailOutbox
from serversherpa.mail.outbox import email_enabled
from serversherpa.mail.transport import send_email

logger = logging.getLogger("serversherpa.mail.delivery")

BATCH_SIZE = 20
MAX_ATTEMPTS = 5
BACKOFF_MINUTES = (1, 5, 15, 60)
STALE_MINUTES = 15
ERROR_MAX = 2000


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def requeue_stale(db: AsyncSession) -> int:
    """Rows a dead worker left `sending` go back to the queue. Commits."""
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    rows = (await db.scalars(
        select(EmailOutbox).where(EmailOutbox.status == "sending",
                                  EmailOutbox.heartbeat_at < cutoff)
        .with_for_update(skip_locked=True))).all()
    for row in rows:
        row.status = "queued"
        row.worker_id = None
        row.heartbeat_at = None
    await db.commit()
    return len(rows)


async def _claim(db: AsyncSession) -> list[uuid.UUID]:
    now = datetime.now(UTC)
    rows = (await db.scalars(
        select(EmailOutbox)
        .where(EmailOutbox.status == "queued", EmailOutbox.next_attempt_at <= now)
        .order_by(EmailOutbox.next_attempt_at, EmailOutbox.created_at)
        .limit(BATCH_SIZE).with_for_update(skip_locked=True))).all()
    for row in rows:
        row.status = "sending"
        row.heartbeat_at = now
        row.worker_id = _worker_id()
    await db.commit()
    return [row.id for row in rows]


async def _deliver(row: EmailOutbox, send) -> None:
    now = datetime.now(UTC)
    if not email_enabled():
        row.status = "skipped"
        logger.info("email %s (%s) skipped — SMTP not configured", row.id, row.template)
        return
    row.attempts += 1
    try:
        await send(to=row.to_address, subject=row.subject,
                   html=row.html_body, text=row.text_body)
    except Exception as exc:
        row.last_error = f"{type(exc).__name__}: {exc}"[:ERROR_MAX]
        if row.attempts >= MAX_ATTEMPTS:
            row.status = "failed"
            logger.error("email %s (%s) failed after %d attempts: %s",
                         row.id, row.template, row.attempts, row.last_error)
        else:
            row.status = "queued"
            row.next_attempt_at = now + timedelta(minutes=BACKOFF_MINUTES[row.attempts - 1])
            logger.warning("email %s (%s) attempt %d failed, retrying: %s",
                           row.id, row.template, row.attempts, row.last_error)
        return
    row.status = "sent"
    row.sent_at = now
    row.last_error = None
    logger.info("sent email %s (%s)", row.id, row.template)


async def deliver_once(maker, *, send=send_email) -> int:
    """One pass: sweep stale rows, claim a batch, deliver each. Returns
    the number of rows processed."""
    async with maker() as db:
        await requeue_stale(db)
        ids = await _claim(db)
    for row_id in ids:
        async with maker() as db:
            row = await db.get(EmailOutbox, row_id)
            if row is None:
                continue
            await _deliver(row, send)
            await db.commit()
    return len(ids)
```

- [ ] **Step 5: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_mail_delivery.py -v`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/mail/transport.py api/src/serversherpa/mail/delivery.py api/tests/test_mail_delivery.py
git commit -m "feat(api): SMTP transport + outbox delivery (retry/backoff, skip when unconfigured)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: notification-worker delivers the outbox

**Files:**
- Modify: `api/src/serversherpa/notifications/worker.py`
- Modify: `api/tests/test_notification_worker.py`

**Interfaces:**
- Consumes: `deliver_once(maker, *, send=...) -> int`, `email_enabled()`.
- Produces: `notification-worker` calls `deliver_once(maker)` every loop iteration (unless paused). Idle line text becomes `"idle — %d enabled group(s), %d member(s); email delivery on|off (SMTP not configured)"`.

- [ ] **Step 1: Update/write the failing tests**

In `tests/test_notification_worker.py`:

1. In `test_run_forever_heartbeats_and_marks_stop`, replace
   `assert "delivery pipeline not implemented" in caplog.text` with
   `assert "email delivery off (SMTP not configured)" in caplog.text`.
2. In `test_run_once_logs_idle_status_line`, add `assert "email delivery off" in caplog.text`.
3. Append:

```python
async def test_run_forever_delivers_the_outbox(db, monkeypatch):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def fake_deliver(maker):
        calls.append(maker)
        return 0

    monkeypatch.setattr(worker_mod, "deliver_once", fake_deliver)
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) >= 2          # every poll, not hourly


async def test_delivery_errors_do_not_kill_the_loop(db, monkeypatch, caplog):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def boom(maker):
        calls.append(1)
        raise RuntimeError("db down")

    monkeypatch.setattr(worker_mod, "deliver_once", boom)
    caplog.set_level(logging.WARNING, logger="serversherpa.notifications.worker")
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) >= 2
    assert caplog.text.count("could not deliver the email outbox") == 1   # once per outage
```

- [ ] **Step 2: Run to verify failure**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_notification_worker.py -v`
Expected: the idle-line assertions and both new tests fail (`AttributeError: ... has no attribute 'deliver_once'` for the monkeypatch ones).

- [ ] **Step 3: Modify the worker**

In `notifications/worker.py`:

Replace the module docstring with:

```python
"""The notification-worker loop — a separate process from the API
(`serversherpa notification-worker`). Each poll it delivers the email
outbox (mail/delivery.py); once an hour it runs the password-expiry
reminder sweep (notifications/password_reminders.py); every 15 minutes it
logs a status line. Quiet hours / DND delivery is still a later task."""
```

Add imports:

```python
from serversherpa.mail import email_enabled
from serversherpa.mail.delivery import deliver_once
```

Replace `run_once`'s log call with:

```python
    logger.info(
        "idle — %d enabled group(s), %d member(s); email delivery %s",
        groups, members, "on" if email_enabled() else "off (SMTP not configured)")
```

Replace the online log line with:

```python
    logger.info("notification worker online — email outbox every %.0fs, hourly "
                "password expiry reminders", poll_seconds)
```

Add `deliver_state = {"failed": False}` next to `check_state = {}`, and inside the `while True:` loop, right after `pause_state["paused"] = False`:

```python
            try:
                await deliver_once(maker)
                deliver_state["failed"] = False
            except Exception:
                # a DB blip must never kill the loop: log once per outage
                if not deliver_state["failed"]:
                    logger.warning("could not deliver the email outbox — retrying",
                                   exc_info=True)
                deliver_state["failed"] = True
```

- [ ] **Step 4: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_notification_worker.py tests/test_mail_delivery.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/notifications/worker.py api/tests/test_notification_worker.py
git commit -m "feat(api): notification-worker delivers the email outbox every poll

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Shared session revoke + admin reset-request cards

**Files:**
- Modify: `api/src/serversherpa/services/sessions.py`
- Modify: `api/src/serversherpa/api/routes/users.py` (helper at ~478, callers at ~561, ~579, ~823; admin `reset_password` at ~537)
- Create: `api/src/serversherpa/notifications/reset_requests.py`
- Test: `api/tests/test_reset_request_cards.py`

**Interfaces:**
- Produces:
  - `services.sessions.revoke_all_sessions(db: AsyncSession, person_id: uuid.UUID, reason: str) -> None` (no commit).
  - `notifications.reset_requests.KIND = "password_reset_request"`.
  - `notifications.reset_requests.open_or_bump(db: AsyncSession, person: Person) -> int` — copies created or bumped; no commit.
  - `notifications.reset_requests.resolve(db: AsyncSession, person_id: uuid.UUID, resolved_by: str) -> None` — no commit.
  - Card payload: `{"target_person_id": str, "state": "open" | "resolved", "count": int, "last_requested_at": iso str, "resolved_by"?: str}`; title `"{first} {last} asked for a password reset"`; link `/people/users/{person_id}`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_reset_request_cards.py`:

```python
"""Admin inbox cards for password reset requests made while email is off:
fan-out to users:change holders, bump instead of duplicate, resolve on
reset (admin route or self-service)."""

from sqlalchemy import select

from serversherpa.db.models import Notification, Person, PersonRole, UserAccount
from serversherpa.notifications import reset_requests

from tests.test_status_values_write import _make


async def _cards(db):
    db.expire_all()
    return list(await db.scalars(
        select(Notification).where(Notification.kind == reset_requests.KIND)))


async def test_open_fans_out_to_users_change_holders_only(client, db, seeded_user):
    await _make(db, client, "super_admin", "sa@test.example.com")
    await _make(db, client, "staff", "st@test.example.com")
    n = await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    cards = await _cards(db)
    assert n == len(cards) >= 1
    sa = await db.scalar(select(UserAccount).where(UserAccount.email == "sa@test.example.com"))
    st = await db.scalar(select(UserAccount).where(UserAccount.email == "st@test.example.com"))
    owners = {c.person_id for c in cards}
    assert sa.person_id in owners and st.person_id not in owners
    assert seeded_user.id not in owners
    card = cards[0]
    assert card.title == "Alice Anderson asked for a password reset"
    assert card.link == f"/people/users/{seeded_user.id}"
    assert card.payload["state"] == "open" and card.payload["count"] == 1
    assert "alice@test.example.com" not in (card.title + card.body + str(card.payload))


async def test_second_request_bumps_instead_of_duplicating(client, db, seeded_user):
    await _make(db, client, "super_admin", "sa@test.example.com")
    await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    first = await _cards(db)
    for c in first:
        c.read_at = c.created_at
    await db.commit()
    await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    again = await _cards(db)
    assert len(again) == len(first)
    assert all(c.payload["count"] == 2 and c.read_at is None for c in again)


async def test_resolve_marks_every_copy(client, db, seeded_user):
    await _make(db, client, "super_admin", "sa@test.example.com")
    await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    await reset_requests.resolve(db, seeded_user.id, "Sam Admin")
    await db.commit()
    cards = await _cards(db)
    assert all(c.payload["state"] == "resolved" and c.payload["resolved_by"] == "Sam Admin"
               for c in cards)
    # a later request opens a fresh card rather than bumping a resolved one
    await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    assert len([c for c in await _cards(db) if c.payload["state"] == "open"]) >= 1


async def test_admin_reset_route_resolves_cards(client, db, seeded_user):
    hdrs = await _make(db, client, "super_admin", "sa@test.example.com")
    await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    resp = await client.post(f"/users/{seeded_user.id}/reset-password", headers=hdrs,
                             json={"temp_password": "TempPassw0rd!x", "must_change_password": True})
    assert resp.status_code == 204, resp.text
    cards = await _cards(db)
    assert cards and all(c.payload["state"] == "resolved" for c in cards)
    assert all(c.payload["resolved_by"] == "R X" for c in cards)   # _make's name
```

- [ ] **Step 2: Run to verify failure**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_reset_request_cards.py -v`
Expected: `ImportError: cannot import name 'reset_requests'`.

- [ ] **Step 3: Move the session revoke into `services/sessions.py`**

Append to `services/sessions.py` (add `update` to the `sqlalchemy` import):

```python
async def revoke_all_sessions(db: AsyncSession, person_id: uuid.UUID, reason: str) -> None:
    """Revoke every live login family for one person. Does not commit."""
    await db.execute(
        update(AuthSession)
        .where(AuthSession.person_id == person_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC), revoke_reason=reason))
```

Update the module docstring's first line to: `"""Login families for one person — live_session_rows (shared by /auth/me/sessions and GET /users/{id}) and revoke_all_sessions (admin routes, self-service password reset)."""`

In `api/routes/users.py`: delete `_revoke_all_sessions`, add `from serversherpa.services.sessions import revoke_all_sessions` (merge into the existing `services.sessions` import if there is one), and replace the three calls:
`await revoke_all_sessions(db, person_id, "password_change")`, `await revoke_all_sessions(db, person_id, "account_disabled")`, `await revoke_all_sessions(db, person_id, "admin")`. Drop the `update`/`AuthSession` imports only if nothing else in the file uses them.

- [ ] **Step 4: Write `notifications/reset_requests.py`**

```python
"""Admin inbox cards for password-reset requests made while email isn't
configured (POST /auth/password-reset/request). One open card per target
person per approver: a repeat request bumps the existing copies (count,
unread again, back to the top) instead of piling up. Cards carry the
person's name and a link to their user page — never the email typed on the
login page. Resolved by the admin reset-password route or a completed
self-service reset. Adds to the caller's session — never commits."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification, Person
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.requests import approver_ids

KIND = "password_reset_request"
BODY = ("Email isn't set up, so they can't reset it themselves. "
        "Set a temporary password from their user page.")


async def open_or_bump(db: AsyncSession, person: Person) -> int:
    now = datetime.now(UTC)
    existing = (await db.scalars(
        select(Notification).where(
            Notification.kind == KIND,
            Notification.payload["target_person_id"].astext == str(person.id),
            Notification.payload["state"].astext == "open"))).all()
    if existing:
        for card in existing:
            card.payload = {**card.payload,
                            "count": int(card.payload.get("count", 1)) + 1,
                            "last_requested_at": now.isoformat()}
            card.read_at = None
            card.dismissed_at = None
            card.created_at = now
        await db.flush()
        return len(existing)
    title = f"{person.first_name} {person.last_name} asked for a password reset"
    payload = {"target_person_id": str(person.id), "state": "open", "count": 1,
               "last_requested_at": now.isoformat()}
    recipients = await approver_ids(db, exclude=person.id, resource="users", action="change")
    for approver in recipients:
        await notify(db, approver, KIND, title, body=BODY,
                     link=f"/people/users/{person.id}", payload=dict(payload))
    return len(recipients)


async def resolve(db: AsyncSession, person_id: uuid.UUID, resolved_by: str) -> None:
    await db.execute(text(
        "UPDATE notifications SET payload = payload || "
        "jsonb_build_object('state', 'resolved', 'resolved_by', CAST(:by AS text)) "
        "WHERE kind = :kind AND payload ->> 'target_person_id' = CAST(:pid AS text) "
        "AND payload ->> 'state' = 'open'"),
        {"by": resolved_by, "kind": KIND, "pid": str(person_id)})
```

- [ ] **Step 5: Resolve cards from the admin reset route**

In `api/routes/users.py` `reset_password`, after `await revoke_all_sessions(db, person_id, "password_change")`:

```python
    await reset_requests.resolve(
        db, person_id, f"{actor.person.first_name} {actor.person.last_name}")
```

with `from serversherpa.notifications import reset_requests` at the top.

- [ ] **Step 6: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_reset_request_cards.py tests/test_account_mgmt.py tests/test_user_detail_api.py -v`
(If `test_user_detail_api.py` doesn't exist, run `ls tests | grep -i user` and include the users-route test files.)
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/services/sessions.py api/src/serversherpa/api/routes/users.py \
  api/src/serversherpa/notifications/reset_requests.py api/tests/test_reset_request_cards.py
git commit -m "feat(api): admin reset-request inbox cards; shared revoke_all_sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Password-reset service

**Files:**
- Create: `api/src/serversherpa/services/password_reset.py`
- Test: `api/tests/test_password_reset_service.py`

**Interfaces:**
- Consumes: `PasswordResetToken`, `enqueue`, `email_enabled`, `reset_requests.open_or_bump/resolve`, `revoke_all_sessions`, `apply_password(db, account, new_password, *, must_change, now)`, `totp_service.revoke_trust(db, person_id)`, `audit(...)`.
- Produces:
  - `hash_token(raw: str) -> str` (hex SHA-256).
  - `request_reset(db, email: str, *, ip: str | None) -> None` — does all work for the request route; **commits** only when it did something (a no-op for unknown/disabled accounts).
  - `find_valid(db, raw: str) -> tuple[PasswordResetToken, UserAccount] | None` — locks the token row (`FOR UPDATE`); account loaded with `person`.
  - `complete(db, token: PasswordResetToken, account: UserAccount, new_password: str, *, ip: str | None) -> None` — no commit.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_password_reset_service.py`:

```python
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
    db.expire_all()
    row = (await db.scalars(select(EmailOutbox).order_by(EmailOutbox.created_at.desc()))).first()
    return _raw_from(row)


async def test_email_on_issues_hashed_token_and_queues_mail(db, seeded_user, email_on):
    raw = await _issue(db)
    tok = await db.scalar(select(PasswordResetToken))
    assert tok.token_hash == svc.hash_token(raw) and raw not in tok.token_hash
    assert tok.person_id == seeded_user.id and tok.requested_ip == "203.0.113.5"
    ttl = (tok.expires_at - tok.created_at).total_seconds()
    assert ttl == get_settings().password_reset_ttl_minutes * 60
    mail = await db.scalar(select(EmailOutbox))
    assert mail.template == "password_reset" and mail.to_address == EMAIL
    assert f"{get_settings().portal_origin.rstrip('/')}/reset-password#token={raw}" in mail.text_body
    assert await db.scalar(select(AuditLog).where(AuditLog.action == "password.reset_requested"))


async def test_unknown_and_disabled_accounts_do_nothing(db, seeded_user, email_on):
    await svc.request_reset(db, "nobody@test.example.com", ip=None)
    account = await db.get(UserAccount, seeded_user.id)
    account.disabled_at = datetime.now(UTC)
    await db.commit()
    await svc.request_reset(db, EMAIL, ip=None)
    db.expire_all()
    assert await db.scalar(select(EmailOutbox)) is None
    assert await db.scalar(select(PasswordResetToken)) is None


async def test_email_off_opens_admin_card_instead(client, db, seeded_user):
    await _make(db, client, "super_admin", "sa@test.example.com")
    await svc.request_reset(db, EMAIL, ip=None)
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
    raw = await _issue(db)
    account = await db.get(UserAccount, seeded_user.id)
    account.password_updated_at = datetime.now(UTC) + timedelta(seconds=1)
    await db.commit()
    assert await svc.find_valid(db, raw) is None


async def test_complete_applies_everything(client, db, seeded_user, email_on):
    login = await client.post("/auth/login", json={"email": EMAIL, "password": "CorrectHorse9!"})
    assert login.status_code == 200
    db.add(TrustedDevice(person_id=seeded_user.id, token_hash="trust",
                         expires_at=datetime.now(UTC) + timedelta(days=7)))
    account = await db.get(UserAccount, seeded_user.id)
    account.failed_login_count = 3
    account.locked_until = datetime.now(UTC) + timedelta(minutes=10)
    await db.commit()
    raw = await _issue(db)

    tok, acct = await svc.find_valid(db, raw)
    await svc.complete(db, tok, acct, "BrandNewPass9!", ip="203.0.113.5")
    await db.commit()
    db.expire_all()

    acct = await db.get(UserAccount, seeded_user.id)
    pepper = get_settings().password_pepper.get_secret_value()
    assert verify_password(acct.password_hash, "BrandNewPass9!", pepper=pepper)
    assert acct.must_change_password is False
    assert acct.failed_login_count == 0 and acct.locked_until is None
    assert (await db.get(PasswordResetToken, tok.id)).used_at is not None
    assert await svc.find_valid(db, raw) is None                    # single use
    live = await db.scalars(select(AuthSession).where(
        AuthSession.person_id == seeded_user.id, AuthSession.revoked_at.is_(None)))
    assert list(live) == []
    trust = await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == seeded_user.id, TrustedDevice.revoked_at.is_(None)))
    assert list(trust) == []
    templates = [m.template for m in await db.scalars(select(EmailOutbox))]
    assert "password_changed" in templates
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "password.reset_self"))
    assert row.entity_id == str(seeded_user.id) and row.actor_id == seeded_user.id
```

Before running: check the `TrustedDevice` constructor columns with `grep -n "class TrustedDevice" -A15 api/src/serversherpa/db/models.py` and adjust that one constructor to the real required columns (keep the assertions). `verify_password(stored_hash, password, *, pepper)` takes the hash first.

- [ ] **Step 2: Run to verify failure**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_password_reset_service.py -v`
Expected: `ImportError: cannot import name 'password_reset'`.

- [ ] **Step 3: Write the service**

`services/password_reset.py`:

```python
"""Self-service password reset. Raw tokens are 32 random bytes
(token_urlsafe) that live only in the email; the DB keeps their SHA-256.
A token is valid when it exists, is unused, unexpired, its account is
still active, and the password hasn't changed since it was issued. The
request side never reveals whether an account exists — callers answer
the same way whatever happens here."""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from serversherpa.config import get_settings
from serversherpa.db.models import PasswordResetToken, UserAccount
from serversherpa.mail import email_enabled, enqueue
from serversherpa.notifications import reset_requests
from serversherpa.services import totp as totp_service
from serversherpa.services.audit import audit
from serversherpa.services.password_policy import apply_password
from serversherpa.services.sessions import revoke_all_sessions

TOKEN_BYTES = 32


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _portal(path: str) -> str:
    return f"{get_settings().portal_origin.rstrip('/')}{path}"


def _active(account: UserAccount | None) -> bool:
    return (account is not None and account.disabled_at is None
            and account.person.archived_at is None)


async def _account_by(db: AsyncSession, **where) -> UserAccount | None:
    query = select(UserAccount).options(selectinload(UserAccount.person))
    for key, value in where.items():
        query = query.where(getattr(UserAccount, key) == value)
    return await db.scalar(query)


async def _retire_unused(db: AsyncSession, person_id: uuid.UUID, now: datetime) -> None:
    await db.execute(
        update(PasswordResetToken)
        .where(PasswordResetToken.person_id == person_id,
               PasswordResetToken.used_at.is_(None))
        .values(used_at=now))


async def request_reset(db: AsyncSession, email: str, *, ip: str | None) -> None:
    account = await _account_by(db, email=email.strip())
    if not _active(account):
        return
    now = datetime.now(UTC)
    if email_enabled():
        settings = get_settings()
        await _retire_unused(db, account.person_id, now)
        raw = secrets.token_urlsafe(TOKEN_BYTES)
        db.add(PasswordResetToken(
            person_id=account.person_id, token_hash=hash_token(raw), created_at=now,
            expires_at=now + timedelta(minutes=settings.password_reset_ttl_minutes),
            requested_ip=ip))
        await enqueue(db, "password_reset", account.email, person_id=account.person_id,
                      name=account.person.first_name,
                      link=_portal(f"/reset-password#token={raw}"),
                      ttl_minutes=settings.password_reset_ttl_minutes)
        via = "email"
    else:
        await reset_requests.open_or_bump(db, account.person)
        via = "admin"
    audit(db, actor_id=None, entity_type="auth", entity_id=account.email,
          action="password.reset_requested", changes={"via": via}, ip=ip)
    await db.commit()


async def find_valid(db: AsyncSession, raw: str
                     ) -> tuple[PasswordResetToken, UserAccount] | None:
    token = await db.scalar(
        select(PasswordResetToken)
        .where(PasswordResetToken.token_hash == hash_token(raw))
        .with_for_update())
    now = datetime.now(UTC)
    if token is None or token.used_at is not None or token.expires_at <= now:
        return None
    account = await _account_by(db, person_id=token.person_id)
    if not _active(account):
        return None
    if account.password_updated_at is not None and account.password_updated_at > token.created_at:
        return None
    return token, account


async def complete(db: AsyncSession, token: PasswordResetToken, account: UserAccount,
                   new_password: str, *, ip: str | None) -> None:
    now = datetime.now(UTC)
    await apply_password(db, account, new_password, must_change=False, now=now)
    await _retire_unused(db, account.person_id, now)
    token.used_at = now
    account.failed_login_count = 0
    account.locked_until = None
    await revoke_all_sessions(db, account.person_id, "password_reset")
    await totp_service.revoke_trust(db, account.person_id)
    person = account.person
    await reset_requests.resolve(db, account.person_id,
                                 f"{person.first_name} {person.last_name}")
    audit(db, actor_id=account.person_id, entity_type="user_account",
          entity_id=str(account.person_id), action="password.reset_self", ip=ip)
    await enqueue(db, "password_changed", account.email, person_id=account.person_id,
                  name=person.first_name, login_url=_portal("/login"))
```

- [ ] **Step 4: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_password_reset_service.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/services/password_reset.py api/tests/test_password_reset_service.py
git commit -m "feat(api): password reset service — hashed single-use tokens, policy + history, revoke sessions/trust

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Reset routes, rate limits, `/system/status` fields

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (add schemas; extend `SystemStatusOut` ~line 2253)
- Modify: `api/src/serversherpa/api/routes/system.py` (`_status_from`, ~line 90)
- Modify: `api/src/serversherpa/api/routes/auth.py`
- Modify: `api/tests/test_system_admin_api.py` (`test_status_is_public_and_defaults_off`)
- Modify: `api/tests/conftest.py` (reset the new limiters between tests)
- Test: `api/tests/test_password_reset_api.py`

**Interfaces:**
- Consumes: `password_reset.request_reset/find_valid/complete`, `require_password_length`, `raise_if_reused`, `rate_limit_ip`, `client_ip`, `IpRateLimiter`.
- Produces:
  - `POST /auth/password-reset/request {email}` → 202 `{"status": "accepted"}` | 429 `{"code": "rate_limited"}`.
  - `POST /auth/password-reset/check {token}` → 200 `{"valid": bool}` | 429.
  - `POST /auth/password-reset/confirm {token, new_password}` → 204 | 400 `{"code": "reset_token_invalid"}` | 422 `password_too_short` / `password_recently_used` | 429.
  - `GET /system/status` adds `email_enabled: bool`, `password_reset_ttl_minutes: int`, `password_min_length: int`.
  - Module-level `reset_request_limiter`, `reset_confirm_limiter` in `api/routes/auth.py`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_password_reset_api.py`:

```python
"""/auth/password-reset/* over HTTP: enumeration parity, the full
email-on flow (incl. 2FA still required after reset), rate limits."""

from sqlalchemy import select

from serversherpa.db.models import EmailOutbox, UserAccount

from tests.test_totp_api import _enroll_direct, _security

EMAIL = "alice@test.example.com"


async def _request(client, email=EMAIL):
    return await client.post("/auth/password-reset/request", json={"email": email})


async def _latest_raw(db):
    db.expire_all()
    row = (await db.scalars(select(EmailOutbox).where(EmailOutbox.template == "password_reset")
                            .order_by(EmailOutbox.created_at.desc()))).first()
    return row.text_body.split("#token=")[1].split()[0]


async def test_request_responses_are_identical(client, db, seeded_user, email_on):
    real = await _request(client)
    missing = await _request(client, "nobody@test.example.com")
    account = await db.get(UserAccount, seeded_user.id)
    from datetime import UTC, datetime
    account.disabled_at = datetime.now(UTC)
    await db.commit()
    disabled = await _request(client)
    for resp in (real, missing, disabled):
        assert resp.status_code == 202
        assert resp.content == real.content == b'{"status":"accepted"}'


async def test_request_parity_when_email_off(client, db, seeded_user):
    real = await _request(client)
    missing = await _request(client, "nobody@test.example.com")
    assert real.status_code == missing.status_code == 202
    assert real.content == missing.content


async def test_full_flow_requires_2fa_at_next_sign_in(client, db, seeded_user, email_on):
    await _security(db, two_factor_enabled=True)
    await _enroll_direct(db, seeded_user.id)
    await _request(client)
    raw = await _latest_raw(db)

    check = await client.post("/auth/password-reset/check", json={"token": raw})
    assert check.json() == {"valid": True}
    done = await client.post("/auth/password-reset/confirm",
                             json={"token": raw, "new_password": "BrandNewPass9!"})
    assert done.status_code == 204, done.text

    reused = await client.post("/auth/password-reset/confirm",
                               json={"token": raw, "new_password": "AnotherPass9!x"})
    assert reused.status_code == 400 and reused.json()["detail"]["code"] == "reset_token_invalid"
    assert (await client.post("/auth/password-reset/check", json={"token": raw})).json() == {"valid": False}

    old = await client.post("/auth/login", json={"email": EMAIL, "password": "CorrectHorse9!"})
    assert old.status_code == 401
    new = await client.post("/auth/login", json={"email": EMAIL, "password": "BrandNewPass9!"})
    assert new.status_code == 200 and new.json()["status"] == "totp_verify"


async def test_confirm_enforces_length_and_history(client, db, seeded_user, email_on):
    # the reuse rule is part of the password-expiry policy: it only runs
    # while that policy is on (services/password_policy.assert_not_reused)
    await _security(db, password_expiry_enabled=True, password_history_count=3)
    await _request(client)
    raw = await _latest_raw(db)
    short = await client.post("/auth/password-reset/confirm",
                              json={"token": raw, "new_password": "x"})
    assert short.status_code == 422 and short.json()["detail"]["code"] == "password_too_short"
    same = await client.post("/auth/password-reset/confirm",
                             json={"token": raw, "new_password": "CorrectHorse9!"})
    assert same.status_code == 422 and same.json()["detail"]["code"] == "password_recently_used"
    # a refused attempt doesn't burn the link
    assert (await client.post("/auth/password-reset/check", json={"token": raw})).json() == {"valid": True}


async def test_bad_token_is_400(client, seeded_user):
    resp = await client.post("/auth/password-reset/confirm",
                             json={"token": "nope", "new_password": "BrandNewPass9!"})
    assert resp.status_code == 400 and resp.json()["detail"]["code"] == "reset_token_invalid"


async def test_request_rate_limit(client, seeded_user, monkeypatch):
    from serversherpa.api.routes import auth as auth_routes
    monkeypatch.setattr(auth_routes.reset_request_limiter, "limit", 2)
    codes = [(await _request(client, f"x{i}@test.example.com")).status_code for i in range(3)]
    assert codes == [202, 202, 429]


async def test_confirm_and_check_share_a_limit(client, seeded_user, monkeypatch):
    from serversherpa.api.routes import auth as auth_routes
    monkeypatch.setattr(auth_routes.reset_confirm_limiter, "limit", 2)
    a = await client.post("/auth/password-reset/check", json={"token": "t"})
    b = await client.post("/auth/password-reset/confirm", json={"token": "t", "new_password": "BrandNewPass9!"})
    c = await client.post("/auth/password-reset/check", json={"token": "t"})
    assert (a.status_code, b.status_code, c.status_code) == (200, 400, 429)
    assert c.json()["detail"]["code"] == "rate_limited"


async def test_status_reports_email_and_reset_settings(client, email_on):
    body = (await client.get("/system/status")).json()
    assert body["email_enabled"] is True
    assert body["password_reset_ttl_minutes"] == 15
    assert body["password_min_length"] >= 1
```

In `tests/test_system_admin_api.py` `test_status_is_public_and_defaults_off`, add to the expected dict:
`"email_enabled": False, "password_reset_ttl_minutes": 15, "password_min_length": get_settings().password_min_length,` (import `get_settings` from `serversherpa.config` in that test).

In `tests/conftest.py` `clean_db`, right before `yield`, add:

```python
    # per-process rate limiters would otherwise carry hits between tests
    from serversherpa.api.routes.auth import reset_confirm_limiter, reset_request_limiter
    reset_request_limiter.reset()
    reset_confirm_limiter.reset()
```

- [ ] **Step 2: Run to verify failure**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_password_reset_api.py tests/test_system_admin_api.py -v`
Expected: import errors / 404s / status-dict mismatch.

- [ ] **Step 3: Schemas**

In `api/schemas.py`, extend `SystemStatusOut` (before `background`):

```python
    email_enabled: bool = False
    password_reset_ttl_minutes: int = 15
    password_min_length: int = 8
```

And add near the other auth schemas (`LoginIn`):

```python
class PasswordResetRequestIn(BaseModel):
    email: str = Field(max_length=320)


class PasswordResetCheckIn(BaseModel):
    token: str = Field(max_length=200)


class PasswordResetConfirmIn(BaseModel):
    token: str = Field(max_length=200)
    new_password: str = Field(max_length=1024)


class PasswordResetCheckOut(BaseModel):
    valid: bool
```

(`email` is a plain `str`, not `EmailStr`: a malformed address must get the same 202 as everything else, never a 422 that reveals validation. Import `Field` from pydantic if `schemas.py` doesn't already.)

- [ ] **Step 4: `/system/status`**

In `api/routes/system.py` `_status_from`, add to the `SystemStatusOut(...)` call:

```python
        email_enabled=email_enabled(),
        password_reset_ttl_minutes=get_settings().password_reset_ttl_minutes,
        password_min_length=get_settings().password_min_length,
```

with `from serversherpa.mail import email_enabled`.

- [ ] **Step 5: Routes**

In `api/routes/auth.py` add imports:

```python
from serversherpa.api.deps import raise_if_reused, rate_limit_ip, require_password_length
from serversherpa.api.schemas import (
    PasswordResetCheckIn, PasswordResetCheckOut, PasswordResetConfirmIn, PasswordResetRequestIn,
)
from serversherpa.services import password_reset
from serversherpa.wiki.share_links import IpRateLimiter
```

(merge into the existing `deps`/`schemas` import lines; confirm `require_password_length` lives in `api/deps.py` with `grep -n "def require_password_length" -r api/src/serversherpa` and import from wherever it is.)

Then, after `_auth_http_error`:

```python
# ── self-service password reset ─────────────────────────────────────
# Per-process, per-IP (rate_limit_ip, /64 for IPv6), one-hour windows.
# /check and /confirm share one counter: both test a guessed token.
RESET_WINDOW_SECONDS = 3600
reset_request_limiter = IpRateLimiter(
    limit=get_settings().password_reset_rate_limit, window_seconds=RESET_WINDOW_SECONDS)
reset_confirm_limiter = IpRateLimiter(
    limit=get_settings().password_reset_confirm_rate_limit, window_seconds=RESET_WINDOW_SECONDS)


def _limit(limiter: IpRateLimiter, request: Request) -> None:
    if not limiter.hit(rate_limit_ip(request)):
        raise HTTPException(status_code=429, detail={"code": "rate_limited"})


def _invalid_reset() -> HTTPException:
    return HTTPException(status_code=400, detail={"code": "reset_token_invalid"})


@router.post("/password-reset/request", status_code=202)
async def password_reset_request(
    body: PasswordResetRequestIn, request: Request, db: DbSession,
) -> dict:
    """Same answer whether or not the account exists (no enumeration)."""
    _limit(reset_request_limiter, request)
    await password_reset.request_reset(db, body.email, ip=client_ip(request))
    return {"status": "accepted"}


@router.post("/password-reset/check", response_model=PasswordResetCheckOut)
async def password_reset_check(
    body: PasswordResetCheckIn, request: Request, db: DbSession,
) -> PasswordResetCheckOut:
    _limit(reset_confirm_limiter, request)
    valid = await password_reset.find_valid(db, body.token) is not None
    await db.rollback()          # release the FOR UPDATE lock
    return PasswordResetCheckOut(valid=valid)


@router.post("/password-reset/confirm", status_code=204)
async def password_reset_confirm(
    body: PasswordResetConfirmIn, request: Request, db: DbSession,
) -> None:
    _limit(reset_confirm_limiter, request)
    found = await password_reset.find_valid(db, body.token)
    if found is None:
        raise _invalid_reset()
    token, account = found
    require_password_length(body.new_password)
    await raise_if_reused(db, account, body.new_password)
    await password_reset.complete(db, token, account, body.new_password,
                                  ip=client_ip(request))
    await db.commit()
```

- [ ] **Step 6: Exempt the reset routes from read-only mode? — verify, don't change**

Public routes have no `get_current_user`, so `enforce_read_only` never runs for them; no change needed. Confirm by reading `api/deps.py` around `enforce_read_only` — if public routes *are* frozen by some middleware, add the three paths to `READ_ONLY_EXEMPT_PATHS` (sign-in lifecycle) and note it in the commit.

- [ ] **Step 7: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest tests/test_password_reset_api.py tests/test_system_admin_api.py tests/test_auth_flow.py tests/test_totp_api.py -v`
Expected: all pass.

- [ ] **Step 8: Run the whole API suite (foreground)**

Run: `SS_TEST_DB=serversherpa_test_email_reset .venv/bin/pytest -q -x` (it takes ~15–20 minutes; set the tool timeout to the max and run in the foreground).
Expected: all pass. Fix any test that pins the exact `/system/status` shape or the old worker log text.

- [ ] **Step 9: Commit**

```bash
git add api/src/serversherpa/api api/tests/test_password_reset_api.py \
  api/tests/test_system_admin_api.py api/tests/conftest.py
git commit -m "feat(api): /auth/password-reset/{request,check,confirm} with per-IP limits; email flags on /system/status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Portal — API calls, status fields, Forgot password modal

**Files:**
- Modify: `portal/src/lib/systemStatus.ts`
- Modify: `portal/src/lib/api.ts` (after `changePasswordRequest`, ~line 533)
- Create: `portal/src/components/login/ForgotPasswordCard.tsx`
- Modify: `portal/src/pages/Login.tsx`
- Test: `portal/src/components/login/ForgotPasswordCard.test.tsx`

**Interfaces:**
- Consumes: the three API routes and `/system/status` fields (Task 7).
- Produces:
  - `SystemStatus` gains `email_enabled: boolean`, `password_reset_ttl_minutes: number`, `password_min_length: number` (defaults `false`, `15`, `8`).
  - `requestPasswordReset(email: string): Promise<void>`, `checkPasswordResetToken(token: string): Promise<boolean>`, `confirmPasswordReset(token: string, newPassword: string): Promise<void>` — all throw `ApiError` on non-2xx.
  - `<ForgotPasswordCard initialEmail emailEnabled ttlMinutes onClose />`.
  - `/login?forgot=1` opens the card on load.

- [ ] **Step 1: Write the failing test**

`portal/src/components/login/ForgotPasswordCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';

const api = vi.hoisted(() => ({ requestPasswordReset: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: ForgotPasswordCard } = await import('./ForgotPasswordCard');

beforeEach(() => { vi.clearAllMocks(); api.requestPasswordReset.mockResolvedValue(undefined); });
afterEach(cleanup);

it('sends a reset link when email is on and shows the fixed message', async () => {
  const user = userEvent.setup();
  render(<ForgotPasswordCard initialEmail="pat@x.test" emailEnabled ttlMinutes={15} onClose={() => {}} />);
  expect(screen.getByLabelText('Email')).toHaveProperty('value', 'pat@x.test');
  await user.click(screen.getByRole('button', { name: 'Send reset link' }));
  expect(api.requestPasswordReset).toHaveBeenCalledWith('pat@x.test');
  expect(await screen.findByText(/a reset link is on its way\. It expires in 15 minutes\./)).toBeTruthy();
});

it('asks administrators when email is off', async () => {
  const user = userEvent.setup();
  render(<ForgotPasswordCard initialEmail="" emailEnabled={false} ttlMinutes={15} onClose={() => {}} />);
  await user.type(screen.getByLabelText('Email'), 'pat@x.test');
  await user.click(screen.getByRole('button', { name: 'Ask for a reset' }));
  expect(await screen.findByText(/your administrators have been asked to reset it/)).toBeTruthy();
});

it('requires an email', async () => {
  const user = userEvent.setup();
  render(<ForgotPasswordCard initialEmail="" emailEnabled ttlMinutes={15} onClose={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Send reset link' }));
  expect(api.requestPasswordReset).not.toHaveBeenCalled();
  expect(screen.getByText('Enter your email.')).toBeTruthy();
});

it('shows the rate-limit message on 429', async () => {
  api.requestPasswordReset.mockRejectedValue(new ApiError(429, 'rate_limited'));
  const user = userEvent.setup();
  render(<ForgotPasswordCard initialEmail="pat@x.test" emailEnabled ttlMinutes={15} onClose={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Send reset link' }));
  expect(await screen.findByText('Too many requests. Try again later.')).toBeTruthy();
});
```

`ApiError`'s constructor is `(status, code, detail?, message?)`.

- [ ] **Step 2: Run to verify failure**

Run (from `portal/`; `npm ci` first if `node_modules` is missing): `npx vitest run src/components/login/ForgotPasswordCard.test.tsx`
Expected: FAIL — cannot resolve `./ForgotPasswordCard`.

- [ ] **Step 3: Status fields and API calls**

`lib/systemStatus.ts` — add to `SystemStatus`:

```ts
  email_enabled: boolean;
  password_reset_ttl_minutes: number;
  password_min_length: number;
```

and to `DEFAULT_SYSTEM_STATUS`: `email_enabled: false, password_reset_ttl_minutes: 15, password_min_length: 8,`.

`lib/api.ts`, after `changePasswordRequest`:

```ts
/* ── self-service password reset (public, no token) ────────────── */

async function postPublic(path: string, body: unknown): Promise<Response> {
  const resp = await fetch(`${apiUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp;
}

/** Same answer whether or not the account exists. */
export async function requestPasswordReset(email: string): Promise<void> {
  await postPublic('/auth/password-reset/request', { email });
}

export async function checkPasswordResetToken(token: string): Promise<boolean> {
  const resp = await postPublic('/auth/password-reset/check', { token });
  return ((await resp.json()) as { valid: boolean }).valid;
}

export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  await postPublic('/auth/password-reset/confirm', { token, new_password: newPassword });
}
```

- [ ] **Step 4: The card**

`components/login/ForgotPasswordCard.tsx`:

```tsx
/**
 * Forgot password — the login page's recovery card. With email on it
 * sends a reset link; with email off it asks the administrators (an inbox
 * card for users:change holders). Either way the answer is one fixed
 * message: it never says whether the account exists.
 */

import { useState, type FormEvent } from 'react';

import { ApiError, requestPasswordReset } from '../../lib/api';

interface Props {
  initialEmail: string;
  emailEnabled: boolean;
  ttlMinutes: number;
  onClose: () => void;
}

export default function ForgotPasswordCard({ initialEmail, emailEnabled, ttlMinutes, onClose }: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) { setError('Enter your email.'); return; }
    setSending(true);
    setError('');
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'rate_limited'
        ? 'Too many requests. Try again later.'
        : 'Could not send the request. Try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="auth-scrim" role="dialog" aria-modal="true" aria-labelledby="forgot-title"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="otp-card centered">
        <button className="otp-close" type="button" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
        </button>
        <div className="eyebrow">Account recovery</div>
        {sent ? (
          <>
            <h3 className="otp-title" id="forgot-title">{emailEnabled ? 'Check your email' : 'Request sent'}</h3>
            <p className="otp-text" role="status">
              {emailEnabled
                ? `If an account exists for that email, a reset link is on its way. It expires in ${ttlMinutes} minutes.`
                : "If an account exists for that email, your administrators have been asked to reset it. They'll be in touch."}
            </p>
            <button className="btn otp-verify" type="button" onClick={onClose}><span>Done</span></button>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <h3 className="otp-title" id="forgot-title">Reset your password</h3>
            <p className="otp-text">
              {emailEnabled
                ? "Enter your account email and we'll send you a link to choose a new password."
                : "Enter your account email and we'll ask your administrators to reset your password."}
            </p>
            <div className="field">
              <label htmlFor="forgot-email">Email</label>
              <div className="control">
                <input id="forgot-email" type="email" autoComplete="username" autoFocus
                       placeholder="you@company.com" value={email}
                       onChange={(e) => { setEmail(e.target.value); setError(''); }} />
              </div>
            </div>
            <p className={`otp-error ${error ? 'show' : ''}`} role={error ? 'alert' : undefined}>{error}</p>
            <button className={`btn otp-verify ${sending ? 'loading' : ''}`} type="submit" disabled={sending}>
              <span>{emailEnabled ? 'Send reset link' : 'Ask for a reset'}</span>
              <span className="spinner"></span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire it into `Login.tsx`**

1. Import: `import ForgotPasswordCard from '../components/login/ForgotPasswordCard';`
2. Replace `const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);` with:

```tsx
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(
    () => new URLSearchParams(location.search).get('forgot') === '1');
  const [reset, setReset] = useState({ emailEnabled: false, ttlMinutes: 15 });
```

3. Replace the status effect body with:

```tsx
    getSystemStatus().then((s) => {
      setTrustDays(s.totp_trust_days);
      setReset({ emailEnabled: !!s.email_enabled, ttlMinutes: s.password_reset_ttl_minutes ?? 15 });
    }).catch(() => {});
```

4. Replace the whole `{/* Forgot Password / Contact Support card */} {forgotPasswordOpen && (...)}` block with:

```tsx
      {forgotPasswordOpen && (
        <ForgotPasswordCard initialEmail={email} emailEnabled={reset.emailEnabled}
                            ttlMinutes={reset.ttlMinutes} onClose={() => setForgotPasswordOpen(false)} />
      )}
```

5. In the footer, change `Trouble signing in? <button ...>Contact support</button>` to `Trouble signing in? <button ...>Reset your password</button>`, and update the comment above the "Forgot password?" button to say the footer button reaches the same card.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/components/login src/pages ../kiosk/src/pages/Login.test.tsx 2>/dev/null || npx vitest run src/components/login src/pages`
Then from `kiosk/` and `wiki/web/` run their Login-related tests if they have their own vitest config (`ls ../kiosk/package.json ../wiki/web/package.json`; `npx vitest run src/pages/Login.test.tsx` in kiosk, `npx vitest run src/App.test.tsx` in wiki/web — `npm ci` there first if needed).
Expected: all pass. If a Login test mocked `getSystemStatus` with an older shape, the `?? 15` / `!!` guards keep it working; fix only real failures.

- [ ] **Step 7: Typecheck**

Run from `portal/`: `npx tsc -b`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add portal/src/lib/systemStatus.ts portal/src/lib/api.ts portal/src/components/login/ForgotPasswordCard.tsx \
  portal/src/components/login/ForgotPasswordCard.test.tsx portal/src/pages/Login.tsx
git commit -m "feat(portal): Forgot password requests a reset link (or asks admins when email is off)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Portal — `/reset-password` page, form variant, inbox card

**Files:**
- Create: `portal/src/components/AuthCard.tsx`
- Modify: `portal/src/components/ForceChangePassword.tsx`
- Modify: `portal/src/components/ChangePasswordForm.tsx`
- Create: `portal/src/pages/ResetPassword.tsx`
- Modify: `portal/src/App.tsx` (beside `<Route path="/login" ...>`, ~line 85)
- Modify: `portal/src/components/NotificationsPanel.tsx`
- Test: `portal/src/pages/ResetPassword.test.tsx`, additions to `portal/src/components/NotificationsPanel.test.tsx`

**Interfaces:**
- Consumes: `checkPasswordResetToken`, `confirmPasswordReset`, `getSystemStatus` (Task 8).
- Produces:
  - `<AuthCard title={ReactNode} lead={ReactNode}>{children}</AuthCard>` — the dark full-screen shell + white card with the "ServerSherpa Portal" eyebrow.
  - `ChangePasswordForm` props: `{ onSuccess: () => void; resetToken?: string; minLength?: number }`. With `resetToken`, the current-password field is hidden, it submits `confirmPasswordReset(resetToken, next)`, the button reads "Set password", and the footer note reads "Setting a new password signs you out everywhere."
  - Route `/reset-password` (public).

- [ ] **Step 1: Write the failing tests**

`portal/src/pages/ResetPassword.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';

const api = vi.hoisted(() => ({
  checkPasswordResetToken: vi.fn(),
  confirmPasswordReset: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));
vi.mock('../lib/systemStatus', async (importActual) => ({
  ...(await importActual<typeof import('../lib/systemStatus')>()),
  getSystemStatus: vi.fn().mockResolvedValue({ password_min_length: 10 }),
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ passwordMinLength: 8 }) }));

const { default: ResetPassword } = await import('./ResetPassword');

function renderAt(hash: string) {
  window.history.replaceState(null, '', `/reset-password${hash}`);
  return render(<MemoryRouter><ResetPassword /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.checkPasswordResetToken.mockResolvedValue(true);
  api.confirmPasswordReset.mockResolvedValue(undefined);
});
afterEach(cleanup);

it('strips the token from the address bar and checks it', async () => {
  renderAt('#token=abc123');
  expect(await screen.findByLabelText(/New password/)).toBeTruthy();
  expect(window.location.hash).toBe('');
  expect(api.checkPasswordResetToken).toHaveBeenCalledWith('abc123');
  expect(screen.queryByLabelText('Current password')).toBeNull();
});

it('shows the expired state for a dead link', async () => {
  api.checkPasswordResetToken.mockResolvedValue(false);
  renderAt('#token=old');
  expect(await screen.findByText('This link has expired or was already used')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Request a new link' }).getAttribute('href')).toBe('/login?forgot=1');
});

it('treats a missing token as expired without calling the API', async () => {
  renderAt('');
  expect(await screen.findByText('This link has expired or was already used')).toBeTruthy();
  expect(api.checkPasswordResetToken).not.toHaveBeenCalled();
});

it('sets the password and offers sign-in', async () => {
  const user = userEvent.setup();
  renderAt('#token=abc123');
  await user.type(await screen.findByLabelText(/New password/), 'BrandNewPass9!');
  await user.type(screen.getByLabelText('Confirm new password'), 'BrandNewPass9!');
  await user.click(screen.getByRole('button', { name: 'Set password' }));
  expect(api.confirmPasswordReset).toHaveBeenCalledWith('abc123', 'BrandNewPass9!');
  expect(await screen.findByText('Password changed')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
});

it('uses the server minimum length', async () => {
  const user = userEvent.setup();
  renderAt('#token=abc123');
  await user.type(await screen.findByLabelText(/New password \(10\+ characters\)/), 'short9!x');
  await user.type(screen.getByLabelText('Confirm new password'), 'short9!x');
  await user.click(screen.getByRole('button', { name: 'Set password' }));
  expect(screen.getByText('New password must be at least 10 characters.')).toBeTruthy();
  expect(api.confirmPasswordReset).not.toHaveBeenCalled();
});

it('maps server errors', async () => {
  api.confirmPasswordReset.mockRejectedValue(new ApiError(422, 'password_recently_used'));
  const user = userEvent.setup();
  renderAt('#token=abc123');
  await user.type(await screen.findByLabelText(/New password/), 'BrandNewPass9!');
  await user.type(screen.getByLabelText('Confirm new password'), 'BrandNewPass9!');
  await user.click(screen.getByRole('button', { name: 'Set password' }));
  expect(await screen.findByText(/That password was used recently/)).toBeTruthy();
});
```

Append to `portal/src/components/NotificationsPanel.test.tsx`, following the file's existing pattern for rendering a list with given items (read the file first and reuse its helper/mocks):

```tsx
it('shows the outcome line on a resolved password reset request', async () => {
  // render the panel with one item:
  // { kind: 'password_reset_request', title: 'Pat Lee asked for a password reset',
  //   payload: { target_person_id: 'p1', state: 'resolved', resolved_by: 'Sam Admin', count: 1 } }
  // then:
  expect(await screen.findByText('Resolved by Sam Admin')).toBeTruthy();
});

it('shows the repeat count on an open password reset request', async () => {
  // same, payload: { state: 'open', count: 3 }
  expect(await screen.findByText('Asked 3 times')).toBeTruthy();
});
```

Fill in the render calls with the file's real helper — the two assertions are the contract.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/ResetPassword.test.tsx src/components/NotificationsPanel.test.tsx`
Expected: FAIL — `./ResetPassword` unresolved; outcome texts missing.

- [ ] **Step 3: `AuthCard` and `ForceChangePassword`**

`components/AuthCard.tsx` — move the two wrapper `div`s, the eyebrow `<p>`, the `<h1>` and the lead `<p>` out of `ForceChangePassword.tsx` verbatim:

```tsx
/**
 * The dark full-screen shell + white card used by screens that render
 * INSTEAD of the portal shell (forced password change, reset password).
 * Defines the theme variables .portal-shell normally provides, so
 * .btn-solid renders as a real button.
 */

import { type CSSProperties, type ReactNode } from 'react';

import '../styles/profile.css';
import '../styles/settings.css';

export default function AuthCard({ title, lead, children }: {
  title: ReactNode; lead?: ReactNode; children: ReactNode;
}) {
  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: '#0c1117', padding: 24,
      fontFamily: "'Geologica', sans-serif",
      '--accent': '#ffa12e',
      '--accent-soft': '#ffc06b',
      '--font-display': "'Geologica', sans-serif",
    } as CSSProperties}>
      <div style={{
        width: 'min(480px, 96vw)', background: '#fbfcfd', borderRadius: 18,
        padding: '30px 30px 26px', boxShadow: '0 40px 90px -30px rgba(0,0,0,.7)',
      }}>
        <p style={{
          fontFamily: "'Fragment Mono', monospace", fontSize: 10.5,
          letterSpacing: '.3em', textTransform: 'uppercase',
          color: '#ffa12e', margin: 0,
        }}>
          ServerSherpa Portal
        </p>
        <h1 style={{ margin: '10px 0 6px', fontSize: 24, color: '#1b2129' }}>{title}</h1>
        {lead && (
          <p style={{ margin: '0 0 22px', fontSize: 14, color: '#667085', fontWeight: 300 }}>{lead}</p>
        )}
        {children}
      </div>
    </div>
  );
}
```

Rewrite `ForceChangePassword.tsx` to render `<AuthCard title={...} lead={...}>` with the existing title/lead expressions, `<ChangePasswordForm onSuccess={clearMustChange} />` and the existing "Not you? Sign out" paragraph as children; drop the now-unused style imports and `CSSProperties`.

- [ ] **Step 4: `ChangePasswordForm` reset variant**

Changes to `ChangePasswordForm.tsx`:

```tsx
import { ApiError, changePasswordRequest, confirmPasswordReset } from '../lib/api';

const ERRORS: Record<string, string> = {
  invalid_current_password: 'Current password is incorrect.',
  same_as_current: 'The new password must be different from the current one.',
  password_too_short: 'The new password is too short.',
  password_recently_used: "That password was used recently. Choose one you haven't used before.",
  reset_token_invalid: 'This link has expired or was already used. Request a new one from the sign-in page.',
  rate_limited: 'Too many attempts. Try again later.',
};

export default function ChangePasswordForm({ onSuccess, resetToken, minLength }: {
  onSuccess: () => void;
  /** Reset-link mode: no current password; submits to /auth/password-reset/confirm. */
  resetToken?: string;
  /** Overrides the signed-in minimum (the reset page has no session). */
  minLength?: number;
}) {
  const { passwordMinLength: sessionMin } = useAuth();
  const passwordMinLength = minLength ?? sessionMin;
  const resetMode = resetToken !== undefined;
```

In `submit`, replace `await changePasswordRequest(current, next);` with:

```tsx
      if (resetMode) await confirmPasswordReset(resetToken, next);
      else await changePasswordRequest(current, next);
```

Wrap the current-password `<div className="full">…</div>` in `{!resetMode && (…)}`; change the button label to `{saving ? (resetMode ? 'Setting…' : 'Changing…') : (resetMode ? 'Set password' : 'Change password')}`; change the note to `{resetMode ? 'Setting a new password signs you out everywhere.' : 'Changing your password signs you out everywhere else.'}`.

- [ ] **Step 5: The page and the route**

`pages/ResetPassword.tsx`:

```tsx
/**
 * /reset-password#token=… — the page a reset email links to. The token
 * rides in the fragment (never sent to a server or a Referer) and is
 * stripped from the address bar on load. A dead link offers a new one;
 * success sends the user to sign in, where 2FA still applies.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import AuthCard from '../components/AuthCard';
import ChangePasswordForm from '../components/ChangePasswordForm';
import { checkPasswordResetToken } from '../lib/api';
import { getSystemStatus } from '../lib/systemStatus';

type Phase = 'checking' | 'invalid' | 'form' | 'done';

const linkStyle = { color: '#1b2129', fontWeight: 500, borderBottom: '1px solid #ffa12e', textDecoration: 'none' };

export default function ResetPassword() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  const [phase, setPhase] = useState<Phase>(token ? 'checking' : 'invalid');
  const [minLength, setMinLength] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    getSystemStatus().then((s) => setMinLength(s.password_min_length)).catch(() => {});
    if (!token) return;
    let live = true;
    checkPasswordResetToken(token)
      .then((ok) => { if (live) setPhase(ok ? 'form' : 'invalid'); })
      .catch(() => { if (live) setPhase('invalid'); });
    return () => { live = false; };
  }, [token]);

  if (phase === 'checking') return <AuthCard title="Checking your link…">{null}</AuthCard>;

  if (phase === 'invalid') {
    return (
      <AuthCard title="This link has expired or was already used"
                lead="Reset links work once and expire quickly. Ask for a new one from the sign-in page.">
        <Link to="/login?forgot=1" style={linkStyle}>Request a new link</Link>
      </AuthCard>
    );
  }

  if (phase === 'done') {
    return (
      <AuthCard title="Password changed"
                lead="Every device was signed out. Sign in with your new password.">
        <Link to="/login" style={linkStyle}>Sign in</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password"
              lead="It can't be one you've used recently.">
      <ChangePasswordForm resetToken={token} minLength={minLength} onSuccess={() => setPhase('done')} />
    </AuthCard>
  );
}
```

`App.tsx`: `import ResetPassword from './pages/ResetPassword';` and, right after `<Route path="/login" element={<Login />} />`:

```tsx
              <Route path="/reset-password" element={<ResetPassword />} />
```

- [ ] **Step 6: Inbox card**

In `components/NotificationsPanel.tsx`:

1. After `RouterApprovalStrip`, add:

```tsx
interface ResetRequestPayload {
  state: string;
  count?: number;
  resolved_by?: string | null;
}

/** The outcome line under a `password_reset_request` row: who resolved it,
 *  or how many times the person has asked while it's open. */
function ResetRequestOutcome({ payload }: { payload: ResetRequestPayload }) {
  if (payload.state === 'resolved') {
    return (
      <span className="notif-body notif-outcome">
        {payload.resolved_by ? `Resolved by ${payload.resolved_by}` : 'Resolved'}
      </span>
    );
  }
  if ((payload.count ?? 1) > 1) {
    return <span className="notif-body notif-outcome">Asked {payload.count} times</span>;
  }
  return null;
}
```

2. In `KindIcon`, before the `membership_decided` branch:

```tsx
  if (kind === 'password_reset_request') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
      </svg>
    );
  }
```

3. After the `router_approval` strip in the row:

```tsx
                {n.kind === 'password_reset_request' && (
                  <ResetRequestOutcome payload={n.payload as unknown as ResetRequestPayload} />
                )}
```

- [ ] **Step 7: Run the tests, typecheck, full portal suite**

Run from `portal/`:
- `npx vitest run src/pages/ResetPassword.test.tsx src/components/NotificationsPanel.test.tsx src/components`
- `npx tsc -b`
- `npx vitest run` (the whole suite, foreground — it includes the CSS/list-typography/natural-sort guardrails)

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add portal/src/components/AuthCard.tsx portal/src/components/ForceChangePassword.tsx \
  portal/src/components/ChangePasswordForm.tsx portal/src/pages/ResetPassword.tsx \
  portal/src/pages/ResetPassword.test.tsx portal/src/App.tsx \
  portal/src/components/NotificationsPanel.tsx portal/src/components/NotificationsPanel.test.tsx
git commit -m "feat(portal): /reset-password page, reset variant of the password form, reset-request inbox card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live verification against mailpit (controller-run)

This task is run by the controller session, not a subagent: it needs the browser pane and the dev stack.

**Files:** none (fix-forward commits only if something breaks).

- [ ] **Step 1: Bring up dependencies and migrate**

Confirm mailpit is up: `docker compose -f docker-compose.dev.yml ps mailpit` (start it with `docker compose -f docker-compose.dev.yml up -d mailpit` if not). Check the dev DB head before migrating (`api/.venv/bin/alembic current` from `api/`): if another branch already applied a different 0089, stop and re-number. Then `api/.venv/bin/alembic upgrade head`.

- [ ] **Step 2: Run the API, worker and portal from this worktree**

Use the worktree's own ports (memory: user-detail recipe used 8001/5175) so the main dev stack isn't disturbed: API on 8001, `serversherpa notification-worker` from the worktree, portal Vite on 5175 pointed at 8001. Set `SS_PORTAL_ORIGIN=http://localhost:5175` for the API and worker so links point at this portal. Add a `.claude/launch.json` entry if one doesn't exist and start the portal with `preview_start`.

- [ ] **Step 3: Email-on flow**

1. In the browser pane, open `http://localhost:5175/login`, click **Forgot password?**, request a reset for a seeded dev test account (see the dev-workflow memory for logins; use a 2FA-enrolled test account if one exists).
2. Open mailpit at `http://localhost:8025`, find "Reset your ServerSherpa password", check the HTML part renders and the text part has the link.
3. Follow the link, confirm the address bar loses `#token=…`, set a new password, see **Password changed**.
4. Sign in with the new password and confirm a 2FA code is requested (for an enrolled account) even if the browser was previously trusted.
5. Re-open the same link and confirm "This link has expired or was already used".
6. Confirm "Your ServerSherpa password was changed" arrived in mailpit.
7. Request for a nonexistent email and confirm the same on-screen message and no mail.

Afterwards restore the test account's original password through the admin Users page (temporary password) or the self-service flow again, so other sessions' logins keep working; record what you set in the dev-workflow memory only if it changed.

- [ ] **Step 4: Email-off flow**

Restart the API + worker with `SS_SMTP_HOST=` (empty). Request a reset; confirm the modal says administrators were asked; sign in as an admin and see "{Name} asked for a password reset" in the inbox with no email shown; request again and see "Asked 2 times"; reset the user's password from their user page and see "Resolved by {admin}". Confirm the outbox rows created while off are `skipped` (`SELECT status, template FROM email_outbox ORDER BY created_at DESC LIMIT 5;`).

- [ ] **Step 5: Screenshots + wrap-up**

Take screenshots of the modal, the mailpit email, the reset page and the resolved inbox card, and send them to Jimmy. Then use superpowers:finishing-a-development-branch. At ship time, add a Features wiki row + Change log entry (features-wiki-page memory).
