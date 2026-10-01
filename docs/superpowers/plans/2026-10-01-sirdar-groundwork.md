# Sirdar Groundwork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up Sirdar, a standalone Dockerized app with its own Postgres. Portal users ranked admin or higher (copied by an import), plus local break-glass admins, can sign in with the portal's login page. They land in a portal-styled shell with Users, Roles & access, Audit log, Settings and My preferences.

**Architecture:** `sirdar/api` is an independent FastAPI package (`sirdar_api`). It has its own SQLAlchemy models, Alembic chain and CLI, and never imports the main `serversherpa` package at runtime. Its HTTP API, served under `/api`, copies the portal's auth contract exactly: paths, `SessionOut` shape and error codes. That lets `sirdar/web`, a Vite/React SPA, reuse the portal's `Login` page, `AuthProvider` and `lib/api` client through a `@portal` alias (the wiki pattern), with `VITE_API_URL=/api`. One Docker image serves the API and the built SPA; a second container runs Postgres 16.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 (asyncpg), Alembic (psycopg), argon2-cffi, PyJWT, pyotp, cryptography (Fernet), Typer, pytest + pytest-asyncio + httpx; React 18, react-router-dom 6, Vite 5, Vitest 3, @testing-library/react; Docker, Postgres 16.

**Spec:** `docs/superpowers/specs/2026-10-01-sirdar-groundwork-design.md`. Read it before starting any task.

## Global Constraints

- Work only in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Never `cd` into the main checkout, and never `git checkout --` files you did not change.
- Everything new lives under `sirdar/`. The only edits outside `sirdar/` are:
  - Task 1: `docker-compose.dev.yml`
  - Task 10: `portal/src/pages/Login.tsx`, `portal/src/components/login/LoginScene.tsx`, `portal/src/layout/NavPanel.tsx` and their tests
  - Task 15: `.claude/launch.json`
- `sirdar_api` must never `import serversherpa`. The only exception is `sirdar/api/tests/test_portal_compat.py`, which loads one portal file by path.
- Sirdar API routes all live under `/api` (plus a bare `/healthz` for Docker).
- Auth error bodies use the portal's format: `{"detail": {"code": "<code>"}}`.
- Use the portal's error codes from the spec: `invalid_credentials`, `account_locked` (423), `account_disabled`, `password_change_required` (403), `totp_enrollment_required` (403), `totp_invalid`, `invalid_challenge`, `invalid_session`, `session_expired`, `session_reuse_detected`, `missing_refresh`, `invalid_token`, `session_ended`, `forbidden` (403).
- Refresh cookie: name `sirdar_refresh`, path `/api/auth`, httpOnly, samesite lax, `secure` unless `SIRDAR_ENV=development`, `expires` = the absolute session deadline.
- JWT issuer `sirdar`, HS256, secret `SIRDAR_JWT_SECRET`. Challenge tokens use `typ: "totp"` and live 300 s.
- Lockout: 10 failures (`SIRDAR_MAX_FAILED_LOGINS`), then lock for 900 s (`SIRDAR_LOCKOUT_SECONDS`) and reset the count to 0.
- Eligibility for import: the account has a password hash, is not disabled, the person is not archived, and the person holds an active (`revoked_at IS NULL`) role with `scope_anchor = 'global'` and `rank >= 60`.
- All copy, comments and docs use American English (color, customize, recognize).
- Dev ports:

  | Service | Port | Notes |
  |---|---|---|
  | `sirdar-db` | 127.0.0.1:5434 | |
  | API | 8097 | |
  | Web | 5178 | `strictPort` |

  Taken by other apps: 5173 (portal), 5174 (kiosk), 5176/5177 (wiki), 8000 (portal API), 8096 (wiki), 5433 (portal Postgres).
- Python venv: `sirdar/api/.venv` (Python 3.13). Run tests with `sirdar/api/.venv/bin/pytest -q` from `sirdar/api`.
- Web tests: `npm --prefix sirdar/web test`. Portal tests: `npm --prefix portal test`.
- Run test suites in the foreground and read the output before claiming they pass.
- Commit after every task with a conventional message ending in:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

---

## File map

```
sirdar/
  .env.example                       documented settings (Task 15)
  .gitignore                         .env, .venv, node_modules, dist
  README.md                          dev + deploy instructions (Task 15)
  Dockerfile, docker-entrypoint.sh, docker-compose.yml, install.sh   (Task 15)
  scripts/dev-env.sh                 writes sirdar/.env for local dev (Task 1)
  api/
    pyproject.toml, alembic.ini
    migrations/env.py, migrations/script.py.mako, migrations/versions/0001_initial.py
    src/sirdar_api/
      __init__.py
      config.py                      Settings (SIRDAR_* + SS_PASSWORD_PEPPER/SS_TOTP_ENCRYPTION_KEY)
      cli.py                         Typer app: import-users, create-admin, reset-password (Task 7)
      db/engine.py, db/models.py
      security/passwords.py, security/tokens.py, security/totp.py      (Task 2)
      access/defaults.py (Task 1), access/resources.py, access/resolver.py (Task 3)
      services/audit.py, services/auth.py (Task 4)
      services/portal_policy.py, services/import_users.py (Task 6)
      services/local_users.py (Task 7)
      api/app.py, api/deps.py, api/schemas.py
      api/routes/auth.py, system.py (Task 5); users.py (Task 8); access.py, audit.py, settings.py (Task 9)
    tests/
      conftest.py, source_schema.sql, factories.py, source_helpers.py
      test_*.py
  web/
    package.json, package-lock.json, tsconfig.json, vite.config.ts, dedupe.ts, index.html
    src/main.tsx, Root.tsx, App.tsx
    src/portalImports.test.ts
    src/auth/RequireAuth.tsx, src/pages/SirdarLogin.tsx
    src/layout/SirdarShell.tsx, src/layout/sirdarNav.tsx, src/layout/SirdarTopbar.tsx
    src/lib/sirdarApi.ts
    src/pages/Dashboard.tsx, Users.tsx, UserDetail.tsx, Access.tsx, Audit.tsx, Settings.tsx, Me.tsx
    src/components/ImportSummaryModal.tsx, OverridesModal.tsx
    src/styles/sirdar.css
```

---

### Task 1: API scaffold, data model, migration, test harness, dev database

**Files:**
- Create: `sirdar/.gitignore`, `sirdar/scripts/dev-env.sh`
- Create: `sirdar/api/pyproject.toml`, `sirdar/api/alembic.ini`, `sirdar/api/migrations/env.py`, `sirdar/api/migrations/script.py.mako`, `sirdar/api/migrations/versions/0001_initial.py`
- Create: `sirdar/api/src/sirdar_api/__init__.py`, `config.py`, `db/__init__.py`, `db/engine.py`, `db/models.py`, `access/__init__.py`, `access/defaults.py`, `api/__init__.py`, `api/app.py`, `api/routes/__init__.py`
- Create: `sirdar/api/tests/__init__.py` (empty), `sirdar/api/tests/conftest.py`, `sirdar/api/tests/source_schema.sql`, `sirdar/api/tests/test_scaffold.py`
- Modify: `docker-compose.dev.yml` (add `sirdar-db` service + `sirdardata` volume)

**Interfaces:**
- Produces:
  - `sirdar_api.config.get_settings() -> Settings` (lru_cached). Fields:
    - `env`, `database_url: SecretStr`, `database_ssl`, `source_database_url: SecretStr | None`
    - `jwt_secret: SecretStr`, `access_token_ttl_seconds=900`, `session_ttl_seconds=86400`
    - `max_failed_logins=10`, `lockout_seconds=900`
    - `cookie_domain=""`, `static_dir=""`
    - `password_pepper: SecretStr`, `totp_encryption_key: SecretStr`
    - property `sync_database_url`
  - `sirdar_api.db.engine`: `get_engine()`, `get_sessionmaker()`, `dispose_engine()`, `get_db()` (FastAPI dependency).
  - `sirdar_api.db.models`: `Base`, `Role`, `User`, `UserRole`, `RolePermission`, `PermissionOverride`, `TotpBackupCode`, `AuthSession`, `AuditLog`, `ImportRun` (fields below).
  - `sirdar_api.access.defaults`: `FULL`, `DEFAULT_ROLES: list[tuple[str, str, int]]`, `DEFAULT_GRANTS: dict[str, dict[str, tuple[str, ...]]]`, `async restore_default_roles(db)`.
  - `sirdar_api.api.app.create_app() -> FastAPI`. It defines `api = APIRouter(prefix="/api")`; later tasks add `api.include_router(...)` lines.
  - Test fixtures in `conftest.py`:
    - `client` (httpx AsyncClient on the ASGI app, base `http://testserver`)
    - `db` (AsyncSession)
    - `source` (psycopg autocommit connection to the source test DB)
    - `SOURCE_URL` (module constant, asyncpg URL of the source test DB)

- [ ] **Step 1: Add the dev database and check the port is free**

Run: `lsof -nP -iTCP:5434 -sTCP:LISTEN || echo free`
Expected: `free`.

In `docker-compose.dev.yml`, add this service after `mailpit`, matching the file's indentation:

```yaml
  # Sirdar's own database (sirdar/ — the environment builder). Separate
  # from the portal's Postgres on purpose: Sirdar keeps working when the
  # portal database is down or not built yet.
  sirdar-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: sirdar
      POSTGRES_PASSWORD: sirdar
      POSTGRES_DB: sirdar
    ports:
      - "127.0.0.1:5434:5432"
    volumes:
      - sirdardata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sirdar -d sirdar"]
      interval: 5s
      timeout: 3s
      retries: 10
```

Add `sirdardata:` to the top-level `volumes:` list. Then run:

```bash
docker compose -f docker-compose.dev.yml up -d sirdar-db
docker compose -f docker-compose.dev.yml ps sirdar-db
```

Expected: the service is `healthy` within about 15 s. Bring up only `sirdar-db`; do not restart the other services, which other sessions share.

- [ ] **Step 2: Create the package files**

`sirdar/.gitignore`:
```
.env
api/.venv/
api/*.egg-info/
api/src/*.egg-info/
web/node_modules/
web/dist/
__pycache__/
```

`sirdar/api/pyproject.toml`:
```toml
[project]
name = "sirdar-api"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = [
    "pydantic-settings>=2.3",
    "pydantic[email]>=2.7",
    "sqlalchemy[asyncio]>=2.0",
    "alembic>=1.13",
    "asyncpg>=0.29",          # runtime driver
    "psycopg[binary]>=3.1",   # Alembic + tests
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "argon2-cffi>=23.1",
    "pyjwt>=2.9",
    "pyotp>=2.9",
    "cryptography>=42",
    "typer>=0.12",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24",
    "httpx>=0.27",
]

[project.scripts]
sirdar = "sirdar_api.cli:app"

[build-system]
requires = ["setuptools>=69"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
testpaths = ["tests"]

[tool.ruff]
line-length = 100
src = ["src"]
```

`sirdar/api/src/sirdar_api/__init__.py`:
```python
"""Sirdar — builds, installs and manages ServerSherpa environments."""
```

Create empty `__init__.py` in `db/`, `access/`, `api/`, `api/routes/`, and `services/` (an empty `services/__init__.py` now saves later tasks a step).

`sirdar/api/src/sirdar_api/config.py`:
```python
"""Sirdar settings. Everything Sirdar-specific is SIRDAR_*; the password
pepper and the TOTP key keep the portal's SS_* names because they MUST
equal the portal's values (copied password hashes and 2FA seeds only
verify with the same ones)."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# sirdar/api/src/sirdar_api/config.py -> sirdar/
_SIRDAR_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SIRDAR_",
        env_file=_SIRDAR_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
    )

    env: Literal["development", "staging", "production"] = "production"

    database_url: SecretStr                      # postgresql+asyncpg://…
    database_ssl: Literal["require", "disable"] = "disable"
    # The portal's Postgres, read only. Unset = import disabled.
    source_database_url: SecretStr | None = None

    jwt_secret: SecretStr
    access_token_ttl_seconds: int = 900
    # Absolute session lifetime from login; refresh rotations inherit it.
    session_ttl_seconds: int = 86_400
    max_failed_logins: int = 10
    lockout_seconds: int = 900
    cookie_domain: str = ""
    # Built SPA directory; empty = API only (local dev uses Vite).
    static_dir: str = ""

    password_pepper: SecretStr = Field(
        validation_alias=AliasChoices("SS_PASSWORD_PEPPER", "SIRDAR_PASSWORD_PEPPER"))
    totp_encryption_key: SecretStr = Field(
        validation_alias=AliasChoices("SS_TOTP_ENCRYPTION_KEY", "SIRDAR_TOTP_ENCRYPTION_KEY"))

    @property
    def sync_database_url(self) -> str:
        """Alembic runs synchronously on psycopg."""
        return self.database_url.get_secret_value().replace(
            "postgresql+asyncpg://", "postgresql+psycopg://")


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

`sirdar/api/src/sirdar_api/db/engine.py`:
```python
"""Lazy global async engine — one per process (and per test, see conftest)."""

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine,
)

from sirdar_api.config import get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine, _sessionmaker
    if _engine is None:
        settings = get_settings()
        connect_args = {"ssl": True} if settings.database_ssl == "require" else {}
        _engine = create_async_engine(
            settings.database_url.get_secret_value(),
            pool_pre_ping=True,
            connect_args=connect_args,
        )
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _sessionmaker is not None
    return _sessionmaker


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request."""
    async with get_sessionmaker()() as session:
        yield session
```

`sirdar/api/src/sirdar_api/db/models.py`:
```python
"""Sirdar's own tables (migration 0001). `users` mirrors the portal's
user_accounts + people for the people it copies; Sirdar-only data
(overrides, sessions, audit, lockout counters) never comes from the portal."""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, text
from sqlalchemy.dialects.postgresql import BYTEA, CITEXT, INET, JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import Text


class Base(DeclarativeBase):
    type_annotation_map = {
        uuid.UUID: UUID(as_uuid=True),
        datetime: TIMESTAMP(timezone=True),
        str: Text,
    }


class Role(Base):
    __tablename__ = "roles"

    name: Mapped[str] = mapped_column(primary_key=True)
    label: Mapped[str]
    rank: Mapped[int] = mapped_column(Integer)
    color: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class User(Base):
    __tablename__ = "users"

    person_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    source: Mapped[str]                                   # "portal" | "local"
    email: Mapped[str] = mapped_column(CITEXT, unique=True)
    first_name: Mapped[str]
    last_name: Mapped[str]
    preferred_name: Mapped[str | None]
    job_title: Mapped[str | None]
    password_hash: Mapped[str | None]
    must_change_password: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    password_updated_at: Mapped[datetime | None]
    password_expires_at: Mapped[datetime | None]
    totp_secret_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    totp_confirmed_at: Mapped[datetime | None]
    totp_last_counter: Mapped[int | None] = mapped_column(BigInteger)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    totp_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    failed_login_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    locked_until: Mapped[datetime | None]
    last_login_at: Mapped[datetime | None]
    last_login_ip: Mapped[str | None] = mapped_column(INET)
    disabled_at: Mapped[datetime | None]
    disabled_reason: Mapped[str | None]
    last_imported_at: Mapped[datetime | None]
    ui_prefs: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    @property
    def display_name(self) -> str:
        return f"{self.preferred_name or self.first_name} {self.last_name}"


class UserRole(Base):
    __tablename__ = "user_roles"

    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.person_id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(
        ForeignKey("roles.name", ondelete="CASCADE"), primary_key=True)


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role: Mapped[str] = mapped_column(
        ForeignKey("roles.name", ondelete="CASCADE"), primary_key=True)
    resource: Mapped[str] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(primary_key=True)


class PermissionOverride(Base):
    __tablename__ = "permission_overrides"

    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.person_id", ondelete="CASCADE"), primary_key=True)
    resource: Mapped[str] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(primary_key=True)
    allow: Mapped[bool] = mapped_column(Boolean)
    set_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.person_id"))
    set_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class TotpBackupCode(Base):
    __tablename__ = "totp_backup_codes"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.person_id", ondelete="CASCADE"))
    code_hash: Mapped[str]
    used_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.person_id", ondelete="CASCADE"))
    family_id: Mapped[uuid.UUID]
    token_hash: Mapped[str] = mapped_column(unique=True)
    expires_at: Mapped[datetime]
    rotated_at: Mapped[datetime | None]
    replaced_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("auth_sessions.id"))
    revoked_at: Mapped[datetime | None]
    revoke_reason: Mapped[str | None]
    ip_address: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    actor_id: Mapped[uuid.UUID | None]            # no FK: the trail outlives users
    action: Mapped[str]
    entity_type: Mapped[str]
    entity_id: Mapped[str | None]
    ip: Mapped[str | None] = mapped_column(INET)
    changes: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))


class ImportRun(Base):
    __tablename__ = "import_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    started_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    finished_at: Mapped[datetime | None]
    actor_id: Mapped[uuid.UUID | None]
    trigger: Mapped[str]                          # "cli" | "web"
    status: Mapped[str]                           # "running" | "ok" | "failed"
    error: Mapped[str | None]
    added: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    updated: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    unchanged: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    disabled: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    skipped: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    rows: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))
```

`sirdar/api/src/sirdar_api/access/defaults.py`:
```python
"""Live copy of the seeded roles and permission matrix (migration 0001
holds the frozen snapshot; test_access.py checks the two agree). Tests
use restore_default_roles to reset the matrix between runs."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

FULL = ("view", "add", "change", "delete")

# name, label, rank — the portal's global roles at rank >= 60
DEFAULT_ROLES: list[tuple[str, str, int]] = [
    ("developer", "Developer", 100),
    ("founder", "Founder", 100),
    ("super_admin", "Super admin", 80),
    ("admin", "Administrator", 60),
]

DEFAULT_GRANTS: dict[str, dict[str, tuple[str, ...]]] = {
    "developer": {"dashboard": ("view",), "users": FULL, "access": FULL,
                  "audit": ("view",), "settings": FULL, "devtools": FULL},
    "founder": {"dashboard": ("view",), "users": FULL, "access": FULL,
                "audit": ("view",), "settings": FULL},
    "super_admin": {"dashboard": ("view",), "users": FULL, "access": ("view", "change"),
                    "audit": ("view",), "settings": ("view", "change")},
    "admin": {"dashboard": ("view",), "users": ("view",), "access": ("view",),
              "audit": ("view",), "settings": ("view",)},
}


async def restore_default_roles(db: AsyncSession) -> None:
    """Delete every role (cascading user_roles + role_permissions) and
    re-seed the defaults. Does not commit."""
    await db.execute(text("DELETE FROM roles"))
    for name, label, rank in DEFAULT_ROLES:
        await db.execute(
            text("INSERT INTO roles (name, label, rank) VALUES (:n, :l, :r)"),
            {"n": name, "l": label, "r": rank})
    for role, grants in DEFAULT_GRANTS.items():
        for resource, actions in grants.items():
            for action in actions:
                await db.execute(
                    text("INSERT INTO role_permissions (role, resource, action) "
                         "VALUES (:ro, :re, :a)"),
                    {"ro": role, "re": resource, "a": action})
```

- [ ] **Step 3: Alembic and migration 0001**

`sirdar/api/alembic.ini`:
```ini
[alembic]
script_location = migrations
prepend_sys_path = src

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
```

`sirdar/api/migrations/env.py`:
```python
"""Sirdar migrations — synchronous (psycopg), hand-written SQL, no autogenerate."""

import sys
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from sirdar_api.config import get_settings  # noqa: E402

target_metadata = None


def run_migrations_offline() -> None:
    context.configure(url=get_settings().sync_database_url, target_metadata=target_metadata,
                      literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(get_settings().sync_database_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

`sirdar/api/migrations/script.py.mako`:
```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}
"""
from alembic import op

revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = None
depends_on = None


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

`sirdar/api/migrations/versions/0001_initial.py`:
```python
"""Sirdar initial schema + the four default roles and their permissions.

Revision ID: 0001
Revises:
Create Date: 2026-10-01
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

FULL = ("view", "add", "change", "delete")
# Frozen snapshot of access/defaults.py at 0001 (test_access.py compares).
ROLES = [("developer", "Developer", 100), ("founder", "Founder", 100),
         ("super_admin", "Super admin", 80), ("admin", "Administrator", 60)]
GRANTS = {
    "developer": {"dashboard": ("view",), "users": FULL, "access": FULL,
                  "audit": ("view",), "settings": FULL, "devtools": FULL},
    "founder": {"dashboard": ("view",), "users": FULL, "access": FULL,
                "audit": ("view",), "settings": FULL},
    "super_admin": {"dashboard": ("view",), "users": FULL, "access": ("view", "change"),
                    "audit": ("view",), "settings": ("view", "change")},
    "admin": {"dashboard": ("view",), "users": ("view",), "access": ("view",),
              "audit": ("view",), "settings": ("view",)},
}


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")
    op.execute("""
        CREATE TABLE roles (
          name text PRIMARY KEY,
          label text NOT NULL,
          rank integer NOT NULL,
          color text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE users (
          person_id uuid PRIMARY KEY,
          source text NOT NULL CHECK (source IN ('portal', 'local')),
          email citext NOT NULL UNIQUE,
          first_name text NOT NULL,
          last_name text NOT NULL,
          preferred_name text,
          job_title text,
          password_hash text,
          must_change_password boolean NOT NULL DEFAULT false,
          password_updated_at timestamptz,
          password_expires_at timestamptz,
          totp_secret_enc bytea,
          totp_confirmed_at timestamptz,
          totp_last_counter bigint,
          totp_enabled boolean NOT NULL DEFAULT false,
          totp_required boolean NOT NULL DEFAULT false,
          failed_login_count integer NOT NULL DEFAULT 0,
          locked_until timestamptz,
          last_login_at timestamptz,
          last_login_ip inet,
          disabled_at timestamptz,
          disabled_reason text,
          last_imported_at timestamptz,
          ui_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE user_roles (
          person_id uuid NOT NULL REFERENCES users(person_id) ON DELETE CASCADE,
          role text NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
          PRIMARY KEY (person_id, role)
        );
        CREATE TABLE role_permissions (
          role text NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
          resource text NOT NULL,
          action text NOT NULL,
          PRIMARY KEY (role, resource, action)
        );
        CREATE TABLE permission_overrides (
          person_id uuid NOT NULL REFERENCES users(person_id) ON DELETE CASCADE,
          resource text NOT NULL,
          action text NOT NULL,
          allow boolean NOT NULL,
          set_by uuid REFERENCES users(person_id),
          set_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (person_id, resource, action)
        );
        CREATE TABLE totp_backup_codes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          person_id uuid NOT NULL REFERENCES users(person_id) ON DELETE CASCADE,
          code_hash text NOT NULL,
          used_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_totp_backup_codes_person ON totp_backup_codes (person_id);
        CREATE TABLE auth_sessions (
          id uuid PRIMARY KEY,
          person_id uuid NOT NULL REFERENCES users(person_id) ON DELETE CASCADE,
          family_id uuid NOT NULL,
          token_hash text NOT NULL UNIQUE,
          expires_at timestamptz NOT NULL,
          rotated_at timestamptz,
          replaced_by uuid REFERENCES auth_sessions(id),
          revoked_at timestamptz,
          revoke_reason text,
          ip_address inet,
          user_agent text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_auth_sessions_person ON auth_sessions (person_id);
        CREATE INDEX ix_auth_sessions_family ON auth_sessions (family_id);
        CREATE TABLE audit_log (
          id bigserial PRIMARY KEY,
          at timestamptz NOT NULL DEFAULT now(),
          actor_id uuid,
          action text NOT NULL,
          entity_type text NOT NULL,
          entity_id text,
          ip inet,
          changes jsonb NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX ix_audit_log_at ON audit_log (at DESC);
        CREATE TABLE import_runs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          started_at timestamptz NOT NULL DEFAULT now(),
          finished_at timestamptz,
          actor_id uuid,
          trigger text NOT NULL CHECK (trigger IN ('cli', 'web')),
          status text NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
          error text,
          added integer NOT NULL DEFAULT 0,
          updated integer NOT NULL DEFAULT 0,
          unchanged integer NOT NULL DEFAULT 0,
          disabled integer NOT NULL DEFAULT 0,
          skipped integer NOT NULL DEFAULT 0,
          rows jsonb NOT NULL DEFAULT '[]'::jsonb
        );
        CREATE INDEX ix_import_runs_started ON import_runs (started_at DESC);
    """)
    for name, label, rank in ROLES:
        op.execute(f"INSERT INTO roles (name, label, rank) VALUES ('{name}', '{label}', {rank})")
    for role, grants in GRANTS.items():
        for resource, actions in grants.items():
            for action in actions:
                op.execute("INSERT INTO role_permissions (role, resource, action) "
                           f"VALUES ('{role}', '{resource}', '{action}')")


def downgrade() -> None:
    op.execute("""
        DROP TABLE import_runs, audit_log, auth_sessions, totp_backup_codes,
                   permission_overrides, role_permissions, user_roles, users, roles
    """)
```

- [ ] **Step 4: Minimal app with health checks**

`sirdar/api/src/sirdar_api/api/app.py`:
```python
"""Sirdar API. Every route lives under /api; the built SPA (when
SIRDAR_STATIC_DIR is set) is served from / — see _mount_spa."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text

from sirdar_api.config import get_settings
from sirdar_api.db.engine import dispose_engine, get_sessionmaker


@asynccontextmanager
async def _lifespan(app: FastAPI):
    yield
    await dispose_engine()


async def _db_ok() -> bool:
    try:
        async with get_sessionmaker()() as session:
            await session.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001 — health is a yes/no answer
        return False


def _mount_spa(app: FastAPI, static_dir: str) -> None:
    root = Path(static_dir).resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(root / "index.html")


def create_app() -> FastAPI:
    settings = get_settings()
    prod = settings.env == "production"
    app = FastAPI(
        title="Sirdar API",
        lifespan=_lifespan,
        docs_url=None if prod else "/api/docs",
        redoc_url=None,
        openapi_url=None if prod else "/api/openapi.json",
    )

    api = APIRouter(prefix="/api")

    @api.get("/healthz")
    async def api_healthz():
        ok = await _db_ok()
        return JSONResponse({"status": "ok" if ok else "db_unreachable"},
                            status_code=200 if ok else 503)

    # routers (later tasks add include_router lines here)

    app.include_router(api)

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        ok = await _db_ok()
        return JSONResponse({"status": "ok" if ok else "db_unreachable"},
                            status_code=200 if ok else 503)

    if settings.static_dir:
        _mount_spa(app, settings.static_dir)
    return app
```

- [ ] **Step 5: Test harness**

`sirdar/api/tests/source_schema.sql`. This is a minimal portal-shaped schema that the import reads; the column names match the portal's `user_accounts`, `people`, `roles`, `person_roles`, `access_groups`, `access_group_members`, `totp_backup_codes` and `system_config`.
```sql
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text NOT NULL,
  last_name text NOT NULL,
  preferred_name text,
  job_title text,
  archived_at timestamptz
);
CREATE TABLE user_accounts (
  person_id uuid PRIMARY KEY REFERENCES people(id),
  email citext NOT NULL,
  password_hash text,
  must_change_password boolean NOT NULL DEFAULT false,
  password_updated_at timestamptz,
  totp_secret_enc bytea,
  totp_confirmed_at timestamptz,
  totp_required boolean NOT NULL DEFAULT false,
  totp_last_counter bigint,
  disabled_at timestamptz
);
CREATE TABLE roles (
  name text PRIMARY KEY,
  label text,
  rank integer NOT NULL DEFAULT 0,
  scope_anchor text NOT NULL DEFAULT 'global',
  color text,
  totp_required boolean NOT NULL DEFAULT false
);
CREATE TABLE person_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id),
  role text NOT NULL REFERENCES roles(name),
  revoked_at timestamptz
);
CREATE TABLE access_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  totp_required boolean NOT NULL DEFAULT false
);
CREATE TABLE access_group_members (
  group_id uuid NOT NULL REFERENCES access_groups(id),
  person_id uuid NOT NULL REFERENCES people(id),
  PRIMARY KEY (group_id, person_id)
);
CREATE TABLE totp_backup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES user_accounts(person_id),
  code_hash text NOT NULL,
  used_at timestamptz
);
CREATE TABLE system_config (
  section text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
```

`sirdar/api/tests/conftest.py`:
```python
"""Real Postgres for every test: sirdar_test (Sirdar's schema, migrated to
head) and sirdar_test_source (a minimal portal-shaped schema the import
reads). Both live in the dev sirdar-db container (127.0.0.1:5434).
Tables are truncated before each test; roles are restored to defaults."""

import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text
from sqlalchemy.engine import make_url

API_DIR = Path(__file__).resolve().parents[1]
TEST_DB = os.environ.get("SIRDAR_TEST_DB", "sirdar_test")
if not TEST_DB.startswith("sirdar_test"):
    raise RuntimeError("SIRDAR_TEST_DB must start with 'sirdar_test'")
SOURCE_DB = f"{TEST_DB}_source"
BASE_URL = make_url(os.environ.get(
    "SIRDAR_TEST_DATABASE_URL", "postgresql+asyncpg://sirdar:sirdar@127.0.0.1:5434/sirdar"))


def _psycopg_url(database: str) -> str:
    return BASE_URL.set(drivername="postgresql", database=database).render_as_string(
        hide_password=False)


def _asyncpg_url(database: str) -> str:
    return BASE_URL.set(database=database).render_as_string(hide_password=False)


SOURCE_URL = _asyncpg_url(SOURCE_DB)
SOURCE_PSYCOPG_URL = _psycopg_url(SOURCE_DB)

SIRDAR_TABLES = ("users, user_roles, permission_overrides, totp_backup_codes, "
                 "auth_sessions, audit_log, import_runs")
SOURCE_TABLES = ("people, user_accounts, roles, person_roles, access_groups, "
                 "access_group_members, totp_backup_codes, system_config")


def _prepare_environment() -> None:
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        for name in (TEST_DB, SOURCE_DB):
            exists = conn.execute(
                "SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone()
            if exists is None:
                conn.execute(f'CREATE DATABASE "{name}"')

    os.environ["SIRDAR_ENV"] = "development"
    os.environ["SIRDAR_DATABASE_URL"] = _asyncpg_url(TEST_DB)
    os.environ["SIRDAR_SOURCE_DATABASE_URL"] = SOURCE_URL
    os.environ["SIRDAR_JWT_SECRET"] = "test-jwt-secret-" + "x" * 32
    os.environ["SS_PASSWORD_PEPPER"] = "test-pepper"
    os.environ["SS_TOTP_ENCRYPTION_KEY"] = Fernet.generate_key().decode()

    from sirdar_api.config import get_settings
    get_settings.cache_clear()

    subprocess.run([str(API_DIR / ".venv/bin/alembic"), "upgrade", "head"],
                   cwd=API_DIR, env={**os.environ}, check=True, capture_output=True)
    with psycopg.connect(SOURCE_PSYCOPG_URL, autocommit=True) as conn:
        conn.execute((Path(__file__).parent / "source_schema.sql").read_text())


_prepare_environment()


@pytest.fixture(autouse=True)
async def clean_db():
    from sirdar_api.access.defaults import restore_default_roles
    from sirdar_api.db.engine import dispose_engine, get_sessionmaker

    async with get_sessionmaker()() as session:
        connected = await session.scalar(text("SELECT current_database()"))
        if not str(connected).startswith("sirdar_test"):
            raise RuntimeError(f"refusing to TRUNCATE: connected to {connected!r}")
        await session.execute(text(f"TRUNCATE {SIRDAR_TABLES} CASCADE"))
        await restore_default_roles(session)
        await session.commit()
    with psycopg.connect(SOURCE_PSYCOPG_URL, autocommit=True) as conn:
        conn.execute(f"TRUNCATE {SOURCE_TABLES} CASCADE")
    yield
    await dispose_engine()


@pytest.fixture
async def client():
    from httpx import ASGITransport, AsyncClient

    from sirdar_api.api.app import create_app

    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest.fixture
async def db():
    from sirdar_api.db.engine import get_sessionmaker

    async with get_sessionmaker()() as session:
        yield session


@pytest.fixture
def source():
    with psycopg.connect(SOURCE_PSYCOPG_URL, autocommit=True) as conn:
        yield conn
```

`sirdar/api/tests/test_scaffold.py`:
```python
from sqlalchemy import text


async def test_healthz_reports_ok(client):
    for path in ("/healthz", "/api/healthz"):
        resp = await client.get(path)
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


async def test_migration_creates_every_table(db):
    names = set(await db.scalars(text(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")))
    assert {"roles", "users", "user_roles", "role_permissions", "permission_overrides",
            "totp_backup_codes", "auth_sessions", "audit_log", "import_runs"} <= names


async def test_default_roles_seeded(db):
    rows = (await db.execute(text("SELECT name, rank FROM roles ORDER BY rank DESC, name"))).all()
    assert [tuple(r) for r in rows] == [
        ("developer", 100), ("founder", 100), ("super_admin", 80), ("admin", 60)]


async def test_unknown_api_path_is_404_not_spa(client):
    resp = await client.get("/api/nope")
    assert resp.status_code == 404
```

- [ ] **Step 6: Create the venv and run the tests (expected to FAIL first, then pass)**

Write `test_scaffold.py` before `app.py` exists, then run it to see the import fail, then add the code above. Commands:

```bash
cd sirdar/api
python3.13 -m venv .venv
.venv/bin/pip install -q -e '.[dev]'
.venv/bin/pytest -q
```

Expected: `4 passed`. If alembic fails, rerun the subprocess by hand (`SIRDAR_DATABASE_URL=… .venv/bin/alembic upgrade head`) to see the error, since conftest captures output.

- [ ] **Step 7: Dev env script**

`sirdar/scripts/dev-env.sh` (mode 755):
```bash
#!/usr/bin/env bash
# Writes sirdar/.env for local development. The pepper and TOTP key are
# copied from the repo-root .env (they MUST match the portal's), and the
# import source points at the dev portal Postgres. Re-run safely: it
# keeps an existing SIRDAR_JWT_SECRET.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_ENV=../.env
[[ -f "$ROOT_ENV" ]] || { echo "error: $ROOT_ENV not found" >&2; exit 1; }
get() { grep -E "^$1=" "$ROOT_ENV" | head -1 | cut -d= -f2-; }
JWT=$(grep -E '^SIRDAR_JWT_SECRET=' .env 2>/dev/null | cut -d= -f2- || true)
[[ -n "$JWT" ]] || JWT=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
SOURCE=$(get SS_DATABASE_URL)
cat > .env <<EOF
SIRDAR_ENV=development
SIRDAR_DATABASE_URL=postgresql+asyncpg://sirdar:sirdar@127.0.0.1:5434/sirdar
SIRDAR_SOURCE_DATABASE_URL=$SOURCE
SIRDAR_JWT_SECRET=$JWT
SS_PASSWORD_PEPPER=$(get SS_PASSWORD_PEPPER)
SS_TOTP_ENCRYPTION_KEY=$(get SS_TOTP_ENCRYPTION_KEY)
EOF
chmod 600 .env
echo "wrote sirdar/.env"
```

Run `sirdar/scripts/dev-env.sh`, then `cd sirdar/api && .venv/bin/alembic upgrade head`. Expected: migration `0001` applies to the dev `sirdar` database. Never commit `sirdar/.env`; `git status` must not list it.

- [ ] **Step 8: Commit**

```bash
git add sirdar docker-compose.dev.yml
git commit -m "feat(sirdar): API scaffold, own Postgres, schema 0001 and test harness"
```

---

### Task 2: Security primitives and portal compatibility pins

**Files:**
- Create: `sirdar/api/src/sirdar_api/security/__init__.py` (empty), `security/passwords.py`, `security/tokens.py`, `security/totp.py`
- Test: `sirdar/api/tests/test_security.py`, `sirdar/api/tests/test_portal_compat.py`

**Interfaces:**
- Produces:
  - `passwords.hash_password(password, *, pepper) -> str`, `verify_password(hash, password, *, pepper) -> bool`, `DUMMY_HASH`.
  - `tokens`:
    - `ISSUER = "sirdar"`, `CHALLENGE_TTL_SECONDS = 300`, `class TokenError(Exception)`
    - `create_access_token(*, person_id, session_id, secret, ttl_seconds) -> str`
    - `decode_access_token(token, *, secret) -> dict`
    - `create_challenge_token(*, person_id, secret) -> str`
    - `decode_challenge_token(token, *, secret) -> uuid.UUID`
    - `generate_refresh_token() -> str`, `hash_refresh_token(token) -> str`
  - `totp`:
    - `BACKUP_CODE_LENGTH = 10`, `class TotpSeedError(Exception)`
    - `encrypt_secret(secret, *, key) -> bytes`, `decrypt_secret(blob, *, key) -> str`
    - `match_counter(secret, code, last_counter, *, now=None) -> int | None`
    - `compact_code(code) -> str`, `is_app_code(compact) -> bool`, `normalize_backup(code) -> str`

- [ ] **Step 1: Write failing tests**

`sirdar/api/tests/test_security.py`:
```python
import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pyotp
import pytest
from cryptography.fernet import Fernet

from sirdar_api.security import passwords, tokens, totp

SECRET = "s" * 40


def test_password_roundtrip_and_pepper_matters():
    h = passwords.hash_password("CorrectHorse9!", pepper="p1")
    assert passwords.verify_password(h, "CorrectHorse9!", pepper="p1")
    assert not passwords.verify_password(h, "CorrectHorse9!", pepper="p2")
    assert not passwords.verify_password("not-a-hash", "x", pepper="p1")


def test_access_token_roundtrip():
    pid, sid = uuid.uuid4(), uuid.uuid4()
    tok = tokens.create_access_token(person_id=pid, session_id=sid, secret=SECRET, ttl_seconds=60)
    claims = tokens.decode_access_token(tok, secret=SECRET)
    assert claims["sub"] == str(pid) and claims["sid"] == str(sid) and claims["iss"] == "sirdar"


def test_access_token_rejects_other_issuer_and_challenge_type():
    portal_style = jwt.encode({"iss": "serversherpa", "sub": "x", "sid": "y", "typ": "access",
                               "iat": datetime.now(UTC),
                               "exp": datetime.now(UTC) + timedelta(minutes=1)},
                              SECRET, algorithm="HS256")
    with pytest.raises(tokens.TokenError):
        tokens.decode_access_token(portal_style, secret=SECRET)
    challenge = tokens.create_challenge_token(person_id=uuid.uuid4(), secret=SECRET)
    with pytest.raises(tokens.TokenError):
        tokens.decode_access_token(challenge, secret=SECRET)


def test_challenge_roundtrip_and_expiry():
    pid = uuid.uuid4()
    assert tokens.decode_challenge_token(
        tokens.create_challenge_token(person_id=pid, secret=SECRET), secret=SECRET) == pid
    expired = jwt.encode({"iss": "sirdar", "sub": str(pid), "typ": "totp", "purpose": "verify",
                          "iat": datetime.now(UTC) - timedelta(minutes=10),
                          "exp": datetime.now(UTC) - timedelta(minutes=5)},
                         SECRET, algorithm="HS256")
    with pytest.raises(tokens.TokenError):
        tokens.decode_challenge_token(expired, secret=SECRET)


def test_refresh_token_hash_is_stable_sha256():
    t = tokens.generate_refresh_token()
    assert len(t) >= 43
    assert tokens.hash_refresh_token(t) == tokens.hash_refresh_token(t)
    assert len(tokens.hash_refresh_token(t)) == 64


def test_secret_roundtrip_and_wrong_key():
    key = Fernet.generate_key().decode()
    blob = totp.encrypt_secret("JBSWY3DPEHPK3PXP", key=key)
    assert totp.decrypt_secret(blob, key=key) == "JBSWY3DPEHPK3PXP"
    with pytest.raises(totp.TotpSeedError):
        totp.decrypt_secret(blob, key=Fernet.generate_key().decode())


def test_match_counter_accepts_drift_and_rejects_replay():
    seed = pyotp.random_base32()
    otp = pyotp.TOTP(seed)
    now = datetime.now(UTC)
    counter = otp.timecode(now)
    code = otp.generate_otp(counter)
    assert totp.match_counter(seed, code, None, now=now) == counter
    assert totp.match_counter(seed, code, counter, now=now) is None          # replay
    assert totp.match_counter(seed, otp.generate_otp(counter - 1), None, now=now) == counter - 1
    assert totp.match_counter(seed, otp.generate_otp(counter - 3), None, now=now) is None


def test_code_helpers():
    assert totp.compact_code("123 456") == "123456"
    assert totp.is_app_code("123456") and not totp.is_app_code("12345a")
    assert totp.normalize_backup("ABCDE-fghjk") == "abcdefghjk"
```

`sirdar/api/tests/test_portal_compat.py`:
```python
"""Sirdar copies a few portal security rules instead of importing the
portal package. These tests fail the moment the two drift: they load the
portal's pure password module by path and pin the exact lines of the
other rules Sirdar ports. A failure means: re-read the portal change,
port it to sirdar_api, then update the pin."""

import importlib.util
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from sirdar_api.security import passwords, totp

REPO = Path(__file__).resolve().parents[3]
PORTAL = REPO / "api" / "src" / "serversherpa"

pytestmark = pytest.mark.skipif(not PORTAL.exists(), reason="portal source not checked out")


def _portal_passwords():
    spec = importlib.util.spec_from_file_location(
        "portal_passwords", PORTAL / "security" / "passwords.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_portal_hash_verifies_in_sirdar_and_back():
    portal = _portal_passwords()
    h = portal.hash_password("CorrectHorse9!", pepper="pep")
    assert passwords.verify_password(h, "CorrectHorse9!", pepper="pep")
    h2 = passwords.hash_password("CorrectHorse9!", pepper="pep")
    assert portal.verify_password(h2, "CorrectHorse9!", pepper="pep")


def test_portal_totp_seed_encryption_is_plain_fernet():
    src = (PORTAL / "services" / "totp.py").read_text()
    assert "return fernet().encrypt(secret.encode())" in src
    assert "return fernet().decrypt(bytes(blob)).decode()" in src
    secretbox = (PORTAL / "security" / "secretbox.py").read_text()
    assert "return Fernet(key.encode())" in secretbox
    key = Fernet.generate_key().decode()
    blob = Fernet(key.encode()).encrypt(b"JBSWY3DPEHPK3PXP")   # what the portal stores
    assert totp.decrypt_secret(blob, key=key) == "JBSWY3DPEHPK3PXP"


def test_portal_backup_code_rules_unchanged():
    src = (PORTAL / "services" / "totp.py").read_text()
    assert "BACKUP_CODE_LENGTH = 10" in src
    assert 'return "".join(ch for ch in code.lower() if ch.isalnum())' in src
    assert "code_hash=hash_password(code, pepper=pepper)" in src


def test_portal_totp_policy_unchanged():
    src = (PORTAL / "services" / "totp.py").read_text()
    assert 'if not cfg.get("two_factor_enabled"):' in src
    assert 'if cfg.get("two_factor_required") or account.totp_required:' in src
    assert "AccessGroup.totp_required.is_(True)" in src
    assert "Role.totp_required.is_(True)" in src


def test_portal_password_expiry_unchanged():
    src = (PORTAL / "services" / "password_policy.py").read_text()
    assert "start = policy.since if changed is None else max(changed, policy.since)" in src
    assert "return start + timedelta(days=policy.days)" in src
    assert "if not policy.enabled or policy.since is None or account.password_hash is None:" in src
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd sirdar/api && .venv/bin/pytest -q tests/test_security.py tests/test_portal_compat.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'sirdar_api.security'`.

- [ ] **Step 3: Implement**

`security/passwords.py`:
```python
"""Argon2id with a server-side pepper — byte-for-byte the portal's scheme
(serversherpa/security/passwords.py), so imported hashes verify here.
test_portal_compat.py proves it."""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

_hasher = PasswordHasher()

# Verified against when no real hash exists, so "unknown email" and
# "wrong password" take the same time.
DUMMY_HASH = _hasher.hash("timing-equalizer-dummy-value")


def hash_password(password: str, *, pepper: str) -> str:
    return _hasher.hash(password + pepper)


def verify_password(password_hash: str, password: str, *, pepper: str) -> bool:
    try:
        _hasher.verify(password_hash, password + pepper)
        return True
    except (VerifyMismatchError, InvalidHashError):
        return False
```

`security/tokens.py`:
```python
"""Access tokens (short-lived JWT), 2FA challenge tokens, and opaque
refresh tokens (only their SHA-256 is stored). Issuer "sirdar", so a
portal token never verifies here even if someone reused the secret."""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt

ISSUER = "sirdar"
CHALLENGE_TTL_SECONDS = 300


class TokenError(Exception):
    pass


def create_access_token(*, person_id: uuid.UUID, session_id: uuid.UUID, secret: str,
                        ttl_seconds: int) -> str:
    now = datetime.now(UTC)
    return jwt.encode({"iss": ISSUER, "sub": str(person_id), "sid": str(session_id),
                       "iat": now, "exp": now + timedelta(seconds=ttl_seconds),
                       "typ": "access"}, secret, algorithm="HS256")


def decode_access_token(token: str, *, secret: str) -> dict:
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"], issuer=ISSUER,
                            options={"require": ["exp", "iat", "sub", "sid"]}, leeway=10)
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
    if claims.get("typ") != "access":
        raise TokenError("wrong token type")
    return claims


def create_challenge_token(*, person_id: uuid.UUID, secret: str) -> str:
    now = datetime.now(UTC)
    return jwt.encode({"iss": ISSUER, "sub": str(person_id), "purpose": "verify",
                       "iat": now, "exp": now + timedelta(seconds=CHALLENGE_TTL_SECONDS),
                       "typ": "totp"}, secret, algorithm="HS256")


def decode_challenge_token(token: str, *, secret: str) -> uuid.UUID:
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"], issuer=ISSUER,
                            options={"require": ["exp", "iat", "sub", "purpose"]}, leeway=10)
        if claims.get("typ") != "totp" or claims["purpose"] != "verify":
            raise TokenError("wrong token type")
        return uuid.UUID(claims["sub"])
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
    except ValueError as exc:
        raise TokenError("invalid subject") from exc


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(32)  # 256 bits


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
```

`security/totp.py`:
```python
"""TOTP pieces ported from the portal (serversherpa/services/totp.py):
seeds are Fernet tokens under SS_TOTP_ENCRYPTION_KEY, codes are 6 digits
/ 30 s with ±1 step of drift and no replays, backup codes are 10
lowercase alphanumerics hashed like passwords."""

import hmac
from datetime import UTC, datetime

import pyotp
from cryptography.fernet import Fernet, InvalidToken

BACKUP_CODE_LENGTH = 10


class TotpSeedError(Exception):
    """The stored seed does not decrypt with the configured key."""


def _fernet(key: str) -> Fernet:
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise TotpSeedError("SS_TOTP_ENCRYPTION_KEY is not a valid Fernet key") from exc


def encrypt_secret(secret: str, *, key: str) -> bytes:
    return _fernet(key).encrypt(secret.encode())


def decrypt_secret(blob: bytes, *, key: str) -> str:
    try:
        return _fernet(key).decrypt(bytes(blob)).decode()
    except InvalidToken as exc:
        raise TotpSeedError("stored TOTP seed does not decrypt with SS_TOTP_ENCRYPTION_KEY") from exc


def match_counter(secret: str, code: str, last_counter: int | None, *,
                  now: datetime | None = None) -> int | None:
    """The time-step counter `code` belongs to (±1 step), or None when it
    matches nothing new. A counter at or below `last_counter` is a replay."""
    otp = pyotp.TOTP(secret, digits=6, interval=30)
    base = otp.timecode(now or datetime.now(UTC))
    for offset in (0, -1, 1):
        counter = base + offset
        if hmac.compare_digest(otp.generate_otp(counter), code):
            if last_counter is not None and counter <= last_counter:
                return None
            return counter
    return None


def compact_code(code: str) -> str:
    """Authenticator apps often show "123 456"."""
    return "".join(code.split())


def is_app_code(compact: str) -> bool:
    return compact.isdigit() and len(compact) == 6


def normalize_backup(code: str) -> str:
    return "".join(ch for ch in code.lower() if ch.isalnum())
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest -q tests/test_security.py tests/test_portal_compat.py`
Expected: all pass. If a compat pin fails, the portal changed: port the change, don't loosen the pin.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api
git commit -m "feat(sirdar): password, token and TOTP primitives pinned to the portal's"
```

---

### Task 3: Permission registry and resolver

**Files:**
- Create: `sirdar/api/src/sirdar_api/access/resources.py`, `access/resolver.py`
- Test: `sirdar/api/tests/test_access.py`, `sirdar/api/tests/factories.py`

**Interfaces:**
- Consumes: `models.User`, `UserRole`, `Role`, `RolePermission`, `PermissionOverride`; `defaults.DEFAULT_GRANTS`; `passwords.hash_password`.
- Produces:
  - `resources.ACTIONS = ("view", "add", "change", "delete")`, `resources.Resource(id, label, developer_only=False)`, `resources.REGISTRY: dict[str, Resource]` (order: dashboard, users, access, audit, settings, devtools).
  - `resolver.TOP_RANK = 100`, `resolver.can_touch_rank(actor_rank, target_rank) -> bool`.
  - `resolver.AccessInfo` dataclass:
    - `perms: dict[str, dict[str, bool]]`
    - `sources: dict[str, dict[str, str]]`, where the values are `"role" | "override" | "hard_gate"`
    - `max_rank: int`, `role_names: list[str]`
    - method `can(resource, action) -> bool`
  - `resolver.assemble(roles: list[tuple[str, int]], granted: dict[str, set[str]], overrides: dict[str, dict[str, bool]]) -> AccessInfo`.
  - `resolver.async resolve_access(db, person_id) -> AccessInfo`.
  - `resolver.async role_matrix(db) -> dict[str, dict[str, set[str]]]` (role -> resource -> actions).
  - `tests/factories.py`:
    - `PASSWORD = "CorrectHorse9!"`
    - `async make_user(db, *, email="alice@test.example.com", roles=("admin",), source="portal", first_name="Alice", last_name="Anderson", **fields) -> User` (commits; hashes `PASSWORD` with the test pepper)

- [ ] **Step 1: Write failing tests**

`sirdar/api/tests/factories.py`:
```python
import uuid

from sirdar_api.config import get_settings
from sirdar_api.db.models import User, UserRole
from sirdar_api.security.passwords import hash_password

PASSWORD = "CorrectHorse9!"


async def make_user(db, *, email: str = "alice@test.example.com",
                    roles: tuple[str, ...] = ("admin",), source: str = "portal",
                    first_name: str = "Alice", last_name: str = "Anderson",
                    **fields) -> User:
    pepper = get_settings().password_pepper.get_secret_value()
    fields.setdefault("password_hash", hash_password(PASSWORD, pepper=pepper))
    user = User(person_id=fields.pop("person_id", uuid.uuid4()), source=source, email=email,
                first_name=first_name, last_name=last_name, **fields)
    db.add(user)
    await db.flush()
    for role in roles:
        db.add(UserRole(person_id=user.person_id, role=role))
    await db.commit()
    return user
```

`sirdar/api/tests/test_access.py`:
```python
import importlib.util
from pathlib import Path

from sirdar_api.access.defaults import DEFAULT_GRANTS, DEFAULT_ROLES
from sirdar_api.access.resolver import assemble, can_touch_rank, resolve_access, role_matrix
from sirdar_api.access.resources import ACTIONS, REGISTRY
from sirdar_api.db.models import PermissionOverride

from .factories import make_user


def test_defaults_only_name_known_resources_and_actions():
    for grants in DEFAULT_GRANTS.values():
        for res, actions in grants.items():
            assert res in REGISTRY
            assert set(actions) <= set(ACTIONS)
    assert [r for r, g in DEFAULT_GRANTS.items() if "devtools" in g] == ["developer"]


def test_migration_seed_matches_defaults():
    path = Path(__file__).resolve().parents[1] / "migrations/versions/0001_initial.py"
    spec = importlib.util.spec_from_file_location("m0001", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.ROLES == DEFAULT_ROLES
    assert mod.GRANTS == DEFAULT_GRANTS


def test_can_touch_rank():
    assert can_touch_rank(80, 60)
    assert not can_touch_rank(80, 80)
    assert not can_touch_rank(60, 80)
    assert can_touch_rank(100, 100)


def test_assemble_role_union_override_and_hard_gate():
    info = assemble([("admin", 60), ("super_admin", 80)],
                    {"users": {"view", "add"}, "devtools": {"view"}},
                    {"users": {"add": False}, "devtools": {"view": True}})
    assert info.max_rank == 80
    assert info.role_names == ["admin", "super_admin"]
    assert info.can("users", "view") and info.sources["users"]["view"] == "role"
    assert not info.can("users", "add") and info.sources["users"]["add"] == "override"
    # devtools is developer-only: neither grants nor overrides reach it
    assert not info.can("devtools", "view") and info.sources["devtools"]["view"] == "hard_gate"
    assert set(info.perms) == set(REGISTRY)


async def test_resolve_access_reads_roles_and_overrides(db):
    user = await make_user(db, roles=("admin",))
    db.add(PermissionOverride(person_id=user.person_id, resource="users", action="change",
                              allow=True))
    await db.commit()
    info = await resolve_access(db, user.person_id)
    assert info.can("users", "view") and info.can("users", "change")
    assert not info.can("users", "delete")
    assert info.max_rank == 60


async def test_developer_sees_devtools(db):
    user = await make_user(db, roles=("developer",))
    assert (await resolve_access(db, user.person_id)).can("devtools", "view")


async def test_role_matrix(db):
    matrix = await role_matrix(db)
    assert matrix["admin"]["users"] == {"view"}
    assert "devtools" in matrix["developer"]
```

- [ ] **Step 2: Run to fail**

Run: `.venv/bin/pytest -q tests/test_access.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'sirdar_api.access.resolver'`.

- [ ] **Step 3: Implement**

`access/resources.py`:
```python
"""Everything Sirdar can grant. One row per resource; actions are fixed."""

from dataclasses import dataclass

ACTIONS: tuple[str, ...] = ("view", "add", "change", "delete")


@dataclass(frozen=True)
class Resource:
    id: str
    label: str
    developer_only: bool = False   # hard gate: only the developer role, no override reaches it


REGISTRY: dict[str, Resource] = {r.id: r for r in (
    Resource("dashboard", "Dashboard"),
    Resource("users", "Users"),
    Resource("access", "Roles & access"),
    Resource("audit", "Audit log"),
    Resource("settings", "Settings"),
    Resource("devtools", "Developer tools", developer_only=True),
)}
```

`access/resolver.py`:
```python
"""Effective permissions — the portal's model minus group gates (everyone
in Sirdar is rank >= 60, the portal's gate-bypass tier). Per resource x
action: hard gate (developer_only) -> per-person override -> role union."""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resources import ACTIONS, REGISTRY
from sirdar_api.db.models import PermissionOverride, Role, RolePermission, UserRole

TOP_RANK = 100


def can_touch_rank(actor_rank: int, target_rank: int) -> bool:
    """Strictly-below management; the top rank may also manage peers."""
    return actor_rank >= TOP_RANK or target_rank < actor_rank


@dataclass
class AccessInfo:
    perms: dict[str, dict[str, bool]] = field(default_factory=dict)
    sources: dict[str, dict[str, str]] = field(default_factory=dict)
    max_rank: int = 0
    role_names: list[str] = field(default_factory=list)

    def can(self, resource: str, action: str) -> bool:
        return self.perms.get(resource, {}).get(action, False)


def assemble(roles: list[tuple[str, int]], granted: dict[str, set[str]],
             overrides: dict[str, dict[str, bool]]) -> AccessInfo:
    info = AccessInfo()
    role_set = {name for name, _ in roles}
    info.role_names = sorted(role_set)
    info.max_rank = max((rank for _, rank in roles), default=0)
    for res_id, res in REGISTRY.items():
        cells: dict[str, bool] = {}
        sources: dict[str, str] = {}
        for action in ACTIONS:
            if res.developer_only and "developer" not in role_set:
                cells[action], sources[action] = False, "hard_gate"
                continue
            ov = overrides.get(res_id, {}).get(action)
            if ov is not None:
                cells[action], sources[action] = ov, "override"
            else:
                cells[action], sources[action] = action in granted.get(res_id, set()), "role"
        info.perms[res_id] = cells
        info.sources[res_id] = sources
    return info


async def resolve_access(db: AsyncSession, person_id: uuid.UUID) -> AccessInfo:
    roles = [(name, rank) for name, rank in (await db.execute(
        select(UserRole.role, Role.rank).join(Role, Role.name == UserRole.role)
        .where(UserRole.person_id == person_id))).all()]
    granted: dict[str, set[str]] = {}
    if roles:
        for res, action in (await db.execute(
                select(RolePermission.resource, RolePermission.action)
                .where(RolePermission.role.in_([r for r, _ in roles])))).all():
            granted.setdefault(res, set()).add(action)
    overrides: dict[str, dict[str, bool]] = {}
    for res, action, allow in (await db.execute(
            select(PermissionOverride.resource, PermissionOverride.action,
                   PermissionOverride.allow)
            .where(PermissionOverride.person_id == person_id))).all():
        overrides.setdefault(res, {})[action] = allow
    return assemble(roles, granted, overrides)


async def role_matrix(db: AsyncSession) -> dict[str, dict[str, set[str]]]:
    matrix: dict[str, dict[str, set[str]]] = {
        name: {} for name in await db.scalars(select(Role.name))}
    for role, res, action in (await db.execute(
            select(RolePermission.role, RolePermission.resource, RolePermission.action))).all():
        matrix.setdefault(role, {}).setdefault(res, set()).add(action)
    return matrix
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api
git commit -m "feat(sirdar): permission registry and resolver (portal model, developer hard gate)"
```

---

### Task 4: Auth service (login, 2FA, sessions)

**Files:**
- Create: `sirdar/api/src/sirdar_api/services/audit.py`, `services/auth.py`
- Test: `sirdar/api/tests/test_auth_service.py`

**Interfaces:**
- Consumes: Task 2 primitives, Task 3 `resolve_access`/`AccessInfo`, `models.*`, `factories.make_user/PASSWORD`.
- Produces:
  - `audit.audit(db, *, actor_id, action, entity_type, entity_id=None, ip=None, changes=None) -> None` (adds the row; the caller commits).
  - `auth.AuthError(code)` with `.code`.
  - `auth.AuthResult` dataclass: `access_token`, `refresh_token`, `session_expires_at`, `user: User`, `access: AccessInfo`, `session_id`.
  - `auth.LoginChallenge` dataclass: `user`, `challenge_token`, `backup_codes_remaining: int`.
  - `auth.async login(db, *, email, password, ip=None, user_agent=None) -> AuthResult | LoginChallenge`.
  - `auth.async verify_totp(db, *, challenge_token, code, ip=None, user_agent=None) -> AuthResult`.
  - `auth.async start_session(db, user, *, ip, user_agent) -> AuthResult`.
  - `auth.async refresh(db, *, refresh_token, ip=None, user_agent=None) -> AuthResult`.
  - `auth.async logout(db, *, refresh_token) -> None`.
  - `auth.async revoke_sessions(db, person_id, *, reason) -> int` (does not commit).
  - `auth.async backup_codes_remaining(db, person_id) -> int`.

- [ ] **Step 1: Write failing tests**

`sirdar/api/tests/test_auth_service.py`:
```python
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
    assert await _code(db, user) == "account_locked"


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
    with pytest.raises(AuthError):
        await auth.refresh(db, refresh_token=second.refresh_token)   # family revoked


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
    a = await auth.login(db, email=user.email, password=PASSWORD)
    await auth.logout(db, refresh_token=a.refresh_token)
    await auth.logout(db, refresh_token="unknown")          # never fails
    with pytest.raises(AuthError):
        await auth.refresh(db, refresh_token=a.refresh_token)
    await auth.login(db, email=user.email, password=PASSWORD)
    assert await auth.revoke_sessions(db, user.person_id, reason="test") == 1
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
```

- [ ] **Step 2: Run to fail**

Run: `.venv/bin/pytest -q tests/test_auth_service.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'sirdar_api.services.audit'` (or `services.auth`).

- [ ] **Step 3: Implement**

`services/audit.py`:
```python
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.db.models import AuditLog


def audit(db: AsyncSession, *, actor_id: uuid.UUID | None, action: str, entity_type: str,
          entity_id: str | None = None, ip: str | None = None,
          changes: dict | None = None) -> None:
    """Queue one audit row on the caller's transaction (the caller commits)."""
    db.add(AuditLog(actor_id=actor_id, action=action, entity_type=entity_type,
                    entity_id=entity_id, ip=ip, changes=changes or {}))
```

`services/auth.py`:
```python
"""Sign-in, 2FA and sessions — the portal's flow (serversherpa/services/
auth.py + totp.py) with Sirdar's extra refusals. Sessions have an ABSOLUTE
lifetime: every refresh rotation inherits the original deadline."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resolver import AccessInfo, resolve_access
from sirdar_api.config import Settings, get_settings
from sirdar_api.db.models import AuthSession, TotpBackupCode, User
from sirdar_api.security.passwords import DUMMY_HASH, verify_password
from sirdar_api.security.tokens import (
    TokenError, create_access_token, create_challenge_token, decode_challenge_token,
    generate_refresh_token, hash_refresh_token,
)
from sirdar_api.security.totp import (
    BACKUP_CODE_LENGTH, TotpSeedError, compact_code, decrypt_secret, is_app_code,
    match_counter, normalize_backup,
)
from sirdar_api.services.audit import audit


class AuthError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass
class AuthResult:
    access_token: str
    refresh_token: str
    session_expires_at: datetime
    user: User
    access: AccessInfo
    session_id: uuid.UUID


@dataclass
class LoginChallenge:
    user: User
    challenge_token: str
    backup_codes_remaining: int


def _strike(user: User, now: datetime, settings: Settings) -> None:
    """A wrong password or code: N strikes -> temporary lockout."""
    user.failed_login_count += 1
    user.updated_at = now
    if user.failed_login_count >= settings.max_failed_logins:
        user.locked_until = now + timedelta(seconds=settings.lockout_seconds)
        user.failed_login_count = 0


async def _refuse(db: AsyncSession, user: User, code: str, ip: str | None) -> AuthError:
    audit(db, actor_id=user.person_id, entity_type="auth", entity_id=str(user.person_id),
          action="login_failed", changes={"reason": code}, ip=ip)
    await db.commit()
    return AuthError(code)


async def backup_codes_remaining(db: AsyncSession, person_id: uuid.UUID) -> int:
    return await db.scalar(select(func.count(TotpBackupCode.id)).where(
        TotpBackupCode.person_id == person_id, TotpBackupCode.used_at.is_(None))) or 0


async def login(db: AsyncSession, *, email: str, password: str, ip: str | None = None,
                user_agent: str | None = None) -> AuthResult | LoginChallenge:
    settings = get_settings()
    pepper = settings.password_pepper.get_secret_value()
    now = datetime.now(UTC)

    user = await db.scalar(select(User).where(User.email == email))
    if user is None or user.password_hash is None:
        verify_password(DUMMY_HASH, password, pepper=pepper)   # same time as a real check
        audit(db, actor_id=None, entity_type="auth", entity_id=email,
              action="login_failed", ip=ip)
        await db.commit()
        raise AuthError("invalid_credentials")

    if not verify_password(user.password_hash, password, pepper=pepper):
        _strike(user, now, settings)
        audit(db, actor_id=None, entity_type="auth", entity_id=email,
              action="login_failed", ip=ip)
        await db.commit()
        raise AuthError("invalid_credentials")

    # Password is correct from here on — only now is it safe to reveal
    # account status (otherwise an email list could be sorted into
    # disabled / locked / other without knowing any password).
    if user.disabled_at is not None:
        raise await _refuse(db, user, "account_disabled", ip)
    if user.locked_until is not None and user.locked_until > now:
        raise await _refuse(db, user, "account_locked", ip)
    if user.source == "portal" and (
            user.must_change_password
            or (user.password_expires_at is not None and user.password_expires_at <= now)):
        raise await _refuse(db, user, "password_change_required", ip)
    if user.totp_required and user.totp_confirmed_at is None:
        raise await _refuse(db, user, "totp_enrollment_required", ip)

    if (user.totp_enabled and user.totp_confirmed_at is not None
            and user.totp_secret_enc is not None):
        audit(db, actor_id=user.person_id, entity_type="auth",
              entity_id=str(user.person_id), action="login_challenged", ip=ip)
        await db.commit()
        return LoginChallenge(
            user=user,
            challenge_token=create_challenge_token(
                person_id=user.person_id, secret=settings.jwt_secret.get_secret_value()),
            backup_codes_remaining=await backup_codes_remaining(db, user.person_id))

    return await start_session(db, user, ip=ip, user_agent=user_agent)


async def verify_totp(db: AsyncSession, *, challenge_token: str, code: str,
                      ip: str | None = None, user_agent: str | None = None) -> AuthResult:
    settings = get_settings()
    try:
        person_id = decode_challenge_token(
            challenge_token, secret=settings.jwt_secret.get_secret_value())
    except TokenError:
        raise AuthError("invalid_challenge") from None

    # row lock: two concurrent verifies can't both accept the same code
    user = await db.scalar(select(User).where(User.person_id == person_id)
                           .with_for_update().execution_options(populate_existing=True))
    now = datetime.now(UTC)
    if user is None or user.disabled_at is not None:
        raise AuthError("invalid_challenge")
    if user.locked_until is not None and user.locked_until > now:
        raise AuthError("account_locked")
    if user.totp_confirmed_at is None or user.totp_secret_enc is None:
        raise AuthError("invalid_challenge")

    compact = compact_code(code)
    if is_app_code(compact):
        try:
            seed = decrypt_secret(user.totp_secret_enc,
                                  key=settings.totp_encryption_key.get_secret_value())
        except TotpSeedError:
            raise AuthError("totp_seed_unreadable") from None
        counter = match_counter(seed, compact, user.totp_last_counter)
        if counter is not None:
            user.totp_last_counter = counter
            return await start_session(db, user, ip=ip, user_agent=user_agent)
    else:
        wanted = normalize_backup(code)
        if len(wanted) == BACKUP_CODE_LENGTH:
            pepper = settings.password_pepper.get_secret_value()
            rows = list(await db.scalars(select(TotpBackupCode).where(
                TotpBackupCode.person_id == user.person_id, TotpBackupCode.used_at.is_(None))))
            for row in rows:
                if verify_password(row.code_hash, wanted, pepper=pepper):
                    # conditional: a concurrent request may have used it first
                    result = await db.execute(update(TotpBackupCode).where(
                        TotpBackupCode.id == row.id, TotpBackupCode.used_at.is_(None),
                    ).values(used_at=now))
                    if result.rowcount == 0:
                        continue
                    audit(db, actor_id=user.person_id, entity_type="user",
                          entity_id=str(user.person_id), action="totp.backup_used", ip=ip)
                    return await start_session(db, user, ip=ip, user_agent=user_agent)

    _strike(user, now, settings)
    audit(db, actor_id=None, entity_type="user", entity_id=str(user.person_id),
          action="totp.verify_failed", ip=ip)
    await db.commit()
    raise AuthError("totp_invalid")


async def start_session(db: AsyncSession, user: User, *, ip: str | None,
                        user_agent: str | None) -> AuthResult:
    """Reset lockout state, stamp last login, open a session family. Commits."""
    settings = get_settings()
    now = datetime.now(UTC)
    user.failed_login_count = 0
    user.locked_until = None
    user.last_login_at = now
    user.last_login_ip = ip
    user.updated_at = now

    refresh_token = generate_refresh_token()
    session_id = uuid.uuid4()
    session = AuthSession(id=session_id, person_id=user.person_id, family_id=session_id,
                          token_hash=hash_refresh_token(refresh_token),
                          expires_at=now + timedelta(seconds=settings.session_ttl_seconds),
                          ip_address=ip, user_agent=user_agent)
    db.add(session)
    audit(db, actor_id=user.person_id, entity_type="auth", entity_id=str(user.person_id),
          action="login", ip=ip)
    await db.commit()

    access = await resolve_access(db, user.person_id)
    return AuthResult(
        access_token=create_access_token(
            person_id=user.person_id, session_id=session_id,
            secret=settings.jwt_secret.get_secret_value(),
            ttl_seconds=settings.access_token_ttl_seconds),
        refresh_token=refresh_token, session_expires_at=session.expires_at,
        user=user, access=access, session_id=session_id)


async def _revoke_family(db: AsyncSession, family_id: uuid.UUID, *, reason: str) -> None:
    await db.execute(update(AuthSession)
                     .where(AuthSession.family_id == family_id, AuthSession.revoked_at.is_(None))
                     .values(revoked_at=datetime.now(UTC), revoke_reason=reason))


async def refresh(db: AsyncSession, *, refresh_token: str, ip: str | None = None,
                  user_agent: str | None = None) -> AuthResult:
    settings = get_settings()
    now = datetime.now(UTC)
    session = await db.scalar(select(AuthSession)
                              .where(AuthSession.token_hash == hash_refresh_token(refresh_token))
                              .with_for_update())
    if session is None or session.revoked_at is not None:
        raise AuthError("invalid_session")
    if session.rotated_at is not None:
        # a rotated token presented again = replay of a stolen token
        await _revoke_family(db, session.family_id, reason="reuse_detected")
        audit(db, actor_id=session.person_id, entity_type="auth",
              entity_id=str(session.person_id), action="token_replay_detected", ip=ip)
        await db.commit()
        raise AuthError("session_reuse_detected")
    if session.expires_at <= now:
        raise AuthError("session_expired")

    user = await db.get(User, session.person_id)
    if user is None or user.disabled_at is not None:
        raise AuthError("account_disabled")

    new_token = generate_refresh_token()
    new_id = uuid.uuid4()
    db.add(AuthSession(id=new_id, person_id=session.person_id, family_id=session.family_id,
                       token_hash=hash_refresh_token(new_token),
                       expires_at=session.expires_at,   # absolute deadline, never extended
                       ip_address=ip, user_agent=user_agent))
    await db.flush()   # the successor must exist before the old row points at it
    session.rotated_at = now
    session.replaced_by = new_id
    await db.commit()

    access = await resolve_access(db, user.person_id)
    return AuthResult(
        access_token=create_access_token(
            person_id=user.person_id, session_id=new_id,
            secret=settings.jwt_secret.get_secret_value(),
            ttl_seconds=settings.access_token_ttl_seconds),
        refresh_token=new_token, session_expires_at=session.expires_at,
        user=user, access=access, session_id=new_id)


async def logout(db: AsyncSession, *, refresh_token: str) -> None:
    """Revoke the whole login (family). Unknown tokens are a silent no-op."""
    session = await db.scalar(select(AuthSession)
                              .where(AuthSession.token_hash == hash_refresh_token(refresh_token)))
    if session is not None:
        await _revoke_family(db, session.family_id, reason="logout")
        audit(db, actor_id=session.person_id, entity_type="auth",
              entity_id=str(session.person_id), action="logout")
        await db.commit()


async def revoke_sessions(db: AsyncSession, person_id: uuid.UUID, *, reason: str) -> int:
    """Revoke every live session family of a person. Returns the number of
    families revoked. Does not commit."""
    families = set(await db.scalars(select(AuthSession.family_id).where(
        AuthSession.person_id == person_id, AuthSession.revoked_at.is_(None),
        AuthSession.rotated_at.is_(None))))
    await db.execute(update(AuthSession)
                     .where(AuthSession.person_id == person_id, AuthSession.revoked_at.is_(None))
                     .values(revoked_at=datetime.now(UTC), revoke_reason=reason))
    return len(families)
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api
git commit -m "feat(sirdar): sign-in, 2FA verify and rotating sessions (portal flow + Sirdar refusals)"
```

---

### Task 5: Auth and system HTTP API (portal contract)

**Files:**
- Create: `sirdar/api/src/sirdar_api/api/deps.py`, `api/schemas.py`, `api/routes/auth.py`, `api/routes/system.py`
- Modify: `sirdar/api/src/sirdar_api/api/app.py` (include routers)
- Test: `sirdar/api/tests/test_auth_api.py`

**Interfaces:**
- Consumes: the Task 4 service, Task 3 `resolve_access`.
- Produces:
  - `deps.DbSession`
  - `deps.AuthContext(user, session, access)`, `deps.CurrentUser`
  - `deps.require_permission(resource, action)` (returns `Depends(...)` resolving to `AuthContext`)
  - `deps.client_ip(request) -> str | None`
  - `schemas.PersonOut`, `ScopeOut`, `TotpStatusOut`, `NotifPrefs`, `UiPreferences`, `SessionOut`, `MeOut`, `LoginIn`, `LoginChallengeOut`, `TotpVerifyIn`, `SystemStatusOut`, `EffectiveCellOut`
  - `routes.auth.me_fields(db, user, access, session_expires_at) -> dict`
  - `routes.auth.person_out(user) -> PersonOut`
  - Endpoints:
    - `POST /api/auth/login`, `POST /api/auth/totp/verify`, `POST /api/auth/refresh`, `POST /api/auth/logout`
    - `GET /api/auth/me`, `PUT /api/auth/me/preferences`
    - `GET /api/system/status`

- [ ] **Step 1: Write failing tests**

`sirdar/api/tests/test_auth_api.py`:
```python
from datetime import UTC, datetime

import pyotp

from sirdar_api.config import get_settings
from sirdar_api.security.totp import encrypt_secret

from .factories import PASSWORD, make_user


async def _login(client, email="alice@test.example.com", password=PASSWORD):
    return await client.post("/api/auth/login", json={"email": email, "password": password})


async def test_login_returns_portal_session_shape_and_cookie(client, db):
    await make_user(db, roles=("super_admin",))
    resp = await _login(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    for key in ("access_token", "expires_in", "session_expires_at", "person", "roles",
                "must_change_password", "preferences", "perms", "max_rank", "scope",
                "password_min_length", "totp"):
        assert key in body, key
    assert body["person"]["display_name"] == "Alice Anderson"
    assert body["scope"] == {"global": True, "client_ids": [], "partner_ids": []}
    assert body["perms"]["users"]["add"] is True
    assert body["preferences"]["nav_mode"] == "expanded"
    cookie = resp.headers["set-cookie"]
    assert "sirdar_refresh=" in cookie and "Path=/api/auth" in cookie and "HttpOnly" in cookie


async def test_login_errors_use_portal_codes(client, db):
    await make_user(db, must_change_password=True)
    bad = await _login(client, password="wrong")
    assert bad.status_code == 401 and bad.json() == {"detail": {"code": "invalid_credentials"}}
    must = await _login(client)
    assert must.status_code == 403
    assert must.json()["detail"]["code"] == "password_change_required"


async def test_totp_challenge_flow(client, db):
    seed = pyotp.random_base32()
    key = get_settings().totp_encryption_key.get_secret_value()
    await make_user(db, totp_secret_enc=encrypt_secret(seed, key=key),
                    totp_confirmed_at=datetime.now(UTC), totp_enabled=True)
    first = await _login(client)
    assert first.status_code == 200
    challenge = first.json()
    assert challenge["status"] == "totp_verify" and challenge["challenge_token"]
    missing = await client.post("/api/auth/totp/verify", json={"code": "123456"})
    assert missing.status_code == 401 and missing.json()["detail"]["code"] == "invalid_challenge"
    ok = await client.post("/api/auth/totp/verify",
                           json={"code": pyotp.TOTP(seed).now(), "remember": True},
                           headers={"X-Totp-Challenge": challenge["challenge_token"]})
    assert ok.status_code == 200 and ok.json()["status"] == "ok"


async def test_refresh_me_preferences_logout(client, db):
    await make_user(db)
    login = await _login(client)
    token = login.json()["access_token"]
    me = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200 and me.json()["person"]["email"] == "alice@test.example.com"
    prefs = await client.put("/api/auth/me/preferences",
                             headers={"Authorization": f"Bearer {token}"},
                             json={**login.json()["preferences"], "nav_mode": "rail"})
    assert prefs.status_code == 200 and prefs.json()["nav_mode"] == "rail"
    refreshed = await client.post("/api/auth/refresh")       # httpx keeps the cookie jar
    assert refreshed.status_code == 200
    assert refreshed.json()["preferences"]["nav_mode"] == "rail"
    out = await client.post("/api/auth/logout")
    assert out.status_code == 204
    again = await client.post("/api/auth/refresh")
    assert again.status_code == 401
    assert again.json()["detail"]["code"] in ("missing_refresh", "invalid_session")


async def test_refresh_without_cookie(client):
    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "missing_refresh"


async def test_me_requires_token_and_rejects_disabled(client, db):
    assert (await client.get("/api/auth/me")).json()["detail"]["code"] == "missing_token"
    user = await make_user(db)
    token = (await _login(client)).json()["access_token"]
    user.disabled_at = datetime.now(UTC)
    await db.commit()
    resp = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "account_disabled"


async def test_system_status(client, db):
    resp = await client.get("/api/system/status")
    assert resp.json() == {"read_only": False, "read_only_message": "", "workers_paused": False,
                           "banner": None, "totp_trust_days": 0, "needs_setup": True}
    await make_user(db)
    assert (await client.get("/api/system/status")).json()["needs_setup"] is False
```

- [ ] **Step 2: Run to fail**

Run: `.venv/bin/pytest -q tests/test_auth_api.py`
Expected: FAIL, with 404s, because the routes don't exist yet.

- [ ] **Step 3: Implement**

`api/schemas.py`:
```python
"""Response/request shapes. The auth ones mirror the portal's
serversherpa/api/schemas.py exactly — the SPA reuses the portal's
AuthProvider and Login, which read these fields."""

import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class PersonOut(BaseModel):
    id: uuid.UUID
    first_name: str
    last_name: str
    preferred_name: str | None
    display_name: str
    email: str | None
    job_title: str | None
    avatar_key: str | None = None
    avatar_url: str | None = None


class ScopeOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    global_: bool = Field(alias="global")
    client_ids: list[uuid.UUID] = []
    partner_ids: list[uuid.UUID] = []


class TotpStatusOut(BaseModel):
    enrolled: bool
    enrolled_at: datetime | None
    required: bool
    backup_codes_remaining: int


class NotifPrefs(BaseModel):
    model_config = ConfigDict(extra="ignore")

    critical: bool = True
    email: bool = True
    maint: bool = True
    digest: bool = False
    sound: Literal["none", "chime", "ping", "pop", "bell"] = "chime"


NAMED_ACCENTS = {"amber", "aqua", "blue", "violet", "pink", "green"}


class UiPreferences(BaseModel):
    """Same shape and defaults as the portal's UiPreferences."""

    model_config = ConfigDict(extra="ignore")

    accent: str = "amber"
    theme: Literal["light", "dark"] = "light"
    density: Literal["comfortable", "compact"] = "comfortable"
    list_size: Literal["small", "default", "large", "xlarge"] = "default"
    motion: bool = True
    notif: NotifPrefs = NotifPrefs()
    list_prefs: dict = {}
    nav_mode: Literal["expanded", "rail", "hidden"] = "expanded"
    nav_bg: str = "default"
    nav_size: Literal["small", "default", "large", "xlarge"] = "default"

    @field_validator("accent")
    @classmethod
    def _accent(cls, v: str) -> str:
        if v in NAMED_ACCENTS or re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            return v
        raise ValueError("accent must be a named accent or #rrggbb")

    @field_validator("nav_bg")
    @classmethod
    def _nav_bg(cls, v: str) -> str:
        if v == "default" or re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            return v
        raise ValueError("nav_bg must be 'default' or #rrggbb")


class MeOut(BaseModel):
    person: PersonOut
    roles: list[str]
    session_expires_at: datetime
    must_change_password: bool = False
    must_change_reason: Literal["temporary", "expired"] | None = None
    password_expires_at: datetime | None = None
    preferences: UiPreferences
    perms: dict[str, dict[str, bool]]
    max_rank: int
    scope: ScopeOut
    password_min_length: int = 8
    totp: TotpStatusOut
    kiosk_move: None = None
    source: Literal["portal", "local"]


class SessionOut(MeOut):
    status: Literal["ok"] = "ok"
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class LoginChallengeOut(BaseModel):
    status: Literal["totp_verify"] = "totp_verify"
    challenge_token: str
    backup_codes_remaining: int | None = None


class TotpVerifyIn(BaseModel):
    code: str = Field(min_length=6, max_length=16)
    remember: bool = False      # accepted for the portal client; Sirdar has no trusted devices


class SystemStatusOut(BaseModel):
    read_only: bool = False
    read_only_message: str = ""
    workers_paused: bool = False
    banner: str | None = None
    totp_trust_days: int = 0     # 0 hides "Remember this browser" on the shared Login
    needs_setup: bool


class EffectiveCellOut(BaseModel):
    value: bool
    source: Literal["role", "override", "hard_gate"]
```

`api/deps.py`:
```python
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resolver import AccessInfo, resolve_access
from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_db
from sirdar_api.db.models import AuthSession, User
from sirdar_api.security.tokens import TokenError, decode_access_token

_bearer = HTTPBearer(auto_error=False)

DbSession = Annotated[AsyncSession, Depends(get_db)]


@dataclass
class AuthContext:
    user: User
    session: AuthSession
    access: AccessInfo


def _unauthorized(code: str) -> HTTPException:
    return HTTPException(status_code=401, detail={"code": code},
                         headers={"WWW-Authenticate": "Bearer"})


async def authenticate_token(db: AsyncSession, token: str) -> AuthContext:
    try:
        claims = decode_access_token(token, secret=get_settings().jwt_secret.get_secret_value())
        session_id, person_id = uuid.UUID(claims["sid"]), uuid.UUID(claims["sub"])
    except (TokenError, ValueError):
        raise _unauthorized("invalid_token") from None
    session = await db.get(AuthSession, session_id)
    if (session is None or session.revoked_at is not None
            or session.expires_at <= datetime.now(UTC)):
        raise _unauthorized("session_ended")
    user = await db.get(User, person_id)
    if user is None or user.disabled_at is not None:
        raise _unauthorized("account_disabled")
    return AuthContext(user=user, session=session,
                       access=await resolve_access(db, user.person_id))


async def get_current_user(
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthContext:
    if credentials is None:
        raise _unauthorized("missing_token")
    return await authenticate_token(db, credentials.credentials)


CurrentUser = Annotated[AuthContext, Depends(get_current_user)]


def require_permission(resource: str, action: str):
    """Route guard: require an effective (resource, action) permission."""

    async def guard(user: CurrentUser) -> AuthContext:
        if not user.access.can(resource, action):
            raise HTTPException(status_code=403, detail={"code": "forbidden"})
        return user

    return Depends(guard)


def client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip() or None
    return request.client.host if request.client else None
```

`api/routes/auth.py`:
```python
"""Auth endpoints — the portal's contract under /api/auth. The refresh
token travels ONLY in the httpOnly sirdar_refresh cookie (path /api/auth)."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resolver import AccessInfo
from sirdar_api.api.deps import CurrentUser, DbSession, client_ip
from sirdar_api.api.schemas import (
    LoginChallengeOut, LoginIn, MeOut, PersonOut, ScopeOut, SessionOut, TotpStatusOut,
    TotpVerifyIn, UiPreferences,
)
from sirdar_api.config import get_settings
from sirdar_api.db.models import User
from sirdar_api.services import auth as auth_service
from sirdar_api.services.auth import AuthError, AuthResult, LoginChallenge

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "sirdar_refresh"
COOKIE_PATH = "/api/auth"
_STATUS = {"account_locked": 423, "password_change_required": 403,
           "totp_enrollment_required": 403, "totp_seed_unreadable": 409}


def _auth_http_error(exc: AuthError) -> HTTPException:
    return HTTPException(status_code=_STATUS.get(exc.code, 401), detail={"code": exc.code})


def _set_refresh_cookie(response: Response, result: AuthResult) -> None:
    settings = get_settings()
    response.set_cookie(REFRESH_COOKIE, result.refresh_token,
                        expires=result.session_expires_at, httponly=True,
                        secure=settings.env != "development", samesite="lax",
                        domain=settings.cookie_domain or None, path=COOKIE_PATH)


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, domain=get_settings().cookie_domain or None,
                           path=COOKIE_PATH)


def person_out(user: User) -> PersonOut:
    return PersonOut(id=user.person_id, first_name=user.first_name, last_name=user.last_name,
                     preferred_name=user.preferred_name, display_name=user.display_name,
                     email=user.email, job_title=user.job_title)


async def me_fields(db: AsyncSession, user: User, access: AccessInfo,
                    session_expires_at: datetime) -> dict:
    return {
        "person": person_out(user),
        "roles": access.role_names,
        "session_expires_at": session_expires_at,
        "password_expires_at": user.password_expires_at,
        "preferences": UiPreferences.model_validate(user.ui_prefs or {}),
        "perms": access.perms,
        "max_rank": access.max_rank,
        "scope": ScopeOut(**{"global": True}),
        "totp": TotpStatusOut(
            enrolled=user.totp_confirmed_at is not None, enrolled_at=user.totp_confirmed_at,
            required=user.totp_required,
            backup_codes_remaining=await auth_service.backup_codes_remaining(
                db, user.person_id)),
        "source": user.source,
    }


async def _session_out(db: AsyncSession, result: AuthResult, response: Response) -> SessionOut:
    _set_refresh_cookie(response, result)
    return SessionOut(access_token=result.access_token,
                      expires_in=get_settings().access_token_ttl_seconds,
                      **await me_fields(db, result.user, result.access,
                                        result.session_expires_at))


@router.post("/login", response_model=SessionOut | LoginChallengeOut)
async def login(body: LoginIn, request: Request, response: Response, db: DbSession):
    try:
        result = await auth_service.login(db, email=body.email, password=body.password,
                                          ip=client_ip(request),
                                          user_agent=request.headers.get("user-agent"))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    if isinstance(result, LoginChallenge):
        return LoginChallengeOut(challenge_token=result.challenge_token,
                                 backup_codes_remaining=result.backup_codes_remaining)
    return await _session_out(db, result, response)


@router.post("/totp/verify", response_model=SessionOut)
async def totp_verify(body: TotpVerifyIn, request: Request, response: Response, db: DbSession,
                      x_totp_challenge: Annotated[str | None, Header()] = None):
    if not x_totp_challenge:
        raise HTTPException(status_code=401, detail={"code": "invalid_challenge"})
    try:
        result = await auth_service.verify_totp(
            db, challenge_token=x_totp_challenge, code=body.code, ip=client_ip(request),
            user_agent=request.headers.get("user-agent"))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return await _session_out(db, result, response)


@router.post("/refresh", response_model=SessionOut)
async def refresh(request: Request, response: Response, db: DbSession,
                  sirdar_refresh: Annotated[str | None, Cookie()] = None):
    if not sirdar_refresh:
        raise HTTPException(status_code=401, detail={"code": "missing_refresh"})
    try:
        result = await auth_service.refresh(db, refresh_token=sirdar_refresh,
                                            ip=client_ip(request),
                                            user_agent=request.headers.get("user-agent"))
    except AuthError as exc:
        failed = JSONResponse(status_code=_STATUS.get(exc.code, 401),
                              content={"detail": {"code": exc.code}})
        _clear_refresh_cookie(failed)
        return failed
    return await _session_out(db, result, response)


@router.post("/logout", status_code=204)
async def logout(db: DbSession, sirdar_refresh: Annotated[str | None, Cookie()] = None):
    if sirdar_refresh:
        await auth_service.logout(db, refresh_token=sirdar_refresh)
    resp = Response(status_code=204)
    _clear_refresh_cookie(resp)
    return resp


@router.get("/me", response_model=MeOut)
async def me(user: CurrentUser, db: DbSession):
    return MeOut(**await me_fields(db, user.user, user.access, user.session.expires_at))


@router.put("/me/preferences", response_model=UiPreferences)
async def save_preferences(prefs: UiPreferences, user: CurrentUser, db: DbSession):
    user.user.ui_prefs = prefs.model_dump(mode="json")
    await db.commit()
    return prefs
```

`api/routes/system.py`:
```python
from fastapi import APIRouter
from sqlalchemy import func, select

from sirdar_api.api.deps import DbSession
from sirdar_api.api.schemas import SystemStatusOut
from sirdar_api.db.models import User

router = APIRouter(tags=["system"])


@router.get("/system/status", response_model=SystemStatusOut)
async def system_status(db: DbSession):
    """Public: the shared Login reads banners from here; needs_setup tells
    the Sirdar login page to show the first-run instructions."""
    count = await db.scalar(select(func.count()).select_from(User))
    return SystemStatusOut(needs_setup=count == 0)
```

In `app.py`, replace the `# routers (later tasks add include_router lines here)` comment with:
```python
    from sirdar_api.api.routes import auth, system

    api.include_router(auth.router)
    api.include_router(system.router)
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest -q`
Expected: all pass.

If httpx doesn't send the `Path=/api/auth` cookie to `/api/auth/refresh` (cookies on `http://testserver` are non-secure in development), check that conftest sets `SIRDAR_ENV=development`.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api
git commit -m "feat(sirdar): /api/auth and /api/system/status on the portal's contract"
```

---

### Task 6: Portal policy port and the user import

**Files:**
- Create: `sirdar/api/src/sirdar_api/services/portal_policy.py`, `services/import_users.py`
- Test: `sirdar/api/tests/source_helpers.py`, `sirdar/api/tests/test_portal_policy.py`, `sirdar/api/tests/test_import_users.py`

**Interfaces:**
- Consumes:
  - `models.User`, `UserRole`, `Role`, `TotpBackupCode`, `ImportRun`
  - `auth.revoke_sessions`, `audit.audit`
  - conftest `source` fixture and `SOURCE_URL`
- Produces:
  - `portal_policy.SECURITY_DEFAULTS`, `TotpPolicy(enabled, required)`.
  - `portal_policy.totp_policy(cfg, *, account_required, in_totp_group, has_totp_role) -> TotpPolicy`.
  - `portal_policy.password_expires_at(cfg, password_hash, password_updated_at) -> datetime | None`.
  - `import_users`:
    - `ELIGIBLE_RANK = 60`, `IMPORT_DISABLE_REASONS = {"not_eligible"}`
    - `class ImportNotConfigured(Exception)`, `class ImportSourceError(Exception)` (with `.run_id`)
    - `async import_users(db, *, actor_id: uuid.UUID | None, trigger: Literal["cli", "web"], source_url: str | None = None) -> ImportRun`
    - Each row in `ImportRun.rows` is a dict: `{"person_id": str | None, "email": str, "name": str, "action": "added" | "updated" | "unchanged" | "disabled" | "skipped", "reason": str | None, "roles": list[str], "changes": list[str]}`
  - `tests/source_helpers.py`: `add_role(conn, name, rank, scope="global", totp_required=False, label=None)`, `add_portal_person(conn, *, email, first="Pat", last="Portal", roles=("admin",), password="CorrectHorse9!", **account) -> uuid.UUID`, `set_security(conn, data: dict)`.

- [ ] **Step 1: Write failing tests**

`sirdar/api/tests/source_helpers.py`:
```python
"""Write rows into the portal-shaped source test database (psycopg)."""

import json
import uuid

from sirdar_api.config import get_settings
from sirdar_api.security.passwords import hash_password


def add_role(conn, name: str, rank: int, *, scope: str = "global",
             totp_required: bool = False, label: str | None = None,
             color: str | None = None) -> None:
    conn.execute("INSERT INTO roles (name, label, rank, scope_anchor, totp_required, color) "
                 "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (name) DO NOTHING",
                 (name, label or name.replace("_", " ").title(), rank, scope, totp_required,
                  color))


def add_portal_person(conn, *, email: str, first: str = "Pat", last: str = "Portal",
                      roles: tuple[str, ...] = ("admin",), password: str = "CorrectHorse9!",
                      archived: bool = False, **account) -> uuid.UUID:
    pepper = get_settings().password_pepper.get_secret_value()
    pid = uuid.uuid4()
    conn.execute("INSERT INTO people (id, first_name, last_name, archived_at) "
                 "VALUES (%s, %s, %s, CASE WHEN %s THEN now() END)",
                 (pid, first, last, archived))
    cols = {"person_id": pid, "email": email,
            "password_hash": hash_password(password, pepper=pepper) if password else None,
            **account}
    names = ", ".join(cols)
    marks = ", ".join(["%s"] * len(cols))
    conn.execute(f"INSERT INTO user_accounts ({names}) VALUES ({marks})", tuple(cols.values()))
    for role in roles:
        conn.execute("INSERT INTO person_roles (person_id, role) VALUES (%s, %s)", (pid, role))
    return pid


def set_security(conn, data: dict) -> None:
    conn.execute("INSERT INTO system_config (section, data) VALUES ('security', %s) "
                 "ON CONFLICT (section) DO UPDATE SET data = EXCLUDED.data",
                 (json.dumps(data),))
```

`sirdar/api/tests/test_portal_policy.py`:
```python
from datetime import UTC, datetime, timedelta

from sirdar_api.services.portal_policy import password_expires_at, totp_policy


def test_totp_policy_switch_off_means_nothing():
    p = totp_policy({}, account_required=True, in_totp_group=True, has_totp_role=True)
    assert (p.enabled, p.required) == (False, False)


def test_totp_policy_required_by_any_source():
    on = {"two_factor_enabled": True}
    assert totp_policy(on, account_required=False, in_totp_group=False,
                       has_totp_role=False).required is False
    assert totp_policy({**on, "two_factor_required": True}, account_required=False,
                       in_totp_group=False, has_totp_role=False).required
    for kw in ({"account_required": True}, {"in_totp_group": True}, {"has_totp_role": True}):
        args = {"account_required": False, "in_totp_group": False, "has_totp_role": False, **kw}
        assert totp_policy(on, **args).required


def test_password_expiry():
    since = datetime(2026, 1, 1, tzinfo=UTC)
    cfg = {"password_expiry_enabled": True, "password_expiry_days": 90,
           "password_expiry_since": since.isoformat()}
    assert password_expires_at({}, "h", None) is None
    assert password_expires_at({**cfg, "password_expiry_since": None}, "h", None) is None
    assert password_expires_at(cfg, None, None) is None
    assert password_expires_at(cfg, "h", None) == since + timedelta(days=90)
    later = datetime(2026, 3, 1, tzinfo=UTC)
    assert password_expires_at(cfg, "h", later) == later + timedelta(days=90)
    earlier = datetime(2025, 6, 1, tzinfo=UTC)
    assert password_expires_at(cfg, "h", earlier) == since + timedelta(days=90)
```

`sirdar/api/tests/test_import_users.py`:
```python
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuthSession, ImportRun, Role, TotpBackupCode, User, UserRole
from sirdar_api.services import auth
from sirdar_api.services.import_users import (
    ImportNotConfigured, ImportSourceError, import_users,
)

from .factories import PASSWORD, make_user
from .source_helpers import add_portal_person, add_role, set_security


def _std_roles(conn):
    add_role(conn, "developer", 100)
    add_role(conn, "admin", 60, label="Administrator")
    add_role(conn, "staff", 40)
    add_role(conn, "client_owner", 70, scope="client")


async def _roles_of(db, pid) -> set[str]:
    return set(await db.scalars(select(UserRole.role).where(UserRole.person_id == pid)))


async def test_imports_only_eligible_people(db, source):
    _std_roles(source)
    admin = add_portal_person(source, email="admin@test.example.com", roles=("admin", "staff"))
    add_portal_person(source, email="staff@test.example.com", roles=("staff",))
    add_portal_person(source, email="owner@test.example.com", roles=("client_owner",))
    add_portal_person(source, email="nopw@test.example.com", password=None)
    add_portal_person(source, email="off@test.example.com", disabled_at=datetime.now(UTC))
    add_portal_person(source, email="gone@test.example.com", archived=True)
    revoked = add_portal_person(source, email="rev@test.example.com", roles=())
    source.execute("INSERT INTO person_roles (person_id, role, revoked_at) "
                   "VALUES (%s, 'admin', now())", (revoked,))

    run = await import_users(db, actor_id=None, trigger="cli")
    assert run.status == "ok" and run.added == 1
    users = list(await db.scalars(select(User)))
    assert [u.email for u in users] == ["admin@test.example.com"]
    assert users[0].person_id == admin and users[0].source == "portal"
    assert await _roles_of(db, admin) == {"admin"}       # only eligible roles are mirrored


async def test_imported_user_can_sign_in_with_portal_password(db, source):
    _std_roles(source)
    add_portal_person(source, email="admin@test.example.com", password="PortalPass1!")
    await import_users(db, actor_id=None, trigger="cli")
    result = await auth.login(db, email="admin@test.example.com", password="PortalPass1!")
    assert result.user.email == "admin@test.example.com"


async def test_rerun_is_idempotent_and_updates(db, source):
    _std_roles(source)
    pid = add_portal_person(source, email="admin@test.example.com", first="Pat")
    await import_users(db, actor_id=None, trigger="cli")
    run2 = await import_users(db, actor_id=None, trigger="cli")
    assert (run2.added, run2.updated, run2.unchanged) == (0, 0, 1)
    source.execute("UPDATE people SET first_name = 'Patricia' WHERE id = %s", (pid,))
    run3 = await import_users(db, actor_id=None, trigger="cli")
    assert run3.updated == 1
    row = next(r for r in run3.rows if r["action"] == "updated")
    assert "first_name" in row["changes"]


async def test_demoted_user_is_disabled_and_sessions_revoked(db, source):
    _std_roles(source)
    pid = add_portal_person(source, email="admin@test.example.com", password=PASSWORD)
    await import_users(db, actor_id=None, trigger="cli")
    await auth.login(db, email="admin@test.example.com", password=PASSWORD)
    source.execute("UPDATE person_roles SET revoked_at = now() WHERE person_id = %s", (pid,))
    run = await import_users(db, actor_id=None, trigger="cli")
    assert run.disabled == 1
    user = await db.get(User, pid)
    await db.refresh(user)
    assert user.disabled_at is not None and user.disabled_reason == "not_eligible"
    live = list(await db.scalars(select(AuthSession).where(AuthSession.revoked_at.is_(None))))
    assert live == []
    # re-promoted: re-enabled
    source.execute("INSERT INTO person_roles (person_id, role) VALUES (%s, 'admin')", (pid,))
    run = await import_users(db, actor_id=None, trigger="cli")
    await db.refresh(user)
    assert user.disabled_at is None and run.updated == 1


async def test_local_users_untouched_and_email_collision_skipped(db, source):
    _std_roles(source)
    local = await make_user(db, email="admin@test.example.com", source="local",
                            roles=("developer",))
    add_portal_person(source, email="admin@test.example.com")
    run = await import_users(db, actor_id=None, trigger="cli")
    assert run.skipped == 1 and run.rows[0]["reason"] == "email_collision_local"
    await db.refresh(local)
    assert local.source == "local" and local.disabled_at is None


async def test_totp_policy_and_backup_codes_copied(db, source):
    _std_roles(source)
    set_security(source, {"two_factor_enabled": True})
    source.execute("UPDATE roles SET totp_required = true WHERE name = 'staff'")
    pid = add_portal_person(source, email="admin@test.example.com", roles=("admin", "staff"),
                            totp_secret_enc=b"seed-blob", totp_confirmed_at=datetime.now(UTC),
                            totp_last_counter=5)
    source.execute("INSERT INTO totp_backup_codes (person_id, code_hash) VALUES (%s, 'h1'), "
                   "(%s, 'h2')", (pid, pid))
    await import_users(db, actor_id=None, trigger="cli")
    user = await db.get(User, pid)
    assert user.totp_enabled and user.totp_required      # required via the staff role
    assert user.totp_secret_enc == b"seed-blob" and user.totp_last_counter == 5
    codes = list(await db.scalars(select(TotpBackupCode.code_hash)
                                  .where(TotpBackupCode.person_id == pid)))
    assert sorted(codes) == ["h1", "h2"]
    # a code used in Sirdar stays used; a higher Sirdar counter is kept
    code = await db.scalar(select(TotpBackupCode).where(TotpBackupCode.code_hash == "h1"))
    code.used_at = datetime.now(UTC)
    user.totp_last_counter = 99
    await db.commit()
    await import_users(db, actor_id=None, trigger="cli")
    await db.refresh(user)
    assert user.totp_last_counter == 99
    used = await db.scalar(select(TotpBackupCode.used_at).where(TotpBackupCode.code_hash == "h1"))
    assert used is not None


async def test_new_eligible_portal_role_is_added_without_permissions(db, source):
    _std_roles(source)
    add_role(source, "ops_chief", 70, label="Ops chief")
    add_portal_person(source, email="ops@test.example.com", roles=("ops_chief",))
    await import_users(db, actor_id=None, trigger="cli")
    role = await db.get(Role, "ops_chief")
    assert role is not None and role.rank == 70 and role.label == "Ops chief"


async def test_unreachable_source_records_failed_run_and_changes_nothing(db):
    with pytest.raises(ImportSourceError) as exc:
        await import_users(db, actor_id=None, trigger="web",
                           source_url="postgresql+asyncpg://nobody:x@127.0.0.1:1/nope")
    run = await db.get(ImportRun, exc.value.run_id)
    assert run.status == "failed" and run.error
    assert list(await db.scalars(select(User))) == []



async def test_not_configured(db, monkeypatch):
    from sirdar_api.config import Settings, get_settings
    monkeypatch.delenv("SIRDAR_SOURCE_DATABASE_URL")
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    get_settings.cache_clear()
    try:
        with pytest.raises(ImportNotConfigured):
            await import_users(db, actor_id=None, trigger="cli")
    finally:
        get_settings.cache_clear()
```

`monkeypatch.setitem(Settings.model_config, "env_file", None)` stops a developer's `sirdar/.env` from supplying the source URL that the test just removed from the environment.

- [ ] **Step 2: Run to fail**

Run: `.venv/bin/pytest -q tests/test_portal_policy.py tests/test_import_users.py`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`services/portal_policy.py`:
```python
"""Ports of two portal rules the import evaluates once per person:
the 2FA policy (serversherpa/services/totp.py policy_for) and password
expiry (serversherpa/services/password_policy.py expires_at).
test_portal_compat.py pins the portal lines these mirror."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

SECURITY_DEFAULTS: dict = {
    "two_factor_enabled": False,
    "two_factor_required": False,
    "password_expiry_enabled": False,
    "password_expiry_days": 90,
    "password_expiry_since": None,
}


@dataclass(frozen=True)
class TotpPolicy:
    enabled: bool    # site master switch
    required: bool   # this account must use 2FA (implies enabled)


def totp_policy(cfg: dict, *, account_required: bool, in_totp_group: bool,
                has_totp_role: bool) -> TotpPolicy:
    if not cfg.get("two_factor_enabled"):
        return TotpPolicy(enabled=False, required=False)
    required = bool(cfg.get("two_factor_required") or account_required
                    or in_totp_group or has_totp_role)
    return TotpPolicy(enabled=True, required=required)


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def password_expires_at(cfg: dict, password_hash: str | None,
                        password_updated_at: datetime | None) -> datetime | None:
    if not cfg.get("password_expiry_enabled"):
        return None
    raw = cfg.get("password_expiry_since")
    since = _aware(datetime.fromisoformat(raw)) if raw else None
    if since is None or password_hash is None:
        return None
    changed = _aware(password_updated_at)
    start = since if changed is None else max(changed, since)
    return start + timedelta(days=int(cfg.get("password_expiry_days", 90)))
```

`services/import_users.py`:
```python
"""Copy portal users (an active global role with rank >= 60) into Sirdar.

The portal owns identity: every run overwrites the identity fields of the
people it copies, disables the ones who stopped qualifying (sessions
revoked, never deleted), and never touches local users or Sirdar-only
data (overrides, sessions, audit, lockout counters). The source is read
in a READ ONLY transaction; Sirdar's writes are one transaction, so a
failure leaves everything as it was. This is where scheduled sync will
plug in later."""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from sirdar_api.config import get_settings
from sirdar_api.db.models import ImportRun, Role, TotpBackupCode, User, UserRole
from sirdar_api.services.audit import audit
from sirdar_api.services.auth import revoke_sessions
from sirdar_api.services.portal_policy import (
    SECURITY_DEFAULTS, password_expires_at, totp_policy,
)

ELIGIBLE_RANK = 60
IMPORT_DISABLE_REASONS = {"not_eligible"}


class ImportNotConfigured(Exception):
    """SIRDAR_SOURCE_DATABASE_URL is not set."""


class ImportSourceError(Exception):
    def __init__(self, message: str, run_id: uuid.UUID):
        super().__init__(message)
        self.run_id = run_id


@dataclass
class _Account:
    person_id: uuid.UUID
    email: str
    first_name: str
    last_name: str
    preferred_name: str | None
    job_title: str | None
    password_hash: str | None
    must_change_password: bool
    password_updated_at: datetime | None
    totp_secret_enc: bytes | None
    totp_confirmed_at: datetime | None
    totp_last_counter: int | None
    totp_required: bool
    disabled_at: datetime | None
    archived_at: datetime | None


@dataclass
class _Role:
    name: str
    label: str
    rank: int
    color: str | None
    scope_anchor: str
    totp_required: bool


@dataclass
class _Snapshot:
    accounts: list[_Account]
    roles: dict[str, _Role]
    grants: dict[uuid.UUID, set[str]] = field(default_factory=dict)
    totp_group_members: set[uuid.UUID] = field(default_factory=set)
    backup_codes: dict[uuid.UUID, list[tuple[str, datetime | None]]] = field(
        default_factory=dict)
    security: dict = field(default_factory=dict)


async def _read_source(url: str) -> _Snapshot:
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SET TRANSACTION READ ONLY"))
            accounts = [_Account(**dict(r)) for r in (await conn.execute(text("""
                SELECT ua.person_id, ua.email::text AS email, p.first_name, p.last_name,
                       p.preferred_name, p.job_title, ua.password_hash,
                       ua.must_change_password, ua.password_updated_at, ua.totp_secret_enc,
                       ua.totp_confirmed_at, ua.totp_last_counter, ua.totp_required,
                       ua.disabled_at, p.archived_at
                FROM user_accounts ua JOIN people p ON p.id = ua.person_id
            """))).mappings()]
            roles = {r["name"]: _Role(name=r["name"], label=r["label"] or r["name"],
                                      rank=r["rank"], color=r["color"],
                                      scope_anchor=r["scope_anchor"],
                                      totp_required=r["totp_required"])
                     for r in (await conn.execute(text(
                         "SELECT name, label, rank, color, scope_anchor, totp_required "
                         "FROM roles"))).mappings()}
            snap = _Snapshot(accounts=accounts, roles=roles)
            for pid, role in (await conn.execute(text(
                    "SELECT person_id, role FROM person_roles WHERE revoked_at IS NULL"))).all():
                snap.grants.setdefault(pid, set()).add(role)
            snap.totp_group_members = set((await conn.execute(text(
                "SELECT agm.person_id FROM access_group_members agm "
                "JOIN access_groups ag ON ag.id = agm.group_id "
                "WHERE ag.totp_required"))).scalars())
            for pid, code_hash, used_at in (await conn.execute(text(
                    "SELECT person_id, code_hash, used_at FROM totp_backup_codes"))).all():
                snap.backup_codes.setdefault(pid, []).append((code_hash, used_at))
            row = (await conn.execute(text(
                "SELECT data FROM system_config WHERE section = 'security'"))).first()
            snap.security = {**SECURITY_DEFAULTS, **(row[0] if row else {})}
            return snap
    finally:
        await engine.dispose()


def _eligible_roles(snap: _Snapshot, person_id: uuid.UUID) -> list[str]:
    return sorted(r for r in snap.grants.get(person_id, set())
                  if r in snap.roles and snap.roles[r].scope_anchor == "global"
                  and snap.roles[r].rank >= ELIGIBLE_RANK)


def _identity_fields(acct: _Account, snap: _Snapshot) -> dict:
    policy = totp_policy(
        snap.security, account_required=acct.totp_required,
        in_totp_group=acct.person_id in snap.totp_group_members,
        has_totp_role=any(snap.roles[r].totp_required
                          for r in snap.grants.get(acct.person_id, set()) if r in snap.roles))
    return {
        "email": acct.email, "first_name": acct.first_name, "last_name": acct.last_name,
        "preferred_name": acct.preferred_name, "job_title": acct.job_title,
        "password_hash": acct.password_hash,
        "must_change_password": acct.must_change_password,
        "password_updated_at": acct.password_updated_at,
        "password_expires_at": password_expires_at(
            snap.security, acct.password_hash, acct.password_updated_at),
        "totp_secret_enc": acct.totp_secret_enc,
        "totp_confirmed_at": acct.totp_confirmed_at,
        "totp_enabled": policy.enabled, "totp_required": policy.required,
    }


def _row(acct_or_user, action: str, *, reason: str | None = None,
         roles: list[str] | None = None, changes: list[str] | None = None) -> dict:
    pid = acct_or_user.person_id
    name = f"{acct_or_user.preferred_name or acct_or_user.first_name} {acct_or_user.last_name}"
    return {"person_id": str(pid) if pid else None, "email": acct_or_user.email,
            "name": name, "action": action, "reason": reason, "roles": roles or [],
            "changes": changes or []}


async def _sync_roles(db: AsyncSession, snap: _Snapshot) -> None:
    for r in snap.roles.values():
        if r.scope_anchor != "global" or r.rank < ELIGIBLE_RANK:
            continue
        role = await db.get(Role, r.name)
        if role is None:
            db.add(Role(name=r.name, label=r.label, rank=r.rank, color=r.color))
        else:
            role.label, role.rank, role.color = r.label, r.rank, r.color
    await db.flush()


async def _replace_roles(db: AsyncSession, person_id: uuid.UUID, roles: list[str]) -> bool:
    current = set(await db.scalars(select(UserRole.role).where(UserRole.person_id == person_id)))
    if current == set(roles):
        return False
    await db.execute(delete(UserRole).where(UserRole.person_id == person_id))
    for role in roles:
        db.add(UserRole(person_id=person_id, role=role))
    return True


async def _replace_backup_codes(db: AsyncSession, person_id: uuid.UUID,
                                source_codes: list[tuple[str, datetime | None]]) -> bool:
    current = {h: used for h, used in (await db.execute(
        select(TotpBackupCode.code_hash, TotpBackupCode.used_at)
        .where(TotpBackupCode.person_id == person_id))).all()}
    # a code used in Sirdar stays used even if the portal has not seen it used
    desired = {h: used or current.get(h) for h, used in source_codes}
    if desired == current:
        return False
    await db.execute(delete(TotpBackupCode).where(TotpBackupCode.person_id == person_id))
    for h, used in desired.items():
        db.add(TotpBackupCode(person_id=person_id, code_hash=h, used_at=used))
    return True


async def _apply(db: AsyncSession, snap: _Snapshot, now: datetime) -> list[dict]:
    await _sync_roles(db, snap)
    existing = {u.person_id: u for u in await db.scalars(select(User))}
    by_email = {u.email.lower(): u for u in existing.values()}
    rows: list[dict] = []
    seen: set[uuid.UUID] = set()

    for acct in sorted(snap.accounts, key=lambda a: a.email.lower()):
        roles = _eligible_roles(snap, acct.person_id)
        if (not roles or acct.password_hash is None or acct.disabled_at is not None
                or acct.archived_at is not None):
            continue
        holder = by_email.get(acct.email.lower())
        if holder is not None and holder.person_id != acct.person_id:
            reason = "email_collision_local" if holder.source == "local" else "email_collision"
            rows.append(_row(acct, "skipped", reason=reason, roles=roles))
            continue
        user = existing.get(acct.person_id)
        if user is not None and user.source == "local":
            rows.append(_row(acct, "skipped", reason="person_is_local", roles=roles))
            continue
        seen.add(acct.person_id)
        fields = _identity_fields(acct, snap)

        if user is None:
            user = User(person_id=acct.person_id, source="portal",
                        totp_last_counter=acct.totp_last_counter, last_imported_at=now, **fields)
            db.add(user)
            await db.flush()
            await _replace_roles(db, user.person_id, roles)
            await _replace_backup_codes(db, user.person_id,
                                        snap.backup_codes.get(acct.person_id, []))
            rows.append(_row(acct, "added", roles=roles))
            continue

        changes = [k for k, v in fields.items() if getattr(user, k) != v]
        for k in changes:
            setattr(user, k, fields[k])
        counters = [c for c in (user.totp_last_counter, acct.totp_last_counter) if c is not None]
        best = max(counters) if counters else None
        if best != user.totp_last_counter:
            user.totp_last_counter = best
            changes.append("totp_last_counter")
        if user.disabled_at is not None and user.disabled_reason in IMPORT_DISABLE_REASONS:
            user.disabled_at = None
            user.disabled_reason = None
            changes.append("enabled")
        if await _replace_roles(db, user.person_id, roles):
            changes.append("roles")
        if await _replace_backup_codes(db, user.person_id,
                                       snap.backup_codes.get(acct.person_id, [])):
            changes.append("backup_codes")
        user.last_imported_at = now
        if changes:
            user.updated_at = now
            rows.append(_row(acct, "updated", roles=roles, changes=changes))
        else:
            rows.append(_row(acct, "unchanged", roles=roles))

    for user in existing.values():
        if user.source != "portal" or user.person_id in seen or user.disabled_at is not None:
            continue
        user.disabled_at = now
        user.disabled_reason = "not_eligible"
        user.updated_at = now
        await revoke_sessions(db, user.person_id, reason="import_disabled")
        rows.append(_row(user, "disabled", reason="not_eligible"))
    return rows


def _describe(exc: Exception) -> str:
    return f"{type(exc).__name__}: {str(exc)[:300]}"


async def import_users(db: AsyncSession, *, actor_id: uuid.UUID | None,
                       trigger: Literal["cli", "web"],
                       source_url: str | None = None) -> ImportRun:
    settings = get_settings()
    url = source_url or (settings.source_database_url.get_secret_value()
                         if settings.source_database_url else None)
    if not url:
        raise ImportNotConfigured()

    run = ImportRun(actor_id=actor_id, trigger=trigger, status="running")
    db.add(run)
    await db.commit()
    run_id = run.id

    try:
        snap = await _read_source(url)
    except Exception as exc:  # noqa: BLE001 — any source failure is reported, not raised raw
        run.status, run.error, run.finished_at = "failed", _describe(exc), datetime.now(UTC)
        audit(db, actor_id=actor_id, action="users.import_failed", entity_type="import_run",
              entity_id=str(run_id), changes={"error": run.error})
        await db.commit()
        raise ImportSourceError(run.error, run_id) from exc

    now = datetime.now(UTC)
    try:
        rows = await _apply(db, snap, now)
        counts = {k: sum(1 for r in rows if r["action"] == k)
                  for k in ("added", "updated", "unchanged", "disabled", "skipped")}
        run.rows = rows
        run.status = "ok"
        run.finished_at = datetime.now(UTC)
        for k, v in counts.items():
            setattr(run, k, v)
        audit(db, actor_id=actor_id, action="users.import", entity_type="import_run",
              entity_id=str(run_id), changes=counts)
        await db.commit()
    except Exception as exc:
        await db.rollback()
        failed = await db.get(ImportRun, run_id)
        failed.status, failed.error = "failed", _describe(exc)
        failed.finished_at = datetime.now(UTC)
        await db.commit()
        raise
    return run
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest -q`
Expected: all pass.

If `test_unreachable_source…` hangs, asyncpg's connect timeout defaults to 60 s. Pass `connect_args={"timeout": 10}` to `create_async_engine` in `_read_source`.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api
git commit -m "feat(sirdar): import portal users (rank >= 60) with 2FA/expiry policy, disable on demotion"
```

---

### Task 7: CLI (import-users, create-admin, reset-password)

**Files:**
- Create: `sirdar/api/src/sirdar_api/services/local_users.py`, `sirdar/api/src/sirdar_api/cli.py`
- Test: `sirdar/api/tests/test_cli.py`

**Interfaces:**
- Consumes: Task 6 `import_users`, `ImportNotConfigured`, `ImportSourceError`; `hash_password`; `dispose_engine`.
- Produces:
  - `local_users.MIN_PASSWORD_LENGTH = 12`.
  - `local_users.LocalUserError(code)`, with codes `email_taken`, `unknown_role`, `password_too_short`, `not_found`, `not_local`.
  - `local_users.async create_local_admin(db, *, email, first_name, last_name, role, password) -> User`.
  - `local_users.async reset_local_password(db, *, email, password) -> User`.
  - The Typer `app` (console script `sirdar`), with commands `import-users`, `create-admin`, `reset-password`.

- [ ] **Step 1: Write failing tests**

`sirdar/api/tests/test_cli.py`:
```python
import psycopg
from typer.testing import CliRunner

from sirdar_api.cli import app

from .conftest import _psycopg_url, TEST_DB
from .source_helpers import add_portal_person, add_role

runner = CliRunner()


def _scalar(sql: str, *args):
    with psycopg.connect(_psycopg_url(TEST_DB)) as conn:
        return conn.execute(sql, args).fetchone()[0]


def test_create_admin_and_login_ready():
    result = runner.invoke(app, ["create-admin", "--email", "root@test.example.com",
                                 "--first-name", "Root", "--last-name", "Admin"],
                           input="LongEnoughPass1\nLongEnoughPass1\n")
    assert result.exit_code == 0, result.output
    assert "Created local developer root@test.example.com" in result.output
    assert _scalar("SELECT source FROM users WHERE email = %s", "root@test.example.com") == "local"
    assert _scalar("SELECT role FROM user_roles") == "developer"


def test_create_admin_rejects_short_password_and_unknown_role():
    short = runner.invoke(app, ["create-admin", "--email", "a@test.example.com",
                                "--first-name", "A", "--last-name", "B"],
                          input="short\nshort\n")
    assert short.exit_code == 1 and "at least 12" in short.output
    bad = runner.invoke(app, ["create-admin", "--email", "a@test.example.com",
                              "--first-name", "A", "--last-name", "B", "--role", "staff"],
                        input="LongEnoughPass1\nLongEnoughPass1\n")
    assert bad.exit_code == 1 and "Unknown role" in bad.output


def test_reset_password_local_only():
    runner.invoke(app, ["create-admin", "--email", "root@test.example.com",
                        "--first-name", "Root", "--last-name", "Admin"],
                  input="LongEnoughPass1\nLongEnoughPass1\n")
    ok = runner.invoke(app, ["reset-password", "--email", "root@test.example.com"],
                       input="AnotherLongPass2\nAnotherLongPass2\n")
    assert ok.exit_code == 0, ok.output
    missing = runner.invoke(app, ["reset-password", "--email", "nobody@test.example.com"],
                            input="AnotherLongPass2\nAnotherLongPass2\n")
    assert missing.exit_code == 1 and "No user" in missing.output


def test_import_users_prints_summary(source):
    add_role(source, "admin", 60)
    add_portal_person(source, email="admin@test.example.com")
    result = runner.invoke(app, ["import-users"])
    assert result.exit_code == 0, result.output
    assert "added 1" in result.output
    assert "admin@test.example.com" in result.output
```

- [ ] **Step 2: Run to fail**

Run: `.venv/bin/pytest -q tests/test_cli.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'sirdar_api.cli'`.

- [ ] **Step 3: Implement**

`services/local_users.py`:
```python
"""Sirdar-only (source = local) break-glass accounts. The import never
reads or changes them. No 2FA in v1."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import get_settings
from sirdar_api.db.models import Role, User, UserRole
from sirdar_api.security.passwords import hash_password
from sirdar_api.services.audit import audit

MIN_PASSWORD_LENGTH = 12


class LocalUserError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _hash(password: str) -> str:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise LocalUserError("password_too_short")
    return hash_password(password, pepper=get_settings().password_pepper.get_secret_value())


async def create_local_admin(db: AsyncSession, *, email: str, first_name: str, last_name: str,
                             role: str, password: str) -> User:
    if await db.get(Role, role) is None:
        raise LocalUserError("unknown_role")
    if await db.scalar(select(User).where(User.email == email)) is not None:
        raise LocalUserError("email_taken")
    now = datetime.now(UTC)
    user = User(person_id=uuid.uuid4(), source="local", email=email, first_name=first_name,
                last_name=last_name, password_hash=_hash(password), password_updated_at=now)
    db.add(user)
    await db.flush()
    db.add(UserRole(person_id=user.person_id, role=role))
    audit(db, actor_id=None, action="user.create_local", entity_type="user",
          entity_id=str(user.person_id), changes={"email": email, "role": role})
    await db.commit()
    return user


async def reset_local_password(db: AsyncSession, *, email: str, password: str) -> User:
    user = await db.scalar(select(User).where(User.email == email))
    if user is None:
        raise LocalUserError("not_found")
    if user.source != "local":
        raise LocalUserError("not_local")
    user.password_hash = _hash(password)
    now = datetime.now(UTC)
    user.password_updated_at = now
    user.failed_login_count = 0
    user.locked_until = None
    user.updated_at = now
    audit(db, actor_id=None, action="user.reset_local_password", entity_type="user",
          entity_id=str(user.person_id))
    await db.commit()
    return user
```

`cli.py`:
```python
"""`sirdar` command line. Each command opens its own event loop and
disposes the engine before exiting."""

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

import typer

from sirdar_api.db.engine import dispose_engine, get_sessionmaker
from sirdar_api.services.import_users import ImportNotConfigured, ImportSourceError, import_users
from sirdar_api.services.local_users import (
    MIN_PASSWORD_LENGTH, LocalUserError, create_local_admin, reset_local_password,
)

app = typer.Typer(help="Sirdar — manage ServerSherpa environments.", no_args_is_help=True)
T = TypeVar("T")

_MESSAGES = {
    "password_too_short": f"Password must be at least {MIN_PASSWORD_LENGTH} characters.",
    "unknown_role": "Unknown role. Use one of the roles on the Roles & access page.",
    "email_taken": "A user with that email already exists.",
    "not_found": "No user with that email.",
    "not_local": "That user comes from the portal — change the password there, then re-import.",
}


def _run(fn: Callable[..., Awaitable[T]]) -> T:
    async def main() -> T:
        try:
            async with get_sessionmaker()() as db:
                return await fn(db)
        finally:
            await dispose_engine()
    return asyncio.run(main())


@app.command("import-users")
def import_users_cmd() -> None:
    """Copy portal users with an admin-or-higher role into Sirdar."""
    try:
        run = _run(lambda db: import_users(db, actor_id=None, trigger="cli"))
    except ImportNotConfigured:
        typer.echo("SIRDAR_SOURCE_DATABASE_URL is not set — nothing to import from.")
        raise typer.Exit(1) from None
    except ImportSourceError as exc:
        typer.echo(f"Import failed: {exc}")
        raise typer.Exit(1) from None
    typer.echo(f"Import finished: added {run.added}, updated {run.updated}, "
               f"unchanged {run.unchanged}, disabled {run.disabled}, skipped {run.skipped}")
    for row in run.rows:
        if row["action"] != "unchanged":
            detail = row["reason"] or ", ".join(row["changes"]) or ", ".join(row["roles"])
            typer.echo(f"  {row['action']:<9} {row['email']}  {detail}")


@app.command("create-admin")
def create_admin_cmd(
    email: str = typer.Option(...),
    first_name: str = typer.Option(...),
    last_name: str = typer.Option(...),
    role: str = typer.Option("developer"),
) -> None:
    """Create a Sirdar-only (local) user — break-glass access for a fresh install."""
    password = typer.prompt("Password", hide_input=True, confirmation_prompt=True)
    try:
        user = _run(lambda db: create_local_admin(db, email=email, first_name=first_name,
                                                  last_name=last_name, role=role,
                                                  password=password))
    except LocalUserError as exc:
        typer.echo(_MESSAGES[exc.code])
        raise typer.Exit(1) from None
    typer.echo(f"Created local {role} {user.email}")


@app.command("reset-password")
def reset_password_cmd(email: str = typer.Option(...)) -> None:
    """Set a new password for a local user."""
    password = typer.prompt("New password", hide_input=True, confirmation_prompt=True)
    try:
        user = _run(lambda db: reset_local_password(db, email=email, password=password))
    except LocalUserError as exc:
        typer.echo(_MESSAGES[exc.code])
        raise typer.Exit(1) from None
    typer.echo(f"Password updated for {user.email}")
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest -q`
Expected: all pass.

If a sync CLI test errors with "attached to a different loop", the autouse async fixture's engine leaked. The CLI's `_run` disposes the engine, and `clean_db` disposes it after the test. Check that `dispose_engine` resets both globals.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api
git commit -m "feat(sirdar): sirdar CLI — import-users, create-admin, reset-password"
```

---

### Task 8: Users admin API (list, detail, import, sessions)

**Files:**
- Create: `sirdar/api/src/sirdar_api/api/routes/users.py`
- Modify: `sirdar/api/src/sirdar_api/api/app.py` (include `users.router`)
- Test: `sirdar/api/tests/test_users_api.py`, plus a helper `tests/api_helpers.py`

**Interfaces:**
- Consumes:
  - `require_permission`, `CurrentUser`, `DbSession`
  - `resolve_access`, `can_touch_rank`
  - `import_users`, `ImportNotConfigured`, `ImportSourceError`
  - `revoke_sessions`, `audit`, `EffectiveCellOut`
- Produces (all under `/api/users`; the import routes MUST be declared before `/{person_id}`):

  | Method and path | Permission | Returns or errors |
  |---|---|---|
  | `GET ""` | users:view | `list[UserRowOut]` |
  | `GET /import/source` | users:view | `{"configured": bool}` |
  | `GET /import/runs` | users:view | `list[ImportRunOut]`, newest 20, `rows: []` |
  | `GET /import/runs/{run_id}` | users:view | `ImportRunOut` with rows |
  | `POST /import` | users:add | `ImportRunOut` with rows. 409 `source_not_configured`; 502 `{"code": "source_unavailable", "run_id"}` |
  | `GET /{person_id}` | users:view | `UserDetailOut` |
  | `POST /{person_id}/sessions/revoke` | users:change | `{"revoked": int}`. 404 `person_not_found`; 403 `rank_too_low` unless the target is self or `can_touch_rank` holds |

  Models:
  - `UserRowOut`: `person_id`, `display_name`, `email`, `source`, `roles: list[str]`, `max_rank`, `totp_enrolled`, `totp_required`, `last_login_at`, `disabled_at`, `disabled_reason`, `last_imported_at`
  - `ImportRowOut`: `person_id | None`, `email`, `name`, `action`, `reason`, `roles`, `changes`
  - `ImportRunOut`: `id`, `started_at`, `finished_at`, `trigger`, `status`, `error`, `actor_name`, `added`, `updated`, `unchanged`, `disabled`, `skipped`, `rows`
  - `SessionRowOut`: `id`, `family_id`, `created_at`, `expires_at`, `ip_address`, `user_agent`
  - `UserDetailOut`: `user: UserRowOut`, `first_name`, `last_name`, `preferred_name`, `job_title`, `cells: dict[str, dict[str, EffectiveCellOut]]`, `overrides: dict[str, dict[str, bool]]`, `sessions: list[SessionRowOut]`, `can_manage: bool`
  - `tests/api_helpers.py`: `async auth_headers(client, db, *, email, roles) -> dict` (creates the user, logs in, returns `{"Authorization": "Bearer …"}`).

- [ ] **Step 1: Write failing tests**

`sirdar/api/tests/api_helpers.py`:
```python
from .factories import PASSWORD, make_user


async def auth_headers(client, db, *, email: str = "boss@test.example.com",
                       roles: tuple[str, ...] = ("developer",)) -> dict:
    await make_user(db, email=email, roles=roles, first_name="Boss", last_name="User")
    resp = await client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}
```

`sirdar/api/tests/test_users_api.py`:
```python
from .api_helpers import auth_headers
from .factories import PASSWORD, make_user
from .source_helpers import add_portal_person, add_role


async def test_list_and_detail(client, db):
    h = await auth_headers(client, db)
    other = await make_user(db, email="admin@test.example.com", roles=("admin",))
    rows = (await client.get("/api/users", headers=h)).json()
    assert {r["email"] for r in rows} == {"boss@test.example.com", "admin@test.example.com"}
    detail = (await client.get(f"/api/users/{other.person_id}", headers=h)).json()
    assert detail["user"]["roles"] == ["admin"]
    assert detail["cells"]["users"]["view"] == {"value": True, "source": "role"}
    assert detail["cells"]["devtools"]["view"]["source"] == "hard_gate"
    assert detail["can_manage"] is True


async def test_admin_cannot_import(client, db):
    h = await auth_headers(client, db, roles=("admin",))
    resp = await client.post("/api/users/import", headers=h)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"


async def test_import_endpoint_and_runs(client, db, source):
    h = await auth_headers(client, db)
    add_role(source, "admin", 60)
    add_portal_person(source, email="pat@test.example.com")
    assert (await client.get("/api/users/import/source", headers=h)).json() == {
        "configured": True}
    run = (await client.post("/api/users/import", headers=h)).json()
    assert run["status"] == "ok" and run["added"] == 1
    assert run["rows"][0]["email"] == "pat@test.example.com"
    assert run["actor_name"] == "Boss User"
    runs = (await client.get("/api/users/import/runs", headers=h)).json()
    assert runs[0]["id"] == run["id"] and runs[0]["rows"] == []
    one = (await client.get(f"/api/users/import/runs/{run['id']}", headers=h)).json()
    assert len(one["rows"]) == 1


async def test_revoke_sessions_respects_rank(client, db):
    h_admin = await auth_headers(client, db, email="a@test.example.com", roles=("super_admin",))
    dev = await make_user(db, email="dev@test.example.com", roles=("developer",))
    await client.post("/api/auth/login", json={"email": dev.email, "password": PASSWORD})
    # super_admin (80) may change users but not a developer (100)
    resp = await client.post(f"/api/users/{dev.person_id}/sessions/revoke", headers=h_admin)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "rank_too_low"
    h_dev = await auth_headers(client, db, email="root@test.example.com", roles=("developer",))
    ok = await client.post(f"/api/users/{dev.person_id}/sessions/revoke", headers=h_dev)
    assert ok.status_code == 200 and ok.json()["revoked"] == 1


async def test_unknown_person(client, db):
    h = await auth_headers(client, db)
    resp = await client.get("/api/users/00000000-0000-0000-0000-000000000000", headers=h)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "person_not_found"
```

- [ ] **Step 2: Run to fail**

Run: `.venv/bin/pytest -q tests/test_users_api.py`
Expected: FAIL (404s).

- [ ] **Step 3: Implement `api/routes/users.py`**

```python
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resolver import AccessInfo, can_touch_rank, resolve_access
from sirdar_api.api.deps import AuthContext, DbSession, require_permission
from sirdar_api.api.schemas import EffectiveCellOut
from sirdar_api.config import get_settings
from sirdar_api.db.models import (
    AuthSession, ImportRun, PermissionOverride, Role, TotpBackupCode, User, UserRole,
)
from sirdar_api.services.audit import audit
from sirdar_api.services.auth import revoke_sessions
from sirdar_api.services.import_users import (
    ImportNotConfigured, ImportSourceError, import_users,
)

router = APIRouter(prefix="/users", tags=["users"])


class UserRowOut(BaseModel):
    person_id: uuid.UUID
    display_name: str
    email: str
    source: Literal["portal", "local"]
    roles: list[str]
    max_rank: int
    totp_enrolled: bool
    totp_required: bool
    last_login_at: datetime | None
    disabled_at: datetime | None
    disabled_reason: str | None
    last_imported_at: datetime | None


class ImportRowOut(BaseModel):
    person_id: uuid.UUID | None
    email: str
    name: str
    action: Literal["added", "updated", "unchanged", "disabled", "skipped"]
    reason: str | None = None
    roles: list[str] = []
    changes: list[str] = []


class ImportRunOut(BaseModel):
    id: uuid.UUID
    started_at: datetime
    finished_at: datetime | None
    trigger: str
    status: str
    error: str | None
    actor_name: str | None
    added: int
    updated: int
    unchanged: int
    disabled: int
    skipped: int
    rows: list[ImportRowOut] = []


class SessionRowOut(BaseModel):
    id: uuid.UUID
    family_id: uuid.UUID
    created_at: datetime
    expires_at: datetime
    ip_address: str | None
    user_agent: str | None


class UserDetailOut(BaseModel):
    user: UserRowOut
    first_name: str
    last_name: str
    preferred_name: str | None
    job_title: str | None
    cells: dict[str, dict[str, EffectiveCellOut]]
    overrides: dict[str, dict[str, bool]]
    sessions: list[SessionRowOut]
    can_manage: bool


async def _roles_by_person(db: AsyncSession) -> tuple[dict[uuid.UUID, list[str]], dict[str, int]]:
    ranks = {name: rank for name, rank in (await db.execute(select(Role.name, Role.rank))).all()}
    roles: dict[uuid.UUID, list[str]] = {}
    for pid, role in (await db.execute(select(UserRole.person_id, UserRole.role))).all():
        roles.setdefault(pid, []).append(role)
    return roles, ranks


def _row(user: User, roles: list[str], ranks: dict[str, int]) -> UserRowOut:
    return UserRowOut(
        person_id=user.person_id, display_name=user.display_name, email=user.email,
        source=user.source, roles=sorted(roles),
        max_rank=max((ranks.get(r, 0) for r in roles), default=0),
        totp_enrolled=user.totp_confirmed_at is not None, totp_required=user.totp_required,
        last_login_at=user.last_login_at, disabled_at=user.disabled_at,
        disabled_reason=user.disabled_reason, last_imported_at=user.last_imported_at)


async def _run_out(db: AsyncSession, run: ImportRun, *, with_rows: bool) -> ImportRunOut:
    actor = await db.get(User, run.actor_id) if run.actor_id else None
    return ImportRunOut(
        id=run.id, started_at=run.started_at, finished_at=run.finished_at, trigger=run.trigger,
        status=run.status, error=run.error,
        actor_name=actor.display_name if actor else None,
        added=run.added, updated=run.updated, unchanged=run.unchanged, disabled=run.disabled,
        skipped=run.skipped,
        rows=[ImportRowOut(**r) for r in run.rows] if with_rows else [])


@router.get("", response_model=list[UserRowOut])
async def list_users(db: DbSession, actor: AuthContext = require_permission("users", "view")):
    roles, ranks = await _roles_by_person(db)
    users = await db.scalars(select(User).order_by(User.last_name, User.first_name))
    return [_row(u, roles.get(u.person_id, []), ranks) for u in users]


# ── import (declared before /{person_id} so "import" never parses as an id) ──

@router.get("/import/source")
async def import_source(db: DbSession, actor: AuthContext = require_permission("users", "view")):
    return {"configured": get_settings().source_database_url is not None}


@router.get("/import/runs", response_model=list[ImportRunOut])
async def import_runs(db: DbSession, actor: AuthContext = require_permission("users", "view")):
    runs = await db.scalars(select(ImportRun).order_by(ImportRun.started_at.desc()).limit(20))
    return [await _run_out(db, r, with_rows=False) for r in runs]


@router.get("/import/runs/{run_id}", response_model=ImportRunOut)
async def import_run(run_id: uuid.UUID, db: DbSession,
                     actor: AuthContext = require_permission("users", "view")):
    run = await db.get(ImportRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail={"code": "run_not_found"})
    return await _run_out(db, run, with_rows=True)


@router.post("/import", response_model=ImportRunOut)
async def run_import(db: DbSession, actor: AuthContext = require_permission("users", "add")):
    try:
        run = await import_users(db, actor_id=actor.user.person_id, trigger="web")
    except ImportNotConfigured:
        raise HTTPException(status_code=409, detail={"code": "source_not_configured"}) from None
    except ImportSourceError as exc:
        raise HTTPException(status_code=502, detail={
            "code": "source_unavailable", "run_id": str(exc.run_id)}) from None
    return await _run_out(db, run, with_rows=True)


# ── one person ──

async def _target(db: AsyncSession, person_id: uuid.UUID) -> User:
    user = await db.get(User, person_id)
    if user is None:
        raise HTTPException(status_code=404, detail={"code": "person_not_found"})
    return user


def _can_manage(actor: AccessInfo, actor_id: uuid.UUID, target_id: uuid.UUID,
                target_rank: int) -> bool:
    return actor_id == target_id or can_touch_rank(actor.max_rank, target_rank)


@router.get("/{person_id}", response_model=UserDetailOut)
async def get_user(person_id: uuid.UUID, db: DbSession,
                   actor: AuthContext = require_permission("users", "view")):
    user = await _target(db, person_id)
    roles, ranks = await _roles_by_person(db)
    access = await resolve_access(db, person_id)
    overrides: dict[str, dict[str, bool]] = {}
    for res, action, allow in (await db.execute(
            select(PermissionOverride.resource, PermissionOverride.action,
                   PermissionOverride.allow)
            .where(PermissionOverride.person_id == person_id))).all():
        overrides.setdefault(res, {})[action] = allow
    now = datetime.now(UTC)
    sessions = await db.scalars(select(AuthSession).where(
        AuthSession.person_id == person_id, AuthSession.revoked_at.is_(None),
        AuthSession.rotated_at.is_(None), AuthSession.expires_at > now)
        .order_by(AuthSession.created_at.desc()))
    return UserDetailOut(
        user=_row(user, roles.get(person_id, []), ranks),
        first_name=user.first_name, last_name=user.last_name,
        preferred_name=user.preferred_name, job_title=user.job_title,
        cells={res: {a: EffectiveCellOut(value=access.perms[res][a],
                                          source=access.sources[res][a])
                     for a in access.perms[res]} for res in access.perms},
        overrides=overrides,
        sessions=[SessionRowOut(id=s.id, family_id=s.family_id, created_at=s.created_at,
                                expires_at=s.expires_at,
                                ip_address=str(s.ip_address) if s.ip_address else None,
                                user_agent=s.user_agent) for s in sessions],
        can_manage=_can_manage(actor.access, actor.user.person_id, person_id, access.max_rank))


@router.post("/{person_id}/sessions/revoke")
async def revoke_user_sessions(person_id: uuid.UUID, db: DbSession,
                               actor: AuthContext = require_permission("users", "change")):
    await _target(db, person_id)
    target_rank = (await resolve_access(db, person_id)).max_rank
    if not _can_manage(actor.access, actor.user.person_id, person_id, target_rank):
        raise HTTPException(status_code=403, detail={"code": "rank_too_low"})
    revoked = await revoke_sessions(db, person_id, reason="admin_revoke")
    audit(db, actor_id=actor.user.person_id, action="sessions.revoke", entity_type="user",
          entity_id=str(person_id), changes={"revoked": revoked})
    await db.commit()
    return {"revoked": revoked}
```

`TotpBackupCode` is imported but unused; remove it if lint complains. Add to `app.py`: `from sirdar_api.api.routes import auth, system, users` and `api.include_router(users.router)`.

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api
git commit -m "feat(sirdar): users API — list, detail, import from portal, revoke sessions"
```

---

### Task 9: Access matrix, overrides, audit and settings API

**Files:**
- Create: `sirdar/api/src/sirdar_api/api/routes/access.py`, `routes/audit.py`, `routes/settings.py`
- Modify: `app.py` (include the three routers)
- Test: `sirdar/api/tests/test_access_api.py`, `sirdar/api/tests/test_audit_settings_api.py`

**Interfaces:**
- Consumes: `REGISTRY`, `ACTIONS`, `resolve_access`, `role_matrix`, `can_touch_rank`, `audit`, `auth_headers`.
- Produces:

  | Method and path | Permission | Returns or errors |
  |---|---|---|
  | `GET /api/access/summary` | access:view | `{"resources": [{id, label, developer_only, always_viewable: false, gated_by: []}], "roles": [{name, label, color, rank, member_count, matrix: {res: {action: bool}}}]}` (roles ordered by rank desc, then name) |
  | `PUT /api/access/roles/{name}/matrix` | access:change | body `{"matrix": {res: {action: bool}}}`; returns `{"role", "grants": int}` |
  | `GET /api/access/overrides/{person_id}` | access:view | `{"person_id", "overrides": {res: {action: bool}}}` |
  | `PUT /api/access/overrides/{person_id}` | access:change | body `{"overrides": {res: {action: bool \| null}}}` (replaces all); returns `{"person_id", "overrides": int}` |
  | `GET /api/audit` | audit:view | params `entity_type`, `action`, `actor_id`, `limit` (1–500, default 100), `offset`; returns `list[{id, at, action, entity_type, entity_id, ip, actor_id, actor_name, changes}]` newest first |
  | `GET /api/audit/facets` | audit:view | `{"entity_types": [...], "actions": [...]}` |
  | `GET /api/settings` | settings:view | `{"env", "source_configured", "session_ttl_seconds", "access_token_ttl_seconds", "max_failed_logins", "lockout_seconds"}` |

  Matrix PUT errors, checked in this order:
  1. 404 `role_not_found`
  2. 403 `cannot_edit_own_role`
  3. 403 `rank_too_low`
  4. 422 `unknown_resource` / `unknown_action`
  5. 422 `developer_only_resource` (a developer_only resource granted to a role other than `developer`)
  6. 422 `access_view_locked` (`access.view` false)
  7. 403 `grant_exceeds_own` (newly granted pairs the actor can't do)

  Overrides PUT errors, checked in this order:
  1. 404 `person_not_found`
  2. 403 `cannot_target_self`
  3. 403 `rank_too_low`
  4. 422 `unknown_resource` / `unknown_action` / `developer_only_resource`
  5. 403 `grant_exceeds_own` (any `true` the actor can't do)

  Both PUTs write an audit row: the matrix PUT writes `entity_type="role", action="matrix.update", changes={"granted": [...], "revoked": [...]}` and the overrides PUT writes `entity_type="user", action="override.set"`.

- [ ] **Step 1: Write failing tests**

`sirdar/api/tests/test_access_api.py`:
```python
from .api_helpers import auth_headers
from .factories import make_user


def _admin_matrix(view_users=True, add_users=False):
    return {"dashboard": {"view": True}, "users": {"view": view_users, "add": add_users},
            "access": {"view": True}, "audit": {"view": True}, "settings": {"view": True}}


async def test_summary(client, db):
    h = await auth_headers(client, db)
    body = (await client.get("/api/access/summary", headers=h)).json()
    assert [r["id"] for r in body["resources"]] == [
        "dashboard", "users", "access", "audit", "settings", "devtools"]
    assert [r["name"] for r in body["roles"]] == ["developer", "founder", "super_admin", "admin"]
    admin = body["roles"][-1]
    assert admin["matrix"]["users"] == {"view": True, "add": False, "change": False,
                                        "delete": False}
    assert body["roles"][0]["member_count"] == 1


async def test_matrix_update_and_rules(client, db):
    h = await auth_headers(client, db)                       # developer, rank 100
    ok = await client.put("/api/access/roles/admin/matrix", headers=h,
                          json={"matrix": _admin_matrix(add_users=True)})
    assert ok.status_code == 200 and ok.json()["grants"] == 6
    bad_dev = await client.put("/api/access/roles/admin/matrix", headers=h,
                               json={"matrix": {**_admin_matrix(), "devtools": {"view": True}}})
    assert bad_dev.json()["detail"]["code"] == "developer_only_resource"
    locked = await client.put("/api/access/roles/admin/matrix", headers=h,
                              json={"matrix": {**_admin_matrix(), "access": {"view": False}}})
    assert locked.json()["detail"]["code"] == "access_view_locked"
    own = await client.put("/api/access/roles/developer/matrix", headers=h,
                           json={"matrix": _admin_matrix()})
    assert own.json()["detail"]["code"] == "cannot_edit_own_role"
    unknown = await client.put("/api/access/roles/admin/matrix", headers=h,
                               json={"matrix": {**_admin_matrix(), "nope": {"view": True}}})
    assert unknown.status_code == 422 and unknown.json()["detail"]["code"] == "unknown_resource"


async def test_super_admin_cannot_grant_beyond_own(client, db):
    h = await auth_headers(client, db, roles=("super_admin",))
    # super_admin lacks access.add — granting it to admin exceeds their own
    resp = await client.put("/api/access/roles/admin/matrix", headers=h,
                            json={"matrix": {**_admin_matrix(), "access": {"view": True,
                                                                           "add": True}}})
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "grant_exceeds_own"
    peer = await client.put("/api/access/roles/super_admin/matrix", headers=h,
                            json={"matrix": _admin_matrix()})
    assert peer.json()["detail"]["code"] == "cannot_edit_own_role"


async def test_overrides_roundtrip_and_rules(client, db):
    h = await auth_headers(client, db)
    target = await make_user(db, email="admin@test.example.com", roles=("admin",))
    url = f"/api/access/overrides/{target.person_id}"
    put = await client.put(url, headers=h,
                           json={"overrides": {"users": {"change": True, "view": None}}})
    assert put.status_code == 200 and put.json()["overrides"] == 1
    got = (await client.get(url, headers=h)).json()
    assert got["overrides"] == {"users": {"change": True}}
    dev = await client.put(url, headers=h, json={"overrides": {"devtools": {"view": True}}})
    assert dev.json()["detail"]["code"] == "developer_only_resource"
    me = (await client.get("/api/auth/me", headers=h)).json()["person"]["id"]
    self_edit = await client.put(f"/api/access/overrides/{me}", headers=h,
                                 json={"overrides": {}})
    assert self_edit.json()["detail"]["code"] == "cannot_target_self"


async def test_admin_cannot_edit_matrix(client, db):
    h = await auth_headers(client, db, roles=("admin",))
    resp = await client.put("/api/access/roles/admin/matrix", headers=h,
                            json={"matrix": _admin_matrix()})
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"
```

`sirdar/api/tests/test_audit_settings_api.py`:
```python
from .api_helpers import auth_headers


async def test_audit_lists_logins_with_actor_names(client, db):
    h = await auth_headers(client, db)
    rows = (await client.get("/api/audit", headers=h)).json()
    login = next(r for r in rows if r["action"] == "login")
    assert login["actor_name"] == "Boss User" and login["entity_type"] == "auth"
    facets = (await client.get("/api/audit/facets", headers=h)).json()
    assert "login" in facets["actions"] and "auth" in facets["entity_types"]
    only = (await client.get("/api/audit?action=login&limit=1", headers=h)).json()
    assert len(only) == 1


async def test_settings(client, db):
    h = await auth_headers(client, db, roles=("admin",))
    body = (await client.get("/api/settings", headers=h)).json()
    assert body["source_configured"] is True and body["max_failed_logins"] == 10
```

- [ ] **Step 2: Run to fail**

Run: `.venv/bin/pytest -q tests/test_access_api.py tests/test_audit_settings_api.py`
Expected: FAIL (404s).

- [ ] **Step 3: Implement**

`api/routes/access.py`:
```python
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resolver import can_touch_rank, resolve_access, role_matrix
from sirdar_api.access.resources import ACTIONS, REGISTRY
from sirdar_api.api.deps import AuthContext, DbSession, require_permission
from sirdar_api.db.models import PermissionOverride, Role, RolePermission, User, UserRole
from sirdar_api.services.audit import audit

router = APIRouter(prefix="/access", tags=["access"])


class MatrixIn(BaseModel):
    matrix: dict[str, dict[str, bool]]


class OverridesIn(BaseModel):
    overrides: dict[str, dict[str, bool | None]]


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _check_names(cells: dict[str, dict]) -> None:
    for res, acts in cells.items():
        if res not in REGISTRY:
            raise _err(422, "unknown_resource")
        for action in acts:
            if action not in ACTIONS:
                raise _err(422, "unknown_action")


@router.get("/summary")
async def summary(db: DbSession, actor: AuthContext = require_permission("access", "view")):
    matrix = await role_matrix(db)
    counts = dict((await db.execute(
        select(UserRole.role, func.count()).group_by(UserRole.role))).all())
    roles = await db.scalars(select(Role).order_by(Role.rank.desc(), Role.name))
    return {
        "resources": [{"id": r.id, "label": r.label, "developer_only": r.developer_only,
                       "always_viewable": False, "gated_by": []} for r in REGISTRY.values()],
        "roles": [{"name": r.name, "label": r.label, "color": r.color, "rank": r.rank,
                   "member_count": counts.get(r.name, 0),
                   "matrix": {res: {a: a in matrix.get(r.name, {}).get(res, set())
                                    for a in ACTIONS} for res in REGISTRY}}
                  for r in roles],
    }


@router.put("/roles/{name}/matrix")
async def put_role_matrix(name: str, body: MatrixIn, db: DbSession,
                          actor: AuthContext = require_permission("access", "change")):
    role = await db.get(Role, name)
    if role is None:
        raise _err(404, "role_not_found")
    if name in actor.access.role_names:
        raise _err(403, "cannot_edit_own_role")
    if not can_touch_rank(actor.access.max_rank, role.rank):
        raise _err(403, "rank_too_low")
    _check_names(body.matrix)
    desired = {(res, a) for res, acts in body.matrix.items() for a, on in acts.items() if on}
    if name != "developer" and any(REGISTRY[res].developer_only for res, _ in desired):
        raise _err(422, "developer_only_resource")
    if ("access", "view") not in desired:
        raise _err(422, "access_view_locked")
    current = set((await db.execute(select(RolePermission.resource, RolePermission.action)
                                    .where(RolePermission.role == name))).all())
    granted, revoked = desired - current, current - desired
    if any(not actor.access.can(res, a) for res, a in granted):
        raise _err(403, "grant_exceeds_own")
    for res, a in revoked:
        await db.execute(delete(RolePermission).where(
            RolePermission.role == name, RolePermission.resource == res,
            RolePermission.action == a))
    for res, a in granted:
        db.add(RolePermission(role=name, resource=res, action=a))
    audit(db, actor_id=actor.user.person_id, action="matrix.update", entity_type="role",
          entity_id=name, changes={"granted": sorted(f"{r}:{a}" for r, a in granted),
                                   "revoked": sorted(f"{r}:{a}" for r, a in revoked)})
    await db.commit()
    return {"role": name, "grants": len(desired)}


async def _overrides(db: AsyncSession, person_id: uuid.UUID) -> dict[str, dict[str, bool]]:
    out: dict[str, dict[str, bool]] = {}
    for res, a, allow in (await db.execute(
            select(PermissionOverride.resource, PermissionOverride.action,
                   PermissionOverride.allow)
            .where(PermissionOverride.person_id == person_id))).all():
        out.setdefault(res, {})[a] = allow
    return out


@router.get("/overrides/{person_id}")
async def get_overrides(person_id: uuid.UUID, db: DbSession,
                        actor: AuthContext = require_permission("access", "view")):
    if await db.get(User, person_id) is None:
        raise _err(404, "person_not_found")
    return {"person_id": str(person_id), "overrides": await _overrides(db, person_id)}


@router.put("/overrides/{person_id}")
async def put_overrides(person_id: uuid.UUID, body: OverridesIn, db: DbSession,
                        actor: AuthContext = require_permission("access", "change")):
    if await db.get(User, person_id) is None:
        raise _err(404, "person_not_found")
    if person_id == actor.user.person_id:
        raise _err(403, "cannot_target_self")
    if not can_touch_rank(actor.access.max_rank, (await resolve_access(db, person_id)).max_rank):
        raise _err(403, "rank_too_low")
    _check_names(body.overrides)
    wanted = {(res, a): allow for res, acts in body.overrides.items()
              for a, allow in acts.items() if allow is not None}
    if any(REGISTRY[res].developer_only for res, _ in wanted):
        raise _err(422, "developer_only_resource")
    if any(allow and not actor.access.can(res, a) for (res, a), allow in wanted.items()):
        raise _err(403, "grant_exceeds_own")
    before = await _overrides(db, person_id)
    await db.execute(delete(PermissionOverride).where(PermissionOverride.person_id == person_id))
    for (res, a), allow in wanted.items():
        db.add(PermissionOverride(person_id=person_id, resource=res, action=a, allow=allow,
                                  set_by=actor.user.person_id))
    audit(db, actor_id=actor.user.person_id, action="override.set", entity_type="user",
          entity_id=str(person_id),
          changes={"before": before, "after": {f"{r}:{a}": v for (r, a), v in wanted.items()}})
    await db.commit()
    return {"person_id": str(person_id), "overrides": len(wanted)}
```

`api/routes/audit.py`:
```python
import uuid
from datetime import datetime

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from sirdar_api.api.deps import AuthContext, DbSession, require_permission
from sirdar_api.db.models import AuditLog, User

router = APIRouter(prefix="/audit", tags=["audit"])


class AuditLogItem(BaseModel):
    id: int
    at: datetime
    action: str
    entity_type: str
    entity_id: str | None
    ip: str | None
    actor_id: uuid.UUID | None
    actor_name: str | None
    changes: dict


@router.get("", response_model=list[AuditLogItem])
async def list_audit(db: DbSession, entity_type: str | None = None, action: str | None = None,
                     actor_id: uuid.UUID | None = None,
                     limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
                     actor: AuthContext = require_permission("audit", "view")):
    q = (select(AuditLog, User).outerjoin(User, User.person_id == AuditLog.actor_id)
         .order_by(AuditLog.at.desc(), AuditLog.id.desc()).limit(limit).offset(offset))
    if entity_type:
        q = q.where(AuditLog.entity_type == entity_type)
    if action:
        q = q.where(AuditLog.action == action)
    if actor_id:
        q = q.where(AuditLog.actor_id == actor_id)
    return [AuditLogItem(id=row.id, at=row.at, action=row.action, entity_type=row.entity_type,
                         entity_id=row.entity_id, ip=str(row.ip) if row.ip else None,
                         actor_id=row.actor_id,
                         actor_name=user.display_name if user else None, changes=row.changes)
            for row, user in (await db.execute(q)).all()]


@router.get("/facets")
async def facets(db: DbSession, actor: AuthContext = require_permission("audit", "view")):
    types = await db.scalars(select(AuditLog.entity_type).distinct())
    actions = await db.scalars(select(AuditLog.action).distinct())
    return {"entity_types": sorted(types), "actions": sorted(actions)}
```

`api/routes/settings.py`:
```python
from fastapi import APIRouter

from sirdar_api.api.deps import AuthContext, require_permission
from sirdar_api.config import get_settings

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
async def read_settings(actor: AuthContext = require_permission("settings", "view")):
    s = get_settings()
    return {"env": s.env, "source_configured": s.source_database_url is not None,
            "session_ttl_seconds": s.session_ttl_seconds,
            "access_token_ttl_seconds": s.access_token_ttl_seconds,
            "max_failed_logins": s.max_failed_logins, "lockout_seconds": s.lockout_seconds}
```

`sorted(types)` uses the default string sort; that's fine for codes, since the portal's natural-sort guardrail applies only to portal TypeScript. Register the routers in `app.py`: `from sirdar_api.api.routes import access, audit, auth, settings, system, users`, then add `include_router` lines for `access.router`, `audit.router` and `settings.router`.

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api
git commit -m "feat(sirdar): roles & access matrix, overrides, audit log and settings API"
```

---

### Task 10: Portal components accept Sirdar branding (backward-compatible props)

**Files:**
- Modify: `portal/src/pages/Login.tsx`, `portal/src/components/login/LoginScene.tsx`, `portal/src/layout/NavPanel.tsx`
- Test: `portal/src/pages/Login.props.test.tsx` (new), `portal/src/layout/NavPanel.props.test.tsx` (new)

**Interfaces:**
- Produces:
  - `export default function LoginScene({ tag = 'Datacenter Relocation Tools' }: { tag?: string } = {})`, which renders `tag` in `.lx-logo-tag`.
  - `export default function Login({ eyebrow = 'ServerSherpa Portal', sceneTag, notice, extraErrors }: LoginProps = {})`, where `LoginProps = { eyebrow?: string; sceneTag?: string; notice?: ReactNode; extraErrors?: Record<string, string> }`.
    - `extraErrors[code]` wins over the built-in password-step map.
    - `notice` renders inside the form column above the banners: `<div className="login-notice" role="status">{notice}</div>`.
    - The "Remember this browser" label (and the EnrollFlow `remember` prop's checkbox) is hidden when `trustDays === 0`.
  - `NavPanelProps` gains `tag?: string` (default `'Portal'`), rendered in `.logo-tag`.

- [ ] **Step 1: Write failing tests**

`portal/src/layout/NavPanel.props.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import NavPanel from './NavPanel';

afterEach(cleanup);

const base = { sections: [], openSection: '', onToggleSection: () => {}, mode: 'expanded' as const };

it('shows "Portal" by default and a custom tag when given', () => {
  const { rerender } = render(<MemoryRouter><NavPanel {...base} /></MemoryRouter>);
  expect(screen.getByText('Portal')).toBeTruthy();
  rerender(<MemoryRouter><NavPanel {...base} tag="Sirdar" /></MemoryRouter>);
  expect(screen.getByText('Sirdar')).toBeTruthy();
});
```

`portal/src/pages/Login.props.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const login = vi.fn();
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ login, completeLogin: vi.fn() }),
}));
vi.mock('../components/SystemBanners', () => ({ default: () => null }));
vi.mock('../lib/systemStatus', () => ({
  getSystemStatus: vi.fn().mockResolvedValue({ totp_trust_days: 0 }),
}));

import { ApiError } from '../lib/api';
import Login from './Login';

beforeEach(() => login.mockReset());
afterEach(cleanup);

it('keeps the portal defaults without props', () => {
  render(<MemoryRouter><Login /></MemoryRouter>);
  expect(screen.getByText('ServerSherpa Portal')).toBeTruthy();
  expect(screen.getByText('Datacenter Relocation Tools')).toBeTruthy();
});

it('takes eyebrow, scene tag, notice and extra error text', async () => {
  login.mockRejectedValue(new ApiError(403, 'password_change_required'));
  render(
    <MemoryRouter>
      <Login eyebrow="Sirdar" sceneTag="Environment Builder" notice={<span>First run</span>}
             extraErrors={{ password_change_required: 'Change it in the portal first.' }} />
    </MemoryRouter>,
  );
  expect(screen.getByText('Sirdar')).toBeTruthy();
  expect(screen.getByText('Environment Builder')).toBeTruthy();
  expect(screen.getByText('First run')).toBeTruthy();
  await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co');
  await userEvent.type(screen.getByLabelText(/^password/i), 'x');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
  await waitFor(() => expect(screen.getByText('Change it in the portal first.')).toBeTruthy());
});
```

Before writing these tests, read `portal/src/pages/Login.tsx` and adjust the label and button queries to the real markup: input labels and the submit button text (for example "Sign in" vs "Log in"). Also confirm the `ApiError` constructor order in `portal/src/lib/api.ts` is `(status, code, …)`.

- [ ] **Step 2: Run to fail**

Run: `npm --prefix portal test -- src/pages/Login.props.test.tsx src/layout/NavPanel.props.test.tsx`
Expected: FAIL (the custom text is not found).

- [ ] **Step 3: Implement the props**

The edits are minimal; portal defaults are unchanged.

1. **LoginScene.tsx:**
   - Change `export default function LoginScene()` to `export default function LoginScene({ tag = 'Datacenter Relocation Tools' }: { tag?: string } = {})`.
   - Replace the literal `Datacenter Relocation Tools` inside `.lx-logo-tag` with `{tag}`.
2. **Login.tsx:**
   - Add `type ReactNode` to the react import.
   - Add the props interface and destructure it in the signature:
     ```tsx
     export interface LoginProps {
       eyebrow?: string;
       sceneTag?: string;
       notice?: ReactNode;
       extraErrors?: Record<string, string>;
     }
     export default function Login({ eyebrow = 'ServerSherpa Portal', sceneTag, notice, extraErrors }: LoginProps = {}) {
     ```
   - `<LoginScene />` becomes `<LoginScene tag={sceneTag} />`. Passing `undefined` keeps the default.
   - The `<div className="eyebrow">ServerSherpa Portal</div>` on the password card becomes `<div className="eyebrow">{eyebrow}</div>`.
   - Directly above `<div className="login-banners">`, add `{notice && <div className="login-notice" role="status">{notice}</div>}`.
   - Where the password-step error message is chosen from `ERROR_MESSAGES[code]`, use `extraErrors?.[code] ?? ERROR_MESSAGES[code] ?? <existing fallback>`.
   - Wrap the remember-browser `<label className="remember">…</label>` in `{trustDays > 0 && (…)}`. For `EnrollFlow`, leave the prop as-is; Sirdar never issues a `totp_enroll` challenge.
3. **NavPanel.tsx:**
   - Add `tag?: string;` to `NavPanelProps`.
   - Destructure `tag = 'Portal'`.
   - Replace `<div className="logo-tag">Portal</div>` with `<div className="logo-tag">{tag}</div>`.
4. Add to `portal/src/styles/login-light.css` (the login page's own stylesheet):
   ```css
   .login-notice {
     margin: 0 0 14px;
     padding: 10px 12px;
     border-radius: 10px;
     background: color-mix(in srgb, var(--accent, #d97706) 10%, transparent);
     color: inherit;
     font-size: 13px;
   }
   .login-notice code { font-family: 'Fragment Mono', monospace; font-size: 12px; }
   ```
   If the list-typography guardrail (`portal/src/styles/listTypography.test.ts`) flags this rule, it's a false positive (`.login-notice` is not a list selector). Report it rather than editing the allowlist silently.

- [ ] **Step 4: Run the full portal suite**

Run: `npm --prefix portal test`
Expected: all pass, including the existing Login/LoginScene/NavPanel tests and the two new files. Also run `npx --prefix portal tsc -p portal/tsconfig.json --noEmit`; expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add portal/src
git commit -m "feat(portal): optional branding props on Login, LoginScene and NavPanel (for Sirdar)"
```

---

### Task 11: Sirdar web scaffold and sign-in

**Files:**
- Create: `sirdar/web/package.json`, `sirdar/web/tsconfig.json`, `sirdar/web/vite.config.ts`, `sirdar/web/dedupe.ts`, `sirdar/web/index.html`
- Create: `sirdar/web/src/main.tsx`, `src/Root.tsx`, `src/App.tsx`, `src/auth/RequireAuth.tsx`, `src/pages/SirdarLogin.tsx`, `src/styles/sirdar.css`, `src/vite-env.d.ts`
- Test: `sirdar/web/src/portalImports.test.ts`, `sirdar/web/src/auth/RequireAuth.test.tsx`, `sirdar/web/src/pages/SirdarLogin.test.tsx`

**Interfaces:**
- Consumes:
  - portal `@portal/auth/AuthContext` (`AuthProvider`, `useAuth`)
  - `@portal/pages/Login` (props from Task 10)
  - `@portal/lib/systemStatusContext` (`SystemStatusProvider`)
  - `@portal/lib/api` (`apiUrl`)
  - Task 5 `/api/system/status`
- Produces:
  - `SIRDAR_ERRORS: Record<string, string>` (exported from `SirdarLogin.tsx`).
  - `RequireAuth({ children })`.
  - `App` routes: `/login` → `SirdarLogin`; `/*` → `RequireAuth` + `SirdarShell` (the shell itself comes in Task 12; in this task the `/*` route renders a placeholder `<div className="portal-page">Signed in</div>`, which Task 12 replaces).

- [ ] **Step 1: Package and config**

`sirdar/web/package.json`:
```json
{
  "name": "sirdar-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "bwip-js": "^4.11.4",
    "gsap": "^3.15.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.30.6"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.3",
    "@testing-library/user-event": "^14.6.7",
    "@types/node": "^22.20.4",
    "@types/react": "^18.3.31",
    "@types/react-dom": "^18.3.7",
    "@vitejs/plugin-react": "^4.7.0",
    "jsdom": "^29.1.1",
    "typescript": "~5.6.2",
    "vite": "^5.4.21",
    "vitest": "^3.2.7"
  }
}
```

`sirdar/web/dedupe.ts`:
```ts
/** Bare packages the allowlisted portal modules import. Shared files
 *  resolve their own imports from portal/node_modules unless deduped, and
 *  a second React/router/gsap breaks every hook. portalImports.test.ts
 *  fails when a portal module starts importing a package missing here. */
export const dedupe: string[] = ['react', 'react-dom', 'react-router-dom', 'gsap', 'bwip-js'];
```

`sirdar/web/vite.config.ts`:
```ts
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

import { dedupe } from './dedupe';

// Sirdar's SPA reuses portal styles and an allowlisted set of portal React
// modules (sign-in, nav, tables) through @portal; src/portalImports.test.ts
// enforces the allowlist. The portal's API client is reused against
// Sirdar's own API by pinning VITE_API_URL to /api (same origin: Vite
// proxies it in dev, the API serves the SPA in production).
const webRoot = fileURLToPath(new URL('.', import.meta.url));
const portalSrc = fileURLToPath(new URL('../../portal/src', import.meta.url));
const portalPublic = fileURLToPath(new URL('../../portal/public', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: webRoot,
  publicDir: portalPublic,
  plugins: [react()],
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify('/api') },
  resolve: { alias: { '@portal': portalSrc }, dedupe },
  server: {
    port: 5178,
    strictPort: true,
    host: true,
    allowedHosts: ['.serversherpa.com', 'localhost'],
    ...(process.env.SS_PUBLIC_HTTPS ? { hmr: { protocol: 'wss' as const, clientPort: 443 } } : {}),
    fs: { allow: [repoRoot] },
    proxy: { '/api': { target: 'http://localhost:8097' } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    root: webRoot,
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/._*'],
    onConsoleLog: (log) => !log.includes('React Router Future Flag Warning'),
  },
});
```

`sirdar/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext",
    "moduleResolution": "bundler", "jsx": "react-jsx", "types": ["vite/client", "node"],
    "strict": true, "noUnusedLocals": true, "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true, "skipLibCheck": true, "isolatedModules": true,
    "noEmit": true, "baseUrl": ".", "paths": { "@portal/*": ["../../portal/src/*"] }
  },
  "include": ["src", "dedupe.ts", "vite.config.ts"]
}
```

`sirdar/web/index.html`: copy `wiki/web/index.html` (fonts, root div, `/src/main.tsx`) and set `<title>Sirdar</title>`.

`sirdar/web/src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

Run `npm --prefix sirdar/web install` and commit the generated `package-lock.json`.

- [ ] **Step 2: Write failing tests**

`sirdar/web/src/portalImports.test.ts`:
- Copy `wiki/web/src/portalImports.test.ts` verbatim.
- Change `PORTAL` to `resolve(SRC, '../../../portal/src')`. The path is the same depth (`sirdar/web/src` → repo root is three levels); verify it resolves to the portal's `src`.
- Change `PACKAGE_JSON` to `resolve(SRC, '../package.json')`.
- Change the dedupe import to `../dedupe`.
- Replace the allowlist with:
```ts
const REACT_ALLOWLIST = [
  'auth/AuthContext',
  'pages/Login',
  'components/login/*',
  'components/totp/*',
  'components/SystemBanners',
  'components/DataTable',
  'components/ComboBox',
  'components/Switch',
  'components/access/MatrixTable',
  'layout/NavPanel',
  'lib/systemStatusContext',
];
```
- Keep the assertion that `'@portal/pages/Login'` is among the imports found.

`sirdar/web/src/auth/RequireAuth.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const state = { status: 'anon' as 'anon' | 'authed' | 'loading' };
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => state }));

import RequireAuth from './RequireAuth';

afterEach(cleanup);

function renderAt() {
  render(
    <MemoryRouter initialEntries={['/admin/users']}>
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/*" element={<RequireAuth><div>secret</div></RequireAuth>} />
      </Routes>
    </MemoryRouter>,
  );
}

it('sends anonymous visitors to /login', () => {
  state.status = 'anon';
  renderAt();
  expect(screen.getByText('login page')).toBeTruthy();
});

it('renders children when signed in', () => {
  state.status = 'authed';
  renderAt();
  expect(screen.getByText('secret')).toBeTruthy();
});
```

`sirdar/web/src/pages/SirdarLogin.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const seen: Record<string, unknown>[] = [];
vi.mock('@portal/pages/Login', () => ({
  default: (props: Record<string, unknown>) => { seen.push(props); return <div>{props.notice as never}</div>; },
}));

import SirdarLogin, { SIRDAR_ERRORS } from './SirdarLogin';

afterEach(() => { cleanup(); seen.length = 0; vi.unstubAllGlobals(); });

it('brands the shared Login and maps Sirdar-only codes', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ needs_setup: false }) }));
  render(<SirdarLogin />);
  expect(seen[0].eyebrow).toBe('Sirdar');
  expect(seen[0].extraErrors).toBe(SIRDAR_ERRORS);
  expect(SIRDAR_ERRORS.password_change_required).toMatch(/portal/);
  expect(SIRDAR_ERRORS.totp_enrollment_required).toMatch(/portal/);
});

it('shows first-run instructions when Sirdar has no users', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ needs_setup: true }) }));
  render(<SirdarLogin />);
  await waitFor(() => expect(screen.getByText(/sirdar create-admin/)).toBeTruthy());
});
```

- [ ] **Step 3: Run to fail**

Run: `npm --prefix sirdar/web test`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`src/auth/RequireAuth.tsx`:
```tsx
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return null;
  if (status === 'anon') return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}
```

`src/pages/SirdarLogin.tsx`:
```tsx
import { useEffect, useState } from 'react';

import Login from '@portal/pages/Login';
import { apiUrl } from '@portal/lib/api';

/** Refusals only Sirdar's API returns — the portal's Login falls back to
 *  these before its own generic text. */
export const SIRDAR_ERRORS: Record<string, string> = {
  password_change_required:
    'Your portal password has to be changed first. Update it in the portal, then ask an admin to re-import users.',
  totp_enrollment_required:
    'Two-factor is required for your account. Set it up in the portal, then ask an admin to re-import users.',
};

export default function SirdarLogin() {
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiUrl()}/system/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => { if (!cancelled && s) setNeedsSetup(!!s.needs_setup); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const notice = needsSetup ? (
    <>No users yet. On the Sirdar host run <code>sirdar create-admin</code> or{' '}
      <code>sirdar import-users</code>.</>
  ) : null;

  return (
    <Login eyebrow="Sirdar" sceneTag="Environment Builder" notice={notice}
           extraErrors={SIRDAR_ERRORS} />
  );
}
```

`src/Root.tsx`:
```tsx
import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from '@portal/auth/AuthContext';
import { SystemStatusProvider } from '@portal/lib/systemStatusContext';

import App from './App';

export default function Root() {
  return (
    <SystemStatusProvider>
      <AuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </SystemStatusProvider>
  );
}
```

`src/App.tsx` (Task 12 replaces the placeholder):
```tsx
import { Route, Routes } from 'react-router-dom';

import RequireAuth from './auth/RequireAuth';
import SirdarLogin from './pages/SirdarLogin';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<SirdarLogin />} />
      <Route path="/*" element={<RequireAuth><div className="portal-page">Signed in</div></RequireAuth>} />
    </Routes>
  );
}
```

`src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@portal/styles/base.css';
import '@portal/styles/portal-theme.css';
import '@portal/styles/chrome.css';
import '@portal/styles/directory.css';
import '@portal/styles/profile.css';
import '@portal/styles/settings.css';
import '@portal/styles/access.css';
import '@portal/styles/reports.css';
import Root from './Root';
import './styles/sirdar.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
```

`src/styles/sirdar.css`:
```css
/* Sirdar's own accents on top of the portal stylesheets. Only Sirdar-
   specific classes live here; everything else is the portal's. */
.sirdar-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, #0f766e 14%, transparent);
  color: #0f766e;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.sirdar-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.sirdar-card { padding: 16px; border: 1px solid var(--line, #e5e7eb); border-radius: 12px; background: var(--surface, #fff); }
.sirdar-card h3 { margin: 0 0 6px; }
.sirdar-kv { display: grid; grid-template-columns: max-content 1fr; gap: 8px 24px; }
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm --prefix sirdar/web test`, then `npx --prefix sirdar/web tsc -p sirdar/web/tsconfig.json --noEmit`
Expected: tests pass; tsc reports no errors.

If the import guardrail reports a bare package reached from an allowlisted portal module, add it to both `dependencies` and `dedupe.ts` (the wiki precedent) and re-run.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web
git commit -m "feat(sirdar): web scaffold — portal Login + AuthProvider against /api, import allowlist"
```

---

### Task 12: Sirdar shell and navigation

**Files:**
- Create: `sirdar/web/src/layout/sirdarNav.tsx`, `src/layout/SirdarShell.tsx`, `src/layout/SirdarTopbar.tsx`
- Create placeholder pages (filled in Tasks 13–14), each exporting a component that renders `<div className="portal-page"><div className="eyebrow">…</div><div className="dir-head"><h1>…</h1></div></div>`: `src/pages/Dashboard.tsx`, `Users.tsx`, `UserDetail.tsx`, `Access.tsx`, `Audit.tsx`, `Settings.tsx`, `Me.tsx`
- Modify: `sirdar/web/src/App.tsx`
- Test: `sirdar/web/src/layout/sirdarNav.test.ts`, `sirdar/web/src/layout/SirdarShell.test.tsx`

**Interfaces:**
- Consumes:
  - `@portal/layout/NavPanel` (with the `tag` prop)
  - `import type { NavSection } from '@portal/layout/navSections'`
  - `@portal/lib/settings` (`applyPreferences`, `nextNavMode`, `NavMode`)
  - `useAuth` (`person`, `roles`, `logout`, `preferences`, `updatePreferences`, `can`)
- Produces:
  - `SIRDAR_NAV: NavSection[]`
  - `visibleSections(can: (resource: string, action: 'view') => boolean): NavSection[]`
  - `PAGE_TITLES: Record<string, string>`
  - `SirdarShell({ children })`, `SirdarTopbar({ leading })`

  Nav data:
  - Dashboard → `/` (resource `dashboard`, `end: true`)
  - Administration:
    - Users → `/admin/users` (`users`)
    - Roles & access → `/admin/access` (`access`)
    - Audit log → `/admin/audit` (`audit`)
  - System:
    - Settings → `/settings` (`settings`)

- [ ] **Step 1: Write failing tests**

`sirdar/web/src/layout/sirdarNav.test.ts`:
```ts
import { expect, it } from 'vitest';

import { SIRDAR_NAV, visibleSections } from './sirdarNav';

it('has Dashboard, Administration and System sections', () => {
  expect(SIRDAR_NAV.map((s) => s.label)).toEqual(['Dashboard', 'Administration', 'System']);
});

it('drops items and empty sections the user cannot view', () => {
  const only = new Set(['dashboard', 'users']);
  const out = visibleSections((r) => only.has(r));
  expect(out.map((s) => s.label)).toEqual(['Dashboard', 'Administration']);
  expect(out[1].items.map((i) => i.label)).toEqual(['Users']);
});
```

`sirdar/web/src/layout/SirdarShell.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const updatePreferences = vi.fn().mockResolvedValue(true);
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    person: { display_name: 'Alice Anderson', email: 'a@b.co', avatar_url: null },
    roles: ['admin'], logout: vi.fn(), updatePreferences, can: () => true,
    preferences: { nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', accent: 'amber',
                   theme: 'light', density: 'comfortable', list_size: 'default', motion: true,
                   notif: {}, list_prefs: {} },
  }),
}));

import SirdarShell from './SirdarShell';

afterEach(cleanup);

it('renders the Sirdar-tagged nav and the page', () => {
  render(<MemoryRouter><SirdarShell><p>content</p></SirdarShell></MemoryRouter>);
  expect(screen.getAllByText('Sirdar').length).toBeGreaterThan(0);
  expect(screen.getByText('Users')).toBeTruthy();
  expect(screen.getByText('content')).toBeTruthy();
});

it('Ctrl+B cycles the nav mode through preferences', () => {
  render(<MemoryRouter><SirdarShell><p>content</p></SirdarShell></MemoryRouter>);
  fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
  expect(updatePreferences).toHaveBeenCalledWith(expect.objectContaining({ nav_mode: 'rail' }));
});
```

- [ ] **Step 2: Run to fail**

Run: `npm --prefix sirdar/web test`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/layout/sirdarNav.tsx`:
```tsx
import type { NavSection } from '@portal/layout/navSections';

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

const I = {
  dash: icon('M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z'),
  users: icon('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'),
  shield: icon('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'),
  log: icon('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8'),
  gear: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'),
};

export const SIRDAR_NAV: NavSection[] = [
  { label: 'Dashboard', icon: I.dash, items: [
    { to: '/', label: 'Dashboard', resource: 'dashboard', icon: I.dash, end: true },
  ] },
  { label: 'Administration', icon: I.shield, items: [
    { to: '/admin/users', label: 'Users', resource: 'users', icon: I.users },
    { to: '/admin/access', label: 'Roles & access', resource: 'access', icon: I.shield },
    { to: '/admin/audit', label: 'Audit log', resource: 'audit', icon: I.log },
  ] },
  { label: 'System', icon: I.gear, items: [
    { to: '/settings', label: 'Settings', resource: 'settings', icon: I.gear },
  ] },
];

export const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/admin/users': 'Users',
  '/admin/access': 'Roles & access',
  '/admin/audit': 'Audit log',
  '/settings': 'Settings',
  '/me': 'My profile & preferences',
};

export function visibleSections(can: (resource: string, action: 'view') => boolean): NavSection[] {
  return SIRDAR_NAV
    .map((s) => ({ ...s, items: s.items.filter((i) => can(i.resource, 'view')) }))
    .filter((s) => s.items.length > 0);
}
```

`src/layout/SirdarTopbar.tsx`:
```tsx
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { PAGE_TITLES } from './sirdarNav';

/** Crumb + Sirdar badge. The portal Topbar's search, AI and notifications
 *  are portal-data features and are not part of Sirdar. */
export default function SirdarTopbar({ leading }: { leading?: ReactNode }) {
  const { pathname } = useLocation();
  const title = PAGE_TITLES[pathname]
    ?? (pathname.startsWith('/admin/users/') ? 'User' : 'Sirdar');
  return (
    <header className="topbar">
      {leading}
      <div className="crumbs">
        <span>Sirdar</span>
        <span className="crumb-sep">/</span>
        <span>{title}</span>
      </div>
      <div className="tb-actions">
        <span className="sirdar-badge">Sirdar</span>
      </div>
    </header>
  );
}
```

`src/layout/SirdarShell.tsx`: build it from a copy of `portal/src/layout/AppShell.tsx` (read the whole file first), with these exact changes:
1. **Wrapper and data:**
   - Drop `TopbarProvider`/`useTopbar`, `CommandPalette`, `ToastHost`, `SystemBanners`, god mode (`godMode`, `godNavColor`, `exitGodMode` and the `god-exit` button), `isNavItemVisible`, `NAV_SECTIONS`, `scope` and `maxRank`.
   - `visibleSections` comes from `./sirdarNav` (`visibleSections(can)`).
   - Default export `SirdarShell({ children })` with no provider wrapper.
2. **`leading`:** replace `setLeading(...)` with a local `const leading = mode === 'hidden' ? (<button … nav-hamburger …/>) : null;`, passed as `<SirdarTopbar leading={leading} />`.
3. **`paletteOpen`:** remove it from the Ctrl/⌘+B handler and its dependency list.
4. **User menu:**
   - The single menu item "My profile & preferences" goes to `/me`; drop the second item.
   - Keep the `um-sep` and the Sign out item.
5. **Both `NavPanel` usages:** pass `tag="Sirdar"`; drop `godMode`/`godNavColor`.
6. **Layout:** inside `portal-main-col`, render `<SirdarTopbar leading={leading} />` followed by `<main className="portal-main">{children}</main>`. Keep the `portal-theme.css` and `chrome.css` imports (as `@portal/styles/...`).
7. **Keep unchanged:**
   - `applyPreferences` on change
   - the mobile query
   - accordion/rail/overlay behavior
   - Escape handling and outside-click closing
   - `MODE_LABEL`, `ChipAvatar`, `initials`, `sectionForPath`, `matchesMobile`, `isTypingTarget`

   These are copied verbatim, not imported, because AppShell keeps them private.

Then replace `src/App.tsx`:
```tsx
import { Route, Routes } from 'react-router-dom';

import RequireAuth from './auth/RequireAuth';
import SirdarShell from './layout/SirdarShell';
import Access from './pages/Access';
import Audit from './pages/Audit';
import Dashboard from './pages/Dashboard';
import Me from './pages/Me';
import Settings from './pages/Settings';
import SirdarLogin from './pages/SirdarLogin';
import UserDetail from './pages/UserDetail';
import Users from './pages/Users';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<SirdarLogin />} />
      <Route path="/*" element={
        <RequireAuth>
          <SirdarShell>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/admin/users" element={<Users />} />
              <Route path="/admin/users/:personId" element={<UserDetail />} />
              <Route path="/admin/access" element={<Access />} />
              <Route path="/admin/audit" element={<Audit />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/me" element={<Me />} />
            </Routes>
          </SirdarShell>
        </RequireAuth>
      } />
    </Routes>
  );
}
```

Each placeholder page in this task looks like this (Dashboard shown; use matching eyebrow and title for the others):
```tsx
export default function Dashboard() {
  return (
    <div className="portal-page">
      <div className="eyebrow">Sirdar</div>
      <div className="dir-head"><h1>Dashboard</h1></div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm --prefix sirdar/web test && npx --prefix sirdar/web tsc -p sirdar/web/tsconfig.json --noEmit`
Expected: pass. The import guardrail must still pass with `layout/NavPanel` allowlisted, because `navSections` is imported as a type only.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web
git commit -m "feat(sirdar): shell — portal NavPanel tagged Sirdar, collapse modes, Ctrl/⌘+B, user menu"
```

---

### Task 13: Users pages (list, import summary, user detail)

**Files:**
- Create: `sirdar/web/src/lib/sirdarApi.ts`, `src/components/ImportSummaryModal.tsx`, `src/components/OverridesModal.tsx`
- Modify: `src/pages/Users.tsx`, `src/pages/UserDetail.tsx`, `src/pages/Dashboard.tsx`
- Test: `src/components/ImportSummaryModal.test.tsx`, `src/pages/Users.test.tsx`

**Interfaces:**
- Consumes:
  - Task 8 and Task 9 endpoints
  - `@portal/lib/api` (`apiFetch`, `ApiError`, plus `AccessResourceOut` and `EffectiveCell` as types)
  - `@portal/lib/access` (`ACTIONS`, `canTouchRank`, `Action`)
  - `@portal/components/DataTable`, `@portal/components/access/MatrixTable`
  - `@portal/lib/listTools` (`exportCsv`)
  - `useAuth().can`, `maxRank`
- Produces: `sirdarApi.ts` exports:
  - Types: `UserRow`, `ImportRow`, `ImportRun`, `UserDetail`, `SessionRow`, `AccessSummary`, `SirdarRole`, `AuditItem`, `SirdarSettings`
  - Functions: `listUsers`, `getUser`, `getImportSource`, `listImportRuns`, `runImport`, `revokeSessions`, `getAccessSummary`, `putRoleMatrix`, `getOverrides`, `putOverrides`, `listAudit`, `getAuditFacets`, `getSettings`
  - `errorText(err: unknown, fallback: string): string`

- [ ] **Step 1: API module**

`src/lib/sirdarApi.ts`:
```ts
/** Sirdar endpoints, through the portal's apiFetch (token refresh and
 *  session-ended handling come with it; VITE_API_URL=/api). */
import { ApiError, apiFetch, type AccessResourceOut, type EffectiveCell } from '@portal/lib/api';
import type { Action } from '@portal/lib/access';

export interface UserRow {
  person_id: string; display_name: string; email: string; source: 'portal' | 'local';
  roles: string[]; max_rank: number; totp_enrolled: boolean; totp_required: boolean;
  last_login_at: string | null; disabled_at: string | null; disabled_reason: string | null;
  last_imported_at: string | null;
}
export interface ImportRow {
  person_id: string | null; email: string; name: string;
  action: 'added' | 'updated' | 'unchanged' | 'disabled' | 'skipped';
  reason: string | null; roles: string[]; changes: string[];
}
export interface ImportRun {
  id: string; started_at: string; finished_at: string | null; trigger: string;
  status: 'running' | 'ok' | 'failed'; error: string | null; actor_name: string | null;
  added: number; updated: number; unchanged: number; disabled: number; skipped: number;
  rows: ImportRow[];
}
export interface SessionRow {
  id: string; family_id: string; created_at: string; expires_at: string;
  ip_address: string | null; user_agent: string | null;
}
export interface UserDetail {
  user: UserRow; first_name: string; last_name: string; preferred_name: string | null;
  job_title: string | null; cells: Record<string, Record<Action, EffectiveCell>>;
  overrides: Record<string, Partial<Record<Action, boolean>>>; sessions: SessionRow[];
  can_manage: boolean;
}
export interface SirdarRole {
  name: string; label: string; color: string | null; rank: number; member_count: number;
  matrix: Record<string, Record<Action, boolean>>;
}
export interface AccessSummary { resources: AccessResourceOut[]; roles: SirdarRole[] }
export interface AuditItem {
  id: number; at: string; action: string; entity_type: string; entity_id: string | null;
  ip: string | null; actor_id: string | null; actor_name: string | null;
  changes: Record<string, unknown>;
}
export interface SirdarSettings {
  env: string; source_configured: boolean; session_ttl_seconds: number;
  access_token_ttl_seconds: number; max_failed_logins: number; lockout_seconds: number;
}

async function errorOf(resp: Response): Promise<ApiError> {
  let code = `http_${resp.status}`;
  let detail: unknown;
  try {
    const body = await resp.json();
    detail = body?.detail;
    if (detail && typeof detail === 'object' && 'code' in detail) {
      code = String((detail as { code: unknown }).code);
    }
  } catch { /* not JSON */ }
  return new ApiError(resp.status, code, detail);
}

async function getJson<T>(path: string): Promise<T> {
  const resp = await apiFetch(path);
  if (!resp.ok) throw await errorOf(resp);
  return resp.json();
}

async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await apiFetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) throw await errorOf(resp);
  return resp.json();
}

const MESSAGES: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  rank_too_low: 'That person outranks you.',
  cannot_edit_own_role: "You can't change the permissions of a role you hold.",
  cannot_target_self: "You can't change your own overrides.",
  grant_exceeds_own: "You can't grant a permission you don't have yourself.",
  developer_only_resource: 'Developer tools can only be granted to the developer role.',
  access_view_locked: 'Every role keeps view on Roles & access.',
  source_not_configured: 'The portal database is not configured for this Sirdar.',
  source_unavailable: "Couldn't reach the portal database. Nothing was changed.",
};

export function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? fallback;
  return fallback;
}

export const listUsers = () => getJson<UserRow[]>('/users');
export const getUser = (id: string) => getJson<UserDetail>(`/users/${id}`);
export const getImportSource = () => getJson<{ configured: boolean }>('/users/import/source');
export const listImportRuns = () => getJson<ImportRun[]>('/users/import/runs');
export const runImport = () => sendJson<ImportRun>('POST', '/users/import');
export const revokeSessions = (id: string) =>
  sendJson<{ revoked: number }>('POST', `/users/${id}/sessions/revoke`);
export const getAccessSummary = () => getJson<AccessSummary>('/access/summary');
export const putRoleMatrix = (name: string, matrix: Record<string, Record<Action, boolean>>) =>
  sendJson<{ role: string; grants: number }>('PUT', `/access/roles/${name}/matrix`, { matrix });
export const getOverrides = (id: string) =>
  getJson<{ person_id: string; overrides: Record<string, Partial<Record<Action, boolean>>> }>(
    `/access/overrides/${id}`);
export const putOverrides = (id: string,
                             overrides: Record<string, Partial<Record<Action, boolean | null>>>) =>
  sendJson<{ person_id: string; overrides: number }>('PUT', `/access/overrides/${id}`, { overrides });
export function listAudit(q: { entity_type?: string; action?: string; offset?: number; limit?: number }) {
  const params = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => { if (v !== undefined && v !== '') params.set(k, String(v)); });
  return getJson<AuditItem[]>(`/audit?${params.toString()}`);
}
export const getAuditFacets = () =>
  getJson<{ entity_types: string[]; actions: string[] }>('/audit/facets');
export const getSettings = () => getJson<SirdarSettings>('/settings');
```

Before using it, confirm `apiFetch`, `ApiError`, `AccessResourceOut` and `EffectiveCell` are exported from `portal/src/lib/api.ts` (grep `export`). Also check that `lib/api.ts` imports React nowhere, so the guardrail accepts it as a React-free `lib/*.ts`.

- [ ] **Step 2: Write failing tests**

`src/components/ImportSummaryModal.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

const exportCsv = vi.fn();
vi.mock('@portal/lib/listTools', () => ({ exportCsv }));

import type { ImportRun } from '../lib/sirdarApi';
import ImportSummaryModal from './ImportSummaryModal';

afterEach(cleanup);

const run: ImportRun = {
  id: 'r1', started_at: '2026-10-01T12:00:00Z', finished_at: '2026-10-01T12:00:01Z',
  trigger: 'web', status: 'ok', error: null, actor_name: 'Boss User',
  added: 1, updated: 1, unchanged: 0, disabled: 1, skipped: 1,
  rows: [
    { person_id: '1', email: 'a@x.co', name: 'Ann A', action: 'added', reason: null, roles: ['admin'], changes: [] },
    { person_id: '2', email: 'b@x.co', name: 'Bo B', action: 'updated', reason: null, roles: ['admin'], changes: ['first_name'] },
    { person_id: '3', email: 'c@x.co', name: 'Cy C', action: 'disabled', reason: 'not_eligible', roles: [], changes: [] },
    { person_id: null, email: 'd@x.co', name: 'Di D', action: 'skipped', reason: 'email_collision_local', roles: ['admin'], changes: [] },
  ],
};

it('shows counts, one row per person and a CSV download', async () => {
  render(<ImportSummaryModal run={run} onClose={() => {}} />);
  expect(screen.getByText('Import finished')).toBeTruthy();
  expect(screen.getByText('Ann A')).toBeTruthy();
  expect(screen.getByText(/no longer has an admin-or-higher role/i)).toBeTruthy();
  expect(screen.getByText(/local user already has this email/i)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /download csv/i }));
  expect(exportCsv).toHaveBeenCalledWith('sirdar-import-r1.csv', expect.any(Array), run.rows);
});
```

`src/pages/Users.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

let canAdd = true;
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a = 'view') => (r === 'users' && a === 'add' ? canAdd : true) }),
}));
vi.mock('../lib/sirdarApi', async (orig) => ({
  ...(await orig<typeof import('../lib/sirdarApi')>()),
  listUsers: vi.fn().mockResolvedValue([{
    person_id: 'p1', display_name: 'Alice Anderson', email: 'a@x.co', source: 'portal',
    roles: ['admin'], max_rank: 60, totp_enrolled: true, totp_required: true,
    last_login_at: null, disabled_at: null, disabled_reason: null, last_imported_at: null,
  }]),
  getImportSource: vi.fn().mockResolvedValue({ configured: true }),
}));

import Users from './Users';

afterEach(cleanup);

it('lists users and offers import to users:add holders', async () => {
  render(<MemoryRouter><Users /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('Alice Anderson')).toBeTruthy());
  expect(screen.getByRole('button', { name: /import from portal/i })).toBeTruthy();
});

it('hides import without users:add', async () => {
  canAdd = false;
  render(<MemoryRouter><Users /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('Alice Anderson')).toBeTruthy());
  expect(screen.queryByRole('button', { name: /import from portal/i })).toBeNull();
});
```

- [ ] **Step 3: Run to fail**

Run: `npm --prefix sirdar/web test`
Expected: FAIL.

- [ ] **Step 4: Implement**

`src/components/ImportSummaryModal.tsx`. It follows the modal header pattern: eyebrow, title and description, a stat strip, then a wide card sized to its content.
```tsx
import DataTable from '@portal/components/DataTable';
import { exportCsv } from '@portal/lib/listTools';

import type { ImportRow, ImportRun } from '../lib/sirdarApi';

const ACTION_LABEL: Record<ImportRow['action'], string> = {
  added: 'Added', updated: 'Updated', unchanged: 'Unchanged', disabled: 'Disabled', skipped: 'Skipped',
};
const REASON_TEXT: Record<string, string> = {
  not_eligible: 'No longer has an admin-or-higher role in the portal',
  email_collision_local: 'A local user already has this email',
  email_collision: 'Another Sirdar user already has this email',
  person_is_local: 'This person is a local Sirdar user',
};

export function rowDetail(r: ImportRow): string {
  if (r.reason) return REASON_TEXT[r.reason] ?? r.reason;
  if (r.changes.length) return `Changed: ${r.changes.join(', ').replaceAll('_', ' ')}`;
  return '';
}

export default function ImportSummaryModal({ run, onClose }: { run: ImportRun; onClose: () => void }) {
  const counts: [string, number][] = [
    ['Added', run.added], ['Updated', run.updated], ['Unchanged', run.unchanged],
    ['Disabled', run.disabled], ['Skipped', run.skipped],
  ];
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-import-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-import-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Import from portal</div>
            <h3 id="sirdar-import-title">Import finished</h3>
            <p className="page-hint">
              Portal users with an admin-or-higher role are copied into Sirdar. People who lost that
              role are disabled here; local users are never changed.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="sirdar-stats">
            {counts.map(([label, n]) => (
              <div key={label} className="sirdar-stat"><b>{n}</b><span>{label}</span></div>
            ))}
          </div>
          <DataTable
            ariaLabel="Import results"
            columns={[
              { key: 'name', label: 'Name' }, { key: 'email', label: 'Email', mono: true },
              { key: 'result', label: 'Result' }, { key: 'roles', label: 'Roles' },
              { key: 'detail', label: 'Detail' },
            ]}
            rows={run.rows.map((r, i) => ({
              key: `${r.email}-${i}`,
              cells: [r.name, r.email, ACTION_LABEL[r.action], r.roles.join(', ') || '—', rowDetail(r) || '—'],
            }))}
            emptyText="Nobody in the portal qualifies yet."
          />
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={() => exportCsv(
            `sirdar-import-${run.id}.csv`,
            [['Name', (r: ImportRow) => r.name], ['Email', (r: ImportRow) => r.email],
             ['Result', (r: ImportRow) => ACTION_LABEL[r.action]],
             ['Roles', (r: ImportRow) => r.roles.join('; ')],
             ['Detail', (r: ImportRow) => rowDetail(r)]],
            run.rows)}>
            Download CSV
          </button>
          <button type="button" className="btn-solid" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
```

Add to `src/styles/sirdar.css`:
```css
.sirdar-import-card { width: min(920px, calc(100vw - 48px)); }
.sirdar-stats { display: flex; gap: 12px; margin: 0 0 16px; flex-wrap: wrap; }
.sirdar-stat { display: flex; flex-direction: column; padding: 8px 14px; border: 1px solid var(--line, #e5e7eb); border-radius: 10px; min-width: 96px; }
.sirdar-stat b { font-size: 20px; }
.sirdar-stat span { font-size: 12px; opacity: 0.7; }
```

`src/pages/Users.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import ImportSummaryModal from '../components/ImportSummaryModal';
import {
  errorText, getImportSource, listUsers, runImport, type ImportRun, type UserRow,
} from '../lib/sirdarApi';

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function status(u: UserRow): string {
  if (u.disabled_at) return u.disabled_reason === 'not_eligible' ? 'Disabled (no longer eligible)' : 'Disabled';
  return 'Active';
}

export default function Users() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [importing, setImporting] = useState(false);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    listUsers().then(setUsers).catch((e) => setError(errorText(e, "Couldn't load users.")));
  }, []);

  useEffect(() => {
    load();
    getImportSource().then((s) => setConfigured(s.configured)).catch(() => setConfigured(false));
  }, [load]);

  const doImport = async () => {
    setImporting(true);
    setError('');
    try {
      setRun(await runImport());
      load();
    } catch (e) {
      setError(errorText(e, 'The import failed.'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Administration</div>
      <div className="dir-head">
        <h1>Users</h1>
        <p>Everyone who can sign in to Sirdar: portal admins (copied by the import) and local users.</p>
      </div>
      <div className="dir-toolbar">
        {can('users', 'add') && (
          <button type="button" className="btn-solid" onClick={doImport}
                  disabled={importing || !configured}>
            {importing ? 'Importing…' : 'Import from portal'}
          </button>
        )}
        {!configured && <span className="page-hint">Portal database not configured.</span>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {users && (
        <DataTable
          ariaLabel="Users"
          columns={[
            { key: 'name', label: 'Name' }, { key: 'email', label: 'Email', mono: true },
            { key: 'roles', label: 'Roles' }, { key: 'source', label: 'Source' },
            { key: 'totp', label: '2FA' }, { key: 'last', label: 'Last sign-in' },
            { key: 'status', label: 'Status' },
          ]}
          rows={users.map((u) => ({
            key: u.person_id,
            className: 'sirdar-row-link',
            cells: [
              <button type="button" className="link-btn" onClick={() => navigate(`/admin/users/${u.person_id}`)}>
                {u.display_name}
              </button>,
              u.email, u.roles.join(', ') || '—', u.source === 'portal' ? 'Portal' : 'Local',
              u.totp_enrolled ? 'On' : u.totp_required ? 'Required — not set up' : 'Off',
              fmt(u.last_login_at), status(u),
            ],
          }))}
          emptyText="No users yet. Import from the portal or run sirdar create-admin."
        />
      )}
      {run && <ImportSummaryModal run={run} onClose={() => setRun(null)} />}
    </div>
  );
}
```

`src/components/OverridesModal.tsx`: the override editor, the portal's `OverrideEditor` behavior in Sirdar data.
```tsx
import { useEffect, useState } from 'react';

import MatrixTable from '@portal/components/access/MatrixTable';
import { ACTIONS, type Action } from '@portal/lib/access';
import type { AccessResourceOut } from '@portal/lib/api';

import { errorText, getOverrides, putOverrides } from '../lib/sirdarApi';

type Board = Record<string, Partial<Record<Action, boolean>>>;

export default function OverridesModal({ personId, name, resources, inherited, onClose, onSaved }: {
  personId: string; name: string; resources: AccessResourceOut[];
  inherited: Record<string, Record<Action, boolean>>;
  onClose: () => void; onSaved: () => void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getOverrides(personId).then((r) => setBoard(r.overrides))
      .catch((e) => setError(errorText(e, "Couldn't load overrides.")));
  }, [personId]);

  const cycle = (res: string, action: Action) => setBoard((b) => {
    const cur = b?.[res]?.[action];
    const next = cur === undefined ? true : cur === true ? false : undefined;
    const row = { ...(b?.[res] ?? {}) };
    if (next === undefined) delete row[action]; else row[action] = next;
    return { ...(b ?? {}), [res]: row };
  });

  const save = async () => {
    if (!board) return;
    setSaving(true);
    setError('');
    const full: Record<string, Record<Action, boolean | null>> = {};
    for (const r of resources) {
      full[r.id] = Object.fromEntries(ACTIONS.map((a) => [a, board[r.id]?.[a] ?? null])) as Record<Action, boolean | null>;
    }
    try {
      await putOverrides(personId, full);
      onSaved();
    } catch (e) {
      setError(errorText(e, "Couldn't save overrides."));
      setSaving(false);
    }
  };

  const locked = new Set(resources.filter((r) => r.developer_only).map((r) => r.id));

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-import-card" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Permission overrides</div>
            <h3>{name}</h3>
            <p className="page-hint">Click a cell to cycle inherit → allow → deny. Overrides win over roles.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {error && <p className="form-error" role="alert">{error}</p>}
          {board && (
            <MatrixTable mode="override" resources={resources} overrides={board} inherited={inherited}
                         editable={!saving} lockedResources={locked} onCycle={cycle} />
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn-solid" onClick={save} disabled={saving || !board}>
            {saving ? 'Saving…' : 'Save overrides'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

`src/pages/UserDetail.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';
import MatrixTable from '@portal/components/access/MatrixTable';
import type { Action } from '@portal/lib/access';
import type { AccessResourceOut } from '@portal/lib/api';

import OverridesModal from '../components/OverridesModal';
import {
  errorText, getAccessSummary, getUser, revokeSessions, type UserDetail as Detail,
} from '../lib/sirdarApi';

export default function UserDetail() {
  const { personId = '' } = useParams();
  const { can, person } = useAuth();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [resources, setResources] = useState<AccessResourceOut[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    getUser(personId).then(setDetail).catch((e) => setError(errorText(e, "Couldn't load this user.")));
  }, [personId]);

  useEffect(() => {
    load();
    getAccessSummary().then((s) => setResources(s.resources)).catch(() => {});
  }, [load]);

  if (error) return <div className="portal-page"><p className="form-error" role="alert">{error}</p></div>;
  if (!detail) return null;
  const u = detail.user;
  const isSelf = person?.id === u.person_id;
  const inherited = Object.fromEntries(Object.entries(detail.cells).map(([res, acts]) => [
    res, Object.fromEntries(Object.entries(acts).map(([a, c]) => [a, c.value])) as Record<Action, boolean>,
  ]));

  const revoke = async () => {
    try {
      const r = await revokeSessions(u.person_id);
      setNotice(`Signed out of ${r.revoked} session${r.revoked === 1 ? '' : 's'}.`);
      load();
    } catch (e) {
      setError(errorText(e, "Couldn't revoke sessions."));
    }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow"><Link to="/admin/users">Users</Link></div>
      <div className="dir-head">
        <h1>{u.display_name}</h1>
        <p>{u.email} · {u.source === 'portal' ? 'Copied from the portal' : 'Local Sirdar user'}
          {u.disabled_at ? ' · Disabled' : ''}</p>
      </div>
      {notice && <p className="page-hint" role="status">{notice}</p>}

      <section className="sirdar-section">
        <h2>Roles</h2>
        <p>{u.roles.length ? u.roles.join(', ') : 'No roles'} {u.source === 'portal' && <span className="page-hint">(managed in the portal)</span>}</p>
      </section>

      <section className="sirdar-section">
        <div className="sirdar-section-head">
          <h2>Access</h2>
          {can('access', 'change') && detail.can_manage && !isSelf && (
            <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>Edit overrides</button>
          )}
        </div>
        {resources.length > 0 && (
          <MatrixTable mode="effective" resources={resources} cells={detail.cells} editable={false} />
        )}
      </section>

      <section className="sirdar-section">
        <div className="sirdar-section-head">
          <h2>Sessions</h2>
          {can('users', 'change') && detail.can_manage && detail.sessions.length > 0 && (
            <button type="button" className="btn-ghost danger" onClick={revoke}>Sign out everywhere</button>
          )}
        </div>
        <DataTable
          ariaLabel="Active sessions"
          columns={[{ key: 'started', label: 'Started' }, { key: 'expires', label: 'Expires' },
                    { key: 'ip', label: 'IP', mono: true }, { key: 'agent', label: 'Browser' }]}
          rows={detail.sessions.map((s) => ({
            key: s.id,
            cells: [new Date(s.created_at).toLocaleString(), new Date(s.expires_at).toLocaleString(),
                    s.ip_address ?? '—', s.user_agent ?? '—'],
          }))}
          emptyText="No active sessions."
        />
      </section>

      {editing && (
        <OverridesModal personId={u.person_id} name={u.display_name} resources={resources}
                        inherited={inherited} onClose={() => setEditing(false)}
                        onSaved={() => { setEditing(false); load(); }} />
      )}
    </div>
  );
}
```

Add to `sirdar.css`:
```css
.sirdar-section { margin: 24px 0; }
.sirdar-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
```

`src/pages/Dashboard.tsx`:
```tsx
import { useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { listImportRuns, listUsers, type ImportRun, type UserRow } from '../lib/sirdarApi';

export default function Dashboard() {
  const { person, roles, can } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [lastRun, setLastRun] = useState<ImportRun | null | undefined>(undefined);

  useEffect(() => {
    if (!can('users', 'view')) return;
    listUsers().then(setUsers).catch(() => {});
    listImportRuns().then((r) => setLastRun(r[0] ?? null)).catch(() => {});
  }, [can]);

  const active = users?.filter((u) => !u.disabled_at).length;

  return (
    <div className="portal-page">
      <div className="eyebrow">Sirdar</div>
      <div className="dir-head">
        <h1>Dashboard</h1>
        <p>Build, install and manage ServerSherpa environments.</p>
      </div>
      <div className="sirdar-cards">
        <div className="sirdar-card">
          <h3>Signed in as</h3>
          <p>{person?.display_name}</p>
          <p className="page-hint">{roles.join(', ')}</p>
        </div>
        {users && (
          <div className="sirdar-card">
            <h3>Users</h3>
            <p>{active} active of {users.length}</p>
          </div>
        )}
        {lastRun !== undefined && (
          <div className="sirdar-card">
            <h3>Last import</h3>
            {lastRun
              ? <p>{lastRun.status === 'ok' ? 'Finished' : 'Failed'} · {new Date(lastRun.started_at).toLocaleString()}</p>
              : <p>Never run</p>}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm --prefix sirdar/web test && npx --prefix sirdar/web tsc -p sirdar/web/tsconfig.json --noEmit`
Expected: pass. Add `lib/listTools` to the allowlist only if the guardrail rejects it. It is a `.tsx` under `lib/` that imports React, so it needs an allowlist entry: add `'lib/listTools'`.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web
git commit -m "feat(sirdar): users list with import summary, user detail with access and sessions"
```

---

### Task 14: Roles & access, Audit log, Settings and My preferences pages

**Files:**
- Modify: `sirdar/web/src/pages/Access.tsx`, `Audit.tsx`, `Settings.tsx`, `Me.tsx`
- Test: `sirdar/web/src/pages/Access.test.tsx`

**Interfaces:**
- Consumes:
  - `sirdarApi`: `getAccessSummary`, `putRoleMatrix`, `listAudit`, `getAuditFacets`, `getSettings`, `errorText`
  - `useAuth`: `can`, `maxRank`, `roles`, `person`, `preferences`, `updatePreferences`
  - `@portal/lib/access` (`canTouchRank`, `ACTIONS`)
  - `@portal/lib/settings` (`NAV_BACKGROUNDS`)
  - `@portal/components/ComboBox`

- [ ] **Step 1: Write the failing test**

`src/pages/Access.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, maxRank: 80, roles: ['super_admin'] }),
}));
const putRoleMatrix = vi.fn().mockResolvedValue({ role: 'admin', grants: 5 });
const full = (on: string[]) => Object.fromEntries(['view', 'add', 'change', 'delete'].map((a) => [a, on.includes(a)]));
vi.mock('../lib/sirdarApi', async (orig) => ({
  ...(await orig<typeof import('../lib/sirdarApi')>()),
  putRoleMatrix,
  getAccessSummary: vi.fn().mockResolvedValue({
    resources: [{ id: 'users', label: 'Users', developer_only: false, always_viewable: false, gated_by: [] },
                { id: 'access', label: 'Roles & access', developer_only: false, always_viewable: false, gated_by: [] }],
    roles: [
      { name: 'super_admin', label: 'Super admin', color: null, rank: 80, member_count: 1,
        matrix: { users: full(['view']), access: full(['view', 'change']) } },
      { name: 'admin', label: 'Administrator', color: null, rank: 60, member_count: 2,
        matrix: { users: full(['view']), access: full(['view']) } },
    ],
  }),
}));

import Access from './Access';

afterEach(cleanup);

it('own role is read-only; a lower role can be edited and saved', async () => {
  render(<Access />);
  await waitFor(() => expect(screen.getByRole('tab', { name: /super admin/i })).toBeTruthy());
  expect(screen.getByText(/you hold this role/i)).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: /administrator/i }));
  await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
  expect(putRoleMatrix).toHaveBeenCalledWith('admin', expect.objectContaining({ users: expect.any(Object) }));
});
```

- [ ] **Step 2: Run to fail**

Run: `npm --prefix sirdar/web test -- src/pages/Access.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the pages**

`src/pages/Access.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import MatrixTable from '@portal/components/access/MatrixTable';
import { ACTIONS, canTouchRank, type Action } from '@portal/lib/access';

import { errorText, getAccessSummary, putRoleMatrix, type AccessSummary } from '../lib/sirdarApi';

type Matrix = Record<string, Record<Action, boolean>>;

export default function Access() {
  const { can, maxRank, roles: myRoles } = useAuth();
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<Matrix | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(() => {
    getAccessSummary().then((s) => {
      setSummary(s);
      setSelected((cur) => cur || s.roles[0]?.name || '');
    }).catch((e) => setMessage(errorText(e, "Couldn't load roles.")));
  }, []);

  useEffect(load, [load]);

  const role = summary?.roles.find((r) => r.name === selected);
  useEffect(() => { setDraft(role ? structuredClone(role.matrix) : null); }, [role]);
  if (!summary || !role || !draft) return message ? <p className="form-error">{message}</p> : null;

  const holds = myRoles.includes(role.name);
  const editable = can('access', 'change') && canTouchRank(maxRank, role.rank) && !holds && !saving;
  const locked = new Set(summary.resources.filter((r) => r.developer_only && role.name !== 'developer').map((r) => r.id));
  const dirty = JSON.stringify(draft) !== JSON.stringify(role.matrix);

  const toggle = (res: string, action: Action) =>
    setDraft((d) => d && { ...d, [res]: { ...d[res], [action]: !d[res][action] } });
  const toggleColumn = (action: Action) => setDraft((d) => {
    if (!d) return d;
    const open = summary.resources.filter((r) => !locked.has(r.id));
    const allOn = open.every((r) => d[r.id]?.[action]);
    const next = { ...d };
    for (const r of open) {
      if (r.id === 'access' && action === 'view') continue;
      next[r.id] = { ...next[r.id], [action]: !allOn };
    }
    return next;
  });

  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      await putRoleMatrix(role.name, draft);
      setMessage(`Saved ${role.label}.`);
      load();
    } catch (e) {
      setMessage(errorText(e, "Couldn't save the role."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Administration</div>
      <div className="dir-head">
        <h1>Roles &amp; access</h1>
        <p>What each role can do in Sirdar. Per-person overrides live on each user's page.</p>
      </div>
      <div className="segmented" role="tablist" aria-label="Roles">
        {summary.roles.map((r) => (
          <button key={r.name} type="button" role="tab" aria-selected={r.name === selected}
                  className={r.name === selected ? 'on' : ''} onClick={() => setSelected(r.name)}>
            {r.label} <span className="page-hint">({r.member_count})</span>
          </button>
        ))}
      </div>
      {holds && <p className="page-hint">You hold this role, so you can't change it.</p>}
      {!holds && !canTouchRank(maxRank, role.rank) && <p className="page-hint">This role outranks you.</p>}
      <MatrixTable mode="role" resources={summary.resources} matrix={draft} editable={editable}
                   lockedResources={locked} lockedCells={new Set(['access:view'])}
                   onToggle={toggle} onToggleColumn={toggleColumn} />
      {message && <p className="page-hint" role="status">{message}</p>}
      {editable && (
        <div className="sirdar-actions">
          <button type="button" className="btn-ghost" disabled={!dirty || saving}
                  onClick={() => setDraft(structuredClone(role.matrix))}>Reset</button>
          <button type="button" className="btn-solid" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}
```

The test clicks "Save changes" without toggling anything, which would leave the button disabled. In the test, first click one cell (for example the `users` / `add` checkbox: query `screen.getAllByRole('button')` within the matrix, or click the column toggle) so `dirty` is true. Adjust the test to toggle a cell before saving; do not drop the dirty guard. `ACTIONS` is imported for the column toggle's typing; remove it if unused.

`src/pages/Audit.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';
import DataTable from '@portal/components/DataTable';

import { errorText, getAuditFacets, listAudit, type AuditItem } from '../lib/sirdarApi';

const PAGE = 100;

export default function Audit() {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [facets, setFacets] = useState<{ entity_types: string[]; actions: string[] }>({ entity_types: [], actions: [] });
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback((offset: number) => {
    listAudit({ entity_type: entityType, action, offset, limit: PAGE })
      .then((rows) => {
        setItems((cur) => (offset === 0 ? rows : [...cur, ...rows]));
        setMore(rows.length === PAGE);
      })
      .catch((e) => setError(errorText(e, "Couldn't load the audit log.")));
  }, [entityType, action]);

  useEffect(() => { load(0); }, [load]);
  useEffect(() => { getAuditFacets().then(setFacets).catch(() => {}); }, []);

  return (
    <div className="portal-page">
      <div className="eyebrow">Administration</div>
      <div className="dir-head">
        <h1>Audit log</h1>
        <p>Every sign-in, import and permission change in Sirdar, newest first.</p>
      </div>
      <div className="dir-toolbar">
        <ComboBox ariaLabel="Record type" placeholder="All record types" clearable value={entityType}
                  onChange={setEntityType}
                  options={facets.entity_types.map((t) => ({ value: t, label: t }))} />
        <ComboBox ariaLabel="Action" placeholder="All actions" clearable value={action}
                  onChange={setAction}
                  options={facets.actions.map((a) => ({ value: a, label: a }))} />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="Audit log"
        columns={[{ key: 'at', label: 'When' }, { key: 'actor', label: 'Who' },
                  { key: 'action', label: 'Action', mono: true }, { key: 'entity', label: 'Record' },
                  { key: 'ip', label: 'IP', mono: true }]}
        rows={items.map((i) => ({
          key: String(i.id),
          cells: [new Date(i.at).toLocaleString(), i.actor_name ?? '—', i.action,
                  `${i.entity_type}${i.entity_id ? ` · ${i.entity_id}` : ''}`, i.ip ?? '—'],
        }))}
        emptyText="Nothing recorded yet."
      />
      {more && (
        <button type="button" className="btn-ghost" onClick={() => load(items.length)}>Load more</button>
      )}
    </div>
  );
}
```

Confirm the ComboBox prop names (`ariaLabel`, `clearable`, `onChange(value: string)`) against `portal/src/components/ComboBox.tsx` before relying on them.

`src/pages/Settings.tsx`:
```tsx
import { useEffect, useState } from 'react';

import { errorText, getSettings, type SirdarSettings } from '../lib/sirdarApi';

const minutes = (s: number) => `${Math.round(s / 60)} min`;

export default function Settings() {
  const [s, setS] = useState<SirdarSettings | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { getSettings().then(setS).catch((e) => setError(errorText(e, "Couldn't load settings."))); }, []);
  return (
    <div className="portal-page">
      <div className="eyebrow">System</div>
      <div className="dir-head">
        <h1>Settings</h1>
        <p>How this Sirdar is configured. These come from the server's environment.</p>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {s && (
        <div className="sirdar-kv">
          <span>Environment</span><span>{s.env}</span>
          <span>Portal database</span><span>{s.source_configured ? 'Configured' : 'Not configured'}</span>
          <span>Session lifetime</span><span>{Math.round(s.session_ttl_seconds / 3600)} h</span>
          <span>Access token lifetime</span><span>{minutes(s.access_token_ttl_seconds)}</span>
          <span>Lockout</span><span>{s.max_failed_logins} failures → {minutes(s.lockout_seconds)}</span>
        </div>
      )}
    </div>
  );
}
```

`src/pages/Me.tsx`:
```tsx
import { useAuth } from '@portal/auth/AuthContext';
import type { UiPreferences } from '@portal/lib/api';
import { NAV_BACKGROUNDS } from '@portal/lib/settings';

const SIZES: UiPreferences['nav_size'][] = ['small', 'default', 'large', 'xlarge'];
const MODES: [UiPreferences['nav_mode'], string][] = [['expanded', 'Expanded'], ['rail', 'Icons only'], ['hidden', 'Hidden']];

export default function Me() {
  const { person, roles, preferences, updatePreferences } = useAuth();
  const set = (patch: Partial<UiPreferences>) => void updatePreferences({ ...preferences, ...patch });

  return (
    <div className="portal-page">
      <div className="eyebrow">Account</div>
      <div className="dir-head">
        <h1>{person?.display_name}</h1>
        <p>{person?.email} · {roles.join(', ')}</p>
      </div>
      <p className="page-hint">Your name, email and password come from the portal (or the Sirdar CLI for local users).</p>

      <section className="sirdar-section">
        <h2>Navigation</h2>
        <div className="sirdar-kv">
          <span>Sidebar</span>
          <div className="segmented" role="radiogroup" aria-label="Sidebar">
            {MODES.map(([m, label]) => (
              <button key={m} type="button" role="radio" aria-checked={preferences.nav_mode === m}
                      className={preferences.nav_mode === m ? 'on' : ''} onClick={() => set({ nav_mode: m })}>{label}</button>
            ))}
          </div>
          <span>Text size</span>
          <div className="segmented" role="radiogroup" aria-label="Navigation text size">
            {SIZES.map((sz) => (
              <button key={sz} type="button" role="radio" aria-checked={preferences.nav_size === sz}
                      className={preferences.nav_size === sz ? 'on' : ''} onClick={() => set({ nav_size: sz })}>{sz}</button>
            ))}
          </div>
          <span>Background</span>
          <div className="segmented" role="radiogroup" aria-label="Navigation background">
            <button type="button" role="radio" aria-checked={preferences.nav_bg === 'default'}
                    className={preferences.nav_bg === 'default' ? 'on' : ''} onClick={() => set({ nav_bg: 'default' })}>Default</button>
            {NAV_BACKGROUNDS.map((b) => (
              <button key={b.key} type="button" role="radio" aria-checked={preferences.nav_bg === b.key}
                      className={preferences.nav_bg === b.key ? 'on' : ''} onClick={() => set({ nav_bg: b.key })}>{b.label}</button>
            ))}
          </div>
        </div>
      </section>

      <section className="sirdar-section">
        <h2>Lists</h2>
        <div className="segmented" role="radiogroup" aria-label="List text size">
          {SIZES.map((sz) => (
            <button key={sz} type="button" role="radio" aria-checked={preferences.list_size === sz}
                    className={preferences.list_size === sz ? 'on' : ''} onClick={() => set({ list_size: sz })}>{sz}</button>
          ))}
        </div>
      </section>
    </div>
  );
}
```

Add to `sirdar.css`:
```css
.sirdar-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm --prefix sirdar/web test && npx --prefix sirdar/web tsc -p sirdar/web/tsconfig.json --noEmit && npm --prefix sirdar/web run build`
Expected: tests pass, no type errors, and the build writes `sirdar/web/dist/index.html` plus `dist/images/serversherpa-logo.png` (from `publicDir`).

- [ ] **Step 5: Commit**

```bash
git add sirdar/web
git commit -m "feat(sirdar): roles & access matrix, audit log, settings and my-preferences pages"
```

---

### Task 15: Docker image, compose, install script, dev wiring and README

**Files:**
- Create: `sirdar/Dockerfile`, `sirdar/docker-entrypoint.sh`, `sirdar/docker-compose.yml`, `sirdar/install.sh`, `sirdar/.env.example`, `sirdar/README.md`
- Modify: `.claude/launch.json` (add `sirdar-api` and `sirdar-web`)
- Test: `docker build` plus a container smoke test (commands below)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - Image `sirdar` (build context = repo root). `CMD serve` runs `alembic upgrade head`, then uvicorn on 8080 serving `/api/*` and the SPA. Any other args go to the `sirdar` CLI: `docker compose run --rm sirdar import-users`.

- [ ] **Step 1: Files**

`sirdar/Dockerfile`:
```dockerfile
# Sirdar — one image: the FastAPI app serves /api and the built SPA.
# Build context is the REPO ROOT (the SPA imports portal/src + portal/public):
#   docker build -f sirdar/Dockerfile -t sirdar .
FROM node:20-alpine AS web
WORKDIR /app
COPY sirdar/web/package.json sirdar/web/package-lock.json ./sirdar/web/
RUN npm ci --prefix sirdar/web
COPY portal/src ./portal/src
COPY portal/public ./portal/public
COPY sirdar/web ./sirdar/web
RUN npm --prefix sirdar/web run build

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SIRDAR_STATIC_DIR=/app/static
WORKDIR /app/api
COPY sirdar/api/pyproject.toml ./
COPY sirdar/api/src ./src
RUN pip install --no-cache-dir .
COPY sirdar/api/alembic.ini ./
COPY sirdar/api/migrations ./migrations
COPY --from=web /app/sirdar/web/dist /app/static
COPY sirdar/docker-entrypoint.sh /usr/local/bin/sirdar-entrypoint
RUN chmod 755 /usr/local/bin/sirdar-entrypoint && useradd --system --uid 10001 sirdar
USER sirdar
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"
ENTRYPOINT ["sirdar-entrypoint"]
CMD ["serve"]
```

`sirdar/docker-entrypoint.sh`:
```sh
#!/bin/sh
# `serve` (default): migrate, then run the API + SPA on :8080.
# Anything else is a sirdar CLI command, e.g. `import-users`, `create-admin …`.
set -e
if [ "${1:-serve}" = "serve" ]; then
  cd /app/api
  alembic upgrade head
  exec uvicorn --factory sirdar_api.api.app:create_app --host 0.0.0.0 --port 8080 \
    --proxy-headers --forwarded-allow-ips='*'
fi
exec sirdar "$@"
```

`sirdar/docker-compose.yml`:
```yaml
# Sirdar — two containers: the app (API + SPA) and its own Postgres.
#   cp sirdar/.env.example sirdar/.env   # then edit it
#   docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env up -d --build
#   docker compose -f sirdar/docker-compose.yml run --rm sirdar create-admin --email … --first-name … --last-name …
#   docker compose -f sirdar/docker-compose.yml run --rm sirdar import-users
name: sirdar

services:
  sirdar:
    build:
      context: ..
      dockerfile: sirdar/Dockerfile
    env_file: .env
    environment:
      SIRDAR_DATABASE_URL: postgresql+asyncpg://sirdar:${SIRDAR_DB_PASSWORD:?set SIRDAR_DB_PASSWORD in sirdar/.env}@sirdar-db:5432/sirdar
    ports:
      - "127.0.0.1:${SIRDAR_PORT:-8098}:8080"   # put the reverse proxy in front
    depends_on:
      sirdar-db:
        condition: service_healthy
    restart: unless-stopped

  sirdar-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: sirdar
      POSTGRES_PASSWORD: ${SIRDAR_DB_PASSWORD:?set SIRDAR_DB_PASSWORD in sirdar/.env}
      POSTGRES_DB: sirdar
    volumes:
      - sirdar-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sirdar -d sirdar"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

volumes:
  sirdar-db:
```

`sirdar/.env.example`:
```bash
# ── Sirdar ──────────────────────────────────────────────────────────
SIRDAR_ENV=production
# Password for Sirdar's own Postgres (docker-compose builds the URL from it).
SIRDAR_DB_PASSWORD=change-me
# Host port the app listens on (behind your reverse proxy).
SIRDAR_PORT=8098
# Long random string: python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
SIRDAR_JWT_SECRET=
# The portal's Postgres, used ONLY by "Import from portal" (read only).
# Prefer a role that can only SELECT people, user_accounts, roles,
# person_roles, access_groups, access_group_members, totp_backup_codes,
# system_config. Leave empty to disable the import.
SIRDAR_SOURCE_DATABASE_URL=
# Cookie domain for the refresh cookie; empty = this host only.
SIRDAR_COOKIE_DOMAIN=

# ── Must equal the portal's values ─────────────────────────────────
# Copied password hashes and 2FA seeds only verify with these.
SS_PASSWORD_PEPPER=
SS_TOTP_ENCRYPTION_KEY=
```

`sirdar/install.sh` (mode 755):
```bash
#!/usr/bin/env bash
# Install or update Sirdar from GitHub with a sparse checkout (sirdar/ plus
# the portal files its SPA imports). Run as a user who can use docker.
#   SIRDAR_DIR=/opt/sirdar SIRDAR_BRANCH=sirdar ./install.sh
set -euo pipefail
REPO=${SIRDAR_REPO:-https://github.com/jrh1812/BaseCampV3.git}
DIR=${SIRDAR_DIR:-/opt/sirdar}
BRANCH=${SIRDAR_BRANCH:-sirdar}

if [[ ! -d "$DIR/.git" ]]; then
  git clone --filter=blob:none --no-checkout --branch "$BRANCH" "$REPO" "$DIR"
  git -C "$DIR" sparse-checkout init --cone
  git -C "$DIR" sparse-checkout set sirdar portal/src portal/public
  git -C "$DIR" checkout "$BRANCH"
else
  git -C "$DIR" fetch origin "$BRANCH"
  git -C "$DIR" checkout "$BRANCH"
  git -C "$DIR" reset --hard "origin/$BRANCH"
fi

if [[ ! -f "$DIR/sirdar/.env" ]]; then
  cp "$DIR/sirdar/.env.example" "$DIR/sirdar/.env"
  chmod 600 "$DIR/sirdar/.env"
  echo "Created $DIR/sirdar/.env — fill it in, then re-run this script."
  exit 0
fi

docker compose -f "$DIR/sirdar/docker-compose.yml" --env-file "$DIR/sirdar/.env" up -d --build
echo "Sirdar is starting on 127.0.0.1:\${SIRDAR_PORT:-8098}."
```

Before writing `REPO`, check the actual GitHub remote with `git remote get-url origin` and use that URL.

`sirdar/README.md`: write a short guide in American English with these sections:
- **What Sirdar is:** one paragraph from the spec's Purpose.
- **Local development:**
  1. `docker compose -f docker-compose.dev.yml up -d sirdar-db`
  2. `sirdar/scripts/dev-env.sh`
  3. `cd sirdar/api && python3.13 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/alembic upgrade head`
  4. API: `.venv/bin/uvicorn --factory sirdar_api.api.app:create_app --port 8097 --reload`
  5. Web: `npm --prefix sirdar/web install && npm --prefix sirdar/web run dev` (http://localhost:5178)
  6. `sirdar/api/.venv/bin/sirdar import-users`
- **Tests:** the API and web commands from Global Constraints.
- **First sign-in:** `create-admin` vs `import-users`.
- **Deploy:** `install.sh` and the compose commands.
- **Security notes:** the pepper and TOTP key must match the portal, use a read-only source role, and local users have no 2FA.

`.claude/launch.json`: add two configurations to the existing array (keep the others):
```json
{ "name": "sirdar-api", "runtimeExecutable": "sirdar/api/.venv/bin/uvicorn",
  "runtimeArgs": ["--factory", "sirdar_api.api.app:create_app", "--app-dir", "sirdar/api/src", "--host", "0.0.0.0", "--port", "8097", "--reload"],
  "port": 8097 },
{ "name": "sirdar-web", "runtimeExecutable": "npm", "runtimeArgs": ["--prefix", "sirdar/web", "run", "dev"], "port": 5178 }
```

- [ ] **Step 2: Build and smoke-test the image**

Run from the worktree root:

```bash
docker build -f sirdar/Dockerfile -t sirdar:dev .
```
Expected: the build succeeds.

Then smoke-test it against the dev `sirdar-db`. This creates a throwaway database and leaves the dev and test databases untouched:
```bash
docker exec $(docker compose -f docker-compose.dev.yml ps -q sirdar-db) \
  psql -U sirdar -d postgres -c 'DROP DATABASE IF EXISTS sirdar_smoke' -c 'CREATE DATABASE sirdar_smoke'
docker run --rm -d --name sirdar-smoke -p 127.0.0.1:8099:8080 \
  -e SIRDAR_ENV=development \
  -e SIRDAR_DATABASE_URL=postgresql+asyncpg://sirdar:sirdar@host.docker.internal:5434/sirdar_smoke \
  -e SIRDAR_JWT_SECRET=smoke-secret-0123456789abcdef0123456789 \
  -e SS_PASSWORD_PEPPER=smoke -e SS_TOTP_ENCRYPTION_KEY=$(python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())') \
  sirdar:dev
sleep 8
curl -s localhost:8099/healthz
curl -s localhost:8099/api/system/status
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' localhost:8099/admin/users
curl -s -o /dev/null -w '%{http_code}\n' localhost:8099/images/serversherpa-logo.png
docker stop sirdar-smoke
```

Expected:
- `{"status":"ok"}`
- `{... "needs_setup":true}`
- `200 text/html; charset=utf-8` (the SPA fallback)
- `200` for the logo

If `python3` lacks `cryptography`, generate the key with `sirdar/api/.venv/bin/python` instead.

- [ ] **Step 3: Commit**

```bash
git add sirdar .claude/launch.json
git commit -m "feat(sirdar): Docker image (API + SPA), compose with own Postgres, install script, README"
```

---

### Task 16: Live verification (controller)

The controller runs this task (not a subagent), following the dev-workflow memory. It verifies the whole flow against the real dev portal database and fixes anything found before declaring the work done.

- [ ] **Step 1:** Start the Sirdar API and web:
  - `preview_start` `sirdar-api` and `sirdar-web` (launch.json from Task 15).
  - Check that `curl -s localhost:8097/api/healthz` returns ok.
- [ ] **Step 2:** Run the import against the dev portal database:
  - `sirdar/api/.venv/bin/sirdar import-users`.
  - Confirm the printed summary lists the dev developer/admin accounts and nobody below rank 60. Spot-check with a read-only `psql` query on the portal DB (5433): `person_roles` joined to `roles` where `rank >= 60`.
- [ ] **Step 3:** Sign in at http://localhost:5178/login with a dev login from the dev-workflow memory that holds rank ≥ 60. Confirm:
  - the Sirdar eyebrow and scene tag appear;
  - the 2FA step appears if that account is enrolled in the portal;
  - the shell renders with the Sirdar-tagged nav;
  - Ctrl/⌘+B cycles expanded → rail → hidden.
- [ ] **Step 4:** Exercise each page:
  - **Users:** the list loads, then "Import from portal" opens the summary modal and the CSV downloads.
  - **User detail:** the effective matrix and sessions load.
  - **Roles & access:** your own role is read-only and a lower role is editable.
  - **Audit log:** shows the logins and the import.
  - **Settings**, and **My preferences** (change nav size, reload, and confirm it persisted).
- [ ] **Step 5:** Run the negative checks:
  - A wrong password shows the portal's message.
  - In `sirdar/api/.venv/bin/python`, set a Sirdar user's `must_change_password = true` in the **sirdar** dev DB. That account then shows the "Update it in the portal" message. Reset it afterwards.
  - A `staff` portal user cannot sign in, because they were never imported (`invalid_credentials`).
- [ ] **Step 6:** Run every suite once more in the foreground:
  - `cd sirdar/api && .venv/bin/pytest -q`
  - `npm --prefix sirdar/web test`
  - `npm --prefix portal test`

  Take a screenshot of the Users page with the import summary open as proof.
- [ ] **Step 7:** Commit any fixes found during verification. Then update the `sirdar` memory file with:
  - status (built, unmerged)
  - commit SHA
  - the live-verify recipe
  - deferred items: environment building, scheduled sync, access groups, trusted devices, local-user 2FA
