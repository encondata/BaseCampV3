# Encrypted DB Backups (Dev → Database) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Tab the /dev/database page into Reconcile + Backups; Backups creates a password-encrypted SQL dump (download + saved to Spaces), and lists existing backups (date/size/creator) with download/delete.

**Architecture:** New `db_backups` metadata table (migration 0029). Devtools router grows 4 endpoints; the dump comes from the `pg_dump` binary, is encrypted server-side in an **OpenSSL-compatible envelope** (AES-256-CBC, PBKDF2-SHA256 10000 iters, `Salted__` header) keyed by the requesting user's account password (verified against their stored hash first), stored via the existing Spaces service, downloaded via presigned URLs. Portal converts DevDatabase.tsx to the sysconf-tab pattern.

**Tech Stack:** existing + new dependency `cryptography>=42` (api).

## Global Constraints

- The encryption password is the CALLER'S OWN account password: the create endpoint takes `{password}`, verifies it with `verify_password(account.password_hash, password, pepper=settings.password_pepper.get_secret_value())` (see `services/auth.py:83`), and returns 403 `{"code": "invalid_password"}` on mismatch. The password is never stored or logged; audit `changes` must never contain it.
- Encrypted format must decrypt with stock OpenSSL: `openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -in <file> -out backup.sql` — i.e. header `Salted__` + 8-byte random salt; key(32)+iv(16) = PBKDF2-HMAC-SHA256(password, salt, iterations=10000, dklen=48); AES-256-CBC with PKCS7 padding. Iteration count MUST be 10000 (OpenSSL's `-pbkdf2` default) so no `-iter` flag is needed.
- Dump: `pg_dump --no-owner --no-privileges` plain format against `settings.database_url` (convert the SQLAlchemy URL to libpq form; pass password via `PGPASSWORD` env, never argv). Resolve the binary with `shutil.which("pg_dump")` then fallbacks `/opt/homebrew/opt/libpq/bin/pg_dump`, `/usr/local/bin/pg_dump`, `/usr/bin/pg_dump`; missing → 500 `{"code": "pg_dump_unavailable"}`. Run via `asyncio.create_subprocess_exec`, capture stdout bytes.
- Storage key: `backups/<uuid>.sql.enc`; filename shown to users: `serversherpa_backup_YYYYMMDD_HHMMSS.sql.enc` (UTC). Presigned download must set `ResponseContentDisposition` = `attachment; filename="<filename>"` (extend `presign_get` with an optional `download_filename` param rather than a parallel helper).
- All endpoints gate `require_permission("devtools", ...)` (view for list/download, change for create/delete). Audit entity_type `"system"`, actions `backup.create` / `backup.delete`, changes carrying filename+size only.
- Tests FOREGROUND, one continuous run, timeout 600000ms. `api/.venv/bin/python` for everything.
- Storage in tests: do NOT hit real MinIO — monkeypatch the storage functions (`put_object`/`get_object`/`delete_object`/`presign_get`) in the route module with in-memory fakes, same as any existing storage-mocking test does (grep tests for `put_object` to copy the fixture style).

---

### Task 1: API — migration 0029 + backup service + devtools endpoints

**Files:**
- Modify: `api/pyproject.toml` (add `"cryptography>=42",` to dependencies; then `api/.venv/bin/pip install -e '.[dev]'` — quiet, foreground)
- Create: `api/migrations/versions/0029_db_backups.py`
- Modify: `api/src/serversherpa/db/models.py` (append `DbBackup`)
- Create: `api/src/serversherpa/services/db_backup.py`
- Modify: `api/src/serversherpa/services/storage.py` (add `delete_object(key)`; add optional `download_filename` param to `presign_get`)
- Modify: `api/src/serversherpa/api/routes/devtools.py` (4 endpoints)
- Modify: `api/src/serversherpa/api/schemas.py` (`DbBackupItem`, `DbBackupCreateIn`)
- Test: `api/tests/test_db_backups.py`

**Interfaces (produces):**
- Table `db_backups`: `id uuid pk default gen_random_uuid()`, `filename text NOT NULL`, `storage_key text NOT NULL`, `size_bytes bigint NOT NULL`, `created_by uuid NULL FK people ON DELETE SET NULL`, `created_at timestamptz NOT NULL default now()`. Migration 0029 (down_revision 0028), full downgrade.
- `services/db_backup.py`:
  ```python
  def encrypt_openssl(data: bytes, password: str) -> bytes  # Salted__ envelope per Global Constraints
  def decrypt_openssl(blob: bytes, password: str) -> bytes  # inverse; used by tests
  async def run_pg_dump(database_url: str) -> bytes         # raises PgDumpUnavailable / PgDumpFailed
  ```
- Endpoints (devtools router, existing prefix):
  | Method + path | Gate | Behavior |
  |---|---|---|
  | `GET /devtools/backups` | devtools:view | `list[DbBackupItem]` newest first; `created_by_name` resolved |
  | `POST /devtools/backups` body `{password: str}` | devtools:change | verify caller's password (403 `invalid_password`); pg_dump → encrypt → `put_object` (`application/octet-stream`) → insert row → audit `backup.create` → return `DbBackupItem` with `download_url` (presigned w/ attachment disposition) |
  | `GET /devtools/backups/{id}/download` | devtools:view | 404 `not_found`; returns `{"url": <presigned>}` |
  | `DELETE /devtools/backups/{id}` | devtools:change | delete object (ignore storage NoSuchKey), delete row, audit `backup.delete`, 204 |
- `DbBackupItem`: `id, filename, size_bytes, created_at, created_by, created_by_name (str|None), download_url (str|None = None)`.

**Steps:**
- [ ] TDD the crypto round-trip pure functions first: encrypt→decrypt round-trips; envelope starts with `b"Salted__"`; wrong password raises (padding error → raise `ValueError("bad_password_or_corrupt")`). If `openssl` binary exists on the host (`shutil.which`), ALSO assert `openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -pass pass:<pw>` decrypts a sample (subprocess; skip test if binary missing).
- [ ] Endpoint tests with storage monkeypatched to an in-memory dict and `run_pg_dump` monkeypatched to return `b"-- fake dump\n"`: create with wrong password → 403; create with right password (seeded_user's known test password — see `tests/test_assets_api.py` login helper for the password used) → 200, item listed, stored blob decrypts back to the fake dump with that password; list shows creator name; download returns url; delete removes row + object; devtools gate: staff/worker → 403 (copy an existing devtools gate test).
- [ ] Migration + model + service + endpoints; `alembic upgrade head` on dev DB.
- [ ] Focused tests pass → FULL api suite foreground (timeout 600000) → commit `feat(api): encrypted DB backups — pg_dump + OpenSSL-compatible envelope, Spaces storage, devtools endpoints` (body ends with the Claude Fable trailer).

---

### Task 2: Portal — tabbed DevDatabase + Backups UI

**Files:**
- Modify: `portal/src/pages/DevDatabase.tsx` (tab shell: `Reconcile` | `Backups`; existing content becomes the Reconcile tab UNCHANGED — wrap, don't rewrite)
- Modify: `portal/src/lib/api.ts` (`DbBackupItem` iface + `listDbBackups`, `createDbBackup(password)`, `getDbBackupDownload(id)`, `deleteDbBackup(id)`)
- Test: extend nothing new is required beyond tsc/suite/build; add a small pure test ONLY if you extract a helper worth testing.

**Backups tab spec:**
- Tab bar: `.sysconf-tabbar`/`.sysconf-tab` pattern (see `portal/src/pages/SystemConfig.tsx`), default tab Reconcile.
- Create card (top, `.init-panel`): explanation line ("Creates a full SQL dump encrypted with your account password. Keep the password — the file cannot be decrypted without it."), a password input (`type="password"`, autocomplete="current-password", labeled "Your account password"), and a `.btn-solid` "Create encrypted backup" button; disabled while running with "Backing up…" label. On success: refresh the list AND trigger the download by creating a temporary `<a href={download_url}>` and clicking it. Errors via `.pf-error` (`invalid_password` → "That password doesn't match your account."; `pg_dump_unavailable` → "pg_dump isn't installed on the server."). Below the button, a muted mono hint with the decrypt command: `openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -in <file> -out backup.sql`.
- List (`.dir-list` lite, like the page's existing lists): columns Filename · Created (longDate + relativeTime tooltip) · Size (human: KB/MB with one decimal) · Creator · actions Download (`mini-btn sm`; fetches `getDbBackupDownload` then anchor-click) and Delete (`mini-btn sm danger`; `confirm()` "Delete backup <filename>? This cannot be undone." then delete + refresh). Empty state: "No backups yet."
- Everything gated exactly as the page already is (route is devtools/god); use `can('devtools','change')` to show Create/Delete, view-only otherwise.

**Steps:**
- [ ] Implement; `npx tsc --noEmit` clean; FULL portal suite + build foreground.
- [ ] Commit `feat(portal): Dev → Database tabs — Reconcile + encrypted Backups (create, download, delete)` (Claude Fable trailer).

---

### Task 3: Verification (orchestrator)
- [ ] Browser: create a backup with the dev password, confirm the download lands and the list row appears; decrypt the downloaded file with openssl locally and sanity-check the SQL; delete flow; wrong-password error; both tabs render; dark theme spot-check.
- [ ] Full suites; ledger.
