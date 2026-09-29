# Move Passwords Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins set a per-move kiosk password; a kiosk signs in with it while the move is active and can only set itself up for that move.

**Architecture:** New columns on `initiatives` (encrypted password, keyed fingerprint, kiosk identity person) and `auth_sessions.initiative_id`. A `services/move_password.py` module owns set/clear/reveal/lookup, the hidden kiosk identity and session revocation. `POST /kiosk/move-login` mints a normal kiosk session for the identity, tagged with the move; setup-options/setup honor the tag. Portal edit modal and kiosk login form call the new endpoints.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (Postgres), pytest; React/TypeScript + Vitest (portal, kiosk).

**Spec:** `docs/superpowers/specs/2026-09-28-move-password-design.md`

## Global Constraints

- Migration `api/migrations/versions/0083_move_passwords.py`, `revision = "0083"`, `down_revision = "0082"`; reversible.
- Columns (exact): `initiatives.kiosk_password_enc TEXT NULL`, `initiatives.kiosk_password_fp TEXT NULL` + unique index `ux_initiatives_kiosk_password_fp`, `initiatives.kiosk_person_id UUID NULL` FK `people.id`, `auth_sessions.initiative_id UUID NULL` FK `initiatives.id`.
- Fingerprint (exact): `hmac.new(pepper.encode(), password.encode(), hashlib.sha256).hexdigest()` with `pepper = get_settings().password_pepper.get_secret_value()`. Encryption: Fernet with `SS_TOTP_ENCRYPTION_KEY` via `security/secretbox.py` (`encrypt(text) -> str`, `decrypt(token) -> str`), which `services/totp.py` switches to (no behavior change there).
- Blocked statuses (exact): `MOVE_LOGIN_BLOCKED_STATUSES = ("completed", "cancelled", "historical")`; archived (`archived_at` not null) also blocks.
- Error codes (exact): `kiosk_password_forbidden` (403), `kiosk_password_too_short` (422), `kiosk_password_in_use` (422), `invalid_move_password` (401), `move_not_active` (401), `move_locked` (403).
- Rank rule: set/clear/reveal need `actor.access.max_rank >= ADMIN_RANK` (60) — use the existing `GATE_BYPASS_RANK`/`ADMIN_RANK` constant the routes file already imports, and check what `GATE_BYPASS_RANK` equals; the rule is "admin and above".
- Kiosk identity (exact): `Person(first_name="Kiosk", last_name=<initiative name>, source="kiosk_move", source_ref=str(initiative.id))`, `UserAccount(email=f"kiosk+{initiative.id}@kiosk.serversherpa.local", password_hash=None)`, active `PersonRole(role="worker")`. People with `source == "kiosk_move"` never appear in `GET /users`, `GET /workers`, `GET /kiosk/sync/people` or search.
- Session payload (exact): `kiosk_move: {"initiative_id": uuid, "name": str} | null` on `SessionOut` and `MeOut`.
- Audit: `kiosk_password` changes recorded as `"set"`/`null`, never the value; reveal audited as `kiosk_password.reveal`; move login audit action `login_move`.
- American English. Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Environment (worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/move-password`):** `api/.venv`, `portal/node_modules`, `kiosk/node_modules` symlinked; `.env` copied. API tests: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_movepw .venv/bin/pytest tests/<file> -q` — FOREGROUND, long timeout, never background, never pip/npm install, never `git stash`. Portal: `cd portal && npx vitest run <paths>`; `npx tsc -b`. Kiosk: `cd kiosk && npx vitest run`; `npx tsc -b`. Test helpers: `tests/test_status_values_write.py::_make(db, client, role, email)`, `tests/test_sites_api.py::login`, `tests/test_account_mgmt.py::_mk_user`; look at `tests/test_kiosk_setup_api.py` (or the file `ls api/tests | grep -i "kiosk.*setup"` shows) for creating an initiative and calling setup-options/setup, and `tests/test_initiatives_api.py` for PATCH/archive shapes.

---

### Task 1: Migration, secretbox, model fields, and the move-password service

**Files:**
- Create: `api/migrations/versions/0083_move_passwords.py`, `api/src/serversherpa/security/secretbox.py`, `api/src/serversherpa/services/move_password.py`
- Modify: `api/src/serversherpa/db/models.py` (`Initiative`, `AuthSession`), `api/src/serversherpa/services/totp.py` (use secretbox), `api/src/serversherpa/services/auth.py` (`start_session(..., initiative_id=None)` stamps the row)
- Test: `api/tests/test_move_password_service.py`

**Interfaces:**
- Produces (in `serversherpa.services.move_password`): `MOVE_LOGIN_BLOCKED_STATUSES`, `fingerprint(password: str) -> str`, `is_move_active(initiative) -> bool`, `async set_password(db, initiative, password, *, actor_id) -> None` (raises `MovePasswordError(code)` with `code` in `kiosk_password_too_short` / `kiosk_password_in_use`), `async clear_password(db, initiative, *, actor_id) -> None`, `reveal(initiative) -> str | None`, `async find_initiative_by_password(db, password) -> Initiative | None`, `async ensure_kiosk_identity(db, initiative) -> UserAccount`, `async revoke_move_sessions(db, initiative_id) -> int`, `async rename_kiosk_identity(db, initiative) -> None`. None commit; the caller owns the transaction. `set_password`/`clear_password` write the audit row themselves (`entity_type="initiative"`, action `update`, `changes={"kiosk_password": {"from": …, "to": …}}`).
- Produces: `security.secretbox.encrypt/decrypt`; `auth_service.start_session(..., initiative_id: uuid.UUID | None = None)`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_move_password_service.py`:

```python
"""Move passwords: fingerprint/encrypt round trip, the hidden kiosk
identity, uniqueness and length rules, activity rule, session revocation."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, AuthSession, Initiative, Person, PersonRole, UserAccount,
)
from serversherpa.services import auth as auth_service
from serversherpa.services.move_password import (
    MOVE_LOGIN_BLOCKED_STATUSES, MovePasswordError, clear_password, ensure_kiosk_identity,
    find_initiative_by_password, fingerprint, is_move_active, rename_kiosk_identity,
    reveal, revoke_move_sessions, set_password,
)


async def _move(db, name="Las Vegas 3", status="planned"):
    init = Initiative(name=name, initiative_type="move", status=status)
    db.add(init)
    await db.flush()
    return init


async def test_fingerprint_is_stable_and_keyed():
    assert fingerprint("Crew-2026!") == fingerprint("Crew-2026!")
    assert fingerprint("Crew-2026!") != fingerprint("crew-2026!")
    assert len(fingerprint("x")) == 64


async def test_set_reveal_and_clear(db, seeded_user):
    init = await _move(db)
    await set_password(db, init, "Crew-2026!", actor_id=seeded_user.id)
    await db.commit()
    assert reveal(init) == "Crew-2026!"
    assert init.kiosk_password_fp == fingerprint("Crew-2026!")
    assert init.kiosk_person_id is not None
    person = await db.get(Person, init.kiosk_person_id)
    assert (person.first_name, person.last_name, person.source) == ("Kiosk", "Las Vegas 3", "kiosk_move")
    account = await db.get(UserAccount, person.id)
    assert account.password_hash is None and account.email == f"kiosk+{init.id}@kiosk.serversherpa.local"
    roles = list(await db.scalars(select(PersonRole.role).where(
        PersonRole.person_id == person.id, PersonRole.revoked_at.is_(None))))
    assert roles == ["worker"]
    await clear_password(db, init, actor_id=seeded_user.id)
    await db.commit()
    assert reveal(init) is None and init.kiosk_password_fp is None
    assert init.kiosk_person_id == person.id     # the identity is kept for history
    rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "initiative", AuditLog.entity_id == str(init.id))))
    assert [r.changes["kiosk_password"] for r in rows] == [
        {"from": None, "to": "set"}, {"from": "set", "to": None}]


async def test_rules_length_and_uniqueness(db, seeded_user):
    a = await _move(db, "A")
    b = await _move(db, "B")
    with pytest.raises(MovePasswordError) as exc:
        await set_password(db, a, "short7!", actor_id=seeded_user.id)
    assert exc.value.code == "kiosk_password_too_short"
    await set_password(db, a, "Crew-2026!", actor_id=seeded_user.id)
    await db.flush()
    with pytest.raises(MovePasswordError) as exc:
        await set_password(db, b, "Crew-2026!", actor_id=seeded_user.id)
    assert exc.value.code == "kiosk_password_in_use"
    # re-setting the same password on the same move is fine
    await set_password(db, a, "Crew-2026!", actor_id=seeded_user.id)


async def test_lookup_and_activity(db, seeded_user):
    init = await _move(db)
    await set_password(db, init, "Crew-2026!", actor_id=seeded_user.id)
    await db.commit()
    assert (await find_initiative_by_password(db, "Crew-2026!")).id == init.id
    assert await find_initiative_by_password(db, "nope-nope-nope") is None
    assert is_move_active(init)
    for status in MOVE_LOGIN_BLOCKED_STATUSES:
        init.status = status
        assert not is_move_active(init)
    init.status = "in_progress"
    init.archived_at = datetime.now(UTC)
    assert not is_move_active(init)


async def test_revoke_move_sessions_and_rename(db, seeded_user):
    init = await _move(db)
    await set_password(db, init, "Crew-2026!", actor_id=seeded_user.id)
    account = await ensure_kiosk_identity(db, init)
    await db.commit()
    result = await auth_service.start_session(
        db, account, ip=None, user_agent=None, client="kiosk",
        audit_action="login_move", initiative_id=init.id)
    await db.commit()
    row = await db.get(AuthSession, result_session_id(result))
    assert row.initiative_id == init.id
    assert await revoke_move_sessions(db, init.id) == 1
    await db.commit()
    db.expire_all()
    row = await db.get(AuthSession, row.id)
    assert row.revoked_at is not None and row.revoke_reason == "admin"
    init.name = "Las Vegas 3 Cluster Move"
    await rename_kiosk_identity(db, init)
    await db.commit()
    person = await db.get(Person, init.kiosk_person_id)
    assert person.last_name == "Las Vegas 3 Cluster Move"


def result_session_id(result):
    """AuthResult doesn't expose the row id directly; find it through the
    refresh token hash the way services/auth.py stores it."""
    return result.session_id
```

`AuthResult` may not carry a session id — if not, add `session_id: uuid.UUID` to `AuthResult` in `services/auth.py` (set where the row is created) and use it; adjust the helper accordingly. Keep every other assertion.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_movepw .venv/bin/pytest tests/test_move_password_service.py -q`
Expected: FAIL at import (`serversherpa.services.move_password` missing).

- [ ] **Step 3: Migration**

Create `api/migrations/versions/0083_move_passwords.py`:

```python
"""Move passwords for kiosk sign-in: an encrypted per-initiative password,
its keyed fingerprint (unique = unique across moves, and the sign-in
lookup), the move's hidden kiosk identity, and the move a kiosk session
is locked to.

Revision ID: 0083
Revises: 0082
Create Date: 2026-09-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0083"
down_revision: str | None = "0082"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("initiatives", sa.Column("kiosk_password_enc", sa.Text, nullable=True))
    op.add_column("initiatives", sa.Column("kiosk_password_fp", sa.Text, nullable=True))
    op.add_column("initiatives", sa.Column(
        "kiosk_person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=True))
    op.create_index("ux_initiatives_kiosk_password_fp", "initiatives",
                    ["kiosk_password_fp"], unique=True)
    op.add_column("auth_sessions", sa.Column(
        "initiative_id", UUID(as_uuid=True), sa.ForeignKey("initiatives.id"), nullable=True))


def downgrade() -> None:
    op.drop_column("auth_sessions", "initiative_id")
    op.drop_index("ux_initiatives_kiosk_password_fp", table_name="initiatives")
    op.drop_column("initiatives", "kiosk_person_id")
    op.drop_column("initiatives", "kiosk_password_fp")
    op.drop_column("initiatives", "kiosk_password_enc")
```

Models (`db/models.py`): on `Initiative` add `kiosk_password_enc: Mapped[str | None]`, `kiosk_password_fp: Mapped[str | None]`, `kiosk_person_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))`; on `AuthSession` add `initiative_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("initiatives.id"))`.

- [ ] **Step 4: Secretbox and totp**

Create `api/src/serversherpa/security/secretbox.py`:

```python
"""Reversible secrets at rest (2FA seeds, move passwords): Fernet with
SS_TOTP_ENCRYPTION_KEY. Hashing stays in security/passwords.py — this is
only for values that must be read back."""

from cryptography.fernet import Fernet

from serversherpa.config import get_settings


def fernet() -> Fernet:
    key = get_settings().totp_encryption_key.get_secret_value()
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise RuntimeError("SS_TOTP_ENCRYPTION_KEY is not a valid Fernet key") from exc


def encrypt(text: str) -> str:
    return fernet().encrypt(text.encode()).decode()


def decrypt(token: str) -> str:
    return fernet().decrypt(token.encode()).decode()
```

(Match the settings attribute name `services/totp.py` uses for the key.) In `services/totp.py`, replace its private `_fernet()` with `from serversherpa.security.secretbox import fernet` and use `fernet()` where `_fernet()` was; behavior unchanged (`tests/test_totp*.py` must still pass).

- [ ] **Step 5: The service**

Create `api/src/serversherpa/services/move_password.py`:

```python
"""Move passwords: an admin-set password that signs a kiosk in for ONE
move. Stored encrypted (admins can reveal it) plus a keyed fingerprint
(unique across moves; the sign-in lookup). The move gets a hidden kiosk
identity — a worker-role person with no portal login — so scans and
punches made under the move password are attributed to "Kiosk · <move>".
Nothing here commits; callers own the transaction.
"""

import hashlib
import hmac
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import AuthSession, Initiative, Person, PersonRole, UserAccount
from serversherpa.security.secretbox import decrypt, encrypt
from serversherpa.services.audit import audit

MOVE_LOGIN_BLOCKED_STATUSES = ("completed", "cancelled", "historical")
MIN_LENGTH = 8
KIOSK_MOVE_SOURCE = "kiosk_move"


class MovePasswordError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def fingerprint(password: str) -> str:
    pepper = get_settings().password_pepper.get_secret_value()
    return hmac.new(pepper.encode(), password.encode(), hashlib.sha256).hexdigest()


def is_move_active(initiative: Initiative) -> bool:
    return initiative.archived_at is None and initiative.status not in MOVE_LOGIN_BLOCKED_STATUSES


def reveal(initiative: Initiative) -> str | None:
    return decrypt(initiative.kiosk_password_enc) if initiative.kiosk_password_enc else None


def _kiosk_email(initiative: Initiative) -> str:
    return f"kiosk+{initiative.id}@kiosk.serversherpa.local"


async def ensure_kiosk_identity(db: AsyncSession, initiative: Initiative) -> UserAccount:
    """The move's hidden worker: created once, kept for history."""
    if initiative.kiosk_person_id is not None:
        account = await db.get(UserAccount, initiative.kiosk_person_id)
        if account is not None:
            return account
    person = Person(first_name="Kiosk", last_name=initiative.name, source=KIOSK_MOVE_SOURCE,
                    source_ref=str(initiative.id))
    db.add(person)
    await db.flush()
    account = UserAccount(person_id=person.id, email=_kiosk_email(initiative), password_hash=None)
    db.add(account)
    db.add(PersonRole(person_id=person.id, role="worker"))
    initiative.kiosk_person_id = person.id
    await db.flush()
    return account


async def rename_kiosk_identity(db: AsyncSession, initiative: Initiative) -> None:
    if initiative.kiosk_person_id is None:
        return
    person = await db.get(Person, initiative.kiosk_person_id)
    if person is not None and person.last_name != initiative.name:
        person.last_name = initiative.name
        person.updated_at = datetime.now(UTC)


async def set_password(db: AsyncSession, initiative: Initiative, password: str, *,
                       actor_id: uuid.UUID) -> None:
    if len(password) < MIN_LENGTH:
        raise MovePasswordError("kiosk_password_too_short")
    fp = fingerprint(password)
    other = await db.scalar(select(Initiative.id).where(
        Initiative.kiosk_password_fp == fp, Initiative.id != initiative.id))
    if other is not None:
        raise MovePasswordError("kiosk_password_in_use")
    was_set = initiative.kiosk_password_fp is not None
    initiative.kiosk_password_enc = encrypt(password)
    initiative.kiosk_password_fp = fp
    initiative.updated_at = datetime.now(UTC)
    await ensure_kiosk_identity(db, initiative)
    audit(db, actor_id=actor_id, entity_type="initiative", entity_id=str(initiative.id),
          action="update", changes={"kiosk_password": {"from": "set" if was_set else None, "to": "set"}})


async def clear_password(db: AsyncSession, initiative: Initiative, *, actor_id: uuid.UUID) -> None:
    if initiative.kiosk_password_fp is None:
        return
    initiative.kiosk_password_enc = None
    initiative.kiosk_password_fp = None
    initiative.updated_at = datetime.now(UTC)
    await revoke_move_sessions(db, initiative.id)
    audit(db, actor_id=actor_id, entity_type="initiative", entity_id=str(initiative.id),
          action="update", changes={"kiosk_password": {"from": "set", "to": None}})


async def find_initiative_by_password(db: AsyncSession, password: str) -> Initiative | None:
    return await db.scalar(select(Initiative).where(Initiative.kiosk_password_fp == fingerprint(password)))


async def revoke_move_sessions(db: AsyncSession, initiative_id: uuid.UUID) -> int:
    result = await db.execute(
        update(AuthSession)
        .where(AuthSession.initiative_id == initiative_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC), revoke_reason="admin"))
    return result.rowcount or 0
```

In `services/auth.py` `start_session(...)`: add keyword `initiative_id: uuid.UUID | None = None`, set it on the new `AuthSession` row, and expose the row id on `AuthResult` (`session_id`) if it isn't there. `refresh()` copies `initiative_id` from the old row to the rotated row (like `client`).

- [ ] **Step 6: Run the tests**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_movepw .venv/bin/pytest tests/test_move_password_service.py tests/test_totp_api.py tests/test_auth_flow.py -q` (use the real totp test file names: `ls api/tests | grep totp`). Then `cd api && PYTHONPATH=$PWD/src .venv/bin/alembic heads` → `0083 (head)`.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0083_move_passwords.py api/src/serversherpa/security/secretbox.py api/src/serversherpa/services/move_password.py api/src/serversherpa/services/totp.py api/src/serversherpa/services/auth.py api/src/serversherpa/db/models.py api/tests/test_move_password_service.py
git commit -m "feat(api): move passwords — storage, kiosk identity, lookup and session revocation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: API routes — initiative set/clear/reveal, kiosk move login, locked setup, hidden identity

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (`InitiativeUpdateIn.kiosk_password`, `InitiativeDetailOut.kiosk_password_set`, `KioskMoveOut`, `SessionOut.kiosk_move`, `MeOut.kiosk_move`, `MoveLoginIn`, `KioskPasswordOut`)
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (`update_initiative`, `archive_initiative`, new `GET /{id}/kiosk-password`, `_detail`)
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (`POST /move-login`, `setup_options`, `kiosk_setup`, `sync_people` filter)
- Modify: `api/src/serversherpa/api/routes/auth.py` (`session_response` + `/auth/me` carry `kiosk_move`), `routes/users.py`, `routes/workers.py`, `routes/search.py` (hide `kiosk_move` people)
- Test: `api/tests/test_move_password_api.py`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: the endpoints and payload fields in Global Constraints; `auth.kiosk_move_out(db, session) -> KioskMoveOut | None` helper used by `session_response` callers and `/auth/me`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_move_password_api.py` covering, with real endpoints (model each on the neighboring test files for request shapes — `tests/test_initiatives_api.py`, the kiosk setup tests, `tests/test_users_api.py`, `tests/test_workers.py`, `tests/test_search_api.py`):

```python
"""Move passwords end to end: admin set/clear/reveal on PATCH /initiatives,
kiosk sign-in with the password, the session locked to the move, and the
hidden kiosk identity staying out of the people lists."""

from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.db.models import AuditLog, AuthSession, Initiative, Person, UserAccount

from tests.test_sites_api import login
from tests.test_status_values_write import _make

PW = "Crew-2026!"


async def _admin(db, client):
    return await _make(db, client, "admin", "mp-admin@test.example.com")


async def _move(db, name="Las Vegas 3", status="planned"):
    init = Initiative(name=name, initiative_type="move", status=status)
    db.add(init)
    await db.commit()
    return init


async def _set(client, hdrs, init, password=PW):
    return await client.patch(f"/initiatives/{init.id}", headers=hdrs, json={"kiosk_password": password})


async def _move_login(client, password=PW):
    return await client.post("/kiosk/move-login", json={"password": password})


async def test_admin_sets_reveals_and_clears(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    resp = await _set(client, admin, init)
    assert resp.status_code == 200, resp.text
    assert resp.json()["kiosk_password_set"] is True
    shown = await client.get(f"/initiatives/{init.id}/kiosk-password", headers=admin)
    assert shown.status_code == 200 and shown.json()["password"] == PW
    reveal_rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(init.id), AuditLog.action == "kiosk_password.reveal")))
    assert len(reveal_rows) == 1
    cleared = await client.patch(f"/initiatives/{init.id}", headers=admin, json={"kiosk_password": None})
    assert cleared.json()["kiosk_password_set"] is False
    assert (await client.get(f"/initiatives/{init.id}/kiosk-password", headers=admin)).json()["password"] is None


async def test_rules_and_rank(client, db, seeded_user):
    admin = await _admin(db, client)
    staff = await login(client)                      # alice, staff (rank 40)
    a = await _move(db, "A")
    b = await _move(db, "B")
    r = await _set(client, admin, a, "short7!")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "kiosk_password_too_short"
    assert (await _set(client, admin, a)).status_code == 200
    r = await _set(client, admin, b)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "kiosk_password_in_use"
    r = await _set(client, staff, b, "Another-pw1")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "kiosk_password_forbidden"
    assert (await client.get(f"/initiatives/{a.id}/kiosk-password", headers=staff)).status_code == 403
    # a staff PATCH without the field still works
    assert (await client.patch(f"/initiatives/{a.id}", headers=staff, json={"description": "x"})).status_code == 200


async def test_hidden_identity(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    await _set(client, admin, init)
    await db.refresh(init)
    person = await db.get(Person, init.kiosk_person_id)
    users = (await client.get("/users", headers=admin)).json()
    assert all(u["person_id"] != str(person.id) for u in users)
    workers = (await client.get("/workers", headers=admin)).json()
    rows = workers["items"] if isinstance(workers, dict) else workers
    assert all(w["id"] != str(person.id) for w in rows)
    # the identity has no password, so email sign-in is refused
    r = await client.post("/auth/login", json={"email": f"kiosk+{init.id}@kiosk.serversherpa.local",
                                               "password": PW, "client": "kiosk"})
    assert r.status_code == 401


async def test_move_login_and_locked_setup(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    other = await _move(db, "Other move")
    await _set(client, admin, init)
    bad = await _move_login(client, "wrong-wrong")
    assert bad.status_code == 401 and bad.json()["detail"]["code"] == "invalid_move_password"
    ok = await _move_login(client)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["kiosk_move"] == {"initiative_id": str(init.id), "name": "Las Vegas 3"}
    assert body["person"]["display_name"].startswith("Kiosk")
    hdrs = {"Authorization": f"Bearer {body['access_token']}"}
    me = (await client.get("/auth/me", headers=hdrs)).json()
    assert me["kiosk_move"]["initiative_id"] == str(init.id)
    options = (await client.get("/kiosk/setup-options", headers=hdrs)).json()
    assert [i["id"] for i in options["initiatives"]] == [str(init.id)]
    # setting up for another move is refused; see the kiosk setup tests for the body shape
    # (serial, initiative_id, site_id, scan_status) and a valid site/scan status
    # ... build a valid setup body for `other` and assert 403 move_locked ...
    # a portal route is still refused for a kiosk session
    assert (await client.get("/initiatives", headers=hdrs)).status_code == 403


async def test_inactive_moves_refuse_login_and_lose_sessions(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    await _set(client, admin, init)
    ok = await _move_login(client)
    hdrs = {"Authorization": f"Bearer {ok.json()['access_token']}"}
    assert (await client.get("/auth/me", headers=hdrs)).status_code == 200
    # completing the move revokes its kiosk sessions and blocks new sign-ins
    r = await client.patch(f"/initiatives/{init.id}", headers=admin, json={"status": "completed"})
    assert r.status_code == 200, r.text
    assert (await client.get("/auth/me", headers=hdrs)).status_code == 401
    r = await _move_login(client)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "move_not_active"
    # archived blocks too
    init2 = await _move(db, "Second")
    await _set(client, admin, init2, "Second-pw-1")
    assert (await client.post(f"/initiatives/{init2.id}/archive", headers=admin)).status_code == 204
    r = await _move_login(client, "Second-pw-1")
    assert r.json()["detail"]["code"] == "move_not_active"
    # clearing the password revokes sessions as well
    init3 = await _move(db, "Third")
    await _set(client, admin, init3, "Third-pw-11")
    ok = await _move_login(client, "Third-pw-11")
    hdrs3 = {"Authorization": f"Bearer {ok.json()['access_token']}"}
    await client.patch(f"/initiatives/{init3.id}", headers=admin, json={"kiosk_password": None})
    assert (await client.get("/auth/me", headers=hdrs3)).status_code == 401


async def test_rename_follows(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    await _set(client, admin, init)
    await client.patch(f"/initiatives/{init.id}", headers=admin, json={"name": "Renamed move"})
    await db.refresh(init)
    person = await db.get(Person, init.kiosk_person_id)
    assert person.last_name == "Renamed move"
```

Fill in the `move_locked` part of `test_move_login_and_locked_setup` with a real setup body (the kiosk setup tests show how to create a site and pick a scan status; `serial` is any string). Adjust fixture fields (`initiative_type`, status keys, site creation) to the real models/status seeds; keep every assertion.

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_movepw .venv/bin/pytest tests/test_move_password_api.py -q`
Expected: FAIL (unknown field `kiosk_password` → 422; `/kiosk/move-login` 404).

- [ ] **Step 3: Schemas**

In `api/src/serversherpa/api/schemas.py`:
- `InitiativeUpdateIn`: add `kiosk_password: str | None = None` — and, because `None` must mean "clear" only when the client SENT it, the route uses `body.model_fields_set` to tell absent from null (`"kiosk_password" in body.model_fields_set`).
- `InitiativeDetailOut` (or `InitiativeItem` if `_item` builds everything): add `kiosk_password_set: bool = False`.
- New:

```python
class KioskMoveOut(BaseModel):
    initiative_id: uuid.UUID
    name: str


class MoveLoginIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class KioskPasswordOut(BaseModel):
    password: str | None
```

- `SessionOut` and `MeOut`: add `kiosk_move: KioskMoveOut | None = None`.

- [ ] **Step 4: Initiative routes**

In `routes/initiatives.py`:
- Import `from serversherpa.services import move_password as move_password_service` and `from serversherpa.access.defaults import ADMIN_RANK` (or the constant the file already has for "admin and above" — `GATE_BYPASS_RANK` is used for the type change; check its value in `access/defaults.py` and use the one that equals 60).
- `update_initiative`: before `data = body.model_dump(exclude_unset=True)`, pop the password: `wants_password = "kiosk_password" in body.model_fields_set`; `new_password = body.kiosk_password`; remove `kiosk_password` from `data`. If `wants_password` and `actor.access.max_rank < ADMIN_RANK` → `_err(403, "kiosk_password_forbidden")`. After the existing field loop (and after `_check_refs`): if `wants_password`: `try: await (set_password(...) if new_password else clear_password(...)) except MovePasswordError as exc: raise _err(422, exc.code)`. If `"name" in changes` → `await rename_kiosk_identity(db, initiative)`. If the status changed into `MOVE_LOGIN_BLOCKED_STATUSES` → `await revoke_move_sessions(db, initiative.id)`. Keep the existing audit for other fields (the service audits the password itself).
- `archive_initiative`: `await revoke_move_sessions(db, initiative_id)` before commit.
- `_item`/`_detail`: `kiosk_password_set=initiative.kiosk_password_fp is not None`.
- New route:

```python
@router.get("/{initiative_id}/kiosk-password", response_model=KioskPasswordOut)
async def get_kiosk_password(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "view"),
) -> KioskPasswordOut:
    """Show the move's kiosk password to an admin (audited): it is shared
    with crews out loud, so it has to be readable back."""
    initiative = await _get_initiative(db, initiative_id, actor)
    _require_global(actor)
    if actor.access.max_rank < ADMIN_RANK:
        raise _err(403, "kiosk_password_forbidden")
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="kiosk_password.reveal")
    await db.commit()
    return KioskPasswordOut(password=move_password_service.reveal(initiative))
```

- [ ] **Step 5: Kiosk routes and session payloads**

In `routes/auth.py`: add

```python
async def kiosk_move_out(db: AsyncSession, session: AuthSession) -> KioskMoveOut | None:
    if session.initiative_id is None:
        return None
    initiative = await db.get(Initiative, session.initiative_id)
    return KioskMoveOut(initiative_id=initiative.id, name=initiative.name) if initiative else None
```

`session_response(result, response, totp, policy, kiosk_move=None)` sets `kiosk_move=kiosk_move`; `/auth/refresh` and the kiosk pairing/2FA callers pass `await kiosk_move_out(db, <the AuthSession row>)` where they have it (for `refresh`, `auth_service.refresh` has the rotated row — expose it on `AuthResult` as `session` or look it up by `session_id`); `/auth/me` sets `kiosk_move=await kiosk_move_out(db, user.session)`.

In `routes/kiosk.py`:

```python
@router.post("/move-login", response_model=SessionOut)
async def move_login(
    body: MoveLoginIn, request: Request, response: Response, db: DbSession,
    _rl: None = Depends(<the same rate-limit dependency /kiosk/pair or /auth/login uses; grep rate_limit_ip>),
) -> SessionOut:
    """Sign a kiosk in with a move's password. The session belongs to the
    move's hidden kiosk identity and is locked to that move."""
    initiative = await move_password_service.find_initiative_by_password(db, body.password)
    ip = client_ip(request)
    if initiative is None:
        audit(db, actor_id=None, entity_type="auth", entity_id="move-login",
              action="login_failed", changes={"reason": "invalid_move_password"}, ip=ip)
        await db.commit()
        raise _err(401, "invalid_move_password")
    if not move_password_service.is_move_active(initiative):
        audit(db, actor_id=None, entity_type="auth", entity_id=str(initiative.id),
              action="login_failed", changes={"reason": "move_not_active"}, ip=ip)
        await db.commit()
        raise _err(401, "move_not_active")
    account = await move_password_service.ensure_kiosk_identity(db, initiative)
    access = await resolve_access(db, account.person_id)
    result = await auth_service.start_session(
        db, account, ip=ip, user_agent=request.headers.get("user-agent"),
        audit_action="login_move", access=access, client="kiosk", initiative_id=initiative.id)
    return session_response(result, response, await totp_status_out(db, account),
                            await load_policy(db),
                            kiosk_move=KioskMoveOut(initiative_id=initiative.id, name=initiative.name))
```

(`start_session` loads `account.person` itself or needs it loaded — check how `poll_pair` calls it and mirror that.) `setup_options`: if `actor.session.initiative_id` is set, restrict the initiatives query to that id (the existing active/unarchived filters still apply). `kiosk_setup`: if `actor.session.initiative_id` is set and `body.initiative_id != actor.session.initiative_id` → `_err(403, "move_locked")`. `sync_people` (kiosk.py ~547): add `Person.source != "kiosk_move"`.

Hide the identity elsewhere: `routes/users.py list_users` (the person join) add `Person.source != "kiosk_move"`; `routes/workers.py` list (line ~109) same; `routes/search.py` people query same. Put the literal in one place: `KIOSK_MOVE_SOURCE` from the service, or a `Person.is_kiosk_identity` hybrid — a shared constant import is enough.

- [ ] **Step 6: Run the tests**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_movepw .venv/bin/pytest tests/test_move_password_api.py tests/test_move_password_service.py tests/test_initiatives_api.py tests/test_kiosk_setup_api.py tests/test_auth_flow.py tests/test_auth_kiosk_login.py tests/test_kiosk_pairing_api.py tests/test_users_api.py tests/test_workers.py tests/test_search_api.py -q` (real file names via `ls api/tests`).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src api/tests/test_move_password_api.py
git commit -m "feat(api): move password on PATCH /initiatives, admin reveal, POST /kiosk/move-login, setup locked to the move, hidden kiosk identity

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Kiosk — move-password sign-in and the footer

**Files:**
- Modify: `kiosk/src/lib/api.ts` (`moveLoginRequest`), `kiosk/src/auth/KioskAuthContext.tsx` (`loginWithMovePassword`, `kioskMove` state), `kiosk/src/pages/Login.tsx` (`handleMove`), `kiosk/src/layout/KioskShell.tsx` (footer Move item)
- Modify: `portal/src/lib/api.ts` `SessionData` (shared type): `kiosk_move: { initiative_id: string; name: string } | null`
- Tests: `kiosk/src/pages/Login.test.tsx` (replace the placeholder test), `kiosk/src/auth/KioskAuthContext.test.tsx`, `kiosk/src/layout/KioskShell.test.tsx` (if it exists; else add the footer assertion where the shell is tested)

- [ ] **Step 1: Write the failing tests** — Login: "move password signs in through the move endpoint and navigates" (mock `auth.loginWithMovePassword` resolving; assert called with `'Crew-2026!'` and the input cleared) and "a wrong or inactive move password shows the matching message" (`auth.loginWithMovePassword` rejecting with `new ApiError(401, 'invalid_move_password')` → text "That move password isn't right."; `'move_not_active'` → "That move password isn't active."). Delete the placeholder test. Context: `loginWithMovePassword` calls `moveLoginRequest`, sets state with `kioskMove` from `kiosk_move`. Shell: with `kioskMove = { initiative_id: 'i1', name: 'Las Vegas 3' }` and no setup, the footer shows `Move` `Las Vegas 3`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — `moveLoginRequest(password)` POSTs `{ password }` to `/kiosk/move-login` with `credentials: 'include'` and `storeSession(data)` like `loginRequest`. `KioskAuthContext`: `State.kioskMove: { initiative_id: string; name: string } | null` (`ANON`: null; `stateFrom`: `s.kiosk_move ?? null`); `loginWithMovePassword(password)` mirrors `login` with `signInRef.current = { method: 'move' }` (extend the union if it's typed). `Login.tsx` `handleMove`: `await loginWithMovePassword(movePassword)`, `navigate(from, { replace: true })`; on `ApiError` map codes `invalid_move_password` → "That move password isn't right.", `move_not_active` → "That move password isn't active.", else the generic message; clear the field, shake. Remove `moveNotice` and the placeholder copy. `KioskShell` footer: `{ label: 'Move', value: kioskSetup?.initiativeName ?? kioskMove?.name }` — only push when one exists; keep the setup's Site/Scan items as they are.
- [ ] **Step 4:** `cd kiosk && npx vitest run && npx tsc -b`; `cd portal && npx tsc -b` (the shared type). Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add kiosk/src portal/src/lib/api.ts
git commit -m "feat(kiosk): sign in with a move password; footer shows the move

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Portal — kiosk password in the initiative edit modal and detail

**Files:**
- Modify: `portal/src/lib/api.ts` (`InitiativeDetail.kiosk_password_set`, `InitiativePayload.kiosk_password?`, `getInitiativeKioskPassword(id)`), `portal/src/components/initiatives/InitiativeFields.tsx` (form state + field), `portal/src/components/initiatives/InitiativeEditModal.tsx` (payload, errors), `portal/src/pages/InitiativeDetail.tsx` (detail line)
- Tests: `portal/src/components/initiatives/InitiativeEditModal.test.tsx`, `portal/src/pages/InitiativeDetail.test.tsx` (if present)

- [ ] **Step 1: Write the failing tests** — modal in edit mode with `isAdmin` shows a "Kiosk password" field with Show, a "Reveal current" button only when `initiative.kiosk_password_set`, and a "Clear kiosk password" checkbox; non-admin sees none of it; create mode sees none; typing a password and saving sends `kiosk_password: 'Crew-2026!'` in the PATCH payload; saving without touching it sends no `kiosk_password` key; ticking Clear sends `kiosk_password: ''`; a 422 `kiosk_password_in_use` shows "That kiosk password is already used by another move."; Reveal calls `getInitiativeKioskPassword` and shows the value. Detail page (admin): "Kiosk password" row reads "Set" / "Not set".
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — `InitiativeFormState.kiosk_password?: string` (undefined = untouched; `''` = clear) and `clear_kiosk_password?: boolean`; `initiativePayload` adds `kiosk_password` only when `form.clear_kiosk_password` (→ `''`) or `form.kiosk_password` is a non-empty string. Field (edit mode, `isAdmin`): label "Kiosk password", masked input with the same Show toggle pattern the login uses (`peek` button) or a plain "Show" link, hint "At least 8 characters, unique across moves. Crews sign in to the kiosk with it.", a "Reveal current" link when `initiative.kiosk_password_set` that calls `getInitiativeKioskPassword(initiative.id)` and shows the value in a `set-note`, and a "Clear kiosk password" checkbox (disables the input). Error map: `kiosk_password_too_short` → "Kiosk password must be at least 8 characters.", `kiosk_password_in_use` → "That kiosk password is already used by another move.", `kiosk_password_forbidden` → "Only admins can change the kiosk password." Detail page: in the details `dl` (where status/client show) add `<dt>Kiosk password</dt><dd>{kiosk_password_set ? 'Set' : 'Not set'}</dd>` for `isAdmin` only. No new CSS; the typography guardrails (`listTypography`, `naturalSort`) must pass.
- [ ] **Step 4:** `cd portal && npx vitest run src/components/initiatives src/pages/InitiativeDetail.test.tsx src/styles && npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add portal/src
git commit -m "feat(portal): kiosk password on the initiative edit modal (admins), with reveal and clear

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Full suites (controller)

```bash
cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_movepw_full .venv/bin/pytest -q
cd ../portal && npx vitest run && npx tsc -b && npm run build
cd ../kiosk && npx vitest run && npx tsc -b
```
