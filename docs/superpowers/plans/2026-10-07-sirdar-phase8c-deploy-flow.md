# Sirdar phase 8c (the step-by-step Deploy page) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One flow on the Deploy page creates **and** deploys a new environment, in seven steps — **Environment, Servers, Target, Extras, Traffic, Data, Review & Deploy** (spec §1) — and replaces the "New environment" dialog:

- Targets, the connection test and the trusted SSH hosts move into the Target step (collapsible); the Environments and Snapshots lists stay below the flow.
- **Extras**: optional apps (Wiki, Kiosk, Status page, Mailpit; API and Portal always on), hosting options (DigitalOcean standby node and test certificate, auto-activate for Blue/Green), integrations (Publish DNS through Cloudflare, mail through Mailpit or SMTP, the Anthropic API key).
- **Traffic** shows, read-only, what will route traffic: the DigitalOcean load balancer, or the Nginx Proxy Manager proxy hosts and the server each points at first.
- **Data**: seed from a snapshot, or start empty with a first super admin (typed password, checked against ServerSherpa's bar, or generate & invite) — plan 8a's API.
- **Review & Deploy**: every choice and one Deploy button that creates the environment, starts its first deployment and opens it. Errors from the API go back to the step that owns them.
- Adopt (hand-built SSH environments) keeps working from a small "Adopt existing" dialog on the Environments list.

The backend gains what the Extras step needs and doesn't exist yet: **turning apps off** (a `STACK_APPS` key `ss-stack` honors, public names only for the apps that run) and **SMTP** (ServerSherpa reads SMTP only from its environment — `SS_SMTP_*` in `config.py`; `deploy/stack/api/compose.yml` hard-codes Mailpit — so Sirdar stores it and writes it into the `.env`).

**Architecture:**

- **Stack** (`deploy/stack`): `STACK_APPS` (comma-separated optional apps, `none` for none; unset = all, so every existing `.env` keeps running everything) — `ss-stack up` scales the apps that are off to zero and stops the status stack; `api/compose.yml` reads `SS_SMTP_HOST/PORT/USERNAME/PASSWORD/STARTTLS/FROM` from the `.env` with today's Mailpit values as defaults.
- **Sirdar backend**: migration **0013** adds `environments.apps` and the SMTP columns; `deploy/apps.py` checks the apps and the mail settings, renders their `.env` keys (`EXTRA_KEYS` gains `STACK_APPS` and the five non-secret `SS_SMTP_*` keys; `SS_SMTP_PASSWORD` becomes an optional secret, vault-encrypted like `SS_ANTHROPIC_API_KEY`), and says which public names an environment has. Create takes `apps`, `mail` and `secrets` (optional secrets at create). The pipeline renders the apps/mail keys on every target; DigitalOcean's slot smoke test and public smoke test check only the apps that run.
- **Web**: `pages/deploy/flowState.ts` is the pure core (state, defaults, per-step checks, the create body, which step an API code belongs to, the traffic plan). `pages/deploy/DeployFlow.tsx` is the page section (report-generate header with `.rgm-steps`, Back / Next / Deploy). Each step is its own component in `pages/deploy/steps/`. `pages/deploy/TargetPanel.tsx` is today's Deploy-page targets, connection test and trusted-hosts code, moved and made controlled. `NewEnvironmentModal` is deleted; `AdoptEnvironmentModal` keeps its Adopt path.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic (raw SQL), bash (`ss-stack`), Docker Compose; React 18 + TypeScript, Vite, Vitest + Testing Library (jsdom), the portal's `DataTable` / `ComboBox` / `Switch` / `lib/api` through `@portal`.

**Spec:** `docs/superpowers/specs/2026-10-07-sirdar-deploy-flow-design.md` §1 (and the Extras decision). Plans 8a (`2026-10-07-sirdar-phase8a-fresh-start.md`) and 8b (`2026-10-07-sirdar-phase8b-lan-bluegreen.md`) come first: this plan uses their API shapes (`first_admin`, `vm.slots: 2`, `machines`, `lan_slots`) and its migration revises 8b's 0012.

## Global Constraints

**Where and how to work**

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it.
- `sirdar` is both a branch and a folder: use `--` in `git diff` and `git log`.
- Other agents commit in this worktree at the same time: `git add` only your task's files (see "File ownership"); never `git add -A`, never bare `git stash`; retry when `.git/index.lock` is busy. Never `git checkout --` a file another task owns. If a file this plan edits changed since it was written, apply the same edit to the new text and keep their change.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**House rules**

- American English in all copy, comments and docs ("Canceled" for `cancelled`).
- **Step titles use the report-generate header style**: the flow's section has `.rgm-head-text` (`.eyebrow` "Deploy", `h3` the step's title, `.page-hint` the step's description) and `.rgm-steps` with `.rgm-step` / `.rgm-step-num` / `.rgm-step-label` / `.rgm-step-sep`, exactly the classes `NewEnvironmentModal` used.
- **Modals size to their content**: `AdoptEnvironmentModal` gets the report-generate header and a content-matched width class (`sirdar-adopt-card`, `min(640px, 96vw)`).
- Reuse the portal idioms: `DataTable`, `ComboBox` (with `portal`), `Switch` (named export; `label` is its accessible name), segmented radio groups (`.segmented`, `role="radio"`, `arrowNav`), chips (`chip c-green|c-amber|c-red|c-blue|tag`), `.pf-form` with `.field-label` (`span.field-label` for captions that aren't labels), `.sirdar-span2`, `.sirdar-kv`, `Breakable`. **Never a raw `<select>`.**
- **Secrets never appear in a response, a log line, an audit row, an exception message, a `repr()`, a stored step log, or any process's argv or environment**: the SMTP password, the Anthropic API key, the first admin's typed password, and every existing secret. Forms send them write-only; responses say only whether one is set.
- Never use `AVNS_`-prefixed fake passwords.
- **Never invent password rules.** The first admin's bar is ServerSherpa's (`GET /environment-defaults` → `first_admin.password_min_length`); the form shows it and adds nothing. A "type it again" field catches typos and is not a rule. The SMTP password and API key follow the existing `.env` character rule for optional secrets (an escaping limit, not a policy).
- Don't add reader-facing widgets the spec doesn't ask for.

**Backend**

- Python 3.13, Ruff line length 100, `asyncio_mode = "auto"`. Changed files pass `.venv/bin/ruff check --select E,F,W --ignore F811 <files>` (from `sirdar/api`).
- Sirdar's dev database must be up (from the main checkout: `docker compose -f docker-compose.dev.yml up -d sirdar-db`, Postgres on 127.0.0.1:5434).
- Sirdar tests run from `sirdar/api` with **this task's own test DB**: `SIRDAR_TEST_DB=sirdar_test_p8cN .venv/bin/pytest -q tests/<file>`. Never the dev `sirdar` DB; foreground, long timeout (600000 ms). Implementers run focused files; the controller runs the whole suite (about 22 minutes).
- When the task is done: `PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8cN` and the same for `sirdar_test_p8cN_source`.
- Deploy-stack suite: from the worktree root, `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests`; plus `bash -n deploy/stack/ss-stack`. `ss-stack` must run on macOS's bash 3.2 (the tests use it): expand a possibly-empty array as `${arr[@]+"${arr[@]}"}`.

**Web**

- `npm --prefix sirdar/web test -- <path>`; `npm --prefix sirdar/web run build`. Never `npm install`.
- Component tests start with `// @vitest-environment jsdom`, mock `../../lib/sirdarApi` (spreading the real module) and `@portal/auth/AuthContext` as the existing tests do, and set `Element.prototype.scrollIntoView = () => {}` when a ComboBox is used.
- No new `@portal` import beyond the allowlist (`auth/AuthContext`, `components/DataTable`, `components/ComboBox`, `components/Switch`, `lib/api`).
- The copy scanner (`src/lib/sirdarApi.test.ts`) stays green: Task 3 adds copy for every code below and `deploy/apps.py` (`AppsError`) to the scanner.

**Migration number**

- **0013** (`revision = "0013"`, `down_revision = "0012"`, 8b's). Task 2 Step 1 checks every worktree and the dev DB first; stop and ask if 8b's 0012 isn't merged or 0013 is taken.

## New error codes (copy added by Task 3)

| Code | Status | Raised by | Copy | Step |
|---|---|---|---|---|
| `apps_invalid` | 422 | `apps.check_apps` | Choose the apps from Wiki, Kiosk, Status page and Mailpit. | Extras |
| `mailpit_required` | 422 | `apps.check_mail` | Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP. | Extras |
| `mail_invalid` | 422 | `apps.check_mail` | Choose Mailpit or SMTP for mail. | Extras |
| `smtp_host_invalid` | 422 | `apps.check_mail` | Enter the SMTP server's host name or address. | Extras |
| `smtp_port_invalid` | 422 | `apps.check_mail` | Use an SMTP port from 1 to 65535. | Extras |
| `smtp_username_invalid` | 422 | `apps.check_mail` | That SMTP user name can't be used: no spaces, quotes, $, # or backslashes. | Extras |
| `smtp_password_invalid` | 422 | `apps.check_mail` | That SMTP password can't be saved. Use letters, numbers and ._~+/=:@%^*!?,;- only, with no spaces or quotes. | Extras |
| `smtp_from_invalid` | 422 | `apps.check_mail` | Enter the address mail is sent from, like noreply@example.com. | Extras |
| `secrets_not_allowed` | 422 | route (adopt) | An adopted environment keeps its own secrets; change them on its Settings tab. | — |

## File ownership / parallelism

| Task | Files (create or modify) | Runs |
|---|---|---|
| 1 Stack: apps and SMTP | `deploy/stack/ss-stack`, `deploy/stack/api/compose.yml`; tests `deploy/tests/test_ss_stack.py`, `deploy/tests/test_stack_config.py` | first, parallel with 2–4 |
| 2 Sirdar: apps, mail, secrets at create | `sirdar/api/migrations/versions/0013_apps_and_mail.py` (new), `db/models.py`, `deploy/apps.py` (new), `deploy/envfile.py`, `deploy/stack/env.example`, `deploy/environments.py`, `deploy/pipeline.py`, `deploy/do_provision.py` (one line), `deploy/serialize.py`, `api/routes/deploy.py`; tests `test_deploy_apps.py` (new), `test_deploy_apps_api.py` (new), `test_deploy_envfile.py`, `test_deploy_environments_api.py` | parallel with 1, 3, 4 |
| 3 Web foundation | `web/src/lib/sirdarApi.ts` (+ test), `pages/deploy/flowState.ts` (+ `flowState.test.ts`, new), `pages/deploy/flowFixtures.ts` (new), `styles/sirdar.css`, `pages/environments/testData.ts` (new fields only) | parallel with 1, 2, 4 |
| 4 TargetPanel | `pages/deploy/TargetPanel.tsx` (+ `TargetPanel.test.tsx`, new — the Deploy-page target/connect/trusted-host tests move here) | parallel with 1–3 |
| 5 Steps 1–3 | `pages/deploy/steps/EnvironmentStep.tsx`, `ServersStep.tsx`, `TargetStep.tsx` (+ tests) | after 3 and 4 |
| 6 Steps 4–6 | `pages/deploy/steps/ExtrasStep.tsx`, `TrafficStep.tsx`, `DataStep.tsx` (+ tests) | after 3, parallel with 5 |
| 7 Review, the flow, the page | `pages/deploy/steps/ReviewStep.tsx`, `pages/deploy/DeployFlow.tsx` (+ tests), `pages/Deploy.tsx`, `pages/Deploy.test.tsx` | after 5 and 6 |
| 8 Adopt dialog; the old dialog goes | `pages/environments/AdoptEnvironmentModal.tsx` (+ test, new), `EnvironmentsSection.tsx` (+ test), delete `NewEnvironmentModal.tsx` and `NewEnvironmentModal.test.tsx` | after 3, parallel with 5–7 |
| 9 Docs, suites, live verify | `sirdar/README.md`, `deploy/stack/README.md` | last (controller) |

Dependency graph: `1 ‖ 2 ‖ 3 ‖ 4`; `{3, 4} → 5`; `3 → 6`; `{5, 6} → 7`; `3 → 8`; everything → 9. The web tasks use fixtures (`flowFixtures.ts`, `testData.ts`), so they never wait on the backend tasks; only Task 9 needs both.

## Where the old dialog's tests go

`NewEnvironmentModal.test.tsx` (49 tests) is deleted in Task 8 only after every behavior below has a new home (the implementer of each task ports the listed tests, rewriting the selectors to the new components):

| Old test (by its `it(` title) | New home |
|---|---|
| has the report-generate header and the Create steps | `DeployFlow.test.tsx` "has the report-generate header and the seven steps" (Task 7) |
| creates an environment through Basics, Services and Review | `DeployFlow.test.tsx` "creates and deploys an SSH environment end to end"; `flowState.test.ts` "the SSH body" (Tasks 3, 7) |
| Services offers Publish (on by default); Off is shown in Review and sent | `ExtrasStep.test.tsx` "Publish DNS: on with both integrations, off is sent"; `ReviewStep.test.tsx` (Tasks 6, 7) |
| without both integrations set up, Publish starts Off and says where to set them up | `ExtrasStep.test.tsx` (Task 6) |
| a choice made before the integrations load is kept | obsolete: the flow starts only after everything loaded (`DeployFlow.test.tsx` "shows Loading until the defaults, targets and integrations answer") |
| with Publish on, Review lists the names it publishes | `TrafficStep.test.tsx` "lists each public name and where it points first" (Task 6) |
| checks the basics and the ports before moving on | `flowState.test.ts` "environment and target checks" (ports stay at the defaults: the flow has no ports editor — Settings changes them later) |
| an API error goes back to the step that owns the field | `flowState.test.ts` "every code maps to a step"; `DeployFlow.test.tsx` "an API error goes back to its step" |
| adopts an existing environment …; adopt: an unknown host key …; adopt: a mismatched host key …; Escape and Cancel close it; adopt: trusting replays the exact failed attempt …; canceling the host-key prompt returns focus to the Name; a failed adopt returns focus to the Name; Adopt offers SSH targets only; ESXi: Adopt does not offer it …; DigitalOcean: Adopt neither offers nor keeps it; Adopt has no Data step and never sends a snapshot_id … | `AdoptEnvironmentModal.test.tsx`, one test each (Task 8) |
| create: an unknown host key is trusted with "Trust and create" and retries the same payload | `DeployFlow.test.tsx` "an unknown host key on the first deployment is trusted, then the deploy is retried" (the create itself never connects; the first deployment does) |
| a create error that sends you back to Basics focuses the Name; vm_name_invalid goes back to the Name | `DeployFlow.test.tsx` "an Environment-step error focuses the name"; `flowState.test.ts` (`vm_name_invalid` → name) |
| Data: a new environment can start from a ready snapshot; Data: with no snapshot only Start empty is offered, and a gone snapshot sends you back to Data; Data: picking a snapshot, going Back and choosing Start empty creates an empty environment | `DataStep.test.tsx` and `flowState.test.ts` "a snapshot body has no first admin; an empty one has it" |
| Proxmox: a Machine step sizes the VM …; Proxmox: DHCP needs no address; sizes are checked against the limits; Proxmox: an address in use sends you back to Machine; Proxmox: the network is checked like the API does; Proxmox: a DHCP create sends no address or gateway, and Review says DHCP; Proxmox: the limit messages come from the defaults, and a fractional GB default is kept | `TargetStep.test.tsx` (VM details) and `flowState.test.ts` (`vmNetworkProblem`, limits, the VM body) |
| an SSH create sends no vm key and has no Machine step | `flowState.test.ts` "the SSH body" |
| switching to Adopt with Proxmox chosen falls back to the first SSH target | obsolete: Adopt is its own dialog and lists SSH targets only |
| ESXi: the target says Sirdar builds a VM there …; ESXi: creating sends target esxi with the vm body; ESXi: an unconfigured ESXi integration is reported … | `TargetStep.test.tsx`, `flowState.test.ts`, `DeployFlow.test.tsx` (`integration_not_configured` → Target) |
| DigitalOcean: … (13 tests: the DigitalOcean step, production's account and slots, an account that isn't set up, a base domain outside the zone, the Development-account warnings, one droplet, account errors, size checks, no accounts, Back) | `TargetStep.test.tsx` (account, sizes, warnings, no accounts), `ExtrasStep.test.tsx` (standby, test certificate, auto-activate), `flowState.test.ts` (production's body: the Production account, no `slots`, no staging or auto-activate; one droplet `slots: 1`; `base_domain_not_in_zone` → Environment) |
| DigitalOcean: leaving it sets a Production type back to Dev | replaced: `flowState.test.ts` "production offers only DigitalOcean and Blue/Green" |

---

### Task 1: The stack runs only the apps that are on, and reads SMTP from the `.env`

**Files:**
- Modify: `deploy/stack/ss-stack`
- Modify: `deploy/stack/api/compose.yml`
- Modify: `deploy/tests/test_ss_stack.py`, `deploy/tests/test_stack_config.py`

**Interfaces:**
- Produces:
  - `STACK_APPS` in the `.env`: the optional apps that run, comma-separated (`wiki`, `kiosk`, `status`, `mailpit`), `none` for none; absent or empty = all of them.
  - `ss-stack up`: `dc api up … --scale wiki-worker=0 --scale wiki-export-worker=0` without the wiki; `dc web up … --scale kiosk=0` / `--scale wiki=0`; `dc status down` instead of `up` without the status page; local data: `dc storage up … --scale mailpit=0` without Mailpit; external data: `dc storage rm -sf mailpit` instead of `up … mailpit`.
  - `api/compose.yml`: `SS_SMTP_HOST: ${SS_SMTP_HOST:-mailpit}`, `SS_SMTP_PORT: ${SS_SMTP_PORT:-1025}`, `SS_SMTP_USERNAME: ${SS_SMTP_USERNAME:-}`, `SS_SMTP_PASSWORD: ${SS_SMTP_PASSWORD:-}`, `SS_SMTP_STARTTLS: ${SS_SMTP_STARTTLS:-false}`, `SS_SMTP_FROM: ${SS_SMTP_FROM:-noreply@${STACK_DOMAIN}}`.

- [ ] **Step 1: Write the failing tests**

Append to `deploy/tests/test_ss_stack.py`:

```python
WAIT = "up -d --wait --wait-timeout 300 --remove-orphans"


def _apps(env_dir: Path, line: str) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(line)


def test_apps_that_are_off_dont_run(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, "STACK_APPS=kiosk\n")
    out = run(fake, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    c = calls(fake)
    assert dc(env_dir, "storage", f"{WAIT} --scale mailpit=0") in c
    assert dc(env_dir, "api", f"{WAIT} --scale wiki-worker=0 --scale wiki-export-worker=0") in c
    assert dc(env_dir, "web", f"{WAIT} --scale wiki=0") in c
    assert dc(env_dir, "status", "down") in c
    assert dc(env_dir, "status", WAIT) not in c


def test_none_runs_only_the_api_and_the_portal(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, "STACK_APPS=none\n")
    assert run(fake, "up", str(env_dir)).returncode == 0
    c = calls(fake)
    assert dc(env_dir, "web", f"{WAIT} --scale kiosk=0 --scale wiki=0") in c
    assert dc(env_dir, "status", "down") in c


def test_every_app_runs_when_the_key_is_absent_or_lists_them_all(env_dir: Path,
                                                                 fake: dict[str, str]) -> None:
    _apps(env_dir, "STACK_APPS=wiki,kiosk,status,mailpit\n")
    assert run(fake, "up", str(env_dir)).returncode == 0
    c = calls(fake)
    for stack in ("storage", "api", "web", "status"):
        assert dc(env_dir, stack, WAIT) in c, stack


def test_external_data_without_mailpit_removes_it(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, "STACK_EXTERNAL_DATA=1\nSTACK_APPS=wiki,kiosk,status\n")
    assert run(fake, "up", str(env_dir)).returncode == 0
    c = calls(fake)
    assert dc(env_dir, "storage", "rm -sf mailpit") in c
    assert dc(env_dir, "storage", f"{WAIT} mailpit") not in c
```

Append to `deploy/tests/test_stack_config.py`:

```python
def test_smtp_comes_from_the_env_file_with_mailpit_by_default(tmp_path) -> None:
    env = rendered("api")["services"]["api"]["environment"]
    assert (env["SS_SMTP_HOST"], env["SS_SMTP_PORT"], env["SS_SMTP_STARTTLS"]) == (
        "mailpit", "1025", "false")
    assert (env["SS_SMTP_USERNAME"], env["SS_SMTP_PASSWORD"]) == ("", "")
    assert env["SS_SMTP_FROM"] == f"noreply@{DOMAIN}"
    env_file = tmp_path / ".env"
    env_file.write_text(ENV_EXAMPLE.read_text() + (
        "SS_SMTP_HOST=smtp.example.com\nSS_SMTP_PORT=587\nSS_SMTP_USERNAME=mailer\n"
        "SS_SMTP_PASSWORD=Mail-Secret-1\nSS_SMTP_STARTTLS=true\nSS_SMTP_FROM=ops@example.com\n"))
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(STACK_DIR / "api/compose.yml"),
         "config", "--format", "json"], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    smtp = json.loads(out.stdout)["services"]["api"]["environment"]
    assert (smtp["SS_SMTP_HOST"], smtp["SS_SMTP_PORT"], smtp["SS_SMTP_USERNAME"],
            smtp["SS_SMTP_PASSWORD"], smtp["SS_SMTP_STARTTLS"], smtp["SS_SMTP_FROM"]) == (
        "smtp.example.com", "587", "mailer", "Mail-Secret-1", "true", "ops@example.com")
```

and in `test_api_environment_points_at_the_stack`, keep `assert env["SS_SMTP_HOST"] == "mailpit"` (the default).

- [ ] **Step 2: Run them to verify they fail**

Run (worktree root): `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -c deploy/pytest.ini deploy/tests/test_ss_stack.py deploy/tests/test_stack_config.py`
Expected: FAIL (every stack starts; `SS_SMTP_USERNAME` missing from the rendered environment).

- [ ] **Step 3: `ss-stack`**

In `deploy/stack/ss-stack`, add to the header after the DigitalOcean paragraph: "`# STACK_APPS lists the optional apps that run (wiki, kiosk, status, mailpit;` `# "none" for none); without it every app runs. API and portal always run.`" Then, after `caddy()`:

```bash
# An optional app runs unless STACK_APPS is set and doesn't name it.
app_on() {
  local apps
  apps=$(env_value STACK_APPS)
  [[ -z $apps ]] && return 0
  [[ ",$apps," == *",$1,"* ]]
}
```

`data_up()` becomes:

```bash
data_up() {
  if external; then
    if app_on mailpit; then
      dc storage up -d "${WAIT[@]}" mailpit
    else
      dc storage rm -sf mailpit
    fi
  else
    dc db up -d "${WAIT[@]}"
    if app_on mailpit; then
      dc storage up -d "${WAIT[@]}"
    else
      dc storage up -d "${WAIT[@]}" --scale mailpit=0
    fi
  fi
}
```

In `up)`, replace the three app lines with:

```bash
    dc api run --rm migrate
    api_off=()
    app_on wiki || api_off=(--scale wiki-worker=0 --scale wiki-export-worker=0)
    dc api up -d "${WAIT[@]}" ${api_off[@]+"${api_off[@]}"}
    web_off=()
    app_on kiosk || web_off+=(--scale kiosk=0)
    app_on wiki || web_off+=(--scale wiki=0)
    dc web up -d "${WAIT[@]}" ${web_off[@]+"${web_off[@]}"}
    if app_on status; then dc status up -d "${WAIT[@]}"; else dc status down; fi
```

(the `caddy` line stays last; the `ps`/`down` commands keep listing every stack).

- [ ] **Step 4: `api/compose.yml`**

Replace the four `SS_SMTP_*` lines in `x-ss-env` with:

```yaml
  # Mail: the environment's own Mailpit unless the .env names an SMTP server
  # (Sirdar writes SS_SMTP_* when one is set up; the password is a secret).
  SS_SMTP_HOST: ${SS_SMTP_HOST:-mailpit}
  SS_SMTP_PORT: ${SS_SMTP_PORT:-1025}
  SS_SMTP_USERNAME: ${SS_SMTP_USERNAME:-}
  SS_SMTP_PASSWORD: ${SS_SMTP_PASSWORD:-}
  SS_SMTP_STARTTLS: ${SS_SMTP_STARTTLS:-false}
  SS_SMTP_FROM: ${SS_SMTP_FROM:-noreply@${STACK_DOMAIN}}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bash -n deploy/stack/ss-stack && /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -c deploy/pytest.ini deploy/tests`
Expected: PASS (and the existing `test_up_starts_stacks_in_dependency_order` unchanged).

- [ ] **Step 6: Commit**

```bash
git add deploy/stack/ss-stack deploy/stack/api/compose.yml deploy/tests/test_ss_stack.py deploy/tests/test_stack_config.py
git commit -m "feat(stack): STACK_APPS turns optional apps off; SMTP comes from the .env

Wiki, kiosk, the status page and Mailpit scale to zero when STACK_APPS
leaves them out (unset: all run); SS_SMTP_* default to Mailpit.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Apps, mail and optional secrets at create (Sirdar, migration 0013)

**Files:**
- Create: `sirdar/api/migrations/versions/0013_apps_and_mail.py`
- Modify: `sirdar/api/src/sirdar_api/db/models.py` (`Environment.apps`, `smtp_*`)
- Create: `sirdar/api/src/sirdar_api/deploy/apps.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/envfile.py` (`SECRET_VALUE_RE`; `OPTIONAL_SECRETS` gains `SS_SMTP_PASSWORD`; `EXTRA_KEYS` gains `STACK_APPS` and the five `SS_SMTP_*`), `deploy/stack/env.example`
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`create_new(..., apps=None, mail=None, secrets=None)`; `_SECRET_VALUE_RE = envfile.SECRET_VALUE_RE`; `check_optional_secrets`)
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py` (apps/mail keys on every render; DigitalOcean public hosts), `deploy/do_provision.py` (public hosts), `deploy/serialize.py` (`apps`, `mail`)
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (`EnvironmentIn.apps/mail/secrets`, `MailIn`, defaults, audit)
- Create: `sirdar/api/tests/test_deploy_apps.py`, `sirdar/api/tests/test_deploy_apps_api.py`
- Modify: `sirdar/api/tests/test_deploy_envfile.py`, `test_deploy_environments_api.py` (ENV_KEYS, defaults)

**Interfaces:**
- Produces:
  - Columns: `environments.apps text[] NOT NULL DEFAULT '{wiki,kiosk,status,mailpit}'` (subset check), `smtp_host`, `smtp_port`, `smtp_username`, `smtp_from` (all NULL = Mailpit), `smtp_starttls boolean NOT NULL DEFAULT true`; `environments_mail_check`: Mailpit is on, or SMTP is set.
  - `apps.OPTIONAL_APPS = ("wiki", "kiosk", "status", "mailpit")`, `apps.ALWAYS = ("api", "portal")`, `apps.DEFAULT_SMTP_PORT = 587` (ServerSherpa's `smtp_port` default).
  - `apps.AppsError(code)`; `apps.check_apps(value) -> list[str]` (None → all); `apps.check_mail(value, apps_on) -> dict` (`smtp_host`, `smtp_port`, `smtp_username`, `smtp_from`, `smtp_starttls`, `smtp_password`); `apps.public_services(apps_on, base=envfile.PUBLIC_SERVICES) -> tuple[str, ...]`; `apps.is_public(env, service) -> bool`; `apps.env_extra(env) -> dict[str, str]`; `apps.public(env, password_set: bool) -> dict`.
  - `environments.check_optional_secrets(secrets: dict) -> dict` (the PATCH rules, shared).
  - `POST /environments` body gains `apps?: string[]`, `mail?: {mode: "mailpit"|"smtp", host?, port?, username?, password?, from_address?, starttls?}`, `secrets?: {SS_ANTHROPIC_API_KEY?: string, SS_DB_TESTING_PASSWORD?: string}` (mode `new`; `secrets` on adopt → 422 `secrets_not_allowed`). Audit adds `apps`, `mail: {mode, host}` and `secrets: [names]`.
  - Environment JSON gains `"apps": [...]` and `"mail": {"mode", "host", "port", "username", "from_address", "starttls", "password_set"}`.
  - `GET /environment-defaults` gains `"apps": {"optional": [...], "always": ["api", "portal"]}` and `"mail": {"smtp_port": 587}`.

- [ ] **Step 1: Check the migration number** (as 8b Task 1 Step 1, for `0013`; expect 8b's 0012 present and nothing at 0013).

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_apps.py`:

```python
"""deploy/apps.py: which optional apps run, where mail goes, and the .env
keys both render to."""

import pytest
from types import SimpleNamespace

from sirdar_api.deploy import apps, envfile


def test_check_apps():
    assert apps.check_apps(None) == ["wiki", "kiosk", "status", "mailpit"]
    assert apps.check_apps(["mailpit", "wiki"]) == ["wiki", "mailpit"]      # canonical order
    assert apps.check_apps([]) == []
    for bad in (["api"], "wiki", [1], ["wiki", "nope"]):
        with pytest.raises(apps.AppsError) as e:
            apps.check_apps(bad)
        assert e.value.code == "apps_invalid"


def test_mailpit_mail_needs_mailpit():
    assert apps.check_mail(None, ["mailpit"])["smtp_host"] is None
    with pytest.raises(apps.AppsError) as e:
        apps.check_mail({"mode": "mailpit"}, ["wiki"])
    assert e.value.code == "mailpit_required"


SMTP = {"mode": "smtp", "host": "smtp.example.com", "port": 587, "username": "mailer",
        "password": "Mail-Secret-1", "from_address": "ops@example.com", "starttls": True}


def test_smtp_mail():
    assert apps.check_mail(SMTP, []) == {
        "smtp_host": "smtp.example.com", "smtp_port": 587, "smtp_username": "mailer",
        "smtp_from": "ops@example.com", "smtp_starttls": True, "smtp_password": "Mail-Secret-1"}
    plain = apps.check_mail({**SMTP, "username": None, "password": None, "port": None}, [])
    assert (plain["smtp_port"], plain["smtp_username"], plain["smtp_password"]) == (
        apps.DEFAULT_SMTP_PORT, None, None)


@pytest.mark.parametrize("change, code", [
    ({"mode": "fax"}, "mail_invalid"),
    ({"host": ""}, "smtp_host_invalid"),
    ({"host": "smtp example.com"}, "smtp_host_invalid"),
    ({"port": 0}, "smtp_port_invalid"),
    ({"port": True}, "smtp_port_invalid"),
    ({"username": "has space"}, "smtp_username_invalid"),
    ({"password": "has space"}, "smtp_password_invalid"),
    ({"password": "dollar$sign"}, "smtp_password_invalid"),
    ({"from_address": "nope"}, "smtp_from_invalid"),
    ({"starttls": "yes"}, "mail_invalid"),
])
def test_smtp_refusals(change, code):
    with pytest.raises(apps.AppsError) as e:
        apps.check_mail({**SMTP, **change}, [])
    assert e.value.code == code
    assert "Mail-Secret-1" not in str(e.value)


def test_public_services_follow_the_apps():
    assert apps.public_services(["wiki", "kiosk", "status", "mailpit"]) == envfile.PUBLIC_SERVICES
    assert apps.public_services([]) == ("api", "portal", "spaces")
    assert apps.public_services(["status"], base=("api", "portal", "kiosk", "wiki", "status")) == (
        "api", "portal", "status")


def test_env_extra():
    env = SimpleNamespace(apps=["kiosk"], smtp_host=None, smtp_port=None, smtp_username=None,
                          smtp_from=None, smtp_starttls=True)
    assert apps.env_extra(env) == {"STACK_APPS": "kiosk"}
    env = SimpleNamespace(apps=[], smtp_host="smtp.example.com", smtp_port=587,
                          smtp_username=None, smtp_from="ops@example.com", smtp_starttls=False)
    assert apps.env_extra(env) == {
        "STACK_APPS": "none", "SS_SMTP_HOST": "smtp.example.com", "SS_SMTP_PORT": "587",
        "SS_SMTP_USERNAME": "", "SS_SMTP_STARTTLS": "false", "SS_SMTP_FROM": "ops@example.com"}
    assert set(apps.env_extra(env)) <= set(envfile.EXTRA_KEYS)
```

Create `sirdar/api/tests/test_deploy_apps_api.py`:

```python
"""Apps, mail and optional secrets on create: stored, shown without
secrets, rendered into the .env, and only the running apps are public."""

import base64
import uuid

import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog, EnvironmentService
from sirdar_api.deploy import envfile, pipeline

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
SMTP_PASSWORD = "Mail-Secret-1"
AI_KEY = "sk-ant-test-0123456789"
NEW = {"mode": "new", "name": "qa1", "type": "custom", "target": "ssh",
       "proxy_ip": "10.10.48.6", "publish": False}


@pytest.fixture
def target(deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    return ssh_server


async def test_apps_and_smtp_are_stored_and_shown_without_secrets(client, db, target,
                                                                  leak_guard):
    leak_guard += [SMTP_PASSWORD, AI_KEY]
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={
        **NEW, "apps": ["kiosk"], "secrets": {"SS_ANTHROPIC_API_KEY": AI_KEY},
        "mail": {"mode": "smtp", "host": "smtp.example.com", "port": 587, "username": "mailer",
                 "password": SMTP_PASSWORD, "from_address": "ops@example.com", "starttls": True}})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["apps"] == ["kiosk"]
    assert body["mail"] == {"mode": "smtp", "host": "smtp.example.com", "port": 587,
                            "username": "mailer", "from_address": "ops@example.com",
                            "starttls": True, "password_set": True}
    assert body["secrets_set"]["SS_ANTHROPIC_API_KEY"] is True
    hostnames = dict((await db.execute(select(EnvironmentService.service,
                                              EnvironmentService.hostname))).all())
    assert hostnames["kiosk"] == "kiosk.qa1.serversherpa.com"
    assert hostnames["wiki"] is None and hostnames["status"] is None     # off: not public
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_create"))).one()
    assert audit["apps"] == ["kiosk"] and audit["mail"] == {"mode": "smtp",
                                                            "host": "smtp.example.com"}
    assert audit["secrets"] == ["SS_ANTHROPIC_API_KEY"]


async def test_the_env_file_carries_the_apps_and_smtp(client, db, target, fake_runner):
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json={
        **NEW, "apps": ["wiki", "status"],
        "mail": {"mode": "smtp", "host": "smtp.example.com", "port": 2525,
                 "from_address": "ops@example.com", "password": SMTP_PASSWORD}})
    resp = await client.post(f"{URL}/qa1/deployments", headers=h, json={"mode": "update"})
    await pipeline.wait(uuid.UUID(resp.json()["id"]))
    render = next(r for r in fake_runner.requests if r.step == "render")
    values = envfile.parse_env(base64.b64decode(render.extravars["env_file_b64"]).decode())
    assert values["STACK_APPS"] == "wiki,status"
    assert (values["SS_SMTP_HOST"], values["SS_SMTP_PORT"], values["SS_SMTP_FROM"]) == (
        "smtp.example.com", "2525", "ops@example.com")
    assert values["SS_SMTP_PASSWORD"] == SMTP_PASSWORD


@pytest.mark.parametrize("body, code", [
    ({"apps": ["api"]}, "apps_invalid"),
    ({"apps": ["wiki"]}, "mailpit_required"),
    ({"mail": {"mode": "smtp", "host": "", "from_address": "a@b.co"}}, "smtp_host_invalid"),
    ({"secrets": {"SS_PASSWORD_PEPPER": "x"}}, "secret_not_editable"),
])
async def test_create_refusals(client, db, target, body, code):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, **body})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, code)


async def test_adopt_takes_no_secrets(client, db, target):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={"mode": "adopt", "name": "x", "type": "custom",
                                                   "target": "ssh", "secrets": {"SS_ANTHROPIC_API_KEY": AI_KEY}})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "secrets_not_allowed")


async def test_defaults_list_the_apps_and_the_smtp_port(client, db):
    h = await auth_headers(client, db)
    body = (await client.get("/api/deploy/environment-defaults", headers=h)).json()
    assert body["apps"] == {"optional": ["wiki", "kiosk", "status", "mailpit"],
                            "always": ["api", "portal"]}
    assert body["mail"] == {"smtp_port": 587}
```

(The redaction of `SS_SMTP_PASSWORD` in step logs needs no new code: optional secrets are part of the environment's `secrets`, which the run's redactor already hides.)

In `test_deploy_envfile.py`, append:

```python
def test_apps_and_mail_keys():
    assert "SS_SMTP_PASSWORD" in envfile.OPTIONAL_SECRETS
    assert envfile.EXTRA_KEYS[:6] == ("STACK_APPS", "SS_SMTP_HOST", "SS_SMTP_PORT",
                                      "SS_SMTP_USERNAME", "SS_SMTP_STARTTLS", "SS_SMTP_FROM")
```

In `test_deploy_environments_api.py`: `ENV_KEYS` gains `"apps"` and `"mail"`; the defaults test's expected dict gains `"apps"` and `"mail"` (as above) and `"optional_secrets"` becomes `["SS_ANTHROPIC_API_KEY", "SS_DB_TESTING_PASSWORD", "SS_SMTP_PASSWORD"]`; any `secrets_set` dict in that file gains `"SS_SMTP_PASSWORD": False`.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8c2 .venv/bin/pytest -q tests/test_deploy_apps.py tests/test_deploy_apps_api.py tests/test_deploy_envfile.py`
Expected: FAIL (`No module named 'sirdar_api.deploy.apps'`).

- [ ] **Step 4: Migration 0013 and the model**

Create `sirdar/api/migrations/versions/0013_apps_and_mail.py`:

```python
"""The Deploy page flow (deploy phase 8c): which optional apps an
environment runs, and its SMTP server (none: the environment's Mailpit).
The SMTP password is an optional secret (environment_secrets).

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-07
"""
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE environments
          ADD COLUMN apps text[] NOT NULL DEFAULT '{wiki,kiosk,status,mailpit}',
          ADD COLUMN smtp_host text,
          ADD COLUMN smtp_port integer CHECK (smtp_port BETWEEN 1 AND 65535),
          ADD COLUMN smtp_username text,
          ADD COLUMN smtp_from text,
          ADD COLUMN smtp_starttls boolean NOT NULL DEFAULT true,
          ADD CONSTRAINT environments_apps_check
            CHECK (apps <@ ARRAY['wiki', 'kiosk', 'status', 'mailpit']::text[]),
          ADD CONSTRAINT environments_smtp_check
            CHECK ((smtp_host IS NULL) = (smtp_port IS NULL)
                   AND (smtp_host IS NULL) = (smtp_from IS NULL)),
          ADD CONSTRAINT environments_mail_check
            CHECK ('mailpit' = ANY (apps) OR smtp_host IS NOT NULL);
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE environments
          DROP CONSTRAINT environments_mail_check, DROP CONSTRAINT environments_smtp_check,
          DROP CONSTRAINT environments_apps_check,
          DROP COLUMN smtp_starttls, DROP COLUMN smtp_from, DROP COLUMN smtp_username,
          DROP COLUMN smtp_port, DROP COLUMN smtp_host, DROP COLUMN apps;
        DELETE FROM environment_secrets WHERE key = 'SS_SMTP_PASSWORD';
    """)
```

In `models.py` (docstring "0001–0013"), `Environment` gains after `retiring`:

```python
    # The Deploy page flow (migration 0013): the optional apps it runs, and
    # its SMTP server (smtp_host NULL: its own Mailpit).
    apps: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{wiki,kiosk,status,mailpit}'"))
    smtp_host: Mapped[str | None]
    smtp_port: Mapped[int | None] = mapped_column(Integer)
    smtp_username: Mapped[str | None]
    smtp_from: Mapped[str | None]
    smtp_starttls: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
```

- [ ] **Step 5: `envfile` and `env.example`**

In `envfile.py`:

```python
OPTIONAL_SECRETS = ("SS_ANTHROPIC_API_KEY", "SS_DB_TESTING_PASSWORD", "SS_SMTP_PASSWORD")
# Optional secrets set by hand (API keys, passwords): no whitespace, quotes,
# "$" (compose interpolation), "#", backslash or backtick.
SECRET_VALUE_RE = re.compile(r"[A-Za-z0-9._~+/=:@%^*!?,;-]{1,1024}")
```

and prepend to `EXTRA_KEYS`:

```python
EXTRA_KEYS = (
    # the Deploy page flow (phase 8c): the optional apps that run, and SMTP
    # (the password is the optional secret SS_SMTP_PASSWORD)
    "STACK_APPS", "SS_SMTP_HOST", "SS_SMTP_PORT", "SS_SMTP_USERNAME", "SS_SMTP_STARTTLS",
    "SS_SMTP_FROM",
    "STACK_EXTERNAL_DATA", …                      # unchanged from here
)
```

(update the comment above `EXTRA_KEYS`: "Extra keys a .env carries beyond the basics: the apps and mail of any environment, then a DigitalOcean droplet's or a LAN Blue/Green app VM's…").

`deploy/stack/env.example`: after `SS_DB_TESTING_PASSWORD=` add `SS_SMTP_PASSWORD=`, and before the DigitalOcean block:

```
# ── Apps and mail (Sirdar writes these; leave them out to run every app and use Mailpit) ──
# STACK_APPS=wiki,kiosk,status,mailpit   the optional apps that run ("none" for none)
# SS_SMTP_HOST= SS_SMTP_PORT=587 SS_SMTP_USERNAME= SS_SMTP_STARTTLS=true SS_SMTP_FROM=
```

In `environments.py`: `_SECRET_VALUE_RE = envfile.SECRET_VALUE_RE` (replacing its own regex), and extract the PATCH secret checks into:

```python
def check_optional_secrets(secrets) -> dict[str, str]:
    """Optional secrets as create or PATCH sends them: only OPTIONAL_SECRETS,
    each a string the .env can carry ("" or None: leave it unset)."""
    if not isinstance(secrets, dict):
        raise EnvError("secret_invalid", key="secrets")
    for key, value in secrets.items():
        if key not in envfile.OPTIONAL_SECRETS:
            raise EnvError("secret_not_editable", key=key)
        if value is not None and (not isinstance(value, str)
                                  or (value and not _SECRET_VALUE_RE.fullmatch(value))):
            raise EnvError("secret_invalid", key=key)
    return {k: v for k, v in secrets.items() if v}
```

used by `update()` (`check_optional_secrets(fields.get("secrets") or {})` replaces its loop; keep its clear-on-"" behavior).

- [ ] **Step 6: `deploy/apps.py`**

Create `sirdar/api/src/sirdar_api/deploy/apps.py`:

```python
"""Which apps an environment runs and where its mail goes (deploy phase 8c).
API and portal always run; wiki, kiosk, status and mailpit can be turned off
when the environment is created. Mail goes to the environment's own Mailpit
(nothing leaves the host) or to an SMTP server: ServerSherpa reads SMTP only
from its environment (SS_SMTP_* in api/src/serversherpa/config.py), so Sirdar
writes it into the .env. The SMTP password is the optional secret
SS_SMTP_PASSWORD, vault-encrypted like the others and never returned."""

import re

from sirdar_api.deploy import envfile

OPTIONAL_APPS = ("wiki", "kiosk", "status", "mailpit")
ALWAYS = ("api", "portal")
_PUBLIC_APPS = ("wiki", "kiosk", "status")          # their public names go when they're off
DEFAULT_SMTP_PORT = 587                             # ServerSherpa's smtp_port default
_HOST_RE = re.compile(r"(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?")
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}")
_USER_RE = re.compile(r"[^\s\"'$#`\\]{1,254}")


class AppsError(Exception):
    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


def check_apps(value) -> list[str]:
    if value is None:
        return list(OPTIONAL_APPS)
    if (not isinstance(value, list) or not all(isinstance(a, str) for a in value)
            or set(value) - set(OPTIONAL_APPS)):
        raise AppsError("apps_invalid")
    return [a for a in OPTIONAL_APPS if a in value]


def check_mail(value, apps_on: list[str]) -> dict:
    """The mail settings create stores: all None (and STARTTLS on) for Mailpit."""
    value = value or {}
    if not isinstance(value, dict):
        raise AppsError("mail_invalid")
    mode = value.get("mode", "mailpit")
    if mode == "mailpit":
        if "mailpit" not in apps_on:
            raise AppsError("mailpit_required")
        return {"smtp_host": None, "smtp_port": None, "smtp_username": None, "smtp_from": None,
                "smtp_starttls": True, "smtp_password": None}
    if mode != "smtp":
        raise AppsError("mail_invalid")
    host = value.get("host")
    if not isinstance(host, str) or not _HOST_RE.fullmatch(host.strip()):
        raise AppsError("smtp_host_invalid")
    port = value.get("port")
    port = DEFAULT_SMTP_PORT if port is None else port
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise AppsError("smtp_port_invalid")
    username = value.get("username") or None
    if username is not None and (not isinstance(username, str) or not _USER_RE.fullmatch(username)):
        raise AppsError("smtp_username_invalid")
    password = value.get("password") or None
    if password is not None and (not isinstance(password, str)
                                 or not envfile.SECRET_VALUE_RE.fullmatch(password)):
        raise AppsError("smtp_password_invalid")
    sender = value.get("from_address")
    if not isinstance(sender, str) or not _EMAIL_RE.fullmatch(sender.strip()):
        raise AppsError("smtp_from_invalid")
    starttls = value.get("starttls", True)
    if not isinstance(starttls, bool):
        raise AppsError("mail_invalid")
    return {"smtp_host": host.strip(), "smtp_port": port, "smtp_username": username,
            "smtp_from": sender.strip(), "smtp_starttls": starttls, "smtp_password": password}


def public_services(apps_on: list[str], base: tuple[str, ...] = envfile.PUBLIC_SERVICES
                    ) -> tuple[str, ...]:
    return tuple(s for s in base if s not in _PUBLIC_APPS or s in apps_on)


def is_public(env, service: str) -> bool:
    return service not in _PUBLIC_APPS or service in (env.apps or ())


def env_extra(env) -> dict[str, str]:
    out = {"STACK_APPS": ",".join(env.apps) if env.apps else "none"}
    if env.smtp_host:
        out |= {"SS_SMTP_HOST": env.smtp_host, "SS_SMTP_PORT": str(env.smtp_port),
                "SS_SMTP_USERNAME": env.smtp_username or "",
                "SS_SMTP_STARTTLS": "true" if env.smtp_starttls else "false",
                "SS_SMTP_FROM": env.smtp_from}
    return out


def public(env, *, password_set: bool) -> dict:
    if not env.smtp_host:
        return {"mode": "mailpit", "host": None, "port": None, "username": None,
                "from_address": None, "starttls": True, "password_set": False}
    return {"mode": "smtp", "host": env.smtp_host, "port": env.smtp_port,
            "username": env.smtp_username, "from_address": env.smtp_from,
            "starttls": env.smtp_starttls, "password_set": password_set}
```

- [ ] **Step 7: Create, render, public names**

`environments.create_new(..., apps: list[str] | None = None, mail: dict | None = None, secrets: dict | None = None)`: right after `_precheck`:

```python
    try:
        apps_on = app_rules.check_apps(apps)
        mail_spec = app_rules.check_mail(mail, apps_on)
    except app_rules.AppsError as e:
        raise EnvError(e.code, **e.extra) from None
    extra_secrets = check_optional_secrets(secrets or {})
    if mail_spec["smtp_password"]:
        extra_secrets["SS_SMTP_PASSWORD"] = mail_spec["smtp_password"]
```

(`from sirdar_api.deploy import apps as app_rules`, to keep the `apps` parameter name.) Pass the public names to `_insert`: the SSH/VM path `public_services=app_rules.public_services(apps_on)`; `_create_on_do` gets `apps_on` and `extra_secrets` arguments and uses `public_services=app_rules.public_services(apps_on, base=certs.PUBLIC_SERVICES)` and `secrets=vault.generate_env_secrets() | extra_secrets`. After the environment row exists (both paths, before returning): `env.apps = apps_on`; `env.smtp_host, env.smtp_port, env.smtp_username, env.smtp_from, env.smtp_starttls = (mail_spec[k] for k in ("smtp_host", "smtp_port", "smtp_username", "smtp_from", "smtp_starttls"))`; and `secrets=vault.generate_env_secrets() | extra_secrets` in both `_insert(...)` calls (the optional secrets join the generated ones, all vault-encrypted). Flush.

`pipeline._prepare`: `extra: dict[str, str] = app_rules.env_extra(env)` replaces `extra: dict[str, str] = {}` (so every render — Update, Reset, Restore backup, Roll back, on every target — carries them); the DigitalOcean and LAN Blue/Green branches do `extra |= …` instead of `extra = …`. The DigitalOcean `public_hosts` comprehension gains `if app_rules.is_public(env, s)`; in `do_provision.py` line 223 the `hosts=` comprehension gains the same filter (import `apps as app_rules` there).

`serialize.environment_out` gains `"apps": list(env.apps), "mail": app_rules.public(env, password_set="SS_SMTP_PASSWORD" in keys),`.

- [ ] **Step 8: Routes**

In `routes/deploy.py`:

```python
class MailIn(BaseModel):
    """Where the environment's mail goes: its Mailpit, or an SMTP server."""
    mode: Literal["mailpit", "smtp"] = "mailpit"
    host: str | None = Field(default=None, max_length=253)
    port: int | None = None
    username: str | None = Field(default=None, max_length=254)
    password: str | None = Field(default=None, max_length=1024, repr=False)
    from_address: str | None = Field(default=None, max_length=254)
    starttls: bool | None = None
```

`EnvironmentIn` gains `apps: list[str] | None = None`, `mail: MailIn | None = None`, `secrets: dict[str, str] | None = Field(default=None, repr=False)` (mode `new` only). In `create_environment`: `if body.mode == "adopt" and body.secrets: raise HTTPException(status_code=422, detail={"code": "secrets_not_allowed"})`; pass `apps=body.apps, mail=body.mail.model_dump(exclude_none=True) if body.mail else None, secrets=body.secrets` to `create_new`; the audit `changes` add `"apps": list(env.apps)`, `"mail": {"mode": "smtp", "host": env.smtp_host} if env.smtp_host else {"mode": "mailpit"}`, and `"secrets": sorted(k for k, v in (body.secrets or {}).items() if v)` (names only). `environment_defaults` gains `"apps": {"optional": list(app_rules.OPTIONAL_APPS), "always": list(app_rules.ALWAYS)}, "mail": {"smtp_port": app_rules.DEFAULT_SMTP_PORT}`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8c2 .venv/bin/pytest -q tests/test_deploy_apps.py tests/test_deploy_apps_api.py tests/test_deploy_envfile.py tests/test_deploy_environments_api.py tests/test_deploy_environments.py tests/test_deploy_pipeline.py tests/test_deploy_pipeline_do.py tests/test_deploy_do_environments.py tests/test_deploy_do_provision.py tests/test_scaffold.py`
Expected: PASS.

- [ ] **Step 10: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 migrations/versions/0013_apps_and_mail.py src/sirdar_api/db/models.py src/sirdar_api/deploy/apps.py src/sirdar_api/deploy/envfile.py src/sirdar_api/deploy/environments.py src/sirdar_api/deploy/pipeline.py src/sirdar_api/deploy/do_provision.py src/sirdar_api/deploy/serialize.py src/sirdar_api/api/routes/deploy.py tests/test_deploy_apps.py tests/test_deploy_apps_api.py tests/test_deploy_envfile.py
cd ../.. && git add sirdar/api/migrations/versions/0013_apps_and_mail.py sirdar/api/src/sirdar_api/db/models.py sirdar/api/src/sirdar_api/deploy/apps.py sirdar/api/src/sirdar_api/deploy/envfile.py deploy/stack/env.example sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/deploy/do_provision.py sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_apps.py sirdar/api/tests/test_deploy_apps_api.py sirdar/api/tests/test_deploy_envfile.py sirdar/api/tests/test_deploy_environments_api.py
git commit -m "feat(sirdar): apps, mail and optional secrets on create (migration 0013)

Optional apps off at create (only the running apps are public; STACK_APPS
in the .env), SMTP stored and written as SS_SMTP_* (password vault-held),
the Anthropic key at create.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8c2
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8c2_source
```

---

### Task 3: Web foundation: types, copy, `flowState`, styles

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts` (+ `sirdarApi.test.ts`)
- Create: `sirdar/web/src/pages/deploy/flowState.ts`, `pages/deploy/flowState.test.ts`, `pages/deploy/flowFixtures.ts`
- Modify: `sirdar/web/src/styles/sirdar.css`
- Modify: `sirdar/web/src/pages/environments/testData.ts` (new fields on fixtures)

**Interfaces:**
- Produces:
  - Types: `NewEnvironmentBody` gains `apps?: string[]; mail?: NewMail; secrets?: Record<string, string>`; `interface NewMail { mode: 'mailpit' | 'smtp'; host?: string; port?: number; username?: string; password?: string; from_address?: string; starttls?: boolean }`; `Environment` gains `apps: string[]; mail: EnvMail`; `EnvironmentDefaults` gains `apps: { optional: string[]; always: string[] }; mail: { smtp_port: number }`.
  - `flowState.ts` exports (exact names used by Tasks 5–7): `FlowStep`, `FLOW_STEPS`, `STEP_HINT`, `KINDS`, `KIND_LABEL`, `CONNECT_TYPE`, `Servers`, `OptionalApp`, `OPTIONAL_APPS`, `TargetKind`, `targetKind`, `FlowState`, `FlowContext`, `TargetChoice`, `initialState(ctx)`, `withRules(state, ctx)`, `targetChoices(state, ctx)`, `Field`, `Errors`, `vmNetworkProblem(cidr, gw)`, `stepErrors(step, state, ctx)`, `buildBody(state, ctx)`, `CODE_FIELD`, `FIELD_STEP`, `stepOfCode(code)`, `nextStep(step)`, `prevStep(step)`, `effectiveDomain(state, ctx)`, `TrafficRow`, `trafficPlan(state, ctx)`.
  - `flowFixtures.ts`: `FLOW_DEFAULTS` (`DEFAULTS` plus `apps`, `mail`, `first_admin`), `FLOW_TARGETS`, `FLOW_INTEGRATIONS`, `flowCtx(over?)`.
  - CSS: `.sirdar-flow`, `.sirdar-flow-head`, `.sirdar-flow-body`, `.sirdar-flow-foot`, `.sirdar-flow-grid` (two columns, one on a phone), `.sirdar-flow-details`, `.modal-card.reports-modal-card.rgm-card.sirdar-adopt-card`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/deploy/flowFixtures.ts`:

```ts
/** Fixtures for the Deploy page flow's tests. */
import type { DeployTarget, Integrations } from '../../lib/sirdarApi';
import { DEFAULTS, DO_ACCOUNTS_BOTH, INTEGRATIONS, SNAP } from '../environments/testData';

import type { FlowContext } from './flowState';

export const FLOW_DEFAULTS = {
  ...DEFAULTS,
  apps: { optional: ['wiki', 'kiosk', 'status', 'mailpit'], always: ['api', 'portal'] },
  mail: { smtp_port: 587 },
  first_admin: { password_min_length: 8, role: 'super_admin', link_minutes: 240 },
};
export const FLOW_TARGETS: DeployTarget[] = [
  { id: 'aws', label: 'AWS', kind: 'aws', available: false, configured: false },
  { id: 'gcp', label: 'Google Cloud', kind: 'gcp', available: false, configured: false },
  { id: 'digitalocean', label: 'DigitalOcean', kind: 'digitalocean', available: true, configured: true },
  { id: 'ssh:lab', label: 'Lab box', kind: 'ssh', source: 'saved', available: true, configured: true },
  { id: 'esxi', label: 'VMware ESXi', kind: 'esxi', available: true, configured: true },
  { id: 'proxmox', label: 'Proxmox', kind: 'proxmox', available: true, configured: true },
];
export const FLOW_INTEGRATIONS: Integrations = {
  ...INTEGRATIONS,
  npm: { ...INTEGRATIONS.npm, configured: true, url: 'http://10.10.48.6:81' },
};
export const flowCtx = (over: Partial<FlowContext> = {}): FlowContext => ({
  targets: FLOW_TARGETS, defaults: FLOW_DEFAULTS, integrations: FLOW_INTEGRATIONS,
  accounts: DO_ACCOUNTS_BOTH, snapshots: [SNAP], ...over,
});
```

Create `sirdar/web/src/pages/deploy/flowState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { flowCtx } from './flowFixtures';
import {
  CODE_FIELD, FIELD_STEP, FLOW_STEPS, buildBody, initialState, nextStep, prevStep, stepErrors, stepOfCode,
  targetChoices, trafficPlan, vmNetworkProblem, withRules, type FlowState,
} from './flowState';

const ctx = flowCtx();
const base = (over: Partial<FlowState> = {}) => withRules({ ...initialState(ctx), ...over }, ctx);
const ssh = (over: Partial<FlowState> = {}) => base({
  name: 'qa', type: 'custom', target: 'ssh:lab', proxyIp: '10.10.48.6', adminFirst: 'Ada', adminLast: 'Lovelace',
  adminEmail: 'ada@test.example.com', adminPassword: 'Correct-Horse-9', adminConfirm: 'Correct-Horse-9', ...over,
});

describe('the steps', () => {
  it('are the spec seven, in order', () => {
    expect(FLOW_STEPS.map(([, label]) => label)).toEqual(
      ['Environment', 'Servers', 'Target', 'Extras', 'Traffic', 'Data', 'Review & Deploy']);
    expect(nextStep('environment')).toBe('servers');
    expect(prevStep('servers')).toBe('environment');
    expect(nextStep('review')).toBe('review');
  });
});

describe('initial state', () => {
  it('starts from the defaults and the NPM address', () => {
    const s = initialState(ctx);
    expect([s.gitRef, s.bindIp, s.cores, s.memoryGb, s.diskGb, s.dropletSize, s.smtpPort]).toEqual(
      ['main', '0.0.0.0', '4', '8', '64', 's-2vcpu-4gb', '587']);
    expect(s.proxyIp).toBe('10.10.48.6');
    expect(s.apps).toEqual({ wiki: true, kiosk: true, status: true, mailpit: true });
    expect(s.publish).toBe(true);
  });
  it('starts Publish off without both integrations', () => {
    const s = initialState(flowCtx({ integrations: { ...ctx.integrations!, npm: { ...ctx.integrations!.npm, configured: false } } }));
    expect(s.publish).toBe(false);
  });
});

describe('rules', () => {
  it('production offers only DigitalOcean and Blue/Green', () => {
    const s = base({ type: 'production', servers: 'single', target: 'ssh:lab', autoActivate: true, acmeStaging: true });
    expect([s.servers, s.target, s.autoActivate, s.acmeStaging, s.doAccount]).toEqual(
      ['bluegreen', '', false, false, 'production']);
    expect(targetChoices(s, ctx).map((t) => t.id)).toEqual(['digitalocean']);
  });
  it('Blue/Green never offers SSH', () => {
    expect(targetChoices(base({ servers: 'bluegreen' }), ctx).map((t) => t.id)).toEqual(
      ['esxi', 'proxmox', 'digitalocean']);
    expect(base({ servers: 'bluegreen', target: 'ssh:lab' }).target).toBe('');
  });
  it('a Blue/Green VM needs NPM to be ready', () => {
    const noNpm = flowCtx({ integrations: { ...ctx.integrations!, npm: { ...ctx.integrations!.npm, configured: false } } });
    const esxi = targetChoices(base({ servers: 'bluegreen' }), noNpm).find((t) => t.id === 'esxi')!;
    expect(esxi.ready).toBe(false);
    expect(esxi.why).toMatch(/Nginx Proxy Manager/);
  });
});

describe('checks', () => {
  it('environment and target', () => {
    expect(stepErrors('environment', base(), ctx)).toEqual({ name: 'Enter a name.' });
    expect(stepErrors('environment', base({ name: 'Bad Name' }), ctx).name).toMatch(/lowercase/);
    expect(stepErrors('environment', base({ name: 'qa', gitRef: '' }), ctx).gitRef).toBe('Enter a branch, tag or commit.');
    expect(stepErrors('target', ssh({ proxyIp: 'x' }), ctx).proxyIp).toBe('The proxy IP must be an IPv4 address.');
    expect(stepErrors('target', ssh({ target: '' }), ctx).target).toBe('Choose a target.');
    expect(stepErrors('target', ssh(), ctx)).toEqual({});
  });
  it('a VM, single and Blue/Green', () => {
    const vm = ssh({ target: 'esxi', ipCidr: '10.10.48.70/24', gateway: '10.10.48.1' });
    expect(stepErrors('target', vm, ctx)).toEqual({});
    expect(stepErrors('target', { ...vm, cores: '99' }, ctx).machine).toBe('Use 1 to 64 vCPUs.');
    expect(stepErrors('target', { ...vm, ipMode: 'dhcp', ipCidr: '', gateway: '' }, ctx)).toEqual({});
    const bg = withRules({ ...vm, servers: 'bluegreen', purpleIpCidr: '10.10.48.71/24', dataIpCidr: '10.10.48.72/24' }, ctx);
    expect(stepErrors('target', bg, ctx)).toEqual({});
    expect(stepErrors('target', { ...bg, purpleIpCidr: '10.10.48.70/24' }, ctx).machine)
      .toBe('The data VM and the two app VMs need three different addresses.');
    expect(stepErrors('target', { ...bg, ipMode: 'dhcp' }, ctx).machine)
      .toBe('Blue/Green needs a static address for each of the three VMs.');
  });
  it('the network like the API', () => {
    expect(vmNetworkProblem('10.10.48.70/24', '10.10.48.1')).toBe('');
    expect(vmNetworkProblem('10.10.48.0/24', '10.10.48.1')).toMatch(/prefix/);
    expect(vmNetworkProblem('10.10.48.70/24', '10.10.49.1')).toMatch(/gateway/);
  });
  it('extras: SMTP and Mailpit', () => {
    const smtp = ssh({ mailMode: 'smtp', smtpHost: 'smtp.example.com', smtpFrom: 'ops@example.com' });
    expect(stepErrors('extras', smtp, ctx)).toEqual({});
    expect(stepErrors('extras', { ...smtp, smtpHost: '' }, ctx).mail).toBe("Enter the SMTP server's host name or address.");
    expect(stepErrors('extras', { ...smtp, smtpPassword: 'has space' }, ctx).mail).toMatch(/can't be saved/);
    expect(stepErrors('extras', ssh({ apps: { wiki: true, kiosk: true, status: true, mailpit: false } }), ctx).apps)
      .toBe('Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP.');
    expect(stepErrors('extras', ssh({ aiKey: 'with space' }), ctx).aiKey).toMatch(/can't be saved/);
  });
  it('data: the first admin against the policy hint, never a rule of our own', () => {
    expect(stepErrors('data', ssh(), ctx)).toEqual({});
    expect(stepErrors('data', ssh({ adminPassword: 'short', adminConfirm: 'short' }), ctx).adminPassword)
      .toBe('Use at least 8 characters (ServerSherpa\'s password policy).');
    expect(stepErrors('data', ssh({ adminConfirm: 'Different-Horse-9' }), ctx).adminPassword)
      .toBe("The two passwords don't match.");
    expect(stepErrors('data', ssh({ adminPasswordMode: 'invite', adminPassword: '', adminConfirm: '' }), ctx)).toEqual({});
    expect(stepErrors('data', ssh({ adminEmail: 'nope' }), ctx).adminEmail).toMatch(/valid email/);
    expect(stepErrors('data', ssh({ dataMode: 'snapshot', snapshotId: '' }), ctx).data).toBe('Choose a snapshot.');
  });
});

describe('the create body', () => {
  it('SSH: proxy, bind, publish, default ports, the first admin, no vm', () => {
    expect(buildBody(ssh(), ctx)).toEqual({
      name: 'qa', type: 'custom', target: 'ssh:lab', git_ref: 'main', proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0',
      publish: true, ports: { api: 8000, portal: 8091, kiosk: 8090, wiki: 8096, spaces: 9000, status: 8095, mailpit: 8025 },
      apps: ['wiki', 'kiosk', 'status', 'mailpit'], mail: { mode: 'mailpit' },
      first_admin: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.example.com', password_mode: 'typed',
                     password: 'Correct-Horse-9' },
    });
  });
  it('a snapshot body has no first admin; an invite has no password', () => {
    expect(buildBody(ssh({ dataMode: 'snapshot', snapshotId: 's1' }), ctx)).toMatchObject({ snapshot_id: 's1' });
    expect(buildBody(ssh({ dataMode: 'snapshot', snapshotId: 's1' }), ctx).first_admin).toBeUndefined();
    expect(buildBody(ssh({ adminPasswordMode: 'invite' }), ctx).first_admin).toEqual({
      first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.example.com', password_mode: 'invite', password: null });
  });
  it('a single VM, DHCP sends no address', () => {
    expect(buildBody(ssh({ target: 'esxi', ipMode: 'dhcp' }), ctx).vm).toEqual(
      { cores: 4, memory_mb: 8192, disk_gb: 64, ip_mode: 'dhcp' });
  });
  it('Blue/Green VMs', () => {
    const s = withRules(ssh({ target: 'proxmox', servers: 'bluegreen', ipCidr: '10.10.48.70/24', gateway: '10.10.48.1',
                              purpleIpCidr: '10.10.48.71/24', dataIpCidr: '10.10.48.72/24', autoActivate: true }), ctx);
    expect(buildBody(s, ctx).vm).toEqual({
      cores: 4, memory_mb: 8192, disk_gb: 64, ip_mode: 'static', ip_cidr: '10.10.48.70/24', gateway: '10.10.48.1',
      slots: 2, purple_ip_cidr: '10.10.48.71/24', data_ip_cidr: '10.10.48.72/24',
      data: { cores: 4, memory_mb: 8192, disk_gb: 64 }, auto_activate: true });
  });
  it('DigitalOcean: one droplet, two slots, production', () => {
    const one = buildBody(ssh({ target: 'digitalocean', doAccount: 'development' }), ctx);
    expect(one.do).toEqual({ account: 'development', slots: 1, droplet_size: 's-2vcpu-4gb', db_size: 'db-s-2vcpu-4gb',
                             db_standby: false, acme_staging: false });
    expect(one.proxy_ip).toBeUndefined();
    const prod = buildBody(withRules(ssh({ type: 'production', target: 'digitalocean' }), ctx), ctx);
    expect(prod.do).toEqual({ account: 'production', droplet_size: 's-2vcpu-4gb', db_size: 'db-s-2vcpu-4gb', db_standby: false });
  });
  it('SMTP, apps off and the AI key', () => {
    const body = buildBody(ssh({ apps: { wiki: false, kiosk: true, status: false, mailpit: false }, mailMode: 'smtp',
                                 smtpHost: 'smtp.example.com', smtpPort: '2525', smtpUsername: 'mailer',
                                 smtpPassword: 'Mail-Secret-1', smtpFrom: 'ops@example.com', aiKey: 'sk-ant-1' }), ctx);
    expect([body.apps, body.mail, body.secrets]).toEqual([['kiosk'], {
      mode: 'smtp', host: 'smtp.example.com', port: 2525, username: 'mailer', password: 'Mail-Secret-1',
      from_address: 'ops@example.com', starttls: true }, { SS_ANTHROPIC_API_KEY: 'sk-ant-1' }]);
  });
});

describe('errors', () => {
  it('every code maps to a step', () => {
    for (const [code, field] of Object.entries(CODE_FIELD)) expect(FIELD_STEP[field], code).toBeTruthy();
    expect(stepOfCode('vm_name_invalid')).toBe('environment');
    expect(stepOfCode('base_domain_not_in_zone')).toBe('environment');
    expect(stepOfCode('ip_in_use')).toBe('target');
    expect(stepOfCode('integration_not_configured')).toBe('target');
    expect(stepOfCode('smtp_from_invalid')).toBe('extras');
    expect(stepOfCode('first_admin_password_too_short')).toBe('data');
    expect(stepOfCode('snapshot_not_ready')).toBe('data');
    expect(stepOfCode('something_else')).toBe('review');
  });
});

describe('traffic', () => {
  it('LAN: each public app through NPM to the first server; spaces to the data VM', () => {
    const s = withRules(ssh({ target: 'esxi', servers: 'bluegreen', ipCidr: '10.10.48.70/24', gateway: '10.10.48.1',
                              purpleIpCidr: '10.10.48.71/24', dataIpCidr: '10.10.48.72/24',
                              apps: { wiki: false, kiosk: true, status: true, mailpit: true } }), ctx);
    const plan = trafficPlan(s, ctx);
    expect(plan.kind).toBe('proxy');
    expect(plan.rows.map((r) => [r.hostname, r.to])).toEqual([
      ['api.qa.serversherpa.com', '10.10.48.70:8000'], ['portal.qa.serversherpa.com', '10.10.48.70:8091'],
      ['kiosk.qa.serversherpa.com', '10.10.48.70:8090'], ['spaces.qa.serversherpa.com', '10.10.48.72:9000'],
      ['status.qa.serversherpa.com', '10.10.48.70:8095']]);
  });
  it('DigitalOcean: the load balancer, no spaces name', () => {
    const plan = trafficPlan(ssh({ target: 'digitalocean' }), ctx);
    expect(plan.kind).toBe('load_balancer');
    expect(plan.rows.map((r) => r.hostname)).not.toContain('spaces.qa.serversherpa.com');
  });
});
```

In `lib/sirdarApi.test.ts`, add `'deploy/apps.py'` to the scanner's files and `AppsError` to its error-class alternation, and `'mailpit_required', 'smtp_from_invalid', 'apps_invalid'` to the expected codes.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/deploy src/lib`
Expected: FAIL (no `flowState`, missing copy).

- [ ] **Step 3: Types and copy**

In `sirdarApi.ts`: the interfaces in "Interfaces"; `EnvMail = { mode: 'mailpit' | 'smtp'; host: string | null; port: number | null; username: string | null; from_address: string | null; starttls: boolean; password_set: boolean }`; `MESSAGES` for every row of this plan's table. In `pages/environments/testData.ts`, add `apps: ['wiki', 'kiosk', 'status', 'mailpit']` and `mail: { mode: 'mailpit', host: null, port: null, username: null, from_address: null, starttls: true, password_set: false }` to every `Environment` fixture the type checker flags, `SS_SMTP_PASSWORD: false` to every `secrets_set`, and `apps` / `mail` / `first_admin` to `DEFAULTS`.

- [ ] **Step 4: `flowState.ts`**

Create `sirdar/web/src/pages/deploy/flowState.ts`:

```ts
/** The Deploy page's step-by-step flow (spec 2026-10-07 §1): its state, each
 *  step's checks (the API's rules mirrored so a step can answer before a
 *  round trip; the API stays the authority), the create body, the traffic
 *  plan, and which step an API error belongs to. Pure: no React, no I/O. */
import { ipv4Problem, nameProblem, refProblem } from '../../lib/envRules';
import type {
  DeployTarget, DoAccount, DoAccountKey, EnvType, EnvironmentDefaults, Integrations, NewEnvironmentBody, Snapshot,
} from '../../lib/sirdarApi';
import { gbOf, isDoTarget, isVmTarget, mbOf, sshTargets } from '../environments/labels';

export type FlowStep = 'environment' | 'servers' | 'target' | 'extras' | 'traffic' | 'data' | 'review';
export const FLOW_STEPS: [FlowStep, string][] = [
  ['environment', 'Environment'], ['servers', 'Servers'], ['target', 'Target'], ['extras', 'Extras'],
  ['traffic', 'Traffic'], ['data', 'Data'], ['review', 'Review & Deploy'],
];
export const STEP_HINT: Record<FlowStep, string> = {
  environment: 'A new environment: its type and name.',
  servers: 'One server, or two (Blue/Green) with traffic moved between them by Activate.',
  target: 'Where Sirdar builds it, and that target\'s details.',
  extras: 'Optional apps, hosting options and integrations.',
  traffic: 'What will route traffic to the environment. Nothing to choose here.',
  data: 'Seed it from a snapshot, or start empty with a first super admin.',
  review: 'Every choice. Deploy creates the environment and starts its first deployment.',
};
export const KINDS: EnvType[] = ['production', 'dev', 'beta', 'custom'];
export const KIND_LABEL: Record<EnvType, string> = {
  production: 'Production', dev: 'Development', beta: 'UAT', custom: 'Custom',
};
/** The connection test's type for an environment type (routes/deploy.py DeployType). */
export const CONNECT_TYPE: Record<EnvType, 'blue' | 'dev' | 'beta' | 'custom'> = {
  production: 'blue', dev: 'dev', beta: 'beta', custom: 'custom',
};
export type Servers = 'single' | 'bluegreen';
export type OptionalApp = 'wiki' | 'kiosk' | 'status' | 'mailpit';
export const OPTIONAL_APPS: [OptionalApp, string][] = [
  ['wiki', 'Wiki'], ['kiosk', 'Kiosk'], ['status', 'Status page'], ['mailpit', 'Mailpit'],
];
export type TargetKind = 'esxi' | 'proxmox' | 'digitalocean' | 'ssh';
export const targetKind = (id: string): TargetKind | null =>
  (isVmTarget(id) ? (id as 'esxi' | 'proxmox') : isDoTarget(id) ? 'digitalocean'
    : id === 'ssh' || id.startsWith('ssh:') ? 'ssh' : null);

export interface FlowState {
  type: EnvType; name: string; gitRef: string; baseDomain: string;
  servers: Servers;
  target: string;
  /** LAN (VM or SSH): Nginx Proxy Manager's address, and where the ports bind. */
  proxyIp: string; bindIp: string;
  /** VM sizes (app VMs on Blue/Green) and the network: ipCidr is the VM's, or orange's. */
  cores: string; memoryGb: string; diskGb: string;
  ipMode: 'static' | 'dhcp'; ipCidr: string; gateway: string;
  purpleIpCidr: string; dataIpCidr: string; dataCores: string; dataMemoryGb: string; dataDiskGb: string;
  doAccount: DoAccountKey; dropletSize: string; dbSize: string; dbStandby: boolean; acmeStaging: boolean;
  autoActivate: boolean;
  publish: boolean;
  apps: Record<OptionalApp, boolean>;
  mailMode: 'mailpit' | 'smtp'; smtpHost: string; smtpPort: string; smtpUsername: string; smtpPassword: string;
  smtpFrom: string; smtpStarttls: boolean;
  aiKey: string;
  dataMode: 'empty' | 'snapshot'; snapshotId: string;
  adminFirst: string; adminLast: string; adminEmail: string; adminPasswordMode: 'typed' | 'invite';
  adminPassword: string; adminConfirm: string;
}
export interface FlowContext {
  targets: DeployTarget[];
  defaults: EnvironmentDefaults & { first_admin: { password_min_length: number; role: string; link_minutes: number } };
  integrations: Integrations | null;
  accounts: DoAccount[];
  snapshots: Snapshot[];
}

const npmHost = (i: Integrations | null): string => {
  if (!i?.npm.url) return '';
  try { return new URL(i.npm.url).hostname; } catch { return ''; }
};

export function initialState(ctx: FlowContext): FlowState {
  const d = ctx.defaults;
  const account = ctx.accounts.find((a) => a.configured && a.key === 'development')?.key
    ?? ctx.accounts.find((a) => a.configured)?.key ?? 'development';
  return {
    type: 'dev', name: '', gitRef: d.git_ref, baseDomain: '',
    servers: 'single', target: '',
    proxyIp: npmHost(ctx.integrations), bindIp: d.bind_ip,
    cores: String(d.vm.cores), memoryGb: gbOf(d.vm.memory_mb), diskGb: String(d.vm.disk_gb),
    ipMode: 'static', ipCidr: '', gateway: '', purpleIpCidr: '', dataIpCidr: '',
    dataCores: String(d.vm.cores), dataMemoryGb: gbOf(d.vm.memory_mb), dataDiskGb: String(d.vm.disk_gb),
    doAccount: account, dropletSize: d.do.droplet_size, dbSize: d.do.db_size, dbStandby: d.do.db_standby,
    acmeStaging: false, autoActivate: false,
    publish: !!(ctx.integrations?.cloudflare.configured && ctx.integrations?.npm.configured),
    apps: { wiki: true, kiosk: true, status: true, mailpit: true },
    mailMode: 'mailpit', smtpHost: '', smtpPort: String(d.mail.smtp_port), smtpUsername: '', smtpPassword: '',
    smtpFrom: '', smtpStarttls: true, aiKey: '',
    dataMode: 'empty', snapshotId: '',
    adminFirst: '', adminLast: '', adminEmail: '', adminPasswordMode: 'typed', adminPassword: '', adminConfirm: '',
  };
}

export interface TargetChoice { id: string; label: string; kind: TargetKind; ready: boolean; why: string }

/** Every target the flow can show for the type and servers chosen, with whether it can be picked now. */
export function targetChoices(s: FlowState, ctx: FlowContext): TargetChoice[] {
  const doReady = ctx.accounts.some((a) => a.configured && a.region);
  const npm = !!ctx.integrations?.npm.configured;
  const out: TargetChoice[] = [];
  if (s.type !== 'production') {
    for (const t of ctx.targets.filter((x) => isVmTarget(x.id))) {
      const ready = t.available && t.configured && (s.servers === 'single' || npm);
      out.push({ id: t.id, label: t.label, kind: t.id as 'esxi' | 'proxmox', ready,
                 why: ready ? '' : s.servers === 'bluegreen' && !npm
                   ? 'Blue/Green on the LAN needs Nginx Proxy Manager (Settings › Integrations).' : 'Not set up yet.' });
    }
  }
  out.push({ id: 'digitalocean', label: 'DigitalOcean', kind: 'digitalocean', ready: doReady,
             why: doReady ? '' : 'Set up a DigitalOcean account (token and region) in Settings › Integrations.' });
  if (s.type !== 'production' && s.servers === 'single') {
    for (const t of sshTargets(ctx.targets)) out.push({ id: t.id, label: t.label, kind: 'ssh', ready: true, why: '' });
  }
  return out;
}

/** The rules a choice imposes on the others (production lives on DigitalOcean with Blue and Green). */
export function withRules(s: FlowState, ctx: FlowContext): FlowState {
  let next = s;
  if (next.type === 'production') {
    const prodReady = ctx.accounts.find((a) => a.key === 'production')?.configured;
    next = { ...next, servers: 'bluegreen', autoActivate: false, acmeStaging: false,
             doAccount: prodReady ? 'production' : next.doAccount };
  }
  if (next.target && !targetChoices(next, ctx).some((t) => t.id === next.target)) next = { ...next, target: '' };
  if (next.servers === 'bluegreen' && next.ipMode === 'dhcp' && isVmTarget(next.target)) next = { ...next, ipMode: 'static' };
  return next;
}

export type Field = 'type' | 'name' | 'gitRef' | 'baseDomain' | 'servers' | 'target' | 'proxyIp' | 'bindIp'
  | 'machine' | 'cloud' | 'hosting' | 'publish' | 'apps' | 'mail' | 'aiKey' | 'data' | 'adminName' | 'adminEmail'
  | 'adminPassword' | 'form';
export type Errors = Partial<Record<Field, string>>;
const only = (e: Errors): Errors => Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Errors;

const CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
const VM_IP_HELP = 'Use an address with its prefix, like 10.10.48.70/24.';
const VM_GATEWAY_HELP = "The gateway must be another address in the VM's network.";
const toInt = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
/** The API's check_network for a static address: '' when the API would accept it. */
export function vmNetworkProblem(cidr: string, gw: string): string {
  const m = CIDR_RE.exec(cidr.trim());
  const prefix = m ? Number(m[2]) : 0;
  if (!m || ipv4Problem(m[1], 'address') || prefix < 8 || prefix > 30) return VM_IP_HELP;
  const ip = toInt(m[1]);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const first = ip >>> 24;
  if (ip === network || ip === broadcast || first === 0 || first === 127 || first >= 224
      || (ip >>> 16) === 0xa9fe) return VM_IP_HELP;
  if (ipv4Problem(gw, 'gateway')) return VM_GATEWAY_HELP;
  const g = toInt(gw.trim());
  if (((g & mask) >>> 0) !== network || g === ip || g === network || g === broadcast) return VM_GATEWAY_HELP;
  return '';
}
const DROPLET_SIZE_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const DB_SIZE_RE = /^db-[a-z0-9][a-z0-9-]{2,36}$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}$/;
const USER_RE = /^[^\s"'$#`\\]{1,254}$/;
/** envfile.SECRET_VALUE_RE: what an optional secret in the .env may hold. */
const SECRET_RE = /^[A-Za-z0-9._~+/=:@%^*!?,;-]{1,1024}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f  ]/;
const SECRET_HELP = "can't be saved. Use letters, numbers and ._~+/=:@%^*!?,;- only, with no spaces or quotes.";

const whole = (raw: string) => (/^\d+$/.test(raw.trim()) ? Number(raw) : NaN);
const inRange = (n: number, [low, high]: [number, number]) => n >= low && n <= high;

function sizeProblem(cores: string, memoryGb: string, diskGb: string, ctx: FlowContext): string {
  const l = ctx.defaults.vm.limits;
  if (!inRange(whole(cores), l.cores)) return `Use ${l.cores[0]} to ${l.cores[1]} vCPUs.`;
  if (!/^\d+(\.\d)?$/.test(memoryGb.trim()) || !inRange(mbOf(memoryGb), l.memory_mb))
    return `Use ${gbOf(l.memory_mb[0])} to ${gbOf(l.memory_mb[1])} GB of memory.`;
  if (!inRange(whole(diskGb), l.disk_gb)) return `Use a disk of ${l.disk_gb[0]} to ${l.disk_gb[1]} GB.`;
  return '';
}

function machineProblem(s: FlowState, ctx: FlowContext): string {
  const sizes = sizeProblem(s.cores, s.memoryGb, s.diskGb, ctx);
  if (sizes) return sizes;
  if (s.servers === 'single') return s.ipMode === 'dhcp' ? '' : vmNetworkProblem(s.ipCidr, s.gateway);
  if (s.ipMode !== 'static') return 'Blue/Green needs a static address for each of the three VMs.';
  for (const cidr of [s.ipCidr, s.purpleIpCidr, s.dataIpCidr]) {
    const p = vmNetworkProblem(cidr, s.gateway);
    if (p) return p;
  }
  const data = sizeProblem(s.dataCores, s.dataMemoryGb, s.dataDiskGb, ctx);
  if (data) return `Data VM: ${data}`;
  const ips = new Set([s.ipCidr, s.purpleIpCidr, s.dataIpCidr].map((c) => c.trim().split('/')[0]));
  return ips.size === 3 ? '' : 'The data VM and the two app VMs need three different addresses.';
}

export function stepErrors(step: FlowStep, s: FlowState, ctx: FlowContext): Errors {
  const kind = targetKind(s.target);
  switch (step) {
    case 'environment': {
      const name = s.name.trim();
      const prodBlocked = s.type === 'production' && !ctx.accounts.some((a) => a.configured);
      return only({
        name: name ? nameProblem(name) : 'Enter a name.',
        type: prodBlocked ? 'Production runs on DigitalOcean: set up a DigitalOcean account in Settings › Integrations first.' : '',
        gitRef: refProblem(s.gitRef),
        baseDomain: s.baseDomain.trim() && !DOMAIN_RE.test(s.baseDomain.trim().toLowerCase())
          ? "That domain isn't valid. Use a name like uat.serversherpa.com." : '',
      });
    }
    case 'target': {
      const choice = targetChoices(s, ctx).find((t) => t.id === s.target);
      if (!choice) return { target: 'Choose a target.' };
      if (!choice.ready) return { target: choice.why };
      if (kind === 'digitalocean') {
        const a = ctx.accounts.find((x) => x.key === s.doAccount);
        if (!a?.configured || !a.region) return { cloud: `Set up the ${a?.label ?? 'DigitalOcean'} account (token and region) in Settings › Integrations first.` };
        if (!DROPLET_SIZE_RE.test(s.dropletSize) || s.dropletSize.startsWith('db-')) return { cloud: "That isn't a DigitalOcean droplet size." };
        if (!DB_SIZE_RE.test(s.dbSize)) return { cloud: "That isn't a DigitalOcean database size." };
        return {};
      }
      return only({
        proxyIp: ipv4Problem(s.proxyIp, 'proxy IP'), bindIp: ipv4Problem(s.bindIp, 'bind IP'),
        machine: kind === 'esxi' || kind === 'proxmox' ? machineProblem(s, ctx) : '',
      });
    }
    case 'extras': {
      const errors: Errors = {};
      if (s.mailMode === 'mailpit' && !s.apps.mailpit)
        errors.apps = 'Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP.';
      if (s.mailMode === 'smtp') {
        const port = whole(s.smtpPort);
        errors.mail = !HOST_RE.test(s.smtpHost.trim()) ? "Enter the SMTP server's host name or address."
          : !inRange(port, [1, 65535]) ? 'Use an SMTP port from 1 to 65535.'
          : s.smtpUsername && !USER_RE.test(s.smtpUsername) ? "That SMTP user name can't be used: no spaces, quotes, $, # or backslashes."
          : s.smtpPassword && !SECRET_RE.test(s.smtpPassword) ? `That SMTP password ${SECRET_HELP}`
          : !EMAIL_RE.test(s.smtpFrom.trim()) ? 'Enter the address mail is sent from, like noreply@example.com.' : '';
      }
      if (s.aiKey && !SECRET_RE.test(s.aiKey)) errors.aiKey = `That key ${SECRET_HELP}`;
      return only(errors);
    }
    case 'data': {
      if (s.dataMode === 'snapshot') return s.snapshotId ? {} : { data: 'Choose a snapshot.' };
      const min = ctx.defaults.first_admin.password_min_length;
      const names = [s.adminFirst, s.adminLast].map((v) => v.trim());
      return only({
        adminName: names.some((n) => !n || n.length > 100 || CONTROL_RE.test(n))
          ? 'Enter a first and last name (up to 100 characters each).' : '',
        adminEmail: !EMAIL_RE.test(s.adminEmail.trim()) ? 'Enter a valid email address for the first admin.' : '',
        adminPassword: s.adminPasswordMode === 'invite' ? ''
          : s.adminPassword.length < min ? `Use at least ${min} characters (ServerSherpa's password policy).`
          : CONTROL_RE.test(s.adminPassword) ? "The password can't contain line breaks or control characters."
          : s.adminPassword !== s.adminConfirm ? "The two passwords don't match." : '',
      });
    }
    default:
      return {};
  }
}

const ports = (ctx: FlowContext) => Object.fromEntries(ctx.defaults.services.map((sv) => [sv.service, sv.port]));

export function buildBody(s: FlowState, ctx: FlowContext): NewEnvironmentBody {
  const kind = targetKind(s.target);
  const production = s.type === 'production';
  const twoSlots = s.servers === 'bluegreen';
  const body: NewEnvironmentBody = {
    name: s.name.trim(), type: s.type, target: s.target, git_ref: s.gitRef.trim(),
    ...(s.baseDomain.trim() ? { base_domain: s.baseDomain.trim().toLowerCase() } : {}),
    ports: ports(ctx),
    apps: OPTIONAL_APPS.map(([a]) => a).filter((a) => s.apps[a]),
    mail: s.mailMode === 'smtp'
      ? { mode: 'smtp', host: s.smtpHost.trim(), port: Number(s.smtpPort), ...(s.smtpUsername ? { username: s.smtpUsername } : {}),
          ...(s.smtpPassword ? { password: s.smtpPassword } : {}), from_address: s.smtpFrom.trim(), starttls: s.smtpStarttls }
      : { mode: 'mailpit' },
    ...(s.aiKey ? { secrets: { SS_ANTHROPIC_API_KEY: s.aiKey } } : {}),
  };
  if (s.dataMode === 'snapshot') body.snapshot_id = s.snapshotId;
  else {
    body.first_admin = {
      first_name: s.adminFirst.trim(), last_name: s.adminLast.trim(), email: s.adminEmail.trim(),
      password_mode: s.adminPasswordMode, password: s.adminPasswordMode === 'typed' ? s.adminPassword : null,
    };
  }
  if (kind === 'digitalocean') {
    body.do = {
      account: s.doAccount, ...(production ? {} : { slots: twoSlots ? 2 : 1 }),
      droplet_size: s.dropletSize, db_size: s.dbSize, db_standby: s.dbStandby,
      ...(production ? {} : { acme_staging: s.acmeStaging }),
      ...(twoSlots && !production ? { auto_activate: s.autoActivate } : {}),
    };
    return body;
  }
  body.proxy_ip = s.proxyIp.trim();
  body.bind_ip = s.bindIp.trim();
  body.publish = s.publish;
  if (kind === 'esxi' || kind === 'proxmox') {
    const sizes = { cores: Number(s.cores), memory_mb: mbOf(s.memoryGb), disk_gb: Number(s.diskGb) };
    body.vm = twoSlots
      ? { ...sizes, ip_mode: 'static', ip_cidr: s.ipCidr.trim(), gateway: s.gateway.trim(), slots: 2,
          purple_ip_cidr: s.purpleIpCidr.trim(), data_ip_cidr: s.dataIpCidr.trim(),
          data: { cores: Number(s.dataCores), memory_mb: mbOf(s.dataMemoryGb), disk_gb: Number(s.dataDiskGb) },
          auto_activate: s.autoActivate }
      : { ...sizes, ip_mode: s.ipMode,
          ...(s.ipMode === 'static' ? { ip_cidr: s.ipCidr.trim(), gateway: s.gateway.trim() } : {}) };
  }
  return body;
}

/** API error code → the field (so the step) it belongs to; anything else stays on Review. */
export const CODE_FIELD: Record<string, Field> = {
  name_invalid: 'name', name_reserved: 'name', environment_exists: 'name', vm_name_invalid: 'name',
  type_invalid: 'type', production_exists: 'type',
  ref_invalid: 'gitRef', base_domain_invalid: 'baseDomain', base_domain_not_in_zone: 'baseDomain',
  target_invalid: 'target', target_not_configured: 'target', integration_not_configured: 'target',
  vm_not_allowed: 'target', do_not_allowed: 'target', bluegreen_not_allowed: 'target',
  production_requires_digitalocean: 'target', integration_unreadable: 'target',
  proxy_ip_required: 'proxyIp', proxy_ip_invalid: 'proxyIp', bind_ip_invalid: 'bindIp',
  vm_invalid: 'machine', vm_cores_invalid: 'machine', vm_memory_invalid: 'machine', vm_disk_invalid: 'machine',
  vm_ip_mode_invalid: 'machine', vm_ip_invalid: 'machine', vm_gateway_invalid: 'machine', ip_in_use: 'machine',
  vm_static_required: 'machine', vm_ips_not_distinct: 'machine', ssh_targets_unreadable: 'machine',
  dns_servers_invalid: 'machine',
  do_account_not_configured: 'cloud', do_invalid: 'cloud', do_slots_invalid: 'cloud', do_size_invalid: 'cloud',
  do_db_size_invalid: 'cloud',
  auto_activate_not_allowed: 'hosting',
  apps_invalid: 'apps', mailpit_required: 'apps',
  mail_invalid: 'mail', smtp_host_invalid: 'mail', smtp_port_invalid: 'mail', smtp_username_invalid: 'mail',
  smtp_password_invalid: 'mail', smtp_from_invalid: 'mail',
  secret_invalid: 'aiKey', secret_not_editable: 'aiKey',
  snapshot_not_found: 'data', snapshot_not_ready: 'data', first_admin_with_seed: 'data', first_admin_invalid: 'data',
  first_admin_name_invalid: 'adminName', first_admin_email_invalid: 'adminEmail',
  first_admin_password_too_short: 'adminPassword', first_admin_password_invalid: 'adminPassword',
  first_admin_password_not_allowed: 'adminPassword',
};
export const FIELD_STEP: Record<Field, FlowStep> = {
  type: 'environment', name: 'environment', gitRef: 'environment', baseDomain: 'environment',
  servers: 'servers',
  target: 'target', proxyIp: 'target', bindIp: 'target', machine: 'target', cloud: 'target',
  hosting: 'extras', publish: 'extras', apps: 'extras', mail: 'extras', aiKey: 'extras',
  data: 'data', adminName: 'data', adminEmail: 'data', adminPassword: 'data',
  form: 'review',
};
export const stepOfCode = (code: string): FlowStep => FIELD_STEP[CODE_FIELD[code] ?? 'form'];

const ORDER = FLOW_STEPS.map(([s]) => s);
export const nextStep = (s: FlowStep): FlowStep => ORDER[Math.min(ORDER.indexOf(s) + 1, ORDER.length - 1)];
export const prevStep = (s: FlowStep): FlowStep => ORDER[Math.max(ORDER.indexOf(s) - 1, 0)];

export const effectiveDomain = (s: FlowState, ctx: FlowContext) =>
  s.baseDomain.trim().toLowerCase() || `${s.name.trim() || '<name>'}.${ctx.defaults.domain_suffix}`;

export interface TrafficRow { hostname: string; via: string; to: string }
/** What will route traffic, read-only (the Traffic step). */
export function trafficPlan(s: FlowState, ctx: FlowContext): { kind: 'load_balancer' | 'proxy'; rows: TrafficRow[] } {
  const domain = effectiveDomain(s, ctx);
  const kind = targetKind(s.target);
  const port = (svc: string) => ctx.defaults.services.find((x) => x.service === svc)?.port ?? 0;
  const publicApps = ctx.defaults.services.filter((x) => x.public)
    .map((x) => x.service).filter((svc) => !(svc in s.apps) || s.apps[svc as OptionalApp]);
  const ip = (cidr: string) => cidr.trim().split('/')[0];
  if (kind === 'digitalocean') {
    const first = s.type === 'production' ? 'Blue' : 'Orange';
    return { kind: 'load_balancer', rows: publicApps.filter((svc) => svc !== 'spaces').map((svc) => ({
      hostname: `${svc}.${domain}`, via: "The load balancer (HTTPS, Let's Encrypt)", to: `${first} droplet` })) };
  }
  const first = kind === 'ssh' ? "the SSH target's address"
    : s.ipMode === 'dhcp' && s.servers === 'single' ? "the VM's DHCP address" : ip(s.ipCidr) || 'the first VM';
  const via = `Nginx Proxy Manager${s.proxyIp ? ` (${s.proxyIp})` : ''}`;
  return { kind: 'proxy', rows: publicApps.map((svc) => ({
    hostname: `${svc}.${domain}`, via,
    to: svc === 'spaces' && s.servers === 'bluegreen' ? `${ip(s.dataIpCidr) || 'the data VM'}:${port(svc)}`
      : `${first}:${port(svc)}` })) };
}
```

(Every literal copy above that has an API twin is the twin's `MESSAGES` text; keep them identical when one changes.)

- [ ] **Step 5: Styles**

Append to `sirdar/web/src/styles/sirdar.css`:

```css
/* The Deploy page's step-by-step flow: a page section with the report-generate
   header and steps (the portal's .rgm-head-text / .rgm-steps), a body, and the
   Back / Next / Deploy row. */
.sirdar-flow { margin: 24px 0; padding: 20px; min-width: 0; border: 1px solid var(--paper-line, #e5e7eb);
  border-radius: 12px; background: var(--surface, #fff); }
.sirdar-flow-head { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
.sirdar-flow-body { min-width: 0; }
.sirdar-flow-body.pf-form > * { grid-column: 1 / -1; }
.sirdar-flow-foot { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 20px; }
.sirdar-flow-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; align-items: start; }
.sirdar-flow-grid .sirdar-span2 { grid-column: 1 / -1; }
@media (max-width: 720px) { .sirdar-flow-grid { grid-template-columns: 1fr; } }
.sirdar-flow-details { margin-top: 16px; }
.sirdar-flow-details > summary { cursor: pointer; font-weight: 600; }
.sirdar-toggle-row { display: flex; align-items: center; gap: 10px; }
.modal-card.reports-modal-card.rgm-card.sirdar-adopt-card { width: min(640px, 96vw); max-width: 96vw; }
```

and in `styles/cardLayout.test.ts` add:

```ts
it('the Deploy flow keeps two columns on a desktop and one on a phone', () => {
  expect(decls('.sirdar-flow-grid')['grid-template-columns']).toBe('repeat(2, minmax(0, 1fr))');
  expect(decls('.sirdar-flow')['min-width']).toBe('0');
});
```

- [ ] **Step 6: Run the tests and the build**

Run: `npm --prefix sirdar/web test -- src/pages/deploy src/lib src/styles && npm --prefix sirdar/web run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/lib/sirdarApi.test.ts sirdar/web/src/pages/deploy/flowState.ts sirdar/web/src/pages/deploy/flowState.test.ts sirdar/web/src/pages/deploy/flowFixtures.ts sirdar/web/src/styles/sirdar.css sirdar/web/src/styles/cardLayout.test.ts sirdar/web/src/pages/environments/testData.ts
git commit -m "feat(sirdar-web): the Deploy flow's state, checks and create body

Seven steps, the API's rules mirrored per step, the create body for SSH,
VMs (single and Blue/Green) and DigitalOcean, the traffic plan and which
step an API error goes back to.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `TargetPanel` (today's targets, connection test and trusted hosts, moved)

**Files:**
- Create: `sirdar/web/src/pages/deploy/TargetPanel.tsx`
- Create: `sirdar/web/src/pages/deploy/TargetPanel.test.tsx` (the target / connect / trusted-host tests of `pages/Deploy.test.tsx` move here; Task 7 removes them from `Deploy.test.tsx`)

**Interfaces:**
- Consumes: `getDeployTargets`, `connectDeploy`, `listKnownHosts`, `trustKnownHost`, `forgetKnownHost`, `deleteSshTarget`, `getDoAccounts`, `getDoRegions`, `SshTargetModal`, `HostKeyModal`.
- Produces: `TargetPanel({ target, onTarget, connectType, connectName, choosable, onTargetsChanged, doAccount })`:
  - `target: string`, `onTarget(id: string)` — controlled selection;
  - `connectType: 'blue' | 'dev' | 'beta' | 'custom'` (from `flowState.CONNECT_TYPE`), `connectName?: string` (sent for `custom`);
  - `choosable?: (id: string) => boolean` — targets the flow allows now (others show disabled with their chip);
  - `onTargetsChanged?()` — after an SSH target is added, edited or removed (the flow reloads its context);
  - `doAccount?: DoAccountKey` — when set (the flow's Target step), the DigitalOcean connection test reads this account and the panel shows no account picker of its own (the step has one); without it the panel keeps today's picker.
  - Renders the target cards (+ "Add SSH target"), the selected target's notes, and a `<details className="sirdar-flow-details">` with summary **"Connection test and trusted SSH hosts"** holding the Connect section (account and region pickers for DigitalOcean, as today) and the Trusted SSH hosts table. No "Deployment type" section (the flow's Environment step owns the type).

- [ ] **Step 1: Move the tests**

Create `sirdar/web/src/pages/deploy/TargetPanel.test.tsx` from `pages/Deploy.test.tsx`:

- keep its mocks, `TARGETS`, `OK`, `UNKNOWN`, `MISMATCH` and `beforeEach` (drop `listEnvironments` / `listSnapshots` from the mocked API: the panel doesn't call them);
- add the harness and use it instead of `<Deploy />`:

```tsx
function Harness({ type = 'dev', name, choosable }: {
  type?: 'blue' | 'dev' | 'beta' | 'custom'; name?: string; choosable?: (id: string) => boolean;
}) {
  const [target, setTarget] = useState('');
  return <TargetPanel target={target} onTarget={setTarget} connectType={type} connectName={name} choosable={choosable} />;
}
const renderPanel = (props: Parameters<typeof Harness>[0] = {}) =>
  render(<MemoryRouter><Harness {...props} /></MemoryRouter>);
```

- port these tests one for one, replacing every "choose a type" click with the harness's `type` prop: "renders the four cards …", "a not-configured target lists the env keys to set", "Test connection stays disabled until a configured target is chosen" (was "…and a type are chosen"), "a successful test shows each check and the facts", "connect_failed shows the reason inline", "an unknown host key opens the trust modal …", "host_key_changed while trusting …", "changing the target clears the result, mismatch and error" (was "…target or type…"), "a double click on Test connection sends one request", "forgetting after a mismatch …", "a key mismatch shows both fingerprints …", "without deploy:change the mismatch panel has no forget button", "a view-only admin sees the panel but the button is disabled with a note", "lists trusted hosts and forgets one after confirming", "empty hosts list shows the empty state", all seven "DigitalOcean: …" tests, "sends the name for Custom and shows it in the results header; other types don't send it" (render with `type: 'custom', name: 'qa7'` and with `type: 'dev', name: 'qa7'`), the five SSH-target tests ("shows the add card only with deploy:change and can_add_ssh …", "saved SSH cards show names only …", "adding a target selects it and reloads the list", "Edit opens the modal …", "Remove confirms, deletes, refreshes and clears the selection"), "connects with the saved target id, and trusts with it";
- replace the two "the Proxmox/ESXi card points to Settings and New environment instead of testing here" tests with:

```tsx
it('a VM host card says Sirdar builds VMs there and is tested in Settings', async () => {
  api.getDeployTargets.mockResolvedValue({ ...TARGETS, targets: [...TARGETS.targets,
    { id: 'esxi', label: 'VMware ESXi', kind: 'esxi', available: true, configured: true }] });
  renderPanel();
  await userEvent.click(await screen.findByRole('radio', { name: /VMware ESXi/ }));
  expect(screen.getByText(/Sirdar builds this environment's VMs on VMware ESXi/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true);
});

it('only the targets the flow allows can be picked', async () => {
  const onTarget = vi.fn();
  render(<MemoryRouter><TargetPanel target="" onTarget={onTarget} connectType="dev"
                                    choosable={(id) => id === 'ssh'} /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('radio', { name: /DigitalOcean/ }));
  expect(onTarget).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  expect(onTarget).toHaveBeenCalledWith('ssh');
});

it('keeps the connection test and trusted hosts in a collapsible section', async () => {
  renderPanel();
  const summary = await screen.findByText('Connection test and trusted SSH hosts');
  expect(summary.closest('details')).toBeTruthy();
});
```

- drop "shows Custom as the fifth type with its description" and "shows the name field only for Custom, validates it and gates the button" (the Environment step owns both; Task 5's `EnvironmentStep.test.tsx` covers the name rules).

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/deploy/TargetPanel.test.tsx`
Expected: FAIL (no `TargetPanel`).

- [ ] **Step 3: `TargetPanel.tsx`**

Create `sirdar/web/src/pages/deploy/TargetPanel.tsx` by **moving** from `pages/Deploy.tsx`: `ENV_KEYS`, `INITIALS`, `kindOf`, `CHECK_CHIP`, `KeyInfo`, `statusChip`, and the body of `Deploy()` from the state hooks down to the Trusted SSH hosts table and the two modals, with these changes:

```tsx
export default function TargetPanel({ target, onTarget, connectType, connectName, choosable, onTargetsChanged, doAccount }: {
  target: string; onTarget: (id: string) => void;
  connectType: 'blue' | 'dev' | 'beta' | 'custom'; connectName?: string;
  choosable?: (id: string) => boolean; onTargetsChanged?: () => void; doAccount?: DoAccountKey;
}) {
```

- with `doAccount` set: `account` follows it (`useEffect(() => { if (doAccount && doAccount !== accountRef.current) { accountRef.current = doAccount; setAccount(doAccount); setRegion(''); } }, [doAccount])`) and the "Account" segmented block renders only when `!doAccount`;

- remove the `type` / `types` / `envName` state and the whole "Deployment type" `<section>`; `isCustom = connectType === 'custom'`, `trimmedName = (connectName ?? '').trim()`, `nameOk = !isCustom || (!!trimmedName && !nameProblem(trimmedName))`; `canRun` drops `!!type`;
- `run()` calls `connectDeploy(target, connectType, …)` with `sentName = isCustom ? trimmedName : undefined` (the existing argument shapes);
- `pick` and the cards call `onTarget(id)` (and `clearOutcome()`), never `setTarget`; a card is clickable when `t.available && (choosable?.(t.id) ?? true)` — otherwise `aria-disabled` and no call;
- every `setTarget('')` / `setTarget(\`ssh:${slug}\`)` becomes `onTarget(...)`, and `loadTargets()` is followed by `onTargetsChanged?.()` in `removeSaved` and `savedSsh`;
- the VM-host note becomes `Sirdar builds this environment's VMs on {selected.label}. Test the host in Settings › Integrations.`;
- wrap the Connect `<section>` and the Trusted SSH hosts `<section>` in

```tsx
      <details className="sirdar-flow-details">
        <summary>Connection test and trusted SSH hosts</summary>
        …the two sections, unchanged…
      </details>
```

- the results header shows `CONNECT_LABEL[result.type] ?? result.type` with `const CONNECT_LABEL = { blue: 'Production', dev: 'Development', beta: 'UAT', custom: 'Custom' }` (instead of the `types` list).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/pages/deploy/TargetPanel.test.tsx`
Expected: PASS. (`pages/Deploy.test.tsx` still tests the old page until Task 7.)

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/deploy/TargetPanel.tsx sirdar/web/src/pages/deploy/TargetPanel.test.tsx
git commit -m "feat(sirdar-web): TargetPanel, the Deploy page's targets made controlled

Cards, the connection test and trusted SSH hosts (collapsible), for the
flow's Target step; the type comes from the flow.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Steps 1–3 (Environment, Servers, Target)

**Files:**
- Create: `sirdar/web/src/pages/deploy/steps/EnvironmentStep.tsx`, `ServersStep.tsx`, `TargetStep.tsx`
- Create: `sirdar/web/src/pages/deploy/steps/EnvironmentStep.test.tsx`, `ServersStep.test.tsx`, `TargetStep.test.tsx`

**Interfaces:**
- Consumes: Task 3 (`FlowState`, `FlowContext`, `Errors`, `KINDS`, `KIND_LABEL`, `targetChoices`, `targetKind`, `CONNECT_TYPE`), Task 4 (`TargetPanel`).
- Produces: every step component takes `StepProps = { state: FlowState; set: (patch: Partial<FlowState>) => void; errors: Errors; ctx: FlowContext }` (export the type from `EnvironmentStep.tsx` as `StepProps`); `TargetStep` adds `onTargetsChanged: () => void`.
  - **EnvironmentStep**: Type (segmented: Production, Development, UAT, Custom), Name (input, `NAME_HELP`, focused on mount), and a `<details>` "Advanced" with Git ref and Base domain (placeholder = the default domain). Production with no DigitalOcean account shows its error under Type.
  - **ServersStep**: segmented "Single server · Blue/Green"; production: only Blue/Green (Single `aria-disabled`, with "Production always runs Blue and Green."); hints: Single → "One server: each deploy updates it in place." (SSH targets: "SSH targets run a single server."), Blue/Green → production "Blue and Green: each deploy goes to the idle one; Activate moves traffic to it." / else "Orange and Purple: …".
  - **TargetStep**: `TargetPanel` (choosable = `targetChoices(...).filter(t => t.ready)`), the chosen target's reason when not ready, then the details: DigitalOcean (account segmented, region read-only, droplet and database sizes, the Development-account warning for production); VM (sizes; Single: Static/DHCP + address + gateway; Blue/Green: gateway, orange, purple and data VM addresses, data VM sizes); LAN (VM or SSH): Proxy IP (prefilled from NPM) and Bind IP. Errors: `target`, `cloud`, `machine`, `proxyIp`, `bindIp`.

- [ ] **Step 1: Write the failing tests**

Create `EnvironmentStep.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';

import { flowCtx } from '../flowFixtures';
import { initialState, withRules, type Errors, type FlowState } from '../flowState';

import EnvironmentStep from './EnvironmentStep';

afterEach(cleanup);
const ctx = flowCtx();

function Harness({ errors = {} }: { errors?: Errors }) {
  const [state, setState] = useState<FlowState>(initialState(ctx));
  return (
    <>
      <EnvironmentStep state={state} set={(p) => setState((s) => withRules({ ...s, ...p }, ctx))} errors={errors} ctx={ctx} />
      <output data-testid="state">{JSON.stringify({ type: state.type, name: state.name, servers: state.servers })}</output>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!);

it('offers the four types and a name, focused', async () => {
  render(<Harness />);
  for (const label of ['Production', 'Development', 'UAT', 'Custom']) expect(screen.getByRole('radio', { name: label })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await userEvent.click(screen.getByRole('radio', { name: 'UAT' }));
  expect(state()).toEqual({ type: 'beta', name: 'qa', servers: 'single' });
});

it('production switches to Blue/Green', async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole('radio', { name: 'Production' }));
  expect(state().servers).toBe('bluegreen');
});

it('shows each field error under its field', () => {
  render(<Harness errors={{ name: 'Enter a name.', type: 'Production runs on DigitalOcean: …' }} />);
  expect(screen.getByText('Enter a name.')).toBeTruthy();
  expect(screen.getByText('Production runs on DigitalOcean: …')).toBeTruthy();
});

it('keeps the ref and base domain under Advanced', () => {
  render(<Harness />);
  expect(screen.getByText('Advanced').closest('details')).toBeTruthy();
  expect((screen.getByLabelText('Git ref') as HTMLInputElement).value).toBe('main');
  expect((screen.getByLabelText('Base domain') as HTMLInputElement).placeholder).toBe('<name>.serversherpa.com');
});
```

Create `ServersStep.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { flowCtx } from '../flowFixtures';
import { initialState } from '../flowState';

import ServersStep from './ServersStep';

afterEach(cleanup);
const ctx = flowCtx();

it('Single or Blue/Green', async () => {
  const set = vi.fn();
  render(<ServersStep state={initialState(ctx)} set={set} errors={{}} ctx={ctx} />);
  await userEvent.click(screen.getByRole('radio', { name: 'Blue/Green' }));
  expect(set).toHaveBeenCalledWith({ servers: 'bluegreen' });
  expect(screen.getByText(/One server: each deploy updates it in place/)).toBeTruthy();
});

it('production is Blue/Green only', async () => {
  const set = vi.fn();
  render(<ServersStep state={{ ...initialState(ctx), type: 'production', servers: 'bluegreen' }} set={set} errors={{}} ctx={ctx} />);
  expect(screen.getByRole('radio', { name: 'Single server' }).getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(screen.getByRole('radio', { name: 'Single server' }));
  expect(set).not.toHaveBeenCalled();
  expect(screen.getByText(/Production always runs Blue and Green/)).toBeTruthy();
});
```

Create `TargetStep.test.tsx` (mock `../../../lib/sirdarApi` as `TargetPanel.test.tsx` does — `getDeployTargets` → `{ targets: FLOW_TARGETS, types: [] }`, `listKnownHosts` → `[]`, `getDoAccounts` → `DO_ACCOUNTS_BOTH`, `getDoRegions` → a region list — and `@portal/auth/AuthContext` with add + change), with these tests:

```tsx
it('a VM target asks for sizes and the address; Single can be DHCP', async () => {
  const { set } = await renderStep({ target: 'esxi' });
  expect(screen.getByLabelText('vCPUs')).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: 'DHCP' }));
  expect(set).toHaveBeenCalledWith({ ipMode: 'dhcp' });
  expect(screen.getByText(/Sirdar copies the Ubuntu seed VM's disk into a VM named ss-qa on ESXi/)).toBeTruthy();
});

it('Blue/Green asks for three addresses and the data VM size', async () => {
  await renderStep({ target: 'proxmox', servers: 'bluegreen' });
  for (const label of ['Gateway', 'Orange VM address', 'Purple VM address', 'Data VM address', 'Data VM vCPUs'])
    expect(screen.getByLabelText(label)).toBeTruthy();
  expect(screen.queryByRole('radio', { name: 'DHCP' })).toBeNull();
  expect(screen.getByText(/ss-qa-data, ss-qa-orange and ss-qa-purple/)).toBeTruthy();
});

it('the LAN proxy IP starts at Nginx Proxy Manager\'s address', async () => {
  await renderStep({ target: 'ssh:lab' });
  expect((screen.getByLabelText('Proxy IP') as HTMLInputElement).value).toBe('10.10.48.6');
});

it('DigitalOcean: the account, its region and the sizes; no proxy IP', async () => {
  const { set } = await renderStep({ target: 'digitalocean' });
  expect(screen.queryByLabelText('Proxy IP')).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: 'Production' }));
  expect(set).toHaveBeenCalledWith({ doAccount: 'production' });
  expect(screen.getByLabelText('Droplet size')).toBeTruthy();
  expect(screen.getByText(/Built in nyc3/)).toBeTruthy();
});

it("DigitalOcean: an account that isn't set up can't be chosen", async () => {
  await renderStep({ target: 'digitalocean', doAccount: 'production' }, { accounts: DO_ACCOUNTS });
  expect((screen.getByRole('radio', { name: 'Development' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByRole('radio', { name: 'Production' })).toHaveLength(1);     // the panel has no picker of its own
});

it('production in the Development account warns', async () => {
  await renderStep({ target: 'digitalocean', type: 'production', servers: 'bluegreen', doAccount: 'development' });
  expect(screen.getByText(/shares its renewal token with every development droplet/)).toBeTruthy();
});

it('shows the step errors', async () => {
  await renderStep({ target: 'esxi' }, {}, { machine: 'Use 1 to 64 vCPUs.', proxyIp: 'The proxy IP must be an IPv4 address.' });
  expect(screen.getByText('Use 1 to 64 vCPUs.')).toBeTruthy();
  expect(screen.getByText('The proxy IP must be an IPv4 address.')).toBeTruthy();
});
```

with the helper

```tsx
async function renderStep(over: Partial<FlowState>, ctxOver: Partial<FlowContext> = {}, errors: Errors = {}) {
  const ctx = flowCtx(ctxOver);
  const set = vi.fn();
  render(<MemoryRouter><TargetStep state={{ ...initialState(ctx), name: 'qa', ...over }} set={set} errors={errors}
                                   ctx={ctx} onTargetsChanged={vi.fn()} /></MemoryRouter>);
  await screen.findByText('Connection test and trusted SSH hosts');
  return { set };
}
```

(`DO_ACCOUNTS` — only Production configured, in `nyc3` — and `DO_ACCOUNTS_BOTH` — both, both in `nyc3` — come from `pages/environments/testData.ts`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/deploy/steps`
Expected: FAIL (no step components).

- [ ] **Step 3: `EnvironmentStep.tsx`**

```tsx
/** Step 1: always a new environment — its type and name (and, under
 *  Advanced, the git ref deploys use and the base domain). */
import { useEffect, useRef } from 'react';

import { arrowNav } from '../../../lib/arrowNav';
import { NAME_HELP } from '../../../lib/envRules';
import { KINDS, KIND_LABEL, effectiveDomain, type Errors, type FlowContext, type FlowState } from '../flowState';

export interface StepProps {
  state: FlowState; set: (patch: Partial<FlowState>) => void; errors: Errors; ctx: FlowContext;
}

export default function EnvironmentStep({ state, set, errors, ctx }: StepProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  return (
    <div className="sirdar-flow-grid">
      <div className="sirdar-span2">
        <span className="field-label" id="flow-type-label">Type</span>
        <div className="segmented" role="radiogroup" aria-labelledby="flow-type-label">
          {KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={state.type === k} className={state.type === k ? 'on' : ''}
                    tabIndex={state.type === k ? 0 : -1} onKeyDown={arrowNav} onClick={() => set({ type: k })}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <p className="page-hint">
          {state.type === 'production'
            ? 'Production runs on DigitalOcean, as Blue and Green. Only one production is live at a time.'
            : 'Development, UAT and Custom run on any target.'}
        </p>
        {errors.type && <p className="form-error" role="alert">{errors.type}</p>}
      </div>
      <div className="sirdar-span2">
        <label className="field-label" htmlFor="flow-name">Name</label>
        <input id="flow-name" ref={nameRef} type="text" value={state.name} maxLength={64} autoComplete="off" spellCheck={false}
               aria-invalid={!!errors.name} aria-describedby="flow-name-help" onChange={(e) => set({ name: e.target.value })} />
        <p id="flow-name-help" className="page-hint">{NAME_HELP}</p>
        {errors.name && <p className="form-error" role="alert">{errors.name}</p>}
      </div>
      <details className="sirdar-flow-details sirdar-span2">
        <summary>Advanced</summary>
        <div className="sirdar-flow-grid">
          <div>
            <label className="field-label" htmlFor="flow-ref">Git ref</label>
            <input id="flow-ref" type="text" value={state.gitRef} maxLength={200} autoComplete="off" spellCheck={false}
                   aria-invalid={!!errors.gitRef} onChange={(e) => set({ gitRef: e.target.value })} />
            <p className="page-hint">The branch, tag or commit deploys use unless you pick another.</p>
            {errors.gitRef && <p className="form-error" role="alert">{errors.gitRef}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor="flow-domain">Base domain</label>
            <input id="flow-domain" type="text" value={state.baseDomain} maxLength={253} autoComplete="off" spellCheck={false}
                   placeholder={effectiveDomain({ ...state, baseDomain: '' }, ctx)} aria-invalid={!!errors.baseDomain}
                   onChange={(e) => set({ baseDomain: e.target.value })} />
            <p className="page-hint">Leave empty for {effectiveDomain({ ...state, baseDomain: '' }, ctx)}.</p>
            {errors.baseDomain && <p className="form-error" role="alert">{errors.baseDomain}</p>}
          </div>
        </div>
      </details>
    </div>
  );
}
```

(`effectiveDomain` with an empty name yields `<name>.serversherpa.com`, the placeholder the test expects.)

- [ ] **Step 4: `ServersStep.tsx`**

```tsx
/** Step 2: one server, or Blue/Green (two, with Activate moving traffic). */
import { arrowNav } from '../../../lib/arrowNav';
import type { Servers } from '../flowState';

import type { StepProps } from './EnvironmentStep';

const CHOICES: [Servers, string][] = [['single', 'Single server'], ['bluegreen', 'Blue/Green']];

export default function ServersStep({ state, set }: StepProps) {
  const production = state.type === 'production';
  const hint = state.servers === 'single'
    ? 'One server: each deploy updates it in place. SSH targets run a single server.'
    : production ? 'Blue and Green: each deploy goes to the idle one; Activate moves traffic to it.'
      : 'Orange and Purple: each deploy goes to the idle one; Activate (or auto-activate, in Extras) moves traffic to it. '
        + 'On ESXi or Proxmox a third VM holds the data both use.';
  return (
    <div>
      <span className="field-label" id="flow-servers-label">Servers</span>
      <div className="segmented" role="radiogroup" aria-labelledby="flow-servers-label">
        {CHOICES.map(([v, label]) => {
          const locked = production && v === 'single';
          return (
            <button key={v} type="button" role="radio" aria-checked={state.servers === v} aria-disabled={locked}
                    className={state.servers === v ? 'on' : ''} tabIndex={state.servers === v ? 0 : -1} onKeyDown={arrowNav}
                    onClick={() => { if (!locked && v !== state.servers) set({ servers: v }); }}>{label}</button>
          );
        })}
      </div>
      <p className="page-hint">{hint}</p>
      {production && <p className="page-hint">Production always runs Blue and Green.</p>}
    </div>
  );
}
```

- [ ] **Step 5: `TargetStep.tsx`**

```tsx
/** Step 3: where Sirdar builds the environment, and that target's details. */
import { arrowNav } from '../../../lib/arrowNav';
import TargetPanel from '../TargetPanel';
import { CONNECT_TYPE, targetChoices, targetKind } from '../flowState';

import type { StepProps } from './EnvironmentStep';

const IP_MODES: ['static' | 'dhcp', string][] = [['static', 'Static'], ['dhcp', 'DHCP']];

function Text({ id, label, value, onChange, placeholder, mode }: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string;
  mode?: 'numeric' | 'decimal';
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type="text" value={value} placeholder={placeholder} inputMode={mode} autoComplete="off"
             spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export default function TargetStep({ state, set, errors, ctx, onTargetsChanged }: StepProps & { onTargetsChanged: () => void }) {
  const choices = targetChoices(state, ctx);
  const chosen = choices.find((t) => t.id === state.target);
  const kind = targetKind(state.target);
  const bg = state.servers === 'bluegreen';
  const name = state.name.trim() || '<name>';
  const account = ctx.accounts.find((a) => a.key === state.doAccount);
  return (
    <>
      <TargetPanel target={state.target} onTarget={(id) => set({ target: id })} connectType={CONNECT_TYPE[state.type]}
                   connectName={state.name} choosable={(id) => choices.some((t) => t.id === id && t.ready)}
                   onTargetsChanged={onTargetsChanged} doAccount={state.doAccount} />
      {chosen && !chosen.ready && <p className="page-hint sirdar-envnote">{chosen.why}</p>}
      {errors.target && <p className="form-error" role="alert">{errors.target}</p>}

      {kind === 'digitalocean' && (
        <div className="sirdar-flow-grid">
          <div className="sirdar-span2">
            <span className="field-label" id="flow-do-account-label">Account</span>
            <div className="segmented" role="radiogroup" aria-labelledby="flow-do-account-label">
              {ctx.accounts.map((a) => (
                <button key={a.key} type="button" role="radio" aria-checked={state.doAccount === a.key}
                        className={state.doAccount === a.key ? 'on' : ''} tabIndex={state.doAccount === a.key ? 0 : -1}
                        disabled={!a.configured} onKeyDown={arrowNav} onClick={() => set({ doAccount: a.key })}>{a.label}</button>
              ))}
            </div>
            <p className="page-hint">{account?.region ? `Built in ${account.region}. ` : ''}An environment stays in the account it is built in.</p>
            {state.type === 'production' && state.doAccount === 'development' && (
              <p className="page-hint" role="note"><span className="chip c-amber">Warning</span>{' '}
                Production in the Development account shares its renewal token with every development droplet. Set up the
                Production account instead if you can.</p>
            )}
          </div>
          <Text id="flow-do-droplet" label="Droplet size" value={state.dropletSize} onChange={(v) => set({ dropletSize: v.trim() })} />
          <Text id="flow-do-db" label="Database size" value={state.dbSize} onChange={(v) => set({ dbSize: v.trim() })} />
          {errors.cloud && <p className="form-error sirdar-span2" role="alert">{errors.cloud}</p>}
        </div>
      )}

      {(kind === 'esxi' || kind === 'proxmox') && (
        <div className="sirdar-flow-grid">
          <p className="page-hint sirdar-span2">
            {bg ? `Sirdar builds three VMs: ss-${name}-data, ss-${name}-orange and ss-${name}-purple. `
              : kind === 'esxi' ? `Sirdar copies the Ubuntu seed VM's disk into a VM named ss-${name} on ESXi. `
                : `Sirdar clones the Ubuntu template into a VM named ss-${name} on Proxmox. `}
            Sizes can grow later in Settings; the network can't change.
          </p>
          <Text id="flow-vm-cores" label={bg ? 'App VM vCPUs' : 'vCPUs'} value={state.cores} mode="numeric" onChange={(v) => set({ cores: v })} />
          <Text id="flow-vm-memory" label={bg ? 'App VM memory (GB)' : 'Memory (GB)'} value={state.memoryGb} mode="decimal" onChange={(v) => set({ memoryGb: v })} />
          <Text id="flow-vm-disk" label={bg ? 'App VM disk (GB)' : 'Disk (GB)'} value={state.diskGb} mode="numeric" onChange={(v) => set({ diskGb: v })} />
          {!bg && (
            <div className="sirdar-span2">
              <span className="field-label" id="flow-vm-net-label">Network</span>
              <div className="segmented" role="radiogroup" aria-labelledby="flow-vm-net-label">
                {IP_MODES.map(([m, label]) => (
                  <button key={m} type="button" role="radio" aria-checked={state.ipMode === m} className={state.ipMode === m ? 'on' : ''}
                          tabIndex={state.ipMode === m ? 0 : -1} onKeyDown={arrowNav} onClick={() => set({ ipMode: m })}>{label}</button>
                ))}
              </div>
            </div>
          )}
          {(bg || state.ipMode === 'static') && (
            <>
              <Text id="flow-vm-gateway" label="Gateway" value={state.gateway} placeholder="10.10.48.1" onChange={(v) => set({ gateway: v })} />
              <Text id="flow-vm-ip" label={bg ? 'Orange VM address' : 'Address'} value={state.ipCidr} placeholder="10.10.48.70/24"
                    onChange={(v) => set({ ipCidr: v })} />
            </>
          )}
          {bg && (
            <>
              <Text id="flow-vm-purple" label="Purple VM address" value={state.purpleIpCidr} placeholder="10.10.48.71/24"
                    onChange={(v) => set({ purpleIpCidr: v })} />
              <Text id="flow-vm-data" label="Data VM address" value={state.dataIpCidr} placeholder="10.10.48.72/24"
                    onChange={(v) => set({ dataIpCidr: v })} />
              <Text id="flow-vm-data-cores" label="Data VM vCPUs" value={state.dataCores} mode="numeric" onChange={(v) => set({ dataCores: v })} />
              <Text id="flow-vm-data-memory" label="Data VM memory (GB)" value={state.dataMemoryGb} mode="decimal" onChange={(v) => set({ dataMemoryGb: v })} />
              <Text id="flow-vm-data-disk" label="Data VM disk (GB)" value={state.dataDiskGb} mode="numeric" onChange={(v) => set({ dataDiskGb: v })} />
            </>
          )}
          {errors.machine && <p className="form-error sirdar-span2" role="alert">{errors.machine}</p>}
        </div>
      )}

      {(kind === 'esxi' || kind === 'proxmox' || kind === 'ssh') && (
        <div className="sirdar-flow-grid">
          <div>
            <label className="field-label" htmlFor="flow-proxy">Proxy IP</label>
            <input id="flow-proxy" type="text" value={state.proxyIp} maxLength={45} autoComplete="off" spellCheck={false}
                   aria-invalid={!!errors.proxyIp} onChange={(e) => set({ proxyIp: e.target.value })} />
            <p className="page-hint">Nginx Proxy Manager's LAN address. The apps trust forwarded headers from it only.</p>
            {errors.proxyIp && <p className="form-error" role="alert">{errors.proxyIp}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor="flow-bind">Bind IP</label>
            <input id="flow-bind" type="text" value={state.bindIp} maxLength={45} autoComplete="off" spellCheck={false}
                   aria-invalid={!!errors.bindIp} onChange={(e) => set({ bindIp: e.target.value })} />
            <p className="page-hint">The address the server publishes the service ports on.</p>
            {errors.bindIp && <p className="form-error" role="alert">{errors.bindIp}</p>}
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/pages/deploy/steps`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/pages/deploy/steps/EnvironmentStep.tsx sirdar/web/src/pages/deploy/steps/ServersStep.tsx sirdar/web/src/pages/deploy/steps/TargetStep.tsx sirdar/web/src/pages/deploy/steps/EnvironmentStep.test.tsx sirdar/web/src/pages/deploy/steps/ServersStep.test.tsx sirdar/web/src/pages/deploy/steps/TargetStep.test.tsx
git commit -m "feat(sirdar-web): Deploy flow steps 1-3 (Environment, Servers, Target)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Steps 4–6 (Extras, Traffic, Data)

**Files:**
- Create: `sirdar/web/src/pages/deploy/steps/ExtrasStep.tsx`, `TrafficStep.tsx`, `DataStep.tsx`
- Create: `sirdar/web/src/pages/deploy/steps/ExtrasStep.test.tsx`, `TrafficStep.test.tsx`, `DataStep.test.tsx`

**Interfaces:**
- Consumes: Task 3. `StepProps` from `./EnvironmentStep` (Task 5 creates it; if Task 6 runs first, create `steps/stepProps.ts` with the same type and have Task 5 import it from there instead — note it in the ledger).
- Produces:
  - **ExtrasStep** — three sections with `h4.sirdar-sub` titles:
    - *Apps*: "API and Portal always run." + a `Switch` per optional app (`label` = "Wiki", "Kiosk", "Status page", "Mailpit"); error `apps`.
    - *Hosting*: DigitalOcean — Standby node (`Switch`), Certificate (segmented "Let's Encrypt · Let's Encrypt staging", non-production); Blue/Green non-production — Activate automatically (`Switch`); otherwise "Nothing to set for this target."; error `hosting`.
    - *Integrations*: Publish DNS (`Switch`, LAN only — DigitalOcean always publishes; "Set up Cloudflare and Nginx Proxy Manager in Settings › Integrations to publish." when either is missing, and the switch is disabled); Mail (segmented "Mailpit · SMTP"; SMTP: Host, Port, User name, Password (`type="password"`, `autoComplete="new-password"`), From address, STARTTLS `Switch`; the hint "Saved encrypted; never shown again."); Anthropic API key (`type="password"`, hint "For the Makes / Models spec lookup. Saved encrypted; never shown again."); errors `publish`, `mail`, `aiKey`.
  - **TrafficStep** — read-only: DigitalOcean "A DigitalOcean load balancer with a Let's Encrypt certificate sends each name to the live droplet." / LAN "Nginx Proxy Manager gets one proxy host per public app, pointed at the first server." (Blue/Green: "Activate moves every proxy host but spaces to the other app VM."), then a `DataTable` (`ariaLabel="Traffic plan"`, columns Public name · Through · To) of `trafficPlan(state, ctx).rows`; with Publish off on the LAN: "DNS records stay as they are; Sirdar still manages the proxy hosts." on Blue/Green, or "DNS records and proxy hosts are set up by hand." on a single server.
  - **DataStep** — segmented "Start empty · From a snapshot" (snapshot `aria-disabled` without ready snapshots); snapshot: `ComboBox` (`inputId="flow-snapshot"`, `portal`); empty: First name, Last name, Email, then Their password (segmented "Type a password · Generate & invite"): typed → Password + Type it again (`type="password"`, `autoComplete="new-password"`) and the hint "At least N characters (ServerSherpa's password policy). They get an email with a link to change it, valid H hours. The password is never emailed."; invite → "Sirdar sends <email> a link to set their password, valid H hours. No password is ever emailed." (N and H from `ctx.defaults.first_admin`); the first admin is a super admin. Errors `data`, `adminName`, `adminEmail`, `adminPassword`.

- [ ] **Step 1: Write the failing tests**

`ExtrasStep.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { NO_INTEGRATIONS } from '../../environments/testData';
import { flowCtx } from '../flowFixtures';
import { initialState, type FlowContext, type FlowState } from '../flowState';

import ExtrasStep from './ExtrasStep';

afterEach(cleanup);
function renderStep(over: Partial<FlowState> = {}, ctxOver: Partial<FlowContext> = {}, errors = {}) {
  const ctx = flowCtx(ctxOver);
  const set = vi.fn();
  render(<ExtrasStep state={{ ...initialState(ctx), name: 'qa', target: 'ssh:lab', ...over }} set={set} errors={errors} ctx={ctx} />);
  return set;
}

it('apps: API and Portal always, four switches', async () => {
  const set = renderStep();
  expect(screen.getByText('API and Portal always run.')).toBeTruthy();
  await userEvent.click(screen.getByLabelText('Wiki'));
  expect(set).toHaveBeenCalledWith({ apps: { wiki: false, kiosk: true, status: true, mailpit: true } });
});

it('Publish DNS: on with both integrations, off is sent', async () => {
  const set = renderStep();
  expect((screen.getByLabelText('Publish DNS') as HTMLInputElement).checked).toBe(true);
  await userEvent.click(screen.getByLabelText('Publish DNS'));
  expect(set).toHaveBeenCalledWith({ publish: false });
});

it('without both integrations Publish is off and says where to set them up', () => {
  renderStep({ publish: false }, { integrations: NO_INTEGRATIONS });
  expect((screen.getByLabelText('Publish DNS') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/Set up Cloudflare and Nginx Proxy Manager in Settings › Integrations to publish/)).toBeTruthy();
});

it('SMTP fields appear for SMTP, the password write-only', async () => {
  const set = renderStep({ mailMode: 'smtp' });
  for (const label of ['SMTP host', 'SMTP port', 'User name', 'SMTP password', 'From address']) expect(screen.getByLabelText(label)).toBeTruthy();
  expect((screen.getByLabelText('SMTP password') as HTMLInputElement).type).toBe('password');
  await userEvent.click(screen.getByRole('radio', { name: 'Mailpit' }));
  expect(set).toHaveBeenCalledWith({ mailMode: 'mailpit' });
});

it('DigitalOcean hosting: standby and the staging certificate; production has no staging', () => {
  renderStep({ target: 'digitalocean' });
  expect(screen.getByLabelText('Standby node')).toBeTruthy();
  expect(screen.getByRole('radio', { name: "Let's Encrypt staging" })).toBeTruthy();
  cleanup();
  renderStep({ target: 'digitalocean', type: 'production', servers: 'bluegreen' });
  expect(screen.queryByRole('radio', { name: "Let's Encrypt staging" })).toBeNull();
  expect(screen.queryByLabelText('Activate automatically')).toBeNull();
});

it('Blue/Green offers auto-activate', () => {
  renderStep({ target: 'esxi', servers: 'bluegreen' });
  expect(screen.getByLabelText('Activate automatically')).toBeTruthy();
});

it('shows the errors', () => {
  renderStep({}, {}, { apps: 'Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP.' });
  expect(screen.getByText(/turn Mailpit on, or choose SMTP/)).toBeTruthy();
});
```

`TrafficStep.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { flowCtx } from '../flowFixtures';
import { initialState, type FlowState } from '../flowState';

import TrafficStep from './TrafficStep';

afterEach(cleanup);
const ctx = flowCtx();
const show = (over: Partial<FlowState>) =>
  render(<TrafficStep state={{ ...initialState(ctx), name: 'qa', ...over }} set={vi.fn()} errors={{}} ctx={ctx} />);

it('lists each public name and where it points first', () => {
  show({ target: 'esxi', ipCidr: '10.10.48.70/24', gateway: '10.10.48.1' });
  const table = screen.getByRole('table', { name: 'Traffic plan' });
  expect(within(table).getByText('portal.qa.serversherpa.com')).toBeTruthy();
  expect(within(table).getAllByText('10.10.48.70:8091').length).toBe(1);
  expect(screen.getByText(/one proxy host per public app/)).toBeTruthy();
});

it('DigitalOcean shows the load balancer', () => {
  show({ target: 'digitalocean' });
  expect(screen.getByText(/A DigitalOcean load balancer/)).toBeTruthy();
});

it('a single server with Publish off is set up by hand', () => {
  show({ target: 'ssh:lab', publish: false });
  expect(screen.getByText(/DNS records and proxy hosts are set up by hand/)).toBeTruthy();
});

it('has no inputs', () => {
  show({ target: 'ssh:lab' });
  expect(screen.queryByRole('textbox')).toBeNull();
});
```

`DataStep.test.tsx` (mock nothing; `Element.prototype.scrollIntoView = () => {}`):

```tsx
it('starts empty with a typed password and the policy hint', () => {
  renderStep();
  expect(screen.getByRole('radio', { name: 'Start empty' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText(/At least 8 characters \(ServerSherpa's password policy\)/)).toBeTruthy();
  expect(screen.getByText(/valid 4 hours/)).toBeTruthy();
  expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('password');
});

it('Generate & invite has no password fields', async () => {
  const set = renderStep({ adminEmail: 'ada@test.example.com', adminPasswordMode: 'invite' });
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(screen.getByText(/Sirdar sends ada@test.example.com a link to set their password, valid 4 hours/)).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: 'Type a password' }));
  expect(set).toHaveBeenCalledWith({ adminPasswordMode: 'typed' });
});

it('a snapshot replaces the first admin', async () => {
  const set = renderStep({ dataMode: 'snapshot' });
  expect(screen.queryByLabelText('First name')).toBeNull();
  await userEvent.click(screen.getByLabelText('Snapshot'));
  await userEvent.click(await screen.findByText(/uat-2026/));
  expect(set).toHaveBeenCalledWith({ snapshotId: SNAP.id });
});

it('without snapshots only Start empty is offered', () => {
  renderStep({}, { snapshots: [] });
  expect(screen.getByRole('radio', { name: 'From a snapshot' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText(/No snapshot yet/)).toBeTruthy();
});

it('shows the errors under their fields', () => {
  renderStep({}, {}, { adminPassword: "The two passwords don't match.", adminEmail: 'Enter a valid email address for the first admin.' });
  expect(screen.getByText("The two passwords don't match.")).toBeTruthy();
  expect(screen.getByText('Enter a valid email address for the first admin.')).toBeTruthy();
});
```

with `renderStep(over, ctxOver, errors)` built like ExtrasStep's (returning `set`); `SNAP` from `../../environments/testData` (its name starts `uat-2026`; if not, click the label `snapshotLabel(SNAP)` gives).

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/deploy/steps/ExtrasStep.test.tsx src/pages/deploy/steps/TrafficStep.test.tsx src/pages/deploy/steps/DataStep.test.tsx`
Expected: FAIL.

- [ ] **Step 3: `ExtrasStep.tsx`**

```tsx
/** Step 4: optional apps, hosting options and integrations. */
import { Switch } from '@portal/components/Switch';

import { arrowNav } from '../../../lib/arrowNav';
import { OPTIONAL_APPS, targetKind } from '../flowState';

import type { StepProps } from './EnvironmentStep';

function Toggle({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="sirdar-toggle-row">
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

function Field({ id, label, value, onChange, type = 'text', hint }: {
  id: string; label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} autoComplete={type === 'password' ? 'new-password' : 'off'}
             spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="page-hint">{hint}</p>}
    </div>
  );
}

export default function ExtrasStep({ state, set, errors, ctx }: StepProps) {
  const kind = targetKind(state.target);
  const onDoTarget = kind === 'digitalocean';
  const production = state.type === 'production';
  const bg = state.servers === 'bluegreen';
  const canPublish = !!(ctx.integrations?.cloudflare.configured && ctx.integrations?.npm.configured);
  return (
    <>
      <h4 className="sirdar-sub">Apps</h4>
      <p className="page-hint">API and Portal always run.</p>
      <div className="sirdar-flow-grid">
        {OPTIONAL_APPS.map(([app, label]) => (
          <Toggle key={app} label={label} checked={state.apps[app]}
                  onChange={(v) => set({ apps: { ...state.apps, [app]: v } })} />
        ))}
      </div>
      {errors.apps && <p className="form-error" role="alert">{errors.apps}</p>}

      <h4 className="sirdar-sub">Hosting</h4>
      {onDoTarget ? (
        <div className="sirdar-flow-grid">
          <Toggle label="Standby node" checked={state.dbStandby} onChange={(v) => set({ dbStandby: v })} />
          {!production && (
            <div>
              <span className="field-label" id="flow-cert-label">Certificate</span>
              <div className="segmented" role="radiogroup" aria-labelledby="flow-cert-label">
                {([[false, "Let's Encrypt"], [true, "Let's Encrypt staging"]] as [boolean, string][]).map(([v, label]) => (
                  <button key={label} type="button" role="radio" aria-checked={state.acmeStaging === v}
                          className={state.acmeStaging === v ? 'on' : ''} tabIndex={state.acmeStaging === v ? 0 : -1}
                          onKeyDown={arrowNav} onClick={() => set({ acmeStaging: v })}>{label}</button>
                ))}
              </div>
              <p className="page-hint">Staging certificates aren't trusted by browsers: for test environments.</p>
            </div>
          )}
        </div>
      ) : null}
      {bg && !production && (
        <>
          <Toggle label="Activate automatically" checked={state.autoActivate} onChange={(v) => set({ autoActivate: v })} />
          <p className="page-hint">On: a deploy whose smoke test passes takes traffic by itself.</p>
        </>
      )}
      {!onDoTarget && !(bg && !production) && <p className="page-hint">Nothing to set for this target.</p>}
      {errors.hosting && <p className="form-error" role="alert">{errors.hosting}</p>}

      <h4 className="sirdar-sub">Integrations</h4>
      {!onDoTarget && (
        <>
          <Toggle label="Publish DNS" checked={state.publish && canPublish} disabled={!canPublish}
                  onChange={(v) => set({ publish: v })} />
          <p className="page-hint">
            {canPublish
              ? bg ? 'On: each deploy keeps a Cloudflare record for every public name. Sirdar manages the proxy hosts either way.'
                : 'On: each deploy keeps a Cloudflare record and a proxy host for every public name.'
              : 'Set up Cloudflare and Nginx Proxy Manager in Settings › Integrations to publish.'}
          </p>
          {errors.publish && <p className="form-error" role="alert">{errors.publish}</p>}
        </>
      )}
      {onDoTarget && <p className="page-hint">DigitalOcean environments always publish their DNS records.</p>}
      <span className="field-label" id="flow-mail-label">Mail</span>
      <div className="segmented" role="radiogroup" aria-labelledby="flow-mail-label">
        {([['mailpit', 'Mailpit'], ['smtp', 'SMTP']] as const).map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={state.mailMode === m} className={state.mailMode === m ? 'on' : ''}
                  tabIndex={state.mailMode === m ? 0 : -1} onKeyDown={arrowNav} onClick={() => set({ mailMode: m })}>{label}</button>
        ))}
      </div>
      <p className="page-hint">
        {state.mailMode === 'mailpit' ? "Mailpit catches every email on the server; nothing is sent. Good for testing."
          : 'Mail goes out through your SMTP server.'}
      </p>
      {state.mailMode === 'smtp' && (
        <div className="sirdar-flow-grid">
          <Field id="flow-smtp-host" label="SMTP host" value={state.smtpHost} onChange={(v) => set({ smtpHost: v })} />
          <Field id="flow-smtp-port" label="SMTP port" value={state.smtpPort} onChange={(v) => set({ smtpPort: v })} />
          <Field id="flow-smtp-user" label="User name" value={state.smtpUsername} onChange={(v) => set({ smtpUsername: v })} />
          <Field id="flow-smtp-password" label="SMTP password" type="password" value={state.smtpPassword}
                 onChange={(v) => set({ smtpPassword: v })} hint="Saved encrypted; never shown again." />
          <Field id="flow-smtp-from" label="From address" value={state.smtpFrom} onChange={(v) => set({ smtpFrom: v })} />
          <Toggle label="STARTTLS" checked={state.smtpStarttls} onChange={(v) => set({ smtpStarttls: v })} />
        </div>
      )}
      {errors.mail && <p className="form-error" role="alert">{errors.mail}</p>}
      <Field id="flow-ai-key" label="Anthropic API key" type="password" value={state.aiKey} onChange={(v) => set({ aiKey: v })}
             hint="For the Makes / Models spec lookup. Optional. Saved encrypted; never shown again." />
      {errors.aiKey && <p className="form-error" role="alert">{errors.aiKey}</p>}
    </>
  );
}
```

(`.sirdar-toggle-row` comes with Task 3's styles.)

- [ ] **Step 4: `TrafficStep.tsx`**

```tsx
/** Step 5: what will route traffic, read-only. */
import DataTable from '@portal/components/DataTable';

import { targetKind, trafficPlan } from '../flowState';

import type { StepProps } from './EnvironmentStep';

export default function TrafficStep({ state, ctx }: StepProps) {
  const plan = trafficPlan(state, ctx);
  const bg = state.servers === 'bluegreen';
  const lan = targetKind(state.target) !== 'digitalocean';
  return (
    <>
      <p className="page-hint">
        {plan.kind === 'load_balancer'
          ? "A DigitalOcean load balancer with a Let's Encrypt certificate sends each name to the live droplet; Sirdar builds it on the first deploy."
          : `Nginx Proxy Manager gets one proxy host per public app, pointed at the first server.${bg
            ? ' Activate moves every proxy host but spaces to the other app VM.' : ''}`}
      </p>
      {lan && !state.publish && (
        <p className="page-hint">
          {bg ? 'DNS records stay as they are; Sirdar still manages the proxy hosts.'
            : 'DNS records and proxy hosts are set up by hand.'}
        </p>
      )}
      <DataTable
        ariaLabel="Traffic plan"
        columns={[{ key: 'host', label: 'Public name', mono: true }, { key: 'via', label: 'Through' },
                  { key: 'to', label: 'To', mono: true }]}
        rows={plan.rows.map((r) => ({ key: r.hostname, cells: [r.hostname, r.via, r.to] }))}
      />
    </>
  );
}
```

- [ ] **Step 5: `DataStep.tsx`**

```tsx
/** Step 6: seed from a snapshot, or start empty with a first super admin. */
import ComboBox from '@portal/components/ComboBox';

import { arrowNav } from '../../../lib/arrowNav';
import { snapshotLabel } from '../../environments/labels';

import type { StepProps } from './EnvironmentStep';

const hours = (minutes: number) => (minutes % 60 === 0
  ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`);

export default function DataStep({ state, set, errors, ctx }: StepProps) {
  const fa = ctx.defaults.first_admin;
  const none = ctx.snapshots.length === 0;
  const input = (id: string, label: string, value: string, key: 'adminFirst' | 'adminLast' | 'adminEmail' | 'adminPassword' | 'adminConfirm',
                 type = 'text') => (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} autoComplete={type === 'password' ? 'new-password' : 'off'} spellCheck={false}
             onChange={(e) => set({ [key]: e.target.value } as Partial<typeof state>)} />
    </div>
  );
  return (
    <div className="sirdar-flow-grid">
      <div className="sirdar-span2">
        <span className="field-label" id="flow-data-label">Data</span>
        <div className="segmented" role="radiogroup" aria-labelledby="flow-data-label">
          {([['empty', 'Start empty'], ['snapshot', 'From a snapshot']] as const).map(([m, label]) => {
            const locked = m === 'snapshot' && none;
            return (
              <button key={m} type="button" role="radio" aria-checked={state.dataMode === m} aria-disabled={locked}
                      className={state.dataMode === m ? 'on' : ''} tabIndex={state.dataMode === m ? 0 : -1} onKeyDown={arrowNav}
                      onClick={() => { if (!locked) set({ dataMode: m }); }}>{label}</button>
            );
          })}
        </div>
        {none && <p className="page-hint">No snapshot yet. Upload one or take one in Snapshots below.</p>}
      </div>
      {state.dataMode === 'snapshot' ? (
        <div className="sirdar-span2">
          <label className="field-label" htmlFor="flow-snapshot">Snapshot</label>
          <ComboBox inputId="flow-snapshot" ariaLabel="Snapshot" portal value={state.snapshotId} placeholder="Choose a snapshot…"
                    options={ctx.snapshots.map((s) => ({ value: s.id, label: snapshotLabel(s) }))}
                    onChange={(v) => set({ snapshotId: v })} />
          <p className="page-hint">The first deploy restores its database and files. Its users sign in with their own passwords and 2FA.</p>
          {errors.data && <p className="form-error" role="alert">{errors.data}</p>}
        </div>
      ) : (
        <>
          <p className="page-hint sirdar-span2">The first deploy creates this person as the environment's first super admin.</p>
          {input('flow-admin-first', 'First name', state.adminFirst, 'adminFirst')}
          {input('flow-admin-last', 'Last name', state.adminLast, 'adminLast')}
          {errors.adminName && <p className="form-error sirdar-span2" role="alert">{errors.adminName}</p>}
          <div className="sirdar-span2">
            {input('flow-admin-email', 'Email', state.adminEmail, 'adminEmail')}
            {errors.adminEmail && <p className="form-error" role="alert">{errors.adminEmail}</p>}
          </div>
          <div className="sirdar-span2">
            <span className="field-label" id="flow-admin-pw-label">Their password</span>
            <div className="segmented" role="radiogroup" aria-labelledby="flow-admin-pw-label">
              {([['typed', 'Type a password'], ['invite', 'Generate & invite']] as const).map(([m, label]) => (
                <button key={m} type="button" role="radio" aria-checked={state.adminPasswordMode === m}
                        className={state.adminPasswordMode === m ? 'on' : ''} tabIndex={state.adminPasswordMode === m ? 0 : -1}
                        onKeyDown={arrowNav} onClick={() => set({ adminPasswordMode: m })}>{label}</button>
              ))}
            </div>
          </div>
          {state.adminPasswordMode === 'typed' ? (
            <>
              {input('flow-admin-password', 'Password', state.adminPassword, 'adminPassword', 'password')}
              {input('flow-admin-confirm', 'Type it again', state.adminConfirm, 'adminConfirm', 'password')}
              <p className="page-hint sirdar-span2">
                At least {fa.password_min_length} characters (ServerSherpa's password policy). They get an email with a link to
                change it, valid {hours(fa.link_minutes)}. The password is never emailed.
              </p>
            </>
          ) : (
            <p className="page-hint sirdar-span2">
              Sirdar sends {state.adminEmail.trim() || 'them'} a link to set their password, valid {hours(fa.link_minutes)}.
              No password is ever emailed.
            </p>
          )}
          {errors.adminPassword && <p className="form-error sirdar-span2" role="alert">{errors.adminPassword}</p>}
        </>
      )}
    </div>
  );
}
```

(The segmented group is captioned "Their password" and the typed input is labeled "Password", so `getByLabelText('Password')` finds only the input.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/pages/deploy/steps`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/pages/deploy/steps/ExtrasStep.tsx sirdar/web/src/pages/deploy/steps/TrafficStep.tsx sirdar/web/src/pages/deploy/steps/DataStep.tsx sirdar/web/src/pages/deploy/steps/ExtrasStep.test.tsx sirdar/web/src/pages/deploy/steps/TrafficStep.test.tsx sirdar/web/src/pages/deploy/steps/DataStep.test.tsx
git commit -m "feat(sirdar-web): Deploy flow steps 4-6 (Extras, Traffic, Data)

Apps, hosting and integrations; the read-only traffic plan; a snapshot or
a first super admin with ServerSherpa's password bar as the hint.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Review & Deploy, the flow, and the page

**Files:**
- Create: `sirdar/web/src/pages/deploy/steps/ReviewStep.tsx` (+ `ReviewStep.test.tsx`)
- Create: `sirdar/web/src/pages/deploy/DeployFlow.tsx` (+ `DeployFlow.test.tsx`)
- Modify: `sirdar/web/src/pages/Deploy.tsx`, `sirdar/web/src/pages/Deploy.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–6; `createEnvironment`, `startDeployment`, `getEnvironmentDefaults`, `getIntegrations`, `getDoAccounts`, `listSnapshots`, `getDeployTargets`, `deployErrorText`, `useHostKeyTrust`.
- Produces:
  - `ReviewStep(StepProps & { busy, problem, created })` — a `.sirdar-kv` of every choice (no secret ever shown: the SMTP password, the key and the typed password read "Set (hidden)"), plus the services the first deploy publishes.
  - `DeployFlow({ targets, reloadTargets })`: loads the defaults, integrations, accounts and ready snapshots; "Loading…" until they answer; the header (`.eyebrow` "Deploy", `h3` = the current step's label, `.page-hint` = `STEP_HINT[step]`) and `.rgm-steps`; the current step; Back / Next / Deploy (Deploy only on Review; Next runs `stepErrors` and stays with the errors shown; Back keeps every choice); **Start over** (resets to `initialState`, confirm first). Deploy: `createEnvironment(buildBody(...))` → `startDeployment(name, { mode: 'update' })` → `navigate(/deploy/environments/<name>?deployment=<id>)`. A create error goes to `stepOfCode(code)` with its message under the field (`errors[CODE_FIELD[code] ?? 'form']`), and an Environment-step error focuses the name; a gone snapshot is dropped from the list. If the create succeeded but the start failed: a host-key prompt (`useHostKeyTrust`, "Trust and deploy") retries the start only; any other error shows "Created <name>, but its first deployment didn't start: <message>" with a link to the environment, and a second Deploy click only retries the start (never creates twice).
  - `Deploy.tsx`: the header ("Create an environment and deploy it, step by step. Your environments and snapshots are below."), `<DeployFlow>` (only with deploy:add; otherwise the hint "You can view deployments but not create them. Ask a super admin for access."), then `EnvironmentsSection` and `SnapshotsSection`.

- [ ] **Step 1: Write the failing tests**

`DeployFlow.test.tsx` (mocks: `getDeployTargets` → `{ targets: FLOW_TARGETS, types: [] }`, `getEnvironmentDefaults` → `FLOW_DEFAULTS`, `getIntegrations` → `FLOW_INTEGRATIONS`, `getDoAccounts` → `{ accounts: DO_ACCOUNTS_BOTH }`, `listSnapshots` → `{ snapshots: [SNAP] }`, `listKnownHosts` → `[]`, `createEnvironment`, `startDeployment`, `trustKnownHost`; `useNavigate` from a `MemoryRouter` with a `Routes` that renders the pathname + search at `/deploy/environments/:name`; `Element.prototype.scrollIntoView = () => {}`):

```tsx
async function open() {
  render(<MemoryRouter initialEntries={['/deploy']}>
    <Routes>
      <Route path="/deploy" element={<DeployFlow targets={FLOW_TARGETS} reloadTargets={vi.fn()} />} />
      <Route path="/deploy/environments/:name" element={<Where />} />
    </Routes>
  </MemoryRouter>);
  await screen.findByLabelText('Name');
}
function Where() { const l = useLocation(); return <p>at {l.pathname}{l.search}</p>; }
const next = () => userEvent.click(screen.getByRole('button', { name: 'Next' }));

async function sshToReview() {
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  await next();                                              // Servers
  await next();                                              // Target
  await userEvent.click(screen.getByRole('radio', { name: /Lab box/ }));
  await next();                                              // Extras
  await next();                                              // Traffic
  await next();                                              // Data
  await userEvent.type(screen.getByLabelText('First name'), 'Ada');
  await userEvent.type(screen.getByLabelText('Last name'), 'Lovelace');
  await userEvent.type(screen.getByLabelText('Email'), 'ada@test.example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'Correct-Horse-9');
  await userEvent.type(screen.getByLabelText('Type it again'), 'Correct-Horse-9');
  await next();                                              // Review
}

it('shows Loading until the defaults, targets and integrations answer', async () => {
  api.getEnvironmentDefaults.mockReturnValue(new Promise(() => {}));
  render(<MemoryRouter><DeployFlow targets={FLOW_TARGETS} reloadTargets={vi.fn()} /></MemoryRouter>);
  expect(screen.getByText('Loading…')).toBeTruthy();
});

it('has the report-generate header and the seven steps', async () => {
  await open();
  expect(screen.getByText('Deploy', { selector: '.eyebrow' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Environment' })).toBeTruthy();
  for (const label of ['Environment', 'Servers', 'Target', 'Extras', 'Traffic', 'Data', 'Review & Deploy'])
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  expect(document.querySelector('.rgm-steps .rgm-step.on .rgm-step-label')?.textContent).toBe('Environment');
});

it('checks each step before Next and keeps choices on Back', async () => {
  await open();
  await next();
  expect(screen.getByText('Enter a name.')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('qa');
});

it('creates and deploys an SSH environment end to end', async () => {
  api.createEnvironment.mockResolvedValue({ ...ENV, name: 'qa' });
  api.startDeployment.mockResolvedValue({ ...RUNNING, id: 'dep-1', environment: 'qa' });
  await open();
  await sshToReview();
  expect(screen.getByRole('heading', { name: 'Review & Deploy' })).toBeTruthy();
  expect(screen.queryByText('Correct-Horse-9')).toBeNull();               // never shown
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText('at /deploy/environments/qa?deployment=dep-1');
  expect(api.createEnvironment).toHaveBeenCalledWith(expect.objectContaining({
    name: 'qa', type: 'custom', target: 'ssh:lab', proxy_ip: '10.10.48.6',
    first_admin: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.example.com', password_mode: 'typed',
                   password: 'Correct-Horse-9' } }));
  expect(api.startDeployment).toHaveBeenCalledWith('qa', { mode: 'update' });
});

it('an API error goes back to its step', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(422, 'proxy_ip_invalid', { code: 'proxy_ip_invalid' }));
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  expect(await screen.findByRole('heading', { name: 'Target' })).toBeTruthy();
  expect(screen.getByText('The proxy IP must be an IPv4 address.')).toBeTruthy();
});

it('an Environment-step error focuses the name', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'environment_exists', { code: 'environment_exists' }));
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText('An environment with that name already exists.');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
});

it('an unknown host key on the first deployment is trusted, then the deploy is retried', async () => {
  api.createEnvironment.mockResolvedValue({ ...ENV, name: 'qa' });
  api.startDeployment
    .mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', { code: 'host_key_unknown', host: '10.10.48.70', port: 22,
                                                                   key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' }))
    .mockResolvedValueOnce({ ...RUNNING, id: 'dep-2', environment: 'qa' });
  api.trustKnownHost.mockResolvedValue({});
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and deploy' }));
  await screen.findByText('at /deploy/environments/qa?deployment=dep-2');
  expect(api.createEnvironment).toHaveBeenCalledTimes(1);                   // created once
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.70', 22, 'SHA256:abc', 'ssh:lab');
});

it('a start that fails after the create says so, and Deploy only retries the start', async () => {
  api.createEnvironment.mockResolvedValue({ ...ENV, name: 'qa' });
  api.startDeployment.mockRejectedValueOnce(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }))
    .mockResolvedValueOnce({ ...RUNNING, id: 'dep-3', environment: 'qa' });
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  expect(await screen.findByText(/Created qa, but its first deployment didn't start/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText('at /deploy/environments/qa?deployment=dep-3');
  expect(api.createEnvironment).toHaveBeenCalledTimes(1);
});

it('a gone snapshot sends you back to Data and is no longer offered', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'snapshot_not_ready', { code: 'snapshot_not_ready' }));
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next(); await next();
  await userEvent.click(screen.getByRole('radio', { name: /Lab box/ }));
  await next(); await next(); await next();
  await userEvent.click(screen.getByRole('radio', { name: 'From a snapshot' }));
  await userEvent.click(screen.getByLabelText('Snapshot'));
  await userEvent.click(await screen.findByText(snapshotLabel(SNAP)));
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  expect(await screen.findByRole('heading', { name: 'Data' })).toBeTruthy();
  expect(screen.getByRole('radio', { name: 'From a snapshot' }).getAttribute('aria-disabled')).toBe('true');
});
```

`ReviewStep.test.tsx`:

```tsx
it('lists every choice and never a secret', () => {
  const ctx = flowCtx();
  const state = { ...initialState(ctx), name: 'qa', type: 'custom' as const, target: 'ssh:lab', adminFirst: 'Ada',
                  adminLast: 'Lovelace', adminEmail: 'ada@test.example.com', adminPassword: 'Correct-Horse-9',
                  mailMode: 'smtp' as const, smtpHost: 'smtp.example.com', smtpPassword: 'Mail-Secret-1', aiKey: 'sk-ant-1' };
  render(<ReviewStep state={state} set={vi.fn()} errors={{}} ctx={ctx} busy={false} problem="" created={null} />);
  for (const text of ['qa', 'Custom', 'Lab box', 'Single server', 'smtp.example.com', 'Ada Lovelace · ada@test.example.com'])
    expect(screen.getAllByText(text, { exact: false }).length).toBeGreaterThan(0);
  for (const secret of ['Correct-Horse-9', 'Mail-Secret-1', 'sk-ant-1']) expect(document.body.textContent).not.toContain(secret);
  expect(screen.getAllByText('Set (hidden)').length).toBe(3);
});
```

`pages/Deploy.test.tsx` becomes (the target/connect tests now live in `TargetPanel.test.tsx`):

```tsx
it('puts the flow first, then the Environments and Snapshots lists', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'Environment' });
  const order = ['Environment', 'Environments', 'Snapshots'].map((n) => screen.getByRole('heading', { name: n }));
  expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('without deploy:add there is no flow, only the lists and a note', async () => {
  perms.add = false;
  renderPage();
  expect(await screen.findByText(/You can view deployments but not create them/)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Environment' })).toBeNull();
});
```

(keep its mocks; add `getEnvironmentDefaults`, `getIntegrations` to them; `renderPage` renders `<MemoryRouter><Deploy /></MemoryRouter>`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/deploy src/pages/Deploy.test.tsx`
Expected: FAIL.

- [ ] **Step 3: `ReviewStep.tsx`**

```tsx
/** Step 7: every choice, then one Deploy (the flow owns the button). */
import { Link } from 'react-router-dom';

import { KIND_LABEL, OPTIONAL_APPS, effectiveDomain, targetChoices, targetKind } from '../flowState';

import type { StepProps } from './EnvironmentStep';

const HIDDEN = 'Set (hidden)';

export default function ReviewStep({ state, ctx, problem, created }: StepProps & {
  busy: boolean; problem: string; created: string | null;
}) {
  const kind = targetKind(state.target);
  const target = targetChoices(state, ctx).find((t) => t.id === state.target)?.label ?? state.target;
  const apps = ['API', 'Portal', ...OPTIONAL_APPS.filter(([a]) => state.apps[a]).map(([, l]) => l)].join(', ');
  const bg = state.servers === 'bluegreen';
  const servers = bg ? (state.type === 'production' ? 'Blue/Green (blue and green)' : 'Blue/Green (orange and purple)') : 'Single server';
  const snapshot = ctx.snapshots.find((s) => s.id === state.snapshotId);
  return (
    <>
      <dl className="sirdar-kv">
        <dt>Name</dt><dd className="mono">{state.name.trim()}</dd>
        <dt>Type</dt><dd>{KIND_LABEL[state.type]}</dd>
        <dt>Servers</dt><dd>{servers}</dd>
        <dt>Target</dt><dd>{target}</dd>
        {kind === 'digitalocean' ? (
          <><dt>Sizes</dt><dd className="mono">{`${state.dropletSize} · ${state.dbSize}${state.dbStandby ? ' · standby node' : ''}`}</dd></>
        ) : (
          <><dt>Proxy IP · Bind IP</dt><dd className="mono">{`${state.proxyIp} · ${state.bindIp}`}</dd></>
        )}
        {(kind === 'esxi' || kind === 'proxmox') && (
          <><dt>Addresses</dt><dd className="mono">{bg ? `orange ${state.ipCidr} · purple ${state.purpleIpCidr} · data ${state.dataIpCidr}`
            : state.ipMode === 'dhcp' ? 'DHCP' : `${state.ipCidr} via ${state.gateway}`}</dd></>
        )}
        <dt>Git ref</dt><dd className="mono">{state.gitRef.trim()}</dd>
        <dt>Base domain</dt><dd className="mono">{effectiveDomain(state, ctx)}</dd>
        <dt>Apps</dt><dd>{apps}</dd>
        {bg && state.type !== 'production' && <><dt>Activates</dt><dd>{state.autoActivate ? 'Automatically' : 'With Activate'}</dd></>}
        {kind === 'digitalocean' && state.type !== 'production' && (
          <><dt>Certificate</dt><dd>{state.acmeStaging ? "Let's Encrypt staging" : "Let's Encrypt"}</dd></>
        )}
        <dt>DNS</dt><dd>{kind === 'digitalocean' || state.publish ? 'Published by Sirdar' : 'Set up by hand'}</dd>
        <dt>Mail</dt><dd>{state.mailMode === 'smtp' ? `SMTP ${state.smtpHost}:${state.smtpPort}` : 'Mailpit'}</dd>
        {state.mailMode === 'smtp' && state.smtpPassword && <><dt>SMTP password</dt><dd>{HIDDEN}</dd></>}
        {state.aiKey && <><dt>Anthropic API key</dt><dd>{HIDDEN}</dd></>}
        <dt>Data</dt>
        <dd>{state.dataMode === 'snapshot' ? `Snapshot ${snapshot?.name ?? ''}, restored by the first deploy` : 'Empty'}</dd>
        {state.dataMode === 'empty' && (
          <>
            <dt>First super admin</dt>
            <dd>{`${state.adminFirst.trim()} ${state.adminLast.trim()} · ${state.adminEmail.trim()}`}</dd>
            <dt>Their password</dt>
            <dd>{state.adminPasswordMode === 'invite' ? 'Generated: they get a set-password link' : HIDDEN}</dd>
          </>
        )}
        <dt>Secrets</dt><dd>Generated by Sirdar and never shown</dd>
      </dl>
      <p className="page-hint">Deploy creates the environment and starts its first deployment, then opens it.</p>
      {created && problem && (
        <p className="form-error" role="alert">
          Created {created}, but its first deployment didn't start: {problem}{' '}
          <Link to={`/deploy/environments/${encodeURIComponent(created)}`}>Open the environment</Link>
        </p>
      )}
      {!created && problem && <p className="form-error" role="alert">{problem}</p>}
    </>
  );
}
```

- [ ] **Step 4: `DeployFlow.tsx`**

```tsx
/** The Deploy page's step-by-step flow (spec 2026-10-07 §1): Environment,
 *  Servers, Target, Extras, Traffic, Data, Review & Deploy. A page section
 *  with the report-generate header; Deploy creates the environment, starts
 *  its first deployment and opens it. */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import {
  createEnvironment, deployErrorText, getDoAccounts, getEnvironmentDefaults, getIntegrations, listSnapshots, startDeployment,
  type DeployTarget,
} from '../../lib/sirdarApi';

import {
  CODE_FIELD, FLOW_STEPS, STEP_HINT, buildBody, initialState, nextStep, prevStep, stepErrors, stepOfCode, withRules,
  type Errors, type FlowContext, type FlowState, type FlowStep,
} from './flowState';
import DataStep from './steps/DataStep';
import EnvironmentStep from './steps/EnvironmentStep';
import ExtrasStep from './steps/ExtrasStep';
import ReviewStep from './steps/ReviewStep';
import ServersStep from './steps/ServersStep';
import TargetStep from './steps/TargetStep';
import TrafficStep from './steps/TrafficStep';

export default function DeployFlow({ targets, reloadTargets }: { targets: DeployTarget[]; reloadTargets: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [base, setBase] = useState<Omit<FlowContext, 'targets'> | null>(null);
  const [loadError, setLoadError] = useState('');
  const [state, setState] = useState<FlowState | null>(null);
  const [step, setStep] = useState<FlowStep>('environment');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const busyRef = useRef(false);
  const focusName = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    const snaps = listSnapshots().then((r) => r.snapshots.filter((s) => s.status === 'ready')).catch(() => []);
    Promise.all([getEnvironmentDefaults(), getIntegrations().catch(() => null),
                 getDoAccounts().then((r) => r.accounts).catch(() => []), snaps])
      .then(([defaults, integrations, accounts, snapshots]) => {
        if (live) setBase({ defaults: defaults as FlowContext['defaults'], integrations, accounts, snapshots });
      })
      .catch((e) => { if (live) setLoadError(deployErrorText(e, "Couldn't load the defaults.")); });
    return () => { live = false; };
  }, []);
  const ctx: FlowContext | null = base ? { ...base, targets } : null;
  useEffect(() => { if (ctx && !state) setState(initialState(ctx)); }, [ctx, state]);

  const set = useCallback((patch: Partial<FlowState>) => {
    setState((s) => (s && ctx ? withRules({ ...s, ...patch }, ctx) : s));
    setErrors({});
  }, [ctx]);

  const start = async (name: string) => {
    const dep = await startDeployment(name, { mode: 'update' });
    navigate(`/deploy/environments/${encodeURIComponent(name)}?deployment=${encodeURIComponent(dep.id)}`);
  };
  const hostKey = useHostKeyTrust<string>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and deploy',
    onTrusted: (name) => { void deploy(name); }, onProblem: (m) => setProblem(m),
  });
  useLayoutEffect(() => { sectionRef.current?.toggleAttribute('inert', hostKey.open); }, [hostKey.open]);

  const deploy = async (alreadyCreated?: string) => {
    if (!state || !ctx || busyRef.current) return;
    busyRef.current = true; setBusy(true); setProblem('');
    let name = alreadyCreated ?? created;
    try {
      if (!name) {
        try {
          name = (await createEnvironment(buildBody(state, ctx))).name;
          setCreated(name);
        } catch (err) {
          const code = (err as { code?: string }).code ?? '';
          const field = CODE_FIELD[code] ?? 'form';
          const to = stepOfCode(code);
          if (to === 'data' && (code === 'snapshot_not_found' || code === 'snapshot_not_ready')) {
            const gone = state.snapshotId;
            setBase((b) => (b ? { ...b, snapshots: b.snapshots.filter((s) => s.id !== gone) } : b));
            setState((s) => (s ? { ...s, snapshotId: '', dataMode: 'empty' } : s));
          }
          setErrors({ [field]: deployErrorText(err, "Couldn't create the environment.") });
          if (field === 'form') setProblem(deployErrorText(err, "Couldn't create the environment."));
          focusName.current = to === 'environment';
          setStep(to);
          return;
        }
      }
      try {
        await start(name);
      } catch (err) {
        if (!hostKey.handle(err, state.target, name)) setProblem(deployErrorText(err, "Couldn't start the deployment."));
      }
    } finally {
      busyRef.current = false; setBusy(false);
    }
  };

  useEffect(() => {
    if (focusName.current && step === 'environment') {
      focusName.current = false;
      document.getElementById('flow-name')?.focus();
    }
  });

  if (!can('deploy', 'add')) return null;
  if (loadError) return <p className="form-error" role="alert">{loadError}</p>;
  if (!ctx || !state) return <section className="sirdar-flow"><p className="page-hint">Loading…</p></section>;

  const at = FLOW_STEPS.findIndex(([s]) => s === step);
  const label = FLOW_STEPS[at][1];
  const props = { state, set, errors, ctx };
  const next = () => {
    const e = stepErrors(step, state, ctx);
    setErrors(e);
    if (!Object.keys(e).length) setStep(nextStep(step));
  };
  const back = () => { setErrors({}); setStep(prevStep(step)); };
  const startOver = () => {
    if (!window.confirm('Start over? Every choice in this flow is cleared.')) return;
    setState(initialState(ctx)); setStep('environment'); setErrors({}); setProblem(''); setCreated(null);
  };

  return (
    <>
      <section ref={sectionRef} className="sirdar-flow" aria-labelledby="sirdar-flow-title">
        <div className="sirdar-flow-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Deploy</div>
            <h3 id="sirdar-flow-title">{label}</h3>
            <p className="page-hint">{STEP_HINT[step]}</p>
          </div>
          <div className="rgm-steps">
            {FLOW_STEPS.map(([s, text], i) => (
              <Fragment key={s}>
                {i > 0 && <span className="rgm-step-sep" />}
                <span className={`rgm-step${i === at ? ' on' : ''}${i < at ? ' done' : ''}`}>
                  <span className="rgm-step-num">{i + 1}</span>
                  <span className="rgm-step-label">{text}</span>
                </span>
              </Fragment>
            ))}
          </div>
        </div>
        <div className="sirdar-flow-body pf-form">
          {step === 'environment' && <EnvironmentStep {...props} />}
          {step === 'servers' && <ServersStep {...props} />}
          {step === 'target' && <TargetStep {...props} onTargetsChanged={reloadTargets} />}
          {step === 'extras' && <ExtrasStep {...props} />}
          {step === 'traffic' && <TrafficStep {...props} />}
          {step === 'data' && <DataStep {...props} />}
          {step === 'review' && <ReviewStep {...props} busy={busy} problem={problem} created={created} />}
          {errors.form && step !== 'review' && <p className="form-error" role="alert">{errors.form}</p>}
        </div>
        <div className="sirdar-flow-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={startOver}>Start over</button>
          {step !== 'environment' && <button type="button" className="btn-ghost" disabled={busy} onClick={back}>Back</button>}
          {step === 'review'
            ? <button type="button" className="btn-solid" disabled={busy} onClick={() => { void deploy(); }}>
                {busy ? 'Deploying…' : 'Deploy'}
              </button>
            : <button type="button" className="btn-solid" onClick={next}>Next</button>}
        </div>
      </section>
      {hostKey.modal}
    </>
  );
}
```

(`deploy` is a hoisted `const` used by `useHostKeyTrust`'s `onTrusted` only when the user trusts, after render; declare `deploy` with `function` instead if the linter flags the order.)

- [ ] **Step 5: `Deploy.tsx`**

Replace `pages/Deploy.tsx` with:

```tsx
/** /deploy: the step-by-step flow that creates and deploys an environment,
 *  then the Environments and Snapshots lists. Targets, the connection test
 *  and trusted SSH hosts live in the flow's Target step. */
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { errorText, getDeployTargets, type DeployTarget } from '../lib/sirdarApi';

import DeployFlow from './deploy/DeployFlow';
import EnvironmentsSection from './environments/EnvironmentsSection';
import SnapshotsSection from './snapshots/SnapshotsSection';

export default function Deploy() {
  const { can } = useAuth();
  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [loadError, setLoadError] = useState('');
  const loadTargets = useCallback(() => getDeployTargets()
    .then((r) => { setTargets(r.targets); setLoadError(''); })
    .catch((e) => setLoadError(errorText(e, "Couldn't load deployment targets."))), []);
  useEffect(() => { void loadTargets(); }, [loadTargets]);
  return (
    <div className="portal-page">
      <div className="eyebrow">Deployments</div>
      <div className="dir-head">
        <h1>Deploy</h1>
        <p>Create an environment and deploy it, step by step. Your environments and snapshots are below.</p>
      </div>
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      {can('deploy', 'add')
        ? <DeployFlow targets={targets} reloadTargets={() => { void loadTargets(); }} />
        : <p className="page-hint">You can view deployments but not create them. Ask a super admin for access.</p>}
      <EnvironmentsSection targets={targets} />
      <SnapshotsSection />
    </div>
  );
}
```

- [ ] **Step 6: Run the tests and the build**

Run: `npm --prefix sirdar/web test -- src/pages && npm --prefix sirdar/web run build`
Expected: PASS (EnvironmentsSection still opens the old modal until Task 8; nothing here depends on it).

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/pages/deploy/steps/ReviewStep.tsx sirdar/web/src/pages/deploy/steps/ReviewStep.test.tsx sirdar/web/src/pages/deploy/DeployFlow.tsx sirdar/web/src/pages/deploy/DeployFlow.test.tsx sirdar/web/src/pages/Deploy.tsx sirdar/web/src/pages/Deploy.test.tsx
git commit -m "feat(sirdar-web): the Deploy page is the seven-step flow

Review & Deploy creates the environment, starts its first deployment and
opens it; API errors go back to their step; a failed start is retried
without creating twice.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The Adopt dialog; the old dialog goes

**Files:**
- Create: `sirdar/web/src/pages/environments/AdoptEnvironmentModal.tsx` (+ `AdoptEnvironmentModal.test.tsx`)
- Modify: `sirdar/web/src/pages/environments/EnvironmentsSection.tsx` (+ `EnvironmentsSection.test.tsx`)
- Delete: `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, `NewEnvironmentModal.test.tsx`

**Interfaces:**
- Consumes: `adoptEnvironment`, `getDeployTargets`, `deployErrorText`, `useHostKeyTrust`, `sshTargets`, `TYPE_LABEL`, `NAME_HELP`, `nameProblem`, `refProblem`.
- Produces: `AdoptEnvironmentModal({ onAdopted, onClose })` — report-generate header (`.eyebrow` "Deploy", `h3` "Adopt an environment", hint "Adopt an environment set up by hand. Sirdar reads its .env and git checkout over SSH and changes nothing."), `.rgm-steps` (Basics › Result), card class `sirdar-adopt-card`; Basics: Name, Type (Dev / Beta / Custom), Target (`ComboBox`, SSH targets only), Git ref; Result: the adopted environment's commit, image tag, domain, folder, imported secrets and ignored keys (chips), and "Open environment". Escape and Cancel close it; the host-key prompt "Trust and adopt" replays the exact failed attempt; focus returns to Name after a failed adopt or a canceled prompt. `EnvironmentsSection`: the "New environment" button is gone (the flow is above); an "Adopt existing" button (deploy:add) opens the dialog; `onAdopted` reloads the list and navigates to the environment.

- [ ] **Step 1: Move the tests**

Create `AdoptEnvironmentModal.test.tsx` from `NewEnvironmentModal.test.tsx`'s adopt tests (its mocks and `beforeEach`, rendering `<AdoptEnvironmentModal onAdopted={…} onClose={…} />`, without the "How to add it" mode switch): "has the report-generate header", "adopts an existing environment and lists what it imported and ignored", "an unknown host key asks to trust it with the target, then adopts", "a mismatched host key explains what to do", "Escape and Cancel close it", "trusting replays the exact failed attempt even if the form changed behind the host-key modal", "canceling the host-key prompt returns focus to the Name", "a failed adopt returns focus to the Name", "offers SSH targets only (no ESXi, Proxmox or DigitalOcean)", "sends only name, type, target and ref (never a snapshot_id)". Then in `EnvironmentsSection.test.tsx`: replace the "New environment" button test with "Adopt existing opens the adopt dialog (deploy:add)" and "there is no New environment button (the flow is above)".

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/AdoptEnvironmentModal.test.tsx src/pages/environments/EnvironmentsSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: `AdoptEnvironmentModal.tsx`**

Build it from `NewEnvironmentModal.tsx`'s adopt path — keep exactly its `useHostKeyTrust` wiring (`trustLabel: 'Trust and adopt'`), the inert scrim layout effect, the Escape handler, the `refocus` effect, `basicsErrors()` restricted to name / target / ref, `run()` with `adoptEnvironment`, and the Result block — and drop everything about Create (machine, cloud, services, data, review, publish, accounts, snapshots, defaults). The target list is `sshTargets(targets)`; the types `['dev', 'beta', 'custom']` with `TYPE_LABEL`. The card: `className="modal-card reports-modal-card rgm-card sirdar-adopt-card"`, `aria-labelledby="sirdar-adopt-title"`.

- [ ] **Step 4: `EnvironmentsSection.tsx`; delete the old dialog**

In `EnvironmentsSection.tsx`: import `AdoptEnvironmentModal` instead of `NewEnvironmentModal`; the button reads "Adopt existing" (`btn-ghost`); the state is `adopting`; `onAdopted={(env) => { setAdopting(false); void load(); navigate(\`/deploy/environments/${encodeURIComponent(env.name)}\`); }}`, `onClose={() => { setAdopting(false); void load(); }}`. Then `git rm sirdar/web/src/pages/environments/NewEnvironmentModal.tsx sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx` and remove `.sirdar-envmodal-card` rules from `sirdar.css` only if nothing else uses them (`grep -rn sirdar-envmodal sirdar/web/src`).

Before deleting, check the table "Where the old dialog's tests go": every row's new home exists (Tasks 3–8). If one is missing, port it now into the file the table names.

- [ ] **Step 5: Run the tests and the build**

Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: PASS; no import of `NewEnvironmentModal` remains (`grep -rn NewEnvironmentModal sirdar/web/src` prints nothing).

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/pages/environments/AdoptEnvironmentModal.tsx sirdar/web/src/pages/environments/AdoptEnvironmentModal.test.tsx sirdar/web/src/pages/environments/EnvironmentsSection.tsx sirdar/web/src/pages/environments/EnvironmentsSection.test.tsx sirdar/web/src/styles/sirdar.css
git rm -q sirdar/web/src/pages/environments/NewEnvironmentModal.tsx sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx
git commit -m "feat(sirdar-web): Adopt keeps its dialog; New environment is the Deploy flow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, full suites, live verify (controller)

**Files:**
- Modify: `sirdar/README.md` ("Deploy": the seven-step flow; apps; mail; the first admin; Adopt)
- Modify: `deploy/stack/README.md` (`STACK_APPS`; the `SS_SMTP_*` keys and their Mailpit defaults)

- [ ] **Step 1: Docs**

`sirdar/README.md`, "Deploy": replace the "New environment" description with the seven steps and what each holds (one short paragraph each), the rules (production on DigitalOcean with Blue and Green; SSH single only; LAN Blue/Green needs NPM and static addresses), Extras (apps, hosting, integrations; **SMTP lives in the environment's `.env`**: ServerSherpa reads `SS_SMTP_*` from its environment only, so Sirdar stores the host, port, user, from address and STARTTLS on the environment and the password as the optional secret `SS_SMTP_PASSWORD`, and writes them on every deploy), Traffic, Data (the first admin: ServerSherpa's password bar; typed → change-password link, generated → invite link, 4 hours, never a password in mail), Review & Deploy, and "Adopt existing" for hand-built SSH environments. `deploy/stack/README.md`: `STACK_APPS` and the SMTP keys, with an example.

- [ ] **Step 2: Full suites and lint**

Run (foreground, 600000 ms timeouts):

```bash
cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8c9 .venv/bin/pytest -q
cd ../.. && /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -c deploy/pytest.ini deploy/tests
bash -n deploy/stack/ss-stack
npm --prefix sirdar/web test && npm --prefix sirdar/web run build
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src tests migrations
```

Expected: green. Drop `sirdar_test_p8c9` and `sirdar_test_p8c9_source`.

- [ ] **Step 3: Live verify (dev Sirdar per the memory's recipe: worktree API on 8097, web on 5178; signed in as claude-dev)**

1. `/deploy`: the flow's header and seven steps; Next refuses an empty name; Back keeps choices; Start over clears them. The Environments and Snapshots lists are below; "Adopt existing" opens the small dialog.
2. Target step: AWS/GCP disabled; the connection test and trusted hosts sit in the collapsible section and still work (test the lab SSH target; trust a key).
3. A throwaway **SSH** environment (`flow1`, Development, single): Extras with Wiki off and Mailpit on; Traffic lists api, portal, kiosk, spaces, status (no wiki); Data: start empty, typed password. Deploy → the page opens the environment with the deployment running; step 11 creates the first admin; Mailpit has the account-ready email; the wiki container doesn't run (`docker ps`), and there's no `wiki.flow1` DNS record or proxy host.
4. A throwaway **ESXi Blue/Green** environment (8b's recipe and addresses): Target asks for three addresses; Traffic shows spaces → the data VM; Data: Generate & invite. Deploy → the invite arrives; Activate works as in 8b.
5. SMTP: an environment with SMTP pointed at the dev Mailpit's SMTP port on the host (e.g. `10.10.48.x:1025`, STARTTLS off): its `.env` has `SS_SMTP_*` and `SS_SMTP_PASSWORD` (if one was set), the API's notification-worker sends through it, and the password is in no response, log or audit row (`GET /environments/<name>` shows `mail.password_set: true` only).
6. Errors: create with an address already in use → back to Target with the message; with a name that exists → back to Environment, the name focused; a short typed password → Data says "Use at least 8 characters (ServerSherpa's password policy)" before any request.
7. Phone width (375 px): the steps wrap, the grids are one column, nothing scrolls sideways.
8. Delete every throwaway environment. Record results in `.superpowers/sdd/p8c-live-verify.md` (git-ignored).
</content>
</invoke>
