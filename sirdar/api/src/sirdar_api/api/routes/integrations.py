"""Settings › Integrations: the Cloudflare and Nginx Proxy Manager
credentials Sirdar publishes environments with. Secrets are write-only: no
response, log line or audit row carries one (audits list the names of the
fields that changed), and the request models put no constraint on them, so
no validation error can describe one."""

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from sirdar_api.api.deps import AuthContext, DbSession, client_ip, require_permission
from sirdar_api.config import get_settings
from sirdar_api.deploy import ConnectFailed, cloudflare, integrations, npm, outbound
from sirdar_api.deploy.integrations import IntegrationError
from sirdar_api.services.audit import audit

log = logging.getLogger(__name__)

router = APIRouter(prefix="/deploy/integrations", tags=["deploy"])

Kind = Literal["cloudflare", "npm"]
TESTERS = {"cloudflare": cloudflare.test_connection, "npm": npm.test_connection}
UNEXPECTED_REASON = "Sirdar couldn't reach it."
_STATUS = {"secrets_key_missing": 400, "integration_unreadable": 409}


class CloudflareIn(BaseModel):
    zone: str = Field(default=integrations.DEFAULT_ZONE, max_length=253)
    public_ip: str = Field(max_length=45)
    token: str | None = None


class NpmIn(BaseModel):
    url: str = Field(max_length=300)
    identity: str = Field(max_length=254)
    letsencrypt_email: str = Field(default="", max_length=254)
    password: str | None = None


def _http(e: IntegrationError) -> HTTPException:
    return HTTPException(status_code=_STATUS.get(e.code, 422), detail={"code": e.code, **e.extra})


def _cloudflare_values(body: CloudflareIn) -> dict:
    return {"zone": body.zone, "public_ip": body.public_ip}


def _npm_values(body: NpmIn) -> dict:
    return {"url": body.url, "identity": body.identity,
            "letsencrypt_email": body.letsencrypt_email}


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


@router.delete("/{kind}", status_code=204)
async def remove_integration(kind: Kind, request: Request, db: DbSession,
                             actor: AuthContext = require_permission("deploy", "change")):
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
        result = await TESTERS[kind](cfg, transport=outbound.transports()[kind])
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
