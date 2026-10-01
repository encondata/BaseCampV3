"""Deploy page, step 1: targets, connection tests and trusted SSH host keys.
Responses never carry secrets; error reasons are our own copy."""

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from sirdar_api.api.deps import AuthContext, DbSession, client_ip, require_permission
from sirdar_api.config import get_settings
from sirdar_api.db.models import SshKnownHost
from sirdar_api.deploy import ConnectFailed, digitalocean, known_hosts, ssh, targets
from sirdar_api.services.audit import audit

router = APIRouter(prefix="/deploy", tags=["deploy"])

TargetId = Literal["aws", "gcp", "digitalocean", "ssh"]
DeployType = Literal["blue", "green", "dev", "beta"]


class ConnectIn(BaseModel):
    target: TargetId
    type: DeployType
    region: str | None = Field(default=None, pattern=r"^[a-z0-9-]{2,20}$")


class TrustIn(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    fingerprint: str = Field(min_length=1, max_length=200)


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
    return {"targets": targets.public_targets(get_settings()), "types": targets.DEPLOY_TYPES}


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

    async def record(ok: bool, code: str | None = None) -> None:
        changes: dict = {"target": body.target, "type": body.type, "ok": ok}
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

    target = targets.get_target(body.target)
    if target is None or not target.available:
        raise await fail(400, "target_unavailable")
    if not targets.is_configured(body.target, settings):
        raise await fail(400, "target_not_configured")

    try:
        if body.target == "digitalocean":
            result = await digitalocean.test_connection(settings, region=body.region)
        else:
            result = await ssh.test_connection(settings, db)
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
            "checks": result.as_dict()["checks"], "facts": result.facts}


@router.get("/known-hosts", response_model=list[KnownHostOut])
async def list_known_hosts(db: DbSession,
                           actor: AuthContext = require_permission("deploy", "view")):
    return [_known_host_out(row, name) for row, name in await known_hosts.list_hosts(db)]


@router.post("/known-hosts", response_model=KnownHostOut)
async def trust_host(body: TrustIn, request: Request, db: DbSession,
                     actor: AuthContext = require_permission("deploy", "change")):
    s = get_settings()
    if body.host != s.deploy_ssh_host.strip() or body.port != s.deploy_ssh_port:
        raise HTTPException(status_code=400, detail={"code": "not_configured_host"})
    try:
        row = await known_hosts.trust(db, body.host, body.port, body.fingerprint,
                                      actor.user.person_id, ip=client_ip(request))
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
    if not await known_hosts.forget(db, host, port, actor.user.person_id, ip=client_ip(request)):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    await db.commit()
    return Response(status_code=204)
