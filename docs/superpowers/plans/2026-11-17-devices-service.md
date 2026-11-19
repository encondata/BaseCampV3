# Devices service (app distribution) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the separate Devices service at `devices.<env>.serversherpa.com`: standard sign-in, an app catalog that installs Android APKs and Ad Hoc iOS IPAs over the air, automatic iPhone registration and server-side re-signing, and the update endpoint the kiosk apps will call.

**Architecture:** A new `devices/` service with its own FastAPI backend (`serversherpa_devices`), its own Postgres database, its own bucket and its own worker. The same container serves its React web app. It trusts the main API for sign-in: it forwards the caller's bearer token to a new main-API internal endpoint guarded by a shared service token, the same way the wiki's live-editing server does. The main API gains a permission resource, the internal endpoints, and the `devices` app flag; the portal gains a nav link.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async + asyncpg, Alembic (psycopg), pydantic-settings, boto3, cryptography (Fernet), PyJWT (ES256 for Apple, HS256 for links), asn1crypto, androguard 4.1.x (`<5`), httpx, rcodesign 0.29.0 (Linux musl binary). Web: React 18.3, react-router 6.30, Vite 5.4, vitest 3.2, `@portal` imports.

**Spec:** `docs/superpowers/specs/2026-11-17-devices-app-design.md`

**Out of this plan (own plans, after this one ships to dev):** the Android kiosk updater with `play`/`direct` flavors, and the iOS kiosk updater. They consume Task 12's `/api/updates` contract. Sirdar's app/port lists are also a follow-up.

## Global Constraints

- Names. The main API already uses "devices" for the scanning-hardware registry (`/devices`, `Device`, audit `entity_type="device"`). So in the **main API** this feature is always `app_distribution`:
  - the resource is `app_distribution`, labeled `"Apps"`;
  - routes are under `/app-distribution/internal`;
  - the settings are `devices_service_token` (`SS_DEVICES_SERVICE_TOKEN`) and `devices_origin` (`SS_DEVICES_ORIGIN`);
  - audit `entity_type` values are `appdist_app`, `appdist_version`, `appdist_device`, `appdist_apple`.
- The service token header is `X-Devices-Service-Token`. The service env prefix is `DEVICES_`. The Python package is `serversherpa_devices` under `devices/api/src`.
- Default grants: developer, founder, super_admin and admin get `view, add, change, delete`; staff get `view`. Every other role gets nothing.
- Permission meanings:
  - `view`: sign in, add an iPhone, install.
  - `add`: upload.
  - `change`: notes, make current, Apple settings.
  - `delete`: delete versions, disable devices.
- Kiosk sessions (`client == "kiosk"`) may only use `/api/updates` and the install links it returns. They never reach the web app's API.
- Read-only mode: for non-developers, every devices write returns 423 `read_only_mode`, carrying the main API's message.
- Apple profile name: `ServerSherpa Devices · <bundle id>`. The worker only ever deletes profiles with exactly that name.
- One stack owns iOS: the stack whose Apple settings are filled in. When they are empty, every iOS card, iOS upload and iOS update answer says iPhone installs are set up on `DEVICES_IOS_OWNER_URL` (when that is set), or that Apple settings aren't set up yet.
- The Apple certificate `.p12`, its password and the `.p8` key are Fernet-encrypted with `DEVICES_SECRET_KEY` (env only). No endpoint returns them.
- Install links (APK download, iOS manifest, IPA) carry a signed token. It is HS256 over a key derived from `DEVICES_SECRET_KEY`, with purpose `"install"` and a 30-minute lifetime.
- UI rules:
  - Follow the user's light/dark theme through `applyPreferences`. Never force a theme.
  - Show times as 24-hour HH:MM and dates as YYYY-MM-DD.
  - Use American English.
  - Modals use `StandardModal` (eyebrow, title, description header) with rounded corners.
  - Modal action buttons are always visible, never below a scroll.
  - Row actions use `RowActionsMenu` ("Actions ▾").
  - Lists use `DataTable`.
  - No default browser scrollbars: reuse the portal's scrollbar styling.
  - Every destructive action shows a review summary first.
- Ports:
  - dev devices API **8099**, dev web **5180**;
  - stack `STACK_DEVICES_PORT` **8093** (container 8080);
  - dev devices database **`serversherpa_devices`** on the dev Postgres (127.0.0.1:5433);
  - dev bucket **`serversherpa-devices`** on dev MinIO.
- Dev previews bind 0.0.0.0 (LAN-reachable).
- Tests never call Apple, never write to the dev database, and never sign in to the live dev site. Subagents never sign in anywhere.
- API test DB: `SS_TEST_DB=serversherpa_test_devices`. Devices test DB: `DEVICES_TEST_DB=devices_test`, which must start with `devices_test`.

## Review Focus

1. **A second upload of the same build, or an older build:** rejected with "0.1.1 (2) is already uploaded" or "Build 2 isn't newer than 0.1.2 (3)", never stored twice. Rollback is only through Make current. *(Task 8: `test_commit_rejects_duplicate_and_older_build`)*
2. **An iPhone added twice** (Safari storage cleared, profile run again): the same UDID maps to the same device row; Apple isn't called again when the device already exists there, and a disabled device is re-enabled. *(Task 10: `test_callback_same_udid_reuses_device`; Task 11: `test_register_existing_apple_device_skips_post`)*
3. **Several iPhones added within seconds:** at most one profile rebuild is queued at a time, and the last one includes every device. *(Task 11: `test_rebuild_is_coalesced`)*
4. **A main-API session revoked mid-use:** the devices API stops accepting it within the cache window (60 s), and a 401 from authorize is never cached. *(Task 5: `test_401_is_not_cached`, `test_cache_expires_after_ttl`)*
5. **An Android APK signed with a different key**, including a Play-signed APK uploaded by mistake: rejected at inspect, naming both certificate digests' first 12 hex characters. The update endpoint answers `reinstall_required` for a phone whose installed digest differs. *(Task 8: `test_inspect_rejects_new_signing_key`; Task 12: `test_updates_android_digest_mismatch`)*

---

### Task 1: Main API — `app_distribution` permission resource

**Files:**
- Modify: `api/src/serversherpa/access/resources.py` (append to `_RESOURCES`)
- Modify: `api/src/serversherpa/access/defaults.py` (`_ALL`, `admin`, `staff` entries)
- Create: `api/migrations/versions/0131_app_distribution.py` (`revision="0131"`, `down_revision="0130"`)
- Modify: `api/tests/test_access_registry.py`
- Create: `api/tests/test_app_distribution_migration.py`

**Interfaces:**
- Produces: resource id `"app_distribution"`, label `"Apps"`, `visible_to=frozenset({"global"})`, no `routes`.

- [ ] **Step 1: Write the failing tests.**
  - In `test_access_registry.py`, add `"app_distribution"` to the expected id set in `test_registry_shape`.
  - Add `test_app_distribution_default_grants`. It asserts:
    - developer, founder, super_admin and admin each get `{"view","add","change","delete"}`;
    - staff get `{"view"}`;
    - client_owner, client_admin and learning_admin get nothing.
  - In the migration test, copy `test_plans_migration.py`'s round trip on `<SS_TEST_DB>_m0131`. After upgrade the `role_permissions` rows match the grants above; after downgrade to 0130 none remain.
- [ ] **Step 2: Run** `cd api && SS_TEST_DB=serversherpa_test_devices .venv/bin/pytest tests/test_access_registry.py tests/test_app_distribution_migration.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Append the Resource.
  - Add `"app_distribution"` to `_ALL`, `admin` (FULL) and `staff` (`("view",)`).
  - The migration inserts the rows with the `0117_project_plans.py` pattern (`ON CONFLICT DO NOTHING`), plus staff `view`; downgrade deletes `resource='app_distribution'`.
- [ ] **Step 4: Run** the same command, then the whole access suite (`.venv/bin/pytest tests -k "access or kiosk_access" -q`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(access): app_distribution permission resource (Apps)`.

### Task 2: Main API — internal authorize and audit endpoints

**Files:**
- Modify: `api/src/serversherpa/config.py`: add `devices_service_token: SecretStr = SecretStr("")` and `devices_origin: str = "http://localhost:5180"`.
- Create: `api/src/serversherpa/api/routes/app_distribution_internal.py`
- Modify: `api/src/serversherpa/api/app.py` (include the router)
- Modify: `api/src/serversherpa/api/schemas.py` (add `AppDistAuthorizeOut`, `AppDistAuditIn`)
- Create: `api/tests/test_app_distribution_internal.py`

**Interfaces:**
- `router = APIRouter(prefix="/app-distribution/internal", dependencies=[Depends(service_auth)])`.
  - `service_auth` follows `wiki/internal.py`: a missing configured token gives 503 `internal_disabled`; a wrong or missing header gives 401 `bad_service_token` (`hmac.compare_digest`).
- `GET /app-distribution/internal/authorize`. It takes the user's `Authorization: Bearer` and returns `AppDistAuthorizeOut`:
  ```
  person_id: UUID; display_name: str; email: str | None
  client: Literal["portal","kiosk"]; kiosk_serial: str | None
  actions: list[Literal["view","add","change","delete"]]   # from user.access.perms["app_distribution"]
  password_change_required: bool                          # password_change_owed(db, user)
  read_only: bool                                          # admin config read_only and "developer" not in roles
  read_only_message: str | None
  ```
  - It calls `authenticate_token` and maps that 401 to 401 `unauthenticated`.
  - It deliberately does **not** call `enforce_session_scope` or `enforce_forced_password_change`: the devices service enforces those using the fields above.
- `POST /app-distribution/internal/audit` takes `AppDistAuditIn` and returns 204.
  - Body: `actor_person_id: UUID | None`, `entity_type: Literal["appdist_app","appdist_version","appdist_device","appdist_apple"]`, `entity_id: str`, `action: str` (max 64), `changes: dict = {}`, `ip: str | None`.
  - It calls `services.audit.audit(...)` and commits.

- [ ] **Step 1: Write the failing tests** (token fixture copied from `test_wiki_internal_api.py`, env `SS_DEVICES_SERVICE_TOKEN`):
  - `test_service_token_is_required_and_compared`: the four cases, as in the wiki test.
  - `test_authorize_portal_staff`: `login_as(..., roles=("staff",))` gives `client=="portal"`, `actions==["view"]`, `kiosk_serial is None`.
  - `test_authorize_admin_has_all_actions`.
  - `test_authorize_kiosk_session` (password login with `client="kiosk"` by a user holding `kiosk:view`): `client=="kiosk"`. This must not be 403 `kiosk_session`.
  - `test_authorize_revoked_session_401`: revoke via `/auth/logout`, then 401 `unauthenticated`.
  - `test_authorize_reports_read_only` (set admin config read_only): true for staff, false for developer.
  - `test_audit_writes_row`: a row with that entity_type/action/changes and the actor.
  - `test_audit_rejects_unknown_entity_type`: 422.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_app_distribution_internal.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the router and schemas, and register it in `create_app()`.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): app-distribution internal authorize + audit for the devices service`.

### Task 3: Main API + portal — `devices` app flag and Apps nav link

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (`AppsStatusOut.devices: bool = True`)
- Modify: `api/src/serversherpa/api/routes/system.py` (add `"devices"` to the apps tuple in `_status_from`)
- Modify: `api/tests/test_apps_setting.py`
- Modify: `portal/src/lib/systemStatus.ts` (`PortalApp` and `apps` type gain `'devices'`)
- Modify: `portal/src/lib/appLinks.ts`: add `export const DEVICES_DEV_PORT = 5180` and `export function devicesUrl(loc: LocationLike = pageLocation()): string`, which returns `VITE_DEVICES_URL`, then the sibling `devices.*`, then `:5180`.
- Modify: `portal/src/layout/navSections.tsx` and `portal/src/lib/godmode.ts` (the `app` unions gain `'devices'`; add an Apps item `{ to: 'app:devices', href: devicesUrl(), label: 'Devices', resource: 'app_distribution', app: 'devices', icon }` after Wiki)
- Modify: `portal/src/lib/api.ts`: add `export async function accessTokenForService(): Promise<string | null>`. It returns the in-memory token, refreshing first through the existing single-flight `refreshSession()` when it is stale (same 30 s rule as `apiFetch`), and returns null when signed out.
- Modify/Test: `portal/src/layout/appsNav.test.tsx`, `portal/src/lib/appLinks.test.ts` (create it if missing), `portal/src/lib/api.test.ts` (or the closest existing api test)

**Interfaces:**
- Produces: `devicesUrl()`, `accessTokenForService()`, and `apps.devices` in `/system/status`.

- [ ] **Step 1: Write the failing tests.**
  - API:
    - `SS_APPS="wiki"` gives `apps.devices is False`;
    - unset gives True.
  - Portal:
    - the Devices link shows for staff and hides when `apps.devices === false` or when `can('app_distribution','view')` is false;
    - `devicesUrl` gives `https://devices.dev.serversherpa.com` from `portal.dev.serversherpa.com`, and `http://localhost:5180` from localhost;
    - `accessTokenForService` returns null while signed out and calls refresh exactly once for two concurrent calls on a stale token.
- [ ] **Step 2: Run** `cd api && .venv/bin/pytest tests/test_apps_setting.py -q` and `cd portal && npx vitest run src/layout/appsNav.test.tsx src/lib/appLinks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both again, then `cd portal && npx tsc -b && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): Devices link in Apps nav; devices app flag`.

### Task 4: Devices API scaffold — package, settings, database, schema

**Files:**
- Create: `devices/api/pyproject.toml`
  - project `serversherpa-devices`, python `>=3.13`, script `devices = "serversherpa_devices.cli:app"`;
  - deps: fastapi>=0.118, uvicorn[standard]>=0.30, pydantic-settings>=2.3, sqlalchemy[asyncio]>=2.0, alembic>=1.13, asyncpg>=0.29, psycopg[binary]>=3.1, boto3>=1.34, cryptography>=46, pyjwt[crypto]>=2.9, asn1crypto>=1.5, androguard>=4.1.4,<5, httpx>=0.27, typer>=0.12, pillow>=11;
  - dev extras: pytest>=8, pytest-asyncio>=0.24, respx>=0.21.
  - Pytest/ruff config is copied from `sirdar/api/pyproject.toml`.
- Create: `devices/api/alembic.ini`, `devices/api/migrations/env.py` (the sirdar pattern, `target_metadata=None`), and `devices/api/migrations/versions/0001_initial.py`
- Create: `devices/api/src/serversherpa_devices/{__init__,config,cli}.py`, `db/{engine,models}.py`, `api/app.py`
- Create: `devices/api/tests/conftest.py`, `devices/api/tests/test_scaffold.py`
- Create: `devices/README.md` (dev setup: venv, create DB, run)
- Create: `scripts/devices-dev-db.sh`. It runs `CREATE DATABASE serversherpa_devices` on the dev Postgres if missing (via `docker compose -f docker-compose.dev.yml exec postgres psql`), and `mc mb --ignore-existing local/serversherpa-devices` on MinIO.

**Interfaces:**
- `Settings` (env prefix `DEVICES_`, env file `devices/.env`, `frozen=True`, `hide_input_in_errors=True`):
  - `env`, `database_url: SecretStr`, `database_ssl`;
  - `main_api_url: str` (internal, e.g. `http://localhost:8000`);
  - `service_token: SecretStr` (accepts `DEVICES_SERVICE_TOKEN` or `SS_DEVICES_SERVICE_TOKEN` via AliasChoices);
  - `secret_key: SecretStr` (a Fernet key);
  - `public_url: str` (e.g. `https://devices.dev.serversherpa.com`);
  - `ios_owner_url: str = ""`;
  - `spaces_endpoint`, `spaces_region`, `spaces_bucket = "serversherpa-devices"`, `spaces_access_key`, `spaces_secret_key`, `spaces_use_path_style: bool = False`;
  - `static_dir: str = ""`;
  - `rcodesign_path: str = "rcodesign"`;
  - `authorize_cache_seconds: int = 60`.
  - Also the `sync_database_url` property and `get_settings()` (lru_cache).
- `db/models.py` uses `Base` with sirdar's `type_annotation_map`. Tables, all `id uuid pk default gen_random_uuid()` and `created_at timestamptz default now()` unless stated:
  - `apple_settings` (singleton `id int pk check id=1`):
    - `team_id`, `issuer_id`, `key_id`, `p8_enc bytea`, `p12_enc bytea`, `p12_password_enc bytea`;
    - `cert_name`, `cert_serial`, `cert_expires_at`, `asc_certificate_id`;
    - `updated_by uuid`, `updated_by_name`, `updated_at`.
  - `apps`:
    - `platform text check in ('android','ios')`, `identifier text`, `name`, `icon_key text null`;
    - `signing_digest text null` (Android SHA-256 hex of the first upload's signer), `asc_bundle_id text null`;
    - `unique(platform, identifier)`.
  - `app_versions`:
    - `app_id fk`, `version_name`, `build text`, `build_sort bigint` (Android versionCode; iOS natural-sort key from Task 7);
    - `notes text default ''`, `file_key`, `size bigint`, `sha256`, `min_os text null`;
    - `uploaded_by uuid`, `uploaded_by_name`, `uploaded_at`, `is_current bool default false`, `deleted_at null`;
    - `unique(app_id, version_name, build)`, and a partial unique index on `(app_id) where is_current and deleted_at is null`.
  - `ios_devices`:
    - `udid text unique`, `name`, `product`, `os_version`, `serial null`;
    - `added_by uuid`, `added_by_name`, `added_at`;
    - `status text check in ('pending','registered','failed','disabled')`, `error null`, `asc_device_id null`, `device_class null`.
  - `ios_profiles`: `app_id fk unique`, `asc_profile_id`, `uuid`, `content bytea`, `expires_at`, `device_ids uuid[]`.
  - `signed_builds`:
    - `version_id fk`, `profile_uuid`;
    - `status text check in ('queued','running','ready','failed')`, `file_key null`, `error null`;
    - `unique(version_id, profile_uuid)`.
  - `enroll_tokens`: `token_hash text pk`, `person_id`, `person_name`, `device_name`, `created_at`, `expires_at`, `used_at null`.
  - `uploads`:
    - `file_key`, `filename`, `size`, `created_by`, `created_at`;
    - `inspected jsonb null` (Task 8's inspection result), `committed_at null`.
  - `jobs`: the `wiki_jobs` shape. `kind check in ('register_device','rebuild_profiles','sign_build','ensure_bundle','disable_device','sync_devices')`, `payload jsonb`, `status`, `attempts`, `error`, `result`, `progress_at`, `started_at`, `finished_at`.
  - `apple_device_counts`: `device_class pk`, `count int`, `synced_at`.
- `create_app()` follows sirdar:
  - an `/api` router;
  - `/healthz` and `/api/healthz` (503 when the DB is down);
  - docs off in production;
  - a 422 handler that strips `input`/`ctx`;
  - `_mount_spa(static_dir)`, which returns 404 for `api/*`, `enroll/*`, `ota/*` and `dl/*` misses.
- `cli.py` (typer): commands `serve` and `worker` (the worker is filled in by Task 11).

- [ ] **Step 1: Write the failing tests.**
  - `conftest.py` copies sirdar's pattern:
    - `DEVICES_TEST_DB` default `devices_test`, refusing any name not starting with it;
    - the base URL comes from `DEVICES_TEST_DATABASE_URL`, default `postgresql+asyncpg://` using the dev `.env`'s `POSTGRES_USER`/`POSTGRES_PASSWORD` at `127.0.0.1:5433`;
    - create the database if missing, run `alembic upgrade head`, and an autouse TRUNCATE fixture;
    - fixtures `client` (ASGITransport) and `db`;
    - an autouse `no_real_http` fixture.
  - `test_scaffold.py`:
    - `test_healthz_ok`;
    - `test_unknown_api_path_404_not_spa`;
    - `test_alembic_round_trip` (downgrade base, then upgrade head, on `devices_test_m0001`).
- [ ] **Step 2: Run** `cd devices/api && python3.13 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/pytest -q`. Expected: FAIL.
- [ ] **Step 3: Implement** the package, migration, engine, app and CLI.
- [ ] **Step 4: Run** `.venv/bin/pytest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices): service scaffold, settings, schema 0001`.

### Task 5: Devices API — sign-in bridge, permission deps, audit client

**Files:**
- Create: `devices/api/src/serversherpa_devices/auth/{main_api,deps}.py`
- Create: `devices/api/tests/test_auth_bridge.py`, `devices/api/tests/fake_main_api.py`

**Interfaces:**
- `@dataclass(frozen=True) class Principal`:
  - `person_id: uuid.UUID`, `display_name: str`, `client: Literal["portal","kiosk"]`;
  - `kiosk_serial: str | None`, `actions: frozenset[str]`;
  - `password_change_required: bool`, `read_only: bool`, `read_only_message: str | None`;
  - `def can(self, action: str) -> bool`.
- `class MainApiClient`:
  - `async def authorize(self, bearer: str) -> Principal | None`. It returns None on 401. It caches successes for `authorize_cache_seconds`, keyed by `sha256(bearer)`, and never caches failures. A 5xx or network error raises `MainApiUnavailable`.
  - `async def audit(self, *, actor: uuid.UUID | None, entity_type: str, entity_id: str, action: str, changes: dict, ip: str | None) -> None`. Failure is logged (class and status only) and never fails the request.
  - `get_main_api() -> MainApiClient` is the FastAPI dependency (overridable in tests).
- FastAPI deps (`auth/deps.py`):
  - `async def current_principal(request, ...) -> Principal`:
    - no bearer, or authorize returned None: 401 `{"code":"unauthenticated"}`;
    - `MainApiUnavailable`: 503 `{"code":"main_api_unavailable"}`.
  - `def require(action: str)`. It is a dependency factory for portal sessions:
    - a kiosk session gives 403 `kiosk_session`;
    - `password_change_required` gives 403 `password_change_required`;
    - a missing action gives 403 `forbidden`;
    - for a write method, `read_only` gives 423 `read_only_mode` with the message.
  - `async def kiosk_principal(...) -> Principal` accepts `client=="kiosk"` sessions, or portal sessions holding `view`.
  - `def client_ip(request) -> str | None`, the same X-Forwarded-For rule as the main API.

- [ ] **Step 1: Write the failing tests.** Use a respx-mocked main API in `fake_main_api.py` with helpers `as_staff()`, `as_admin()`, `as_kiosk()`, `revoked()`, mounted on a test-only route `/api/_whoami` registered in the test.
  - `test_missing_bearer_401`
  - `test_staff_view_ok_add_forbidden`
  - `test_kiosk_session_blocked_from_portal_routes`
  - `test_password_change_required_403`
  - `test_read_only_blocks_writes_not_reads`
  - `test_main_api_down_503`
  - `test_401_is_not_cached`
  - `test_cache_expires_after_ttl` (freeze the clock via injectable `time.monotonic`)
  - `test_service_token_header_sent`
  - `test_audit_failure_does_not_raise`
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_auth_bridge.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices): sign-in bridge to the main API, permission deps`.

### Task 6: Devices API — storage, secrets box, install-link tokens

**Files:**
- Create: `devices/api/src/serversherpa_devices/services/{storage,secrets,links}.py`
- Create: `devices/api/tests/test_storage.py`, `test_secrets.py`, `test_links.py`

**Interfaces:**
- `storage.py` is a port of the main API's `services/storage.py` subset. It keeps the `_client_lock` and `_preload_ca_bundle` TLS-segfault guard verbatim in behavior, citing the main API docstring.
  - `presign_put(key, content_type, size, expires=900) -> str`
  - `async head_object(key) -> dict | None`
  - `async download_to(key, path: Path)`
  - `async upload_from(path: Path, key, content_type)`
  - `async open_stream(key) -> AsyncIterator[bytes]` (chunks of 1 MiB, via `to_thread`)
  - `async delete_object(key)`
  - `async ensure_bucket()` (head_bucket, else create_bucket; called once at startup and logged, never fatal)
- `secrets.py`:
  - `def seal(data: bytes) -> bytes`
  - `def unseal(token: bytes) -> bytes`
  - Fernet keyed by `settings.secret_key`. `unseal` of tampered data raises `SecretError`.
- `links.py`:
  - `def make_install_token(*, kind: Literal["apk","manifest","ipa"], ref: uuid.UUID, ttl_seconds: int = 1800) -> str`
  - `def read_install_token(token: str, *, kind: str) -> uuid.UUID`, which raises `LinkError` when expired, the wrong kind, or tampered.
  - HS256 with key `HMAC(secret_key, b"devices-install-links")`, claims `{"k": kind, "r": str(ref), "exp": ...}`.

- [ ] **Step 1: Write the failing tests.**
  - `test_presign_put_signs_type_and_length`
  - `test_preload_ca_bundle_called_for_https` (mirror `api/tests/test_storage_tls_preload.py`)
  - `test_seal_round_trip`
  - `test_unseal_tampered_raises`
  - `test_link_round_trip`
  - `test_link_wrong_kind_raises`
  - `test_link_expired_raises`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices): storage, sealed secrets, install-link tokens`.

### Task 7: Package inspection — APK and IPA

**Files:**
- Create: `devices/api/src/serversherpa_devices/packages/{apk,ipa,cgbi,provision,versions}.py`
- Create: `devices/api/tests/test_apk.py`, `test_ipa.py`, `test_provision.py`, `test_versions.py`
- Create: `devices/api/tests/fixtures/README.md` and two fixture APKs: `hello-a.apk` (versionCode 1, signed with test key A) and `hello-a2.apk` (versionCode 2, key B). Build them once on the Mac with Android build-tools 36 `aapt2 link` plus `apksigner`, using Android Studio's bundled JBR (`/Applications/Android Studio.app/Contents/jbr`) and throwaway `keytool` keystores. The README records the exact commands. Each fixture is under 50 KB.
- IPA fixtures are built inside the tests:
  - a zip with `Payload/Hello.app/Info.plist` (binary plist), a CgBI icon made by the inverse of the decoder, and an `embedded.mobileprovision`;
  - the provision file is CMS-signed with a self-made certificate through `cryptography`'s `PKCS7SignatureBuilder`.

**Interfaces:**
- `@dataclass PackageInfo`:
  - `platform: Literal["android","ios"]`, `identifier: str`, `name: str`;
  - `version_name: str`, `build: str`, `build_sort: int`;
  - `min_os: str | None`, `icon_png: bytes | None`;
  - `signing_digest: str | None` (Android: lowercase SHA-256 hex of the v3, else v2, else v1 signer certificate DER);
  - `provision: ProvisionInfo | None`.
- `apk.inspect_apk(path: Path) -> PackageInfo` uses androguard `APK`. Call `loguru.logger.remove()` once at import. The icon comes from `get_app_icon(max_dpi=640)`; an XML (adaptive) icon is ignored, so the icon is None.
- `ipa.inspect_ipa(path: Path) -> PackageInfo`:
  - reads only `Payload/<X>.app/Info.plist`, exactly one level deep;
  - name: `CFBundleDisplayName`, falling back to `CFBundleName`;
  - icon: the largest `CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconFiles` match, decoded through `cgbi.decode`.
- `cgbi.decode(png: bytes) -> bytes` returns a normal PNG. Non-CgBI input is returned unchanged; unsupported formats give None.
- `@dataclass ProvisionInfo`: `kind: Literal["adhoc","development","enterprise","appstore"]`, `team_id`, `uuid`, `name`, `expires_at`, `devices: list[str]`, `entitlements: dict`.
- `provision.parse(raw: bytes) -> ProvisionInfo` uses asn1crypto `cms.ContentInfo` and plistlib, with the classification table from the spec research:
  - Ad Hoc: `ProvisionedDevices` present and `get-task-allow` false;
  - Development: `ProvisionedDevices` present and `get-task-allow` true;
  - Enterprise: `ProvisionsAllDevices`;
  - otherwise App Store.
- `versions.ios_build_sort(build: str) -> int` packs up to 4 dot-separated integers into 16 bits each. Non-numeric input raises `ValueError`.
- `PackageError(message: str)`: "This isn't an APK or IPA", "The IPA has no app inside Payload/", and so on.

- [ ] **Step 1: Write the failing tests.**
  - `test_apk_reads_identity_and_digest`: package, versionCode `"1"`, versionName, label, 64-hex digest.
  - `test_apk_two_keys_differ`
  - `test_ipa_reads_info_plist`
  - `test_ipa_ignores_extension_plists`
  - `test_cgbi_round_trip_matches_original_pixels`
  - `test_provision_classifies_adhoc_and_development`
  - `test_ipa_without_payload_raises`
  - `test_ios_build_sort_orders_1_10_after_1_9`
  - `test_garbage_file_raises_package_error`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices): APK/IPA inspection, CgBI icons, provisioning profiles`.

### Task 8: Catalog and upload API

**Files:**
- Create: `devices/api/src/serversherpa_devices/api/routes/{apps,uploads}.py`, `devices/api/src/serversherpa_devices/catalog.py`
- Create: `devices/api/tests/test_catalog_api.py`, `test_uploads_api.py`

**Interfaces** (all under `/api`; `require(...)` from Task 5):
- `GET /apps` (`view`) returns `[{id, platform, identifier, name, icon_url, current: VersionOut | None, ios_state: IosState | None}]`.
  - `ios_state` comes from Task 12's `install_state()`, so this task returns `None` until Task 12 fills it.
  - `icon_url` is `/api/apps/{id}/icon`.
- `GET /apps/{id}` (`view`) returns the app plus `versions: [VersionOut]`, newest `build_sort` first, without deleted versions.
  - `VersionOut = {id, version_name, build, notes, size, uploaded_at, uploaded_by_name, is_current}`
- `GET /apps/{id}/icon` (`view`) returns the PNG, `Cache-Control: private, max-age=3600`.
- `POST /uploads` (`add`) takes `{filename, size, content_type}` and returns `{upload_id, put_url, headers}`.
  - Key: `uploads/<uuid>/<sanitized filename>`.
  - Size limit 500 MB; above that, 413 "Files over 500 MB aren't accepted".
- `POST /uploads/{id}/inspect` (`add`) checks `head_object` (409 "The file didn't finish uploading"), downloads to a temp dir, runs Task 7, and validates. It stores and returns `InspectOut = {app: {exists: bool, id?, name, platform, identifier}, version_name, build, signing_digest?, min_os?, problems: [str]}`. Problems, with this exact copy:
  - same version and build exists: `"{version_name} ({build}) is already uploaded."`
  - `build_sort` ≤ the app's highest: `"Build {build} isn't newer than {cur_version} ({cur_build})."`
  - Android digest differs from `apps.signing_digest`: `"This APK is signed with a different key ({new12}…) than earlier versions ({old12}…). Phones would refuse it as an update."`
  - iOS and Apple settings empty: `"iPhone installs are set up on {ios_owner_url}."`, or when that is empty `"Apple settings aren't set up yet."`
- `POST /uploads/{id}/commit` (`add`) takes `{notes: str}`. It is 409 if there are problems or it was already committed. Otherwise:
  - it creates the app if new (setting `signing_digest` for Android) and moves the file to `apps/<app_id>/<version_id>/<filename>`;
  - it creates the version as current (clearing the old current) and stores the icon at `apps/<app_id>/icon.png`;
  - it audits `appdist_version`/`upload`;
  - for iOS it enqueues `ensure_bundle` then `sign_build`, through Task 11's `enqueue()`. Until Task 11 lands this is a stub, `catalog.enqueue = lambda *a, **k: None`, replaced in Task 11.
- `PATCH /versions/{id}` (`change`) takes `{notes}` and audits `edit_notes`.
- `POST /versions/{id}/make-current` (`change`) audits `make_current`. It does not touch older iOS signed builds; Task 11 signs on demand.
- `DELETE /versions/{id}` (`delete`) soft-deletes. The current version can't be deleted: 409 `"Make another version current first."` It audits `delete` and deletes the objects in the background.
- Cleanup: on each `POST /uploads`, uploads older than 24 h and never committed are deleted, both objects and rows.

- [ ] **Step 1: Write the failing tests**, using the Task 7 fixtures and a moto-free fake storage (monkeypatch `storage` functions to a temp dir).
  - `test_upload_requires_add` (staff gets 403)
  - `test_inspect_then_commit_creates_app_and_current_version`
  - `test_commit_rejects_duplicate_and_older_build`
  - `test_inspect_rejects_new_signing_key` (`hello-a` then `hello-a2`; the message contains both 12-character prefixes)
  - `test_ios_upload_refused_when_not_owner` (both copies)
  - `test_make_current_switches_and_audits`
  - `test_cannot_delete_current`
  - `test_list_hides_deleted_versions`
  - `test_stale_uploads_are_purged`
  - `test_read_only_blocks_commit`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices): app catalog, uploads with inspection and review`.

### Task 9: Apple settings API and App Store Connect client

**Files:**
- Create: `devices/api/src/serversherpa_devices/apple/{asc,settings}.py`, `devices/api/src/serversherpa_devices/api/routes/apple.py`
- Create: `devices/api/tests/fake_asc.py`, `test_asc_client.py`, `test_apple_settings_api.py`

**Interfaces:**
- `class AscClient(team_key_id: str, issuer_id: str, p8_pem: bytes, *, http: httpx.AsyncClient | None = None)`. Base URL `https://api.appstoreconnect.apple.com/v1`.
  - The JWT is ES256 with header `kid`, claims `iss`, `iat`, `exp=iat+1200` and `aud="appstoreconnect-v1"`. It is reused until 60 s before expiry.
  - Methods:
    - `find_device(udid) -> AscDevice | None` (`GET /devices?filter[udid]=`)
    - `register_device(name, udid) -> AscDevice` (`POST /devices`, `platform="IOS"`)
    - `set_device_status(id, "ENABLED"|"DISABLED") -> AscDevice`
    - `list_devices() -> list[AscDevice]` (follows `links.next`, `limit=200`)
    - `find_bundle_id(identifier) -> str | None` (exact match on the client side)
    - `create_bundle_id(identifier, name) -> str`
    - `find_certificate_by_serial(serial_hex) -> AscCertificate | None` (types `DISTRIBUTION`/`IOS_DISTRIBUTION`; compare serials uppercase with leading zeros stripped)
    - `list_profiles(name) -> list[AscProfile]`
    - `delete_profile(id)`
    - `create_adhoc_profile(name, bundle_id_res, cert_id, device_ids) -> AscProfile` (`profileType="IOS_APP_ADHOC"`; returns the decoded `profileContent` bytes)
  - `AscError(status, code, detail)`; a 429 raises `AscRateLimited`.
  - `AscDevice = {id, udid, name, device_class, status, model}`; `AscProfile = {id, uuid, name, content: bytes, expires_at}`.
- `GET /apple` (`change`) returns `{configured: bool, team_id, key_id, issuer_id, cert_name, cert_expires_at, profiles: [{app_name, expires_at}], ios_owner_url}`. It never returns secrets.
- `PUT /apple` (`change`) is multipart: `team_id, issuer_id, key_id, p8 (file), p12 (file), p12_password`. Every part is required on first save; on later saves an omitted file keeps the stored one. Steps:
  1. Load the p12 with `cryptography.hazmat.primitives.serialization.pkcs12.load_key_and_certificates`. A wrong password gives 422 `"The certificate password is wrong."`
  2. Check the certificate common name starts with `"Apple Distribution"` or `"iPhone Distribution"`, else 422.
  3. Make a live check call `find_certificate_by_serial`. On a 401/403 from Apple, 422 `"Apple refused the API key: {detail}"`. If the certificate isn't found, 422 `"Apple doesn't list this certificate on team {team}."`
  4. Seal and save, and audit `appdist_apple`/`update` with no secret values in `changes`.
- `DELETE /apple` (`change`) clears the row and audits it. It takes a confirm body `{confirm: "clear"}`.

- [ ] **Step 1: Write the failing tests.** `fake_asc.py` is a respx router holding in-memory devices, bundle ids, certificates and profiles, which also asserts the bearer JWT decodes with the test key.
  - `test_jwt_claims_and_header`
  - `test_register_then_find_device`
  - `test_list_devices_follows_next`
  - `test_create_profile_returns_decoded_content`
  - `test_429_raises_rate_limited`
  - `test_put_apple_rejects_wrong_password`
  - `test_put_apple_rejects_development_cert`
  - `test_put_apple_saves_sealed_and_never_returns_secrets` (the GET JSON has no `p8`/`p12` keys, and the raw DB bytes differ from the input)
  - `test_staff_cannot_read_apple_settings`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices): Apple settings + App Store Connect client`.

### Task 10: iPhone enrollment (profile service)

**Files:**
- Create: `devices/api/src/serversherpa_devices/api/routes/enroll.py`, `devices/api/src/serversherpa_devices/enroll.py`
- Create: `devices/api/tests/test_enroll.py`

**Interfaces:**
- `POST /api/enroll` (`view`) takes `{device_name: str}` (1–60 characters, required) and returns `{url: "/enroll/<token>.mobileconfig"}`.
  - The token is 32 random URL-safe bytes; only its SHA-256 is stored. It lasts 15 minutes and is single use.
- `GET /enroll/{token}.mobileconfig` takes no auth (Safari hands it to Settings).
  - An unknown, expired or used token gives 410 with a plain HTML page: "This link has expired. Go back to Devices and tap Add this iPhone again."
  - Otherwise it returns the Profile Service plist:
    - `URL` = `{public_url}/enroll/{token}/callback`;
    - `DeviceAttributes` = `UDID, PRODUCT, VERSION, SERIAL, DEVICE_NAME`;
    - `Challenge` = token;
    - `PayloadDisplayName` "ServerSherpa Devices — add this iPhone";
    - `PayloadOrganization` "ServerSherpa";
    - `PayloadIdentifier` "com.serversherpa.devices.enroll";
    - a fresh `PayloadUUID`.
  - Response: `Content-Type: application/x-apple-aspen-config`, `Content-Disposition: attachment; filename="add-this-iphone.mobileconfig"`, `Cache-Control: no-store`.
- `POST /enroll/{token}/callback` takes no auth.
  - It parses the body with asn1crypto, without verifying the signature, and requires `UDID`. If the plist has a `CHALLENGE`, it must equal the token.
  - It upserts `ios_devices` by udid:
    - new: `status="pending"`, with `added_by`/`name` from the token;
    - existing and disabled: status set to `pending`;
    - existing and registered: name, product and os updated, status kept.
  - It marks the token used, enqueues `register_device {device_id}`, and audits `appdist_device`/`add`.
  - It replies `301 Location: {public_url}/?added=<device_ref>`. `device_ref` is the device row id; it is not secret, but it is not the UDID.
- No UDID ever appears in a URL or a log.

- [ ] **Step 1: Write the failing tests**, building a callback body with a self-signed CMS around a plist.
  - `test_mobileconfig_contents_and_headers`
  - `test_mobileconfig_expired_token_410`
  - `test_callback_creates_pending_device_and_job`
  - `test_callback_same_udid_reuses_device`
  - `test_callback_reenables_disabled_device_as_pending`
  - `test_callback_rejects_used_token`
  - `test_callback_rejects_wrong_challenge`
  - `test_redirect_has_no_udid`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices): add-this-iPhone profile service`.

### Task 11: Worker — jobs, Apple registration, profiles, re-signing

**Files:**
- Create: `devices/api/src/serversherpa_devices/worker/{queue,run,jobs}.py`, `devices/api/src/serversherpa_devices/signing/{resign,entitlements}.py`
- Modify: `devices/api/src/serversherpa_devices/cli.py` (`devices worker [--once] [--poll-seconds 2.0] [--reload]`), and `catalog.py` (replace the enqueue stub)
- Create: `devices/api/tests/test_queue.py`, `test_jobs.py`, `test_resign.py`
- Create: `devices/api/tests/test_resign_integration.py`. It is marked `signer` and skipped unless `rcodesign` is on PATH and `clang` exists: it compiles a 1-line arm64 Mach-O into a fixture `.app`.

**Interfaces:**
- `queue.py` follows `api/src/serversherpa/wiki/worker.py`:
  - `async def enqueue(db, kind, payload) -> Job`
  - `claim_next(db) -> Job | None` (SKIP LOCKED, backoff `30 * 2**(attempts-1)` s)
  - `MAX_ATTEMPTS = 3`, `STALE_MINUTES = 30`
  - `requeue_stale(db)`
  - `run_once()` and `run_forever(poll_seconds)`
  - `AscRateLimited` re-queues the job without counting an attempt.
- `enqueue(db, "rebuild_profiles", {})` is coalesced: it is a no-op when a `rebuild_profiles` job is already queued (not running).
- Job handlers (`jobs.py`):
  - **`register_device {device_id}`:**
    - `find_device`; if absent, `register_device`; if DISABLED, `set_device_status(ENABLED)`.
    - Save `asc_device_id`, `device_class` and `status="registered"`, then enqueue `rebuild_profiles`.
    - An `AscError` sets `status="failed"` with `error = "Apple refused this iPhone: {detail}"` and stops retrying for 409s.
  - **`disable_device {device_id}`:** `set_device_status(DISABLED)`, `status="disabled"`, enqueue `rebuild_profiles`.
  - **`ensure_bundle {app_id}`:** `find_bundle_id` or `create_bundle_id(identifier, name)`, then save `asc_bundle_id`.
  - **`rebuild_profiles {}`:** for each iOS app with a current version and `asc_bundle_id`:
    - delete every profile named exactly `ServerSherpa Devices · <bundle id>`;
    - create a new one with all `registered` devices and the settings' `asc_certificate_id`;
    - save `ios_profiles`;
    - enqueue `sign_build {version_id: current}`.
    - With zero registered devices it skips creating a profile and leaves state `no_devices`.
  - **`sign_build {version_id}`:**
    - Skip if the version is deleted. Upsert the `signed_builds(version, profile_uuid)` row to `running`.
    - Download the original, unzip into a temp dir, and copy the profile to `Payload/X.app/embedded.mobileprovision`.
    - Compute entitlements (below), run `resign.sign_app(...)`, zip `Payload` (with `-y` symlink semantics through `zipfile` + `ZipInfo` external attrs).
    - Upload to `apps/<app>/<version>/signed/<profile_uuid>.ipa`, then mark the row `ready`. Failure marks it `failed` with `error`.
  - **`sync_devices {}`:** `list_devices()`, then upsert `apple_device_counts` by `device_class` (ENABLED plus DISABLED both count).
- `entitlements.for_profile(binary_ents: dict, profile: ProvisionInfo, *, bundle_id: str) -> dict`:
  - Start from the binary's entitlements (from `rcodesign print-signature-info`, the `entitlements_plist` field).
  - Force `get-task-allow=False`.
  - Set `application-identifier=f"{team}.{bundle_id}"` and `com.apple.developer.team-identifier=team`.
  - Drop any key not allowed by `profile.entitlements`. A wildcard profile value (`TEAM.*`) allows any concrete value with that prefix.
  - `aps-environment`, when present, becomes `"production"`.
- `resign.sign_app(app_dir: Path, *, p12: bytes, password: str, entitlements: dict) -> None` writes temp files with mode 0600, runs `rcodesign sign --p12-file … --p12-password-file … -e <ents.plist> <app_dir>`, and deletes the temp files in `finally`.
  - Nested appex bundles get `-e PlugIns/<X>.appex:<file>` computed the same way.
  - A non-zero exit raises `SignError(stderr_tail)`. The tail is the last 20 lines with the p12 path stripped.
- `catalog.enqueue` now points at `queue.enqueue`. The `sign_build` for an older version is enqueued on demand by Task 12.

- [ ] **Step 1: Write the failing tests** (`fake_asc` from Task 9; `resign.sign_app` monkeypatched in `test_jobs.py`):
  - `test_claim_skips_locked_and_backs_off`
  - `test_rate_limited_requeues_without_attempt`
  - `test_register_new_device_then_rebuild_enqueued`
  - `test_register_existing_apple_device_skips_post`
  - `test_register_conflict_marks_failed_with_reason`
  - `test_rebuild_is_coalesced`
  - `test_rebuild_only_deletes_named_profiles` (a profile named "Xcode Managed" survives)
  - `test_rebuild_includes_all_registered_devices`
  - `test_sign_build_marks_ready_and_uploads`
  - `test_sign_build_failure_records_error`
  - `test_entitlements_drop_unallowed_and_force_get_task_allow_false`
  - `test_entitlements_wildcard_keychain_group`
  - `test_temp_secret_files_removed_on_failure`
  - Integration: `test_rcodesign_signs_fixture_app`, which checks the signature info shows the test certificate's team and our entitlements.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_queue.py tests/test_jobs.py tests/test_resign.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, plus `PATH=$PATH:$HOME/.local/bin .venv/bin/pytest -m signer -v` if rcodesign is installed locally. Expected: PASS, or the integration test SKIPPED with its reason.
- [ ] **Step 5: Commit** `feat(devices): worker, Apple registration, Ad Hoc profiles, IPA re-signing`.

### Task 12: Install links, page install state, kiosk update endpoint

**Files:**
- Create: `devices/api/src/serversherpa_devices/api/routes/{install,updates}.py`, `devices/api/src/serversherpa_devices/install_state.py`
- Create: `devices/api/tests/test_install.py`, `test_updates.py`

**Interfaces:**
- `install_state.ios_state(db, app, device_ref: uuid.UUID | None) -> IosState`. `IosState = {state, message, install_url?}`. The states, with this exact copy:
  - `not_set_up`: the Task 8 owner messages.
  - `register_first`: `"This iPhone isn't registered."` (no device_ref, or unknown).
  - `registering`: `"Registering this iPhone with Apple…"` (pending).
  - `failed`: the device `error`.
  - `disabled`: `"This iPhone was removed from Devices."`
  - `preparing`: `"Preparing the app for this iPhone…"` (no ready signed build for the current version and current profile; also enqueues `sign_build` when there is no row).
  - `ready`: has `install_url`.
- `GET /api/apps?device_ref=` fills `ios_state` (Task 8's field).
- `POST /api/apps/{id}/install` (`view`) takes `{version_id?, device_ref?}` and returns `{url}`:
  - Android: `{public_url}/dl/<token>/<app-name>-<version>.apk`
  - iOS: `itms-services://?action=download-manifest&url=<urlencoded {public_url}/ota/<token>/manifest.plist>`. For an older version it may answer 202 `{state:"preparing"}` after enqueueing `sign_build`.
- `GET /dl/{token}/{filename}` takes no auth; the token is enough. It streams the APK with `application/vnd.android.package-archive`, `Content-Disposition: attachment; filename=…` and `Content-Length`.
- `GET /ota/{token}/manifest.plist` takes no auth.
  - It returns `text/xml` with a `software-package` URL `{public_url}/ota/<ipa token>/app.ipa`, `display-image` and `full-size-image` (`/ota/<token>/icon-57.png`, `icon-512.png`, resized with Pillow), and metadata `bundle-identifier`, `bundle-version` (version_name), `kind` `software`, `title`.
  - `/ota/{token}/app.ipa` streams `application/octet-stream`.
- `GET /api/updates` uses `kiosk_principal`.
  - Query: `platform=android&package=&version_code=&signing_digest=`, or `platform=ios&bundle_id=&build=&profile_kind=adhoc|development|none`.
  - Response: `{status, version_name?, build?, notes?, size?, install_url?, message?}`. Statuses:
    - `up_to_date`: current `build_sort` ≤ the installed one, or the app is unknown.
    - `available`: has `install_url`.
    - `reinstall_required` (Android digest mismatch): message `"This copy came from Google Play. Uninstall it and install from {public_url} once to get updates."`
    - `register_first` (iOS `profile_kind != "adhoc"`): message `"Add this iPhone on {public_url} first."`
    - `preparing`: iOS, no ready signed build.
    - `not_set_up`: iOS on a non-owner stack.
  - It never offers a build lower than the installed one.

- [ ] **Step 1: Write the failing tests.**
  - `test_android_install_link_streams_apk_with_headers`
  - `test_install_token_expired_410`
  - `test_ios_states_walk` (register_first → registering → preparing → ready)
  - `test_manifest_plist_fields`
  - `test_ipa_stream_uses_signed_build`
  - `test_older_version_install_enqueues_sign`
  - `test_updates_android_available`
  - `test_updates_android_up_to_date_never_downgrades`
  - `test_updates_android_digest_mismatch`
  - `test_updates_ios_development_profile_register_first`
  - `test_updates_ios_not_owner`
  - `test_updates_requires_session`
  - `test_portal_staff_can_call_updates`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then the full suite with `.venv/bin/pytest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices): install links, OTA manifest, kiosk update endpoint`.

### Task 13: Devices web — scaffold, sign-in, shell

**Files:**
- Create: `devices/web/package.json`. Same deps and versions as `learn/package.json`, minus `bwip-js`/`gsap` unless the guard test needs them through `@portal` imports (add them back if the reachability test says so). Port 5180.
- Create: `devices/web/{vite.config.ts,dedupe.ts,tsconfig.json}`, `devices/web/web/index.html`, `devices/web/web/src/{main,Root,App}.tsx`.
  - `vite.config.ts` copies learn's settings: `@portal` alias, `publicDir ../../portal/public`, `allowedHosts`, wss HMR when `SS_PUBLIC_HTTPS`.
  - Plus `server.proxy` for `/api`, `/enroll`, `/ota` and `/dl` to `http://localhost:8099`.
  - `host: true` and `strictPort`.
- Create: `devices/web/web/src/{auth/RequireAccess.tsx,layout/DevicesShell.tsx,layout/devicesNav.tsx,layout/DevicesTopbar.tsx,components/ErrorBoundary.tsx,lib/devicesApi.ts,lib/platform.ts,styles/devices.css}`
- Create: `devices/web/web/src/portalImports.test.ts`, a copy of learn's with its own allowlist: learn's list plus `components/StandardModal`, `components/hardware/RowActionsMenu`, `components/DataTable`, `components/FileDropzone`, `lib/qr`.
- Create: `devices/web/web/src/{App.test.tsx,lib/platform.test.ts,lib/devicesApi.test.ts}`

**Interfaces:**
- Root nests: `ErrorBoundary > SystemStatusProvider > AuthProvider > NotificationsProvider > BrowserRouter > App` (the wiki's wiring).
- App routes:
  - `/login` renders `<Login eyebrow="Devices" />` from `@portal/pages/Login`;
  - `*` renders `<RequireAccess><ThemedRoot><DevicesShell/></ThemedRoot></RequireAccess>`, with child routes `/` (Apps), `/apps/:id`, `/devices`, `/apple`.
  - `ThemedRoot` calls `applyPreferences(preferences)`, as the wiki does, so it follows the user's theme.
- `RequireAccess`:
  - `loading` renders null; `anon` navigates to `/login` with `from`;
  - `mustChangePassword` shows the wiki's notice with a portal link;
  - `!can('app_distribution','view')` shows "You don't have access to Devices" with a Back to portal link.
- Nav, one section "Devices":
  - Apps (`/`)
  - Devices (`/devices`)
  - Apple settings (`/apple`, only when `can('app_distribution','change')`)
  - `NavPanel` tag `"Devices"`; the chip menu (Back to portal, Sign out) is copied from LearnShell.
  - The shell does not hard-code `data-nav-mode`: it uses the user's `nav_mode` preference (`expanded` or `rail` on desktop, overlay under 900 px).
- `devicesApi.ts`:
  - `async function devicesFetch(path: string, init?: RequestInit): Promise<Response>` adds `Authorization: Bearer ${await accessTokenForService()}` (Task 3) to same-origin `/api…`. On a 401 it calls `refreshSession()` once and retries.
  - It parses errors into the portal `ApiError` (`errorFrom`).
- `platform.ts`: `type ViewerPlatform = 'android' | 'ios' | 'desktop'` and `function viewerPlatform(nav = navigator): ViewerPlatform`. iPadOS's Macintosh user agent with `maxTouchPoints > 1` counts as `ios`.
- `devices.css` sets the body background through the theme tokens (no hard-coded light color) and imports the portal scrollbar styling used by `.portal-shell`.

- [ ] **Step 1: Write the failing tests.**
  - App: `/login` renders the portal Login (mocked); a staff `can` mock reaches the shell; no view permission shows the no-access copy; Apple settings is hidden for staff.
  - `viewerPlatform`: an Android user agent gives `android`; an iPhone gives `ios`; iPad desktop-mode gives `ios`; a Mac gives `desktop`.
  - `devicesFetch`: it sends the bearer and retries once after a 401.
  - `portalImports`: green.
- [ ] **Step 2: Run** `cd devices/web && npm install && npx vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc -p tsconfig.json --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices-web): scaffold, portal sign-in, shell`.

### Task 14: Devices web — Apps page, app detail, upload modal

**Files:**
- Create: `devices/web/web/src/pages/{AppsPage,AppDetailPage}.tsx`, `devices/web/web/src/components/{AppCard,UploadModal,InstallButton,DesktopQr}.tsx`
- Create: the matching tests `*.test.tsx`

**Interfaces / behavior** (spec "Pages", with the copy fixed there and in Tasks 8 and 12):
- **AppsPage:**
  - It lists `GET /api/apps?device_ref=<localStorage devices.iosDeviceRef>`. Storage access is wrapped in try/catch.
  - On load with `?added=<ref>` it stores the ref, removes the query param, and polls `/api/apps` every 5 s while any iOS card is `registering` or `preparing`, stopping after 10 minutes.
  - The page head has an **Upload** button for `can('app_distribution','add')`.
  - An admin-only banner shows when a certificate or profile expires in ≤ 30 days (from `GET /api/apple`; staff never call it).
- **AppCard:**
  - icon, name and platform;
  - `version_name (build)`;
  - "Uploaded YYYY-MM-DD by Name";
  - "What's new" notes;
  - a `CollapsePanel`-style "Previous versions" toggle linking to the detail page.
- **InstallButton**, by `viewerPlatform()`:
  - **Android card on Android:** an **Install** button (`POST …/install`, then `location.href = url`), with the hint "Got it from Google Play? Uninstall it first."
  - **iOS card on iOS:** the `ios_state` message, plus:
    - `register_first`: **Add this iPhone**, which opens a `StandardModal` (eyebrow "Devices", title "Add this iPhone", one required field "Name this iPhone") with three steps of copy:
      1. "Tap Continue, then Allow."
      2. "Open Settings, tap Profile Downloaded, then Install."
      3. "You'll come back here automatically."
      - It also says "iOS shows the profile as Not Verified; that's expected."
      - Continue calls `POST /api/enroll`, then `location.href = url`.
    - `ready`: **Install**.
    - `registering`/`preparing`: a disabled **Preparing…**.
  - **Wrong platform, or desktop:** no install button. A `DesktopQr` (`qrDataUrl(location.href)`) says "Open this page on the phone to install."
- **AppDetailPage:**
  - The header shows name, platform and identifier.
  - The versions list is a `DataTable`: Version, Build, Uploaded, By, Size, Notes, Current chip (`chip c-green` "Current"), and actions.
  - Actions use `RowActionsMenu`:
    - **Install** (when the platform matches);
    - **Make current** (`change`; review modal "Make 0.1.0 (1) current? New installs get this version. Phones that already have a newer version keep it.");
    - **Edit notes** (`change`);
    - **Delete** (`delete`; review modal naming the version; disabled on current, with the hint "Make another version current first").
- **UploadModal** (`add`):
  1. `StandardModal` eyebrow "Devices", title "Upload a version", with a `FileDropzone accept=".apk,.ipa"`.
  2. It POSTs `/api/uploads`, PUTs to `put_url` with progress (`XMLHttpRequest`), then calls inspect.
  3. It shows the review summary: "New app" or the existing app name, version, build, signing certificate (first 12 characters), and each problem in `.pf-error`.
  4. Release notes go in a textarea; **Save** is disabled while there are problems.
  5. Commit closes and refreshes. The footer buttons are always visible.
- Dates and times use 24-hour formatting via the portal format helpers.

- [ ] **Step 1: Write the failing tests** (fetch stubbed):
  - `AppsPage stores ?added ref and polls until ready`
  - `Android card on Android shows Install + Play hint`
  - `iOS register_first opens Add this iPhone modal and requires a name`
  - `desktop shows QR and no install button`
  - `staff see no Upload button`
  - `UploadModal blocks Save when inspect reports problems`
  - `UploadModal commit refreshes the list`
  - `Delete action disabled on current version`
  - `Make current shows review then calls the endpoint`
- [ ] **Step 2: Run** `npx vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc -p tsconfig.json --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices-web): apps, versions, upload with review`.

### Task 15: Devices web — Devices page and Apple settings

**Files:**
- Create: `devices/web/web/src/pages/{DevicesPage,AppleSettingsPage}.tsx` plus tests
- Modify: `devices/api/src/serversherpa_devices/api/routes/` by adding `devices.py`:
  - `GET /api/devices` (`view`): `{devices:[…], counts:[{device_class, count, synced_at}]}`. It enqueues `sync_devices` when `synced_at` is more than 1 minute old and Apple is configured.
  - `POST /api/devices/{id}/disable` (`delete`): enqueues `disable_device` and audits `appdist_device`/`disable`.
  - Tests go in `devices/api/tests/test_devices_api.py`: `test_list_devices_and_counts`, `test_disable_requires_delete`, `test_disable_enqueues_and_audits`, `test_sync_enqueued_when_stale`.

**Behavior:**
- **DevicesPage:**
  - Above the list: a count line per class, e.g. "iPhone 7 of 100 this membership year", with "Last checked HH:MM".
  - The list is a `DataTable`: Name, Model (`product`), iOS, Added by, Added, Status chip (pending amber, registered green, failed red with the error in the row, disabled slate).
  - Actions ▾ has **Disable** (`delete`). Its review modal says: "Disable {name}? It can no longer install or update apps. Apple won't free its slot until the membership renews."
- **AppleSettingsPage** (`change`):
  - It opens with the notice "Only one environment may hold these settings. iPhone installs on every other environment point here."
  - A `.pf-form` holds: Team ID, Issuer ID, Key ID, API key (.p8) file, Distribution certificate (.p12) file, Certificate password.
  - Once saved, it shows the certificate name and expiry, the key ID, and "Replace" file pickers. Nothing secret is shown.
  - **Clear settings** opens a review modal. On confirm it sends `{confirm:"clear"}`.
  - It shows `ios_owner_url` when set.

- [ ] **Step 1: Write the failing tests** (API and web):
  - `counts line renders`
  - `Disable shows review copy`
  - `staff see no Disable`
  - `Apple form requires all parts on first save`
  - `after save shows cert name and no secret fields`
  - `Clear requires confirm`
- [ ] **Step 2: Run** the API and web tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices): devices list, disable, Apple settings page`.

### Task 16: Container image and deploy stack

**Files:**
- Create: `devices/Dockerfile` (build context is the repo root):
  - Stage `node:20-alpine` builds `devices/web` with `portal/src` and `portal/public` copied in.
  - Final stage `python:3.13-slim`:
    - downloads the `apple-codesign-0.29.0-<arch>-unknown-linux-musl.tar.gz` release, verifies it against the release's SHA256SUMS (pinned in a build ARG), and installs it to `/usr/local/bin/rcodesign`;
    - `pip install devices/api`;
    - static files go to `/app/static`;
    - runs as uid 10001, `EXPOSE 8080`, with a `/healthz` HEALTHCHECK.
- Create: `devices/docker-entrypoint.sh`:
  - `serve`: `alembic upgrade head` then `uvicorn --factory serversherpa_devices.api.app:create_app --host 0.0.0.0 --port 8080 --proxy-headers --forwarded-allow-ips=$FORWARDED_ALLOW_IPS`;
  - `worker`: `exec devices worker`.
- Create: `deploy/stack/devices/compose.yml`:
  - name `ss-${STACK_ENV}-devices`, network `ss-${STACK_ENV}` (external);
  - services `devices` (port `${STACK_BIND_IP:-0.0.0.0}:${STACK_DEVICES_PORT:-8093}:8080`) and `devices-worker` (same image, command `worker`);
  - shared env:
    - `DEVICES_DATABASE_URL` → `serversherpa_devices` on `postgres`;
    - `DEVICES_MAIN_API_URL: http://api:8000`;
    - `DEVICES_SERVICE_TOKEN: ${SS_DEVICES_SERVICE_TOKEN:?}`;
    - `DEVICES_SECRET_KEY: ${DEVICES_SECRET_KEY:?}`;
    - `DEVICES_PUBLIC_URL: https://devices.${STACK_DOMAIN}`;
    - `DEVICES_IOS_OWNER_URL: ${DEVICES_IOS_OWNER_URL:-}`;
    - `DEVICES_SPACES_*` defaulting like the api stack, with bucket `serversherpa-devices`;
  - healthchecks, `restart: unless-stopped`.
- Modify: `deploy/stack/build.yml` (devices image), `deploy/stack/env.example` (`STACK_DEVICES_PORT=8093`, `SS_DEVICES_SERVICE_TOKEN=CHANGEME`, `DEVICES_SECRET_KEY=CHANGEME`, commented `DEVICES_IOS_OWNER_URL`)
- Modify: `deploy/stack/api/compose.yml`:
  - `SS_DEVICES_SERVICE_TOKEN`;
  - `SS_DEVICES_ORIGIN: https://devices.${STACK_DOMAIN}`;
  - the devices origin added to `SS_ALLOWED_ORIGINS`;
  - a `devices` extra_host.
- Modify: `deploy/stack/ss-stack`:
  - `check_apps` accepts `devices`;
  - `STACKS` gains `devices` after `web`;
  - before `dc devices up`, an idempotent `CREATE DATABASE serversherpa_devices` through `pg_local` (or the external-DB client when `STACK_EXTERNAL_DATA=1`);
  - `dc devices down` when the app is off;
  - `down` walks it in reverse.
  - It also creates the `serversherpa-devices` bucket on seaweedfs: the service's `ensure_bucket` on startup covers it, so the script does nothing extra.
- Modify: `deploy/stack/proxy/Caddyfile` (`@devices host devices.{$STACK_DOMAIN}` → `reverse_proxy @devices devices:8080 { header_up X-Forwarded-For {client_ip} }`)
- Modify: `deploy/stack/README.md` (stack table row, the devices env keys, NPM host note)
- Modify: `deploy/tests/test_stack_config.py`:
  - `STACKS`, `PUBLIC`, default ports (`"devices":[8093]`), built images (`serversherpa-devices:local`);
  - the Caddyfile route;
  - `SS_ALLOWED_ORIGINS` includes devices;
  - required secrets.
- Modify: `deploy/tests/test_ss_stack.py` (up order includes devices; the devices database is created; `STACK_APPS=wiki` skips devices)
- Create: `deploy/tests/test_devices_image.py` (marker `images`). It checks that `rcodesign --version` prints `0.29.0` and that `devices --help` runs in the image. No database is started.

- [ ] **Step 1: Write the failing deploy tests** listed above.
- [ ] **Step 2: Run** `api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the deploy tests, then `docker build -f devices/Dockerfile -t serversherpa-devices:pytest . && api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests/test_devices_image.py -m images -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): devices stack, image with rcodesign, ss-stack wiring`.

### Task 17: Dev bring-up and live check

**Files:**
- Modify: `.claude/launch.json`. Add `devices-api` (`devices/api/.venv/bin/uvicorn --factory serversherpa_devices.api.app:create_app --app-dir devices/api/src --host 0.0.0.0 --port 8099 --reload`, port 8099) and `devices-web` (`npm --prefix devices/web run dev`, port 5180). The file has the user's uncommitted edits: back it up first and add only these two entries.
- Modify: `Procfile.dev` (`devicesapi`, `deviceswork`, `devicesweb`)
- Create: `devices/.env.example`. It holds only key names and dev defaults: `DEVICES_DATABASE_URL` using the dev Postgres, `DEVICES_MAIN_API_URL=http://localhost:8000`, `DEVICES_PUBLIC_URL=https://devices.dev.serversherpa.com`, and the MinIO endpoint and bucket. No real secrets.
- Modify: the repo-root `.env.example` (`SS_DEVICES_SERVICE_TOKEN`, `SS_DEVICES_ORIGIN`)

- [ ] **Step 1: Prepare dev.**
  - Run `scripts/devices-dev-db.sh`.
  - Create `devices/.env` from the example. Generate `DEVICES_SECRET_KEY` with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` and a random service token.
  - Add the same token to the root `.env` as `SS_DEVICES_SERVICE_TOKEN`.
  - Do **not** restart the shared dev API or workers yourself. Tell the controller the dev API needs a restart to pick up the token and Task 1's migration. The controller asks Jimmy.
- [ ] **Step 2: Start** `devices-api` and `devices-web` through `preview_start`, and start the worker (`devices/api/.venv/bin/devices worker --reload`) in the background.
- [ ] **Step 3: Verify without signing in.**
  - `curl -s localhost:8099/healthz` gives ok.
  - `curl -s -o /dev/null -w '%{http_code}' localhost:8099/api/apps` gives 401.
  - `localhost:5180/login` renders the portal sign-in with the eyebrow "Devices" (read_page).
  - No console errors.
- [ ] **Step 4: Report.** The steps that need Jimmy are:
  - add the NPM proxy host `devices.dev.serversherpa.com` → 5180;
  - restart the dev API;
  - sign in and upload the kiosk APK on an Android phone;
  - iOS end to end, after the paid Apple account and the certificate and API key exist.
- [ ] **Step 5: Commit** `chore(devices): dev launch entries and env examples`.

---

## Self-review notes

- **Spec coverage:**
  - sign-in and permissions: T1, T2, T5, T13
  - catalog, versions and upload review: T8, T14
  - adding an iPhone: T10, T14
  - Apple automation and re-signing: T9, T11
  - install over the air: T12
  - Devices page and counts: T15
  - Apple settings, secrets, single owner: T6, T8, T9, T15
  - expiry banner: T14
  - audit: T2, T5, T8–T10, T15
  - kiosk update contract: T12
  - portal link: T3
  - deploy: T16
  - dev: T17
  - The Android and iOS app changes are deferred to their own plans, stated in the header.
- **Known limits to report at the end:**
  - iOS can't be tested against Apple until the paid membership exists;
  - the `.mobileconfig` is unsigned, so iOS shows "Not Verified";
  - Profile Service on iOS 26 and `DEVICE_NAME` are unconfirmed, so the name is asked for in the modal;
  - `ss-stack dump`/`restore` don't cover `serversherpa_devices` yet (a follow-up).
