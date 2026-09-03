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
