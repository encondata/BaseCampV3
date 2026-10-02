import logging
import ssl
import traceback

import httpx
import pytest
import respx

from edge.rfid import ziotc
from edge.rfid.ziotc import PASSWORDS, ReaderError, ZiotcClient, probe
from fake_reader import TOO_MANY_ENDPOINTS, BATCHING_MISMATCH, FakeReader

IP = "10.10.48.200"


def make(reader: FakeReader, **kw) -> ZiotcClient:
    return ZiotcClient(IP, transport=reader.transport(), **kw)


def test_passwords_are_the_global_list_in_order():
    assert PASSWORDS == ("Cumulu$SG0", "Cumulus$G0", "Cumulu$SG.", "33q44w40x5", "change")


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
    assert reader.login_attempts == list(range(len(PASSWORDS)))


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
    assert await client.put_config({"READER-GATEWAY": in_step(gateway)}) is None
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
        await client.put_config({"READER-GATEWAY": in_step(gateway)})
    assert err.value.code == "reader_error"
    assert err.value.message == TOO_MANY_ENDPOINTS
    await client.aclose()


def in_step(gateway):
    """One global batching/retention entry per connection, as the reader requires."""
    count = len(gateway["endpointConfig"]["data"]["event"]["connections"])
    gateway["batching"] = [{"maxPayloadSizePerReport": 256000, "reportingInterval": 2000}] * count
    gateway["retention"] = [{"maxNumEvents": 150000}] * count
    return gateway


async def test_put_config_with_too_few_batching_entries_is_refused():
    reader = FakeReader()
    client = make(reader)
    gateway = (await client.get_config())["READER-GATEWAY"]
    gateway["endpointConfig"]["data"]["event"]["connections"] = [
        {"type": "httpPost", "name": "x", "options": SECURE}]
    with pytest.raises(ReaderError) as err:
        await client.put_config({"READER-GATEWAY": gateway})
    assert err.value.message == BATCHING_MISMATCH
    await client.aclose()


async def test_verify_mismatch_mode_keeps_the_old_config():
    reader = FakeReader(mode="verify_mismatch")
    client = make(reader)
    gateway = (await client.get_config())["READER-GATEWAY"]
    gateway["endpointConfig"]["data"]["event"]["connections"] = [{"type": "httpPost",
                                                                 "name": "x", "options": SECURE}]
    await client.put_config({"READER-GATEWAY": in_step(gateway)})
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


# ── probe ───────────────────────────────────────────────────────────

async def test_probe_returns_the_reader():
    reader = FakeReader(password_index=1, model="FX7500", serial="SER123")
    found = await probe(IP, transport=reader.transport())
    assert found == {
        "ip": IP, "scheme": "https", "port": 443, "model": "FX7500", "serial": "SER123",
        "versions": {"readerApplication": "2.7.19.0", "radioFirmware": "2.1.14.0",
                     "cloudAgentApplication": "1.0.0"},
        "status": {**reader.status, "radioActivity": "inactive"}, "password_index": 1,
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
        await client.put_config({"READER-GATEWAY": in_step(gateway)})
    assert err.value.code == "reader_error" and field in err.value.message
    assert get_conns(reader) == []
    await client.aclose()


def get_conns(reader):
    return reader.config["READER-GATEWAY"]["endpointConfig"]["data"]["event"]["connections"]


# ── final fix round: both ports, fingerprint before credentials ─────

from fake_reader import FakeNas  # noqa: E402


def test_client_takes_a_scheme_and_port():
    https = ZiotcClient(IP)
    plain = ZiotcClient(IP, scheme="http", port=80)
    odd = ZiotcClient(IP, scheme="https", port=8443)
    assert str(https._http.base_url) == f"https://{IP}"
    assert str(plain._http.base_url) == f"http://{IP}"
    assert str(odd._http.base_url) == f"https://{IP}:8443"
    with pytest.raises(ValueError):
        ZiotcClient(IP, scheme="ftp")


async def test_http_only_reader_on_port_80():
    reader = FakeReader(ports=(80,))
    found = await probe(IP, transport=reader.transport(), scheme="http", port=80)
    assert found["serial"] == "84248dee5721"
    assert (found["scheme"], found["port"]) == ("http", 80)
    with pytest.raises(ReaderError) as err:
        await probe(IP, transport=reader.transport())  # https 443: closed
    assert err.value.code == "reader_unreachable"


async def test_login_with_an_explicit_password_list_tries_only_those():
    reader = FakeReader(password_index=3)
    client = make(reader, passwords=[1])
    with pytest.raises(ReaderError) as err:
        await client.login()
    assert err.value.code == "reader_auth_failed"
    assert reader.login_attempts == [1]
    await client.aclose()


@pytest.mark.parametrize("kw", [{}, {"server": "Zebra FX9600"}, {"realm": "FX9600"}])
async def test_fingerprint_knows_a_zebra_reader_without_credentials(kw):
    reader = FakeReader(**kw)
    transport = reader.transport()
    assert await ziotc.fingerprint(IP, transport=transport) is True
    assert reader.login_attempts == []
    assert all("authorization" not in r.headers for r in transport.requests)


async def test_fingerprint_drops_a_generic_401_host_and_non_iotc():
    nas = FakeNas()
    assert await ziotc.fingerprint(IP, transport=nas.transport()) is False
    assert nas.credential_attempts == 0 and nas.requests >= 1
    assert await ziotc.fingerprint(IP, transport=FakeReader(mode="not_iotc").transport()) is False
    assert await ziotc.fingerprint(IP, transport=FakeReader(mode="unreachable").transport()) is False


def _resp(status, *, json=None, text=None, headers=None):
    return httpx.Response(status, json=json, text=text, headers=headers or {})


@pytest.mark.parametrize("login, version, expected", [
    # (b) ZIOTC: 401 on sign-in, ZIOTC's JSON error on /cloud/version
    (_resp(401), _resp(401, json={"code": 2, "message": "Unauthorized"}), True),
    (_resp(401, text="no"), _resp(403, json={"code": 2, "message": "Forbidden"}), True),
    # (a) the box names itself
    (_resp(401, headers={"www-authenticate": 'Basic realm="Zebra Reader"'}), None, True),
    (_resp(200, headers={"server": "IoT Connector"}), _resp(404, text="x"), True),
    # body text counts only alongside a /cloud/*-specific answer
    (_resp(403, text="Zebra IoT Connector"), _resp(403, json={"code": 2, "message": "Forbidden"}), True),
    (_resp(404, text="<title>FX7500 web console</title>"), None, False),
    (_resp(200, text="IoT Connector"), _resp(404, text="Not Found"), False),
    # Zebra label printers aren't readers
    (_resp(200, text="<title>Zebra Technologies ZT410</title>"),
     _resp(404, text="<p>Zebra Technologies</p>"), False),
    (_resp(401, text="Zebra Technologies", headers={"www-authenticate": 'Basic realm="ZebraNet"'}),
     _resp(401, text="Zebra Technologies", headers={"www-authenticate": 'Basic realm="ZebraNet"'}),
     False),
    # generic hosts
    (_resp(401, text="<h1>401</h1>", headers={"www-authenticate": 'Basic realm="NAS"'}),
     _resp(401, text="<h1>401</h1>", headers={"www-authenticate": 'Basic realm="NAS"'}), False),
    (_resp(401), _resp(401, text="Unauthorized"), False),
    (_resp(200, text="hello"), _resp(200, json={"code": 2, "message": "x"}), False),
    (_resp(404, text="Not Found"), _resp(404, text="Not Found"), False),
    (None, None, False),
    # "fx" inside another word isn't a mention
    (_resp(401, text="effxy firefox"), None, False),
])
def test_zebra_matcher(login, version, expected):
    assert ziotc.looks_like_ziotc(login, version) is expected


async def test_discover_needs_connect_without_a_remembered_index():
    reader = FakeReader()
    found = await ziotc.discover(IP, transport=reader.transport(), password_index=None)
    assert found == {"ip": IP, "scheme": "https", "port": 443, "model": None, "serial": None,
                     "needs_connect": True}
    assert reader.login_attempts == []


async def test_discover_tries_only_the_remembered_index():
    reader = FakeReader(password_index=3)
    found = await ziotc.discover(IP, transport=reader.transport(), password_index=1)
    assert found["needs_connect"] is True and found["serial"] is None
    assert reader.login_attempts == [1]
    reader.login_attempts.clear()
    found = await ziotc.discover(IP, transport=reader.transport(), password_index=3)
    assert reader.login_attempts == [3]
    assert found["needs_connect"] is False and found["serial"] == "84248dee5721"
    assert found["config"]["READER-GATEWAY"] and found["password_index"] == 3


async def test_discover_drops_non_candidates_with_zero_credentials():
    nas = FakeNas()
    assert await ziotc.discover(IP, transport=nas.transport(), password_index=0) is None
    assert nas.credential_attempts == 0
    assert await ziotc.discover(IP, transport=FakeReader(model="ATR7000").transport(),
                                password_index=3) is None


# Captured from a real FX9600 (10.10.48.119, 2026-10-02): unauthenticated
# answers are HTTP 500 with ZIOTC's JSON error, not 401.
_FX9600_MISSING_AUTH = {"code": -1, "message": "Authorization header missing!"}


def test_real_fx9600_unauthenticated_answer_is_a_candidate():
    login = _resp(500, json=_FX9600_MISSING_AUTH, headers={"server": "Apache"})
    version = _resp(500, json=_FX9600_MISSING_AUTH, headers={"server": "Apache"})
    assert ziotc.looks_like_ziotc(login, version) is True


@pytest.mark.parametrize("login, version", [
    # one path only, or a different message, isn't enough
    (_resp(500, json=_FX9600_MISSING_AUTH), None),
    (_resp(500, json=_FX9600_MISSING_AUTH), _resp(404, text="<html>Not Found</html>")),
    (_resp(500, json={"code": -1, "message": "Internal error"}),
     _resp(500, json={"code": -1, "message": "Internal error"})),
    # a generic server error page
    (_resp(500, text="Internal Server Error", headers={"server": "Apache"}),
     _resp(500, text="Internal Server Error", headers={"server": "Apache"})),
])
def test_other_500s_are_not_candidates(login, version):
    assert ziotc.looks_like_ziotc(login, version) is False


async def test_json_500_on_sign_in_tries_the_next_password():
    reader = FakeReader(password_index=1)
    reader.fail_next["GET /cloud/localRestLogin"] = (500, {"code": -1, "message": "Unauthorized"})
    client = make(reader)
    assert await client.login() == 1


async def test_html_500_on_sign_in_still_stops():
    reader = FakeReader(password_index=1)
    reader.fail_next["GET /cloud/localRestLogin"] = (500, "<html>Internal Server Error</html>")
    with pytest.raises(ReaderError) as err:
        await make(reader).login()
    assert err.value.code == "reader_error"


async def test_start_sends_do_not_persist_state():
    reader = FakeReader()
    async with make(reader) as client:
        await client.start()
        await client.stop()
        await client.start(persist=False)
    assert reader.starts == [{"doNotPersistState": False}, {"doNotPersistState": True}]
    assert reader.reading is True
