# Push notifications in deployed environments (Sirdar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Sirdar-deployed environment can turn push on by setting one optional secret, the Firebase service-account key, and push works in its API and notification worker.

**Architecture:** The deploy stack passes settings to containers only from an explicit list (`x-ss-env` in `deploy/stack/api/compose.yml`), and Sirdar writes each environment's `.env` from fixed key lists whose hand-set secrets must be one line of at most 1,024 safe characters. The key file is about 2.4 KB of multi-line JSON. So the key travels as one base64 line, `SS_FCM_SERVICE_ACCOUNT_B64` (the same pattern as `SS_DATABASE_CA_B64`). The API accepts it as an alternative to the existing `SS_FCM_SERVICE_ACCOUNT_FILE`. Sirdar stores it as a vault-encrypted optional secret with its own validator, and its environment Settings page takes the JSON file and base64-encodes it in the browser.

**Tech Stack:** FastAPI/pydantic-settings, httpx (API); docker compose (stack); FastAPI + Postgres (`sirdar_api`), React + TypeScript + vitest (`sirdar/web`).

**Spec:** `docs/superpowers/specs/2026-11-17-android-push-notifications-design.md` (Implementation notes › Firebase: "Production needs its own copy and setting").

## Global Constraints

- Setting name: `SS_FCM_SERVICE_ACCOUNT_B64` (API Settings field `fcm_service_account_b64: str = ""`). Value: standard base64 (`A-Z a-z 0-9 + / =`, no whitespace) of the service-account JSON.
- A valid key decodes to a JSON object with `"type": "service_account"` and non-empty `project_id`, `client_email`, `private_key`. Max encoded length 8192.
- `SS_FCM_SERVICE_ACCOUNT_FILE` keeps working and wins when both are set.
- The key is a secret: never logged, never returned by any API (Sirdar returns only "set / not set"), never in error messages.
- Push stays off (no error) in an environment without the key.
- American English copy. Sirdar UI label: **Firebase push key**. Helper text: "The Firebase service-account JSON. Turns on push notifications to admins' phones."
- API tests: `cd api && SS_TEST_DB=serversherpa_test_pushdeploy PYTHONPATH=src .venv/bin/pytest tests/<files> -q` (foreground, 600000 ms). Sirdar API tests: see `sirdar/README.md` or `sirdar/api` test setup (use a separate test DB name). Sirdar web: `cd sirdar/web && npx vitest run <files>` and `npx tsc --noEmit`.

## Review Focus

1. **A key pasted with newlines or as raw JSON** into the Sirdar field must not end up in the `.env` broken; the browser encodes it, and the server validator refuses anything that isn't valid base64 of a service-account JSON.
2. **Both file and base64 set** (a dev box with a file plus a stray value): the file wins, and push still works.
3. **A malformed base64 value in a deployed `.env`** (hand-edited): push reports not set up (no crash loop in the worker; the API still starts).
4. **Snapshots and environment copies** carry the key like the other optional secrets, and the key never appears in a snapshot manifest or log in plain text.
5. **Clearing the key** in Sirdar Settings turns push off on the next deploy.

---

### Task 1: API accepts the key as base64; the stack passes it

**Files:**
- Modify: `api/src/serversherpa/config.py` (add `fcm_service_account_b64: str = ""`)
- Modify: `api/src/serversherpa/push/fcm.py` (`FcmClient.from_settings`: file first, else base64; a bad value raises the same clear `RuntimeError` as an unreadable file, with no key text in it)
- Modify: `api/src/serversherpa/notifications/push.py` (`push_enabled()`: true when either setting is non-empty)
- Modify: `api/src/serversherpa/notifications/worker.py` (`run_push` rebuilds the client when either setting changes)
- Modify: `deploy/stack/api/compose.yml` (`x-ss-env`: `SS_FCM_SERVICE_ACCOUNT_B64: ${SS_FCM_SERVICE_ACCOUNT_B64:-}` with a one-line comment), `deploy/stack/env.example` (commented entry with how to produce the value: `base64 -i key.json | tr -d '\n'`), `.env.example` (mention both settings)
- Test: `api/tests/test_push_fcm.py`, `api/tests/test_notification_push_decide.py` (or wherever `push_enabled` is tested)

- [ ] **Step 1: Failing tests:** `test_from_settings_reads_base64`, `test_file_wins_over_base64`, `test_bad_base64_is_a_clear_error_without_the_key`, `test_push_enabled_with_base64_only`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them plus `tests/test_push_delivery.py` and `tests/test_notification_push_decide.py`; all pass.**
- [ ] **Step 5: Commit** `feat(push): accept the Firebase key as one base64 line; pass it through the stack`.

### Task 2: Sirdar stores and writes the Firebase push key

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/envfile.py` (`OPTIONAL_SECRETS` gains `SS_FCM_SERVICE_ACCOUNT_B64`; a per-key validator so this key is checked by `valid_fcm_key(value)` instead of `SECRET_VALUE_RE`)
- Modify: every place that validates optional secrets with `SECRET_VALUE_RE` (`environments.py` ~186, ~767, ~773; `snapshots.py` ~117 if it applies) to use one shared `envfile.valid_secret(key, value)` helper
- Modify: `sirdar/web/src/pages/environments/EnvSettings.tsx` (label "Firebase push key"; for this key a "Choose JSON file" button that reads the file, checks it parses with `type: service_account`, base64-encodes it, and submits it; "Remove" clears it; shows set / not set like the others), plus the deploy flow's Extras step if optional secrets are offered there (`web/src/pages/deploy/flowState.ts`)
- Test: Sirdar API tests for envfile render and environment update (valid key accepted and written to `.env` on one line; raw JSON, bad base64, wrong `type`, over 8192 refused with the existing error shape; never echoed back); web tests for the file picker (valid file → base64 submitted; invalid file → error message, nothing submitted).

- [ ] **Step 1: Failing tests** (API and web).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Sirdar API deploy tests and the web EnvSettings/flowState tests plus `tsc`; all pass.**
- [ ] **Step 5: Commit** `feat(sirdar): Firebase push key as an optional environment secret`.
