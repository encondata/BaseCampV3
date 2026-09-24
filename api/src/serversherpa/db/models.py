"""SQLAlchemy models. The schema of record is the Alembic migrations;
these models mirror them for application queries."""

import uuid
from datetime import date, datetime, time
from decimal import Decimal

from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, Date, ForeignKey, Identity, Integer, Numeric,
    SmallInteger, String, Text, Time, text,
)
from sqlalchemy.dialects.postgresql import ARRAY, BYTEA, CITEXT, INET, JSONB, TIMESTAMP, UUID
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
    totp_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    totp_last_counter: Mapped[int | None] = mapped_column(BigInteger)
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
    account_manager: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    logo_key: Mapped[str | None]


class Client(OrgColumns, Base):
    __tablename__ = "clients"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    code: Mapped[str | None] = mapped_column(CITEXT)
    tier: Mapped[str] = mapped_column(server_default="standard")
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
    # keys under status_values record_type='partner_type'; API-validated
    # (composite FK can't cover arrays) — see initiatives.shipping_types
    partner_types: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{}'::text[]"))
    # freeform, unlike Client.tier — partners aren't tiered, they just
    # record which regions they service; NULL = unrecorded
    service_region: Mapped[str | None]
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
    totp_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
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


class ContactProfile(Base):
    """Per-org contact metadata (org_title + function tags), independent of
    person_roles so tier revoke+regrant never touches it. Exactly one of
    client_id/partner_id is set; unique-per-(person, org) is enforced by
    partial indexes in the migration, not by this table's declared PK."""

    __tablename__ = "contact_profiles"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    client_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clients.id"))
    partner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("partners.id"))
    org_title: Mapped[str | None]
    functions: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


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
    # which app minted the login: "portal" | "kiosk". A kiosk login skips
    # the 2FA challenge, so its session is held to the kiosk routes.
    client: Mapped[str] = mapped_column(server_default="portal")
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


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
    token_hash: Mapped[str] = mapped_column(unique=True)
    user_agent: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    last_used_at: Mapped[datetime | None]
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]


class KioskPairRequest(Base):
    """One 'link with phone' attempt from a kiosk. The kiosk keeps the
    poll token (only its sha256 is stored); a portal user approves the
    code on their phone; the kiosk's next poll claims a fresh session
    and the row becomes `claimed` (one-shot). Expiry is derived from
    expires_at, never stored as a status. Rows older than a day are
    deleted opportunistically on the next create."""

    __tablename__ = "kiosk_pair_requests"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    code: Mapped[str] = mapped_column(unique=True)
    poll_token_hash: Mapped[str]
    serial: Mapped[str] = mapped_column(CITEXT)
    kiosk_name: Mapped[str]
    status: Mapped[str] = mapped_column(server_default=text("'pending'"))
    approved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    ip_address: Mapped[str | None]
    expires_at: Mapped[datetime]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


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
    color: Mapped[str]
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
    totp_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
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


class NotificationGroup(Base):
    __tablename__ = "notification_groups"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    description: Mapped[str] = mapped_column(server_default="")
    channels: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{email,web}'::text[]"))
    quiet_start: Mapped[time | None] = mapped_column(Time)
    quiet_end: Mapped[time | None] = mapped_column(Time)
    timezone: Mapped[str] = mapped_column(server_default="America/New_York")
    active_days: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{mon,tue,wed,thu,fri,sat,sun}'::text[]"))
    dnd_behavior: Mapped[str] = mapped_column(server_default="defer")
    urgent_bypass: Mapped[bool] = mapped_column(server_default=text("true"))
    enabled: Mapped[bool] = mapped_column(server_default=text("true"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class NotificationGroupMember(Base):
    __tablename__ = "notification_group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("notification_groups.id", ondelete="CASCADE"), primary_key=True)
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("people.id", ondelete="CASCADE"), primary_key=True)
    added_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id", ondelete="SET NULL"))
    added_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    # nullable per-member overrides — NULL means "inherit the group value"
    channels: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    quiet_mode: Mapped[str | None]
    quiet_start: Mapped[time | None] = mapped_column(Time)
    quiet_end: Mapped[time | None] = mapped_column(Time)
    timezone: Mapped[str | None]
    active_days: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    dnd_behavior: Mapped[str | None]
    urgent_bypass: Mapped[bool | None]


class NotificationMembershipRequest(Base):
    """A person's self-service request to join or leave a notification
    group; decided by anyone with notifications:change. One pending
    request per (group, person) — enforced by a partial unique index in
    the migration, not by this table's declared PK."""

    __tablename__ = "notification_membership_requests"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("notification_groups.id", ondelete="CASCADE"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    action: Mapped[str]
    status: Mapped[str] = mapped_column(server_default="pending")
    note: Mapped[str] = mapped_column(server_default="")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    decided_at: Mapped[datetime | None]
    decision_note: Mapped[str] = mapped_column(server_default="")
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


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


class SiteType(Base):
    __tablename__ = "site_types"

    key: Mapped[str] = mapped_column(primary_key=True)
    label: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    sort_order: Mapped[int] = mapped_column(Integer)
    icon: Mapped[str | None]
    color: Mapped[str]
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class StatusValue(Base):
    """One row per (entity, status) pair. record_type is validated in code
    against status/registry.py, not by a DB constraint — the registry is the
    source of truth for which types exist."""

    __tablename__ = "status_values"

    record_type: Mapped[str] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(primary_key=True)
    label: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    color: Mapped[str]
    sort_order: Mapped[int] = mapped_column(Integer, server_default="0")
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    # 0-100 or null (excluded from the weighted-progress calc); generic
    # column, seeded for the asset vocabulary's workflow statuses
    progress_weight: Mapped[int | None] = mapped_column(Integer)


class Site(Base):
    __tablename__ = "sites"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    code: Mapped[str | None] = mapped_column(CITEXT)
    site_type: Mapped[str | None] = mapped_column(ForeignKey("site_types.key"))
    status: Mapped[str] = mapped_column(server_default="active")
    address_line1: Mapped[str | None]
    address_line2: Mapped[str | None]
    city: Mapped[str | None]
    region: Mapped[str | None]
    postal_code: Mapped[str | None]
    country: Mapped[str] = mapped_column(server_default="US")
    latitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    timezone: Mapped[str | None]
    dc_provider: Mapped[str | None]
    partner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("partners.id"))
    notes: Mapped[str | None]
    source: Mapped[str] = mapped_column(server_default="manual")
    source_ref: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class SiteClient(Base):
    __tablename__ = "site_clients"

    site_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), primary_key=True)
    client_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clients.id"), primary_key=True)
    linked_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    linked_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class RawSurveyEntry(Base):
    """Append-only submission trail — the scans-raw of surveys. ANY
    field_key is accepted (strays allowed, V2 raw-editor parity); no FK
    to the registry."""

    __tablename__ = "raw_survey_data"

    id: Mapped[int] = mapped_column(BigInteger, Identity(),
                                    primary_key=True)
    site_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sites.id"))
    field_key: Mapped[str]
    value: Mapped[dict | list | str | int | bool | None] = mapped_column(JSONB)
    captured_at: Mapped[datetime]
    submitted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    device_id: Mapped[str] = mapped_column(server_default="")
    source: Mapped[str] = mapped_column(server_default="")
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class SiteSurveyEntry(Base):
    """Current answer per (site, field); UNIQUE enforced; raw_id =
    provenance (the raw_survey_data row this answer came from)."""

    __tablename__ = "site_survey_data"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    site_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sites.id"))
    field_key: Mapped[str]
    value: Mapped[dict | list | str | int | bool] = mapped_column(JSONB)
    raw_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("raw_survey_data.id"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AssetCategory(Base):
    __tablename__ = "asset_categories"

    key: Mapped[str] = mapped_column(primary_key=True)
    label: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    sort_order: Mapped[int] = mapped_column(Integer)
    color: Mapped[str]
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AssetModel(Base):
    """Catalog row (legacy assets_make_model). Dual-unit columns are always
    written in pairs — assets/units.py computes the missing partner."""

    __tablename__ = "asset_models"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    make: Mapped[str] = mapped_column(CITEXT)
    model: Mapped[str] = mapped_column(CITEXT)
    category: Mapped[str | None] = mapped_column(ForeignKey("asset_categories.key"))
    ru_size: Mapped[int | None] = mapped_column(Integer)
    weight_lbs: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    length_in: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    width_in: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    height_in: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    length_cm: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    width_cm: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    height_cm: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    mount_type: Mapped[str | None]
    rail_type: Mapped[str | None]
    form_factor: Mapped[str | None]      # standalone | chassis | node | null (0068)
    knowledge: Mapped[str] = mapped_column(server_default="")
    review_dismissed_at: Mapped[datetime | None]
    legacy_id: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AssetModelAlias(Base):
    __tablename__ = "asset_model_aliases"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    model_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("asset_models.id", ondelete="CASCADE"))
    alias: Mapped[str] = mapped_column(CITEXT, unique=True)
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Asset(Base):
    __tablename__ = "assets"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    serial_number: Mapped[str | None] = mapped_column(CITEXT)
    name: Mapped[str | None] = mapped_column(CITEXT)
    rfid_tag: Mapped[str | None] = mapped_column(CITEXT)
    pod_number: Mapped[str | None]
    model_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("asset_models.id"))
    client_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clients.id"))
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    location_detail: Mapped[str] = mapped_column(server_default="")
    status: Mapped[str] = mapped_column(server_default="unknown")
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED column; never written
    has_rails: Mapped[bool | None] = mapped_column(Boolean)
    last_seen_at: Mapped[datetime | None]
    legacy_id: Mapped[int] = mapped_column(  # the human Asset ID (0047)
        BigInteger, unique=True,
        server_default=text("nextval('asset_number_seq')"))
    source: Mapped[str] = mapped_column(server_default="manual")
    source_ref: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Container(Base):
    __tablename__ = "containers"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    rfid_tag: Mapped[str | None] = mapped_column(CITEXT)
    container_type: Mapped[str | None]
    status: Mapped[str] = mapped_column(server_default="available")
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'container'"))  # GENERATED column; never written
    type_record_type: Mapped[str] = mapped_column(
        server_default=text("'container_type'"))  # GENERATED; never written
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    # Migration 0057 — Container Labels: V2's `containers.move_id`, ported
    # as an initiative link (V3 had no such link before).
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id", ondelete="SET NULL"))
    # Migration 0058 — the Container Labels tag now lives on the
    # container itself (CHECK constraint enforces the five keys in
    # serversherpa.labels.tags.LABEL_TAG_KEYS).
    label_tag: Mapped[str | None] = mapped_column()
    location_detail: Mapped[str] = mapped_column(server_default="")
    last_audit_at: Mapped[datetime | None]
    audit_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    last_validated_at: Mapped[datetime | None]
    legacy_id: Mapped[int | None] = mapped_column(BigInteger)
    source: Mapped[str] = mapped_column(server_default="manual")
    source_ref: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Truck(Base):
    """A truckload on a move (V2 parity). Status keys live in status_values
    record_type='truck'; containers ride via truck_containers."""

    __tablename__ = "trucks"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    legacy_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    name: Mapped[str] = mapped_column(CITEXT)
    driver_name: Mapped[str | None]
    co_driver_name: Mapped[str | None]
    team_drive: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    contact_info: Mapped[str] = mapped_column(server_default="")
    status: Mapped[str] = mapped_column(server_default="created")
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'truck'"))  # GENERATED column; never written
    load_number: Mapped[str | None]
    seal_id: Mapped[str | None] = mapped_column(String(24))
    tracking_type: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id", ondelete="SET NULL"))
    start_site_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sites.id", ondelete="SET NULL"))
    end_site_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sites.id", ondelete="SET NULL"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    archived_at: Mapped[datetime | None]


class TruckContainer(Base):
    __tablename__ = "truck_containers"

    truck_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("trucks.id", ondelete="CASCADE"), primary_key=True)
    container_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("containers.id", ondelete="CASCADE"), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class TruckUpdate(Base):
    """One location report. `location` is V2's raw "lat, lng" text; lat/lng
    are the parsed numbers the map uses (NULL when unparsable)."""

    __tablename__ = "truck_updates"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    truck_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("trucks.id", ondelete="CASCADE"))
    recorded_at: Mapped[datetime]
    location: Mapped[str]
    lat: Mapped[float | None]
    lng: Mapped[float | None]
    approximate_address: Mapped[str] = mapped_column(server_default="")
    source: Mapped[str] = mapped_column(server_default="manual")


class StockLine(Base):
    """Counted stock at a warehouse site — "24 × PDU, 30A" — optionally
    inside a container and/or linked to a catalog model. No status: its
    state is quantity (0 allowed) and archived_at."""

    __tablename__ = "stock_lines"
    __table_args__ = (
        CheckConstraint("quantity >= 0", name="ck_stock_lines_quantity_nonneg"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    site_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sites.id"))
    container_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("containers.id", ondelete="SET NULL"))
    model_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("asset_models.id", ondelete="SET NULL"))
    description: Mapped[str] = mapped_column(Text)
    quantity: Mapped[int] = mapped_column(Integer)
    unit: Mapped[str] = mapped_column(Text, server_default="each")
    location_detail: Mapped[str] = mapped_column(Text, server_default="")
    notes: Mapped[str] = mapped_column(Text, server_default="")
    source: Mapped[str] = mapped_column(Text, server_default="manual")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    archived_at: Mapped[datetime | None] = mapped_column()


class ContainerAsset(Base):
    __tablename__ = "container_assets"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    container_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("containers.id", ondelete="CASCADE"))
    asset_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("assets.id"), unique=True)
    added_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    added_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    last_validated_at: Mapped[datetime | None]


class RawScan(Base):
    """One unprocessed scan from a kiosk/reader — the inbox. The future
    matcher moves rows to processed_scans (true move: copy + delete);
    unmatched rows just stay here. Append-only, log_entries-style."""

    __tablename__ = "raw_scans"

    id: Mapped[int] = mapped_column(BigInteger, Identity(),
                                    primary_key=True)
    scanned_value: Mapped[str] = mapped_column(CITEXT)
    scan_type: Mapped[str]
    scan_type_record_type: Mapped[str] = mapped_column(
        server_default=text("'scan'"))  # GENERATED column; never written
    status: Mapped[str | None]
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED column; never written
    scanned_at: Mapped[datetime]
    device_id: Mapped[str] = mapped_column(server_default="")
    operator_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id"))
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    location_detail: Mapped[str] = mapped_column(server_default="")
    source: Mapped[str] = mapped_column(server_default="")
    match_attempted_at: Mapped[datetime | None] = mapped_column(
        comment="last matcher attempt; NULL = never tried")
    # kiosk ingest (migration 0063)
    client_scan_id: Mapped[uuid.UUID | None] = mapped_column(
        comment="kiosk-generated scan id; UNIQUE where set, which is what "
                "makes POST /kiosk/scans idempotent on a retried batch")
    scan_status: Mapped[str | None] = mapped_column(
        comment="checkpoint the scanning device was set to, as reported — "
                "un-FK'd device data (cf. devices.scan_status); `status` is "
                "the vocabulary-checked column the matcher copies")
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id", ondelete="SET NULL"),
        comment="the move this scan belongs to (the kiosk's current move)")
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ProcessedScan(Base):
    """A matched scan — the permanent record. Carries a copy of the raw
    context; person_id is the MATCHED person (badge scan), operator_id
    is who ran the scanner. CHECK enforces the match_type target FK."""

    __tablename__ = "processed_scans"
    __table_args__ = (
        # Mirrors migration 0025. Declared here so schema walkers (the
        # devtools force-delete flow) can see that the match FKs, though
        # nullable, cannot be nulled while match_type points at them.
        CheckConstraint(
            "(match_type = 'asset' AND asset_id IS NOT NULL) OR "
            "(match_type = 'container' AND container_id IS NOT NULL) OR "
            "(match_type = 'person' AND person_id IS NOT NULL)",
            name="processed_scans_match_target_chk"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    scanned_value: Mapped[str] = mapped_column(CITEXT)
    scan_type: Mapped[str]
    scan_type_record_type: Mapped[str] = mapped_column(
        server_default=text("'scan'"))  # GENERATED column; never written
    status: Mapped[str | None]
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED column; never written
    scanned_at: Mapped[datetime]
    device_id: Mapped[str] = mapped_column(server_default="")
    operator_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id"))
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    location_detail: Mapped[str] = mapped_column(server_default="")
    source: Mapped[str] = mapped_column(server_default="")
    raw_scan_id: Mapped[int | None] = mapped_column(BigInteger)
    match_type: Mapped[str]
    match_record_type: Mapped[str] = mapped_column(
        server_default=text("'processed_scan'"))  # GENERATED; never written
    asset_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("assets.id"))
    container_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("containers.id"))
    person_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id"))
    processed_at: Mapped[datetime]
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class StatusRule(Base):
    """Admin-authored scan automation: when a scan with trigger_status
    matches a trigger_match_type entity, conditions (AND-only) gate the
    typed actions. Evaluated by the scan-matching worker."""

    __tablename__ = "status_rules"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    trigger_status: Mapped[str]
    trigger_status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED column; never written
    trigger_match_type: Mapped[str]
    trigger_match_record_type: Mapped[str] = mapped_column(
        server_default=text("'processed_scan'"))  # GENERATED; never written
    priority: Mapped[int] = mapped_column(server_default="10")
    enabled: Mapped[bool] = mapped_column(server_default=text("true"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    conditions: Mapped[list["StatusRuleCondition"]] = relationship(
        cascade="all, delete-orphan",
        order_by="StatusRuleCondition.position")
    actions: Mapped[list["StatusRuleAction"]] = relationship(
        cascade="all, delete-orphan", order_by="StatusRuleAction.position")


class StatusRuleCondition(Base):
    __tablename__ = "status_rule_conditions"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    rule_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("status_rules.id", ondelete="CASCADE"))
    position: Mapped[int]
    field: Mapped[str]
    operator: Mapped[str]
    value: Mapped[str | None]


class StatusRuleAction(Base):
    __tablename__ = "status_rule_actions"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    rule_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("status_rules.id", ondelete="CASCADE"))
    position: Mapped[int]
    action_type: Mapped[str]
    params: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))


class StatusRuleExecution(Base):
    """One row per rule fire (or per failed scan — then processed_scan_id
    is NULL and error is set; the scan txn rolled back)."""

    __tablename__ = "status_rule_executions"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    rule_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("status_rules.id", ondelete="SET NULL"))
    rule_name: Mapped[str]
    processed_scan_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("processed_scans.id"))
    conditions_met: Mapped[bool]
    actions_applied: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb"))
    error: Mapped[str | None]
    executed_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    duration_ms: Mapped[int] = mapped_column(server_default="0")


class Device(Base):
    """One row per piece of scanning hardware; device_type discriminates
    (initiatives-style unification). wan_ip/lan_ip/uptime_seconds are
    the router block — NULL for other families. serial is the future
    registration endpoint's upsert key. Hard-delete only; deletes are
    audited. A fixed reader's name = its reported raw_scans.device_id
    (the tags-read derivation key) — renaming a reader zeroes its
    tags-read count until new scans report under the new name. A fixed
    reader's lan_ip doubles as its network address."""

    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    device_type: Mapped[str]
    type_record_type: Mapped[str] = mapped_column(
        server_default=text("'device_type'"))  # GENERATED; never written
    name: Mapped[str] = mapped_column(CITEXT)
    model: Mapped[str | None]
    version: Mapped[str | None]
    serial: Mapped[str | None] = mapped_column(CITEXT)
    mac: Mapped[str | None] = mapped_column(CITEXT)
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    wan_ip: Mapped[str | None]
    lan_ip: Mapped[str | None]
    antennas_connected: Mapped[int | None] = mapped_column(SmallInteger)
    connection_type: Mapped[str | None]
    scan_status: Mapped[str | None]
    scan_status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED; never written
    sub_type: Mapped[str | None]   # kiosk: laptop/pi/web/android/zebra/ios
    current_initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id"))
    vpn_status: Mapped[str | None]
    uptime_seconds: Mapped[int | None] = mapped_column(BigInteger)
    last_seen_at: Mapped[datetime | None]
    token_expires_at: Mapped[datetime | None]
    raw_info: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    registered_at: Mapped[datetime] = mapped_column(
        server_default=text("now()"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    # who is signed in on this kiosk right now (set by the sign-in
    # heartbeat, cleared by /kiosk/sign-out)
    session_person_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id", ondelete="SET NULL"))
    session_login_method: Mapped[str | None]
    session_started_at: Mapped[datetime | None]


class DeviceDhcpLease(Base):
    """One DHCP lease/reservation on a device, synced by the (future)
    heartbeat via UNIQUE (device_id, mac). reserved and up are
    orthogonal — a static reservation can be online."""

    __tablename__ = "device_dhcp_leases"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    device_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"))
    mac: Mapped[str] = mapped_column(CITEXT)
    ip: Mapped[str | None]
    hostname: Mapped[str | None]
    reserved: Mapped[bool] = mapped_column(server_default=text("false"))
    up: Mapped[bool] = mapped_column(server_default=text("false"))
    last_seen_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Initiative(Base):
    """Unified V2 projects/events/moves. initiative_type discriminates;
    the move-only block stays NULL for the other types and is retained
    (not wiped) on an admin type change."""

    __tablename__ = "initiatives"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    description: Mapped[str | None]
    # '#rrggbb' lowercase; the calendar and timeline bars paint with it.
    # NULL is legal and falls back to the status color at render time.
    color: Mapped[str | None]
    initiative_type: Mapped[str]
    type_record_type: Mapped[str] = mapped_column(
        server_default=text("'initiative_type'"))  # GENERATED; never written
    sub_type: Mapped[str | None]
    sub_type_record_type: Mapped[str] = mapped_column(
        server_default=text("'initiative_sub_type'"))  # GENERATED; never written
    status: Mapped[str] = mapped_column(server_default="planned")
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'initiative'"))  # GENERATED; never written
    client_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clients.id"))
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    location: Mapped[str | None]
    scheduled_start: Mapped[datetime | None]
    scheduled_end: Mapped[datetime | None]
    sky_command_project_id: Mapped[str | None]
    origin_site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    destination_site_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sites.id"))
    real_start_at: Mapped[datetime | None]
    real_end_at: Mapped[datetime | None]
    priority_devices: Mapped[bool | None]
    shipping_types: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    shipping_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    origin_tech_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    origin_cable_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    origin_logistics_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    destination_tech_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    destination_cable_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    destination_logistics_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    origin_vendor_involved: Mapped[bool | None]
    destination_vendor_involved: Mapped[bool | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class InitiativePerson(Base):
    __tablename__ = "initiative_people"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    initiative_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    work_type: Mapped[str | None]
    work_type_record_type: Mapped[str] = mapped_column(
        server_default=text("'initiative_work_type'"))  # GENERATED; never written
    site_worked_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    rating: Mapped[int | None] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class InitiativeLink(Base):
    """parent contains child. Any type may parent any type; the API
    enforces acyclicity (the DB only blocks direct self-links)."""

    __tablename__ = "initiative_links"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    parent_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    child_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    role: Mapped[str | None]
    sort_order: Mapped[int | None]
    notes: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class InitiativeAsset(Base):
    """Per-move asset roster (V2 moves_assets_list). Assets reach a move
    only via the future bulk-import script or dev seeding — no
    interactive picker."""

    __tablename__ = "initiative_assets"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    initiative_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    asset_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assets.id"))
    priority_wave: Mapped[str | None] = mapped_column(String(30))
    disposition: Mapped[str | None]
    owner: Mapped[str | None]
    source_pod: Mapped[str | None]
    destination_pod: Mapped[str | None]
    source_rack: Mapped[str | None]
    source_ru: Mapped[Decimal | None] = mapped_column(Numeric)
    source_verified: Mapped[bool | None] = mapped_column(Boolean)
    source_position: Mapped[str | None]
    destination_rack: Mapped[str | None]
    destination_ru: Mapped[Decimal | None] = mapped_column(Numeric)
    destination_verified: Mapped[bool | None] = mapped_column(Boolean)
    destination_position: Mapped[str | None]
    cable_info: Mapped[str | None]
    vendor_involved: Mapped[bool | None] = mapped_column(Boolean)
    raw_ft: Mapped[dict | None] = mapped_column(JSONB)
    label_info: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(server_default="loaded_in_system")
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED column; never written
    added_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class TimeEntry(Base):
    """One clock-in/clock-out span for the punch-clock + timesheet-approval
    suite. status walks open -> pending -> approved/rejected. A partial
    unique index (migration 0028) enforces at most one open entry per
    person at a time."""

    __tablename__ = "time_entries"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id"))
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    clock_in_at: Mapped[datetime]
    clock_out_at: Mapped[datetime | None]
    break_minutes: Mapped[int] = mapped_column(server_default="0")
    status: Mapped[str] = mapped_column(server_default="open")
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'time_entry'"))  # GENERATED column; never written
    source: Mapped[str] = mapped_column(server_default="punch")
    device_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL"))   # the kiosk, when source='kiosk'
    notes: Mapped[str] = mapped_column(server_default="")
    adjusted: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    adjust_reason: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    approved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    approved_at: Mapped[datetime | None]
    reject_reason: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ImportJob(Base):
    """Queued background import work. The API only creates rows and serves
    status; the separate import-worker process claims queued rows
    (FOR UPDATE SKIP LOCKED) and does all parsing and writing — an import
    can never affect API readiness or response times."""

    __tablename__ = "import_jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    kind: Mapped[str]                       # 'move_assets' (only kind yet)
    initiative_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    filename: Mapped[str]
    file_key: Mapped[str] = mapped_column(server_default="")
    options: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    phase: Mapped[str] = mapped_column(server_default="validate")
    status: Mapped[str] = mapped_column(server_default="queued")
    total_rows: Mapped[int] = mapped_column(Integer, server_default="0")
    processed_rows: Mapped[int] = mapped_column(Integer, server_default="0")
    created_count: Mapped[int] = mapped_column(Integer, server_default="0")
    updated_count: Mapped[int] = mapped_column(Integer, server_default="0")
    error_count: Mapped[int] = mapped_column(Integer, server_default="0")
    results: Mapped[dict | None] = mapped_column(JSONB)
    cancel_requested: Mapped[bool] = mapped_column(server_default=text("false"))
    error: Mapped[str | None]
    progress_at: Mapped[datetime | None]
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class SystemProcess(Base):
    """Heartbeat registry — one row per process name, upserted at
    startup (a restart overwrites; no run history). Status is derived
    at read time in system/registry.py, never stored here."""

    __tablename__ = "processes"

    name: Mapped[str] = mapped_column(primary_key=True)
    kind: Mapped[str]                    # 'service' | 'worker' | 'probe'
    pid: Mapped[int | None] = mapped_column(Integer)
    hostname: Mapped[str] = mapped_column(server_default="")
    started_at: Mapped[datetime | None]
    heartbeat_at: Mapped[datetime | None]
    stopped_at: Mapped[datetime | None]
    meta: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))


class LogEntry(Base):
    """One log record from any process; id is the ordering + streaming
    cursor. Size is bounded by the log-service's retention pass."""

    __tablename__ = "log_entries"

    id: Mapped[int] = mapped_column(BigInteger, Identity(),
                                    primary_key=True)
    process: Mapped[str]
    level: Mapped[str]
    levelno: Mapped[int] = mapped_column(Integer)
    logger: Mapped[str] = mapped_column(server_default="")
    message: Mapped[str]
    extra: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class SystemConfig(Base):
    """Section-keyed JSONB config. 'logging' is seeded by 0024;
    'logging_cursor' is written only by the log-service."""

    __tablename__ = "system_config"

    section: Mapped[str] = mapped_column(primary_key=True)
    data: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    updated_at: Mapped[datetime] = mapped_column(
        server_default=text("now()"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id"))


class Note(Base):
    """Global polymorphic notes (attachments-style entity_type/entity_id).
    Soft-deleted like attachments; only entity_type='asset' is wired in V1."""

    __tablename__ = "notes"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    entity_type: Mapped[str]
    entity_id: Mapped[uuid.UUID]
    body: Mapped[str]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    deleted_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class PendingDelete(Base):
    """God-mode staging area for a hard delete. entity_label is a
    display-only snapshot taken at mark time — it never updates, so the
    list stays readable even if the target changes before reconcile runs."""

    __tablename__ = "pending_deletes"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    entity_type: Mapped[str]
    entity_id: Mapped[uuid.UUID]
    entity_label: Mapped[str] = mapped_column(server_default="")
    marked_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    marked_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class DbBackup(Base):
    """Metadata row for one full-database dump (Dev -> Database ->
    Backups). The dump bytes live in Spaces at storage_key — when
    `encrypted`, sealed with the creator's own account password
    (services.db_backup), which is never stored here, never in this
    row, never in the audit log."""

    __tablename__ = "db_backups"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    filename: Mapped[str]
    storage_key: Mapped[str]
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    encrypted: Mapped[bool] = mapped_column(server_default=text("true"))
    # 'manual' (Dev -> Database -> Backups) or 'testing_snapshot' (taken by
    # the db-testing-worker at the start of a testing session) — the
    # Backups tab labels the latter with a chip.
    purpose: Mapped[str] = mapped_column(server_default=text("'manual'"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class DbTestingSession(Base):
    """One password-gated 'DB testing mode' session (Dev -> Database ->
    Testing): snapshot the database, let the user make changes, then
    either revert to the snapshot or keep the changes. Processed by the
    db-testing-worker, never inline in the API request — a pg_dump/psql
    restore is too slow (and a revert too disruptive) to run in a request.

    Only one session may be in an unfinished state at a time — enforced by
    a partial unique index (migration 0059) on status IN ('snapshotting',
    'active', 'reverting')."""

    __tablename__ = "db_testing_sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    # snapshotting -> active -> reverting -> ended (ended_with: reverted|kept)
    # any state can instead land on 'failed' (see `error`)
    status: Mapped[str]
    snapshot_backup_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("db_backups.id", ondelete="SET NULL"))
    # table -> row count, captured right after the snapshot dump; the
    # status endpoint diffs this against live counts to report `changes`
    row_counts: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    # start time; `changes.audit_rows` counts audit_log rows after this
    audit_watermark: Mapped[datetime]
    started_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id", ondelete="SET NULL"))
    started_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    ended_at: Mapped[datetime | None]
    ended_with: Mapped[str | None]           # 'reverted' | 'kept' | null
    error: Mapped[str | None]
    worker_id: Mapped[str | None]
    heartbeat_at: Mapped[datetime | None]
    # the admin broadcast-banner config as it was before testing turned its
    # own banner on — restored verbatim when the session ends (revert or
    # keep) so the maintenance banner never gets stuck on "testing mode"
    previous_banner: Mapped[dict | None] = mapped_column(JSONB)


class LabelVocab(Base):
    """Label dropdown vocabularies; `kind` discriminates type/size/dpi/
    language. Kind-specific facts live in meta (sizes: width_in/height_in/
    has_tab; dpis: dots; languages: family). Codegen keys off well-known
    `key` values — rows only control what the UI offers."""
    __tablename__ = "label_vocab"

    kind: Mapped[str] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(primary_key=True)
    label: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    meta: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    sort_order: Mapped[int] = mapped_column(Integer, server_default="0")
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class LabelPlaceholder(Base):
    """Catalog of {token} fields the builder offers; sample_value drives
    editor previews; applies_to filters by label-type key."""
    __tablename__ = "label_placeholders"

    key: Mapped[str] = mapped_column(primary_key=True)
    label: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    sample_value: Mapped[str] = mapped_column(server_default="")
    applies_to: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{}'::text[]"))
    sort_order: Mapped[int] = mapped_column(Integer, server_default="0")
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class LabelTemplate(Base):
    """kind='design' rows own element-model JSON (inches; compiled to
    printer code on demand); kind='code' rows own raw pasted code with
    {placeholder} tokens. Exactly one payload per row (CHECK, 0042).
    Delete is deactivation; the creator is captured by the audit log."""
    __tablename__ = "label_templates"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT, unique=True)
    description: Mapped[str] = mapped_column(server_default="")
    label_type: Mapped[str]
    size_key: Mapped[str]
    dpi_key: Mapped[str]
    language_key: Mapped[str]
    kind: Mapped[str]
    # none_as_null: a bare JSONB type stores Python None as a JSON 'null'
    # literal (still non-NULL), which would defeat the payload CHECK's
    # "exactly one of design/code is populated" contract.
    design: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    code: Mapped[str | None]
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))
    # V2's `label_generation_code` port: {"destination": {"1": "nap", ...},
    # "source": {...}, "length_limits": {"asset_name": 20}} — position maps
    # split the raw location on "." (1-based) into extra placeholder
    # tokens; length_limits truncate named values. See labels/generate/values.py.
    generation_rules: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    site_links: Mapped[list["LabelTemplateSite"]] = relationship(
        cascade="all, delete-orphan")


class LabelFont(Base):
    """A TrueType font in the label font library: `name` is the Zebra
    object name it is installed under on the printer's E: drive
    (Install Fonts on Labels → Printers). Soft-deleted; the partial
    unique index on (name) WHERE deleted_at IS NULL lives in 0060."""
    __tablename__ = "label_fonts"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    display_name: Mapped[str] = mapped_column(server_default="")
    storage_key: Mapped[str]
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    content_type: Mapped[str] = mapped_column(server_default="font/ttf")
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    deleted_at: Mapped[datetime | None]


class LabelTemplateSite(Base):
    """One row per template-site assignment; no rows = global template."""
    __tablename__ = "label_template_sites"

    template_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("label_templates.id", ondelete="CASCADE"),
        primary_key=True)
    site_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), primary_key=True)


class LabelGenerationRun(Base):
    """The label-worker's queue (same shape as ReportRun/ImportJob): the
    API creates rows, `label-worker` claims them with FOR UPDATE SKIP
    LOCKED and renders every asset on the initiative for each requested
    label type into `generated_labels`. One active (queued/running) run
    per initiative — enforced by a partial unique index (migration 0055)."""
    __tablename__ = "label_generation_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    initiative_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("initiatives.id"))
    label_types: Mapped[list[str]] = mapped_column(ARRAY(Text))
    regenerate_existing: Mapped[bool] = mapped_column(server_default=text("false"))
    status: Mapped[str] = mapped_column(server_default="queued")
    cancel_requested: Mapped[bool] = mapped_column(server_default=text("false"))
    current_label_type: Mapped[str | None]
    current_item: Mapped[str | None]
    total: Mapped[int] = mapped_column(Integer, server_default="0")
    processed: Mapped[int] = mapped_column(Integer, server_default="0")
    generated: Mapped[int] = mapped_column(Integer, server_default="0")
    skipped: Mapped[int] = mapped_column(Integer, server_default="0")
    errors: Mapped[int] = mapped_column(Integer, server_default="0")
    error_summary: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    error_details: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb"))
    error: Mapped[str | None]
    requested_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    notify: Mapped[bool] = mapped_column(server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    worker_id: Mapped[str | None]
    heartbeat_at: Mapped[datetime | None]
    # type key -> template uuid (text). The operator's per-type override
    # of select_template's auto-match (migration 0056); enqueue_run
    # validates it at write time, the runner re-checks at process time
    # since a template can be deactivated in between.
    template_overrides: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))


class GeneratedLabel(Base):
    """One row per (entity, initiative, label_type) — regenerating
    replaces the row (upsert). `values` holds the substituted placeholder
    values for audit/preview; `stale` is set only by explicit
    regeneration (this phase never auto-invalidates it)."""
    __tablename__ = "generated_labels"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    entity_type: Mapped[str]
    entity_id: Mapped[uuid.UUID]
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id"))
    label_type: Mapped[str]
    template_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("label_templates.id"))
    template_version: Mapped[int] = mapped_column(Integer)
    language_key: Mapped[str]
    dpi_key: Mapped[str]
    size_key: Mapped[str]
    code: Mapped[str]
    values: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("label_generation_runs.id"))
    generated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    stale: Mapped[bool] = mapped_column(server_default=text("false"))


class ReportDefinition(Base):
    """The Reports page's Available tab: a named report type + default
    section options. System rows are seeded and cannot be deleted."""
    __tablename__ = "report_definitions"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    description: Mapped[str] = mapped_column(server_default="")
    report_type: Mapped[str]
    options: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    is_system: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ReportRun(Base):
    """One generation of a report: queued by the API, executed by the
    report-worker, stored in Spaces + attached to the initiative."""
    __tablename__ = "report_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    definition_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("report_definitions.id"))
    report_type: Mapped[str]
    # nullable since migration 0052: Site & Move Survey may target a
    # partner + manually chosen sites with no initiative at all
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("initiatives.id"))
    options: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    status: Mapped[str] = mapped_column(server_default="queued")
    error: Mapped[str | None]
    requested_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    requested_rank: Mapped[int] = mapped_column(Integer, server_default="0")
    notify: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    storage_key: Mapped[str | None]
    attachment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("attachments.id"))
    filename: Mapped[str | None]
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Notification(Base):
    """Per-person in-app inbox row. Written only via notifications/inbox.py
    notify(); future channels (email…) fan out from that function."""
    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    kind: Mapped[str]
    title: Mapped[str]
    body: Mapped[str] = mapped_column(server_default="")
    link: Mapped[str | None]
    payload: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    read_at: Mapped[datetime | None]
    dismissed_at: Mapped[datetime | None]
