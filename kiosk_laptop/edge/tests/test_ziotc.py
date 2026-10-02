import logging
import ssl
import traceback

import httpx
import pytest
import respx

from edge.rfid import ziotc
from edge.rfid.ziotc import PASSWORDS, ReaderError, ZiotcClient, probe
from fake_reader import TOO_MANY_ENDPOINTS, FakeReader

IP = "10.10.48.200"


def make(reader: FakeReader, **kw) -> ZiotcClient:
    return ZiotcClient(IP, transport=reader.transport(), **kw)


def test_passwords_are_the_global_list_in_order():
    assert PASSWORDS == ("Cumulus$G0", "Cumulu$SG.", "33q44w40x5", "change")


def test_client_uses_https_no_verify_and_the_timeouts():
    client = ZiotcClient(IP)
    assert str(client._http.base_url) == f"https://{IP}"
    assert client._http.timeout.connect == 3.0
    assert client._http.timeout.read == 10.0
    pool = client._http._transport._pool
    assert pool._ssl_context.verify_mode == ssl.CERT_NONE


# ── sign-in ─────────────────────────────────────────────────────────

async def test_login_tries_passwords_in_order_and_returns_the_index():
    reader = FakeReader(password_index=2)
    client = make(reader)
    assert await client.login() == 2
    assert reader.login_attempts == [0, 1, 2]
    await client.aclose()


async def test_login_tries_password_first_before_the_rest():
    reader = FakeReader(password_index=3)
    client = make(reader, password_first=3)
    assert await client.login() == 3
    assert reader.login_attempts == [3]
    await client.aclose()


async def test_stale_password_first_falls_back_to_the_rest_in_order():
    reader = FakeReader(password_index=1)
    client = make(reader, password_first=2)
    assert await client.login() == 1
    assert reader.login_attempts == [2, 0, 1]
    await client.aclose()


async def test_out_of_range_password_first_is_ignored():
    reader = FakeReader(password_index=0)
    client = make(reader, password_first=9)
    assert await client.login() == 0
    assert reader.login_attempts == [0]


async def test_all_passwords_fail_is_reader_auth_failed():
    reader = FakeReader(password="not-on-our-list")
    with pytest.raises(ReaderError) as err:
        await make(reader).login()
    assert err.value.code == "reader_auth_failed"
    assert reader.login_attempts == [0, 1, 2, 3]


async def test_403_also_tries_the_next_password():
    with respx.mock(base_url=f"https://{IP}") as router:
        route = router.get("/cloud/localRestLogin")
        route.side_effect = [httpx.Response(403), httpx.Response(200, json={"message": "tok"})]
        client = ZiotcClient(IP)
        assert await client.login() == 1
        await client.aclose()


@pytest.mark.parametrize("style", ["json_message", "json_token", "text"])
async def test_token_accepted_from_message_token_or_plain_text(style):
    reader = FakeReader(login_style=style)
    client = make(reader)
    await client.login()
    assert (await client.version())["model"] == "FX9600"
    await client.aclose()


async def test_jwt_token_prefix_is_stripped():
    with respx.mock(base_url=f"https://{IP}") as router:
        router.get("/cloud/localRestLogin").respond(200, json={"message": "JWT Token: abc.def"})
        version = router.get("/cloud/version").respond(200, json={"model": "FX7500"})
        client = ZiotcClient(IP)
        await client.version()
        assert version.calls.last.request.headers["authorization"] == "Bearer abc.def"
        await client.aclose()


async def test_empty_token_is_reader_error():
    with respx.mock(base_url=f"https://{IP}") as router:
        router.get("/cloud/localRestLogin").respond(200, json={"message": ""})
        with pytest.raises(ReaderError) as err:
            await ZiotcClient(IP).login()
        assert err.value.code == "reader_error"


# ── calls ───────────────────────────────────────────────────────────

async def test_version_status_and_config_sign_in_on_demand():
    reader = FakeReader(password_index=1)
    client = make(reader)
    version = await client.version()
    assert version["serialNumber"] == "84248dee5721"
    assert version["cloudAgentApplication"] == "1.0.0"
    assert (await client.status())["radioConnection"] == "connected"
    config = await client.get_config()
    assert config["READER-GATEWAY"]["endpointConfig"]["data"]["event"]["connections"] == []
    assert reader.login_attempts == [0, 1]  # signed in once
    await client.aclose()


SECURE = {"URL": "http://10.0.0.5:8091/rfid/x/y",
          "security": {"verifyPeer": False, "verifyHost": False, "authenticationType": "NONE"}}


async def test_put_config_round_trips():
    reader = FakeReader()
    client = make(reader)
    config = await client.get_config()
    conn = {"type": "httpPost", "name": "ServerSherpa Kiosk 1234 (Dock)",
            "options": {"URL": "http://10.0.0.5:8091/rfid/x/y",
                        "security": {"verifyPeer": False, "verifyHost": False,
                                     "authenticationType": "NONE"}}}
    gateway = config["READER-GATEWAY"]
    gateway["endpointConfig"]["data"]["event"]["connections"].append(conn)
    assert await client.put_config({"READER-GATEWAY": gateway}) is None
    again = await client.get_config()
    assert again["READER-GATEWAY"]["endpointConfig"]["data"]["event"]["connections"] == [conn]
    await client.aclose()


async def test_put_config_over_the_endpoint_limit_is_reader_error_with_its_message():
    reader = FakeReader()
    client = make(reader)
    gateway = (await client.get_config())["READER-GATEWAY"]
    gateway["endpointConfig"]["data"]["event"]["connections"] = [
        {"type": "httpPost", "name": f"c{i}", "options": {}} for i in range(3)]
    with pytest.raises(ReaderError) as err:
        await client.put_config({"READER-GATEWAY": gateway})
    assert err.value.code == "reader_error"
    assert err.value.message == TOO_MANY_ENDPOINTS
    await client.aclose()


async def test_verify_mismatch_mode_keeps_the_old_config():
    reader = FakeReader(mode="verify_mismatch")
    client = make(reader)
    gateway = (await client.get_config())["READER-GATEWAY"]
    gateway["endpointConfig"]["data"]["event"]["connections"] = [{"type": "httpPost",
                                                                 "name": "x", "options": SECURE}]
    await client.put_config({"READER-GATEWAY": gateway})
    assert len(reader.puts) == 1
    again = await client.get_config()
    assert again["READER-GATEWAY"]["endpointConfig"]["data"]["event"]["connections"] == []
    await client.aclose()


async def test_expired_token_signs_in_again_once():
    reader = FakeReader(password_index=0)
    client = make(reader)
    await client.version()
    reader.expire_tokens()
    assert (await client.status())["temperature"] == 31
    assert reader.login_attempts == [0, 0]
    await client.aclose()


async def test_sign_in_remembers_the_winning_index_for_later_logins():
    reader = FakeReader(password_index=2)
    client = make(reader)
    await client.version()
    reader.expire_tokens()
    await client.status()
    assert reader.login_attempts == [0, 1, 2, 2]
    assert client.password_index == 2


# ── errors ──────────────────────────────────────────────────────────

async def test_not_iotc_is_reader_not_iotc():
    reader = FakeReader(mode="not_iotc")
    with pytest.raises(ReaderError) as err:
        await make(reader).login()
    assert err.value.code == "reader_not_iotc"


async def test_404_on_a_cloud_call_is_reader_not_iotc():
    reader = FakeReader()
    client = make(reader)
    await client.login()
    reader.fail_next["/cloud/status"] = (404, {"code": 7, "message": "/cloud/status is not a valid URI"})
    with pytest.raises(ReaderError) as err:
        await client.status()
    assert err.value.code == "reader_not_iotc"


async def test_unreachable_is_reader_unreachable():
    reader = FakeReader(mode="unreachable")
    with pytest.raises(ReaderError) as err:
        await make(reader).login()
    assert err.value.code == "reader_unreachable"


async def test_timeout_is_reader_unreachable():
    with respx.mock(base_url=f"https://{IP}") as router:
        router.get("/cloud/localRestLogin").mock(side_effect=httpx.ReadTimeout("slow"))
        with pytest.raises(ReaderError) as err:
            await ZiotcClient(IP).login()
        assert err.value.code == "reader_unreachable"


async def test_422_is_reader_error_with_the_reader_message():
    reader = FakeReader()
    client = make(reader)
    reader.fail_next["/cloud/version"] = (
        422, {"code": 1, "message": "Failed to get the Cloud Agent Version"})
    with pytest.raises(ReaderError) as err:
        await client.version()
    assert err.value.code == "reader_error"
    assert err.value.message == "Failed to get the Cloud Agent Version"


async def test_500_html_is_reader_error_with_a_generic_message():
    reader = FakeReader()
    client = make(reader)
    reader.fail_next["/cloud/status"] = (500, "<html><h1>Internal Server Error</h1></html>")
    with pytest.raises(ReaderError) as err:
        await client.status()
    assert err.value.code == "reader_error"
    assert "500" in err.value.message
    assert "<html>" not in err.value.message


async def test_500_on_login_stops_the_attempt():
    reader = FakeReader(password_index=3)
    reader.fail_next["/cloud/localRestLogin"] = (500, {"code": 1, "message": "busy"})
    with pytest.raises(ReaderError) as err:
        await make(reader).login()
    assert err.value.code == "reader_error"
    assert err.value.message == "busy"
    assert reader.login_attempts == []  # the middleware answered before the handler


# ── probe ───────────────────────────────────────────────────────────

async def test_probe_returns_the_reader():
    reader = FakeReader(password_index=1, model="FX7500", serial="SER123")
    found = await probe(IP, transport=reader.transport())
    assert found == {
        "ip": IP, "model": "FX7500", "serial": "SER123",
        "versions": {"readerApplication": "2.7.19.0", "radioFirmware": "2.1.14.0",
                     "cloudAgentApplication": "1.0.0"},
        "status": reader.status, "password_index": 1,
    }


async def test_probe_honors_password_first():
    reader = FakeReader(password_index=3)
    found = await probe(IP, transport=reader.transport(), password_first=3)
    assert found["password_index"] == 3
    assert reader.login_attempts == [3]


async def test_probe_drops_non_fx_and_non_iotc_hosts():
    assert await probe(IP, transport=FakeReader(model="ATR7000").transport()) is None
    assert await probe(IP, transport=FakeReader(mode="not_iotc").transport()) is None


async def test_probe_raises_auth_and_unreachable_unless_quiet():
    locked = FakeReader(password="elsewhere")
    with pytest.raises(ReaderError) as err:
        await probe(IP, transport=locked.transport())
    assert err.value.code == "reader_auth_failed"
    assert await probe(IP, transport=locked.transport(), quiet=True) is None
    dead = FakeReader(mode="unreachable")
    with pytest.raises(ReaderError) as err:
        await probe(IP, transport=dead.transport())
    assert err.value.code == "reader_unreachable"
    assert await probe(IP, transport=dead.transport(), quiet=True) is None


# ── passwords never leak ────────────────────────────────────────────

async def test_no_password_in_any_log_exception_or_repr(caplog):
    caplog.set_level(logging.DEBUG)
    texts: list[str] = []

    async def capture(coro):
        try:
            return await coro
        except ReaderError as exc:
            texts.extend([str(exc), repr(exc), exc.message,
                          "".join(traceback.format_exception(exc))])
            return None

    for reader in (FakeReader(password="elsewhere"), FakeReader(mode="unreachable"),
                   FakeReader(mode="not_iotc"), FakeReader(password_index=2)):
        client = make(reader)
        texts.append(repr(client))
        await capture(client.login())
        await capture(client.version())
        texts.append(repr(client))
        texts.append(str(vars(client)))
        await client.aclose()
        await capture(probe(IP, transport=reader.transport()))

    with respx.mock(base_url=f"https://{IP}") as router:
        router.get("/cloud/localRestLogin").mock(side_effect=httpx.ConnectTimeout("t"))
        await capture(ZiotcClient(IP).login())

    texts.append(caplog.text)
    blob = "\n".join(texts)
    assert "reader_auth_failed" in blob and "reader_unreachable" in blob
    for password in PASSWORDS:
        assert password not in blob
    assert ziotc.USERNAME == "admin"


@pytest.mark.parametrize("field", ["verifyPeer", "verifyHost", "authenticationType"])
async def test_fake_reader_requires_the_full_http_post_security(field):
    reader = FakeReader()
    client = make(reader)
    gateway = (await client.get_config())["READER-GATEWAY"]
    security = {k: v for k, v in SECURE["security"].items() if k != field}
    gateway["endpointConfig"]["data"]["event"]["connections"] = [
        {"type": "httpPost", "name": "x", "options": {**SECURE, "security": security}}]
    with pytest.raises(ReaderError) as err:
        await client.put_config({"READER-GATEWAY": gateway})
    assert err.value.code == "reader_error" and field in err.value.message
    assert get_conns(reader) == []
    await client.aclose()


def get_conns(reader):
    return reader.config["READER-GATEWAY"]["endpointConfig"]["data"]["event"]["connections"]
