"""Integration credentials Sirdar publishes with (phase 4): the Cloudflare
API token and the Nginx Proxy Manager login, plus their non-secret settings.

The secret is Fernet-encrypted with SIRDAR_SECRETS_KEY in
integrations.secret_enc and write-only: public() reports only whether one is
set, errors name fields, never values, and the config dataclasses keep the
secret out of repr(). Callers audit and commit."""

import ipaddress
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Integration, User
from sirdar_api.deploy import envfile, vault

KINDS = ("cloudflare", "npm")
LABELS = {"cloudflare": "Cloudflare", "npm": "Nginx Proxy Manager"}
FIELDS = {"cloudflare": ("zone", "public_ip"), "npm": ("url", "identity", "letsencrypt_email")}
SECRET_FIELD = {"cloudflare": "token", "npm": "password"}
DEFAULT_ZONE = "serversherpa.com"
PASSWORD_MAX = 1024

_DOMAIN_RE = re.compile(r"(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{20,200}")
_URL_RE = re.compile(r"https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?")
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}")

_REASONS = {
    "secrets_key_missing": "SIRDAR_SECRETS_KEY isn't set, so Sirdar can't read the "
                           "integration credentials.",
    "integration_unreadable": "The stored credentials don't open with the current "
                              "SIRDAR_SECRETS_KEY. Enter them again in Settings.",
}


class IntegrationError(Exception):
    """`code` is the API error code; `extra` holds non-secret details."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra

    @property
    def reason(self) -> str:
        return _REASONS.get(self.code, "The integration settings can't be used.")


@dataclass(frozen=True)
class CloudflareConfig:
    zone: str
    public_ip: str
    token: str = field(repr=False)


@dataclass(frozen=True)
class NpmConfig:
    url: str
    identity: str
    letsencrypt_email: str
    password: str = field(repr=False)


def _check_cloudflare(values: dict) -> dict:
    zone = str(values.get("zone") or "").strip().lower().rstrip(".")
    if not _DOMAIN_RE.fullmatch(zone):
        raise IntegrationError("zone_invalid")
    try:
        ip = str(ipaddress.IPv4Address(str(values.get("public_ip") or "").strip()))
    except ValueError:
        raise IntegrationError("public_ip_invalid") from None
    return {"zone": zone, "public_ip": ip}


def _email(value: str) -> bool:
    return len(value) <= 254 and bool(_EMAIL_RE.fullmatch(value))


def _check_npm(values: dict) -> dict:
    url = str(values.get("url") or "").strip().rstrip("/")
    if not _URL_RE.fullmatch(url):
        raise IntegrationError("npm_url_invalid")
    identity = str(values.get("identity") or "").strip()
    if not _email(identity):
        raise IntegrationError("identity_invalid")
    email = str(values.get("letsencrypt_email") or "").strip() or identity
    if not _email(email):
        raise IntegrationError("letsencrypt_email_invalid")
    return {"url": url, "identity": identity, "letsencrypt_email": email}


def check_fields(kind: str, values: dict) -> dict:
    return _check_cloudflare(values) if kind == "cloudflare" else _check_npm(values)


def check_secret(kind: str, value: str) -> str:
    if kind == "cloudflare":
        if not isinstance(value, str) or not _TOKEN_RE.fullmatch(value):
            raise IntegrationError("token_invalid")
    elif (not isinstance(value, str) or not value or len(value) > PASSWORD_MAX
          or envfile.unsafe_value(value)):
        raise IntegrationError("password_invalid")
    return value


def _config(kind: str, config: dict, secret: str) -> CloudflareConfig | NpmConfig:
    if kind == "cloudflare":
        return CloudflareConfig(zone=config["zone"], public_ip=config["public_ip"], token=secret)
    return NpmConfig(url=config["url"], identity=config["identity"],
                     letsencrypt_email=config.get("letsencrypt_email") or config["identity"],
                     password=secret)


def _decrypt(settings: Settings, row: Integration) -> str:
    try:
        return vault.decrypt(settings, row.secret_enc)
    except vault.SecretsKeyMissing:
        raise IntegrationError("secrets_key_missing") from None
    except vault.SecretUnreadable:
        raise IntegrationError("integration_unreadable", kind=row.kind) from None


async def _row(db: AsyncSession, kind: str) -> Integration | None:
    return await db.get(Integration, kind, populate_existing=True)


async def is_configured(db: AsyncSession, kind: str) -> bool:
    row = await _row(db, kind)
    return row is not None and row.secret_enc is not None


async def load(db: AsyncSession, settings: Settings,
               kind: str) -> CloudflareConfig | NpmConfig | None:
    """The stored settings with the decrypted secret; None when not set up."""
    row = await _row(db, kind)
    if row is None or row.secret_enc is None:
        return None
    return _config(kind, row.config, _decrypt(settings, row))


async def load_cloudflare(db: AsyncSession, settings: Settings) -> CloudflareConfig | None:
    return await load(db, settings, "cloudflare")


async def load_npm(db: AsyncSession, settings: Settings) -> NpmConfig | None:
    return await load(db, settings, "npm")


async def candidate(db: AsyncSession, settings: Settings, kind: str, values: dict,
                    secret: str | None) -> CloudflareConfig | NpmConfig:
    """Unsaved values for a Test: the given secret, else the stored one."""
    checked = check_fields(kind, values)
    if secret is not None:
        return _config(kind, checked, check_secret(kind, secret))
    row = await _row(db, kind)
    if row is None or row.secret_enc is None:
        raise IntegrationError("secret_required")
    return _config(kind, checked, _decrypt(settings, row))


async def save(db: AsyncSession, settings: Settings, kind: str, values: dict,
               secret: str | None, actor_id) -> list[str]:
    """Store the settings, and the secret when given (None keeps the stored
    one). Returns the names of what changed (the secret as token/password)."""
    checked = check_fields(kind, values)
    if secret is not None:
        check_secret(kind, secret)
    row = await _row(db, kind)
    if secret is None and (row is None or row.secret_enc is None):
        raise IntegrationError("secret_required")
    if secret is not None and not vault.is_configured(settings):
        raise IntegrationError("secrets_key_missing")
    if row is None:
        row = Integration(kind=kind, config={})
        db.add(row)
    changed = [k for k, v in checked.items() if row.config.get(k) != v]
    row.config = dict(checked)
    if secret is not None:
        row.secret_enc = vault.encrypt(settings, secret)
        changed.append(SECRET_FIELD[kind])
    if changed:
        row.updated_by, row.updated_at = actor_id, datetime.now(UTC)
    await db.flush()
    return changed


async def remove(db: AsyncSession, kind: str) -> bool:
    result = await db.execute(delete(Integration).where(Integration.kind == kind))
    return result.rowcount > 0


async def public(db: AsyncSession, settings: Settings) -> dict:
    """What the Settings page shows: settings and whether a secret is set."""
    out: dict = {"secrets_key_configured": vault.is_configured(settings)}
    for kind in KINDS:
        row = await _row(db, kind)
        config = dict(row.config) if row else {}
        by = await db.get(User, row.updated_by) if row and row.updated_by else None
        out[kind] = {
            "configured": bool(row and row.secret_enc is not None),
            **{name: config.get(name) for name in FIELDS[kind]},
            f"{SECRET_FIELD[kind]}_set": bool(row and row.secret_enc is not None),
            "updated_at": row.updated_at if row else None,
            "updated_by_name": by.display_name if by else None,
        }
    return out
