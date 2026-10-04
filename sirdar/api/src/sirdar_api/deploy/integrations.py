"""Integration credentials: the Cloudflare API token and the Nginx Proxy
Manager login Sirdar publishes with (phase 4), and the Proxmox API token it
builds VMs with (phase 5), plus their non-secret settings. Proxmox's config
also holds the pinned TLS certificate (tls_pin) and the token's id part.

The secret is Fernet-encrypted with SIRDAR_SECRETS_KEY in
integrations.secret_enc and write-only: public() reports only whether one is
set, errors name fields, never values, and the config dataclasses keep the
secret out of repr(). Callers audit and commit."""

import ipaddress
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Environment, Integration, User
from sirdar_api.deploy import envfile, tls_pin, vault

KINDS = ("cloudflare", "npm", "proxmox")
LABELS = {"cloudflare": "Cloudflare", "npm": "Nginx Proxy Manager", "proxmox": "Proxmox"}
FIELDS = {"cloudflare": ("zone", "public_ip"), "npm": ("url", "identity", "letsencrypt_email"),
          "proxmox": ("url", "node", "pool", "storage", "bridge", "vlan_tag", "template_vmid",
                      "tls_fingerprint", "token_id")}
SECRET_FIELD = {"cloudflare": "token", "npm": "password", "proxmox": "token"}
DEFAULT_ZONE = "serversherpa.com"
# A stored secret is reused (secret omitted) only for the target it was
# entered for: the Cloudflare token only ever goes to api.cloudflare.com, so
# the zone is enough; the NPM password goes to the URL, for the login.
TARGET_FIELDS = {"cloudflare": ("zone",), "npm": ("url", "identity"), "proxmox": ("url",)}
NEW_TARGET_REASON = {
    "cloudflare": "Enter the token again to use it with a different zone.",
    "npm": "Enter the password again to use it with a different server or login.",
    "proxmox": "Enter the API token again to use it with a different Proxmox server.",
}
# The environment target that builds its host on Proxmox (targets.PROXMOX_TARGET).
PROXMOX_TARGET = "proxmox"
PASSWORD_MAX = 1024

_DOMAIN_RE = re.compile(r"(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{20,200}")
_URL_RE = re.compile(r"https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?")
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}")
_PVE_URL_RE = re.compile(r"https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?")
_NODE_RE = re.compile(r"[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_POOL_RE = re.compile(r"[A-Za-z0-9_.-]{1,40}")
_STORAGE_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,62}")
_BRIDGE_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,14}")
# user@realm!tokenid=<uuid>: the id part is shown, the uuid is the secret.
_PVE_TOKEN_RE = re.compile(
    r"([A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,64}![A-Za-z][A-Za-z0-9._-]{1,63})="
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})")
_FINGERPRINT_RE = re.compile(r"([0-9A-F]{2}:){31}[0-9A-F]{2}")

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


@dataclass(frozen=True)
class ProxmoxConfig:
    url: str
    node: str
    pool: str
    storage: str
    bridge: str
    vlan_tag: int | None
    template_vmid: int
    tls_fingerprint: str
    tls_cert_pem: str = field(repr=False)
    token: str = field(repr=False)          # user@realm!tokenid=<uuid>

    @property
    def token_id(self) -> str:
        return token_id_of(self.token)

    @property
    def token_secret(self) -> str:
        return self.token.split("=", 1)[1]


def token_id_of(token: str) -> str:
    return token.split("=", 1)[0]


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


def check_proxmox_url(value) -> str:
    url = str(value or "").strip().rstrip("/")
    if not _PVE_URL_RE.fullmatch(url):
        raise IntegrationError("proxmox_url_invalid")
    return url


def _int_in(value, low: int, high: int, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise IntegrationError(code)
    return value


def _check_proxmox(values: dict) -> dict:
    """Also needs the certificate the route fetched and the user trusted:
    `tls_cert_pem` must have the fingerprint `tls_fingerprint`."""
    url = check_proxmox_url(values.get("url"))

    def text(key: str, regex: re.Pattern, code: str) -> str:
        value = str(values.get(key) or "").strip()
        if not regex.fullmatch(value):
            raise IntegrationError(code)
        return value

    node = text("node", _NODE_RE, "node_invalid")
    pool = text("pool", _POOL_RE, "pool_invalid")
    storage = text("storage", _STORAGE_RE, "storage_invalid")
    bridge = text("bridge", _BRIDGE_RE, "bridge_invalid")
    vlan = values.get("vlan_tag")
    vlan = None if vlan is None else _int_in(vlan, 1, 4094, "vlan_tag_invalid")
    template = _int_in(values.get("template_vmid"), 100, 999_999_999, "template_vmid_invalid")
    fingerprint = str(values.get("tls_fingerprint") or "").strip().upper()
    pem = values.get("tls_cert_pem")
    if not _FINGERPRINT_RE.fullmatch(fingerprint) or not isinstance(pem, str):
        raise IntegrationError("tls_untrusted")
    try:
        actual = tls_pin.fingerprint_of(pem)
    except ValueError:
        raise IntegrationError("tls_untrusted") from None
    if actual != fingerprint:
        raise IntegrationError("tls_untrusted")
    return {"url": url, "node": node, "pool": pool, "storage": storage, "bridge": bridge,
            "vlan_tag": vlan, "template_vmid": template, "tls_fingerprint": fingerprint,
            "tls_cert_pem": pem}


_CHECKS = {"cloudflare": _check_cloudflare, "npm": _check_npm, "proxmox": _check_proxmox}


def check_fields(kind: str, values: dict) -> dict:
    return _CHECKS[kind](values)


def check_secret(kind: str, value: str) -> str:
    if kind == "cloudflare":
        if not isinstance(value, str) or not _TOKEN_RE.fullmatch(value):
            raise IntegrationError("token_invalid")
    elif kind == "proxmox":
        if not isinstance(value, str) or not _PVE_TOKEN_RE.fullmatch(value):
            raise IntegrationError("proxmox_token_invalid")
    elif (not isinstance(value, str) or not value or len(value) > PASSWORD_MAX
          or envfile.unsafe_value(value)):
        raise IntegrationError("password_invalid")
    return value


def _config(kind: str, config: dict,
            secret: str) -> CloudflareConfig | NpmConfig | ProxmoxConfig:
    if kind == "cloudflare":
        return CloudflareConfig(zone=config["zone"], public_ip=config["public_ip"], token=secret)
    if kind == "proxmox":
        return ProxmoxConfig(url=config["url"], node=config["node"], pool=config["pool"],
                             storage=config["storage"], bridge=config["bridge"],
                             vlan_tag=config.get("vlan_tag"),
                             template_vmid=config["template_vmid"],
                             tls_fingerprint=config["tls_fingerprint"],
                             tls_cert_pem=config["tls_cert_pem"], token=secret)
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


def _check_same_target(kind: str, checked: dict, row: Integration) -> None:
    """Refuse to pair the stored secret with a server, login or zone it
    wasn't entered for (it would be sent there)."""
    if any(row.config.get(name) != checked[name] for name in TARGET_FIELDS[kind]):
        raise IntegrationError("secret_required", reason=NEW_TARGET_REASON[kind])


async def is_configured(db: AsyncSession, kind: str) -> bool:
    row = await _row(db, kind)
    return row is not None and row.secret_enc is not None


async def load(db: AsyncSession, settings: Settings,
               kind: str) -> CloudflareConfig | NpmConfig | ProxmoxConfig | None:
    """The stored settings with the decrypted secret; None when not set up."""
    row = await _row(db, kind)
    if row is None or row.secret_enc is None:
        return None
    return _config(kind, row.config, _decrypt(settings, row))


async def load_cloudflare(db: AsyncSession, settings: Settings) -> CloudflareConfig | None:
    return await load(db, settings, "cloudflare")


async def load_npm(db: AsyncSession, settings: Settings) -> NpmConfig | None:
    return await load(db, settings, "npm")


async def load_proxmox(db: AsyncSession, settings: Settings) -> ProxmoxConfig | None:
    return await load(db, settings, "proxmox")


async def config_of(db: AsyncSession, kind: str) -> dict:
    """The stored non-secret settings (a copy), {} when none."""
    row = await _row(db, kind)
    return dict(row.config) if row else {}


async def in_use(db: AsyncSession, kind: str) -> list[str]:
    """Environments that can't lose this integration: those built on
    Proxmox (their VMs could no longer be destroyed)."""
    if kind != "proxmox":
        return []
    return list(await db.scalars(select(Environment.name)
                                 .where(Environment.target_id == PROXMOX_TARGET)
                                 .order_by(Environment.name)))


async def candidate(db: AsyncSession, settings: Settings, kind: str, values: dict,
                    secret: str | None) -> CloudflareConfig | NpmConfig | ProxmoxConfig:
    """Unsaved values for a Test: the given secret, else the stored one."""
    checked = check_fields(kind, values)
    if secret is not None:
        return _config(kind, checked, check_secret(kind, secret))
    row = await _row(db, kind)
    if row is None or row.secret_enc is None:
        raise IntegrationError("secret_required")
    _check_same_target(kind, checked, row)
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
    if secret is None:
        _check_same_target(kind, checked, row)
    if secret is not None and not vault.is_configured(settings):
        raise IntegrationError("secrets_key_missing")
    if kind == "proxmox":
        checked["token_id"] = (token_id_of(secret) if secret is not None
                               else row.config.get("token_id"))
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
