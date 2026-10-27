"""Learning portal ORM models; the schema of record is migration 0109."""

import uuid
from datetime import date, datetime, time

from sqlalchemy import (
    Boolean,
    Date,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Text,
    Time,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, BYTEA, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from serversherpa.db.models import Base

_ZERO = "'00000000-0000-0000-0000-000000000000'::uuid"


def _id() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))


def _now() -> Mapped[datetime]:
    return mapped_column(server_default=text("now()"))


class LearningDocument(Base):
    __tablename__ = "learning_documents"

    id: Mapped[uuid.UUID] = _id()
    wiki_node_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("wiki_nodes.id", ondelete="SET NULL"))
    title: Mapped[str]
    summary: Mapped[str | None]
    validity_days: Mapped[int | None]      # null = never expires
    resign_rule: Mapped[str] = mapped_column(server_default="expired_or_new_version")
    sign_style: Mapped[str] = mapped_column(server_default="typed_name")
    require_scroll: Mapped[bool] = mapped_column(server_default=text("true"))
    min_read_seconds: Mapped[int | None]
    quiz_enabled: Mapped[bool] = mapped_column(server_default=text("false"))
    quiz_pass_percent: Mapped[int | None]
    quiz_max_attempts: Mapped[int | None]
    quiz_fail_action: Mapped[str] = mapped_column(server_default="retry")
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("learning_document_versions.id", ondelete="SET NULL",
                   use_alter=True, name="learning_documents_current_version_fk"))
    archived_at: Mapped[datetime | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class LearningDocumentVersion(Base):
    __tablename__ = "learning_document_versions"

    id: Mapped[uuid.UUID] = _id()
    document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learning_documents.id", ondelete="CASCADE"))
    version_no: Mapped[int]
    # no FK on purpose: the wiki may prune its own history
    wiki_version_id: Mapped[uuid.UUID | None]
    wiki_version_no: Mapped[int | None]
    title: Mapped[str]
    content_json: Mapped[dict] = mapped_column(JSONB)
    content_html: Mapped[str]
    image_asset_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), server_default=text("'{}'"))
    change_note: Mapped[str | None]
    published_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    published_at: Mapped[datetime] = _now()
    created_at: Mapped[datetime] = _now()

    __table_args__ = (UniqueConstraint(
        "document_id", "version_no", name="learning_document_versions_doc_no_key"),)


class LearningTranslation(Base):
    __tablename__ = "learning_translations"

    id: Mapped[uuid.UUID] = _id()
    version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learning_document_versions.id", ondelete="CASCADE"))
    language: Mapped[str]
    status: Mapped[str] = mapped_column(server_default="draft")    # draft|in_review|published
    title: Mapped[str]
    content_html: Mapped[str]
    source: Mapped[str] = mapped_column(server_default="manual")   # claude|manual
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    updated_at: Mapped[datetime] = _now()
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    reviewed_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = _now()

    __table_args__ = (UniqueConstraint(
        "version_id", "language", name="learning_translations_version_language_key"),)


class LearningQuizQuestion(Base):
    __tablename__ = "learning_quiz_questions"

    id: Mapped[uuid.UUID] = _id()
    document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learning_documents.id", ondelete="CASCADE"))
    prompt: Mapped[str]
    choices: Mapped[list] = mapped_column(JSONB)                   # [{id, text}]
    correct_choice_ids: Mapped[list[str]] = mapped_column(ARRAY(Text))
    # {lang: {prompt, choices: {id: text}}}
    translations: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    position: Mapped[float] = mapped_column(Float, server_default=text("0"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = _now()


class LearningPacket(Base):
    __tablename__ = "learning_packets"

    id: Mapped[uuid.UUID] = _id()
    name: Mapped[str]
    description: Mapped[str | None]
    enforce_order: Mapped[bool] = mapped_column(server_default=text("false"))
    due_offset_days: Mapped[int | None]    # null = use the initiative schedule
    icon: Mapped[str | None]
    color: Mapped[str | None]
    archived_at: Mapped[datetime | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class LearningPacketItem(Base):
    __tablename__ = "learning_packet_items"

    packet_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learning_packets.id", ondelete="CASCADE"), primary_key=True)
    document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learning_documents.id"), primary_key=True)
    position: Mapped[float] = mapped_column(Float, server_default=text("0"))
    created_at: Mapped[datetime] = _now()


class LearningRule(Base):
    __tablename__ = "learning_rules"

    id: Mapped[uuid.UUID] = _id()
    name: Mapped[str]
    packet_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learning_packets.id", ondelete="CASCADE"))
    # [{field, values: [str]}]
    conditions: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))
    position: Mapped[float] = mapped_column(Float, server_default=text("0"))
    enabled: Mapped[bool] = mapped_column(server_default=text("true"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class LearningCode(Base):
    __tablename__ = "learning_codes"

    id: Mapped[uuid.UUID] = _id()
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    fingerprint: Mapped[bytes] = mapped_column(BYTEA)
    link_token_hash: Mapped[str] = mapped_column(unique=True)
    expires_at: Mapped[datetime | None]
    failed_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    locked_until: Mapped[datetime | None]
    revoked_at: Mapped[datetime | None]
    last_used_at: Mapped[datetime | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = _now()

    __table_args__ = (
        Index("learning_codes_fingerprint_active_uniq", "fingerprint", unique=True,
              postgresql_where=text("revoked_at IS NULL")),
        Index("learning_codes_person_initiative_active_uniq", "person_id",
              text(f"coalesce(initiative_id, {_ZERO})"), unique=True,
              postgresql_where=text("revoked_at IS NULL")),
    )


class LearningSession(Base):
    __tablename__ = "learning_sessions"

    id: Mapped[uuid.UUID] = _id()
    code_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("learning_codes.id", ondelete="CASCADE"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    token_hash: Mapped[str] = mapped_column(unique=True)
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
    ip: Mapped[str | None]
    user_agent: Mapped[str | None]
    created_at: Mapped[datetime] = _now()


class LearningAssignment(Base):
    __tablename__ = "learning_assignments"

    id: Mapped[uuid.UUID] = _id()
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("learning_documents.id"))
    version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learning_document_versions.id"))      # the version required
    packet_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("learning_packets.id", ondelete="SET NULL"))
    rule_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("learning_rules.id", ondelete="SET NULL"))
    source: Mapped[str]                                   # rule|manual|new_version
    due_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(server_default="assigned")
    opened_at: Mapped[datetime | None]
    signed_at: Mapped[datetime | None]
    signoff_id: Mapped[uuid.UUID | None]
    quiz_locked_at: Mapped[datetime | None]
    # attempts a manager unlock forgave: they no longer count toward the limit
    quiz_attempts_forgiven: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = _now()

    __table_args__ = (
        Index("learning_assignments_open_uniq", "person_id",
              text(f"coalesce(initiative_id, {_ZERO})"), "document_id", unique=True,
              postgresql_where=text("status IN ('assigned', 'opened')")),
    )


class LearningSignoff(Base):
    __tablename__ = "learning_signoffs"

    id: Mapped[uuid.UUID] = _id()
    assignment_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("learning_assignments.id", ondelete="SET NULL"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("learning_documents.id"))
    version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learning_document_versions.id"))
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id", ondelete="SET NULL"))
    language: Mapped[str]
    typed_name: Mapped[str | None]
    signature_png: Mapped[bytes | None] = mapped_column(LargeBinary)
    read_seconds: Mapped[int]
    scrolled_to_end: Mapped[bool] = mapped_column(Boolean)
    quiz_score: Mapped[int | None]
    ip: Mapped[str | None]
    user_agent: Mapped[str | None]
    signed_at: Mapped[datetime] = _now()
    created_at: Mapped[datetime] = _now()


class LearningQuizAttempt(Base):
    __tablename__ = "learning_quiz_attempts"

    id: Mapped[uuid.UUID] = _id()
    assignment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learning_assignments.id", ondelete="CASCADE"))
    answers: Mapped[dict] = mapped_column(JSONB)
    score_percent: Mapped[int]
    passed: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[datetime] = _now()


class LearningInviteSchedule(Base):
    __tablename__ = "learning_invite_schedules"

    initiative_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"), primary_key=True)
    mode: Mapped[str] = mapped_column(server_default="manual")    # manual|scheduled
    send_offset_days: Mapped[int] = mapped_column(Integer, server_default=text("7"))
    send_time: Mapped[time] = mapped_column(Time, server_default=text("'08:00'"))
    reminder_offsets: Mapped[list[int]] = mapped_column(
        ARRAY(Integer), server_default=text("'{5,3}'"))
    due_offset_days: Mapped[int] = mapped_column(Integer, server_default=text("2"))
    late_adds: Mapped[bool] = mapped_column(server_default=text("true"))
    sent_at: Mapped[datetime | None]
    sent_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class LearningEmailLog(Base):
    __tablename__ = "learning_email_log"

    id: Mapped[uuid.UUID] = _id()
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id", ondelete="SET NULL"))
    code_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("learning_codes.id", ondelete="CASCADE"))
    assignment_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("learning_assignments.id", ondelete="SET NULL"))
    kind: Mapped[str]       # invite|reminder|complete|new_version|link
    stage: Mapped[str] = mapped_column(server_default="")
    outbox_id: Mapped[uuid.UUID | None]
    created_at: Mapped[datetime] = _now()

    __table_args__ = (
        Index("learning_email_log_dedupe_uniq", "kind", "person_id",
              text(f"coalesce(code_id, {_ZERO})"), "stage", unique=True),
    )


class LearningOverride(Base):
    __tablename__ = "learning_overrides"

    id: Mapped[uuid.UUID] = _id()
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id", ondelete="SET NULL"))
    site_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sites.id", ondelete="SET NULL"))
    device_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL"))
    admin_person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    reason: Mapped[str]     # signing_on_break|signed_on_paper|no_phone|other
    reason_text: Mapped[str | None]
    scope: Mapped[str]      # punch|day
    local_day: Mapped[date] = mapped_column(Date)
    outstanding: Mapped[list] = mapped_column(JSONB)
    time_entry_id: Mapped[uuid.UUID | None]
    created_at: Mapped[datetime] = _now()
