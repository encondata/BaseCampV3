# Sirdar phase 8a (fresh start: the first super admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An environment that starts empty gets its first super admin from Sirdar, end to end:

- ServerSherpa's `serversherpa bootstrap-admin` gains `--role`, `--password-stdin`, `--invite` and `--link-minutes`, checks the password against the environment's own policy (clear exit codes), and queues one of two new emails through the existing outbox: **"Your ServerSherpa account is ready"** with a change-password link (typed password) or with a set-password link (invite). No password ever goes in an email.
- Sirdar stores the first admin on the environment (migration **0011**; a typed password vault-encrypted, cleared once used), and the first deploy of an unseeded environment runs a new step **11 "Create the first admin"** right after Start services, with the password on stdin only.
- The API takes `first_admin` on create (and `PUT …/first-admin` to fix it before it is used); every new error code has copy in the web client.

**Architecture:**

- ServerSherpa (`api/`): the rules live in a new service, `services/first_admin.py` (`create_admin`), which reuses one token issuer extracted from `services/password_reset.py` (`issue_token`) and one length rule extracted from `services/password_policy.py` (`length_problem`). `cli.py`'s `bootstrap_admin` only parses flags, reads stdin and maps `FirstAdminError` codes to exit codes.
- Sirdar: `deploy/first_admins.py` owns the record (`environment_first_admins`), its validation, the step's extra vars and the exit-code copy. `steps.plan_for(..., first_admin=True)` inserts step 11 after `up` in every Update plan (SSH, VM, DigitalOcean). `ansible/first_admin.yml` calls the new `ss-stack admin <env-dir> …` command, which runs `serversherpa bootstrap-admin` inside the running api container; the password reaches it as the command module's stdin and the task is `no_log`.
- The password is checked twice: by Sirdar at create (the ServerSherpa default, mirrored in `services/portal_policy.py` and pinned by `test_portal_compat.py`), and by the environment's own command at deploy (the authority). A refusal at deploy fails step 11 with Sirdar's copy; `PUT /environments/{name}/first-admin` sets a new password or switches to an invite, then Retry.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async, Alembic (raw SQL), Typer, Jinja2 mail templates, Ansible, bash (`ss-stack`), pytest on real Postgres; React 18 + TypeScript (types and copy only in 8a).

**Spec:** `docs/superpowers/specs/2026-10-07-sirdar-deploy-flow-design.md` §3 "Fresh start" and the "First super admin" decision. Phase-7 decisions (`docs/superpowers/plans/2026-10-05-sirdar-phase7-context.md`) still bind.

## Global Constraints

**Where and how to work**

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it.
- `sirdar` is both a branch and a folder: use `--` in `git diff` and `git log` (`git log -- sirdar/`).
- Other agents commit in this worktree at the same time: `git add` only your task's files (see "File ownership"); never `git add -A`, never bare `git stash`; retry when `.git/index.lock` is busy. Never `git checkout --` a file another task owns. If a file this plan edits changed since it was written, apply the same edit to the new text and keep their change.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**House rules**

- American English in all copy, comments and docs ("Canceled" for `cancelled`).
- Every new modal (none in 8a) gets the report-generate header and sizes to its content; step titles in flows use the same header style.
- Reuse the portal idioms (`ComboBox`, segmented radio groups, chips, `.pf-form`). **Never a raw `<select>`.**
- **Secrets never appear in a response, a log line, an audit row, an exception message, a `repr()`, a stored step log, or any process's argv or environment.** In 8a that means the first admin's typed password, the reset token, and every existing secret.
- Never use `AVNS_`-prefixed fake passwords in tests or fixtures (they look like real DigitalOcean database passwords to scanners).
- **Never invent password rules.** The only bar is the ServerSherpa API's own: `password_min_length` (`SS_PASSWORD_MIN_LENGTH`, default 8) for new accounts, plus the reuse rule for existing ones. Sirdar mirrors the default and pins it; it adds no rule of its own (no maximum beyond the transport's 1024-character field limit, no character classes).

**ServerSherpa API tests** (Tasks 1–3)

- Once per worktree, before the first API test: `ln -s /Users/jrh1812/Developer/BaseCampV3/api/.venv api/.venv` (the worktree's root `.env` is already a symlink to the main checkout's).
- Run from `api/` in the worktree, with this worktree's sources first and a per-task database whose name **must start with `serversherpa_test`** (conftest refuses anything else): `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_p8aN .venv/bin/pytest -q tests/<file>` (N = the task number). The first run creates and migrates the database (a few minutes).
- When the task is done, drop it: `PGPASSWORD=postgres dropdb -w -h 127.0.0.1 -p 5432 -U postgres --if-exists serversherpa_test_p8aN` (if the dev Postgres uses another user, read it from the root `.env`'s `SS_DATABASE_URL`; never touch `serversherpa` or `serversherpa_test`).
- Lint: `api/.venv/bin/ruff check --select E,F,W <files>` from `api/`.

**Sirdar tests** (Tasks 4–7)

- Sirdar's dev database must be up (from the main checkout: `docker compose -f docker-compose.dev.yml up -d sirdar-db`, Postgres on 127.0.0.1:5434).
- Run from `sirdar/api` with this task's own DB: `SIRDAR_TEST_DB=sirdar_test_p8aN .venv/bin/pytest -q tests/<file>`. Never the dev `sirdar` DB; run test files in the foreground with a long timeout (600000 ms); never background a suite. Implementers run focused files; the controller runs the whole suite (about 22 minutes).
- When the task is done, drop its DBs: `PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8aN` and the same for `sirdar_test_p8aN_source`.
- Lint: `.venv/bin/ruff check --select E,F,W --ignore F811 <files>` from `sirdar/api`.
- Deploy-stack suite (Task 5 only): from the worktree root, `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests`; also `bash -n deploy/stack/ss-stack`.

**Web** (Task 8)

- `npm --prefix sirdar/web test -- <path>`; type-check and build: `npm --prefix sirdar/web run build`. Never `npm install`.
- The copy scanner (`src/lib/sirdarApi.test.ts`, "every error code the deploy routes can return has its own message") must stay green: every new code in this plan's table gets copy in `MESSAGES`, and the new module `deploy/first_admins.py` joins the scanner's file list.

**Migration number**

- **0011** (`revision = "0011"`, `down_revision = "0010"`). Task 4 Step 1 checks every worktree and the dev DB first (`grep -l "revision = \"0011\"" .claude/worktrees/*/sirdar/api/migrations/versions/* sirdar/api/migrations/versions/*` from the main checkout, and `SELECT version_num FROM alembic_version` on the dev `sirdar` DB). If 0011 is taken, stop and ask the controller.

## New error codes (copy added by Task 8)

| Code | Status | Raised by | Copy |
|---|---|---|---|
| `first_admin_not_allowed` | 422 | route (adopt) | The first admin is only for a new environment. |
| `first_admin_with_seed` | 422 | `environments.create_new` | An environment seeded from a snapshot already has its users. Start empty to add a first admin. |
| `first_admin_name_invalid` | 422 | `first_admins.check` | Enter a first and last name (up to 100 characters each). |
| `first_admin_email_invalid` | 422 | `first_admins.check` | Enter a valid email address for the first admin. |
| `first_admin_password_too_short` | 422 | `first_admins.check` (`{min_length}`) | The password is too short for ServerSherpa's password policy. |
| `first_admin_password_invalid` | 422 | `first_admins.check` | The password can't contain line breaks or control characters. |
| `first_admin_password_not_allowed` | 422 | `first_admins.check` | An invite sends a set-password link: leave the password empty. |
| `first_admin_invalid` | 422 | `first_admins.check` | Those first-admin settings aren't valid. |
| `first_admin_not_set` | 404 | `PUT …/first-admin` | This environment has no first admin to change. |
| `first_admin_done` | 409 | `PUT …/first-admin` | The first admin was already created. Change their account in the environment itself. |

`deployErrorText` adds `(at least N characters)` for `first_admin_password_too_short` from `min_length` (Task 8).

## ServerSherpa exit codes (Task 3; Sirdar maps them in Task 6)

| Exit | Meaning | Sirdar's step-11 copy |
|---|---|---|
| 0 | created | — |
| 1 | an account with that email already exists | (success) "An account for {email} already exists in this environment; Sirdar left it as it is." |
| 2 | usage error (typer), incl. an old image without these flags | "This commit's serversherpa bootstrap-admin doesn't know --password-stdin, --invite or --link-minutes. Deploy a newer commit, then retry." |
| 3 | the password is refused by the environment's policy | "The environment refused the first admin's password: it's shorter than its password policy allows. Set a new one with PUT …/first-admin (the environment's Settings), then retry from step 11." |
| 4 | the role doesn't exist | "The environment has no super_admin role. Deploy a commit whose migrations seed it, then retry." |
| 5 | an invite was asked for and mail isn't configured | "The environment can't send email (SMTP isn't configured), so it can't invite the first admin. Use a typed password instead, then retry." |
| other | anything else | "serversherpa bootstrap-admin failed (exit {rc}). See the api container's log, then retry." |

## File ownership / parallelism

| Task | Files (create or modify) | Runs |
|---|---|---|
| 1 Password rule and token issuer | `api/src/serversherpa/services/password_policy.py`, `services/password_reset.py`, `api/deps.py`; tests `api/tests/test_password_policy_length.py` (new), `test_password_reset_service.py` | first ServerSherpa task |
| 2 Mail templates | `api/src/serversherpa/mail/templates/account_ready.{subject.txt,html,txt}`, `account_invite.{subject.txt,html,txt}` (new); test `api/tests/test_mail_outbox.py` | parallel with 1 |
| 3 First admin service and CLI | `api/src/serversherpa/services/first_admin.py` (new), `api/src/serversherpa/cli.py`; tests `api/tests/test_first_admin_service.py`, `test_cli_bootstrap_admin.py` (new) | after 1 and 2 |
| 4 Sirdar record (0011) | `sirdar/api/migrations/versions/0011_first_admin.py` (new), `db/models.py`, `deploy/first_admins.py` (new), `services/portal_policy.py`; tests `conftest.py` (truncate list), `test_deploy_first_admins.py` (new), `test_portal_compat.py`, `test_deploy_models.py` | parallel with 1–3 |
| 5 Step 11, playbook, `ss-stack admin` | `sirdar/api/src/sirdar_api/deploy/steps.py`, `deploy/ansible/first_admin.yml` (new), `deploy/stack/ss-stack`, `deploy/stack/README.md` (usage line only); tests `test_deploy_playbooks.py`, `deploy/tests/test_ss_stack.py` | parallel with 1–4 |
| 6 Pipeline | `deploy/pipeline.py`, `deploy/serialize.py` (deployment summary); test `test_deploy_pipeline_first_admin.py` (new) | after 4 and 5 |
| 7 API | `api/routes/deploy.py`, `deploy/environments.py`, `deploy/serialize.py` (environment), tests `test_deploy_first_admin_api.py` (new), `test_deploy_environments_api.py` (ENV_KEYS, defaults) | after 6 |
| 8 Web types and copy | `sirdar/web/src/lib/sirdarApi.ts`, `lib/sirdarApi.test.ts` | parallel with 5–7 (codes are in the table above) |
| 9 Docs, suites, live verify | `deploy/stack/README.md` (step 7), `sirdar/README.md`, `README.md` (root, bootstrap-admin) | last (controller) |

Dependency graph: `{1, 2} → 3`; `4 ‖ 5 ‖ {1, 2, 3}`; `{4, 5} → 6 → 7`; `8` after the table is fixed (any time); everything → 9. Task 6's pipeline tests fake the runner, so they don't wait on Task 3.

---

### Task 1: One password-length rule and one reset-token issuer (ServerSherpa)

**Files:**
- Modify: `api/src/serversherpa/services/password_policy.py` (add `length_problem`)
- Modify: `api/src/serversherpa/api/deps.py` (`require_password_length` uses it)
- Modify: `api/src/serversherpa/services/password_reset.py` (add `issue_token`, `portal_url`; `request_reset` uses them)
- Create: `api/tests/test_password_policy_length.py`
- Modify: `api/tests/test_password_reset_service.py`

**Interfaces:**
- Consumes: `get_settings().password_min_length`, `PasswordResetToken`, `hash_token`, `TOKEN_BYTES`.
- Produces:
  - `password_policy.length_problem(password: str) -> int | None` — the minimum length when `password` is shorter, else `None`.
  - `password_reset.portal_url(path: str) -> str` (the old `_portal`, now public; `_portal` stays as an alias).
  - `password_reset.issue_token(db, person_id: uuid.UUID, *, minutes: int, now: datetime, ip: str | None = None) -> str` — retires the person's unused tokens, adds a new one valid `minutes`, returns the raw token. Never commits.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_password_policy_length.py`:

```python
"""The one password-length bar (SS_PASSWORD_MIN_LENGTH) shared by the API's
routes and the bootstrap-admin command."""

import pytest
from fastapi import HTTPException

from serversherpa.api.deps import require_password_length
from serversherpa.config import get_settings
from serversherpa.services.password_policy import length_problem


def test_length_problem_names_the_bar():
    bar = get_settings().password_min_length
    assert length_problem("x" * bar) is None
    assert length_problem("x" * (bar - 1)) == bar
    assert length_problem("") == bar


def test_the_route_gate_uses_the_same_rule():
    bar = get_settings().password_min_length
    require_password_length("y" * bar)
    with pytest.raises(HTTPException) as e:
        require_password_length("y" * (bar - 1))
    assert e.value.status_code == 422
    assert e.value.detail == {"code": "password_too_short", "min_length": bar}


def test_the_bar_follows_the_setting(monkeypatch):
    monkeypatch.setenv("SS_PASSWORD_MIN_LENGTH", "12")
    get_settings.cache_clear()
    try:
        assert length_problem("z" * 11) == 12
        assert length_problem("z" * 12) is None
    finally:
        get_settings.cache_clear()
```

Append to `api/tests/test_password_reset_service.py`:

```python
async def test_issue_token_retires_older_ones_and_keeps_only_the_hash(db, seeded_user):
    now = datetime.now(UTC)
    first = await svc.issue_token(db, seeded_user.id, minutes=240, now=now)
    second = await svc.issue_token(db, seeded_user.id, minutes=240, now=now)
    await db.commit()
    rows = list(await db.scalars(select(PasswordResetToken)
                                 .order_by(PasswordResetToken.created_at)))
    assert len(rows) == 2
    assert {r.token_hash for r in rows} == {svc.hash_token(first), svc.hash_token(second)}
    assert all(first not in r.token_hash and second not in r.token_hash for r in rows)
    old = next(r for r in rows if r.token_hash == svc.hash_token(first))
    new = next(r for r in rows if r.token_hash == svc.hash_token(second))
    assert old.used_at is not None and new.used_at is None
    assert (new.expires_at - new.created_at).total_seconds() == 240 * 60
    assert await svc.find_valid(db, second) is not None


def test_portal_url_joins_the_portal_origin():
    origin = get_settings().portal_origin.rstrip("/")
    assert svc.portal_url("/login") == f"{origin}/login"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_p8a1 .venv/bin/pytest -q tests/test_password_policy_length.py tests/test_password_reset_service.py`
Expected: FAIL (`cannot import name 'length_problem'`, `module 'serversherpa.services.password_reset' has no attribute 'issue_token'`).

- [ ] **Step 3: `length_problem` and the route gate**

In `api/src/serversherpa/services/password_policy.py`, after `class PasswordReused`:

```python
def length_problem(password: str) -> int | None:
    """The one password bar every new password meets (SS_PASSWORD_MIN_LENGTH):
    the minimum length when `password` is shorter, else None. The API's
    routes (deps.require_password_length) and `serversherpa bootstrap-admin`
    both use it, so ops can raise it without a deploy."""
    min_length = get_settings().password_min_length
    return min_length if len(password) < min_length else None
```

In `api/src/serversherpa/api/deps.py`, replace the body of `require_password_length`:

```python
def require_password_length(password: str) -> None:
    """One policy gate for every password the API accepts. The schemas keep
    only a non-empty floor — the real bar lives in settings so ops can
    raise it without a deploy (password_policy.length_problem)."""
    min_length = length_problem(password)
    if min_length is not None:
        raise HTTPException(
            status_code=422,
            detail={"code": "password_too_short", "min_length": min_length})
```

and add `length_problem` to deps.py's existing `from serversherpa.services.password_policy import …` line (create that import if deps.py imports the module differently; keep `assert_not_reused`, `load_policy`, `PasswordReused` as they are).

- [ ] **Step 4: `issue_token` and `portal_url`**

In `api/src/serversherpa/services/password_reset.py`, replace `_portal` with:

```python
def portal_url(path: str) -> str:
    return f"{get_settings().portal_origin.rstrip('/')}{path}"


_portal = portal_url   # older callers


async def issue_token(db: AsyncSession, person_id: uuid.UUID, *, minutes: int,
                      now: datetime, ip: str | None = None) -> str:
    """A new single-use reset token valid `minutes`, the person's older unused
    ones retired. Only the hash is stored; the raw token is returned for the
    email and nowhere else. Never commits."""
    await _retire_unused(db, person_id, now)
    raw = secrets.token_urlsafe(TOKEN_BYTES)
    db.add(PasswordResetToken(person_id=person_id, token_hash=hash_token(raw),
                              created_at=now, expires_at=now + timedelta(minutes=minutes),
                              requested_ip=ip))
    await db.flush()
    return raw
```

In `request_reset`, replace the `_retire_unused(...)`, `raw = …` and `db.add(PasswordResetToken(…))` lines with:

```python
        raw = await issue_token(db, account.person_id,
                                minutes=settings.password_reset_ttl_minutes, now=now, ip=ip)
```

(keep the `enqueue(...)` call; its `link=_portal(...)` becomes `link=portal_url(...)`, and `login_url=_portal("/login")` in `complete` becomes `portal_url("/login")`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_p8a1 .venv/bin/pytest -q tests/test_password_policy_length.py tests/test_password_reset_service.py tests/test_password_reset_api.py`
Expected: PASS (the reset API tests prove the refactor kept behavior).

- [ ] **Step 6: Lint and commit**

```bash
cd api && .venv/bin/ruff check --select E,F,W src/serversherpa/services/password_policy.py src/serversherpa/services/password_reset.py src/serversherpa/api/deps.py tests/test_password_policy_length.py tests/test_password_reset_service.py
cd .. && git add api/src/serversherpa/services/password_policy.py api/src/serversherpa/services/password_reset.py api/src/serversherpa/api/deps.py api/tests/test_password_policy_length.py api/tests/test_password_reset_service.py
git commit -m "refactor(api): one password-length rule and one reset-token issuer

length_problem() is the SS_PASSWORD_MIN_LENGTH bar the routes and
bootstrap-admin share; issue_token() is the one way a reset link is made.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=postgres dropdb -w -h 127.0.0.1 -p 5432 -U postgres --if-exists serversherpa_test_p8a1
```

---

### Task 2: "Your ServerSherpa account is ready" emails (ServerSherpa)

**Files:**
- Create: `api/src/serversherpa/mail/templates/account_ready.subject.txt`, `account_ready.html`, `account_ready.txt`
- Create: `api/src/serversherpa/mail/templates/account_invite.subject.txt`, `account_invite.html`, `account_invite.txt`
- Modify: `api/tests/test_mail_outbox.py`

**Interfaces:**
- Produces two templates rendered by `mail.render.render(name, **ctx)`; both take `name`, `email`, `link`, `ttl_text` (like "4 hours"), `login_url`. `account_ready` = a typed password: sign in now, change it with the link. `account_invite` = no password: set it with the link. Neither ever takes a password.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_mail_outbox.py`:

```python
READY = dict(name="Ada", email="ada@test.example.com", link=LINK, ttl_text="4 hours",
             login_url="https://portal.example.com/login")


def test_render_account_ready_has_the_change_password_link():
    r = render("account_ready", **READY)
    assert r.subject == "Your ServerSherpa account is ready"
    for part in (r.html, r.text):
        assert LINK in part and "https://portal.example.com/login" in part
        assert "4 hours" in part and "ada@test.example.com" in part
    assert "Hi Ada" in r.text
    assert "change your password" in r.text.lower()
    assert r.html.lstrip().lower().startswith("<!doctype html>")


def test_render_account_invite_has_the_set_password_link():
    r = render("account_invite", **READY)
    assert r.subject == "Your ServerSherpa account is ready: set your password"
    for part in (r.html, r.text):
        assert LINK in part and "4 hours" in part and "ada@test.example.com" in part
    assert "set your password" in r.text.lower()


@pytest.mark.parametrize("template", ["account_ready", "account_invite"])
def test_account_emails_never_take_a_password(template):
    """A typo'd context key fails (StrictUndefined); a password key is simply
    never used by the template, so it can't reach the inbox."""
    r = render(template, **READY, password="Never-In-Mail-123")
    assert "Never-In-Mail-123" not in r.html and "Never-In-Mail-123" not in r.text
    with pytest.raises(Exception):
        render(template, name="Ada", email="ada@test.example.com", link=LINK)
```

and add `import pytest` at the top of the file.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_p8a2 .venv/bin/pytest -q tests/test_mail_outbox.py`
Expected: FAIL (`jinja2.exceptions.TemplateNotFound: account_ready.subject.txt`).

- [ ] **Step 3: The templates**

`account_ready.subject.txt`:

```
Your ServerSherpa account is ready
```

`account_ready.txt`:

```
Hi {{ name }},

An administrator account for {{ email }} was set up for you in ServerSherpa. Sign in at {{ login_url }} with the password you were given.

To change your password, open this link. It works once and expires in {{ ttl_text }}:

{{ link }}

If you weren't expecting this account, contact your administrator.
```

`account_ready.html`:

```html
{% extends "_base.html" %}
{% block content %}
<p style="margin:0 0 16px;">Hi {{ name }},</p>
<p style="margin:0 0 16px;">An administrator account for <b>{{ email }}</b> was set up for you in ServerSherpa. Sign in at <a href="{{ login_url }}" style="color:#1b2129;">{{ login_url }}</a> with the password you were given.</p>
<p style="margin:0 0 24px;">To change your password, use the button below. The link works once and expires in {{ ttl_text }}.</p>
<p style="margin:0 0 24px;"><a href="{{ link }}" style="display:inline-block;background:#ffa12e;color:#0c1117;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">Change your password</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#667085;">If the button doesn't work, paste this address into your browser:</p>
<p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="{{ link }}" style="color:#1b2129;">{{ link }}</a></p>
<p style="margin:0;font-size:13px;color:#667085;">If you weren't expecting this account, contact your administrator.</p>
{% endblock %}
```

`account_invite.subject.txt`:

```
Your ServerSherpa account is ready: set your password
```

`account_invite.txt`:

```
Hi {{ name }},

An administrator account for {{ email }} was set up for you in ServerSherpa. It has no password yet: open this link to set your password. It works once and expires in {{ ttl_text }}:

{{ link }}

Then sign in at {{ login_url }}. If the link expires, ask your administrator for a new invite, or use "Forgot password" on the sign-in page.

If you weren't expecting this account, contact your administrator.
```

`account_invite.html`:

```html
{% extends "_base.html" %}
{% block content %}
<p style="margin:0 0 16px;">Hi {{ name }},</p>
<p style="margin:0 0 16px;">An administrator account for <b>{{ email }}</b> was set up for you in ServerSherpa. It has no password yet.</p>
<p style="margin:0 0 24px;">Set your password with the button below. The link works once and expires in {{ ttl_text }}.</p>
<p style="margin:0 0 24px;"><a href="{{ link }}" style="display:inline-block;background:#ffa12e;color:#0c1117;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">Set your password</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#667085;">If the button doesn't work, paste this address into your browser:</p>
<p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="{{ link }}" style="color:#1b2129;">{{ link }}</a></p>
<p style="margin:0 0 16px;">Then sign in at <a href="{{ login_url }}" style="color:#1b2129;">{{ login_url }}</a>. If the link expires, ask your administrator for a new invite, or use "Forgot password" on the sign-in page.</p>
<p style="margin:0;font-size:13px;color:#667085;">If you weren't expecting this account, contact your administrator.</p>
{% endblock %}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_p8a2 .venv/bin/pytest -q tests/test_mail_outbox.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/mail/templates/account_ready.subject.txt api/src/serversherpa/mail/templates/account_ready.html api/src/serversherpa/mail/templates/account_ready.txt api/src/serversherpa/mail/templates/account_invite.subject.txt api/src/serversherpa/mail/templates/account_invite.html api/src/serversherpa/mail/templates/account_invite.txt api/tests/test_mail_outbox.py
git commit -m "feat(api): account-ready and invite emails for a first admin

Change-password link (typed password) or set-password link (invite); no
template ever takes a password.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=postgres dropdb -w -h 127.0.0.1 -p 5432 -U postgres --if-exists serversherpa_test_p8a2
```

---

### Task 3: `create_admin` and the new `bootstrap-admin` flags (ServerSherpa)

**Files:**
- Create: `api/src/serversherpa/services/first_admin.py`
- Modify: `api/src/serversherpa/cli.py` (`bootstrap_admin`; module docstring example)
- Create: `api/tests/test_first_admin_service.py`, `api/tests/test_cli_bootstrap_admin.py`

**Interfaces:**
- Consumes (Tasks 1–2): `password_policy.length_problem`, `password_policy.apply_password`, `password_reset.issue_token`, `password_reset.portal_url`, `mail.email_enabled`, `mail.enqueue`, templates `account_ready` / `account_invite`, `services.audit.audit`.
- Produces:
  - `first_admin.FirstAdminError(code, **extra)`; codes `account_exists`, `password_too_short` (`min_length`), `role_unknown`, `mail_not_configured`, `link_required`.
  - `first_admin.FirstAdminResult(person_id: uuid.UUID, emailed: bool)`.
  - `async first_admin.create_admin(db, *, email, first_name, last_name, role="admin", password: str | None, link_minutes: int | None, now: datetime | None = None) -> FirstAdminResult` — never commits; `password=None` is an invite (needs `link_minutes` and mail).
  - `first_admin.ttl_text(minutes: int) -> str` ("4 hours", "90 minutes", "1 hour").
  - CLI: `serversherpa bootstrap-admin --email E --first-name F --last-name L [--role R] [--password-stdin | --invite] [--link-minutes N]`; exit codes 0 / 1 / 2 / 3 / 4 / 5 as in the table above; messages on stderr; the password never printed. No `--password` option (a password never goes in argv); with neither flag it prompts twice (hidden), as before.

- [ ] **Step 1: Write the failing service tests**

Create `api/tests/test_first_admin_service.py`:

```python
"""services/first_admin.py: the first admin of a fresh environment — a typed
password (account ready, change-password link) or an invite (no password,
set-password link). Mail goes through the outbox; nothing is committed."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog, EmailOutbox, PasswordResetToken, PersonRole, UserAccount,
)
from serversherpa.security.passwords import verify_password
from serversherpa.services import password_reset
from serversherpa.services.first_admin import FirstAdminError, create_admin, ttl_text

EMAIL = "ada@test.example.com"
TYPED = "Correct-Horse-Battery-9"
NOW = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)


async def _make(db, **kw):
    # the real clock: find_valid() compares the link's expiry with now
    args = dict(email=EMAIL, first_name="Ada", last_name="Lovelace", role="super_admin",
                password=TYPED, link_minutes=240)
    result = await create_admin(db, **{**args, **kw})
    await db.commit()
    return result


def _raw(mail: EmailOutbox) -> str:
    return mail.text_body.split("#token=")[1].split()[0]


def test_ttl_text():
    assert (ttl_text(240), ttl_text(60), ttl_text(90), ttl_text(1)) == (
        "4 hours", "1 hour", "90 minutes", "1 minute")


async def test_typed_password_creates_a_super_admin_and_mails_a_change_link(db, email_on):
    result = await _make(db)
    account = await db.scalar(select(UserAccount).where(UserAccount.email == EMAIL))
    assert account.person_id == result.person_id and result.emailed is True
    pepper = get_settings().password_pepper.get_secret_value()
    assert verify_password(account.password_hash, TYPED, pepper=pepper)
    assert account.must_change_password is False
    roles = list(await db.scalars(select(PersonRole.role)
                                  .where(PersonRole.person_id == account.person_id)))
    assert roles == ["super_admin"]
    mail = await db.scalar(select(EmailOutbox))
    assert (mail.template, mail.to_address) == ("account_ready", EMAIL)
    assert "4 hours" in mail.text_body and TYPED not in mail.text_body + mail.html_body
    token = await db.scalar(select(PasswordResetToken))
    assert (token.expires_at - token.created_at).total_seconds() == 240 * 60
    assert token.token_hash == password_reset.hash_token(_raw(mail))
    assert await password_reset.find_valid(db, _raw(mail)) is not None
    audit = await db.scalar(select(AuditLog).where(AuditLog.action == "user.bootstrap"))
    assert audit.changes == {"role": "super_admin", "invite": False, "emailed": True}
    assert TYPED not in repr(audit.changes)


async def test_invite_has_no_password_and_a_set_password_link_that_works(db, email_on):
    result = await _make(db, password=None)
    account = await db.get(UserAccount, result.person_id)
    assert account.password_hash is None
    mail = await db.scalar(select(EmailOutbox))
    assert mail.template == "account_invite"
    found = await password_reset.find_valid(db, _raw(mail))
    assert found is not None and found[1].person_id == result.person_id
    await password_reset.complete(db, *found, "A-New-Password-77", ip=None)
    await db.commit()
    account = await db.get(UserAccount, result.person_id, populate_existing=True)
    pepper = get_settings().password_pepper.get_secret_value()
    assert verify_password(account.password_hash, "A-New-Password-77", pepper=pepper)


async def test_typed_password_without_mail_still_creates_the_account(db):
    result = await _make(db)
    assert result.emailed is False
    assert await db.scalar(select(EmailOutbox)) is None
    assert await db.scalar(select(PasswordResetToken)) is None
    assert await db.get(UserAccount, result.person_id) is not None


async def test_typed_password_without_a_link_sends_nothing(db, email_on):
    result = await _make(db, link_minutes=None)
    assert result.emailed is False and await db.scalar(select(EmailOutbox)) is None


@pytest.mark.parametrize("kw, code", [
    ({"password": "short"}, "password_too_short"),
    ({"role": "no_such_role"}, "role_unknown"),
    ({"password": None, "link_minutes": None}, "link_required"),
])
async def test_refusals_create_nothing(db, email_on, kw, code):
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email=EMAIL, first_name="Ada", last_name="Lovelace",
                           role=kw.get("role", "super_admin"),
                           password=kw.get("password", TYPED),
                           link_minutes=kw.get("link_minutes", 240), now=NOW)
    await db.rollback()
    assert e.value.code == code
    if code == "password_too_short":
        assert e.value.extra == {"min_length": get_settings().password_min_length}
    assert await db.scalar(select(UserAccount)) is None


async def test_invite_needs_mail(db):
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email=EMAIL, first_name="Ada", last_name="Lovelace",
                           role="super_admin", password=None, link_minutes=240, now=NOW)
    assert e.value.code == "mail_not_configured"


async def test_an_existing_account_is_refused(db, email_on, seeded_user):
    with pytest.raises(FirstAdminError) as e:
        await create_admin(db, email="alice@test.example.com", first_name="A",
                           last_name="B", role="super_admin", password=TYPED,
                           link_minutes=240, now=NOW)
    assert e.value.code == "account_exists"
```

- [ ] **Step 2: Write the failing CLI tests**

Create `api/tests/test_cli_bootstrap_admin.py`:

```python
"""bootstrap-admin's surface: flags, stdin, exit codes. The service is
replaced (test_first_admin_service.py covers it), so nothing here touches
Postgres or a real event loop's engine."""

import pytest
from typer.testing import CliRunner

from serversherpa import cli
from serversherpa.cli import app
from serversherpa.services.first_admin import FirstAdminError, FirstAdminResult

runner = CliRunner()
BASE = ["bootstrap-admin", "--email", "ada@test.example.com", "--first-name", "Ada",
        "--last-name", "Lovelace"]
SECRET = "Stdin-Only-Password-42"


class Calls(list):
    """The service calls, plus `outcome`: what the fake answers next."""
    outcome: dict


@pytest.fixture
def calls(monkeypatch):
    seen = Calls()
    outcome: dict = {}

    async def fake(**kwargs):
        seen.append(kwargs)
        if "error" in outcome:
            raise outcome["error"]
        return FirstAdminResult(person_id="00000000-0000-0000-0000-000000000001",
                                emailed=outcome.get("emailed", True))

    monkeypatch.setattr(cli, "_create_first_admin", fake)
    seen.outcome = outcome
    return seen


def test_help_lists_the_new_flags():
    result = runner.invoke(app, ["bootstrap-admin", "--help"])
    assert result.exit_code == 0
    for flag in ("--role", "--password-stdin", "--invite", "--link-minutes"):
        assert flag in result.output
    assert "--password " not in result.output        # never a password in argv


def test_password_stdin_reads_one_line(calls):
    result = runner.invoke(app, [*BASE, "--role", "super_admin", "--password-stdin",
                                 "--link-minutes", "240"], input=SECRET + "\n")
    assert result.exit_code == 0, result.output
    assert calls == [{"email": "ada@test.example.com", "first_name": "Ada",
                      "last_name": "Lovelace", "role": "super_admin", "password": SECRET,
                      "link_minutes": 240}]
    assert SECRET not in result.output


def test_invite_sends_no_password(calls):
    result = runner.invoke(app, [*BASE, "--invite", "--link-minutes", "240"])
    assert result.exit_code == 0, result.output
    assert calls[0]["password"] is None and calls[0]["role"] == "admin"


def test_the_prompt_is_kept_without_either_flag(calls):
    result = runner.invoke(app, BASE, input=f"{SECRET}\n{SECRET}\n")
    assert result.exit_code == 0, result.output
    assert calls[0]["password"] == SECRET and calls[0]["link_minutes"] is None


@pytest.mark.parametrize("args", [
    ["--password-stdin", "--invite", "--link-minutes", "240"],
    ["--invite"],
    ["--invite", "--link-minutes", "0"],
])
def test_usage_errors_exit_2(calls, args):
    result = runner.invoke(app, [*BASE, *args], input=SECRET + "\n")
    assert result.exit_code == 2
    assert calls == []


@pytest.mark.parametrize("code, extra, exit_code", [
    ("account_exists", {}, 1),
    ("password_too_short", {"min_length": 8}, 3),
    ("role_unknown", {}, 4),
    ("mail_not_configured", {}, 5),
])
def test_refusals_map_to_exit_codes(calls, code, extra, exit_code):
    calls.outcome["error"] = FirstAdminError(code, **extra)
    result = runner.invoke(app, [*BASE, "--password-stdin", "--link-minutes", "240"],
                           input=SECRET + "\n")
    assert result.exit_code == exit_code
    assert SECRET not in result.output
    if code == "password_too_short":
        assert "at least 8 characters" in result.output


def test_a_typed_password_without_mail_warns(calls):
    calls.outcome["emailed"] = False
    result = runner.invoke(app, [*BASE, "--password-stdin", "--link-minutes", "240"],
                           input=SECRET + "\n")
    assert result.exit_code == 0
    assert "No email was sent" in result.output
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_p8a3 .venv/bin/pytest -q tests/test_first_admin_service.py tests/test_cli_bootstrap_admin.py`
Expected: FAIL (`No module named 'serversherpa.services.first_admin'`).

- [ ] **Step 4: The service**

Create `api/src/serversherpa/services/first_admin.py`:

```python
"""The first admin of a fresh environment (`serversherpa bootstrap-admin`,
which Sirdar runs once on an environment that starts empty). A typed
password creates a ready account and, when a link is asked for, mails a
change-password link; an invite creates the account without a password and
mails a set-password link. No password ever goes in an email or an audit row.
The bar is the API's own (password_policy.length_problem). Never commits."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Person, PersonRole, Role, UserAccount
from serversherpa.mail import email_enabled, enqueue
from serversherpa.services import password_reset
from serversherpa.services.audit import audit
from serversherpa.services.password_policy import apply_password, length_problem


class FirstAdminError(Exception):
    """Nothing was created. `code`: account_exists, password_too_short
    (`min_length`), role_unknown, mail_not_configured, link_required."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


@dataclass(frozen=True)
class FirstAdminResult:
    person_id: uuid.UUID
    emailed: bool


def ttl_text(minutes: int) -> str:
    if minutes % 60 == 0:
        hours = minutes // 60
        return f"{hours} hour{'' if hours == 1 else 's'}"
    return f"{minutes} minute{'' if minutes == 1 else 's'}"


async def create_admin(db: AsyncSession, *, email: str, first_name: str, last_name: str,
                       role: str = "admin", password: str | None,
                       link_minutes: int | None,
                       now: datetime | None = None) -> FirstAdminResult:
    now = now or datetime.now(UTC)
    invite = password is None
    if invite and not link_minutes:
        raise FirstAdminError("link_required")
    if not invite and (min_length := length_problem(password)) is not None:
        raise FirstAdminError("password_too_short", min_length=min_length)
    if await db.get(Role, role) is None:
        raise FirstAdminError("role_unknown")
    if invite and not email_enabled():
        raise FirstAdminError("mail_not_configured")
    if await db.scalar(select(UserAccount).where(UserAccount.email == email)) is not None:
        raise FirstAdminError("account_exists")

    person = Person(first_name=first_name, last_name=last_name, email=email, source="manual")
    db.add(person)
    await db.flush()
    account = UserAccount(person_id=person.id, email=email)
    db.add(account)
    await db.flush()      # password_history references the account
    if not invite:
        await apply_password(db, account, password, must_change=False, now=now)
    db.add(PersonRole(person_id=person.id, role=role))    # granted_by NULL = bootstrap
    emailed = False
    if link_minutes and email_enabled():
        raw = await password_reset.issue_token(db, person.id, minutes=link_minutes, now=now)
        await enqueue(db, "account_invite" if invite else "account_ready", email,
                      person_id=person.id, name=first_name, email=email,
                      link=password_reset.portal_url(f"/reset-password#token={raw}"),
                      ttl_text=ttl_text(link_minutes),
                      login_url=password_reset.portal_url("/login"))
        emailed = True
    audit(db, actor_id=None, entity_type="user_account", entity_id=str(person.id),
          action="user.bootstrap", changes={"role": role, "invite": invite, "emailed": emailed})
    await db.flush()
    return FirstAdminResult(person_id=person.id, emailed=emailed)
```

- [ ] **Step 5: The CLI**

In `api/src/serversherpa/cli.py`, update the module docstring's example line to:

```
    serversherpa bootstrap-admin --email you@company.com --first-name You --last-name Name \
        [--role super_admin] [--password-stdin | --invite] [--link-minutes 240]
```

Replace `bootstrap_admin` with:

```python
# bootstrap-admin's exit codes (Sirdar's step 11 reads them; 2 is typer's usage error).
EXIT_ACCOUNT_EXISTS = 1
EXIT_PASSWORD_REFUSED = 3
EXIT_ROLE_UNKNOWN = 4
EXIT_MAIL_OFF = 5
_EXIT_CODES = {"account_exists": EXIT_ACCOUNT_EXISTS, "password_too_short": EXIT_PASSWORD_REFUSED,
               "role_unknown": EXIT_ROLE_UNKNOWN, "mail_not_configured": EXIT_MAIL_OFF}


async def _create_first_admin(**kwargs):
    """One session: create, commit, dispose (tests replace this)."""
    from serversherpa.services.first_admin import create_admin

    try:
        async with get_sessionmaker()() as db:
            result = await create_admin(db, **kwargs)
            await db.commit()
            return result
    finally:
        await dispose_engine()


@app.command()
def bootstrap_admin(
    email: str = typer.Option(..., help="Login email for the admin account"),
    first_name: str = typer.Option(...),
    last_name: str = typer.Option(...),
    role: str = typer.Option("admin", help="The role to grant, e.g. super_admin"),
    password_stdin: bool = typer.Option(
        False, "--password-stdin", help="Read the password from stdin (one line); no prompt"),
    invite: bool = typer.Option(
        False, "--invite", help="No password: email a set-password link (needs --link-minutes)"),
    link_minutes: int | None = typer.Option(
        None, "--link-minutes", min=1, max=1440,
        help="Email a link valid this many minutes: change-password, or set-password with "
             "--invite"),
) -> None:
    """Create the first admin: person + account + role grant, and optionally
    the account-ready or invite email. The password never goes in argv."""
    from serversherpa.services.first_admin import FirstAdminError

    if password_stdin and invite:
        typer.secho("Use --password-stdin or --invite, not both.", fg="red", err=True)
        raise typer.Exit(code=2)
    if invite and link_minutes is None:
        typer.secho("--invite needs --link-minutes (how long the set-password link works).",
                    fg="red", err=True)
        raise typer.Exit(code=2)
    password: str | None = None
    if password_stdin:
        password = sys.stdin.readline().rstrip("\r\n")
    elif not invite:
        password = typer.prompt("Password", hide_input=True, confirmation_prompt=True)
    try:
        result = asyncio.run(_create_first_admin(
            email=email, first_name=first_name, last_name=last_name, role=role,
            password=password, link_minutes=link_minutes))
    except FirstAdminError as e:
        messages = {
            "account_exists": f"An account for {email} already exists.",
            "password_too_short": "The password is too short: use at least "
                                  f"{e.extra.get('min_length')} characters.",
            "role_unknown": f"There is no role named {role}.",
            "mail_not_configured": "Email isn't configured (SS_SMTP_HOST and SS_SMTP_FROM), "
                                   "so an invite can't be sent.",
            "link_required": "--invite needs --link-minutes.",
        }
        typer.secho(messages.get(e.code, e.code), fg="red", err=True)
        raise typer.Exit(code=_EXIT_CODES.get(e.code, 2)) from None
    kind = "invited" if invite else "created"
    typer.secho(f"Admin {kind}: {first_name} {last_name} <{email}> as {role} "
                f"(person {result.person_id})", fg="green")
    if link_minutes and not result.emailed:
        typer.secho("No email was sent: email isn't configured.", fg="yellow")
```

Remove the now-unused imports from the top of `cli.py` only if ruff reports them unused (`Person`, `PersonRole`, `UserAccount`, `apply_password` are still used by `set_password` and others; leave what is used).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_p8a3 .venv/bin/pytest -q tests/test_first_admin_service.py tests/test_cli_bootstrap_admin.py tests/test_cli_import_worker.py tests/test_password_reset_service.py`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
cd api && .venv/bin/ruff check --select E,F,W src/serversherpa/services/first_admin.py src/serversherpa/cli.py tests/test_first_admin_service.py tests/test_cli_bootstrap_admin.py
cd .. && git add api/src/serversherpa/services/first_admin.py api/src/serversherpa/cli.py api/tests/test_first_admin_service.py api/tests/test_cli_bootstrap_admin.py
git commit -m "feat(api): bootstrap-admin takes a role, stdin, an invite and a link

--role super_admin, --password-stdin (never argv), --invite (no password,
a set-password link) and --link-minutes; the API's own password bar; exit
codes 1/3/4/5 for Sirdar's step 11.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=postgres dropdb -w -h 127.0.0.1 -p 5432 -U postgres --if-exists serversherpa_test_p8a3
```

---

### Task 4: The first admin on the environment (Sirdar, migration 0011)

**Files:**
- Create: `sirdar/api/migrations/versions/0011_first_admin.py`
- Modify: `sirdar/api/src/sirdar_api/db/models.py` (`EnvironmentFirstAdmin`; `Deployment.first_admin`; docstring "0001–0011")
- Create: `sirdar/api/src/sirdar_api/deploy/first_admins.py`
- Modify: `sirdar/api/src/sirdar_api/services/portal_policy.py` (`PASSWORD_MIN_LENGTH`)
- Modify: `sirdar/api/tests/conftest.py` (`SIRDAR_TABLES` gains `environment_first_admins`)
- Create: `sirdar/api/tests/test_deploy_first_admins.py`
- Modify: `sirdar/api/tests/test_portal_compat.py`, `sirdar/api/tests/test_deploy_models.py`

**Interfaces:**
- Produces:
  - Table `environment_first_admins` (one row per environment, `ON DELETE CASCADE`): `first_name`, `last_name`, `email`, `password_mode` (`typed` | `invite`), `password_enc` (vault, typed only; NULL once used), `done_at`, timestamps. `deployments.first_admin boolean NOT NULL DEFAULT false`.
  - `portal_policy.PASSWORD_MIN_LENGTH = 8`, `portal_policy.FIRST_ADMIN_ROLE = "super_admin"`, `portal_policy.FIRST_ADMIN_LINK_MINUTES = 240`.
  - `first_admins.FirstAdminError(code, **extra)` with the codes in the table above.
  - `first_admins.check(fields: dict) -> dict` → `{"first_name", "last_name", "email", "password_mode", "password"}` (password `None` for an invite).
  - `async first_admins.put(db, settings, env_id, spec) -> EnvironmentFirstAdmin` (insert or replace; encrypts the password).
  - `async first_admins.get(db, env_id) -> EnvironmentFirstAdmin | None`, `async first_admins.pending(db, env_id) -> bool` (a row with `done_at` NULL).
  - `async first_admins.step_vars(db, settings, env_id) -> tuple[dict, list[str]]` — the playbook vars and the values to redact; vault errors propagate.
  - `async first_admins.mark_done(db, env_id) -> None` (password cleared, `done_at` set; the caller commits).
  - `first_admins.exit_code(data: dict) -> int`, `first_admins.refusal(rc: int) -> str`, `first_admins.EXISTS_NOTE` (format with `email`), `first_admins.ALREADY_CREATED`.
  - `first_admins.public(row) -> dict | None` → `{"first_name", "last_name", "email", "password_mode", "done": bool}` (never the password).

- [ ] **Step 1: Check the migration number**

From the main checkout (`/Users/jrh1812/Developer/BaseCampV3`): `grep -l 'revision = "0011"' .claude/worktrees/*/sirdar/api/migrations/versions/*.py sirdar/api/migrations/versions/*.py` and `docker compose -f docker-compose.dev.yml exec -T sirdar-db psql -U sirdar -d sirdar -tAc 'SELECT version_num FROM alembic_version'`.
Expected: no file, and the dev DB at 0010 or lower. Otherwise stop and report to the controller.

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_first_admins.py`:

```python
"""deploy/first_admins.py: the first super admin a fresh environment gets
on its first deploy. A typed password is vault-encrypted until step 11 has
used it; an invite has none."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import EnvironmentFirstAdmin
from sirdar_api.deploy import first_admins, vault
from sirdar_api.services import portal_policy

from .deploy_factories import make_environment, secrets_key  # noqa: F401

TYPED = "Correct-Horse-Battery-9"
GOOD = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
        "password_mode": "typed", "password": TYPED}


def test_check_accepts_typed_and_invite():
    assert first_admins.check(GOOD) == GOOD
    invite = {**GOOD, "password_mode": "invite", "password": None}
    assert first_admins.check(invite) == invite
    assert first_admins.check({**GOOD, "first_name": "  Ada "})["first_name"] == "Ada"


@pytest.mark.parametrize("change, code", [
    ({"first_name": ""}, "first_admin_name_invalid"),
    ({"last_name": "x" * 101}, "first_admin_name_invalid"),
    ({"first_name": "A\nB"}, "first_admin_name_invalid"),
    ({"email": "not-an-email"}, "first_admin_email_invalid"),
    ({"email": "a@b"}, "first_admin_email_invalid"),
    ({"password": "x" * (portal_policy.PASSWORD_MIN_LENGTH - 1)},
     "first_admin_password_too_short"),
    ({"password": None}, "first_admin_password_too_short"),
    ({"password": "Long-enough\npassword"}, "first_admin_password_invalid"),
    ({"password_mode": "invite"}, "first_admin_password_not_allowed"),
    ({"password_mode": "sms"}, "first_admin_invalid"),
])
def test_check_refusals(change, code):
    with pytest.raises(first_admins.FirstAdminError) as e:
        first_admins.check({**GOOD, **change})
    assert e.value.code == code
    if code == "first_admin_password_too_short":
        assert e.value.extra == {"min_length": portal_policy.PASSWORD_MIN_LENGTH}
    assert TYPED not in str(e.value) and TYPED not in repr(e.value)


async def test_put_encrypts_and_public_hides_the_password(db, secrets_key):
    env = await make_environment(db, name="fresh", secrets={})
    row = await first_admins.put(db, get_settings(), env.id, first_admins.check(GOOD))
    await db.commit()
    assert TYPED.encode() not in bytes(row.password_enc)
    assert vault.decrypt(get_settings(), row.password_enc) == TYPED
    assert first_admins.public(row) == {"first_name": "Ada", "last_name": "Lovelace",
                                        "email": "ada@test.example.com",
                                        "password_mode": "typed", "done": False}
    assert TYPED not in repr(row)
    assert await first_admins.pending(db, env.id) is True


async def test_step_vars_and_mark_done(db, secrets_key):
    env = await make_environment(db, name="fresh", secrets={})
    await first_admins.put(db, get_settings(), env.id, first_admins.check(GOOD))
    await db.commit()
    values, redact = await first_admins.step_vars(db, get_settings(), env.id)
    assert values == {"admin_email": "ada@test.example.com", "admin_first_name": "Ada",
                      "admin_last_name": "Lovelace", "admin_role": "super_admin",
                      "admin_invite": False, "admin_password": TYPED,
                      "admin_link_minutes": 240}
    assert redact == [TYPED]
    await first_admins.mark_done(db, env.id)
    await db.commit()
    row = await db.get(EnvironmentFirstAdmin, env.id, populate_existing=True)
    assert row.password_enc is None and row.done_at is not None
    assert await first_admins.pending(db, env.id) is False
    assert first_admins.public(row)["done"] is True


async def test_an_invite_has_no_password_var(db, secrets_key):
    env = await make_environment(db, name="fresh", secrets={})
    await first_admins.put(db, get_settings(), env.id, first_admins.check(
        {**GOOD, "password_mode": "invite", "password": None}))
    await db.commit()
    values, redact = await first_admins.step_vars(db, get_settings(), env.id)
    assert values["admin_invite"] is True and values["admin_password"] == ""
    assert redact == []


async def test_the_row_goes_with_its_environment(db, secrets_key):
    env = await make_environment(db, name="fresh", secrets={})
    await first_admins.put(db, get_settings(), env.id, first_admins.check(GOOD))
    await db.commit()
    await db.delete(env)
    await db.commit()
    assert await db.scalar(select(EnvironmentFirstAdmin)) is None


def test_exit_codes_and_copy():
    assert first_admins.exit_code({"first_admin_rc": "3"}) == 3
    assert first_admins.exit_code({}) == -1
    assert first_admins.exit_code({"first_admin_rc": "x"}) == -1
    assert "password policy" in first_admins.refusal(3)
    assert "newer commit" in first_admins.refusal(2)
    assert "SMTP" in first_admins.refusal(5)
    assert "super_admin" in first_admins.refusal(4)
    assert "exit 9" in first_admins.refusal(9)
```

Append to `sirdar/api/tests/test_portal_compat.py`:

```python
def test_first_admin_password_bar_is_the_portals_default():
    """Sirdar checks a typed first-admin password against ServerSherpa's
    default bar; an environment Sirdar builds never overrides it."""
    from sirdar_api.services import portal_policy
    config = (PORTAL / "config.py").read_text()
    assert f"password_min_length: int = {portal_policy.PASSWORD_MIN_LENGTH}" in config
    compose = (REPO / "deploy" / "stack" / "api" / "compose.yml").read_text()
    assert "SS_PASSWORD_MIN_LENGTH" not in compose
    roles = (PORTAL / "access" / "defaults.py").read_text()
    assert f'"{portal_policy.FIRST_ADMIN_ROLE}":' in roles
```

In `sirdar/api/tests/test_deploy_models.py`, add (the file already imports the models and a `db` fixture; follow its existing style):

```python
async def test_first_admin_password_only_for_typed(db):
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from .deploy_factories import make_environment
    env = await make_environment(db, name="fa1", secrets={})
    with pytest.raises(IntegrityError):
        await db.execute(text(
            "INSERT INTO environment_first_admins (environment_id, first_name, last_name, "
            "email, password_mode, password_enc) VALUES (:e, 'A', 'B', 'a@b.co', 'invite', "
            "'\\x00')"), {"e": env.id})
    await db.rollback()
```

(add `import pytest` if the file lacks it).

- [ ] **Step 3: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8a4 .venv/bin/pytest -q tests/test_deploy_first_admins.py tests/test_portal_compat.py tests/test_deploy_models.py`
Expected: FAIL (`cannot import name 'EnvironmentFirstAdmin'`).

- [ ] **Step 4: Migration 0011**

Create `sirdar/api/migrations/versions/0011_first_admin.py`:

```python
"""Fresh start (deploy phase 8a): the first super admin an environment that
starts empty gets on its first deploy (step 11), and the deployments that
run that step.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-07
"""
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE environment_first_admins (
          environment_id uuid PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
          first_name text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 100),
          last_name text NOT NULL CHECK (length(last_name) BETWEEN 1 AND 100),
          email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
          password_mode text NOT NULL CHECK (password_mode IN ('typed', 'invite')),
          -- vault-encrypted; typed only, and NULL again once step 11 used it
          password_enc bytea,
          done_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT environment_first_admins_password_check
            CHECK (password_mode = 'typed' OR password_enc IS NULL)
        );
        ALTER TABLE deployments ADD COLUMN first_admin boolean NOT NULL DEFAULT false;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE deployments DROP COLUMN first_admin;
        DROP TABLE environment_first_admins;
    """)
```

- [ ] **Step 5: The model**

In `sirdar/api/src/sirdar_api/db/models.py`, change the module docstring's "(migrations 0001–0010)" to "(migrations 0001–0011)". In `class Deployment`, after `go_live`:

```python
    # Fresh start (migration 0011): its plan has step 11, Create the first admin.
    first_admin: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
```

After `class EnvironmentSecret`:

```python
class EnvironmentFirstAdmin(Base):
    """The first super admin of an environment that starts empty (migration
    0011): step 11 of its first deploy creates them. A typed password is
    Fernet-encrypted with SIRDAR_SECRETS_KEY until that step used it, then
    cleared; an invite has none. Never returned."""

    __tablename__ = "environment_first_admins"

    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"), primary_key=True)
    first_name: Mapped[str]
    last_name: Mapped[str]
    email: Mapped[str]
    password_mode: Mapped[str]                      # typed | invite
    password_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    done_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

(The models use SQLAlchemy's default `repr`, which prints no column values, so the ciphertext never shows in a `repr()`; the test checks it.)

In `sirdar/api/tests/conftest.py`, append `, environment_first_admins` to `SIRDAR_TABLES` (inside the string, after `acme_accounts`).

- [ ] **Step 6: The policy mirror**

Append to `sirdar/api/src/sirdar_api/services/portal_policy.py`:

```python
# A new environment's password bar: ServerSherpa's default
# (api/src/serversherpa/config.py password_min_length; deploy/stack/api/compose.yml
# never sets SS_PASSWORD_MIN_LENGTH). The environment's own bootstrap-admin
# checks again and is the authority. test_portal_compat.py pins both.
PASSWORD_MIN_LENGTH = 8
FIRST_ADMIN_ROLE = "super_admin"
FIRST_ADMIN_LINK_MINUTES = 240          # the change-password or set-password link: 4 hours
```

- [ ] **Step 7: `deploy/first_admins.py`**

Create `sirdar/api/src/sirdar_api/deploy/first_admins.py`:

```python
"""The first super admin of an environment that starts empty (deploy phase
8a): the record (environment_first_admins), its checks, the vars step 11
(Create the first admin) hands its playbook, and our copy for the exit codes
of `serversherpa bootstrap-admin`. A typed password is vault-encrypted until
step 11 used it; it never reaches a response, log, audit row, error or argv
(it travels only as the command's stdin). Callers audit and commit."""

import re
import unicodedata
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import EnvironmentFirstAdmin
from sirdar_api.deploy import vault
from sirdar_api.services import portal_policy

MODES = ("typed", "invite")
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}")
_BAD_CATEGORIES = frozenset({"Cc", "Zl", "Zp"})
ALREADY_CREATED = "The first admin was already created; nothing to do.\n"
EXISTS_NOTE = ("An account for {email} already exists in this environment; Sirdar left it as "
               "it is.\n")
_REFUSALS = {
    2: ("This commit's serversherpa bootstrap-admin doesn't know --password-stdin, --invite or "
        "--link-minutes. Deploy a newer commit, then retry."),
    3: ("The environment refused the first admin's password: it's shorter than its password "
        "policy allows. Set a new one on the environment's Settings tab, then retry from "
        "step 11."),
    4: ("The environment has no super_admin role. Deploy a commit whose migrations seed it, "
        "then retry."),
    5: ("The environment can't send email (SMTP isn't configured), so it can't invite the "
        "first admin. Use a typed password instead, then retry."),
}


class FirstAdminError(Exception):
    """A validation failure. `code` is the API error code; `extra` holds
    non-secret details (min_length), never the password."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


def _clean(value) -> bool:
    return isinstance(value, str) and not any(
        unicodedata.category(ch) in _BAD_CATEGORIES for ch in value)


def _name(value) -> str:
    if not _clean(value) or not 1 <= len(value.strip()) <= 100:
        raise FirstAdminError("first_admin_name_invalid")
    return value.strip()


def check(fields) -> dict:
    """The first admin as create (or PUT …/first-admin) asked for it. A typed
    password meets ServerSherpa's own bar and has no line break (it is one
    line on stdin); an invite has no password."""
    if not isinstance(fields, dict) or fields.get("password_mode") not in MODES:
        raise FirstAdminError("first_admin_invalid")
    email = fields.get("email")
    if not _clean(email) or len(email.strip()) > 254 or not _EMAIL_RE.fullmatch(email.strip()):
        raise FirstAdminError("first_admin_email_invalid")
    mode, password = fields["password_mode"], fields.get("password")
    if mode == "invite":
        if password not in (None, ""):
            raise FirstAdminError("first_admin_password_not_allowed")
        password = None
    else:
        if password is None or not isinstance(password, str) \
                or len(password) < portal_policy.PASSWORD_MIN_LENGTH:
            raise FirstAdminError("first_admin_password_too_short",
                                  min_length=portal_policy.PASSWORD_MIN_LENGTH)
        if not _clean(password):
            raise FirstAdminError("first_admin_password_invalid")
    return {"first_name": _name(fields.get("first_name")),
            "last_name": _name(fields.get("last_name")), "email": email.strip(),
            "password_mode": mode, "password": password}


async def get(db: AsyncSession, env_id: uuid.UUID) -> EnvironmentFirstAdmin | None:
    return await db.get(EnvironmentFirstAdmin, env_id, populate_existing=True)


async def pending(db: AsyncSession, env_id: uuid.UUID) -> bool:
    row = await get(db, env_id)
    return row is not None and row.done_at is None


async def put(db: AsyncSession, settings: Settings, env_id: uuid.UUID,
              spec: dict) -> EnvironmentFirstAdmin:
    """Insert or replace the first admin (a checked spec)."""
    row = await get(db, env_id)
    if row is None:
        row = EnvironmentFirstAdmin(environment_id=env_id)
        db.add(row)
    row.first_name, row.last_name, row.email = spec["first_name"], spec["last_name"], \
        spec["email"]
    row.password_mode = spec["password_mode"]
    row.password_enc = (vault.encrypt(settings, spec["password"])
                        if spec["password_mode"] == "typed" else None)
    row.updated_at = datetime.now(UTC)
    await db.flush()
    return row


async def step_vars(db: AsyncSession, settings: Settings,
                    env_id: uuid.UUID) -> tuple[dict, list[str]]:
    """Step 11's extra vars and the values to redact. vault.SecretsKeyMissing
    and vault.SecretUnreadable propagate."""
    row = await get(db, env_id)
    if row is None or row.done_at is not None:
        return {}, []
    password = vault.decrypt(settings, row.password_enc) if row.password_enc else ""
    values = {"admin_email": row.email, "admin_first_name": row.first_name,
              "admin_last_name": row.last_name, "admin_role": portal_policy.FIRST_ADMIN_ROLE,
              "admin_invite": row.password_mode == "invite", "admin_password": password,
              "admin_link_minutes": portal_policy.FIRST_ADMIN_LINK_MINUTES}
    return values, [password] if password else []


async def mark_done(db: AsyncSession, env_id: uuid.UUID) -> None:
    row = await get(db, env_id)
    if row is not None:
        now = datetime.now(UTC)
        row.password_enc, row.done_at, row.updated_at = None, now, now


def exit_code(data: dict) -> int:
    """bootstrap-admin's exit code, as first_admin.yml reported it."""
    try:
        return int(str(data.get("first_admin_rc")))
    except (TypeError, ValueError):
        return -1


def refusal(rc: int) -> str:
    return _REFUSALS.get(rc, f"serversherpa bootstrap-admin failed (exit {rc}). See the api "
                             "container's log, then retry.")


def public(row: EnvironmentFirstAdmin | None) -> dict | None:
    if row is None:
        return None
    return {"first_name": row.first_name, "last_name": row.last_name, "email": row.email,
            "password_mode": row.password_mode, "done": row.done_at is not None}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8a4 .venv/bin/pytest -q tests/test_deploy_first_admins.py tests/test_portal_compat.py tests/test_deploy_models.py tests/test_scaffold.py`
Expected: PASS (`test_scaffold.py` checks the migration chain).

- [ ] **Step 9: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 migrations/versions/0011_first_admin.py src/sirdar_api/db/models.py src/sirdar_api/deploy/first_admins.py src/sirdar_api/services/portal_policy.py tests/test_deploy_first_admins.py tests/test_portal_compat.py tests/test_deploy_models.py tests/conftest.py
cd ../.. && git add sirdar/api/migrations/versions/0011_first_admin.py sirdar/api/src/sirdar_api/db/models.py sirdar/api/src/sirdar_api/deploy/first_admins.py sirdar/api/src/sirdar_api/services/portal_policy.py sirdar/api/tests/conftest.py sirdar/api/tests/test_deploy_first_admins.py sirdar/api/tests/test_portal_compat.py sirdar/api/tests/test_deploy_models.py
git commit -m "feat(sirdar): the first admin on the environment (migration 0011)

environment_first_admins: names, email, typed (vault) or invite; checks
against ServerSherpa's own password bar, pinned by test_portal_compat.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8a4
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8a4_source
```

---

### Task 5: Step 11, its playbook and `ss-stack admin`

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py` (step 11 `first_admin`; `plan_for(..., first_admin=False)`; docstring)
- Create: `sirdar/api/src/sirdar_api/deploy/ansible/first_admin.yml`
- Modify: `deploy/stack/ss-stack` (the `admin` command; usage lines)
- Modify: `sirdar/api/tests/test_deploy_playbooks.py`, `deploy/tests/test_ss_stack.py`

**Interfaces:**
- Produces:
  - `StepDef(11, "first_admin", "Create the first admin", "first_admin.yml", 10 * 60)` (Ansible). Number 11 is shared with `export`, which never meets an Update plan.
  - `steps.plan_for(mode, *, restore=False, publish=False, vm=False, cloud=False, go_live=False, snapshot=False, smoke=True, first_admin=False)`: `first_admin=True` inserts `first_admin` right after `up`; `ValueError` unless `mode == "update"` and not `restore`.
  - `ss-stack admin <env-dir> <bootstrap-admin args…>` → `docker compose … -f api/compose.yml exec -T api serversherpa bootstrap-admin <args…>`; stdin passes through; its exit code is the command's.
  - `first_admin.yml` vars: `ss_stack`, `env_dir`, `admin_email`, `admin_first_name`, `admin_last_name`, `admin_role`, `admin_invite`, `admin_password` (typed only), `admin_link_minutes`. Reports `first_admin_rc` through `set_stats`; fails unless the exit code is 0 or 1.

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/test_deploy_playbooks.py`, update `test_plans`' first assertion to the new list (step 11 `first_admin` sits between `up` and `export`):

```python
    assert [s.number for s in steps.STEPS] == [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11,
                                               11, 12, 13, 13, 14, 14, 15, 15, 16, 17, 18, 19]
```

In `test_playbook_shape`, extend the secret check so `admin_password` needs `no_log` too:

```python
        if (("env_file_b64" in text or "keys_enc_b64" in text or "admin_password" in text)
                and "block" not in task):
            assert task.get("no_log") is True, f"{step.playbook}: {task['name']} needs no_log"
```

Append:

```python
UPDATE_PLAN = ["preflight", "bootstrap", "fetch", "render", "build", "dump", "up"]


def test_first_admin_step_follows_start_services():
    def keys(**kw):
        return [s.key for s in steps.plan_for("update", first_admin=True, **kw)]
    assert keys() == [*UPDATE_PLAN, "first_admin"]
    assert keys(publish=True) == [*UPDATE_PLAN, "first_admin", "dns", "proxy", "smoke"]
    assert keys(vm=True) == ["provision", *UPDATE_PLAN, "first_admin"]
    assert keys(cloud=True) == ["do_prepare", *UPDATE_PLAN, "first_admin", "dns",
                                "slot_smoke"]
    assert keys(cloud=True, go_live=True)[-1] == "go_live"
    assert [s.number for s in steps.plan_for("update", first_admin=True, publish=True)] == [
        1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14]
    assert steps.STEPS_BY_KEY["first_admin"].name == "Create the first admin"
    for mode, kw in (("reset", {}), ("update", {"restore": True}), ("teardown", {}),
                     ("snapshot", {}), ("restore_dump", {})):
        with pytest.raises(ValueError):
            steps.plan_for(mode, first_admin=True, **kw)


FAKE_SS_STACK = """#!/usr/bin/env bash
# the playbook looks for this case label, as in the real ss-stack
case "${1:-}" in
  admin) ;;
esac
printf '%s\\n' "$*" >> "$ADMIN_LOG"
cat > "$ADMIN_LOG.stdin"
exit "${FAKE_RC:-0}"
"""


def _admin_target(tmp_path: Path) -> tuple[dict, dict, Path]:
    env_dir, env = _target(tmp_path)
    stack = tmp_path / "fake-ss-stack"
    stack.write_text(FAKE_SS_STACK)
    stack.chmod(0o755)
    (tmp_path / "admin.log").touch()
    env = {**env, "ADMIN_LOG": str(tmp_path / "admin.log")}
    vars_ = {**_common(env_dir), "ss_stack": str(stack), "admin_email": "ada@test.example.com",
             "admin_first_name": "Ada", "admin_last_name": "Lovelace",
             "admin_role": "super_admin", "admin_invite": False,
             "admin_password": "Stdin-Only-Password-42", "admin_link_minutes": 240}
    return vars_, env, tmp_path / "admin.log"


def test_first_admin_playbook_puts_the_password_on_stdin_only(tmp_path):
    vars_, env, log = _admin_target(tmp_path)
    result, _ = _play(tmp_path, "first_admin.yml", vars_, env)
    out = result.stdout + result.stderr
    assert result.returncode == 0, out
    argv = log.read_text()
    assert argv.split() == ["admin", vars_["env_dir"], "--email", "ada@test.example.com",
                            "--first-name", "Ada", "--last-name", "Lovelace", "--role",
                            "super_admin", "--link-minutes", "240", "--password-stdin"]
    assert Path(str(log) + ".stdin").read_text() == "Stdin-Only-Password-42\n"
    assert "Stdin-Only-Password-42" not in argv and "Stdin-Only-Password-42" not in out


def test_first_admin_playbook_invites_without_stdin(tmp_path):
    vars_, env, log = _admin_target(tmp_path)
    vars_ = {**vars_, "admin_invite": True, "admin_password": ""}
    result, _ = _play(tmp_path, "first_admin.yml", vars_, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert log.read_text().split()[-1] == "--invite"
    assert Path(str(log) + ".stdin").read_text() == ""


@pytest.mark.parametrize("rc, ok", [(0, True), (1, True), (2, False), (3, False), (5, False)])
def test_first_admin_playbook_exit_codes(tmp_path, rc, ok):
    vars_, env, _ = _admin_target(tmp_path)
    result, _ = _play(tmp_path, "first_admin.yml", vars_, {**env, "FAKE_RC": str(rc)})
    out = result.stdout + result.stderr
    assert (result.returncode == 0) is ok, out
    if not ok:
        assert f"serversherpa bootstrap-admin exited with {rc}." in out
    assert "Stdin-Only-Password-42" not in out


def test_first_admin_playbook_explains_an_old_checkout(tmp_path):
    vars_, env, log = _admin_target(tmp_path)
    old = tmp_path / "old-ss-stack"
    old.write_text("#!/bin/sh\nexit 2\n")
    old.chmod(0o755)
    result, _ = _play(tmp_path, "first_admin.yml", {**vars_, "ss_stack": str(old)}, env)
    assert result.returncode != 0
    assert "This commit's ss-stack has no admin command" in result.stdout
    assert log.read_text() == ""
```

In `deploy/tests/test_ss_stack.py`, append:

```python
def test_admin_runs_bootstrap_admin_in_the_api_container(env_dir: Path,
                                                         fake: dict[str, str]) -> None:
    out = subprocess.run(["bash", str(SS_STACK), "admin", str(env_dir), "--email",
                          "ada@test.example.com", "--password-stdin"], env=fake,
                         capture_output=True, text=True, input="Stdin-Only-Password-42\n")
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, "api", "exec -T api serversherpa bootstrap-admin "
                              "--email ada@test.example.com --password-stdin")]
    assert "Stdin-Only-Password-42" not in "\n".join(calls(fake))


def test_admin_passes_the_exit_code_through(env_dir: Path, fake: dict[str, str],
                                            tmp_path: Path) -> None:
    docker = tmp_path / "bin" / "docker"
    docker.write_text("#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$DOCKER_LOG\"\nexit 3\n")
    out = run(fake, "admin", str(env_dir), "--invite")
    assert out.returncode == 3


def test_admin_needs_arguments(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "admin", str(env_dir))
    assert out.returncode == 2
    assert calls(fake) == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8a5 .venv/bin/pytest -q tests/test_deploy_playbooks.py -k "plans or first_admin or playbook_shape or every_playbook"` and, from the worktree root, `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -c deploy/pytest.ini deploy/tests/test_ss_stack.py -k admin`
Expected: FAIL (`plan_for() got an unexpected keyword argument 'first_admin'`; ss-stack prints its usage for `admin`).

- [ ] **Step 3: Step 11 and `plan_for`**

In `sirdar/api/src/sirdar_api/deploy/steps.py`, add to `STEPS` right after the `export` line:

```python
    StepDef(11, "first_admin", "Create the first admin", "first_admin.yml", 10 * 60),
```

Add after `_CLOUD_PLANS`:

```python
def _with_first_admin(keys: tuple[str, ...]) -> tuple[str, ...]:
    """Step 11 right after Start services: the api is up, and nothing has
    published the environment yet."""
    at = keys.index("up") + 1
    return (*keys[:at], "first_admin", *keys[at:])
```

Give `plan_for` a `first_admin: bool = False` keyword. At its top:

```python
    if first_admin and (mode != "update" or restore):
        raise ValueError("only an Update that starts empty creates the first admin")
```

In the cloud branch, replace `return [STEPS_BY_KEY[k] for k in keys]` with:

```python
        if first_admin:
            keys = _with_first_admin(keys)
        return [STEPS_BY_KEY[k] for k in keys]
```

and in the non-cloud path, right before the final `return`:

```python
    if first_admin:
        keys = _with_first_admin(keys)
```

Extend the module docstring's first paragraph with: "11 Create the first admin follows Start services in the first Update of an environment that starts empty (spec 2026-10-07 §3); it shares 11 with Take snapshot, which never meets an Update."

- [ ] **Step 4: `first_admin.yml`**

Create `sirdar/api/src/sirdar_api/deploy/ansible/first_admin.yml`:

```yaml
# Step 11 — Create the first admin: the first Update of an environment that
# starts empty runs `serversherpa bootstrap-admin` in its api container
# (ss-stack admin). A typed password reaches the command only as stdin, and
# the task is no_log; an invite has no password. Exit 1 (the account exists)
# counts as done. The exit code goes to Sirdar through set_stats, which
# explains the others in the step's log.
- name: Create the first admin
  hosts: target
  gather_facts: false
  tasks:
    - name: Does this checkout's ss-stack have the admin command?
      ansible.builtin.command:
        argv: [grep, -q, "^  admin)", "{{ ss_stack }}"]
      register: knows_admin
      changed_when: false
      failed_when: false

    - name: Stop when it doesn't
      ansible.builtin.fail:
        msg: >-
          This commit's ss-stack has no admin command, so Sirdar can't create the
          first admin. Deploy a newer commit.
      when: knows_admin.rc != 0

    - name: serversherpa bootstrap-admin
      ansible.builtin.command:
        argv: >-
          {{ [ss_stack, 'admin', env_dir, '--email', admin_email,
              '--first-name', admin_first_name, '--last-name', admin_last_name,
              '--role', admin_role, '--link-minutes', admin_link_minutes | string]
             + (['--invite'] if admin_invite | bool else ['--password-stdin']) }}
        stdin: "{{ omit if admin_invite | bool else admin_password }}"
      register: created
      changed_when: created.rc == 0
      failed_when: false
      no_log: true

    - name: Report bootstrap-admin's exit code
      ansible.builtin.set_stats:
        data:
          first_admin_rc: "{{ created.rc }}"
        per_host: false
        aggregate: true

    - name: Stop when it refused
      ansible.builtin.fail:
        msg: "serversherpa bootstrap-admin exited with {{ created.rc }}."
      when: created.rc not in [0, 1]
```

(The check matches the case label `  admin)` exactly as `data.yml` matches `  data)`; the tests' fake ss-stack has the same label.)

- [ ] **Step 5: `ss-stack admin`**

In `deploy/stack/ss-stack`, add to the header's usage block, after the `revision` line:

```bash
#   ss-stack admin   <env-dir> <args…>      serversherpa bootstrap-admin in the running api
#                                           container; stdin (a password) passes through
```

and change `usage()` from `sed -n '6,16p'` to `sed -n '6,18p'` (the command block is lines 6–16 today; the two new lines make it 6–18). `ss-stack` with no arguments must print every command and nothing past the block.

Add a case before `*)`:

```bash
  admin)
    # The first admin (Sirdar's step 11): stdin carries a typed password, never
    # argv; the command's exit code is ss-stack's.
    [[ $# -ge 1 ]] || usage
    dc api exec -T api serversherpa bootstrap-admin "$@"
    ;;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8a5 .venv/bin/pytest -q tests/test_deploy_playbooks.py` and, from the worktree root, `bash -n deploy/stack/ss-stack && /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -c deploy/pytest.ini deploy/tests`
Expected: PASS (deploy suite: the previous count plus 3).

- [ ] **Step 7: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/steps.py tests/test_deploy_playbooks.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/ansible/first_admin.yml deploy/stack/ss-stack sirdar/api/tests/test_deploy_playbooks.py deploy/tests/test_ss_stack.py
git commit -m "feat(sirdar): step 11 Create the first admin, and ss-stack admin

After Start services in an Update that starts empty; bootstrap-admin runs
in the api container with the password on stdin only (no_log).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8a5
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8a5_source
```

---

### Task 6: The pipeline runs step 11

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py` (`deployment_summary` gains `first_admin`)
- Create: `sirdar/api/tests/test_deploy_pipeline_first_admin.py`

**Interfaces:**
- Consumes: Task 4's `first_admins.*`, Task 5's `plan_for(..., first_admin=)`.
- Produces:
  - `pipeline.create_deployment(..., first_admin: bool = False)` stores `Deployment.first_admin`; `plan_of(dep)` passes it on.
  - `_Context.vars_for("first_admin")` = common + `first_admins.step_vars(...)`; the password is in the run's redactor.
  - Step 11 is skipped (succeeded, log `first_admins.ALREADY_CREATED`) when the record is done or gone; on exit 0 or 1 the record is marked done (password cleared) in the step's own commit; exit 1 appends `EXISTS_NOTE`; any other exit appends `first_admins.refusal(rc)` and the deployment's `error` ends with it.
  - `deployment_summary` → `"first_admin": dep.first_admin`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_pipeline_first_admin.py`:

```python
"""Step 11 (Create the first admin) in the pipeline: its vars, the password
only in the playbook's extravars (redacted everywhere else), the record
marked done, and our copy for bootstrap-admin's refusals."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment, DeploymentStep, EnvironmentFirstAdmin
from sirdar_api.deploy import first_admins, pipeline
from sirdar_api.deploy.runner import RunResult

from .deploy_factories import (  # noqa: F401
    fake_runner,
    make_environment,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA, _load

TYPED = "Correct-Horse-Battery-9"
ADMIN = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
         "password_mode": "typed", "password": TYPED}


@pytest.fixture
async def fresh(db, deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    env = await make_environment(db, name="fresh", status="new")
    await first_admins.put(db, get_settings(), env.id, first_admins.check(ADMIN))
    await db.commit()
    return env


async def _run(db, env, **kw):
    dep = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, first_admin=True, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


def _rc(rc: int, status: str = "successful") -> RunResult:
    return RunResult(status=status, rc=0 if status == "successful" else 2,
                     data={"first_admin_rc": str(rc)})


async def test_step_11_runs_after_up_with_the_admin_vars(db, fresh, fake_runner):
    fake_runner.results["first_admin"] = _rc(0)
    dep_id = await _run(db, fresh)
    dep, steps, env = await _load(dep_id)
    assert fake_runner.steps() == ["preflight", "bootstrap", "fetch", "render", "build",
                                   "dump", "up", "first_admin"]
    assert [s.number for s in steps][-2:] == [10, 11]
    assert (dep.status, dep.first_admin, env.status) == ("succeeded", True, "ready")
    request = next(r for r in fake_runner.requests if r.step == "first_admin")
    assert request.playbook == "first_admin.yml"
    assert {k: request.extravars[k] for k in ("admin_email", "admin_role", "admin_invite",
                                              "admin_password", "admin_link_minutes")} == {
        "admin_email": "ada@test.example.com", "admin_role": "super_admin",
        "admin_invite": False, "admin_password": TYPED, "admin_link_minutes": 240}
    others = [r for r in fake_runner.requests if r.step != "first_admin"]
    assert all("admin_password" not in r.extravars for r in others)
    row = await db.get(EnvironmentFirstAdmin, fresh.id, populate_existing=True)
    assert row.password_enc is None and row.done_at is not None


async def test_the_password_is_redacted_from_every_log(db, fresh, fake_runner):
    fake_runner.output["first_admin"] = [f"echoed {TYPED} by mistake\n"]
    fake_runner.results["first_admin"] = _rc(0)
    dep_id = await _run(db, fresh)
    _, steps, _ = await _load(dep_id)
    logs = "".join(s.log for s in steps)
    assert TYPED not in logs and "[redacted]" in logs


async def test_an_existing_account_counts_as_done(db, fresh, fake_runner):
    fake_runner.results["first_admin"] = _rc(1)
    dep_id = await _run(db, fresh)
    dep, steps, _ = await _load(dep_id)
    assert dep.status == "succeeded"
    assert steps[-1].log.endswith(first_admins.EXISTS_NOTE.format(email="ada@test.example.com"))
    assert (await first_admins.pending(db, fresh.id)) is False


@pytest.mark.parametrize("rc", [2, 3, 4, 5, 9])
async def test_a_refusal_fails_step_11_with_our_copy(db, fresh, fake_runner, rc):
    fake_runner.results["first_admin"] = _rc(rc, status="failed")
    dep_id = await _run(db, fresh)
    dep, steps, env = await _load(dep_id)
    assert (dep.status, dep.failed_step, env.status) == ("failed", 11, "failed")
    assert dep.error.endswith(first_admins.refusal(rc))
    assert steps[-1].log.endswith(first_admins.refusal(rc) + "\n")
    assert await first_admins.pending(db, fresh.id) is True          # the password is kept
    assert TYPED not in dep.error


async def test_a_done_record_skips_step_11(db, fresh, fake_runner):
    await first_admins.mark_done(db, fresh.id)
    await db.commit()
    dep_id = await _run(db, fresh)
    dep, steps, _ = await _load(dep_id)
    assert "first_admin" not in fake_runner.steps()
    assert (steps[-1].key, steps[-1].status, steps[-1].log) == (
        "first_admin", "succeeded", first_admins.ALREADY_CREATED)
    assert dep.status == "succeeded"


async def test_a_retry_from_step_11_keeps_the_flag(db, fresh, fake_runner):
    fake_runner.results["first_admin"] = _rc(3, status="failed")
    failed = await _run(db, fresh)
    fake_runner.results["first_admin"] = _rc(0)
    dep = await pipeline.create_deployment(db, fresh, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, first_admin=True, start_step=11,
                                           retry_of=failed)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    statuses = dict((await db.execute(
        select(DeploymentStep.key, DeploymentStep.status)
        .where(DeploymentStep.deployment_id == dep.id))).all())
    assert statuses["up"] == "skipped" and statuses["first_admin"] == "succeeded"
    assert (await db.get(Deployment, dep.id, populate_existing=True)).first_admin is True


async def test_a_seeded_update_has_no_step_11(db, fresh):
    with pytest.raises(ValueError):
        await pipeline.create_deployment(db, fresh, mode="reset", git_ref="main", sha=SHA,
                                         actor_id=None, first_admin=True)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8a6 .venv/bin/pytest -q tests/test_deploy_pipeline_first_admin.py`
Expected: FAIL (`create_deployment() got an unexpected keyword argument 'first_admin'`).

- [ ] **Step 3: Records**

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`:

- import `first_admins` in the `from sirdar_api.deploy import (...)` list;
- `plan_of`: add `first_admin=dep.first_admin` to the `plan_for(...)` call;
- `create_deployment`: add the keyword `first_admin: bool = False` (after `go_live`), pass `first_admin=first_admin` to its `plan_for(...)` call, and `first_admin=first_admin` to `Deployment(...)`. Extend its docstring: "first_admin: its plan has step 11 Create the first admin (an Update that starts empty)."

- [ ] **Step 4: Step 11's vars and redaction**

In `_prepare`, right after `secrets = {**secrets, **snapshot_keys}`:

```python
    if dep.first_admin:
        try:
            admin_vars, admin_secrets = await first_admins.step_vars(db, settings, env.id)
        except (vault.SecretsKeyMissing, vault.SecretUnreadable):
            raise PrepareError("Sirdar can't read the first admin's password with the current "
                               "SIRDAR_SECRETS_KEY. Set it again on the environment's Settings "
                               "tab, then retry.") from None
        step_vars["first_admin"] = admin_vars
        extra_secrets = [*extra_secrets, *admin_secrets]
```

(`_Context.vars_for` already returns `{**common, **step_vars[key]}` for any other step key, so step 11 gets `ss_stack`, `env_dir` and the admin vars.)

- [ ] **Step 5: Running step 11**

Add near `KEPT_DUMP`:

```python
async def _append_log(step_id: uuid.UUID, text: str) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(DeploymentStep).where(DeploymentStep.id == step_id)
                        .values(log=DeploymentStep.log + text))
        await s.commit()
```

In `_run`'s step loop, right after the `if step.key == "dump" and dep.dump_path:` block:

```python
                    if step.key == "first_admin" and not await first_admins.pending(db, env.id):
                        # Done by an earlier attempt (or the record was removed).
                        await _save_log(step.id, first_admins.ALREADY_CREATED)
                        step.status, step.finished_at = "succeeded", _now()
                        await db.commit()
                        continue
```

In the failure branch (`if result.status != "successful":`), after `note = IN_PLACE_NOTE.format(...) if in_place else ""`:

```python
                        if step.key == "first_admin":
                            note = first_admins.refusal(first_admins.exit_code(result.data))
```

In the chain of `elif step.key == …` branches that runs after a step succeeds, add:

```python
                    elif step.key == "first_admin":
                        if first_admins.exit_code(result.data) == 1:
                            row = await first_admins.get(db, env.id)
                            await _append_log(step.id, first_admins.EXISTS_NOTE.format(
                                email=row.email if row else "the first admin"))
                        await first_admins.mark_done(db, env.id)
```

(the `await db.commit()` that follows the chain saves the step status and the cleared password together).

- [ ] **Step 6: The deployment JSON**

In `sirdar/api/src/sirdar_api/deploy/serialize.py`, `deployment_summary`: add `"first_admin": dep.first_admin,` after `"go_live": dep.go_live,`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8a6 .venv/bin/pytest -q tests/test_deploy_pipeline_first_admin.py tests/test_deploy_pipeline.py tests/test_deploy_pipeline_vm.py tests/test_deploy_pipeline_do.py tests/test_deploy_deployments_api.py`
Expected: PASS. If a deployment-shape test pins the summary's keys, add `"first_admin": False` to its expected dict.

- [ ] **Step 8: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/pipeline.py src/sirdar_api/deploy/serialize.py tests/test_deploy_pipeline_first_admin.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/tests/test_deploy_pipeline_first_admin.py
git add sirdar/api/tests/test_deploy_deployments_api.py 2>/dev/null || true
git commit -m "feat(sirdar): the pipeline runs step 11 and forgets the password

Admin vars only in step 11's extravars, redacted everywhere; done on exit 0
or 1 (password cleared in the same commit); our copy for every refusal.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8a6
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8a6_source
```

---

### Task 7: The API: `first_admin` on create, PUT, defaults, deploys

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`create_new(..., first_admin=None)`)
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py` (`environment_out` gains `first_admin`)
- Create: `sirdar/api/tests/test_deploy_first_admin_api.py`
- Modify: `sirdar/api/tests/test_deploy_environments_api.py` (`ENV_KEYS`, `test_environment_defaults`)

**Interfaces:**
- Consumes: Tasks 4 and 6.
- Produces:
  - `POST /api/deploy/environments` body gains `first_admin?: {first_name, last_name, email, password_mode: "typed"|"invite", password?: string|null}` (mode `new` only; 422 `first_admin_not_allowed` on adopt; 422 `first_admin_with_seed` with `snapshot_id`; the table's codes from `first_admins.check`). Audit `changes.first_admin = {"email", "password_mode"}` (never the password).
  - `PUT /api/deploy/environments/{name}/first-admin` (`deploy:add`), same body → environment JSON. 404 `first_admin_not_set`; 409 `first_admin_done`; 409 `deploy_in_progress`. Audit `deploy.first_admin_set` with `{"environment", "email", "password_mode"}`.
  - `GET /api/deploy/environment-defaults` gains `"first_admin": {"password_min_length": 8, "role": "super_admin", "link_minutes": 240}`.
  - Environment JSON gains `"first_admin": first_admins.public(row)`.
  - `POST …/deployments` mode `update` (SSH, VM and DigitalOcean) sets `first_admin=True` when the record is pending and the deploy doesn't restore a snapshot; Retry keeps `dep.first_admin`; audit `changes.first_admin = True` when set.
  - `environments.create_new(..., first_admin: dict | None = None)`: `first_admin` with `snapshot_id` raises `EnvError("first_admin_with_seed")`; otherwise checks (`FirstAdminError` → `EnvError` same code and extra) and stores it.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_first_admin_api.py`:

```python
"""The first admin through the API: create, the defaults' policy hint,
PUT …/first-admin before it's used, and the first deploy's step 11. The
password never reaches a response or an audit row."""

import uuid

import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog
from sirdar_api.deploy import pipeline

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_runner,
    leak_guard,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_deployments_api import LS, SHA

URL = "/api/deploy/environments"
TYPED = "Correct-Horse-Battery-9"
ADMIN = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
         "password_mode": "typed", "password": TYPED}
NEW = {"mode": "new", "name": "fresh", "type": "custom", "target": "ssh",
       "proxy_ip": "10.10.48.6", "publish": False}


@pytest.fixture
def target(deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    return ssh_server


def _code(resp) -> tuple[int, str]:
    return resp.status_code, resp.json()["detail"]["code"]


async def test_create_stores_it_and_never_echoes_the_password(client, db, target, leak_guard):
    leak_guard.append(TYPED)
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "first_admin": ADMIN})
    assert resp.status_code == 201, resp.text
    assert resp.json()["first_admin"] == {"first_name": "Ada", "last_name": "Lovelace",
                                          "email": "ada@test.example.com",
                                          "password_mode": "typed", "done": False}
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_create"))).one()
    assert audit["first_admin"] == {"email": "ada@test.example.com", "password_mode": "typed"}


@pytest.mark.parametrize("change, expected", [
    ({"password": "short"}, (422, "first_admin_password_too_short")),
    ({"email": "nope"}, (422, "first_admin_email_invalid")),
    ({"password_mode": "invite"}, (422, "first_admin_password_not_allowed")),
])
async def test_create_refusals(client, db, target, change, expected):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "first_admin": {**ADMIN, **change}})
    assert _code(resp) == expected
    if expected[1] == "first_admin_password_too_short":
        assert resp.json()["detail"]["min_length"] == 8
    assert TYPED not in resp.text


async def test_not_with_a_seed_nor_on_adopt(client, db, target):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "snapshot_id": str(uuid.uuid4()),
                                                   "first_admin": ADMIN})
    assert _code(resp) == (422, "first_admin_with_seed")
    resp = await client.post(URL, headers=h, json={"mode": "adopt", "name": "x",
                                                   "type": "custom", "target": "ssh",
                                                   "first_admin": ADMIN})
    assert _code(resp) == (422, "first_admin_not_allowed")


async def test_defaults_carry_the_policy_hint(client, db):
    h = await auth_headers(client, db)
    resp = await client.get("/api/deploy/environment-defaults", headers=h)
    assert resp.json()["first_admin"] == {"password_min_length": 8, "role": "super_admin",
                                          "link_minutes": 240}


async def test_put_replaces_it_until_done(client, db, target, leak_guard):
    leak_guard.append(TYPED)
    h = await auth_headers(client, db)
    assert _code(await client.put(f"{URL}/fresh/first-admin", headers=h, json=ADMIN)) == (
        404, "environment_not_found")
    await client.post(URL, headers=h, json=NEW)
    assert _code(await client.put(f"{URL}/fresh/first-admin", headers=h, json=ADMIN)) == (
        404, "first_admin_not_set")
    await client.post(URL, headers=h, json={**NEW, "name": "fresh2", "first_admin": ADMIN})
    resp = await client.put(f"{URL}/fresh2/first-admin", headers=h,
                            json={**ADMIN, "password_mode": "invite", "password": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["first_admin"]["password_mode"] == "invite"
    from sirdar_api.deploy import first_admins
    from sirdar_api.deploy.environments import get_by_name
    env = await get_by_name(db, "fresh2")
    await first_admins.mark_done(db, env.id)
    await db.commit()
    assert _code(await client.put(f"{URL}/fresh2/first-admin", headers=h, json=ADMIN)) == (
        409, "first_admin_done")


async def test_the_first_deploy_runs_step_11_and_a_later_one_does_not(
        client, db, target, fake_runner):
    from sirdar_api.deploy.runner import RunResult
    fake_runner.results["first_admin"] = RunResult(status="successful", rc=0,
                                                   data={"first_admin_rc": "0"})
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json={**NEW, "first_admin": ADMIN})
    resp = await client.post(f"{URL}/fresh/deployments", headers=h, json={"mode": "update"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["first_admin"] is True
    assert "first_admin" in [s["key"] for s in resp.json()["steps"]]
    await pipeline.wait(uuid.UUID(resp.json()["id"]))
    again = await client.post(f"{URL}/fresh/deployments", headers=h, json={"mode": "update"})
    assert again.json()["first_admin"] is False
    assert "first_admin" not in [s["key"] for s in again.json()["steps"]]
```

In `sirdar/api/tests/test_deploy_environments_api.py`, add `"first_admin"` to `ENV_KEYS`, and in `test_environment_defaults`' expected dict add:

```python
        "first_admin": {"password_min_length": 8, "role": "super_admin", "link_minutes": 240},
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8a7 .venv/bin/pytest -q tests/test_deploy_first_admin_api.py tests/test_deploy_environments_api.py -k "first_admin or defaults or permissions"`
Expected: FAIL (the field is ignored; `first_admin` missing from the defaults and the JSON).

- [ ] **Step 3: `create_new` stores it**

In `sirdar/api/src/sirdar_api/deploy/environments.py`, import `first_admins` in the `from sirdar_api.deploy import (...)` list. Add the keyword `first_admin: dict | None = None` to `create_new` (after `do`), and right after `_precheck(...)`:

```python
    admin_spec = None
    if first_admin is not None:
        if snapshot_id is not None:
            raise EnvError("first_admin_with_seed")    # a seed already has its users
        try:
            admin_spec = first_admins.check(first_admin)
        except first_admins.FirstAdminError as e:
            raise EnvError(e.code, **e.extra) from None
```

Then store it on both create paths. In the DigitalOcean branch replace `return await _create_on_do(...)` with:

```python
        env = await _create_on_do(db, settings, name=name, type_=type_, git_ref=git_ref,
                                  domain=domain, ports=all_ports, actor_id=actor_id,
                                  snapshot_id=snapshot_id, do=do or {})
        if admin_spec is not None:
            await first_admins.put(db, settings, env.id, admin_spec)
        return env
```

and right before the final `return env`:

```python
    if admin_spec is not None:
        await first_admins.put(db, settings, env.id, admin_spec)
```

Extend the docstring: "first_admin: the first super admin step 11 of the first deploy creates (never with a snapshot)."

- [ ] **Step 4: Routes**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`:

- import `first_admins` in the `from sirdar_api.deploy import (...)` list and `from sirdar_api.services import portal_policy`;
- add `"first_admin_not_set": 404, "first_admin_done": 409` to `_ENV_STATUS`;
- add the model:

```python
class FirstAdminIn(BaseModel):
    """The first super admin of an environment that starts empty. The
    password is write-only (typed mode); an invite has none."""
    first_name: str = Field(max_length=100)
    last_name: str = Field(max_length=100)
    email: str = Field(max_length=254)
    password_mode: Literal["typed", "invite"]
    password: str | None = Field(default=None, max_length=1024, repr=False)
```

  (No `min_length` on the password: the bar is ServerSherpa's, checked by `first_admins.check` with its own code. `max_length=1024` is the transport limit every Sirdar password field has.)

- `EnvironmentIn` gains `first_admin: FirstAdminIn | None = None  # mode "new" only`;
- `create_environment`: next to the other adopt refusals, `if body.mode == "adopt" and body.first_admin is not None: raise HTTPException(status_code=422, detail={"code": "first_admin_not_allowed"})`; pass `first_admin=body.first_admin.model_dump() if body.first_admin else None` to `environments.create_new`; in the `changes` block add:

```python
        if body.first_admin is not None:
            changes["first_admin"] = {"email": body.first_admin.email.strip(),
                                      "password_mode": body.first_admin.password_mode}
```

- `environment_defaults` gains:

```python
        "first_admin": {"password_min_length": portal_policy.PASSWORD_MIN_LENGTH,
                        "role": portal_policy.FIRST_ADMIN_ROLE,
                        "link_minutes": portal_policy.FIRST_ADMIN_LINK_MINUTES},
```

- the PUT route (after `update_environment`):

```python
@router.put("/environments/{name}/first-admin")
async def set_first_admin(name: str, body: FirstAdminIn, request: Request, db: DbSession,
                          actor: AuthContext = require_permission("deploy", "add")):
    """Change the first admin before step 11 used it: a new password (the
    environment refused the last one) or an invite instead."""
    env = await _environment(db, name)
    row = await first_admins.get(db, env.id)
    if row is None:
        raise _refuse(404, "first_admin_not_set")
    if row.done_at is not None:
        raise _refuse(409, "first_admin_done")
    if await environments.is_deploying(db, env.id):
        raise _refuse(409, "deploy_in_progress")
    settings = get_settings()
    if not vault.is_configured(settings):
        raise _refuse(400, "secrets_key_missing")
    try:
        spec = first_admins.check(body.model_dump())
    except first_admins.FirstAdminError as e:
        raise _refuse(422, e.code, **e.extra) from None
    await first_admins.put(db, settings, env.id, spec)
    audit(db, actor_id=actor.user.person_id, action="deploy.first_admin_set",
          entity_type="environment", entity_id=env.name, ip=client_ip(request),
          changes={"environment": env.name, "email": spec["email"],
                   "password_mode": spec["password_mode"]})
    await db.commit()
    await db.refresh(env)
    return await serialize.environment_out(db, env)
```

- `_launch` gains `first_admin: bool = False`, passes `first_admin=first_admin` to `pipeline.create_deployment`, and `if first_admin: changes["first_admin"] = True`;
- `start_deployment`: in the final `_launch(...)` (SSH and VM Update/Reset), add `first_admin=body.mode == "update" and snapshot is None and await first_admins.pending(db, env.id)`;
- `_start_do_update`: in its `_launch(...)` add `first_admin=snapshot is None and await first_admins.pending(db, env.id)`;
- `retry_deployment`: add `first_admin=dep.first_admin` to its `plan_for(...)` call and to its `_launch(...)` call.

- [ ] **Step 5: The environment JSON**

In `sirdar/api/src/sirdar_api/deploy/serialize.py`, import `first_admins` (`from sirdar_api.deploy import envfile, first_admins, snapshots, targets, vms`) and in `environment_out` add after `"publish": env.publish,`:

```python
        "first_admin": first_admins.public(await first_admins.get(db, env.id)),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8a7 .venv/bin/pytest -q tests/test_deploy_first_admin_api.py tests/test_deploy_environments_api.py tests/test_deploy_deployments_api.py tests/test_deploy_do_deployments_api.py tests/test_deploy_do_environments.py`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/api/routes/deploy.py src/sirdar_api/deploy/environments.py src/sirdar_api/deploy/serialize.py tests/test_deploy_first_admin_api.py tests/test_deploy_environments_api.py
cd ../.. && git add sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/tests/test_deploy_first_admin_api.py sirdar/api/tests/test_deploy_environments_api.py
git commit -m "feat(sirdar): first_admin on create, PUT before use, step 11 on the first deploy

The defaults carry ServerSherpa's password bar for the form; the password
never reaches a response or an audit row.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8a7
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8a7_source
```

---

### Task 8: Web types and copy for the first admin

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts`
- Modify: `sirdar/web/src/lib/sirdarApi.test.ts`

**Interfaces:**
- Produces (for 8c's Data step):
  - `interface NewFirstAdmin { first_name: string; last_name: string; email: string; password_mode: 'typed' | 'invite'; password?: string | null }`
  - `interface EnvFirstAdmin { first_name: string; last_name: string; email: string; password_mode: 'typed' | 'invite'; done: boolean }`
  - `Environment.first_admin: EnvFirstAdmin | null`; `NewEnvironmentBody.first_admin?: NewFirstAdmin`; `EnvironmentDefaults.first_admin: { password_min_length: number; role: string; link_minutes: number }`; `DeploymentSummary.first_admin: boolean`.
  - `setFirstAdmin(name: string, body: NewFirstAdmin) => Promise<Environment>` (`PUT /deploy/environments/{name}/first-admin`).
  - `MESSAGES` for every code in this plan's table; `deployErrorText` adds "(at least N characters)" for `first_admin_password_too_short`.

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/lib/sirdarApi.test.ts`:

- add `'deploy/first_admins.py'` to the scanner's file list in `deployCodes()`, and `FirstAdminError` to the alternation in its second regex (`(?:EnvError|RefError|…|DoEnvError|FirstAdminError)\("([a-z_]+)"`);
- add to the scanner test's `for (const code of [...])` list: `'first_admin_with_seed', 'first_admin_password_too_short', 'first_admin_not_set', 'first_admin_done'`;
- add to `CALLS`:

```ts
  { name: 'setFirstAdmin', call: () => sirdar.setFirstAdmin('fresh', {
      first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.example.com', password_mode: 'invite', password: null }),
    path: '/deploy/environments/fresh/first-admin', method: 'PUT',
    body: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.example.com', password_mode: 'invite', password: null } },
```

- append:

```ts
it('a short first-admin password names the bar', () => {
  expect(sirdar.deployErrorText(new ApiError(422, 'first_admin_password_too_short',
    { code: 'first_admin_password_too_short', min_length: 8 }), 'x'))
    .toBe("The password is too short for ServerSherpa's password policy (at least 8 characters).");
});
```

(`setFirstAdmin`'s fetch mock answers like the other `CALLS` entries; nothing else is needed.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/lib/sirdarApi.test.ts`
Expected: FAIL (`sirdar.setFirstAdmin is not a function`; `missing` lists the new codes).

- [ ] **Step 3: Types, call and copy**

In `sirdar/web/src/lib/sirdarApi.ts`:

- add to `MESSAGES` (after the DigitalOcean block, under a `// the first admin` comment) every row of this plan's code table, copy exactly as written there;
- in `deployErrorText`, before `const base = errorText(err, fallback);`:

```ts
  if (d && typeof (d as { min_length?: unknown }).min_length === 'number' && err instanceof ApiError
      && err.code === 'first_admin_password_too_short') {
    const n = (d as { min_length: number }).min_length;
    return `${errorText(err, fallback).replace(/\.$/, '')} (at least ${n} characters).`;
  }
```

  and add `min_length?: unknown;` to the `errorDetail<{…}>` type there;
- add the interfaces:

```ts
/** The first super admin step 11 of the first deploy creates (an environment that starts empty). */
export interface NewFirstAdmin {
  first_name: string; last_name: string; email: string; password_mode: 'typed' | 'invite';
  /** typed only; write-only */
  password?: string | null;
}
export interface EnvFirstAdmin {
  first_name: string; last_name: string; email: string; password_mode: 'typed' | 'invite'; done: boolean;
}
```

- `DeploymentSummary` gains `/** Its plan has step 11, Create the first admin. */ first_admin: boolean;`
- `Environment` gains `first_admin: EnvFirstAdmin | null;`
- `EnvironmentDefaults` gains `first_admin: { password_min_length: number; role: string; link_minutes: number };`
- `NewEnvironmentBody` gains `/** An environment that starts empty: its first super admin. */ first_admin?: NewFirstAdmin;`
- after `addSlot`:

```ts
export const setFirstAdmin = (name: string, body: NewFirstAdmin) =>
  sendJson<Environment>('PUT', `${envPath(name)}/first-admin`, body);
```

- [ ] **Step 4: Fixtures**

Add `first_admin: null` to every `Environment` fixture and `first_admin: false` to every `DeploymentSummary` fixture the type checker flags (`pages/environments/testData.ts`, `pages/dashboard/testData.ts`), and `first_admin: { password_min_length: 8, role: 'super_admin', link_minutes: 240 }` to `DEFAULTS` in `pages/environments/testData.ts`. These two files are Task 8's too.

- [ ] **Step 5: Run the tests and the build**

Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: PASS; the build type-checks.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/lib/sirdarApi.test.ts sirdar/web/src/pages/environments/testData.ts sirdar/web/src/pages/dashboard/testData.ts
git commit -m "feat(sirdar-web): first-admin types, setFirstAdmin and copy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, full suites, live verify (controller)

**Files:**
- Modify: `deploy/stack/README.md` (step 7 "First admin")
- Modify: `sirdar/README.md` ("Deploy pipeline (environments)": the first admin)
- Modify: `README.md` (root: `bootstrap-admin` flags)

- [ ] **Step 1: Docs**

`deploy/stack/README.md` step 7 becomes:

```markdown
7. **First admin** (an empty database has no users). Sirdar does this itself on
   the first deploy of an environment that starts empty (step 11). By hand:

   ```bash
   /opt/serversherpa/uat/repo/deploy/stack/ss-stack admin /opt/serversherpa/uat \
     --email you@example.com --first-name First --last-name Last --role super_admin
   ```

   It prompts for the password twice (hidden). `--password-stdin` reads it
   from stdin instead (one line); `--invite` creates the account without one
   and emails a set-password link (needs `--link-minutes` and mail). With a
   typed password, `--link-minutes 240` also emails a change-password link
   valid 4 hours. No password is ever emailed. Exit codes: 1 the account
   exists, 2 usage, 3 the password is too short (`SS_PASSWORD_MIN_LENGTH`,
   default 8), 4 no such role, 5 mail isn't configured.
```

`sirdar/README.md`, in "Deploy pipeline (environments)": a paragraph "**First admin.** A new environment that starts empty can name its first super admin (first name, last name, email; a typed password checked against ServerSherpa's bar, or an invite). The first deploy's step 11 runs `ss-stack admin … bootstrap-admin --role super_admin --link-minutes 240` in the api container, with a typed password on stdin only; then Sirdar clears the stored password. A refusal (exit 3) fails step 11: set a new password (`PUT /api/deploy/environments/<name>/first-admin`), then retry from step 11. Mail goes through the environment's own notification-worker (Mailpit unless SMTP is set)."

Root `README.md`: next to the existing `bootstrap-admin` line, list the four new flags in one sentence.

- [ ] **Step 2: Full suites and lint**

Run (foreground, 600000 ms timeouts):

```bash
cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_p8a9 .venv/bin/pytest -q
cd ../sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8a9 .venv/bin/pytest -q
cd ../.. && /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -c deploy/pytest.ini deploy/tests
npm --prefix sirdar/web test && npm --prefix sirdar/web run build
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src tests migrations
cd ../../api && .venv/bin/ruff check --select E,F,W src/serversherpa/services/first_admin.py src/serversherpa/cli.py
```

Expected: every suite green. Then drop `serversherpa_test_p8a9`, `sirdar_test_p8a9` and `sirdar_test_p8a9_source`.

- [ ] **Step 3: Live verify (on the dev stack; nothing in uat or production)**

1. On a throwaway SSH or ESXi environment (e.g. `fresh1`), create it from the API (8c's page doesn't exist yet): `POST /api/deploy/environments` with `first_admin` typed (a password of 8+ characters you generate locally). Check the JSON shows `first_admin.done: false` and no password; check the audit row.
2. Deploy. Step 11 appears after Start services; its log shows nothing of the password (and neither do the logs of steps 1–10). `environment_first_admins.password_enc` is NULL afterwards.
3. Mailpit (the environment's `mailpit` port): one "Your ServerSherpa account is ready" mail to the admin, with a change-password link valid 4 hours and no password. Sign in to the portal with the typed password; open the link; set a new password; sign in again.
4. A second throwaway environment with `password_mode: "invite"`: step 11 succeeds; the mail is the set-password invite; the account can't sign in until the link is used; after it, it can.
5. Refusal: create a third with a typed password, then, before deploying, set `SS_PASSWORD_MIN_LENGTH=40` in its `.env` by hand after step 4 renders it (or run `ss-stack admin` by hand with a short password): step 11 fails with the copy for exit 3; `PUT …/first-admin` with a longer password; Retry from step 11 succeeds.
6. `docker compose … exec -T api serversherpa bootstrap-admin --help` on the environment lists the four flags; `ps` on the host while step 11 runs never shows the password (it isn't in argv).
7. Delete all three environments. Record results in `.superpowers/sdd/p8a-live-verify.md` (git-ignored).
</content>
</invoke>
