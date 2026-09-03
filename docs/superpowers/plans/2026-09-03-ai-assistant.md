# AI Assistant (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working natural-language assistant behind the Topbar AI button: lookups, clarifying questions, and portal navigation, powered by a local Ollama model through one provider adapter.

**Architecture:** New backend module `api/src/serversherpa/ai/` (provider adapter, tool registry, prompts) plus `POST /ai/chat` running the model↔tool loop under the caller's permissions. Portal replaces the coming-soon popover with a chat panel that executes returned `navigate` actions. Spec: `docs/superpowers/specs/2026-09-03-ai-assistant-design.md`.

**Tech Stack:** FastAPI + SQLAlchemy async + httpx (already deps), pytest with `httpx.MockTransport`; React + vitest on the portal. No new dependencies.

## Global Constraints

- Worktree: `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/ai-assistant`, branch `ai-assistant`. All commands run from `<worktree>/api` unless noted.
- **API test command (always use exactly this shape, FOREGROUND, never backgrounded):**
  `SS_TEST_DB=serversherpa_test_ai PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest <paths> -q`
  (worktree has no venv; `.venv` is a symlink to the main checkout's; `PYTHONPATH` makes worktree sources win; the DB `serversherpa_test_ai` already exists. NEVER run without `SS_TEST_DB` — the shared default DB collides with other sessions.)
- Portal tests: `cd <worktree>/portal && npx vitest run <paths>` (node_modules is a symlink; it works).
- Migration numbering: next revision is `0045`, `down_revision = "0044"`.
- Read-only feature: no tool may mutate data. `POST /ai/chat` must remain exempt-safe under read-only mode only if trivially so — do NOT add it to the read-only exemption list; a 423 under maintenance is acceptable phase-1 behavior.
- Copy rules: portal user-facing offline text is exactly "AI assistant is offline." Error code strings: `ai_offline`, `forbidden` (existing).
- Never commit `api/src/serversherpa/_dev_reload.py` if it churns (`git checkout -- src/serversherpa/_dev_reload.py`).

---

### Task 1: Settings + provider adapter (`ai/client.py`)

**Files:**
- Modify: `api/src/serversherpa/config.py` (after the "Labels" settings block, ~line 90)
- Create: `api/src/serversherpa/ai/__init__.py` (empty)
- Create: `api/src/serversherpa/ai/client.py`
- Test: `api/tests/test_ai_client.py`

**Interfaces:**
- Produces: `AiToolCall(id: str, name: str, args: dict)`, `AiTurn(text: str | None, tool_calls: list[AiToolCall])`, `AiUnavailableError`, `AiProtocolError`, `class AiClient` with `async chat(messages: list[dict], tools: list[dict]) -> AiTurn` and `async aclose()`, and `get_client() -> AiClient | None` (None when `SS_AI_ENABLED` is false). Later tasks import all of these from `serversherpa.ai.client`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_ai_client.py
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_ai PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/test_ai_client.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'serversherpa.ai'`

- [ ] **Step 3: Implement settings + adapter**

Add to `api/src/serversherpa/config.py`, directly after the `labelary_base_url` line inside `Settings`:

```python
    # ── AI assistant ───────────────────────────────────────
    ai_enabled: bool = False
    ai_base_url: str = "http://localhost:11434/v1"
    ai_model: str = "qwen3:8b"
    ai_timeout_seconds: float = 60.0
```

Create `api/src/serversherpa/ai/__init__.py` (empty) and `api/src/serversherpa/ai/client.py`:

```python
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
            return AiTurn(text=msg.get("content"), tool_calls=calls)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise AiProtocolError(str(exc)) from exc


def get_client() -> AiClient | None:
    """One fresh client per request; None while the feature is disabled.
    The /ai/chat route monkeypatches THIS function in tests."""
    s = get_settings()
    if not s.ai_enabled:
        return None
    return AiClient(s.ai_base_url, s.ai_model, s.ai_timeout_seconds)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_ai PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/test_ai_client.py -q`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/serversherpa/config.py src/serversherpa/ai/ tests/test_ai_client.py
git commit -m "feat(ai): settings + provider adapter for the AI assistant

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Prompts + tool registry (`ai/prompts.py`, `ai/tools.py`)

**Files:**
- Create: `api/src/serversherpa/ai/prompts.py`
- Create: `api/src/serversherpa/ai/tools.py`
- Test: `api/tests/test_ai_tools.py`

**Interfaces:**
- Consumes: nothing from Task 1 (parallel-safe).
- Produces: `prompts.SYSTEM_PROMPT: str`; `tools.PAGES: tuple[str, ...]`; `tools.TOOLS: list[dict]` (OpenAI function-tool format); `tools.validate_navigate(args: dict) -> dict` (returns `{"page": str, "id": str | None}`, raises `ValueError`); `tools.run_tool(name: str, args: dict, db: AsyncSession, user) -> dict` — `user` needs only `user.access.can(resource, action)`. `navigate` is NOT dispatched by `run_tool` (the route intercepts it).

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_ai_tools.py
"""Tool registry: schema shape, navigate validation, executors + gating."""

from types import SimpleNamespace

import pytest

from serversherpa.ai import tools
from serversherpa.ai.prompts import SYSTEM_PROMPT
from serversherpa.db.models import Client, Initiative, Person, PersonRole


def _user(allow: bool = True):
    return SimpleNamespace(access=SimpleNamespace(
        can=lambda resource, action: allow))


def test_schemas_are_wellformed():
    names = [t["function"]["name"] for t in tools.TOOLS]
    assert sorted(names) == sorted([
        "navigate", "find_moves", "find_assets", "find_people",
        "find_sites", "find_stakeholders", "count_records"])
    for t in tools.TOOLS:
        assert t["type"] == "function"
        params = t["function"]["parameters"]
        assert params["type"] == "object"
        assert params["additionalProperties"] is False
        assert t["function"]["description"]


def test_system_prompt_budget():
    assert 500 < len(SYSTEM_PROMPT) < 12000  # ~3K tokens ceiling
    assert "read-only" in SYSTEM_PROMPT.lower()


def test_validate_navigate():
    out = tools.validate_navigate({"page": "assets"})
    assert out == {"page": "assets", "id": None}
    out = tools.validate_navigate(
        {"page": "initiative_detail",
         "id": "0b6ef88e-9d2b-4a7f-8b57-6d38f65d3c21"})
    assert out["page"] == "initiative_detail"
    with pytest.raises(ValueError):
        tools.validate_navigate({"page": "nope"})
    with pytest.raises(ValueError):
        tools.validate_navigate({"page": "initiative_detail"})  # id required
    with pytest.raises(ValueError):
        tools.validate_navigate({"page": "asset_detail", "id": "not-a-uuid"})


async def test_find_moves_filters_and_shape(db):
    db.add(Initiative(name="NAP11 Hall Migration", initiative_type="move",
                      status="in_progress"))
    db.add(Initiative(name="Broadcom Decommission", initiative_type="move",
                      status="planned"))
    db.add(Initiative(name="Not A Move", initiative_type="project",
                      status="planned"))
    await db.commit()
    out = await tools.run_tool("find_moves", {}, db, _user())
    names = {m["name"] for m in out["moves"]}
    assert names == {"NAP11 Hall Migration", "Broadcom Decommission"}
    out = await tools.run_tool(
        "find_moves", {"status": "in_progress"}, db, _user())
    assert [m["name"] for m in out["moves"]] == ["NAP11 Hall Migration"]
    out = await tools.run_tool("find_moves", {"query": "nap"}, db, _user())
    assert [m["name"] for m in out["moves"]] == ["NAP11 Hall Migration"]
    move = out["moves"][0]
    assert set(move) == {"id", "name", "status"}


async def test_permission_denied_shape(db):
    out = await tools.run_tool("find_moves", {}, db, _user(allow=False))
    assert out == {"error": "permission_denied"}


async def test_count_records_assets_by_client(db):
    c = Client(name="Broadcom")
    db.add(c)
    await db.flush()
    from serversherpa.db.models import Asset
    db.add(Asset(name="a1", client_id=c.id, status="in_storage"))
    db.add(Asset(name="a2", client_id=c.id, status="active"))
    db.add(Asset(name="a3", status="in_storage"))
    await db.commit()
    out = await tools.run_tool("count_records", {
        "entity": "assets",
        "filters": {"client": "Broadcom", "status": "in_storage"}},
        db, _user())
    assert out == {"count": 1}


async def test_find_people_matches_name(db):
    p = Person(first_name="Grace", last_name="Huizing")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="worker"))
    await db.commit()
    out = await tools.run_tool("find_people", {"query": "huiz"}, db, _user())
    assert out["people"][0]["name"] == "Grace Huizing"


async def test_unknown_tool_is_error(db):
    out = await tools.run_tool("explode", {}, db, _user())
    assert "error" in out
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_ai PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/test_ai_tools.py -q`
Expected: FAIL — `ModuleNotFoundError` / `ImportError` on `serversherpa.ai.tools`

- [ ] **Step 3: Implement prompts.py**

Create `api/src/serversherpa/ai/prompts.py`. The examples ride inside the
system prompt (simplest for an 8B; no synthetic tool_call ids needed):

```python
"""System prompt + worked examples for the AI assistant.

Budget: keep the whole string under ~12K chars (~3K tokens) so an 8B model
stays sharp; cap examples at 8 and justify additions with the eval set."""

SYSTEM_PROMPT = """\
You are the ServerSherpa portal assistant. You help data-center staff find
information about moves, assets, sites, and people, and you open portal
pages for them. You are READ-ONLY: you can look things up and navigate,
nothing else.

Rules:
1. Use tools for facts. Never answer about specific moves, assets, people,
   or counts from memory - look them up first. Never invent IDs, serials,
   or names.
2. Ambiguity -> one short clarifying question. If a search returns several
   plausible matches, list them briefly (name plus one distinguishing
   detail) and ask which one. Ask one question at a time.
3. Exactly one match -> act on it without asking.
4. "Load / open / show / take me to" means call navigate. Questions
   ("how many", "where is", "which") mean answer in chat with tool data.
   When you answer in chat, offer navigation only if a page would help.
5. You cannot create, edit, delete, or move anything. If asked to, say
   what you can do instead and where in the portal the user can do it.
6. If a search returns nothing, say so plainly and suggest a broader
   search. Never guess.
7. Keep replies to one or two sentences. No preamble, no markdown.
8. Only discuss portal data and navigation. For anything else, say it is
   outside what you can help with.

Worked examples ("->" is a tool call you make, "<-" its result):

User: load assets for move
-> find_moves {"status": "any"}
<- {"moves": [{"id": "a1", "name": "NAP11 Hall Migration",
   "status": "in_progress"}, {"id": "b2", "name": "Broadcom Cage
   Decommission", "status": "planned"}]}
Assistant: Which move - NAP11 Hall Migration (in progress) or Broadcom
Cage Decommission (planned)?
User: nap11
-> navigate {"page": "move_load_assets", "id": "a1"}
Assistant: Opening Load Assets for NAP11 Hall Migration.

User: open the broadcom client page
-> find_stakeholders {"query": "broadcom"}
<- {"stakeholders": [{"id": "c9", "name": "Broadcom", "kind": "client"}]}
-> navigate {"page": "client_detail", "id": "c9"}
Assistant: Opening Broadcom.

User: how many assets does broadcom have in storage
-> count_records {"entity": "assets", "filters": {"client": "Broadcom",
   "status": "in_storage"}}
<- {"count": 37}
Assistant: Broadcom has 37 assets in storage.

User: where is asset JX4M2P1
-> find_assets {"query": "JX4M2P1"}
<- {"assets": [{"id": "x1", "serial": "JX4M2P1", "name": "r740-web-04",
   "model": "Dell R740", "status": "active", "site": "NAP11",
   "location": "Hall B, Rack 14, RU 22"}]}
Assistant: JX4M2P1 (Dell R740, r740-web-04) is active at NAP11 - Hall B,
Rack 14, RU 22. Want me to open it?

User: show me the dallas move
-> find_moves {"query": "dallas"}
<- {"moves": []}
Assistant: I don't see any move matching "dallas". Want me to list all
open moves?

User: mark those assets as decommissioned
Assistant: I can't change asset records - I'm read-only. You can update
statuses from the Assets page; want me to open it?
"""
```

- [ ] **Step 4: Implement tools.py**

Create `api/src/serversherpa/ai/tools.py`:

```python
"""Tool registry for the AI assistant: JSON schemas the model sees and
the executors that run them UNDER THE CALLER'S PERMISSIONS.

Every executor takes (db, user, args) where user only needs
user.access.can(resource, action) - the same gate the REST routes use.
Executors are read-only by construction and clip results to LIMIT rows
of compact display fields before the model sees them. navigate is
special: the /ai/chat route intercepts it (validate_navigate) and it
never reaches run_tool."""

import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, AssetModel, Client, Initiative, Partner, Person, PersonRole,
    ProcessedScan, Site,
)

LIMIT = 10

PAGES: tuple[str, ...] = (
    "assets", "asset_detail", "initiatives", "initiative_detail",
    "move_load_assets", "workers", "worker_detail", "sites",
    "clients", "client_detail", "partners", "scans",
)
_DETAIL_PAGES = {"asset_detail", "initiative_detail", "move_load_assets",
                 "worker_detail", "client_detail"}

TOOLS: list[dict] = [
    {"type": "function", "function": {
        "name": "navigate",
        "description": "Open a portal page for the user. The ONLY way to "
                       "take the user somewhere; changes no data. Ids must "
                       "come from a previous tool result - never invented.",
        "parameters": {"type": "object", "properties": {
            "page": {"type": "string", "enum": list(PAGES)},
            "id": {"type": "string", "description":
                   "Record UUID, required for *_detail and "
                   "move_load_assets pages."}},
            "required": ["page"], "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "find_moves",
        "description": "Search moves (relocation projects). Returns id, "
                       "name, status. Use before navigating to a move.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string",
                      "description": "Name fragment; omit to list all"},
            "status": {"type": "string",
                       "enum": ["planned", "in_progress", "completed",
                                "any"]}},
            "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "find_assets",
        "description": "Search assets by serial, name, or RFID with "
                       "optional filters. Returns compact rows.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"},
            "client": {"type": "string"},
            "site": {"type": "string"},
            "status": {"type": "string",
                       "enum": ["active", "in_transit", "in_storage",
                                "decommissioned", "unknown"]}},
            "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "find_people",
        "description": "Search workers and staff by name.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}},
            "required": ["query"], "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "find_sites",
        "description": "Search sites by name or city.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}},
            "required": ["query"], "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "find_stakeholders",
        "description": "Search clients and partners by name.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}},
            "required": ["query"], "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "count_records",
        "description": "Count records matching filters. Use for 'how "
                       "many' questions instead of fetching lists.",
        "parameters": {"type": "object", "properties": {
            "entity": {"type": "string",
                       "enum": ["assets", "moves", "workers", "sites",
                                "scans"]},
            "filters": {"type": "object", "properties": {
                "client": {"type": "string"},
                "site": {"type": "string"},
                "status": {"type": "string"},
                "days": {"type": "integer"}},
                "additionalProperties": False}},
            "required": ["entity"], "additionalProperties": False}}},
]


def validate_navigate(args: dict) -> dict:
    page = args.get("page")
    if page not in PAGES:
        raise ValueError(f"unknown page: {page!r}")
    rec_id = args.get("id")
    if page in _DETAIL_PAGES:
        try:
            uuid.UUID(str(rec_id))
        except ValueError:
            raise ValueError(f"page {page} needs a record UUID") from None
        return {"page": page, "id": str(rec_id)}
    return {"page": page, "id": None}


async def _find_moves(db: AsyncSession, args: dict) -> dict:
    q = select(Initiative).where(Initiative.initiative_type == "move")
    status = args.get("status") or "any"
    if status != "any":
        q = q.where(Initiative.status == status)
    if args.get("query"):
        q = q.where(Initiative.name.ilike(f"%{args['query']}%"))
    rows = (await db.scalars(q.order_by(Initiative.name).limit(LIMIT))).all()
    return {"moves": [{"id": str(m.id), "name": m.name, "status": m.status}
                      for m in rows]}


async def _find_assets(db: AsyncSession, args: dict) -> dict:
    q = (select(Asset, AssetModel, Site, Client)
         .outerjoin(AssetModel, Asset.model_id == AssetModel.id)
         .outerjoin(Site, Asset.site_id == Site.id)
         .outerjoin(Client, Asset.client_id == Client.id))
    if args.get("query"):
        needle = f"%{args['query']}%"
        q = q.where(or_(Asset.serial_number.ilike(needle),
                        Asset.name.ilike(needle),
                        Asset.rfid_tag.ilike(needle)))
    if args.get("client"):
        q = q.where(Client.name.ilike(f"%{args['client']}%"))
    if args.get("site"):
        q = q.where(Site.name.ilike(f"%{args['site']}%"))
    if args.get("status"):
        q = q.where(Asset.status == args["status"])
    rows = (await db.execute(q.limit(LIMIT))).all()
    return {"assets": [{
        "id": str(a.id), "serial": a.serial_number, "name": a.name,
        "model": f"{m.make} {m.model}" if m else None,
        "status": a.status, "site": s.name if s else None,
        "client": c.name if c else None,
        "location": a.location_detail or None}
        for a, m, s, c in rows]}


async def _find_people(db: AsyncSession, args: dict) -> dict:
    needle = f"%{args.get('query', '')}%"
    q = (select(Person)
         .where(Person.archived_at.is_(None))
         .where(or_(
             func.concat(Person.first_name, " ", Person.last_name)
             .ilike(needle),
             Person.preferred_name.ilike(needle)))
         .order_by(Person.last_name, Person.first_name).limit(LIMIT))
    rows = (await db.scalars(q)).all()
    return {"people": [{
        "id": str(p.id),
        "name": f"{p.first_name} {p.last_name}",
        "job_title": p.job_title} for p in rows]}


async def _find_sites(db: AsyncSession, args: dict) -> dict:
    needle = f"%{args.get('query', '')}%"
    q = (select(Site)
         .where(or_(Site.name.ilike(needle), Site.city.ilike(needle)))
         .order_by(Site.name).limit(LIMIT))
    rows = (await db.scalars(q)).all()
    return {"sites": [{"id": str(s.id), "name": s.name, "city": s.city}
                      for s in rows]}


async def _find_stakeholders(db: AsyncSession, args: dict) -> dict:
    needle = f"%{args.get('query', '')}%"
    out: list[dict] = []
    clients = (await db.scalars(
        select(Client).where(Client.name.ilike(needle))
        .order_by(Client.name).limit(LIMIT))).all()
    out += [{"id": str(c.id), "name": c.name, "kind": "client"}
            for c in clients]
    partners = (await db.scalars(
        select(Partner).where(Partner.name.ilike(needle))
        .order_by(Partner.name).limit(LIMIT))).all()
    out += [{"id": str(p.id), "name": p.name, "kind": "partner"}
            for p in partners]
    return {"stakeholders": out[:LIMIT]}


async def _count_records(db: AsyncSession, args: dict) -> dict:
    entity = args.get("entity")
    filters = args.get("filters") or {}
    if entity == "assets":
        q = select(func.count(Asset.id))
        if filters.get("client"):
            q = (q.join(Client, Asset.client_id == Client.id)
                 .where(Client.name.ilike(f"%{filters['client']}%")))
        if filters.get("site"):
            q = (q.join(Site, Asset.site_id == Site.id)
                 .where(Site.name.ilike(f"%{filters['site']}%")))
        if filters.get("status"):
            q = q.where(Asset.status == filters["status"])
    elif entity == "moves":
        q = (select(func.count(Initiative.id))
             .where(Initiative.initiative_type == "move"))
        if filters.get("status"):
            q = q.where(Initiative.status == filters["status"])
    elif entity == "workers":
        q = (select(func.count(func.distinct(PersonRole.person_id)))
             .where(PersonRole.role == "worker"))
    elif entity == "sites":
        q = select(func.count(Site.id))
    elif entity == "scans":
        q = select(func.count(ProcessedScan.id))
        if filters.get("days"):
            q = q.where(ProcessedScan.scanned_at
                        >= func.now() - func.make_interval(0, 0, 0,
                                                           filters["days"]))
    else:
        return {"error": f"unknown entity: {entity!r}"}
    return {"count": (await db.scalar(q)) or 0}


# tool name -> (permission resource, executor). navigate is intercepted
# by the route and never dispatched here.
_EXECUTORS = {
    "find_moves": ("initiatives", _find_moves),
    "find_assets": ("assets", _find_assets),
    "find_people": ("workers", _find_people),
    "find_sites": ("sites", _find_sites),
    "find_stakeholders": ("clients", _find_stakeholders),
    "count_records": (None, _count_records),
}

_COUNT_RESOURCES = {"assets": "assets", "moves": "initiatives",
                    "workers": "workers", "sites": "sites",
                    "scans": "scans"}


async def run_tool(name: str, args: dict, db: AsyncSession, user) -> dict:
    entry = _EXECUTORS.get(name)
    if entry is None:
        return {"error": f"unknown tool: {name!r}"}
    resource, fn = entry
    if resource is None:  # count_records gates per entity
        resource = _COUNT_RESOURCES.get(str(args.get("entity")))
    if resource is None or not user.access.can(resource, "view"):
        return {"error": "permission_denied"}
    try:
        return await fn(db, args)
    except Exception as exc:  # tool failures go back to the model, not 500
        return {"error": f"{type(exc).__name__}: {exc}"}
```

NOTE for the implementer: check the real column names before running —
`ProcessedScan.scanned_at` may be named differently (open
`src/serversherpa/db/models.py`, search `class ProcessedScan`); same for
`Site.city`. Use the actual names; adjust the test only if a field truly
doesn't exist. If `func.make_interval` proves awkward, use
`ProcessedScan.<ts_col> >= func.now() - text("make_interval(days => :d)")`
with a bound param, or compute the cutoff in Python with
`datetime.now(UTC) - timedelta(days=...)` — Python cutoff is simplest.

- [ ] **Step 5: Run tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_ai PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/test_ai_tools.py -q`
Expected: 8 passed

- [ ] **Step 6: Commit**

```bash
git add src/serversherpa/ai/prompts.py src/serversherpa/ai/tools.py tests/test_ai_tools.py
git commit -m "feat(ai): system prompt and permission-gated tool registry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 0045 + `POST /ai/chat` route

**Files:**
- Create: `api/migrations/versions/0045_ai_grants.py`
- Create: `api/src/serversherpa/api/routes/ai.py`
- Modify: `api/src/serversherpa/api/app.py` (routes import block + `include_router` list)
- Test: `api/tests/test_ai_chat_api.py`

**Interfaces:**
- Consumes: `serversherpa.ai.client` (`get_client`, `AiTurn`, `AiToolCall`, `AiUnavailableError`, `AiProtocolError`), `serversherpa.ai.tools` (`TOOLS`, `run_tool`, `validate_navigate`), `serversherpa.ai.prompts.SYSTEM_PROMPT`.
- Produces: `POST /ai/chat` — request `{"messages": [{"role": "user"|"assistant", "content": str}]}`, response `{"reply": str, "navigate": {"page": str, "id": str|null} | null}`; 403 without `ai:use`; 503 `{"detail": {"code": "ai_offline", ...}}` when disabled/unreachable. The portal (Task 4) relies on exactly this shape.

- [ ] **Step 1: Write the migration**

```python
# api/migrations/versions/0045_ai_grants.py
"""AI assistant: admin + developer roles gain ai:use.

Revision ID: 0045
Revises: 0044
Create Date: 2026-09-03
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0045"
down_revision: str | None = "0044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ROLES = ("admin", "developer")


def upgrade() -> None:
    conn = op.get_bind()
    for role in ROLES:
        conn.execute(sa.text(
            "INSERT INTO role_permissions (role, resource, action) "
            "VALUES (:r, 'ai', 'use') ON CONFLICT DO NOTHING"), {"r": role})


def downgrade() -> None:
    conn = op.get_bind()
    for role in ROLES:
        conn.execute(sa.text(
            "DELETE FROM role_permissions WHERE role = :r "
            "AND resource = 'ai' AND action = 'use'"), {"r": role})
```

- [ ] **Step 2: Write the failing tests**

```python
# api/tests/test_ai_chat_api.py
"""/ai/chat: gating, offline, the tool loop, navigate, caps, retry."""

import pytest

from serversherpa.ai import client as ai_client_mod
from serversherpa.ai.client import AiProtocolError, AiToolCall, AiTurn
from serversherpa.db.models import Initiative
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff


class FakeAiClient:
    """Scripted adapter. Each chat() pops the next turn; an exception
    instance in the script is raised instead."""

    def __init__(self, script):
        self.script = list(script)
        self.calls: list[list[dict]] = []

    async def chat(self, messages, tools):
        self.calls.append(messages)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def aclose(self):
        pass


def _install(monkeypatch, fake):
    monkeypatch.setattr(ai_client_mod, "get_client", lambda: fake)


async def test_forbidden_without_grant(client, db, seeded_user):
    hdrs = await login_staff(client, seeded_user)
    resp = await client.post("/ai/chat", headers=hdrs, json={
        "messages": [{"role": "user", "content": "hi"}]})
    assert resp.status_code == 403


async def test_offline_503_when_disabled(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/ai/chat", headers=hdrs, json={
        "messages": [{"role": "user", "content": "hi"}]})
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "ai_offline"


async def test_text_reply_passthrough(client, db, seeded_user, monkeypatch):
    hdrs = await login_admin(client, db, seeded_user)
    _install(monkeypatch, FakeAiClient([AiTurn(text="Hello!")]))
    resp = await client.post("/ai/chat", headers=hdrs, json={
        "messages": [{"role": "user", "content": "hi"}]})
    assert resp.status_code == 200
    assert resp.json() == {"reply": "Hello!", "navigate": None}


async def test_tool_loop_with_navigate(client, db, seeded_user, monkeypatch):
    hdrs = await login_admin(client, db, seeded_user)
    move = Initiative(name="NAP11 Hall Migration",
                      initiative_type="move", status="in_progress")
    db.add(move)
    await db.commit()
    fake = FakeAiClient([
        AiTurn(tool_calls=[AiToolCall("c1", "find_moves",
                                      {"status": "in_progress"})]),
        AiTurn(text="Opening it.",
               tool_calls=[AiToolCall("c2", "navigate", {
                   "page": "move_load_assets", "id": str(move.id)})]),
        AiTurn(text="Opening Load Assets for NAP11 Hall Migration."),
    ])
    _install(monkeypatch, fake)
    resp = await client.post("/ai/chat", headers=hdrs, json={
        "messages": [{"role": "user", "content": "load assets for nap11"}]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["navigate"] == {"page": "move_load_assets",
                                "id": str(move.id)}
    assert body["reply"] == "Opening Load Assets for NAP11 Hall Migration."
    # the tool result made it back to the model as a tool message
    tool_msgs = [m for m in fake.calls[1] if m["role"] == "tool"]
    assert "NAP11 Hall Migration" in tool_msgs[0]["content"]


async def test_bad_navigate_reported_to_model(client, db, seeded_user,
                                              monkeypatch):
    hdrs = await login_admin(client, db, seeded_user)
    fake = FakeAiClient([
        AiTurn(tool_calls=[AiToolCall("c1", "navigate",
                                      {"page": "warp_core"})]),
        AiTurn(text="Sorry, I can't open that."),
    ])
    _install(monkeypatch, fake)
    resp = await client.post("/ai/chat", headers=hdrs, json={
        "messages": [{"role": "user", "content": "open the warp core"}]})
    body = resp.json()
    assert body["navigate"] is None
    assert body["reply"] == "Sorry, I can't open that."


async def test_round_cap(client, db, seeded_user, monkeypatch):
    hdrs = await login_admin(client, db, seeded_user)
    looping = AiTurn(tool_calls=[AiToolCall("c", "find_moves", {})])
    _install(monkeypatch, FakeAiClient([looping] * 6))
    resp = await client.post("/ai/chat", headers=hdrs, json={
        "messages": [{"role": "user", "content": "loop forever"}]})
    assert resp.status_code == 200
    assert "couldn't finish" in resp.json()["reply"]


async def test_protocol_error_retries_once(client, db, seeded_user,
                                           monkeypatch):
    hdrs = await login_admin(client, db, seeded_user)
    fake = FakeAiClient([AiProtocolError("garbage"),
                         AiTurn(text="Recovered.")])
    _install(monkeypatch, fake)
    resp = await client.post("/ai/chat", headers=hdrs, json={
        "messages": [{"role": "user", "content": "hi"}]})
    assert resp.json()["reply"] == "Recovered."
    assert len(fake.calls) == 2


async def test_history_clamped(client, db, seeded_user, monkeypatch):
    hdrs = await login_admin(client, db, seeded_user)
    fake = FakeAiClient([AiTurn(text="ok")])
    _install(monkeypatch, fake)
    msgs = [{"role": "user", "content": f"m{i}"} for i in range(40)]
    resp = await client.post("/ai/chat", headers=hdrs,
                             json={"messages": msgs})
    assert resp.status_code == 200
    sent = fake.calls[0]
    # system prompt + at most 20 history messages
    assert len(sent) <= 21
    assert sent[0]["role"] == "system"
    assert sent[-1]["content"] == "m39"  # newest kept
```

NOTE: `login_admin` lives in `tests/test_access_roles_api.py` and
`login_staff` in `tests/test_notification_groups_api.py` — confirm the
import paths/signatures by opening those files; adjust imports if the
helpers moved, do not reimplement them.

- [ ] **Step 3: Run tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_ai PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/test_ai_chat_api.py -q`
Expected: FAIL — 404s (route not registered) after the migration autoruns

- [ ] **Step 4: Implement the route**

Create `api/src/serversherpa/api/routes/ai.py`:

```python
"""AI assistant chat: the model<->tool loop, run under the caller.

The client holds the visible history and sends it whole each time; the
server prepends the system prompt, executes tool calls (permission-
checked in tools.run_tool), and returns the final text plus at most one
validated navigate action (last one wins). No conversation state is
stored server-side."""

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal

from serversherpa.ai import client as ai_client_mod
from serversherpa.ai.client import (
    AiProtocolError, AiTurn, AiUnavailableError,
)
from serversherpa.ai.prompts import SYSTEM_PROMPT
from serversherpa.ai.tools import TOOLS, run_tool, validate_navigate
from serversherpa.api.deps import AuthContext, DbSession, require_permission

router = APIRouter(prefix="/ai", tags=["ai"])

MAX_ROUNDS = 5
MAX_MESSAGES = 20
FAIL_REPLY = "Sorry - I couldn't finish that request. Try rephrasing."
_OFFLINE = HTTPException(status_code=503, detail={
    "code": "ai_offline", "message": "AI assistant is offline."})


class AiChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2000)


class AiChatIn(BaseModel):
    messages: list[AiChatMessage] = Field(min_length=1, max_length=100)


class NavigateOut(BaseModel):
    page: str
    id: str | None = None


class AiChatOut(BaseModel):
    reply: str
    navigate: NavigateOut | None = None


def _assistant_msg(turn: AiTurn) -> dict:
    return {"role": "assistant", "content": turn.text or "",
            "tool_calls": [{"id": c.id, "type": "function", "function": {
                "name": c.name, "arguments": json.dumps(c.args)}}
                for c in turn.tool_calls]}


@router.post("/chat", response_model=AiChatOut)
async def ai_chat(
    payload: AiChatIn,
    db: DbSession,
    actor: AuthContext = require_permission("ai", "use"),
) -> AiChatOut:
    ai = ai_client_mod.get_client()
    if ai is None:
        raise _OFFLINE
    history = [m.model_dump() for m in payload.messages[-MAX_MESSAGES:]]
    convo: list[dict] = [{"role": "system",
                          "content": SYSTEM_PROMPT}] + history
    navigate: NavigateOut | None = None
    retried = False
    try:
        for _ in range(MAX_ROUNDS):
            try:
                turn = await ai.chat(convo, TOOLS)
            except AiUnavailableError:
                raise _OFFLINE from None
            except AiProtocolError:
                if retried:
                    return AiChatOut(reply=FAIL_REPLY, navigate=navigate)
                retried = True
                convo.append({"role": "user", "content":
                              "Your last reply was malformed. Answer "
                              "again with valid tool calls or plain "
                              "text."})
                continue
            if not turn.tool_calls:
                return AiChatOut(reply=turn.text or FAIL_REPLY,
                                 navigate=navigate)
            convo.append(_assistant_msg(turn))
            for call in turn.tool_calls:
                if call.name == "navigate":
                    try:
                        navigate = NavigateOut(**validate_navigate(call.args))
                        result: dict = {"ok": True}
                    except ValueError as exc:
                        result = {"error": str(exc)}
                else:
                    result = await run_tool(call.name, call.args, db, actor)
                convo.append({"role": "tool", "tool_call_id": call.id,
                              "content": json.dumps(result, default=str)})
        return AiChatOut(reply=FAIL_REPLY, navigate=navigate)
    finally:
        await ai.aclose()
```

Modify `api/src/serversherpa/api/app.py`: add `ai` to the existing
`from serversherpa.api.routes import (...)` block (alphabetical — right
after `access`), and add `app.include_router(ai.router)` directly after
`app.include_router(access.router)` (line ~93).

- [ ] **Step 5: Run tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_ai PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/test_ai_chat_api.py tests/test_ai_tools.py tests/test_ai_client.py -q`
Expected: all pass (8 chat + 8 tools + 6 client)

- [ ] **Step 6: Commit**

```bash
git add migrations/versions/0045_ai_grants.py src/serversherpa/api/routes/ai.py src/serversherpa/api/app.py tests/test_ai_chat_api.py
git commit -m "feat(ai): /ai/chat model-tool loop + ai:use grants (migration 0045)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Portal — chat panel, navigation, Topbar wiring

**Files:**
- Modify: `portal/src/lib/api.ts` (append near the other request helpers)
- Create: `portal/src/components/AiAssistant.tsx`
- Create: `portal/src/styles/ai.css`
- Modify: `portal/src/components/Topbar.tsx` (~lines 326-334, the `pop === 'ai'` popover body)
- Test: `portal/src/components/AiAssistant.test.tsx`

**Interfaces:**
- Consumes: `POST /ai/chat` shape from Task 3, via `apiFetch` (existing helper in `lib/api.ts`).
- Produces: `<AiAssistant onClose={() => void} />`; `aiChatRequest(messages: AiChatMessage[]): Promise<AiChatOut>` in `lib/api.ts`.

- [ ] **Step 1: Write the failing tests**

```tsx
// portal/src/components/AiAssistant.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import AiAssistant from './AiAssistant';

const aiChatRequest = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (orig) => ({
  ...(await orig() as object), aiChatRequest,
}));

function mount() {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<AiAssistant onClose={onClose} />} />
        <Route path="/initiatives/:id/import-assets"
               element={<div>LOAD ASSETS PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose };
}

async function send(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/ask about/i),
                   { target: { value: text } });
  fireEvent.submit(screen.getByRole('form', { name: /ai assistant/i }));
}

describe('AiAssistant', () => {
  it('sends a message and renders the reply', async () => {
    aiChatRequest.mockResolvedValueOnce({
      reply: 'Broadcom has 37 assets in storage.', navigate: null });
    mount();
    await send('how many assets does broadcom have in storage');
    await waitFor(() => expect(
      screen.getByText(/37 assets in storage/)).toBeInTheDocument());
    expect(aiChatRequest).toHaveBeenCalledWith([
      { role: 'user',
        content: 'how many assets does broadcom have in storage' }]);
  });

  it('navigates and closes when the reply carries navigate', async () => {
    const { onClose } = mount();
    aiChatRequest.mockResolvedValueOnce({
      reply: 'Opening it.',
      navigate: { page: 'move_load_assets', id: 'abc-123' } });
    await send('load assets for nap11');
    await waitFor(() =>
      expect(screen.getByText('LOAD ASSETS PAGE')).toBeInTheDocument());
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the offline note on 503', async () => {
    aiChatRequest.mockRejectedValueOnce(new Error('ai_offline'));
    mount();
    await send('hello');
    await waitFor(() => expect(
      screen.getByText('AI assistant is offline.')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ../portal && npx vitest run src/components/AiAssistant.test.tsx`
Expected: FAIL — cannot resolve `./AiAssistant`

- [ ] **Step 3: Implement api.ts additions, component, styles, Topbar wiring**

Append to `portal/src/lib/api.ts` (match the file's existing error style —
open a neighboring helper like `savePreferencesRequest` and copy its
`if (!resp.ok)` handling verbatim):

```ts
export type AiChatMessage = { role: 'user' | 'assistant'; content: string };
export type AiNavigate = { page: string; id?: string | null };
export type AiChatOut = { reply: string; navigate: AiNavigate | null };

export async function aiChatRequest(
  messages: AiChatMessage[],
): Promise<AiChatOut> {
  const resp = await apiFetch('/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  if (resp.status === 503) throw new Error('ai_offline');
  if (!resp.ok) throw new Error('ai_chat_failed');
  return resp.json();
}
```

Create `portal/src/components/AiAssistant.tsx`:

```tsx
/** Chat panel behind the Topbar AI button. Client-held history (cleared
 * on unmount); a `navigate` in the response routes and closes the panel. */
import { FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AiChatMessage, aiChatRequest } from '../lib/api';
import '../styles/ai.css';

const PAGE_ROUTES: Record<string, (id?: string | null) => string> = {
  assets: () => '/assets',
  asset_detail: (id) => `/assets/${id}`,
  initiatives: () => '/initiatives',
  initiative_detail: (id) => `/initiatives/${id}`,
  move_load_assets: (id) => `/initiatives/${id}/import-assets`,
  workers: () => '/people/workers',
  worker_detail: (id) => `/people/workers/${id}`,
  sites: () => '/sites',
  clients: () => '/stakeholders/clients',
  client_detail: (id) => `/stakeholders/clients/${id}`,
  partners: () => '/stakeholders/partners',
  scans: () => '/scans',
};

export default function AiAssistant({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const out = await aiChatRequest(next);
      setMessages([...next,
                   { role: 'assistant' as const, content: out.reply }]);
      if (out.navigate && PAGE_ROUTES[out.navigate.page]) {
        navigate(PAGE_ROUTES[out.navigate.page](out.navigate.id));
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error && err.message === 'ai_offline'
        ? 'AI assistant is offline.'
        : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }

  return (
    <div className="ai-panel">
      <div className="ai-messages" ref={listRef}>
        {messages.length === 0 && !error && (
          <div className="ai-hint">
            Ask about your moves, assets, sites, and people — or say
            where to go, like “load assets for the NAP11 move”.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ai-msg ai-msg-${m.role}`}>{m.content}</div>
        ))}
        {busy && <div className="ai-msg ai-msg-assistant ai-busy">…</div>}
        {error && <div className="ai-error">{error}</div>}
      </div>
      <form aria-label="AI assistant" onSubmit={onSubmit} className="ai-form">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about moves, assets, people…"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
```

Create `portal/src/styles/ai.css` (follow the token/variable usage you see
in `portal/src/styles/hardware.css` — colors via existing CSS variables,
no hardcoded hex beyond what neighboring files use):

```css
/* AI assistant panel (Topbar popover body) */
.ai-panel { width: 340px; display: flex; flex-direction: column; }
.ai-messages { max-height: 320px; overflow-y: auto; padding: 4px 2px;
  display: flex; flex-direction: column; gap: 6px; }
.ai-hint { color: var(--text-dim, #667); font-size: 12.5px; padding: 6px 4px; }
.ai-msg { border-radius: 10px; padding: 6px 10px; font-size: 13px;
  line-height: 1.35; max-width: 92%; white-space: pre-wrap; }
.ai-msg-user { align-self: flex-end; background: var(--accent-soft, #eef); }
.ai-msg-assistant { align-self: flex-start; background: var(--panel-2, #f4f4f6); }
.ai-busy { opacity: 0.6; }
.ai-error { color: var(--c-red, #c0392b); font-size: 12.5px; padding: 4px; }
.ai-form { display: flex; gap: 6px; margin-top: 8px; }
.ai-form input { flex: 1; }
```

Modify `portal/src/components/Topbar.tsx`: replace the `pop === 'ai'`
popover body (the `pop-empty` div with the coming-soon copy) with:

```tsx
          {pop === 'ai' && (
            <div className="pop-menu pop-menu-ai">
              <div className="pop-title">AI Assistant</div>
              <AiAssistant onClose={() => setPop(null)} />
            </div>
          )}
```

Add `import AiAssistant from './AiAssistant';` with the other component
imports, update the button `title` to `"AI assistant"` (drop
"(coming soon)"), and add `.pop-menu-ai { width: auto; }` beside wherever
`.pop-menu` is defined (find it with grep; keep the existing popover
open/close behavior — do NOT close the pop on inside clicks; check the
existing outside-click handler `popRef` doesn't swallow form submits).

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/components/AiAssistant.test.tsx` — Expected: 3 passed
Run: `npx vitest run` — Expected: full portal suite passes
Run: `npm run build` — Expected: clean build

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/components/AiAssistant.tsx src/components/Topbar.tsx src/styles/ai.css src/components/AiAssistant.test.tsx
git commit -m "feat(portal): AI assistant chat panel behind the Topbar button

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Eval script, env docs, full-suite verification

**Files:**
- Create: `api/scripts/ai_eval.py` (create the `scripts/` dir if absent)
- Modify: `.env.example` (repo root — add the AI block after the Email block)
- Test: full API + portal suites (no new test files)

**Interfaces:**
- Consumes: `serversherpa.ai.prompts.SYSTEM_PROMPT`, `serversherpa.ai.tools.TOOLS`.

- [ ] **Step 1: Add the .env.example block**

```
# ── AI assistant ────────────────────────────────────────────
# Local Ollama (OpenAI-compatible). Point SS_AI_BASE_URL at the Mac mini
# in prod (e.g. http://mini16.local:11434/v1). Disabled by default.
SS_AI_ENABLED=false
SS_AI_BASE_URL=http://localhost:11434/v1
SS_AI_MODEL=qwen3:8b
SS_AI_TIMEOUT_SECONDS=60
```

- [ ] **Step 2: Write the eval script**

```python
# api/scripts/ai_eval.py
"""Dev-only eval: fire ~20 representative commands at a REAL model and
score whether its FIRST action matches expectations. Not CI - run by
hand when tuning the prompt or comparing models:

    SS_AI_ENABLED=true SS_AI_BASE_URL=http://mini16.local:11434/v1 \
    PYTHONPATH=src .venv/bin/python scripts/ai_eval.py
"""

import asyncio
import sys

from serversherpa.ai.client import get_client
from serversherpa.ai.prompts import SYSTEM_PROMPT
from serversherpa.ai.tools import TOOLS

# (command, expected first tool or "text")
CASES = [
    ("load assets for move", "find_moves"),
    ("load assets for the nap11 move", "find_moves"),
    ("open the broadcom client page", "find_stakeholders"),
    ("how many assets does broadcom have in storage", "count_records"),
    ("how many assets are at nap11", "count_records"),
    ("where is asset JX4M2P1", "find_assets"),
    ("find serial ABC123", "find_assets"),
    ("show me all in progress moves", "find_moves"),
    ("which moves are planned", "find_moves"),
    ("open the assets page", "navigate"),
    ("take me to sites", "navigate"),
    ("show me grace huizing", "find_people"),
    ("who is the tech named terry", "find_people"),
    ("open nap11", "find_sites"),
    ("how many scans in the last 7 days", "count_records"),
    ("how many workers do we have", "count_records"),
    ("show partners", "navigate"),
    ("delete all decommissioned assets", "text"),
    ("mark asset ABC as received", "text"),
    ("what's the weather like", "text"),
]


async def main() -> int:
    ai = get_client()
    if ai is None:
        print("SS_AI_ENABLED is false or unset - nothing to eval.")
        return 2
    passed = 0
    for prompt, expected in CASES:
        turn = await ai.chat(
            [{"role": "system", "content": SYSTEM_PROMPT},
             {"role": "user", "content": prompt}], TOOLS)
        got = turn.tool_calls[0].name if turn.tool_calls else "text"
        ok = got == expected
        passed += ok
        print(f"{'PASS' if ok else 'FAIL':4}  {prompt!r}: "
              f"expected {expected}, got {got}")
    await ai.aclose()
    print(f"\n{passed}/{len(CASES)} passed")
    return 0 if passed == len(CASES) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
```

- [ ] **Step 3: Sanity-check the script imports (no model needed)**

Run: `PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python scripts/ai_eval.py`
Expected: exits with "SS_AI_ENABLED is false or unset - nothing to eval."

- [ ] **Step 4: Full suites (FOREGROUND, long timeout)**

Run: `SS_TEST_DB=serversherpa_test_ai PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q` (timeout 600000ms)
Expected: everything passes (pre-existing known failure exception: `test_scans_people_flow_api::test_limit_and_since` may fail — it fails on a clean tree; anything else failing is yours to fix)
Run: `cd ../portal && npx vitest run` then `npm run build`
Expected: all pass, clean build

- [ ] **Step 5: Commit**

```bash
git add scripts/ai_eval.py ../.env.example
git commit -m "feat(ai): model eval script + env documentation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
