"""Sign-in through the edge. Online, the cloud decides and the edge
ADOPTS the result: it keeps the cloud tokens server-side (encrypted, per
person) and hands the browser its own edge session in the same SessionOut
shape. Offline, the edge decides from what it cached. The cloud's error
codes reach the browser unchanged."""

import asyncio
from datetime import datetime
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Cookie, Request, Response
from fastapi.responses import JSONResponse

from edge import offline, outbox, sessions
from edge.config import Settings
from edge.deps import err
from edge.upstream import REFRESH_COOKIE, CloudOffline, refresh_cookie_from

router = APIRouter()


def set_refresh_cookie(response: Response, settings: Settings, token: str,
                       expires_at: str) -> None:
    response.set_cookie(REFRESH_COOKIE, token, expires=datetime.fromisoformat(expires_at),
                        httponly=True, secure=settings.secure_cookies, samesite="lax",
                        path="/auth")


def _clear_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path="/auth")


def passthrough(resp: httpx.Response) -> Response:
    return Response(content=resp.content, status_code=resp.status_code,
                    media_type=resp.headers.get("content-type", "application/json"))


def adopt(state, resp: httpx.Response, data: dict) -> tuple[dict, str]:
    person_id = str(data["person"]["id"])
    cloud_refresh = refresh_cookie_from(resp)
    if cloud_refresh:
        state.upstream.save_session(person_id, refresh_token=cloud_refresh,
                                    access_token=data["access_token"],
                                    expires_in=data["expires_in"])
        if outbox.release_waiting(state.store, person_id):
            state.outbox_wake.set()
    return sessions.issue(state.store, state.keys, template=sessions.template_from(data),
                          offline=False, expires_at=data["session_expires_at"])


def _session_response(state, out: dict, refresh_token: str) -> JSONResponse:
    response = JSONResponse(out)
    set_refresh_cookie(response, state.settings, refresh_token, out["session_expires_at"])
    return response


def _offline_session(state, template: dict) -> JSONResponse:
    out, refresh_token = sessions.issue(state.store, state.keys, template=template,
                                        offline=True, expires_at=sessions.offline_expiry())
    return _session_response(state, out, refresh_token)


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise err(422, "bad_request") from None
    if not isinstance(body, dict):
        raise err(422, "bad_request")
    return body


@router.post("/auth/login")
async def login(request: Request) -> Response:
    st = request.app.state
    body = await _json_body(request)
    body["client"] = "kiosk"
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    try:
        resp = await st.upstream.request("POST", "/auth/login", json=body)
    except CloudOffline:
        key = f"login:{email}"
        if offline.too_many_failures(st.store, key):
            raise err(423, "account_locked") from None
        template = await asyncio.to_thread(
            offline.check_login, st.store, email, password, st.settings.offline_login_days)
        if template is None:
            offline.record_failure(st.store, key)
            raise err(401, "invalid_credentials") from None
        return _offline_session(st, template)
    if resp.status_code == 200:
        data = resp.json()
        if data.get("status") != "ok":
            offline.forget_login(st.store, email)  # a password-only verifier must not outlive 2FA
            return JSONResponse(data)  # 2FA challenge: the kiosk shows its message
        out, refresh_token = adopt(st, resp, data)
        await asyncio.to_thread(offline.cache_login, st.store, email, password,
                                sessions.template_from(data))
        return _session_response(st, out, refresh_token)
    if resp.status_code in (401, 403):
        offline.forget_login(st.store, email)
    return passthrough(resp)


@router.post("/auth/totp/verify")
async def totp_verify(request: Request) -> Response:
    st = request.app.state
    await _json_body(request)
    headers = {"content-type": "application/json"}
    if request.headers.get("authorization"):
        headers["authorization"] = request.headers["authorization"]
    try:
        resp = await st.upstream.request("POST", "/auth/totp/verify",
                                         content=await request.body(), headers=headers)
    except CloudOffline:
        raise err(503, "edge_offline") from None
    if resp.status_code == 200:
        data = resp.json()
        if data.get("status") == "ok":
            out, refresh_token = adopt(st, resp, data)
            return _session_response(st, out, refresh_token)
    return passthrough(resp)


@router.post("/kiosk/move-login")
async def move_login(request: Request) -> Response:
    st = request.app.state
    body = await _json_body(request)
    password = str(body.get("password", ""))
    try:
        resp = await st.upstream.request("POST", "/kiosk/move-login", json=body)
    except CloudOffline:
        if offline.too_many_failures(st.store, "move"):
            raise err(429, "move_login_rate_limited") from None
        template = await asyncio.to_thread(offline.check_move_password, st.store, password)
        if template is None:
            offline.record_failure(st.store, "move")
            raise err(401, "invalid_move_password") from None
        return _offline_session(st, template)
    if resp.status_code == 200:
        out, refresh_token = adopt(st, resp, resp.json())
        return _session_response(st, out, refresh_token)
    return passthrough(resp)


@router.post("/kiosk/pair/{code}/poll")
async def pair_poll(code: str, request: Request) -> Response:
    st = request.app.state
    try:
        resp = await st.upstream.request("POST", f"/kiosk/pair/{quote(code, safe='')}/poll",
                                         content=await request.body(),
                                         headers={"content-type": "application/json"})
    except CloudOffline:
        raise err(503, "edge_offline") from None
    if resp.status_code == 200:
        data = resp.json()
        if data.get("status") == "approved" and data.get("session"):
            out, refresh_token = adopt(st, resp, data["session"])
            response = JSONResponse({**data, "session": out})
            set_refresh_cookie(response, st.settings, refresh_token, out["session_expires_at"])
            return response
    return passthrough(resp)


@router.post("/auth/refresh")
async def refresh(request: Request, ss_refresh: str | None = Cookie(None)) -> Response:
    st = request.app.state
    got = sessions.refresh(st.store, st.keys, ss_refresh) if ss_refresh else None
    if got is None:
        response = JSONResponse({"detail": {"code": "invalid_refresh"}}, status_code=401)
        _clear_cookie(response)
        return response
    out, refresh_token = got
    return _session_response(st, out, refresh_token)


@router.post("/auth/logout", status_code=204)
async def logout(request: Request, ss_refresh: str | None = Cookie(None)) -> Response:
    st = request.app.state
    ended = sessions.revoke(st.store, ss_refresh) if ss_refresh else None
    if ended and not sessions.has_live_session(st.store, ended.person_id):
        # end the cloud session only once this person's queued work has gone up
        st.upstream.mark_ending(ended.person_id)
        st.outbox_wake.set()
    response = Response(status_code=204)
    _clear_cookie(response)
    return response
