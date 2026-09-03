# AI Assistant (Phase 1) — Design

2026-09-03. Status: approved in conversation (Jimmy), implementing.

## Summary

Turn the Topbar's "AI assistant (coming soon)" button into a working
natural-language assistant: staff type requests like "load assets for the
NAP11 move", "where is asset JX4M2P1", or "how many assets does Broadcom
have in storage", and the assistant either answers from live data, asks one
clarifying question, or navigates the portal to the right page.

Phase 1 is **read-only + navigation only**. Report generation, mutations,
and streaming are explicitly deferred.

The model is a **local Ollama instance** (Mac mini M4 16GB, Qwen3 8B q4 to
start) reached over its OpenAI-compatible API. All model access goes through
one thin provider adapter so the model/host can be swapped (bigger mini,
DGX, or a cloud API) by changing config only. Data-control rationale: the
model sees the user's request, tool schemas, and small lookup results —
never bulk data; report rendering (phase 2) will keep result rows out of
the model entirely.

## Goals

- Natural-language lookups about moves, assets, sites, people, stakeholders.
- Clarify-then-act flows ("load assets for move" → "which move?" → navigate).
- Counts ("how many …") answered via a count tool, not fetched lists.
- All tool execution under the requesting user's own permission context.
- Provider-agnostic: one config change swaps model or host.
- Graceful offline behavior when the model host is unreachable.

## Non-goals (Phase 1)

- No report generation (phase 2: AI fills a report spec; server renders).
- No mutations of any kind; the assistant is read-only by construction.
- No streaming responses (8B latency is acceptable without it).
- No conversation persistence across page reloads.

## Architecture

New backend module `api/src/serversherpa/ai/`:

- **`client.py` — provider adapter.** Async HTTP (httpx) against an
  OpenAI-compatible `/v1/chat/completions` endpoint with `tools` support.
  Config: `SS_AI_BASE_URL` (e.g. `http://mini16.local:11434/v1`),
  `SS_AI_MODEL` (e.g. `qwen3:8b`), `SS_AI_ENABLED` (default false),
  `SS_AI_TIMEOUT_SECONDS` (default 60). No other file may talk to the model.
  The adapter exposes one call: `chat(messages, tools) -> AiTurn` where
  AiTurn is either assistant text or a list of tool calls. Malformed tool
  JSON → one retry with an appended corrective message, then a polite
  failure text.
- **`tools.py` — tool registry.** Seven tools, each a JSON schema plus an
  async executor taking `(db, user_access, args)`:
  `navigate`, `find_moves`, `find_assets`, `find_people`, `find_sites`,
  `find_stakeholders`, `count_records`. Executors call the existing
  service/query layer and apply the caller's permissions the same way the
  matching REST routes do (reuse the routes' query-building helpers where
  practical; the global `search.py` machinery is a candidate for the find_*
  implementations). `navigate` executes nothing server-side — it validates
  the page/id and is returned to the client as the turn's action. Every
  find_* result is truncated to a compact shape (id + a few display fields,
  limit ≤ 10) before it is shown to the model.
- **`prompts.py` — system prompt + few-shot examples.** The prompt and
  worked examples from the design conversation (rules: tools-for-facts,
  one clarifying question, single-match-acts, read-only refusals, terse
  replies). Target ≤ ~3K tokens total; examples capped at 8.
- **`routes/ai.py` — `POST /ai/chat`.** Request: `{messages: [{role, content}]}`
  (client-held history, capped server-side at 20 messages / 8K chars).
  Response: `{reply: str, navigate: {page, id?} | null}`. The route runs the
  model↔tool loop (max 5 tool rounds), executing tools under the caller's
  access. Guarded by `require_permission("ai", "use")`. When
  `SS_AI_ENABLED` is false or the host is unreachable, returns 503 with
  error code `ai_offline`.
- **Migration 0045**: `role_permissions` grants — `ai`/`use` for admin and
  developer roles (staff can be added later via the existing permissions UI).

Portal:

- **`components/AiAssistant.tsx`** replaces the coming-soon popover body:
  message list, input, busy state, error state ("AI assistant is offline").
  On a `navigate` action in the response, push the mapped route via
  react-router and close the panel. Page-key → route mapping lives beside
  the component and must cover exactly the `navigate` enum.
- **`lib/api.ts`**: `aiChat(messages)` client function; `AiChatOut` type.
- Conversation state lives in the component (cleared on close); no storage.
- The Topbar button keeps its `ai-glow` styling; popover becomes the panel
  (position/size per existing `pop` conventions, wider than the notif pop).

## Data flow

1. User types into the panel; portal POSTs full visible history to `/ai/chat`.
2. Route builds `[system prompt + few-shots] + history`, calls the adapter.
3. Model returns tool calls → route executes them (permission-checked),
   appends results, calls the model again (≤ 5 rounds).
4. Model returns text (and possibly a validated `navigate` from an earlier
   round in the same turn — the last `navigate` wins) → route responds.
5. Portal renders the reply; if `navigate` present, routes there.

## Error handling

- Model host down / timeout → 503 `ai_offline`; panel shows offline note.
- Tool executor error → tool result carries `{"error": ...}` back to the
  model (which apologizes/adjusts); route never 500s on a tool failure.
- Malformed model output → one corrective retry, then a canned failure reply.
- Permission denied inside a tool → tool result says so; the model relays.
- Loop cap reached → canned "I couldn't finish that" reply.

## Testing

- Unit tests with a **FakeAiClient** (scripted AiTurns): the tool loop,
  permission gating (a user without assets:view gets no asset data),
  navigate validation (bad page/id rejected), history caps, offline 503,
  malformed-output retry path.
- Tool executor tests against the real test DB (find/count correctness,
  result truncation).
- Portal vitest: panel render, send flow (mocked api), navigate dispatch,
  offline state.
- A ~20-command eval script (`api/scripts/ai_eval.py`, runs only when a
  real endpoint is configured) is included as a dev tool, not CI.

## Config

`.env.example` additions:

```
SS_AI_ENABLED=false
SS_AI_BASE_URL=http://localhost:11434/v1
SS_AI_MODEL=qwen3:8b
SS_AI_TIMEOUT_SECONDS=60
```

Live-model verification (Ollama on the mini) is a manual step after merge —
no Ollama exists on the dev machine; all CI-path tests use the fake client.

## Phases (later)

- Phase 2: report generation via AI-filled report specs rendered server-side.
- Phase 3: mutating actions with confirm-before-execute.
- Model upgrades: 14B/32B on the 32GB mini; decision driven by the eval set.
