# Learning Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workers sign in at learn.serversherpa.com with a learning code, read and sign their assigned documents, and the time clock warns about anything unsigned. Managers run it all from a new Learning area in the portal.

**Architecture:**
- New `serversherpa.learning` package (models, services, routes `/learning/*` for managers and `/learn/*` for workers) on migration 0109.
- Content comes from the wiki `learning` space and is snapshotted at publish.
- A new `learn/` Vite SPA uses its own `Learn <token>` sessions.
- The portal gets a Learning nav section plus the initiative Learning tab.
- The web kiosk and laptop time clock flows get a learning step.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, Jinja mail templates, openpyxl/weasyprint reports, `segno` (new, QR PNG), React 18 + Vite (portal, kiosk, new learn app), Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-10-25-learning-portal-design.md` (read it first; this plan argues from it). Mockups: `docs/mockups/learning-portal.html`.

## Global Constraints

- **American English** in all copy, comments and docs. Sentence case in the UI.
- **Policy values come only from the spec.** Code lockout is 10 failures then 900 s, per-IP 30 per 300 s, global 300 per 300 s, all editable. Schedule defaults are invite 7 days before start at 08:00, reminders [5, 3], due 2. `general_code_days` defaults to null. Retention is keep. Do not invent other numbers. If a task needs one, use a setting with a null default and leave it unenforced when null.
- **Migration:** `0109_learning_portal.py`, revision `"0109"`, down_revision `"0108"`.
- **API tests:** `cd api && SS_TEST_DB=serversherpa_test_learning PYTHONPATH=src .venv/bin/pytest <file> -q`. Never use the shared default test DB, and never weaken the conftest truncate guard.
- **Portal tests:** `npm --prefix portal test -- <path>`, typecheck `npm --prefix portal exec tsc -- -b --noEmit`.
- **Kiosk tests:** `npm --prefix kiosk test -- <path>`. The learn app follows the wiki's conventions.
- **Never commit the dev `.env`**, and never rename the `ss_refresh` / `ss_portal_refresh` cookies.
- **Services never commit.** `notify()`, `audit()` and `mail.outbox.enqueue()` add to the session; routes commit.
- **Portal UI reuses house idioms:**
  - `.dir-toolbar` / `.dir-search`, `.segmented`, `span.chip c-*`, `form.pf-form`, `ColumnMenu` / `ColHead` / `listGridStyle`, `usePagedList`;
  - modals use the report-generate header (eyebrow / title / description) and rounded corners (`modalCorners.test.ts`);
  - lists follow the list-typography and list-column-floor guardrail tests;
  - no raw native selects where a ComboBox exists.
- **Managers** are `learning:<action>` holders, plus anyone with global `wiki:delete` (wiki administrators). There is one helper for this (Task 1); never re-derive it.
- **Kiosk session scoping:** `/learn/*` worker routes accept a `Learn` token or a user bearer token. `/learning/*` manager routes accept user bearer tokens only (kiosk-client sessions are already refused by `enforce_session_scope`).

## Review Focus

1. **Brute-forcing codes.** The same code with a wrong last name, or many IPs guessing, must hit the per-code lockout and the global cap. A locked code must refuse even the correct last name until `locked_until`. Test in Task 6.
2. **Last names with accents, case, double spaces, hyphens and apostrophes.** "Núñez", "o'neil" and " Van  Der Berg " must match. Test in Task 6.
3. **A wiki page edited after publish.** The worker must keep seeing the snapshotted version they're assigned. A trashed or purged wiki page must not break reading or signing. Test in Task 3.
4. **The same person added twice, removed and re-added, or added through bulk and then single.** No duplicate open assignments and no second invite email. Test in Task 5.
5. **Time clock status for a station with no move, or a person with assignments on a different initiative.** It warns only about the station's initiative (or general assignments when there's no move), and never 500s. Test in Task 10.

---

### Task 1: Migration 0109, models, access and the manager helper

**Files:**
- Create: `api/migrations/versions/0109_learning_portal.py`
- Create: `api/src/serversherpa/learning/__init__.py`, `api/src/serversherpa/learning/models.py` (ORM classes; import them in `db/models.py`'s module list the same way other packages register, or define them in `db/models.py` if that is the house pattern. Check how `wiki` models are registered and copy it).
- Create: `api/src/serversherpa/learning/access.py`
- Modify: `api/src/serversherpa/access/resources.py`, `api/src/serversherpa/access/defaults.py`, `api/tests/test_access_registry.py`
- Modify: `api/src/serversherpa/db/models.py` (`WorkerCertification` gains `source`, `learning_initiative_id`; `EmailOutbox` gains `attachments`)
- Test: `api/tests/test_learning_migration.py`

**Schema:** create the tables exactly as listed. Every table gets a `gen_random_uuid()` primary key unless noted, `created_at now()`, and FKs to `people.id` for person columns.

- **`learning_documents`**
  - `wiki_node_id` uuid FK `wiki_nodes.id` ON DELETE SET NULL, null
  - `title` text NOT NULL, `summary` text
  - `validity_days` int null (null = never expires)
  - `resign_rule` text NOT NULL default `'expired_or_new_version'`, CHECK in (`every_initiative`, `expired_or_new_version`)
  - `sign_style` text NOT NULL default `'typed_name'`, CHECK in (`checkbox`, `typed_name`, `drawn_signature`)
  - `require_scroll` bool NOT NULL default true
  - `min_read_seconds` int null
  - `quiz_enabled` bool NOT NULL default false
  - `quiz_pass_percent` int null, CHECK 1..100
  - `quiz_max_attempts` int null
  - `quiz_fail_action` text NOT NULL default `'retry'`, CHECK in (`retry`, `lock`)
  - `current_version_id` uuid null (FK added after versions)
  - `archived_at`, `created_by`, `updated_at`
- **`learning_document_versions`**
  - `document_id` FK CASCADE, `version_no` int, UNIQUE(`document_id`, `version_no`)
  - `wiki_version_id` uuid null (no FK, on purpose), `wiki_version_no` int null
  - `title` text, `content_json` jsonb NOT NULL, `content_html` text NOT NULL
  - `image_asset_ids` uuid[] NOT NULL default `'{}'`
  - `change_note` text, `published_by`, `published_at` NOT NULL
- **`learning_translations`**
  - `version_id` FK CASCADE, `language` text CHECK `^[a-z]{2}(-[A-Z]{2})?$`, UNIQUE(`version_id`, `language`)
  - `status` CHECK in (`draft`, `in_review`, `published`)
  - `title`, `content_html` NOT NULL
  - `source` CHECK in (`claude`, `manual`)
  - `updated_by`, `updated_at`, `reviewed_by`, `reviewed_at`
- **`learning_quiz_questions`**
  - `document_id` FK CASCADE, `prompt` text NOT NULL
  - `choices` jsonb NOT NULL (list of `{id, text}`)
  - `correct_choice_ids` text[] NOT NULL
  - `translations` jsonb NOT NULL default `'{}'` (`{lang: {prompt, choices: {id: text}}}`)
  - `position` float8, `archived_at`
- **`learning_packets`**
  - `name` NOT NULL, `description`
  - `enforce_order` bool default false
  - `due_offset_days` int null (null = use the initiative schedule)
  - `icon` text null, `color` text null
  - `archived_at`, `created_by`, `updated_at`
- **`learning_packet_items`**: `packet_id` FK CASCADE, `document_id` FK, `position` float8, PK(`packet_id`, `document_id`)
- **`learning_rules`**
  - `name` NOT NULL, `packet_id` FK
  - `conditions` jsonb NOT NULL default `'[]'` (list of `{field, values: [str]}`)
  - `position` float8, `enabled` bool default true
  - `created_by`, `updated_at`
- **`learning_codes`**
  - `person_id` NOT NULL, `initiative_id` FK `initiatives` null
  - `fingerprint` bytea NOT NULL, `link_token_hash` text NOT NULL UNIQUE
  - `expires_at` timestamptz null
  - `failed_count` int default 0, `locked_until` timestamptz null
  - `revoked_at`, `last_used_at`, `created_by`
  - Partial unique index on `fingerprint` WHERE `revoked_at IS NULL`
  - Partial unique index on (`person_id`, coalesce(`initiative_id`, `'00000000-0000-0000-0000-000000000000'`)) WHERE `revoked_at IS NULL`
- **`learning_sessions`**
  - `code_id` FK null, `person_id` NOT NULL
  - `token_hash` text UNIQUE NOT NULL
  - `expires_at` NOT NULL, `revoked_at`
  - `ip` text, `user_agent` text
- **`learning_assignments`**
  - `person_id` NOT NULL, `initiative_id` null FK CASCADE, `document_id` FK, `version_id` FK (the version required)
  - `packet_id` null, `rule_id` null (both FK SET NULL)
  - `source` CHECK in (`rule`, `manual`, `new_version`)
  - `due_on` date null
  - `status` CHECK in (`assigned`, `opened`, `signed`, `cancelled`) default `assigned`
  - `opened_at`, `signed_at`, `signoff_id` uuid null, `quiz_locked_at`, `created_by`
  - Partial unique index on (`person_id`, coalesce(`initiative_id`, zero-uuid), `document_id`) WHERE `status <> 'cancelled'`
- **`learning_signoffs`**
  - `assignment_id` FK, `person_id`, `document_id`, `version_id`, `initiative_id` null
  - `language` text NOT NULL, `typed_name` text null, `signature_png` bytea null
  - `read_seconds` int NOT NULL, `scrolled_to_end` bool NOT NULL, `quiz_score` int null
  - `ip`, `user_agent`, `signed_at` NOT NULL default now()
- **`learning_quiz_attempts`**: `assignment_id` FK CASCADE, `answers` jsonb, `score_percent` int, `passed` bool
- **`learning_invite_schedules`**
  - `initiative_id` PK FK CASCADE
  - `mode` CHECK in (`manual`, `scheduled`) default `manual`
  - `send_offset_days` int, `send_time` time, `reminder_offsets` int[], `due_offset_days` int
  - `late_adds` bool default true
  - `sent_at`, `sent_by`, `updated_by`, `updated_at`
- **`learning_email_log`**
  - `person_id`, `initiative_id` null, `code_id` null, `assignment_id` null
  - `kind` CHECK in (`invite`, `reminder`, `complete`, `new_version`, `link`)
  - `stage` text NOT NULL default `''`, `outbox_id` uuid null
  - Unique index on (`kind`, `person_id`, coalesce(`code_id`, zero-uuid), `stage`). It is null-safe, so the overdue notices with no code dedupe too.
- **`learning_overrides`**
  - `person_id`, `initiative_id` null, `site_id` null, `device_id` null
  - `admin_person_id` NOT NULL
  - `reason` CHECK in (`signing_on_break`, `signed_on_paper`, `no_phone`, `other`), `reason_text` text
  - `scope` CHECK in (`punch`, `day`), `local_day` date NOT NULL
  - `outstanding` jsonb NOT NULL, `time_entry_id` uuid null

**Changes to existing tables and seed data:**
- `worker_certifications`: add `source` text NOT NULL default `'manual'` CHECK in (`manual`, `learning`), and `learning_initiative_id` uuid null.
- `email_outbox`: add `attachments` jsonb null.
- Widen `ck_notification_groups_categories` to add `'learning'`.
- Roles: insert `learning_admin` (label `Learning admin`, rank 40, `scope_anchor` `global`, `is_system` true, color `c-violet`).
- `role_permissions`: `learning` view/add/change/delete for developer, founder, super_admin, admin and learning_admin; `learning` view for staff. Use `ON CONFLICT DO NOTHING`.
- Downgrade drops everything in reverse.

**Interfaces:**
- Produces: ORM classes `LearningDocument`, `LearningDocumentVersion`, `LearningTranslation`, `LearningQuizQuestion`, `LearningPacket`, `LearningPacketItem`, `LearningRule`, `LearningCode`, `LearningSession`, `LearningAssignment`, `LearningSignoff`, `LearningQuizAttempt`, `LearningInviteSchedule`, `LearningEmailLog`, `LearningOverride`, with attribute names equal to the column names.
- Produces: `learning.access.is_manager(access: AccessInfo, action: str = "view") -> bool`, which is `access.can("learning", action) or access.can("wiki", "delete")`.
- Produces: `learning.access.require_manager(action: str)`, a FastAPI dependency returning the `AuthContext`, 403 `forbidden` otherwise.
- Produces: a `learning` resource in `access/resources.py`, label `Learning`, routes `("/learning",)`, `visible_to={"global"}`.

- [ ] **Step 1: Write the failing tests** in `test_learning_migration.py`:
  - `test_learning_tables_exist`: every table above exists after upgrade.
  - `test_assignment_unique_ignores_cancelled`: two open assignments for the same person, initiative and document raise IntegrityError; a cancelled one plus an open one is fine; a null initiative is treated as one value.
  - `test_code_fingerprint_unique_only_when_active`
  - `test_learning_admin_role_and_grants`: the role exists with rank 40 and holds `learning:change`; staff holds only view.
  - `test_notification_category_learning_allowed`
  - `test_is_manager_true_for_wiki_admin_and_learning_admin_false_for_worker`
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Write the migration, models and access code. Update `test_access_registry.py` expectations.
- [ ] **Step 4:** Run `test_learning_migration.py test_access_registry.py` and confirm PASS.
- [ ] **Step 5:** Commit `feat(learning): migration 0109, models and access`.

### Task 2: Learning settings (`/system/learning`)

**Files:**
- Modify: `api/src/serversherpa/system/config_store.py` (add `DEFAULTS["learning"]`)
- Create: `api/src/serversherpa/learning/settings.py`
- Modify: `api/src/serversherpa/api/routes/system.py`, `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_learning_settings.py`

**Defaults** (the spec's values only):
```python
DEFAULTS["learning"] = {
    "code_max_failures": 10, "code_lockout_seconds": 900,
    "ip_limit": 30, "ip_window_seconds": 300, "global_limit": 300,
    "general_code_days": None,
    "default_validity_days": None,
    "invite_offset_days": 7, "invite_time": "08:00",
    "reminder_offsets": [5, 3], "due_offset_days": 2,
    "retention_days": None,
    "brand_line": "",
    "email_text": {},   # {template: {lang: {"subject": str, "intro": str}}}
    "languages": ["en", "ja", "ko", "he"],
}
```

**Interfaces:**
- Produces: `learning.settings.LearningSettings`, a frozen dataclass with the keys above (types: int | None, str, list[int], dict).
- Produces: `async def load_settings(db) -> LearningSettings`.
- Produces: `GET /system/learning` (manager view) and `PUT /system/learning` (manager change).
  - The schemas are `LearningSettingsOut` / `LearningSettingsIn` with `extra="forbid"`.
  - Integers are ≥ 1 when set. `reminder_offsets` are each 0..365 and unique. `invite_time` is `HH:MM`. `languages` is a subset of `["en","ja","ko","he"]` and always includes `en`.
  - `PUT` writes the audit `learning_config_update` with a diff, copying `security_config_update`.

- [ ] **Step 1:** Write the tests:
  - `test_defaults_returned`
  - `test_put_validates_and_audits`
  - `test_put_rejects_unknown_key`
  - `test_worker_forbidden`
  - `test_wiki_admin_allowed`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement, copying the `/system/security` pair.
- [ ] **Step 4:** Run them and confirm they pass.
- [ ] **Step 5:** Commit `feat(learning): settings section`.

### Task 3: Library: documents, wiki snapshot publish, reading content

**Files:**
- Create: `api/src/serversherpa/learning/library.py`, `api/src/serversherpa/learning/render.py`
- Create: `api/src/serversherpa/api/routes/learning/__init__.py` (router prefix `/learning`, included from the app like other routers), `api/src/serversherpa/api/routes/learning/library.py`
- Create: `api/src/serversherpa/learning/schemas.py` (all learning pydantic schemas live here)
- Test: `api/tests/test_learning_library.py`

**Interfaces:**
- `render.async render_version_html(content_json: dict) -> tuple[str, list[uuid.UUID]]` returns `(html, image_asset_ids)`. It uses `wiki.export_html.prepare_doc`, `render_client`, `render_fragment` and `finish_fragment`, and collects the `wikiImage` asset ids. It raises `LearningRenderUnavailable` when the render server can't be reached; the route maps that to 503 `render_unavailable`.
- `render.async html_with_images(db, version: LearningDocumentVersion) -> str` swaps image placeholders for presigned URLs, using the same helper `POST /wiki/assets/urls` uses.
- `library.async create_document(db, *, actor_id, title, wiki_node_id, **settings) -> LearningDocument`. `wiki_node_id` must be a page node in the `learning` space; otherwise 422 `not_learning_page`.
- `library.async publish_version(db, document, *, actor_id, change_note: str | None) -> LearningDocumentVersion`
  - Reads the wiki page's current published version (404 `wiki_not_published` if there is none) and renders it.
  - Inserts `version_no = max + 1` under a `FOR UPDATE` lock on the document, then sets `current_version_id`.
  - If the wiki version id equals the current version's, it raises 409 `no_changes`.
- **Routes** (managers; view for GET, add for POST, change for PATCH/publish, delete for archive):
  - `GET /learning/documents` returns `[{id, title, current_version_no, published_at, packets: [name], signoff_count, languages: {lang: status|"out_of_date"}}]`.
  - `POST /learning/documents`.
  - `GET /learning/documents/{id}` returns the settings, the versions list and the current HTML.
  - `PATCH /learning/documents/{id}` updates settings. Pydantic validates: `validity_days` ≥ 1 or null; quiz fields only meaningful when `quiz_enabled`.
  - `POST /learning/documents/{id}/publish` takes `{change_note}`.
  - `GET /learning/documents/{id}/versions/{version_id}` returns the HTML.
  - `DELETE /learning/documents/{id}` sets `archived_at`.
  - Mutations audit `learning_document_*`.
- **Learning spaces:** `GET /learning/wiki-pages` lists the pages in the `learning` space (id, title, path, published version no) for the "link a page" picker.

- [ ] **Step 1:** Write the tests. Mock the render HTTP call with the same fixture style the wiki export tests use (find it with `grep -rn render_fragment api/tests`).
  - `test_create_requires_learning_space_page`
  - `test_publish_snapshots_and_numbers_versions`
  - `test_publish_twice_without_wiki_change_is_409`
  - `test_wiki_edit_after_publish_does_not_change_snapshot` (Review Focus 3)
  - `test_purged_wiki_node_keeps_version_readable` (Review Focus 3): delete the wiki node row, then the version HTML still returns.
  - `test_render_unavailable_is_503`
  - `test_non_manager_forbidden`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them and confirm they pass.
- [ ] **Step 5:** Commit `feat(learning): library and versioned snapshots`.

### Task 4: Packets and assignment rules

**Files:**
- Create: `api/src/serversherpa/learning/packets.py`, `api/src/serversherpa/learning/rules.py`, `api/src/serversherpa/api/routes/learning/packets.py`
- Test: `api/tests/test_learning_packets_rules.py`

**Interfaces:**
- **Packet routes:** `GET/POST /learning/packets`, `GET/PATCH/DELETE /learning/packets/{id}`.
  - The body carries `items: [document_id]` in order. `PATCH` replaces the items.
  - `POST /learning/packets/{id}/copy` creates "Copy of <name>".
- **Rule routes:** `GET/POST /learning/rules`, `PATCH/DELETE /learning/rules/{id}`, `POST /learning/rules/reorder` with `{ids: [...]}`.
- **Condition fields:** `RULE_FIELDS = ("everyone","initiative","client","site","site_country","worker_role","partner","person")`.
  - `everyone` takes no values. Every other field needs ≥ 1 value.
  - An unknown field is 422 `bad_rule_field`.
- **Context:** `rules.RuleContext`, a dataclass with `person_id`, `initiative_id: UUID | None`, `client_id`, `site_ids: set[UUID]` (origin, destination and the initiative's site), `site_countries: set[str]`, `work_type: str | None`, `partner_id: UUID | None`.
- `rules.async build_context(db, person_id, initiative_id: UUID | None) -> RuleContext`
- `rules.matches(rule: LearningRule, ctx: RuleContext) -> bool` is pure. All conditions are ANDed; a condition matches if any of its values match.
- `rules.async matching_packets(db, ctx) -> list[tuple[LearningRule, LearningPacket]]` checks enabled rules in `position` order and skips archived packets.

- [ ] **Step 1:** Write the tests:
  - `test_packet_crud_orders_items`
  - `test_rule_matches_everyone`
  - `test_rule_and_of_conditions`
  - `test_rule_country_and_role`
  - `test_disabled_rule_ignored`
  - `test_reorder`
  - `test_bad_field_422`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them and confirm they pass.
- [ ] **Step 5:** Commit `feat(learning): packets and assignment rules`.

### Task 5: Assignment engine, the add hooks, dry run and manual assign

**Files:**
- Create: `api/src/serversherpa/learning/assign.py`, `api/src/serversherpa/api/routes/learning/initiatives.py`
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (`add_initiative_person`), `api/src/serversherpa/people/team_bulk.py` (the add branch of `commit_rows`)
- Test: `api/tests/test_learning_assign.py`

**Interfaces:**
- `assign.async signoff_valid(db, person_id, document: LearningDocument, *, initiative_id: UUID | None, on: date) -> tuple[bool, str]`. It returns `(valid, reason)`, with reason one of `"valid_until:<iso>"`, `"never_signed"`, `"expired"`, `"new_version"`, `"every_initiative"`. It follows the spec's "due" rules.
- `assign.async plan_for(db, person_id, initiative_id: UUID | None) -> list[PlannedItem]`. `PlannedItem` is a dataclass with `document_id`, `version_id`, `packet_id`, `rule_id`, `action: "assign"|"skip"`, `reason: str`.
- `assign.async apply_plan(db, person_id, initiative_id, items, *, actor_id, source="rule") -> list[LearningAssignment]`.
  - It is idempotent: an open assignment for the same key is skipped.
  - `due_on` comes from the packet's `due_offset_days`, or the schedule's / settings' `due_offset_days`, counted before `initiative.start`.
- `assign.async assign_on_add(db, initiative_id, person_id, actor_id) -> None` calls `plan_for` + `apply_plan`. When the schedule has `sent_at` set and `late_adds` is true, it also queues the invite (Task 8 provides `invites.send_invite_for(db, person_id, initiative_id, actor_id)`; call it through a late import).
- `assign.async cancel_for_removed(db, initiative_id, person_id)` sets the open assignments to `cancelled` and revokes the code. Call it from the people remove route (find the remove endpoint next to `add_initiative_person`).
- **Routes** (managers):
  - `POST /learning/initiatives/{id}/dry-run` takes `{apply: bool}` and returns `{rows: [{person_id, name, will_get: [title], why: [str], skipped: [{title, reason}], no_email: bool}], totals: {checked, to_assign, skipped, no_email}}`.
  - `POST /learning/assign` takes `{person_ids: [...], initiative_id: UUID|null, packet_id?: UUID, document_ids?: [UUID]}` and creates manual assignments ("Assign extras" and on-site days).
  - `POST /learning/documents/{id}/push-version` takes `{person_ids}` and creates `new_version` assignments with no initiative, for people on site outside an initiative.

- [ ] **Step 1:** Write the tests:
  - `test_new_worker_gets_everyone_packet`
  - `test_valid_signoff_skips_expired_or_new_version_doc`
  - `test_every_initiative_doc_always_assigned`
  - `test_signed_for_same_initiative_stays_valid_past_expiry`
  - `test_new_version_requires_resign_at_next_initiative`
  - `test_single_add_creates_assignments_in_same_transaction`
  - `test_bulk_add_creates_assignments`
  - `test_add_twice_bulk_then_single_no_duplicates` (Review Focus 4)
  - `test_remove_cancels_and_readd_reassigns` (Review Focus 4)
  - `test_dry_run_does_not_write`
  - `test_dry_run_apply_writes`
  - `test_manual_assign_general`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement and wire the hooks.
- [ ] **Step 4:** Run the tests plus `test_team_bulk_api.py`, `test_team_bulk_service.py` and the initiatives people tests (`grep -ln add_initiative_person api/tests`). Confirm PASS.
- [ ] **Step 5:** Commit `feat(learning): assignment engine and initiative hooks`.

### Task 6: Codes, learn sessions and worker sign-in

**Files:**
- Create: `api/src/serversherpa/learning/codes.py`, `api/src/serversherpa/learning/sessions.py`, `api/src/serversherpa/api/routes/learn/__init__.py` (router prefix `/learn`), `api/src/serversherpa/api/routes/learn/auth.py`
- Modify: `api/src/serversherpa/config.py` (`learn_origin: str = "http://localhost:5179"` plus a `learn_url(path)` helper beside `portal_url`)
- Test: `api/tests/test_learning_codes.py`, `api/tests/test_learn_auth.py`

**Interfaces:**
- `codes.generate() -> str`: 6 characters from `kiosk_pairing.CODE_ALPHABET`, using `secrets`.
- `codes.fingerprint(code: str) -> bytes`: HMAC-SHA256 over the pepper, `b"learning-code\0"` and `normalize_code(code)`. Reuse the key source from `move_password.fingerprint`.
- `codes.normalize_last_name(s: str) -> str`: NFKD, drop combining marks, casefold, collapse whitespace, trim. Hyphens and apostrophes are kept.
- `codes.async issue(db, person_id, initiative_id: UUID | None, *, actor_id) -> tuple[LearningCode, str, str]` returns `(row, code, link_token)`.
  - It revokes any active code for the same key.
  - On a fingerprint collision it retries up to 5 times.
  - `expires_at`: the initiative end at 23:59 in the site's time zone (UTC fallback); for general codes, `general_code_days` or null.
- `codes.async revoke(db, code_id, *, actor_id)`
- `sessions.async start(db, *, code: LearningCode | None, person_id, ip, user_agent) -> str` returns the raw token. The expiry is `min(code.expires_at, now + SS_SESSION_TTL_SECONDS)`.
- **`LearnActor` dependency** in `sessions.py`: a dataclass with `person_id`, `session: LearningSession | None`, `user: AuthContext | None`.
  - It accepts `Authorization: Learn <token>` (an active, unexpired session whose code is not revoked) or a normal bearer (via `get_current_user`).
  - Otherwise 401 `learn_auth_required`.
- **Routes** (public, all POST with a JSON body):
  - `/learn/auth/code` takes `{code, last_name}` and returns `{token, expires_at, person: {first_name}}`.
  - `/learn/auth/link` takes `{token}` and returns the same shape.
  - `/learn/auth/logout` revokes the session.
  - `/learn/auth/me` returns `{person_id, first_name, via: "code"|"account"}`.
- **Failure handling:**
  - A failure returns 401 `learn_code_invalid` with no detail on whether the code or the name was wrong. It increments `failed_count`; at `code_max_failures` it sets `locked_until = now + code_lockout_seconds`.
  - A locked code returns 423 `learn_code_locked` even with the right last name.
  - IP and global caps copy `move_login_capped`, counting the `audit_log` action `learning_code_failed` per `rate_limit_ip` bucket over `ip_window_seconds`, and return 429 `rate_limited`.
  - An expired or revoked code returns 401 `learn_code_invalid`.

- [ ] **Step 1:** Write the tests:
  - `test_generate_alphabet_and_length`
  - `test_normalize_last_name` with `("Núñez","nunez")`, `(" Van  Der Berg ","van der berg")`, `("O'Neil","o'neil")`
  - `test_code_login_success_case_space_insensitive` (`"k7q m2x"`)
  - `test_wrong_last_name_counts_failure`
  - `test_lockout_after_max_failures_refuses_correct_name` (Review Focus 1)
  - `test_ip_cap_429`
  - `test_global_cap_429` (Review Focus 1)
  - `test_link_login`
  - `test_revoked_or_expired_code_rejected`
  - `test_learn_token_cannot_call_portal_routes` (`GET /people` with a Learn token is 401)
  - `test_account_bearer_accepted_by_learn_me`
  - `test_issue_revokes_previous`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them and confirm they pass.
- [ ] **Step 5:** Commit `feat(learning): learning codes and learn sessions`.

### Task 7: Worker learn API: assignments, reading, quiz, signing, completion

**Files:**
- Create: `api/src/serversherpa/learning/worker.py`, `api/src/serversherpa/learning/completion.py`, `api/src/serversherpa/learning/quiz.py`, `api/src/serversherpa/api/routes/learn/training.py`
- Modify: `api/src/serversherpa/notifications/kinds.py` (`CATEGORIES` += `learning`; kinds `learning_complete` (category learning, email True), `learning_overdue` (category learning, email True) and `learning_quiz_locked` (category learning, email False))
- Modify: `portal/src/lib/api.ts` (`NotificationCategory`) and `portal/src/lib/notificationKinds.ts` (`NOTIFICATION_CATEGORIES`, label "Learning"); keep the kinds-registry test green
- Test: `api/tests/test_learn_training.py`, `api/tests/test_learning_completion.py`

**Interfaces** (all routes take `LearnActor` and only touch that person's own rows; anything else is 404):
- `GET /learn/training` returns `{groups: [{initiative: {id,name,start}|null, due_on, items: [{assignment_id, title, status, minutes, has_quiz, locked: bool, signed_at}]}], complete: bool, badge_uid: str|null}`.
  - `locked` is true when the packet has `enforce_order` and an earlier item isn't signed.
  - `badge_uid` is only included when `complete`.
- `GET /learn/assignments/{id}?lang=xx` returns `{title, html, language, fallback: bool, version_no, change_note, sign_style, require_scroll, min_read_seconds, has_quiz, quiz_passed}`. It sets `opened_at`/status `opened` the first time. It uses the published translation for `lang` if there is one, otherwise English with `fallback=true`.
- `GET /learn/assignments/{id}/quiz?lang=` returns `[{id, prompt, choices: [{id, text}], multiple: bool}]`, with no answers and shuffled per request. `multiple` is true when more than one choice is correct. `quiz.select(...)` uses all non-archived questions.
- `POST /learn/assignments/{id}/quiz` takes `{answers: {question_id: [choice_id]}}` and returns `{score_percent, passed, attempts_left, locked}`.
  - Passing needs `score >= quiz_pass_percent`, an exact set match per question.
  - With `fail_action="lock"`, reaching `quiz_max_attempts` sets `quiz_locked_at` and notifies the managers (kind `learning_overdue` is not right for this; inbox only, kind `learning_quiz_locked`, category learning, email False).
- `POST /learn/assignments/{id}/sign` takes `{agreed: true, typed_name?: str, signature_png_b64?: str, language: str, scrolled_to_end: bool}`.
  - 422 `must_agree` without `agreed`.
  - 422 `name_required` (typed_name style) or `signature_required` (drawn style).
  - 422 `quiz_required` when the quiz isn't passed.
  - 422 `read_time` when `now - opened_at < min_read_seconds` (the server-side check).
  - 422 `scroll_required` when `require_scroll` is set and the client says it didn't scroll.
  - 409 `locked` for order or quiz locks.
  - It writes a `LearningSignoff` (`read_seconds = now - opened_at`) and sets the assignment to `signed` + `signoff_id`, then calls `completion.check(db, person_id, initiative_id, actor=None)`.
- `completion.async check(db, person_id, initiative_id: UUID | None) -> bool`. When no open assignment is left for that person and initiative:
  - insert `WorkerCertification(source="learning", learning_initiative_id=…, name="Onboarding: <initiative>" or "Learning: general", issued_on=today, expires_on=<earliest of signed_at + validity_days among the signed docs, or null>)`;
  - `notify` every manager (global `learning:change` or `wiki:delete` holders, not disabled) with kind `learning_complete`, title `"<Name> finished learning for <initiative>"`, link `/initiatives/<id>?tab=learning` (or the worker page for general);
  - call `emails.send_complete(db, person_id, initiative_id)` (Task 8, late import).
  - It returns True when it completed. It is idempotent: an existing learning cert for that initiative means it does nothing.

- [ ] **Step 1:** Write the tests:
  - `test_training_lists_only_own_assignments`
  - `test_other_persons_assignment_404`
  - `test_translation_used_or_fallback`
  - `test_open_sets_opened_at_once`
  - `test_sign_validations` (parametrized over each 422 code)
  - `test_min_read_time_enforced_server_side`
  - `test_quiz_grading_and_lock`
  - `test_enforce_order_locks_later_items`
  - `test_last_sign_writes_cert_notifies_and_queues_email`
  - `test_completion_idempotent`
  - `test_quiz_answers_never_returned`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them, plus the notification kinds registry test (`grep -ln KINDS api/tests`) and the portal tests touching `notificationKinds`. Confirm PASS.
- [ ] **Step 5:** Commit `feat(learning): worker training API and completion`.

### Task 8: Emails, the QR attachment, invites, reminders and the scheduler

**Files:**
- Create: `api/src/serversherpa/learning/emails.py`, `api/src/serversherpa/learning/invites.py`, `api/src/serversherpa/learning/scheduler.py`
- Create: `api/src/serversherpa/mail/templates/learning_invite.{subject.txt,html,txt}`, `learning_reminder.*`, `learning_complete.*`, `learning_new_version.*`, `learning_link.*`
- Modify: `api/src/serversherpa/mail/outbox.py` (`enqueue(..., attachments: list[dict] | None = None)`), `api/src/serversherpa/mail/transport.py` (`build_message` adds `multipart/related` inline parts from `attachments` = `[{"cid","filename","content_type","b64"}]`), `api/src/serversherpa/notifications/worker.py` (call `scheduler.run_learning_once(maker)` every 60 s on a monotonic timer, like `last_reminders`)
- Modify: `api/pyproject.toml` (add `segno`)
- Modify: `api/src/serversherpa/api/routes/learning/initiatives.py`
- Test: `api/tests/test_learning_emails.py`, `api/tests/test_learning_scheduler.py`, `api/tests/test_mail_attachments.py`

**Interfaces:**
- `emails.qr_png(value: str) -> bytes`: segno, error level M, scale 8, border 4.
- Each email function returns the `EmailOutbox` row or None when the person has no email. Context keys are fixed per template, and each function writes a `learning_email_log` row (kind/stage) before enqueueing so the unique index dedupes:
  - `emails.async send_invite(db, person, code_row, code: str, link_token: str, initiative | None, due_on)`
  - `send_reminder(..., stage: str)`
  - `send_complete(db, person_id, initiative_id)` (QR inline, `cid:qr`, value `str(person.badge_uid)`, plus a line warning not to share it)
  - `send_link(db, person_id, initiative_id)` (re-issues the link only, kind `link`, stage = ISO minute)
  - `send_new_version(...)`
- **Subject and intro** come from `settings.email_text[template][lang]` when set, otherwise the template default. `lang` is the person's preferred learning language: the last sign-off language, else `en`.
- **Person email:** the contact email first, then the login email, matching `notifications/email.py`.
- `invites.async send_invite_for(db, person_id, initiative_id, actor_id) -> bool` issues a code (Task 6) and sends the invite.
- `invites.async send_initiative(db, initiative_id, actor_id, *, person_ids: list[UUID] | None = None) -> dict` returns `{sent, no_email, skipped_complete}`. It covers everyone with open assignments, or only `person_ids` (Resend), and sets `schedule.sent_at` the first time.
- `scheduler.async run_learning_once(maker) -> dict`:
  - sends scheduled invites whose computed send time (start − `send_offset_days` at `send_time` in the site's time zone) has passed and that have no `sent_at`;
  - sends reminders at start − each offset to people with open assignments (stage `"r<offset>"`);
  - raises an overdue inbox and email notice to managers once per initiative per local day when `due_on` has passed with open assignments (deduped with `learning_email_log` kind `reminder`, stage `"overdue:<date>"`, `code_id` null, `person_id` = manager).
- **Routes** (managers):
  - `GET /learning/initiatives/{id}` returns `{stats: {invited, opened, in_progress, complete, overdue}, schedule, packets: [{packet, rule_name, every_initiative: bool}], extras: [{title, people: n}], timeline: [{date, kind}]}`.
  - `PUT /learning/initiatives/{id}/schedule` (validated like settings).
  - `POST /learning/initiatives/{id}/send` takes `{person_ids?}`.
  - `GET /learning/initiatives/{id}/roster?status=` returns rows of `{person_id, name, email, partner, language, done, total, status: complete|in_progress|overdue|not_opened|no_email, last_activity}`.
  - `POST /learning/initiatives/{id}/people/{pid}/regenerate` re-issues the code and emails it.
  - `POST /learning/initiatives/{id}/people/{pid}/revoke`.
  - `GET /learning/initiatives/{id}/code-sheet.pdf` (weasyprint): one row per person with no email (name and a fresh code; issuing a new code revokes the old one, so the sheet says "codes on this sheet replace earlier ones"). With `?all=1` it covers everyone.
- `GET /initiatives/{id}` timeline consumers: add `learning_send_at: datetime | None` to the initiative timeline payload (find the timeline endpoint used by `pages/InitiativeTimeline.tsx`) so Task 18 can draw the marker.

- [ ] **Step 1:** Write the tests:
  - `test_attachments_build_inline_related_part`
  - `test_send_invite_renders_code_and_link_and_logs`
  - `test_invite_dedup_unique`
  - `test_no_email_returns_none_and_counts`
  - `test_scheduled_send_fires_once_at_site_time`
  - `test_reminders_per_offset_once`
  - `test_overdue_notice_once_per_day`
  - `test_complete_email_has_qr_cid`
  - `test_email_text_override_used`
  - `test_roster_statuses`
  - `test_regenerate_revokes_old_code`
  - `test_code_sheet_pdf_returns_pdf`
  - `test_late_add_after_send_auto_invites`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement. Run `uv`/pip install of segno into `api/.venv` the way other dependencies are installed (check the README / pyproject tooling).
- [ ] **Step 4:** Run them, plus the existing mail tests (`grep -ln build_message api/tests`). Confirm PASS.
- [ ] **Step 5:** Commit `feat(learning): emails, QR, invites and scheduler`.

### Task 9: Translations, quiz admin and Claude drafts

**Files:**
- Create: `api/src/serversherpa/learning/translate.py`, `api/src/serversherpa/api/routes/learning/content.py`
- Test: `api/tests/test_learning_translations.py`

**Interfaces:**
- **Translation routes** (managers):
  - `GET /learning/documents/{id}/translations` returns `[{language, status: draft|in_review|published|out_of_date|missing, version_no, updated_at, reviewed_by}]`. A language is `out_of_date` when its newest translation is for an older version than current.
  - `PUT /learning/documents/{id}/translations/{lang}` takes `{title, content_html}` and saves as draft for the current version, with source `manual`.
  - `POST .../{lang}/draft` calls Claude and saves with source `claude`, status `draft`.
  - `POST .../{lang}/submit` sets `in_review`.
  - `POST .../{lang}/approve` sets `published` with `reviewed_by`/`reviewed_at`. It is refused (409 `self_review`) when the approver is the last editor, unless the approver is a developer.
- **HTML safety:** translated HTML is sanitized with the allowlist the wiki export output uses (if no Python sanitizer exists, add `nh3` and allow the tags that `generateHTML` emits).
- `translate.async draft(html: str, title: str, target_lang: str) -> tuple[str, str]`
  - Uses the Anthropic client and model setting the spec lookup uses (`spec_lookup/provider.py`).
  - The prompt tells it to translate the visible text only and keep every tag and attribute.
  - The result is sanitized.
  - 503 `translation_unavailable` without an API key.
- **Quiz routes:** `GET/POST /learning/documents/{id}/questions`, `PATCH/DELETE /learning/questions/{qid}`, `POST /learning/documents/{id}/questions/reorder`. A question needs ≥ 2 choices and ≥ 1 correct choice id that exists in the choices.

- [ ] **Step 1:** Write the tests (mock the Anthropic client):
  - `test_out_of_date_after_new_version`
  - `test_draft_via_claude_saved_as_draft`
  - `test_approve_requires_different_reviewer`
  - `test_sanitizes_script`
  - `test_question_validation`
  - `test_no_key_503`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them and confirm they pass.
- [ ] **Step 5:** Commit `feat(learning): translations and quiz admin`.

### Task 10: Time clock API: status block, email link, admin override

**Files:**
- Create: `api/src/serversherpa/learning/timeclock.py`
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (`_status_out` / `station_timeclock_status` and the session twin `/kiosk/timeclock/{person_id}`; new station routes), `api/src/serversherpa/api/schemas.py` (`KioskTimeclockStatusOut.learning`, `KioskStationClockIn.learning_override_id`)
- Modify: `kiosk_laptop/edge/src/edge/routes/timeclock.py` (forward `POST /learning-link` and `POST /learning-override` exactly like clock-in)
- Test: `api/tests/test_learning_timeclock.py`, the edge test beside the existing timeclock edge tests

**Interfaces:**
- `timeclock.async outstanding(db, person_id, initiative_id: UUID | None, site_id: UUID | None, today: date) -> list[dict]`
  - Returns `[{title, kind: "required"|"extra"}]`: open assignments for that initiative, or `initiative_id IS NULL` assignments when the station has no move. `extra` means source `manual`.
  - It returns `[]` when a `day` override exists for (person, site, today) or the person has nothing open.
- **Status:** `KioskTimeclockStatusOut.learning: KioskLearningBlock | None`, where `KioskLearningBlock = {outstanding: list[{title, kind}], link_email: bool}` (`link_email` is true when the person has an email). It is null when `outstanding` is empty. "Today" is the station's local day, from `tz`.
- `POST /kiosk/station/timeclock/learning-link` takes `{serial, person_id}` and returns `{sent: bool}`. It calls `emails.send_link`, rate-limited per person to one per minute through the `learning_email_log` stage.
- `POST /kiosk/station/timeclock/learning-override` takes `{serial, person_id, admin_email, admin_password, totp_code?, reason, reason_text?, scope}` and returns `{override_id}`.
  - Credentials are checked with the same primitives as `/auth/login` (Argon2 verify with the dummy hash on unknown emails, account lockout counters, a TOTP check when the account has 2FA, 401 `totp_required` when the code is missing).
  - Rank must be ≥ `GATE_BYPASS_RANK` (60), else 403 `override_rank`.
  - 422 `reason_text_required` for `other` without text.
  - It writes `LearningOverride` with `outstanding` as of now, plus the audit `learning_override` (`actor_id` = admin).
- **Clock-in:** `learning_override_id` is optional. When it's given, it must belong to that person at this station today, and `time_entry_id` is set after the punch.
- Punches are never blocked on learning.

- [ ] **Step 1:** Write the tests:
  - `test_status_learning_null_when_nothing_open`
  - `test_status_lists_station_initiative_only` (Review Focus 5)
  - `test_status_no_move_uses_general_assignments` (Review Focus 5)
  - `test_status_never_500_without_learning_rows` (Review Focus 5)
  - `test_day_override_suppresses_until_local_midnight`
  - `test_override_bad_password_401_counts_lockout`
  - `test_override_rank_403`
  - `test_override_totp_required`
  - `test_override_other_needs_text`
  - `test_clock_in_links_override`
  - `test_learning_link_rate_limited`
  - Edge: `test_edge_forwards_learning_routes`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them, plus `test_kiosk_timeclock_*.py` and the edge suite (`cd kiosk_laptop/edge && .venv/bin/pytest -q`, matching how its tests run today). Confirm PASS.
- [ ] **Step 5:** Commit `feat(learning): time clock learning status and override`.

### Task 11: Dashboard, compliance grid, person history, report and certificate

**Files:**
- Create: `api/src/serversherpa/learning/stats.py`, `api/src/serversherpa/reports/learning_compliance/{__init__.py,gather.py,xlsx.py,pdf.py,templates/learning_compliance.html}`, `api/src/serversherpa/learning/certificate.py` + `templates/learning_certificate.html`
- Modify: `api/src/serversherpa/reports/registry.py`, `api/src/serversherpa/api/routes/reports.py` (allow runs with no initiative for this type; gate on manager view), migration 0109 (add the system `report_definitions` row for `learning_compliance`, copying 0090's INSERT constant pattern; amend Task 1's migration since the branch is unmerged)
- Modify: `api/src/serversherpa/api/routes/learning/initiatives.py` or a new `routes/learning/stats.py`
- Test: `api/tests/test_learning_stats.py`, `api/tests/test_learning_compliance_report.py`

**Interfaces:**
- `GET /learning/dashboard?days=7|30|90` returns:
  - `funnel: {assigned, opened, complete, median_open_hours, median_finish_minutes}`
  - `overrides: {count, admins}`
  - `at_risk: [{initiative_id, name, starts_in_days, percent, not_finished, no_email}]` for active initiatives starting within 30 days with open assignments, sorted by percent
  - `expiring: [{document_id, title, people, first_date}]` within 30 days
  - `translation_issues: [{document_id, title, language}]`
  - `hard_questions: [{question_id, document_title, miss_percent}]` with ≥ 10 attempts and > 40 % missed
- `GET /learning/initiatives/{id}/grid` returns `{documents: [{id,title}], rows: [{person_id, name, cells: {doc_id: {state: valid|expires_during|missing|not_required, label}}}]}`. `expires_during` means valid now but expiring before the initiative ends, and only for `expired_or_new_version` documents that would not be re-required.
- `GET /learning/people/{person_id}/history` returns sign-offs (document, version, language, signed_at, read_seconds, quiz_score), quiz attempts, overrides and open assignments. Managers, or `workers:view` with worker scope.
- `GET /learning/people/{person_id}/certificate.pdf?initiative_id=` lists every sign-off with the version and timestamp, plus a signature image when drawn.
- **Report type `learning_compliance`:** options `{initiative_id: UUID|null, format: "xlsx"|"pdf"}`. One row per person × required document: status, version signed, language, signed_at, expires_on, override count.

- [ ] **Step 1:** Write the tests:
  - `test_dashboard_funnel_counts`
  - `test_at_risk_sorting`
  - `test_grid_states_including_expires_during`
  - `test_history_scoped`
  - `test_certificate_pdf`
  - `test_report_registered_and_builds_xlsx_and_pdf`
  - `test_report_seed_row_present`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them, plus the existing report registry tests (`grep -ln "registry()" api/tests`). Confirm PASS.
- [ ] **Step 5:** Commit `feat(learning): dashboard, grid, history and compliance report`.

### Task 12: Wiki Learning space seed (`serversherpa learning-seed`)

**Files:**
- Create: `api/src/serversherpa/learning/seed.py`, `api/src/serversherpa/learning/seed_content.py` (ProseMirror JSON builders; never emit empty text nodes; copy the helpers in `.superpowers/wiki/android-guides/wikidoc.py` instead of importing them)
- Modify: `api/src/serversherpa/cli.py` (command `learning-seed [--actor-email EMAIL]`)
- Test: `api/tests/test_learning_seed.py`

**What it creates** (idempotent; it looks up the space by key and pages by parent + title):
- Space `key="learning"`, `name="Learning"`, description "Training documents workers review and sign before working on site.", `default_access="internal"`, created through the same service function `POST /wiki/spaces` uses.
- Folder `Standard onboarding` with published pages `Dress code`, `Confidentiality` and `Work expectations` (`doc_type` "Policy").
  - Each starts with a callout paragraph: "Sample document. Replace this text with your company's policy before you assign it."
  - Then 3–5 headed sections of realistic content (Dress code follows the mockup's sections).
- Folder `Client site rules` with `Acme site rules (sample)` and `Acme NDA (sample)`.
- Folder `Extras` with `Forklift safety (sample)`.
- One learning document per page:
  - Dress code: `validity_days` 365, `expired_or_new_version`, typed name, scroll required, `min_read_seconds` 60 (all from the mockup).
  - Confidentiality and Work expectations: `validity_days` 365, `expired_or_new_version`.
  - The Acme pages: `every_initiative`.
  - Acme NDA: `quiz_enabled` with 4 questions, pass 75, `max_attempts` 3, retry (from the mockup).
  - Forklift: `validity_days` 365.
- Publish v1 of each.
- Packets `Standard onboarding` (the 3 docs, in order), `Acme site rules` (2 docs) and `Forklift safety`.
- One enabled rule `Everyone → Standard onboarding`. The Acme and forklift packets get no rule (the client ids differ per install); Jimmy adds those rules in the UI.
- It needs the render server for publish; if that's down it prints a clear message and exits 1.

- [ ] **Step 1:** Write the tests:
  - `test_seed_creates_space_pages_documents_packets_rule` (mock render)
  - `test_seed_is_idempotent`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them and confirm they pass.
- [ ] **Step 5:** Commit `feat(learning): learning-seed command and sample documents`.

### Task 13: Learn app scaffold, deploy wiring and sign-in

**Files:**
- Create: `learn/` with `package.json` (scripts `dev`, `build`, `test`), `vite.config.ts` (copy wiki's: `root web/`, `publicDir ../portal/public`, `@portal` alias, `dedupe`, port **5179** `strictPort`, `host`, `allowedHosts`, wss HMR when `SS_PUBLIC_HTTPS`), `dedupe.ts`, `tsconfig.json`, `web/index.html`, `web/src/{main.tsx,Root.tsx,App.tsx}`, `web/src/lib/{api.ts,session.ts,i18n.ts}`, `web/src/i18n/{en,ja,ko,he}.ts`, `web/src/pages/SignIn.tsx`, `web/src/pages/Start.tsx` (the `/start#t=` link handler), `web/src/styles/learn.css`, `web/src/portalImports.test.ts` (copy wiki's allowlist test with the same allowlist plus `lib/qr.ts`)
- Create: `learn/Dockerfile` + `learn/docker/{Caddyfile,entrypoint.sh}` (copy `kiosk/`'s static pattern, `config.js` with the API URL)
- Modify: `Procfile.dev` (`learn: npm --prefix learn run dev`), `deploy/stack/web/compose.yml`, `deploy/stack/build.yml`, `deploy/stack/proxy/Caddyfile` (`@learn host learn.{$STACK_DOMAIN}` → learn:8080), `deploy/stack/ss-stack` (`STACK_APPS` adds `learn`), `deploy/stack/api/compose.yml` (`SS_ALLOWED_ORIGINS` += `https://learn.…`, `SS_LEARN_ORIGIN`), `.env.example`, `deploy/tests/test_stack_config.py`
- Test: `learn/web/src/pages/SignIn.test.tsx`, `learn/web/src/lib/session.test.ts`

**Interfaces:**
- `session.ts`:
  - `getToken(): string | null`, `setToken(t: string, expiresAt: string)`, `clearToken()` (sessionStorage key `ss.learn.token`)
  - `learnFetch(path, init)` adds `Authorization: Learn <t>`, or falls back to the portal `apiFetch` when signed in by account
  - on a 401 it clears the token and goes to `/`
- `i18n.ts`:
  - `t(key: keyof typeof en, vars?)`, `useLang()`, `setLang(lang)` (localStorage `ss.learn.lang`)
  - sets `document.documentElement.dir = "rtl"` for `he`
  - every key exists in all four dictionaries (test)
- **`SignIn` page** (mockup screen 2):
  - `LoginScene` styling (light), a "Enter your learning code" heading, the six-box code input (paste fills all boxes; typing advances; backspace goes back), the "Last name" field and Continue
  - the error copy maps `learn_code_invalid` → "That code and last name don't match. Check your invite email." and `learn_code_locked` → "Too many tries. Wait a few minutes and try again." and `rate_limited` likewise
  - an "or" divider, then "Sign in with an account" (shows `@portal/pages/Login` inside the same shell), then the language links
- **`Start` page:** reads `#t=`, calls `/learn/auth/link`, then replaces the history entry (no token stays in the URL) and goes to `/training`.

- [ ] **Step 1:** Write the tests:
  - `SignIn.test.tsx`: paste fills boxes; submit posts the normalized code and last name; the error codes map to copy; the account link shows the portal Login
  - `session.test.ts`: token round trip; a 401 clears it
  - an i18n key parity test
  - `portalImports.test.ts`
- [ ] **Step 2:** Run `npm --prefix learn install` (copy the wiki's dependency set that the allowlisted portal modules need) and `npm --prefix learn test`. Confirm the new tests fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm --prefix learn test`, `npm --prefix learn run build` and `deploy/tests` pytest. Confirm PASS.
- [ ] **Step 5:** Commit `feat(learn): learn app scaffold, sign-in and deploy wiring`.

### Task 14: Learn app training, reading and signing, quiz, done screen

**Files:**
- Create: `learn/web/src/pages/{Training.tsx,Reader.tsx,Quiz.tsx,Done.tsx}`, `learn/web/src/components/{SignaturePad.tsx,ProgressBar.tsx,TaskRow.tsx}`
- Test: one `*.test.tsx` per page

**Behavior** (mockup screens 3–6; copy taken from the mockup):
- **Training:**
  - Shows "Hi <first name>", the initiative eyebrow, "N of M done · due <date>", a progress bar and task rows (done ✓ with "Signed <date>", next item highlighted, locked rows show a lock icon).
  - The button says "Continue: <title>".
  - With nothing assigned: "You're all caught up."
- **Reader:**
  - Header "k of n · v<version_no>".
  - The HTML goes in a scroll box (`dangerouslySetInnerHTML`; the server output is already sanitized and snapshotted).
  - A `fallback` banner: "This document isn't translated yet. You're reading the English version."
  - A `change_note` banner on new versions: "What changed: …".
  - Shows "Read to the end · m:ss" once scrolled and the minimum time is met.
  - The checkbox reads "I've read <title> and agree to follow it.", then the typed name field ("Type your full name to sign") or the `SignaturePad` (canvas, clear button, exports PNG base64).
  - "Sign and continue" stays enabled; tapping it early shows the inline reason (time left, scroll, agree, name).
  - A quiz document goes to Quiz first.
- **Quiz:**
  - One question per screen, single or multiple choice (from the `multiple` flag in Task 7's quiz GET), a progress bar, and "Check answer" moving to the next question.
  - The result screen shows the score. Pass goes back to the Reader's sign step. Fail shows "attempts left" or locked copy: "Your lead has been notified."
- **Done:**
  - "You're all set, <first name>", the QR code from `qrDataUrl(badge_uid)` (`@portal/lib/qr.ts`), and "Your time clock code. Scan it at the station when you clock in."
  - "Save to phone" downloads `serversherpa-timeclock-qr.png`.
  - The note: "We also emailed it to you. Don't share it: it clocks you in."
- Dark mode is not needed; it follows portal light tokens. RTL layout works under `dir=rtl` (logical CSS properties only).

- [ ] **Step 1:** Write the tests:
  - `Training` renders groups and the locked state
  - `Reader` enforces scroll and time before calling sign, shows the fallback banner, and sends a drawn signature as base64
  - `Quiz` grades through the API and shows locked copy
  - `Done` renders the QR and the download link
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm --prefix learn test && npm --prefix learn run build` and confirm PASS.
- [ ] **Step 5:** Commit `feat(learn): training, reader, quiz and done screens`.

### Task 15: Portal API client, nav, routes and the Learning dashboard

**Files:**
- Create: `portal/src/lib/learning.ts` (typed client for every `/learning/*` route and `/system/learning`; types mirror the API shapes above)
- Create: `portal/src/pages/learning/LearningDashboard.tsx`, `portal/src/styles/learning.css`
- Modify: `portal/src/layout/navSections.tsx` (new section `Learning`, placed after People, with items Dashboard `/learning` (end), Library, Packets, Assignment rules, Settings; `resource: 'learning'`; icons from the existing icon set), `portal/src/App.tsx` (routes under `ProtectedRoute resource="learning"`), `portal/src/lib/access.ts` (map `/learning` → `learning`; managers by `wiki:delete` are covered because `can()` on the client must mirror `is_manager`: add `canManageLearning(access)`)
- Test: `portal/src/pages/learning/LearningDashboard.test.tsx`, `portal/src/lib/learning.test.ts`

**Dashboard** (mockup view 4):
- stat tiles with funnel bars (Workers assigned, Opened invite, Fully signed off, Time clock overrides)
- the `segmented` range selector (7 days / 30 days / Quarter → 7/30/90)
- an "Initiatives at risk" card (percent ring, remind button → `POST /learning/initiatives/{id}/send` for the unfinished people)
- an "Expiring in the next 30 days" list that includes translation and hard-question rows
- Export runs the compliance report for everyone

- [ ] **Step 1:** Write the tests:
  - the dashboard renders API data, the range switch refetches, and Remind calls send
  - the nav shows Learning for a learning admin and for a wiki admin, and hides it for a worker
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, the portal styles guardrail suite (`src/styles`) and tsc. Confirm PASS.
- [ ] **Step 5:** Commit `feat(portal): learning nav and dashboard`.

### Task 16: Portal Library and Document pages

**Files:**
- Create: `portal/src/pages/learning/LearningLibrary.tsx`, `portal/src/pages/learning/LearningDocument.tsx`, `portal/src/components/learning/{DocumentRulesPanel.tsx,QuizEditor.tsx,TranslationsPanel.tsx,VersionsPanel.tsx,SignoffsPanel.tsx,NewDocumentModal.tsx,PublishModal.tsx}`
- Test: `LearningLibrary.test.tsx`, `LearningDocument.test.tsx`, one test per panel with logic (QuizEditor, TranslationsPanel)

**Behavior** (mockup view 2):
- **Library:** a standard list (title, version, published, packets, sign-offs, translation chips), search, and New document (a modal with a wiki page picker from `/learning/wiki-pages` and a title).
- **Document page:**
  - Header chips: "v4 published" / "Not published", plus "Preview as worker" (opens the learn app URL `?preview=<version>`; render the preview inside the portal instead if the learn app can't authenticate a manager; use a modal with the HTML at phone width plus a language select). Also "Edit in wiki" (external link to the page) and "Publish vN" (PublishModal with the change note).
  - Tabs `?tab=`: Content and rules | Quiz | Translations | Versions | Sign-offs.
  - **Content and rules:** two columns, rendered HTML on the left and the rules panel on the right.
    - Validity select (Never, 30 days, 90 days, 6 months = 182, 1 year = 365, Custom days).
    - The re-sign rule as two option cards with the mockup's copy.
    - Sign style segmented control, scroll-to-end and minimum reading time toggles (with seconds), and the quiz toggle.
    - Autosaves with a toast.
  - **Quiz:** questions list, add/edit modal (prompt, choices, mark correct), pass percent, max attempts and failure action.
  - **Translations:** a row per configured language with status chip, Translate draft, Edit (modal with title + HTML textarea and a preview), Submit for review and Approve.
  - **Versions:** a list with the change note, who and when, and a sign-off count; clicking a row shows its HTML.
  - **Sign-offs:** a paged list.

- [ ] **Step 1:** Write the tests:
  - the library list and create flow
  - rule panel changes PATCH the right fields
  - re-sign option cards
  - the publish modal sends the note
  - quiz editor validation (≥ 2 choices, one correct)
  - translations status chips including out of date, and Approve hidden for the last editor
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, `src/styles` and tsc. Confirm PASS.
- [ ] **Step 5:** Commit `feat(portal): learning library and document pages`.

### Task 17: Portal Packets and Assignment rules pages

**Files:**
- Create: `portal/src/pages/learning/LearningPackets.tsx`, `portal/src/pages/learning/LearningRules.tsx`, `portal/src/components/learning/{PacketEditor.tsx,RuleEditorModal.tsx,DryRunPanel.tsx}`
- Test: tests for each page and for `DryRunPanel`

**Behavior** (mockup view 3):
- **Packets:** a list plus an editor (name, description, ordered documents with drag or up/down, enforce order, due offset, Copy, Archive).
- **Rules:**
  - Rule rows: grip, the condition tokens "When <field> is <values> → <packet>", an On/Off chip and an actions menu.
  - Drag or up/down reorder calls `/reorder`.
  - The New rule modal has a field picker with value pickers: initiative, client, site, partner and person use the existing ComboBox searches; country uses the country list; worker role uses work types.
- **Dry run:** pick an initiative, then see summary tiles (Workers checked / Documents to assign / Already valid, skipped / No email on file) and the per-row table. Download summary is CSV; "Assign and schedule invites" calls apply.

- [ ] **Step 1:** Write the tests:
  - packet editor ordering and save
  - the rule modal builds `conditions`
  - reorder posts ids
  - dry run renders totals and rows, and apply posts `apply=true`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, styles and tsc. Confirm PASS.
- [ ] **Step 5:** Commit `feat(portal): learning packets and rules`.

### Task 18: Initiative Learning tab and timeline marker

**Files:**
- Create: `portal/src/components/learning/InitiativeLearningTab.tsx`, `portal/src/components/learning/{ScheduleModal.tsx,LearningTimeline.tsx,LearningRoster.tsx}`
- Modify: `portal/src/pages/InitiativeDetail.tsx` (replace the Learning placeholder panel with `<InitiativeLearningTab initiativeId canChange />`; show the tab only to managers, and to workers:view holders as read-only), `portal/src/pages/InitiativeTimeline.tsx` (draw a marker at `learning_send_at`)
- Test: `InitiativeLearningTab.test.tsx`, an update to `InitiativeDetail.test.tsx` (the placeholder test becomes "Learning tab renders the learning panel"), `InitiativeTimeline.test.tsx` marker test

**Behavior** (mockup view 1 content, inside the tab):
- stat tiles (Invited / Opened / In progress / Complete / Overdue, with sub-lines)
- **"Invites and reminders" card:** the mini timeline from `timeline`, key/values (Invites, Reminders, Due, Codes expire, Late adds), and Edit schedule (ScheduleModal: manual or scheduled, days before + time, reminder days chips, due days, late adds toggle; defaults from settings)
- **"What this initiative requires" card:** packets with the rule source and an "Every initiative" chip, extras with Assign (manual assign modal using person search and a packet/document pick), and Preview rules (dry run panel)
- **Workers roster:** a segmented filter (All / Overdue / In progress / Not opened / Complete), search, columns (Worker, Partner, Language, Progress, Status, Last activity, actions)
  - per row: Resend / Regenerate code / Revoke / View history
  - selected rows: Resend to selected
- **Header actions inside the tab:** "Send invites now" (confirm modal showing the counts) and "Compliance report" (runs the report for this initiative), plus "Print code sheet"

- [ ] **Step 1:** Write the tests:
  - renders stats and schedule
  - Send now confirms then posts
  - the roster filter refetches with `status=`
  - Resend on a row posts `person_ids`
  - the schedule modal validates and PUTs
  - the timeline marker appears when `learning_send_at` is set
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, `InitiativeDetail.test.tsx`, styles and tsc. Confirm PASS.
- [ ] **Step 5:** Commit `feat(portal): initiative learning tab`.

### Task 19: Worker learning history, certificates, Learning settings, Reports type

**Files:**
- Create: `portal/src/components/learning/LearningHistoryPanel.tsx`, `portal/src/pages/learning/LearningSettings.tsx`, `portal/src/components/reports/LearningComplianceOptions.tsx`
- Modify: `portal/src/pages/WorkerDetail.tsx` (add `LearningHistoryPanel` after `CertsPanel`), `portal/src/components/workers/CertsPanel.tsx` (show a "Learning" chip on `source === 'learning'` rows plus a "Certificate" link to the PDF), `portal/src/pages/Reports.tsx` (`TYPE_LABELS.learning_compliance = 'Learning compliance'`), `GenerateReportModal.tsx` / `EditDefinitionModal.tsx` (wire the options like `isTimesheet`); API `CertItem` gains `source` and `learning_initiative_id` (small change in `routes/workers.py` + schema, with a test there)
- Test: tests for the history panel, settings page (validation + PUT) and report options

**Settings page sections** (pf-form):
- Sign-in codes: max failures, lockout seconds, per-IP limit and window, global limit, general code days (blank = no limit)
- Defaults: validity, invite days and time, reminder days, due days
- Email text: template × language subject + intro, with "Reset to default"
- Languages offered
- Branding line
- Retention: "Keep sign-off records for N days" (blank = keep)

- [ ] **Step 1:** Write the tests.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, the workers route tests, styles and tsc. Confirm PASS.
- [ ] **Step 5:** Commit `feat(portal): learning history, settings and compliance report type`.

### Task 20: Kiosk web and laptop time clock learning step

**Files:**
- Modify: `kiosk/src/timeclock/flow.ts` (new step `'learning'` entered after `confirmYes` when `status.learning` is set and the person is about to clock in; actions `learningOverride(overrideId)`, `learningCancel`, `learningLinkSent`), `kiosk/src/timeclock/TimeclockFlow.tsx`, `kiosk/src/timeclock/backend.ts` + `stationApi.ts` (`learningLink(personId)`, `learningOverride(body)`, clock-in passes `learning_override_id`)
- Create: `kiosk/src/timeclock/screens/LearningWarning.tsx`, `kiosk/src/timeclock/screens/LearningOverrideModal.tsx`
- Test: `kiosk/src/timeclock/flow.test.ts` additions, `LearningWarning.test.tsx`, `LearningOverrideModal.test.tsx`

**Behavior** (mockup view 6):
- **Warning screen:**
  - The person card, then "<n> required items aren't signed yet" with the list and a kind label per item ("Required for this move" / "Extra").
  - The line "You can finish them on your phone in a few minutes."
  - Buttons: Email me the link (shown only when `link_email`; after sending it shows "Link sent to your email"), Cancel punch (reset) and Admin override.
- **Override modal:**
  - Admin email, password, a 2FA code field shown after a `totp_required` response, reason chips (Signing on break / Signed on paper / No phone / Other + text), and the covers choice (This punch only / Rest of today).
  - Buttons: Back, and "Override and clock in", which overrides and then clocks in with `learning_override_id`.
  - Errors map to copy (wrong credentials, not an admin, locked).
- The idle timer still returns to Welcome, and the busy guard prevents double punches.
- Clock-out never shows the warning.

- [ ] **Step 1:** Write the tests:
  - the reducer enters `learning` only for clock-in with outstanding items
  - Cancel resets
  - override then clock-in sends the id
  - "Email me the link" is hidden without `link_email`
  - the modal asks for 2FA on `totp_required`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm --prefix kiosk test`, `npm --prefix kiosk exec tsc -- --noEmit` and the edge tests. Confirm PASS.
- [ ] **Step 5:** Commit `feat(kiosk): learning warning and admin override at the time clock`.

### Task 21: Seed the dev wiki, live verify, docs

Done by the controller, not a subagent.

- [ ] Back up, then upgrade the dev DB to 0109 (`api/.venv/bin/alembic upgrade head` from the main checkout with the dev `.env`).
- [ ] Run `serversherpa learning-seed --actor-email jhenderson@encondata.com` with the wiki render server on 5177.
- [ ] Restart the API, notification worker, portal and kiosk dev servers as the memories describe, and start learn on 5179.
- [ ] **Live checks:**
  - add a worker to the NAP11 demo and see the assignments
  - send invites and see the Mailpit message with the link and code
  - sign in on the learn app by link and by code, read, sign, take the quiz and finish; see the QR email, the cert, the notification and the report
  - time clock station: scan an unfinished worker and see the warning, then override
- [ ] Update the README (`learn/` dev instructions), the Harbor Master design page "Implementation notes", the Features wiki row and memory. The parity sheet stays as Jimmy said (skip until asked).
