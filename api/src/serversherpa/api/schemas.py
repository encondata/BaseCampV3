"""API response/request models (Pydantic)."""

import json
import re
import urllib.parse
import uuid
from datetime import date, datetime, time
from typing import Annotated, Any, Literal

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
    # in-app sound played when a new inbox item arrives while the portal is open
    sound: Literal["none", "chime", "ping", "pop", "bell"] = "chime"


NAMED_ACCENTS = {"amber", "aqua", "blue", "violet", "pink", "green"}


class UiPreferences(BaseModel):
    """Per-account UI preferences, stored in user_accounts.ui_prefs (JSONB).
    Unknown keys are dropped on read, so retired options age out safely."""

    model_config = ConfigDict(extra="ignore")

    accent: str = "amber"  # a named accent or a custom #rrggbb color
    theme: Literal["light", "dark"] = "light"
    density: Literal["comfortable", "compact"] = "comfortable"
    list_size: Literal["small", "default", "large", "xlarge"] = "default"
    motion: bool = True
    notif: NotifPrefs = NotifPrefs()
    # Per-page list UI state (visible columns, sort, column filters), keyed
    # by page — free-form so the portal can evolve the shape without an API
    # change. Same PUT endpoint as every other preference; the portal is
    # responsible for merging so one page's save never clobbers another's.
    list_prefs: dict = {}
    nav_mode: Literal["expanded", "rail", "hidden"] = "expanded"
    nav_bg: str = "default"      # "default" or a custom #rrggbb color
    nav_size: Literal["small", "default", "large", "xlarge"] = "default"

    @field_validator("accent")
    @classmethod
    def _accent_named_or_hex(cls, v: str) -> str:
        if v in NAMED_ACCENTS or re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            return v
        raise ValueError("accent must be a named accent or #rrggbb")

    @field_validator("nav_bg")
    @classmethod
    def _nav_bg_default_or_hex(cls, v: str) -> str:
        if v == "default" or re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            return v
        raise ValueError("nav_bg must be 'default' or #rrggbb")


class LoginIn(BaseModel):
    email: EmailStr
    password: str
    # "kiosk" adds the kiosk:view gate before a session is minted (the
    # kiosk app sends it; the portal never does).
    client: Literal["portal", "kiosk"] = "portal"


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
    password_min_length: int = 8


class MeOut(BaseModel):
    person: PersonOut
    roles: list[str]
    session_expires_at: datetime
    must_change_password: bool
    preferences: UiPreferences
    perms: dict[str, dict[str, bool]]
    max_rank: int
    scope: ScopeOut
    password_min_length: int = 8


class ErrorOut(BaseModel):
    code: str


# ── kiosk: pairing + heartbeat ─────────────────────────────────────

from serversherpa.services.kiosk_pairing import PairStatus  # noqa: E402


class PairCreateIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=80)

    @field_validator("serial", "name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("blank")
        return v


class PairCreateOut(BaseModel):
    code: str
    poll_token: str          # returned exactly once; only its hash is stored
    link_url: str
    expires_at: datetime


class PairPollIn(BaseModel):
    poll_token: str = Field(min_length=1, max_length=200)


class PairPollOut(BaseModel):
    status: PairStatus
    session: SessionOut | None = None   # present only when status == "approved"


class PairInfoOut(BaseModel):
    code: str
    kiosk_name: str
    serial: str
    status: PairStatus
    expires_at: datetime


class HeartbeatIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=80)
    mode: Literal["web", "laptop", "pi", "android", "ios"]
    version: str | None = Field(default=None, max_length=40)
    raw_info: dict[str, Any] = Field(default_factory=dict)
    sign_in: bool = False
    login_method: Literal["password", "link"] | None = None

    @field_validator("serial", "name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("blank")
        return v

    @field_validator("raw_info")
    @classmethod
    def _raw_info_bounded(cls, v: dict[str, Any]) -> dict[str, Any]:
        if len(v) > 32 or len(json.dumps(v)) > 4096:
            raise ValueError("raw_info too large")
        return v


class HeartbeatOut(BaseModel):
    device_id: uuid.UUID
    name: str
    registration: Literal["ok", "soon", "expired", "none"]
    token_expires_at: datetime | None


class KioskSignOutIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)


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
    # only /auth/me/profile fills this (from the caller's own UserAccount) —
    # person-shaped payloads elsewhere leave it None
    password_updated_at: datetime | None = None


class AuditLogItem(BaseModel):
    """One audit row for the admin log viewer — same shape as
    MyActivityItem but actor-explicit instead of by_me-relative."""

    id: uuid.UUID
    at: datetime
    action: str
    entity_type: str
    entity_id: str | None
    ip: str | None
    actor_id: uuid.UUID | None
    actor_name: str | None
    changes: dict
    entity_name: str | None = None
    entity_summary: dict = {}


class MyActivityItem(BaseModel):
    """One row of the signed-in user's history: something they did, or
    something done to their account (by_me=False, actor_name says who).
    `changes` is the audit row's field diff — sensitive fields were already
    redacted at write time by the audit service."""

    id: uuid.UUID
    at: datetime
    action: str
    entity_type: str
    entity_id: str | None
    ip: str | None
    by_me: bool
    actor_name: str | None
    changes: dict
    entity_name: str | None = None
    entity_summary: dict = {}


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
    new_password: str = Field(min_length=1)   # real bar: settings.password_min_length


class ResetPasswordIn(BaseModel):
    temp_password: str = Field(min_length=1)  # real bar: settings.password_min_length
    must_change_password: bool = True


class AccountCreateIn(BaseModel):
    """Create a login account for an EXISTING person (external contacts
    promoted to portal users). Mirrors UserCreateIn's account fields."""

    model_config = ConfigDict(extra="forbid")

    login_email: EmailStr
    temp_password: str = Field(min_length=1)  # real bar: settings.password_min_length
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
    temp_password: str | None = Field(None, min_length=1)  # real bar: settings.password_min_length
    must_change_password: bool = True


# ── stakeholders (clients & partners) ──────────────────────────────

ORG_STATUSES = {"prospect", "active", "inactive"}
ORG_TIERS = {"standard", "preferred", "strategic"}


def _normalize_website(v: str | None) -> str | None:
    """Client/partner website: strip; empty -> None; a bare domain gets
    `https://` prepended; then it must parse as an http(s) URL with a
    host, or it's rejected. Blocks a `javascript:`/`data:` URL from ever
    reaching the portal's anchor tags (security-fixes task 7) — the
    portal's safeHref() is the second, independent guard at render time."""
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    parsed = urllib.parse.urlsplit(v)
    if not parsed.scheme:
        # no scheme at all (e.g. "example.com") -- assume https and
        # reparse, rather than trusting a scheme-like prefix such as
        # "javascript:" or "data:" that urlsplit already recognized
        v = f"https://{v}"
        parsed = urllib.parse.urlsplit(v)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("invalid_website")
    return v


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
    tier: str | None = None            # clients only; None for partners
    service_region: str | None = None  # partners only; None for clients
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
    partner_types: list[str] = []   # partners only; API-validated against
                                     # status_values record_type=partner_type
    status: Literal["prospect", "active", "inactive"] = "active"
    tier: Literal["standard", "preferred", "strategic"] = "standard"   # clients only
    service_region: str | None = None   # partners only; freeform, '' -> NULL
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

    @field_validator("website")
    @classmethod
    def _website_normalized(cls, v: str | None) -> str | None:
        return _normalize_website(v)


class OrgUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1)
    code: str | None = None
    partner_types: list[str] | None = None   # partners only; API-validated
    status: Literal["prospect", "active", "inactive"] | None = None
    tier: Literal["standard", "preferred", "strategic"] | None = None   # clients only
    service_region: str | None = None   # partners only; freeform, '' -> NULL
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

    @field_validator("website")
    @classmethod
    def _website_normalized(cls, v: str | None) -> str | None:
        return _normalize_website(v)


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


class ClientActivityItem(BaseModel):
    """One processed scan on a client's asset, joined for display."""

    id: uuid.UUID
    scanned_at: datetime
    asset_id: uuid.UUID
    asset_name: str | None
    serial_number: str | None
    status: str | None
    status_label: str | None
    status_color: str  # dashboard dot always renders; null-status uses fallback "#51606f"
    site_name: str | None
    device_id: str


class ClientActivityOut(BaseModel):
    events: list[ClientActivityItem]
    activity_7d: int


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


# ── user detail page (GET /users/{id}) ─────────────────────────────

class PersonRef(BaseModel):
    id: uuid.UUID
    display_name: str


class OrgRefOut(BaseModel):
    kind: str            # "client" | "partner"
    id: uuid.UUID
    name: str


class UserDetailPerson(PersonDetail):
    source: str
    source_ref: str | None
    archived_at: datetime | None


class UserDetailAccount(BaseModel):
    login_email: str | None
    status: str                          # active | locked | disabled
    must_change_password: bool
    last_login_at: datetime | None
    created_at: datetime
    password_updated_at: datetime | None


class UserRoleGrant(BaseModel):
    role: str
    label: str
    rank: int
    scope_anchor: str
    org: OrgRefOut | None
    granted_by: PersonRef | None
    granted_at: datetime


class UserWorkerCard(BaseModel):
    trade: str | None
    level: str | None
    level_title: str | None
    level_color: str | None
    partner: PartnerRef | None
    status: str
    status_label: str
    status_color: str


class UserNotificationGroup(BaseModel):
    id: uuid.UUID
    name: str
    channels: list[str]
    added_at: datetime


class UserAccessGroupRow(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    gate_count: int
    gated_pages: list[str]
    added_by: PersonRef | None
    added_at: datetime


class UserOverrideRow(BaseModel):
    resource: str
    resource_label: str
    action: str
    allow: bool
    set_by: PersonRef | None
    set_at: datetime


class UserAccessBlock(BaseModel):
    groups: list[UserAccessGroupRow]
    overrides: list[UserOverrideRow]
    scope: dict
    scope_orgs: list[OrgRefOut]
    cells: dict


class UserSessionRow(BaseModel):
    family_id: uuid.UUID
    started_at: datetime
    last_active_at: datetime
    expires_at: datetime
    ip_address: str | None
    user_agent: str | None


class UserDetailOut(BaseModel):
    person: UserDetailPerson
    account: UserDetailAccount
    roles: list[UserRoleGrant]
    max_rank: int
    worker: UserWorkerCard | None
    notification_groups: list[UserNotificationGroup]
    access: UserAccessBlock | None       # None below rank 60 unless viewing yourself
    sessions: list[UserSessionRow] | None  # None without users:change (global)


class AccessGroupsUpdateIn(BaseModel):
    group_ids: list[uuid.UUID]


class AccessGroupsOut(BaseModel):
    group_ids: list[uuid.UUID]


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


class WorkerInitiativeItem(BaseModel):
    initiative_id: uuid.UUID
    initiative_name: str
    type_label: str | None
    type_color: str | None
    status_label: str
    status_color: str
    work_type_label: str | None
    work_type_color: str | None
    site_worked_name: str | None
    rating: int | None
    added_at: datetime


class WorkerDetailOut(WorkerItem):
    """WorkerItem + the person-record extras and history the full-detail
    page shows. person_notes is Person.notes (the imported V2 leftovers
    live there) — distinct from the /notes entity rows."""

    preferred_name: str | None
    job_title: str | None
    address_line1: str | None
    address_line2: str | None
    city: str | None
    region: str | None
    postal_code: str | None
    # country and badge_uid are otherwise non-null (Person.country has a
    # server default, badge_uid is generated) — nullable here because
    # get_worker() redacts them to None for non-global (partner-anchored)
    # actors, per security-fixes task 5 finding (a).
    country: str | None
    badge_uid: uuid.UUID | None
    rfid_tag: str | None
    person_notes: str | None
    source: str
    source_ref: str | None
    created_at: datetime
    level_def: WorkerLevelOut | None
    initiatives: list[WorkerInitiativeItem]


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
    pass


class StatusRecordTypeOut(BaseModel):
    """One entry of the frozen status-record-type registry (status/registry.py)
    — served so the portal's vocabulary editor offers every record type
    without a code change when a deploy adds one."""

    id: str
    label: str
    resource: str
    array: bool


class StatusValueOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    record_type: str
    key: str
    label: str
    description: str
    color: str
    sort_order: int
    is_active: bool
    # 0-100 or null (excluded from the weighted-progress calc)
    progress_weight: int | None = None
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
    # Any, not `int | None` — an out-of-range OR non-int value must reach the
    # route's manual 0-100 check and come back as the `invalid_progress_weight`
    # code (the routes' _err convention), not pydantic's own type-coercion
    # error shape.
    progress_weight: Any = None


class StatusValueUpdateIn(BaseModel):
    # extra="forbid" is what makes key/record_type immutable — a PATCH naming
    # them is a 422, not a silent no-op
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(None, min_length=1)
    description: str | None = None
    color: HexColor | None = None
    sort_order: int | None = None
    is_active: bool | None = None
    # see StatusValueCreateIn.progress_weight — Any so validation stays in
    # the route with the shared error code
    progress_weight: Any = None


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


class SiteSurveyRowOut(BaseModel):
    field_key: str
    label: str
    group: str
    group_label: str
    kind: str
    options: list[str]
    value: bool | int | str | None = None
    raw_id: int | None = None
    updated_by: uuid.UUID | None = None
    updated_by_name: str | None = None
    updated_at: datetime | None = None


class RawSurveyRowOut(BaseModel):
    id: int
    field_key: str
    registered: bool
    value: bool | int | str | None = None
    captured_at: datetime
    submitted_by: uuid.UUID | None = None
    submitted_by_name: str | None = None
    device_id: str
    source: str
    created_at: datetime


class SiteSurveyValueIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: bool | int | str | None = None


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
    model_config = ConfigDict(extra="forbid")   # rejects unknown fields


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
    model_config = ConfigDict(extra="forbid")   # rejects unknown fields


# ── assets ─────────────────────────────────────────────────────────


class AssetCategoryOut(BaseModel):
    key: str
    label: str
    description: str
    sort_order: int
    color: str
    model_config = ConfigDict(from_attributes=True)


class AssetCategoryCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # slug, not prose — this is a stable identifier and an FK target
    key: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    label: str = Field(min_length=1)
    description: str = ""
    sort_order: int = 0
    color: HexColor


class AssetCategoryUpdateIn(BaseModel):
    label: str | None = None
    description: str | None = None
    sort_order: int | None = None
    color: HexColor | None = None


class AssetModelRef(BaseModel):
    """Read-only catalog summary embedded in asset payloads — this is all a
    client-anchored actor ever sees of the catalog (no knowledge field)."""

    id: uuid.UUID
    make: str
    model: str
    category: str | None = None
    category_label: str | None = None
    category_color: str | None = None
    ru_size: int | None = None


class AssetModelItem(BaseModel):
    id: uuid.UUID
    make: str
    model: str
    category: str | None = None
    category_label: str | None = None
    category_color: str | None = None
    ru_size: int | None = None
    weight_lbs: float | None = None
    weight_kg: float | None = None
    length_in: float | None = None
    width_in: float | None = None
    height_in: float | None = None
    length_cm: float | None = None
    width_cm: float | None = None
    height_cm: float | None = None
    mount_type: str | None = None
    rail_type: str | None = None
    knowledge: str
    aliases: list[str] = []
    created_at: datetime
    updated_at: datetime


class AssetModelCreateIn(BaseModel):
    make: str = Field(min_length=1)
    model: str = Field(min_length=1)
    category: str | None = None
    ru_size: int | None = Field(default=None, ge=0, le=100)
    weight_lbs: float | None = Field(default=None, ge=0, le=99999)
    weight_kg: float | None = Field(default=None, ge=0, le=99999)
    length_in: float | None = Field(default=None, ge=0, le=99999)
    width_in: float | None = Field(default=None, ge=0, le=99999)
    height_in: float | None = Field(default=None, ge=0, le=99999)
    length_cm: float | None = Field(default=None, ge=0, le=99999)
    width_cm: float | None = Field(default=None, ge=0, le=99999)
    height_cm: float | None = Field(default=None, ge=0, le=99999)
    mount_type: str | None = None
    rail_type: str | None = None
    knowledge: str = ""
    model_config = ConfigDict(extra="forbid")


class AssetModelUpdateIn(BaseModel):
    make: str | None = None
    model: str | None = None
    category: str | None = None
    ru_size: int | None = Field(default=None, ge=0, le=100)
    weight_lbs: float | None = Field(default=None, ge=0, le=99999)
    weight_kg: float | None = Field(default=None, ge=0, le=99999)
    length_in: float | None = Field(default=None, ge=0, le=99999)
    width_in: float | None = Field(default=None, ge=0, le=99999)
    height_in: float | None = Field(default=None, ge=0, le=99999)
    length_cm: float | None = Field(default=None, ge=0, le=99999)
    width_cm: float | None = Field(default=None, ge=0, le=99999)
    height_cm: float | None = Field(default=None, ge=0, le=99999)
    mount_type: str | None = None
    rail_type: str | None = None
    knowledge: str | None = None
    model_config = ConfigDict(extra="forbid")


class AssetModelAliasesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    aliases: list[str]


class AssetItem(BaseModel):
    id: uuid.UUID
    legacy_id: int | None = None   # the human Asset ID (V2 ids kept; V3 from 100000)
    serial_number: str | None = None
    name: str | None = None
    rfid_tag: str | None = None
    model_id: uuid.UUID | None = None
    model: AssetModelRef | None = None
    client_id: uuid.UUID | None = None
    client_name: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    location_detail: str
    status: str
    status_label: str
    status_color: str
    has_rails: bool | None = None
    last_seen_at: datetime | None = None
    archived_at: datetime | None = None
    created_at: datetime


class AssetCreateIn(BaseModel):
    serial_number: str | None = None
    name: str | None = None
    rfid_tag: str | None = None
    model_id: uuid.UUID | None = None
    client_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    location_detail: str = ""
    status: str | None = None
    has_rails: bool | None = None
    model_config = ConfigDict(extra="forbid")


class AssetUpdateIn(BaseModel):
    serial_number: str | None = None
    name: str | None = None
    rfid_tag: str | None = None
    model_id: uuid.UUID | None = None
    client_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    location_detail: str | None = None
    status: str | None = None
    has_rails: bool | None = None
    model_config = ConfigDict(extra="forbid")


class AssetMoveRow(BaseModel):
    """One move roster row an asset has appeared on — the compact history
    line. Rack, RU, disposition and verification live on the move-row page
    this links to, deliberately not here."""

    row_id: uuid.UUID            # initiative_assets.id — the move-row page key
    initiative_id: uuid.UUID
    initiative_name: str
    initiative_status: str
    initiative_status_label: str
    initiative_status_color: str
    asset_status: str
    asset_status_label: str
    asset_status_color: str
    scheduled_start: datetime | None
    scheduled_end: datetime | None
    added_at: datetime


class ContainerItem(BaseModel):
    id: uuid.UUID
    name: str
    rfid_tag: str | None = None
    container_type: str | None = None
    type_label: str | None = None
    type_color: str | None = None
    status: str
    status_label: str
    status_color: str
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    initiative_id: uuid.UUID | None = None
    initiative_name: str | None = None
    label_tag: str | None = None
    location_detail: str
    asset_count: int = 0
    last_audit_at: datetime | None = None
    last_validated_at: datetime | None = None
    archived_at: datetime | None = None
    created_at: datetime


class ContainerCreateIn(BaseModel):
    name: str
    rfid_tag: str | None = None
    container_type: str | None = None
    status: str | None = None
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None
    label_tag: str | None = None
    location_detail: str = ""
    model_config = ConfigDict(extra="forbid")


class ContainerUpdateIn(BaseModel):
    name: str | None = None
    rfid_tag: str | None = None
    container_type: str | None = None
    status: str | None = None
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None
    label_tag: str | None = None
    location_detail: str | None = None
    model_config = ConfigDict(extra="forbid")


class ContainerBulkNamingIn(BaseModel):
    """Name = prefix + zero-padded(start + i) + suffix, i = 0..count-1."""

    prefix: str = Field("", max_length=40)
    start: int = Field(1, ge=0)
    pad: int = Field(0, ge=0, le=4)   # never more than four digits of padding
    suffix: str = Field("", max_length=40)
    model_config = ConfigDict(extra="forbid")


class ContainerBulkCreateIn(BaseModel):
    count: int = Field(ge=1, le=500)
    container_type: str
    naming: ContainerBulkNamingIn = ContainerBulkNamingIn()
    initiative_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    status: str | None = None
    tags: dict[str, Annotated[int, Field(ge=0)]] = {}
    model_config = ConfigDict(extra="forbid")


class ContainerBulkCreateOut(BaseModel):
    created: list[ContainerItem]


class ContainerAssetRow(BaseModel):
    asset_id: uuid.UUID
    serial_number: str | None = None
    name: str | None = None
    model_name: str | None = None
    status: str
    status_label: str
    status_color: str
    added_at: datetime
    added_by_name: str | None = None


class ContainerAssetsAddIn(BaseModel):
    asset_ids: list[uuid.UUID]
    model_config = ConfigDict(extra="forbid")


class RawScanItem(BaseModel):
    """One raw (unprocessed) scan — the inbox row, read-only."""

    id: int
    scanned_value: str
    scan_type: str
    scan_type_label: str
    scan_type_color: str
    status: str | None = None
    status_label: str | None = None
    status_color: str | None = None
    scanned_at: datetime
    device_id: str
    operator_id: uuid.UUID | None = None
    operator_name: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    location_detail: str
    source: str
    created_at: datetime


class StatusProvenanceOut(BaseModel):
    """When (and via what) a row's status became its current value —
    the payload behind every list's status-chip hover popup."""

    status: str
    changed_at: datetime | None = None
    source: Literal["scan", "edit"] | None = None
    scan_type: str | None = None
    scan_type_label: str | None = None
    scan_type_color: str | None = None
    device_id: str | None = None
    site_name: str | None = None
    actor_name: str | None = None


class ScanDailyStat(BaseModel):
    """Raw-scan count for one UTC day — the dashboard's activity chart."""

    day: date
    count: int


class ProcessedScanItem(BaseModel):
    """One matched scan — raw context plus the match resolution."""

    id: uuid.UUID
    scanned_value: str
    scan_type: str
    scan_type_label: str
    scan_type_color: str
    status: str | None = None
    status_label: str | None = None
    status_color: str | None = None
    scanned_at: datetime
    device_id: str
    operator_id: uuid.UUID | None = None
    operator_name: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    location_detail: str
    source: str
    raw_scan_id: int | None = None
    match_type: str
    match_type_label: str
    match_type_color: str
    asset_id: uuid.UUID | None = None
    container_id: uuid.UUID | None = None
    person_id: uuid.UUID | None = None
    matched_name: str | None = None
    processed_at: datetime
    archived_at: datetime | None = None
    created_at: datetime


class ProcessedScanPatch(BaseModel):
    """God-edit surface — historical-context fixes only. Match fields
    are deliberately absent: re-matching is the (future) processor's job."""

    site_id: uuid.UUID | None = None
    location_detail: str | None = None
    operator_id: uuid.UUID | None = None
    model_config = ConfigDict(extra="forbid")


class PeopleFlowEvent(BaseModel):
    """One debounced walk-by — a person badge read, folded per burst."""

    person_id: uuid.UUID
    display_name: str
    avatar_url: str | None
    device_id: str
    site_name: str | None
    scanned_at: datetime


class PeopleFlowOut(BaseModel):
    """The People Dashboard's walk-by rail: debounced events plus the
    day's raw (pre-debounce) counts, so the KPIs ride the same call."""

    events: list[PeopleFlowEvent]
    distinct_people_today: int
    person_scans_today: int


class AssetScanItem(BaseModel):
    """One processed scan of a given asset — the per-asset history row
    (initiative roster expansion). Match fields omitted: they are the
    asset by construction."""

    id: uuid.UUID
    scanned_value: str
    scan_type: str
    scan_type_label: str
    scan_type_color: str
    status: str | None = None
    status_label: str | None = None
    status_color: str | None = None
    scanned_at: datetime
    processed_at: datetime
    device_id: str
    operator_id: uuid.UUID | None = None
    operator_name: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    location_detail: str
    source: str


class NoteOut(BaseModel):
    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    body: str
    created_by: uuid.UUID | None = None
    author_name: str | None = None
    created_at: datetime
    updated_at: datetime


class NoteCreateIn(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    body: str = Field(min_length=1)
    model_config = ConfigDict(extra="forbid")


class NoteUpdateIn(BaseModel):
    body: str = Field(min_length=1)
    model_config = ConfigDict(extra="forbid")


class GodModeIn(BaseModel):
    word: str


# ── pending deletes (god-mode banner) ─────────────────────────────


class PendingDeleteOut(BaseModel):
    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    entity_label: str
    marked_by: uuid.UUID | None = None
    marked_by_name: str | None = None
    marked_at: datetime


class PendingDeleteCreateIn(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    entity_label: str = ""
    model_config = ConfigDict(extra="forbid")


class PendingDeleteReference(BaseModel):
    """One (table, column) elsewhere in the schema that still points at a
    reconcile target — the detail behind an fk_violation failure."""

    table: str
    column: str
    nullable: bool
    # True for pure association tables (PURGE_ROW_TABLES): force mode
    # deletes these rows outright instead of nulling the column
    purgeable: bool = False
    # True when a CHECK constraint on the referencing table mentions this
    # column (e.g. processed_scans_match_target_chk): the column may be
    # nullable, but force mode still can't null it without tripping the
    # CHECK — the whole force delete rolls back
    check_guarded: bool = False
    # True when the foreign key itself declares ON DELETE CASCADE or SET
    # NULL: the database clears this reference on delete, so it never
    # blocked anything and must not be reported as a blocker.
    db_handled: bool = False
    count: int
    labels: list[str] = []


class PendingDeleteFailure(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    label: str
    reason: str
    references: list[PendingDeleteReference] = []


class PendingDeleteReconcileOut(BaseModel):
    deleted: int
    failed: list[PendingDeleteFailure] = []


class CascadeStepOut(BaseModel):
    """One (table, column) a cascade delete touches, and how. Validated
    straight from the engine's CascadeStep dataclasses (CascadePlanOut(
    **plan.__dict__) in the preview endpoint), hence from_attributes."""

    model_config = ConfigDict(from_attributes=True)

    table: str
    column: str
    action: str          # purge | clear | db_cascade | db_set_null
    count: int
    labels: list[str] = []
    depth: int


class CascadePlanOut(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    label: str
    steps: list[CascadeStepOut] = []
    # non-empty means the cascade will refuse to run, with these reasons
    blocked: list[str] = []
    total_rows_deleted: int
    total_rows_cleared: int
    # rows the DATABASE destroys via ON DELETE CASCADE — not part of
    # total_rows_deleted, which is only this walk's own DELETEs
    total_rows_db_deleted: int


class CascadeDeleteIn(BaseModel):
    """The record's own label, typed by the operator. Guards against a
    stale preview in a forgotten browser tab destroying the wrong row."""

    confirm_label: str
    model_config = ConfigDict(extra="forbid")


# ── db backups ───────────────────────────────────────────────────────


class DbBackupItem(BaseModel):
    id: uuid.UUID
    filename: str
    size_bytes: int
    encrypted: bool = True
    # 'manual' (Dev -> Database -> Backups) or 'testing_snapshot' (taken
    # automatically at the start of a DB testing session) — the Backups
    # tab labels the latter with a chip.
    purpose: str = "manual"
    created_at: datetime
    created_by: uuid.UUID | None = None
    created_by_name: str | None = None
    # only populated on create (a fresh presigned link); list rows leave
    # this None — a caller wanting to download an older backup hits the
    # dedicated download endpoint for a freshly-signed URL instead
    download_url: str | None = None


class DbBackupCreateIn(BaseModel):
    """encrypt=True (the default) seals the dump with the caller's own
    account password, which must be supplied and is verified first.
    encrypt=False produces a plain .sql dump — password stays unused."""

    encrypt: bool = True
    password: str | None = None
    model_config = ConfigDict(extra="forbid")


# ── db testing mode ───────────────────────────────────────────────────


class DbTestingSessionOut(BaseModel):
    id: uuid.UUID
    status: str
    snapshot_backup_id: uuid.UUID | None = None
    # db_backups.filename for snapshot_backup_id — null while snapshotting
    # (no backup row yet) or if the backup row is gone.
    snapshot_filename: str | None = None
    started_by: uuid.UUID | None = None
    started_by_name: str | None = None
    started_at: datetime
    ended_at: datetime | None = None
    ended_with: str | None = None
    error: str | None = None


class DbTestingTableChange(BaseModel):
    table: str
    before: int
    after: int
    delta: int


class DbTestingChanges(BaseModel):
    audit_rows: int
    tables: list[DbTestingTableChange] = []
    since: datetime


class DbTestingStatusOut(BaseModel):
    session: DbTestingSessionOut | None = None
    changes: DbTestingChanges | None = None
    recent: list[DbTestingSessionOut] = []
    worker_online: bool


class DbTestingStartIn(BaseModel):
    password: str
    model_config = ConfigDict(extra="forbid")


class DbTestingEndIn(BaseModel):
    password: str
    revert: bool
    model_config = ConfigDict(extra="forbid")


# ── initiatives ────────────────────────────────────────────────────


_HEX_COLOR_RE = re.compile(r"#([0-9a-f]{3}|[0-9a-f]{6})\Z", re.IGNORECASE)


def _normalize_color(v: str | None) -> str | None:
    """Initiative color: strip; empty -> None; accept `#rgb` or `#rrggbb`
    in any case and store lowercase `#rrggbb`. Anything else is rejected,
    so the portal only ever has one shape to parse.

    Not the `HexColor` annotated type above: this field is typed by hand
    into a wheel's hex readout, so it has to expand the three-digit form,
    and it reports `invalid_color` rather than a raw pattern message —
    same shape as `_normalize_website`."""
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if not _HEX_COLOR_RE.match(v):
        raise ValueError("invalid_color")
    v = v.lower()
    if len(v) == 4:
        v = "#" + "".join(c * 2 for c in v[1:])
    return v


class InitiativeItem(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    color: str | None = None   # stored value, not a fallback; null = unset
    initiative_type: str
    type_label: str
    type_color: str
    sub_type: str | None = None
    sub_type_label: str | None = None
    sub_type_color: str | None = None
    status: str
    status_label: str
    status_color: str
    client_id: uuid.UUID | None = None
    client_name: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    location: str | None = None
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    sky_command_project_id: str | None = None
    origin_site_id: uuid.UUID | None = None
    origin_site_name: str | None = None
    destination_site_id: uuid.UUID | None = None
    destination_site_name: str | None = None
    real_start_at: datetime | None = None
    real_end_at: datetime | None = None
    priority_devices: bool | None = None
    shipping_types: list[str] = []
    shipping_partner_id: uuid.UUID | None = None
    shipping_partner_name: str | None = None
    origin_tech_partner_id: uuid.UUID | None = None
    origin_cable_partner_id: uuid.UUID | None = None
    origin_logistics_partner_id: uuid.UUID | None = None
    destination_tech_partner_id: uuid.UUID | None = None
    destination_cable_partner_id: uuid.UUID | None = None
    destination_logistics_partner_id: uuid.UUID | None = None
    origin_vendor_involved: bool | None = None
    destination_vendor_involved: bool | None = None
    people_count: int = 0
    links_count: int = 0
    archived_at: datetime | None = None
    created_at: datetime


class InitiativePersonRow(BaseModel):
    id: uuid.UUID
    person_id: uuid.UUID
    person_name: str
    work_type: str | None = None
    work_type_label: str | None = None
    work_type_color: str | None = None
    site_worked_id: uuid.UUID | None = None
    site_worked_name: str | None = None
    rating: int | None = None
    created_at: datetime


class InitiativeLinkRow(BaseModel):
    """One link, described from one side: `other_*` is the initiative at
    the far end (the child when listed under links_children, the parent
    when under links_parents)."""

    id: uuid.UUID
    other_id: uuid.UUID
    other_name: str
    other_type: str
    other_type_label: str
    other_type_color: str
    other_status_label: str
    other_status_color: str
    role: str | None = None
    sort_order: int | None = None
    notes: str | None = None
    created_at: datetime


class InitiativeDetailOut(InitiativeItem):
    people: list[InitiativePersonRow] = []
    links_children: list[InitiativeLinkRow] = []
    links_parents: list[InitiativeLinkRow] = []


class InitiativeNextColorOut(BaseModel):
    """Response for GET /initiatives/next-color."""

    color: str


class InitiativeLinksOut(BaseModel):
    """Response for GET /initiatives/{id}/links."""

    children: list[InitiativeLinkRow] = []
    parents: list[InitiativeLinkRow] = []


class InitiativeCreateIn(BaseModel):
    name: str
    initiative_type: str
    description: str | None = None
    color: str | None = None   # omitted on create -> one is assigned
    sub_type: str | None = None
    status: str | None = None
    client_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    location: str | None = None
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    sky_command_project_id: str | None = None
    origin_site_id: uuid.UUID | None = None
    destination_site_id: uuid.UUID | None = None
    real_start_at: datetime | None = None
    real_end_at: datetime | None = None
    priority_devices: bool | None = None
    shipping_types: list[str] | None = None
    shipping_partner_id: uuid.UUID | None = None
    origin_tech_partner_id: uuid.UUID | None = None
    origin_cable_partner_id: uuid.UUID | None = None
    origin_logistics_partner_id: uuid.UUID | None = None
    destination_tech_partner_id: uuid.UUID | None = None
    destination_cable_partner_id: uuid.UUID | None = None
    destination_logistics_partner_id: uuid.UUID | None = None
    origin_vendor_involved: bool | None = None
    destination_vendor_involved: bool | None = None
    model_config = ConfigDict(extra="forbid")

    @field_validator("color")
    @classmethod
    def _color_normalized(cls, v: str | None) -> str | None:
        return _normalize_color(v)


class InitiativeUpdateIn(InitiativeCreateIn):
    """PATCH body — same fields, everything optional. `color: null` is
    honored as "clear it" (the route's exclude_unset dump keeps the
    difference between omitted and explicitly null)."""

    name: str | None = None
    initiative_type: str | None = None
    model_config = ConfigDict(extra="forbid")


class InitiativePersonAddIn(BaseModel):
    person_id: uuid.UUID
    work_type: str | None = None
    site_worked_id: uuid.UUID | None = None
    rating: int | None = None
    model_config = ConfigDict(extra="forbid")


class InitiativePersonUpdateIn(BaseModel):
    work_type: str | None = None
    site_worked_id: uuid.UUID | None = None
    rating: int | None = None
    model_config = ConfigDict(extra="forbid")


class InitiativeLinkAddIn(BaseModel):
    child_id: uuid.UUID
    role: str | None = None
    sort_order: int | None = None
    notes: str | None = None
    model_config = ConfigDict(extra="forbid")


class InitiativeLinkUpdateIn(BaseModel):
    role: str | None = None
    sort_order: int | None = None
    notes: str | None = None
    model_config = ConfigDict(extra="forbid")


class InitiativeAssetSummary(BaseModel):
    """Embedded read-only asset summary on a move-asset row."""

    id: uuid.UUID
    legacy_id: int | None = None
    serial_number: str | None = None
    name: str | None = None
    rfid_tag: str | None = None
    model_make: str | None = None
    model_name: str | None = None
    ru_size: int | None = None
    model_category: str | None = None
    model_category_label: str | None = None
    model_category_color: str | None = None
    location_detail: str | None = None
    client_name: str | None = None
    status: str
    status_label: str
    status_color: str


class InitiativeAssetOut(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    priority_wave: str | None = None
    disposition: str | None = None
    owner: str | None = None
    source_rack: str | None = None
    source_ru: float | None = None
    source_verified: bool | None = None
    source_position: str | None = None
    destination_rack: str | None = None
    destination_ru: float | None = None
    destination_verified: bool | None = None
    destination_position: str | None = None
    cable_info: str | None = None
    vendor_involved: bool | None = None
    status: str
    status_label: str
    status_color: str
    created_at: datetime
    updated_at: datetime
    asset: InitiativeAssetSummary


class InitiativeAssetsAddIn(BaseModel):
    asset_ids: list[uuid.UUID]
    model_config = ConfigDict(extra="forbid")


class InitiativeAssetUpdateIn(BaseModel):
    priority_wave: str | None = Field(None, max_length=30)
    disposition: str | None = None
    owner: str | None = None
    source_rack: str | None = None
    source_ru: str | float | int | None = None
    source_verified: bool | None = None
    source_position: str | None = None
    destination_rack: str | None = None
    destination_ru: str | float | int | None = None
    destination_verified: bool | None = None
    destination_position: str | None = None
    cable_info: str | None = None
    vendor_involved: bool | None = None
    status: str | None = None
    model_config = ConfigDict(extra="forbid")


class ImportJobOut(BaseModel):
    """import_jobs row as served to the portal's polling loop."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    initiative_id: uuid.UUID
    kind: str
    filename: str
    options: dict
    phase: str
    status: str
    total_rows: int
    processed_rows: int
    created_count: int
    updated_count: int
    error_count: int
    results: dict | None = None
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


# ── system ────────────────────────────────────────────────────────

class SystemProcessOut(BaseModel):
    name: str
    kind: str
    status: str                      # derived: running | paused | stopped | failed
    pid: int | None = None
    hostname: str
    started_at: datetime | None = None
    heartbeat_at: datetime | None = None
    stopped_at: datetime | None = None
    uptime_seconds: int | None = None
    meta: dict


class SystemStatusOut(BaseModel):
    """Public (unauthenticated) portal status — banners + read-only state."""

    read_only: bool
    read_only_message: str
    workers_paused: bool
    banner: str | None


class AdminConfigOut(BaseModel):
    read_only: bool
    read_only_message: str
    pause_workers: bool
    banner_enabled: bool
    banner_message: str


class SecurityConfigOut(BaseModel):
    two_factor_enabled: bool
    two_factor_required: bool


class SecurityConfigIn(BaseModel):
    """Partial update — only sent fields change. `two_factor_required`
    implies `two_factor_enabled`; turning enabled off clears required."""

    model_config = ConfigDict(extra="forbid")

    two_factor_enabled: bool | None = None
    two_factor_required: bool | None = None


class RevokeAllSessionsOut(BaseModel):
    revoked_sessions: int
    revoked_people: int


class AdminConfigIn(BaseModel):
    """Partial update — only sent fields change."""

    model_config = ConfigDict(extra="forbid")

    read_only: bool | None = None
    read_only_message: str | None = Field(default=None, max_length=300)
    pause_workers: bool | None = None
    banner_enabled: bool | None = None
    banner_message: str | None = Field(default=None, max_length=300)


class LogEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    level: str
    levelno: int
    logger: str
    message: str
    at: datetime


class LogPageOut(BaseModel):
    entries: list[LogEntryOut]
    has_more: bool


# ── time ──────────────────────────────────────────────────────────

class TimeEntryItem(BaseModel):
    """One clock-in/clock-out span — denormalized for the timesheet lists
    and the punch-clock widget."""

    id: uuid.UUID
    person_id: uuid.UUID
    person_name: str
    initiative_id: uuid.UUID | None = None
    initiative_name: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    clock_in_at: datetime
    clock_out_at: datetime | None = None
    break_minutes: int
    minutes: int
    status: str
    status_label: str
    status_color: str
    source: str
    notes: str
    adjusted: bool
    adjust_reason: str | None = None
    approved_by: uuid.UUID | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    reject_reason: str | None = None
    created_at: datetime
    updated_at: datetime


class TimeSummaryPerson(BaseModel):
    person_id: uuid.UUID
    person_name: str
    approved_minutes: int
    pending_minutes: int
    entry_count: int
    last_entry_at: datetime | None = None


class TimeSummaryOut(BaseModel):
    approved_minutes: int
    pending_minutes: int
    open_count: int
    people: list[TimeSummaryPerson]


class TimeDayStat(BaseModel):
    day: date
    minutes: int


class TimeStatsSummaryOut(BaseModel):
    clocked_in: int
    pending_entries: int
    minutes_today: int
    days: list[TimeDayStat]


class PunchOption(BaseModel):
    id: uuid.UUID
    name: str


class TimeMeOut(BaseModel):
    open: TimeEntryItem | None = None
    entries: list[TimeEntryItem]


class TimePunchOptionsOut(BaseModel):
    initiatives: list[PunchOption]
    sites: list[PunchOption]


class ClockInIn(BaseModel):
    initiative_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    notes: str | None = None
    model_config = ConfigDict(extra="forbid")


class ClockOutIn(BaseModel):
    notes: str | None = None
    break_minutes: int | None = None
    model_config = ConfigDict(extra="forbid")


class TimeEntryCreateIn(BaseModel):
    person_id: uuid.UUID
    clock_in_at: datetime
    clock_out_at: datetime
    initiative_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    break_minutes: int | None = None
    notes: str | None = None
    model_config = ConfigDict(extra="forbid")


class TimeEntryPatchIn(BaseModel):
    clock_in_at: datetime | None = None
    clock_out_at: datetime | None = None
    break_minutes: int | None = None
    initiative_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    notes: str | None = None
    adjust_reason: str | None = None
    model_config = ConfigDict(extra="forbid")


class TimeEntryRejectIn(BaseModel):
    reason: str = Field(min_length=1)
    model_config = ConfigDict(extra="forbid")


class NotificationGroupSettings(BaseModel):
    """Shared shape for the group-level notification settings. All fields
    optional so it can be reused for PATCH (partial update)."""
    channels: list[str] | None = None
    quiet_start: time | None = None
    quiet_end: time | None = None
    timezone: str | None = None
    active_days: list[str] | None = None
    dnd_behavior: str | None = None
    urgent_bypass: bool | None = None


class NotificationGroupCreateIn(NotificationGroupSettings):
    name: str
    description: str = ""
    model_config = ConfigDict(extra="forbid")


class NotificationGroupPatchIn(NotificationGroupSettings):
    name: str | None = None
    description: str | None = None
    enabled: bool | None = None
    model_config = ConfigDict(extra="forbid")


class NotificationGroupOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    channels: list[str]
    quiet_start: time | None = None
    quiet_end: time | None = None
    timezone: str
    active_days: list[str]
    dnd_behavior: str
    urgent_bypass: bool
    enabled: bool
    member_count: int
    created_at: datetime


class NotificationMemberAddIn(BaseModel):
    person_id: uuid.UUID
    model_config = ConfigDict(extra="forbid")


class NotificationMemberOverrides(BaseModel):
    """Raw per-member override columns — nulls preserved (None means
    'inherit the group value'). Used both as the PATCH body (all fields
    optional, and `model_fields_set` distinguishes absent from explicit
    null) and embedded read-only in NotificationMemberOut."""
    channels: list[str] | None = None
    quiet_mode: str | None = None
    quiet_start: time | None = None
    quiet_end: time | None = None
    timezone: str | None = None
    active_days: list[str] | None = None
    dnd_behavior: str | None = None
    urgent_bypass: bool | None = None
    model_config = ConfigDict(extra="forbid")


class NotificationEffectiveSettings(BaseModel):
    """Fully resolved settings (member override merged over group
    default) — no Nones except the quiet hour times, which are legitimately
    absent when there are no quiet hours in effect."""
    channels: list[str]
    quiet_start: time | None = None
    quiet_end: time | None = None
    timezone: str
    active_days: list[str]
    dnd_behavior: str
    urgent_bypass: bool


class NotificationMemberOut(BaseModel):
    person_id: uuid.UUID
    display_name: str
    job_title: str | None
    avatar_url: str | None
    email: str | None
    phone: str | None
    has_account: bool
    can_email: bool
    can_text: bool
    can_push: bool
    can_web: bool
    overrides: NotificationMemberOverrides
    effective: NotificationEffectiveSettings
    added_at: datetime


class NotificationGroupDetailOut(NotificationGroupOut):
    members: list[NotificationMemberOut]


class NotificationRecipientOut(BaseModel):
    person_id: uuid.UUID
    display_name: str
    job_title: str | None
    avatar_url: str | None
    email: str | None
    phone: str | None
    has_account: bool
    can_email: bool
    can_text: bool
    can_push: bool
    can_web: bool


class NotificationInboxItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: str
    title: str
    body: str
    link: str | None = None
    payload: dict
    created_at: datetime
    read_at: datetime | None = None


class NotificationInboxOut(BaseModel):
    unread_count: int
    items: list[NotificationInboxItemOut]


# ── notification-group membership requests (self-service + approval) ──

class MembershipRequestOut(BaseModel):
    id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    person_id: uuid.UUID
    person_name: str
    action: str
    status: str
    note: str
    decided_by_name: str | None = None
    decided_at: datetime | None = None
    decision_note: str
    created_at: datetime


class MembershipRequestCreateIn(BaseModel):
    action: Literal["join", "leave"]
    note: str = ""
    model_config = ConfigDict(extra="forbid")


class MembershipDecisionIn(BaseModel):
    note: str = ""
    model_config = ConfigDict(extra="forbid")


class MyPendingRequestOut(BaseModel):
    id: uuid.UUID
    action: str
    note: str
    created_at: datetime


class MyNotificationGroupOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    channels: list[str]
    quiet_start: time | None = None
    quiet_end: time | None = None
    timezone: str
    active_days: list[str]
    dnd_behavior: str
    urgent_bypass: bool
    member_count: int
    is_member: bool
    overrides: NotificationMemberOverrides | None = None
    effective: NotificationEffectiveSettings | None = None
    pending_request: MyPendingRequestOut | None = None


# ── status rules ─────────────────────────────────────────────────────

class StatusRuleConditionIn(BaseModel):
    field: str
    operator: str
    value: str | None = None


class StatusRuleActionIn(BaseModel):
    action_type: str
    params: dict = {}


class StatusRuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    trigger_status: str
    trigger_match_type: str
    priority: int = 10
    enabled: bool = True
    conditions: list[StatusRuleConditionIn] = []
    actions: list[StatusRuleActionIn] = Field(min_length=1)


class StatusRulePatch(BaseModel):
    enabled: bool


class StatusRuleOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    trigger_status: str
    trigger_match_type: str
    priority: int
    enabled: bool
    conditions: list[StatusRuleConditionIn]
    actions: list[StatusRuleActionIn]
    created_at: datetime
    updated_at: datetime


class StatusRuleExecutionItem(BaseModel):
    id: int
    rule_id: uuid.UUID | None
    rule_name: str
    processed_scan_id: uuid.UUID | None
    conditions_met: bool
    actions_applied: list
    error: str | None
    executed_at: datetime
    duration_ms: int
    scanned_value: str | None
    scan_status: str | None


class StatusRuleExecStat(BaseModel):
    rule_id: uuid.UUID
    run_count: int
    met_count: int
    last_run_at: datetime | None
    avg_duration_ms: float | None


# ── devices ──────────────────────────────────────────────────────────

class DeviceItem(BaseModel):
    id: uuid.UUID
    device_type: str
    name: str
    serial: str | None
    mac: str | None
    site_id: uuid.UUID | None
    site_name: str | None
    wan_ip: str | None
    lan_ip: str | None
    model: str | None
    version: str | None
    sub_type: str | None
    current_initiative_id: uuid.UUID | None
    current_initiative_name: str | None
    antennas_connected: int | None
    connection_type: str | None
    scan_status: str | None
    scan_status_label: str | None
    scan_status_color: str | None
    tags_read_24h: int
    vpn_status: str | None
    token_expires_at: datetime | None
    connected_count: int
    uptime_seconds: int | None
    last_seen_at: datetime | None
    raw_info: dict
    registered_at: datetime
    session_person_id: uuid.UUID | None
    session_person_name: str | None
    session_login_method: str | None
    session_started_at: datetime | None


class DevicePatch(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str | None = None
    sub_type: str | None = None
    mac: str | None = None
    lan_ip: str | None = None
    version: str | None = None
    site_id: uuid.UUID | None = None
    current_initiative_id: uuid.UUID | None = None
    scan_status: str | None = None


class DeviceCreate(DevicePatch):
    device_type: str
    name: str = Field(min_length=1)


class DeviceRegisterIn(BaseModel):
    days: int | None = None


class DeviceLeaseItem(BaseModel):
    id: uuid.UUID
    mac: str
    ip: str | None
    hostname: str | None
    reserved: bool
    up: bool
    last_seen_at: datetime | None


# ── kiosk setup ──

class SetupOptionSite(BaseModel):
    id: uuid.UUID
    name: str


class SetupOptionInitiative(BaseModel):
    id: uuid.UUID
    name: str
    status: str
    status_label: str
    client_name: str | None = None
    scheduled_start: str | None = None
    scheduled_end: str | None = None
    source_site: SetupOptionSite | None = None
    destination_site: SetupOptionSite | None = None


class SetupOptionScanType(BaseModel):
    key: str
    label: str
    color: str


class SetupOptionsOut(BaseModel):
    initiatives: list[SetupOptionInitiative]
    scan_types: list[SetupOptionScanType]


class KioskSetupIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    initiative_id: uuid.UUID
    site_id: uuid.UUID
    scan_status: str = Field(min_length=1)


class KioskSetupOut(BaseModel):
    device_id: uuid.UUID
    initiative_id: uuid.UUID
    initiative_name: str
    site_id: uuid.UUID
    site_name: str
    site_role: Literal["source", "destination"]
    scan_status: str
    scan_status_label: str


# ── kiosk local-data sync ──

class KioskAssetOut(BaseModel):
    """One roster asset as the kiosk caches it. `label` is the full label
    placeholder map for this asset on this move (the same values the label
    generator writes), so a kiosk can render a label offline.

    `container_id` is the crate this asset is packed in, or None
    (`container_assets.asset_id` is UNIQUE, so there is at most one). The
    Trucks screen needs it: trucks carry containers, so an asset someone
    scans there has to resolve to its crate before anything can be loaded,
    and that lookup must not cost a round trip."""

    id: uuid.UUID
    asset_id: str            # Asset.legacy_id, the human Asset ID ("" if unset)
    name: str | None = None
    rfid: str | None = None
    serial_number: str | None = None
    make: str | None = None
    model: str | None = None
    make_model: str
    container_id: uuid.UUID | None = None
    label: dict[str, str]


class KioskAssetsSyncOut(BaseModel):
    initiative_id: uuid.UUID
    initiative_name: str
    generated_at: datetime
    assets: list[KioskAssetOut]


class KioskPersonOut(BaseModel):
    """One cached person. The name parts ride along with display_name so
    the kiosk can match a typed name in any order ("tina t", "timeclock
    tina") without re-splitting a formatted string."""

    id: uuid.UUID
    display_name: str
    first_name: str
    last_name: str
    preferred_name: str | None = None
    rfid_tag: str | None = None
    is_worker: bool
    has_account: bool


class KioskPeopleSyncOut(BaseModel):
    generated_at: datetime
    people: list[KioskPersonOut]


# ── kiosk scan ingest ──

class KioskScanIn(BaseModel):
    """One scan the kiosk already matched against its local copy of the
    move. `asset_id` is that local match — informational only: the
    server's own scan-matching worker re-matches `scanned_value` from
    scratch, so a stale local database can never mis-attribute a scan.
    `site_id` / `initiative_id` / `scan_status` are per-scan overrides;
    left out, each falls back to the kiosk Device's own setup."""

    client_scan_id: uuid.UUID
    scanned_value: str = Field(min_length=1, max_length=200)
    scan_type: Literal["rfid", "barcode"]
    scanned_at: datetime
    asset_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None
    scan_status: str | None = Field(default=None, max_length=120)

    @field_validator("scanned_value")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("blank")
        return v


class KioskScanBatchIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    scans: list[KioskScanIn] = Field(min_length=1, max_length=100)


class KioskScanRejected(BaseModel):
    client_scan_id: uuid.UUID
    code: Literal["bad_site", "bad_initiative", "bad_status", "bad_scan_type"]


class KioskScanBatchOut(BaseModel):
    accepted: list[uuid.UUID]
    rejected: list[KioskScanRejected]


# ── kiosk printer maintenance ──

class KioskPrinterEventIn(BaseModel):
    """One piece of printer maintenance a kiosk performed over WebUSB.
    `event` is an enum with a single member today (`factory_reset`) so
    later maintenance events — a head cleaning, a firmware push — become
    another member here rather than another endpoint.

    `printer_model` / `printer_firmware` are whatever `~HI` reported and
    are null when the printer was never identified; `failed_step` and
    `error` describe a run that did not finish, and are null for one that
    did. `error` is a message meant for a human, capped so a runaway
    device string cannot bloat the audit log."""

    serial: str = Field(min_length=1, max_length=120)
    event: Literal["factory_reset"]
    outcome: Literal["completed", "failed"]
    printer_model: str | None = Field(default=None, max_length=120)
    printer_firmware: str | None = Field(default=None, max_length=120)
    calibrated: bool = False
    failed_step: str | None = Field(default=None, max_length=60)
    error: str | None = Field(default=None, max_length=500)


# ── kiosk RFID enroll ──

class KioskRfidEnrollIn(BaseModel):
    """One tag the kiosk's RFID Enroll screen just read for an asset it
    already found by serial or asset ID.

    `rfid_tag` is whatever the reader produced: the server strips
    whitespace, upper-cases, and left-pads it with zeros to the house's
    24-character stored format itself (422 `bad_rfid` /
    `rfid_too_long`), so a kiosk that normalizes differently — or not at
    all — can never write a tag in another shape. The field is capped
    generously here so the endpoint's own codes, not a schema error,
    explain a too-long tag.

    `scan_status` is the checkpoint the enrollment scan records (the
    Admin tab's "RFID Enroll checkpoint"); `site_id` / `initiative_id`
    come from Kiosk Setup and fall back to the Device's own setup.
    `client_scan_id` makes the whole call idempotent, exactly as it does
    for /kiosk/scans."""

    serial: str = Field(min_length=1, max_length=120)
    rfid_tag: str = Field(min_length=1, max_length=200)
    scan_status: str = Field(min_length=1, max_length=120)
    client_scan_id: uuid.UUID
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None


class KioskRfidEnrollOut(BaseModel):
    """The tagged asset as the kiosk should now show it. `rfid_tag` is
    the stored (padded) value — the kiosk trims it for display the same
    way the portal's lists do. `already_had_tag` says this asset was
    already carrying exactly this tag, so nothing changed but the scan."""

    asset_id: uuid.UUID
    asset_name: str | None = None
    asset_tag: str          # the human Asset ID (Asset.legacy_id), "" if unset
    serial_number: str | None = None
    rfid_tag: str
    already_had_tag: bool


# ── kiosk timeclock ──

class KioskTimeclockPerson(BaseModel):
    """Who the kiosk is punching, as the timeclock screen shows them —
    avatar included, so a worker recognizes themselves at a glance."""

    id: uuid.UUID
    display_name: str
    first_name: str
    last_name: str
    preferred_name: str | None = None
    avatar_url: str | None = None      # presigned, short-lived; None without an avatar
    rfid_tag: str | None = None


class KioskTimeclockEntry(BaseModel):
    """The open entry, so the kiosk can show how long they have been on
    the clock (now - started_at) and against which move and site."""

    id: uuid.UUID
    started_at: datetime
    initiative_id: uuid.UUID | None = None
    initiative_name: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None


class KioskTimeclockLastEntry(BaseModel):
    """The entry a clock-out just closed — enough for "Clocked out after
    3h 12m" without a second round trip."""

    id: uuid.UUID
    started_at: datetime
    ended_at: datetime
    minutes: int


class KioskTimeclockStatusOut(BaseModel):
    person: KioskTimeclockPerson
    clocked_in: bool
    entry: KioskTimeclockEntry | None = None
    last_entry: KioskTimeclockLastEntry | None = None


# ── kiosk containers (pack / unpack) ──

class KioskContainerOut(BaseModel):
    """One of the move's containers as the kiosk caches it — enough to
    recognize a scanned container (RFID tag, label tag, name) and to show
    its header card (type, status, site) without a round trip.
    `asset_count` is the count at sync time; the Containers screen keeps
    its own live count from there."""

    id: uuid.UUID
    name: str
    rfid_tag: str | None = None
    label_tag: str | None = None
    container_type: str | None = None
    status: str
    status_label: str
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    asset_count: int


class KioskContainersSyncOut(BaseModel):
    initiative_id: uuid.UUID
    generated_at: datetime
    containers: list[KioskContainerOut]


class KioskContainerAssetIn(BaseModel):
    """One asset the kiosk just scanned into (or out of) a container.

    `action` is what the Pack / Unpack toggle was set to. `scanned_value`
    and `scan_type` describe the physical scan exactly as /kiosk/scans
    records it — the value the kiosk matched on, and whether it came off
    a reader or a barcode. `asset_id` is the kiosk's own local match; the
    server acts on it (membership is relational state, not something the
    scan matcher can decide), but the raw scan still carries
    `scanned_value` for the matcher to resolve independently.

    `scan_status` is the checkpoint the pack/unpack scan records (the
    Admin tab's "Container pack/unpack checkpoint"); `site_id` /
    `initiative_id` come from Kiosk Setup and fall back to the Device's
    own setup. `client_scan_id` makes the scan idempotent, exactly as it
    does for /kiosk/scans."""

    serial: str = Field(min_length=1, max_length=120)
    asset_id: uuid.UUID
    action: Literal["pack", "unpack"]
    scanned_value: str = Field(min_length=1, max_length=200)
    scan_type: Literal["rfid", "barcode"]
    scan_status: str = Field(min_length=1, max_length=120)
    client_scan_id: uuid.UUID
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None


class KioskContainerRef(BaseModel):
    """A container named in a result — the one packed into, or the one an
    asset was moved out of / is actually in."""

    id: uuid.UUID
    name: str


class KioskContainerStateOut(KioskContainerRef):
    asset_count: int


class KioskContainerAssetRow(BaseModel):
    """The asset a pack/unpack acted on, for the session list."""

    id: uuid.UUID
    name: str | None = None
    asset_tag: str          # the human Asset ID (Asset.legacy_id), "" if unset
    serial_number: str | None = None
    rfid: str | None = None


class KioskContainerAssetOut(BaseModel):
    """What the Containers screen shows after a scan: the container with
    its fresh count, the asset as the portal holds it, and — when the
    unique membership constraint made a pack a move — the container it
    came out of. `already_there` means the asset was already in THIS
    container, so only the scan was recorded."""

    container: KioskContainerStateOut
    asset: KioskContainerAssetRow
    action: Literal["pack", "unpack"]
    moved_from: KioskContainerRef | None = None
    already_there: bool = False


# ── kiosk trucks (load / unload) ──

class KioskTruckOut(BaseModel):
    """One of the move's trucks as the kiosk caches it. Trucks carry no
    RFID tag, so nothing here is a scannable key — this is what the
    Trucks screen's card picker shows (name, load number, status, driver,
    the route) and filters on (name or load number).

    `container_count` is the count at sync time; the screen keeps its own
    live count from there, and every load/unload answer carries a fresh
    one."""

    id: uuid.UUID
    name: str
    load_number: str | None = None
    status: str
    status_label: str
    driver_name: str | None = None
    start_site_id: uuid.UUID | None = None
    start_site_name: str | None = None
    end_site_id: uuid.UUID | None = None
    end_site_name: str | None = None
    container_count: int


class KioskTrucksSyncOut(BaseModel):
    initiative_id: uuid.UUID
    generated_at: datetime
    trucks: list[KioskTruckOut]


class KioskTruckContainerIn(BaseModel):
    """One container the kiosk just scanned onto (or off) a truck.

    Trucks carry CONTAINERS, not assets — `truck_containers` is keyed on
    (truck_id, container_id) and there is no asset-to-truck link. When the
    operator scans an asset, the kiosk resolves it to the container it is
    packed in and sends THAT container's id; `scanned_value` still carries
    what was physically read, so the scan record is honest about it.

    `scan_status` is the checkpoint the load/unload scan records (the
    Admin tab's "Truck load/unload checkpoint"); `site_id` /
    `initiative_id` come from Kiosk Setup and fall back to the Device's
    own setup. `client_scan_id` makes the scan idempotent, exactly as it
    does for /kiosk/scans."""

    serial: str = Field(min_length=1, max_length=120)
    container_id: uuid.UUID
    action: Literal["load", "unload"]
    scanned_value: str = Field(min_length=1, max_length=200)
    scan_type: str = Field(min_length=1, max_length=120)
    scan_status: str = Field(min_length=1, max_length=120)
    client_scan_id: uuid.UUID
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None


class KioskTruckRef(BaseModel):
    """A truck named in a result — the one loaded, or the one a container
    was moved off / is actually on."""

    id: uuid.UUID
    name: str


class KioskTruckStateOut(KioskTruckRef):
    container_count: int


class KioskTruckContainerRow(BaseModel):
    """The container a load/unload acted on, for the session list."""

    id: uuid.UUID
    name: str
    asset_count: int


class KioskTruckContainerOut(BaseModel):
    """What the Trucks screen shows after a scan: the truck with its fresh
    count, the container as the portal holds it, and — when the container
    was already riding another truck — the truck it came off.
    `already_there` means the container was already on THIS truck, so only
    the scan was recorded."""

    truck: KioskTruckStateOut
    container: KioskTruckContainerRow
    action: Literal["load", "unload"]
    moved_from: KioskTruckRef | None = None
    already_there: bool = False


class KioskClockInIn(BaseModel):
    """`site_id` / `initiative_id` left out fall back to the kiosk
    Device's own setup. There is deliberately no `at`: the kiosk has no
    offline queue (see the spec), so it never needs to back-date a punch,
    and `kiosk:view` includes the worker role, which holds no `time`
    grants — an unbounded `at` would let a worker post a fabricated
    back-dated clock-in straight into the approval queue, bypassing the
    portal's own `time:change` + `adjust_reason` gate on edits. Every
    kiosk punch is stamped `datetime.now(UTC)`; back-dating stays a
    portal action."""

    serial: str = Field(min_length=1, max_length=120)
    person_id: uuid.UUID
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None


class KioskClockOutIn(BaseModel):
    """No `at` either, for the same reason as `KioskClockInIn` — see
    there."""

    serial: str = Field(min_length=1, max_length=120)
    person_id: uuid.UUID


# ── Labels ──


class LabelVocabOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    kind: str
    key: str
    label: str
    description: str
    meta: dict
    sort_order: int
    is_active: bool
    # populated on every listing — counts label_templates referencing the key
    usage_count: int | None = None


class LabelVocabCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["type", "size", "dpi", "language"]
    key: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=80)
    description: str = ""
    meta: dict = Field(default_factory=dict)
    sort_order: int = 0


class LabelVocabUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(None, min_length=1, max_length=80)
    description: str | None = None
    meta: dict | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class LabelPlaceholderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    key: str
    label: str
    description: str
    sample_value: str
    applies_to: list[str]
    sort_order: int
    is_active: bool
    usage_count: int | None = None


class LabelPlaceholderCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    label: str = Field(min_length=1, max_length=80)
    description: str = ""
    sample_value: str = ""
    applies_to: list[str] = Field(default_factory=list)
    sort_order: int = 0


class LabelPlaceholderUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(None, min_length=1, max_length=80)
    description: str | None = None
    sample_value: str | None = None
    applies_to: list[str] | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class LabelTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str
    label_type: str
    size_key: str
    dpi_key: str
    language_key: str
    kind: str
    design: dict | None
    code: str | None
    version: int
    is_active: bool
    # V2 label_generation_code port — position-split + length-limit rules;
    # see api/routes/labels.py's _validate_generation_rules for the shape.
    generation_rules: dict = Field(default_factory=dict)
    # assignment set; [] = global. Populated by the route, not from_attributes.
    site_ids: list[uuid.UUID] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class LabelFontUsedByOut(BaseModel):
    template_id: uuid.UUID
    template_name: str


class LabelFontOut(BaseModel):
    id: uuid.UUID
    name: str
    display_name: str
    size_bytes: int
    content_type: str
    uploaded_by: uuid.UUID | None
    uploaded_by_name: str | None
    created_at: datetime
    used_by: list[LabelFontUsedByOut]


class LabelTemplateCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    label_type: str
    size_key: str
    dpi_key: str
    language_key: str
    kind: Literal["design", "code"]
    design: dict | None = None
    code: str | None = None
    generation_rules: dict = Field(default_factory=dict)
    site_ids: list[uuid.UUID] | None = None


class LabelTemplateUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = None
    label_type: str | None = None
    size_key: str | None = None
    dpi_key: str | None = None
    language_key: str | None = None
    design: dict | None = None
    code: str | None = None
    is_active: bool | None = None
    generation_rules: dict | None = None
    site_ids: list[uuid.UUID] | None = None


class LabelCompileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["design", "code"]
    design: dict | None = None
    code: str | None = Field(None, max_length=20000)
    size_key: str
    dpi_key: str
    language_key: str
    mode: Literal["placeholders", "sample"] = "placeholders"


class LabelCompileOut(BaseModel):
    code: str


class LabelZplPreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    zpl: str = Field(min_length=1, max_length=20000)
    size_key: str
    dpi_key: str


# ── generate labels (runs, preview, generated) ──────────────────────

class LabelRunCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    initiative_id: uuid.UUID
    # No min_length here on purpose: an empty list must reach the route's
    # enqueue_run() call so it 422s as {"code": "invalid_label_types",
    # "problems": []} — the project's error shape — rather than a stock
    # pydantic validation error with no `code` at all.
    label_types: list[str]
    regenerate_existing: bool = False
    notify: bool = False
    # type key -> template id: the operator's per-type override of
    # select_template's auto-match. Also reaches enqueue_run() for
    # validation (unknown key, inactive template, wrong type) rather than
    # a stock pydantic error, so it 422s as {"code": "invalid_templates",
    # "problems": [...]}.
    templates: dict[str, uuid.UUID] = Field(default_factory=dict)


class LabelRunOut(BaseModel):
    id: uuid.UUID
    initiative_id: uuid.UUID
    initiative_name: str
    label_types: list[str]
    regenerate_existing: bool
    status: str
    cancel_requested: bool
    current_label_type: str | None
    current_item: str | None
    total: int
    processed: int
    generated: int
    skipped: int
    errors: int
    error_summary: dict
    error_details: list
    error: str | None
    requested_by: uuid.UUID
    requested_by_name: str
    notify: bool
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    worker_id: str | None
    # round(processed/total*100) or 0 when total is 0 (nothing queued yet).
    progress_pct: int
    # type key -> template id (text) — the operator's per-type override,
    # as validated and stored by enqueue_run.
    template_overrides: dict[str, str]


class LabelGeneratePreviewInitiativeOut(BaseModel):
    id: uuid.UUID
    name: str
    client_name: str | None
    status: str
    scheduled_start: datetime | None
    source_name: str | None
    destination_name: str | None
    asset_count: int


class LabelGeneratePreviewTemplateOut(BaseModel):
    id: uuid.UUID
    name: str
    version: int
    scope: Literal["site", "global"]


class LabelGeneratePreviewCandidateOut(BaseModel):
    id: uuid.UUID
    name: str
    version: int
    scope: Literal["site", "global", "other"]
    # populated only for scope 'other' — which other site(s) it's linked
    # to, since that's not otherwise visible from a bare candidate row.
    site_names: list[str]


class LabelGeneratePreviewTypeOut(BaseModel):
    key: str
    label: str
    # the auto-match (candidates[0] when its scope is site/global);
    # None both when there's no active template at all and when the
    # only active templates are 'other'-scoped (linked to a different
    # site) — an operator must pick one explicitly in that case too.
    template: LabelGeneratePreviewTemplateOut | None
    candidates: list[LabelGeneratePreviewCandidateOut]
    current: int
    stale: int


class LabelGeneratePreviewOut(BaseModel):
    initiative: LabelGeneratePreviewInitiativeOut
    types: list[LabelGeneratePreviewTypeOut]
    active_run_id: uuid.UUID | None


class GeneratedLabelOut(BaseModel):
    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    # the human Asset ID (assets.legacy_id) — None for a non-asset entity.
    asset_id: int | None
    serial_number: str | None
    name: str | None
    label_type: str
    template_name: str
    template_version: int
    generated_at: datetime
    stale: bool
    code: str


class GeneratedLabelBundleItemOut(BaseModel):
    id: uuid.UUID
    entity_type: Literal["asset", "container"]
    entity_id: uuid.UUID
    template_id: uuid.UUID
    template_name: str
    template_version: int
    language_key: str
    size_key: str
    dpi_key: str
    stale: bool
    generated_at: datetime
    code: str


class GeneratedLabelBundleOut(BaseModel):
    """Every generated label for one initiative + label type — the Print
    Labels page's print payload and its offline-cache entry. Not paged:
    an initiative's labels are bounded by its roster."""
    initiative_id: uuid.UUID
    label_type: str
    fetched_at: datetime
    labels: list[GeneratedLabelBundleItemOut]


# ── reports ───────────────────────────────────────────────────────

class ReportDefinitionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str
    report_type: str
    options: dict
    is_system: bool
    updated_at: datetime


class ReportDefinitionUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = Field(None, max_length=1000)
    options: dict | None = None


class ReportRunCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    definition_id: uuid.UUID
    # Optional — a Site & Move Survey may target a partner + manually
    # chosen sites with no initiative at all; every other report type
    # still requires one (routes/reports.py's create_run 422s otherwise).
    initiative_id: uuid.UUID | None = None
    options: dict = Field(default_factory=dict)
    notify: bool = False


class ReportRunNotifyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    notify: bool


class ReportRunOut(BaseModel):
    id: uuid.UUID
    definition_id: uuid.UUID
    definition_name: str
    report_type: str
    initiative_id: uuid.UUID | None
    initiative_name: str
    options: dict
    status: str
    error: str | None = None
    requested_by: uuid.UUID
    requested_by_name: str
    requested_rank: int
    notify: bool
    filename: str | None = None
    size_bytes: int | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_at: datetime


class ReportDownloadOut(BaseModel):
    url: str


class SurveyPartnerOut(BaseModel):
    """One row of `GET /reports/site-move-survey/partners` — a logistics
    partner the Generate modal's Partner step can pick. The xlsx
    template itself lives on the report definition, not the partner, so
    this carries no template flag."""

    id: uuid.UUID
    name: str


class ScanHistoryPreviewStatusOut(BaseModel):
    """One status column of `GET /reports/move-scan-history/preview`, in
    `ScanHistoryData.statuses`'s "all" order — `in_pipeline` and
    `scan_count` let the modal derive both `status_columns` modes
    (pipeline / all) from this one response."""

    key: str
    label: str
    color: str
    in_pipeline: bool
    scan_count: int


class ScanHistoryPreviewInitiativeOut(BaseModel):
    id: uuid.UUID
    name: str
    client_name: str | None
    scheduled_start: datetime | None
    source_name: str | None
    destination_name: str | None


class ScanHistoryPreviewOut(BaseModel):
    initiative: ScanHistoryPreviewInitiativeOut
    total_assets: int
    scanned_assets: int
    completed: int
    completion_pct: int
    last_scan_at: datetime | None
    statuses: list[ScanHistoryPreviewStatusOut]


# ── trucks ─────────────────────────────────────────────────────────

class TruckLastUpdate(BaseModel):
    recorded_at: datetime
    lat: float | None = None
    lng: float | None = None
    approximate_address: str = ""


class TruckItem(BaseModel):
    id: uuid.UUID
    legacy_id: int | None = None
    name: str
    driver_name: str | None = None
    co_driver_name: str | None = None
    team_drive: bool = False
    contact_info: str = ""
    status: str
    status_label: str
    status_color: str
    load_number: str | None = None
    seal_id: str | None = None
    tracking_type: dict = {}
    initiative_id: uuid.UUID | None = None
    initiative_name: str | None = None
    start_site_id: uuid.UUID | None = None
    start_site_name: str | None = None
    end_site_id: uuid.UUID | None = None
    end_site_name: str | None = None
    container_count: int = 0
    last_update: TruckLastUpdate | None = None
    archived_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class TruckContainerOut(BaseModel):
    id: uuid.UUID
    name: str
    status: str
    status_label: str
    status_color: str
    asset_count: int = 0


class TruckDetail(TruckItem):
    containers: list[TruckContainerOut] = []


class TruckCreateIn(BaseModel):
    name: str
    driver_name: str | None = None
    co_driver_name: str | None = None
    load_number: str | None = None
    seal_id: str | None = None
    team_drive: bool = False
    contact_info: str = ""
    status: str = "created"
    tracking_type: dict = {}
    initiative_id: uuid.UUID | None = None
    start_site_id: uuid.UUID | None = None
    end_site_id: uuid.UUID | None = None
    container_ids: list[uuid.UUID] = []
    model_config = ConfigDict(extra="forbid")


class TruckUpdateIn(BaseModel):
    """PATCH /trucks/{id} — every field optional; None (unset) means
    unchanged. container_ids, when present, REPLACES the link set."""

    name: str | None = None
    driver_name: str | None = None
    co_driver_name: str | None = None
    load_number: str | None = None
    seal_id: str | None = None
    team_drive: bool | None = None
    contact_info: str | None = None
    status: str | None = None
    tracking_type: dict | None = None
    initiative_id: uuid.UUID | None = None
    start_site_id: uuid.UUID | None = None
    end_site_id: uuid.UUID | None = None
    container_ids: list[uuid.UUID] | None = None
    model_config = ConfigDict(extra="forbid")


class TruckUpdateOut(BaseModel):
    id: uuid.UUID
    truck_id: uuid.UUID
    recorded_at: datetime
    location: str
    lat: float | None = None
    lng: float | None = None
    approximate_address: str = ""
    source: str = "manual"


class TruckUpdateCreateIn(BaseModel):
    location: str | dict
    approximate_address: str = ""
    recorded_at: datetime | None = None
    source: str = "manual"
    model_config = ConfigDict(extra="forbid")


class TruckTrailPoint(BaseModel):
    recorded_at: datetime
    lat: float
    lng: float


class TruckMapPoint(BaseModel):
    id: uuid.UUID
    name: str
    status: str
    status_label: str
    status_color: str
    driver_name: str | None = None
    load_number: str | None = None
    seal_id: str | None = None
    last_update: TruckLastUpdate
    trail: list[TruckTrailPoint] = []


# ── warehouse ─────────────────────────────────────────────────────────

class AssetRef(BaseModel):
    id: uuid.UUID
    legacy_id: int | None = None
    serial_number: str | None = None
    name: str | None = None
    model_name: str | None = None
    status: str
    status_label: str
    status_color: str
    location_detail: str = ""


class StockLineOut(BaseModel):
    id: uuid.UUID
    site_id: uuid.UUID
    site_name: str
    container_id: uuid.UUID | None = None
    container_name: str | None = None
    model_id: uuid.UUID | None = None
    model_make: str | None = None
    model_model: str | None = None
    description: str
    quantity: int
    unit: str
    location_detail: str = ""
    notes: str = ""
    archived_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class StockLineCreateIn(BaseModel):
    site_id: uuid.UUID
    container_id: uuid.UUID | None = None
    model_id: uuid.UUID | None = None
    description: str
    quantity: int = Field(ge=0)
    unit: str = "each"
    location_detail: str = ""
    notes: str = ""
    model_config = ConfigDict(extra="forbid")


class StockLineUpdateIn(BaseModel):
    """PATCH — every field optional; None (unset) means unchanged EXCEPT
    container_id/model_id where an explicit null means 'clear'."""

    site_id: uuid.UUID | None = None
    container_id: uuid.UUID | None = None
    model_id: uuid.UUID | None = None
    description: str | None = None
    quantity: int | None = Field(default=None, ge=0)
    unit: str | None = None
    location_detail: str | None = None
    notes: str | None = None
    model_config = ConfigDict(extra="forbid")


class WarehouseSiteOut(BaseModel):
    id: uuid.UUID
    name: str
    code: str | None = None
    city: str | None = None
    region: str | None = None
    status: str
    status_label: str
    status_color: str
    container_count: int = 0
    asset_count: int = 0
    stock_line_count: int = 0
    stock_units: int = 0


class WarehouseContainerOut(BaseModel):
    id: uuid.UUID
    name: str
    rfid_tag: str | None = None
    container_type: str | None = None
    type_label: str | None = None
    type_color: str | None = None
    status: str
    status_label: str
    status_color: str
    location_detail: str = ""
    updated_at: datetime
    assets: list[AssetRef] = []
    stock: list[StockLineOut] = []


class WarehouseInventoryOut(BaseModel):
    site: WarehouseSiteOut
    containers: list[WarehouseContainerOut] = []
    loose_assets: list[AssetRef] = []
    loose_stock: list[StockLineOut] = []
