# Two-factor authentication (TOTP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portal sign-in can require an authenticator-app code (per user, per access group, per role, or site-wide), with forced enrollment, "remember this browser" trust for N days, backup codes, and admin reset.

**Architecture:** The password login returns either a full session or a short-lived *challenge token*; no session or refresh cookie exists until the second factor passes. A new `services/totp.py` owns secrets (Fernet at rest), code verification (pyotp, replay guard), backup codes (Argon2 hashes), trusted-browser tokens (SHA-256 hashes + `ss_trust` cookie) and the policy resolver. The portal login page swaps its form for the V2 OTP card; the same enrollment components serve the forced step at login and self-service on My Profile.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + pyotp + cryptography (Fernet) + argon2-cffi + PyJWT; React + TypeScript + Vite + vitest + Testing Library; bwip-js for the QR.

**Spec:** `docs/superpowers/specs/2026-09-23-two-factor-auth-design.md` (read it once before Task 1).

## Global Constraints

- Work in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/two-factor` on branch `two-factor-auth`. Never `cd` to the main checkout. `.env` and `portal/node_modules` are symlinks to the main checkout's (already created).
- **API tests:** run from `<worktree>/api` with the main checkout's venv and the worktree's source on the path, on a private test database:
  `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/two-factor/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_two_factor /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/<file>.py -v`
  Everything runs in the FOREGROUND in one continuous command with a long timeout (600000 ms); never background a suite.
- **Portal tests:** `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/two-factor/portal && npx vitest run <file>`; typecheck with `npx tsc -b`.
- Migration number is **0071**, `down_revision = "0070"`.
- Env var `SS_TOTP_TRUST_DAYS` (int, default 7). Existing `SS_TOTP_ENCRYPTION_KEY` (Fernet). `SS_JWT_SECRET` signs challenge tokens.
- Challenge token: HS256 JWT, `typ="totp"`, `purpose` ∈ {`verify`,`enroll`}, 300 s expiry, sent by the portal in the `X-Totp-Challenge` header.
- Cookies: `ss_trust` — httpOnly, `secure` unless `env == "development"`, `samesite="lax"`, `path="/auth"`, `domain=settings.cookie_domain or None`, `max_age = totp_trust_days * 86400`.
- TOTP: `pyotp.random_base32()` secret, 6 digits, 30 s, SHA1, accept counters `base-1..base+1`, reject any counter `<= totp_last_counter`.
- Backup codes: 8 codes, 10 chars from `abcdefghjkmnpqrstuvwxyz23456789`, shown `xxxxx-xxxxx`, compared lowercase with dashes/spaces stripped, stored as Argon2 (`hash_password` with the password pepper), single use.
- `otpauth://totp/ServerSherpa:{email}?secret=…&issuer=ServerSherpa&algorithm=SHA1&digits=6&period=30` (pyotp `provisioning_uri(name=email, issuer_name="ServerSherpa")` produces exactly this).
- Failed codes count toward `failed_login_count` / `locked_until` like failed passwords (`settings.max_failed_logins`, `settings.lockout_seconds`); a locked account gets `account_locked` (423).
- Kiosk clients (`LoginIn.client == "kiosk"`) and phone pairing are never challenged.
- Audit actions (entity_type `user_account`): `totp.enroll`, `totp.confirm`, `totp.verify_failed`, `totp.backup_used`, `totp.codes_regenerated`, `totp.reset`, `totp.trust`, `totp.required_set`.
- American English everywhere (enrollment, authenticator, canceled).
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never commit `api/src/serversherpa/_dev_reload.py` changes.

---

## File map

| File | Responsibility |
|---|---|
| `api/migrations/versions/0071_two_factor_auth.py` | new columns + `totp_backup_codes` + `trusted_devices` |
| `api/src/serversherpa/db/models.py` | `totp_required` on `UserAccount`/`AccessGroup`/`Role`, `totp_last_counter`, `TotpBackupCode`, `TrustedDevice` |
| `api/src/serversherpa/config.py`, `.env.example`, `api/pyproject.toml`, `api/tests/conftest.py` | `totp_trust_days`, pyotp dependency, test Fernet key |
| `api/src/serversherpa/services/totp.py` | all TOTP logic (Task 2) |
| `api/src/serversherpa/services/auth.py` | login branches (`LoginChallenge`) |
| `api/src/serversherpa/api/routes/auth.py`, `api/src/serversherpa/api/schemas.py`, `api/src/serversherpa/api/deps.py` | `/auth/totp/*`, challenge dependency, `totp` block on `SessionOut`/`MeOut`, `/system/status.totp_trust_days` |
| `api/src/serversherpa/api/routes/users.py`, `routes/access.py`, `cli.py` | admin reset / require flag / group+role PATCH / summary fields / `reset-totp` |
| `portal/src/lib/api.ts`, `portal/src/lib/systemStatus.ts`, `portal/src/auth/AuthContext.tsx`, `portal/src/lib/qr.ts` | client types + calls, login result union, QR helper |
| `portal/src/components/totp/{OtpInput,BackupCodesPanel,EnrollFlow,TotpEnrollModal,RegenerateCodesModal}.tsx` | shared 2FA UI |
| `portal/src/pages/Login.tsx` | verify + enroll cards |
| `portal/src/pages/Profile.tsx` | Security row |
| `portal/src/components/users/UserProfileTab.tsx`, `portal/src/pages/UserDetail.tsx`, `portal/src/components/UserAdminModals.tsx` | admin 2FA row, require toggle, reset modal |
| `portal/src/components/access/{GroupsTab,RolesTab}.tsx`, `portal/src/components/settings/SecurityControls.tsx` | Require 2FA switches, policy copy |

---

### Task 1: Schema, models, config, dependency

**Files:**
- Create: `api/migrations/versions/0071_two_factor_auth.py`
- Modify: `api/src/serversherpa/db/models.py` (UserAccount L64-87, Role L146-156, AccessGroup L312-322; add two models after `AuthSession`)
- Modify: `api/src/serversherpa/config.py` (auth section, after `totp_encryption_key`)
- Modify: `.env.example` (after `SS_LOCKOUT_SECONDS`)
- Modify: `api/pyproject.toml` (dependencies)
- Modify: `api/tests/conftest.py` (`_prepare_environment`)
- Test: `api/tests/test_totp_schema.py`

**Interfaces:**
- Produces: `UserAccount.totp_required: bool`, `UserAccount.totp_last_counter: int | None`, `Role.totp_required`, `AccessGroup.totp_required`, models `TotpBackupCode(id, person_id, code_hash, used_at, created_at)` and `TrustedDevice(id, person_id, token_hash, user_agent, created_at, last_used_at, expires_at, revoked_at)`, `Settings.totp_trust_days: int = 7`.

- [ ] **Step 1: Install pyotp into the venv and declare it**

```bash
/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pip install 'pyotp>=2.9'
```

In `api/pyproject.toml` add after `"pyjwt>=2.9",`:

```toml
    "pyotp>=2.9",
```

- [ ] **Step 2: Write the failing schema test**

`api/tests/test_totp_schema.py`:

```python
"""Migration 0071: 2FA columns and tables exist with the documented defaults."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AccessGroup, Role, TotpBackupCode, TrustedDevice, UserAccount,
)


async def test_totp_columns_default_false(db, seeded_user):
    account = await db.get(UserAccount, seeded_user.id)
    assert account.totp_required is False
    assert account.totp_last_counter is None
    role = await db.get(Role, "staff")
    assert role.totp_required is False
    group = AccessGroup(name="Finance")
    db.add(group)
    await db.commit()
    await db.refresh(group)
    assert group.totp_required is False


async def test_backup_codes_and_trusted_devices_cascade(db, seeded_user):
    now = datetime.now(UTC)
    db.add(TotpBackupCode(person_id=seeded_user.id, code_hash="x"))
    db.add(TrustedDevice(person_id=seeded_user.id, token_hash="t1",
                         expires_at=now + timedelta(days=7)))
    await db.commit()
    codes = list(await db.scalars(select(TotpBackupCode).where(
        TotpBackupCode.person_id == seeded_user.id)))
    assert len(codes) == 1 and codes[0].used_at is None
    devices = list(await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == seeded_user.id)))
    assert len(devices) == 1 and devices[0].revoked_at is None


def test_trust_days_setting_defaults_to_seven():
    assert get_settings().totp_trust_days == 7
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/two-factor/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_two_factor /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_totp_schema.py -v`
Expected: ImportError on `TotpBackupCode`.

- [ ] **Step 4: Write the migration**

`api/migrations/versions/0071_two_factor_auth.py`:

```python
"""Two-factor authentication.

Adds the per-user / per-group / per-role `totp_required` policy flags, the
TOTP replay guard (`totp_last_counter`), one-time backup codes, and
trusted browsers ("Remember this browser" skips the code for N days).

Revision ID: 0071
Revises: 0070
Create Date: 2026-09-23
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0071"
down_revision: str | None = "0070"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("user_accounts", sa.Column(
        "totp_required", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("user_accounts", sa.Column(
        "totp_last_counter", sa.BigInteger(), nullable=True,
        comment="Last accepted TOTP time step; codes at or below it are replays"))
    op.add_column("access_groups", sa.Column(
        "totp_required", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("roles", sa.Column(
        "totp_required", sa.Boolean(), nullable=False, server_default=sa.text("false")))

    op.create_table(
        "totp_backup_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("user_accounts.person_id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_totp_backup_codes_person", "totp_backup_codes", ["person_id"])

    op.create_table(
        "trusted_devices",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("user_accounts.person_id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_trusted_devices_person", "trusted_devices", ["person_id"])


def downgrade() -> None:
    op.drop_index("ix_trusted_devices_person", table_name="trusted_devices")
    op.drop_table("trusted_devices")
    op.drop_index("ix_totp_backup_codes_person", table_name="totp_backup_codes")
    op.drop_table("totp_backup_codes")
    op.drop_column("roles", "totp_required")
    op.drop_column("access_groups", "totp_required")
    op.drop_column("user_accounts", "totp_last_counter")
    op.drop_column("user_accounts", "totp_required")
```

- [ ] **Step 5: Models**

In `api/src/serversherpa/db/models.py`, `UserAccount`: after `totp_confirmed_at: Mapped[datetime | None]` add

```python
    totp_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    totp_last_counter: Mapped[int | None] = mapped_column(BigInteger)
```

`Role`: after `color: Mapped[str | None]` add

```python
    totp_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
```

`AccessGroup`: after `icon` add

```python
    totp_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
```

After the `AuthSession` class add:

```python
class TotpBackupCode(Base):
    """One-time recovery codes; only the Argon2 hash is stored."""

    __tablename__ = "totp_backup_codes"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_accounts.person_id", ondelete="CASCADE"))
    code_hash: Mapped[str]
    used_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class TrustedDevice(Base):
    """A browser that checked "Remember this browser" at 2FA time. The
    cookie token is stored as SHA-256 (pure randomness, like refresh
    tokens)."""

    __tablename__ = "trusted_devices"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_accounts.person_id", ondelete="CASCADE"))
    token_hash: Mapped[str]
    user_agent: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    last_used_at: Mapped[datetime | None]
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
```

- [ ] **Step 6: Config + env example + test key**

`api/src/serversherpa/config.py`, right after `totp_encryption_key: SecretStr`:

```python
    # "Remember this browser" at the 2FA step skips the code for this long.
    totp_trust_days: int = 7
```

`.env.example`, after `SS_LOCKOUT_SECONDS=900 …`:

```
SS_TOTP_TRUST_DAYS=7              # "Remember this browser" skips the 2FA code for this many days
```

`api/tests/conftest.py`, inside `_prepare_environment()` right after the `os.environ["SS_AI_ENABLED"] = "false"` line:

```python
    # 2FA tests need a real Fernet key regardless of what .env carries.
    from cryptography.fernet import Fernet

    os.environ["SS_TOTP_ENCRYPTION_KEY"] = Fernet.generate_key().decode()
    os.environ.setdefault("SS_TOTP_TRUST_DAYS", "7")
```

- [ ] **Step 7: Run the schema test**

Run the Step 3 command. Expected: 3 passed (conftest migrates the private DB to 0071).

- [ ] **Step 8: Run the neighboring suites to prove nothing regressed**

Run: same prefix, `tests/test_auth_hardening_api.py tests/test_account_mgmt.py tests/test_access_api.py tests/test_system_security_api.py tests/test_env_api.py -q`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add api/migrations/versions/0071_two_factor_auth.py api/src/serversherpa/db/models.py api/src/serversherpa/config.py .env.example api/pyproject.toml api/tests/conftest.py api/tests/test_totp_schema.py
git commit -m "feat(api): 2FA schema — policy flags, backup codes, trusted devices (migration 0071)"
```

---

### Task 2: TOTP service

**Files:**
- Create: `api/src/serversherpa/services/totp.py`
- Test: `api/tests/test_totp_service.py`

**Interfaces:**
- Consumes: Task 1 models; `hash_password`/`verify_password` from `security/passwords.py`; `audit` from `services/audit.py`; `AuthError` from `services/auth.py`; `read_section` from `system/config_store.py`.
- Produces (all used by Tasks 3–4):

```python
ISSUER = "ServerSherpa"; CHALLENGE_TTL_SECONDS = 300; BACKUP_CODE_COUNT = 8; BACKUP_CODE_LENGTH = 10
BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
@dataclass(frozen=True) class TotpPolicy: enabled: bool; required: bool
def encrypt_secret(secret: str) -> bytes
def decrypt_secret(blob: bytes) -> str
async def policy_for(db, account: UserAccount) -> TotpPolicy
async def backup_codes_remaining(db, person_id) -> int
async def begin_enrollment(db, account, *, actor_id, ip) -> tuple[str, str]      # (secret, otpauth_uri)
async def confirm_enrollment(db, account, code, *, actor_id, ip) -> list[str]  # plaintext backup codes
async def verify_code(db, account, code, *, ip) -> Literal["totp", "backup"]    # raises AuthError("totp_invalid") / ("account_locked")
async def regenerate_backup_codes(db, account, *, actor_id, ip) -> list[str]
async def reset(db, account, *, actor_id, ip) -> None
def make_challenge_token(person_id, purpose) -> str
def decode_challenge_token(token) -> tuple[uuid.UUID, str]                     # raises TokenError
async def issue_trust(db, account, *, user_agent, ip) -> str
async def check_trust(db, account, token) -> bool
async def revoke_trust(db, person_id) -> None
def format_backup_code(code: str) -> str                                        # "abcde-fghjk"
```

- [ ] **Step 1: Write the failing tests**

`api/tests/test_totp_service.py`:

```python
"""services/totp: secrets at rest, policy resolver, code verification with
replay guard, backup codes, trusted browsers, challenge tokens."""

import uuid
from datetime import UTC, datetime, timedelta

import pyotp
import pytest
from sqlalchemy import select, update

from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, PersonRole, Role, SystemConfig,
    TotpBackupCode, TrustedDevice, UserAccount,
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
```

- [ ] **Step 2: Run to see it fail**

Run: `… pytest tests/test_totp_service.py -v` (Global Constraints prefix). Expected: ImportError `serversherpa.services.totp`.

- [ ] **Step 3: Implement the service**

`api/src/serversherpa/services/totp.py`:

```python
"""Two-factor authentication (TOTP) service.

Owns everything about the second factor: the seed encrypted at rest
(Fernet, SS_TOTP_ENCRYPTION_KEY), code verification with a replay guard,
one-time backup codes (Argon2 hashes), trusted browsers (the ss_trust
cookie's token stored as SHA-256), the policy resolver, and the short-lived
challenge token the portal carries between the password step and the code
step. Routes never touch a secret directly.
"""

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

import jwt
import pyotp
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, PersonRole, Role, TotpBackupCode,
    TrustedDevice, UserAccount,
)
from serversherpa.security.passwords import hash_password, verify_password
from serversherpa.security.tokens import ISSUER as JWT_ISSUER, TokenError
from serversherpa.services.audit import audit
from serversherpa.services.auth import AuthError
from serversherpa.system.config_store import read_section

ISSUER = "ServerSherpa"
CHALLENGE_TTL_SECONDS = 300
BACKUP_CODE_COUNT = 8
BACKUP_CODE_LENGTH = 10
# no 0/1/i/l/o: the codes get read off a printout
BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
SECURITY_SECTION = "security"

Purpose = Literal["verify", "enroll"]


@dataclass(frozen=True)
class TotpPolicy:
    enabled: bool   # site master switch
    required: bool  # this account must use 2FA (implies enabled)


# ── secrets at rest ─────────────────────────────────────────────────

def _fernet() -> Fernet:
    key = get_settings().totp_encryption_key.get_secret_value()
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise RuntimeError("SS_TOTP_ENCRYPTION_KEY is not a valid Fernet key") from exc


def encrypt_secret(secret: str) -> bytes:
    return _fernet().encrypt(secret.encode())


def decrypt_secret(blob: bytes) -> str:
    try:
        return _fernet().decrypt(bytes(blob)).decode()
    except InvalidToken as exc:
        raise RuntimeError("stored TOTP seed does not decrypt with SS_TOTP_ENCRYPTION_KEY") from exc


# ── policy ──────────────────────────────────────────────────────────

async def policy_for(db: AsyncSession, account: UserAccount) -> TotpPolicy:
    cfg = await read_section(db, SECURITY_SECTION)
    if not cfg.get("two_factor_enabled"):
        return TotpPolicy(enabled=False, required=False)
    if cfg.get("two_factor_required") or account.totp_required:
        return TotpPolicy(enabled=True, required=True)
    group_hit = await db.scalar(
        select(AccessGroup.id)
        .join(AccessGroupMember, AccessGroupMember.group_id == AccessGroup.id)
        .where(AccessGroupMember.person_id == account.person_id,
               AccessGroup.totp_required.is_(True))
        .limit(1))
    if group_hit is not None:
        return TotpPolicy(enabled=True, required=True)
    role_hit = await db.scalar(
        select(Role.name)
        .join(PersonRole, PersonRole.role == Role.name)
        .where(PersonRole.person_id == account.person_id,
               PersonRole.revoked_at.is_(None),
               Role.totp_required.is_(True))
        .limit(1))
    return TotpPolicy(enabled=True, required=role_hit is not None)


# ── challenge tokens ────────────────────────────────────────────────

def make_challenge_token(person_id: uuid.UUID, purpose: Purpose) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {"iss": JWT_ISSUER, "sub": str(person_id), "purpose": purpose,
         "iat": now, "exp": now + timedelta(seconds=CHALLENGE_TTL_SECONDS),
         "typ": "totp"},
        get_settings().jwt_secret.get_secret_value(), algorithm="HS256")


def decode_challenge_token(token: str) -> tuple[uuid.UUID, str]:
    try:
        claims = jwt.decode(
            token, get_settings().jwt_secret.get_secret_value(), algorithms=["HS256"],
            issuer=JWT_ISSUER, options={"require": ["exp", "iat", "sub", "purpose"]},
            leeway=10)
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
    if claims.get("typ") != "totp" or claims["purpose"] not in ("verify", "enroll"):
        raise TokenError("wrong token type")
    return uuid.UUID(claims["sub"]), claims["purpose"]


# ── enrollment ──────────────────────────────────────────────────────

def _otp(secret: str) -> pyotp.TOTP:
    return pyotp.TOTP(secret, digits=6, interval=30)


async def begin_enrollment(
    db: AsyncSession, account: UserAccount, *, actor_id: uuid.UUID | None, ip: str | None,
) -> tuple[str, str]:
    """Mint a fresh seed (an unconfirmed one is simply replaced) and return
    (secret, otpauth URI). Commits."""
    if account.totp_confirmed_at is not None:
        raise AuthError("totp_already_enrolled")
    secret = pyotp.random_base32()
    account.totp_secret_enc = encrypt_secret(secret)
    account.totp_last_counter = None
    account.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor_id, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.enroll", ip=ip)
    await db.commit()
    uri = _otp(secret).provisioning_uri(name=account.email, issuer_name=ISSUER)
    return secret, uri


def _match_counter(secret: str, code: str, last_counter: int | None) -> int | None:
    """The time-step counter the code belongs to (±1 step of drift), or
    None when it matches nothing new. A counter at or below the last one
    accepted is a replay and also returns None."""
    otp = _otp(secret)
    base = otp.timecode(datetime.now(UTC))
    for offset in (0, -1, 1):
        counter = base + offset
        if hmac.compare_digest(otp.generate_otp(counter), code):
            if last_counter is not None and counter <= last_counter:
                return None
            return counter
    return None


async def confirm_enrollment(
    db: AsyncSession, account: UserAccount, code: str, *,
    actor_id: uuid.UUID | None, ip: str | None,
) -> list[str]:
    """First code from the app confirms the seed; returns the plaintext
    backup codes (shown once). Commits."""
    if account.totp_confirmed_at is not None:
        raise AuthError("totp_already_enrolled")
    if account.totp_secret_enc is None:
        raise AuthError("totp_not_started")
    counter = _match_counter(decrypt_secret(account.totp_secret_enc), _digits(code), None)
    if counter is None:
        await _record_failure(db, account, ip=ip)
        raise AuthError("totp_invalid")
    now = datetime.now(UTC)
    account.totp_confirmed_at = now
    account.totp_last_counter = counter
    account.updated_at = now
    await revoke_trust(db, account.person_id)
    codes = await _replace_backup_codes(db, account.person_id)
    audit(db, actor_id=actor_id, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.confirm", ip=ip)
    await db.commit()
    return codes


# ── verification ────────────────────────────────────────────────────

def _digits(code: str) -> str:
    return "".join(ch for ch in code if ch.isdigit())


def _normalize_backup(code: str) -> str:
    return "".join(ch for ch in code.lower() if ch.isalnum())


async def _record_failure(db: AsyncSession, account: UserAccount, *, ip: str | None) -> None:
    """Same counters as a wrong password: N strikes → temporary lockout."""
    settings = get_settings()
    now = datetime.now(UTC)
    account.failed_login_count += 1
    account.updated_at = now
    if account.failed_login_count >= settings.max_failed_logins:
        account.locked_until = now + timedelta(seconds=settings.lockout_seconds)
        account.failed_login_count = 0
    audit(db, actor_id=None, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.verify_failed", ip=ip)
    await db.commit()


async def verify_code(
    db: AsyncSession, account: UserAccount, code: str, *, ip: str | None,
) -> Literal["totp", "backup"]:
    """Accept a 6-digit app code (±1 step, no replays) or an unused backup
    code. Raises AuthError("account_locked") while locked out and
    AuthError("totp_invalid") otherwise; a failure counts toward lockout.
    Commits."""
    now = datetime.now(UTC)
    if account.locked_until is not None and account.locked_until > now:
        raise AuthError("account_locked")
    if account.totp_confirmed_at is None or account.totp_secret_enc is None:
        raise AuthError("totp_not_enrolled")

    digits = _digits(code)
    if len(digits) == 6 and digits == code.strip():
        counter = _match_counter(decrypt_secret(account.totp_secret_enc), digits,
                                 account.totp_last_counter)
        if counter is not None:
            account.totp_last_counter = counter
            account.failed_login_count = 0
            account.updated_at = now
            await db.commit()
            return "totp"
    else:
        wanted = _normalize_backup(code)
        pepper = get_settings().password_pepper.get_secret_value()
        if len(wanted) == BACKUP_CODE_LENGTH:
            rows = list(await db.scalars(select(TotpBackupCode).where(
                TotpBackupCode.person_id == account.person_id,
                TotpBackupCode.used_at.is_(None))))
            for row in rows:
                if verify_password(row.code_hash, wanted, pepper=pepper):
                    row.used_at = now
                    account.failed_login_count = 0
                    account.updated_at = now
                    audit(db, actor_id=account.person_id, entity_type="user_account",
                          entity_id=str(account.person_id), action="totp.backup_used", ip=ip)
                    await db.commit()
                    return "backup"
    await _record_failure(db, account, ip=ip)
    raise AuthError("totp_invalid")


# ── backup codes ────────────────────────────────────────────────────

def format_backup_code(code: str) -> str:
    return f"{code[:5]}-{code[5:]}"


def _new_backup_code() -> str:
    return "".join(secrets.choice(BACKUP_ALPHABET) for _ in range(BACKUP_CODE_LENGTH))


async def _replace_backup_codes(db: AsyncSession, person_id: uuid.UUID) -> list[str]:
    """Delete every existing code (used or not) and store a fresh set;
    returns the plaintext codes formatted for display. Does not commit."""
    pepper = get_settings().password_pepper.get_secret_value()
    for row in list(await db.scalars(select(TotpBackupCode).where(
            TotpBackupCode.person_id == person_id))):
        await db.delete(row)
    codes = [_new_backup_code() for _ in range(BACKUP_CODE_COUNT)]
    for code in codes:
        db.add(TotpBackupCode(person_id=person_id, code_hash=hash_password(code, pepper=pepper)))
    return [format_backup_code(c) for c in codes]


async def backup_codes_remaining(db: AsyncSession, person_id: uuid.UUID) -> int:
    rows = list(await db.scalars(select(TotpBackupCode.id).where(
        TotpBackupCode.person_id == person_id, TotpBackupCode.used_at.is_(None))))
    return len(rows)


async def regenerate_backup_codes(
    db: AsyncSession, account: UserAccount, *, actor_id: uuid.UUID | None, ip: str | None,
) -> list[str]:
    if account.totp_confirmed_at is None:
        raise AuthError("totp_not_enrolled")
    codes = await _replace_backup_codes(db, account.person_id)
    audit(db, actor_id=actor_id, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.codes_regenerated", ip=ip)
    await db.commit()
    return codes


# ── reset (admin / CLI) ─────────────────────────────────────────────

async def reset(
    db: AsyncSession, account: UserAccount, *, actor_id: uuid.UUID | None, ip: str | None,
) -> None:
    """Forget the seed, the backup codes and every trusted browser. The
    user enrolls again at their next sign-in if policy requires it. Does
    NOT commit — the caller owns the transaction."""
    account.totp_secret_enc = None
    account.totp_confirmed_at = None
    account.totp_last_counter = None
    account.updated_at = datetime.now(UTC)
    for row in list(await db.scalars(select(TotpBackupCode).where(
            TotpBackupCode.person_id == account.person_id))):
        await db.delete(row)
    await revoke_trust(db, account.person_id)
    audit(db, actor_id=actor_id, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.reset", ip=ip)


# ── trusted browsers ────────────────────────────────────────────────

def _hash_trust(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def issue_trust(
    db: AsyncSession, account: UserAccount, *, user_agent: str | None, ip: str | None,
) -> str:
    """Create a trusted-browser row and return the cookie token. Commits."""
    token = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    db.add(TrustedDevice(
        person_id=account.person_id, token_hash=_hash_trust(token),
        user_agent=user_agent, last_used_at=now,
        expires_at=now + timedelta(days=get_settings().totp_trust_days)))
    audit(db, actor_id=account.person_id, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.trust", ip=ip)
    await db.commit()
    return token


async def check_trust(db: AsyncSession, account: UserAccount, token: str | None) -> bool:
    if not token:
        return False
    now = datetime.now(UTC)
    row = await db.scalar(select(TrustedDevice).where(
        TrustedDevice.person_id == account.person_id,
        TrustedDevice.token_hash == _hash_trust(token)))
    if row is None or row.revoked_at is not None or row.expires_at <= now:
        return False
    row.last_used_at = now
    await db.commit()
    return True


async def revoke_trust(db: AsyncSession, person_id: uuid.UUID) -> None:
    """Does not commit."""
    await db.execute(
        update(TrustedDevice)
        .where(TrustedDevice.person_id == person_id, TrustedDevice.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC)))
```

- [ ] **Step 4: Run the service tests**

Run: `… pytest tests/test_totp_service.py -v`. Expected: 11 passed. If `provisioning_uri` encodes the `@` differently from `%40`, adjust the test's `startswith` to `urllib.parse.unquote(uri).startswith("otpauth://totp/ServerSherpa:alice@test.example.com?")`.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/services/totp.py api/tests/test_totp_service.py
git commit -m "feat(api): TOTP service — seeds at rest, replay-guarded verify, backup codes, trusted browsers, challenge tokens"
```

---

### Task 3: Login branches, `/auth/totp/*` routes, `totp` status block, public trust days

**Files:**
- Modify: `api/src/serversherpa/services/auth.py` (login L58-118)
- Modify: `api/src/serversherpa/api/schemas.py` (SessionOut L114-127, MeOut L129-139, SystemStatusOut L2057-2064; add TOTP schemas after MeOut)
- Modify: `api/src/serversherpa/api/deps.py` (add the challenge dependency at the end)
- Modify: `api/src/serversherpa/api/routes/auth.py`
- Modify: `api/src/serversherpa/api/routes/system.py` (`_status_from`, L90-100)
- Modify: `README.md` line 23 (security summary sentence)
- Test: `api/tests/test_totp_api.py`, extend `api/tests/test_system_security_api.py`

**Interfaces:**
- Consumes: Task 2 service.
- Produces:
  - `services.auth.LoginChallenge(purpose, account, backup_codes_remaining)`; `login()` returns `AuthResult | LoginChallenge` and takes `trust_token: str | None = None`.
  - Schemas: `TotpStatusOut(enrolled, enrolled_at, required, backup_codes_remaining)`; `SessionOut.status: Literal["ok"] = "ok"`, `SessionOut.totp: TotpStatusOut`, `MeOut.totp`; `LoginChallengeOut(status, challenge_token, backup_codes_remaining)`; `TotpVerifyIn(code, remember=False)`; `TotpEnrollStartOut(secret, otpauth_uri)`; `TotpEnrollConfirmIn(code, remember=False)`; `TotpEnrollConfirmOut(backup_codes, session: SessionOut | None)`; `TotpRegenerateIn(code)`; `BackupCodesOut(backup_codes)`; `SystemStatusOut.totp_trust_days: int`.
  - deps: `TotpActor(account, purpose, user)` + `TotpChallengeOrUser = Annotated[TotpActor, Depends(totp_actor)]`.
  - routes/auth: `TRUST_COOKIE = "ss_trust"`, `async def totp_status_out(db, account) -> TotpStatusOut`, `session_response(result, response, totp)`.

- [ ] **Step 1: Write the failing API tests**

`api/tests/test_totp_api.py`:

```python
"""2FA over HTTP: login branches, challenge tokens, verify, enrollment,
trusted browsers, kiosk exemption, the totp block on /auth/me."""

from datetime import UTC, datetime, timedelta

import pyotp
from sqlalchemy import select

from serversherpa.db.models import AuthSession, SystemConfig, TrustedDevice, UserAccount
from serversherpa.services import totp as totp_service

EMAIL = "alice@test.example.com"
PW = "CorrectHorse9!"


async def _security(db, **flags):
    row = await db.get(SystemConfig, "security")
    if row is None:
        row = SystemConfig(section="security", data={})
        db.add(row)
    row.data = {"two_factor_enabled": False, "two_factor_required": False, **flags}
    await db.commit()


async def _login(client, email=EMAIL, password=PW, **extra):
    return await client.post("/auth/login", json={"email": email, "password": password, **extra})


async def _enroll_direct(db, person_id):
    account = await db.get(UserAccount, person_id)
    secret, _ = await totp_service.begin_enrollment(db, account, actor_id=None, ip=None)
    codes = await totp_service.confirm_enrollment(
        db, account, pyotp.TOTP(secret).now(), actor_id=None, ip=None)
    return secret, codes


def _next_code(secret, seconds=30):
    return pyotp.TOTP(secret).at(datetime.now(UTC) + timedelta(seconds=seconds))


# ── login branches ──────────────────────────────────────────────────

async def test_switch_off_never_challenges_even_when_enrolled(client, db, seeded_user):
    await _enroll_direct(db, seeded_user.id)
    resp = await _login(client)
    assert resp.status_code == 200 and resp.json()["status"] == "ok"
    assert resp.json()["totp"]["enrolled"] is True
    assert "ss_refresh" in resp.cookies


async def test_enrolled_user_gets_verify_challenge_no_session(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    await _enroll_direct(db, seeded_user.id)
    resp = await _login(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "totp_verify" and body["challenge_token"]
    assert body["backup_codes_remaining"] == 8
    assert "ss_refresh" not in resp.cookies and "access_token" not in body
    assert (await db.scalar(select(AuthSession).where(
        AuthSession.person_id == seeded_user.id))) is None


async def test_required_unenrolled_user_gets_enroll_challenge(client, db, seeded_user):
    await _security(db, two_factor_enabled=True, two_factor_required=True)
    resp = await _login(client)
    assert resp.json()["status"] == "totp_enroll"


async def test_not_required_unenrolled_user_gets_session(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    resp = await _login(client)
    assert resp.json()["status"] == "ok"
    assert resp.json()["totp"] == {"enrolled": False, "enrolled_at": None,
                                   "required": False, "backup_codes_remaining": 0}


async def test_kiosk_client_is_never_challenged(client, db, seeded_user):
    from serversherpa.db.models import RolePermission

    has_kiosk = await db.scalar(select(RolePermission).where(
        RolePermission.role == "staff", RolePermission.resource == "kiosk",
        RolePermission.action == "view"))
    if has_kiosk is None:
        db.add(RolePermission(role="staff", resource="kiosk", action="view"))
        await db.commit()
    await _security(db, two_factor_enabled=True, two_factor_required=True)
    await _enroll_direct(db, seeded_user.id)
    resp = await _login(client, client="kiosk")
    assert resp.status_code == 200 and resp.json()["status"] == "ok"


async def test_wrong_password_still_401_when_enrolled(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    await _enroll_direct(db, seeded_user.id)
    resp = await _login(client, password="nope")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "invalid_credentials"


# ── verify ──────────────────────────────────────────────────────────

async def _challenge(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    secret, codes = await _enroll_direct(db, seeded_user.id)
    token = (await _login(client)).json()["challenge_token"]
    return secret, codes, token


async def test_verify_right_code_mints_session(client, db, seeded_user):
    secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": _next_code(secret)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok" and body["access_token"]
    assert "ss_refresh" in resp.cookies and "ss_trust" not in resp.cookies
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200 and me.json()["totp"]["enrolled"] is True


async def test_verify_wrong_code_401_and_counts_toward_lockout(client, db, seeded_user):
    _secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": "000000"})
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "totp_invalid"
    account = await db.get(UserAccount, seeded_user.id)
    await db.refresh(account)
    assert account.failed_login_count == 1


async def test_verify_with_backup_code(client, db, seeded_user):
    _secret, codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": codes[3]})
    assert resp.status_code == 200 and resp.json()["totp"]["backup_codes_remaining"] == 7


async def test_remember_sets_trust_cookie_and_next_login_skips_code(client, db, seeded_user):
    secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": _next_code(secret), "remember": True})
    assert resp.status_code == 200 and "ss_trust" in resp.cookies
    trust = resp.cookies["ss_trust"]
    # a fresh login on the same browser (the client jar now holds ss_trust): no challenge
    again = await client.post("/auth/login", json={"email": EMAIL, "password": PW})
    assert again.json()["status"] == "ok"
    # and without the cookie: challenged
    client.cookies.clear()
    bare = await client.post("/auth/login", json={"email": EMAIL, "password": PW})
    assert bare.json()["status"] == "totp_verify"
    # an expired trust row no longer helps
    row = await db.scalar(select(TrustedDevice).where(TrustedDevice.person_id == seeded_user.id))
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    client.cookies.set("ss_trust", trust, domain="testserver", path="/auth")
    stale = await client.post("/auth/login", json={"email": EMAIL, "password": PW})
    assert stale.json()["status"] == "totp_verify"


async def test_challenge_token_is_not_an_access_token(client, db, seeded_user):
    _secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401


async def test_forged_expired_and_wrong_purpose_tokens_401(client, db, seeded_user):
    secret, _codes, token = await _challenge(client, db, seeded_user)
    bad = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token + "x"},
                            json={"code": _next_code(secret)})
    assert bad.status_code == 401 and bad.json()["detail"]["code"] == "invalid_challenge"
    enroll_tok = totp_service.make_challenge_token(seeded_user.id, "enroll")
    wrong = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": enroll_tok},
                              json={"code": _next_code(secret)})
    assert wrong.status_code == 401 and wrong.json()["detail"]["code"] == "invalid_challenge"
    missing = await client.post("/auth/totp/verify", json={"code": "123456"})
    assert missing.status_code == 401 and missing.json()["detail"]["code"] == "missing_token"


# ── enrollment via challenge (forced at login) ──────────────────────

async def test_forced_enrollment_flow_mints_session(client, db, seeded_user):
    await _security(db, two_factor_enabled=True, two_factor_required=True)
    token = (await _login(client)).json()["challenge_token"]
    hdrs = {"X-Totp-Challenge": token}
    start = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert start.status_code == 200, start.text
    secret = start.json()["secret"]
    assert start.json()["otpauth_uri"].startswith("otpauth://totp/ServerSherpa:")
    # a second start replaces the pending seed
    start2 = await client.post("/auth/totp/enroll/start", headers=hdrs)
    secret = start2.json()["secret"]
    bad = await client.post("/auth/totp/enroll/confirm", headers=hdrs, json={"code": "000000"})
    assert bad.status_code == 401 and bad.json()["detail"]["code"] == "totp_invalid"
    good = await client.post("/auth/totp/enroll/confirm", headers=hdrs,
                             json={"code": pyotp.TOTP(secret).now(), "remember": True})
    assert good.status_code == 200, good.text
    body = good.json()
    assert len(body["backup_codes"]) == 8
    assert body["session"]["status"] == "ok" and body["session"]["totp"]["enrolled"] is True
    assert "ss_refresh" in good.cookies and "ss_trust" in good.cookies
    # the challenge token is spent: the account is enrolled now
    spent = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert spent.status_code == 401 and spent.json()["detail"]["code"] == "invalid_challenge"


async def test_verify_challenge_cannot_enroll(client, db, seeded_user):
    _secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/enroll/start", headers={"X-Totp-Challenge": token})
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "invalid_challenge"


# ── enrollment via session (My Profile) ─────────────────────────────

async def test_self_service_enrollment_no_new_session(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    login = await _login(client)
    hdrs = {"Authorization": f"Bearer {login.json()['access_token']}"}
    start = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert start.status_code == 200, start.text
    secret = start.json()["secret"]
    good = await client.post("/auth/totp/enroll/confirm", headers=hdrs,
                             json={"code": pyotp.TOTP(secret).now()})
    assert good.status_code == 200 and good.json()["session"] is None
    assert "ss_refresh" not in good.cookies
    me = await client.get("/auth/me", headers=hdrs)
    assert me.json()["totp"]["enrolled"] is True
    again = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert again.status_code == 409 and again.json()["detail"]["code"] == "totp_already_enrolled"


async def test_enrollment_refused_when_switch_off(client, db, seeded_user):
    login = await _login(client)
    hdrs = {"Authorization": f"Bearer {login.json()['access_token']}"}
    resp = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "totp_disabled"


async def test_regenerate_needs_a_current_code(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    secret, codes = await _enroll_direct(db, seeded_user.id)
    token = (await _login(client)).json()["challenge_token"]
    sess = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": _next_code(secret)})
    hdrs = {"Authorization": f"Bearer {sess.json()['access_token']}"}
    bad = await client.post("/auth/totp/backup-codes/regenerate", headers=hdrs,
                            json={"code": "000000"})
    assert bad.status_code == 401
    good = await client.post("/auth/totp/backup-codes/regenerate", headers=hdrs,
                             json={"code": _next_code(secret, 60)})
    assert good.status_code == 200 and len(good.json()["backup_codes"]) == 8
    assert not set(good.json()["backup_codes"]) & set(codes)
```

Append to `api/tests/test_system_security_api.py`:

```python
async def test_public_status_reports_trust_days(client):
    resp = await client.get("/system/status")
    assert resp.status_code == 200
    assert resp.json()["totp_trust_days"] == 7
```

- [ ] **Step 2: Run to see them fail**

Run: `… pytest tests/test_totp_api.py tests/test_system_security_api.py -v`. Expected: failures (no `status` field, 404 on `/auth/totp/*`).

- [ ] **Step 3: Schemas**

In `api/src/serversherpa/api/schemas.py` add `Literal` to the `typing` import if missing, then replace `SessionOut` and `MeOut` and add the TOTP schemas:

```python
class TotpStatusOut(BaseModel):
    enrolled: bool
    enrolled_at: datetime | None
    required: bool                # by user flag, group, role or site policy
    backup_codes_remaining: int


class SessionOut(BaseModel):
    status: Literal["ok"] = "ok"
    access_token: str
    token_type: str = "bearer"
    expires_in: int              # access-token TTL, seconds
    session_expires_at: datetime  # absolute end of the login (24h rule)
    person: PersonOut
    roles: list[str]
    must_change_password: bool
    preferences: UiPreferences
    perms: dict[str, dict[str, bool]]
    max_rank: int
    scope: ScopeOut
    password_min_length: int = 8
    totp: TotpStatusOut


class LoginChallengeOut(BaseModel):
    """Password accepted; the second factor is still owed. No session or
    cookie exists yet — only the 2FA endpoints accept the token."""

    status: Literal["totp_verify", "totp_enroll"]
    challenge_token: str
    backup_codes_remaining: int | None = None


class MeOut(BaseModel):
    person: PersonOut
    roles: list[str]
    session_expires_at: datetime
    must_change_password: bool
    preferences: UiPreferences
    perms: dict[str, dict[str, bool]]
    max_rank: int
    scope: ScopeOut
    password_min_length: int = 8
    totp: TotpStatusOut


class TotpVerifyIn(BaseModel):
    code: str = Field(min_length=6, max_length=16)
    remember: bool = False


class TotpEnrollStartOut(BaseModel):
    secret: str
    otpauth_uri: str


class TotpEnrollConfirmIn(BaseModel):
    code: str = Field(min_length=6, max_length=8)
    remember: bool = False


class BackupCodesOut(BaseModel):
    backup_codes: list[str]


class TotpEnrollConfirmOut(BackupCodesOut):
    session: SessionOut | None = None   # set only on the forced-at-login path


class TotpRegenerateIn(BaseModel):
    code: str = Field(min_length=6, max_length=8)
```

`SystemStatusOut` gains `totp_trust_days: int`.

- [ ] **Step 4: Login service**

In `api/src/serversherpa/services/auth.py` add after `AuthResult`:

```python
@dataclass
class LoginChallenge:
    """Password accepted; a second factor is owed before any session exists."""

    purpose: str                        # "verify" | "enroll"
    account: UserAccount
    backup_codes_remaining: int | None
```

Change `login()`'s signature and body: add `trust_token: str | None = None` after `client`, return type `AuthResult | LoginChallenge`, and replace the `if account.totp_confirmed_at is not None: … raise AuthError("totp_required")` block with:

```python
    if client == "portal":
        # kiosk password logins and phone pairing are never challenged
        from serversherpa.services import totp as totp_service

        policy = await totp_service.policy_for(db, account)
        if policy.enabled:
            if account.totp_confirmed_at is not None:
                if not await totp_service.check_trust(db, account, trust_token):
                    return LoginChallenge(
                        purpose="verify", account=account,
                        backup_codes_remaining=await totp_service.backup_codes_remaining(
                            db, account.person_id))
            elif policy.required:
                return LoginChallenge(purpose="enroll", account=account,
                                      backup_codes_remaining=None)
```

(The local import avoids a circular import: `services/totp.py` imports `AuthError` from this module.)

- [ ] **Step 5: Challenge dependency**

Append to `api/src/serversherpa/api/deps.py` (add `Header` to the fastapi import and `joinedload` is already imported):

```python
@dataclass
class TotpActor:
    """Who is calling a 2FA endpoint: a half-signed-in challenge holder
    (purpose "verify"/"enroll", no session) or a signed-in user (purpose
    None)."""

    account: UserAccount
    purpose: str | None
    user: AuthContext | None


async def totp_actor(
    request: Request,
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    x_totp_challenge: Annotated[str | None, Header()] = None,
) -> TotpActor:
    if x_totp_challenge:
        from serversherpa.services.totp import decode_challenge_token

        try:
            person_id, purpose = decode_challenge_token(x_totp_challenge)
        except TokenError:
            raise _unauthorized("invalid_challenge") from None
        account = await db.scalar(
            select(UserAccount).options(joinedload(UserAccount.person))
            .where(UserAccount.person_id == person_id))
        if (account is None or account.disabled_at is not None
                or account.person.archived_at is not None):
            raise _unauthorized("account_disabled")
        # the token must still describe the account: an enroll token is
        # spent once enrolled, a verify token is void once reset
        enrolled = account.totp_confirmed_at is not None
        if (purpose == "verify") != enrolled:
            raise _unauthorized("invalid_challenge")
        return TotpActor(account=account, purpose=purpose, user=None)
    if credentials is None:
        raise _unauthorized("missing_token")
    user = await authenticate_token(db, credentials.credentials)
    enforce_forced_password_change(request, user)
    await enforce_read_only(db, request, user)
    return TotpActor(account=user.account, purpose=None, user=user)


TotpChallengeOrUser = Annotated[TotpActor, Depends(totp_actor)]
```

Also add `"/auth/totp/verify", "/auth/totp/enroll/start", "/auth/totp/enroll/confirm", "/auth/totp/backup-codes/regenerate"` to `READ_ONLY_EXEMPT_PATHS` (sign-in lifecycle; forced enrollment must work during a freeze) — they then flow into `FORCED_CHANGE_EXEMPT_PATHS` automatically, which is right: a temp-password user who is required to enroll must be able to.

- [ ] **Step 6: Routes**

Rewrite the relevant parts of `api/src/serversherpa/api/routes/auth.py`:

```python
from fastapi import APIRouter, Cookie, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import CurrentUser, DbSession, TotpChallengeOrUser, client_ip
from serversherpa.api.schemas import (
    BackupCodesOut, LoginChallengeOut, LoginIn, MeOut, PersonOut, ScopeOut, SessionOut,
    TotpEnrollConfirmIn, TotpEnrollConfirmOut, TotpEnrollStartOut, TotpRegenerateIn,
    TotpStatusOut, TotpVerifyIn, UiPreferences,
)
from serversherpa.db.models import UserAccount
from serversherpa.services import totp as totp_service
from serversherpa.services.auth import AuthError, AuthResult, LoginChallenge
```

Constants and cookie helpers:

```python
REFRESH_COOKIE = "ss_refresh"
TRUST_COOKIE = "ss_trust"

_STATUS = {"account_locked": 423, "kiosk_not_allowed": 403,
           "totp_already_enrolled": 409, "totp_disabled": 409, "totp_not_started": 409}


def _set_trust_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        TRUST_COOKIE, token,
        max_age=settings.totp_trust_days * 86_400,
        httponly=True, secure=settings.env != "development", samesite="lax",
        domain=settings.cookie_domain or None, path="/auth")


async def totp_status_out(db: AsyncSession, account: UserAccount) -> TotpStatusOut:
    policy = await totp_service.policy_for(db, account)
    return TotpStatusOut(
        enrolled=account.totp_confirmed_at is not None,
        enrolled_at=account.totp_confirmed_at,
        required=policy.required,
        backup_codes_remaining=await totp_service.backup_codes_remaining(db, account.person_id))


def session_response(result: AuthResult, response: Response, totp: TotpStatusOut) -> SessionOut:
    _set_refresh_cookie(response, result)
    return SessionOut(
        access_token=result.access_token,
        expires_in=get_settings().access_token_ttl_seconds,
        session_expires_at=result.session_expires_at,
        person=person_out(result.person),
        roles=result.roles,
        must_change_password=result.account.must_change_password,
        preferences=UiPreferences.model_validate(result.account.ui_prefs or {}),
        perms=result.access.perms,
        max_rank=result.access.max_rank,
        scope=_scope_out(result.access),
        password_min_length=get_settings().password_min_length,
        totp=totp,
    )
```

Login and refresh:

```python
@router.post("/login", response_model=SessionOut | LoginChallengeOut)
async def login(
    body: LoginIn, request: Request, response: Response, db: DbSession,
    ss_trust: Annotated[str | None, Cookie()] = None,
) -> SessionOut | LoginChallengeOut:
    try:
        result = await auth_service.login(
            db, email=body.email, password=body.password,
            ip=client_ip(request), user_agent=request.headers.get("user-agent"),
            client=body.client, trust_token=ss_trust,
        )
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    if isinstance(result, LoginChallenge):
        return LoginChallengeOut(
            status="totp_verify" if result.purpose == "verify" else "totp_enroll",
            challenge_token=totp_service.make_challenge_token(
                result.account.person_id, result.purpose),
            backup_codes_remaining=result.backup_codes_remaining)
    return session_response(result, response, await totp_status_out(db, result.account))
```

`refresh` keeps its body but ends with `return session_response(result, response, await totp_status_out(db, result.account))`. `me` adds `totp=await totp_status_out(db, user.account)` (add `db: DbSession` to its parameters).

TOTP routes (append):

```python
# ── two-factor ──────────────────────────────────────────────────────

async def _finish_challenge(
    db: AsyncSession, actor, request: Request, response: Response, *, remember: bool,
) -> SessionOut:
    """The second factor passed on a challenge: mint the real session and,
    when asked, remember this browser."""
    ip = client_ip(request)
    ua = request.headers.get("user-agent")
    result = await auth_service.start_session(db, actor.account, ip=ip, user_agent=ua)
    if remember:
        _set_trust_cookie(response, await totp_service.issue_trust(
            db, actor.account, user_agent=ua, ip=ip))
    return session_response(result, response, await totp_status_out(db, actor.account))


@router.post("/totp/verify", response_model=SessionOut)
async def totp_verify(
    body: TotpVerifyIn, request: Request, response: Response, db: DbSession,
    actor: TotpChallengeOrUser,
) -> SessionOut:
    if actor.purpose != "verify":
        raise HTTPException(status_code=401, detail={"code": "invalid_challenge"})
    try:
        await totp_service.verify_code(db, actor.account, body.code, ip=client_ip(request))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return await _finish_challenge(db, actor, request, response, remember=body.remember)


async def _enrollment_allowed(db: AsyncSession, actor) -> None:
    if actor.purpose == "verify":
        raise HTTPException(status_code=401, detail={"code": "invalid_challenge"})
    if actor.purpose is None and not (await totp_service.policy_for(db, actor.account)).enabled:
        raise HTTPException(status_code=409, detail={"code": "totp_disabled"})


@router.post("/totp/enroll/start", response_model=TotpEnrollStartOut)
async def totp_enroll_start(
    request: Request, db: DbSession, actor: TotpChallengeOrUser,
) -> TotpEnrollStartOut:
    await _enrollment_allowed(db, actor)
    try:
        secret, uri = await totp_service.begin_enrollment(
            db, actor.account, actor_id=actor.account.person_id, ip=client_ip(request))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return TotpEnrollStartOut(secret=secret, otpauth_uri=uri)


@router.post("/totp/enroll/confirm", response_model=TotpEnrollConfirmOut)
async def totp_enroll_confirm(
    body: TotpEnrollConfirmIn, request: Request, response: Response, db: DbSession,
    actor: TotpChallengeOrUser,
) -> TotpEnrollConfirmOut:
    await _enrollment_allowed(db, actor)
    try:
        codes = await totp_service.confirm_enrollment(
            db, actor.account, body.code, actor_id=actor.account.person_id,
            ip=client_ip(request))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    session = None
    if actor.purpose == "enroll":
        session = await _finish_challenge(db, actor, request, response, remember=body.remember)
    return TotpEnrollConfirmOut(backup_codes=codes, session=session)


@router.post("/totp/backup-codes/regenerate", response_model=BackupCodesOut)
async def totp_regenerate(
    body: TotpRegenerateIn, request: Request, db: DbSession, user: CurrentUser,
) -> BackupCodesOut:
    ip = client_ip(request)
    try:
        await totp_service.verify_code(db, user.account, body.code, ip=ip)
        codes = await totp_service.regenerate_backup_codes(
            db, user.account, actor_id=user.person.id, ip=ip)
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return BackupCodesOut(backup_codes=codes)
```

`api/src/serversherpa/api/routes/system.py` `_status_from`: add `totp_trust_days=get_settings().totp_trust_days` (import `get_settings` from `serversherpa.config` if not already imported).

`README.md` line 23: change "TOTP seeds encrypted at rest" to "TOTP two-factor (authenticator apps, backup codes, remembered browsers) with seeds encrypted at rest".

- [ ] **Step 7: Kiosk pairing and other `session_response` callers**

`grep -rn "session_response(" api/src` — every caller (kiosk pairing claim in `routes/kiosk.py`, possibly `routes/me.py`) must pass `await totp_status_out(db, account)` as the third argument. Fix them all; run `… pytest tests/test_kiosk_setup_api.py tests/test_me_api.py -q` to prove it.

- [ ] **Step 8: Run the new tests and the auth neighbors**

Run: `… pytest tests/test_totp_api.py tests/test_system_security_api.py tests/test_auth_hardening_api.py tests/test_account_mgmt.py tests/test_me_api.py tests/test_kiosk_setup_api.py tests/test_rate_limit_ip.py -v`
Expected: all pass. The httpx `AsyncClient` keeps cookies between calls (the trust test relies on that, then clears and re-sets the jar explicitly).

- [ ] **Step 9: Commit**

```bash
git add api/src/serversherpa/services/auth.py api/src/serversherpa/api api/tests/test_totp_api.py api/tests/test_system_security_api.py README.md
git commit -m "feat(api): 2FA login challenge, /auth/totp verify + enrollment, trusted-browser cookie, totp status on sessions"
```

---

### Task 4: Admin surface — user reset/require, group and role flags, user detail, CLI

**Files:**
- Modify: `api/src/serversherpa/api/routes/users.py` (imports; `UserDetailAccount(...)` build L279-283; add two routes after `unlock_account` L575-587; `revoke_all_user_sessions` L655-666)
- Modify: `api/src/serversherpa/api/schemas.py` (`UserDetailAccount` L681-687; add `TotpRequiredIn`)
- Modify: `api/src/serversherpa/api/routes/access.py` (summary L84-99; add `PATCH /groups/{id}` and `PATCH /roles/{name}`)
- Modify: `api/src/serversherpa/cli.py` (add `reset_totp` after `set_password`)
- Test: `api/tests/test_totp_admin_api.py`

**Interfaces:**
- Produces: `POST /users/{id}/totp/reset` (204), `PUT /users/{id}/totp-required` body `{ "required": bool }` (204), `UserDetailAccount.totp_enrolled / totp_enrolled_at / totp_required / totp_effective_required`, `PATCH /access/groups/{group_id}` body `{ "totp_required": bool }` → `{id, name, totp_required}`, `PATCH /access/roles/{name}` body `{ "totp_required": bool }` → `{name, totp_required}`, summary `roles[].totp_required` and `groups[].totp_required`, CLI `serversherpa reset-totp --email`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_totp_admin_api.py`:

```python
"""Admin 2FA: reset, per-user requirement, group/role flags, detail fields,
trusted browsers revoked with sessions, CLI reset."""

import pyotp
from sqlalchemy import select

from serversherpa.db.models import AccessGroup, AuditLog, TrustedDevice, UserAccount
from serversherpa.services import totp as totp_service
from tests.test_status_values_write import _make
from tests.test_sites_api import login


async def _admin(db, client):
    return await _make(db, client, "super_admin", "totp-admin@test.example.com")


async def _enroll(db, person_id):
    account = await db.get(UserAccount, person_id)
    secret, _ = await totp_service.begin_enrollment(db, account, actor_id=None, ip=None)
    await totp_service.confirm_enrollment(
        db, account, pyotp.TOTP(secret).now(), actor_id=None, ip=None)
    await totp_service.issue_trust(db, account, user_agent=None, ip=None)
    return account


async def test_detail_reports_totp_fields(client, db, seeded_user):
    hdrs = await _admin(db, client)
    body = (await client.get(f"/users/{seeded_user.id}", headers=hdrs)).json()
    assert body["account"]["totp_enrolled"] is False
    assert body["account"]["totp_required"] is False
    assert body["account"]["totp_effective_required"] is False
    await _enroll(db, seeded_user.id)
    body = (await client.get(f"/users/{seeded_user.id}", headers=hdrs)).json()
    assert body["account"]["totp_enrolled"] is True and body["account"]["totp_enrolled_at"]


async def test_require_flag_and_reset(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put(f"/users/{seeded_user.id}/totp-required", headers=hdrs,
                            json={"required": True})
    assert resp.status_code == 204, resp.text
    account = await db.get(UserAccount, seeded_user.id)
    await db.refresh(account)
    assert account.totp_required is True

    await _enroll(db, seeded_user.id)
    resp = await client.post(f"/users/{seeded_user.id}/totp/reset", headers=hdrs)
    assert resp.status_code == 204, resp.text
    await db.refresh(account)
    assert account.totp_secret_enc is None and account.totp_confirmed_at is None
    live = list(await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == seeded_user.id, TrustedDevice.revoked_at.is_(None))))
    assert live == []
    actions = [r.action for r in await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "user_account", AuditLog.entity_id == str(seeded_user.id)))]
    assert "totp.required_set" in actions and "totp.reset" in actions


async def test_reset_and_require_respect_permission_and_rank(client, db, seeded_user):
    staff = await login(client)  # alice: staff, no users:change
    assert (await client.post(f"/users/{seeded_user.id}/totp/reset", headers=staff)).status_code == 403
    admin = await _make(db, client, "admin", "totp-admin2@test.example.com")
    boss = await _make(db, client, "super_admin", "totp-boss@test.example.com")
    boss_id = (await client.get("/auth/me", headers=boss)).json()["person"]["id"]
    resp = await client.post(f"/users/{boss_id}/totp/reset", headers=admin)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "rank_too_low"


async def test_revoke_all_sessions_also_forgets_trusted_browsers(client, db, seeded_user):
    hdrs = await _admin(db, client)
    await _enroll(db, seeded_user.id)
    resp = await client.post(f"/users/{seeded_user.id}/sessions/revoke-all", headers=hdrs)
    assert resp.status_code == 204
    live = list(await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == seeded_user.id, TrustedDevice.revoked_at.is_(None))))
    assert live == []


async def test_group_and_role_flags_flow_into_policy(client, db, seeded_user):
    hdrs = await _admin(db, client)
    from serversherpa.db.models import SystemConfig
    db.add(SystemConfig(section="security", data={"two_factor_enabled": True,
                                                   "two_factor_required": False}))
    group = AccessGroup(name="Finance")
    db.add(group)
    await db.commit()

    resp = await client.patch(f"/access/groups/{group.id}", headers=hdrs,
                              json={"totp_required": True})
    assert resp.status_code == 200 and resp.json()["totp_required"] is True
    resp = await client.put(f"/access/groups/{group.id}/members", headers=hdrs,
                            json={"person_ids": [str(seeded_user.id)]})
    assert resp.status_code == 200, resp.text
    detail = (await client.get(f"/users/{seeded_user.id}", headers=hdrs)).json()
    assert detail["account"]["totp_effective_required"] is True

    summary = (await client.get("/access/summary", headers=hdrs)).json()
    assert next(g for g in summary["groups"] if g["name"] == "Finance")["totp_required"] is True
    assert all("totp_required" in r for r in summary["roles"])

    resp = await client.patch(f"/access/groups/{group.id}", headers=hdrs,
                              json={"totp_required": False})
    assert resp.json()["totp_required"] is False
    resp = await client.patch("/access/roles/staff", headers=hdrs, json={"totp_required": True})
    assert resp.status_code == 200 and resp.json() == {"name": "staff", "totp_required": True}
    detail = (await client.get(f"/users/{seeded_user.id}", headers=hdrs)).json()
    assert detail["account"]["totp_effective_required"] is True

    # rank rule: an admin cannot flag a role at or above their rank
    admin = await _make(db, client, "admin", "totp-admin3@test.example.com")
    resp = await client.patch("/access/roles/super_admin", headers=admin, json={"totp_required": True})
    assert resp.status_code == 403


# typer's CliRunner would call asyncio.run() inside the already-running test
# loop, so the command is checked by registration and the service call it
# wraps is exercised directly.
async def test_cli_reset_totp_command_exists_and_service_resets(db, seeded_user):
    from serversherpa.cli import app

    names = {c.name for c in app.registered_commands}
    assert "reset-totp" in names or "reset_totp" in names
    account = await _enroll(db, seeded_user.id)
    await totp_service.reset(db, account, actor_id=None, ip=None)
    await db.commit()
    await db.refresh(account)
    assert account.totp_confirmed_at is None
```

- [ ] **Step 2: Run to see them fail**

Run: `… pytest tests/test_totp_admin_api.py -v`. Expected: failures (missing fields / 404s).

- [ ] **Step 3: Schemas**

`UserDetailAccount` becomes:

```python
class UserDetailAccount(BaseModel):
    login_email: str | None
    status: str                          # active | locked | disabled
    must_change_password: bool
    last_login_at: datetime | None
    created_at: datetime
    password_updated_at: datetime | None
    totp_enrolled: bool
    totp_enrolled_at: datetime | None
    totp_required: bool                  # the per-user flag only
    totp_effective_required: bool        # user flag OR group OR role OR site policy


class TotpRequiredIn(BaseModel):
    required: bool
```

- [ ] **Step 4: Users routes**

In `routes/users.py` import `TotpRequiredIn` and `from serversherpa.services import totp as totp_service`. In `get_user_detail`, before the `return UserDetailOut(` add `policy = await totp_service.policy_for(db, account)` and extend the account block:

```python
        account=UserDetailAccount(
            login_email=account.email, status=_status(account, now),
            must_change_password=account.must_change_password,
            last_login_at=account.last_login_at, created_at=account.created_at,
            password_updated_at=account.password_updated_at,
            totp_enrolled=account.totp_confirmed_at is not None,
            totp_enrolled_at=account.totp_confirmed_at,
            totp_required=account.totp_required,
            totp_effective_required=policy.required),
```

Add after `unlock_account`:

```python
@router.post("/{person_id}/totp/reset", status_code=204)
async def reset_totp(
    person_id: uuid.UUID,
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("users", "change"),
) -> None:
    """Forget their authenticator, backup codes and trusted browsers; they
    enroll again at their next sign-in if policy requires it."""
    _, account, _ = await _load_target(db, actor, person_id)
    await totp_service.reset(db, account, actor_id=actor.person.id, ip=client_ip(request))
    await db.commit()


@router.put("/{person_id}/totp-required", status_code=204)
async def set_totp_required(
    person_id: uuid.UUID,
    body: TotpRequiredIn,
    db: DbSession,
    actor: AuthContext = require_permission("users", "change"),
) -> None:
    _, account, _ = await _load_target(db, actor, person_id)
    if account.totp_required != body.required:
        audit(db, actor_id=actor.person.id, entity_type="user_account",
              entity_id=str(person_id), action="totp.required_set",
              changes={"totp_required": {"from": account.totp_required, "to": body.required}})
        account.totp_required = body.required
        account.updated_at = datetime.now(UTC)
    await db.commit()
```

(`Request` from fastapi and `client_ip` from deps join the imports.) In `revoke_all_user_sessions`, after `_revoke_all_sessions(...)` add `await totp_service.revoke_trust(db, person_id)`.

- [ ] **Step 5: Access routes**

In `routes/access.py` add to the summary dicts: roles → `"totp_required": r.totp_required,`; groups → `"totp_required": g.totp_required,`. Add after `delete_group`:

```python
class TotpFlagIn(BaseModel):
    totp_required: bool


@router.patch("/groups/{group_id}")
async def patch_group(
    group_id: uuid.UUID,
    body: TotpFlagIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    group = await db.get(AccessGroup, group_id)
    if group is None:
        raise _err(404, "group_not_found")
    if group.totp_required != body.totp_required:
        audit(db, actor_id=actor.person.id, entity_type="access_group",
              entity_id=str(group_id), action="group.update",
              changes={"totp_required": {"from": group.totp_required, "to": body.totp_required}})
        group.totp_required = body.totp_required
    await db.commit()
    return {"id": str(group.id), "name": group.name, "totp_required": group.totp_required}


@router.patch("/roles/{name}")
async def patch_role(
    name: str,
    body: TotpFlagIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    role = await _load_role_for_edit(db, actor, name)
    if role.totp_required != body.totp_required:
        audit(db, actor_id=actor.person.id, entity_type="role", entity_id=name,
              action="role.update",
              changes={"totp_required": {"from": role.totp_required, "to": body.totp_required}})
        role.totp_required = body.totp_required
    await db.commit()
    return {"name": role.name, "totp_required": role.totp_required}
```

- [ ] **Step 6: CLI**

In `api/src/serversherpa/cli.py` after `set_password`:

```python
@app.command()
def reset_totp(
    email: str = typer.Option(..., help="Login email of the account to reset"),
) -> None:
    """Last-resort 2FA reset: forget the authenticator, backup codes and
    trusted browsers. The user enrolls again at their next sign-in if
    policy requires it."""

    async def _run() -> None:
        from serversherpa.services import totp as totp_service

        async with get_sessionmaker()() as db:
            account = await db.scalar(
                select(UserAccount).where(UserAccount.email == email))
            if account is None:
                typer.secho(f"No account found for {email}.", fg="red")
                raise typer.Exit(code=1)
            await totp_service.reset(db, account, actor_id=None, ip=None)
            await db.commit()
            typer.secho(f"Two-factor reset for {email}.", fg="green")
        await dispose_engine()

    asyncio.run(_run())
```

- [ ] **Step 7: Run the tests**

Run: `… pytest tests/test_totp_admin_api.py tests/test_access_api.py tests/test_account_mgmt.py tests/test_user_detail_api.py -v` (if `test_user_detail_api.py` does not exist, use `grep -l "UserDetailOut\|/users/" tests/*.py` and include those files).
Expected: all pass.

- [ ] **Step 8: Full API suite**

Run: `… pytest -q` (timeout 600000). Expected: all pass except any pre-existing WeasyPrint environment failures (report them by name).

- [ ] **Step 9: Commit**

```bash
git add api/src/serversherpa/api/routes/users.py api/src/serversherpa/api/routes/access.py api/src/serversherpa/api/schemas.py api/src/serversherpa/cli.py api/tests/test_totp_admin_api.py
git commit -m "feat(api): admin 2FA — user reset + require flag, group/role totp_required, detail fields, reset-totp CLI"
```

---

### Task 5: Portal client, auth context, QR helper

**Files:**
- Modify: `portal/src/lib/api.ts` (SessionData L139-153, loginRequest L305-317, UserDetailAccount L506-513, AccessRole L618-623, AccessGroupOut L625-629; add TOTP helpers after `savePreferencesRequest`)
- Modify: `portal/src/lib/systemStatus.ts` (`SystemStatus`, `DEFAULT_SYSTEM_STATUS`)
- Modify: `portal/src/auth/AuthContext.tsx`
- Create: `portal/src/lib/qr.ts`; modify `portal/src/labels/containerLabelAdapters.browser.ts` to import it
- Test: `portal/src/lib/totpApi.test.ts`, `portal/src/auth/AuthContext.totp.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface TotpStatus { enrolled: boolean; enrolled_at: string | null; required: boolean; backup_codes_remaining: number }
export interface SessionData { …existing; status: 'ok'; totp: TotpStatus }
export interface TotpChallenge { status: 'totp_verify' | 'totp_enroll'; challenge_token: string; backup_codes_remaining: number | null }
export type LoginResult = SessionData | TotpChallenge
export function isTotpChallenge(r: LoginResult): r is TotpChallenge
export async function loginRequest(email, password): Promise<LoginResult>            // stores the session only when status === 'ok'
export async function totpVerify(token: string, code: string, remember: boolean): Promise<SessionData>
export async function totpEnrollStart(token?: string): Promise<{ secret: string; otpauth_uri: string }>
export async function totpEnrollConfirm(code: string, opts?: { token?: string; remember?: boolean }): Promise<{ backup_codes: string[]; session: SessionData | null }>
export async function totpRegenerateBackupCodes(code: string): Promise<{ backup_codes: string[] }>
export async function adminResetTotp(personId: string): Promise<void>
export async function adminSetTotpRequired(personId: string, required: boolean): Promise<void>
export async function patchAccessGroup(groupId: string, body: { totp_required: boolean }): Promise<void>
export async function patchRole(name: string, body: { totp_required: boolean }): Promise<void>
UserDetailAccount += totp_enrolled, totp_enrolled_at, totp_required, totp_effective_required
AccessRole += totp_required; AccessGroupOut += totp_required; SystemStatus += totp_trust_days
AuthContext: login(): Promise<LoginResult>; completeLogin(data: SessionData): void; totp: TotpStatus | null; applyTotp(t: TotpStatus): void
lib/qr.ts: export function qrDataUrl(text: string, color = '000000'): string
```

- [ ] **Step 1: Write the failing tests**

`portal/src/lib/totpApi.test.ts`:

```ts
// @vitest-environment jsdom
/** loginRequest returns the session OR a 2FA challenge; the challenge
 *  must not be stored as a session, and the totp calls carry the
 *  challenge token in the X-Totp-Challenge header. */
import { afterEach, expect, it, vi } from 'vitest';

import { isTotpChallenge, loginRequest, totpEnrollStart, totpVerify } from './api';

const SESSION = {
  status: 'ok', access_token: 'tok', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p1' }, roles: [], must_change_password: false, preferences: {},
  perms: {}, max_rank: 0, scope: { global: true, client_ids: [], partner_ids: [] },
  password_min_length: 8,
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 },
};

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

it('loginRequest surfaces a verify challenge without storing a session', async () => {
  mockFetch({ status: 'totp_verify', challenge_token: 'ch', backup_codes_remaining: 5 });
  const result = await loginRequest('a@b.c', 'pw');
  expect(isTotpChallenge(result)).toBe(true);
  if (isTotpChallenge(result)) expect(result.challenge_token).toBe('ch');
});

it('loginRequest returns the session when status is ok', async () => {
  mockFetch(SESSION);
  const result = await loginRequest('a@b.c', 'pw');
  expect(isTotpChallenge(result)).toBe(false);
  if (!isTotpChallenge(result)) expect(result.access_token).toBe('tok');
});

it('totpVerify posts the code with the challenge header and remember flag', async () => {
  const fetch = mockFetch(SESSION);
  await totpVerify('ch', '123456', true);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toMatch(/\/auth\/totp\/verify$/);
  expect((init.headers as Record<string, string>)['X-Totp-Challenge']).toBe('ch');
  expect(JSON.parse(init.body as string)).toEqual({ code: '123456', remember: true });
  expect(init.credentials).toBe('include');
});

it('totpEnrollStart without a token uses the signed-in session (no challenge header)', async () => {
  const fetch = mockFetch({ secret: 'S', otpauth_uri: 'otpauth://x' });
  await totpEnrollStart();
  const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect((init.headers as Record<string, string>)['X-Totp-Challenge']).toBeUndefined();
});
```

`portal/src/auth/AuthContext.totp.test.tsx`:

```tsx
// @vitest-environment jsdom
/** login() hands a 2FA challenge back to the caller without touching auth
 *  state; completeLogin() applies the session once the code passes. */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  loginRequest: vi.fn(),
  refreshSession: vi.fn(async () => null),
  logoutRequest: vi.fn(),
  onSessionEnded: vi.fn(() => () => {}),
  installVisibilityRefresh: vi.fn(() => () => {}),
  savePreferencesRequest: vi.fn(),
  isTotpChallenge: (r: { status: string }) => r.status !== 'ok',
}));
vi.mock('../lib/api', () => api);

const { AuthProvider, useAuth } = await import('./AuthContext');

const SESSION = {
  status: 'ok', access_token: 'tok', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p1', display_name: 'Ada' }, roles: ['staff'], must_change_password: false,
  preferences: {}, perms: {}, max_rank: 40, scope: { global: true, client_ids: [], partner_ids: [] },
  password_min_length: 8,
  totp: { enrolled: true, enrolled_at: '2026-09-23T00:00:00Z', required: false, backup_codes_remaining: 8 },
};

let ctx: ReturnType<typeof useAuth>;
function Probe() { ctx = useAuth(); return null; }

afterEach(cleanup);

it('a challenge leaves the context anonymous; completeLogin signs in', async () => {
  api.loginRequest.mockResolvedValue({ status: 'totp_verify', challenge_token: 'ch', backup_codes_remaining: 8 });
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => {});
  const result = await act(() => ctx.login('a@b.c', 'pw'));
  expect(result.status).toBe('totp_verify');
  expect(ctx.status).toBe('anon');
  act(() => ctx.completeLogin(SESSION as never));
  expect(ctx.status).toBe('authed');
  expect(ctx.totp?.enrolled).toBe(true);
  act(() => ctx.applyTotp({ ...SESSION.totp, backup_codes_remaining: 3 }));
  expect(ctx.totp?.backup_codes_remaining).toBe(3);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd …/portal && npx vitest run src/lib/totpApi.test.ts src/auth/AuthContext.totp.test.tsx`. Expected: import/type failures.

- [ ] **Step 3: api.ts**

Add to `SessionData`: `status: 'ok';` (first) and `totp: TotpStatus;` (last). Above it:

```ts
export interface TotpStatus {
  enrolled: boolean;
  enrolled_at: string | null;
  required: boolean;                 // by user flag, group, role or site policy
  backup_codes_remaining: number;
}

/** Password accepted; a code (or enrollment) is owed. No session exists yet. */
export interface TotpChallenge {
  status: 'totp_verify' | 'totp_enroll';
  challenge_token: string;
  backup_codes_remaining: number | null;
}

export type LoginResult = SessionData | TotpChallenge;

export function isTotpChallenge(result: LoginResult): result is TotpChallenge {
  return result.status !== 'ok';
}
```

Replace `loginRequest`:

```ts
export async function loginRequest(email: string, password: string): Promise<LoginResult> {
  const resp = await fetch(`${apiUrl()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // receive the refresh cookie (and send ss_trust)
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  const data: LoginResult = await resp.json();
  if (!isTotpChallenge(data)) storeSession(data);
  return data;
}

// ── two-factor ──────────────────────────────────────────────────────

/** 2FA endpoints run either on a challenge token (mid-login, no session)
 *  or on the signed-in session (My Profile). Plain fetch when a token is
 *  given — apiFetch would try to refresh a session that does not exist. */
async function totpFetch(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['X-Totp-Challenge'] = token;
    return fetch(`${apiUrl()}${path}`, {
      method: 'POST', headers, credentials: 'include', body: JSON.stringify(body ?? {}),
    });
  }
  return apiFetch(path, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body ?? {}) });
}

export async function totpVerify(token: string, code: string, remember: boolean): Promise<SessionData> {
  const resp = await totpFetch('/auth/totp/verify', { code, remember }, token);
  if (!resp.ok) throw await errorFrom(resp);
  const data: SessionData = await resp.json();
  storeSession(data);
  return data;
}

export async function totpEnrollStart(token?: string): Promise<{ secret: string; otpauth_uri: string }> {
  const resp = await totpFetch('/auth/totp/enroll/start', {}, token);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function totpEnrollConfirm(
  code: string, opts: { token?: string; remember?: boolean } = {},
): Promise<{ backup_codes: string[]; session: SessionData | null }> {
  const resp = await totpFetch('/auth/totp/enroll/confirm', { code, remember: opts.remember ?? false }, opts.token);
  if (!resp.ok) throw await errorFrom(resp);
  const data: { backup_codes: string[]; session: SessionData | null } = await resp.json();
  if (data.session) storeSession(data.session);
  return data;
}

export async function totpRegenerateBackupCodes(code: string): Promise<{ backup_codes: string[] }> {
  const resp = await totpFetch('/auth/totp/backup-codes/regenerate', { code });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function adminResetTotp(personId: string): Promise<void> {
  const resp = await apiFetch(`/users/${personId}/totp/reset`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function adminSetTotpRequired(personId: string, required: boolean): Promise<void> {
  const resp = await apiFetch(`/users/${personId}/totp-required`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ required }),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function patchAccessGroup(groupId: string, body: { totp_required: boolean }): Promise<void> {
  const resp = await apiFetch(`/access/groups/${groupId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function patchRole(name: string, body: { totp_required: boolean }): Promise<void> {
  const resp = await apiFetch(`/access/roles/${encodeURIComponent(name)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
}
```

Check whether `apiFetch` already sets `credentials`; if it does, drop that option from the second branch. Extend `UserDetailAccount` with `totp_enrolled: boolean; totp_enrolled_at: string | null; totp_required: boolean; totp_effective_required: boolean;`, `AccessRole` and `AccessGroupOut` with `totp_required: boolean;`. In `systemStatus.ts` add `totp_trust_days: number;` to the interface and `totp_trust_days: 7` to the default.

The kiosk app imports `SessionData` from `@portal/lib/api` and parses its own login response: adding `status`/`totp` to the type means the kiosk's `SessionData` object literals in tests may need the two fields — run `cd …/kiosk && npx tsc -b` (if the kiosk has node_modules; otherwise note it in the report) and fix any literal that no longer typechecks by adding `status: 'ok'` and a `totp` block.

- [ ] **Step 4: AuthContext**

- `AuthState` gains `totp: TotpStatus | null;` (`ANON` → `null`; `stateFrom` → `data.totp`).
- Interface: `login: (email, password) => Promise<LoginResult>; completeLogin: (data: SessionData) => void; applyTotp: (t: TotpStatus) => void;`.
- Implementation:

```ts
  const login = useCallback(async (email: string, password: string) => {
    const result = await loginRequest(email, password);
    if (!isTotpChallenge(result)) setState(stateFrom(result));
    return result;
  }, []);

  const completeLogin = useCallback((data: SessionData) => setState(stateFrom(data)), []);

  const applyTotp = useCallback((totp: TotpStatus) => {
    setState((prev) => ({ ...prev, totp }));
  }, []);
```

Add both to the provider value. Import `isTotpChallenge`, `LoginResult`, `TotpStatus`.

- [ ] **Step 5: QR helper**

`portal/src/lib/qr.ts`:

```ts
/** QR code → PNG data URL via bwip-js (already a dependency for labels). */
import bwipjs from 'bwip-js';

export function qrDataUrl(text: string, color = '000000', scale = 5): string {
  const canvas = document.createElement('canvas');
  bwipjs.toCanvas(canvas, { bcid: 'qrcode', text, scale, width: 25, height: 25, barcolor: color });
  return canvas.toDataURL('image/png');
}
```

In `containerLabelAdapters.browser.ts` delete the local `generateQRCode` and use `qr: (text, color) => qrDataUrl(text, color)` (keep the adapter signature; check how `bwipjs` is imported there and mirror it exactly in `qr.ts`).

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/lib/totpApi.test.ts src/auth/AuthContext.totp.test.tsx src/lib/systemStatus.test.ts src/labels` then `npx tsc -b`. Expected: green. Any other test file that builds a `SessionData` literal now needs `status: 'ok'` and `totp` — fix those (grep `session_expires_at:` under `src`).

- [ ] **Step 7: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/systemStatus.ts portal/src/lib/qr.ts portal/src/labels/containerLabelAdapters.browser.ts portal/src/auth/AuthContext.tsx portal/src/lib/totpApi.test.ts portal/src/auth/AuthContext.totp.test.tsx
git commit -m "feat(portal): 2FA client — login result union, totp endpoints, auth context completeLogin/applyTotp, qr helper"
```

---

### Task 6: Login page — verify and enrollment cards, shared OTP components

**Files:**
- Create: `portal/src/components/totp/OtpInput.tsx`, `portal/src/components/totp/BackupCodesPanel.tsx`, `portal/src/components/totp/EnrollFlow.tsx`
- Modify: `portal/src/pages/Login.tsx`
- Modify: `portal/src/styles/auth-theme.css` (append a few rules)
- Test: `portal/src/components/totp/OtpInput.test.tsx`, `portal/src/components/totp/EnrollFlow.test.tsx`, extend `portal/src/pages/Login.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`isTotpChallenge`, `totpVerify`, `totpEnrollStart`, `totpEnrollConfirm`, `completeLogin`, `getSystemStatus().totp_trust_days`, `qrDataUrl`).
- Produces:

```tsx
// OtpInput: six boxes; value is the joined digits; onComplete fires once six digits are present
export default function OtpInput({ value, onChange, onComplete, disabled, invalid, autoFocus, idPrefix }: {
  value: string; onChange: (v: string) => void; onComplete?: (v: string) => void;
  disabled?: boolean; invalid?: boolean; autoFocus?: boolean; idPrefix?: string }): JSX.Element
// BackupCodesPanel: grid + Copy + Download; onAcknowledged enabled after Copy/Download or 5 s
export default function BackupCodesPanel({ codes, onAcknowledged, ackLabel = "I've saved my codes" }: {
  codes: string[]; onAcknowledged: () => void; ackLabel?: string }): JSX.Element
// EnrollFlow: Scan → Confirm → Save codes; `start`/`confirm` are injected so the login page (challenge token) and the profile modal (session) share it
export default function EnrollFlow({ email, start, confirm, remember, onDone, onError }: {
  email: string;
  start: () => Promise<{ secret: string; otpauth_uri: string }>;
  confirm: (code: string) => Promise<{ backup_codes: string[] }>;
  remember?: { checked: boolean; onChange: (v: boolean) => void; days: number } | null;
  onDone: () => void;
  onError?: (code: string) => void;
}): JSX.Element
```

- [ ] **Step 1: Write the failing component tests**

`portal/src/components/totp/OtpInput.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import OtpInput from './OtpInput';

afterEach(cleanup);

function Harness({ onComplete }: { onComplete: (v: string) => void }) {
  const [v, setV] = useState('');
  return <OtpInput value={v} onChange={setV} onComplete={onComplete} autoFocus />;
}

it('typing advances box to box and fires onComplete on the sixth digit', async () => {
  const done = vi.fn();
  const user = userEvent.setup();
  render(<Harness onComplete={done} />);
  const boxes = screen.getAllByRole('textbox');
  expect(boxes).toHaveLength(6);
  await user.type(boxes[0], '123456');
  expect(done).toHaveBeenCalledWith('123456');
  expect((boxes[5] as HTMLInputElement).value).toBe('6');
});

it('pasting six digits fills every box', () => {
  const done = vi.fn();
  render(<Harness onComplete={done} />);
  const boxes = screen.getAllByRole('textbox');
  fireEvent.paste(boxes[0], { clipboardData: { getData: () => '98 76 54' } });
  expect(done).toHaveBeenCalledWith('987654');
});

it('Backspace on an empty box moves back', async () => {
  const user = userEvent.setup();
  render(<Harness onComplete={() => {}} />);
  const boxes = screen.getAllByRole('textbox');
  await user.type(boxes[0], '12');
  await user.keyboard('{Backspace}{Backspace}');
  expect(document.activeElement).toBe(boxes[0]);
});
```

`portal/src/components/totp/EnrollFlow.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../lib/qr', () => ({ qrDataUrl: (t: string) => `data:qr,${encodeURIComponent(t)}` }));

import EnrollFlow from './EnrollFlow';

afterEach(cleanup);

it('walks Scan → Confirm → Save codes and acknowledges', async () => {
  const user = userEvent.setup();
  const start = vi.fn(async () => ({ secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/x' }));
  const confirm = vi.fn(async () => ({ backup_codes: ['aaaaa-bbbbb', 'ccccc-ddddd'] }));
  const done = vi.fn();
  render(<EnrollFlow email="ada@x.test" start={start} confirm={confirm} onDone={done} />);
  await waitFor(() => expect(start).toHaveBeenCalled());
  expect((screen.getByAltText(/scan this/i) as HTMLImageElement).src).toContain('otpauth');
  expect(screen.getByText(/JBSW Y3DP EHPK 3PXP/)).toBeTruthy();
  const boxes = screen.getAllByRole('textbox');
  await user.type(boxes[0], '123456');
  await waitFor(() => expect(confirm).toHaveBeenCalledWith('123456'));
  expect(await screen.findByText('aaaaa-bbbbb')).toBeTruthy();
  const ack = screen.getByRole('button', { name: /saved my codes/i }) as HTMLButtonElement;
  expect(ack.disabled).toBe(true);
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  fireEvent.click(screen.getByRole('button', { name: /copy/i }));
  await waitFor(() => expect(ack.disabled).toBe(false));
  fireEvent.click(ack);
  expect(done).toHaveBeenCalled();
});

it('a wrong confirm code shows the error and keeps the QR step reachable', async () => {
  const user = userEvent.setup();
  const err = Object.assign(new Error('x'), { code: 'totp_invalid' });
  const start = vi.fn(async () => ({ secret: 'S', otpauth_uri: 'otpauth://totp/x' }));
  const confirm = vi.fn(async () => { throw err; });
  render(<EnrollFlow email="a@x" start={start} confirm={confirm} onDone={() => {}} />);
  await waitFor(() => expect(start).toHaveBeenCalled());
  await user.type(screen.getAllByRole('textbox')[0], '000000');
  expect(await screen.findByText(/didn.t match/i)).toBeTruthy();
});
```

Extend `portal/src/pages/Login.test.tsx` — change the `useAuth` mock to a hoisted object and add:

```tsx
const auth = vi.hoisted(() => ({ login: vi.fn(), completeLogin: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const api = vi.hoisted(() => ({
  totpVerify: vi.fn(), totpEnrollStart: vi.fn(), totpEnrollConfirm: vi.fn(),
  isTotpChallenge: (r: { status: string }) => r.status !== 'ok',
  ApiError: class ApiError extends Error { constructor(public status: number, public code: string) { super(code); } },
}));
vi.mock('../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../lib/api')>()), ...api }));
vi.mock('../lib/systemStatus', () => ({ getSystemStatus: async () => ({ totp_trust_days: 7 }) }));
vi.mock('../lib/qr', () => ({ qrDataUrl: () => 'data:qr' }));

it('a verify challenge swaps the form for the code card and completes the login', async () => {
  const user = userEvent.setup();
  auth.login.mockResolvedValue({ status: 'totp_verify', challenge_token: 'ch', backup_codes_remaining: 8 });
  api.totpVerify.mockResolvedValue({ status: 'ok', totp: {} });
  const { email, password } = renderLogin();
  await user.type(email, 'jimmy@example.com');
  await user.type(password, 'pw');
  fireEvent.submit(email.closest('form')!);
  const boxes = await screen.findAllByRole('textbox');
  expect(boxes).toHaveLength(6);
  expect(screen.getByLabelText(/remember this browser for 7 days/i)).toBeTruthy();
  await user.click(screen.getByLabelText(/remember this browser/i));
  await user.type(boxes[0], '123456');
  await waitFor(() => expect(api.totpVerify).toHaveBeenCalledWith('ch', '123456', true));
  await waitFor(() => expect(auth.completeLogin).toHaveBeenCalled());
});

it('Use a backup code swaps the boxes for one field', async () => {
  const user = userEvent.setup();
  auth.login.mockResolvedValue({ status: 'totp_verify', challenge_token: 'ch', backup_codes_remaining: 8 });
  const { email, password } = renderLogin();
  await user.type(email, 'j@x'); await user.type(password, 'pw');
  fireEvent.submit(email.closest('form')!);
  await screen.findAllByRole('textbox');
  await user.click(screen.getByRole('button', { name: /use a backup code/i }));
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
});

it('an enroll challenge shows the QR step', async () => {
  const user = userEvent.setup();
  auth.login.mockResolvedValue({ status: 'totp_enroll', challenge_token: 'ch', backup_codes_remaining: null });
  api.totpEnrollStart.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://x' });
  const { email, password } = renderLogin();
  await user.type(email, 'j@x'); await user.type(password, 'pw');
  fireEvent.submit(email.closest('form')!);
  expect(await screen.findByAltText(/scan this/i)).toBeTruthy();
  expect(api.totpEnrollStart).toHaveBeenCalledWith('ch');
});
```

Add `fireEvent`, `waitFor` to the RTL import. The existing three tab-order tests stay unchanged (the remember checkbox is gone from the password form, so the path is still email → password → Sign in).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/components/totp src/pages/Login.test.tsx`. Expected: module-not-found failures.

- [ ] **Step 3: OtpInput**

`portal/src/components/totp/OtpInput.tsx`:

```tsx
/**
 * OtpInput — six single-digit boxes (V2's .otp-inputs styling). Typing
 * advances, Backspace on an empty box retreats, a paste anywhere fills
 * the whole code, and onComplete fires the moment six digits are present.
 */
import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';

const LENGTH = 6;

export default function OtpInput({
  value, onChange, onComplete, disabled = false, invalid = false, autoFocus = false, idPrefix = 'otp',
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  idPrefix?: string;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.replace(/\D/g, '').slice(0, LENGTH);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  const commit = (next: string) => {
    onChange(next);
    if (next.length === LENGTH) onComplete?.(next);
  };

  const setAt = (i: number, ch: string) => {
    const arr = digits.padEnd(LENGTH, ' ').split('');
    arr[i] = ch;
    const next = arr.join('').replace(/\s/g, '').slice(0, LENGTH);
    commit(next);
    if (ch && i < LENGTH - 1) refs.current[i + 1]?.focus();
  };

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[i]) {
        commit(digits.slice(0, i) + digits.slice(i + 1));
      } else if (i > 0) {
        commit(digits.slice(0, i - 1) + digits.slice(i));
        refs.current[i - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < LENGTH - 1) {
      refs.current[i + 1]?.focus();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, LENGTH);
    if (!text) return;
    e.preventDefault();
    commit(text);
    refs.current[Math.min(text.length, LENGTH - 1)]?.focus();
  };

  return (
    <div className={`otp-inputs ${invalid ? 'bad' : ''}`} role="group" aria-label="Verification code">
      {Array.from({ length: LENGTH }, (_, i) => (
        <input
          key={i}
          id={`${idPrefix}-${i}`}
          ref={(el) => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          aria-label={`Digit ${i + 1}`}
          className={digits[i] ? 'filled' : ''}
          value={digits[i] ?? ''}
          disabled={disabled}
          onChange={(e) => setAt(i, e.target.value.replace(/\D/g, '').slice(-1))}
          onKeyDown={onKeyDown(i)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: BackupCodesPanel**

`portal/src/components/totp/BackupCodesPanel.tsx`:

```tsx
/**
 * BackupCodesPanel — the one-time recovery codes, shown exactly once.
 * Copy / Download unlock the acknowledge button (or a 5 s timer does, for
 * people who photograph the screen).
 */
import { useEffect, useState } from 'react';

export default function BackupCodesPanel({ codes, onAcknowledged, ackLabel = "I've saved my codes" }: {
  codes: string[];
  onAcknowledged: () => void;
  ackLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setSaved(true), 5000);
    return () => window.clearTimeout(t);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch { /* clipboard blocked — the codes are still on screen */ }
    setSaved(true);
  };

  const download = () => {
    const blob = new Blob([
      'ServerSherpa two-factor backup codes\nEach code works once. Keep them somewhere safe.\n\n',
      codes.join('\n'), '\n',
    ], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'serversherpa-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <>
      <p className="otp-info notice">These codes each work once if you lose your phone. This is the only time they are shown.</p>
      <div className="backup-grid">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="otp-actions">
        <button type="button" className="btn-sso" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" className="btn-sso" onClick={download}>Download</button>
      </div>
      <button type="button" className="btn otp-verify" disabled={!saved} onClick={onAcknowledged}>
        <span>{ackLabel}</span>
      </button>
    </>
  );
}
```

- [ ] **Step 5: EnrollFlow**

`portal/src/components/totp/EnrollFlow.tsx`:

```tsx
/**
 * EnrollFlow — Scan → Confirm → Save codes. `start` and `confirm` are
 * injected so the login page (challenge token) and the My Profile modal
 * (signed-in session) share one flow.
 */
import { useEffect, useState } from 'react';

import { ApiError } from '../../lib/api';
import { qrDataUrl } from '../../lib/qr';
import BackupCodesPanel from './BackupCodesPanel';
import OtpInput from './OtpInput';

type Step = 'scan' | 'codes';

const CONFIRM_ERRORS: Record<string, string> = {
  totp_invalid: "That code didn't match. Wait for a new code in the app and try again.",
  account_locked: 'Too many attempts — this account is temporarily locked. Try again in about 15 minutes.',
  invalid_challenge: 'This sign-in expired. Go back and sign in again.',
};

export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export default function EnrollFlow({ email, start, confirm, remember = null, onDone, onError }: {
  email: string;
  start: () => Promise<{ secret: string; otpauth_uri: string }>;
  confirm: (code: string) => Promise<{ backup_codes: string[] }>;
  remember?: { checked: boolean; onChange: (v: boolean) => void; days: number } | null;
  onDone: () => void;
  onError?: (code: string) => void;
}) {
  const [step, setStep] = useState<Step>('scan');
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    start().then((r) => {
      if (cancelled) return;
      setSecret(r.secret);
      setQr(qrDataUrl(r.otpauth_uri));
    }).catch((err) => {
      const c = err instanceof ApiError ? err.code : 'network';
      setError(CONFIRM_ERRORS[c] ?? 'Could not start enrollment. Try again.');
      onError?.(c);
    });
    return () => { cancelled = true; };
  // start is stable for the life of the flow
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await confirm(value);
      setCodes(r.backup_codes);
      setStep('codes');
    } catch (err) {
      const c = err instanceof ApiError ? err.code : 'network';
      setError(CONFIRM_ERRORS[c] ?? 'Something went wrong. Try again.');
      setCode('');
      onError?.(c);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="steps" aria-hidden="true">
        <span className={`step ${step === 'scan' ? 'active' : 'done'}`}>1 · Scan</span>
        <span className={`step ${step === 'scan' ? 'active' : 'done'}`}>2 · Confirm</span>
        <span className={`step ${step === 'codes' ? 'active' : ''}`}>3 · Save codes</span>
      </div>

      {step === 'scan' && (
        <>
          <p className="otp-text">Open your authenticator app (Google Authenticator, Apple Passwords, 1Password…) and scan this code for <b>{email}</b>.</p>
          <div className="qr-frame">
            {qr ? <img src={qr} alt="Scan this QR code with your authenticator app" width={180} height={180} /> : <div className="card-spinner" />}
          </div>
          {secret && (
            <>
              <p className="otp-info">Can't scan? Enter this key by hand:</p>
              <div className="secret-box">{groupSecret(secret)}</div>
            </>
          )}
          <p className="otp-info">Then enter the 6-digit code the app shows.</p>
          <OtpInput value={code} onChange={setCode} onComplete={(v) => void submit(v)}
                    disabled={busy || !secret} invalid={!!error} idPrefix="enroll-otp" />
          <p className={`otp-error ${error ? 'show' : ''}`} role={error ? 'alert' : undefined}>{error}</p>
          {remember && (
            <div className="otp-row">
              <label className="remember">
                <input type="checkbox" checked={remember.checked} onChange={(e) => remember.onChange(e.target.checked)} />
                <span className="box">
                  <svg viewBox="0 0 12 12" fill="none" stroke="#0c1117" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
                </span>
                Remember this browser for {remember.days} days
              </label>
            </div>
          )}
        </>
      )}

      {step === 'codes' && (
        <>
          <p className="otp-info success-note">Two-factor authentication is on.</p>
          <BackupCodesPanel codes={codes} onAcknowledged={onDone} />
        </>
      )}
    </>
  );
}
```

- [ ] **Step 6: Login page**

In `portal/src/pages/Login.tsx`:

- Imports: `useCallback`; `import { ApiError, isTotpChallenge, totpEnrollConfirm, totpEnrollStart, totpVerify, type TotpChallenge } from '../lib/api';` `import { getSystemStatus } from '../lib/systemStatus';` `import OtpInput from '../components/totp/OtpInput';` `import EnrollFlow from '../components/totp/EnrollFlow';`. `useAuth()` now also gives `completeLogin`.
- Update the header comment: TwoFAVerify/Setup are now built in; only SSO remains deferred. Remove the `totp_required` entry from `ERROR_MESSAGES` and add:

```ts
const CODE_ERRORS: Record<string, string> = {
  totp_invalid: "That code didn't match. Try the next one.",
  account_locked: 'Too many failed attempts — this account is temporarily locked. Try again in about 15 minutes.',
  invalid_challenge: 'This sign-in expired. Start again.',
};
```

- State: delete `remember`; add

```ts
  const [challenge, setChallenge] = useState<TotpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [backupMode, setBackupMode] = useState(false);
  const [rememberBrowser, setRememberBrowser] = useState(false);
  const [codeError, setCodeError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [trustDays, setTrustDays] = useState(7);

  useEffect(() => {
    getSystemStatus().then((s) => setTrustDays(s.totp_trust_days)).catch(() => {});
  }, []);
```

- `handleSubmit` try block becomes:

```ts
      const result = await login(email, password);
      if (isTotpChallenge(result)) {
        setChallenge(result);
        setPassword('');
        return;
      }
      navigate(from ?? '/', { replace: true });
```

- Handlers:

```ts
  const finish = useCallback(() => navigate(from ?? '/', { replace: true }), [navigate, from]);

  const submitCode = async (value: string) => {
    if (!challenge || verifying) return;
    setVerifying(true);
    setCodeError('');
    try {
      const session = await totpVerify(challenge.challenge_token, value, rememberBrowser);
      completeLogin(session);
      finish();
    } catch (err) {
      const c = err instanceof ApiError ? err.code : 'network';
      setCodeError(CODE_ERRORS[c] ?? 'Could not verify the code. Try again.');
      setCode('');
      shakeForm();
      if (c === 'invalid_challenge' || c === 'account_locked') setChallenge(null);
    } finally {
      setVerifying(false);
    }
  };

  const backToSignIn = () => {
    setChallenge(null); setCode(''); setBackupMode(false); setCodeError(''); setError('');
  };
```

- Render: keep everything, but wrap the existing `<form>…</form>` + divider + SSO + form-foot in `{!challenge && (<>…</>)}` and remove the `.row-between` remember block from the form. After the form-wrap's `form-hint`, render the challenge card when present:

```tsx
          {challenge?.status === 'totp_verify' && (
            <div className="otp-card inline-card">
              <div className="eyebrow">Two-factor</div>
              <h3 className="otp-title">Enter your code</h3>
              <p className="otp-text">{backupMode
                ? 'Enter one of your backup codes. Each one works once.'
                : 'Open your authenticator app and enter the 6-digit code.'}</p>
              {backupMode ? (
                <form onSubmit={(e) => { e.preventDefault(); void submitCode(code); }}>
                  <div className="code-input field">
                    <div className="control">
                      <input id="backup-code" aria-label="Backup code" placeholder="xxxxx-xxxxx"
                             autoComplete="off" autoFocus value={code}
                             onChange={(e) => { setCode(e.target.value); setCodeError(''); }} />
                    </div>
                  </div>
                </form>
              ) : (
                <OtpInput value={code} onChange={(v) => { setCode(v); setCodeError(''); }}
                          onComplete={(v) => void submitCode(v)} disabled={verifying}
                          invalid={!!codeError} autoFocus idPrefix="login-otp" />
              )}
              <p className={`otp-error ${codeError ? 'show' : ''}`} role={codeError ? 'alert' : undefined}>{codeError}</p>
              <div className="otp-row">
                <label className="remember">
                  <input type="checkbox" checked={rememberBrowser} onChange={(e) => setRememberBrowser(e.target.checked)} />
                  <span className="box">
                    <svg viewBox="0 0 12 12" fill="none" stroke="#0c1117" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
                  </span>
                  Remember this browser for {trustDays} days
                </label>
              </div>
              <button className={`btn otp-verify ${verifying ? 'loading' : ''}`} type="button"
                      disabled={verifying || (backupMode ? code.trim().length < 10 : code.length < 6)}
                      onClick={() => void submitCode(code)}>
                <span>{verifying ? 'Verifying…' : 'Verify'}</span>
                <span className="spinner"></span>
              </button>
              <p className="otp-foot">
                <button type="button" className="link" tabIndex={-1}
                        onClick={() => { setBackupMode((b) => !b); setCode(''); setCodeError(''); }}>
                  {backupMode ? 'Use my authenticator app' : 'Use a backup code'}
                </button>
                {' · '}
                <button type="button" className="link" tabIndex={-1} onClick={backToSignIn}>Back to sign in</button>
              </p>
            </div>
          )}

          {challenge?.status === 'totp_enroll' && (
            <div className="otp-card inline-card">
              <div className="eyebrow">Two-factor required</div>
              <h3 className="otp-title">Set up your authenticator</h3>
              <EnrollFlow
                email={email}
                start={() => totpEnrollStart(challenge.challenge_token)}
                confirm={async (c) => {
                  const r = await totpEnrollConfirm(c, { token: challenge.challenge_token, remember: rememberBrowser });
                  if (r.session) completeLogin(r.session);
                  return r;
                }}
                remember={{ checked: rememberBrowser, onChange: setRememberBrowser, days: trustDays }}
                onDone={finish}
                onError={(c) => { shakeForm(); if (c === 'invalid_challenge') setChallenge(null); }}
              />
              <p className="otp-foot">
                <button type="button" className="link" tabIndex={-1} onClick={backToSignIn}>Back to sign in</button>
              </p>
            </div>
          )}
```

The card sits inside `.form-wrap` (not the scrim) so the map layout stays. Add to `auth-theme.css`:

```css
/* 2FA cards render inline in the form column, not in the scrim */
.login-shell .form-wrap .otp-card.inline-card { position:relative;width:100%;max-width:none;margin-top:18px;background:linear-gradient(180deg,var(--paper) 0%,var(--paper-2) 100%);color:var(--text-dark);border-radius:18px;padding:30px 28px 26px;box-shadow:0 30px 80px -20px #0000008c }
.login-shell .form-wrap .otp-card.inline-card:before { content:"";position:absolute;top:0;left:20px;right:20px;height:2px;border-radius:2px;background:repeating-linear-gradient(90deg,var(--amber) 0 12px,transparent 12px 24px);opacity:.8 }
.login-shell .form-wrap .otp-card.inline-card .remember { display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer }
```

Then generalize every `.auth-scrim .otp-*`, `.auth-scrim .steps`, `.qr-frame`, `.secret-box`, `.backup-grid`, `.otp-actions`, `.code-input`, `.card-spinner` selector so it also matches inside `.inline-card`: change each `.auth-scrim .X` rule's selector to `.auth-scrim .X, .inline-card .X` (a mechanical edit; do not restyle). Keep the mobile `@media` rules in step.

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run src/components/totp src/pages/Login.test.tsx && npx tsc -b`. Expected: green. If `role="group"` makes `getAllByRole('textbox')` miss the inputs, drop the `role` attribute (keep `aria-label`s).

- [ ] **Step 8: Commit**

```bash
git add portal/src/components/totp portal/src/pages/Login.tsx portal/src/pages/Login.test.tsx portal/src/styles/auth-theme.css
git commit -m "feat(portal): 2FA at sign-in — code card, backup-code entry, remember this browser, forced enrollment flow"
```

---

### Task 7: My Profile — enroll modal, regenerate codes, security row

**Files:**
- Create: `portal/src/components/totp/TotpEnrollModal.tsx`, `portal/src/components/totp/RegenerateCodesModal.tsx`
- Modify: `portal/src/pages/Profile.tsx` (Security panel L243-277 area; `useAuth()` destructure L55)
- Modify: `portal/src/styles/profile.css` (append)
- Test: `portal/src/components/totp/TotpEnrollModal.test.tsx`, extend `portal/src/pages/Profile.test.tsx`

**Interfaces:**
- Consumes: `EnrollFlow`, `BackupCodesPanel`, `OtpInput`, `totpEnrollStart()`, `totpEnrollConfirm(code)`, `totpRegenerateBackupCodes(code)`, `useAuth().totp`, `applyTotp`.
- Produces: `TotpEnrollModal({ email, onClose, onEnrolled })`, `RegenerateCodesModal({ onClose, onRegenerated(count) })`.

- [ ] **Step 1: Write the failing tests**

`portal/src/components/totp/TotpEnrollModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  totpEnrollStart: vi.fn(async () => ({ secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://x' })),
  totpEnrollConfirm: vi.fn(async () => ({ backup_codes: ['aaaaa-bbbbb'], session: null })),
  ApiError: class ApiError extends Error { constructor(public status: number, public code: string) { super(code); } },
}));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/qr', () => ({ qrDataUrl: () => 'data:qr' }));

const { default: TotpEnrollModal } = await import('./TotpEnrollModal');

afterEach(cleanup);

it('has the report-generate header, walks the flow, and reports enrollment', async () => {
  const user = userEvent.setup();
  const onEnrolled = vi.fn();
  render(<TotpEnrollModal email="ada@x.test" onClose={() => {}} onEnrolled={onEnrolled} />);
  expect(screen.getByText('Security')).toBeTruthy();           // eyebrow
  expect(screen.getByRole('heading', { name: /set up two-factor/i })).toBeTruthy();
  await waitFor(() => expect(api.totpEnrollStart).toHaveBeenCalledWith());
  await user.type(screen.getAllByRole('textbox')[0], '123456');
  await waitFor(() => expect(api.totpEnrollConfirm).toHaveBeenCalledWith('123456', {}));
  expect(await screen.findByText('aaaaa-bbbbb')).toBeTruthy();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  fireEvent.click(screen.getByRole('button', { name: /copy/i }));
  const done = screen.getByRole('button', { name: /done/i });
  await waitFor(() => expect((done as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(done);
  expect(onEnrolled).toHaveBeenCalledWith(1);
});
```

Extend `portal/src/pages/Profile.test.tsx` — the `auth` hoisted mock gets `totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 }` and `applyTotp: vi.fn()` (and whatever the `useAuth` mock factory spreads; read the file). Add:

```tsx
it('Security shows Set up 2FA when not enrolled and the status when enrolled', async () => {
  renderAt('/me');
  expect(await screen.findByRole('button', { name: /set up 2fa/i })).toBeTruthy();
  auth.totp = { enrolled: true, enrolled_at: '2026-09-23T00:00:00Z', required: false, backup_codes_remaining: 3 };
  cleanup();
  renderAt('/me');
  expect(await screen.findByText(/3 backup codes left/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /regenerate backup codes/i })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /turn off/i })).toBeNull();
});
```

(Use the file's own render helper name; `renderAt` is illustrative — match what the test file already defines.)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/components/totp/TotpEnrollModal.test.tsx src/pages/Profile.test.tsx`. Expected: failures.

- [ ] **Step 3: Modals**

`portal/src/components/totp/TotpEnrollModal.tsx`:

```tsx
/**
 * TotpEnrollModal — self-service enrollment from My Profile. Report-generate
 * header pattern (eyebrow / title / description + numbered steps), sized
 * to its content. The flow itself is EnrollFlow, shared with the login page.
 */
import { useState } from 'react';

import { totpEnrollConfirm, totpEnrollStart } from '../../lib/api';
import EnrollFlow from './EnrollFlow';
import '../../styles/reports.css';
import '../../styles/auth-theme.css';

export default function TotpEnrollModal({ email, onClose, onEnrolled }: {
  email: string;
  onClose: () => void;
  onEnrolled: (backupCodesRemaining: number) => void;
}) {
  const [count, setCount] = useState(0);
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card totp-modal-card">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Security</div>
            <h3>Set up two-factor authentication</h3>
            <p className="page-hint">Scan the code with an authenticator app, confirm a code, then save your backup codes.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body inline-card totp-modal-body">
          <EnrollFlow
            email={email}
            start={() => totpEnrollStart()}
            confirm={async (code) => {
              const r = await totpEnrollConfirm(code, {});
              setCount(r.backup_codes.length);
              return r;
            }}
            onDone={() => onEnrolled(count)}
          />
        </div>
      </div>
    </div>
  );
}
```

Pass `ackLabel="Done"` through: give `EnrollFlow` an optional `ackLabel?: string` prop forwarded to `BackupCodesPanel` (default stays "I've saved my codes"); the modal passes `ackLabel="Done"`. The test above expects `/done/i`; the login flow keeps the default.

`portal/src/components/totp/RegenerateCodesModal.tsx`:

```tsx
/**
 * RegenerateCodesModal — asks for a current authenticator code, then shows
 * the fresh backup codes once (the old ones stop working immediately).
 */
import { useState } from 'react';

import { ApiError, totpRegenerateBackupCodes } from '../../lib/api';
import BackupCodesPanel from './BackupCodesPanel';
import OtpInput from './OtpInput';
import '../../styles/reports.css';
import '../../styles/auth-theme.css';

const ERRORS: Record<string, string> = {
  totp_invalid: "That code didn't match. Try the next one.",
  account_locked: 'Too many attempts — your account is temporarily locked.',
};

export default function RegenerateCodesModal({ onClose, onRegenerated }: {
  onClose: () => void;
  onRegenerated: (count: number) => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const r = await totpRegenerateBackupCodes(value);
      setCodes(r.backup_codes);
    } catch (err) {
      setError(ERRORS[err instanceof ApiError ? err.code : ''] ?? 'Could not regenerate the codes.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !codes) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card totp-modal-card">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Security</div>
            <h3>Regenerate backup codes</h3>
            <p className="page-hint">{codes ? 'Your old codes no longer work.' : 'Confirm with a code from your authenticator app first.'}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body inline-card totp-modal-body">
          {codes ? (
            <BackupCodesPanel codes={codes} ackLabel="Done" onAcknowledged={() => onRegenerated(codes.length)} />
          ) : (
            <>
              <OtpInput value={code} onChange={(v) => { setCode(v); setError(''); }}
                        onComplete={(v) => void submit(v)} disabled={busy} invalid={!!error}
                        autoFocus idPrefix="regen-otp" />
              <p className={`otp-error ${error ? 'show' : ''}`} role={error ? 'alert' : undefined}>{error}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

Append to `portal/src/styles/profile.css`:

```css
/* 2FA modals: content-sized card, the OTP kit renders inside .inline-card */
.totp-modal-card { width: min(520px, 96vw); }
.totp-modal-body { padding: 4px 24px 24px; }
```

- [ ] **Step 4: Profile.tsx**

- `const { roles, applyProfile, totp, applyTotp, person } = useAuth();`
- State: `const [enrollOpen, setEnrollOpen] = useState(false); const [regenOpen, setRegenOpen] = useState(false);`
- Imports: `TotpEnrollModal`, `RegenerateCodesModal`.
- Replace `<dt>Two-factor auth</dt><dd>TOTP enrollment — coming soon</dd>` with:

```tsx
                  <dt>Two-factor auth</dt>
                  <dd className="totp-row">
                    {totp?.enrolled ? (
                      <>
                        <span className="chip c-green"><span className="dot" />On{totp.enrolled_at ? ` since ${longDate(totp.enrolled_at)}` : ''}</span>
                        <span className="set-note">{totp.backup_codes_remaining} backup code{totp.backup_codes_remaining === 1 ? '' : 's'} left</span>
                        <button className="mini-btn" onClick={() => setRegenOpen(true)}>Regenerate backup codes</button>
                      </>
                    ) : (
                      <>
                        <span className="chip tag">Off{totp?.required ? ' · required by policy' : ''}</span>
                        <button className="mini-btn accent" onClick={() => setEnrollOpen(true)}>Set up 2FA</button>
                      </>
                    )}
                  </dd>
```

- Modals at the end of the component's JSX:

```tsx
      {enrollOpen && person && (
        <TotpEnrollModal email={person.email ?? ''} onClose={() => setEnrollOpen(false)}
          onEnrolled={(n) => {
            setEnrollOpen(false);
            applyTotp({ enrolled: true, enrolled_at: new Date().toISOString(),
                        required: totp?.required ?? false, backup_codes_remaining: n });
          }} />
      )}
      {regenOpen && (
        <RegenerateCodesModal onClose={() => setRegenOpen(false)}
          onRegenerated={(n) => {
            setRegenOpen(false);
            if (totp) applyTotp({ ...totp, backup_codes_remaining: n });
          }} />
      )}
```

Add `.kv .totp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }` to profile.css. Use the login email (`person.email`) for the QR label; check `PersonOut` has `email` (it does — `applyProfile` copies it).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/components/totp src/pages/Profile.test.tsx && npx tsc -b`. Expected: green.

- [ ] **Step 6: Commit**

```bash
git add portal/src/components/totp portal/src/pages/Profile.tsx portal/src/pages/Profile.test.tsx portal/src/styles/profile.css
git commit -m "feat(portal): My Profile 2FA — enrollment modal, regenerate backup codes, security row"
```

---

### Task 8: Admin UI — user detail 2FA row, group/role switches, security settings copy

**Files:**
- Modify: `portal/src/components/users/UserProfileTab.tsx` (props L23-33; Account kv L77-93)
- Modify: `portal/src/pages/UserDetail.tsx` (Action type L36-38; handlers; modal render L300-311)
- Modify: `portal/src/components/UserAdminModals.tsx` (add `ResetTotpModal` after `AccountStateModal`)
- Modify: `portal/src/components/access/GroupsTab.tsx` (`GroupDetail` L154+, head L211-217)
- Modify: `portal/src/components/access/RolesTab.tsx` (role head L176-181)
- Modify: `portal/src/components/settings/SecurityControls.tsx`
- Test: extend `portal/src/pages/UserDetail.test.tsx`, `portal/src/components/settings/SecurityControls.test.tsx`; create `portal/src/components/access/totpSwitches.test.tsx`

**Interfaces:**
- Consumes: `adminResetTotp`, `adminSetTotpRequired`, `patchAccessGroup`, `patchRole`, `getSystemStatus`, `UserDetailAccount.totp_*`, `Switch`.
- Produces: `ResetTotpModal({ user, onClose, onDone })`; `UserProfileTab` props `onResetTotp: () => void`, `onToggleTotpRequired: (v: boolean) => Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Extend `UserDetail.test.tsx` — add to `DETAIL.account`: `totp_enrolled: true, totp_enrolled_at: '2026-09-20T00:00:00Z', totp_required: false, totp_effective_required: false`; add `adminResetTotp: vi.fn(async () => {}), adminSetTotpRequired: vi.fn(async () => {})` to the `api` mock; then:

```tsx
it('Account shows the 2FA row with Require switch and Reset 2FA (enrolled only)', async () => {
  renderDetail();
  expect(await screen.findByText(/enrolled/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /reset 2fa/i }));
  fireEvent.click(screen.getByRole('button', { name: /^reset two-factor$/i }));
  await waitFor(() => expect(api.adminResetTotp).toHaveBeenCalledWith('p1'));
  const sw = screen.getByRole('checkbox', { name: /require 2fa/i });
  fireEvent.click(sw);
  await waitFor(() => expect(api.adminSetTotpRequired).toHaveBeenCalledWith('p1', true));
});

it('Reset 2FA is hidden when not enrolled and the switch is locked when policy requires it', async () => {
  api.getUserDetail.mockResolvedValueOnce({ ...DETAIL, account: { ...DETAIL.account,
    totp_enrolled: false, totp_enrolled_at: null, totp_effective_required: true } });
  renderDetail();
  expect(await screen.findByText(/required by policy/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /reset 2fa/i })).toBeNull();
  expect((screen.getByRole('checkbox', { name: /require 2fa/i }) as HTMLInputElement).disabled).toBe(true);
});
```

(Match the file's actual render helper and how `getUserDetail` is mocked.) `Switch` must render an `<input type="checkbox">` with an accessible name — pass `aria-label` through; if `Switch` has no `aria-label` prop, add an optional `label?: string` prop to `Switch.tsx` that becomes `aria-label`.

`portal/src/components/access/totpSwitches.test.tsx`:

```tsx
// @vitest-environment jsdom
/** Require 2FA switches on the group and role cards call the PATCH endpoints. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  patchAccessGroup: vi.fn(async () => {}),
  patchRole: vi.fn(async () => {}),
  listUsers: vi.fn(async () => []),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: GroupsTab } = await import('./GroupsTab');
const { default: RolesTab } = await import('./RolesTab');

const SUMMARY = {
  stats: { members: 0, roles: 1, groups: 1, gated_resources: 0, overrides: 0 },
  resources: [],
  roles: [{ name: 'staff', label: 'Staff', color: null, description: '', rank: 40, scope_anchor: 'global',
            is_system: true, member_count: 0, matrix: {}, totp_required: false }],
  groups: [{ id: 'g1', name: 'Finance', description: '', icon: 'users', member_count: 0, members: [], totp_required: false }],
} as never;

afterEach(cleanup);

it('group card switch PATCHes the group', async () => {
  render(<GroupsTab summary={SUMMARY} canEdit onChanged={() => {}} initialGroupId="g1" />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /require 2fa/i }));
  await waitFor(() => expect(api.patchAccessGroup).toHaveBeenCalledWith('g1', { totp_required: true }));
});

it('role card switch PATCHes the role', async () => {
  render(<RolesTab summary={SUMMARY} canEdit maxRank={100} onChanged={() => {}} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /require 2fa/i }));
  await waitFor(() => expect(api.patchRole).toHaveBeenCalledWith('staff', { totp_required: true }));
});
```

Extend `SecurityControls.test.tsx`: add `vi.mock('../../lib/systemStatus', () => ({ getSystemStatus: async () => ({ totp_trust_days: 7 }) }));` and

```tsx
it('explains the policy and shows the trust window', async () => {
  render(<SecurityControls />);
  expect(await screen.findByText(/skip the code for 7 days/i)).toBeTruthy();
  expect(screen.getByText(/challenges enrolled users at sign-in/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/pages/UserDetail.test.tsx src/components/access/totpSwitches.test.tsx src/components/settings/SecurityControls.test.tsx`. Expected: failures.

- [ ] **Step 3: User detail**

`UserAdminModals.tsx` — add after `AccountStateModal`:

```tsx
export function ResetTotpModal({ user, onClose, onDone }: {
  user: ManagedUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setSaving(true); setError('');
    try {
      await adminResetTotp(user.person_id);
      onDone();
    } catch (err) {
      setError(errText(err));
      setSaving(false);
    }
  };
  return (
    <Modal title={`Reset two-factor — ${user.display_name}`} onClose={onClose}>
      <div className="modal-body">
        <p className="set-note" style={{ padding: 0, margin: 0 }}>
          Their authenticator, backup codes and remembered browsers are forgotten. If policy requires two-factor they set it up again at their next sign-in.
        </p>
      </div>
      <div className="modal-foot">
        <button className="btn-solid btn-danger" onClick={() => void run()} disabled={saving}>
          {saving ? 'Working…' : 'Reset two-factor'}
        </button>
        <button className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
        {error && <span className="pf-error">{error}</span>}
      </div>
    </Modal>
  );
}
```

(import `adminResetTotp`.) `UserDetail.tsx`: `Action` gains `| { kind: 'totp-reset' }`; import `ResetTotpModal` and `adminSetTotpRequired`; render `{action?.kind === 'totp-reset' && managed && <ResetTotpModal user={managed} onClose={() => setAction(null)} onDone={() => { setAction(null); void load(); }} />}`; pass to `UserProfileTab`: `onResetTotp={() => setAction({ kind: 'totp-reset' })}` and `onToggleTotpRequired={async (v) => { await adminSetTotpRequired(personId, v); await load(); }}`.

`UserProfileTab.tsx` — props `onResetTotp: () => void; onToggleTotpRequired: (v: boolean) => Promise<void>;` and after the Password row:

```tsx
                <dt>Two-factor</dt>
                <dd className="totp-row">
                  {account.totp_enrolled
                    ? <span className="chip c-green"><span className="dot" />Enrolled{account.totp_enrolled_at ? ` ${longDate(account.totp_enrolled_at)}` : ''}</span>
                    : <span className="chip tag">Not enrolled</span>}
                  {account.totp_effective_required && !account.totp_required && (
                    <span className="set-note">Required by policy</span>
                  )}
                  {canManage && (
                    <label className="totp-require">
                      <Switch label="Require 2FA" checked={account.totp_required || account.totp_effective_required}
                              disabled={account.totp_effective_required && !account.totp_required || toggling}
                              onChange={(v) => { setToggling(true); void onToggleTotpRequired(v).finally(() => setToggling(false)); }} />
                      <span>Require 2FA</span>
                    </label>
                  )}
                  {canManage && account.totp_enrolled && (
                    <button className="mini-btn danger" onClick={onResetTotp}>Reset 2FA</button>
                  )}
                </dd>
```

with `const [toggling, setToggling] = useState(false);` (import `useState`, `Switch`). Add `.kv .totp-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px } .totp-require { display:inline-flex; align-items:center; gap:6px; font-size:12.5px }` to `user-detail.css`.

- [ ] **Step 4: Access switches**

`GroupsTab.tsx` `GroupDetail`: after the `gc-sub` span add

```tsx
        <label className="totp-require">
          <Switch label="Require 2FA" checked={group.totp_required} disabled={!canEdit || busy}
                  onChange={(v) => void setTotp(v)} />
          <span>Require 2FA</span>
        </label>
```

with

```tsx
  const setTotp = async (v: boolean) => {
    setBusy(true); setError('');
    try { await patchAccessGroup(group.id, { totp_required: v }); onChanged(); }
    catch (err) { setError(msgFor(err)); }
    finally { setBusy(false); }
  };
```

`RolesTab.tsx` role head: after the `system` chip add the same label with `checked={role.totp_required}`, `disabled={!editable}`, calling `patchRole(role.name, { totp_required: v })` then `await onChanged()`; errors through the tab's existing `setErr(msgFor(e))`. Import `Switch` and the two api functions in each file. Add `.totp-require` to `access.css` (same rule as above).

- [ ] **Step 5: Security settings copy**

`SecurityControls.tsx`: import `getSystemStatus`; state `const [trustDays, setTrustDays] = useState<number | null>(null);` loaded in the effect (`getSystemStatus().then((s) => setTrustDays(s.totp_trust_days)).catch(() => {})`). Copy:

- row 1 `<span>`: "Lets people enroll an authenticator app and challenges enrolled users at sign-in."
- row 2 `<span>`: "Every user must enroll at their next sign-in. Turning this on also enables two-factor."
- new read-only row after row 2:

```tsx
      <div className="set-row">
        <div className="set-label">
          <b>Remembered browsers</b>
          <span>"Remember this browser" at the code step lets that browser skip the code for {trustDays ?? '…'} days (SS_TOTP_TRUST_DAYS).</span>
        </div>
      </div>
```

Update the file header comment (the policy is enforced now).

- [ ] **Step 6: Run the tests, then the whole portal suite and build**

Run: `npx vitest run src/pages/UserDetail.test.tsx src/components/access/totpSwitches.test.tsx src/components/settings/SecurityControls.test.tsx` then `npx vitest run` then `npm run build` (from `portal/`). Expected: green; build clean.

- [ ] **Step 7: Commit**

```bash
git add portal/src
git commit -m "feat(portal): admin 2FA — user reset + require switch, group/role Require 2FA, security settings copy"
```

---

### Task 9: Live verification and docs

**Files:**
- Modify: `docs/feature-parity-v2-v3.md` (the 2FA rows: mark enrollment, backup codes and trusted devices as done; note kiosk challenge deferred)
- Modify: `.superpowers/sdd/progress.md` (ledger, git-ignored)

- [ ] **Step 1: Run both full suites once more**

API: `… pytest -q` (600000 timeout). Portal: `npx vitest run && npm run build`. Expected: green (report any pre-existing WeasyPrint failures by name).

- [ ] **Step 2: Live verify (controller does this, not a subagent)**

Start the worktree API on 8001 and portal on 5175 (temporary entries in the main checkout's `.claude/launch.json`, `SS_ALLOWED_ORIGINS` extended, as in the list-column-floors session). In the browser pane: turn on "Enable two-factor" under Settings › Security as jhenderson; on My Profile click Set up 2FA, mint a code with `python3 -c "import pyotp;print(pyotp.TOTP('<secret shown>').now())"`, confirm, copy the codes; sign out, sign in → code card; verify with Remember checked → next sign-in skips the code; sign in from a private window → challenged; use a backup code; on the user detail page for claude-dev, flip Require 2FA and sign in as claude-dev → forced enrollment; Reset 2FA as admin; confirm the kiosk web login for the same account still works with no challenge. Screenshot the code card, the QR step and the backup codes step. Turn "Enable two-factor" back off in the dev DB when done unless Jimmy wants it on.

- [ ] **Step 3: Docs + commit**

Update the three parity rows, then:

```bash
git add docs/feature-parity-v2-v3.md
git commit -m "docs: parity workbook — 2FA enrollment, backup codes, trusted browsers shipped"
```

---

## Self-review notes

- Spec coverage: policy (T2 `policy_for`), data (T1), config (T1), service (T2), login flow + endpoints (T3), admin endpoints + CLI (T4), portal client (T5), login page (T6), profile (T7), user detail / access / settings (T8), tests per section, live verify (T9). The spec's "rate limiting reuses the IP limiter" is satisfied by the account lockout counter (every wrong code is a strike; the pairing limiter is table-specific and not reusable) — call this out in the final report.
- Type consistency: `TotpStatus`/`TotpStatusOut` field names match across API, `api.ts`, `AuthContext`; `X-Totp-Challenge` header everywhere; `status` discriminator `'ok' | 'totp_verify' | 'totp_enroll'`.
- `session_response` signature change (T3 Step 7) must be applied to every caller before the API suite passes.
