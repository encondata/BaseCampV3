"""Response/request shapes. The auth ones mirror the portal's
serversherpa/api/schemas.py exactly — the SPA reuses the portal's
AuthProvider and Login, which read these fields."""

import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class PersonOut(BaseModel):
    id: uuid.UUID
    first_name: str
    last_name: str
    preferred_name: str | None
    display_name: str
    email: str | None
    job_title: str | None
    avatar_key: str | None = None
    avatar_url: str | None = None


class ScopeOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    global_: bool = Field(alias="global")
    client_ids: list[uuid.UUID] = []
    partner_ids: list[uuid.UUID] = []


class TotpStatusOut(BaseModel):
    enrolled: bool
    enrolled_at: datetime | None
    required: bool
    backup_codes_remaining: int


class NotifPrefs(BaseModel):
    model_config = ConfigDict(extra="ignore")

    critical: bool = True
    email: bool = True
    maint: bool = True
    digest: bool = False
    sound: Literal["none", "chime", "ping", "pop", "bell"] = "chime"


NAMED_ACCENTS = {"amber", "aqua", "blue", "violet", "pink", "green"}


class UiPreferences(BaseModel):
    """Same shape and defaults as the portal's UiPreferences."""

    model_config = ConfigDict(extra="ignore")

    accent: str = "amber"
    theme: Literal["light", "dark"] = "light"
    density: Literal["comfortable", "compact"] = "comfortable"
    list_size: Literal["small", "default", "large", "xlarge"] = "default"
    motion: bool = True
    notif: NotifPrefs = NotifPrefs()
    list_prefs: dict = {}
    nav_mode: Literal["expanded", "rail", "hidden"] = "expanded"
    nav_bg: str = "default"
    nav_size: Literal["small", "default", "large", "xlarge"] = "default"

    @field_validator("accent")
    @classmethod
    def _accent(cls, v: str) -> str:
        if v in NAMED_ACCENTS or re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            return v
        raise ValueError("accent must be a named accent or #rrggbb")

    @field_validator("nav_bg")
    @classmethod
    def _nav_bg(cls, v: str) -> str:
        if v == "default" or re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            return v
        raise ValueError("nav_bg must be 'default' or #rrggbb")


class MeOut(BaseModel):
    person: PersonOut
    roles: list[str]
    session_expires_at: datetime
    must_change_password: bool = False
    must_change_reason: Literal["temporary", "expired"] | None = None
    password_expires_at: datetime | None = None
    preferences: UiPreferences
    perms: dict[str, dict[str, bool]]
    max_rank: int
    scope: ScopeOut
    password_min_length: int = 8
    totp: TotpStatusOut
    kiosk_move: None = None
    source: Literal["portal", "local"]


class SessionOut(MeOut):
    status: Literal["ok"] = "ok"
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class LoginChallengeOut(BaseModel):
    status: Literal["totp_verify"] = "totp_verify"
    challenge_token: str
    backup_codes_remaining: int | None = None


class TotpVerifyIn(BaseModel):
    code: str = Field(min_length=6, max_length=16)
    remember: bool = False      # accepted for the portal client; Sirdar has no trusted devices


class SystemStatusOut(BaseModel):
    read_only: bool = False
    read_only_message: str = ""
    workers_paused: bool = False
    banner: str | None = None
    totp_trust_days: int = 0     # 0 hides "Remember this browser" on the shared Login
    needs_setup: bool


class EffectiveCellOut(BaseModel):
    value: bool
    source: Literal["role", "override", "hard_gate"]
