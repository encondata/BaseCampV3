"""/ai/chat: gating, offline, the tool loop, navigate, caps, retry."""

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


async def test_round_cap_drops_earlier_navigate(client, db, seeded_user,
                                                monkeypatch):
    """A navigate validated in an early round must not survive onto a
    FAIL_REPLY once the round cap is hit — otherwise the portal navigates
    and closes the panel, hiding the failure text."""
    hdrs = await login_admin(client, db, seeded_user)
    move = Initiative(name="NAP11 Hall Migration",
                      initiative_type="move", status="in_progress")
    db.add(move)
    await db.commit()
    navigate_then_loop = [
        AiTurn(tool_calls=[AiToolCall("c0", "navigate", {
            "page": "move_load_assets", "id": str(move.id)})]),
    ] + [AiTurn(tool_calls=[AiToolCall("c", "find_moves", {})])] * 5
    _install(monkeypatch, FakeAiClient(navigate_then_loop))
    resp = await client.post("/ai/chat", headers=hdrs, json={
        "messages": [{"role": "user", "content": "loop forever"}]})
    assert resp.status_code == 200
    body = resp.json()
    assert "couldn't finish" in body["reply"]
    assert body["navigate"] is None


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


async def test_history_char_clamp(client, db, seeded_user, monkeypatch):
    """20 messages of 2000 chars each (40,000 total) exceed the 8,000-char
    budget even though they're within the 20-message cap; oldest ones must
    be dropped until the kept history fits, and the newest always survives."""
    hdrs = await login_admin(client, db, seeded_user)
    fake = FakeAiClient([AiTurn(text="ok")])
    _install(monkeypatch, fake)
    msgs = [{"role": "user", "content": f"m{i}" + ("x" * 1996)}
            for i in range(20)]
    resp = await client.post("/ai/chat", headers=hdrs,
                             json={"messages": msgs})
    assert resp.status_code == 200
    sent = fake.calls[0]
    history = [m for m in sent if m["role"] != "system"]
    assert sum(len(m["content"]) for m in history) <= 8000
    assert history[-1]["content"] == msgs[-1]["content"]  # newest kept
