"""FCM HTTP v1 client: token minting/caching, payload shape, outcome mapping."""

from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from serversherpa.config import get_settings
from serversherpa.push.fcm import FcmClient

TOKEN_URI = "https://oauth2.example.test/token"
_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PRIVATE_PEM = _KEY.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
).decode()
_PUBLIC_PEM = _KEY.public_key().public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
)


def _account() -> dict:
    return {
        "project_id": "proj-1",
        "client_email": "svc@proj-1.iam.gserviceaccount.com",
        "private_key": _PRIVATE_PEM,
        "token_uri": TOKEN_URI,
    }


class Clock:
    def __init__(self, now: float = 1_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def _make(send_handler, clock=None):
    calls: list[httpx.Request] = []
    counter = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if str(request.url) == TOKEN_URI:
            counter["n"] += 1
            return httpx.Response(
                200, json={"access_token": f"at-{counter['n']}", "expires_in": 3600}
            )
        return send_handler(request)

    client = FcmClient(
        _account(),
        transport=httpx.MockTransport(handler),
        clock=clock or Clock(),
    )
    return client, calls


def _sends(calls):
    return [c for c in calls if str(c.url) != TOKEN_URI]


def _tokens(calls):
    return [c for c in calls if str(c.url) == TOKEN_URI]


async def test_token_claims_and_cache():
    clock = Clock()
    client, calls = _make(lambda r: httpx.Response(200, json={"name": "m"}), clock)
    assert (await client.send("tok", {"a": "1"}, high_priority=True)).outcome == "sent"
    assert (await client.send("tok", {"a": "1"}, high_priority=True)).outcome == "sent"
    assert len(_tokens(calls)) == 1  # cached

    form = parse_qs(_tokens(calls)[0].content.decode())
    assert form["grant_type"] == ["urn:ietf:params:oauth:grant-type:jwt-bearer"]
    claims = jwt.decode(
        form["assertion"][0],
        _PUBLIC_PEM,
        algorithms=["RS256"],
        audience="https://oauth2.googleapis.com/token",
        options={"verify_exp": False, "verify_iat": False},
    )
    assert claims["iss"] == claims["sub"] == _account()["client_email"]
    assert claims["scope"] == "https://www.googleapis.com/auth/firebase.messaging"
    assert claims["exp"] == claims["iat"] + 3600
    assert claims["iat"] == int(clock.now)

    # Inside the 300 s refresh window the token is replaced.
    clock.now += 3600 - 299
    await client.send("tok", {}, high_priority=False)
    assert len(_tokens(calls)) == 2
    assert _sends(calls)[-1].headers["authorization"] == "Bearer at-2"


async def test_send_payload_shape():
    client, calls = _make(lambda r: httpx.Response(200, json={}))
    await client.send("device-tok", {"k": "v"}, high_priority=True)
    await client.send("device-tok", {"k": "v"}, high_priority=False)
    first, second = _sends(calls)
    assert str(first.url) == "https://fcm.googleapis.com/v1/projects/proj-1/messages:send"
    assert first.headers["authorization"] == "Bearer at-1"
    assert json.loads(first.content) == {
        "message": {
            "token": "device-tok",
            "data": {"k": "v"},
            "android": {"priority": "HIGH"},
        }
    }
    assert json.loads(second.content)["message"]["android"]["priority"] == "NORMAL"


async def test_unregistered_is_token_dead():
    body = {
        "error": {
            "code": 404,
            "status": "NOT_FOUND",
            "details": [{"errorCode": "UNREGISTERED"}],
        }
    }
    client, _ = _make(lambda r: httpx.Response(404, json=body))
    assert (await client.send("tok", {}, high_priority=True)).outcome == "token_dead"

    bad = {
        "error": {
            "code": 400,
            "status": "INVALID_ARGUMENT",
            "message": "The registration token is not a valid FCM registration token",
        }
    }
    client, _ = _make(lambda r: httpx.Response(400, json=bad))
    assert (await client.send("tok", {}, high_priority=True)).outcome == "token_dead"

    other = {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "bad data"}}
    client, _ = _make(lambda r: httpx.Response(400, json=other))
    assert (await client.send("tok", {}, high_priority=True)).outcome == "fatal"


async def test_429_is_retry():
    client, _ = _make(lambda r: httpx.Response(429, json={}))
    assert (await client.send("t", {}, high_priority=True)).outcome == "retry"
    client, _ = _make(lambda r: httpx.Response(503, json={}))
    assert (await client.send("t", {}, high_priority=True)).outcome == "retry"


async def test_401_refreshes_once():
    state = {"n": 0}

    def handler(request):
        state["n"] += 1
        return httpx.Response(401, json={}) if state["n"] == 1 else httpx.Response(200, json={})

    client, calls = _make(handler)
    assert (await client.send("t", {}, high_priority=True)).outcome == "sent"
    assert len(_tokens(calls)) == 2
    assert _sends(calls)[-1].headers["authorization"] == "Bearer at-2"

    client, calls = _make(lambda r: httpx.Response(401, json={}))
    res = await client.send("t", {}, high_priority=True)
    assert res.outcome == "fatal"
    assert len(_sends(calls)) == 2


async def test_error_text_never_carries_the_device_token():
    client, _ = _make(lambda r: httpx.Response(403, text="nope"))
    res = await client.send("secret-device-token", {}, high_priority=True)
    assert res.outcome == "fatal"
    assert "secret-device-token" not in (res.error or "")


@pytest.fixture
def sa_setting(monkeypatch):
    def apply(value: str) -> None:
        monkeypatch.setenv("SS_FCM_SERVICE_ACCOUNT_FILE", value)
        get_settings.cache_clear()

    yield apply
    monkeypatch.undo()
    get_settings.cache_clear()


def test_from_settings_none_when_unset(sa_setting):
    sa_setting("")
    assert FcmClient.from_settings() is None


def test_from_settings_reads_file_and_errors_clearly(sa_setting, tmp_path):
    path = tmp_path / "sa.json"
    path.write_text(json.dumps(_account()))
    sa_setting(str(path))
    assert isinstance(FcmClient.from_settings(), FcmClient)

    sa_setting(str(tmp_path / "missing.json"))
    with pytest.raises(RuntimeError, match="FCM service account"):
        FcmClient.from_settings()


@pytest.fixture
def b64_setting(monkeypatch):
    def apply(file: str, b64: str) -> None:
        monkeypatch.setenv("SS_FCM_SERVICE_ACCOUNT_FILE", file)
        monkeypatch.setenv("SS_FCM_SERVICE_ACCOUNT_B64", b64)
        get_settings.cache_clear()

    yield apply
    monkeypatch.undo()
    get_settings.cache_clear()


def _b64(account: dict) -> str:
    import base64

    body = {"type": "service_account", **account}
    return base64.b64encode(json.dumps(body).encode()).decode()


def test_from_settings_reads_base64(b64_setting):
    b64_setting("", _b64(_account()))
    client = FcmClient.from_settings()
    assert isinstance(client, FcmClient)
    assert client._project_id == "proj-1"


def test_file_wins_over_base64(b64_setting, tmp_path):
    path = tmp_path / "sa.json"
    path.write_text(json.dumps({**_account(), "project_id": "from-file"}))
    b64_setting(str(path), _b64({**_account(), "project_id": "from-b64"}))
    assert FcmClient.from_settings()._project_id == "from-file"


@pytest.mark.parametrize("bad", [
    "not base64 at all!!",
    "bm90IGpzb24=",  # "not json"
    "W10=",  # a JSON list
    "e30=",  # an empty object
    "A" * 9000,  # over the length cap
], ids=["not-base64", "not-json", "json-list", "empty-object", "too-long"])
def test_bad_base64_is_a_clear_error_without_the_key(b64_setting, bad):
    b64_setting("", bad)
    with pytest.raises(RuntimeError, match="FCM service account") as info:
        FcmClient.from_settings()
    assert bad[:20] not in str(info.value)


def test_base64_must_be_a_service_account(b64_setting):
    b64_setting("", _b64({**_account(), "type": "authorized_user"}))
    with pytest.raises(RuntimeError, match="FCM service account") as info:
        FcmClient.from_settings()
    assert _PRIVATE_PEM[:40] not in str(info.value)
