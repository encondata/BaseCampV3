"""SQLAlchemy models. The schema of record is the Alembic migrations;
these models mirror them for application queries."""

import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, Date, ForeignKey, Integer, Text, text
from sqlalchemy.dialects.postgresql import BYTEA, CITEXT, INET, JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    type_annotation_map = {
        uuid.UUID: UUID(as_uuid=True),
        datetime: TIMESTAMP(timezone=True),
        str: Text,
    }


class Person(Base):
    __tablename__ = "people"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    first_name: Mapped[str]
    last_name: Mapped[str]
    preferred_name: Mapped[str | None]
    email: Mapped[str | None] = mapped_column(CITEXT)
    phone: Mapped[str | None]
    job_title: Mapped[str | None]
    address_line1: Mapped[str | None]
    address_line2: Mapped[str | None]
    city: Mapped[str | None]
    region: Mapped[str | None]
    postal_code: Mapped[str | None]
    country: Mapped[str] = mapped_column(server_default="US")
    external_id: Mapped[str | None]
    badge_uid: Mapped[uuid.UUID] = mapped_column(
        server_default=text("gen_random_uuid()"))
    rfid_tag: Mapped[str | None]
    avatar_key: Mapped[str | None]
    notes: Mapped[str | None]
    source: Mapped[str] = mapped_column(server_default="manual")
    source_ref: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    account: Mapped["UserAccount | None"] = relationship(
        back_populates="person", foreign_keys="UserAccount.person_id")
    role_grants: Mapped[list["PersonRole"]] = relationship(
        back_populates="person", foreign_keys="PersonRole.person_id")

    @property
    def display_name(self) -> str:
        return f"{self.preferred_name or self.first_name} {self.last_name}"


class UserAccount(Base):
    __tablename__ = "user_accounts"

    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("people.id"), primary_key=True)
    email: Mapped[str] = mapped_column(CITEXT)
    password_hash: Mapped[str | None]
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, server_default=text("false"))
    password_updated_at: Mapped[datetime | None]
    totp_secret_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    totp_confirmed_at: Mapped[datetime | None]
    failed_login_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    locked_until: Mapped[datetime | None]
    last_login_at: Mapped[datetime | None]
    last_login_ip: Mapped[str | None] = mapped_column(INET)
    disabled_at: Mapped[datetime | None]
    ui_prefs: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    person: Mapped[Person] = relationship(
        back_populates="account", foreign_keys=[person_id])


class OrgColumns:
    """Shared shape for stakeholder organizations (clients, partners)."""

    phone: Mapped[str | None]
    website: Mapped[str | None]
    address_line1: Mapped[str | None]
    address_line2: Mapped[str | None]
    city: Mapped[str | None]
    region: Mapped[str | None]
    postal_code: Mapped[str | None]
    country: Mapped[str] = mapped_column(server_default="US")
    status: Mapped[str] = mapped_column(server_default="active")
    tier: Mapped[str] = mapped_column(server_default="standard")
    account_manager: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    logo_key: Mapped[str | None]


class Client(OrgColumns, Base):
    __tablename__ = "clients"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    code: Mapped[str | None] = mapped_column(CITEXT)
    notes: Mapped[str | None]
    source: Mapped[str] = mapped_column(server_default="manual")
    source_ref: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Partner(OrgColumns, Base):
    __tablename__ = "partners"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    code: Mapped[str | None] = mapped_column(CITEXT)
    partner_types: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb"))
    notes: Mapped[str | None]
    source: Mapped[str] = mapped_column(server_default="manual")
    source_ref: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Role(Base):
    __tablename__ = "roles"

    name: Mapped[str] = mapped_column(primary_key=True)
    description: Mapped[str]
    rank: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    scope_anchor: Mapped[str] = mapped_column(server_default="global")
    is_system: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    label: Mapped[str | None]
    color: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class PersonRole(Base):
    __tablename__ = "person_roles"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    role: Mapped[str] = mapped_column(ForeignKey("roles.name"))
    client_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clients.id"))
    partner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("partners.id"))
    granted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    granted_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    revoked_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    person: Mapped[Person] = relationship(
        back_populates="role_grants", foreign_keys=[person_id])


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_accounts.person_id"))
    family_id: Mapped[uuid.UUID]
    token_hash: Mapped[str]
    expires_at: Mapped[datetime]
    rotated_at: Mapped[datetime | None]
    replaced_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("auth_sessions.id"))
    revoked_at: Mapped[datetime | None]
    revoke_reason: Mapped[str | None]
    ip_address: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    entity_type: Mapped[str]
    entity_id: Mapped[uuid.UUID]
    kind: Mapped[str]
    storage_key: Mapped[str]
    filename: Mapped[str]
    content_type: Mapped[str]
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    deleted_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class WorkerLevel(Base):
    __tablename__ = "worker_levels"

    level: Mapped[str] = mapped_column(primary_key=True)
    rank: Mapped[int] = mapped_column(Integer)
    title: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    expected_skills: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class WorkerProfile(Base):
    __tablename__ = "worker_profiles"

    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("people.id"), primary_key=True)
    partner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("partners.id"))
    trade: Mapped[str | None]
    level: Mapped[str | None] = mapped_column(ForeignKey("worker_levels.level"))
    status: Mapped[str] = mapped_column(server_default="active")
    status_note: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class WorkerCertification(Base):
    __tablename__ = "worker_certifications"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    name: Mapped[str]
    issuer: Mapped[str | None]
    issued_on: Mapped[date | None] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role: Mapped[str] = mapped_column(
        ForeignKey("roles.name", ondelete="CASCADE"), primary_key=True)
    resource: Mapped[str] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(primary_key=True)


class AccessGroup(Base):
    __tablename__ = "access_groups"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    icon: Mapped[str] = mapped_column(server_default="users")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AccessGroupMember(Base):
    __tablename__ = "access_group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("access_groups.id", ondelete="CASCADE"), primary_key=True)
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("people.id"), primary_key=True)
    added_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    added_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ResourceGroupGate(Base):
    __tablename__ = "resource_group_gates"

    resource: Mapped[str] = mapped_column(primary_key=True)
    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("access_groups.id", ondelete="CASCADE"), primary_key=True)


class PermissionOverride(Base):
    __tablename__ = "permission_overrides"

    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("people.id"), primary_key=True)
    resource: Mapped[str] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(primary_key=True)
    allow: Mapped[bool] = mapped_column(Boolean)
    set_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    set_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    actor_person_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    entity_type: Mapped[str]
    entity_id: Mapped[str | None]
    action: Mapped[str]
    changes: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    ip: Mapped[str | None] = mapped_column(INET)
    at: Mapped[datetime] = mapped_column(server_default=text("now()"))
