"""API response/request models (Pydantic)."""

import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    field_validator,
)


def _lower(v: str) -> str:
    return v.lower()


# Vocabulary colours are free-picked and land in a CSS custom property, so the
# format is checked — the status-values spec skipped this when colour was a
# token from a fixed <select>. Case-insensitive in, lowercase out, so equality
# and diffing are stable.
HexColor = Annotated[
    str,
    Field(pattern=r"^#[0-9a-fA-F]{6}$"),
    AfterValidator(_lower),
]


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


class AccountCreateIn(BaseModel):
    """Create a login account for an EXISTING person (external contacts
    promoted to portal users). Mirrors UserCreateIn's account fields."""

    model_config = ConfigDict(extra="forbid")

    login_email: EmailStr
    temp_password: str = Field(min_length=10)
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
    tier: Literal["owner", "admin", "viewer"]
    org_title: str | None = None
    functions: list[str] = []


class ContactAddIn(BaseModel):
    person_id: uuid.UUID
    tier: Literal["owner", "admin", "viewer"] = "viewer"


class ContactUpdateIn(BaseModel):
    """Any subset of {tier, org_title, functions}. Rank rules apply only
    when tier is present; org_title=null clears; functions replaces the
    whole tag list (validated/normalized server-side)."""

    model_config = ConfigDict(extra="forbid")

    tier: Literal["owner", "admin", "viewer"] | None = None
    org_title: str | None = None
    functions: list[str] | None = None


# ── external directory (client/partner contacts + external role) ──

class ExternalLinkItem(BaseModel):
    kind: Literal["client", "partner"]
    org_id: uuid.UUID
    org_name: str
    tier: Literal["owner", "admin", "viewer"]
    org_title: str | None
    functions: list[str]


class ExternalPersonItem(BaseModel):
    person_id: uuid.UUID
    display_name: str
    first_name: str
    last_name: str
    email: str | None
    phone: str | None
    avatar_url: str | None
    has_login: bool
    login_status: Literal["none", "active", "disabled"]
    links: list[ExternalLinkItem]


class ExternalDirectoryOut(BaseModel):
    people: list[ExternalPersonItem]
    function_tags: list[str]


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
    color: str


class WorkerLevelUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(None, min_length=1)
    description: str | None = None
    expected_skills: list[str] | None = None
    color: HexColor | None = None


class WorkerLevelCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    level: str = Field(min_length=1, max_length=10)
    title: str = Field(min_length=1)
    description: str = ""
    expected_skills: list[str] = []
    color: HexColor
    # A POSITION, not a rank: names the level to insert after; None = first.
    # Required-but-nullable on purpose — the server computes the rank, so no
    # client-side arithmetic and a stale client list can't produce a wrong one.
    after: str | None


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
    level_color: str | None     # None = unleveled; worker_levels.color otherwise
    status: str                 # any status_values key under record_type='worker'
    status_label: str
    status_color: str
    status_note: str | None
    partner: PartnerRef | None
    cert_count: int
    certs_expired: int


class WorkerProfileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trade: str | None = None
    level: str | None = None
    partner_id: uuid.UUID | None = None
    # Not a Literal: statuses are vocabulary rows in status_values
    # (record_type='worker'), created via /status-values by a developer.
    # Runtime-validated in routes/workers.py's upsert_profile against
    # StatusValue, mirroring how sites validate `status` in _check_lookups.
    status: str | None = None
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


# ── sites ──────────────────────────────────────────────────────────


class ClientRef(BaseModel):
    client_id: uuid.UUID
    name: str


class SiteItem(BaseModel):
    id: uuid.UUID
    name: str
    code: str | None = None
    site_type: str | None = None
    type_label: str | None = None
    type_color: str | None = None
    status: str
    status_label: str
    status_color: str
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    region: str | None = None
    postal_code: str | None = None
    country: str
    latitude: float | None = None
    longitude: float | None = None
    timezone: str | None = None
    dc_provider: str | None = None
    partner_id: uuid.UUID | None = None
    partner_name: str | None = None
    notes: str | None = None
    archived_at: datetime | None = None
    created_at: datetime
    clients: list[ClientRef] = []


class SiteDetail(SiteItem):
    survey_data: dict = {}


class StatusValueOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    record_type: str
    key: str
    label: str
    description: str
    color: str
    sort_order: int
    is_active: bool
    # populated only on the devtools-gated listing — an entity-scoped read
    # has no business paying for the count query
    usage_count: int | None = None


class StatusValueCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_type: str
    # slug, not prose — this is a stable identifier code may compare against
    key: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    label: str = Field(min_length=1)
    description: str = ""
    color: HexColor
    sort_order: int = 0


class StatusValueUpdateIn(BaseModel):
    # extra="forbid" is what makes key/record_type immutable — a PATCH naming
    # them is a 422, not a silent no-op
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(None, min_length=1)
    description: str | None = None
    color: HexColor | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class SiteLookupOut(BaseModel):
    key: str
    label: str
    description: str
    sort_order: int
    icon: str | None = None
    color: str | None = None
    model_config = ConfigDict(from_attributes=True)


class SiteTypeCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # slug, not prose — this is a stable identifier and an FK target
    key: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    label: str = Field(min_length=1)
    description: str = ""
    sort_order: int = 0
    icon: str | None = None
    color: HexColor


class SiteLookupUpdateIn(BaseModel):
    # Fields mirror update_site_type's mutable set exactly — a field the handler
    # does not write is how you get a silent no-op. `color` was removed in
    # ae198dd when 0012 folded site_statuses into status_values and left this
    # schema's colour vestigial; 0013 gave site_types its own colour column, so
    # it is real again and the handler writes it.
    label: str | None = None
    description: str | None = None
    sort_order: int | None = None
    icon: str | None = None
    color: HexColor | None = None


class SiteClientsIn(BaseModel):
    client_ids: list[uuid.UUID]


class SiteSurveyIn(BaseModel):
    survey_data: dict


class SiteCreateIn(BaseModel):
    name: str = Field(min_length=1)
    code: str | None = None
    site_type: str | None = None
    status: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    region: str | None = None
    postal_code: str | None = None
    country: str = "US"
    latitude: float | None = None
    longitude: float | None = None
    timezone: str | None = None
    dc_provider: str | None = None
    partner_id: uuid.UUID | None = None
    notes: str | None = None
    model_config = ConfigDict(extra="forbid")   # rejects survey_data


class SiteUpdateIn(BaseModel):
    name: str | None = None
    code: str | None = None
    site_type: str | None = None
    status: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    region: str | None = None
    postal_code: str | None = None
    country: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    timezone: str | None = None
    dc_provider: str | None = None
    partner_id: uuid.UUID | None = None
    notes: str | None = None
    model_config = ConfigDict(extra="forbid")   # rejects survey_data


class GodModeIn(BaseModel):
    word: str
