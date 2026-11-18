"""The devices database (migration 0001). People are main-API people: their
ids and display names are stored as given by the main API's authorize
answer, never as foreign keys."""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, BYTEA, JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import Text, TypeDecorator

JOB_KINDS = ("register_device", "rebuild_profiles", "sign_build", "ensure_bundle",
             "disable_device", "sync_devices")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class Base(DeclarativeBase):
    type_annotation_map = {  # noqa: RUF012 (SQLAlchemy reads it as a class attribute)
        uuid.UUID: UUID(as_uuid=True),
        datetime: TIMESTAMP(timezone=True),
        str: Text,
    }


class BuildSort(TypeDecorator):
    """numeric(38,0) read and written as a Python int: an iOS build's sort key
    (four 9-digit parts) doesn't fit bigint."""

    impl = Numeric(38, 0)
    cache_ok = True

    def process_bind_param(self, value: int | None, dialect) -> Decimal | None:
        return None if value is None else Decimal(int(value))

    def process_result_value(self, value: Decimal | None, dialect) -> int | None:
        return None if value is None else int(value)


def _id() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))


def _now() -> Mapped[datetime]:
    return mapped_column(server_default=text("now()"))


class AppleSettings(Base):
    """The one row (id 1) of Apple team settings. The .p8, .p12 and the
    .p12's password are Fernet-encrypted with DEVICES_SECRET_KEY."""
    __tablename__ = "apple_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    team_id: Mapped[str | None]
    issuer_id: Mapped[str | None]
    key_id: Mapped[str | None]
    p8_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    p12_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    p12_password_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    cert_name: Mapped[str | None]
    cert_serial: Mapped[str | None]
    cert_expires_at: Mapped[datetime | None]
    asc_certificate_id: Mapped[str | None]
    updated_by: Mapped[uuid.UUID | None]
    updated_by_name: Mapped[str | None]
    updated_at: Mapped[datetime] = _now()

    __table_args__ = (CheckConstraint("id = 1", name="apple_settings_singleton"),)


class App(Base):
    __tablename__ = "apps"

    id: Mapped[uuid.UUID] = _id()
    platform: Mapped[str]                        # 'android' | 'ios'
    identifier: Mapped[str]                      # package name / bundle id
    name: Mapped[str]
    icon_key: Mapped[str | None]
    # Android: SHA-256 hex of the first upload's signing certificate.
    signing_digest: Mapped[str | None]
    asc_bundle_id: Mapped[str | None]
    created_at: Mapped[datetime] = _now()

    __table_args__ = (
        CheckConstraint(_in("platform", ("android", "ios")), name="apps_platform_check"),
        UniqueConstraint("platform", "identifier", name="apps_platform_identifier_key"),
    )


class AppVersion(Base):
    __tablename__ = "app_versions"

    id: Mapped[uuid.UUID] = _id()
    app_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("apps.id", ondelete="CASCADE"))
    version_name: Mapped[str]
    build: Mapped[str]
    # Android versionCode; iOS packages.versions.ios_build_sort(build).
    build_sort: Mapped[int] = mapped_column(BuildSort)
    notes: Mapped[str] = mapped_column(server_default="")
    file_key: Mapped[str]
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str]
    min_os: Mapped[str | None]
    uploaded_by: Mapped[uuid.UUID]
    uploaded_by_name: Mapped[str]
    uploaded_at: Mapped[datetime] = _now()
    is_current: Mapped[bool] = mapped_column(server_default=text("false"))
    deleted_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = _now()

    __table_args__ = (
        UniqueConstraint("app_id", "version_name", "build",
                         name="app_versions_app_id_version_name_build_key"),
        Index("app_versions_one_current_idx", "app_id", unique=True,
              postgresql_where=text("is_current AND deleted_at IS NULL")),
    )


class IosDevice(Base):
    __tablename__ = "ios_devices"

    id: Mapped[uuid.UUID] = _id()
    udid: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str]
    product: Mapped[str]
    os_version: Mapped[str]
    serial: Mapped[str | None]
    added_by: Mapped[uuid.UUID]
    added_by_name: Mapped[str]
    added_at: Mapped[datetime] = _now()
    status: Mapped[str] = mapped_column(server_default="pending")
    error: Mapped[str | None]
    asc_device_id: Mapped[str | None]
    device_class: Mapped[str | None]
    created_at: Mapped[datetime] = _now()

    __table_args__ = (
        CheckConstraint(_in("status", ("pending", "registered", "failed", "disabled")),
                        name="ios_devices_status_check"),
    )


class IosProfile(Base):
    """The Ad Hoc provisioning profile Apple issued for one iOS app."""
    __tablename__ = "ios_profiles"

    id: Mapped[uuid.UUID] = _id()
    app_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("apps.id", ondelete="CASCADE"), unique=True)
    asc_profile_id: Mapped[str]
    content: Mapped[bytes] = mapped_column(BYTEA)
    expires_at: Mapped[datetime]
    device_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), server_default=text("'{}'"))
    created_at: Mapped[datetime] = _now()
    # The profile's own UUID (from Apple). Declared last: the attribute name
    # shadows the uuid module for the rest of the class body.
    uuid: Mapped[str]


class SignedBuild(Base):
    """An IPA re-signed with one profile."""
    __tablename__ = "signed_builds"

    id: Mapped[uuid.UUID] = _id()
    version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("app_versions.id", ondelete="CASCADE"))
    profile_uuid: Mapped[str]
    status: Mapped[str] = mapped_column(server_default="queued")
    file_key: Mapped[str | None]
    error: Mapped[str | None]
    created_at: Mapped[datetime] = _now()

    __table_args__ = (
        CheckConstraint(_in("status", ("queued", "running", "ready", "failed")),
                        name="signed_builds_status_check"),
        UniqueConstraint("version_id", "profile_uuid",
                         name="signed_builds_version_id_profile_uuid_key"),
    )


class EnrollToken(Base):
    """One "add an iPhone" link; only the token's hash is stored. The two
    flags record what its creator could do when it was made (migration 0002)."""
    __tablename__ = "enroll_tokens"

    token_hash: Mapped[str] = mapped_column(primary_key=True)
    person_id: Mapped[uuid.UUID]
    person_name: Mapped[str]
    device_name: Mapped[str]
    created_at: Mapped[datetime] = _now()
    expires_at: Mapped[datetime]
    used_at: Mapped[datetime | None]
    # The creator held `delete`: may bring a disabled iPhone back.
    can_reenable: Mapped[bool] = mapped_column(server_default=text("false"))
    # The creator held `change`: may rename an iPhone someone else added.
    can_update_existing: Mapped[bool] = mapped_column(server_default=text("false"))


class Upload(Base):
    """A package uploaded to the bucket, waiting for inspection and commit."""
    __tablename__ = "uploads"

    id: Mapped[uuid.UUID] = _id()
    file_key: Mapped[str]
    filename: Mapped[str]
    size: Mapped[int] = mapped_column(BigInteger)
    created_by: Mapped[uuid.UUID]
    created_at: Mapped[datetime] = _now()
    inspected: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    committed_at: Mapped[datetime | None]


class Job(Base):
    """Queued background work. The API only creates rows and reads status;
    the worker claims queued rows and does the work."""
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = _id()
    kind: Mapped[str]
    payload: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    status: Mapped[str] = mapped_column(server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    error: Mapped[str | None]
    result: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    created_at: Mapped[datetime] = _now()
    started_at: Mapped[datetime | None]
    progress_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]

    __table_args__ = (
        CheckConstraint(_in("kind", JOB_KINDS), name="jobs_kind_check"),
        CheckConstraint(_in("status", ("queued", "running", "done", "failed")),
                        name="jobs_status_check"),
        Index("jobs_status_created_idx", "status", "created_at"),
    )


class AppleDeviceCount(Base):
    """How many devices of each class the Apple team has registered, as of
    the last sync."""
    __tablename__ = "apple_device_counts"

    device_class: Mapped[str] = mapped_column(primary_key=True)
    count: Mapped[int] = mapped_column(Integer, server_default="0")
    synced_at: Mapped[datetime] = _now()
