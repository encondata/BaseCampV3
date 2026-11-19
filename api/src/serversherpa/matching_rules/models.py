"""Matching rules ORM models; the schema of record is migration 0130."""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from serversherpa.db.models import Base


def _id() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))


def _now() -> Mapped[datetime]:
    return mapped_column(server_default=text("now()"))


def _person() -> Mapped[uuid.UUID | None]:
    return mapped_column(ForeignKey("people.id", ondelete="SET NULL"))


class MatchingRuleVersion(Base):
    __tablename__ = "matching_rule_versions"
    __table_args__ = (
        CheckConstraint("place IN ('printing', 'scanning')",
                        name="matching_rule_versions_place_check"),
        CheckConstraint("state IN ('draft', 'standby', 'live', 'retired')",
                        name="matching_rule_versions_state_check"),
        UniqueConstraint("place", "version", name="matching_rule_versions_place_version_key"),
        Index("matching_rule_versions_one_live", "place", unique=True,
              postgresql_where=text("state = 'live'")),
    )

    id: Mapped[uuid.UUID] = _id()
    place: Mapped[str] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(Text, server_default="draft")
    flow: Mapped[dict] = mapped_column(JSONB)
    based_on_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("matching_rule_versions.id", ondelete="SET NULL"))
    checked: Mapped[dict | None] = mapped_column(JSONB)
    created_by: Mapped[uuid.UUID | None] = _person()
    updated_by: Mapped[uuid.UUID | None] = _person()
    state_changed_by: Mapped[uuid.UUID | None] = _person()
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()
    state_changed_at: Mapped[datetime | None]


class MatchingTestAsset(Base):
    __tablename__ = "matching_test_assets"
    __table_args__ = (
        CheckConstraint("asset_tag > 0", name="matching_test_assets_tag_check"),
        CheckConstraint("sits IN ('move', 'client')", name="matching_test_assets_sits_check"),
    )

    id: Mapped[uuid.UUID] = _id()
    asset_tag: Mapped[int] = mapped_column(BigInteger, unique=True)
    name: Mapped[str] = mapped_column(Text)
    rfid: Mapped[str | None] = mapped_column(Text)
    serial: Mapped[str | None] = mapped_column(Text)
    sits: Mapped[str] = mapped_column(Text, server_default="move")
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()

    rows: Mapped[list["MatchingTestRow"]] = relationship(
        back_populates="test_asset",
        order_by="(MatchingTestRow.place, MatchingTestRow.value)",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class MatchingTestRow(Base):
    __tablename__ = "matching_test_rows"
    __table_args__ = (
        CheckConstraint("place IN ('printing', 'scanning')",
                        name="matching_test_rows_place_check"),
        CheckConstraint("btrim(value) <> ''", name="matching_test_rows_value_check"),
        CheckConstraint(
            "expected IN ('asset_tag', 'serial', 'rfid', 'name', 'not_found')",
            name="matching_test_rows_expected_check"),
        UniqueConstraint("place", "value", name="matching_test_rows_place_value_key"),
        Index("matching_test_rows_test_asset_idx", "test_asset_id"),
    )

    id: Mapped[uuid.UUID] = _id()
    test_asset_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("matching_test_assets.id", ondelete="CASCADE"))
    place: Mapped[str] = mapped_column(Text)
    value: Mapped[str] = mapped_column(Text)
    expected: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()

    test_asset: Mapped[MatchingTestAsset] = relationship(back_populates="rows")
