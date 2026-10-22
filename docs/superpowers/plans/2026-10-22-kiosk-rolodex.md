# Kiosk Rolodex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rolodex in the iOS and Android kiosk apps for admins (rank 60+): an A–Z worker list by last name with photos, a worker page to edit details and retake the photo, and a New worker flow with a required photo, backed by new `/kiosk/rolodex/*` API routes.

**Architecture:** New person-session-only API routes in `api/routes/kiosk_rolodex.py` reuse the portal's worker-edit and avatar logic (extracted into shared helpers, no behavior change). Each app adds pure logic (sorting, sections, search, crop math) with unit tests, API client calls, an admin-only Home tile, the list/worker page screens with a tablet split view, and a photo capture + crop + upload flow.

**Tech Stack:** FastAPI + SQLAlchemy async + pytest (API); Kotlin + Jetpack Compose + CameraX + OkHttp + kotlinx.serialization + Room + JUnit4/Robolectric (Android); SwiftUI + AVFoundation + PhotosUI + SwiftData + Swift Testing (iOS).

**Spec:** `docs/superpowers/specs/2026-10-22-kiosk-rolodex-design.md` (read §2–§4 before any task). Code maps with exact files, lines, helpers and commands: `.superpowers/rolodex-recon/api.md`, `android.md`, `ios.md` in this worktree (git-ignored; read the one for your platform before starting).

**Order:** Tasks 1–4 (API) run first, in order. Then the Android track (Tasks 5–7) and the iOS track (Tasks 8–10) touch disjoint folders and may run in parallel in separate worktrees branched from the Task 4 commit; each track runs in order.

## Global Constraints

- All copy is American English; use the exact strings in spec §3 and §4.2.
- No migration (Alembic head stays `0105`). People created here use `source="manual"`, `source_ref="kiosk-rolodex:<kiosk serial or 'unknown'>"`.
- Android: add no new libraries; don't bump `coreKtx`, `lifecycle` or `activityCompose`; no material-icons (use the app's `lineIcon` style). iOS: no third-party packages; new Swift file basenames must be unique within the target.
- The cached list and every list payload never contain email or phone.
- Photo output: 512×512 JPEG, quality 0.92 (Android `92`), painted white first, EXIF orientation applied. Zoom 1×–4× over cover-fit.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.env`, `.venv`, `.superpowers`, `node_modules`, `local.properties`. If a test run modifies `api/src/serversherpa/_dev_reload.py`, restore it with `git checkout -- api/src/serversherpa/_dev_reload.py`.
- API tests: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_rolodex .venv/bin/pytest <files> -q` in the foreground (the worktree has `api/.venv`, `.env`, `api/.env` symlinks). Never touch the dev database or a printer.

### The API contract (every task uses these exact names)

All routes: prefix `/kiosk/rolodex`, JSON snake_case, errors `{"detail": {"code": ...}}`.

| Route | Request | Response |
|---|---|---|
| `GET /workers` | — | `{generated_at, workers: [Row]}` |
| `GET /workers/{person_id}` | — | `Detail` |
| `GET /options` | — | `{levels: [{level, title, color}], statuses: [{key, label, color}], partners: [{id, name}]}` |
| `POST /duplicates` | `{first_name, last_name, preferred_name?, email?, phone?}` | `{matches: [Match]}` |
| `POST /workers` | `CreateIn` | 201 `Detail` |
| `PATCH /workers/{person_id}` | `PatchIn` | 200 `Detail` |
| `PUT /workers/{person_id}/photo` | raw `image/jpeg` body | `{photo_url, photo_version}` |

- `Row`: `person_id` (uuid string), `first_name`, `last_name`, `preferred_name|null`, `display_name`, `job_title|null`, `company: {id, name}|null`, `trade|null`, `level|null`, `level_color|null`, `status`, `status_label`, `status_color|null`, `has_photo`, `photo_url|null`, `photo_version|null`, `rfid_enrolled`, `has_account`.
- `Detail` = `Row` + `email|null`, `phone|null`, `external_id|null`, `status_note|null`, `can_edit`, `can_change_status`, `edit_block_reason: "rank_too_low"|null`, `status_block_reason: "self"|"rank_too_low"|null`.
- `Match`: `person_id`, `display_name`, `job_title|null`, `company|null` (name string), `is_worker`, `has_account`, `photo_url|null`, `photo_version|null`, `matched_on: ["name"|"email"|"phone", …]`.
- `CreateIn`: `first_name`*, `last_name`* (stripped, min 1), `preferred_name`, `job_title`, `phone`, `email`, `partner_id`, `trade`, `level`, `allow_duplicate` (bool, default false), `photo_skipped` (bool, default false). `extra="forbid"`.
- `PatchIn`: any of `first_name`, `last_name`, `preferred_name`, `job_title`, `phone`, `email`, `partner_id`, `trade`, `level`, `status`, `status_note`; absent = unchanged, `null` = clear (`null` on first/last name → 422 `first_name_required` / `last_name_required`). `extra="forbid"`.
- Error codes the apps map (spec §4.2): `forbidden` (403), `move_locked` (403), `person_not_found` (404), `possible_duplicate` (409), `email_in_use` (409), `rank_too_low` (403), `cannot_target_self` (403), `blacklist_requires_note` (422), `unknown_level` / `partner_not_found` / `partner_archived` / `unknown_status` (422), `read_only_mode` (423), `file_too_large` (413), `length_required` (411), `empty_file` / `invalid_file_type` / `unreadable_image` / `image_too_large` (422).

### Shared client logic (Android and iOS mirror it exactly)

- **Fold:** lowercase, strip diacritics (`Núñez` → `nunez`), drop characters that aren't letters or digits inside a word (`O'Brien` → `obrien`).
- **Sort:** by folded `last_name`, then folded `first_name`, then `person_id`.
- **Section letter:** the first character of the folded `last_name` if it is `a`–`z` (uppercased), else `#`. `de la Cruz` → `D`; `Ñúñez` → `N`; `3M Crew` → `#`.
- **Search:** split the query on whitespace; drop empty terms; every term (folded) must be a prefix of at least one word of the haystack. Haystack words = the whitespace- and hyphen-split words of `first_name`, `last_name`, `preferred_name`, `job_title`, `company.name`, each folded. `obr` matches `O'Brien`; `cruz` matches `de la Cruz`; `nunez` matches `Núñez`; `rig sum` matches `Rigger · Summit Crew`. An empty query matches everyone.
- **Filters:** `all`; one per status key from `/options`; `no_photo` (`has_photo == false`). Counts are taken over the search-filtered list.
- **Crop math** (viewport is a square of side `V`, image `w×h`, zoom `z` clamped to [1, 4], offset `(dx, dy)` = image center minus viewport center in viewport points):
  - `scale = max(V/w, V/h) * z`
  - clamp: `|dx| ≤ (w*scale − V)/2`, `|dy| ≤ (h*scale − V)/2`
  - source square side `S = V/scale`; `srcX = w/2 − dx/scale − S/2`; `srcY = h/2 − dy/scale − S/2`
  - Pinned vectors: `(w=1000,h=500,V=300,z=1,dx=0,dy=0)` → src `(250, 0, 500, 500)`; clamp of `(1000,500,300,1, dx=400, dy=50)` → `(150, 0)`; `(1000,500,300,z=2,0,0)` → src `(375, 125, 250, 250)`; `z=7` clamps to `4`.

## Review Focus

1. Names with accents, apostrophes, particles or digits (Núñez, O'Brien, de la Cruz, 3M Crew) must sort, section and search as the fold rules say. Tests: Task 5 and Task 8 logic tests use exactly these names.
2. Huge, rotated or transparent library images (a 48 MP photo, EXIF orientation 6, a PNG with alpha) must become an upright 512×512 JPEG on white under 5 MiB, never an upload error. Tests: Task 7 and Task 10 renderer tests.
3. A double tap on Create worker or Save changes must send one request. Tests: Task 6/7 and Task 9/10 view-model tests ("second submit while saving is ignored").
4. A failed save (no connection, 423, 409) keeps everything the admin typed and shows the error. Tests: Task 6 and Task 9 view-model tests.
5. The photo upload failing after the worker was created opens the worker page with "<Name> was saved, but the photo didn't upload." and Try again. Tests: Task 7 and Task 10 flow tests.

---

### Task 1: Shared worker-edit and avatar helpers (API refactor, no behavior change)

**Files:**
- Create: `api/src/serversherpa/api/worker_edits.py`
- Modify: `api/src/serversherpa/api/routes/workers.py` (`update_worker_person` ~347-394, `upsert_profile` ~431-529), `api/src/serversherpa/api/routes/attachments.py` (avatar branch ~216-247)
- Test: `api/tests/test_worker_edits.py`

**Interfaces:**
- Produces:
  - `async def target_rank(db, person_id: UUID) -> int` (max active role rank, 0 if none)
  - `async def apply_person_update(db, actor: AuthContext, person: Person, data: dict) -> dict` — rank guard for account-holders other than self (403 `rank_too_low`), `{field}_required` for null first/last name (and `country` as today), setattr, `updated_at`, audit `person/update` (extra keys merged into `changes` via `audit_extra: dict | None = None` keyword), **no commit**; returns the changes dict.
  - `async def apply_profile_update(db, actor: AuthContext, person_id: UUID, data: dict, *, audit_extra: dict | None = None) -> dict` — the whole body of today's `upsert_profile` up to (not including) the commit, same codes (`status_required`, `rank_too_low`, `cannot_target_self`, `blacklist_requires_note`, `unknown_level`, `partner_not_found`, `unknown_status`) and the blacklist/login coupling.
  - `apply_person_update` takes the same `audit_extra` keyword.
  - In `attachments.py`: `async def replace_avatar(db, *, entity_type: str, entity, key: str, filename: str, content_type: str, size: int, actor_id: UUID, now: datetime, audit_extra: dict | None = None) -> Attachment` (retires old avatar rows, sets `avatar_key`/`updated_at`, adds the row, audits `attachment.add`; no commit).

- [ ] **Step 1:** Write `api/tests/test_worker_edits.py`: `test_apply_person_update_changes_and_audits` (changes dict has `{"job_title": {"from": "Mover", "to": "Rigger"}}`, one `AuditLog` with `entity_type="person"`, `action="update"`, and `changes["via"] == "kiosk_rolodex"` when `audit_extra={"via": "kiosk_rolodex"}`), `test_apply_person_update_refuses_untouchable_account` (target with an admin account, actor admin → 403 `rank_too_low`), `test_apply_profile_update_blacklist_needs_note` (422 `blacklist_requires_note`), `test_apply_profile_update_blacklist_disables_login` (account `disabled_at` set, sessions revoked), `test_nothing_committed` (after `apply_*` and `db.rollback()`, the row is unchanged), `test_replace_avatar_retires_old_row`.
- [ ] **Step 2:** Run them; expect import errors.
- [ ] **Step 3:** Implement `worker_edits.py` by moving the inline logic out of the two routes; the routes become guard → `apply_*` → commit (keep their IntegrityError → 409 `email_in_use` mapping and 204 responses). Extract `replace_avatar` and call it from `POST /attachments`.
- [ ] **Step 4:** Run the new tests plus the regression set: `tests/test_worker_edits.py tests/test_workers.py tests/test_workers_detail_api.py tests/test_workers_bulk_import_api.py tests/test_attachments_visibility.py tests/test_settings_branding.py` (skip `tests/test_attachments.py` only if it fails for lack of a reachable MinIO; say so in the report). Expected: all pass.
- [ ] **Step 5:** Commit `refactor(workers): shared person, profile and avatar edit helpers`.

### Task 2: Rolodex read routes: gates, list, detail, options

**Files:**
- Create: `api/src/serversherpa/api/routes/kiosk_rolodex.py`, `api/tests/test_kiosk_rolodex_api.py`
- Modify: `api/src/serversherpa/api/app.py` (import + `include_router` after `kiosk.router`), `api/src/serversherpa/api/schemas.py` (new `# ── kiosk rolodex ──` section: `KioskRolodexCompany`, `KioskRolodexWorkerOut`, `KioskRolodexListOut`, `KioskRolodexWorkerDetailOut`, `KioskRolodexLevelOut`, `KioskRolodexStatusOut`, `KioskRolodexOptionsOut`)

**Interfaces:**
- Consumes: Task 1 `target_rank`.
- Produces (in `kiosk_rolodex.py`, used by Tasks 3–4): `router`; dependency `rolodex_actor(actor) -> AuthContext` (kiosk:view + `require_rank(GATE_BYPASS_RANK)` + `is_global` → 403 `forbidden`; `session.initiative_id` set → 403 `move_locked`); `async def require_rolodex_worker(db, actor, person_id) -> Person` (404 `person_not_found` for missing, archived, `source="kiosk_move"`, no active worker role, or out of `workers` scope); `async def worker_detail(db, actor, person) -> KioskRolodexWorkerDetailOut`; `def photo_version(avatar_key: str | None) -> str | None` (first 16 hex of sha256).

- [ ] **Step 1:** Write tests (kiosk-session helper: create Person + UserAccount + role, then `POST /auth/login {client: "kiosk"}`; see recon api.md §7): `test_admin_kiosk_session_lists_workers_by_last_name` (three workers `Zed Adams`, `Amy Zane`, `Bo Núñez` come back Adams, Núñez, Zane), `test_list_has_no_email_or_phone` (keys of a row equal the Row field set exactly), `test_staff_and_worker_sessions_are_refused` (staff 403 `forbidden`, worker 403), `test_move_password_session_is_refused`, `test_station_key_is_refused` (`Authorization: Station …` → 401/403, never 200), `test_archived_and_move_identity_are_hidden` (absent from the list; detail 404 `person_not_found`), `test_detail_flags` (an account-less worker: `can_edit` true, `can_change_status` true; a super admin target seen by an admin: `can_edit` false, `edit_block_reason "rank_too_low"`; the actor's own row: `can_change_status` false, `status_block_reason "self"`), `test_photo_version_changes_with_key`, `test_options` (levels L1–L6 in rank order, statuses active/standby/blacklist, archived partners excluded), `test_list_works_in_read_only_mode` (GET 200 after `PUT /system/admin {"read_only": true}`).
- [ ] **Step 2:** Run; expect 404s.
- [ ] **Step 3:** Implement the router, dependencies and the three GET routes using the `list_workers` query and scope filter (recon api.md §2), `status_fields`/`level_fields` for labels and colors, `presign_get` for `photo_url`.
- [ ] **Step 4:** Run the file; all pass. Also `tests/test_kiosk_session_scope.py`.
- [ ] **Step 5:** Commit `feat(kiosk): Rolodex list, worker and options routes for admins`.

### Task 3: Rolodex writes: duplicates, create, edit

**Files:**
- Modify: `api/src/serversherpa/api/routes/kiosk_rolodex.py`, `api/src/serversherpa/api/schemas.py` (`KioskRolodexDuplicatesIn`, `KioskRolodexMatchOut`, `KioskRolodexDuplicatesOut`, `KioskRolodexCreateIn`, `KioskRolodexPatchIn`)
- Test: `api/tests/test_kiosk_rolodex_api.py`

**Interfaces:**
- Consumes: Task 1 `apply_person_update`, `apply_profile_update`; Task 2 `rolodex_actor`, `require_rolodex_worker`, `worker_detail`.
- Produces: `async def find_duplicates(db, *, first_name, last_name, preferred_name=None, email=None, phone=None) -> list[KioskRolodexMatchOut]` (reuse `people/bulk_import.name_keys` and `normalize_phone`; non-archived people, excluding `kiosk_move`).

- [ ] **Step 1:** Write tests: `test_duplicates_by_name_email_phone` (a staff person "Ana Ortiz" matches `{first_name:"ana", last_name:" ORTIZ "}` with `matched_on == ["name"]`, `is_worker False`; same email → `matched_on` includes `"email"`; `(312) 555-0142` vs `312.555.0142` → `"phone"`), `test_create_makes_a_time_clock_worker` (201; Person `source="manual"`, `source_ref` starts `kiosk-rolodex:`; active `worker` PersonRole; WorkerProfile `status="active"`; appears in `GET /kiosk/sync/people` with `is_worker true`, `has_account false`; one `person/create` audit with `changes["via"] == "kiosk_rolodex"` and `changes["photo_skipped"] == {"from": None, "to": True}` when sent), `test_create_refuses_possible_duplicate` (409 `possible_duplicate`; with `allow_duplicate: true` → 201), `test_create_email_in_use` (409 `email_in_use`), `test_create_validation` (`level: "L9"` → 422 `unknown_level`; archived partner → 422 `partner_archived`; blank first name `"  "` → 422), `test_patch_person_and_profile_in_one_transaction` (`{"job_title":"Rigger","level":"L9"}` → 422 `unknown_level` and job title unchanged), `test_patch_clears_with_null` (`{"phone": null}` clears), `test_patch_rules` (`rank_too_low` for a super admin target; `cannot_target_self` on own status; `blacklist_requires_note`; blacklisting an account holder disables their login), `test_writes_frozen_in_read_only_mode` (POST/PATCH → 423 `read_only_mode`), `test_patch_returns_detail`.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement `POST /duplicates`, `POST /workers` (one transaction: Person, PersonRole worker, WorkerProfile, audit with `via`, `device` = `actor.session.kiosk_serial`, `photo_skipped`; duplicate check unless `allow_duplicate`; email pre-check; partner must exist and not be archived for a new link) and `PATCH /workers/{id}` (split the body into person fields and profile fields; `apply_person_update` then `apply_profile_update` with `audit_extra`; one commit; email pre-check; return `worker_detail`).
- [ ] **Step 4:** Run the file plus `tests/test_workers.py tests/test_kiosk_sync_api.py`; all pass.
- [ ] **Step 5:** Commit `feat(kiosk): Rolodex duplicates, create and edit`.

### Task 4: Rolodex photo upload

**Files:**
- Modify: `api/src/serversherpa/api/routes/kiosk_rolodex.py`, `api/src/serversherpa/api/schemas.py` (`KioskRolodexPhotoOut`)
- Test: `api/tests/test_kiosk_rolodex_api.py`

**Interfaces:**
- Consumes: Task 1 `replace_avatar`; Task 2 helpers; `labels.image_prep.probe`; `services.storage.put_object/delete_object/presign_get`; `attachments._sniff_image`, `MAX_IMAGE_BYTES`.
- Produces: `PUT /kiosk/rolodex/workers/{person_id}/photo` → `KioskRolodexPhotoOut {photo_url, photo_version}`.

- [ ] **Step 1:** Write tests with a fake storage fixture patched on the new module (model: `tests/test_settings_branding.py` `store`): `test_photo_replaces_avatar` (key matches `attachments/person/<id>/avatar/<32 hex>.jpg`; old Attachment soft-deleted; `person.avatar_key` repointed; `photo_version` equals the Task 2 function of the new key; audit `attachment.add` with `via`), `test_photo_rejects_non_jpeg` (a PNG → 422 `invalid_file_type`), `test_photo_rejects_empty_and_huge` (0 bytes → 422 `empty_file`; Content-Length over 5 MiB → 413 `file_too_large` without reading the body), `test_photo_needs_content_length` (411 `length_required`), `test_photo_unreadable` (JPEG magic + garbage → 422 `unreadable_image`), `test_photo_rank_rule` (a super admin target → 403 `rank_too_low`; your own photo → 200), `test_photo_deletes_new_object_when_db_fails` (force the commit to raise; `delete_object` called with the new key), `test_photo_frozen_in_read_only_mode` (423), `test_photo_needs_attachments_add` (a role without `attachments:add` → 403 `forbidden`).
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement: auth dependencies first (no body parameters), Content-Length check, stream `request.stream()` with a running cap (pattern: `api/routes/router_agent.py` ~30-41), sniff JPEG, `probe` in a thread, `put_object`, `replace_avatar(..., filename="kiosk-photo.jpg", audit_extra={"via": "kiosk_rolodex", "device": serial})`, commit; on failure rollback + best-effort `delete_object(new_key)` and re-raise.
- [ ] **Step 4:** Run the whole `tests/test_kiosk_rolodex_api.py` and `tests/test_attachments_visibility.py`; all pass.
- [ ] **Step 5:** Commit `feat(kiosk): Rolodex photo upload`.

### Task 5: Android Rolodex logic, models and API client

**Files (base `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/` = `K/`, tests `app/src/test/java/com/serversherpa/kiosk/` = `T/`):**
- Create: `K/core/model/Rolodex.kt`, `K/core/people/Rolodex.kt`, `K/core/photo/Crop.kt`, `T/core/people/RolodexTest.kt`, `T/core/photo/CropTest.kt`, `T/data/api/OkHttpKioskApiRolodexTest.kt`
- Modify: `K/data/api/KioskApi.kt`, `K/data/api/OkHttpKioskApi.kt`, `T/data/FakeKioskApi.kt`

**Interfaces:**
- Produces (Kotlin, `@Serializable`, snake_case JSON as in the contract): `RolodexCompany`, `RolodexRow`, `RolodexList`, `RolodexDetail`, `RolodexLevel`, `RolodexStatus`, `RolodexPartner`, `RolodexOptions`, `RolodexDuplicatesIn`, `RolodexMatch`, `RolodexCreateIn`, `RolodexPhotoOut`.
- `KioskApi` additions: `suspend fun rolodexWorkers(): RolodexList`, `suspend fun rolodexWorker(personId: String): RolodexDetail`, `suspend fun rolodexOptions(): RolodexOptions`, `suspend fun rolodexDuplicates(body: RolodexDuplicatesIn): List<RolodexMatch>`, `suspend fun rolodexCreate(body: RolodexCreateIn): RolodexDetail`, `suspend fun rolodexUpdate(personId: String, patch: JsonObject): RolodexDetail`, `suspend fun rolodexPhoto(personId: String, jpeg: ByteArray): RolodexPhotoOut` (raw `image/jpeg` PUT body, replayable `ByteArray.toRequestBody`).
- `core/people/Rolodex.kt`: `fun fold(s: String?): String`, `fun sortRows(rows: List<RolodexRow>): List<RolodexRow>`, `fun sectionLetter(lastName: String): String`, `fun sections(rows: List<RolodexRow>): List<Pair<String, List<RolodexRow>>>`, `fun matches(row: RolodexRow, query: String): Boolean`, `fun applyFilter(rows: List<RolodexRow>, filter: String): List<RolodexRow>` (`"all"`, a status key, `"no_photo"`), `fun filterCounts(rows: List<RolodexRow>, statusKeys: List<String>): Map<String, Int>`, `fun buildPatch(original: RolodexDetail, edited: RolodexEdit): JsonObject` (only changed fields; cleared → `JsonNull`), `data class RolodexEdit(...)` (the editable fields), `fun validate(edit: RolodexEdit): String?` (copy: "First and last name are required." / "Add a note to blacklist someone.").
- `core/photo/Crop.kt`: `object Crop { const val OUTPUT_PX = 512; const val JPEG_QUALITY = 92; const val MIN_ZOOM = 1f; const val MAX_ZOOM = 4f; fun clampZoom(z: Float): Float; fun scale(w: Float, h: Float, v: Float, z: Float): Float; fun clampOffset(w: Float, h: Float, v: Float, z: Float, dx: Float, dy: Float): Pair<Float, Float>; fun sourceRect(w: Float, h: Float, v: Float, z: Float, dx: Float, dy: Float): FloatArray /* x, y, side, side */ }`.

- [ ] **Step 1:** Write tests: `RolodexTest` with the Review Focus names (`Núñez` sorts and sections under `N`, `O'Brien` found by `obr`, `de la Cruz` under `D` and found by `cruz`, `3M Crew` under `#`, `rig sum` finds a Rigger at Summit Crew, empty query matches all), filters/counts (`no_photo`), `buildPatch` (unchanged → `{}`; cleared phone → `{"phone": null}`; changed level only → `{"level":"L4"}`), `validate`; `CropTest` with the four pinned vectors from Global Constraints; `OkHttpKioskApiRolodexTest` (MockWebServer `ApiHarness`: each path and method, the PATCH body keeps explicit nulls, the photo PUT sends `Content-Type: image/jpeg` and the exact bytes, a 409 body maps to the existing API error with `code == "possible_duplicate"`).
- [ ] **Step 2:** Run `JAVA_HOME=<Android Studio jbr> ./gradlew testDebugUnitTest --tests '*Rolodex*' --tests '*Crop*'` (exact env in recon android.md §5); expect compile failures.
- [ ] **Step 3:** Implement the models, logic and client calls; add every call to `FakeKioskApi` as overridable lambdas.
- [ ] **Step 4:** Run the full `./gradlew testDebugUnitTest`; all pass.
- [ ] **Step 5:** Commit `feat(android): Rolodex models, list logic, crop math and API calls`.

### Task 6: Android Rolodex screens: tile, list, worker page, edit, offline

**Files:**
- Create: `K/ui/guards/AdminGate.kt`, `K/ui/screens/rolodex/RolodexScreen.kt`, `RolodexViewModel.kt`, `RolodexList.kt`, `WorkerPage.kt`, `WorkerAvatar.kt`; tests `T/ui/screens/rolodex/RolodexViewModelTest.kt`, `T/ui/screens/rolodex/RolodexScreenTest.kt`
- Modify: `K/core/features/Features.kt` (`FeatureId.ROLODEX`, `ROLODEX_FEATURE` kept out of `FEATURES`, `homeFeatures(stationType, isAdmin)` adds it only for the full Home and `isAdmin`), `K/ui/screens/home/FeatureIcons.kt`, `K/ui/screens/home/HomeScreen.kt`, `K/ui/Routes.kt` (`ROLODEX = "rolodex"`), `K/ui/KioskApp.kt`, `K/ui/shell/KioskShell.kt` (a `scroll: Boolean = true` parameter; keep the `// INTERNET-TEST` lines), `K/app/AppContainer.kt` (clear the `rolodex` meta row in `logout()` and `resetApp()`), tests `T/core/features/FeaturesTest.kt`, `T/ui/guards/GuardsTest.kt`, `HomeScreenTest`

**Interfaces:**
- Consumes: Task 5 everything; the Time Clock `loadPhoto()` fetch (reuse, never copy); `db.meta()`.
- Produces: `RolodexViewModel` with `state: StateFlow<RolodexUi>` (`rows`, `query`, `filter`, `counts`, `selectedId`, `detail`, `editing: RolodexEdit?`, `saving`, `offline: Boolean`, `cachedAt: Instant?`, `error: String?`, `options`), and functions `load()`, `refresh()`, `setQuery(String)`, `setFilter(String)`, `select(String?)`, `startEdit()`, `cancelEdit()`, `updateEdit(RolodexEdit)`, `save()`, `errorText(code: String?): String`; `WorkerAvatar(row/photo, size)` composable with an in-memory `LruCache` keyed by `"$personId:$photoVersion"`. Task 7 adds photo and create functions to this view model.

- [ ] **Step 1:** Write tests: `FeaturesTest` (`homeFeatures(null, isAdmin = true)` contains ROLODEX; `isAdmin = false` doesn't; a Time Clock station Home never does), `GuardsTest` (non-admin route → Home), `RolodexViewModelTest` (load success caches the list in meta without email/phone; load failure with a cache → `offline = true` with `cachedAt`; save sends `buildPatch`; **a second `save()` while saving sends one request**; **a failed save keeps `editing` and sets `error` to the spec copy** for `network`, `read_only_mode`, `email_in_use`, `rank_too_low`, `cannot_target_self`; `can_edit=false` makes `startEdit()` a no-op), `RolodexScreenTest` (Robolectric `w360dp-h800dp`: list only, tap → worker page full screen with "‹ Rolodex"; `w1280dp-h800dp-land`: list and worker page side by side; offline banner text "Offline · showing the list from …"), `HomeScreenTest` (admin sees the Rolodex tile; staff doesn't).
- [ ] **Step 2:** Run them; expect failures.
- [ ] **Step 3:** Implement per spec §4.2–§4.3 and the mockups (`docs/superpowers/specs/2026-10-22-kiosk-rolodex-mockups/2-list-chosen.html`, `4-photo-required-and-worker-page.html`): `BoxWithConstraints` split at 600dp (list 360dp), `LazyColumn` with `stickyHeader` sections, right-edge jump strip, search field (plain `TextField`, not `ScanInput`), filter chips with counts, status chips from `status_color`, worker page cards, Edit form (company picker from `/options` + None, level picker + none, trade text, status `Segmented` with a required note when the Blacklist key is chosen), disabled states with the spec's reasons, writes under `NonCancellable`. After a save, upsert the person into `db.people()` keeping `rfid_tag`/`badge_uid`.
- [ ] **Step 4:** Run `./gradlew testDebugUnitTest assembleDebug`; all pass.
- [ ] **Step 5:** Commit `feat(android): Rolodex list and worker page for admins`.

### Task 7: Android photo capture, crop, upload and New worker flow

**Files:**
- Create: `K/input/camera/PhotoCaptureSheet.kt`, `K/ui/screens/rolodex/PhotoCropScreen.kt`, `K/ui/screens/rolodex/PhotoRender.kt`, `K/ui/screens/rolodex/NewWorkerFlow.kt`; tests `T/ui/screens/rolodex/PhotoRenderTest.kt`, `T/ui/screens/rolodex/NewWorkerFlowTest.kt`
- Modify: `RolodexViewModel.kt`, `WorkerPage.kt` (camera badge + photo sheet), `RolodexViewModelTest.kt`

**Interfaces:**
- Consumes: Task 5 `Crop`, `rolodexDuplicates/rolodexCreate/rolodexPhoto`; Task 6 view model.
- Produces: `fun renderCrop(source: Bitmap, v: Float, z: Float, dx: Float, dy: Float): ByteArray` (512×512 JPEG q92 on white) and `fun decodeForCrop(context, uri or bytes, maxSide = 2048): Bitmap` (EXIF applied via `ImageDecoder`, downsampled); view-model additions `uploadPhoto(personId, jpeg)`, `newWorker` state machine (`Details → DuplicateSheet? → Photo → Crop → Creating → Done | PhotoFailed`), `checkDuplicates()`, `create(photo: ByteArray?, photoSkipped: Boolean, allowDuplicate: Boolean)`.

- [ ] **Step 1:** Write tests: `PhotoRenderTest` (Robolectric: a 4000×3000 source renders 512×512 and under 5 MiB; a transparent PNG renders white where transparent; an EXIF-6 JPEG decodes upright), `NewWorkerFlowTest` (Next runs duplicates; a worker match offers Open and Create anyway; a non-worker match shows "Already in the portal, not a worker. Add the worker role there." with no Open; an email match blocks Create anyway with "That email belongs to <name>. Change or clear the email."; "Continue without photo" → confirmation → create with `photo_skipped = true`; **double tap on Create sends one POST**; **upload failing after create** → worker page state with "<Name> was saved, but the photo didn't upload." and a retry that calls `rolodexPhoto` again; a 409 `possible_duplicate` on create re-runs duplicates and shows the sheet), `RolodexViewModelTest` additions (photo upload refreshes the row's `photo_version`; `can_edit=false` disables the photo action).
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement per spec §4.2 and mockups `3-new-worker.html`, `4-photo-required-and-worker-page.html`: CameraX `Preview` + `ImageCapture` on the back camera with Flip, circle guide, Library via `PickVisualMedia`, permission flow and insets as in `CameraScanSheet`; devices without a camera (`hasCamera`) get Library only; crop screen with drag, pinch and a Slider (1–4), "Drag to move · pinch or slide to zoom", Retake / Use photo; New worker details form (Step 1 of 2), duplicate sheet, photo step with the "Continue without photo" link and its confirmation dialog (default button Take photo), then Create worker. A denied camera permission shows "Camera access is off. Turn it on in Settings, or choose a photo instead." with Choose photo. After a create, upsert the person into `db.people()` so the Time Clock finds them.
- [ ] **Step 4:** Run `./gradlew testDebugUnitTest assembleDebug`; all pass.
- [ ] **Step 5:** Commit `feat(android): Rolodex photos and New worker flow`.

### Task 8: iOS Rolodex logic, models and API client

**Files (base `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/` = `I/`; tests folder per recon ios.md §6 = `TESTS/`):**
- Create: `I/Core/Rolodex/RolodexModels.swift`, `I/Core/Rolodex/RolodexLogic.swift`, `I/Core/Rolodex/PhotoCropMath.swift`, `TESTS/RolodexLogicTests.swift`, `TESTS/PhotoCropMathTests.swift`, `TESTS/RolodexApiTests.swift` (if the target has an API harness; else cover encoding in the logic tests)
- Modify: `I/Data/Api/KioskApi.swift`, `I/Data/Api/URLSessionKioskApi.swift`, `TESTS/Support/FakeKioskApi.swift`

**Interfaces:**
- Produces (Swift `Codable`, snake_case keys as in the contract): `RolodexCompany`, `RolodexRow`, `RolodexList`, `RolodexDetail`, `RolodexLevel`, `RolodexStatus`, `RolodexPartner`, `RolodexOptions`, `RolodexDuplicatesIn`, `RolodexMatch`, `RolodexCreateIn`, `RolodexPatch` (hand-written `encode(to:)` that writes `null` for cleared fields and omits unchanged ones), `RolodexPhotoOut`.
- `KioskApi` additions: `func rolodexWorkers() async throws -> RolodexList`, `func rolodexWorker(id: String) async throws -> RolodexDetail`, `func rolodexOptions() async throws -> RolodexOptions`, `func rolodexDuplicates(_ body: RolodexDuplicatesIn) async throws -> [RolodexMatch]`, `func rolodexCreate(_ body: RolodexCreateIn) async throws -> RolodexDetail`, `func rolodexUpdate(id: String, patch: RolodexPatch) async throws -> RolodexDetail`, `func rolodexPhoto(id: String, jpeg: Data) async throws -> RolodexPhotoOut` (raw body through the authed helper, `Content-Type: image/jpeg`).
- `RolodexLogic` (Foundation only): `static func fold(_:) -> String`, `sortRows(_:)`, `sectionLetter(lastName:)`, `sections(_:) -> [(String, [RolodexRow])]`, `matches(_:query:)`, `applyFilter(_:filter:)`, `filterCounts(_:statusKeys:)`, `buildPatch(original:edited:) -> RolodexPatch`, `struct RolodexEdit`, `validate(_:) -> String?` — same behavior and copy as Android Task 5.
- `PhotoCropMath` (Foundation only, `Double`): `outputPx = 512`, `jpegQuality = 0.92`, `minZoom = 1`, `maxZoom = 4`, `clampZoom`, `scale(w:h:v:z:)`, `clampOffset(w:h:v:z:dx:dy:) -> (Double, Double)`, `sourceRect(w:h:v:z:dx:dy:) -> CGRect`-free tuple `(x, y, side)`.

- [ ] **Step 1:** Write Swift Testing tests mirroring Task 5's cases exactly (same names, same pinned crop vectors, `RolodexPatch` encodes `{"phone":null}` for a cleared phone and `{}` when nothing changed).
- [ ] **Step 2:** Run the unit tests with the recon ios.md §6 `xcodebuild test` command (iPad Air simulator); expect failures.
- [ ] **Step 3:** Implement; add every call to `FakeKioskApi`.
- [ ] **Step 4:** Run the tests; all pass.
- [ ] **Step 5:** Commit `feat(ios): Rolodex models, list logic, crop math and API calls`.

### Task 9: iOS Rolodex screens: tile, list, worker page, edit, offline

**Files:**
- Create: `I/UI/Screens/Rolodex/RolodexView.swift`, `RolodexModel.swift` (`@MainActor @Observable`), `RolodexListView.swift`, `RolodexWorkerView.swift`, `RolodexAvatar.swift`; tests `TESTS/RolodexModelTests.swift`
- Modify: `I/Core/Features.swift` (`FeatureId.rolodex`, `ROLODEX_FEATURE` out of `FEATURES`, `homeFeatures(stationType:isAdmin:)` with `isAdmin` defaulting to false, `feature(_:)` finds it), `I/UI/Routes.swift` (`Route.rolodex`, `Route.rolodexWorker(String)`; extend every exhaustive switch), `I/UI/RootView.swift`, `I/UI/Shell/KioskShell.swift` (title), `I/UI/Screens/Home/HomeScreen.swift`, `I/UI/Screens/Home/FeatureIcons.swift`, `I/App/AppContainer.swift` (clear the `rolodex` MetaRecord in `onLogout`, `onSessionEnded`, `resetApp()`), existing Features/Home tests

**Interfaces:**
- Consumes: Task 8 everything; `api.fetchImage`.
- Produces: `RolodexModel` with `rows`, `query`, `filter`, `counts`, `selectedId`, `detail`, `editing: RolodexEdit?`, `saving`, `offline`, `cachedAt`, `errorText`, `options`, and `load()`, `refresh()`, `select(_:)`, `startEdit()`, `cancelEdit()`, `save()`, `static func errorText(code:) -> String`; `RolodexAvatar` with an in-memory cache keyed by `personId + photoVersion`. Task 10 extends the model.

- [ ] **Step 1:** Write tests: Features (`homeFeatures(stationType: nil, isAdmin: true)` contains `.rolodex`, false doesn't, a Time Clock station never does; `feature(.rolodex)` doesn't trap), `RolodexModelTests` (offline cache without email/phone; offline fallback with `cachedAt`; **second `save()` while saving sends one request**; **failed save keeps `editing` and sets the spec copy**; `canEdit == false` blocks `startEdit()`).
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement per spec §4.2, §4.4 and the mockups: side-by-side split when the horizontal size class is regular and width ≥ 700pt (list 360pt), phone pushes `Route.rolodexWorker` with its own "‹ Rolodex" back, `List` sections with a jump strip, a plain styled `TextField` for search (not `ScanInput`), chips, worker page cards, Edit form and disabled states. After a save, upsert the `PersonRecord` keeping `rfidTag`/`badgeUid`.
- [ ] **Step 4:** Run the unit tests and the iPhone 16 build (recon ios.md §6 commands); all pass.
- [ ] **Step 5:** Commit `feat(ios): Rolodex list and worker page for admins`.

### Task 10: iOS photo capture, crop, upload and New worker flow

**Files:**
- Create: `I/Input/Camera/PhotoCamera.swift` (AVCapturePhotoOutput, back camera default, flip), `I/UI/Screens/Rolodex/PhotoCaptureView.swift`, `PhotoCropView.swift`, `PhotoRenderer.swift` (UIKit; `UIGraphicsImageRendererFormat.scale = 1`, opaque, white fill; ImageIO downsample with transform), `NewWorkerFlowView.swift`; tests `TESTS/PhotoRendererTests.swift`, `TESTS/NewWorkerFlowTests.swift`
- Modify: `RolodexModel.swift`, `RolodexWorkerView.swift`, `ServerSherpa Kiosk.xcodeproj/project.pbxproj` (`INFOPLIST_KEY_NSCameraUsageDescription` = "The camera scans barcodes and takes worker photos." in Debug and Release)

**Interfaces:**
- Consumes: Task 8 `PhotoCropMath`, API calls; Task 9 model.
- Produces: `PhotoRenderer.render(_ image: CGImage, v:z:dx:dy:) -> Data` (512×512 JPEG 0.92), `PhotoRenderer.load(data: Data, maxSide: Int = 2048) -> CGImage?` (orientation applied); model additions mirroring Android Task 7 (`uploadPhoto`, new-worker stages, `checkDuplicates()`, `create(photo:photoSkipped:allowDuplicate:)`).

- [ ] **Step 1:** Write tests mirroring Android Task 7: renderer (4000×3000 → 512×512 under 5 MiB; alpha → white; `.right` orientation → upright), flow (duplicates sheet cases incl. non-worker and email-block copy; continue-without-photo → `photo_skipped`; **double tap creates once**; **upload failure after create** → "<Name> was saved, but the photo didn't upload." + retry; 409 `possible_duplicate` re-runs duplicates).
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement per spec §4.2, §4.4 and mockups 3–4: camera screen (circle guide, shutter, Flip, Library via `.photosPicker`), Library-only when no camera (simulator, devices without one), crop screen (drag, pinch, slider 1–4, Retake / Use photo), New worker details (Step 1 of 2), duplicate sheet, "Continue without photo" confirmation (default Take photo), Create worker; keep camera/crop/new-worker state in the `@Observable` model (not view state). A denied camera permission shows "Camera access is off. Turn it on in Settings, or choose a photo instead." with Choose photo. After a create, upsert the `PersonRecord` so the Time Clock finds them.
- [ ] **Step 4:** Run unit tests, the iPhone 16 build and the Release build (recon ios.md §6); all pass.
- [ ] **Step 5:** Commit `feat(ios): Rolodex photos and New worker flow`.
