import httpx
import pytest
import respx

from serversherpa_status.probes import probe


async def run(service):
    async with httpx.AsyncClient() as client:
        return await probe(client, service, 5)


@respx.mock
async def test_api_green_on_json_object(api_service):
    respx.get("http://api.test/system/status").respond(200, json={"read_only": False})
    r = await run(api_service)
    assert r.ok and r.detail == "" and isinstance(r.latency_ms, int)


@respx.mock
async def test_api_red_on_non_object_json(api_service):
    respx.get("http://api.test/system/status").respond(200, json=[1, 2])
    r = await run(api_service)
    assert not r.ok and r.detail == "unexpected response body"


@respx.mock
async def test_api_red_on_html(api_service):
    respx.get("http://api.test/system/status").respond(200, text="<html>proxy error</html>")
    r = await run(api_service)
    assert not r.ok and r.detail == "unexpected response body"


@respx.mock
async def test_api_red_on_500(api_service):
    respx.get("http://api.test/system/status").respond(500, json={"detail": "db down"})
    r = await run(api_service)
    assert not r.ok and r.detail == "HTTP 500" and isinstance(r.latency_ms, int)


@respx.mock
async def test_portal_green_when_spa_root_present(portal_service):
    respx.get("http://portal.test/").respond(200, text='<div id="root"></div>')
    assert (await run(portal_service)).ok


@respx.mock
async def test_portal_red_without_spa_root(portal_service):
    respx.get("http://portal.test/").respond(200, text="Welcome to nginx!")
    r = await run(portal_service)
    assert not r.ok and r.detail == "unexpected response body"


@respx.mock
async def test_kiosk_green_on_200(kiosk_service):
    respx.get("http://kiosk.test/config.js").respond(200, text="window.__KIOSK_CONFIG__ = {};")
    assert (await run(kiosk_service)).ok


@respx.mock
async def test_redirect_is_followed(kiosk_service):
    respx.get("http://kiosk.test/config.js").respond(301, headers={"Location": "http://kiosk.test/c.js"})
    respx.get("http://kiosk.test/c.js").respond(200, text="ok")
    assert (await run(kiosk_service)).ok


@respx.mock
async def test_timeout(kiosk_service):
    respx.get("http://kiosk.test/config.js").mock(side_effect=httpx.ConnectTimeout("slow"))
    r = await run(kiosk_service)
    assert r == type(r)(False, None, "timeout")


@respx.mock
async def test_connection_error(kiosk_service):
    respx.get("http://kiosk.test/config.js").mock(side_effect=httpx.ConnectError("refused"))
    r = await run(kiosk_service)
    assert not r.ok and r.latency_ms is None and r.detail == "connection error: ConnectError"
