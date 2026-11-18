"""The sign-in bridge: the main API's authorize answer becomes a Principal,
and the permission deps turn it into 401/403/423/503 answers."""

import json
import logging
import uuid
from typing import Annotated

import httpx
import pytest
from fastapi import Depends, Request
from httpx import ASGITransport, AsyncClient

from .fake_main_api import MAIN_API_URL, PERSON_ID, FakeClock, FakeMainApi

STAFF = {"Authorization": "Bearer tok-staff"}


@pytest.fixture
def fake():
    return FakeMainApi()


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def main_api(fake, clock):
    from serversherpa_devices.auth.main_api import MainApiClient
    from serversherpa_devices.config import get_settings

    return MainApiClient.from_settings(get_settings(), transport=fake.transport(), clock=clock)


@pytest.fixture
async def http(main_api):
    """The app with test-only routes, the main API swapped for the fake."""
    from serversherpa_devices.api.app import create_app
    from serversherpa_devices.auth.deps import (
        client_ip,
        current_principal,
        kiosk_principal,
        require,
    )
    from serversherpa_devices.auth.main_api import Principal, get_main_api

    app = create_app()

    def out(p: Principal) -> dict:
        return {"person_id": str(p.person_id), "client": p.client,
                "actions": sorted(p.actions)}

    @app.get("/api/_whoami")
    async def whoami(p: Annotated[Principal, Depends(current_principal)]):
        return out(p)

    @app.api_route("/api/_view", methods=["GET", "POST"])
    async def view(p: Annotated[Principal, Depends(require("view"))]):
        return out(p)

    @app.post("/api/_add")
    async def add(p: Annotated[Principal, Depends(require("add"))]):
        return out(p)

    @app.get("/api/_kiosk")
    async def kiosk(p: Annotated[Principal, Depends(kiosk_principal)]):
        return out(p)

    @app.get("/api/_ip")
    async def ip(request: Request):
        return {"ip": client_ip(request)}

    app.dependency_overrides[get_main_api] = lambda: main_api
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://testserver") as c:
        yield c
    await main_api.aclose()


def _code(r: httpx.Response) -> str:
    return r.json()["detail"]["code"]


async def test_missing_bearer_401(http, fake):
    r = await http.get("/api/_whoami")
    assert r.status_code == 401
    assert _code(r) == "unauthenticated"
    assert fake.authorize_route.call_count == 0

    fake.revoked()
    r = await http.get("/api/_whoami", headers={"Authorization": "Bearer ended"})
    assert r.status_code == 401
    assert _code(r) == "unauthenticated"


async def test_staff_view_ok_add_forbidden(http, fake):
    r = await http.get("/api/_whoami", headers=STAFF)
    assert r.status_code == 200
    assert r.json() == {"person_id": str(PERSON_ID), "client": "portal", "actions": ["view"]}

    assert (await http.get("/api/_view", headers=STAFF)).status_code == 200
    r = await http.post("/api/_add", headers=STAFF)
    assert r.status_code == 403
    assert _code(r) == "forbidden"

    fake.as_admin()
    admin = {"Authorization": "Bearer tok-admin"}
    assert (await http.post("/api/_add", headers=admin)).status_code == 200


async def test_kiosk_session_blocked_from_portal_routes(http, fake):
    fake.as_kiosk()
    kiosk = {"Authorization": "Bearer tok-kiosk"}
    for method, path in (("GET", "/api/_view"), ("POST", "/api/_add")):
        r = await http.request(method, path, headers=kiosk)
        assert r.status_code == 403, path
        assert _code(r) == "kiosk_session", path
    # The kiosk route takes kiosk sessions...
    r = await http.get("/api/_kiosk", headers=kiosk)
    assert r.status_code == 200
    assert r.json()["client"] == "kiosk"


async def test_kiosk_route_takes_portal_view_only(http, fake):
    assert (await http.get("/api/_kiosk", headers=STAFF)).status_code == 200
    fake.as_staff(actions=[])
    r = await http.get("/api/_kiosk", headers={"Authorization": "Bearer tok-nobody"})
    assert r.status_code == 403
    assert _code(r) == "forbidden"


async def test_password_change_required_403(http, fake):
    fake.as_admin(password_change_required=True)
    r = await http.get("/api/_view", headers=STAFF)
    assert r.status_code == 403
    assert _code(r) == "password_change_required"
    # Signed in still answers: the web app needs to know who to send to the change.
    assert (await http.get("/api/_whoami", headers=STAFF)).status_code == 200


async def test_read_only_blocks_writes_not_reads(http, fake):
    fake.as_admin(read_only=True, read_only_message="Maintenance until 18:00.")
    assert (await http.get("/api/_view", headers=STAFF)).status_code == 200
    for path in ("/api/_view", "/api/_add"):
        r = await http.post(path, headers=STAFF)
        assert r.status_code == 423, path
        assert r.json()["detail"] == {"code": "read_only_mode",
                                      "message": "Maintenance until 18:00."}


async def test_main_api_down_503(http, fake, caplog):
    caplog.set_level(logging.WARNING)
    fake.authorize_error(500)
    r = await http.get("/api/_whoami", headers=STAFF)
    assert r.status_code == 503
    assert _code(r) == "main_api_unavailable"

    fake.authorize_unreachable()
    r = await http.get("/api/_whoami", headers=STAFF)
    assert r.status_code == 503
    assert _code(r) == "main_api_unavailable"
    assert "tok-staff" not in caplog.text


@pytest.mark.parametrize("status,code", [(401, "bad_service_token"), (503, "internal_disabled")])
async def test_service_token_problems_are_unavailable(http, fake, caplog, status, code):
    """A configuration error, not the user's fault: 503, never a sign-in prompt."""
    caplog.set_level(logging.WARNING)
    fake.authorize_error(status, code)
    r = await http.get("/api/_whoami", headers=STAFF)
    assert r.status_code == 503
    assert _code(r) == "main_api_unavailable"
    assert str(status) in caplog.text
    assert "test-service-token" not in caplog.text


async def test_401_is_not_cached(main_api, fake):
    fake.revoked()
    assert await main_api.authorize("tok-a") is None
    fake.as_staff()
    principal = await main_api.authorize("tok-a")
    assert principal is not None and principal.person_id == PERSON_ID
    assert fake.authorize_route.call_count == 2


async def test_errors_are_not_cached(main_api, fake):
    from serversherpa_devices.auth.main_api import MainApiUnavailable

    fake.authorize_error(502)
    with pytest.raises(MainApiUnavailable):
        await main_api.authorize("tok-a")
    fake.as_staff()
    assert await main_api.authorize("tok-a") is not None
    assert fake.authorize_route.call_count == 2


async def test_cache_expires_after_ttl(main_api, fake, clock):
    first = await main_api.authorize("tok-a")
    assert first is not None
    clock.advance(59)
    assert await main_api.authorize("tok-a") == first
    assert fake.authorize_route.call_count == 1

    # Another bearer is its own entry.
    await main_api.authorize("tok-b")
    assert fake.authorize_route.call_count == 2

    clock.advance(2)
    fake.revoked()
    assert await main_api.authorize("tok-a") is None
    assert fake.authorize_route.call_count == 3


async def test_principal_fields(main_api, fake):
    fake.as_kiosk(read_only=True, read_only_message="Hold on.", password_change_required=True)
    p = await main_api.authorize("tok-k")
    assert p.person_id == PERSON_ID
    assert p.display_name == "Pat Example"
    assert p.client == "kiosk"
    assert p.kiosk_serial == "KIOSK-0001"
    assert p.actions == frozenset({"view", "add", "change", "delete"})
    assert p.password_change_required is True
    assert p.read_only is True
    assert p.read_only_message == "Hold on."
    assert p.can("delete") and not p.can("fly")


async def test_service_token_header_sent(main_api, fake):
    await main_api.authorize("tok-a")
    request = fake.authorize_route.calls.last.request
    assert str(request.url) == f"{MAIN_API_URL}/app-distribution/internal/authorize"
    assert request.headers["X-Devices-Service-Token"] == "test-service-token"
    assert request.headers["Authorization"] == "Bearer tok-a"

    actor = uuid.uuid4()
    await main_api.audit(actor=actor, entity_type="appdist_app", entity_id="app-1",
                         action="create", changes={"name": "Kiosk"}, ip="10.0.0.5")
    request = fake.audit_route.calls.last.request
    assert request.headers["X-Devices-Service-Token"] == "test-service-token"
    assert "Authorization" not in request.headers
    assert json.loads(request.content) == {
        "actor_person_id": str(actor), "entity_type": "appdist_app", "entity_id": "app-1",
        "action": "create", "changes": {"name": "Kiosk"}, "ip": "10.0.0.5"}


async def test_audit_failure_does_not_raise(main_api, fake, caplog):
    caplog.set_level(logging.WARNING)
    fake.audit_route.respond(500, json={"detail": "secret-body"})
    await main_api.audit(actor=None, entity_type="appdist_app", entity_id="a",
                         action="delete", changes={}, ip=None)
    assert "500" in caplog.text
    assert "secret-body" not in caplog.text

    caplog.clear()
    fake.audit_route.mock(side_effect=httpx.ConnectError("connection refused"))
    await main_api.audit(actor=None, entity_type="appdist_app", entity_id="a",
                         action="delete", changes={}, ip=None)
    assert "ConnectError" in caplog.text
    assert fake.audit_route.call_count == 2


async def test_client_ip(http):
    r = await http.get("/api/_ip", headers={"X-Forwarded-For": "203.0.113.9, 10.0.0.1"})
    assert r.json() == {"ip": "203.0.113.9"}
    r = await http.get("/api/_ip")
    assert r.json() == {"ip": "127.0.0.1"}
