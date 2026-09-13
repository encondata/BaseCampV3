# Security Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every finding from the 2026-09-13 security review (authorization gaps, data leaks to client/partner accounts, an XSS vector, login enumeration, client-only forced password change, a WebSocket token in the URL, and an insecure default) with a regression test per finding.

**Architecture:** Surgical, per-route fixes in the FastAPI API (`api/src/serversherpa/api/routes/*.py`, `api/deps.py`, `services/auth.py`, `config.py`) following the file's own existing idioms (`_require_global`, `scope_conditions`, `can_touch_rank`, `cannot_target_self`), plus two small portal changes (a `safeHref` helper; the WebSocket token moved into the `Sec-WebSocket-Protocol` header). Each task is one area with its own API test file additions. Review reference: the findings list in the conversation of 2026-09-13 (reproduced per task below).

**Tech Stack:** FastAPI + SQLAlchemy async (api/), pytest against real Postgres, React + TypeScript + vitest (portal/).

## Global Constraints

- Branch `security-fixes` in a worktree off `reports` (`reports` == `main`). Never switch the main checkout's branch. The worktree needs `api/.venv`, `.env` and `portal/node_modules` symlinked from the main checkout (`ln -s /Users/jrh1812/Developer/BaseCampV3/api/.venv <wt>/api/.venv`, same for `/Users/jrh1812/Developer/BaseCampV3/.env` → `<wt>/.env`, and `portal/node_modules`).
- API tests (worktree `api/`, FOREGROUND, 600000 ms): `SS_TEST_DB=serversherpa_test_secfix PYTHONPATH=<worktree>/api/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/<file> -q -x`. The `PYTHONPATH` override is REQUIRED. Test personas: `tests/test_sites_api.py::login` (alice, the default seeded global user), `tests/test_status_values_write.py::_make(db, client, role, email)` creates a user with a role and returns headers — use it for `staff`, `admin`, `worker`, `client_viewer`, `client_owner`, `vendor_admin`, `external`; look at an existing test in the same area for how client-scoped personas get a client anchor (e.g. `tests/test_client_dashboard*.py` / `test_initiatives_scope*.py`).
- Portal tests (worktree `portal/`): `npx vitest run <file>`; `npx tsc -b` before commit.
- Every fix ships with a test that FAILS before the fix and passes after (TDD: run the test red first, record the output). Do not weaken existing tests; if one asserts the old (insecure) behavior, change it and say so in the report.
- American English. Commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never commit `_dev_reload.py`. Never `git add -A`.

---

### Task 1: Login enumeration + server-side forced password change

**Files:** `api/src/serversherpa/services/auth.py`, `api/src/serversherpa/api/deps.py`, tests `api/tests/test_auth_hardening_api.py` (create).

**Findings:** (a) `login()` raises `account_disabled` / `account_locked` before `verify_password`, so an email list can be sorted into real-disabled, real-locked, other. (b) `must_change_password` is only enforced in the portal; the API lets a temp-password session use every route.

- [ ] **Step 1: Failing tests.** (a) Create a user, disable them (set `disabled_at`) → `POST /auth/login` with a WRONG password must return the same status + `code` as a login for a nonexistent email (`invalid_credentials`); same for a locked account (`locked_until` in the future) with a wrong password. With the RIGHT password, a disabled account may still return `account_disabled` (the owner learns their own status). (b) Create a user with `must_change_password=True`; log in; `GET /initiatives` (any normal route) → 403 `{"code": "password_change_required"}`; `POST /auth/me/password` (find the actual self-password route in `routes/me.py` or `auth.py`), `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` still work; after changing the password the flag clears and `GET /initiatives` is allowed.
- [ ] **Step 2: Fix (a)** in `services/auth.py::login`: move `_check_account_usable(account)` and the `locked_until` check AFTER `verify_password` succeeds; keep the failed-attempt counting/lockout logic on wrong passwords exactly as is (a wrong password on a locked account still counts and re-raises `invalid_credentials`). Keep the dummy-hash timing for the unknown-email path.
- [ ] **Step 3: Fix (b)** in `api/deps.py`: in `get_current_user` (or wherever `enforce_read_only` is applied), when `user.account.must_change_password` is true and the request path is not in an allowlist, raise 403 `password_change_required`. Allowlist = the same auth-lifecycle set read-only mode exempts (`deps.py:84-88`) plus the self password-change route. Mirror the read-only implementation style.
- [ ] **Step 4: Run** the new file + `tests/test_auth*.py` + `tests/test_me*.py`; fix any existing test that relied on the old ordering (record it). Commit: `fix(auth): login no longer reveals disabled/locked status before the password check; must_change_password is enforced server-side`.

---

### Task 2: Attachments self-service bypass, notes on self/own org, provenance redaction

**Files:** `api/src/serversherpa/api/routes/attachments.py`, `notes.py`, `status_provenance.py`; tests appended to `api/tests/test_attachments.py`, `api/tests/test_notes*.py` (find the existing file), `api/tests/test_status_provenance*.py` (find or create).

**Findings:** (a) `attachments._authorize` returns early for `entity_type == "person" and entity_id == actor.person.id` for every kind/action — should be avatars only. (b) `notes._authorize_host` lets a worker read notes on their own Person and a client owner read notes on their own org; initiative notes already have the internal-only rule at `notes.py:72`. (c) `status_provenance` returns `site_name`, `device_id`, `actor_name` to non-global actors.

- [ ] **Step 1: Failing tests.** (a) As a `worker` persona: `GET /attachments?entity_type=person&entity_id=<self>` where a staff user attached a `document` → 403 (or a list WITHOUT the document — decide: 403 is simplest and matches the file's hard-deny posture); `POST /attachments` with `kind=document` on self → 403; `kind=avatar` on self → 201 still. (b) As a `worker`: `GET /notes?entity_type=person&entity_id=<self>` → 403; as `client_owner`: `GET /notes?entity_type=client&entity_id=<own org>` → 403; a global staff user still reads both. (c) As a client-scoped viewer: `GET /status/provenance?...` for an asset in their scope → 200 with `site_name`, `device_id`, `actor_name` all `null`; global user still gets them.
- [ ] **Step 2: Fix (a):** `if entity_type == "person" and entity_id == actor.person.id and kind == "avatar": return` — `_authorize` needs the `kind` (thread it through from the three call sites; for `GET /attachments` list and `DELETE`, the kind is known from the query/row). Everything else falls through to the existing permission + `is_global` checks.
- [ ] **Step 3: Fix (b):** generalize the initiative rule: `if action == "view" and not actor.access.is_global and entity_type in ("initiative", "person", "client", "partner"): raise 403` (i.e. notes are internal-only for reads by non-global actors — keep the comment explaining it).
- [ ] **Step 4: Fix (c):** in `status_provenance.py`, after computing the response, if `not user.access.is_global`: set `site_name = device_id = actor_name = None`.
- [ ] **Step 5: Run** the three test files; commit: `fix(api): attachments self-bypass limited to avatars; notes internal-only for non-global readers; provenance redacts internal names for scoped actors`.

---

### Task 3: Time — summary gate, clock-in gate, self-approval

**Files:** `api/src/serversherpa/api/routes/time.py`; tests appended to the existing time test file (`grep -l "time/summary\|clock-in" api/tests/*.py`).

**Findings:** (a) `GET /time/summary` gates on `initiatives:view` → must be `time:view`. (b) `POST /time/clock-in` / `clock-out` take bare `CurrentUser` — any account incl. `external` creates entries; gate on `time:view` at least (decide: `require_permission("time", "view")` — workers hold it? check `defaults.py`; if workers lack `time`, gate on a new rule "must hold `workers` anchor self or `time:view`" — read `defaults.py` and pick the gate that keeps every seeded worker/staff role able to clock in while excluding `external` and client roles; state the choice in the report). Also scope-check `body.initiative_id`/`site_id` existence for non-global actors is already handled by `punch_options` withholding — leave. (c) `POST /time/entries/{id}/approve|reject`: refuse when `entry.person_id == actor.person.id` → 403 `cannot_target_self` (idiom from `workers.py:371`).

- [ ] **Step 1: Failing tests.** `client_viewer` → `GET /time/summary?initiative_id=<in-scope>` → 403. `external` → `POST /time/clock-in` → 403; a `worker` → 200. A `time:change` holder approving their own entry → 403 `cannot_target_self`; approving someone else's → 200.
- [ ] **Step 2–3: Fix** per the findings. Commit: `fix(time): summary gated on time:view, clock-in requires a time-tracked role, no self-approval`.

---

### Task 4: Labels — generation runs and cancel

**Files:** `api/src/serversherpa/api/routes/labels.py`; tests appended to `api/tests/test_label_generate_api.py`.

**Findings:** `POST /labels/generate/runs` and `POST /labels/generate/runs/{id}/cancel` gate on `labels:view`; cancel fetches the run with a bare `db.get`.

- [ ] **Step 1: Failing tests.** `staff` persona (labels view only per `defaults.py:39` — verify) → `POST /labels/generate/runs` → 403; with `labels:add` (an `admin`) → 202; `regenerate_existing: true` with `add` but not `change` → 403 (build that persona via `_make` + a `PermissionOverride` or a custom role — look at `tests/test_access*.py` for how overrides are set; if too heavy, gate regenerate on `labels:change` and test with admin=200, staff=403 only, and say so). `cancel` as `staff` → 403; as admin on an out-of-scope initiative's run → 404 (use `_runs_query(actor)` to load).
- [ ] **Step 2: Fix.** `create_generation_run`: `require_permission("labels", "add")`, and `if body.regenerate_existing and not actor.access.can("labels", "change"): raise _err(403, "forbidden")`. `cancel_generation_run`: `require_permission("labels", "change")`, load via `_runs_query(actor).where(LabelGenerationRun.id == run_id)`.
- [ ] **Step 3: Run** the file (30+ tests) and commit: `fix(labels): generation runs need labels:add (change to regenerate); cancel needs labels:change and a scoped lookup`.

---

### Task 5: Workers and access control

**Files:** `api/src/serversherpa/api/routes/workers.py`, `access.py`; tests appended to `api/tests/test_workers*.py` and `api/tests/test_access*.py`.

**Findings:** (a) `GET /workers/{id}` sends initiative/site names, `rating`, notes, badge/RFID and address to partner-anchored actors. (b) `PUT /workers/{id}/profile` un-blacklist path lacks the rank/self checks the blacklist path has. (c) `PUT /access/roles/{name}/matrix` lets an actor edit a role they hold. (d) `GET /access/overrides/{person_id}` has no rank/self check unlike `GET /access/effective/{person_id}`.

- [ ] **Step 1: Failing tests.** (a) `vendor_admin` (partner-anchored) reading one of their own workers → response has `memberships` empty (or absent) and `rating` fields null, `person_notes`/`badge_uid`/`rfid_tag` null; a global user still sees them. (b) `staff` (rank 40) un-blacklisting an `admin` (rank 60) → 403 `rank_too_low`. (c) an actor holding roles `{admin, staff}` → `PUT /access/roles/staff/matrix` → 403 `cannot_edit_own_role`; editing `worker`'s matrix → 200. (d) `staff` → `GET /access/overrides/<founder id>` → 403; own id → 200; `super_admin` → 200 for anyone.
- [ ] **Step 2: Fix.** (a) In the detail route: `if not actor.access.is_global:` skip the membership block and null the internal fields listed. (b) Move the rank + self checks out of the `if new_status == "blacklist"` branch so they run whenever `new_status != old_status`. (c) In `_load_role_for_edit` (or `put_matrix`): `if role.name in actor.roles: raise _err(403, "cannot_edit_own_role")` (check the attribute name for the actor's role list in `AuthContext`/`AccessInfo`). (d) Copy `GET /access/effective`'s guard (`max_rank >= GATE_BYPASS_RANK or person_id == actor.person.id`).
- [ ] **Step 3: Run** both files; commit: `fix(access,workers): partner-safe worker detail, rank-checked un-blacklist, no editing your own role, overrides read rank-gated`.

---

### Task 6: Initiatives — global anchor on writes, parent scope on child routes, links, import key

**Files:** `api/src/serversherpa/api/routes/initiatives.py`; tests appended to the initiatives scope test file (`grep -l "scope_conditions\|client_viewer" api/tests/test_initiatives*.py`).

**Findings:** (a) no `_require_global` on any initiative write; a client role granted `initiatives:change` can create/patch (incl. `client_id`) and hit the child routes cross-tenant. (b) `_get_assignment`, `_get_link`, `_get_initiative_asset`, `_get_import_job` never scope-check the parent. (c) `POST /initiatives/{id}/links` doesn't scope-check `body.child_id`. (d) the import upload builds the storage key from the raw filename. (e) `links_count` ignores scope (cardinality leak, fix if cheap).

- [ ] **Step 1: Failing tests.** Build a client-scoped persona that ALSO holds `initiatives:change` (via a `PermissionOverride` row or a custom role — see how `tests/test_access*.py` grants overrides). Then: `POST /initiatives` → 403; `PATCH /initiatives/<own>` → 403; `PATCH /initiatives/assets/<assoc on another client's initiative>` → 404; `GET /initiatives/assets/import-jobs/<other tenant's job>` → 404; `POST /initiatives/<own>/links` with a foreign `child_id` → 404. Global staff: all still 200. (d) upload with filename `../../x.csv` → the stored `storage_key` contains no `..` and ends with `.csv`.
- [ ] **Step 2: Fix.** Add `_require_global(actor)` (copy from `assets.py:35`) to every mutating initiative route. In the four child helpers, add an `actor` parameter and after loading the child call `_get_initiative(db, child.initiative_id, actor)` (the existing scope-checking loader) — for links check the parent (and for create-link also the child via the same loader). Import key: `key = f"import-jobs/{initiative_id}/{job.id}/{job.id}{PurePosixPath(filename).suffix.lower()}"`, keep the original filename only in the job row. `links_count`: apply the same predicate `_link_rows` uses, or drop the count for non-global actors.
- [ ] **Step 3: Run** the initiatives test files (there are several — run `tests/test_initiatives*.py`); commit: `fix(initiatives): writes require a global anchor; child routes scope-check the parent; link children scoped; import keys are UUID-based`.

---

### Task 7: Website URLs (XSS)

**Files:** `api/src/serversherpa/api/schemas.py` (client/partner create/update schemas with `website`), `portal/src/lib/format.ts` (or a new `portal/src/lib/safeHref.ts`), `portal/src/pages/StakeholderDetail.tsx:523,546`, `portal/src/pages/OrgDirectory.tsx:597`; tests: `api/tests/test_stakeholders*.py` (append), `portal/src/lib/safeHref.test.ts` (create).

- [ ] **Step 1: Failing tests.** API: `PATCH /clients/{id}` with `website: "javascript:alert(1)"` → 422 `invalid_website`; `"example.com"` → stored as `https://example.com` (normalize: prepend `https://` when no scheme); `"https://example.com/x"` → unchanged; `null`/`""` → cleared. Portal: `safeHref('javascript:alert(1)')` → `null`; `safeHref('https://a.b')` → same; `safeHref('mailto:x@y')` → null (only http/https); a render test that the anchor is omitted (plain text shown) for a bad value.
- [ ] **Step 2: Fix.** Pydantic `field_validator("website")` on the create/update schemas: strip; empty → None; if no scheme, prepend `https://`; parse with `urllib.parse.urlsplit`; require scheme in `("http", "https")` and a non-empty netloc, else raise `ValueError("invalid_website")` (map to the file's 422 idiom — check how other validators surface codes). Portal: `export function safeHref(url: string | null | undefined): string | null` — trims, `new URL(url)` in try/catch, allow `http:`/`https:` only. Use it at the three anchors: `safeHref(org.website) ? <a href=…> : <span className="cell-sub">{org.website}</span>`.
- [ ] **Step 3: Run** both; commit: `fix(stakeholders): website URLs validated to http(s) server-side and guarded before rendering as links`.

---

### Task 8: Archive-as-delete gated on `delete`; system definition update guard; trucks create on `add`

**Files:** `api/src/serversherpa/api/routes/assets.py:215`, `initiatives.py:364`, `containers.py:344`, `trucks.py:244,315,391`, `reports.py:103`; tests appended in the matching test files.

- [ ] **Step 1: Failing tests.** A persona with `change` but not `delete` on the resource (override or custom role) → `POST /assets/{id}/archive` → 403, unarchive too (treat unarchive as `delete` as well — symmetric); same for initiatives, containers, trucks, and `DELETE /trucks/{id}/updates`. `POST /trucks` with `change` but not `add` → 403. `PATCH /reports/definitions/{system id}` → 409 `system_definition` (mirror the delete guard) while non-system → 200.
- [ ] **Step 2: Fix** the gates. Seeded roles all hold FULL where they hold `change` (checked in `access/defaults.py`), so no seeded role loses access. Commit: `fix(api): archive/unarchive and truck-update wipes require delete; truck create requires add; system report definitions are immutable`.

---

### Task 9: WebSocket token out of the URL; DB-testing password must be configured

**Files:** `api/src/serversherpa/api/routes/system.py:273`, `portal/src/lib/api.ts` (~line 2773, the live-tail WS URL builder), `api/src/serversherpa/config.py:70`, `api/src/serversherpa/api/routes/devtools.py:555`; tests: `api/tests/test_system*.py` (WS test if one exists — extend; else add a minimal one with `TestClient`'s websocket support or the httpx-ws helper the repo uses), `api/tests/test_devtools*.py`.

- [ ] **Step 1: Failing tests.** WS: connecting with the token as the second `Sec-WebSocket-Protocol` entry (`["ss-bearer", "<token>"]`) is accepted (server must respond with subprotocol `ss-bearer`); connecting with `?token=` only is refused (4401). DB-testing: with `db_testing_password` unset/empty → `POST /devtools/db-testing/start` → 503 `db_testing_password_not_configured` regardless of the supplied password.
- [ ] **Step 2: Fix.** Server: read `ws.headers.get("sec-websocket-protocol")`, split on commas, expect `ss-bearer, <token>`; `await ws.accept(subprotocol="ss-bearer")` on success; stop reading `query_params["token"]`. Portal: `new WebSocket(url, ['ss-bearer', accessToken])` and drop the query param. Config: `db_testing_password: SecretStr | None = None`; `_require_testing_password` → 503 when unset/empty; update `.env.example` to leave it blank with a comment. Update the `DB testing mode` docs line if present.
- [ ] **Step 3: Run** API tests + `npx vitest run src/lib` + `tsc -b`; commit: `fix(system,devtools): live-tail WebSocket authenticates via Sec-WebSocket-Protocol; DB-testing requires an explicit password`.

---

### Task 10: Full verification and docs

- [ ] Full API suite (worktree, foreground, 600000 ms) and full portal suite + build.
- [ ] Append a "Security review 2026-09-13 — fixes" section to `docs/superpowers/specs/2026-09-13-security-fixes.md` (create: the findings list with file:line and the fix applied for each — this doubles as the audit record).
- [ ] Ledger + memory. Report suites and anything not fixed.
