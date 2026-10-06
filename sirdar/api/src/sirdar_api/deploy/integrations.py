"""Integration credentials: the Cloudflare API token and the Nginx Proxy
Manager login Sirdar publishes with (phase 4), the Proxmox API token it
builds VMs with (phase 5), the ESXi password it builds VMs with (phase 6) and
(since phase 7) a facade over the Production DigitalOcean account in
do_accounts (SIRDAR_DEPLOY_DO_TOKEN is its fallback), plus their non-secret
settings. The Proxmox and ESXi configs also hold the pinned TLS certificate
(tls_pin); Proxmox's holds the token's id part.

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
from sirdar_api.db.models import DoAccount, Environment, Integration, User
from sirdar_api.deploy import envfile, tls_pin, vault

KINDS = ("cloudflare", "npm", "proxmox", "esxi", "digitalocean")
# The kinds an environment's VM is built on; an environment on one has
# target_id equal to the kind (targets.VM_TARGETS).
VM_HOST_KINDS = ("proxmox", "esxi")
LABELS = {"cloudflare": "Cloudflare", "npm": "Nginx Proxy Manager", "proxmox": "Proxmox",
          "esxi": "VMware ESXi", "digitalocean": "DigitalOcean"}
FIELDS = {"cloudflare": ("zone", "public_ip"), "npm": ("url", "identity", "letsencrypt_email"),
          "proxmox": ("url", "node", "pool", "storage", "bridge", "vlan_tag", "template_vmid",
                      "tls_fingerprint", "token_id"),
          "esxi": ("url", "user", "datastore", "network", "resource_pool", "source_vm",
                   "dns_servers", "tls_fingerprint"),
          "digitalocean": ()}
SECRET_FIELD = {"cloudflare": "token", "npm": "password", "proxmox": "token",
                "esxi": "password", "digitalocean": "token"}
DEFAULT_ZONE = "serversherpa.com"
# A stored secret is reused (secret omitted) only for the target it was
# entered for: the Cloudflare token only ever goes to api.cloudflare.com, so
# the zone is enough; the NPM and ESXi passwords go to the URL, for that login.
# The DigitalOcean token only ever goes to api.digitalocean.com.
TARGET_FIELDS = {"cloudflare": ("zone",), "npm": ("url", "identity"), "proxmox": ("url",),
                 "esxi": ("url", "user"), "digitalocean": ()}
NEW_TARGET_REASON = {
    "cloudflare": "Enter the token again to use it with a different zone.",
    "npm": "Enter the password again to use it with a different server or login.",
    "proxmox": "Enter the API token again to use it with a different Proxmox server.",
    "esxi": "Enter the password again to use it with a different ESXi host or user.",
    "digitalocean": "Enter the API token again.",
}
# The environment target that builds its host on Proxmox (targets.PROXMOX_TARGET).
PROXMOX_TARGET = "proxmox"
MAX_DNS_SERVERS = 3
PASSWORD_MAX = 1024

_DOMAIN_RE = re.compile(r"(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{20,200}")
# A DigitalOcean personal access token is dop_v1_ and 64 hex digits; other
# tokens (older or scoped formats) are any printable ASCII without spaces, up
# to 200 characters. Only a dop_v1_ token is held to its full shape, so a
# truncated paste is caught.
DO_TOKEN_PREFIX = "dop_v1_"
_DO_TOKEN_RE = re.compile(r"dop_v1_[0-9a-fA-F]{64}")
_PRINTABLE_TOKEN_RE = re.compile(r"[!-~]{1,200}")
_URL_RE = re.compile(r"https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?")
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}")
_PVE_URL_RE = re.compile(r"https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(?::([0-9]{1,5}))?")
_NODE_RE = re.compile(r"[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_POOL_RE = re.compile(r"[A-Za-z0-9_.-]{1,40}")
_STORAGE_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,62}")
_BRIDGE_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,14}")
# user@realm!tokenid=<uuid>: the id part is shown, the uuid is the secret.
# Proxmox's rule: the user is anything but whitespace, ':', '/', '!' and '@'
# (here also printable ASCII only and no '=', which splits id from secret);
# the realm [A-Za-z0-9._-]; the token id starts with a letter.
_PVE_TOKEN_RE = re.compile(
    r"((?:(?![:/!@=])[!-~]){1,64}@[A-Za-z0-9._-]{1,32}![A-Za-z][A-Za-z0-9._-]{0,63})="
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})")
# ESXi local users ("root", "sirdar") and datastore / port group / pool / VM
# names: no brackets (datastore paths use them), slashes, colons or
# leading/trailing spaces.
_ESXI_USER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@-]{0,63}")
_ESXI_NAME_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9 ._()-]{0,78}[A-Za-z0-9._()-])?")

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


@dataclass(frozen=True)
class EsxiConfig:
    url: str
    user: str
    datastore: str
    network: str
    resource_pool: str | None
    source_vm: str
    dns_servers: tuple[str, ...]
    tls_fingerprint: str
    tls_cert_pem: str = field(repr=False)
    password: str = field(repr=False)


@dataclass(frozen=True)
class DigitalOceanConfig:
    token: str = field(repr=False)
    # "stored" (Settings › Integrations) or "environment" (SIRDAR_DEPLOY_DO_TOKEN).
    source: str = "stored"


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


def check_https_url(value, code: str) -> str:
    url = str(value or "").strip().rstrip("/")
    match = _PVE_URL_RE.fullmatch(url)
    if not match or (match.group(2) is not None and not 1 <= int(match.group(2)) <= 65535):
        raise IntegrationError(code)
    return url


def check_proxmox_url(value) -> str:
    return check_https_url(value, "proxmox_url_invalid")


def check_esxi_url(value) -> str:
    return check_https_url(value, "esxi_url_invalid")


def _int_in(value, low: int, high: int, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise IntegrationError(code)
    return value


def _check_pin(values: dict) -> tuple[str, str]:
    """(fingerprint, certificate PEM): the certificate the route fetched and
    the user trusted must have the fingerprint the request names."""
    given = str(values.get("tls_fingerprint") or "").strip()
    if not given:                                  # nothing trusted yet
        raise IntegrationError("tls_untrusted")
    try:
        fingerprint = tls_pin.normalize_fingerprint(given)
    except ValueError:
        raise IntegrationError("tls_fingerprint_invalid") from None
    pem = values.get("tls_cert_pem")
    if not isinstance(pem, str):
        raise IntegrationError("tls_untrusted")
    try:
        actual = tls_pin.fingerprint_of(pem)
    except ValueError:
        raise IntegrationError("tls_untrusted") from None
    if actual != fingerprint:
        raise IntegrationError("tls_untrusted")
    return fingerprint, pem


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
    fingerprint, pem = _check_pin(values)
    return {"url": url, "node": node, "pool": pool, "storage": storage, "bridge": bridge,
            "vlan_tag": vlan, "template_vmid": template, "tls_fingerprint": fingerprint,
            "tls_cert_pem": pem}


def _check_dns(value) -> list[str]:
    """Up to MAX_DNS_SERVERS IPv4 addresses (a list, or one comma-separated
    string); empty: the VM uses its gateway."""
    if value in (None, ""):
        return []
    items = value if isinstance(value, list) else str(value).split(",")
    found: list[str] = []
    for item in items:
        text = str(item).strip()
        if not text:
            continue
        try:
            ip = ipaddress.IPv4Address(text)
        except ValueError:
            raise IntegrationError("dns_servers_invalid") from None
        if ip.is_unspecified or ip.is_multicast or ip.is_loopback or ip.is_link_local:
            raise IntegrationError("dns_servers_invalid")
        if str(ip) not in found:
            found.append(str(ip))
    if len(found) > MAX_DNS_SERVERS:
        raise IntegrationError("dns_servers_invalid")
    return found


check_dns_servers = _check_dns          # vms checks the stored list again before freezing it


def _check_esxi(values: dict) -> dict:
    url = check_esxi_url(values.get("url"))

    def text(key: str, regex: re.Pattern, code: str) -> str:
        value = str(values.get(key) or "").strip()
        if not regex.fullmatch(value):
            raise IntegrationError(code)
        return value

    user = text("user", _ESXI_USER_RE, "esxi_user_invalid")
    datastore = text("datastore", _ESXI_NAME_RE, "datastore_invalid")
    network = text("network", _ESXI_NAME_RE, "network_invalid")
    pool = str(values.get("resource_pool") or "").strip()
    if pool and not _ESXI_NAME_RE.fullmatch(pool):
        raise IntegrationError("resource_pool_invalid")
    source = text("source_vm", _ESXI_NAME_RE, "source_vm_invalid")
    dns = _check_dns(values.get("dns_servers"))
    fingerprint, pem = _check_pin(values)
    return {"url": url, "user": user, "datastore": datastore, "network": network,
            "resource_pool": pool or None, "source_vm": source, "dns_servers": dns,
            "tls_fingerprint": fingerprint, "tls_cert_pem": pem}


_CHECKS = {"cloudflare": _check_cloudflare, "npm": _check_npm, "proxmox": _check_proxmox,
           "esxi": _check_esxi, "digitalocean": lambda values: {}}


def check_fields(kind: str, values: dict) -> dict:
    return _CHECKS[kind](values)


def check_secret(kind: str, value: str) -> str:
    if kind == "cloudflare":
        if not isinstance(value, str) or not _TOKEN_RE.fullmatch(value):
            raise IntegrationError("token_invalid")
    elif kind == "proxmox":
        if not isinstance(value, str) or not _PVE_TOKEN_RE.fullmatch(value):
            raise IntegrationError("proxmox_token_invalid")
    elif kind == "digitalocean":
        if (not isinstance(value, str) or not _PRINTABLE_TOKEN_RE.fullmatch(value)
                or (value.startswith(DO_TOKEN_PREFIX) and not _DO_TOKEN_RE.fullmatch(value))):
            raise IntegrationError("do_token_invalid")
    elif (not isinstance(value, str) or not value or len(value) > PASSWORD_MAX
          or envfile.unsafe_value(value)):
        raise IntegrationError("password_invalid")
    return value


Config = CloudflareConfig | NpmConfig | ProxmoxConfig | EsxiConfig | DigitalOceanConfig


def _config(kind: str, config: dict, secret: str) -> Config:
    if kind == "digitalocean":
        return DigitalOceanConfig(token=secret)
    if kind == "cloudflare":
        return CloudflareConfig(zone=config["zone"], public_ip=config["public_ip"], token=secret)
    if kind == "proxmox":
        return ProxmoxConfig(url=config["url"], node=config["node"], pool=config["pool"],
                             storage=config["storage"], bridge=config["bridge"],
                             vlan_tag=config.get("vlan_tag"),
                             template_vmid=config["template_vmid"],
                             tls_fingerprint=config["tls_fingerprint"],
                             tls_cert_pem=config["tls_cert_pem"], token=secret)
    if kind == "esxi":
        return EsxiConfig(url=config["url"], user=config["user"], datastore=config["datastore"],
                          network=config["network"], resource_pool=config.get("resource_pool"),
                          source_vm=config["source_vm"],
                          dns_servers=tuple(config.get("dns_servers") or ()),
                          tls_fingerprint=config["tls_fingerprint"],
                          tls_cert_pem=config["tls_cert_pem"], password=secret)
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
    if kind == "digitalocean":
        from sirdar_api.deploy import do_accounts
        return await do_accounts.has_token(db, "production")
    row = await _row(db, kind)
    return row is not None and row.secret_enc is not None


async def load(db: AsyncSession, settings: Settings, kind: str) -> Config | None:
    """The stored settings with the decrypted secret; None when not set up.
    DigitalOcean falls back to SIRDAR_DEPLOY_DO_TOKEN (load_digitalocean)."""
    if kind == "digitalocean":
        return await load_digitalocean(db, settings)
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


async def load_esxi(db: AsyncSession, settings: Settings) -> EsxiConfig | None:
    return await load(db, settings, "esxi")


async def load_digitalocean(db: AsyncSession, settings: Settings) -> DigitalOceanConfig | None:
    """The Production account's token (do_accounts): the stored one, else
    SIRDAR_DEPLOY_DO_TOKEN; None when neither is set. A stored token that
    won't decrypt raises IntegrationError: it is never silently replaced by
    the environment's."""
    from sirdar_api.deploy import do_accounts
    account = await do_accounts.load(db, settings, "production")
    if account is None:
        return None
    return DigitalOceanConfig(token=account.token, source=account.source)


async def digitalocean_source(db: AsyncSession, settings: Settings) -> str | None:
    """Where the Production account's token comes from, without decrypting
    it: "stored", "environment" or None."""
    from sirdar_api.deploy import do_accounts
    row = await db.get(DoAccount, "production", populate_existing=True)
    return do_accounts.source_of(row, settings)


async def config_of(db: AsyncSession, kind: str) -> dict:
    """The stored non-secret settings (a copy), {} when none."""
    row = await _row(db, kind)
    return dict(row.config) if row else {}


async def in_use(db: AsyncSession, kind: str) -> list[str]:
    """Environments that can't lose this integration: those built on this
    VM host (their VMs could no longer be destroyed), and for DigitalOcean
    those built in the Production account."""
    if kind == "digitalocean":
        from sirdar_api.deploy import do_accounts
        return await do_accounts.in_use(db, "production")
    if kind not in VM_HOST_KINDS:
        return []
    return list(await db.scalars(select(Environment.name)
                                 .where(Environment.target_id == kind)
                                 .order_by(Environment.name)))


async def check_url_change(db: AsyncSession, kind: str, url: str) -> None:
    """A VM host's URL can't move while environments are built on it: their
    VMs would be looked for (and called gone) on another host.
    IntegrationError("integration_in_use", environments=[...])."""
    if kind not in VM_HOST_KINDS:
        return
    stored = (await config_of(db, kind)).get("url")
    if stored is None or stored == url:
        return
    users = await in_use(db, kind)
    if users:
        raise IntegrationError("integration_in_use", environments=users)


async def candidate(db: AsyncSession, settings: Settings, kind: str, values: dict,
                    secret: str | None) -> Config:
    """Unsaved values for a Test: the given secret, else the stored one."""
    if kind == "digitalocean":
        if secret is not None:
            return DigitalOceanConfig(token=check_secret(kind, secret))
        from sirdar_api.deploy import do_accounts
        if not await do_accounts.has_token(db, "production"):
            raise IntegrationError("secret_required")
        return await load_digitalocean(db, settings)
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
    one). Returns the names of what changed (the secret as token/password).
    DigitalOcean saves the Production account's token (do_accounts)."""
    if kind == "digitalocean":
        from sirdar_api.deploy import do_accounts
        row = await db.get(DoAccount, "production", populate_existing=True)
        if secret is None:
            if row.token_enc is None:
                raise IntegrationError("secret_required")
            return []
        return [c for c in await do_accounts.save(
            db, settings, "production", label=row.label, region=row.region, token=secret,
            actor_id=actor_id) if c == "token"]
    checked = check_fields(kind, values)
    if secret is not None:
        check_secret(kind, secret)
    if "url" in checked:
        await check_url_change(db, kind, checked["url"])
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
    if kind == "digitalocean":                     # the Production account's tokens
        from sirdar_api.deploy import do_accounts
        return await do_accounts.clear(db, "production")
    result = await db.execute(delete(Integration).where(Integration.kind == kind))
    return result.rowcount > 0


async def public(db: AsyncSession, settings: Settings) -> dict:
    """What the Settings page shows: settings and whether a secret is set."""
    out: dict = {"secrets_key_configured": vault.is_configured(settings)}
    for kind in KINDS:
        if kind == "digitalocean":                 # the Production account (do_accounts)
            account = await db.get(DoAccount, "production", populate_existing=True)
            by = await db.get(User, account.updated_by) if account.updated_by else None
            source = await digitalocean_source(db, settings)
            out[kind] = {"configured": source is not None,
                         "token_set": account.token_enc is not None, "source": source,
                         "updated_at": account.updated_at if account.token_enc else None,
                         "updated_by_name": by.display_name if by else None}
            continue
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
        if kind == "esxi":                         # a list even before it is set up
            out[kind]["dns_servers"] = list(config.get("dns_servers") or [])
    return out
