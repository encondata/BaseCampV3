# Password Expiry Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global password policy under System settings › Security: passwords expire after N days (default 90, clock starts when the switch is turned on), the last N passwords (default 3) can't be reused, expired passwords hit the existing forced-change gate at sign-in, and people get in-app reminders 7, 3 and 1 day before expiry.

**Architecture:** Policy values live in the existing `system_config` `security` section. A new `services/password_policy.py` owns the expiry math, the one helper that sets a password (and records `password_history`), and the reuse check. Session payloads (`SessionOut`/`MeOut`) compute `must_change_password` from the account flag OR expiry, so the portal's `ForceChangePassword` and the kiosk's `KioskGuard` need only copy changes. The notification worker runs an hourly reminder sweep that writes inbox rows through `notify()`.

**Tech Stack:** FastAPI + SQLAlchemy 2 (async) + Alembic + pytest (real Postgres); React 18 + TypeScript + Vitest (portal and kiosk).

**Spec:** `docs/superpowers/specs/2026-09-28-password-expiry-design.md`

## Global Constraints

- American English in all copy, comments, docs and commit messages.
- Config keys and defaults (exact): `password_expiry_enabled: false`, `password_expiry_days: 90` (1–365), `password_history_count: 3` (0–24), `password_expiry_since: null` (ISO timestamp, server-set only).
- Error codes (exact): `password_expiry_days_out_of_range`, `password_history_count_out_of_range` (422, on `PUT /system/security`); `password_recently_used` with `count` (422, on any password set).
- Session payload fields (exact): `must_change_password: bool`, `must_change_reason: "temporary" | "expired" | null`, `password_expires_at: datetime | null`. `"temporary"` wins over `"expired"`.
- Expiry date = `max(password_updated_at or since, since) + days`. Nothing is written to accounts when they expire.
- Reuse is checked only when the policy is enabled and `history_count > 0`; it applies to self-service change, admin reset and the CLI `set-password`; brand-new accounts skip the check but record history. History is trimmed to the newest 24 rows per account.
- Reminder kind (exact): `password_expiring`; stages `(7, 3, 1)`; one notification per stage per expiry date; skip when already expired.
- Migration file is `api/migrations/versions/0081_password_history.py` with `revision = "0081"`, `down_revision = "0073"`.
- Kiosk: `kiosk/src/**` changes only in Task 7 (KioskAuthContext, KioskGuard and their tests).
- Portal typography guardrail (`portal/src/styles/listTypography.test.ts`): no new CSS rules setting font properties on selectors matching `/(row|cell|list|table|chip|mono|\bpn\b|\bps\b|head|…)/i`, no inline `style={{ fontSize… }}`. This plan adds no new CSS.
- Commit messages end with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Environment (worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/password-expiry`):**
- `api/.venv`, `portal/node_modules`, `kiosk/node_modules` are symlinks to the main checkout; `.env` is copied to the worktree root. Never run `npm install`/`pip install`.
- API tests MUST run from `api/` with `PYTHONPATH=$PWD/src` (the venv's editable install points at the main checkout) and a per-branch DB: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/<file> -q`. The first run creates and migrates the DB (a few minutes). Run everything in the foreground with a long timeout; never background a test run.
- Portal: `cd portal && npx vitest run <paths>`; `npx tsc -b`. Kiosk: `cd kiosk && npx vitest run <paths>`; `npx tsc -b`.
- Test helpers: `tests/test_sites_api.py` (`login(client, email=…, pw=…)`, `make_login(db, client, person, email)`), `tests/test_status_values_write.py` (`_make(db, client, role, email)` → auth headers; password `PW` from that module), fixtures `client`, `db`, `seeded_user` (alice@test.example.com / CorrectHorse9!, role staff) in `tests/conftest.py`.

---

### Task 1: Policy settings in the security config (API)

**Files:**
- Modify: `api/src/serversherpa/system/config_store.py` (DEFAULTS["security"])
- Modify: `api/src/serversherpa/api/schemas.py` (`SecurityConfigOut`, `SecurityConfigIn`, ~line 2189)
- Modify: `api/src/serversherpa/api/routes/system.py` (`put_security_config`, ~line 157)
- Modify: `api/tests/test_system_security_api.py`, `api/tests/test_totp_admin_api.py:83` (exact-dict asserts)
- Create: `api/tests/test_password_expiry.py`

**Interfaces:**
- Produces: `read_section(db, "security")` now returns the four new keys with defaults. `PUT /system/security` accepts `password_expiry_enabled`, `password_expiry_days`, `password_history_count`; stamps/clears `password_expiry_since`. Later tasks read `password_expiry_since` as an ISO string (or `None`).

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_password_expiry.py`:

```python
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
```

Update the two exact-dict asserts in `api/tests/test_system_security_api.py` (lines 21, 30 and 32) to the new full shape. Add this helper at the top of that file (after `_admin`) and use it:

```python
def _cfg(**over):
    base = {"two_factor_enabled": False, "two_factor_required": False,
            "password_expiry_enabled": False, "password_expiry_days": 90,
            "password_history_count": 3, "password_expiry_since": None}
    return {**base, **over}
```

- line 21: `assert resp.json() == _cfg()`
- line 30: `assert resp.json() == _cfg(two_factor_enabled=True, two_factor_required=True)`
- line 32: `assert resp.json() == _cfg()`

`api/tests/test_totp_admin_api.py:83` seeds a `SystemConfig` row with only the two 2FA keys; `read_section` merges defaults, so it needs no change.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/test_password_expiry.py tests/test_system_security_api.py -q`
Expected: the three new tests FAIL (`KeyError: 'password_expiry_enabled'` / 422 on unknown keys); the `_cfg()` asserts FAIL because the response lacks the new keys.

- [ ] **Step 3: Add the defaults**

In `api/src/serversherpa/system/config_store.py`, replace the `"security"` entry of `DEFAULTS` with:

```python
    # 2FA policy flags plus the password expiry policy (To-Do #32).
    # password_expiry_since is server-set: the moment the switch was last
    # turned on; the expiry clock never reaches back before it.
    "security": {
        "two_factor_enabled": False,
        "two_factor_required": False,
        "password_expiry_enabled": False,
        "password_expiry_days": 90,
        "password_history_count": 3,
        "password_expiry_since": None,
    },
```

- [ ] **Step 4: Extend the schemas**

In `api/src/serversherpa/api/schemas.py`, replace `SecurityConfigOut` and `SecurityConfigIn` with:

```python
class SecurityConfigOut(BaseModel):
    two_factor_enabled: bool
    two_factor_required: bool
    password_expiry_enabled: bool
    password_expiry_days: int
    password_history_count: int
    password_expiry_since: datetime | None


class SecurityConfigIn(BaseModel):
    """Partial update — only sent fields change. `two_factor_required`
    implies `two_factor_enabled`; turning enabled off clears required.
    `password_expiry_since` is never accepted: the server stamps it when
    `password_expiry_enabled` flips on and clears it when it flips off."""

    model_config = ConfigDict(extra="forbid")

    two_factor_enabled: bool | None = None
    two_factor_required: bool | None = None
    password_expiry_enabled: bool | None = None
    password_expiry_days: int | None = None
    password_history_count: int | None = None
```

- [ ] **Step 5: Validate and stamp in the route**

In `api/src/serversherpa/api/routes/system.py`, add these constants next to `SECURITY_SECTION = "security"`:

```python
PASSWORD_EXPIRY_DAYS_RANGE = (1, 365)
PASSWORD_HISTORY_COUNT_RANGE = (0, 24)
```

In `put_security_config`, after the two-factor coupling lines (`if patch.get("two_factor_enabled") is False: data["two_factor_required"] = False`) and before `row = await db.get(SystemConfig, SECURITY_SECTION)`, insert:

```python
    lo, hi = PASSWORD_EXPIRY_DAYS_RANGE
    if not lo <= data["password_expiry_days"] <= hi:
        raise _err(422, "password_expiry_days_out_of_range")
    lo, hi = PASSWORD_HISTORY_COUNT_RANGE
    if not lo <= data["password_history_count"] <= hi:
        raise _err(422, "password_history_count_out_of_range")
    # the expiry clock starts when the switch goes on, never earlier
    if data["password_expiry_enabled"] and not stored.get("password_expiry_enabled"):
        data["password_expiry_since"] = datetime.now(UTC).isoformat()
    elif not data["password_expiry_enabled"]:
        data["password_expiry_since"] = None
```

`_err` already exists in this file (line 55) and `datetime`/`UTC` are imported. The audit `changes` dict below already picks up `password_expiry_since` because it compares every key.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/test_password_expiry.py tests/test_system_security_api.py tests/test_totp_admin_api.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/system/config_store.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/system.py api/tests/test_password_expiry.py api/tests/test_system_security_api.py
git commit -m "feat(api): password expiry policy keys in the security config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Password history table and the policy service

**Files:**
- Create: `api/migrations/versions/0081_password_history.py`
- Modify: `api/src/serversherpa/db/models.py` (add `PasswordHistory` after `UserAccount`)
- Create: `api/src/serversherpa/services/password_policy.py`
- Test: `api/tests/test_password_expiry.py` (append)

**Interfaces:**
- Produces (all in `serversherpa.services.password_policy`):
  - `@dataclass PasswordPolicy(enabled: bool, days: int, history_count: int, since: datetime | None)`
  - `async load_policy(db: AsyncSession) -> PasswordPolicy`
  - `expires_at(policy: PasswordPolicy, account: UserAccount) -> datetime | None`
  - `change_reason(policy: PasswordPolicy, account: UserAccount, now: datetime) -> Literal["temporary", "expired"] | None`
  - `class PasswordReused(Exception)` with attribute `count: int`
  - `async assert_not_reused(db, policy, account, new_password: str) -> None` (raises `PasswordReused`)
  - `async apply_password(db, account, new_password: str, *, must_change: bool, now: datetime) -> None`
  - `HISTORY_KEEP = 24`
- Produces: model `PasswordHistory(id, person_id, password_hash, created_at)` in `serversherpa.db.models`.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_password_expiry.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/test_password_expiry.py -q`
Expected: FAIL at import (`ModuleNotFoundError: serversherpa.services.password_policy`).

- [ ] **Step 3: Write the migration**

Create `api/migrations/versions/0081_password_history.py`:

```python
"""Password history for the reuse rule (To-Do #32).

One row per password an account has had. Backfilled with each account's
current hash so the current password counts as the newest of the "last
N" from day one.

Revision ID: 0081
Revises: 0073
Create Date: 2026-09-28

Numbered 0081: 0074–0079 belong to the unmerged `wiki` branch and 0080 to the
unmerged `spec-lookup` branch. Whichever of those merges first, re-point
`down_revision` at merge time.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0081"
down_revision: str | None = "0073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "password_history",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("user_accounts.person_id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_password_history_person_created", "password_history",
                    ["person_id", sa.text("created_at DESC")])
    op.execute(
        "INSERT INTO password_history (person_id, password_hash, created_at) "
        "SELECT person_id, password_hash, COALESCE(password_updated_at, now()) "
        "FROM user_accounts WHERE password_hash IS NOT NULL")


def downgrade() -> None:
    op.drop_index("ix_password_history_person_created", table_name="password_history")
    op.drop_table("password_history")
```

- [ ] **Step 4: Add the model**

In `api/src/serversherpa/db/models.py`, directly after the `UserAccount` class (before `class OrgColumns`), add:

```python
class PasswordHistory(Base):
    """Every password an account has had, newest first by created_at.
    Written only by services.password_policy.apply_password, which also
    trims it to HISTORY_KEEP rows. Read by the reuse rule."""
    __tablename__ = "password_history"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_accounts.person_id", ondelete="CASCADE"))
    password_hash: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"))
```

- [ ] **Step 5: Write the service**

Create `api/src/serversherpa/services/password_policy.py`:

```python
"""Password expiry policy (System settings › Security, To-Do #32).

Expiry is computed, never stored: an account's password expires
`days` after the later of its last change and the moment the switch was
turned on, so flipping the switch off makes everyone current at once.
apply_password() is the ONE way a password gets set — it also records
the hash in password_history for the reuse rule.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import PasswordHistory, UserAccount
from serversherpa.security.passwords import hash_password, verify_password
from serversherpa.system.config_store import read_section

HISTORY_KEEP = 24   # the largest history_count the policy allows

ChangeReason = Literal["temporary", "expired"]


@dataclass(frozen=True)
class PasswordPolicy:
    enabled: bool
    days: int
    history_count: int
    since: datetime | None


class PasswordReused(Exception):
    """The new password matches one of the last `count` passwords."""

    def __init__(self, count: int) -> None:
        super().__init__(f"password used within the last {count}")
        self.count = count


async def load_policy(db: AsyncSession) -> PasswordPolicy:
    cfg = await read_section(db, "security")
    raw = cfg.get("password_expiry_since")
    since = datetime.fromisoformat(raw) if raw else None
    if since is not None and since.tzinfo is None:
        since = since.replace(tzinfo=UTC)
    return PasswordPolicy(
        enabled=bool(cfg.get("password_expiry_enabled", False)),
        days=int(cfg.get("password_expiry_days", 90)),
        history_count=int(cfg.get("password_history_count", 3)),
        since=since,
    )


def expires_at(policy: PasswordPolicy, account: UserAccount) -> datetime | None:
    """When this account's password stops working, or None when the
    policy is off (or the switch has no stamp yet) or there is no password."""
    if not policy.enabled or policy.since is None or account.password_hash is None:
        return None
    changed = account.password_updated_at
    if changed is not None and changed.tzinfo is None:
        changed = changed.replace(tzinfo=UTC)
    start = policy.since if changed is None else max(changed, policy.since)
    return start + timedelta(days=policy.days)


def change_reason(policy: PasswordPolicy, account: UserAccount,
                  now: datetime) -> ChangeReason | None:
    """Why the account must set a new password before doing anything
    else — a temporary password from an admin wins over expiry."""
    if account.must_change_password:
        return "temporary"
    due = expires_at(policy, account)
    if due is not None and due <= now:
        return "expired"
    return None


async def assert_not_reused(db: AsyncSession, policy: PasswordPolicy,
                            account: UserAccount, new_password: str) -> None:
    """Raise PasswordReused when new_password matches one of the newest
    `history_count` history rows. No-op while the policy is off or the
    count is 0."""
    if not policy.enabled or policy.history_count <= 0:
        return
    pepper = get_settings().password_pepper.get_secret_value()
    rows = await db.scalars(
        select(PasswordHistory.password_hash)
        .where(PasswordHistory.person_id == account.person_id)
        .order_by(PasswordHistory.created_at.desc())
        .limit(policy.history_count))
    # The current password is the newest of the "last N" even when history
    # predates it (accounts created before the table, or by a fixture).
    candidates: list[str] = []
    if account.password_hash is not None:
        candidates.append(account.password_hash)
    for old_hash in rows:
        if old_hash not in candidates:
            candidates.append(old_hash)
    for old_hash in candidates[:policy.history_count]:
        if verify_password(old_hash, new_password, pepper=pepper):
            raise PasswordReused(policy.history_count)


async def apply_password(db: AsyncSession, account: UserAccount, new_password: str, *,
                         must_change: bool, now: datetime) -> None:
    """Set the password, stamp the account, record history and trim it.
    Adds to the caller's session; never commits. A brand-new account
    (no password_hash yet) records only the new password."""
    pepper = get_settings().password_pepper.get_secret_value()
    if account.password_hash is not None and account.person_id is not None:
        # first change on an account with no history yet: keep the password
        # being replaced, so "the last N" reaches back past this change
        has_history = await db.scalar(
            select(PasswordHistory.id)
            .where(PasswordHistory.person_id == account.person_id).limit(1))
        if has_history is None:
            db.add(PasswordHistory(
                person_id=account.person_id, password_hash=account.password_hash,
                created_at=account.password_updated_at or (now - timedelta(seconds=1))))
    account.password_hash = hash_password(new_password, pepper=pepper)
    account.password_updated_at = now
    account.must_change_password = must_change
    account.updated_at = now
    db.add(PasswordHistory(person_id=account.person_id,
                           password_hash=account.password_hash, created_at=now))
    await db.flush()
    keep = select(PasswordHistory.id).where(
        PasswordHistory.person_id == account.person_id
    ).order_by(PasswordHistory.created_at.desc()).limit(HISTORY_KEEP)
    await db.execute(
        delete(PasswordHistory)
        .where(PasswordHistory.person_id == account.person_id,
               PasswordHistory.id.not_in(keep)))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/test_password_expiry.py -q`
Expected: PASS (the conftest upgrades the test DB to 0081 on the first run; if it reports two heads, another worktree's migrations leaked into the DB — use a fresh `SS_TEST_DB` name).

Also run the alembic single-head check that other tests use, e.g. `tests/test_container_labels_report.py -q -k head` if such a test exists; otherwise `cd api && PYTHONPATH=$PWD/src .venv/bin/alembic heads` must print exactly one head (`0081`).

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0081_password_history.py api/src/serversherpa/db/models.py api/src/serversherpa/services/password_policy.py api/tests/test_password_expiry.py
git commit -m "feat(api): password history table and the password policy service

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Every password set goes through the policy

**Files:**
- Modify: `api/src/serversherpa/api/routes/me.py` (`change_password`, ~line 129)
- Modify: `api/src/serversherpa/api/routes/users.py` (create user with account ~line 366, promote contact ~line 500, `reset_password` ~line 520)
- Modify: `api/src/serversherpa/cli.py` (`bootstrap_admin` ~line 30, `set_password` ~line 307)
- Modify: `api/src/serversherpa/api/deps.py` (add `raise_if_reused` helper)
- Test: `api/tests/test_password_expiry.py` (append)

**Interfaces:**
- Consumes: `load_policy`, `assert_not_reused`, `apply_password`, `PasswordReused` from Task 2.
- Produces: `deps.raise_if_reused(db, account, password) -> None` (async; loads the policy and maps `PasswordReused` to `HTTPException(422, {"code": "password_recently_used", "count": n})`).

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_password_expiry.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/test_password_expiry.py -q -k "reuse or reset or new_accounts"`
Expected: FAIL — the reuse cases return 204 instead of 422; the history-count asserts fail.

- [ ] **Step 3: Add the dependency helper**

In `api/src/serversherpa/api/deps.py`, directly after `require_password_length`, add:

```python
async def raise_if_reused(db, account, password: str) -> None:
    """The reuse rule for every password the API accepts on an EXISTING
    account (self-change, admin reset). New accounts have no history."""
    from serversherpa.services.password_policy import PasswordReused, assert_not_reused, load_policy

    try:
        await assert_not_reused(db, await load_policy(db), account, password)
    except PasswordReused as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "password_recently_used", "count": exc.count}) from None
```

(The import is local to avoid a `deps` ↔ `services` import cycle at module load; follow whatever the file already does for similar helpers if it has a convention.)

- [ ] **Step 4: Self-service change**

In `api/src/serversherpa/api/routes/me.py`:
- Import: change `from serversherpa.api.deps import CurrentUser, DbSession, require_password_length` to include `raise_if_reused`; add `from serversherpa.services.password_policy import apply_password`; drop `hash_password` from the `security.passwords` import if nothing else in the file uses it (keep `verify_password`).
- In `change_password`, replace the block from `now = datetime.now(UTC)` through `account.updated_at = now` with:

```python
    await raise_if_reused(db, account, body.new_password)

    now = datetime.now(UTC)
    await apply_password(db, account, body.new_password, must_change=False, now=now)
```

Keep the `same_as_current` check above it and the session-revoke/audit/commit below it unchanged.

- [ ] **Step 5: Admin paths**

In `api/src/serversherpa/api/routes/users.py`:
- Imports: add `raise_if_reused` to the `serversherpa.api.deps` import list; add `from serversherpa.services.password_policy import apply_password`; remove `from serversherpa.security.passwords import hash_password` once no use remains.
- `reset_password`: replace from `_, account, _ = await _load_target(db, actor, person_id)` through `account.updated_at = now` with:

```python
    _, account, _ = await _load_target(db, actor, person_id)
    await raise_if_reused(db, account, body.temp_password)
    now = datetime.now(UTC)
    await apply_password(db, account, body.temp_password,
                         must_change=body.must_change_password, now=now)
    account.failed_login_count = 0
    account.locked_until = None
```

- Promote a contact (`POST /{person_id}/account`): replace the `db.add(UserAccount(...))` block with:

```python
    account = UserAccount(
        person_id=person.id,
        email=body.login_email,
        created_by=actor.person.id,
    )
    db.add(account)
    await apply_password(db, account, body.temp_password,
                         must_change=body.must_change_password, now=datetime.now(UTC))
```

- Create user with `create_account` (~line 366): replace the `account = UserAccount(...)` / `db.add(account)` block with:

```python
        account = UserAccount(
            person_id=person.id,
            email=body.login_email,
            created_by=actor.person.id,
        )
        db.add(account)
        await apply_password(db, account, body.temp_password,
                             must_change=body.must_change_password, now=now)
```

(`now` is already defined earlier in that function; if not, use `datetime.now(UTC)`.) `apply_password` flushes, which needs `person.id` — both paths already flushed the person.

- [ ] **Step 6: CLI**

In `api/src/serversherpa/cli.py`:
- Import: `from serversherpa.services.password_policy import PasswordReused, apply_password, assert_not_reused, load_policy`; remove the `hash_password` import if unused afterwards.
- `bootstrap_admin`: replace the `db.add(UserAccount(...))` block with:

```python
            account = UserAccount(person_id=person.id, email=email)
            db.add(account)
            await apply_password(db, account, password, must_change=False, now=now)
```

- `set_password`: replace the three `account.password_hash = …` / `password_updated_at` / `must_change_password = False` lines with:

```python
            try:
                await assert_not_reused(db, await load_policy(db), account, password)
            except PasswordReused as exc:
                typer.secho(f"That password was one of the last {exc.count} used for "
                            f"{email}. Choose a different one.", fg="red")
                raise typer.Exit(code=1) from None
            await apply_password(db, account, password, must_change=False,
                                 now=datetime.now(UTC))
```

- [ ] **Step 7: Run the tests**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/test_password_expiry.py tests/test_password_policy.py tests/test_users_api.py tests/test_me_api.py tests/test_account_mgmt.py tests/test_auth_hardening_api.py -q`
Expected: PASS.

Then grep: `grep -rn "hash_password" api/src/serversherpa --include=*.py` must show only `security/passwords.py`, `services/password_policy.py` and `services/totp.py` (if it hashes backup codes). Remove any unused imports the grep reveals; `ruff` (`cd api && .venv/bin/ruff check src`) must be clean.

- [ ] **Step 8: Commit**

```bash
git add api/src/serversherpa/api/deps.py api/src/serversherpa/api/routes/me.py api/src/serversherpa/api/routes/users.py api/src/serversherpa/cli.py api/tests/test_password_expiry.py
git commit -m "feat(api): every password set records history and honors the reuse rule

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Expired passwords hit the forced-change gate

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (`SessionOut` ~line 121, `MeOut` ~line 147)
- Modify: `api/src/serversherpa/api/routes/auth.py` (`session_response` line 87 and its three callers at ~129, ~147, ~206; `/auth/me` ~line 158)
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (~line 122)
- Test: `api/tests/test_password_expiry.py` (append)

**Interfaces:**
- Consumes: `load_policy`, `change_reason`, `expires_at` from Task 2.
- Produces: `session_response(result, response, totp, policy) -> SessionOut` (new fourth positional parameter `policy: PasswordPolicy`). `SessionOut`/`MeOut` gain `must_change_reason` and `password_expires_at`.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_password_expiry.py`:

```python
# ── the sign-in gate ────────────────────────────────────────────────

from sqlalchemy import update  # noqa: E402


async def _backdate(db, person_id, *, days):
    await db.execute(update(UserAccount).where(UserAccount.person_id == person_id)
                     .values(password_updated_at=datetime.now(UTC) - timedelta(days=days)))
    await db.commit()


async def _backdate_since(db, *, days):
    from serversherpa.db.models import SystemConfig
    row = await db.get(SystemConfig, "security")
    row.data = {**row.data,
                "password_expiry_since": (datetime.now(UTC) - timedelta(days=days)).isoformat()}
    await db.commit()


async def test_expired_password_forces_a_change_at_sign_in(client, db, seeded_user):
    await _enable_policy(client, db, password_expiry_days=30)
    await _backdate(db, seeded_user.id, days=100)
    # the switch went on just now: the clock starts today, so alice is fine
    resp = await client.post("/auth/login", json={"email": "alice@test.example.com",
                                                  "password": "CorrectHorse9!"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["must_change_password"] is False
    assert resp.json()["must_change_reason"] is None
    assert resp.json()["password_expires_at"] is not None
    # …until the switch itself is older than the window
    await _backdate_since(db, days=31)
    resp = await client.post("/auth/login", json={"email": "alice@test.example.com",
                                                  "password": "CorrectHorse9!"})
    body = resp.json()
    assert body["must_change_password"] is True
    assert body["must_change_reason"] == "expired"
    hdrs = {"Authorization": f"Bearer {body['access_token']}"}
    me = (await client.get("/auth/me", headers=hdrs)).json()
    assert me["must_change_password"] is True and me["must_change_reason"] == "expired"
    refreshed = await client.post("/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["must_change_reason"] == "expired"
    # changing the password clears it
    change = await _change(client, hdrs, "CorrectHorse9!", "Fresh-pw-2026")
    assert change.status_code == 204, change.text
    me = (await client.get("/auth/me", headers=hdrs)).json()
    assert me["must_change_password"] is False and me["must_change_reason"] is None


async def test_policy_off_means_nothing_expires(client, db, seeded_user):
    await _backdate(db, seeded_user.id, days=400)
    resp = await client.post("/auth/login", json={"email": "alice@test.example.com",
                                                  "password": "CorrectHorse9!"})
    assert resp.json()["must_change_password"] is False
    assert resp.json()["password_expires_at"] is None


async def test_temporary_wins_over_expired(client, db, seeded_user):
    await _enable_policy(client, db, password_expiry_days=1)
    await _backdate_since(db, days=2)
    await db.execute(update(UserAccount).where(UserAccount.person_id == seeded_user.id)
                     .values(must_change_password=True))
    await db.commit()
    resp = await client.post("/auth/login", json={"email": "alice@test.example.com",
                                                  "password": "CorrectHorse9!"})
    assert resp.json()["must_change_reason"] == "temporary"


async def test_kiosk_login_reports_expiry_too(client, db, seeded_user):
    worker = Person(first_name="Kay", last_name="Kiosk", email="kay-pw@test.example.com")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()
    await make_login(db, client, worker, "kay-pw@test.example.com")
    await _enable_policy(client, db, password_expiry_days=1)
    await _backdate_since(db, days=2)
    await _backdate(db, worker.id, days=5)
    resp = await client.post("/auth/login", json={
        "email": "kay-pw@test.example.com", "password": "CorrectHorse9!", "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["must_change_password"] is True
    assert resp.json()["must_change_reason"] == "expired"
```

(If the worker role lacks `kiosk:view` in the seeded access defaults, use the role the existing `tests/test_auth_kiosk_login.py` uses for a permitted kiosk login.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/test_password_expiry.py -q -k "sign_in or nothing_expires or temporary_wins or kiosk_login"`
Expected: FAIL (`KeyError: 'must_change_reason'`).

- [ ] **Step 3: Schemas**

In `api/src/serversherpa/api/schemas.py`, in both `SessionOut` and `MeOut`, directly after `must_change_password: bool`, add:

```python
    must_change_reason: Literal["temporary", "expired"] | None = None
    password_expires_at: datetime | None = None
```

- [ ] **Step 4: Session response and /auth/me**

In `api/src/serversherpa/api/routes/auth.py`:
- Import: `from serversherpa.services.password_policy import PasswordPolicy, change_reason, expires_at, load_policy` and `from datetime import UTC, datetime` (if not present).
- Replace `session_response` with:

```python
def session_response(result: AuthResult, response: Response, totp: TotpStatusOut,
                     policy: PasswordPolicy) -> SessionOut:
    _set_refresh_cookie(response, result)
    reason = change_reason(policy, result.account, datetime.now(UTC))
    return SessionOut(
        access_token=result.access_token,
        expires_in=get_settings().access_token_ttl_seconds,
        session_expires_at=result.session_expires_at,
        person=person_out(result.person),
        roles=result.roles,
        must_change_password=reason is not None,
        must_change_reason=reason,
        password_expires_at=expires_at(policy, result.account),
        preferences=UiPreferences.model_validate(result.account.ui_prefs or {}),
        perms=result.access.perms,
        max_rank=result.access.max_rank,
        scope=_scope_out(result.access),
        password_min_length=get_settings().password_min_length,
        totp=totp,
    )
```

- Each of the three callers in this file becomes `session_response(result, response, await totp_status_out(db, <account>), await load_policy(db))` (keep each call's own account variable: `result.account`, `result.account`, `actor.account`).
- In `me()`, compute `policy = await load_policy(db)` and `reason = change_reason(policy, user.account, datetime.now(UTC))`, then set `must_change_password=reason is not None, must_change_reason=reason, password_expires_at=expires_at(policy, user.account)`.

In `api/src/serversherpa/api/routes/kiosk.py` (~line 122): add `from serversherpa.services.password_policy import load_policy` and change the call to `session_response(result, response, await totp_status_out(db, account), await load_policy(db))`.

- [ ] **Step 5: Run the tests**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/test_password_expiry.py tests/test_auth_flow.py tests/test_auth_kiosk_login.py tests/test_totp_api.py tests/test_kiosk_pairing_api.py -q` (use the kiosk pairing test file's real name; `ls api/tests | grep -i pair`).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/auth.py api/src/serversherpa/api/routes/kiosk.py api/tests/test_password_expiry.py
git commit -m "feat(api): expired passwords force a change at sign-in (portal and kiosk)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Expiry reminders from the notification worker

**Files:**
- Create: `api/src/serversherpa/notifications/password_reminders.py`
- Modify: `api/src/serversherpa/notifications/worker.py`
- Test: `api/tests/test_password_expiry.py` (append), `api/tests/test_notification_worker.py` (append one test)

**Interfaces:**
- Consumes: `load_policy`, `expires_at` (Task 2); `notify` from `serversherpa.notifications.inbox`.
- Produces: `password_reminders.run_password_reminders(db, now) -> int`, `password_reminders.run_reminders_once(maker) -> int` (opens its own session, logs and swallows exceptions), `REMINDER_STAGES = (7, 3, 1)`, `KIND = "password_expiring"`; worker constant `REMINDER_INTERVAL_SECONDS = 3600`.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_password_expiry.py`:

```python
# ── reminders ───────────────────────────────────────────────────────

from serversherpa.db.models import Notification  # noqa: E402
from serversherpa.notifications.password_reminders import (  # noqa: E402
    KIND, run_password_reminders, run_reminders_once,
)


async def _set_policy_direct(db, *, enabled=True, days=90, since):
    from serversherpa.db.models import SystemConfig
    row = await db.get(SystemConfig, "security")
    data = dict(row.data) if row else {}
    data.update({"password_expiry_enabled": enabled, "password_expiry_days": days,
                 "password_history_count": 3,
                 "password_expiry_since": since.isoformat() if since else None})
    if row is None:
        db.add(SystemConfig(section="security", data=data))
    else:
        row.data = data
    await db.commit()


async def _reminders(db, person_id):
    return list(await db.scalars(select(Notification).where(
        Notification.person_id == person_id, Notification.kind == KIND)
        .order_by(Notification.created_at)))


async def _with_days_left(db, person_id, days_left: float, *, policy_days=90):
    """Arrange the policy so the seeded user's password expires `days_left`
    days from now (fractional allowed)."""
    since = datetime.now(UTC) - timedelta(days=policy_days) + timedelta(days=days_left)
    await _set_policy_direct(db, days=policy_days, since=since)
    await db.execute(update(UserAccount).where(UserAccount.person_id == person_id)
                     .values(password_updated_at=since - timedelta(days=1)))
    await db.commit()


async def test_reminders_fire_once_per_stage(db, seeded_user):
    now = datetime.now(UTC)
    await _set_policy_direct(db, enabled=False, since=None)
    assert await run_password_reminders(db, now) == 0
    await _with_days_left(db, seeded_user.id, 10)
    assert await run_password_reminders(db, now) == 0
    await _with_days_left(db, seeded_user.id, 6)
    assert await run_password_reminders(db, now) == 1
    assert await run_password_reminders(db, now) == 0          # dedup
    rows = await _reminders(db, seeded_user.id)
    assert rows[0].payload["stage"] == 7 and rows[0].payload["days_left"] == 6
    assert rows[0].title == "Your password expires in 6 days"
    assert rows[0].link == "/me"
    assert "before" in rows[0].body and "My Profile" in rows[0].body
    await _with_days_left(db, seeded_user.id, 2.5)
    assert await run_password_reminders(db, now) == 1
    await _with_days_left(db, seeded_user.id, 0.5)
    assert await run_password_reminders(db, now) == 1
    rows = await _reminders(db, seeded_user.id)
    assert [r.payload["stage"] for r in rows] == [7, 3, 1]
    assert rows[-1].title == "Your password expires in 1 day"
    await _with_days_left(db, seeded_user.id, -1)
    assert await run_password_reminders(db, now) == 0          # expired: the gate handles it


async def test_reminders_skip_disabled_accounts_and_jump_to_the_urgent_stage(db, seeded_user):
    now = datetime.now(UTC)
    other = Person(first_name="Dee", last_name="Disabled", email="dee-pw@test.example.com")
    db.add(other)
    await db.flush()
    db.add(UserAccount(person_id=other.id, email="dee-pw@test.example.com",
                       password_hash="x", disabled_at=now))
    await db.commit()
    await _with_days_left(db, seeded_user.id, 2)     # inside the 7- and 3-day windows at once
    await db.execute(update(UserAccount).where(UserAccount.person_id == other.id)
                     .values(password_updated_at=datetime.now(UTC) - timedelta(days=200)))
    await db.commit()
    assert await run_password_reminders(db, now) == 1
    rows = await _reminders(db, seeded_user.id)
    assert [r.payload["stage"] for r in rows] == [3]
    assert await _reminders(db, other.id) == []


async def test_run_reminders_once_swallows_errors(db, seeded_user, caplog, monkeypatch):
    import logging

    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.notifications import password_reminders

    async def boom(*_a, **_k):
        raise RuntimeError("db is on fire")

    monkeypatch.setattr(password_reminders, "run_password_reminders", boom)
    caplog.set_level(logging.ERROR, logger="serversherpa.notifications.password_reminders")
    assert await run_reminders_once(get_sessionmaker()) == 0
    assert "db is on fire" in caplog.text
```

Append to `api/tests/test_notification_worker.py`:

```python
async def test_run_forever_runs_the_reminder_sweep(db, caplog, monkeypatch):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def fake_once(maker):
        calls.append(maker)
        return 0

    monkeypatch.setattr(worker_mod, "run_reminders_once", fake_once)
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) == 1   # once on the first loop; the next is an hour away
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/test_password_expiry.py tests/test_notification_worker.py -q -k "reminder"`
Expected: FAIL at import (`serversherpa.notifications.password_reminders` missing; `run_reminders_once` not on the worker module).

- [ ] **Step 3: Write the reminder module**

Create `api/src/serversherpa/notifications/password_reminders.py`:

```python
"""Password-expiry reminders (To-Do #32): 7, 3 and 1 day before a
password expires, one inbox row per stage. Runs from the notification
worker; email fans out from notify() when it exists."""

import logging
import math
from datetime import UTC, datetime, timedelta

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification, Person, UserAccount
from serversherpa.notifications.inbox import notify
from serversherpa.services.password_policy import expires_at, load_policy

logger = logging.getLogger("serversherpa.notifications.password_reminders")

KIND = "password_expiring"
REMINDER_STAGES = (7, 3, 1)


def _days_left(due: datetime, now: datetime) -> int:
    return math.ceil((due - now) / timedelta(days=1))


async def _already_sent(db: AsyncSession, person_id, due_iso: str, stage: int) -> bool:
    return bool(await db.scalar(select(exists().where(
        Notification.person_id == person_id,
        Notification.kind == KIND,
        Notification.payload["expires_at"].astext == due_iso,
        Notification.payload["stage"].astext == str(stage)))))


async def run_password_reminders(db: AsyncSession, now: datetime) -> int:
    """One sweep. Returns how many reminders were written. Commits."""
    policy = await load_policy(db)
    if not policy.enabled:
        return 0
    accounts = await db.scalars(
        select(UserAccount).join(Person, Person.id == UserAccount.person_id)
        .where(UserAccount.password_hash.is_not(None),
               UserAccount.disabled_at.is_(None),
               Person.archived_at.is_(None)))
    sent = 0
    for account in accounts:
        due = expires_at(policy, account)
        if due is None:
            continue
        days_left = _days_left(due, now)
        if days_left < 1:
            continue                      # expired: the sign-in gate takes over
        stages_due = [s for s in REMINDER_STAGES if days_left <= s]
        if not stages_due:
            continue
        stage = min(stages_due)           # the most urgent window only
        due_iso = due.isoformat()
        if await _already_sent(db, account.person_id, due_iso, stage):
            continue
        unit = "day" if days_left == 1 else "days"
        await notify(
            db, account.person_id, KIND, f"Your password expires in {days_left} {unit}",
            body=(f"Change it under My Profile › Security before "
                  f"{due.astimezone(UTC):%B %-d, %Y} to avoid being asked at sign-in."),
            link="/me",
            payload={"expires_at": due_iso, "stage": stage, "days_left": days_left})
        sent += 1
    if sent:
        await db.commit()
    return sent


async def run_reminders_once(maker) -> int:
    """The worker's entry point: own session, never raises."""
    try:
        async with maker() as db:
            return await run_password_reminders(db, datetime.now(UTC))
    except Exception:
        logger.exception("password expiry reminder sweep failed")
        return 0
```

- [ ] **Step 4: Wire the worker**

In `api/src/serversherpa/notifications/worker.py`:
- Replace the module docstring with:

```python
"""The notification-worker loop — a separate process from the API
(`serversherpa notification-worker`). Today it runs the password-expiry
reminder sweep once an hour (notifications/password_reminders.py) and
logs a status line; the delivery pipeline (email, quiet hours, DND) is a
later task. Other DB touches are the heartbeat upsert, log writes and
read-only count queries."""
```

- Add `from serversherpa.notifications.password_reminders import run_reminders_once` and `REMINDER_INTERVAL_SECONDS = 3600` next to `IDLE_LOG_SECONDS`.
- In `run_forever`, seed `last_reminders = time.monotonic() - REMINDER_INTERVAL_SECONDS` next to `last_log`, and in the loop after the pause handling and before the idle-log block add:

```python
            if now - last_reminders >= REMINDER_INTERVAL_SECONDS:
                sent = await run_reminders_once(maker)
                if sent:
                    logger.info("sent %d password expiry reminder(s)", sent)
                last_reminders = now
```

(`now = time.monotonic()` is already computed just above the idle-log check; move that line up so both checks use it.) Update `logger.info("notification worker online — …")` to `"notification worker online — hourly password expiry reminders; no delivery pipeline yet"`. Leave `run_once`/`status_counts` as they are.

- [ ] **Step 5: Run the tests**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp .venv/bin/pytest tests/test_password_expiry.py tests/test_notification_worker.py tests/test_notifications_inbox.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/notifications/password_reminders.py api/src/serversherpa/notifications/worker.py api/tests/test_password_expiry.py api/tests/test_notification_worker.py
git commit -m "feat(api): password expiry reminders 7, 3 and 1 day out from the notification worker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Portal — settings rows, forced-change copy, reuse error, profile line, inbox icon

**Files:**
- Modify: `portal/src/lib/api.ts` (`SessionData` ~line 146, `SecurityConfig` ~line 3860)
- Modify: `portal/src/auth/AuthContext.tsx`
- Modify: `portal/src/components/ForceChangePassword.tsx`
- Modify: `portal/src/components/ChangePasswordForm.tsx` (`ERRORS`)
- Modify: `portal/src/components/UserAdminModals.tsx` (`GUARD_ERRORS`)
- Modify: `portal/src/pages/Profile.tsx` (Security › Password line)
- Modify: `portal/src/components/NotificationsPanel.tsx` (`KindIcon`)
- Modify: `portal/src/components/settings/SecurityControls.tsx`
- Tests: `portal/src/components/settings/SecurityControls.test.tsx`, `portal/src/components/ForceChangePassword.test.tsx`, `portal/src/auth/AuthContext.totp.test.tsx`, `portal/src/components/NotificationsPanel.test.tsx`

**Interfaces:**
- Consumes: API fields from Tasks 1 and 4 (`SecurityConfig` keys; `must_change_reason`, `password_expires_at`; error code `password_recently_used`).
- Produces: `useAuth()` exposes `mustChangeReason: 'temporary' | 'expired' | null` and `passwordExpiresAt: string | null`.

- [ ] **Step 1: Write the failing tests**

`portal/src/components/settings/SecurityControls.test.tsx` — update the mocks in `beforeEach`:

```ts
const CFG = {
  two_factor_enabled: false, two_factor_required: false,
  password_expiry_enabled: false, password_expiry_days: 90, password_history_count: 3,
  password_expiry_since: null as string | null,
};
beforeEach(() => {
  api.getSecurityConfig.mockResolvedValue({ ...CFG });
  api.updateSecurityConfig.mockImplementation(async (p: Record<string, boolean | number>) => ({
    ...CFG,
    two_factor_enabled: !!(p.two_factor_enabled || p.two_factor_required),
    two_factor_required: !!p.two_factor_required,
    ...p,
  }));
  api.revokeAllSessions.mockResolvedValue({ revoked_sessions: 4, revoked_people: 3 });
});
```

and append:

```ts
it('shows the password policy rows and saves the switch and the numbers', async () => {
  render(<SecurityControls />);
  await waitFor(() => expect(switches()[2].disabled).toBe(false));
  expect(screen.getByText('Password expiry')).toBeTruthy();
  fireEvent.click(switches()[2]);
  await waitFor(() => expect(api.updateSecurityConfig).toHaveBeenCalledWith({ password_expiry_enabled: true }));
  const days = screen.getByLabelText('Expires after') as HTMLInputElement;
  expect(days.value).toBe('90');
  fireEvent.change(days, { target: { value: '60' } });
  fireEvent.blur(days);
  await waitFor(() => expect(api.updateSecurityConfig).toHaveBeenCalledWith({ password_expiry_days: 60 }));
  const count = screen.getByLabelText('Prevent reuse of the last') as HTMLInputElement;
  expect(count.value).toBe('3');
  fireEvent.change(count, { target: { value: '5' } });
  fireEvent.keyDown(count, { key: 'Enter' });
  await waitFor(() => expect(api.updateSecurityConfig).toHaveBeenCalledWith({ password_history_count: 5 }));
});

it('shows a range error from the API and keeps the inputs locked without change rights', async () => {
  api.updateSecurityConfig.mockRejectedValueOnce(Object.assign(new api.ApiError('x'), { code: 'password_expiry_days_out_of_range' }));
  render(<SecurityControls />);
  const days = await screen.findByLabelText('Expires after');
  fireEvent.change(days, { target: { value: '500' } });
  fireEvent.blur(days);
  expect(await screen.findByText(/between 1 and 365/)).toBeTruthy();
  cleanup();
  render(<SecurityControls canChange={false} />);
  const locked = await screen.findByLabelText('Expires after') as HTMLInputElement;
  expect(locked.disabled).toBe(true);
});
```

`portal/src/components/ForceChangePassword.test.tsx` — make the auth mock mutable and add a case:

```ts
const auth = vi.hoisted(() => ({
  person: { display_name: 'Bobby Henderson' },
  logout: vi.fn(),
  clearMustChange: vi.fn(),
  passwordMinLength: 8,
  mustChangeReason: 'temporary' as 'temporary' | 'expired' | null,
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
```

(replace the existing `vi.mock('../auth/AuthContext', …)` block) and append:

```ts
it('explains an expired password differently from a temporary one', () => {
  auth.mustChangeReason = 'expired';
  render(<ForceChangePassword />);
  expect(screen.getByRole('heading', { name: 'Your password has expired' })).toBeTruthy();
  expect(screen.getByText(/used recently/)).toBeTruthy();
  cleanup();
  auth.mustChangeReason = 'temporary';
  render(<ForceChangePassword />);
  expect(screen.getByRole('heading', { name: 'Set your password' })).toBeTruthy();
});
```

`portal/src/auth/AuthContext.totp.test.tsx` — append:

```ts
it('carries the change reason and expiry date, and clearMustChange clears them', async () => {
  api.loginRequest.mockResolvedValue({ ...SESSION, must_change_password: true, must_change_reason: 'expired',
    password_expires_at: '2026-09-01T00:00:00Z' });
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => {});
  await act(() => ctx.login('a@b.c', 'pw'));
  expect(ctx.mustChangePassword).toBe(true);
  expect(ctx.mustChangeReason).toBe('expired');
  expect(ctx.passwordExpiresAt).toBe('2026-09-01T00:00:00Z');
  act(() => ctx.clearMustChange());
  expect(ctx.mustChangePassword).toBe(false);
  expect(ctx.mustChangeReason).toBeNull();
});
```

`portal/src/components/NotificationsPanel.test.tsx` — in the first test, change the second fixture line to also include a third item and assert its icon class:

```ts
  ctx.items = [item('a'), item('b', { kind: 'report_failed', read_at: new Date().toISOString(), title: 'Move Report failed' }),
    item('c', { kind: 'password_expiring', title: 'Your password expires in 3 days', link: '/me' })];
```

with `expect(rows).toHaveLength(3);` and `expect(rows[2].querySelector('.notif-icon-password_expiring')).toBeTruthy();` and change `expect(screen.getAllByText('1m ago')).toHaveLength(2)` to `3`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd portal && npx vitest run src/components/settings/SecurityControls.test.tsx src/components/ForceChangePassword.test.tsx src/auth/AuthContext.totp.test.tsx src/components/NotificationsPanel.test.tsx`
Expected: the new cases FAIL (no policy rows; heading still "Set your password"; `mustChangeReason` undefined). The NotificationsPanel case passes already if the fallback icon carries the kind class — that's fine; the icon branch is still added below.

- [ ] **Step 3: API types**

In `portal/src/lib/api.ts`:
- In `SessionData`, after `must_change_password: boolean;` add:

```ts
  must_change_reason: 'temporary' | 'expired' | null;
  password_expires_at: string | null;
```

- Replace the `SecurityConfig` interface with:

```ts
export interface SecurityConfig {
  two_factor_enabled: boolean;
  two_factor_required: boolean;
  password_expiry_enabled: boolean;
  password_expiry_days: number;
  password_history_count: number;
  password_expiry_since: string | null;
}
```

If `tsc` reports other test fixtures typed as `SessionData` missing the two new fields, add `must_change_reason: null, password_expires_at: null` to them (search `must_change_password: false` in `portal/src` and `kiosk/src` test files; kiosk fixtures are cast, but fix them too if `tsc` complains).

- [ ] **Step 4: AuthContext**

In `portal/src/auth/AuthContext.tsx`:
- `AuthState`: after `mustChangePassword: boolean;` add `mustChangeReason: 'temporary' | 'expired' | null;` and `passwordExpiresAt: string | null;`.
- `ANON`: add `mustChangeReason: null,` and `passwordExpiresAt: null,`.
- `stateFrom`: add `mustChangeReason: data.must_change_reason ?? null,` and `passwordExpiresAt: data.password_expires_at ?? null,`.
- `clearMustChange`: `setState((prev) => ({ ...prev, mustChangePassword: false, mustChangeReason: null }));`
- Update the `clearMustChange` doc comment to "Called after a successful password change (forced-change gate, temporary or expired)."

- [ ] **Step 5: Forced-change copy**

In `portal/src/components/ForceChangePassword.tsx`, destructure `mustChangeReason` from `useAuth()` and replace the `<h1>` and the `<p>` under it with:

```tsx
        <h1 style={{ margin: '10px 0 6px', fontSize: 24, color: '#1b2129' }}>
          {mustChangeReason === 'expired' ? 'Your password has expired' : 'Set your password'}
        </h1>
        <p style={{ margin: '0 0 22px', fontSize: 14, color: '#667085', fontWeight: 300 }}>
          {mustChangeReason === 'expired'
            ? <>{person?.display_name}, passwords expire every so often here. Choose a new one to continue. It can&apos;t be one you&apos;ve used recently.</>
            : <>{person?.display_name}, your password was set by an administrator. Choose your own before continuing — the temporary one stops working the moment you do.</>}
        </p>
```

Update the file's header comment: "shown INSTEAD of the portal when the account must set a new password (temporary password from an admin, or an expired one)".

- [ ] **Step 6: Error copy**

`portal/src/components/ChangePasswordForm.tsx` `ERRORS`: add `password_recently_used: "That password was used recently. Choose one you haven't used before.",`.

`portal/src/components/UserAdminModals.tsx` `GUARD_ERRORS`: add `password_recently_used: "That password was one of this person's recent ones. Choose a different one.",` and `password_too_short: 'That password is too short.',`.

- [ ] **Step 7: Profile line**

In `portal/src/pages/Profile.tsx`, add `passwordExpiresAt` to the `useAuth()` destructure and change the Password `<dd>` to:

```tsx
                  <dd>{pwChanged
                    ? <span className="chip c-green"><span className="dot" />changed — other sessions signed out</span>
                    : <>
                        {profile.password_updated_at ? `Last reset ${longDate(profile.password_updated_at)}` : 'set'}
                        {passwordExpiresAt && ` · expires ${longDate(passwordExpiresAt)}`}
                      </>}</dd>
```

- [ ] **Step 8: Inbox icon**

In `portal/src/components/NotificationsPanel.tsx` `KindIcon`, before the final fallback `return`, add:

```tsx
  if (kind === 'password_expiring') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.7-8.7M16 6.5l2.5 2.5M13.5 9l2.5 2.5" />
      </svg>
    );
  }
```

- [ ] **Step 9: Settings rows**

In `portal/src/components/settings/SecurityControls.tsx`:
- Add a small number-field component at the bottom of the file:

```tsx
const RANGE_ERRORS: Record<string, string> = {
  password_expiry_days_out_of_range: 'Expires after must be between 1 and 365 days.',
  password_history_count_out_of_range: 'Prevent reuse must be between 0 and 24 passwords.',
};

function NumberSetting({ id, label, hint, suffix, value, min, max, disabled, onSave }: {
  id: string; label: string; hint: string; suffix: string; value: number;
  min: number; max: number; disabled: boolean; onSave: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n === value) { setDraft(String(value)); return; }
    onSave(n);
  };
  return (
    <div className="set-row">
      <div className="set-label">
        <b><label htmlFor={id}>{label}</label></b>
        <span>{hint}</span>
      </div>
      <span className="set-inline">
        <input id={id} className="set-number" type="number" min={min} max={max} value={draft} disabled={disabled}
               onChange={(e) => setDraft(e.target.value)} onBlur={commit}
               onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
        <span>{suffix}</span>
      </span>
    </div>
  );
}
```

- In `patch()`'s `catch`, map range codes: `setError(err instanceof ApiError ? (RANGE_ERRORS[err.code] ?? err.message) : 'Could not save.')`.
- Between the "Remembered browsers" row and the "End all sessions" row, add:

```tsx
      <div className="set-row">
        <div className="set-label">
          <b>Password expiry</b>
          <span>Everyone must choose a new password after a set number of days, and can't reuse recent ones. The clock starts today.</span>
        </div>
        <Switch checked={cfg?.password_expiry_enabled ?? false} disabled={locked}
                onChange={(v) => void patch({ password_expiry_enabled: v })} />
      </div>
      <NumberSetting id="sec-expiry-days" label="Expires after" hint="Days a password stays valid." suffix="days"
                     value={cfg?.password_expiry_days ?? 90} min={1} max={365} disabled={locked}
                     onSave={(v) => void patch({ password_expiry_days: v })} />
      <NumberSetting id="sec-history-count" label="Prevent reuse of the last" hint="Passwords that can't be chosen again. 0 turns this off." suffix="passwords"
                     value={cfg?.password_history_count ?? 3} min={0} max={24} disabled={locked}
                     onSave={(v) => void patch({ password_history_count: v })} />
```

- Styling: `.set-inline` and `.set-number` — check `portal/src/styles/settings.css` for an existing inline-input pattern (e.g. in `AdminControls.tsx`) and reuse its classes instead if one exists. Otherwise add to `settings.css`, after `.set-row .set-label span { … }`:

```css
.set-inline { display: inline-flex; align-items: center; gap: 8px; color: var(--text-mute); font-size: 12.5px; }
.set-number { width: 76px; padding: 6px 8px; border: 1px solid var(--paper-line); border-radius: 8px; background: #fff; color: var(--text-dark); }
.set-number:disabled { opacity: .6; }
```

(These selectors contain no guardrail trigger words; `font-size` on `.set-inline` is fine.)

- [ ] **Step 10: Run the tests, guardrail and type check**

Run: `cd portal && npx vitest run src/components/settings src/components/ForceChangePassword.test.tsx src/auth src/components/NotificationsPanel.test.tsx src/pages/Profile.test.tsx src/styles/listTypography.test.ts && npx tsc -b`
Expected: PASS; `tsc` prints nothing. (Skip `Profile.test.tsx` if it doesn't exist.)

- [ ] **Step 11: Commit**

```bash
git add portal/src
git commit -m "feat(portal): password expiry settings, expired-password copy, reuse errors, reminder icon

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Kiosk — expired-password notice

**Files:**
- Modify: `kiosk/src/auth/KioskAuthContext.tsx`
- Modify: `kiosk/src/components/KioskGuard.tsx`
- Test: `kiosk/src/components/KioskGuard.test.tsx`

**Interfaces:**
- Consumes: `SessionData.must_change_reason` (Task 6's shared type, re-exported by `kiosk/src/lib/api.ts`).
- Produces: `useKioskAuth().mustChangeReason: 'temporary' | 'expired' | null`.

- [ ] **Step 1: Write the failing test**

In `kiosk/src/components/KioskGuard.test.tsx`, add `mustChangeReason: null as 'temporary' | 'expired' | null,` to the hoisted `auth` object, and append:

```ts
it('tells an expired-password account to pick a new one in the portal', () => {
  auth.status = 'authed';
  auth.mustChangePassword = true;
  auth.mustChangeReason = 'expired';
  renderGuarded();
  expect(screen.getByText('Your password has expired')).toBeTruthy();
  expect(screen.getByText(/choose a new one, then sign in here again/)).toBeTruthy();
  expect(screen.queryByText('Protected page')).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd kiosk && npx vitest run src/components/KioskGuard.test.tsx`
Expected: the new case FAILS (heading still "Password change required").

- [ ] **Step 3: Implement**

`kiosk/src/auth/KioskAuthContext.tsx`: add `mustChangeReason: 'temporary' | 'expired' | null;` to `State` after `mustChangePassword`; `ANON` gets `mustChangeReason: null,`; `stateFrom` gets `mustChangeReason: s.must_change_reason ?? null,`.

`kiosk/src/components/KioskGuard.tsx`: destructure `mustChangeReason` too and replace the `<h1>` and `<p>` with:

```tsx
          <h1 className="page-title">
            {mustChangeReason === 'expired' ? 'Your password has expired' : 'Password change required'}
          </h1>
          <p className="page-hint">
            {mustChangeReason === 'expired'
              ? <>Sign in to the portal at {portalUrl()} to choose a new one, then sign in here again.</>
              : <>Your password needs to be changed before you can use a kiosk. Sign in to the portal
                  at {portalUrl()} to change it, then sign in here again.</>}
          </p>
```

Update the file's header comment: "hold accounts that must set a new password (temporary or expired) on a notice".

- [ ] **Step 4: Run the kiosk tests and type check**

Run: `cd kiosk && npx vitest run && npx tsc -b`
Expected: PASS; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/auth/KioskAuthContext.tsx kiosk/src/components/KioskGuard.tsx kiosk/src/components/KioskGuard.test.tsx
git commit -m "feat(kiosk): expired-password notice on the kiosk guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Full suites and live check (controller)

- [ ] **Step 1: Full suites**

```bash
cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_pwexp_full .venv/bin/pytest -q -x --timeout=1800   # drop --timeout if the plugin isn't installed
cd ../portal && npx vitest run && npx tsc -b && npm run build
cd ../kiosk && npx vitest run && npx tsc -b
```

- [ ] **Step 2: Live check on the dev stack** — upgrade the dev DB to 0081 (`cd api && PYTHONPATH=$PWD/src .venv/bin/alembic upgrade head` against the dev DB URL in `.env`), serve the worktree API on 8001 and portal on 5178 (temporary `.claude/launch.json` entries in the MAIN checkout; portal `.env.local` `VITE_API_URL=http://localhost:8001`), open Settings › Security, turn the policy on, edit the numbers, confirm the audit row. Run `PYTHONPATH=$PWD/src .venv/bin/python -c "…run_reminders_once…"` against the dev DB after back-dating a test account and confirm the inbox item. The forced-change screen needs a real sign-in: Jimmy's step.

- [ ] **Step 3: Remove temporary launch entries and `.env.local`; send Jimmy a screenshot of the Security tab.
