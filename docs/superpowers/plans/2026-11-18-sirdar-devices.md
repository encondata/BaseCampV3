# Sirdar deploys Devices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Sirdar can build, update, roll back and destroy environments that run the `devices` app correctly, on every target: a single LAN/SSH host, LAN Blue/Green (app VMs plus a data VM), and DigitalOcean (managed Postgres, Spaces, Caddy). Also fix a learn regression on main that today's ss-stack change caused.

**Why:** Jimmy asked (2026-11-18) to "make sure sirdar will deploy correctly" after Devices merged (main a5f502db6). Until now Sirdar knew the app name and port but never turned it on (`apps.NOT_RUN = ("devices",)`).

**Spec context:** `docs/superpowers/specs/2026-11-17-devices-app-design.md` (Devices), `deploy/stack/README.md` (devices section), `sirdar/README.md`.

**Tech:** Sirdar API (FastAPI, SQLAlchemy, Alembic, Ansible playbooks), Sirdar web (React/Vite/vitest), deploy/stack (bash + compose), devices service (Python).

## Global constraints

- `SS_DEVICES_SERVICE_TOKEN` is hex (`vault.hex_secret()`); `DEVICES_SECRET_KEY` is a Fernet key (`vault.fernet_key()`). Both are stored vault-encrypted, one `environment_secrets` row each. They are **not** `REQUIRED_SECRETS` (adopt and render would break for every existing environment, and `deploy/tests/test_stack_config.py::test_env_example_leaves_the_devices_secrets_commented` keeps them commented in env.example). They are `EXTRA_KEYS`.
- Never regenerate an existing environment's `DEVICES_SECRET_KEY` (a new key makes its saved Apple settings unreadable).
- The ss-stack app rule (deploy/stack/ss-stack ~106-146) is the authority: with no STACK_APPS, devices runs only when both secrets are set and not CHANGEME; an explicit STACK_APPS listing devices requires both.
- Sirdar writes an explicit STACK_APPS. Keep the stack order `wiki,kiosk,learn,status,devices,mailpit`.
- Older checkouts (before main 79674823f) have an ss-stack that refuses `devices`; Roll back / Update to an older ref / Restore backup must drop devices for them, the same way learn is dropped for checkouts that predate it.
- Secrets never appear in logs, job output, audit rows or API responses (the pipeline's redaction covers every stored secret — keep it that way for any new one).
- Sirdar tests: `cd sirdar/api && .venv/bin/pytest <files> -q` (needs the `serversherpa-dev-sirdar-db-1` container on 127.0.0.1:5434; `docker start` it if stopped, and only ever touch its `sirdar_test*` databases). Web: `cd sirdar/web && npx vitest run`. deploy/stack: `api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests -q` from the worktree root. Devices service: `cd devices/api && .venv/bin/pytest -q -W error`.

## Controller rulings (Jimmy didn't decide these; listed in the final report)

- S1: New environments get `devices` on by default (Sirdar generates both secrets at create, LAN and DigitalOcean). Existing environments keep their app list; turning Devices on in Settings generates the secrets then.
- S2: `DEVICES_IOS_OWNER_URL` isn't managed by Sirdar yet; a stack without Apple settings shows "Apple settings aren't set up yet." Adopt reports the key as ignored if present.
- S3: On DigitalOcean the devices service gets its **own per-environment bucket** (`<main bucket name>-devices`, ≤63 chars) and its **own Spaces key** granted readwrite on it, with CORS for `https://devices.<domain>`. The main key's grants are never changed (a live blue/green slot depends on it).
- S4: The devices database is included in `ss-stack dump`/`restore` (so LAN Roll back and Restore backup keep it in step with the image), but **not** in snapshot bundles (its Apple secrets belong to one stack).
- S5: The devices service verifies a managed database's certificate when `SS_DATABASE_CA_B64` is set, like the main API.

---

### Task 1: ss-stack app detection in the render and smoke playbooks (fixes the learn regression)

**Problem:** main 4e8ceb1d4 replaced ss-stack's `case` line (`wiki|kiosk|learn|status|devices|mailpit)`) with `OPTIONAL_APPS=(wiki kiosk learn status devices mailpit)`. `sirdar/api/src/sirdar_api/deploy/ansible/render.yml:25-48` and `ansible/slot_smoke.yml:14-37` detect whether a checkout "knows learn" with the grep `^ +([a-z]+[|])*learn([|][a-z]+)*[)]`, which no longer matches — so every deploy of a current commit drops learn and prints "This commit predates the learning site", and slot smoke skips learn.

**Files:** `sirdar/api/src/sirdar_api/deploy/ansible/render.yml`, `ansible/slot_smoke.yml`, `sirdar/api/tests/test_deploy_playbooks.py` (~1040-1110: `OLD_SS_STACK`, `_render`, `test_render_*`, `test_slot_smoke_skips_learn_*`; the real ss-stack is used via a symlink, `_target` ~265).

- [ ] Write failing tests: `test_render_keeps_learn_for_the_current_ss_stack` (the real deploy/stack/ss-stack, learn on → STACK_APPS keeps learn, no "predates" message — this fails on main today), `test_render_drops_devices_for_a_checkout_that_predates_it` (an ss-stack with the old case line containing learn but not devices → devices dropped with a message like "This commit predates the Devices app; it runs without it."), `test_render_keeps_devices_for_the_current_ss_stack`, and the matching slot-smoke tests (skip devices smoke for an old checkout, keep it for a current one).
- [ ] Implement one detection that matches either form for a given app name: the old case line `^ +([a-z]+[|])*APP([|][a-z]+)*[)]` OR the array `^OPTIONAL_APPS=\(.*\bAPP\b.*\)`. Apply it to learn and devices in both playbooks (drop each app the checkout doesn't know, with its own message).
- [ ] Run test_deploy_playbooks.py; commit `fix(sirdar): detect apps in the current ss-stack; drop devices for older checkouts`.

### Task 2: deploy/stack — Blue/Green hba, devices DB in dump/restore, devices compose overrides, CA verification in the devices service

**Files:** `deploy/stack/ss-stack`, `deploy/stack/devices/compose.yml`, `deploy/stack/README.md`, `deploy/tests/test_ss_stack.py`, `deploy/tests/test_stack_config.py`; devices service `devices/api/src/serversherpa_devices/config.py`, `db/engine.py`, `devices/api/migrations/env.py`, `devices/api/tests/`.

- [ ] **hba:** `write_hba` (ss-stack ~185-192) writes only `host serversherpa serversherpa <ip>/32`; also write `host serversherpa_devices serversherpa <ip>/32` for each allowed IP. Test in test_ss_stack.py (~358-370 pattern).
- [ ] **dump/restore:** `dump` (~495-524) also writes the devices database, when it exists, to `backups/devices/<same timestamp>.dump` (so the `*.dump` rotation glob and Sirdar's `BACKUP_RE` don't count it; rotate it alongside the main dump with the same keep count). `restore` (~451-488) also stops the `devices` stack and, when the sibling dump exists, recreates the devices schema and `pg_restore`s it into `serversherpa_devices` (local and external modes, same client helpers as the main restore); a missing sibling is fine (older backups). `pgdump` / `revision` stay main-only. Tests in test_ss_stack.py with the fake docker (call order and arguments).
- [ ] **compose overrides:** `deploy/stack/devices/compose.yml` takes `DEVICES_SPACES_ACCESS_KEY: ${DEVICES_SPACES_ACCESS_KEY:-${SS_SPACES_ACCESS_KEY:-serversherpa}}` and the same for the secret key (match how the file defaults them today), and `DEVICES_DATABASE_CA_B64: ${SS_DATABASE_CA_B64:-}`. env.example: commented `# DEVICES_SPACES_ACCESS_KEY=` / `# DEVICES_SPACES_SECRET_KEY=` with one-line comments. Tests in test_stack_config.py.
- [ ] **CA verification (S5):** devices `config.py` gains `database_ca_b64: str = ""`. When set (and database_ssl == "require"): asyncpg engine uses `ssl.create_default_context(cadata=<decoded PEM>)` (hostname checked); Alembic's psycopg URL gets `sslmode=verify-full` and a temp `sslrootcert` file. Without it, behavior is unchanged. Mirror the main API's `api/src/serversherpa/db/tls.py`. Tests in devices/api (unit tests of the connect args / URL; no real TLS server).
- [ ] README: devices dump/restore line (~40-41) and the CA line (~56-58) updated.
- [ ] Run deploy tests, devices tests; commit `feat(deploy): devices DB in dump/restore and Blue/Green hba; devices verifies the managed DB`.

### Task 3: Sirdar core — devices secrets, app rules, adopt, render

**Files:** `sirdar/api/src/sirdar_api/deploy/envfile.py` (14-16 comment, 48-63 EXTRA_KEYS), `deploy/vault.py` (44-56), `deploy/apps.py` (1-23, 117-126 `env_extra`, 140 `ENV_KEYS`, 152-191 `from_env`), `deploy/environments.py` (create ~463 LAN and ~661 DO; `_update_apps_and_mail` ~555; `update` ~928-935; `_adopted_secrets` ~752-773; ~806, ~815, ~849), `deploy/pipeline.py` (~832 `extra = app_rules.env_extra(env)`), `api/routes/deploy.py` (~613-614 comment). Tests: `test_deploy_envfile.py`, `test_deploy_apps.py` (11, 70, 100-104, rewrite 164-202), `test_deploy_apps_api.py` (130, 150-162, 205, 348), `test_deploy_apps_edit_api.py`, `test_deploy_environments.py` (61-63, 150-185), `test_deploy_environments_api.py` (74-114), `test_deploy_do_switch_and_remove.py:648`, `test_deploy_stack_external.py:60-61`.

- [ ] envfile: `DEVICES_SECRETS = ("SS_DEVICES_SERVICE_TOKEN", "DEVICES_SECRET_KEY")`. EXTRA_KEYS gains `SS_DEVICES_SERVICE_TOKEN`, `DEVICES_SECRET_KEY` right after `SS_SMTP_FROM` (keep `EXTRA_KEYS[:6]` starting at STACK_APPS — test ~233), and `DEVICES_DATABASE_URL`, `DEVICES_SPACES_BUCKET`, `DEVICES_SPACES_ACCESS_KEY`, `DEVICES_SPACES_SECRET_KEY` after `SS_SPACES_USE_PATH_STYLE` (SS_DATABASE_CA_B64 must stay right after SS_DATABASE_SSL — test ~138; the cert-worker keys stay last — ~143-149). REQUIRED_SECRETS/FERNET_SECRETS unchanged. Fix the stale comment.
- [ ] Secrets: `environments.ensure_devices_secrets(db, settings, env) -> None` creates whichever of the two rows is missing (hex token, Fernet key), refusing with `secrets_key_missing` when the vault isn't configured; never overwrites an existing row. Call it at create (LAN and DO) — S1 — and in `update()` when the app list gains devices.
- [ ] apps.py: remove `NOT_RUN` (or make it empty) so RUNNABLE_APPS includes devices; `check_apps(None)` (the create default) now includes devices (S1); `env_extra(env, secrets)` adds both devices secrets in EXTRA_KEYS order when devices is on; `ENV_KEYS` gains the devices keys; `from_env` follows the ss-stack rule (no STACK_APPS → devices on only when both secrets are non-empty and not CHANGEME; explicit devices without them → `apps_invalid`/adopt_value_invalid naming the key). Update the docstring.
- [ ] Adopt: `_adopted_secrets` imports both devices secrets as optional (empty/CHANGEME = unset; token matches `_SECRET_VALUE_RE`, key passes `_valid_fernet_key`), storing them as rows; `DEVICES_IOS_OWNER_URL` is reported as ignored (S2).
- [ ] pipeline ~832: `app_rules.env_extra(env, secrets)`; if devices is on and either secret is missing, call `ensure_devices_secrets` before rendering (covers environments turned on before this change) — or fail with a clear PrepareError if that isn't possible from the pipeline (pick one; prefer generating).
- [ ] Tests for each bullet (create stores both secrets; PATCH adding devices generates them once and never regenerates; render puts them in the .env when on and omits them when off; adopt cases; defaults list includes devices). Run the Sirdar API suite files above; commit `feat(sirdar): turn on the devices app — secrets, app rules, adopt, render`.

### Task 4: Sirdar migration 0020 — devices in the apps constraint, default, service rows

**Files:** `sirdar/api/migrations/versions/0020_devices.py` (down_revision "0019"), `sirdar/api/src/sirdar_api/db/models.py` (~232-235 apps server_default), `sirdar/api/tests/test_deploy_models.py` (pattern ~970-1027; ~1027 pins the default string).

- [ ] Upgrade: drop and re-add `environments_apps_check` as `apps <@ ARRAY['wiki','kiosk','learn','status','devices','mailpit']`; set the column default to `'{wiki,kiosk,learn,status,devices,mailpit}'` (S1); backfill an `environment_services` row `service='devices'` for every environment that has a portal row and no devices row, copying 0015's loop (~54-83: port 8093, the shared-SSH-host free-port logic, hostname NULL). Do not add devices to existing environments' `apps`.
- [ ] Downgrade: `apps = array_remove(apps, 'devices')`, restore the 0015 constraint and default; keep the service rows (code at 0019 creates them).
- [ ] Model server_default matches.
- [ ] Test `test_migration_0020_*` (constraint accepts devices, default, backfill with port selection, downgrade). Update the 0015 test's default pin only if it asserts the current default rather than the value right after 0015. Commit `feat(sirdar): migration 0020 — devices app rows and default`.

### Task 5: DigitalOcean and LAN Blue/Green for devices

**Files:** `sirdar/api/src/sirdar_api/deploy/pgauth.py` (30-49), `deploy/do_provision.py` (`_grants` ~948-965; `_bucket` ~517-574; `_lost_keys` ~576-598; CORS `CORS_SERVICES` ~87, `_bucket_cors` ~600-639; `_make_bucket` ~641-653; `_check_all` ~1424-1428; destroy ~1602-1603), `deploy/do_envs.py` (`env_extra` ~307-368, URL built ~344-345, redaction list ~366; `secret_values` ~371-400; `bucket_name`), `deploy/lan_slots.py` (`env_extra` ~102-120), new Sirdar migration columns if needed (put them in **0020** from Task 4 only if Task 4 is still uncommitted; otherwise add **0021**), tests `test_deploy_pgauth.py` (35-51), `test_deploy_do_provision.py` (82, 84-87, 108-118, 335-338, 852-876, destroy tests), `test_deploy_do_environments.py` (239-262), `tests/fake_spaces.py`, `tests/fake_digitalocean.py`, LAN slot tests.

- [ ] **Database:** the setup SQL run as doadmin also creates `serversherpa_devices OWNER serversherpa` (idempotent). Step 0 runs on every DO Update, so existing environments get it next Update.
- [ ] **DEVICES_DATABASE_URL:** `do_envs.env_extra` renders `postgresql+asyncpg://serversherpa:<quoted pw>@<db_host>:<db_port>/serversherpa_devices` (EXTRA_KEYS order) and adds it to the redaction list. `lan_slots.env_extra` renders the same for app VMs pointing at the data VM.
- [ ] **Bucket and key (S3):** a per-environment devices bucket named `<main bucket>-devices` (truncate so ≤63 chars, still unique), created with the setup key in `_make_bucket`'s style and recorded (new kind e.g. `devices_bucket`, or allowed by `_check_all`); a second Spaces key (`resource_name(env, "-devices")`) granted readwrite on that bucket only, its id and secret stored (vault-encrypted, new `do_environments` columns e.g. `devices_spaces_key_id`, `devices_spaces_secret_enc`), rendered as `DEVICES_SPACES_BUCKET`, `DEVICES_SPACES_ACCESS_KEY`, `DEVICES_SPACES_SECRET_KEY`, and included in `secret_values`/redaction and `_lost_keys`; CORS on the devices bucket for `https://devices.<domain>` (reuse `_apply_cors` and its setup-key fallback). Only when devices is in `env.apps` (create, and on Update after turning it on). Destroy empties and deletes the devices bucket and deletes the devices key.
- [ ] Tests for each (fakes updated so grants/CORS are asserted). Commit `feat(sirdar): devices on DigitalOcean (database, bucket, key, CORS) and LAN Blue/Green`.

### Task 6: Sirdar web, drift tests and docs

**Files:** `sirdar/web/src/lib/appRules.ts` (7-10 `OptionalApp`/`OPTIONAL_APPS`: add `['devices', 'Devices']` before mailpit), `pages/deploy/flowState.ts` (~126 initial apps: devices true, S1), `lib/sirdarApi.ts` (~381 `apps_invalid` copy: "Choose the apps from Wiki, Kiosk, Learning, Status page, Devices and Mailpit."), `pages/deploy/flowFixtures.ts:9`, `pages/environments/testData.ts:70`, web tests (`lib/appRules.test.ts:15`, `lib/sirdarApi.test.ts:331`, `pages/deploy/steps/ExtrasStep.test.tsx:23`, `pages/deploy/flowState.test.ts`, `pages/deploy/steps/ReviewStep.test.tsx`, `pages/environments/EnvSettings.test.tsx`); `sirdar/api/tests/test_deploy_stack_drift.py` (devices public, port 8093, `smoke.PATHS`); docs `deploy/stack/README.md` (~36-41 "Sirdar writes one today", ~53-58), `deploy/stack/env.example:74`, `sirdar/README.md` (~966).

- [ ] Web shows a Devices toggle wherever the other apps are (deploy flow, review, environment settings), on by default for new environments. No other new UI.
- [ ] Drift test asserts devices everywhere it should be. Docs say Sirdar runs devices (S1–S4 in plain words).
- [ ] Run `npx vitest run` and `npx tsc` (if the web has a typecheck script) in sirdar/web, the drift test, the deploy tests; commit `feat(sirdar-web): Devices app toggle; docs`.

## Review focus

1. An existing environment Updated after this merge: STACK_APPS unchanged (no devices), learn kept, no secrets generated, no new DO resources. *(Task 3/5 tests)*
2. Turning Devices on for an existing environment: secrets generated once; a later Update never regenerates `DEVICES_SECRET_KEY`. *(Task 3)*
3. Roll back to a commit older than devices: devices dropped from STACK_APPS for that render; restore of a dump without a devices sibling works. *(Tasks 1, 2)*
4. DigitalOcean destroy leaves no devices bucket or key behind; a failure halfway is retryable. *(Task 5)*
5. No new secret value appears in pipeline output or API responses. *(Tasks 3, 5)*
