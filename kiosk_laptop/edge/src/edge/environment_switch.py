"""Switching the laptop to another server (spec "Who can change what" and
"What a switch does"). The edge checks every rule itself; it doesn't trust
the browser to.

- `POST /edge/environment/unlock {password}`: 204 when the environment
  password is right, else 403 `wrong_password`. The chooser asks for it
  first; the switch checks it again.
- `POST /edge/environment {password, target, discard?}`, where `target` is
  `{"id"}` (an entry of the current list, `/edge/environments`) or
  `{"custom": {"api_url", "portal_url"}}`. 200 answers the new
  `/edge/environment` body.

The rules, in order: the password (403 `wrong_password`); the target
(422 `unknown_environment`, `bad_url` or `bad_request`); a custom URL on a
kiosk any server has registered needs the person signed in here to hold a
global role of rank 80 or higher (403 `custom_needs_super_admin`); unsent
work (outbox, RFID uploads, Dock passes) is 409 `outbox_not_empty
{pending}` unless `discard` is true, and discarding needs rank 60 or higher
(403 `discard_needs_admin`). Both ranks come live from `GET /auth/me` on the
current server, asked once per request: an offline sign-in, no sign-in, or
a refused check never passes, and an unreachable server is 503
`access_check_offline`. A named switch with nothing unsent needs only the
password, so a laptop stuck on a dead server can always be moved.

Then: the caller's cloud session is logged out (best effort); Wipe's
clearing runs, plus what is tied to the old server that Wipe keeps (the
kiosk config document and the alarm settings it mirrors, back to their
defaults; the station key and its paused flag); the choice is saved; the
cloud client is re-pointed; and the refresh cookie is deleted. The reader's
LAN pairing, the identity and the registered flag stay: no table holds an
id the old server issued beyond what Wipe and this clear.

Work under way meanwhile (a sync, an outbox drain, an upload) can't bring
the old server's data back: its answers arrive after the re-point as
ServerChanged and are dropped (edge/upstream.py). The wipe, the save and
the re-point's client swap run with no await between them, so nothing is
taken from the old server after the wipe. One switch at a time."""

import asyncio
import hmac
import logging
from dataclasses import dataclass

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from edge.deps import ADMIN_RANK, current_session, err, json_object
from edge.environment_store import Current, clean_url, ever_registered, save_current
from edge.rfid import station_key
from edge.routes.edge import environment_body, unsent_count, wipe_move_data
from edge.sessions import EdgeSession
from edge.upstream import CloudOffline

log = logging.getLogger("edge.environment_switch")

PASSWORD = "cumulus"  # in the source on purpose: a speed bump (spec "Who can change what")
SUPER_ADMIN_RANK = 80  # developer, founder, super_admin: the API's ensure_super_admin
ME_PATH = "/auth/me"
MAX_BODY = 4096

router = APIRouter(prefix="/edge")


@dataclass(frozen=True)
class Access:
    max_rank: int
    is_global: bool


def _lock(st) -> asyncio.Lock:
    found = getattr(st, "environment_lock", None)
    if found is None:
        found = st.environment_lock = asyncio.Lock()
    return found


def _password_ok(body: dict) -> bool:
    given = body.get("password")
    return isinstance(given, str) and hmac.compare_digest(given.encode(), PASSWORD.encode())


async def _target(st, raw) -> Current:
    if not isinstance(raw, dict) or len(raw) != 1:
        raise err(422, "bad_request")
    if "id" in raw:
        envs, _source = await st.env_list.current()
        env = next((e for e in envs if e.id == raw["id"]), None)
        if env is None:
            raise err(422, "unknown_environment")
        return Current.named(env)
    if "custom" in raw:
        custom = raw["custom"]
        api_url = clean_url(custom.get("api_url")) if isinstance(custom, dict) else None
        portal_url = clean_url(custom.get("portal_url")) if isinstance(custom, dict) else None
        if api_url is None or portal_url is None:
            raise err(422, "bad_url")
        return Current.custom(api_url, portal_url)
    raise err(422, "bad_request")


def _int(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


async def _live_access(st, session: EdgeSession | None) -> Access | None:
    """The signed-in person's rank and global scope, live from the current
    server; None when there is nobody to ask about (no sign-in, an offline
    one, no usable cloud session) or the server refuses to say."""
    if session is None or session.offline:
        return None
    try:
        resp = await st.upstream.as_person(session.person_id, "GET", ME_PATH)
    except CloudOffline:
        raise err(503, "access_check_offline") from None
    if resp is None or resp.status_code in (401, 403):
        return None
    if resp.status_code != 200:
        raise err(503, "access_check_offline")
    try:
        data = resp.json()
        rank = _int(data.get("max_rank"))
        scope = data.get("scope")
        is_global = isinstance(scope, dict) and scope.get("global") is True
    except (ValueError, AttributeError):
        return None
    return Access(rank, is_global) if rank is not None else None


async def _sign_out(st, session: EdgeSession | None) -> None:
    """Best effort: log the caller's cloud session out of the old server."""
    if session is None or not st.upstream.has_session(session.person_id):
        return
    st.upstream.mark_ending(session.person_id)
    try:
        await st.upstream.end_session(session.person_id)
    except Exception as exc:  # noqa: BLE001 — offline (or anything) never stops a switch
        log.info("old server sign-out skipped: %s", type(exc).__name__)


def _clear_server_ties(store) -> None:
    """What Wipe keeps that belongs to the old server: the kiosk config
    document (the new server keeps its own) and the alarm settings it
    mirrors, both back to their defaults, and the station key with its
    paused flag and armed Time Clock screens."""
    with store.tx() as c:
        c.execute("DELETE FROM device_config")
        c.execute("DELETE FROM alarm_settings")
    station_key.clear(store)


@router.post("/environment/unlock", status_code=204)
async def unlock(request: Request) -> Response:
    body = await json_object(request, max_bytes=MAX_BODY)
    if not _password_ok(body):
        raise err(403, "wrong_password")
    return Response(status_code=204)


@router.post("/environment")
async def switch(request: Request) -> JSONResponse:
    st = request.app.state
    body = await json_object(request, max_bytes=MAX_BODY)
    if not _password_ok(body):
        raise err(403, "wrong_password")
    discard = body.get("discard", False)
    if not isinstance(discard, bool):
        raise err(422, "bad_request")
    target = await _target(st, body.get("target"))
    async with _lock(st):
        session = current_session(request)  # after any switch ahead of this one
        pending = unsent_count(st)
        custom_gate = target.kind == "custom" and ever_registered(st.settings.data_dir)
        discard_gate = bool(pending) and discard
        access = await _live_access(st, session) if custom_gate or discard_gate else None
        if custom_gate and not (access and access.is_global
                                and access.max_rank >= SUPER_ADMIN_RANK):
            raise err(403, "custom_needs_super_admin")
        if pending and not discard:
            raise err(409, "outbox_not_empty", pending=pending)
        if discard_gate and not (access and access.max_rank >= ADMIN_RANK):
            raise err(403, "discard_needs_admin")

        await _sign_out(st, session)
        # from here to the client swap in repoint: no await
        wipe_move_data(st)
        _clear_server_ties(st.store)
        save_current(st.settings.data_dir, target)
        st.environment = target
        await st.upstream.repoint(target.api_url)
        log.info("switched to %s", target.name)
    response = JSONResponse(environment_body(st))
    response.delete_cookie("ss_refresh", path="/auth")
    return response
