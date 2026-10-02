# Saved Custom (SSH) Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add, edit, remove and reuse Custom (SSH) targets from the Deploy page. They are stored in `sirdar/config/deploy-targets.env`, a separate env file the container can write.

**Spec:** `docs/superpowers/specs/2026-10-01-sirdar-groundwork-design.md`, section "Addendum (2026-10-01): saved Custom (SSH) targets". Earlier Deploy addenda define the existing behavior: TOFU, connect, cards without details, region picker and Custom type. Read them first.

## Global Constraints
- **Where to work:** only in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`).
- **Things to leave alone:**
  - Never cd into the main checkout.
  - Never run a bare `git stash`.
  - Never run `npm install` in `portal/`.
  - Never touch `serversherpa-dev`, the dev sirdar-db data, or ports 5434/8097/8098.
- **Testing:** TDD. Run the suites in the foreground:
  - `cd sirdar/api && .venv/bin/pytest -q`
  - `npm --prefix sirdar/web test`
  - `cd sirdar/web && npx tsc -p tsconfig.json --noEmit`
- **Commits:** end each commit message with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Secrets:**
  - Passwords and passphrases are never returned, logged or audited.
  - The API exposes only `password_set` and `passphrase_set` booleans.
  - Tests must assert that secret strings are absent from every response body.
- **Target cards** show no connection details: no host, user, port or region.
- **API conventions:** error bodies are `{"detail": {"code": …}}`, and routes live under `/api`.
- **Permissions:** viewing targets needs `deploy:view`; add, edit, remove, key-file listing and trust need `deploy:change`; connect needs `deploy:add`.
- **Copy:** American English and portal UI idioms. Modals use the header pattern (eyebrow / title / description), are sized to content, use ComboBox for pickers and the `pf-form` inputs, and close with Escape.

---

### Task A: API — targets file store, CRUD routes, connect/trust integration

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/ssh_targets.py` (the store)
- Modify:
  - `config.py`: `deploy_targets_file: str = "/app/config/deploy-targets.env"`
  - `deploy/targets.py`: listing includes the installer target plus saved targets
  - `deploy/ssh.py`: connect takes an `SshTargetConfig` (host, port, user, password, key_file, passphrase) rather than reading settings directly; the installer target builds one from settings
  - `api/routes/deploy.py`: the new routes; connect/trust accept the `ssh:<slug>` ids
- Tests: `tests/test_deploy_ssh_targets_store.py`, `tests/test_deploy_ssh_targets_api.py`, plus updates to existing deploy tests

**Requirements:**
1. **Store:**
   - **Reading:** `load() -> list[SavedSshTarget]`, `get(slug)`. A missing file is an empty list.
   - **Writing:** `add(fields) -> SavedSshTarget`, `update(slug, fields)` and `remove(slug)`.
     - Each takes an exclusive `fcntl.flock` on `<file>.lock` and rewrites the whole file atomically: temp file in the same directory, `os.replace`, mode 600.
     - Lines not belonging to `SIRDAR_SSH_*` keys are preserved, including comments.
   - **Format:** exactly as the spec describes.
     - Values are single-quoted, and embedded single quotes are escaped as `'\''`.
     - The parser accepts unquoted, single-quoted and double-quoted values.
     - Values containing newline or NUL are rejected with `ValueError`, which the route turns into a 422.
   - **Slug:** derived from the name (lowercase, `[a-z0-9-]`, collapsed hyphens, trimmed, at most 32 characters, fallback `target`), made unique with `-2`, `-3`, and so on. `KEY` is the slug uppercased with `-` → `_`. The slug never changes on rename.
   - **Validation, raised as `TargetError(code)`:**

     | Code | Rule |
     |---|---|
     | `name_invalid` | name is 2–40 characters after trim |
     | `host_invalid` | host is a valid IPv4 or IPv6 address (`ipaddress`), or a hostname (RFC 1123 labels, at most 253 characters) |
     | `port_invalid` | port is 1–65535 |
     | `user_invalid` | user is 1–64 characters of `[A-Za-z0-9._-]` |
     | `key_file_invalid` | `key_path` is a bare file name with no `/`, `\` or `..`, and no leading `.` |
     | `key_file_not_found` | the key file doesn't exist in `deploy_keys_dir` |
     | `auth_required` | after applying an update, neither a password nor a key file is set |
     | `name_taken` | the name duplicates another target's name, case-insensitive |
2. **Routes** (under `/api/deploy`):

   | Method + path | Permission | Behavior |
   |---|---|---|
   | `GET /ssh-targets/{slug}` | change | `{slug, name, host, port, user, key_path, password_set, passphrase_set}` |
   | `POST /ssh-targets` | change | 201 with the same shape |
   | `PUT /ssh-targets/{slug}` | change | partial update; for `password` and `key_passphrase`, omitted keeps the value, `""` clears it, any other value sets it |
   | `DELETE /ssh-targets/{slug}` | change | 204 |
   | `GET /key-files` | change | `{files: [names]}`: regular files in `deploy_keys_dir` excluding dotfiles, name-sorted |

   - An unknown slug returns 404 `target_not_found`.
   - Store validation codes return 422.
   - A file write failure (`OSError`) returns 500 `{code: "targets_file_unwritable"}` with a fixed message and no path details.
   - Audit `deploy.target_add`, `deploy.target_update` and `deploy.target_remove` with non-secret fields only. For updates, list which fields changed.
3. **`GET /targets`:**
   - **Order:** `aws`, `gcp`, `digitalocean`, then the installer target (`{id: "ssh", label: "Custom (SSH) · Installer", kind: "ssh", source: "installer", available: true, configured}`), included only when any `SIRDAR_DEPLOY_SSH_*` value is set, then the saved targets in file order (`{id: "ssh:<slug>", label: <name>, kind: "ssh", source: "saved", available: true, configured: true}`).
   - Add `kind` to every item: `"aws"`, `"gcp"`, `"digitalocean"` or `"ssh"`.
   - Keep the guarantee that no host, user, port or region appears in this response.
   - Also return `can_add_ssh: true` when the targets file's directory exists and is writable. Otherwise return false with `ssh_store_hint: "deploy-targets.env isn't writable; see the README."`
4. **Connect and trust:**
   - `POST /connect` accepts `target` values `ssh` or `ssh:<slug>` and returns 400 `target_not_configured` for an unknown slug.
   - SSH connects use the target's config.
   - Trust and forget accept any host:port that belongs to a configured SSH target. Otherwise they return 400 `not_configured_host`.
   - The audit records the target id.
   - All existing TOFU behavior is unchanged.
5. **Tests:**
   - **Store round-trip:** quoting of tricky values (`'`, `$`, spaces, `#`), preservation of foreign lines, slug collisions, an atomic rewrite with no leftover temp files, concurrent adds under the lock (threads), and newline rejection.
   - **Routes:** each route, permissions (admin is view only), secret guards, partial-update semantics, `auth_required` after clearing the password with no key file, `key_file_not_found`, and the installer target staying read-only (PUT or DELETE on `ssh` returns 404 or 409 consistently; choose 404 `target_not_found`).
   - **End to end:** the full connect plus TOFU flow against the existing in-process asyncssh server, using a saved target.

### Task B: Web — Add/Edit/Remove SSH targets on the Deploy page

**Files:**
- Create: `sirdar/web/src/components/SshTargetModal.tsx`
- Modify: `pages/Deploy.tsx`, `lib/sirdarApi.ts`
- Tests: `components/SshTargetModal.test.tsx` and additions to `pages/Deploy.test.tsx`

**Requirements:**
1. **Target cards:**
   - Cards render from the API list. A saved SSH card shows its name; the installer card shows "Custom (SSH) · Installer".
   - A final "+ Add SSH target" card appears only when the user has `deploy:change` and `can_add_ssh` is true.
   - When `can_add_ssh` is false and the user has `deploy:change`, show a muted note with the hint instead.
   - Keyboard: the add card is a button, not a radio.
2. **Saved SSH target selected:** show "Edit" and "Remove" `mini-btn`s near the cards (deploy:change only).
   - Remove asks for confirmation with "Remove <name>? Its saved password and key settings are deleted. Trusted host keys stay until you forget them." After DELETE it refreshes and clears the selection.
   - The installer target never shows Edit or Remove. Instead, show the small note "Edit this target in sirdar/.env."
3. **`SshTargetModal`:**
   - **Header:** eyebrow "Deploy", title "Add SSH target" or "Edit SSH target", description "Saved to deploy-targets.env on the Sirdar host. Passwords and passphrases are write-only."
   - **Fields:**
     - Name, Host, Port (default 22) and User.
     - **Authentication:**
       - **Password:** on add, a password input. On edit, show "Password: set" with "Replace" and "Clear" buttons, or "not set" with "Add". This produces the PUT semantics: omit, `""` or a value.
       - **Key file:** a ComboBox of `GET /key-files` names with a "None" option. Next to it, hint text: "Put key files in sirdar/deploy-keys/ on the Sirdar host (chmod 600)."
       - **Key passphrase:** same write-only pattern as the password, shown only when a key file is chosen.
   - **Client validation** mirrors the API: required fields, port range, name length, and "add a password or a key file".
   - **Saving:**
     - Save calls POST or PUT. Errors map to inline field messages per code: `name_invalid`, `host_invalid`, `port_invalid`, `user_invalid`, `key_file_invalid`, `key_file_not_found`, `auth_required`, `name_taken`, `targets_file_unwritable`.
     - On success, close the modal, refresh the targets, and select the new or edited target.
   - **Interaction:** Escape and Cancel close the modal; both are disabled while saving. Focus moves to the first field on open.
4. **Connect** works with the selected `ssh:<slug>` id. All existing flows (trust modal, mismatch, results, Custom type name, DigitalOcean region) are unchanged.
5. **Tests** (jsdom, mocked API):
   - The add card is gated by `can('deploy','change')` and `can_add_ssh`.
   - The add modal validates input, sends the correct POST body, and selects the new target.
   - Edit loads the fields and shows "Password: set". Replace, Clear and omit produce the right PUT bodies.
   - Remove confirms, then sends DELETE.
   - The installer target has no Edit or Remove.
   - Secrets are never prefilled.

### Task C: Compose, installer, docs
**Files:** `sirdar/docker-compose.yml`, `sirdar/install.sh`, `sirdar/.gitignore`, `sirdar/README.md`, `sirdar/scripts/dev-env.sh`, `sirdar/config/.gitkeep`

**Requirements:**
1. **Compose:** mount `./config:/app/config` read-write on the `sirdar` service, and pin `SIRDAR_DEPLOY_TARGETS_FILE=/app/config/deploy-targets.env` in `environment`.
2. **Installer** (every run, idempotent):
   - Create `<dir>/sirdar/config` and ensure it is owned by uid and gid 10001 with mode 700 so the container can write it. Use `as_root chown 10001:10001` when not already owned; on macOS, use the numeric chown under sudo.
   - If `deploy-targets.env` exists, ensure it is owned by 10001 with mode 600. Don't create it; the app creates it.
   - If chown isn't possible, warn that adding SSH targets on the page won't work until the folder is writable by uid 10001.
   - The summary line reads "Saved SSH targets: <dir>/sirdar/config/deploy-targets.env".
3. **`.gitignore`:** ignore `config/*` but keep `config/.gitkeep`.
4. **`dev-env.sh`:** add `SIRDAR_DEPLOY_TARGETS_FILE=<abs path>/sirdar/config/deploy-targets.env` for local dev, where the API runs on the host. Keep its existing values otherwise.
5. **README:** add a "Saved SSH targets" section covering where they live, the format (briefly), the rule that secrets are write-only, backing up `config/` together with `.env`, the uid 10001 ownership, and editing by hand (allowed; Sirdar reads the file on each use).
6. **Verify:**
   - `bash -n` and `shellcheck` pass.
   - Run the install function tests through `SIRDAR_INSTALL_LIB`: config dir creation, mode, and a chown attempt stubbed through `as_root`.
   - `docker compose config` shows the mount and the environment pin.

### Task D: Live verification (controller)
1. Run Sirdar from the worktree with the temp `-wt` launch entries and `dev-env.sh` set for local dev (with a backup).
2. Start the openssh test container on `127.0.0.1:2299`.
3. In the browser:
   - add a target with a password;
   - its card shows only the name;
   - Test connection → trust → results;
   - edit the target: rename it, keep the password, and see "Password: set";
   - remove it.
4. Confirm the file contents are well formed, the mode is 600, and no secrets appear in the UI.
5. Clean up.
