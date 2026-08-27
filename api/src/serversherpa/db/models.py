"""SQLAlchemy models. The schema of record is the Alembic migrations;
these models mirror them for application queries."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger, Boolean, Date, ForeignKey, Identity, Integer, Numeric, SmallInteger, String, Text, text,
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
    # keys under status_values record_type='partner_type'; API-validated
    # (composite FK can't cover arrays) — see initiatives.shipping_types
    partner_types: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{}'::text[]"))
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
    survey_data: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
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
    knowledge: Mapped[str] = mapped_column(server_default="")
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

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    serial_number: Mapped[str | None] = mapped_column(CITEXT)
    name: Mapped[str | None] = mapped_column(CITEXT)
    rfid_tag: Mapped[str | None] = mapped_column(CITEXT)
    model_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("asset_models.id"))
    client_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clients.id"))
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    location_detail: Mapped[str] = mapped_column(server_default="")
    status: Mapped[str] = mapped_column(server_default="unknown")
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED column; never written
    has_rails: Mapped[bool | None] = mapped_column(Boolean)
    last_seen_at: Mapped[datetime | None]
    legacy_id: Mapped[int | None] = mapped_column(BigInteger)
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
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ProcessedScan(Base):
    """A matched scan — the permanent record. Carries a copy of the raw
    context; person_id is the MATCHED person (badge scan), operator_id
    is who ran the scanner. CHECK enforces the match_type target FK."""

    __tablename__ = "processed_scans"

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


class Initiative(Base):
    """Unified V2 projects/events/moves. initiative_type discriminates;
    the move-only block stays NULL for the other types and is retained
    (not wiped) on an admin type change."""

    __tablename__ = "initiatives"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    description: Mapped[str | None]
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
