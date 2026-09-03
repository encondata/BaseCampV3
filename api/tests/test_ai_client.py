"""Provider adapter: OpenAI-compatible wire parsing and failure taxonomy."""

import httpx
import pytest

from serversherpa.ai.client import (
    AiClient, AiProtocolError, AiUnavailableError,
)


def _client(handler) -> AiClient:
    return AiClient("http://ai.test/v1", "qwen3:8b", 5.0,
                    transport=httpx.MockTransport(handler))


def _ok(payload: dict) -> httpx.Response:
    return httpx.Response(200, json=payload)


async def test_text_turn_parsed():
    async def handler(request):
        return _ok({"choices": [{"message": {
            "role": "assistant", "content": "Hi there"}}]})
    c = _client(handler)
    turn = await c.chat([{"role": "user", "content": "hi"}], tools=[])
    assert turn.text == "Hi there" and turn.tool_calls == []
    await c.aclose()


async def test_reasoning_effort_in_payload_when_configured():
    seen: dict = {}

    async def handler(request):
        seen.update(__import__("json").loads(request.content))
        return _ok({"choices": [{"message": {
            "role": "assistant", "content": "ok"}}]})
    c = AiClient("http://ai.test/v1", "qwen3:8b", 5.0,
                 transport=httpx.MockTransport(handler),
                 reasoning_effort="none")
    await c.chat([{"role": "user", "content": "hi"}], tools=[])
    assert seen["reasoning_effort"] == "none"
    await c.aclose()


async def test_reasoning_effort_omitted_by_default():
    seen: dict = {}

    async def handler(request):
        seen.update(__import__("json").loads(request.content))
        return _ok({"choices": [{"message": {
            "role": "assistant", "content": "ok"}}]})
    c = _client(handler)
    await c.chat([{"role": "user", "content": "hi"}], tools=[])
    assert "reasoning_effort" not in seen
    await c.aclose()


async def test_tool_call_turn_parsed():
    async def handler(request):
        return _ok({"choices": [{"message": {
            "role": "assistant", "content": "",
            "tool_calls": [{"id": "call_1", "type": "function", "function": {
                "name": "find_moves",
                "arguments": "{\"status\": \"in_progress\"}"}}]}}]})
    c = _client(handler)
    turn = await c.chat([{"role": "user", "content": "moves?"}], tools=[])
    assert turn.tool_calls[0].name == "find_moves"
    assert turn.tool_calls[0].args == {"status": "in_progress"}
    assert turn.tool_calls[0].id == "call_1"
    await c.aclose()


async def test_connection_error_is_unavailable():
    async def handler(request):
        raise httpx.ConnectError("refused")
    c = _client(handler)
    with pytest.raises(AiUnavailableError):
        await c.chat([{"role": "user", "content": "hi"}], tools=[])
    await c.aclose()


async def test_http_500_is_unavailable():
    async def handler(request):
        return httpx.Response(500, text="boom")
    c = _client(handler)
    with pytest.raises(AiUnavailableError):
        await c.chat([{"role": "user", "content": "hi"}], tools=[])
    await c.aclose()


async def test_parts_list_content_is_joined():
    async def handler(request):
        return _ok({"choices": [{"message": {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "joined "},
                {"type": "text", "text": "text"},
                {"type": "image", "image_url": "http://example.test/x.png"},
            ]}}]})
    c = _client(handler)
    turn = await c.chat([{"role": "user", "content": "hi"}], tools=[])
    assert turn.text == "joined text"
    await c.aclose()


async def test_malformed_arguments_is_protocol_error():
    async def handler(request):
        return _ok({"choices": [{"message": {
            "role": "assistant", "content": None,
            "tool_calls": [{"id": "c", "type": "function", "function": {
                "name": "find_moves", "arguments": "{not json"}}]}}]})
    c = _client(handler)
    with pytest.raises(AiProtocolError):
        await c.chat([{"role": "user", "content": "hi"}], tools=[])
    await c.aclose()


async def test_get_client_none_when_disabled():
    from serversherpa.ai.client import get_client
    assert get_client() is None  # SS_AI_ENABLED defaults false in tests
