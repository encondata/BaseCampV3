"""Deploy page, step 1: targets, connection tests and trusted SSH host keys.
Responses never carry secrets; error reasons are our own copy."""

import asyncio
import os
import uuid
from datetime import datetime
from pathlib import PurePosixPath
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from starlette.requests import ClientDisconnect

from sirdar_api.api.deps import AuthContext, DbSession, client_ip, require_permission
from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, Snapshot, SshKnownHost
from sirdar_api.deploy import (
    ConnectFailed,
    digitalocean,
    envfile,
    environments,
    gitref,
    known_hosts,
    names,
    pipeline,
    publish,
    serialize,
    snapshots,
    ssh,
    targets,
    vault,
)
from sirdar_api.deploy.ssh import SshTargetConfig
from sirdar_api.deploy.ssh_targets import SavedSshTarget, TargetError
from sirdar_api.deploy.steps import STEPS_BY_KEY, plan_for
from sirdar_api.services.audit import audit

router = APIRouter(prefix="/deploy", tags=["deploy"])

TARGET_ID_PATTERN = r"^(aws|gcp|digitalocean|ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*)$"
DeployType = Literal["blue", "green", "dev", "beta", "custom"]


class ConnectIn(BaseModel):
    target: str = Field(pattern=TARGET_ID_PATTERN, max_length=36)
    type: DeployType
    region: str | None = Field(default=None, pattern=r"^[a-z0-9-]{2,20}$")
    name: str | None = None


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
async def list_targets(actor: AuthContext = require_permission("deploy", "view")):
    s = get_settings()
    writable = targets.can_add_ssh(s)
    return {"targets": targets.public_targets(s), "types": targets.DEPLOY_TYPES,
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


@router.get("/digitalocean/regions")
async def digitalocean_regions(actor: AuthContext = require_permission("deploy", "view")):
    settings = get_settings()
    if not targets.is_configured("digitalocean", settings):
        raise HTTPException(status_code=400, detail={"code": "target_not_configured"})
    try:
        return await digitalocean.list_regions(settings)
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
            result = await digitalocean.test_connection(settings, region=body.region)
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

SSH_TARGET_PATTERN = r"^(ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*)$"
EnvType = Literal["dev", "beta", "custom"]
_SSH_ERRORS = (ssh.HostKeyUnknown, ssh.HostKeyMismatch, ConnectFailed)
_ENV_STATUS = {"environment_exists": 409, "deploy_in_progress": 409,
               "secrets_key_missing": 400, "target_not_configured": 400,
               "snapshot_not_found": 404, "snapshot_not_ready": 409}
_NAME_CONSTRAINT = "environments_name_key"


class EnvironmentIn(BaseModel):
    mode: Literal["new", "adopt"]
    name: str = Field(max_length=64)
    type: EnvType
    target: str = Field(pattern=SSH_TARGET_PATTERN, max_length=36)
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


class ServicePatch(BaseModel):
    port: int | None = None
    host_ip: str | None = Field(default=None, max_length=45)
    proxied: bool | None = None


class EnvironmentPatch(BaseModel):
    git_ref: str | None = Field(default=None, max_length=200)
    target: str | None = Field(default=None, pattern=SSH_TARGET_PATTERN, max_length=36)
    base_domain: str | None = Field(default=None, max_length=253)
    proxy_ip: str | None = Field(default=None, max_length=45)
    bind_ip: str | None = Field(default=None, max_length=45)
    keep_dumps: int | None = None
    spaces_bucket: str | None = Field(default=None, max_length=63)
    log_level: str | None = Field(default=None, max_length=10)
    services: dict[str, ServicePatch] | None = None
    publish: bool | None = None
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
                snapshot_id=body.snapshot_id, publish=body.publish is not False)
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
        raise
    if report is None:
        changes = {"name": env.name, "type": env.type, "target": env.target_id,
                   "base_domain": env.base_domain, "git_ref": env.git_ref,
                   "proxy_ip": env.proxy_ip, "bind_ip": env.bind_ip, "publish": env.publish}
        seed = await snapshots.snapshot_ref(db, env.seed_snapshot_id)
        if seed is not None:
            changes["seed_snapshot"] = seed["name"]
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


@router.patch("/environments/{name}")
async def update_environment(name: str, body: EnvironmentPatch, request: Request,
                             db: DbSession,
                             actor: AuthContext = require_permission("deploy", "change")):
    env = await _environment(db, name)
    try:
        changed = await environments.update(db, get_settings(), env,
                                            body.model_dump(exclude_unset=True))
    except environments.EnvError as e:
        # update() edits the rows before every check has run: undo the lot.
        await db.rollback()
        raise _env_http(e) from None
    if changed:
        audit(db, actor_id=actor.user.person_id, action="deploy.environment_update",
              entity_type="environment", entity_id=env.name, ip=client_ip(request),
              changes={"changed": changed})
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
    # publish: steps 12–14 for the running commit; teardown: Delete environment
    mode: Literal["update", "reset", "restore_dump", "publish", "teardown"] = "update"
    git_ref: str | None = Field(default=None, max_length=200)
    # Reset and Restore backup: must equal the environment's name exactly.
    confirm_name: str | None = Field(default=None, max_length=64)
    # Reset only: restore this snapshot after the reset.
    snapshot_id: uuid.UUID | None = None
    # Restore backup only: a file name from GET /environments/{name}/backups.
    backup: str | None = Field(default=None, max_length=64)


class RetryIn(BaseModel):
    from_step: int | None = Field(default=None, ge=1, le=99)
    confirm_name: str | None = Field(default=None, max_length=64)


class RollbackIn(BaseModel):
    confirm_name: str | None = Field(default=None, max_length=64)


# Modes that replace data: deploy:change and the environment's name typed back.
GATED_MODES = ("reset", "restore_dump", "rollback", "teardown")
RETRY_MODES = ("update", "reset", "restore_dump", "rollback", "publish", "teardown")


def _forbidden() -> HTTPException:
    return HTTPException(status_code=403, detail={"code": "forbidden"})


def _require_mode(actor: AuthContext, mode: str) -> None:
    """Update needs deploy:add (the route's guard); the modes that replace
    data also need change."""
    if mode in GATED_MODES and not actor.access.can("deploy", "change"):
        raise _forbidden()


def _snapshot_http(e: snapshots.SnapshotError) -> HTTPException:
    status = {"snapshot_not_found": 404, "snapshot_not_ready": 409, "snapshot_exists": 409,
              "snapshot_in_use": 409, "not_deployed": 409, "secrets_key_missing": 400,
              "snapshot_too_large": 413, "snapshots_dir_unwritable": 500}.get(e.code, 422)
    return HTTPException(status_code=status, detail={"code": e.code, **e.extra})


def _deploy_target(env: Environment) -> SshTargetConfig:
    settings = get_settings()
    if not vault.is_configured(settings):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    cfg = targets.ssh_config_for(env.target_id, settings)
    if cfg is None:
        raise HTTPException(status_code=400, detail={"code": "target_not_configured"})
    return cfg


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
                  restore_dump: str | None = None, publish: bool = False) -> dict:
    env_name = env.name           # read now: a lock conflict rolls the session back
    snapshot_id = snapshot.id if snapshot is not None else None
    snapshot_name = snapshot.name if snapshot is not None else None
    try:
        dep = await pipeline.create_deployment(db, env, mode=mode, git_ref=git_ref, sha=sha,
                                               actor_id=actor.user.person_id,
                                               start_step=start_step, retry_of=retry_of,
                                               snapshot_id=snapshot_id,
                                               restore_dump=restore_dump, publish=publish)
    except pipeline.DeployInProgress:
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"}) from None
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
                         mode="publish", git_ref=env.git_ref, sha=env.current_sha)


@router.post("/environments/{name}/deployments", status_code=201)
async def start_deployment(name: str, body: DeploymentIn, request: Request, db: DbSession,
                           actor: AuthContext = require_permission("deploy", "add")):
    _require_mode(actor, body.mode)
    env = await _environment(db, name)
    if body.mode in GATED_MODES and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if body.snapshot_id is not None and body.mode != "reset":
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
    if (body.backup is not None) != (body.mode == "restore_dump"):
        raise HTTPException(status_code=422, detail={"code": "backup_invalid"})
    if body.mode == "restore_dump":
        if not environments.valid_backup_name(body.backup):
            raise HTTPException(status_code=422, detail={"code": "backup_invalid"})
        if body.git_ref is not None:        # it deploys the running commit
            raise HTTPException(status_code=422, detail={"code": "git_ref_not_allowed"})
    if body.mode in ("publish", "teardown") and body.git_ref is not None:
        raise HTTPException(status_code=422, detail={"code": "git_ref_not_allowed"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    if body.mode == "publish":
        return await _start_publish(db, env, request, actor)
    cfg = _deploy_target(env)
    if body.mode == "teardown":
        await _require_integrations(db, env, teardown=True)
        await _pinned(db, cfg)
        return await _launch(db, env, request, actor, action="deploy.deployment_start",
                             mode="teardown", git_ref=env.git_ref, sha=env.current_sha or "")
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
        await _pinned(db, cfg)
        return await _launch(db, env, request, actor, action="deploy.deployment_start",
                             mode="restore_dump", git_ref=env.current_sha,
                             sha=env.current_sha, restore_dump=body.backup,
                             publish=env.publish)
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
                         publish=env.publish)


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
    if dep.mode in GATED_MODES and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    latest = await serialize.latest_deployment(db, env.id)
    if latest is None or latest.id != dep.id:
        raise HTTPException(status_code=409, detail={"code": "retry_not_latest"})
    stopped = await _stopped_step(db, dep.id)
    if stopped is None:
        raise HTTPException(status_code=409, detail={"code": "not_retryable"})
    from_step = body.from_step or stopped
    # Whether it restored a snapshot: its own step rows say so even after the
    # snapshot was deleted (snapshot_id is then NULL).
    restoring = dep.mode in ("update", "reset") and await _has_step(db, dep.id, "restore")
    plan = plan_for(dep.mode, restore=restoring, publish=dep.publish)
    if from_step not in [s.number for s in plan] or from_step > stopped:
        raise HTTPException(status_code=422, detail={"code": "from_step_invalid"})
    # The Publish switch as it is now: a retry never publishes an environment
    # whose switch was turned off since. A data retry drops steps 12–14; one
    # that would start at them (or a publish job's retry) is refused.
    publishing = dep.publish and env.publish
    if not env.publish and (dep.mode == "publish" or (
            dep.publish and from_step >= STEPS_BY_KEY["dns"].number)):
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
    if dep.mode == "publish":
        if not vault.is_configured(get_settings()):
            raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    else:
        cfg = _deploy_target(env)
        await _pinned(db, cfg)
    if dep.mode == "teardown":
        await _require_integrations(db, env, teardown=True)
    elif dep.mode == "publish" or publishing:
        await _require_integrations(db, env)
    return await _launch(db, env, request, actor, action="deploy.deployment_retry",
                         mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                         start_step=from_step, retry_of=dep.id, snapshot=snapshot,
                         restore_dump=dep.restore_dump, publish=publishing)


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
    if body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    latest = await serialize.latest_deployment(db, env.id)
    if latest is None or latest.id != dep.id:
        raise HTTPException(status_code=409, detail={"code": "rollback_not_latest"})
    dump = PurePosixPath(dep.dump_path).name
    if not environments.valid_backup_name(dump):
        raise HTTPException(status_code=409, detail={"code": "rollback_unavailable"})
    cfg = _deploy_target(env)
    await _pinned(db, cfg)
    if env.publish:
        await _require_integrations(db, env)
    return await _launch(db, env, request, actor, action="deploy.deployment_rollback",
                         mode="rollback", git_ref=dep.previous_sha, sha=dep.previous_sha,
                         restore_dump=dump, publish=env.publish)


@router.get("/environments/{name}/backups")
async def list_backups(name: str, db: DbSession,
                       actor: AuthContext = require_permission("deploy", "view")):
    """The environment's pre-deploy dumps, read over SSH (newest first)."""
    env = await _environment(db, name)
    cfg = targets.ssh_config_for(env.target_id, get_settings())
    if cfg is None:
        raise HTTPException(status_code=400, detail={"code": "target_not_configured"})
    try:
        rows = await environments.list_backups(db, cfg, env)
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None
    return {"backups": rows}


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
    cfg = _deploy_target(env)
    await _pinned(db, cfg)
    try:
        snap = await snapshots.begin_take(db, get_settings(), env, name=body.name,
                                          notes=body.notes, actor_id=actor.user.person_id)
    except snapshots.SnapshotError as e:
        await db.rollback()
        raise _snapshot_http(e) from None
    dep = await _launch(db, env, request, actor, action="deploy.snapshot_take",
                        mode="snapshot", git_ref=env.git_ref, sha=env.current_sha,
                        snapshot=snap)
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
