"""Settings › Integrations: the Cloudflare and Nginx Proxy Manager
credentials Sirdar publishes environments with, the DigitalOcean API token
(SIRDAR_DEPLOY_DO_TOKEN is the fallback when none is stored; the saved
settings' Test uses whichever applies), and the Proxmox API token
and ESXi password it builds VMs with (their TLS certificates are pinned
trust-on-first-use: save
and Test answer tls_untrusted until the request names the fingerprint the
user was shown). Secrets are write-only: no
response, log line or audit row carries one (audits list the names of the
fields that changed), and the request models put no constraint on them, so
no validation error can describe one."""

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from sirdar_api.api.deps import AuthContext, DbSession, client_ip, require_permission
from sirdar_api.config import get_settings
from sirdar_api.deploy import (
    ConnectFailed,
    cloudflare,
    digitalocean,
    esxi,
    integrations,
    npm,
    outbound,
    proxmox,
    tls_pin,
)
from sirdar_api.deploy.integrations import IntegrationError
from sirdar_api.services.audit import audit

log = logging.getLogger(__name__)

router = APIRouter(prefix="/deploy/integrations", tags=["deploy"])

Kind = Literal["cloudflare", "npm", "proxmox", "esxi", "digitalocean"]
TESTERS = {"cloudflare": cloudflare.test_connection, "npm": npm.test_connection,
           "proxmox": proxmox.test_connection, "esxi": esxi.test_connection,
           "digitalocean": digitalocean.test_integration}
# Where each VM host's certificate is fetched from (host, port).
SPLIT_URL = {"proxmox": proxmox.split_url, "esxi": esxi.split_url}
UNEXPECTED_REASON = "Sirdar couldn't reach it."
# Everything else is a 422 (tls_fingerprint_invalid among them); tls_untrusted
# only comes from integrations when the route's own pin check was bypassed.
_STATUS = {"secrets_key_missing": 400, "integration_unreadable": 409,
           "integration_in_use": 409, "tls_untrusted": 409, "tls_fingerprint_invalid": 422}
PROXMOX_FIELDS = ("url", "node", "pool", "storage", "bridge", "vlan_tag", "template_vmid",
                  "tls_fingerprint")
ESXI_FIELDS = ("url", "user", "datastore", "network", "resource_pool", "source_vm",
               "dns_servers", "tls_fingerprint")


class CloudflareIn(BaseModel):
    zone: str = Field(default=integrations.DEFAULT_ZONE, max_length=253)
    public_ip: str = Field(max_length=45)
    token: str | None = None


class NpmIn(BaseModel):
    url: str = Field(max_length=300)
    identity: str = Field(max_length=254)
    letsencrypt_email: str = Field(default="", max_length=254)
    password: str | None = None


class ProxmoxIn(BaseModel):
    url: str = Field(max_length=300)
    node: str = Field(max_length=63)
    pool: str = Field(max_length=40)
    storage: str = Field(max_length=63)
    bridge: str = Field(max_length=15)
    vlan_tag: int | None = None
    template_vmid: int
    # The fingerprint the user was shown and trusted (None: show it first).
    tls_fingerprint: str | None = Field(default=None, max_length=95)
    token: str | None = None


class EsxiIn(BaseModel):
    url: str = Field(max_length=300)
    user: str = Field(max_length=64)
    datastore: str = Field(max_length=80)
    network: str = Field(max_length=80)
    resource_pool: str | None = Field(default=None, max_length=80)
    source_vm: str = Field(max_length=80)
    dns_servers: list[str] = Field(default_factory=list, max_length=5)
    # The fingerprint the user was shown and trusted (None: show it first).
    tls_fingerprint: str | None = Field(default=None, max_length=95)
    password: str | None = None


class DigitalOceanIn(BaseModel):
    token: str | None = None


def _http(e: IntegrationError) -> HTTPException:
    return HTTPException(status_code=_STATUS.get(e.code, 422), detail={"code": e.code, **e.extra})


def _cloudflare_values(body: CloudflareIn) -> dict:
    return {"zone": body.zone, "public_ip": body.public_ip}


def _npm_values(body: NpmIn) -> dict:
    return {"url": body.url, "identity": body.identity,
            "letsencrypt_email": body.letsencrypt_email}


async def _pinned(db, kind: str, url: str, given: str | None) -> tuple[str, str]:
    """(fingerprint, certificate PEM) for a VM host's form. The stored pin is
    reused for the same URL and fingerprint; otherwise the live certificate is
    fetched and must have the fingerprint the request names (409 tls_untrusted
    shows it first, 409 tls_mismatch when it changed)."""
    wanted = None
    if (given or "").strip():
        try:
            wanted = tls_pin.normalize_fingerprint(given)
        except ValueError:
            raise _http(IntegrationError("tls_fingerprint_invalid")) from None
    stored = await integrations.config_of(db, kind)
    if (wanted and stored.get("url") == url and stored.get("tls_fingerprint") == wanted
            and stored.get("tls_cert_pem")):
        return wanted, stored["tls_cert_pem"]
    try:
        pem = await tls_pin.fetch_certificate(*SPLIT_URL[kind](url))
    except ConnectFailed as e:
        raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                     "reason": e.reason}) from None
    actual = tls_pin.fingerprint_of(pem)
    if not wanted:
        raise HTTPException(status_code=409, detail={"code": "tls_untrusted",
                                                     "fingerprint": actual,
                                                     **tls_pin.describe(pem)})
    if actual != wanted:
        raise HTTPException(status_code=409, detail={"code": "tls_mismatch",
                                                     "expected": wanted, "actual": actual})
    return wanted, pem


async def _proxmox_values(db, body: ProxmoxIn, *, saving: bool = False) -> dict:
    """The form's values plus the pinned certificate. Saving refuses a new
    URL while environments use the host (before any certificate fetch)."""
    try:
        url = integrations.check_proxmox_url(body.url)
        if saving:
            await integrations.check_url_change(db, "proxmox", url)
    except IntegrationError as e:
        raise _http(e) from None
    fingerprint, pem = await _pinned(db, "proxmox", url, body.tls_fingerprint)
    values = {name: getattr(body, name) for name in PROXMOX_FIELDS}
    return {**values, "url": url, "tls_fingerprint": fingerprint, "tls_cert_pem": pem}


async def _esxi_values(db, body: EsxiIn, *, saving: bool = False) -> dict:
    """The form's values plus the pinned certificate. Saving refuses a new
    URL while environments use the host (before any certificate fetch)."""
    try:
        url = integrations.check_esxi_url(body.url)
        if saving:
            await integrations.check_url_change(db, "esxi", url)
    except IntegrationError as e:
        raise _http(e) from None
    fingerprint, pem = await _pinned(db, "esxi", url, body.tls_fingerprint)
    values = {name: getattr(body, name) for name in ESXI_FIELDS}
    return {**values, "url": url, "tls_fingerprint": fingerprint, "tls_cert_pem": pem}


@router.get("")
async def read_integrations(db: DbSession,
                            actor: AuthContext = require_permission("deploy", "view")):
    return await integrations.public(db, get_settings())


async def _save(kind: str, values: dict, secret: str | None, request: Request, db,
                actor: AuthContext) -> dict:
    try:
        changed = await integrations.save(db, get_settings(), kind, values, secret,
                                          actor.user.person_id)
    except IntegrationError as e:
        await db.rollback()
        raise _http(e) from None
    if changed:
        audit(db, actor_id=actor.user.person_id, action="deploy.integration_update",
              entity_type="integration", entity_id=kind, ip=client_ip(request),
              changes={"kind": kind, "changed": changed})
        await db.commit()
    return await integrations.public(db, get_settings())


@router.put("/cloudflare")
async def save_cloudflare(body: CloudflareIn, request: Request, db: DbSession,
                          actor: AuthContext = require_permission("deploy", "change")):
    return await _save("cloudflare", _cloudflare_values(body), body.token, request, db, actor)


@router.put("/npm")
async def save_npm(body: NpmIn, request: Request, db: DbSession,
                   actor: AuthContext = require_permission("deploy", "change")):
    return await _save("npm", _npm_values(body), body.password, request, db, actor)


@router.put("/proxmox")
async def save_proxmox(body: ProxmoxIn, request: Request, db: DbSession,
                       actor: AuthContext = require_permission("deploy", "change")):
    return await _save("proxmox", await _proxmox_values(db, body, saving=True), body.token,
                       request, db, actor)


@router.put("/esxi")
async def save_esxi(body: EsxiIn, request: Request, db: DbSession,
                    actor: AuthContext = require_permission("deploy", "change")):
    return await _save("esxi", await _esxi_values(db, body, saving=True), body.password,
                       request, db, actor)


@router.put("/digitalocean")
async def save_digitalocean(body: DigitalOceanIn, request: Request, db: DbSession,
                            actor: AuthContext = require_permission("deploy", "change")):
    return await _save("digitalocean", {}, body.token, request, db, actor)


@router.delete("/{kind}", status_code=204)
async def remove_integration(kind: Kind, request: Request, db: DbSession,
                             actor: AuthContext = require_permission("deploy", "change")):
    users = await integrations.in_use(db, kind)
    if users:
        raise HTTPException(status_code=409, detail={"code": "integration_in_use",
                                                     "environments": users})
    if not await integrations.remove(db, kind):
        raise HTTPException(status_code=404, detail={"code": "integration_not_found"})
    audit(db, actor_id=actor.user.person_id, action="deploy.integration_remove",
          entity_type="integration", entity_id=kind, ip=client_ip(request),
          changes={"kind": kind})
    await db.commit()
    return Response(status_code=204)


async def _test(kind: str, values: dict | None, secret: str | None, request: Request, db,
                actor: AuthContext) -> dict:
    """The saved settings (no body), or unsaved values with the given secret
    or else the stored one. Read-only calls only."""
    settings = get_settings()
    try:
        cfg = (await integrations.load(db, settings, kind) if values is None
               else await integrations.candidate(db, settings, kind, values, secret))
    except IntegrationError as e:
        raise _http(e) from None
    if cfg is None:
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": [kind]})

    def record(ok: bool) -> None:
        audit(db, actor_id=actor.user.person_id, action="deploy.integration_test",
              entity_type="integration", entity_id=kind, ip=client_ip(request),
              changes={"kind": kind, "ok": ok})

    try:
        result = await TESTERS[kind](cfg, transport=outbound.transports().get(kind))
    except ConnectFailed as e:
        record(False)
        await db.commit()
        raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                     "reason": e.reason}) from None
    except Exception as e:
        # Only the type: the message may carry the secret or upstream text.
        log.warning("%s integration test failed unexpectedly: %s", kind, type(e).__name__)
        record(False)
        await db.commit()
        raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                     "reason": UNEXPECTED_REASON}) from None
    record(True)
    await db.commit()
    return result.as_dict()


@router.post("/cloudflare/test")
async def check_cloudflare(request: Request, db: DbSession, body: CloudflareIn | None = None,
                           actor: AuthContext = require_permission("deploy", "change")):
    return await _test("cloudflare", _cloudflare_values(body) if body else None,
                       body.token if body else None, request, db, actor)


@router.post("/npm/test")
async def check_npm(request: Request, db: DbSession, body: NpmIn | None = None,
                    actor: AuthContext = require_permission("deploy", "change")):
    return await _test("npm", _npm_values(body) if body else None,
                       body.password if body else None, request, db, actor)


@router.post("/proxmox/test")
async def check_proxmox(request: Request, db: DbSession, body: ProxmoxIn | None = None,
                        actor: AuthContext = require_permission("deploy", "change")):
    values = await _proxmox_values(db, body) if body else None
    return await _test("proxmox", values, body.token if body else None, request, db, actor)


@router.post("/esxi/test")
async def check_esxi(request: Request, db: DbSession, body: EsxiIn | None = None,
                     actor: AuthContext = require_permission("deploy", "change")):
    values = await _esxi_values(db, body) if body else None
    return await _test("esxi", values, body.password if body else None, request, db, actor)


@router.post("/digitalocean/test")
async def check_digitalocean(request: Request, db: DbSession,
                             body: DigitalOceanIn | None = None,
                             actor: AuthContext = require_permission("deploy", "change")):
    """No token: the token Sirdar uses (stored, else SIRDAR_DEPLOY_DO_TOKEN)."""
    token = body.token if body else None
    return await _test("digitalocean", None if token is None else {}, token, request, db, actor)
