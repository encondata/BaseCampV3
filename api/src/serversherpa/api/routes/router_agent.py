"""POST /router-agent/report — the GL.iNet router agent's only endpoint.
No user session: a router proves itself with its WAN MAC + secret, and
nothing beyond identity is stored until an admin approves it
(services/router_agent.py). Not subject to read-only maintenance mode —
it never passes through the user-auth dependency that enforces it, and
reports are telemetry (same reasoning as /kiosk/printer-events)."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from serversherpa.api.deps import DbSession, rate_limit_ip
from serversherpa.api.schemas import RouterReportIn
from serversherpa.services.router_agent import (
    MAX_BODY_BYTES,
    MAX_DHCP_CLIENTS,
    MAX_VPN,
    AgentError,
    handle_report,
)

router = APIRouter(prefix="/router-agent", tags=["router-agent"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


@router.post("/report")
async def post_report(request: Request, db: DbSession) -> JSONResponse:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise _err(413, "payload_too_large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY_BYTES:
            raise _err(413, "payload_too_large")
        chunks.append(chunk)
    raw = b"".join(chunks)
    try:
        body = RouterReportIn.model_validate_json(raw)
    except ValidationError:
        raise _err(422, "bad_report") from None
    if ((body.dhcp_clients is not None and len(body.dhcp_clients) > MAX_DHCP_CLIENTS)
            or (body.vpn is not None and len(body.vpn) > MAX_VPN)):
        raise _err(413, "payload_too_large")
    try:
        state = await handle_report(db, body, rate_limit_ip(request))
    except AgentError as exc:
        raise _err(exc.status, exc.code) from None
    return JSONResponse({"state": state}, status_code=200 if state == "approved" else 202)
