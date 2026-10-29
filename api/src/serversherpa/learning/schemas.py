"""Pydantic schemas for the learning API (every learning route's bodies and
responses live here)."""

import re
import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

ResignRule = Literal["every_initiative", "expired_or_new_version"]
SignStyle = Literal["checkbox", "typed_name", "drawn_signature"]
QuizFailAction = Literal["retry", "lock"]

# the wiki's own limits: a node title, a publish note
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)]

# settings that can't be cleared (NOT NULL columns)
_NOT_NULL = ("title", "wiki_node_id", "resign_rule", "sign_style", "require_scroll",
             "quiz_enabled", "quiz_fail_action")


# ── documents ────────────────────────────────────────────────────────


class DocumentSettings(BaseModel):
    """A document's reading and sign-off settings, checked as a whole: a
    quiz needs a pass mark, and locking after failures needs an attempt
    limit. Quiz fields are kept (and ignored) while the quiz is off."""
    model_config = ConfigDict(extra="forbid")

    summary: Note | None = None
    validity_days: int | None = Field(default=None, ge=1)     # null = never expires
    resign_rule: ResignRule = "expired_or_new_version"
    sign_style: SignStyle = "typed_name"
    require_scroll: bool = True
    min_read_seconds: int | None = Field(default=None, ge=1)
    quiz_enabled: bool = False
    quiz_pass_percent: int | None = Field(default=None, ge=1, le=100)
    quiz_max_attempts: int | None = Field(default=None, ge=1)
    quiz_fail_action: QuizFailAction = "retry"

    @model_validator(mode="after")
    def _quiz(self):
        if self.quiz_enabled and self.quiz_pass_percent is None:
            raise ValueError("A quiz needs a pass mark (quiz_pass_percent).")
        if (self.quiz_enabled and self.quiz_fail_action == "lock"
                and self.quiz_max_attempts is None):
            raise ValueError("Locking after failed attempts needs quiz_max_attempts.")
        return self


SETTING_FIELDS = tuple(DocumentSettings.model_fields)


class DocumentCreateIn(DocumentSettings):
    title: Title
    wiki_node_id: uuid.UUID


class DocumentPatchIn(BaseModel):
    """Only the keys sent change; the merged settings are then checked as
    `DocumentSettings`. Null clears the nullable settings only."""
    model_config = ConfigDict(extra="forbid")

    title: Title | None = None
    wiki_node_id: uuid.UUID | None = None
    summary: Note | None = None
    validity_days: int | None = Field(default=None, ge=1)
    resign_rule: ResignRule | None = None
    sign_style: SignStyle | None = None
    require_scroll: bool | None = None
    min_read_seconds: int | None = Field(default=None, ge=1)
    quiz_enabled: bool | None = None
    quiz_pass_percent: int | None = Field(default=None, ge=1, le=100)
    quiz_max_attempts: int | None = Field(default=None, ge=1)
    quiz_fail_action: QuizFailAction | None = None

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in _NOT_NULL:
                if key in data and data[key] is None:
                    raise ValueError(f"{key} can't be cleared.")
        return data


class PublishIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    change_note: Note | None = None


class PersonRef(BaseModel):
    id: uuid.UUID
    name: str


class WikiPageRef(BaseModel):
    id: uuid.UUID
    title: str
    published_version_no: int | None


class VersionSummary(BaseModel):
    id: uuid.UUID
    version_no: int
    wiki_version_no: int | None
    title: str
    change_note: str | None
    published_at: datetime
    published_by: PersonRef | None


class VersionOut(VersionSummary):
    html: str


class DocumentSignoffOut(BaseModel):
    id: uuid.UUID
    person: PersonRef
    version_no: int
    language: str
    signed_at: datetime
    read_seconds: int
    quiz_score: int | None
    initiative_id: uuid.UUID | None
    initiative: str | None


class DocumentSignoffsOut(BaseModel):
    """One page of a document's sign-offs (newest first) with the totals the
    Versions tab shows: `total` for the filter, and a count per version id."""
    total: int
    version_counts: dict[str, int]
    items: list[DocumentSignoffOut]


class DocumentOut(BaseModel):
    id: uuid.UUID
    title: str
    summary: str | None
    validity_days: int | None
    resign_rule: str
    sign_style: str
    require_scroll: bool
    min_read_seconds: int | None
    quiz_enabled: bool
    quiz_pass_percent: int | None
    quiz_max_attempts: int | None
    quiz_fail_action: str
    wiki_node_id: uuid.UUID | None
    # the linked wiki page, null once it's trashed, purged or moved out
    wiki_page: WikiPageRef | None
    # the wiki page has a published version newer than the current snapshot
    has_wiki_changes: bool
    current_version_id: uuid.UUID | None
    current_version_no: int | None
    current_html: str | None
    versions: list[VersionSummary]
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


class DocumentListItem(BaseModel):
    id: uuid.UUID
    title: str
    current_version_no: int | None
    published_at: datetime | None
    packets: list[str]
    signoff_count: int
    # language → its newest translation's status, or "out_of_date" when
    # that translation is of an older version than the current one
    languages: dict[str, str]
    archived_at: datetime | None


class WikiPageOption(BaseModel):
    """A page in the learning space, for the "link a page" picker."""
    id: uuid.UUID
    title: str
    path: list[str]                     # ancestor titles, root first
    published_version_no: int | None


# ── packets ──────────────────────────────────────────────────────────

# '#rrggbb', as initiative colors
HexColor = Annotated[str, StringConstraints(pattern=r"^#[0-9a-fA-F]{6}$")]
IconName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]

_PACKET_NOT_NULL = ("name", "enforce_order")


class PacketCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Title
    description: Note | None = None
    enforce_order: bool = False
    due_offset_days: int | None = Field(default=None, ge=0)   # null = the initiative schedule
    icon: IconName | None = None
    color: HexColor | None = None
    items: list[uuid.UUID] = []                               # document ids, in order


class PacketPatchIn(BaseModel):
    """Only the keys sent change; `items`, when sent, replaces the list."""
    model_config = ConfigDict(extra="forbid")

    name: Title | None = None
    description: Note | None = None
    enforce_order: bool | None = None
    due_offset_days: int | None = Field(default=None, ge=0)
    icon: IconName | None = None
    color: HexColor | None = None
    items: list[uuid.UUID] | None = None

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in (*_PACKET_NOT_NULL, "items"):
                if key in data and data[key] is None:
                    raise ValueError(f"{key} can't be cleared.")
        return data


class PacketItemOut(BaseModel):
    document_id: uuid.UUID
    title: str
    current_version_no: int | None
    archived: bool


class PacketListItem(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    enforce_order: bool
    due_offset_days: int | None
    icon: str | None
    color: str | None
    item_count: int
    rule_count: int
    archived_at: datetime | None


class PacketOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    enforce_order: bool
    due_offset_days: int | None
    icon: str | None
    color: str | None
    items: list[PacketItemOut]
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


# ── assignment rules ─────────────────────────────────────────────────


class ConditionIn(BaseModel):
    """`field` is checked by the rules service (422 `bad_rule_field`), not
    here, so the error code is the API's own."""
    model_config = ConfigDict(extra="forbid")

    field: str
    values: list[str] = []


class RuleCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Title
    packet_id: uuid.UUID
    conditions: list[ConditionIn]
    enabled: bool = True


class RulePatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Title | None = None
    packet_id: uuid.UUID | None = None
    conditions: list[ConditionIn] | None = None
    enabled: bool | None = None

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ("name", "packet_id", "conditions", "enabled"):
                if key in data and data[key] is None:
                    raise ValueError(f"{key} can't be cleared.")
        return data


class RuleReorderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: list[uuid.UUID]


class RuleOut(BaseModel):
    id: uuid.UUID
    name: str
    packet_id: uuid.UUID
    packet_name: str
    packet_archived: bool
    conditions: list[ConditionIn]
    position: float
    enabled: bool
    created_at: datetime
    updated_at: datetime


# ── assignments ──────────────────────────────────────────────────────


class DryRunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    apply: bool = False


class AssignIn(BaseModel):
    """Manual assignment: a packet, listed documents, or both."""
    model_config = ConfigDict(extra="forbid")

    person_ids: list[uuid.UUID] = Field(min_length=1)
    initiative_id: uuid.UUID | None = None
    packet_id: uuid.UUID | None = None
    document_ids: list[uuid.UUID] = []

    @model_validator(mode="after")
    def _something(self) -> "AssignIn":
        if self.packet_id is None and not self.document_ids:
            raise ValueError("Pick a packet or at least one document.")
        return self


class PushVersionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    person_ids: list[uuid.UUID] = Field(min_length=1)


class SkippedItem(BaseModel):
    title: str
    reason: str


class AssignSummaryRow(BaseModel):
    person_id: uuid.UUID
    name: str
    will_get: list[str]
    # one reason per `will_get` entry
    why: list[str]
    skipped: list[SkippedItem]
    no_email: bool


class AssignTotals(BaseModel):
    checked: int
    to_assign: int
    skipped: int
    no_email: int


class AssignSummaryOut(BaseModel):
    """The per-person review summary the dry run, manual assignment and
    pushed versions all return."""
    rows: list[AssignSummaryRow]
    totals: AssignTotals


# ── initiative learning: schedule, invites, roster ───────────────────

_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class ScheduleIn(BaseModel):
    """Partial update of an initiative's invite schedule, checked like the
    learning settings' defaults: no nulls, HH:MM, unique reminder days."""
    model_config = ConfigDict(extra="forbid")

    mode: Literal["manual", "scheduled"] | None = None
    send_offset_days: int | None = Field(default=None, ge=1)
    send_time: str | None = None
    reminder_offsets: list[Annotated[int, Field(ge=0, le=365)]] | None = None
    due_offset_days: int | None = Field(default=None, ge=1)
    late_adds: bool | None = None

    @model_validator(mode="after")
    def _check(self) -> "ScheduleIn":
        for key in self.model_fields_set:
            if getattr(self, key) is None:
                raise ValueError(f"{key} cannot be null")
        if self.send_time is not None and not _HHMM.match(self.send_time):
            raise ValueError("send_time must be HH:MM")
        offsets = self.reminder_offsets
        if offsets is not None and len(set(offsets)) != len(offsets):
            raise ValueError("reminder_offsets must be unique")
        return self


class ScheduleOut(BaseModel):
    mode: Literal["manual", "scheduled"]
    send_offset_days: int
    send_time: str
    reminder_offsets: list[int]
    due_offset_days: int
    late_adds: bool
    sent_at: datetime | None
    # when a scheduled send will go out (or would, for a manual schedule)
    send_at: datetime | None
    codes_expire_on: date | None
    # the initiative's local end day is before today: no invites go out
    ended: bool
    # archived, cancelled or completed: no invites or reminders go out
    inactive: bool
    # no schedule saved yet: these are the learning settings' defaults
    is_default: bool


class LearningStatsOut(BaseModel):
    invited: int
    opened: int
    in_progress: int
    complete: int
    overdue: int


class PacketBrief(BaseModel):
    id: uuid.UUID
    name: str
    documents: list[str]


class RequiredPacketOut(BaseModel):
    packet: PacketBrief
    rule_name: str | None
    every_initiative: bool


class ExtraOut(BaseModel):
    title: str
    people: int


class TimelineEventOut(BaseModel):
    date: date
    kind: Literal["invite", "reminder", "due", "start"]


class InitiativeLearningOut(BaseModel):
    stats: LearningStatsOut
    schedule: ScheduleOut
    packets: list[RequiredPacketOut]
    extras: list[ExtraOut]
    timeline: list[TimelineEventOut]


class SendInvitesIn(BaseModel):
    """No `person_ids`: everyone with open assignments. With them: Resend."""
    model_config = ConfigDict(extra="forbid")

    person_ids: list[uuid.UUID] | None = Field(default=None, min_length=1)


class SendInvitesOut(BaseModel):
    sent: int
    no_email: int
    skipped_complete: int
    # a full send leaves people with a working, emailed code alone
    already_invited: int


class RemindIn(BaseModel):
    """No `person_ids`: everyone with open assignments."""
    model_config = ConfigDict(extra="forbid")

    person_ids: list[uuid.UUID] | None = Field(default=None, min_length=1)


class RemindOut(BaseModel):
    sent: int
    no_email: int
    # no working code: Send now / Resend invites them, a reminder doesn't
    no_code: int
    skipped_complete: int


RosterStatus = Literal["nothing_assigned", "complete", "in_progress", "overdue", "not_opened",
                       "no_email"]


class RosterRowOut(BaseModel):
    person_id: uuid.UUID
    name: str
    email: str | None
    partner: str | None
    language: str
    done: int
    total: int
    status: RosterStatus
    last_activity: datetime | None


class RegenerateOut(BaseModel):
    sent: bool


class RevokeCodesOut(BaseModel):
    revoked: int


# ── worker sign-in (/learn/auth) ─────────────────────────────────────


class LearnCodeIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    last_name: str = Field(min_length=1, max_length=200)


class LearnLinkIn(BaseModel):
    token: str = Field(min_length=1, max_length=200)


class LearnPersonOut(BaseModel):
    first_name: str


class LearnSessionOut(BaseModel):
    token: str
    expires_at: datetime
    person: LearnPersonOut


class LearnMeOut(BaseModel):
    person_id: uuid.UUID
    first_name: str
    via: Literal["code", "account"]


# ── my training (/learn/training, /learn/assignments) ────────────────

# a language tag as translations store it ("ja", "pt-BR")
LANG_PATTERN = r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$"
Lang = Annotated[str, StringConstraints(strip_whitespace=True, pattern=LANG_PATTERN)]


class TrainingInitiativeOut(BaseModel):
    id: uuid.UUID
    name: str
    start: date | None


class TrainingItemOut(BaseModel):
    assignment_id: uuid.UUID
    title: str
    status: Literal["assigned", "opened", "signed"]
    minutes: int
    has_quiz: bool
    locked: bool
    signed_at: datetime | None


class TrainingGroupOut(BaseModel):
    initiative: TrainingInitiativeOut | None
    due_on: date | None
    items: list[TrainingItemOut]


class TrainingOut(BaseModel):
    groups: list[TrainingGroupOut]
    complete: bool
    badge_uid: str | None       # the time clock QR value, only when complete


class AssignmentReadOut(BaseModel):
    title: str
    html: str
    language: str
    fallback: bool
    version_no: int
    change_note: str | None
    sign_style: SignStyle
    require_scroll: bool
    min_read_seconds: int | None
    has_quiz: bool
    quiz_passed: bool
    signed_at: datetime | None      # set once the assignment is signed (review mode)


class HistoryInitiativeOut(BaseModel):
    id: uuid.UUID
    name: str


class HistoryItemOut(BaseModel):
    assignment_id: uuid.UUID
    title: str                      # of the version signed
    version_no: int
    initiative: HistoryInitiativeOut | None
    signed_at: datetime
    language: str
    newer_version: bool             # the document has a newer published version


class QuizChoiceOut(BaseModel):
    id: str
    text: str


class QuizQuestionOut(BaseModel):
    id: uuid.UUID
    prompt: str
    choices: list[QuizChoiceOut]
    multiple: bool


class QuizAnswersIn(BaseModel):
    answers: dict[str, list[str]] = Field(default_factory=dict)


class QuizResultOut(BaseModel):
    score_percent: int
    passed: bool
    attempts_left: int | None   # null when attempts aren't limited
    locked: bool


class SignIn(BaseModel):
    # agreed/typed_name/signature are checked in the service so each refusal
    # has its own code (must_agree, name_required, signature_required)
    agreed: bool = False
    typed_name: str | None = Field(default=None, max_length=200)
    signature_png_b64: str | None = None
    language: Lang = "en"
    scrolled_to_end: bool = False
    # the version the Reader showed; a newer one published since is a 409
    # `version_changed` (left out: the current version, as before)
    version_no: int | None = Field(default=None, ge=1)


class SignOut(BaseModel):
    signoff_id: uuid.UUID
    signed_at: datetime
    complete: bool


# ── translations ─────────────────────────────────────────────────────

# a translated page is bounded like any request body, not by a policy
TRANSLATION_HTML_MAX = 2_000_000
TranslationStatus = Literal["draft", "in_review", "published", "out_of_date", "missing"]


class TranslationSaveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Title
    content_html: Annotated[str, StringConstraints(min_length=1, max_length=TRANSLATION_HTML_MAX)]


class TranslationStatusOut(BaseModel):
    language: str
    status: TranslationStatus
    version_no: int | None
    updated_at: datetime | None
    reviewed_by: PersonRef | None


class TranslationOut(BaseModel):
    """One language's newest translation, in full (for the editor)."""
    language: str
    status: TranslationStatus
    version_no: int
    current_version_no: int | None
    title: str
    content_html: str
    source: Literal["claude", "manual"]
    updated_at: datetime
    updated_by: PersonRef | None
    reviewed_by: PersonRef | None
    reviewed_at: datetime | None


# ── quiz questions ───────────────────────────────────────────────────

ChoiceId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
ChoiceText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                              max_length=1000)]
QuestionPrompt = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                                  max_length=2000)]


class ChoiceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: ChoiceId | None = None          # new choices get one
    text: ChoiceText


class ChoiceOut(BaseModel):
    id: str
    text: str


class QuestionTranslationIn(BaseModel):
    """A question in one language: any of the prompt and the choices'
    texts (by choice id); what's missing falls back to English."""
    model_config = ConfigDict(extra="forbid")

    prompt: QuestionPrompt | None = None
    choices: dict[ChoiceId, ChoiceText] = Field(default_factory=dict)


class QuestionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: QuestionPrompt
    choices: list[ChoiceIn]
    correct_choice_ids: list[ChoiceId]
    translations: dict[Lang, QuestionTranslationIn] = Field(default_factory=dict)


class QuestionPatchIn(BaseModel):
    """Only the keys sent change; the merged question is then checked."""
    model_config = ConfigDict(extra="forbid")

    prompt: QuestionPrompt | None = None
    choices: list[ChoiceIn] | None = None
    correct_choice_ids: list[ChoiceId] | None = None
    translations: dict[Lang, QuestionTranslationIn] | None = None

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key, value in data.items():
                if value is None:
                    raise ValueError(f"{key} can't be cleared.")
        return data


class QuestionReorderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: list[uuid.UUID]


class QuestionOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    prompt: str
    choices: list[ChoiceOut]
    correct_choice_ids: list[str]
    translations: dict[str, Any]
    position: float
    created_at: datetime


class UnlockQuizOut(BaseModel):
    assignment_id: uuid.UUID
    attempts_forgiven: int


# ── dashboard, compliance grid, person history ───────────────────────


class FunnelOut(BaseModel):
    assigned: int
    opened: int
    complete: int
    median_open_hours: float | None
    median_finish_minutes: float | None


class OverridesOut(BaseModel):
    count: int
    admins: int


class AtRiskOut(BaseModel):
    initiative_id: uuid.UUID
    name: str
    starts_in_days: int
    percent: int
    not_finished: int
    no_email: int


class ExpiringOut(BaseModel):
    document_id: uuid.UUID
    title: str
    people: int
    first_date: date


class TranslationIssueOut(BaseModel):
    document_id: uuid.UUID
    title: str
    language: str


class HardQuestionOut(BaseModel):
    question_id: uuid.UUID
    document_title: str
    miss_percent: int


class DashboardOut(BaseModel):
    funnel: FunnelOut
    overrides: OverridesOut
    at_risk: list[AtRiskOut]
    expiring: list[ExpiringOut]
    translation_issues: list[TranslationIssueOut]
    hard_questions: list[HardQuestionOut]


GridState = Literal["valid", "expires_during", "missing", "not_required"]


class GridDocumentOut(BaseModel):
    id: uuid.UUID
    title: str


class GridCellOut(BaseModel):
    state: GridState
    label: str


class GridRowOut(BaseModel):
    person_id: uuid.UUID
    name: str
    cells: dict[uuid.UUID, GridCellOut]


class GridOut(BaseModel):
    documents: list[GridDocumentOut]
    rows: list[GridRowOut]


class HistoryPersonOut(BaseModel):
    id: uuid.UUID
    name: str


class HistorySignoffOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    document: str
    version: int
    language: str
    signed_at: datetime
    read_seconds: int
    quiz_score: int | None
    initiative_id: uuid.UUID | None
    initiative: str | None


class HistoryAttemptOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    document: str
    score_percent: int
    passed: bool
    created_at: datetime
    initiative_id: uuid.UUID | None
    initiative: str | None


class HistoryOverrideOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    reason: str
    reason_text: str | None
    scope: str
    local_day: date
    admin: str | None
    initiative_id: uuid.UUID | None
    initiative: str | None


class HistoryAssignmentOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    document: str
    status: str
    source: str
    due_on: date | None
    initiative_id: uuid.UUID | None
    initiative: str | None


class HistoryOut(BaseModel):
    person: HistoryPersonOut
    signoffs: list[HistorySignoffOut]
    quiz_attempts: list[HistoryAttemptOut]
    overrides: list[HistoryOverrideOut]
    open_assignments: list[HistoryAssignmentOut]
