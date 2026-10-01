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
    contact_email: Mapped[str | None]
    phone: Mapped[str | None]
    address_line1: Mapped[str | None]
    address_line2: Mapped[str | None]
    city: Mapped[str | None]
    region: Mapped[str | None]
    postal_code: Mapped[str | None]
    country: Mapped[str] = mapped_column(server_default=text("'US'"))
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
