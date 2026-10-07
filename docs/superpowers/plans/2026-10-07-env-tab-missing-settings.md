# System config › Env: settings not in .env yet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Env tab (/dev/system-config) also lists settings that `.env.example` defines but the server's `.env` doesn't have yet, and lets a devtools user add them — without opening a path to inject arbitrary or hidden keys.

**Why:** Jimmy couldn't find `SS_DB_TESTING_PASSWORD` (added to `.env.example` after his `.env` was made). Six more keys had drifted the same way. Approved 2026-10-07.

## Global Constraints

- Allowlist = the keys in `.env.example` next to the `.env` being edited (`env_file.default_env_path().with_name(".env.example")`). Only keys in that file, not already in `.env`, and not hidden (`env_file.is_hidden`) may be added. If `.env.example` is missing (e.g. a container without it), there are simply no missing entries and nothing can be added.
- `GET /system/env` keeps `entries` exactly as today and adds `missing`: one item per allowed key in `.env.example` order: `{ key, secret, section, description, example }` — `section`/`description` parsed from `.env.example` the same way `.env` is parsed; `example` = the example file's value for non-secret keys, omitted for secret keys (never echo a secret example).
- `PUT /system/env` accepts missing keys in `values` (same body shape). A missing secret with `""` is skipped (like today's "keep the stored secret"); a missing non-secret is added with the value given (may be `""`). Line-break guard applies to added values too. Unknown keys (not in `.env` and not allowed missing) still → 422 `invalid_env_update` with `unknown`.
- Added keys are appended to the end of `.env`, grouped under a one-line comment heading `# {section}` (the example's section text) — one heading per section per save, omitted when the section is empty; existing lines are never reordered. Same atomic write + `.env.bak` as today.
- The response's `changed` includes added keys; the audit row's changes become `{"changed": [...], "added": [...]}` (added ⊆ changed).
- Portal Env tab: missing entries appear in their own block after the normal list, headed **Not in .env yet**, with the hint **These settings are in .env.example but not in this server's .env, so they use their built-in defaults. Add one to set it here.** Each row: Key, the value input (in edit mode; placeholder = the example value or `secret` for secrets), Status chip **Not in .env**, Description. In edit mode a **Use example** mini button fills a non-secret's example value. Saving sends them with the rest; after save the list reloads (the added keys move into the normal list).
- Reuse the tab's existing list/edit idioms; no native `<select>`; list-typography and other guardrails pass.
- American English. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`. Never commit `api/src/serversherpa/_dev_reload.py`.
- API tests from `api/`: `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_envmissing .venv/bin/pytest -q tests/test_env_file.py tests/test_env_api.py` (foreground). Portal from `portal/`: targeted files, full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: API — list and add missing settings

**Files:** `api/src/serversherpa/system/env_file.py`, `api/src/serversherpa/api/routes/system.py`; tests `api/tests/test_env_file.py`, `api/tests/test_env_api.py`.
**Produces:** `env_file.default_example_path() -> Path`; `env_file.read_missing(env_path, example_path) -> list[dict]`; `env_file.apply_updates(path, values, descriptions=None, *, example_path=None) -> list[str]` adds allowed missing keys (and returns them in `changed`); a way for the route to know which were added (e.g. return `(changed, added)` from a new function, or a separate helper — keep `apply_updates`' existing callers working).
- [ ] Tests first (missing list order/shape, secret example never returned, hidden keys never listed, no example file → empty; adding a non-secret and a secret, empty secret skipped, two keys from the same section share one heading, unknown key 422, hidden key 422 even if in the example, line break 422, `.bak` written, audit `added`). Fail → implement → pass. Commit `feat(system): Env lists and adds settings that .env.example has but .env doesn't`.

### Task 2: Portal — the Not in .env yet block

**Files:** `portal/src/lib/api.ts` (types: `EnvMissingEntry`, `getEnvEntries` returns `{ entries, missing }`), `portal/src/lib/envConfig.ts` (+ test) if helpers are needed, `portal/src/components/system/EnvTab.tsx` (+ test).
- [ ] Tests first (block hidden when `missing` is empty; heading + hint copy verbatim; rows show the placeholder and chip; editing a missing row and saving sends it in `values`; Use example fills the value; empty secret not sent; reload after save). Fail → implement → pass; full suite, tsc, build. Commit `feat(portal): System config Env tab can add settings that aren't in .env yet`.
