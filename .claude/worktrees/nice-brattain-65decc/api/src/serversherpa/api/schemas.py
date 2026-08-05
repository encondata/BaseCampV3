"""API response/request models (Pydantic)."""

import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class PersonOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    first_name: str
    last_name: str
    preferred_name: str | None
    display_name: str
    email: str | None
    job_title: str | None
    avatar_key: str | None
    avatar_url: str | None = None  # presigned; set by routes via with_avatar()


class NotifPrefs(BaseModel):
    model_config = ConfigDict(extra="ignore")

    critical: bool = True
    email: bool = True
    maint: bool = True
    digest: bool = False


NAMED_ACCENTS = {"amber", "aqua", "blue", "violet", "pink", "green"}


class UiPreferences(BaseModel):
    """Per-account UI preferences, stored in user_accounts.ui_prefs (JSONB).
    Unknown keys are dropped on read, so retired options age out safely."""

    model_config = ConfigDict(extra="ignore")

    accent: str = "amber"  # a named accent or a custom #rrggbb color
    theme: Literal["light", "dark"] = "light"
    density: Literal["comfortable", "compact"] = "comfortable"
    motion: bool = True
    notif: NotifPrefs = NotifPrefs()

    @field_validator("accent")
    @classmethod
    def _accent_named_or_hex(cls, v: str) -> str:
        if v in NAMED_ACCENTS or re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            return v
        raise ValueError("accent must be a named accent or #rrggbb")


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class ScopeOut(BaseModel):
    global_: bool = Field(alias="global")
    client_ids: list[uuid.UUID] = []
    partner_ids: list[uuid.UUID] = []
    model_config = ConfigDict(populate_by_name=True)


class SessionOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int              # access-token TTL, seconds
    session_expires_at: datetime  # absolute end of the login (24h rule)
    person: PersonOut
    roles: list[str]
    must_change_password: bool
    preferences: UiPreferences
    perms: dict[str, dict[str, bool]]
    max_rank: int
    scope: ScopeOut


class MeOut(BaseModel):
    person: PersonOut
    roles: list[str]
    session_expires_at: datetime
    must_change_password: bool
    preferences: UiPreferences
    perms: dict[str, dict[str, bool]]
    max_rank: int
    scope: ScopeOut


class ErrorOut(BaseModel):
    code: str


class PersonDetail(BaseModel):
    """Full person record for the profile page."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    first_name: str
    last_name: str
    preferred_name: str | None
    display_name: str
    email: str | None
    phone: str | None
    job_title: str | None
    address_line1: str | None
    address_line2: str | None
    city: str | None
    region: str | None
    postal_code: str | None
    country: str
    badge_uid: uuid.UUID
    created_at: datetime
    avatar_key: str | None = None
    avatar_url: str | None = None


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    kind: str
    storage_key: str
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime
    url: str | None = None  # presigned


class ProfileUpdateIn(BaseModel):
    """Self-service profile edit. Only provided fields change; explicit
    null clears a nullable field."""

    model_config = ConfigDict(extra="forbid")

    first_name: str | None = Field(None, min_length=1)
    last_name: str | None = Field(None, min_length=1)
    preferred_name: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    job_title: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    region: str | None = None
    postal_code: str | None = None
    country: str | None = Field(None, min_length=2, max_length=2)


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12)


class ResetPasswordIn(BaseModel):
    temp_password: str = Field(min_length=12)
    must_change_password: bool = True


class RolesUpdateIn(BaseModel):
    roles: list[str]


class SessionItem(BaseModel):
    """One live login (family) on the active-sessions panel."""

    family_id: uuid.UUID
    started_at: datetime
    last_active_at: datetime
    expires_at: datetime
    ip_address: str | None
    user_agent: str | None
    current: bool


class UserItem(BaseModel):
    """A person with a login account — the Users directory row."""

    person_id: uuid.UUID
    first_name: str
    last_name: str
    preferred_name: str | None
    display_name: str
    job_title: str | None
    phone: str | None
    contact_email: str | None      # people.email
    login_email: str | None        # user_accounts.email (None only on create without account)
    roles: list[str]
    status: str                    # active | locked | disabled | no_account
    must_change_password: bool
    last_login_at: datetime | None
    account_created_at: datetime | None
    archived_at: datetime | None
    max_rank: int = 0
    avatar_url: str | None = None


class SearchResult(BaseModel):
    """One global-search hit. `kind` tells the client where it links."""

    kind: str          # 'user' (sites/projects/assets join later)
    id: uuid.UUID
    label: str
    sub: str | None


class SearchOut(BaseModel):
    results: list[SearchResult]


class UserCreateIn(BaseModel):
    """Add-person form: person record + optional login account + role grants."""

    model_config = ConfigDict(extra="forbid")

    first_name: str = Field(min_length=1)
    last_name: str = Field(min_length=1)
    preferred_name: str | None = None
    contact_email: EmailStr | None = None
    phone: str | None = None
    job_title: str | None = None
    roles: list[str] = []
    create_account: bool = True
    login_email: EmailStr | None = None
    temp_password: str | None = Field(None, min_length=10)
    must_change_password: bool = True


# ── stakeholders (clients & partners) ──────────────────────────────

ORG_STATUSES = {"prospect", "active", "dormant"}
ORG_TIERS = {"standard", "preferred", "strategic"}
PARTNER_TYPES = {"staffing", "logistics", "subcontractor", "consultant", "other"}


class ManagerRef(BaseModel):
    id: uuid.UUID
    display_name: str


class OrgItem(BaseModel):
    """A stakeholder organization row (client or partner)."""

    id: uuid.UUID
    name: str
    code: str | None
    partner_types: list[str] = []   # partners only
    status: str
    tier: str
    phone: str | None
    website: str | None
    address_line1: str | None
    address_line2: str | None
    city: str | None
    region: str | None
    postal_code: str | None
    country: str
    notes: str | None
    account_manager: ManagerRef | None
    contact_count: int
    logo_url: str | None
    archived_at: datetime | None
    created_at: datetime


class OrgCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    code: str | None = None
    partner_types: list[Literal["staffing", "logistics", "subcontractor",
                               "consultant", "other"]] = []
    status: Literal["prospect", "active", "dormant"] = "active"
    tier: Literal["standard", "preferred", "strategic"] = "standard"
    phone: str | None = None
    website: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    region: str | None = None
    postal_code: str | None = None
    country: str | None = Field(None, min_length=2, max_length=2)
    notes: str | None = None
    account_manager_id: uuid.UUID | None = None


class OrgUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1)
    code: str | None = None
    partner_types: list[Literal["staffing", "logistics", "subcontractor",
                               "consultant", "other"]] | None = None
    status: Literal["prospect", "active", "dormant"] | None = None
    tier: Literal["standard", "preferred", "strategic"] | None = None
    phone: str | None = None
    website: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    region: str | None = None
    postal_code: str | None = None
    country: str | None = Field(None, min_length=2, max_length=2)
    notes: str | None = None
    account_manager_id: uuid.UUID | None = None


class ContactItem(BaseModel):
    """A person linked to an organization via a scoped role grant."""

    person_id: uuid.UUID
    display_name: str
    email: str | None
    phone: str | None
    job_title: str | None
    avatar_url: str | None
    has_account: bool
    granted_at: datetime


class ContactAddIn(BaseModel):
    person_id: uuid.UUID


class PersonListItem(BaseModel):
    """Minimal person row for pickers (all people, accounted or not)."""

    person_id: uuid.UUID
    display_name: str
    email: str | None
    job_title: str | None
    avatar_url: str | None
    has_account: bool


# ── workers ────────────────────────────────────────────────────────

from datetime import date as _date  # noqa: E402


class WorkerLevelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    level: str
    rank: int
    title: str
    description: str
    expected_skills: list[str]


class WorkerLevelUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(None, min_length=1)
    description: str | None = None
    expected_skills: list[str] | None = None


class PartnerRef(BaseModel):
    id: uuid.UUID
    name: str


class WorkerItem(BaseModel):
    person_id: uuid.UUID
    display_name: str
    first_name: str
    last_name: str
    contact_email: str | None
    phone: str | None
    avatar_url: str | None
    has_account: bool
    trade: str | None
    level: str | None
    status: str                 # active | standby | blacklist
    status_note: str | None
    partner: PartnerRef | None
    cert_count: int
    certs_expired: int


class WorkerProfileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trade: str | None = None
    level: str | None = None
    partner_id: uuid.UUID | None = None
    status: Literal["active", "standby", "blacklist"] | None = None
    status_note: str | None = None


class CertItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    issuer: str | None
    issued_on: _date | None
    expires_on: _date | None


class CertCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    issuer: str | None = None
    issued_on: _date | None = None
    expires_on: _date | None = None
