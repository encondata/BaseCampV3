"""Deploy page, step 1: targets, connection tests and trusted SSH host keys.
Responses never carry secrets; error reasons are our own copy."""

import asyncio
import os
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from sirdar_api.api.deps import AuthContext, DbSession, client_ip, require_permission
from sirdar_api.config import get_settings
from sirdar_api.db.models import SshKnownHost
from sirdar_api.deploy import ConnectFailed, digitalocean, known_hosts, names, ssh, targets
from sirdar_api.deploy.ssh_targets import SavedSshTarget, TargetError
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


class SshTargetPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    host: str | None = Field(default=None, max_length=300)
    port: int | None = None
    user: str | None = Field(default=None, max_length=200)
    password: str | None = None
    key_path: str | None = Field(default=None, max_length=255)
    key_passphrase: str | None = None


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
            "passphrase_set": t.passphrase is not None}


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


_PATCH_ORDER = ("name", "host", "port", "user", "password", "key_path", "key_passphrase")


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
               "key_passphrase": (old.passphrase, new.passphrase)}
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
