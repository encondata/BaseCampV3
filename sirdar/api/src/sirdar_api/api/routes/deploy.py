"""Deploy page, step 1: targets, connection tests and trusted SSH host keys.
Responses never carry secrets; error reasons are our own copy."""

import asyncio
import os
import uuid
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from starlette.requests import ClientDisconnect

from sirdar_api.api.deps import AuthContext, DbSession, client_ip, require_permission
from sirdar_api.config import get_settings
from sirdar_api.db.models import (Deployment, DeploymentStep, DoAccount, DoEnvironment,
                                  Environment, EnvironmentFirstAdmin, EsxiVm, Snapshot,
                                  SshKnownHost)
from sirdar_api.deploy import (
    ConnectFailed,
    digitalocean,
    do_accounts,
    do_api,
    do_envs,
    envfile,
    environments,
    esxi,
    first_admins,
    gitref,
    integrations,
    known_hosts,
    lan_slots,
    names,
    outbound,
    pipeline,
    proxmox,
    publish,
    serialize,
    snapshots,
    ssh,
    targets,
    vault,
    vms,
)
from sirdar_api.deploy.ssh import SshTargetConfig
from sirdar_api.deploy.ssh_targets import SavedSshTarget, TargetError
from sirdar_api.deploy.steps import STEPS_BY_KEY, plan_for
from sirdar_api.services import portal_policy
from sirdar_api.services.audit import audit

router = APIRouter(prefix="/deploy", tags=["deploy"])

TARGET_ID_PATTERN = r"^(aws|gcp|digitalocean|ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*)$"
DeployType = Literal["blue", "green", "dev", "beta", "custom"]
DoAccountKey = Literal["production", "development"]


class ConnectIn(BaseModel):
    target: str = Field(pattern=TARGET_ID_PATTERN, max_length=36)
    type: DeployType
    region: str | None = Field(default=None, pattern=r"^[a-z0-9-]{2,20}$")
    name: str | None = None
    account: DoAccountKey | None = None         # the DigitalOcean account (default Production)


class TrustIn(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    fingerprint: str = Field(min_length=1, max_length=200)
    # Which SSH target asked; must connect to host:port. Default: the first that does.
    target: str | None = Field(default=None, pattern=TARGET_ID_PATTERN, max_length=36)


# Store validation (TargetError codes) answers 422, so no Field limits on the
# validated fields beyond a size cap. Secrets carry no pydantic constraint at
# all: the store checks their length (password_too_long / passphrase_too_long)
# so no constraint error can ever describe them. (The app-wide validation
# handler also drops "input" and "ctx" from every 422 item.)
class SshTargetIn(BaseModel):
    name: str = Field(max_length=200)
    host: str = Field(max_length=300)
    port: int = 22
    user: str = Field(max_length=200)
    password: str | None = None
    key_path: str | None = Field(default=None, max_length=255)
    key_passphrase: str | None = None
    sudo_password: str | None = None


class SshTargetPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    host: str | None = Field(default=None, max_length=300)
    port: int | None = None
    user: str | None = Field(default=None, max_length=200)
    password: str | None = None
    key_path: str | None = Field(default=None, max_length=255)
    key_passphrase: str | None = None
    sudo_password: str | None = None


class KnownHostOut(BaseModel):
    host: str
    port: int
    key_type: str
    fingerprint: str
    trusted_at: datetime
    trusted_by_name: str | None


def _known_host_out(row: SshKnownHost, trusted_by_name: str | None) -> KnownHostOut:
    return KnownHostOut(host=row.host, port=row.port, key_type=row.key_type,
                        fingerprint=row.fingerprint_sha256, trusted_at=row.trusted_at,
                        trusted_by_name=trusted_by_name)


@router.get("/targets")
async def list_targets(db: DbSession, actor: AuthContext = require_permission("deploy", "view")):
    s = get_settings()
    writable = targets.can_add_ssh(s)
    do_on = False
    for key in do_accounts.KEYS:                     # either account makes it usable
        row = await db.get(DoAccount, key, populate_existing=True)
        do_on = do_on or (row is not None and do_accounts.source_of(row, s) is not None)
    listed = targets.public_targets(
        s, proxmox_configured=await integrations.is_configured(db, "proxmox"),
        esxi_configured=await integrations.is_configured(db, "esxi"),
        digitalocean_configured=do_on)
    return {"targets": listed, "types": targets.DEPLOY_TYPES,
            "can_add_ssh": writable, "ssh_store_hint": None if writable else targets.STORE_HINT}


# ---- saved Custom (SSH) targets ---------------------------------------------

_UNWRITABLE = {"code": "targets_file_unwritable",
               "message": "Sirdar couldn't save deploy-targets.env. "
                          "Check that it's writable; see the README."}
_UNREADABLE = {"code": "targets_file_unreadable",
               "message": "Sirdar couldn't read deploy-targets.env. "
                          "Check that it's valid UTF-8; see the README."}
_NOT_FOUND = {"code": "target_not_found"}


def _audit_fields(t: SavedSshTarget) -> dict:
    """Non-secret fields only."""
    return {"name": t.name, "host": t.host, "port": t.port, "user": t.user,
            "key_path": t.key_path or None, "password_set": t.password is not None,
            "passphrase_set": t.passphrase is not None,
            "sudo_password_set": t.sudo_password is not None}


async def _store_call(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except KeyError:
        raise HTTPException(status_code=404, detail=_NOT_FOUND) from None
    except TargetError as e:
        raise HTTPException(status_code=422, detail={"code": e.code}) from None
    except UnicodeDecodeError:         # the file itself isn't UTF-8 (a ValueError)
        raise HTTPException(status_code=500, detail=_UNREADABLE) from None
    except ValueError:                 # control / line-separator character in a value
        raise HTTPException(status_code=422, detail={"code": "value_invalid"}) from None
    except OSError:
        raise HTTPException(status_code=500, detail=_UNWRITABLE) from None


@router.get("/ssh-targets/{slug}")
async def get_ssh_target(slug: str, actor: AuthContext = require_permission("deploy", "change")):
    t = await _store_call(targets.ssh_store(get_settings()).get, slug)
    if t is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return t.public()


@router.post("/ssh-targets", status_code=201)
async def add_ssh_target(body: SshTargetIn, request: Request, db: DbSession,
                         actor: AuthContext = require_permission("deploy", "change")):
    t = await _store_call(targets.ssh_store(get_settings()).add, body.model_dump())
    audit(db, actor_id=actor.user.person_id, action="deploy.target_add",
          entity_type="deploy_target", entity_id=t.id, ip=client_ip(request),
          changes=_audit_fields(t))
    await db.commit()
    return t.public()


_PATCH_ORDER = ("name", "host", "port", "user", "password", "key_path", "key_passphrase",
                "sudo_password")


@router.put("/ssh-targets/{slug}")
async def update_ssh_target(slug: str, body: SshTargetPatch, request: Request, db: DbSession,
                            actor: AuthContext = require_permission("deploy", "change")):
    store = targets.ssh_store(get_settings())
    fields = body.model_dump(exclude_unset=True)
    old, new = await _store_call(store.update, slug, fields)   # both read under the lock
    t = new
    current = {"name": (old.name, new.name), "host": (old.host, new.host),
               "port": (old.port, new.port), "user": (old.user, new.user),
               "password": (old.password, new.password),
               "key_path": (old.key_path, new.key_path),
               "key_passphrase": (old.passphrase, new.passphrase),
               "sudo_password": (old.sudo_password, new.sudo_password)}
    changed = [f for f in _PATCH_ORDER if current[f][0] != current[f][1]]
    audit(db, actor_id=actor.user.person_id, action="deploy.target_update",
          entity_type="deploy_target", entity_id=t.id, ip=client_ip(request),
          changes={"changed": changed, **_audit_fields(t)})
    await db.commit()
    return t.public()


@router.delete("/ssh-targets/{slug}", status_code=204)
async def remove_ssh_target(slug: str, request: Request, db: DbSession,
                            actor: AuthContext = require_permission("deploy", "change")):
    t = await _store_call(targets.ssh_store(get_settings()).remove, slug)
    audit(db, actor_id=actor.user.person_id, action="deploy.target_remove",
          entity_type="deploy_target", entity_id=t.id, ip=client_ip(request),
          changes=_audit_fields(t))
    await db.commit()
    return Response(status_code=204)


def _key_file_names(folder: str) -> list[str]:
    try:
        with os.scandir(folder) as it:
            return sorted(e.name for e in it
                          if not e.name.startswith(".") and e.is_file(follow_symlinks=False))
    except OSError:
        return []


@router.get("/key-files")
async def list_key_files(actor: AuthContext = require_permission("deploy", "change")):
    return {"files": await asyncio.to_thread(_key_file_names, get_settings().deploy_keys_dir)}


async def _digitalocean_settings(db, account: str = "production") -> tuple:
    """(settings carrying that DigitalOcean account's token, None) or (None,
    IntegrationError) when its stored token can't be read."""
    try:
        return await digitalocean.resolve(db, get_settings(), account), None
    except integrations.IntegrationError as e:
        return None, e


def _unreadable(e: integrations.IntegrationError) -> HTTPException:
    return HTTPException(status_code=409 if e.code == "integration_unreadable" else 400,
                         detail={"code": e.code, **e.extra})


@router.get("/digitalocean/regions")
async def digitalocean_regions(db: DbSession,
                               account: DoAccountKey = Query(default="production"),
                               actor: AuthContext = require_permission("deploy", "view")):
    settings, problem = await _digitalocean_settings(db, account)
    if problem is not None:
        raise _unreadable(problem)
    if not targets.is_configured("digitalocean", settings):
        raise HTTPException(status_code=400, detail={"code": "target_not_configured"})
    try:
        return await digitalocean.list_regions(
            settings, transport=outbound.transports().get("digitalocean"))
    except ConnectFailed as e:
        raise HTTPException(status_code=502,
                            detail={"code": "connect_failed", "reason": e.reason}) from None


@router.post("/connect")
async def connect(body: ConnectIn, request: Request, db: DbSession,
                  actor: AuthContext = require_permission("deploy", "add")):
    settings = get_settings()
    name: str | None = None
    if body.type == "custom":
        name = (body.name or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail={"code": "custom_name_required"})
        if not names.is_valid_custom_name(name):
            raise HTTPException(status_code=422, detail={"code": "custom_name_invalid"})
        if names.is_reserved_name(name):
            raise HTTPException(status_code=422, detail={"code": "custom_name_reserved"})

    async def record(ok: bool, code: str | None = None) -> None:
        changes: dict = {"target": body.target, "type": body.type, "ok": ok}
        if name:
            changes["name"] = name
        if body.region:
            changes["region"] = body.region
        if body.account and body.target == "digitalocean":
            changes["account"] = body.account
        if code:
            changes["code"] = code
        audit(db, actor_id=actor.user.person_id, action="deploy.connect",
              entity_type="deploy_target", entity_id=body.target, ip=client_ip(request),
              changes=changes)
        await db.commit()

    async def fail(status: int, code: str, **extra) -> HTTPException:
        await record(False, code)
        return HTTPException(status_code=status, detail={"code": code, **extra})

    ssh_config = None
    if body.target == "digitalocean":
        resolved, problem = await _digitalocean_settings(db, body.account or "production")
        if problem is not None:
            await record(False, problem.code)
            raise _unreadable(problem)
        settings = resolved
    if body.target == "ssh" or body.target.startswith("ssh:"):
        ssh_config = targets.ssh_config_for(body.target, settings)
        if ssh_config is None:
            raise await fail(400, "target_not_configured")
    else:
        target = targets.get_target(body.target)
        if target is None or not target.available:
            raise await fail(400, "target_unavailable")
        if not targets.is_configured(body.target, settings):
            raise await fail(400, "target_not_configured")

    try:
        if ssh_config is None:
            result = await digitalocean.test_connection(
                settings, region=body.region, transport=outbound.transports().get("digitalocean"))
        else:
            result = await ssh.test_connection(ssh_config, db, target_id=body.target)
    except ssh.HostKeyUnknown as e:
        raise await fail(409, "host_key_unknown", host=e.host, port=e.port,
                         key_type=e.key_type, fingerprint=e.fingerprint) from None
    except ssh.HostKeyMismatch as e:
        raise await fail(409, "host_key_mismatch", host=e.host, port=e.port,
                         key_type=e.key_type, expected=e.expected, actual=e.actual) from None
    except ConnectFailed as e:
        raise await fail(502, "connect_failed", reason=e.reason) from None
    except Exception:
        await record(False, "error")
        raise

    await record(result.ok)
    return {"ok": result.ok, "target": result.target, "type": body.type,
            "name": name, "checks": result.as_dict()["checks"], "facts": result.facts}


@router.get("/known-hosts", response_model=list[KnownHostOut])
async def list_known_hosts(db: DbSession,
                           actor: AuthContext = require_permission("deploy", "view")):
    return [_known_host_out(row, name) for row, name in await known_hosts.list_hosts(db)]


@router.post("/known-hosts", response_model=KnownHostOut)
async def trust_host(body: TrustIn, request: Request, db: DbSession,
                     actor: AuthContext = require_permission("deploy", "change")):
    matches = await asyncio.to_thread(targets.ssh_targets_at, body.host, body.port,
                                      get_settings())
    if not matches or (body.target is not None and body.target not in matches):
        raise HTTPException(status_code=400, detail={"code": "not_configured_host"})
    try:
        row = await known_hosts.trust(db, body.host, body.port, body.fingerprint,
                                      actor.user.person_id, ip=client_ip(request),
                                      target_id=body.target or matches[0])
    except known_hosts.HostKeyChanged as e:
        raise HTTPException(status_code=409, detail={
            "code": "host_key_changed", "host": e.host, "port": e.port,
            "key_type": e.key_type, "expected": e.expected, "actual": e.actual}) from None
    except ConnectFailed as e:
        raise HTTPException(status_code=502,
                            detail={"code": "connect_failed", "reason": e.reason}) from None
    await db.commit()
    return _known_host_out(row, actor.user.display_name)


@router.delete("/known-hosts", status_code=204)
async def forget_host(request: Request, db: DbSession,
                      host: str = Query(min_length=1, max_length=255),
                      port: int = Query(ge=1, le=65535),
                      actor: AuthContext = require_permission("deploy", "change")):
    # Forgetting is allowed for any stored host, so keys left behind by a
    # removed or edited target can still be dropped; the audit names the
    # target when one still points here.
    matches = await asyncio.to_thread(targets.ssh_targets_at, host, port, get_settings())
    if not await known_hosts.forget(db, host, port, actor.user.person_id, ip=client_ip(request),
                                    target_id=matches[0] if matches else None):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    await db.commit()
    return Response(status_code=204)


# ---- environments (deploy pipeline) -------------------------------------------

# An environment's target: an SSH target, or a VM host Sirdar builds on.
ENV_TARGET_PATTERN = r"^(ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*|proxmox|esxi|digitalocean)$"
EnvType = Literal["dev", "beta", "custom", "production"]
_SSH_ERRORS = (ssh.HostKeyUnknown, ssh.HostKeyMismatch, ConnectFailed)
_ENV_STATUS = {"environment_exists": 409, "deploy_in_progress": 409,
               "secrets_key_missing": 400, "target_not_configured": 400,
               "snapshot_not_found": 404, "snapshot_not_ready": 409,
               "integration_not_configured": 409, "ip_in_use": 409,
               "ssh_targets_unreadable": 409, "vm_invalid": 422,
               "do_account_not_configured": 409, "production_exists": 409,
               "integration_unreadable": 409, "first_admin_not_set": 404,
               "first_admin_done": 409, "vm_name_taken": 409,
               "vm_resize_not_supported": 409}
_NAME_CONSTRAINT = "environments_name_key"
_PRODUCTION_CONSTRAINT = "environments_one_production"


class VmSizeIn(BaseModel):
    cores: int | None = None
    memory_mb: int | None = None
    disk_gb: int | None = None


class VmIn(BaseModel):
    """A VM environment's VM (mode "new", target "proxmox" or "esxi"). With
    slots 2 it is LAN Blue/Green: `ip_cidr` is orange's, plus purple's and
    the data VM's (static, one gateway); `data` sizes the data VM."""
    cores: int | None = None
    memory_mb: int | None = None
    disk_gb: int | None = None
    ip_mode: str = Field(max_length=10)
    ip_cidr: str | None = Field(default=None, max_length=50)
    gateway: str | None = Field(default=None, max_length=45)
    slots: int | None = None
    purple_ip_cidr: str | None = Field(default=None, max_length=50)
    data_ip_cidr: str | None = Field(default=None, max_length=50)
    data: VmSizeIn | None = None
    # Non-production Blue/Green only: an Update to the idle slot goes live by itself.
    auto_activate: bool | None = None


class VmPatch(BaseModel):
    """PATCH's `vm`: sizes (applied by the next deploy's step 0) and how many
    VM snapshots to keep."""
    cores: int | None = None
    memory_mb: int | None = None
    disk_gb: int | None = None
    keep_snapshots: int | None = None


class DoIn(BaseModel):
    """A DigitalOcean environment (mode "new", target "digitalocean")."""
    account: Literal["production", "development"] | None = None
    slots: int | None = None
    droplet_size: str | None = Field(default=None, max_length=40)
    db_size: str | None = Field(default=None, max_length=40)
    db_standby: bool | None = None
    acme_staging: bool | None = None
    # Non-production only: an Update to the idle slot goes live by itself.
    auto_activate: bool | None = None


class FirstAdminIn(BaseModel):
    """The first super admin of an environment that starts empty. The
    password is write-only (typed mode); an invite has none. No min_length:
    the bar is ServerSherpa's, checked by first_admins.check with its own
    code; 1024 is the transport limit of every Sirdar password field."""
    first_name: str = Field(max_length=100)
    last_name: str = Field(max_length=100)
    email: str = Field(max_length=254)
    password_mode: Literal["typed", "invite"]
    password: str | None = Field(default=None, max_length=1024, repr=False)


class EnvironmentIn(BaseModel):
    mode: Literal["new", "adopt"]
    name: str = Field(max_length=64)
    type: EnvType
    target: str = Field(pattern=ENV_TARGET_PATTERN, max_length=36)
    git_ref: str = Field(default="main", max_length=200)
    # mode "new" only; adopt reads these from the target's .env
    base_domain: str | None = Field(default=None, max_length=253)
    proxy_ip: str | None = Field(default=None, max_length=45)
    bind_ip: str = Field(default="0.0.0.0", max_length=45)
    ports: dict[str, int] = Field(default_factory=dict)
    # mode "new" only: the first deploy restores this snapshot
    snapshot_id: uuid.UUID | None = None
    # mode "new" only (default on): deploys publish DNS records and proxy hosts
    publish: bool | None = None
    # mode "new" with a VM target only: the VM step 0 builds
    vm: VmIn | None = None
    # mode "new" with target "digitalocean" only: account, slots and sizes
    do: DoIn | None = None
    # mode "new" only, without snapshot_id: the first deploy's step 11 creates it
    first_admin: FirstAdminIn | None = None


class ServicePatch(BaseModel):
    port: int | None = None
    host_ip: str | None = Field(default=None, max_length=45)
    proxied: bool | None = None


class DoPatch(BaseModel):
    """PATCH's `do`: sizes only grow; step 0 applies them on the next deploy."""
    droplet_size: str | None = Field(default=None, max_length=40)
    db_size: str | None = Field(default=None, max_length=40)
    db_standby: bool | None = None


class EnvironmentPatch(BaseModel):
    git_ref: str | None = Field(default=None, max_length=200)
    target: str | None = Field(default=None, pattern=ENV_TARGET_PATTERN, max_length=36)
    base_domain: str | None = Field(default=None, max_length=253)
    proxy_ip: str | None = Field(default=None, max_length=45)
    bind_ip: str | None = Field(default=None, max_length=45)
    keep_dumps: int | None = None
    spaces_bucket: str | None = Field(default=None, max_length=63)
    log_level: str | None = Field(default=None, max_length=10)
    services: dict[str, ServicePatch] | None = None
    publish: bool | None = None
    vm: VmPatch | None = None
    # Production only: lets Delete remove it and a new production be created.
    # Needs confirm_name (the environment's name).
    retiring: bool | None = None
    confirm_name: str | None = Field(default=None, max_length=64)
    # Non-production DigitalOcean only: an Update to the idle slot goes live by itself.
    auto_activate: bool | None = None
    # DigitalOcean only: grow the droplet and database sizes.
    do: DoPatch | None = None
    # Write-only. No pydantic constraint on the values, so no validation error
    # can describe one; the service answers secret_invalid / secret_not_editable.
    secrets: dict[str, str] | None = None


def _env_http(e: environments.EnvError) -> HTTPException:
    return HTTPException(status_code=_ENV_STATUS.get(e.code, 422),
                         detail={"code": e.code, **e.extra})


def _ssh_http(e: Exception) -> HTTPException:
    """Host-key and connection failures, in /connect's shapes."""
    if isinstance(e, ssh.HostKeyUnknown):
        return HTTPException(status_code=409, detail={
            "code": "host_key_unknown", "host": e.host, "port": e.port,
            "key_type": e.key_type, "fingerprint": e.fingerprint})
    if isinstance(e, ssh.HostKeyMismatch):
        return HTTPException(status_code=409, detail={
            "code": "host_key_mismatch", "host": e.host, "port": e.port,
            "key_type": e.key_type, "expected": e.expected, "actual": e.actual})
    return HTTPException(status_code=502, detail={"code": "connect_failed", "reason": e.reason})


async def _environment(db, name: str) -> Environment:
    env = await environments.get_by_name(db, name)
    if env is None:
        raise HTTPException(status_code=404, detail={"code": "environment_not_found"})
    return env


@router.get("/environment-defaults")
async def environment_defaults(actor: AuthContext = require_permission("deploy", "view")):
    """What the New environment form prefills: the same values create_new uses."""
    return {
        "services": [{"service": s, "port": envfile.DEFAULT_PORTS[s],
                      "public": s in envfile.PUBLIC_SERVICES} for s in envfile.SERVICES],
        "domain_suffix": environments.DEFAULT_DOMAIN_SUFFIX, "env_root": envfile.ENV_ROOT,
        "git_ref": environments.DEFAULT_GIT_REF, "bind_ip": environments.DEFAULT_BIND_IP,
        "keep_dumps": envfile.DEFAULT_KEEP_DUMPS, "spaces_bucket": envfile.DEFAULT_SPACES_BUCKET,
        "log_levels": list(envfile.LOG_LEVELS),
        "optional_secrets": list(envfile.OPTIONAL_SECRETS),
        "vm": {**vms.DEFAULTS, "keep_snapshots": vms.KEEP_SNAPSHOTS,
               "limits": {k: list(v) for k, v in vms.LIMITS.items()}},
        "do": {"droplet_size": do_envs.DEFAULT_DROPLET_SIZE, "db_size": do_envs.DEFAULT_DB_SIZE,
               "db_standby": False, "production_slots": list(do_envs.PRODUCTION_SLOTS),
               "one_slot": list(do_envs.ONE_SLOT), "two_slots": list(do_envs.TWO_SLOTS)},
        "first_admin": {"password_min_length": portal_policy.PASSWORD_MIN_LENGTH,
                        "role": portal_policy.FIRST_ADMIN_ROLE,
                        "link_minutes": portal_policy.FIRST_ADMIN_LINK_MINUTES},
    }


@router.get("/environments")
async def list_environments(db: DbSession,
                            actor: AuthContext = require_permission("deploy", "view")):
    return {"environments": [await serialize.environment_out(db, env)
                             for env in await environments.list_all(db)]}


@router.get("/environments/{name}")
async def get_environment(name: str, db: DbSession,
                          actor: AuthContext = require_permission("deploy", "view")):
    return await serialize.environment_out(db, await _environment(db, name))


@router.post("/environments", status_code=201)
async def create_environment(body: EnvironmentIn, request: Request, db: DbSession,
                             actor: AuthContext = require_permission("deploy", "add")):
    settings = get_settings()
    actor_id = actor.user.person_id
    report = None
    if body.mode == "adopt" and body.snapshot_id is not None:
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
    if body.mode == "adopt" and body.vm is not None:
        raise HTTPException(status_code=422, detail={"code": "vm_not_allowed"})
    if body.mode == "adopt" and body.do is not None:
        raise HTTPException(status_code=422, detail={"code": "do_not_allowed"})
    if body.mode == "adopt" and body.first_admin is not None:
        raise HTTPException(status_code=422, detail={"code": "first_admin_not_allowed"})
    if body.mode == "adopt" and body.publish:
        # A hand-built environment's DNS and proxy were made by hand: turn
        # Publish on after claiming them on the Publish tab.
        raise HTTPException(status_code=422, detail={"code": "publish_not_allowed"})
    try:
        if body.mode == "new":
            env = await environments.create_new(
                db, settings, name=body.name, type_=body.type, target_id=body.target,
                git_ref=body.git_ref, base_domain=body.base_domain, proxy_ip=body.proxy_ip,
                bind_ip=body.bind_ip, ports=body.ports, actor_id=actor_id,
                snapshot_id=body.snapshot_id, publish=body.publish is not False,
                vm=body.vm.model_dump(exclude_none=True) if body.vm else None,
                do=body.do.model_dump(exclude_none=True) if body.do else None,
                first_admin=body.first_admin.model_dump() if body.first_admin else None)
        else:
            env, _, report = await environments.adopt(
                db, settings, name=body.name, type_=body.type, target_id=body.target,
                git_ref=body.git_ref, actor_id=actor_id)
    except environments.EnvError as e:
        await db.rollback()
        raise _env_http(e) from None
    except _SSH_ERRORS as e:
        await db.rollback()
        raise _ssh_http(e) from None
    except IntegrityError as e:
        # Two requests for one name both passed the exists check; the unique
        # constraint settled it.
        await db.rollback()
        if _NAME_CONSTRAINT in str(e.orig):
            raise HTTPException(status_code=409,
                                detail={"code": "environment_exists"}) from None
        if _PRODUCTION_CONSTRAINT in str(e.orig):
            # Lost a race the advisory lock didn't cover: another live production.
            raise HTTPException(status_code=409,
                                detail={"code": "production_exists"}) from None
        raise
    if report is None:
        changes = {"name": env.name, "type": env.type, "target": env.target_id,
                   "base_domain": env.base_domain, "git_ref": env.git_ref,
                   "proxy_ip": env.proxy_ip, "bind_ip": env.bind_ip, "publish": env.publish}
        seed = await snapshots.snapshot_ref(db, env.seed_snapshot_id)
        if seed is not None:
            changes["seed_snapshot"] = seed["name"]
        if body.vm is not None:
            changes["vm"] = body.vm.model_dump(exclude_none=True)
        if body.do is not None:
            changes["do"] = body.do.model_dump(exclude_none=True)
        if body.first_admin is not None:          # never the password
            changes["first_admin"] = {"email": body.first_admin.email.strip(),
                                      "password_mode": body.first_admin.password_mode}
        audit(db, actor_id=actor_id, action="deploy.environment_create",
              entity_type="environment", entity_id=env.name, ip=client_ip(request),
              changes=changes)
    else:
        audit(db, actor_id=actor_id, action="deploy.environment_adopt",
              entity_type="environment", entity_id=env.name, ip=client_ip(request),
              changes={"name": env.name, "type": env.type, "target": env.target_id,
                       "sha": report.sha, "image_tag": env.image_tag,
                       "imported_secrets": report.imported_secrets,
                       "ignored_keys": report.ignored_keys})
    await db.commit()
    await db.refresh(env)
    out = await serialize.environment_out(db, env)
    if report is not None:
        # Names only: what adopt read from the target's .env.
        out["ignored_keys"] = report.ignored_keys
        out["imported_secrets"] = sorted(report.imported_secrets)
    return out


async def _checked_sizes(db, env: Environment, wanted: dict) -> dict:
    """PATCH `do`, checked against DigitalOcean's catalogs (sizes only grow)."""
    if not _on_do(env):
        raise _refuse(422, "do_not_allowed")
    # Locked until the PATCH commits: check and apply are one step, so a
    # concurrent PATCH checks against what this one stores.
    row = await db.get(DoEnvironment, env.id, with_for_update=True, populate_existing=True)
    if row is None:
        raise _refuse(409, "do_not_ready")
    try:
        account = await do_accounts.require(db, get_settings(), row.account_key)
    except integrations.IntegrationError as e:
        status = 409 if e.code in ("do_account_not_configured", "integration_unreadable") else 400
        raise HTTPException(status_code=status, detail={"code": e.code, **e.extra}) from None
    try:
        async with do_api.connect(account.token) as api:
            return await do_envs.check_grow(api, row, wanted)
    except do_envs.DoEnvError as e:
        raise _refuse(422, e.code) from None
    except do_api.DoError as e:
        raise _refuse(502, "connect_failed", reason=e.reason) from None


@router.patch("/environments/{name}")
async def update_environment(name: str, body: EnvironmentPatch, request: Request,
                             db: DbSession,
                             actor: AuthContext = require_permission("deploy", "change")):
    env = await _environment(db, name)
    if body.retiring is not None and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    fields = body.model_dump(exclude_unset=True)
    fields.pop("confirm_name", None)
    wanted = fields.pop("do", None)
    if wanted is not None:
        fields["do_checked"] = await _checked_sizes(
            db, env, {k: v for k, v in wanted.items() if v is not None})
    try:
        changed = await environments.update(db, get_settings(), env, fields)
        if changed:
            audit(db, actor_id=actor.user.person_id, action="deploy.environment_update",
                  entity_type="environment", entity_id=env.name, ip=client_ip(request),
                  changes={"changed": changed})
            await db.commit()
    except environments.EnvError as e:
        # update() edits the rows before every check has run: undo the lot.
        await db.rollback()
        raise _env_http(e) from None
    except IntegrityError as e:
        await db.rollback()
        if _PRODUCTION_CONSTRAINT in str(e.orig):
            # Un-retiring lost a race: another production is live.
            raise HTTPException(status_code=409,
                                detail={"code": "production_exists"}) from None
        raise
    if changed:
        await db.refresh(env)
    return await serialize.environment_out(db, env)


@router.put("/environments/{name}/first-admin")
async def set_first_admin(name: str, body: FirstAdminIn, request: Request, db: DbSession,
                          actor: AuthContext = require_permission("deploy", "change")):
    """Change the first admin before step 11 used it: a new password (the
    environment refused the last one) or an invite instead."""
    env = await _environment(db, name)
    # Locked until this request commits, and the running-deployment check is
    # made under the lock: step 11 marks the record done in its own commit,
    # so a PUT can't land between it reading the record and marking it.
    row = await db.get(EnvironmentFirstAdmin, env.id, with_for_update=True,
                       populate_existing=True)
    if row is None:
        raise _refuse(404, "first_admin_not_set")
    if row.done_at is not None:
        raise _refuse(409, "first_admin_done")
    if await environments.is_deploying(db, env.id):    # step 11 may be using it
        raise _refuse(409, "deploy_in_progress")
    settings = get_settings()
    if not vault.is_configured(settings):
        raise _refuse(400, "secrets_key_missing")
    try:
        spec = first_admins.check(body.model_dump())
        await first_admins.put(db, settings, env.id, spec)
    except first_admins.FirstAdminError as e:     # first_admin_done: step 11 got there first
        await db.rollback()
        raise _refuse(_ENV_STATUS.get(e.code, 422), e.code, **e.extra) from None
    audit(db, actor_id=actor.user.person_id, action="deploy.first_admin_set",
          entity_type="environment", entity_id=env.name, ip=client_ip(request),
          changes={"environment": env.name, "email": spec["email"],
                   "password_mode": spec["password_mode"]})
    await db.commit()
    await db.refresh(env)
    return await serialize.environment_out(db, env)


# ---- deployments (deploy pipeline) ---------------------------------------------

_REF_STATUS = {"ref_invalid": 422, "ref_not_found": 422, "git_missing": 502,
               "ref_lookup_failed": 502}
_REF_REASON = {
    "git_missing": "git isn't installed on the target. Install it "
                   "(sudo apt-get install git) and try again.",
    "ref_lookup_failed": "The target couldn't list the repository's branches and tags.",
}


class DeploymentIn(BaseModel):
    # publish: steps 12–14 for the running commit; teardown: Delete environment;
    # vm_restore: a VM environment's VM back to one of its VM snapshots
    mode: Literal["update", "reset", "restore_dump", "publish", "teardown",
                  "vm_restore"] = "update"
    # VM environments, update / reset / restore_dump: take a VM snapshot in step 0
    # (default: yes once deployed).
    take_vm_snapshot: bool | None = None
    # vm_restore only: the VM snapshot (a name from GET .../vm-snapshots).
    vm_snapshot: str | None = Field(default=None, max_length=40)
    git_ref: str | None = Field(default=None, max_length=200)
    # Reset and Restore backup: must equal the environment's name exactly.
    confirm_name: str | None = Field(default=None, max_length=64)
    # Reset only: restore this snapshot after the reset.
    snapshot_id: uuid.UUID | None = None
    # Restore backup only: a file name from GET /environments/{name}/backups.
    backup: str | None = Field(default=None, max_length=64)
    # DigitalOcean Delete: save a snapshot first (default yes; production always).
    snapshot: bool | None = None
    # DigitalOcean production Delete: "delete production <name>", typed.
    confirm_production: str | None = Field(default=None, max_length=100)


class RetryIn(BaseModel):
    from_step: int | None = Field(default=None, ge=0, le=99)
    confirm_name: str | None = Field(default=None, max_length=64)
    # A DigitalOcean production Delete: "delete production <name>", typed again.
    confirm_production: str | None = Field(default=None, max_length=100)


class RollbackIn(BaseModel):
    confirm_name: str | None = Field(default=None, max_length=64)
    take_vm_snapshot: bool | None = None


# Modes that replace data: deploy:change and the environment's name typed back.
GATED_MODES = ("reset", "restore_dump", "rollback", "teardown", "vm_restore")
# Modes that need deploy:change (production's Activate also needs its name typed).
CHANGE_MODES = (*GATED_MODES, "activate")
RETRY_MODES = ("update", "reset", "restore_dump", "rollback", "publish", "teardown",
               "vm_restore", "activate", "renew")
# Modes a deploy request may ask a VM snapshot for (rollback has its own route).
VM_SNAPSHOT_MODES = ("update", "reset", "restore_dump")


def _forbidden() -> HTTPException:
    return HTTPException(status_code=403, detail={"code": "forbidden"})


def _require_mode(actor: AuthContext, mode: str) -> None:
    """Update needs deploy:add (the route's guard); the modes that replace
    data, and Activate, also need change."""
    if mode in CHANGE_MODES and not actor.access.can("deploy", "change"):
        raise _forbidden()


def _snapshot_http(e: snapshots.SnapshotError) -> HTTPException:
    status = {"snapshot_not_found": 404, "snapshot_not_ready": 409, "snapshot_exists": 409,
              "snapshot_in_use": 409, "not_deployed": 409, "secrets_key_missing": 400,
              "snapshot_too_large": 413, "snapshots_dir_unwritable": 500}.get(e.code, 422)
    return HTTPException(status_code=status, detail={"code": e.code, **e.extra})


async def _host_target(db, env: Environment, *, need_secrets: bool = True,
                       slot: str | None = None) -> SshTargetConfig | None:
    """The SSH connection the host steps use. None only for a built target
    (a VM, or a DigitalOcean slot's droplet) with no address yet (step 0
    builds it). `slot`: a DigitalOcean slot (default: the active one)."""
    settings = get_settings()
    if need_secrets and not vault.is_configured(settings):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    try:
        cfg = await vms.host_config(db, settings, env, slot=slot)
    except (vault.SecretsKeyMissing, vault.SecretUnreadable):
        raise HTTPException(status_code=409, detail={"code": "vm_key_unreadable"}) from None
    if cfg is None and not targets.is_built_target(env.target_id):
        raise HTTPException(status_code=400, detail={"code": "target_not_configured"})
    return cfg


def _on_vm(env: Environment) -> bool:
    return targets.is_vm_target(env.target_id)


def _on_do(env: Environment) -> bool:
    return env.target_id == targets.DO_TARGET


def _snapshot_slot_unreachable(env: Environment) -> HTTPException:
    """A Delete's snapshot would be taken on a droplet with no address.
    `production`: it can't go without the snapshot (the copy differs)."""
    detail: dict = {"code": "snapshot_slot_unreachable"}
    if env.type == "production":
        detail["production"] = True
    return HTTPException(status_code=409, detail=detail)


def _not_on_do() -> HTTPException:
    return HTTPException(status_code=409,
                         detail={"code": pipeline.NotSupportedOnDigitalOcean.code})


def _on_bg(env: Environment) -> bool:
    """A LAN Blue/Green environment (two app VMs and a data VM)."""
    return lan_slots.is_bluegreen(env)


def _not_on_bg() -> HTTPException:
    return HTTPException(status_code=409,
                         detail={"code": pipeline.NotSupportedOnBlueGreen.code})


async def _require_npm(db) -> None:
    """Nginx Proxy Manager is a Blue/Green environment's switch, Publish on or off."""
    if not await integrations.is_configured(db, "npm"):
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": ["npm"]})


async def _require_vm_host(db, env: Environment) -> None:
    if _on_vm(env) and not await integrations.is_configured(db, env.target_id):
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": [env.target_id]})


def _take_vm_snapshot(env: Environment, asked: bool | None) -> bool:
    """A deployed VM environment takes a VM snapshot in step 0 unless
    asked not to; a VM that never ran a deploy has nothing to keep."""
    return _on_vm(env) and env.current_sha is not None and asked is not False


async def _deployment(db, deployment_id: uuid.UUID) -> Deployment:
    dep = await db.get(Deployment, deployment_id)
    if dep is None:
        raise HTTPException(status_code=404, detail={"code": "deployment_not_found"})
    return dep


async def _stopped_step(db, deployment_id: uuid.UUID) -> int | None:
    """Where a deployment stopped: its failed, cancelled or interrupted step, else
    (cancelled or interrupted before any step ran) its first step that didn't run.
    Cancelled and interrupted deployments carry no failed_step, so the step rows
    are the record."""
    rows = list(await db.execute(
        select(DeploymentStep.number, DeploymentStep.status)
        .where(DeploymentStep.deployment_id == deployment_id)
        .order_by(DeploymentStep.number)))
    for number, status in rows:
        if status in pipeline.RETRYABLE_STATUSES:
            return number
    return next((number for number, status in rows if status == "not_run"), None)


async def _has_step(db, deployment_id: uuid.UUID, key: str) -> bool:
    found = await db.scalar(select(DeploymentStep.number).where(
        DeploymentStep.deployment_id == deployment_id, DeploymentStep.key == key).limit(1))
    return found is not None


async def _launch(db, env: Environment, request: Request, actor: AuthContext, *, action: str,
                  mode: str, git_ref: str, sha: str, start_step: int | None = None,
                  retry_of: uuid.UUID | None = None, snapshot: Snapshot | None = None,
                  restore_dump: str | None = None, publish: bool = False, vm: bool = False,
                  take_vm_snapshot: bool = False, vm_snapshot: str | None = None,
                  cloud: bool = False, slot: str | None = None, go_live: bool = False,
                  first_admin: bool = False, bluegreen: bool = False) -> dict:
    env_name = env.name           # read now: a lock conflict rolls the session back
    snapshot_id = snapshot.id if snapshot is not None else None
    snapshot_name = snapshot.name if snapshot is not None else None
    try:
        dep = await pipeline.create_deployment(db, env, mode=mode, git_ref=git_ref, sha=sha,
                                               actor_id=actor.user.person_id,
                                               start_step=start_step, retry_of=retry_of,
                                               snapshot_id=snapshot_id,
                                               restore_dump=restore_dump, publish=publish,
                                               vm=vm, take_vm_snapshot=take_vm_snapshot,
                                               vm_snapshot=vm_snapshot, cloud=cloud,
                                               slot=slot, go_live=go_live,
                                               first_admin=first_admin, bluegreen=bluegreen)
    except pipeline.DeployInProgress:
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"}) from None
    except (pipeline.NotSupportedOnDigitalOcean, pipeline.NotSupportedOnBlueGreen) as e:
        raise HTTPException(status_code=409, detail={"code": e.code}) from None
    except do_envs.DoEnvError as e:      # slot_not_deployed {slot}, seed_not_allowed
        await db.rollback()
        raise HTTPException(status_code=409, detail={"code": e.code, **e.extra}) from None
    except snapshots.SnapshotError as e:
        # The locked re-check: the snapshot went (or stopped being ready, or a
        # pending one isn't pending any more) since this request looked at it.
        await db.rollback()
        raise _snapshot_http(e) from None
    except ValueError:            # start_step isn't a step of this mode's plan
        raise HTTPException(status_code=422, detail={"code": "invalid_start_step"}) from None
    changes: dict = {"environment": env_name, "mode": mode, "git_ref": git_ref, "sha": sha}
    if retry_of is not None:
        changes |= {"retry_of": str(retry_of), "from_step": start_step}
    if snapshot_name is not None:
        changes["snapshot"] = snapshot_name
    if restore_dump is not None:
        changes["backup"] = restore_dump
    if publish:
        changes["publish"] = True
    if take_vm_snapshot:
        changes["take_vm_snapshot"] = True
    if vm_snapshot is not None:
        changes["vm_snapshot"] = vm_snapshot
    if cloud or bluegreen:
        changes |= {"slot": slot, "go_live": go_live}
    if dep.first_admin:          # as planned (create_deployment drops it once done)
        changes["first_admin"] = True
    audit(db, actor_id=actor.user.person_id, action=action, entity_type="deployment",
          entity_id=str(dep.id), ip=client_ip(request), changes=changes)
    await db.commit()
    pipeline.launch(dep.id)
    return await serialize.deployment_out(db, dep, environment_name=env_name)


async def _pinned(db, cfg: SshTargetConfig) -> None:
    try:
        await ssh.pinned_host_key(db, cfg.host, cfg.port)
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None


async def _require_integrations(db, env: Environment, *, teardown: bool = False) -> None:
    """Refuse up front (not after a 30-minute build) when publishing, or
    removing what Sirdar made, needs an integration that isn't set up."""
    missing = await publish.missing_integrations(db, env, teardown=teardown)
    if missing:
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": missing})


async def _start_publish(db, env: Environment, request: Request, actor: AuthContext) -> dict:
    """A publish job: steps 12–14 for the running commit. No SSH."""
    if not env.publish:
        raise HTTPException(status_code=409, detail={"code": "publish_off"})
    if env.current_sha is None:
        raise HTTPException(status_code=409, detail={"code": "not_deployed"})
    if not vault.is_configured(get_settings()):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    await _require_integrations(db, env)
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="publish", git_ref=env.git_ref, sha=env.current_sha,
                         cloud=_on_do(env))


async def _require_account(db, env: Environment) -> None:
    """409 do_account_not_configured {account} when the environment's
    DigitalOcean account has no token (or it can't be read)."""
    row = await do_envs.get(db, env.id)
    if row is None:                     # no DigitalOcean record: nothing to deploy to
        raise HTTPException(status_code=409, detail={"code": "do_not_ready"})
    try:
        await do_accounts.require(db, get_settings(), row.account_key)
    except integrations.IntegrationError as e:
        status = 409 if e.code in ("do_account_not_configured", "integration_unreadable") else 400
        raise HTTPException(status_code=status, detail={"code": e.code, **e.extra}) from None


async def _start_do_update(db, env: Environment, body: DeploymentIn, request: Request,
                           actor: AuthContext) -> dict:
    """Update on DigitalOcean: to the idle slot (the only one of a one-slot
    environment); it goes live when do_envs.goes_live says so. Step 0
    resolves the ref on the slot's droplet. Never publish=True: DNS is part
    of the DigitalOcean plan."""
    if not vault.is_configured(get_settings()):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    await _read_production(db, env)
    _retiring_refused(env)         # a deactivated, retiring production stays dark
    await _require_account(db, env)
    await _require_integrations(db, env)
    ref = body.git_ref or env.git_ref
    if not gitref.valid_ref(ref):
        raise HTTPException(status_code=422, detail={"code": "ref_invalid"})
    snapshot = None
    if env.seed_snapshot_id is not None and not await _do_ran(db, env):
        try:
            snapshot = await snapshots.ready_snapshot(db, env.seed_snapshot_id)
        except snapshots.SnapshotError as e:
            raise _snapshot_http(e) from None
    slot = do_envs.target_slot(env)
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="update", git_ref=ref,
                         sha=ref.lower() if gitref.is_full_sha(ref) else "", snapshot=snapshot,
                         cloud=True, slot=slot, go_live=do_envs.goes_live(env, slot),
                         first_admin=snapshot is None and await first_admins.pending(db, env.id))


async def _do_ran(db, env: Environment) -> bool:
    """Whether a deploy has already run on DigitalOcean: anything live, or a
    slot whose up step ran. The shared database is then seeded (and
    migrated), so the next Update doesn't seed again."""
    if env.current_sha is not None or env.active_slot is not None:
        return True
    return any(row.sha for row in (await do_envs.slots_of(db, env.id)).values())


async def _snapshot_slot(db, env: Environment) -> str | None:
    """Where a DigitalOcean snapshot is taken: the active slot, else the first
    slot whose droplet runs a commit."""
    if env.active_slot:
        return env.active_slot
    slots = await do_envs.slots_of(db, env.id)
    return next((s for s in env.slots if s in slots and slots[s].public_ip and slots[s].sha),
                None)


async def _begin_delete_snapshot(db, env: Environment, actor: AuthContext) -> Snapshot:
    """The pending snapshot a DigitalOcean Delete takes in step 11. A retry
    in the same second as the failed attempt (whose snapshot keeps its
    name) gets a -2, -3, ... suffix, within the 64-character name limit."""
    base = f"{env.name}-before-delete-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
    for n in range(1, 10):
        try:
            return await snapshots.begin_take(
                db, get_settings(), env,
                name=base if n == 1 else f"{base[:62]}-{n}",
                notes="Taken by Sirdar before Delete environment.",
                actor_id=actor.user.person_id)
        except snapshots.SnapshotError as e:
            if e.code == "snapshot_exists" and n < 9:
                continue
            await db.rollback()
            raise _snapshot_http(e) from None


async def _production_removable(db, env: Environment, phrase: str | None) -> None:
    """Production's rules for every attempt at Delete, read under the
    production lock (an un-retire takes it too, so neither races the
    other): retiring, serving no slot, and the phrase typed."""
    await environments.lock_production(db)
    await db.refresh(env)
    if not env.retiring:
        raise HTTPException(status_code=409, detail={"code": "production_not_retiring"})
    if env.active_slot is not None:
        raise HTTPException(status_code=409, detail={"code": "production_slot_active"})
    if phrase != f"delete production {env.name}":
        raise HTTPException(status_code=422, detail={"code": "confirm_production_mismatch"})


async def _start_do_teardown(db, env: Environment, body: DeploymentIn, request: Request,
                             actor: AuthContext) -> dict:
    """Delete on DigitalOcean: a snapshot first (unless turned off; never for
    production), then DNS records, then everything Sirdar recorded.
    Production must be retiring, with no active slot, and the phrase typed."""
    if not vault.is_configured(get_settings()):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    if env.type == "production":
        await _production_removable(db, env, body.confirm_production)
        if body.snapshot is False:
            raise HTTPException(status_code=422, detail={"code": "snapshot_required"})
    await _require_account(db, env)
    await _require_integrations(db, env, teardown=True)
    slot = await _snapshot_slot(db, env)
    snap = None
    if body.snapshot is not False and env.current_sha is not None:
        cfg = await _host_target(db, env, slot=slot) if slot else None
        if cfg is None:
            raise _snapshot_slot_unreachable(env)
        await _pinned(db, cfg)
        snap = await _begin_delete_snapshot(db, env, actor)
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="teardown", git_ref=env.git_ref, sha=env.current_sha or "",
                         snapshot=snap, cloud=True, slot=slot)


async def _start_lan_update(db, env: Environment, body: DeploymentIn, request: Request,
                            actor: AuthContext) -> dict:
    """Update on LAN Blue/Green: to the idle slot; it goes live when
    do_envs.goes_live says so. Step 0 builds the data VM and the slot's VM
    and resolves the ref there. No VM snapshot: the other slot is the way back."""
    if not vault.is_configured(get_settings()):
        raise _refuse(400, "secrets_key_missing")
    if body.take_vm_snapshot is not None:
        raise _refuse(422, "vm_snapshot_not_allowed")
    await _require_vm_host(db, env)
    await _require_npm(db)
    if env.publish:
        await _require_integrations(db, env)
    ref = body.git_ref or env.git_ref
    if not gitref.valid_ref(ref):
        raise _refuse(422, "ref_invalid")
    snapshot = None
    if env.seed_snapshot_id is not None and not await lan_slots.ran(db, env):
        try:
            snapshot = await snapshots.ready_snapshot(db, env.seed_snapshot_id)
        except snapshots.SnapshotError as e:
            raise _snapshot_http(e) from None
    slot = do_envs.target_slot(env)
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="update", git_ref=ref,
                         sha=ref.lower() if gitref.is_full_sha(ref) else "", snapshot=snapshot,
                         publish=env.publish, vm=True, bluegreen=True, slot=slot,
                         go_live=do_envs.goes_live(env, slot),
                         first_admin=snapshot is None and await first_admins.pending(db, env.id))


async def _lan_snapshot_slot(db, env: Environment) -> str | None:
    """Where a Blue/Green snapshot is taken: the live slot, else the first
    slot that runs a commit and has an address."""
    if env.active_slot:
        return env.active_slot
    rows = await lan_slots.slots_of(db, env.id)
    ips = {m.role: m.ip for m in await vms.machines(db, env)}
    return next((s for s in env.slots if s in rows and rows[s].sha and ips.get(s)), None)


async def _start_lan_teardown(db, env: Environment, body: DeploymentIn, request: Request,
                              actor: AuthContext) -> dict:
    """Delete on LAN Blue/Green: a snapshot first (unless turned off), taken on
    the live slot's VM against the data VM; then the three VMs, the proxy
    hosts and the DNS records."""
    if not vault.is_configured(get_settings()):
        raise _refuse(400, "secrets_key_missing")
    await _require_vm_host(db, env)
    await _require_integrations(db, env, teardown=True)
    slot = await _lan_snapshot_slot(db, env)
    snap = None
    if body.snapshot is not False and env.current_sha is not None:
        cfg = await _host_target(db, env, slot=slot) if slot else None
        if cfg is None:
            raise _snapshot_slot_unreachable(env)
        await _pinned(db, cfg)
        snap = await _begin_delete_snapshot(db, env, actor)
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="teardown", git_ref=env.git_ref, sha=env.current_sha or "",
                         snapshot=snap, vm=True, bluegreen=True, slot=slot)


async def _read_production(db, env: Environment) -> None:
    """Production's retiring flag and live slot, read under the production
    lock (an un-retire takes it too), so an Activate, Deactivate or Update
    never acts on a stale copy."""
    if env.type == "production":
        await environments.lock_production(db)
        await db.refresh(env)


def _retiring_refused(env: Environment) -> None:
    """A retiring production only goes dark: no slot goes live on it."""
    if env.type == "production" and env.retiring:
        raise HTTPException(status_code=409, detail={"code": "production_retiring"})


def _check_deactivate(env: Environment) -> None:
    """Deactivate (no slot): a retiring production with a live slot only."""
    if not (env.type == "production" and env.retiring):
        raise _refuse(422, "slot_required")
    if env.active_slot is None:
        raise _refuse(409, "already_inactive")


class ActivateIn(BaseModel):
    # The slot to send traffic to; None deactivates (a retiring production only).
    slot: str | None = Field(default=None, max_length=10)
    confirm_name: str | None = Field(default=None, max_length=64)


def _refuse(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _activate_lan(db, env: Environment, body: ActivateIn, request: Request,
                        actor: AuthContext) -> dict:
    """Activate on LAN Blue/Green: smoke-test the idle slot on its VM, then
    repoint the proxy hosts at it (14 Switch traffic, through NPM)."""
    if await environments.is_deploying(db, env.id):
        raise _refuse(409, "deploy_in_progress")
    if not vault.is_configured(get_settings()):
        raise _refuse(400, "secrets_key_missing")
    if body.slot is None:
        raise _refuse(422, "slot_required")              # Deactivate is production's
    if body.slot not in env.slots:
        raise _refuse(422, "slot_invalid")
    if body.slot == env.active_slot:
        raise _refuse(409, "slot_already_active")
    row = (await lan_slots.slots_of(db, env.id)).get(body.slot)
    if row is None or not row.sha:
        raise _refuse(409, "slot_not_deployed", slot=body.slot)
    await _require_vm_host(db, env)
    await _require_npm(db)
    if await _host_target(db, env, slot=body.slot) is None:
        raise _refuse(409, "vm_not_ready")              # the slot's VM has no address
    return await _launch(db, env, request, actor, action="deploy.activate", mode="activate",
                         git_ref=row.sha, sha=row.sha, vm=True, bluegreen=True, slot=body.slot,
                         go_live=True)


@router.post("/environments/{name}/activate", status_code=201)
async def activate(name: str, body: ActivateIn, request: Request, db: DbSession,
                   actor: AuthContext = require_permission("deploy", "change")):
    """Blue/Green: smoke-test a slot on its droplet, then move the load
    balancer to it without a gap (a deployment, so it shares the lock, the
    log and Retry). Going back is activating the other slot. A retiring
    production can be deactivated (slot None) so Delete can remove it."""
    # And deploy:add, as Retry needs it: anyone who starts an Activate can retry it.
    if not actor.access.can("deploy", "add"):
        raise _forbidden()
    env = await _environment(db, name)
    if _on_bg(env):
        return await _activate_lan(db, env, body, request, actor)
    if not _on_do(env):
        raise _refuse(409, "not_bluegreen_environment")
    if env.type == "production" and body.confirm_name != env.name:
        raise _refuse(422, "confirm_name_mismatch")
    if await environments.is_deploying(db, env.id):
        raise _refuse(409, "deploy_in_progress")
    if not vault.is_configured(get_settings()):
        raise _refuse(400, "secrets_key_missing")
    await _require_account(db, env)
    await _read_production(db, env)
    if body.slot is None:
        _check_deactivate(env)
        return await _launch(db, env, request, actor, action="deploy.activate", mode="activate",
                             git_ref=env.git_ref, sha=env.current_sha or "", cloud=True,
                             slot=None, go_live=True)
    if body.slot not in env.slots:
        raise _refuse(422, "slot_invalid")
    _retiring_refused(env)
    if body.slot == env.active_slot:
        raise _refuse(409, "slot_already_active")
    row = (await do_envs.slots_of(db, env.id)).get(body.slot)
    if row is None or not row.sha:
        raise _refuse(409, "slot_not_deployed", slot=body.slot)
    if await _host_target(db, env, slot=body.slot) is None:
        raise _refuse(409, "do_not_ready")           # the slot's droplet has no address
    return await _launch(db, env, request, actor, action="deploy.activate", mode="activate",
                         git_ref=row.sha, sha=row.sha, cloud=True, slot=body.slot,
                         go_live=True)


@router.post("/environments/{name}/slots", status_code=201)
async def add_slot(name: str, request: Request, db: DbSession,
                   actor: AuthContext = require_permission("deploy", "change")):
    """A one-slot environment gets its second slot (purple). Once anything was
    deployed, the running commit is deployed to it (step 0 builds its droplet
    and lets it reach the database; never a seed: the shared database already
    holds the data); traffic stays where it is. Otherwise the first Update
    builds it."""
    # And deploy:add, as Retry needs it: anyone who starts the deploy can retry it.
    if not actor.access.can("deploy", "add"):
        raise _forbidden()
    env = await _environment(db, name)
    if not _on_do(env):
        raise _refuse(409, "not_digitalocean_environment")
    if env.type == "production":
        raise _refuse(422, "slot_not_allowed")
    await db.refresh(env, with_for_update=True)      # one add at a time
    if len(env.slots) != 1:
        raise _refuse(409, "slots_full")
    if await environments.is_deploying(db, env.id):
        raise _refuse(409, "deploy_in_progress")
    settings = get_settings()
    if not vault.is_configured(settings):
        raise _refuse(400, "secrets_key_missing")
    await _require_account(db, env)
    sha = env.current_sha
    if sha is not None:
        await _require_integrations(db, env)
    env_name = env.name
    await do_envs.add_slot(db, settings, env, "purple")
    env.slots = [*env.slots, "purple"]
    env.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.user.person_id, action="deploy.slot_add", entity_type="environment",
          entity_id=env_name, ip=client_ip(request),
          changes={"environment": env_name, "slot": "purple"})
    deployment = None
    if sha is None:
        await db.commit()
    else:
        # One commit for the slot, its audit row and the deployment.
        deployment = await _launch(db, env, request, actor, action="deploy.deployment_start",
                                   mode="update", git_ref=sha, sha=sha, cloud=True,
                                   slot="purple", go_live=False)
    await db.refresh(env)
    return {"environment": await serialize.environment_out(db, env), "deployment": deployment}


async def _vm_snapshot_restorable(db, env: Environment, name: str) -> None:
    """409 vm_snapshot_keys_changed when a snapshot restore replaced the
    sign-in keys after the VM snapshot was taken."""
    changed_at = (await environments.key_changes(db, env.id)).changed_at
    reason = vms.snapshot_blocked(name, changed_at)
    if reason is not None:
        raise HTTPException(status_code=409, detail={"code": "vm_snapshot_keys_changed",
                                                     "reason": reason})


async def _start_vm_restore(db, env: Environment, name: str, request: Request,
                            actor: AuthContext) -> dict:
    """Restore VM snapshot: the VM back to a snapshot Sirdar took for this
    environment, and the environment's commit back to the one it holds."""
    if not _on_vm(env):
        raise HTTPException(status_code=409, detail={"code": "not_vm_environment"})
    if not vms.valid_snapshot_name(name):
        raise HTTPException(status_code=422, detail={"code": "vm_snapshot_invalid"})
    await _require_vm_host(db, env)
    if not vault.is_configured(get_settings()):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    taking = (await vms.taking_deployments(db, env.id)).get(name)
    if taking is None or not taking.previous_sha:
        raise HTTPException(status_code=404, detail={"code": "vm_snapshot_not_found"})
    await _vm_snapshot_restorable(db, env, name)
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="vm_restore", git_ref=taking.previous_sha,
                         sha=taking.previous_sha, vm=True, vm_snapshot=name)


@router.post("/environments/{name}/deployments", status_code=201)
async def start_deployment(name: str, body: DeploymentIn, request: Request, db: DbSession,
                           actor: AuthContext = require_permission("deploy", "add")):
    _require_mode(actor, body.mode)
    env = await _environment(db, name)
    on_vm = _on_vm(env)
    if _on_do(env) and body.mode in ("reset", "restore_dump", "vm_restore"):
        raise _not_on_do()
    if _on_bg(env) and body.mode in ("reset", "restore_dump", "vm_restore"):
        raise _not_on_bg()
    # Delete's snapshot switch: DigitalOcean and Blue/Green; the production
    # phrase: DigitalOcean only (a LAN environment is never production).
    if (body.snapshot is not None or body.confirm_production is not None) and not (
            body.mode == "teardown" and (
                _on_do(env) or (_on_bg(env) and body.confirm_production is None))):
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
    if body.mode in GATED_MODES and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if body.snapshot_id is not None and body.mode != "reset":
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
    if (body.backup is not None) != (body.mode == "restore_dump"):
        raise HTTPException(status_code=422, detail={"code": "backup_invalid"})
    if (body.vm_snapshot is not None) != (body.mode == "vm_restore"):
        raise HTTPException(status_code=422, detail={"code": "vm_snapshot_invalid"})
    if body.take_vm_snapshot is not None and (not on_vm or body.mode not in VM_SNAPSHOT_MODES):
        raise HTTPException(status_code=422, detail={"code": "vm_snapshot_not_allowed"})
    if body.mode == "restore_dump":
        if not environments.valid_backup_name(body.backup):
            raise HTTPException(status_code=422, detail={"code": "backup_invalid"})
        if body.git_ref is not None:        # it deploys the running commit
            raise HTTPException(status_code=422, detail={"code": "git_ref_not_allowed"})
    if body.mode in ("publish", "teardown", "vm_restore") and body.git_ref is not None:
        raise HTTPException(status_code=422, detail={"code": "git_ref_not_allowed"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    if body.mode == "publish":
        return await _start_publish(db, env, request, actor)
    if body.mode == "vm_restore":
        return await _start_vm_restore(db, env, body.vm_snapshot, request, actor)
    if _on_do(env):
        if body.mode == "teardown":
            return await _start_do_teardown(db, env, body, request, actor)
        return await _start_do_update(db, env, body, request, actor)
    if _on_bg(env):          # update or teardown: every other mode was answered above
        if body.mode == "teardown":
            return await _start_lan_teardown(db, env, body, request, actor)
        return await _start_lan_update(db, env, body, request, actor)
    await _require_vm_host(db, env)
    if body.mode == "teardown" and on_vm:
        # Step 15 Destroy VM needs no SSH (nor the VM's key).
        if not vault.is_configured(get_settings()):
            raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
        cfg = None
    else:
        cfg = await _host_target(db, env)        # None: a VM step 0 hasn't built yet
    take = _take_vm_snapshot(env, body.take_vm_snapshot)
    if body.mode == "teardown":
        await _require_integrations(db, env, teardown=True)
        if not on_vm:
            await _pinned(db, cfg)
        return await _launch(db, env, request, actor, action="deploy.deployment_start",
                             mode="teardown", git_ref=env.git_ref, sha=env.current_sha or "",
                             vm=on_vm)
    if env.publish:
        await _require_integrations(db, env)
    if body.mode == "restore_dump":
        if env.current_sha is None:
            raise HTTPException(status_code=409, detail={"code": "not_deployed"})
        reason = environments.backup_blocked(
            body.backup, await environments.key_changes(db, env.id))
        if reason is not None:
            raise HTTPException(status_code=409, detail={"code": "backup_keys_changed",
                                                         "reason": reason})
        if not on_vm:                            # step 0 pins the VM's key
            await _pinned(db, cfg)
        return await _launch(db, env, request, actor, action="deploy.deployment_start",
                             mode="restore_dump", git_ref=env.current_sha,
                             sha=env.current_sha, restore_dump=body.backup,
                             publish=env.publish, vm=on_vm, take_vm_snapshot=take)
    snapshot_id = body.snapshot_id
    if body.mode == "update" and env.current_sha is None:
        snapshot_id = env.seed_snapshot_id          # the first deploy restores the seed
    snapshot = None
    if snapshot_id is not None:
        try:
            snapshot = await snapshots.ready_snapshot(db, snapshot_id)
        except snapshots.SnapshotError as e:
            raise _snapshot_http(e) from None
    ref = body.git_ref or env.git_ref
    if on_vm:
        # Step 0 resolves a branch or tag on the VM: it may not exist yet.
        if not gitref.valid_ref(ref):
            raise HTTPException(status_code=422, detail={"code": "ref_invalid"})
        sha = ref.lower() if gitref.is_full_sha(ref) else ""
    else:
        try:
            sha = await gitref.resolve_ref(cfg, db, get_settings().deploy_repo_url, ref)
        except gitref.RefError as e:
            detail: dict = {"code": e.code}
            if e.code in _REF_REASON:
                detail["reason"] = _REF_REASON[e.code]
            raise HTTPException(status_code=_REF_STATUS[e.code], detail=detail) from None
        except _SSH_ERRORS as e:
            raise _ssh_http(e) from None
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode=body.mode, git_ref=ref, sha=sha, snapshot=snapshot,
                         publish=env.publish, vm=on_vm, take_vm_snapshot=take,
                         first_admin=body.mode == "update" and snapshot is None
                         and await first_admins.pending(db, env.id))


@router.get("/environments/{name}/deployments")
async def list_deployments(name: str, db: DbSession,
                           limit: int = Query(default=20, ge=1, le=100),
                           actor: AuthContext = require_permission("deploy", "view")):
    env = await _environment(db, name)
    rows = await serialize.recent_deployments(db, env.id, limit)
    return {"deployments": [await serialize.deployment_summary(db, d) for d in rows]}


@router.get("/deployments/{deployment_id}")
async def get_deployment(deployment_id: uuid.UUID, db: DbSession,
                         tail: int = Query(default=serialize.LOG_TAIL_DEFAULT, ge=0,
                                           le=pipeline.LOG_LIMIT),
                         actor: AuthContext = require_permission("deploy", "view")):
    dep = await _deployment(db, deployment_id)
    env = await db.get(Environment, dep.environment_id)
    return await serialize.deployment_out(db, dep, environment_name=env.name, tail=tail)


@router.post("/deployments/{deployment_id}/cancel", status_code=202)
async def cancel_deployment(deployment_id: uuid.UUID, request: Request, db: DbSession,
                            actor: AuthContext = require_permission("deploy", "change")):
    dep = await _deployment(db, deployment_id)
    if dep.status != "running":
        raise HTTPException(status_code=409, detail={"code": "not_running"})
    env = await db.get(Environment, dep.environment_id)
    audit(db, actor_id=actor.user.person_id, action="deploy.deployment_cancel",
          entity_type="deployment", entity_id=str(dep.id), ip=client_ip(request),
          changes={"environment": env.name, "mode": dep.mode, "sha": dep.sha})
    await db.commit()
    if pipeline.request_cancel(dep.id):
        return {"id": str(dep.id), "status": "cancelling"}
    await pipeline.close_orphan(dep.id)        # running record, no task in this process
    return {"id": str(dep.id), "status": "cancelled"}


@router.post("/deployments/{deployment_id}/retry", status_code=201)
async def retry_deployment(deployment_id: uuid.UUID, body: RetryIn, request: Request,
                           db: DbSession,
                           actor: AuthContext = require_permission("deploy", "add")):
    dep = await _deployment(db, deployment_id)
    _require_mode(actor, dep.mode)
    if dep.status not in pipeline.RETRYABLE_STATUSES or dep.mode not in RETRY_MODES:
        raise HTTPException(status_code=409, detail={"code": "not_retryable"})
    env = await db.get(Environment, dep.environment_id)
    if _on_do(env) and dep.mode in pipeline.NOT_ON_DIGITALOCEAN:
        raise _not_on_do()
    if _on_bg(env) and dep.mode in pipeline.NOT_ON_DIGITALOCEAN:
        raise _not_on_bg()
    typed = dep.mode in GATED_MODES or (dep.mode == "activate" and env.type == "production")
    if typed and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if dep.cloud and dep.mode in ("activate", "update"):
        await _read_production(db, env)
        if dep.mode == "activate" and dep.slot is None:
            _check_deactivate(env)
        else:
            _retiring_refused(env)
    # Sirdar's own renew jobs never stand in the way of retrying anything else.
    latest = await db.scalar(
        select(Deployment).where(Deployment.environment_id == env.id,
                                 *(() if dep.mode == "renew" else (Deployment.mode != "renew",)))
        .order_by(Deployment.created_at.desc()).limit(1))
    if latest is None or latest.id != dep.id:
        raise HTTPException(status_code=409, detail={"code": "retry_not_latest"})
    production_delete = dep.cloud and dep.mode == "teardown" and env.type == "production"
    if production_delete:
        await _production_removable(db, env, body.confirm_production)
    stopped = await _stopped_step(db, dep.id)
    if stopped is None:
        raise HTTPException(status_code=409, detail={"code": "not_retryable"})
    from_step = stopped if body.from_step is None else body.from_step   # 0 is a step
    # Whether it restored a snapshot: its own step rows say so even after the
    # snapshot was deleted (snapshot_id is then NULL).
    restoring = dep.mode in ("update", "reset") and await _has_step(db, dep.id, "restore")
    # A DigitalOcean Delete that took a snapshot first (step 11).
    taking = dep.mode == "teardown" and (dep.cloud or dep.bluegreen) \
        and await _has_step(db, dep.id, "export")
    # Step 11 again only while the first admin is still to be created, as
    # create_deployment plans it (a done record drops the step).
    first_admin = dep.first_admin and await first_admins.pending(db, env.id)
    plan = plan_for(dep.mode, restore=restoring, publish=dep.publish, vm=dep.vm,
                    cloud=dep.cloud, go_live=dep.go_live, snapshot=taking,
                    smoke=pipeline.smokes(dep.mode, dep.slot), first_admin=first_admin,
                    bluegreen=dep.bluegreen)
    admin_step = STEPS_BY_KEY["first_admin"].number
    if dep.first_admin and not first_admin and from_step == admin_step <= stopped:
        # The admin was created since step 11 stopped: carry on with the step
        # after it, or there's nothing left to retry.
        later = [s.number for s in plan if s.number > admin_step]
        if not later:
            raise HTTPException(status_code=409, detail={"code": "not_retryable"})
        from_step = later[0]
        stopped = max(stopped, from_step)
    if from_step not in [s.number for s in plan] or from_step > stopped:
        raise HTTPException(status_code=422, detail={"code": "from_step_invalid"})
    # The Publish switch as it is now: a retry never publishes an environment
    # whose switch was turned off since. A data retry drops steps 12–14; one
    # that would start at them (or a publish job's retry) is refused.
    publishing = dep.publish and env.publish
    # On Blue/Green only step 12 publishes: 13 and 14 run without it (the
    # plan without publish simply drops 12).
    dns_step = STEPS_BY_KEY["dns"].number
    if not env.publish and (dep.mode == "publish" or (
            dep.publish and (from_step == dns_step if dep.bluegreen
                             else from_step >= dns_step))):
        raise HTTPException(status_code=409, detail={"code": "publish_off"})
    if restoring and dep.snapshot_id is None:
        if from_step <= STEPS_BY_KEY["restore"].number:
            raise HTTPException(status_code=404, detail={"code": "snapshot_not_found"})
        restoring = False             # the restore already succeeded; only later steps rerun
    snapshot = None
    if restoring:
        try:
            snapshot = await snapshots.ready_snapshot(db, dep.snapshot_id)
        except snapshots.SnapshotError as e:
            raise _snapshot_http(e) from None
    # As the pipeline does: with no host step left to run (a publish job, or
    # a retry of only steps 12–14 or 16–17) there is no target to connect to.
    await _require_vm_host(db, env)
    if dep.cloud:
        await _require_account(db, env)
    cfg = None
    if any(s.runs == "ansible" for s in plan if s.number >= from_step):
        cfg = await _host_target(db, env, slot=dep.slot if dep.cloud or dep.bluegreen else None)
        if not dep.vm and not dep.cloud:    # a built target's step 0 pins the key
            await _pinned(db, cfg)
    elif not vault.is_configured(get_settings()):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    if dep.mode == "vm_restore":
        # As at the start: the sign-in keys may have changed since the
        # failed attempt (a snapshot restore), so the VM snapshot's are gone.
        await _vm_snapshot_restorable(db, env, dep.vm_snapshot)
    if dep.mode == "teardown":
        await _require_integrations(db, env, teardown=True)
    elif dep.mode == "publish" or publishing:
        await _require_integrations(db, env)
    if dep.bluegreen and dep.mode in ("update", "activate"):
        await _require_npm(db)
    if taking:
        if from_step <= STEPS_BY_KEY["export"].number:
            if cfg is None:             # the slot's droplet has no address
                raise _snapshot_slot_unreachable(env)
            # A new pending snapshot; the failed attempt's stays failed.
            snapshot = await _begin_delete_snapshot(db, env, actor)
        elif dep.snapshot_id is not None:
            try:
                snapshot = await snapshots.ready_snapshot(db, dep.snapshot_id)
            except snapshots.SnapshotError:
                snapshot = None         # gone or not ready: the plan drops step 11
        if snapshot is None and production_delete:
            # Production never goes without its snapshot: Delete it again
            # (from the start) to take a new one.
            raise HTTPException(status_code=409, detail={"code": "snapshot_required"})
    return await _launch(db, env, request, actor, action="deploy.deployment_retry",
                         mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                         start_step=from_step, retry_of=dep.id, snapshot=snapshot,
                         restore_dump=dep.restore_dump, publish=publishing, vm=dep.vm,
                         take_vm_snapshot=dep.take_vm_snapshot,
                         vm_snapshot=dep.vm_snapshot if dep.mode == "vm_restore" else None,
                         cloud=dep.cloud, slot=dep.slot, go_live=dep.go_live,
                         first_admin=first_admin, bluegreen=dep.bluegreen)


@router.post("/deployments/{deployment_id}/rollback", status_code=201)
async def rollback_deployment(deployment_id: uuid.UUID, body: RollbackIn, request: Request,
                              db: DbSession,
                              actor: AuthContext = require_permission("deploy", "change")):
    """Spec: after a failed Update, deploy the previous commit again and put
    its pre-deploy dump back. Objects are not rolled back."""
    dep = await _deployment(db, deployment_id)
    if not serialize.rollback_available(dep):
        raise HTTPException(status_code=409, detail={"code": "rollback_unavailable"})
    env = await db.get(Environment, dep.environment_id)
    if _on_do(env):
        raise _not_on_do()
    if _on_bg(env):
        raise _not_on_bg()
    if body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    latest = await serialize.latest_deployment(db, env.id)
    if latest is None or latest.id != dep.id:
        raise HTTPException(status_code=409, detail={"code": "rollback_not_latest"})
    dump = PurePosixPath(dep.dump_path).name
    if not environments.valid_backup_name(dump):
        raise HTTPException(status_code=409, detail={"code": "rollback_unavailable"})
    if body.take_vm_snapshot is not None and not _on_vm(env):
        raise HTTPException(status_code=422, detail={"code": "vm_snapshot_not_allowed"})
    await _require_vm_host(db, env)
    cfg = await _host_target(db, env)
    if not _on_vm(env):
        await _pinned(db, cfg)
    if env.publish:
        await _require_integrations(db, env)
    return await _launch(db, env, request, actor, action="deploy.deployment_rollback",
                         mode="rollback", git_ref=dep.previous_sha, sha=dep.previous_sha,
                         restore_dump=dump, publish=env.publish, vm=_on_vm(env),
                         take_vm_snapshot=_take_vm_snapshot(env, body.take_vm_snapshot))


@router.get("/environments/{name}/backups")
async def list_backups(name: str, db: DbSession,
                       actor: AuthContext = require_permission("deploy", "view")):
    """The environment's pre-deploy dumps, read over SSH (newest first)."""
    env = await _environment(db, name)
    # A VM's SSH key is sealed with the secrets key (a saved target's isn't).
    cfg = await _host_target(db, env, need_secrets=_on_vm(env) or _on_do(env))
    if cfg is None:                     # a VM step 0 hasn't built: nothing to list
        return {"backups": []}
    try:
        rows = await environments.list_backups(db, cfg, env)
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None
    return {"backups": rows}


async def _live_snapshots(cfg, vm) -> list[tuple[str, str]]:
    """(name, description) of every snapshot the host has for the VM."""
    if isinstance(vm, EsxiVm):
        async with esxi.connect(cfg) as api:
            return [(s.name, s.description) for s in await api.snapshots(vm.instance_uuid)]
    async with proxmox.Proxmox(replace(cfg, node=vm.node),
                               transport=outbound.transports()["proxmox"]) as api:
        return [(str(s.get("name", "")), str(s.get("description") or ""))
                for s in await api.snapshots(vm.vmid)]


@router.get("/environments/{name}/vm-snapshots")
async def list_vm_snapshots(name: str, db: DbSession,
                            actor: AuthContext = require_permission("deploy", "view")):
    """The VM snapshots Sirdar took for a VM environment that still exist on
    its host, newest first, with the commit each holds and whether it can be
    restored (read live from Proxmox or ESXi)."""
    env = await _environment(db, name)
    if not _on_vm(env):
        raise HTTPException(status_code=409, detail={"code": "not_vm_environment"})
    try:
        cfg = await integrations.load(db, get_settings(), env.target_id)
    except integrations.IntegrationError as e:
        status = 400 if e.code == "secrets_key_missing" else 409
        raise HTTPException(status_code=status, detail={"code": e.code}) from None
    if cfg is None:
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": [env.target_id]})
    vm = await vms.get_for(db, env)
    if vm is None or vms.stage(vm) != "built":
        return {"snapshots": []}
    taking = await vms.taking_deployments(db, env.id)
    changed_at = (await environments.key_changes(db, env.id)).changed_at
    try:
        found = await _live_snapshots(cfg, vm)
    except (proxmox.ProxmoxError, esxi.EsxiError) as e:
        raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                     "reason": e.reason}) from None
    rows = []
    for name_, description in found:
        dep = taking.get(name_)
        if dep is None or not vms.valid_snapshot_name(name_):
            continue
        reason = vms.snapshot_blocked(name_, changed_at)
        rows.append({"name": name_,
                     "taken_at": vms.snapshot_taken_at(name_).strftime("%Y-%m-%dT%H:%M:%SZ"),
                     "sha": dep.previous_sha, "deployment_id": str(dep.id),
                     "description": description,
                     "restorable": reason is None and bool(dep.previous_sha),
                     "reason": reason})
    return {"snapshots": sorted(rows, key=lambda r: r["name"], reverse=True)}


# ---- publishing (the Publish tab) -----------------------------------------------

def _publish_out(state: dict) -> dict:
    """The Publish tab's shape, with certificate expiry dates as ISO 8601."""
    for svc in state["services"]:
        cert = svc["certificate"]
        if isinstance(cert.get("expires_on"), datetime):
            cert["expires_on"] = cert["expires_on"].isoformat()
    return state


@router.get("/environments/{name}/publish")
async def publish_state(name: str, db: DbSession,
                        actor: AuthContext = require_permission("deploy", "view")):
    """What publishing would do now, per public service (reads Cloudflare and
    Nginx Proxy Manager, changes nothing)."""
    env = await _environment(db, name)
    return _publish_out(await publish.inspect(db, env, get_settings()))


@router.post("/environments/{name}/publish/claim")
async def publish_claim(name: str, request: Request, db: DbSession,
                        actor: AuthContext = require_permission("deploy", "change")):
    """Take every hand-made DNS record and proxy host at this environment's
    names under Sirdar's care: kept up to date, never deleted. Writes only
    Sirdar's database."""
    env = await _environment(db, name)
    env_name = env.name           # read now: a conflict rolls the session back
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    settings = get_settings()
    state = await publish.inspect(db, env, settings)
    try:
        claimed = await publish.claim(db, env, state)
    except IntegrityError:
        # another environment, or a concurrent claim, took one first
        await db.rollback()
        raise HTTPException(status_code=409, detail={"code": "claim_conflict"}) from None
    if not claimed:
        raise HTTPException(status_code=409, detail={"code": "nothing_to_claim"})
    audit(db, actor_id=actor.user.person_id, action="deploy.publish_claim",
          entity_type="environment", entity_id=env_name, ip=client_ip(request),
          changes={"environment": env_name, "claimed": claimed})
    await db.commit()
    return {**_publish_out(await publish.inspect(db, env, settings)), "claimed": claimed}


# ---- snapshots -------------------------------------------------------------------

class TakeSnapshotIn(BaseModel):
    name: str = Field(max_length=64)
    notes: str = Field(default="", max_length=snapshots.NOTES_LIMIT)


@router.get("/snapshots")
async def list_snapshots(db: DbSession,
                         actor: AuthContext = require_permission("deploy", "view")):
    return {"snapshots": [await snapshots.snapshot_out(db, s)
                          for s in await snapshots.list_all(db)]}


@router.post("/snapshots", status_code=201)
async def upload_snapshot(request: Request, db: DbSession,
                          name: str = Query(max_length=64),
                          notes: str = Query(default="", max_length=snapshots.NOTES_LIMIT),
                          actor: AuthContext = require_permission("deploy", "add")):
    """The body is the bundle itself (application/gzip), streamed to disk."""
    raw_length = request.headers.get("content-length")
    length = int(raw_length) if raw_length and raw_length.isdecimal() else None
    try:
        snap = await snapshots.receive_upload(
            db, get_settings(), name=name, notes=notes, chunks=request.stream(),
            content_length=length, actor_id=actor.user.person_id)
    except snapshots.SnapshotError as e:
        await db.rollback()
        raise _snapshot_http(e) from None
    except ClientDisconnect:
        # The client went away mid-upload; receive_upload already removed the
        # partial file. Nobody reads this answer, but it isn't a 500.
        await db.rollback()
        raise HTTPException(status_code=400, detail={"code": "upload_aborted"}) from None
    audit(db, actor_id=actor.user.person_id, action="deploy.snapshot_upload",
          entity_type="snapshot", entity_id=snap.name, ip=client_ip(request),
          changes={"name": snap.name, "source": snap.source,
                   "alembic_revision": snap.alembic_revision, "size_bytes": snap.size_bytes,
                   "checksum": snap.checksum})
    await db.commit()
    await db.refresh(snap)
    return await snapshots.snapshot_out(db, snap)


@router.post("/environments/{name}/snapshots", status_code=201)
async def take_snapshot(name: str, body: TakeSnapshotIn, request: Request, db: DbSession,
                        actor: AuthContext = require_permission("deploy", "add")):
    env = await _environment(db, name)
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    cfg = await _host_target(db, env)
    if cfg is None:
        detail = {"code": "do_not_ready"} if _on_do(env) else {"code": "vm_not_ready"}
        raise HTTPException(status_code=409, detail=detail)
    await _pinned(db, cfg)
    try:
        snap = await snapshots.begin_take(db, get_settings(), env, name=body.name,
                                          notes=body.notes, actor_id=actor.user.person_id)
    except snapshots.SnapshotError as e:
        await db.rollback()
        raise _snapshot_http(e) from None
    on_do, on_bg = _on_do(env), _on_bg(env)
    # Blue/Green: on the live slot's VM, against the data VM.
    dep = await _launch(db, env, request, actor, action="deploy.snapshot_take",
                        mode="snapshot", git_ref=env.git_ref, sha=env.current_sha,
                        snapshot=snap, cloud=on_do, vm=on_bg, bluegreen=on_bg,
                        slot=env.active_slot if on_do or on_bg else None)
    await db.refresh(snap)
    return {"snapshot": await snapshots.snapshot_out(db, snap), "deployment": dep}


@router.delete("/snapshots/{snapshot_id}", status_code=204)
async def delete_snapshot(snapshot_id: uuid.UUID, request: Request, db: DbSession,
                          actor: AuthContext = require_permission("deploy", "change")):
    snap = await db.get(Snapshot, snapshot_id)
    if snap is None:
        raise HTTPException(status_code=404, detail={"code": "snapshot_not_found"})
    name = snap.name
    try:
        bundle_file = await snapshots.delete(db, get_settings(), snap)
    except snapshots.SnapshotError as e:
        await db.rollback()
        raise _snapshot_http(e) from None
    audit(db, actor_id=actor.user.person_id, action="deploy.snapshot_delete",
          entity_type="snapshot", entity_id=name, ip=client_ip(request),
          changes={"name": name})
    await db.commit()
    if bundle_file is not None:              # only once the row is gone for good
        await asyncio.to_thread(bundle_file.unlink, True)
    return Response(status_code=204)
