# Kiosk Environment Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-text API and portal URL fields in Settings › This Kiosk with a named environment picker on the Android, iOS and laptop kiosks.

**Architecture:** Each platform gets the same three layers:
- a pure "environments" module: the built-in list, file validation, URL derivation and migration;
- a store: the saved environment, the last good list and the has-been-registered flag;
- a switcher: gates, unsent check and clean-up, plus the UI (picker row, chooser dialog, non-Prod badge).

On the laptop, the edge (`kiosk_laptop/edge`) owns the store, the list fetch and the switch, enforcing every rule itself. The kiosk web app (laptop mode only) is just the UI over new `/edge/environment*` routes. No API (cloud) change is needed.

**Tech Stack:** Kotlin/Compose + DataStore + OkHttp + kotlinx.serialization (Android); SwiftUI + UserDefaults + URLSession + Codable + Swift Testing (iOS); Python 3.13 FastAPI + httpx + respx (edge); React/TS + vitest (kiosk web).

**Spec:** `docs/superpowers/specs/2026-11-20-kiosk-environment-picker-design.md` — read it before any task.

## Global Constraints

- List URL: `https://status.serversherpa.com/environments.json`. https only, **no redirects followed**, no cookies or auth sent, timeout 5 s.
- File: `{"version": 1, "environments": [{"id", "name", "domain"}…]}`. Use it only when `version == 1` and at least one entry survives validation. Keep the file's order.
- Entry is valid only if all hold:
  - `id` matches `^[a-z][a-z0-9-]{1,31}$`, doesn't end in `-`, and is unique (first one wins, later duplicates dropped);
  - `name` is a non-empty string after trim;
  - `domain` matches `^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*serversherpa\.com$`. That means exactly `serversherpa.com` or a subdomain of it, lower case, with no scheme, port, path or user info.
- Built-in list, in this order: `prod` Prod `serversherpa.com` · `rc1` RC1 `rc1.serversherpa.com` · `uat` UAT `uat.serversherpa.com` · `beta` Beta `beta.serversherpa.com` · `alpha` Alpha `alpha.serversherpa.com` · `dev` Dev `dev.serversherpa.com`.
- Addresses: API `https://api.<domain>`, portal `https://portal.<domain>`. Prod means domain == `serversherpa.com`.
- List source order: fresh download, then the last good download, then the built-in list.
- Environment password: `cumulus` (in source on purpose — Jimmy accepted it).
- Gates (Claude's call, refining the spec's "must sign in"):
  - The rank-80 and rank-60 checks are made against **the person currently signed in on the kiosk**, verified live with `GET /auth/me` on the current server. That call returns `roles`, `max_rank` and `scope.global`.
  - Custom URL on an ever-registered kiosk needs `scope.global && max_rank >= 80`.
  - Discarding unsent work needs `max_rank >= 60`.
  - An offline or failed check never passes.
  - There is no separate gate sign-in form. It would replace the current session, and kiosk sign-in has no 2FA yet.
  - Gate copy:
    - custom: "Sign in as a developer, founder or super admin to use a custom URL."
    - discard: "Sign in as an admin to discard unsent scans."
    - offline: "Can't reach the server to check your access."
- Has-been-registered flag: set the first time any heartbeat reply has `registration != "none"`, or on the laptop when a station key is issued. It is never cleared by a switch, Clear Setup or Wipe. Only a fresh install or clearing app data resets it.
- Saved environment: `{"kind":"named","id","name","domain"}` or `{"kind":"custom","api_url","portal_url"}`. The kiosk always connects to the saved domain or URLs; a later list never moves it (spec "What the kiosk saves").
- Default when nothing is saved: debug builds `dev`, release builds `prod`. This also fixes today's release default portal, which points at portal.dev.
- Custom URL fields keep today's rule: http or https, trimmed, trailing `/` removed, non-empty host.
- Copy (American English):
  - row labels "Environment" / "Server"; button "Change…";
  - chooser eyebrow "This kiosk", title "Change environment";
  - password label "Environment password"; wrong password "That password isn't right.";
  - last list row "Custom URL…";
  - confirm: "Switching to {name} signs this kiosk out and clears its setup and saved move data.";
  - with unsent work, add "{n} unsent scans haven't been sent yet." and the buttons "Wait for them to send" / "Discard and switch";
  - otherwise the buttons "Cancel" / "Switch";
  - badge text = the environment name, or `Custom`.
- UI rules (house style): rounded modal corners; the report-generate modal header (eyebrow + title + close); action buttons never hidden below a scroll; follows light and dark; no AM/PM; no new widgets beyond these.
- Never touch the dev stack's running workers. Never run `adb shell monkey`. iOS tests must never touch the live Keychain or network (`RuntimeEnvironment.isUnitTestHost`).

## Review Focus

1. **A saved environment whose `id` later vanishes from every list, or whose domain changes there.** The kiosk keeps connecting to its saved domain, the picker still names it, and picking the changed entry is a full switch. Test: Tasks 2, 6 and 10 (store/config).
2. **Switching away from a dead server.** The `/auth/me` check fails, so Custom and discard are refused with the offline copy. A named switch with nothing unsent still works. Test: Tasks 3, 7 and 11.
3. **Named switch, then Custom.** An ever-registered kiosk switches to Prod with `cumulus`, then tries Custom without a qualifying sign-in, and is refused. Test: Tasks 3, 7 and 11.
4. **Upgrading a kiosk that has typed URLs saved.** A saved `https://api.uat.serversherpa.com` becomes UAT with no reset. `http://10.10.48.103:8000` becomes Custom with its portal URL (or the build default portal when none was saved). Nothing is migrated when nothing was saved. Test: Tasks 5 and 9.
5. **A downloaded file that is huge, slow or redirecting.** Bodies over 64 KB are rejected, a 3xx counts as a failure, and a timeout falls back to the cached or built-in list without blocking the chooser. Test: Tasks 1, 6 and 10.

---

## Part A — Laptop edge and kiosk web app

Edge tests: `cd kiosk_laptop/edge && .venv/bin/pytest -q`. If `.venv` is missing, first run:
```bash
python3 -m venv kiosk_laptop/edge/.venv && kiosk_laptop/edge/.venv/bin/pip install -e 'kiosk_laptop/edge[dev]'
```

Kiosk tests: `npm --prefix kiosk test`. DOM tests need `// @vitest-environment jsdom` and the `matchMedia` stub used in `KioskShell.test.tsx:11-19`.

### Task 1: Edge environments module and list route

**Files:**
- Create: `kiosk_laptop/edge/src/edge/environments.py`
- Modify: `kiosk_laptop/edge/src/edge/routes/edge.py` (new route), `kiosk_laptop/edge/src/edge/app.py` (state)
- Test: `kiosk_laptop/edge/tests/test_environments.py`

**Interfaces:**
- Produces:
  - `BUILT_IN: tuple[Env, ...]`
  - `@dataclass(frozen=True) Env(id: str, name: str, domain: str)` with properties `api_url`, `portal_url`, `is_prod`
  - `parse_list(raw: bytes) -> list[Env] | None` (None = unusable)
  - `class ListSource(data_dir: Path, *, transport=None)` with `async def current(self) -> tuple[list[Env], str]`, where the str is `"fresh" | "saved" | "built_in"`, plus `aclose()`
  - `STATUS_LIST_URL`
  - `app.state.env_list = ListSource(settings.data_dir, transport=transport)`
  - route `GET /edge/environments` (anonymous) → `{"source": "fresh"|"saved"|"built_in", "environments": [{"id","name","domain","api_url","portal_url","is_prod"}]}`

- [ ] **Step 1: Write failing tests** in `test_environments.py`:
  - `test_built_in_order_and_urls`: the ids are `["prod","rc1","uat","beta","alpha","dev"]`; `BUILT_IN[0].api_url == "https://api.serversherpa.com"`; `BUILT_IN[2].portal_url == "https://portal.uat.serversherpa.com"`; only prod has `is_prod`.
  - `test_parse_drops_bad_entries_keeps_good`: for the entries `{"id":"x","name":"X","domain":"evil.com"}`, `{"id":"y","name":"Y","domain":"api.serversherpa.com:443"}`, `{"id":"z","name":"Z","domain":"serversherpa.com/p"}`, `{"id":"Bad","name":"B","domain":"b.serversherpa.com"}`, `{"id":"rc1","name":"RC1","domain":"rc1.serversherpa.com"}`, `{"id":"rc1","name":"dup","domain":"x.serversherpa.com"}` and `{"id":"n","name":"  ","domain":"n.serversherpa.com"}`, only the first `rc1` survives.
  - `test_parse_rejects_wrong_version_empty_and_bad_json`: `version: 2`, `environments: []`, and `b"{not json"` all return None. So does a body over 64 KB.
  - `test_source_fresh_then_saved_then_built_in` (respx on `STATUS_LIST_URL`):
    - a 200 good body gives `"fresh"` and writes `environments-cache.json` in data_dir;
    - then a 500 gives `"saved"` with the same list;
    - with no cache file and a timeout, it gives `"built_in"`.
  - `test_source_redirect_is_failure`: a 302 to `https://evil.test/x.json` gives `"built_in"`, and evil.test is never called.
  - `test_route_environments_anonymous`: `GET /edge/environments` with no auth returns 200, `source`, and six entries.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_environments.py -q`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - `ListSource` owns its own `httpx.AsyncClient(follow_redirects=False, timeout=5.0, transport=transport)`, separate from `Upstream`. It never sends cookies (empty jar policy as in `upstream.py:57`).
  - The cache is written atomically (identity.py's `_write` pattern).
  - Close the client in the app lifespan shutdown.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then run the full edge suite, which must also PASS.
- [ ] **Step 5: Commit** `feat(edge): environment list with built-in fallback`.

### Task 2: Edge saved environment, registered flag, runtime re-point

**Files:**
- Create: `kiosk_laptop/edge/src/edge/environment_store.py`
- Modify:
  - `upstream.py`: `repoint`
  - `app.py`: resolve at startup; `/config.js` reads live state
  - `proxy.py`: the heartbeat reply sets the flag (next to `_apply_clear_setup`, ~L253)
  - `station_key.py`: issuing a key sets the flag
  - `routes/edge.py`: new `GET /edge/environment`
- Test: `kiosk_laptop/edge/tests/test_environment_store.py`

**Interfaces:**
- Consumes: `Env`, `BUILT_IN` (Task 1).
- Produces:
  - `@dataclass(frozen=True) Current(kind: Literal["named","custom"], id: str|None, name: str, domain: str|None, api_url: str, portal_url: str)` with property `is_prod`
  - `load_current(data_dir: Path, settings: Settings) -> Current`. Uses `environment.json` if valid. Otherwise it takes the installer's `EDGE_CLOUD_API_URL` / `EDGE_PORTAL_URL`, mapped to a named env when the API URL is `https://api.<domain>` of a built-in entry, else `custom`.
  - `save_current(data_dir, cur: Current) -> None` (atomic)
  - `ever_registered(data_dir) -> bool` and `mark_registered(data_dir) -> None`, stored in `registered.json` `{"registered_at": iso}`
  - `Upstream.repoint(base_url: str) -> None` (async): closes the old client and builds a new one with the same timeout, transport and empty cookie policy; sets `online=False` and `last_contact=None`; keeps `_locks`
  - `app.state.environment: Current`
  - `GET /edge/environment` (anonymous) → `{kind,id,name,domain,api_url,portal_url,is_prod,ever_registered}`

- [ ] **Step 1: Write failing tests:**
  - `test_installer_url_maps_to_named`: `cloud_api_url="https://api.uat.serversherpa.com"` gives a named `uat` / UAT.
  - `test_installer_url_unknown_is_custom`: `http://host.docker.internal:8001` gives `custom` with that `api_url` and the settings' `portal_url`.
  - `test_saved_wins_over_env_and_survives_list_change`: after `save_current` of rc1 with domain `rc1.serversherpa.com`, `load_current` still returns that domain even when the list cache maps rc1 elsewhere.
  - `test_corrupt_environment_json_falls_back_to_settings`.
  - `test_heartbeat_reply_marks_registered`: forward a `/kiosk/heartbeat` 200 with `registration: "ok"` and the flag is set. With `"none"` it stays unset.
  - `test_wipe_keeps_registered_flag`.
  - `test_repoint_moves_calls_to_new_base`: respx on two hosts; after `repoint`, `upstream.client` calls go to the new host, and the outbox worker and syncer (same `Upstream` object) use it too.
  - `test_config_js_serves_current_portal`: change `app.state.environment` and `/config.js` returns the new `portalUrl`.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_environment_store.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces. In `create_app`, compute `current = load_current(...)` before building `Upstream`, and pass `current.api_url` as its base URL (`settings.cloud_api_url` stays the installer value). Store `current` on `app.state.environment`.
- [ ] **Step 4: Run** the new tests and then the full edge suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(edge): saved environment and runtime re-point`.

### Task 3: Edge switch routes (unlock + switch)

**Files:**
- Create: `kiosk_laptop/edge/src/edge/environment_switch.py`
- Modify: `routes/edge.py` (extract the body of `/wipe` into `wipe_move_data(st) -> None` in a reusable place and call it from both)
- Test: `kiosk_laptop/edge/tests/test_environment_switch.py`

**Interfaces:**
- Consumes: Tasks 1-2; `deps.current_session` (optional session); `st.upstream.as_person(pid, "GET", "/auth/me")` (returns None with no usable cloud session; raises `CloudOffline`).
- Produces:
  - `PASSWORD = "cumulus"`
  - `POST /edge/environment/unlock {password}` → 204, or 403 `wrong_password`
  - `POST /edge/environment {password, target, discard?: bool}` where `target` = `{"id": str}` | `{"custom": {"api_url", "portal_url"}}` → 200 with the new `/edge/environment` body
  - Error codes:
    - 403 `wrong_password`
    - 422 `unknown_environment` (id not in the current list) or `bad_url`
    - 403 `custom_needs_super_admin`
    - 403 `discard_needs_admin`
    - 409 `outbox_not_empty {pending}`
    - 503 `access_check_offline`

- [ ] **Step 1: Write failing tests:**
  - `test_unlock_wrong_and_right`.
  - `test_named_switch_no_pending_needs_only_password`: anonymous, nothing pending → 200, and `environment.json` is saved.
  - Then, after that switch:
    - the cache and outbox tables are empty;
    - `device_config`, `station_key` and the pause are cleared;
    - the `ss_refresh` cookie is deleted;
    - `identity.json` and `registered.json` are unchanged;
    - the next cloud call goes to the new host.
  - `test_pending_returns_409_with_count`: one outbox row gives 409 `pending == 1`.
  - `test_discard_needs_live_admin`: `discard: true`, anonymous → 403 `discard_needs_admin`. With an offline session of rank 60 → 403 `discard_needs_admin`. With an online session where `/auth/me` gives `max_rank: 60` → 200, and the pending rows are gone.
  - `test_custom_fresh_kiosk_password_only`: not ever registered → custom 200.
  - `test_custom_registered_needs_global_80`: ever registered, with `/auth/me` rank 100 and `scope.global` false → 403; rank 60 → 403; rank 80 and global → 200.
  - `test_named_then_custom_cannot_skip_gate`: ever registered, a named switch (200) and then an anonymous custom → 403 `custom_needs_super_admin`.
  - `test_access_check_offline`: `/auth/me` raises `CloudOffline` → 503 `access_check_offline`.
  - `test_unknown_id_422` and `test_bad_custom_url_422`.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_environment_switch.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** Order:
  1. Password check.
  2. Validate the target.
  3. Run the gate.
  4. Count pending (the same query as `/wipe`). Return 409 unless `discard` passed its gate.
  5. Best-effort cloud logout for the caller's session (ignore errors).
  6. `wipe_move_data`, then clear `device_config`, `station_key.clear()` and `_clear_pause()`.
  7. Drop anything holding an id issued by the old server (e.g. the cloud reader record in `rfid_pairing`), but keep the LAN reader hardware pairing.
  8. `save_current`.
  9. `await upstream.repoint`.
  10. Set `app.state.environment`.
  11. Delete `ss_refresh` (path `/auth`).
- [ ] **Step 4: Run** the new tests and the full edge suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(edge): environment switch with password and access gates`.

### Task 4: Kiosk web (laptop) picker, chooser and badge

**Files:**
- Create: `kiosk/src/lib/environment.ts`, `kiosk/src/components/EnvironmentModal.tsx`
- Modify:
  - `kiosk/src/lib/api.ts` (helpers)
  - `kiosk/src/components/ThisKioskPanel.tsx` (laptop: picker row replaces the read-only URL inputs; web: unchanged)
  - `kiosk/src/lib/factoryReset.ts` (`clearForSwitch`)
  - `kiosk/src/layout/KioskShell.tsx` (badge)
  - `kiosk/src/pages/Login.tsx` (badge next to `eyebrow-row`)
- Test: `kiosk/src/lib/environment.test.ts`, `kiosk/src/components/EnvironmentModal.test.tsx`, plus additions to `ThisKioskPanel.test.tsx`, `KioskShell.test.tsx` and `Login.test.tsx`

**Interfaces:**
- Consumes: the Task 1-3 routes.
- Produces:
  - `getEdgeEnvironment(): Promise<EdgeEnvironment>` and `getEdgeEnvironments(): Promise<{source, environments}>`. Both use raw `request` like `getEdgeStatus` (`api.ts:1037`), so they work signed out.
  - `unlockEnvironment(password): Promise<void>`
  - `switchEnvironment(body): Promise<EdgeEnvironment>`, which sends the bearer if signed in and throws `ApiError` with `code` / `detail.pending`
  - `useEdgeEnvironment(): EdgeEnvironment | null` (fetched once per mount)
  - `clearForSwitch(): Promise<void>` in factoryReset.ts: `resetSettingsToDefaults` → `clearEverything()` → `clearKioskStorage()`, also dropping `ss.kiosk.configSync`, `ss.kiosk.laptopConfigPending` and `ss.kiosk.setupClear`. It does not call `edgeWipe`, because the edge already wiped.

- [ ] **Step 1: Write failing tests:**
  - **EnvironmentModal:**
    - The password step calls `unlockEnvironment`. A 403 shows "That password isn't right."
    - On success the list shows the names in order with the current one marked, and "Custom URL…" last.
    - Picking UAT shows the confirm copy and "Cancel" / "Switch".
    - A 409 `outbox_not_empty` with `pending: 3` shows "3 unsent scans haven't been sent yet." and "Wait for them to send" / "Discard and switch".
    - `discard_needs_admin` shows "Sign in as an admin to discard unsent scans."
    - Custom shows two fields. `custom_needs_super_admin` shows the custom gate copy, and `access_check_offline` the offline copy.
    - Success calls `clearForSwitch` and then `window.location.replace('/login')`.
    - Buttons sit in `modal-foot`, using the ClearSetupModal shell.
  - **ThisKioskPanel:** in laptop mode it shows "Environment" UAT, "Server" `api.uat.serversherpa.com` and "Change…". In web mode it still shows the read-only URL inputs.
  - **Badge:** the shell footer and Login show a `chip c-amber` reading "UAT" on a laptop whose environment isn't Prod, and none on Prod or the plain web kiosk.
  - **`clearForSwitch`:** it removes `ss.kiosk.configSync` and keeps `ss.kiosk.serial` and `ss.kiosk.name`.
- [ ] **Step 2: Run** `npm --prefix kiosk test -- EnvironmentModal ThisKioskPanel environment KioskShell Login`. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces and the Global Constraints copy. Show the picker only when `isLaptop()`.
- [ ] **Step 4: Run** the same tests, then `npm --prefix kiosk test` and `npm --prefix kiosk run build`. Expected: all PASS, and the build succeeds.
- [ ] **Step 5: Commit** `feat(kiosk): laptop environment picker and non-Prod badge`.

## Part B — Android (`Android_Kiosk_App/`)

Tests: `cd Android_Kiosk_App && ./gradlew testPlayDebugUnitTest testDirectDebugUnitTest`, run in the foreground with a long timeout. Pure code goes under `core/` (CorePurityTest: no android/androidx imports). Compose tests use Robolectric `@Config(sdk=[34], qualifiers="w360dp-h800dp")` with `testContainer(...)`.

### Task 5: Android core environments module

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/core/environment/Environments.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/core/environment/EnvironmentsTest.kt`

**Interfaces:**
- Produces (pure Kotlin, `@Serializable`):
  - `data class Env(val id: String, val name: String, val domain: String)` with `apiUrl` and `portalUrl`
  - `sealed interface SavedEnvironment` with `Named(id, name, domain)` and `Custom(apiUrl, portalUrl)`, plus extension properties `apiUrl`, `portalUrl`, `isProd` and `label` (name, or "Custom"). Serialized as the Global Constraints JSON with a `kind` discriminator.
  - `object Environments` with:
    - `BUILT_IN: List<Env>`, `STATUS_LIST_URL`, `PASSWORD = "cumulus"`, `MAX_BODY = 64 * 1024`
    - `fun parseList(body: String): List<Env>?`
    - `fun migrate(savedApi: String?, savedPortal: String?, defaultPortal: String): SavedEnvironment?` (null when nothing was saved)
    - `fun byId(id: String): Env?` (built-in)

- [ ] **Step 1: Write failing tests.** Mirror Task 1's parse cases (same inputs, same survivors) and the built-in order/URL case. Migration cases:
  - `https://api.uat.serversherpa.com/` becomes `Named("uat","UAT","uat.serversherpa.com")`.
  - `http://10.10.48.103:8000` with saved portal `http://10.10.48.103:5173` becomes Custom with both.
  - Custom with no saved portal uses `defaultPortal`.
  - Both null give null.
  - Serialization round trip for both kinds.
- [ ] **Step 2: Run** `./gradlew testPlayDebugUnitTest --tests '*EnvironmentsTest*'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, plus `--tests '*CorePurityTest*'`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(android): environments core`.

### Task 6: Android store, list fetcher, config resolution, registered flag

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/data/environment/EnvironmentStore.kt`, `.../data/environment/EnvironmentListFetcher.kt`
- Modify:
  - `data/prefs/KioskPrefs.kt`: keys `ss.kiosk.environment`, `ss.kiosk.environmentList`, `ss.kiosk.everRegistered`
  - `data/config/KioskConfig.kt`: resolve from the saved environment, else the build default env
  - `app/build.gradle.kts`: `DEFAULT_ENVIRONMENT_ID` is `"dev"` in debug and `"prod"` in release. The existing `DEFAULT_API_URL` / `DEFAULT_PORTAL_URL` fields are removed or derived from it; update `BuildConfigTest`.
  - `AppContainer.kt`: run the migration once at start; wire the store
  - The Heartbeat reply handling sets the flag when registration != none
- Test: `.../data/environment/EnvironmentStoreTest.kt`, `EnvironmentListFetcherTest.kt`, plus updates to `KioskConfigTest.kt` and `TestContainer.kt` (save a `Custom("http://127.0.0.1:1", …)` instead of `setApiUrl`)

**Interfaces:**
- Consumes: Task 5.
- Produces:
  - `class EnvironmentStore(prefs: KioskPrefs)` with:
    - `val saved: Flow<SavedEnvironment?>`
    - `suspend fun save(env: SavedEnvironment)`
    - `val everRegistered: Flow<Boolean>`
    - `suspend fun markRegistered()`
    - `suspend fun cachedList(): List<Env>?`
    - `suspend fun cacheList(list: List<Env>)`
    - `suspend fun migrateIfNeeded(defaultPortal: String)`: converts old `ss.kiosk.apiUrl` / `portalUrl` once, then removes those keys
  - `class EnvironmentListFetcher(client: OkHttpClient, store: EnvironmentStore, url: String = Environments.STATUS_LIST_URL)` with `suspend fun current(): Pair<List<Env>, ListSource>`, where `enum ListSource { FRESH, SAVED, BUILT_IN }`. It uses `client.newBuilder().cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false).callTimeout(5, SECONDS)` and reads at most `MAX_BODY`.
  - `KioskConfig(prefs, store, defaultEnvironment: SavedEnvironment, kioskVersion)`, keeping `apiUrl` / `portalUrl` flows and `originOf` / `normalizeUrl`.
  - `container.environments: EnvironmentStore` and `container.environmentList: EnvironmentListFetcher`.

- [ ] **Step 1: Write failing tests** (MockWebServer or the existing fake HTTP pattern):
  - fetcher fresh, then saved, then built-in;
  - a 302 is a failure and the target is never hit;
  - an oversized body is a failure;
  - the saved env wins and a later list never changes the URLs (Review Focus 1);
  - migration runs once and removes the old keys;
  - the heartbeat `registration: "ok"` sets `everRegistered`, and `"none"` doesn't;
  - with nothing saved, the default env comes from `BuildConfig`.
- [ ] **Step 2: Run** `./gradlew testPlayDebugUnitTest --tests '*Environment*' --tests '*KioskConfigTest*'`. Expected: FAIL.
- [ ] **Step 3: Implement.** Fix every compile break left by removing `setApiUrl` callers. The only callers are ThisKioskPanel and tests; the panel is rewritten in Task 8, so for now give it a temporary `saveCustom` call.
- [ ] **Step 4: Run** both full suites. Expected: PASS.
- [ ] **Step 5: Commit** `feat(android): saved environment, list fetch, registered flag`.

### Task 7: Android switcher

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/data/environment/EnvironmentSwitcher.kt`
- Modify:
  - `data/api/RefreshCookieJar.kt`: `clearAllRefreshCookies()` removes every `cookie|*|ss_refresh` key in SecretStore (needs key enumeration on SecretStore; add `keys(): Set<String>`)
  - `data/outbox/Outbox.kt`: `discardAll()`
  - `data/api/KioskApi.kt` + `OkHttpKioskApi.kt` + `FakeKioskApi`: `suspend fun me(): MeInfo` (GET `/auth/me` via `authed()`), where `MeInfo(roles: List<String>, max_rank: Int, scope: Scope(global: Boolean))`
  - push: make the forget-here path callable (`PushRegistrar.forgetForSwitch()`)
- Test: `app/src/test/java/com/serversherpa/kiosk/data/environment/EnvironmentSwitcherTest.kt`

**Interfaces:**
- Consumes: Tasks 5-6; `AppContainer.resetApp`, `logout`, `BiometricSignIn.forget`, `StationKeyStore.clear`, `KioskPrefs` (signInMethod, setupClear).
- Produces:
  - `class EnvironmentSwitcher(container deps…)` with `suspend fun switchTo(target: SavedEnvironment, discard: Boolean): SwitchResult`
  - `sealed interface SwitchResult`:
    - `Done`
    - `Pending(count: Int)`
    - `Refused(code: String)`, where code is `custom_needs_super_admin` | `discard_needs_admin` | `access_check_offline`
  - `fun unsentCount(): Int` = outbox `queued + failed`

- [ ] **Step 1: Write failing tests** (with FakeKioskApi):
  - A named switch with an empty outbox gives `Done`. Afterwards:
    - the saved env is the new one and `config.apiUrl` emits the new API;
    - every `ss_refresh` cookie (including a host from an earlier process) is gone;
    - the station key, push store, biometric and signInMethod are cleared;
    - `resetApp` ran;
    - serial, name and `everRegistered` are unchanged.
  - Pending outbox: `Pending(2)`. `discard=true` while anonymous gives `Refused("discard_needs_admin")`; with `me()` rank 60 it gives `Done` and the outbox is empty.
  - Custom on a never-registered kiosk gives `Done`.
  - Custom on an ever-registered kiosk: rank 100 non-global is refused, rank 80 global is `Done`, and `me()` throwing a network error gives `Refused("access_check_offline")`.
  - Named then custom (Review Focus 3) is refused.
- [ ] **Step 2: Run** `./gradlew testPlayDebugUnitTest --tests '*EnvironmentSwitcherTest*'`. Expected: FAIL.
- [ ] **Step 3: Implement.** Order:
  1. Gate checks: `me()` only when needed.
  2. Pending check.
  3. Best-effort server calls while still signed in: `biometric.forget(signedIn=true)` and the push delete.
  4. `logout()` (best effort).
  5. `clearAllRefreshCookies`.
  6. `resetApp()`.
  7. `outbox.discardAll()` when discarding.
  8. Clear the station key, push store, signInMethod and setupClear.
  9. `store.save(target)`.
  10. `heartbeat.stop()` and restart.

  Keep appearance, sound and the other device settings. Android has no settings sync, so the spec's reason for resetting them doesn't apply. Note this in the commit body.
- [ ] **Step 4: Run** both full suites. Expected: PASS.
- [ ] **Step 5: Commit** `feat(android): environment switcher with gates`.

### Task 8: Android UI — picker row, chooser dialog, badge

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/EnvironmentChooser.kt`
- Modify:
  - `ui/screens/settings/ThisKioskPanel.kt`: replace L344-355
  - `ui/shell/KioskShell.kt`: top-bar badge
  - `ui/screens/login/LoginScreen.kt`: badge by `LoginBrand`
- Test: `app/src/test/java/com/serversherpa/kiosk/ui/screens/settings/EnvironmentChooserTest.kt`; update `ui/StationModeTest.kt` (13 `api-url` / "Save URLs" references → the new picker, or drop the parts that only tested URL typing)

**Interfaces:**
- Consumes: Tasks 6-7.
- Produces:
  - composable `EnvironmentRow()` (tags `env-name`, `env-server`, `env-change`)
  - `EnvironmentChooser(onDismiss)`: a custom rounded `Dialog` in the `TestLabelSheet.kt:49` style, with steps password → list → (custom fields) → confirm. It uses a masked field in the style of `LoginField` and has tags `env-password`, `env-row-<id>`, `env-custom`, `env-confirm`, `env-discard`.
  - `EnvironmentBadge()`: `KioskChip(label, ChipTone.AMBER)`, hidden on Prod

- [ ] **Step 1: Write failing Compose tests:**
  - the row shows UAT and `api.uat.serversherpa.com`;
  - a wrong password shows the copy;
  - the list order, with Custom URL… last;
  - confirm copy with and without unsent work;
  - each refusal code shows its copy;
  - success navigates to the login route;
  - the badge shows on UAT and not on Prod, on both the shell and login;
  - the dialog's buttons are visible at `w360dp-h640dp` (no scroll needed).
- [ ] **Step 2: Run** `./gradlew testPlayDebugUnitTest --tests '*EnvironmentChooserTest*' --tests '*StationModeTest*'`. Expected: FAIL.
- [ ] **Step 3: Implement** with the Global Constraints copy. Typing calls `LocalStationActivity.current()` as today.
- [ ] **Step 4: Run** both full suites. Expected: PASS.
- [ ] **Step 5: Commit** `feat(android): environment picker UI and non-Prod badge`.

## Part C — iOS (`IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`)

Tests (foreground, long timeout):
```bash
cd IOS_Kiosk_App && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M3),OS=18.5' -derivedDataPath ../.derived -only-testing:"ServerSherpa KioskTests"
```
Swift Testing (`@Test`, `#expect`). Test basenames must be unique in the target. Use `freshDefaults()`, `MemorySecretStore`, `FakeKioskApi` and `StubURLProtocol`; never the live Keychain or network.

### Task 9: iOS core environments module

**Files:**
- Create: `Core/Environment/Environments.swift`
- Test: `ServerSherpa KioskTests/Core/EnvironmentsTests.swift`

**Interfaces:**
- Produces:
  - `struct Env: Codable, Equatable, Identifiable { id, name, domain }` with `apiUrl` and `portalUrl`
  - `enum SavedEnvironment: Codable, Equatable { case named(id: String, name: String, domain: String); case custom(apiUrl: String, portalUrl: String) }`, encoded as the Global Constraints JSON (`kind`, `api_url`, `portal_url`), with `apiUrl`, `portalUrl`, `isProd` and `label`
  - `enum Environments` with:
    - `static let builtIn`, `statusListURL`, `password = "cumulus"`, `maxBody = 65536`
    - `static func parseList(_ data: Data) -> [Env]?`
    - `static func migrate(savedApi: String?, savedPortal: String?, defaultPortal: String) -> SavedEnvironment?`
    - `static func byId(_:) -> Env?`

- [ ] **Step 1: Write failing tests:** the same cases as Task 5 (same inputs and expected survivors).
- [ ] **Step 2: Run** the test command with `-only-testing:"ServerSherpa KioskTests/EnvironmentsTests"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): environments core`.

### Task 10: iOS store, list fetcher, config resolution, registered flag

**Files:**
- Create: `Data/Environment/EnvironmentStore.swift`, `Data/Environment/EnvironmentListFetcher.swift`
- Modify:
  - `Data/Prefs/KioskPrefs.swift`: keys `ss.kiosk.environment`, `ss.kiosk.environmentList`, `ss.kiosk.everRegistered`
  - `Data/Config/KioskConfig.swift`: resolve from the saved env, else the default env
  - `App/App/KioskBuildConfig.swift`: `defaultEnvironmentId` is `"dev"` under DEBUG, else `"prod"` (fixes the Release dev-portal default)
  - `App/App/AppContainer.swift`: migration at start
  - `Data/Heartbeat/Heartbeat.swift`: mark registered when registration != none
- Test: `ServerSherpa KioskTests/Data/EnvironmentStoreTests.swift`, `EnvironmentListFetcherTests.swift`; update `Data/KioskConfigTests.swift`

**Interfaces:**
- Consumes: Task 9.
- Produces:
  - `@MainActor @Observable final class EnvironmentStore(prefs:)` with:
    - `saved: SavedEnvironment?`
    - `save(_:)`
    - `everRegistered: Bool`
    - `markRegistered()`
    - `cachedList: [Env]?`
    - `cacheList(_:)`
    - `migrateIfNeeded(defaultPortal:)`
  - `final class EnvironmentListFetcher(store:, session: URLSession = .makeEnvironmentListSession())` with `func current() async -> (list: [Env], source: ListSource)`, where `enum ListSource { case fresh, saved, builtIn }`. Its own ephemeral session has a delegate that **refuses all redirects**, a 5 s timeout and no cookies. `RedirectGuard` must not be reused, because it follows credential-less cross-origin GETs.
  - `KioskConfig(prefs:store:defaultEnvironment:kioskVersion:)` keeps `apiUrl` / `portalUrl` and `normalizeUrl`.
  - `container.environments` and `container.environmentList`.

- [ ] **Step 1: Write failing tests:** the same cases as Task 6, using `StubURLProtocol` (`.redirect(to:)`, `.fail`).
- [ ] **Step 2: Run** with `-only-testing` for the new suites and `KioskConfigTests`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the `setApiUrl` / `setPortalUrl` callers or keep them internal for the custom path.
- [ ] **Step 4: Run** the full test command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): saved environment, list fetch, registered flag`.

### Task 11: iOS switcher

**Files:**
- Create: `Data/Environment/EnvironmentSwitcher.swift`
- Modify:
  - `Data/Outbox/Outbox.swift`: `discardAll()`
  - `Data/Api/KioskApi.swift` + `URLSessionKioskApi.swift` + `FakeKioskApi`: `func me() async throws -> MeInfo`, where `MeInfo { roles, maxRank, isGlobal }` decoded from `scope.global`
  - `UI/Screens/Settings/SettingsModel.swift`: remove `saveUrls`
- Test: `ServerSherpa KioskTests/Data/EnvironmentSwitcherTests.swift`; replace `UI/SettingsModelTests.swift:68-112`

**Interfaces:**
- Consumes: Tasks 9-10; `AppContainer.resetApp()`, `KioskAuth.logout()`, `SessionStore.signOutLocally()`, `BiometricSignIn.forget(signedIn:)`, `TimeclockStation.clearKey()`, `cookies.clear(host:)`.
- Produces:
  - `@MainActor final class EnvironmentSwitcher` with `func switchTo(_ target: SavedEnvironment, discard: Bool) async -> SwitchResult`
  - `enum SwitchResult: Equatable { case done, pending(Int), refused(String) }` (same codes as Task 7)
  - `var unsentCount: Int` = `queued + failed`

- [ ] **Step 1: Write failing tests:** the same cases as Task 7. iOS has no push: assert instead that the `ss.kiosk.setupClear` record, `signInMethod` and the Rolodex cache are cleared.
- [ ] **Step 2: Run** with `-only-testing` for `EnvironmentSwitcherTests`. Expected: FAIL.
- [ ] **Step 3: Implement** in the same order as Task 7. Clear the old host's refresh cookie with `cookies.clear(host:)` using the pre-switch API host, then call `resetApp()`. Add a `KioskPrefs` method to clear `setupClear`. Keep device settings (same reason as Android).
- [ ] **Step 4: Run** the full test command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): environment switcher with gates`.

### Task 12: iOS UI — picker row, chooser sheet, badge

**Files:**
- Create: `UI/Screens/Settings/EnvironmentChooser.swift`
- Modify:
  - `UI/Screens/Settings/ThisKioskPanel.swift`: replace the API URL row (L71-93)
  - `UI/Shell/KioskShell.swift`: `topBar` badge
  - `UI/Screens/Login/LoginScreen.swift`: badge in the wide and compact layouts
- Test: `ServerSherpa KioskTests/UI/EnvironmentChooserTests.swift` (model-level: step transitions and copy per result); extend `SheetButtonsUITests` to the chooser sheet so its buttons are on screen on the iPhone 16 and iPad

**Interfaces:**
- Consumes: Tasks 10-11.
- Produces:
  - `EnvironmentRow` (accessibility ids `env-name`, `env-server`, `env-change`)
  - `EnvironmentChooser` sheet using `PinnedActions` + `PageHeader(eyebrow: "This kiosk", title: "Change environment")`, `.presentationCornerRadius(16)` and `.interactiveDismissDisabled(busy)`; masked field with ids `env-password`, `env-row-<id>`, `env-custom`, `env-confirm`, `env-discard`
  - `@Observable EnvironmentChooserModel` holding the step and error copy
  - badge `KioskChip(text: label, tone: .amber)`, hidden on Prod

- [ ] **Step 1: Write failing tests:** the same behaviors as Task 8 at model level, plus the UI test that the sheet's buttons are hittable.
- [ ] **Step 2: Run** with `-only-testing` for `EnvironmentChooserTests` and `SheetButtonsUITests`. Expected: FAIL.
- [ ] **Step 3: Implement.** Typing calls `container.station.noteLoginActivity()`. On a Time Clock station the login sheet's auto-close must not dismiss the chooser mid-switch (honor `busy`).
- [ ] **Step 4: Run** the full unit test command, then a build for `name=iPhone 16`. Expected: PASS, and the build succeeds.
- [ ] **Step 5: Commit** `feat(ios): environment picker UI and non-Prod badge`.

---

## Task 13: Docs

**Files:**
- Modify: `kiosk_laptop/README.md`: a "Changing environment" section (Settings › This Kiosk; `environment.json` overrides `EDGE_CLOUD_API_URL`; delete it to go back to the installer's URL)
- Create: `docs/kiosk-environments.md`: the `environments.json` contract from the spec, for the later status-site and Sirdar work (fields, validation, address derivation, no CORS needed for native or edge)

- [ ] **Step 1:** Write both, in American English.
- [ ] **Step 2: Commit** `docs: kiosk environment picker`.
