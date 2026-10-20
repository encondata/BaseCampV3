"""/edge/timeclock/* — the Time Clock station's signed-out screen (kiosk
time clock station spec §6, with the plan-time display-cookie adjustment).

`GET /station` is public and says whether the laptop can run the time
clock (never the key or the serial). `POST /arm`, as a signed-in person,
hands this browser the display cookie (`edge.timeclock`). Everything else
answers only an armed display (403 `not_timeclock_display`): the cached
people list, and a person's status, clock in and clock out forwarded to
the portal's `/kiosk/station/timeclock/*` under the station key with the
laptop's serial. The portal's status and JSON body come back as they are,
so the browser sees its `{"detail": {"code": ...}}`; no key is 409
`station_not_ready`, an unreachable portal 503 `edge_offline`."""

import json
import uuid

from fastapi import APIRouter, Depends, Request, Response

from edge import laptop_setup, timeclock
from edge.deps import err, require_session
from edge.rfid import station_key
from edge.routes.auth import passthrough
from edge.sessions import EdgeSession
from edge.sync import PEOPLE
from edge.upstream import CloudOffline

router = APIRouter(prefix="/edge/timeclock")

STATUS_PATH = "/kiosk/station/timeclock/{person_id}"
CLOCK_IN_PATH = "/kiosk/station/timeclock/clock-in"
CLOCK_OUT_PATH = "/kiosk/station/timeclock/clock-out"


def require_display(request: Request) -> None:
    """The station's own armed screen: a known display cookie."""
    token = request.cookies.get(timeclock.DISPLAY_COOKIE)
    if not timeclock.is_display(request.app.state.store, token):
        raise err(403, "not_timeclock_display")


def _ready(store) -> bool:
    return station_key.is_timeclock_setup(store) and station_key.has_key(store)


@router.get("/station")
async def station(request: Request) -> dict:
    store = request.app.state.store
    is_timeclock = station_key.is_timeclock_setup(store)
    setup = laptop_setup.load(store) if is_timeclock else None
    paused = is_timeclock and station_key.is_paused(store)
    return {
        "timeclock": is_timeclock,
        "ready": _ready(store) and not paused,
        "paused": paused,
        "armed": timeclock.is_display(store, request.cookies.get(timeclock.DISPLAY_COOKIE)),
        "initiative_name": setup.get("initiative_name") if setup else None,
        "site_name": setup.get("site_name") if setup else None,
    }


@router.post("/arm", status_code=204)
async def arm(request: Request, _: EdgeSession = Depends(require_session)) -> Response:
    """Start Time Clock: this browser becomes the station's display."""
    st = request.app.state
    if not _ready(st.store):
        raise err(409, "not_timeclock_station")
    response = Response(status_code=204)
    response.set_cookie(timeclock.DISPLAY_COOKIE, timeclock.issue_display(st.store),
                        max_age=timeclock.DISPLAY_MAX_AGE_S, path=timeclock.DISPLAY_PATH,
                        httponly=True, secure=st.settings.secure_cookies, samesite="strict")
    return response


@router.get("/people", dependencies=[Depends(require_display)])
async def people(request: Request) -> Response:
    """The people list the last sync stored."""
    row = request.app.state.store.one("SELECT status, body FROM cache WHERE key = ?", (PEOPLE,))
    if row is None:
        raise err(503, "people_not_synced")
    return Response(row["body"], status_code=row["status"], media_type="application/json",
                    headers={"X-Edge-Cache": "hit"})


def _person(value) -> str:
    if not isinstance(value, str):
        raise err(422, "bad_person")
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise err(422, "bad_person") from None


async def _body_person(request: Request) -> str:
    try:
        body = json.loads(await request.body())
    except ValueError:
        body = None
    return _person(body.get("person_id") if isinstance(body, dict) else None)


async def _forward(request: Request, method: str, path: str, **kw) -> Response:
    st = request.app.state
    if not station_key.is_timeclock_setup(st.store):
        raise err(409, "station_not_ready")
    try:
        resp = await station_key.station_request(st, method, path, **kw)
    except CloudOffline:
        raise err(503, "edge_offline") from None
    if resp is None:
        raise err(409, "station_not_ready")
    return passthrough(resp)


@router.get("/status/{person_id}", dependencies=[Depends(require_display)])
async def status(request: Request, person_id: str) -> Response:
    person = _person(person_id)
    return await _forward(request, "GET", STATUS_PATH.format(person_id=person),
                          params={"serial": request.app.state.identity.serial})


@router.post("/clock-in", dependencies=[Depends(require_display)])
async def clock_in(request: Request) -> Response:
    person = await _body_person(request)
    return await _forward(request, "POST", CLOCK_IN_PATH,
                          json={"serial": request.app.state.identity.serial,
                                "person_id": person})


@router.post("/clock-out", dependencies=[Depends(require_display)])
async def clock_out(request: Request) -> Response:
    person = await _body_person(request)
    return await _forward(request, "POST", CLOCK_OUT_PATH,
                          json={"serial": request.app.state.identity.serial,
                                "person_id": person})
