# Model spec lookup (Claude web search) — design

**Date:** 2026-09-28 · **Branch:** `spec-lookup` · **Migration:** 0080 (0074–0079 are held by the `wiki` branch)

## Goal

Fill the gaps in the Makes / Models catalog — RU size, weight, dimensions, and optionally
mounting and a knowledge note — by having Claude search the web one model at a time. Findings
land as reviewable suggestions with a source URL and the exact quoted text; confident matches may
fill blank fields automatically when an admin turns that on.

On 2026-09-28 the dev catalog had 416 models: 200 with no RU, 223 with no weight, 226 with
incomplete dimensions, 189 with none of the three.

## Decisions (Jimmy, 2026-09-28)

- **Provider: the Claude API**, not the local Ollama model. Make/model names are not sensitive,
  and Claude's server-side `web_search` + `web_fetch` tools handle search, PDF spec sheets and
  variant matching far better than qwen3:8b + a scraper. SearXNG is dropped. The worker talks to
  Claude through one small "lookup provider" function so a local provider could be added later
  (not built now).
- **Review queue + optional auto-apply.** Suggestions always appear in a review queue. A setting
  (default **off**) lets verified values fill **blank** fields immediately; they appear as
  "applied" with Undo. Knowledge notes never auto-apply.
- **Triggering:** a background sweep with an on/off toggle, plus buttons ("Find missing specs",
  per-model "Look up specs") that jump the queue.
- **Field groups, each a toggle:** Specs (RU, weight, L×W×H) default on; Mounting (mount_type,
  rail_type) default off; Knowledge (a short note into `knowledge`) default off.
- **Private models:** `asset_models.private` — a private model is never sent to Claude, by the
  sweep or the button.
- **Look up once:** `asset_models.specs_looked_up_at` keeps the sweep from re-searching models.
- **Env:** new keys in the repo `.env` and `.env.example`. Because they live in `.env`, the
  existing Developer › System Config › **Environment** tab can already set them (secrets masked,
  keep-on-empty). A new read-only **Spec lookup** tab beside it shows the configuration, worker
  health and a Test connection button. The key is never shown in full in the portal.

## Data (migration 0080)

`asset_models` gains:

| Column | Type | Meaning |
|---|---|---|
| `private` | bool not null default false | never sent to Claude |
| `spec_lookup_skip` | bool not null default false | junk entry; the sweep ignores it and the button is disabled |
| `specs_looked_up_at` | timestamptz null | last completed lookup, whatever the outcome |

`spec_lookup_jobs` — the queue:
`id`, `model_id` (FK cascade), `priority` (int; 0 sweep, 10 "Find missing specs", 20 per-model
button), `status` (queued | running | done | failed), `attempts`, `next_attempt_at`,
`requested_by` (FK people, null for the sweep), `error`, `input_tokens`, `output_tokens`,
`search_count`, `created_at`, `started_at`, `finished_at`, `heartbeat_at`, `worker_id`.
Partial unique index: one queued/running job per model.

`spec_suggestions` — one row per value:
`id`, `model_id` (FK cascade), `job_id` (FK set null), `field` (ru_size | weight | length |
width | height | mount_type | rail_type | knowledge), `value` (text), `unit` (lbs | kg | in | cm |
null), `source_url`, `quote`, `previous_value` (the field's value when the suggestion was made; the 409 checks compare against it), `status` (pending | applied | approved | rejected | reverted),
`decided_by` (FK people), `decided_at`, `created_at`.

A new lookup for a model supersedes that model's older **pending** suggestions for the same
field (they are marked rejected with decided_by null).

## Settings

`system_config` section `ai_lookup` (defaults in `config_store.DEFAULTS`, no seed needed):

| Key | Default |
|---|---|
| `background_enabled` | false |
| `auto_apply` | false |
| `fields_specs` | true |
| `fields_mounting` | false |
| `fields_knowledge` | false |
| `retry_after_days` | 90 (0 = never retry automatically) |

`GET/PUT /system/ai-lookup` follow the security section's pattern exactly (partial PUT,
`settings` view/change permission, audit `ai_lookup_config_update`).

Env (`.env` and `.env.example`, new block after the AI assistant block; read via `config.py`):

```
SS_ANTHROPIC_API_KEY=
SS_SPEC_LOOKUP_MODEL=claude-sonnet-5
SS_SPEC_LOOKUP_MAX_SEARCHES=4
SS_SPEC_LOOKUP_MAX_FETCHES=3
```

No key means "not configured": the worker idles, the sweep queues nothing, the buttons are
disabled with that reason.

## Worker: `spec-lookup-worker`

A new CLI command and `Procfile.dev` line, built from the label worker
(`labels/generate/worker.py` + `jobs.py`): `--once`, `--reload`, `poll_workers_paused`, heartbeat
via `registry.start_heartbeat`, stale-run requeue, once-per-outage error logging.

Each loop:

1. **Sweep** (at most once a minute, only when `background_enabled` and a key is configured):
   queue priority 0 jobs for models where
   - not `private` and not `spec_lookup_skip`, and
   - some field in an **enabled** group is blank, and
   - `specs_looked_up_at` is null, or `retry_after_days > 0` and it is older than that, and
   - no queued/running job exists.
2. **Claim** the highest priority, oldest job whose `next_attempt_at` is due
   (`FOR UPDATE SKIP LOCKED`).
3. **Re-check** the model: if it is now private or skipped, finish the job as `done` with
   error `private` / `skipped` and send nothing.
4. **Look up** — one Claude Messages call through the Anthropic Python SDK:
   - tools `web_search_20260209` (`max_uses` = MAX_SEARCHES) and `web_fetch_20260209`
     (`max_uses` = MAX_FETCHES);
   - structured JSON output: for each requested field `{value, unit, quote, source_url}` or null;
   - input is only make, model, aliases, category and the list of wanted (blank + enabled)
     fields; instructions prefer the manufacturer's own pages and forbid answering from memory.
5. **Verify in code.** A value survives only if:
   - its `quote` contains the number (normalized: commas, fractions like "17.5", unit words);
   - it is in bounds — RU 1–60; weight 0.1–3000 lbs (0.05–1361 kg); each dimension 0.5–120 in
     (1–305 cm); mount/rail text ≤ 100 chars; knowledge ≤ 1000 chars;
   - `source_url` appeared in that call's search results or fetch blocks.
   Numbers become the stored field(s): weight/dimension values keep their unit and
   `assets/units.py` `apply_unit_pairs` fills the partner column on apply.
6. **Record:** insert suggestions, set `specs_looked_up_at`, store tokens and search count on
   the job. If `auto_apply` is on, for each non-knowledge suggestion whose target field is still
   blank: apply it through the same path as PATCH /asset-models (unit pairs, validation, audit
   `update` with actor null and `changes` noting `source: spec_lookup`), status `applied`.

## Errors

| Case | Behavior |
|---|---|
| No key / 401 / 403 | job `failed` "not_configured"; sweep stops queuing; portal banner |
| 429, 5xx, network, timeout | back to `queued`, `next_attempt_at` +1m, +5m, +30m; after 3 attempts `failed`; `specs_looked_up_at` NOT set |
| Refusal or output failing the schema | job `failed` with reason; `specs_looked_up_at` set (no retry until the window) |
| Nothing found | job `done`, no suggestions, `specs_looked_up_at` set |
| Approve when the field no longer equals `previous_value` | 409 `field_changed`; row shows the current value |
| Undo when the field no longer holds the applied value | 409 `field_changed` |

Auto-apply and approve never overwrite a non-blank field without an explicit approve on a
row that shows the current value (approve of a non-blank field is allowed — the admin saw both).

## API — `routes/spec_lookup.py`

All routes use `_require_global` (as `/asset-models` does) so client-anchored users are refused.

| Route | Permission |
|---|---|
| `GET /spec-lookup/status` — configured?, background on?, queue counts, current model, last run, month-to-date tokens/searches/est. cost | asset_models view |
| `POST /spec-lookup/queue` `{model_ids?}` — all eligible (priority 10) or the listed ids (priority 20; ignores the retry window; refuses private/skip per id and returns per-id skips) | asset_models change |
| `GET /spec-lookup/suggestions?status=&model_id=` | asset_models view |
| `POST /spec-lookup/suggestions/{id}/approve \| reject \| undo` | asset_models change |
| `POST /spec-lookup/suggestions/bulk` `{ids, action}` → per-row results | asset_models change |
| `GET /spec-lookup/dev`, `POST /spec-lookup/dev/test` | devtools view |

`AssetModelOut`/`In` gain `private`, `spec_lookup_skip`, `specs_looked_up_at` (read-only).
Est. cost uses constants for Sonnet 5 ($2/$10 per MTok) and search ($10 per 1,000).

## Portal

- **Makes / Models** — the segmented switch becomes `All | Review | Spec lookup`, the new tab
  badged with the pending count. The tab has:
  - a status strip (queue, current model, last run, month-to-date spend) with
    **Find missing specs** and a Background on/off shortcut;
  - a `DataTable` (the sanctioned table component; list typography comes with it): Model ·
    Field · Current · Suggested · Source (domain link) · Quote (truncated, full on hover) ·
    Status · Found; segmented filter Pending | Applied | All; row Approve / Reject / Undo;
    multi-select bulk approve/reject ending in `BulkApplySummary` with CSV download.
- **Expanded model row** — action bar gains **Look up specs** (disabled with a reason when
  private, skipped or not configured); the row shows "Last looked up …" and pending suggestions.
- **Edit model form** — switches **Private** ("Never sent to Claude for spec lookup") and
  **Skip spec lookup**.
- **Settings › AI lookup** — a new tab with the six settings using `Switch` / `canChange`.
- **Developer › System Config** — a new read-only **Spec lookup** tab (next to Logging and
  Environment): model, max searches/fetches, key "Set (…last 4)" / "Not set", worker heartbeat,
  **Test connection** (a tiny no-tools call reporting latency or the error). The key itself is
  set in the Environment tab.

## Testing

- The Claude call sits behind `spec_lookup/provider.py`; tests inject a fake provider returning
  canned results. No live calls in the suite.
- API: verifier (quote/number match, bounds, URL-seen rule), sweep eligibility (private, skip,
  retry window, field toggles, existing job), private re-check before the call, auto-apply
  (blank-only, unit pairs, audit), supersede, approve/undo 409s, retry/backoff, route permissions
  including a client-anchored user.
- Portal: Spec lookup tab, action-bar button states, edit-form switches, settings tab,
  Developer panel.
- Live verification: ~10 dev-catalog models (easy ones like HPE DL320 Gen11 and IBM Power 750
  (8408-E8D), plus junk like "Pure Storage controller 0") against the real API, recording the
  real cost per model before anyone runs Find missing specs on the whole catalog.

## Out of scope

A local (Ollama/SearXNG) provider; overwriting existing values automatically; power/PSU fields;
looking up new models the moment an import creates them (the sweep picks them up).
