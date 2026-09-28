"""ClaudeProvider against a fake AsyncAnthropic: request shape, pause_turn
continuation, URL harvesting, usage, error mapping. No network."""
import json
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from serversherpa.spec_lookup.provider import (
    MAX_CONTINUATIONS, ClaudeProvider, ProviderFailed, ProviderNotConfigured,
    ProviderRetryable, estimate_cost, get_provider,
)


class Resp:
    def __init__(self, content, stop_reason="end_turn", searches=0, inp=100, out=20):
        self.content = content
        self._d = {"content": content, "stop_reason": stop_reason,
                   "usage": {"input_tokens": inp, "output_tokens": out,
                             "server_tool_use": {"web_search_requests": searches}}}

    def model_dump(self, **_):
        return self._d


class FakeMessages:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def create(self, **kw):
        self.calls.append(kw)
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def fake_client(responses):
    return SimpleNamespace(messages=FakeMessages(responses), close=lambda: None)


SEARCH = {"type": "web_search_tool_result", "tool_use_id": "s1",
          "content": [{"type": "web_search_result", "url": "https://www.hpe.com/a/",
                       "title": "DL320"}]}
FETCH = {"type": "web_fetch_tool_result", "tool_use_id": "f1",
         "content": {"type": "web_fetch_result", "url": "https://www.hpe.com/spec.pdf",
                     "content": {}}}
ANSWER = {"findings": [{"field": "ru_size", "value": "1", "unit": "none",
                        "quote": "1U", "source_url": "https://www.hpe.com/a"}], "notes": ""}


def prov(client):
    return ClaudeProvider(api_key="k", model="claude-sonnet-5", max_searches=4,
                          max_fetches=3, client=client)


async def test_lookup_parses_and_harvests_urls():
    c = fake_client([Resp([SEARCH, FETCH, {"type": "text", "text": json.dumps(ANSWER)}],
                          searches=2)])
    r = await prov(c).lookup(make="HPE", model="DL320 Gen11", aliases=["DL320"],
                             category="server", fields=["ru_size", "weight"])
    assert [(f.field, f.value, f.unit) for f in r.findings] == [("ru_size", "1", None)]
    assert r.seen_urls == {"https://www.hpe.com/a", "https://www.hpe.com/spec.pdf"}
    assert (r.input_tokens, r.output_tokens, r.search_count) == (100, 20, 2)
    call = c.messages.calls[0]
    assert call["model"] == "claude-sonnet-5"
    assert {t["type"] for t in call["tools"]} == {"web_search_20260209", "web_fetch_20260209"}
    assert call["tools"][0]["max_uses"] == 4
    assert call["tools"][1]["max_uses"] == 3
    prompt = call["messages"][0]["content"]
    assert "DL320 Gen11" in prompt and "ru_size" in prompt and "weight" in prompt
    assert call["output_config"]["format"]["type"] == "json_schema"


async def test_pause_turn_continues_and_sums_usage():
    first = Resp([SEARCH], stop_reason="pause_turn", searches=1)
    second = Resp([{"type": "text", "text": json.dumps(ANSWER)}], searches=1)
    c = fake_client([first, second])
    r = await prov(c).lookup(make="HPE", model="DL320", aliases=[], category=None,
                             fields=["ru_size"])
    assert len(c.messages.calls) == 2
    assert c.messages.calls[1]["messages"][1] == {"role": "assistant", "content": first.content}
    assert r.search_count == 2 and r.input_tokens == 200
    assert "https://www.hpe.com/a" in r.seen_urls


async def test_refusal_and_bad_json_fail():
    with pytest.raises(ProviderFailed, match="refusal"):
        await prov(fake_client([Resp([], stop_reason="refusal")])).lookup(
            make="a", model="b", aliases=[], category=None, fields=["ru_size"])
    with pytest.raises(ProviderFailed, match="bad_output"):
        await prov(fake_client([Resp([{"type": "text", "text": "not json"}])])).lookup(
            make="a", model="b", aliases=[], category=None, fields=["ru_size"])


async def test_max_tokens_fails_before_parsing():
    with pytest.raises(ProviderFailed, match="max_tokens"):
        await prov(fake_client([Resp([], stop_reason="max_tokens")])).lookup(
            make="a", model="b", aliases=[], category=None, fields=["ru_size"])


async def test_pause_limit_when_every_round_pauses():
    responses = [Resp([SEARCH], stop_reason="pause_turn")
                 for _ in range(MAX_CONTINUATIONS + 1)]
    with pytest.raises(ProviderFailed, match="pause_limit"):
        await prov(fake_client(responses)).lookup(
            make="a", model="b", aliases=[], category=None, fields=["ru_size"])


async def test_tool_result_errors_add_no_urls():
    search_error = {"type": "web_search_tool_result", "tool_use_id": "s1",
                     "content": {"type": "web_search_tool_result_error",
                                 "error_code": "unavailable"}}
    fetch_error = {"type": "web_fetch_tool_result", "tool_use_id": "f1",
                   "content": {"type": "web_fetch_tool_result_error",
                               "error_code": "url_not_accessible"}}
    c = fake_client([Resp([search_error, fetch_error,
                          {"type": "text", "text": json.dumps(ANSWER)}])])
    r = await prov(c).lookup(make="a", model="b", aliases=[], category=None,
                             fields=["ru_size"])
    assert r.seen_urls == set()


async def test_finding_for_unrequested_field_is_dropped():
    answer = {"findings": [
        {"field": "ru_size", "value": "1", "unit": "none", "quote": "1U",
         "source_url": "https://www.hpe.com/a"},
        {"field": "weight", "value": "10", "unit": "lbs", "quote": "10 lbs",
         "source_url": "https://www.hpe.com/a"},
    ], "notes": ""}
    c = fake_client([Resp([{"type": "text", "text": json.dumps(answer)}])])
    r = await prov(c).lookup(make="a", model="b", aliases=[], category=None,
                             fields=["ru_size"])
    assert [f.field for f in r.findings] == ["ru_size"]


def _status_error(cls, code):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("boom", response=httpx.Response(code, request=req), body=None)


async def test_error_mapping():
    async def run(exc):
        await prov(fake_client([exc])).lookup(make="a", model="b", aliases=[],
                                              category=None, fields=["ru_size"])
    with pytest.raises(ProviderNotConfigured):
        await run(_status_error(anthropic.AuthenticationError, 401))
    with pytest.raises(ProviderRetryable):
        await run(_status_error(anthropic.RateLimitError, 429))
    with pytest.raises(ProviderRetryable):
        await run(_status_error(anthropic.InternalServerError, 500))
    with pytest.raises(ProviderRetryable):
        await run(anthropic.APIConnectionError(
            request=httpx.Request("POST", "https://api.anthropic.com")))
    with pytest.raises(ProviderRetryable):
        await run(_status_error(anthropic.OverloadedError, 529))
    with pytest.raises(ProviderRetryable):
        await run(_status_error(anthropic.APIStatusError, 408))
    with pytest.raises(ProviderFailed):
        await run(_status_error(anthropic.BadRequestError, 400))


def test_get_provider_none_without_key():
    assert get_provider() is None


def test_estimate_cost():
    assert estimate_cost(1_000_000, 100_000, 10) == pytest.approx(2.0 + 1.0 + 0.10)


def test_max_tokens_leaves_room_for_adaptive_thinking():
    from serversherpa.spec_lookup.provider import MAX_TOKENS
    assert MAX_TOKENS == 16000


async def test_request_uses_max_tokens():
    from serversherpa.spec_lookup.provider import MAX_TOKENS
    c = fake_client([Resp([SEARCH, {"type": "text", "text": json.dumps(ANSWER)}])])
    await prov(c).lookup(make="a", model="b", aliases=[], category=None, fields=["ru_size"])
    assert c.messages.calls[0]["max_tokens"] == MAX_TOKENS == 16000
