import httpx
import pytest

from loadtest.clock import FakeClock
from loadtest.http import CallFailed, TokenExpired, error_code, timed_call
from loadtest.metrics import Metrics
from loadtest.profile import RetrySpec

RETRY = RetrySpec(attempts=5, backoff_seconds=(1, 2, 4))


def err(status, code):
    return httpx.Response(status, json={"detail": {"code": code}})


def make(responses):
    """A client whose transport plays `responses` in order (Response or Exception)."""
    seq = list(responses)
    seen = []

    def handler(request):
        seen.append(request)
        item = seq.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://t"), seen


async def call(responses, **kw):
    client, seen = make(responses)
    clock, metrics = FakeClock(), Metrics()
    retry = kw.pop("retry", RETRY)
    kwargs = dict(name="pack", metrics=metrics, clock=clock, retry=retry)
    kwargs.update(kw)
    try:
        result = await clock.run(timed_call(client, "POST", "/x", **kwargs))
    except Exception as exc:
        result = exc
    finally:
        await client.aclose()
    return result, metrics, clock, seen


async def test_success_records_once():
    r, m, clock, _ = await call([httpx.Response(200, json={})])
    assert r.status_code == 200
    row = m.calls()["pack"]
    assert (row["count"], row["retries"], row["failures"]) == (1, 0, 0)
    assert clock.sleeps == []


async def test_5xx_then_success_retries_with_backoff():
    r, m, clock, seen = await call([httpx.Response(503), httpx.Response(503), httpx.Response(200)])
    assert r.status_code == 200
    assert clock.sleeps == [1, 2]
    row = m.calls()["pack"]
    assert (row["count"], row["retries"], row["failures"]) == (1, 2, 0)
    assert len(seen) == 3


async def test_exhausted_retries_fail_once_and_last_backoff_repeats():
    r, m, clock, seen = await call([httpx.Response(503)] * 5)
    assert isinstance(r, CallFailed)
    assert (r.status, r.retries, r.call) == (503, 4, "pack")
    assert clock.sleeps == [1, 2, 4, 4]
    row = m.calls()["pack"]
    assert (row["count"], row["retries"], row["failures"]) == (1, 4, 1)
    assert len(seen) == 5


async def test_transport_errors_are_retried():
    r, m, _, _ = await call([httpx.ConnectError("x"), httpx.ReadTimeout("y"), httpx.Response(200)])
    assert r.status_code == 200
    assert m.calls()["pack"]["retries"] == 2


async def test_transport_error_to_the_end_has_no_status():
    r, m, _, _ = await call([httpx.ConnectError("x")] * 5)
    assert isinstance(r, CallFailed)
    assert r.status is None and r.code is None and r.retries == 4
    assert m.calls()["pack"]["failures"] == 1


async def test_423_is_retried():
    r, _, clock, _ = await call([err(423, "read_only"), httpx.Response(200)])
    assert r.status_code == 200
    assert clock.sleeps == [1]


async def test_other_4xx_is_final_with_server_code():
    r, m, clock, seen = await call([err(422, "bad_site")])
    assert isinstance(r, CallFailed)
    assert (r.status, r.code, r.retries) == (422, "bad_site", 0)
    assert clock.sleeps == [] and len(seen) == 1
    assert m.calls()["pack"]["failures"] == 1


async def test_401_raises_token_expired_and_records_nothing():
    r, m, _, _ = await call([httpx.Response(503), httpx.Response(401)])
    assert isinstance(r, TokenExpired)
    assert m.calls() == {}
    r, m, _, _ = await call([httpx.Response(401)])
    assert isinstance(r, TokenExpired) and m.calls() == {}


def done(r):
    return error_code(r) == "not_in_container"


async def test_already_done_on_a_retry_is_success():
    r, m, _, _ = await call([httpx.Response(503), err(409, "not_in_container")], already_done=done)
    assert r.status_code == 409
    row = m.calls()["pack"]
    assert (row["retries"], row["failures"]) == (1, 0)


async def test_already_done_on_the_first_try_is_a_failure():
    r, m, _, _ = await call([err(409, "not_in_container")], already_done=done)
    assert isinstance(r, CallFailed) and r.code == "not_in_container"
    assert m.calls()["pack"]["failures"] == 1


async def test_exception_text_never_carries_request_secrets():
    for responses in ([err(422, "bad")], [httpx.ConnectError("boom")] * 5, [httpx.Response(503)] * 5):
        r, _, _, _ = await call(
            responses,
            headers={"Authorization": "Bearer SECRET"},
            json={"password": "SECRET"},
        )
        assert isinstance(r, CallFailed)
        assert "SECRET" not in str(r) and "SECRET" not in repr(r)
        assert r.__cause__ is None


async def test_recorded_ms_is_the_last_attempt_real_time():
    r, m, _, _ = await call([httpx.Response(503), httpx.Response(200)])
    assert 0 <= m.calls()["pack"]["max_ms"] < 1000


def test_error_code_parses_the_server_shape():
    assert error_code(err(409, "x_y")) == "x_y"
    assert error_code(httpx.Response(502, text="<html>Bad Gateway</html>")) is None
    assert error_code(httpx.Response(500)) is None
    assert error_code(httpx.Response(422, json={"detail": [{"loc": ["body"], "msg": "m"}]})) is None
    assert error_code(httpx.Response(400, json={"detail": "plain"})) is None
    assert error_code(httpx.Response(400, json=["x"])) is None
    assert error_code(httpx.Response(400, json={"detail": {"code": 5}})) is None
