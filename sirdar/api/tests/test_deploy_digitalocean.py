import httpx
import pytest

from sirdar_api.deploy import ConnectFailed, digitalocean

from .test_scaffold import _settings

TOKEN = "dop_v1_TOKEN_SECRET_123"

ACCOUNT = {"account": {"email": "ops@example.com", "status": "active", "droplet_limit": 25,
                       "email_verified": True, "uuid": "u-1"}}
DROPLETS = {"droplets": [{"id": 1}], "meta": {"total": 7}}
REGIONS = {"regions": [{"slug": "nyc3", "available": True}, {"slug": "sfo1", "available": False}],
           "meta": {"total": 2}}


def _transport(*, status=200, regions=REGIONS, seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        if status != 200:
            return httpx.Response(status, json={"id": "unauthorized", "message": "Unable to auth"})
        path = request.url.path
        if path == "/v2/account":
            return httpx.Response(200, json=ACCOUNT)
        if path == "/v2/droplets":
            return httpx.Response(200, json=DROPLETS)
        if path == "/v2/regions":
            return httpx.Response(200, json=regions)
        return httpx.Response(404, json={"id": "not_found"})
    return httpx.MockTransport(handler)


def _checks(result):
    return {c.label: (c.status, c.value) for c in result.checks}


async def test_success_with_region():
    seen = []
    s = _settings(deploy_do_token=TOKEN, deploy_do_region="nyc3")
    result = await digitalocean.test_connection(s, transport=_transport(seen=seen))
    assert result.ok and result.target == "digitalocean"
    assert [(r.method, r.url.path, r.url.params.get("per_page")) for r in seen] == [
        ("GET", "/v2/account", None), ("GET", "/v2/droplets", "1"),
        ("GET", "/v2/regions", "200")]
    assert all(r.headers["authorization"] == f"Bearer {TOKEN}" for r in seen)
    assert str(seen[0].url).startswith("https://api.digitalocean.com/v2/")
    checks = _checks(result)
    assert checks["Account"] == ("pass", "ops@example.com · active")
    assert checks["Droplets"] == ("pass", "7 of 25")
    assert checks["Region"] == ("pass", "nyc3 available")
    assert result.facts == {"email": "ops@example.com", "status": "active", "droplet_limit": 25,
                            "droplet_count": 7, "region": "nyc3", "region_available": True}
    assert TOKEN not in repr(result.as_dict())


async def test_no_region_skips_region_call():
    seen = []
    result = await digitalocean.test_connection(_settings(deploy_do_token=TOKEN),
                                                transport=_transport(seen=seen))
    assert result.ok and [r.url.path for r in seen] == ["/v2/account", "/v2/droplets"]
    assert "Region" not in _checks(result) and "region" not in result.facts


async def test_missing_and_unavailable_region_warn():
    for region, value in (("ams9", "ams9 not found"), ("sfo1", "sfo1 not available")):
        result = await digitalocean.test_connection(
            _settings(deploy_do_token=TOKEN, deploy_do_region=region), transport=_transport())
        assert result.ok
        assert _checks(result)["Region"] == ("warn", value)
        assert result.facts["region_available"] is False


async def test_401_is_rejected_token():
    with pytest.raises(ConnectFailed) as exc:
        await digitalocean.test_connection(_settings(deploy_do_token=TOKEN),
                                           transport=_transport(status=401))
    assert exc.value.reason == "DigitalOcean rejected the API token."


async def test_other_http_error_is_sanitized():
    with pytest.raises(ConnectFailed) as exc:
        await digitalocean.test_connection(_settings(deploy_do_token=TOKEN),
                                           transport=_transport(status=503))
    assert exc.value.reason == "DigitalOcean answered with HTTP 503."


async def test_timeout_and_network_errors_are_unreachable():
    for err in (httpx.ReadTimeout("timed out"), httpx.ConnectError(f"boom {TOKEN}")):
        def handler(request, err=err):
            raise err
        with pytest.raises(ConnectFailed) as exc:
            await digitalocean.test_connection(_settings(deploy_do_token=TOKEN),
                                               transport=httpx.MockTransport(handler))
        assert exc.value.reason == "Couldn't reach the DigitalOcean API."
        assert TOKEN not in str(exc.value) and exc.value.__cause__ is None


async def test_unexpected_body_is_connect_failed():
    def handler(request):
        return httpx.Response(200, text="<html>not json</html>")
    with pytest.raises(ConnectFailed) as exc:
        await digitalocean.test_connection(_settings(deploy_do_token=TOKEN),
                                           transport=httpx.MockTransport(handler))
    assert exc.value.reason == "DigitalOcean sent a response Sirdar didn't understand."


async def test_malformed_token_is_connect_failed():
    token = "dop_v1_tökén_SECRET"
    s = _settings(deploy_do_token=token)
    with pytest.raises(ConnectFailed) as exc:
        await digitalocean.test_connection(s)
    assert exc.value.reason in ("The DigitalOcean API token is malformed.",
                                "DigitalOcean rejected the API token.")
    assert "SECRET" not in exc.value.reason and exc.value.__cause__ is None


async def test_explicit_region_overrides_env_and_blank_skips():
    s = _settings(deploy_do_token=TOKEN, deploy_do_region="sfo1")
    result = await digitalocean.test_connection(s, region="nyc3", transport=_transport())
    assert _checks(result)["Region"] == ("pass", "nyc3 available")
