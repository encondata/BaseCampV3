"""Provider adapter for the AI assistant.

The ONLY file that talks to the model. Speaks the OpenAI-compatible
chat-completions dialect (Ollama serves it at /v1), so swapping the model
or host is config, not code. Failure taxonomy: AiUnavailableError = host
down / HTTP error (route maps it to 503 ai_offline); AiProtocolError =
the model answered garbage (route retries once, then gives up politely).
"""

import json
from dataclasses import dataclass, field

import httpx

from serversherpa.config import get_settings


class AiUnavailableError(Exception):
    """Model host unreachable or returned an HTTP error."""


class AiProtocolError(Exception):
    """Model response didn't parse as a chat completion."""


@dataclass
class AiToolCall:
    id: str
    name: str
    args: dict


@dataclass
class AiTurn:
    text: str | None = None
    tool_calls: list[AiToolCall] = field(default_factory=list)


class AiClient:
    def __init__(self, base_url: str, model: str, timeout: float,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._model = model
        self._http = httpx.AsyncClient(
            base_url=base_url, timeout=timeout, transport=transport)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def chat(self, messages: list[dict], tools: list[dict]) -> AiTurn:
        payload: dict = {"model": self._model, "messages": messages,
                         "stream": False}
        if tools:
            payload["tools"] = tools
        try:
            resp = await self._http.post("/chat/completions", json=payload)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise AiUnavailableError(str(exc)) from exc
        try:
            msg = resp.json()["choices"][0]["message"]
            calls = []
            for i, c in enumerate(msg.get("tool_calls") or []):
                calls.append(AiToolCall(
                    id=c.get("id") or f"call_{i}",
                    name=c["function"]["name"],
                    args=json.loads(c["function"]["arguments"] or "{}")))
            content = msg.get("content")
            text = self._coerce_content(content)
            return AiTurn(text=text, tool_calls=calls)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise AiProtocolError(str(exc)) from exc

    @staticmethod
    def _coerce_content(content: object) -> str | None:
        """Some OpenAI-compatible servers return `content` as a list of
        part objects (e.g. [{"type": "text", "text": "..."}]) instead of
        a plain string. Join the text parts; fall back to None for
        anything else so it never lands un-coerced in AiTurn.text."""
        if content is None or isinstance(content, str):
            return content
        if isinstance(content, list):
            joined = "".join(
                part.get("text", "") for part in content
                if isinstance(part, dict) and part.get("type") == "text")
            return joined or None
        return None


def get_client() -> AiClient | None:
    """One fresh client per request; None while the feature is disabled.
    The /ai/chat route monkeypatches THIS function in tests."""
    s = get_settings()
    if not s.ai_enabled:
        return None
    return AiClient(s.ai_base_url, s.ai_model, s.ai_timeout_seconds)
