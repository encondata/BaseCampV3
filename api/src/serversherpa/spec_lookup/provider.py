"""The only code that talks to Claude. One Messages call per model with the
server-side web_search tool (search only, never page fetches: a fetched spec
sheet is re-read on every step and costs dollars per model) and a JSON-schema
answer; the "Lookup effort" setting picks how hard Claude thinks and how many
searches it may run. The caller
(worker) verifies every value before anything is stored. Only make, model,
aliases, category and the wanted field names are sent."""

import json
from dataclasses import dataclass, field as dc_field
from typing import Protocol

import anthropic

from serversherpa.spec_lookup.fields import ALL_FIELDS
from serversherpa.spec_lookup.verify import normalize_url

MAX_CONTINUATIONS = 3
MAX_TOKENS = 16000                     # adaptive thinking counts toward this
SEARCH_COST_USD = 0.01                 # $10 per 1,000 searches
INPUT_COST_PER_MTOK = 2.0              # claude-sonnet-5
OUTPUT_COST_PER_MTOK = 10.0

# Lookup effort (System settings › AI lookup) -> (thinking effort, web_search
# max_uses). The single source of truth for the mapping. Runs with more
# thinking found far more values than runs with more searches, so thinking
# effort climbs faster than the search budget as the level goes up.
EFFORT_LEVELS = {"low": ("medium", 1), "medium": ("high", 2), "high": ("high", 4)}
DEFAULT_EFFORT = "medium"


def estimate_cost(input_tokens: int, output_tokens: int, searches: int) -> float:
    return (input_tokens / 1e6 * INPUT_COST_PER_MTOK
            + output_tokens / 1e6 * OUTPUT_COST_PER_MTOK
            + searches * SEARCH_COST_USD)


class ProviderError(Exception):
    pass


class ProviderNotConfigured(ProviderError):
    pass


class ProviderRetryable(ProviderError):
    pass


class ProviderFailed(ProviderError):
    pass


@dataclass
class Finding:
    field: str
    value: str
    unit: str | None
    quote: str
    source_url: str


@dataclass
class LookupResult:
    findings: list[Finding] = dc_field(default_factory=list)
    seen_urls: set[str] = dc_field(default_factory=set)
    input_tokens: int = 0
    output_tokens: int = 0
    search_count: int = 0


class LookupProvider(Protocol):
    async def lookup(self, *, make: str, model: str, aliases: list[str],
                     category: str | None, fields: list[str],
                     effort: str = DEFAULT_EFFORT) -> LookupResult: ...
    async def ping(self) -> None: ...
    async def aclose(self) -> None: ...


FIELD_HELP = {
    "ru_size": "rack units the unit occupies (integer, e.g. 2 for a 2U server); unit 'none'",
    "weight": "maximum/fully configured weight; unit 'lbs' or 'kg' as printed",
    "length": "depth front-to-back; unit 'in' or 'cm' as printed",
    "width": "width; unit 'in' or 'cm' as printed",
    "height": "height; unit 'in' or 'cm' as printed",
    "mount_type": "one of rails, ears, shelf, custom; unit 'none'",
    "rail_type": "the rail kit's name or kind, short; unit 'none'",
    "knowledge": "one or two plain sentences on what the product is; unit 'none'",
}

SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "field": {"type": "string", "enum": list(ALL_FIELDS)},
                    "value": {"type": "string"},
                    "unit": {"type": "string", "enum": ["lbs", "kg", "in", "cm", "none"]},
                    "quote": {"type": "string"},
                    "source_url": {"type": "string"},
                },
                "required": ["field", "value", "unit", "quote", "source_url"],
                "additionalProperties": False,
            },
        },
        "notes": {"type": "string"},
    },
    "required": ["findings", "notes"],
    "additionalProperties": False,
}

SYSTEM = (
    "You look up physical specifications of datacenter hardware for an asset "
    "catalog. Use web search and work from the search results (their excerpts); "
    "prefer the manufacturer's own spec sheets and product pages, then "
    "reputable resellers. Never answer from memory: every value must come from "
    "a search result in this conversation, and `quote` must be the exact text "
    "from that result that states it (copied, not paraphrased), with "
    "`source_url` the result's URL. "
    "Match the exact model and variant; if a page covers a different variant, "
    "leave the value out. Omit any field you could not find — an empty "
    "findings list is a fine answer."
)


def _prompt(make: str, model: str, aliases: list[str], category: str | None,
            fields: list[str]) -> str:
    lines = [f"Make: {make}", f"Model: {model}"]
    if aliases:
        lines.append("Also known as: " + ", ".join(aliases))
    if category:
        lines.append(f"Category: {category}")
    lines.append("Find these fields:")
    lines += [f"- {f}: {FIELD_HELP[f]}" for f in fields]
    return "\n".join(lines)


def _harvest(d: dict, seen: set[str]) -> None:
    for block in d.get("content") or []:
        kind = block.get("type")
        content = block.get("content")
        if kind == "web_search_tool_result" and isinstance(content, list):
            for r in content:
                if r.get("url"):
                    seen.add(normalize_url(r["url"]))


class ClaudeProvider:
    def __init__(self, *, api_key: str, model: str, client=None) -> None:
        self._client = client or anthropic.AsyncAnthropic(api_key=api_key, max_retries=0)
        self._model = model

    async def aclose(self) -> None:
        close = getattr(self._client, "close", None)
        if close is not None:
            res = close()
            if hasattr(res, "__await__"):
                await res

    async def _create(self, **kw):
        try:
            return await self._client.messages.create(**kw)
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as exc:
            raise ProviderNotConfigured("not_configured") from exc
        except (anthropic.RateLimitError, anthropic.InternalServerError,
                anthropic.OverloadedError,
                anthropic.APIConnectionError) as exc:      # APITimeoutError is a subclass
            raise ProviderRetryable(type(exc).__name__) from exc
        except anthropic.APIStatusError as exc:
            if exc.status_code in (408, 409):
                raise ProviderRetryable(type(exc).__name__) from exc
            raise ProviderFailed(f"api_error {exc.status_code}: {exc}"[:500]) from exc

    async def lookup(self, *, make: str, model: str, aliases: list[str],
                     category: str | None, fields: list[str],
                     effort: str = DEFAULT_EFFORT) -> LookupResult:
        if effort not in EFFORT_LEVELS:
            effort = DEFAULT_EFFORT
        thinking_effort, max_searches = EFFORT_LEVELS[effort]
        user = {"role": "user", "content": _prompt(make, model, aliases, category, fields)}
        messages: list[dict] = [user]
        result = LookupResult()
        text = None
        for _ in range(MAX_CONTINUATIONS + 1):
            resp = await self._create(
                model=self._model, max_tokens=MAX_TOKENS, system=SYSTEM,
                messages=messages,
                tools=[{"type": "web_search_20250305", "name": "web_search",
                        "max_uses": max_searches}],
                output_config={"format": {"type": "json_schema", "schema": SCHEMA},
                               "effort": thinking_effort},
            )
            d = resp.model_dump()
            usage = d.get("usage") or {}
            result.input_tokens += usage.get("input_tokens") or 0
            result.output_tokens += usage.get("output_tokens") or 0
            result.search_count += ((usage.get("server_tool_use") or {})
                                    .get("web_search_requests") or 0)
            _harvest(d, result.seen_urls)
            stop = d.get("stop_reason")
            if stop == "refusal":
                raise ProviderFailed("refusal")
            if stop == "max_tokens":
                raise ProviderFailed("max_tokens")
            if stop == "pause_turn":
                messages = [user, {"role": "assistant", "content": resp.content}]
                continue
            texts = [b.get("text") for b in d.get("content") or []
                     if b.get("type") == "text" and b.get("text")]
            text = texts[-1] if texts else None
            break
        else:
            raise ProviderFailed("pause_limit")
        if text is None:
            raise ProviderFailed("bad_output: no answer")
        try:
            payload = json.loads(text)
            items = payload["findings"]
            result.findings = [
                Finding(field=i["field"], value=str(i["value"]),
                        unit=None if i["unit"] == "none" else i["unit"],
                        quote=i["quote"], source_url=i["source_url"])
                for i in items if i["field"] in fields]
        except (ValueError, KeyError, TypeError) as exc:
            raise ProviderFailed(f"bad_output: {exc}"[:500]) from exc
        return result

    async def ping(self) -> None:
        await self._create(model=self._model, max_tokens=16,
                           messages=[{"role": "user", "content": "Reply with: ok"}])


def get_provider() -> LookupProvider | None:
    from serversherpa.config import get_settings

    s = get_settings()
    key = s.anthropic_api_key.get_secret_value()
    if not key:
        return None
    return ClaudeProvider(api_key=key, model=s.spec_lookup_model)


def is_configured() -> bool:
    from serversherpa.config import get_settings

    return bool(get_settings().anthropic_api_key.get_secret_value())
