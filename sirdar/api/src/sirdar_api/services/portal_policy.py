"""Ports of two portal rules the import evaluates once per person:
the 2FA policy (serversherpa/services/totp.py policy_for) and password
expiry (serversherpa/services/password_policy.py expires_at).
test_portal_compat.py pins the portal lines these mirror."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

SECURITY_DEFAULTS: dict = {
    "two_factor_enabled": False,
    "two_factor_required": False,
    "password_expiry_enabled": False,
    "password_expiry_days": 90,
    "password_expiry_since": None,
}


@dataclass(frozen=True)
class TotpPolicy:
    enabled: bool    # site master switch
    required: bool   # this account must use 2FA (implies enabled)


def totp_policy(cfg: dict, *, account_required: bool, in_totp_group: bool,
                has_totp_role: bool) -> TotpPolicy:
    if not cfg.get("two_factor_enabled"):
        return TotpPolicy(enabled=False, required=False)
    required = bool(cfg.get("two_factor_required") or account_required
                    or in_totp_group or has_totp_role)
    return TotpPolicy(enabled=True, required=required)


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def password_expires_at(cfg: dict, password_hash: str | None,
                        password_updated_at: datetime | None) -> datetime | None:
    if not cfg.get("password_expiry_enabled"):
        return None
    raw = cfg.get("password_expiry_since")
    since = _aware(datetime.fromisoformat(raw)) if raw else None
    if since is None or password_hash is None:
        return None
    changed = _aware(password_updated_at)
    start = since if changed is None else max(changed, since)
    return start + timedelta(days=int(cfg.get("password_expiry_days", 90)))
