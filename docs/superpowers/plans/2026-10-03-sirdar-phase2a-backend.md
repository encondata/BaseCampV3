# Sirdar deploy — phase 2a (pipeline backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Sirdar's API the deploy pipeline core: environments (create or adopt) with encrypted secrets, deployments that run steps 1–8 on an SSH target through ansible-runner, and the `/api/deploy` endpoints the phase 2b UI will poll.

**Architecture:** New tables (migration 0004) hold environments, their service map, Fernet-encrypted secrets, deployments and steps. A pipeline module runs one asyncio task per deployment; each step is a small Ansible playbook run by an injectable `Runner` (real one: `AnsibleRunner`, a private run folder per step with a pinned `known_hosts`, extra vars mode 600, deleted afterwards; tests use a fake). Step output is redacted before it is stored; the UI polls `GET /api/deploy/deployments/{id}`. Adopt reads a hand-built environment's remote `.env` over SSH and imports it without touching containers.

**Tech Stack:** FastAPI, SQLAlchemy 2 async + asyncpg, Alembic (raw SQL), asyncssh, cryptography (Fernet), ansible-core 2.21.4, ansible-runner 2.4.3, pytest + pytest-asyncio (auto mode), real Postgres.

**Spec:** `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` Sections 2–4, with the binding decisions in `docs/superpowers/plans/2026-10-03-sirdar-phase2-context.md`.

## Global Constraints

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it unless absolute. `sirdar` is both a branch and a folder: use `--` in `git diff`/`git log` (`git log -- sirdar/`).
- Python 3.13, Ruff line length 100, `asyncio_mode = "auto"` (never add `@pytest.mark.asyncio`).
- Migration number is **0004** (`revision = "0004"`, `down_revision = "0003"`); checked free across every worktree on 2026-10-03.
- Pins: `ansible-core==2.21.4`, `ansible-runner==2.4.3`.
- Repo the targets clone: `https://github.com/encondata/BaseCampV3.git` (setting `SIRDAR_DEPLOY_REPO_URL`, that default).
- Environment layout on a target: `/opt/serversherpa/<env>/{.env,repo/,backups/}`; `ss-stack` lives at `<env-dir>/repo/deploy/stack/ss-stack` and is called as `ss-stack <build|up|down [--volumes]|dump> <env-dir>` (argument order exactly: `ss-stack down <env-dir> --volumes`).
- Step numbers and keys: 1 `preflight`, 2 `bootstrap`, 3 `fetch`, 4 `render`, 5 `build`, 6 `dump` (update only), 7 `reset` (reset only), 8 `up` (spec steps 8–11 collapsed into one `ss-stack up`). Update = 1,2,3,4,5,6,8; Reset = 1,2,3,4,5,7,8.
- Secrets (environment secrets, SSH password, key passphrase, key text, sudo password) never appear in an API response, a log line, an audit `changes`, an exception message or a `repr()`. Error reasons are our own copy, never library text.
- Errors: `HTTPException(status, detail={"code": "snake_code", ...})`. Host-key errors keep the `/connect` shapes: 409 `host_key_unknown` `{host, port, key_type, fingerprint}`, 409 `host_key_mismatch` `{host, port, key_type, expected, actual}`, 502 `connect_failed` `{reason}`.
- Permissions reuse `deploy`: `view` = list/read; `add` = create/adopt environments, start Update deploys, retry Update deploys; `change` = edit environments, Reset deploys (start or retry), cancel. Every successful mutation writes one audit row named `deploy.<verb>`.
- One running deployment per environment, enforced by the partial unique index `deployments_one_running`; a second start answers 409 `deploy_in_progress`.
- American English in all copy, comments and docs.
- Never commit `sirdar/.env`.

## Working environment

- Sirdar's dev database must be running. From the main checkout: `cd /Users/jrh1812/Developer/BaseCampV3 && docker compose -f docker-compose.dev.yml up -d sirdar-db` (Postgres on 127.0.0.1:5434).
- Every test command runs from `sirdar/api` in the worktree: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api`, then `.venv/bin/pytest -q tests/<file>`. The worktree has its own `sirdar/api/.venv`.
- If another session runs Sirdar tests at the same time, give this one its own database: prefix commands with `SIRDAR_TEST_DB=sirdar_test_phase2a` (the conftest creates it).
- The dev `sirdar/.env` is read by `Settings`. Tests that need "no secrets key" set `SIRDAR_SECRETS_KEY` to an empty string with `monkeypatch.setenv` (an env var beats the file; blank means unset).
- Integration test (Task 13, opt-in, needs Docker and `sshpass`): `SIRDAR_RUNNER_E2E=1 .venv/bin/pytest -q tests/test_runner_e2e.py`.
- Full suite: `.venv/bin/pytest -q` (several minutes).

## File map

| File | Responsibility |
|---|---|
| `sirdar/api/src/sirdar_api/deploy/envfile.py` | Key names, defaults, `render_env` (record → target `.env`, pure) and `parse_env` |
| `sirdar/api/src/sirdar_api/deploy/vault.py` | Fernet encrypt/decrypt with `SIRDAR_SECRETS_KEY`; secret generation |
| `sirdar/api/src/sirdar_api/config.py` | + `secrets_key`, `runner_dir`, `deploy_repo_url` |
| `sirdar/api/migrations/versions/0004_environments.py` | environments, environment_services, environment_secrets, deployments, deployment_steps |
| `sirdar/api/src/sirdar_api/db/models.py` | + the five ORM models |
| `sirdar/api/src/sirdar_api/deploy/ssh_targets.py` | + write-only `sudo_password` on saved targets |
| `sirdar/api/src/sirdar_api/deploy/ssh.py` | `SshTargetConfig.sudo_password`; `pinned_host_key`, `connect_pinned`, `load_client_key`, `run_command` |
| `sirdar/api/src/sirdar_api/deploy/known_hosts.py` | + `openssh_line`, `host_key_algorithms` |
| `sirdar/api/src/sirdar_api/deploy/targets.py` | saved target → config carries `sudo_password` |
| `sirdar/api/src/sirdar_api/deploy/gitref.py` | ref validation; `git ls-remote` on the target → SHA |
| `sirdar/api/src/sirdar_api/deploy/steps.py` | Step registry, plans per mode, playbook folder |
| `sirdar/api/src/sirdar_api/deploy/ansible/*.yml` | One playbook per step (8 files) |
| `sirdar/api/src/sirdar_api/deploy/redact.py` | Replace known secret values with `[redacted]` |
| `sirdar/api/src/sirdar_api/deploy/runner.py` | `Runner` protocol, request/result types, `AnsibleRunner` |
| `sirdar/api/src/sirdar_api/deploy/pipeline.py` | Deployment records, task registry, step loop, logs, cancel, orphan recovery |
| `sirdar/api/src/sirdar_api/deploy/environments.py` | Create (new), adopt, edit, lookups |
| `sirdar/api/src/sirdar_api/deploy/serialize.py` | JSON shapes for environments and deployments |
| `sirdar/api/src/sirdar_api/api/routes/deploy.py` | + sudo password fields; + environment and deployment endpoints |
| `sirdar/api/src/sirdar_api/api/app.py` | Lifespan: recover orphans at startup, cancel runs at shutdown |
| `sirdar/api/pyproject.toml` | + ansible deps (pinned) + playbooks as package data |
| `sirdar/api/tests/conftest.py` | + new tables in `SIRDAR_TABLES` |
| `sirdar/api/tests/ssh_server.py` | + `exits` (exit status for an override) |
| `sirdar/api/tests/fake_runner.py` | `FakeRunner` |
| `sirdar/api/tests/deploy_factories.py` | Shared fixtures/builders: secrets key, environments, remote `.env`, leak guard |
| `sirdar/api/tests/test_deploy_*.py` (new) | envfile, vault, models, remote, playbooks, runner, pipeline, environments, environments API, deployments API |
| `sirdar/api/tests/test_runner_e2e.py` | Opt-in real ansible-runner run against an SSH container |
| `sirdar/Dockerfile`, `sirdar/docker-compose.yml`, `sirdar/.env.example`, `sirdar/install.sh`, `sirdar/README.md`, `sirdar/.gitignore`, `sirdar/runner/.gitkeep`, `sirdar/scripts/dev-env.sh` | Image tools, runner volume, secrets key, docs |

---

### Task 1: The target `.env` — render and parse

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/envfile.py`
- Test: `sirdar/api/tests/test_deploy_envfile.py`

**Interfaces:**
- Produces: constants `ENV_ROOT = "/opt/serversherpa"`, `SERVICES` (`api, portal, kiosk, wiki, spaces, status, mailpit`), `PUBLIC_SERVICES` (first six), `DEFAULT_PORTS: dict[str, int]`, `PORT_KEYS: dict[str, str]`, `REQUIRED_SECRETS`, `OPTIONAL_SECRETS`, `SECRET_KEYS`, `FERNET_SECRETS`, `HEX_SECRETS`, `LOG_LEVELS`, `DEFAULT_SPACES_BUCKET`, `DEFAULT_LOG_LEVEL`, `DEFAULT_KEEP_DUMPS`, `PLACEHOLDER = "CHANGEME"`, `KNOWN_KEYS` (env.example order).
- Produces: `env_dir(name: str) -> str`; `image_tag(sha: str) -> str` (first 8 chars); `unsafe_value(value: str) -> bool`; `class RenderError(Exception)` with `.reason: str` (names keys, never values); `@dataclass(frozen=True) EnvConfig(name, domain, image_tag, proxy_ip, bind_ip, ports: dict[str, int], keep_dumps: int, spaces_bucket, log_level, secrets: dict[str, str])` (`secrets` hidden from repr); `render_env(cfg: EnvConfig) -> str`; `parse_env(text: str) -> dict[str, str]`.

- [ ] **Step 1: Write the failing test**

`sirdar/api/tests/test_deploy_envfile.py`:

```python
from pathlib import Path

import pytest

from sirdar_api.deploy import envfile
from sirdar_api.deploy.envfile import EnvConfig, RenderError

ENV_EXAMPLE = Path(__file__).resolve().parents[3] / "deploy" / "stack" / "env.example"
SECRETS = {
    "POSTGRES_PASSWORD": "a1" * 32,
    "SPACES_SECRET_KEY": "b2" * 32,
    "SS_JWT_SECRET": "c3" * 32,
    "SS_TOTP_ENCRYPTION_KEY": "x" * 43 + "=",
    "SS_PASSWORD_PEPPER": "d4" * 32,
    "SS_WIKI_SERVICE_TOKEN": "e5" * 32,
}


def _cfg(**over) -> EnvConfig:
    kw = dict(name="uat", domain="uat.serversherpa.com", image_tag="e73b99ca",
              proxy_ip="10.10.48.6", bind_ip="0.0.0.0", ports=dict(envfile.DEFAULT_PORTS),
              keep_dumps=5, spaces_bucket="serversherpa", log_level="INFO",
              secrets=dict(SECRETS))
    kw.update(over)
    return EnvConfig(**kw)


def _keys(text: str) -> list[str]:
    return [line.split("=", 1)[0] for line in text.splitlines()
            if line and not line.startswith("#")]


def test_rendered_keys_match_env_example_in_order():
    example = _keys(ENV_EXAMPLE.read_text())
    assert _keys(envfile.render_env(_cfg())) == example
    assert tuple(example) == envfile.KNOWN_KEYS


def test_render_values():
    text = envfile.render_env(_cfg(secrets={**SECRETS, "SS_ANTHROPIC_API_KEY": "sk-ant-1"}))
    assert text.startswith("# Written by Sirdar")
    assert text.endswith("\n")
    values = envfile.parse_env(text)
    assert values["STACK_ENV"] == "uat"
    assert values["STACK_DOMAIN"] == "uat.serversherpa.com"
    assert values["STACK_IMAGE_TAG"] == "e73b99ca"
    assert values["STACK_REPO_DIR"] == "/opt/serversherpa/uat/repo"
    assert values["STACK_PROXY_IP"] == "10.10.48.6"
    assert values["STACK_BIND_IP"] == "0.0.0.0"
    assert values["STACK_API_PORT"] == "8000"
    assert values["STACK_MAILPIT_PORT"] == "8025"
    assert values["STACK_KEEP_DUMPS"] == "5"
    assert values["SS_SPACES_BUCKET"] == "serversherpa"
    assert values["SS_LOG_LEVEL"] == "INFO"
    assert values["SS_ANTHROPIC_API_KEY"] == "sk-ant-1"
    assert values["SS_DB_TESTING_PASSWORD"] == ""
    for key, value in SECRETS.items():
        assert values[key] == value


def test_secrets_are_not_in_repr():
    assert SECRETS["POSTGRES_PASSWORD"] not in repr(_cfg())


def test_missing_secret_names_the_key_only():
    secrets = {k: v for k, v in SECRETS.items() if k != "SS_JWT_SECRET"}
    with pytest.raises(RenderError) as exc:
        envfile.render_env(_cfg(secrets=secrets))
    assert "SS_JWT_SECRET" in exc.value.reason
    for value in SECRETS.values():
        assert value not in str(exc.value)


@pytest.mark.parametrize("bad", ["a\nb", "a\rb", "a\x00b", "a b"])
def test_control_characters_refused(bad):
    with pytest.raises(RenderError) as exc:
        envfile.render_env(_cfg(secrets={**SECRETS, "SS_PASSWORD_PEPPER": bad}))
    assert "SS_PASSWORD_PEPPER" in exc.value.reason
    assert bad not in str(exc.value)


def test_placeholder_refused():
    with pytest.raises(RenderError) as exc:
        envfile.render_env(_cfg(secrets={**SECRETS, "POSTGRES_PASSWORD": "CHANGEME"}))
    assert "POSTGRES_PASSWORD" in exc.value.reason


def test_parse_env_rules():
    text = ("# comment\n\nSTACK_ENV=uat\r\nA='q v'\nB=\"x\"\nA=last\nlower=no\n"
            "  C=indented\nD=has=equals\n")
    assert envfile.parse_env(text) == {"STACK_ENV": "uat", "A": "last", "B": "x",
                                       "D": "has=equals"}


def test_parse_env_example():
    values = envfile.parse_env(ENV_EXAMPLE.read_text())
    assert values["STACK_ENV"] == "uat"
    assert values["POSTGRES_PASSWORD"] == "CHANGEME"


def test_helpers():
    assert envfile.env_dir("uat") == "/opt/serversherpa/uat"
    assert envfile.image_tag("e73b99ca" + "0" * 32) == "e73b99ca"
    assert envfile.unsafe_value("ok-value") is False
    assert envfile.unsafe_value("a\tb") is True
    assert set(envfile.SERVICES) == set(envfile.DEFAULT_PORTS) == set(envfile.PORT_KEYS)
    assert envfile.PUBLIC_SERVICES == envfile.SERVICES[:6]
    assert set(envfile.HEX_SECRETS) | set(envfile.FERNET_SECRETS) == set(envfile.REQUIRED_SECRETS)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest -q tests/test_deploy_envfile.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'sirdar_api.deploy.envfile'`

- [ ] **Step 3: Write the module**

`sirdar/api/src/sirdar_api/deploy/envfile.py`:

```python
"""One environment's .env on its target: rendered from Sirdar's record
(pure functions, no I/O) and parsed back when adopting a hand-built
environment. Keys and their order follow deploy/stack/env.example.

Values are written raw (KEY=value, no quotes), exactly as ss-stack and
docker compose read them. Errors name keys, never values."""

import re
import unicodedata
from dataclasses import dataclass, field

ENV_ROOT = "/opt/serversherpa"

SERVICES = ("api", "portal", "kiosk", "wiki", "spaces", "status", "mailpit")
PUBLIC_SERVICES = ("api", "portal", "kiosk", "wiki", "spaces", "status")
DEFAULT_PORTS = {"api": 8000, "portal": 8091, "kiosk": 8090, "wiki": 8096,
                 "spaces": 9000, "status": 8095, "mailpit": 8025}
PORT_KEYS = {s: f"STACK_{s.upper()}_PORT" for s in SERVICES}

REQUIRED_SECRETS = ("POSTGRES_PASSWORD", "SPACES_SECRET_KEY", "SS_JWT_SECRET",
                    "SS_TOTP_ENCRYPTION_KEY", "SS_PASSWORD_PEPPER", "SS_WIKI_SERVICE_TOKEN")
OPTIONAL_SECRETS = ("SS_ANTHROPIC_API_KEY", "SS_DB_TESTING_PASSWORD")
SECRET_KEYS = REQUIRED_SECRETS + OPTIONAL_SECRETS
FERNET_SECRETS = ("SS_TOTP_ENCRYPTION_KEY",)
HEX_SECRETS = tuple(k for k in REQUIRED_SECRETS if k not in FERNET_SECRETS)

LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")
DEFAULT_SPACES_BUCKET = "serversherpa"
DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_KEEP_DUMPS = 5
PLACEHOLDER = "CHANGEME"

KNOWN_KEYS = (
    "STACK_ENV", "STACK_DOMAIN", "STACK_IMAGE_TAG", "STACK_REPO_DIR", "STACK_PROXY_IP",
    "STACK_BIND_IP", *(PORT_KEYS[s] for s in SERVICES), "STACK_KEEP_DUMPS",
    *REQUIRED_SECRETS, "SS_SPACES_BUCKET", "SS_LOG_LEVEL", *OPTIONAL_SECRETS,
)

_KEY_RE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
# Control characters and the Unicode line/paragraph separators: any of them
# in a value could end the line and inject another key.
_BAD_CATEGORIES = frozenset({"Cc", "Zl", "Zp"})


def env_dir(name: str) -> str:
    return f"{ENV_ROOT}/{name}"


def image_tag(sha: str) -> str:
    """STACK_IMAGE_TAG for a commit: its first 8 hex digits."""
    return sha[:8]


def unsafe_value(value: str) -> bool:
    return any(unicodedata.category(ch) in _BAD_CATEGORIES for ch in value)


class RenderError(Exception):
    """The record can't become a .env. `reason` names keys, never values."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class EnvConfig:
    name: str
    domain: str
    image_tag: str
    proxy_ip: str
    bind_ip: str
    ports: dict[str, int]
    keep_dumps: int
    spaces_bucket: str
    log_level: str
    secrets: dict[str, str] = field(repr=False)


def render_env(cfg: EnvConfig) -> str:
    missing = [k for k in REQUIRED_SECRETS if not cfg.secrets.get(k)]
    if missing:
        raise RenderError(f"missing secrets: {', '.join(missing)}")
    values = {
        "STACK_ENV": cfg.name,
        "STACK_DOMAIN": cfg.domain,
        "STACK_IMAGE_TAG": cfg.image_tag,
        "STACK_REPO_DIR": f"{env_dir(cfg.name)}/repo",
        "STACK_PROXY_IP": cfg.proxy_ip,
        "STACK_BIND_IP": cfg.bind_ip,
        **{PORT_KEYS[s]: str(cfg.ports[s]) for s in SERVICES},
        "STACK_KEEP_DUMPS": str(cfg.keep_dumps),
        **{k: cfg.secrets[k] for k in REQUIRED_SECRETS},
        "SS_SPACES_BUCKET": cfg.spaces_bucket,
        "SS_LOG_LEVEL": cfg.log_level,
        **{k: cfg.secrets.get(k, "") for k in OPTIONAL_SECRETS},
    }
    for key, value in values.items():
        if unsafe_value(value):
            raise RenderError(f"{key} contains a control or line-break character")
        if value == PLACEHOLDER:
            raise RenderError(f"{key} is still {PLACEHOLDER}")
    lines = ["# Written by Sirdar: edits here are replaced on the next deploy.",
             f"# Environment: {cfg.name}",
             *(f"{k}={v}" for k, v in values.items())]
    return "\n".join(lines) + "\n"


def parse_env(text: str) -> dict[str, str]:
    """KEY=value lines (KEY uppercase, at the start of the line); the last
    assignment wins and one pair of surrounding quotes is dropped, as
    ss-stack's env_value does. Comments, blanks and other lines are ignored."""
    values: dict[str, str] = {}
    for line in text.split("\n"):
        m = _KEY_RE.match(line.removesuffix("\r"))
        if not m:
            continue
        value = m.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[m.group(1)] = value
    return values
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/pytest -q tests/test_deploy_envfile.py`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/envfile.py sirdar/api/tests/test_deploy_envfile.py
git commit -m "feat(sirdar): render and parse an environment's target .env"
```

---

### Task 2: Settings and the secrets vault

**Files:**
- Modify: `sirdar/api/src/sirdar_api/config.py`
- Create: `sirdar/api/src/sirdar_api/deploy/vault.py`
- Test: `sirdar/api/tests/test_deploy_vault.py`

**Interfaces:**
- Consumes: `envfile.REQUIRED_SECRETS`, `envfile.HEX_SECRETS`, `envfile.FERNET_SECRETS` (Task 1).
- Produces: `Settings.secrets_key: SecretStr | None` (`SIRDAR_SECRETS_KEY`, blank = None, must be a Fernet key), `Settings.runner_dir: str = "/app/runner"` (`SIRDAR_RUNNER_DIR`), `Settings.deploy_repo_url: str = "https://github.com/encondata/BaseCampV3.git"` (`SIRDAR_DEPLOY_REPO_URL`).
- Produces: `vault.SecretsKeyMissing`, `vault.SecretUnreadable` (exceptions, no message), `vault.is_configured(settings) -> bool`, `vault.encrypt(settings, value: str) -> bytes`, `vault.decrypt(settings, token: bytes) -> str`, `vault.hex_secret() -> str` (64 hex), `vault.fernet_key() -> str`, `vault.generate_env_secrets() -> dict[str, str]` (keys = `REQUIRED_SECRETS`).

- [ ] **Step 1: Write the failing test**

`sirdar/api/tests/test_deploy_vault.py`:

```python
import re

import pytest
from cryptography.fernet import Fernet
from pydantic import ValidationError

from sirdar_api.deploy import envfile, vault

from .test_scaffold import _settings

KEY = Fernet.generate_key().decode()


def test_round_trip_and_ciphertext_hides_the_value():
    s = _settings(secrets_key=KEY)
    token = vault.encrypt(s, "pg-SECRET-123")
    assert isinstance(token, bytes)
    assert b"pg-SECRET-123" not in token
    assert vault.decrypt(s, token) == "pg-SECRET-123"
    assert vault.decrypt(s, memoryview(token)) == "pg-SECRET-123"


def test_missing_key():
    s = _settings(secrets_key="")
    assert s.secrets_key is None
    assert vault.is_configured(s) is False
    with pytest.raises(vault.SecretsKeyMissing):
        vault.encrypt(s, "x")
    with pytest.raises(vault.SecretsKeyMissing):
        vault.decrypt(s, b"x")
    assert vault.is_configured(_settings(secrets_key=KEY)) is True


def test_wrong_key_is_unreadable():
    token = vault.encrypt(_settings(secrets_key=KEY), "value")
    other = _settings(secrets_key=Fernet.generate_key().decode())
    with pytest.raises(vault.SecretUnreadable):
        vault.decrypt(other, token)


def test_settings_validate_the_key_and_new_defaults():
    with pytest.raises(ValidationError) as exc:
        _settings(secrets_key="not-a-fernet-key")
    assert "SIRDAR_SECRETS_KEY must be a Fernet key" in str(exc.value)
    s = _settings()
    assert s.runner_dir == "/app/runner"
    assert s.deploy_repo_url == "https://github.com/encondata/BaseCampV3.git"
    for bad in ("http://github.com/x.git", "https://github.com/x y.git", "git@github.com:x.git"):
        with pytest.raises(ValidationError):
            _settings(deploy_repo_url=bad)


def test_generated_env_secrets():
    a, b = vault.generate_env_secrets(), vault.generate_env_secrets()
    assert set(a) == set(envfile.REQUIRED_SECRETS)
    for key in envfile.HEX_SECRETS:
        assert re.fullmatch(r"[0-9a-f]{64}", a[key])
        assert a[key] != b[key]
    for key in envfile.FERNET_SECRETS:
        Fernet(a[key].encode())          # a valid Fernet key
        assert a[key] != b[key]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest -q tests/test_deploy_vault.py`
Expected: FAIL — `ImportError: cannot import name 'vault' from 'sirdar_api.deploy'`

- [ ] **Step 3: Add the settings**

In `sirdar/api/src/sirdar_api/config.py`, add `from cryptography.fernet import Fernet` to the imports (after `from typing import Literal`), and add this module constant after `_ORIGIN_RE`:

```python
_REPO_URL_RE = re.compile(r"https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._~/-]+")
```

Add these fields to `Settings`, right after `deploy_targets_file`:

```python
    # Deploy pipeline (phase 2). Fernet key that encrypts every environment's
    # secrets in Sirdar's database; creating, adopting and deploying need it.
    secrets_key: SecretStr | None = None
    # Per-run Ansible working folders (one private folder per step run,
    # deleted when the run ends).
    runner_dir: str = "/app/runner"
    # What targets clone and fetch ServerSherpa from.
    deploy_repo_url: str = "https://github.com/encondata/BaseCampV3.git"
```

Add `"secrets_key"` to the `_blank_secret_is_none` validator's field list, so it reads:

```python
    @field_validator("deploy_do_token", "deploy_aws_secret_access_key",
                     "deploy_ssh_password", "deploy_ssh_key_passphrase", "secrets_key",
                     mode="before")
```

Add two validators after `_origins_valid`:

```python
    @field_validator("secrets_key")
    @classmethod
    def _secrets_key_is_fernet(cls, v: SecretStr | None) -> SecretStr | None:
        if v is None:
            return v
        try:
            Fernet(v.get_secret_value().encode())
        except (ValueError, TypeError):
            raise ValueError("SIRDAR_SECRETS_KEY must be a Fernet key "
                             "(44 characters of URL-safe base64)") from None
        return v

    @field_validator("deploy_repo_url")
    @classmethod
    def _repo_url_valid(cls, v: str) -> str:
        if not _REPO_URL_RE.fullmatch(v):
            raise ValueError("SIRDAR_DEPLOY_REPO_URL must be an https:// git URL")
        return v
```

- [ ] **Step 4: Write the vault**

`sirdar/api/src/sirdar_api/deploy/vault.py`:

```python
"""Per-environment secrets, encrypted with SIRDAR_SECRETS_KEY (Fernet).
decrypt() is the only way a value comes back; its callers hand values
only to the target's .env. Exceptions here carry no message."""

import base64
import os
import secrets

from cryptography.fernet import Fernet, InvalidToken

from sirdar_api.config import Settings
from sirdar_api.deploy import envfile


class SecretsKeyMissing(Exception):
    """SIRDAR_SECRETS_KEY isn't set."""


class SecretUnreadable(Exception):
    """A stored secret doesn't open with the current key."""


def is_configured(settings: Settings) -> bool:
    return settings.secrets_key is not None


def _fernet(settings: Settings) -> Fernet:
    if settings.secrets_key is None:
        raise SecretsKeyMissing()
    return Fernet(settings.secrets_key.get_secret_value().encode())


def encrypt(settings: Settings, value: str) -> bytes:
    return _fernet(settings).encrypt(value.encode())


def decrypt(settings: Settings, token: bytes) -> str:
    try:
        return _fernet(settings).decrypt(bytes(token)).decode()
    except InvalidToken:
        raise SecretUnreadable() from None


def hex_secret() -> str:
    return secrets.token_hex(32)


def fernet_key() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode()


def generate_env_secrets() -> dict[str, str]:
    """A new environment's required secrets: hex (safe inside URLs, e.g. the
    Postgres password) or a Fernet key where the app needs one."""
    return {key: fernet_key() if key in envfile.FERNET_SECRETS else hex_secret()
            for key in envfile.REQUIRED_SECRETS}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/bin/pytest -q tests/test_deploy_vault.py tests/test_scaffold.py`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add sirdar/api/src/sirdar_api/config.py sirdar/api/src/sirdar_api/deploy/vault.py \
  sirdar/api/tests/test_deploy_vault.py
git commit -m "feat(sirdar): SIRDAR_SECRETS_KEY vault, runner dir and repo URL settings"
```

---

### Task 3: Migration 0004 and the models

**Files:**
- Create: `sirdar/api/migrations/versions/0004_environments.py`
- Modify: `sirdar/api/src/sirdar_api/db/models.py` (append five models)
- Modify: `sirdar/api/tests/conftest.py:37-38` (`SIRDAR_TABLES`)
- Test: `sirdar/api/tests/test_deploy_models.py`

**Interfaces:**
- Produces ORM models (all in `sirdar_api.db.models`):
  - `Environment`: `id: UUID`, `name: str` (unique), `type: str` (`dev|beta|custom`), `target_id: str`, `base_domain: str`, `git_ref: str`, `current_sha: str | None`, `image_tag: str | None`, `status: str` (`new|deploying|ready|failed`), `proxy_ip: str`, `bind_ip: str`, `keep_dumps: int`, `spaces_bucket: str`, `log_level: str`, `created_by: UUID | None`, `created_at`, `updated_at`.
  - `EnvironmentService`: `id`, `environment_id`, `service: str`, `host_ip: str`, `port: int`, `hostname: str | None`, `proxied: bool`; unique `(environment_id, service)`.
  - `EnvironmentSecret`: PK `(environment_id, key)`, `value_enc: bytes`, `updated_at`.
  - `Deployment`: `id`, `environment_id`, `mode: str` (`update|reset|adopt`), `git_ref: str`, `sha: str`, `status: str` (`running|succeeded|failed|cancelled|interrupted|adopted`), `start_step: int`, `retry_of: UUID | None`, `failed_step: int | None`, `dump_path: str | None`, `previous_sha: str | None`, `error: str | None`, `actor_id: UUID | None`, `started_at`, `finished_at: datetime | None`, `created_at` (default `clock_timestamp()`).
  - `DeploymentStep`: `id`, `deployment_id`, `number: int`, `key: str`, `name: str`, `status: str` (`pending|running|succeeded|failed|skipped|cancelled|interrupted|not_run`), `started_at`, `finished_at`, `log: str`; unique `(deployment_id, number)`.
- Produces index `deployments_one_running` (unique on `environment_id` where `status = 'running'`).

- [ ] **Step 1: Write the failing test**

`sirdar/api/tests/test_deploy_models.py`:

```python
import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from sirdar_api.db.models import (
    Deployment, DeploymentStep, Environment, EnvironmentSecret, EnvironmentService,
)

SHA = "a" * 40


async def _env(db, name="uat") -> Environment:
    env = Environment(name=name, type="dev", target_id="ssh",
                      base_domain=f"{name}.serversherpa.com", proxy_ip="10.0.0.2",
                      git_ref="main", status="new", bind_ip="0.0.0.0", keep_dumps=5,
                      spaces_bucket="serversherpa", log_level="INFO")
    db.add(env)
    await db.commit()
    return env


def _dep(env, status="running") -> Deployment:
    return Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status=status, start_step=1)


async def test_tables_exist(db):
    names = set(await db.scalars(text(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")))
    assert {"environments", "environment_services", "environment_secrets", "deployments",
            "deployment_steps"} <= names


async def test_server_defaults_are_loaded(db):
    env = await _env(db)
    dep = _dep(env)
    db.add(dep)
    await db.commit()
    assert env.created_at is not None and env.updated_at is not None
    assert dep.created_at is not None and dep.started_at is not None
    assert dep.finished_at is None


async def test_one_running_deployment_per_environment(db):
    env = await _env(db)
    other = await _env(db, "qa")
    db.add(_dep(env))
    await db.commit()
    db.add(_dep(other))
    db.add(_dep(env, "succeeded"))
    await db.commit()
    db.add(_dep(env))
    with pytest.raises(IntegrityError) as exc:
        await db.commit()
    assert "deployments_one_running" in str(exc.value.orig)
    await db.rollback()


async def test_check_constraints_and_unique_names(db):
    env = await _env(db)
    db.add(_dep(env, "bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    db.add(Environment(name="uat", type="dev", target_id="ssh", base_domain="x.example.com",
                       proxy_ip="10.0.0.2", git_ref="main", status="new", bind_ip="0.0.0.0",
                       keep_dumps=5, spaces_bucket="serversherpa", log_level="INFO"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_deleting_an_environment_cascades(db):
    env = await _env(db)
    db.add(EnvironmentService(environment_id=env.id, service="api", host_ip="10.0.0.5",
                              port=8000, hostname="api.uat.serversherpa.com", proxied=False))
    db.add(EnvironmentSecret(environment_id=env.id, key="POSTGRES_PASSWORD", value_enc=b"x"))
    dep = _dep(env)
    db.add(dep)
    await db.flush()
    db.add(DeploymentStep(deployment_id=dep.id, number=1, key="preflight", name="Preflight",
                          status="pending"))
    await db.commit()
    await db.execute(delete(Environment).where(Environment.id == env.id))
    await db.commit()
    for model in (EnvironmentService, EnvironmentSecret, Deployment, DeploymentStep):
        assert await db.scalar(select(func.count()).select_from(model)) == 0
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest -q tests/test_deploy_models.py`
Expected: FAIL — `ImportError: cannot import name 'Deployment' from 'sirdar_api.db.models'`

- [ ] **Step 3: Write the migration**

`sirdar/api/migrations/versions/0004_environments.py`:

```python
"""Deploy pipeline: environments, their services and encrypted secrets,
deployments and their steps.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-03
"""
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE environments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL UNIQUE,
          type text NOT NULL CHECK (type IN ('dev', 'beta', 'custom')),
          target_id text NOT NULL,
          base_domain text NOT NULL,
          git_ref text NOT NULL DEFAULT 'main',
          current_sha text,
          image_tag text,
          status text NOT NULL DEFAULT 'new'
            CHECK (status IN ('new', 'deploying', 'ready', 'failed')),
          proxy_ip text NOT NULL,
          bind_ip text NOT NULL DEFAULT '0.0.0.0',
          keep_dumps integer NOT NULL DEFAULT 5,
          spaces_bucket text NOT NULL DEFAULT 'serversherpa',
          log_level text NOT NULL DEFAULT 'INFO',
          created_by uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE environment_services (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          service text NOT NULL,
          host_ip text NOT NULL,
          port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
          hostname text,
          proxied boolean NOT NULL DEFAULT false,
          UNIQUE (environment_id, service)
        );
        CREATE TABLE environment_secrets (
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          key text NOT NULL,
          value_enc bytea NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (environment_id, key)
        );
        CREATE TABLE deployments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          mode text NOT NULL CHECK (mode IN ('update', 'reset', 'adopt')),
          git_ref text NOT NULL,
          sha text NOT NULL,
          status text NOT NULL CHECK (status IN
            ('running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'adopted')),
          start_step integer NOT NULL DEFAULT 1,
          retry_of uuid REFERENCES deployments(id) ON DELETE SET NULL,
          failed_step integer,
          dump_path text,
          previous_sha text,
          error text,
          actor_id uuid,
          started_at timestamptz NOT NULL DEFAULT now(),
          finished_at timestamptz,
          -- clock_timestamp, not now(): "latest deployment" must order rows
          -- created in the same transaction too.
          created_at timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        -- The per-environment deploy lock.
        CREATE UNIQUE INDEX deployments_one_running ON deployments (environment_id)
          WHERE status = 'running';
        CREATE INDEX deployments_environment_created
          ON deployments (environment_id, created_at DESC);
        CREATE TABLE deployment_steps (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
          number integer NOT NULL,
          key text NOT NULL,
          name text NOT NULL,
          status text NOT NULL DEFAULT 'pending' CHECK (status IN
            ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled',
             'interrupted', 'not_run')),
          started_at timestamptz,
          finished_at timestamptz,
          log text NOT NULL DEFAULT '',
          UNIQUE (deployment_id, number)
        );
    """)


def downgrade() -> None:
    op.execute("""
        DROP TABLE deployment_steps;
        DROP TABLE deployments;
        DROP TABLE environment_secrets;
        DROP TABLE environment_services;
        DROP TABLE environments;
    """)
```

- [ ] **Step 4: Add the models**

Append to `sirdar/api/src/sirdar_api/db/models.py`:

```python
class Environment(Base):
    """One ServerSherpa environment on a target (migration 0004)."""

    __tablename__ = "environments"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(unique=True)
    type: Mapped[str]                              # dev | beta | custom
    target_id: Mapped[str]                         # "ssh" | "ssh:<slug>"
    base_domain: Mapped[str]
    git_ref: Mapped[str] = mapped_column(server_default=text("'main'"))
    current_sha: Mapped[str | None]
    image_tag: Mapped[str | None]
    status: Mapped[str] = mapped_column(server_default=text("'new'"))
    proxy_ip: Mapped[str]
    bind_ip: Mapped[str] = mapped_column(server_default=text("'0.0.0.0'"))
    keep_dumps: Mapped[int] = mapped_column(Integer, server_default=text("5"))
    spaces_bucket: Mapped[str] = mapped_column(server_default=text("'serversherpa'"))
    log_level: Mapped[str] = mapped_column(server_default=text("'INFO'"))
    created_by: Mapped[uuid.UUID | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class EnvironmentService(Base):
    __tablename__ = "environment_services"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"))
    service: Mapped[str]
    host_ip: Mapped[str]
    port: Mapped[int] = mapped_column(Integer)
    hostname: Mapped[str | None]
    proxied: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))


class EnvironmentSecret(Base):
    __tablename__ = "environment_secrets"

    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(primary_key=True)
    value_enc: Mapped[bytes] = mapped_column(BYTEA)
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Deployment(Base):
    __tablename__ = "deployments"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"))
    mode: Mapped[str]                              # update | reset | adopt
    git_ref: Mapped[str]
    sha: Mapped[str]
    status: Mapped[str]
    start_step: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    retry_of: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("deployments.id", ondelete="SET NULL"))
    failed_step: Mapped[int | None] = mapped_column(Integer)
    dump_path: Mapped[str | None]
    previous_sha: Mapped[str | None]
    error: Mapped[str | None]
    actor_id: Mapped[uuid.UUID | None]
    started_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    finished_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("clock_timestamp()"))


class DeploymentStep(Base):
    __tablename__ = "deployment_steps"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    deployment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("deployments.id", ondelete="CASCADE"))
    number: Mapped[int] = mapped_column(Integer)
    key: Mapped[str]
    name: Mapped[str]
    status: Mapped[str] = mapped_column(server_default=text("'pending'"))
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    log: Mapped[str] = mapped_column(server_default=text("''"))
```

Also update the module docstring's first line to: `"""Sirdar's own tables (migrations 0001–0004). `users` mirrors the portal's` (keep the rest as is).

- [ ] **Step 5: Truncate the new tables between tests**

In `sirdar/api/tests/conftest.py`, replace the `SIRDAR_TABLES` assignment with:

```python
SIRDAR_TABLES = ("users, user_roles, permission_overrides, totp_backup_codes, "
                 "auth_sessions, audit_log, import_runs, ssh_known_hosts, "
                 "environments, environment_services, environment_secrets, deployments, "
                 "deployment_steps")
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/pytest -q tests/test_deploy_models.py tests/test_scaffold.py`
Expected: PASS (the conftest migrates the test database to head, now 0004)

- [ ] **Step 7: Check the downgrade on the test database**

Run (from `sirdar/api`):

```bash
SIRDAR_DATABASE_URL=postgresql+asyncpg://sirdar:sirdar@127.0.0.1:5434/sirdar_test \
  .venv/bin/alembic downgrade 0003 && \
SIRDAR_DATABASE_URL=postgresql+asyncpg://sirdar:sirdar@127.0.0.1:5434/sirdar_test \
  .venv/bin/alembic upgrade head
```

Expected: `Running downgrade 0004 -> 0003` then `Running upgrade 0003 -> 0004`, exit 0. (The other settings come from `sirdar/.env`.)

- [ ] **Step 8: Commit**

```bash
git add sirdar/api/migrations/versions/0004_environments.py sirdar/api/src/sirdar_api/db/models.py \
  sirdar/api/tests/conftest.py sirdar/api/tests/test_deploy_models.py
git commit -m "feat(sirdar): migration 0004 — environments, secrets, deployments, steps"
```

---
### Task 4: Write-only sudo password on saved SSH targets

Key-only targets (like the hand-built `uat` host, user `jrh1812`) need a password for `sudo`. It is stored like the other target secrets: write-only, `*_set` boolean, length cap, control characters refused.

The dotenv suffix is `SUDO_PASS`, **not** `SUDO_PASSWORD`: `PASSWORD` is already a suffix, so `SIRDAR_SSH_A_SUDO_PASSWORD` would be both target `a`'s sudo password and target `a-sudo`'s SSH password. `SUDO_PASS` ends in no existing suffix and no existing suffix ends in it.

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/ssh_targets.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/ssh.py` (`SshTargetConfig` only)
- Modify: `sirdar/api/src/sirdar_api/deploy/targets.py` (`_saved_config`)
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (`SshTargetIn`, `SshTargetPatch`, `_audit_fields`, `_PATCH_ORDER`, `update_ssh_target`)
- Test: `sirdar/api/tests/test_deploy_ssh_targets_store.py`, `sirdar/api/tests/test_deploy_ssh_targets_api.py`

**Interfaces:**
- Produces: `SavedSshTarget.sudo_password: str | None`; `public()` gains `"sudo_password_set": bool`; store error code `sudo_password_too_long`; API body field `sudo_password` (POST and PUT; `""` clears, omitted/`null` keeps); `SshTargetConfig.sudo_password: str | None` (not in repr; `None` for the installer target).

- [ ] **Step 1: Write the failing store tests**

Append to `sirdar/api/tests/test_deploy_ssh_targets_store.py`:

```python
def test_sudo_password_round_trip_and_write_only(store):
    t = store.add(_fields(sudo_password="sudo-PW-1"))
    assert t.sudo_password == "sudo-PW-1"
    assert "SIRDAR_SSH_EDGE_BOX_SUDO_PASS='sudo-PW-1'\n" in store.path.read_text()
    assert t.public()["sudo_password_set"] is True
    assert "sudo-PW-1" not in repr(t)
    _, t = store.update("edge-box", {"host": "h.example.com"})
    assert t.sudo_password == "sudo-PW-1"
    _, t = store.update("edge-box", {"sudo_password": ""})
    assert t.sudo_password is None
    assert "SUDO_PASS" not in store.path.read_text()
    assert store.load()[0].public()["sudo_password_set"] is False


def test_sudo_password_never_satisfies_auth(store):
    with pytest.raises(TargetError) as exc:
        store.add(_fields(password=None, sudo_password="sudo-only"))
    assert exc.value.code == "auth_required"


def test_sudo_password_length_capped(store):
    with pytest.raises(TargetError) as exc:
        store.add(_fields(sudo_password="p" * 1025))
    assert exc.value.code == "sudo_password_too_long"
    assert store.add(_fields(sudo_password="p" * 1024)).sudo_password == "p" * 1024


def test_sudo_key_never_collides_with_another_targets_password(store):
    store.add(_fields(name="Ab", sudo_password="sudo-of-ab"))
    store.add(_fields(name="Ab Sudo", password="pw-of-ab-sudo"))
    ab, ab_sudo = store.load()
    assert (ab.slug, ab.password, ab.sudo_password) == ("ab", "pw-1", "sudo-of-ab")
    assert (ab_sudo.slug, ab_sudo.password, ab_sudo.sudo_password) == (
        "ab-sudo", "pw-of-ab-sudo", None)
```

- [ ] **Step 2: Write the failing API test and update the exact-shape assertions**

In `sirdar/api/tests/test_deploy_ssh_targets_api.py`:

1. Add `from sirdar_api.deploy import targets` to the imports.
2. Replace the secret constants block with:

```python
SAVED_PW = "saved-PW-secret-77"
SAVED_PP = "saved-PP-secret-88"
SAVED_SUDO = "saved-SUDO-secret-99"
ALL_SECRETS = (*SECRETS, SAVED_PW, SAVED_PP, SAVED_SUDO)
```

3. In the `secret_bodies` fixture, change `for secret in (SAVED_PW, SAVED_PP):` to `for secret in (SAVED_PW, SAVED_PP, SAVED_SUDO):`.
4. In `test_crud_round_trip`, the `created` dict and the expected `audits[0][2]` dict each gain `"sudo_password_set": False`:

```python
    created = {"slug": "edge-box", "name": "Edge Box", "host": "10.20.30.40", "port": 2222,
               "user": "deployer", "key_path": "id_ed25519", "password_set": True,
               "passphrase_set": True, "sudo_password_set": False}
```

```python
    assert audits[0][2] == {"name": "Edge Box", "host": "10.20.30.40", "port": 2222,
                            "user": "deployer", "key_path": "id_ed25519",
                            "password_set": True, "passphrase_set": True,
                            "sudo_password_set": False}
```

5. Append:

```python
async def test_sudo_password_is_write_only(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/ssh-targets", headers=h,
                             json=_new(sudo_password=SAVED_SUDO))
    assert resp.status_code == 201, resp.text
    assert resp.json()["sudo_password_set"] is True
    cfg = targets.ssh_config_for("ssh:edge-box", get_settings())
    assert cfg.sudo_password == SAVED_SUDO
    assert SAVED_SUDO not in repr(cfg)

    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"sudo_password": ""})
    assert resp.status_code == 200 and resp.json()["sudo_password_set"] is False
    assert targets.ssh_config_for("ssh:edge-box", get_settings()).sudo_password is None

    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"sudo_password": SAVED_SUDO + "x" * 1100})
    assert resp.status_code == 422
    assert resp.json() == {"detail": {"code": "sudo_password_too_long"}}

    audits = await _audits(db)
    assert audits[0][2]["sudo_password_set"] is True
    assert audits[1][2]["changed"] == ["sudo_password"]
    assert audits[1][2]["sudo_password_set"] is False
    for _, _, changes in audits:
        assert SAVED_SUDO not in repr(changes)


async def test_installer_target_has_no_sudo_password(client, db, store_env, secret_bodies):
    store_env["apply"](ssh_host="10.0.0.9", ssh_user="root", ssh_password=SSH_PASSWORD)
    h = await auth_headers(client, db)
    assert (await client.get("/api/deploy/targets", headers=h)).status_code == 200
    assert targets.ssh_config_for("ssh", get_settings()).sudo_password is None
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `.venv/bin/pytest -q tests/test_deploy_ssh_targets_store.py tests/test_deploy_ssh_targets_api.py`
Expected: FAIL — `TypeError`/`AttributeError` on `sudo_password`, and the two updated exact-dict assertions fail (no `sudo_password_set` key).

- [ ] **Step 4: Store support**

In `sirdar/api/src/sirdar_api/deploy/ssh_targets.py`:

1. Docstring, the second format line becomes:

```
    SIRDAR_SSH_<KEY>_NAME / _HOST / _PORT / _USER / _PASSWORD / _KEY_PATH / _KEY_PASSPHRASE
    / _SUDO_PASS
```

and add this paragraph at the end of the docstring:

```
No suffix may end with "_<another suffix>": <KEY> can itself contain "_",
so SUDO_PASSWORD would make target "a"'s sudo password the same key as
target "a-sudo"'s PASSWORD. Hence SUDO_PASS.
```

2. `_SUFFIXES` becomes:

```python
_SUFFIXES = ("NAME", "HOST", "PORT", "USER", "PASSWORD", "KEY_PATH", "KEY_PASSPHRASE",
             "SUDO_PASS")
```

3. Replace the `SavedSshTarget` class with:

```python
@dataclass(frozen=True)
class SavedSshTarget:
    slug: str
    name: str
    host: str
    port: int
    user: str
    password: str | None = None
    key_path: str = ""
    passphrase: str | None = None
    sudo_password: str | None = None

    def __repr__(self) -> str:                 # never print secrets
        return (f"SavedSshTarget(slug={self.slug!r}, name={self.name!r}, host={self.host!r}, "
                f"port={self.port}, user={self.user!r}, key_path={self.key_path!r}, "
                f"password_set={self.password is not None}, "
                f"passphrase_set={self.passphrase is not None}, "
                f"sudo_password_set={self.sudo_password is not None})")

    @property
    def id(self) -> str:
        return f"ssh:{self.slug}"

    @property
    def configured(self) -> bool:
        return bool(self.host and self.user and (self.password is not None or self.key_path))

    def public(self) -> dict:
        """Editable, non-secret fields."""
        return {"slug": self.slug, "name": self.name, "host": self.host, "port": self.port,
                "user": self.user, "key_path": self.key_path or None,
                "password_set": self.password is not None,
                "passphrase_set": self.passphrase is not None,
                "sudo_password_set": self.sudo_password is not None}
```

4. In `_targets_from`, replace the two lines `password = …` / `passphrase = …` and the `out.append(...)` call with:

```python
            password = v.get(k + "PASSWORD") or None
            passphrase = v.get(k + "KEY_PASSPHRASE") or None
            sudo_password = v.get(k + "SUDO_PASS") or None
            out.append(SavedSshTarget(
                slug=slug, name=v.get(k + "NAME", "").strip() or slug,
                host=v.get(k + "HOST", "").strip(), port=port,
                user=v.get(k + "USER", "").strip(), password=password,
                key_path=v.get(k + "KEY_PATH", "").strip(), passphrase=passphrase,
                sudo_password=sudo_password))
```

5. Replace `_apply` with:

```python
    @staticmethod
    def _apply(t: SavedSshTarget, fields: dict) -> SavedSshTarget:
        """Absent or None = keep; "" clears the optional fields."""
        for key, code in (("password", "password_too_long"),
                          ("key_passphrase", "passphrase_too_long"),
                          ("sudo_password", "sudo_password_too_long")):
            value = fields.get(key)
            if value is not None and not isinstance(value, str):
                raise ValueError("secret values must be strings")
            if isinstance(value, str) and len(value) > SECRET_MAX:
                raise TargetError(code)
        for value in fields.values():
            if isinstance(value, str) and has_bad_chars(value):
                raise ValueError("values can't contain control or line-separator characters")
        changes: dict = {}
        for key in ("name", "host", "user"):
            if fields.get(key) is not None:
                changes[key] = str(fields[key]).strip()
        if fields.get("port") is not None:
            changes["port"] = fields["port"]
        if fields.get("key_path") is not None:
            changes["key_path"] = str(fields["key_path"]).strip()
        if fields.get("password") is not None:
            changes["password"] = fields["password"] or None
        if fields.get("key_passphrase") is not None:
            changes["passphrase"] = fields["key_passphrase"] or None
        if fields.get("sudo_password") is not None:
            changes["sudo_password"] = fields["sudo_password"] or None
        return replace(t, **changes)
```

6. In `_render`, after the `KEY_PASSPHRASE` lines, add:

```python
                if t.sudo_password is not None:
                    block.append(f"{k}SUDO_PASS={_quote(t.sudo_password)}")
```

- [ ] **Step 5: Config, target resolution and routes**

In `sirdar/api/src/sirdar_api/deploy/ssh.py`, add this last field to `SshTargetConfig` (after `passphrase`), and extend its docstring with `` `sudo_password` is the password for sudo when it differs from the SSH password (key-only targets).``:

```python
    sudo_password: str | None = field(default=None, repr=False)
```

In `sirdar/api/src/sirdar_api/deploy/targets.py`, `_saved_config` returns:

```python
    return SshTargetConfig(host=t.host, port=t.port, user=t.user, password=t.password,
                           key_file=key_file, key_name=name, passphrase=t.passphrase,
                           sudo_password=t.sudo_password)
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`:

- `SshTargetIn` and `SshTargetPatch` each gain `sudo_password: str | None = None` (after `key_passphrase`).
- `_audit_fields` returns:

```python
    return {"name": t.name, "host": t.host, "port": t.port, "user": t.user,
            "key_path": t.key_path or None, "password_set": t.password is not None,
            "passphrase_set": t.passphrase is not None,
            "sudo_password_set": t.sudo_password is not None}
```

- `_PATCH_ORDER` becomes:

```python
_PATCH_ORDER = ("name", "host", "port", "user", "password", "key_path", "key_passphrase",
                "sudo_password")
```

- In `update_ssh_target`, the `current` dict gains `"sudo_password": (old.sudo_password, new.sudo_password),`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/pytest -q tests/test_deploy_ssh_targets_store.py tests/test_deploy_ssh_targets_api.py tests/test_deploy_targets.py tests/test_deploy_ssh.py`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/ssh_targets.py sirdar/api/src/sirdar_api/deploy/ssh.py \
  sirdar/api/src/sirdar_api/deploy/targets.py sirdar/api/src/sirdar_api/api/routes/deploy.py \
  sirdar/api/tests/test_deploy_ssh_targets_store.py sirdar/api/tests/test_deploy_ssh_targets_api.py
git commit -m "feat(sirdar): write-only sudo password on saved SSH targets"
```

---

### Task 5: Pinned SSH commands and git ref resolution

The deploy pipeline needs to run a few one-off commands on a target (read the remote `.env`, `git rev-parse`, `git ls-remote`) through the same pinned-host-key connection the connection test uses. This task factors the pinning out of `test_connection` (behavior unchanged; its tests keep passing), adds `run_command`, the known_hosts line helpers the runner needs, and ref resolution.

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/ssh.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/known_hosts.py`
- Create: `sirdar/api/src/sirdar_api/deploy/gitref.py`
- Modify: `sirdar/api/tests/ssh_server.py` (`exits`)
- Test: `sirdar/api/tests/test_deploy_remote.py`

**Interfaces:**
- Produces (`ssh`): `@dataclass(frozen=True) PinnedHost(key: asyncssh.SSHKey, key_type: str, fingerprint: str, public_key: str)`; `async pinned_host_key(db, host: str, port: int) -> PinnedHost` (raises `HostKeyUnknown`, `HostKeyMismatch`, `ConnectFailed`); `async load_client_key(cfg) -> asyncssh.SSHKey | None` (renamed from `_load_client_key`); `async connect_pinned(cfg, pinned) -> asyncssh.SSHClientConnection`; `@dataclass(frozen=True) CommandResult(exit_status: int | None, stdout: str)` (stdout hidden from repr); `async run_command(cfg, db, command: str, *, timeout: float = RUN_TIMEOUT) -> CommandResult`; constants `RUN_TIMEOUT = 60`, `OUTPUT_LIMIT = 262144`.
- Produces (`known_hosts`): `openssh_line(host: str, port: int, public_key: str) -> str`; `host_key_algorithms(key_type: str) -> str`.
- Produces (`gitref`): `SHA_RE`; `valid_ref(ref: str) -> bool`; `pick_sha(output: str, ref: str) -> str | None`; `ls_remote_command(repo_url: str, ref: str) -> str`; `class RefError(Exception)` with `.code` in `ref_invalid | ref_not_found | git_missing | ref_lookup_failed`; `async resolve_ref(cfg, db, repo_url: str, ref: str) -> str` (40 lowercase hex).
- Produces (tests): `FakeSshServer.exits: dict[str, int]` — exit status for a command answered from `overrides`.

- [ ] **Step 1: Let the fake SSH server fail a command**

In `sirdar/api/tests/ssh_server.py`, add a field after `delays`:

```python
    exits: dict = field(default_factory=dict)    # command -> exit status for an override
```

and in `answer`, change the override branch to:

```python
        if command in self.overrides:
            return self.overrides[command], "", self.exits.get(command, 0)
```

- [ ] **Step 2: Write the failing test**

`sirdar/api/tests/test_deploy_remote.py`:

```python
import pytest

from sirdar_api.deploy import ConnectFailed, gitref, known_hosts, ssh

from .ssh_server import ssh_config, ssh_server  # noqa: F401

REPO = "https://github.com/encondata/BaseCampV3.git"
LS = f"git ls-remote {REPO}"
SHA_MAIN = "1" * 40
SHA_TAG = "2" * 40
SHA_TAG_OBJECT = "3" * 40
CAT = "cat -- /opt/serversherpa/uat/.env"


async def _trust(db, fake):
    await known_hosts.trust(db, fake.host, fake.port, fake.fingerprint, actor_id=None)
    await db.commit()


async def test_pinned_host_key(db, ssh_server):
    with pytest.raises(ssh.HostKeyUnknown):
        await ssh.pinned_host_key(db, ssh_server.host, ssh_server.port)
    await _trust(db, ssh_server)
    pinned = await ssh.pinned_host_key(db, ssh_server.host, ssh_server.port)
    assert (pinned.key_type, pinned.fingerprint) == ("ssh-ed25519", ssh_server.fingerprint)
    assert pinned.public_key.startswith("ssh-ed25519 ")
    assert ssh_server.commands == []


async def test_run_command_returns_output_and_status(db, ssh_server):
    await _trust(db, ssh_server)
    ssh_server.overrides[CAT] = "STACK_ENV=uat\n"
    result = await ssh.run_command(ssh_config(ssh_server), db, CAT)
    assert (result.exit_status, result.stdout) == (0, "STACK_ENV=uat\n")
    assert "STACK_ENV" not in repr(result)
    ssh_server.exits[CAT] = 1
    result = await ssh.run_command(ssh_config(ssh_server), db, CAT)
    assert result.exit_status == 1


async def test_run_command_refuses_an_untrusted_host(db, ssh_server):
    with pytest.raises(ssh.HostKeyUnknown):
        await ssh.run_command(ssh_config(ssh_server), db, "true")
    assert ssh_server.commands == []


async def test_run_command_timeout_is_no_answer(db, ssh_server):
    await _trust(db, ssh_server)
    ssh_server.overrides["slow"] = "late\n"
    ssh_server.delays["slow"] = 5
    result = await ssh.run_command(ssh_config(ssh_server), db, "slow", timeout=0.5)
    assert (result.exit_status, result.stdout) == (None, "")


async def test_run_command_wrong_password(db, ssh_server):
    await _trust(db, ssh_server)
    with pytest.raises(ConnectFailed) as exc:
        await ssh.run_command(ssh_config(ssh_server, deploy_ssh_password="nope"), db, "true")
    assert exc.value.reason == "The SSH server rejected the username, password or key."


def test_known_hosts_lines():
    assert known_hosts.openssh_line("10.0.0.5", 22, "ssh-ed25519 AAAA comment") == \
        "10.0.0.5 ssh-ed25519 AAAA"
    assert known_hosts.openssh_line("10.0.0.5", 2222, "ssh-ed25519 AAAA") == \
        "[10.0.0.5]:2222 ssh-ed25519 AAAA"
    assert known_hosts.host_key_algorithms("ssh-rsa") == "rsa-sha2-512,rsa-sha2-256"
    assert known_hosts.host_key_algorithms("ssh-ed25519") == "ssh-ed25519"
    assert known_hosts.host_key_algorithms("ecdsa-sha2-nistp256") == "ecdsa-sha2-nistp256"


def test_pick_sha_prefers_branch_then_peeled_tag():
    out = (f"{SHA_MAIN}\trefs/heads/main\n{SHA_TAG_OBJECT}\trefs/tags/v1\n"
           f"{SHA_TAG}\trefs/tags/v1^{{}}\n")
    assert gitref.pick_sha(out, "main") == SHA_MAIN
    assert gitref.pick_sha(out, "v1") == SHA_TAG
    assert gitref.pick_sha(f"{SHA_TAG_OBJECT}\trefs/tags/v2\n", "v2") == SHA_TAG_OBJECT
    assert gitref.pick_sha("junk\n", "main") is None


@pytest.mark.parametrize("ref", ["main", "release/2026-10", "v1.2.3", "feature_x", "HEAD"])
def test_valid_refs(ref):
    assert gitref.valid_ref(ref)


@pytest.mark.parametrize("ref", ["", "-x", "a..b", "a b", "a;b", "$(x)", "x/", "x.lock",
                                 "a" * 201, "ref\n", "a'b"])
def test_invalid_refs(ref):
    assert not gitref.valid_ref(ref)


async def test_resolve_a_branch(db, ssh_server):
    await _trust(db, ssh_server)
    ssh_server.overrides[f"{LS} main"] = f"{SHA_MAIN}\trefs/heads/main\n"
    assert await gitref.resolve_ref(ssh_config(ssh_server), db, REPO, "main") == SHA_MAIN
    assert ssh_server.commands == [f"{LS} main"]


async def test_a_full_sha_runs_nothing_but_needs_a_trusted_host(db, ssh_server):
    cfg = ssh_config(ssh_server)
    with pytest.raises(ssh.HostKeyUnknown):
        await gitref.resolve_ref(cfg, db, REPO, "a" * 40)
    await _trust(db, ssh_server)
    assert await gitref.resolve_ref(cfg, db, REPO, "ABCDEF" + "0" * 34) == "abcdef" + "0" * 34
    assert ssh_server.commands == []


async def test_resolve_errors(db, ssh_server):
    await _trust(db, ssh_server)
    cfg = ssh_config(ssh_server)
    for ref in ("-x", "a..b"):
        with pytest.raises(gitref.RefError) as exc:
            await gitref.resolve_ref(cfg, db, REPO, ref)
        assert exc.value.code == "ref_invalid"
    assert ssh_server.commands == []

    ssh_server.overrides[f"{LS} nope"] = ""
    with pytest.raises(gitref.RefError) as exc:
        await gitref.resolve_ref(cfg, db, REPO, "nope")
    assert exc.value.code == "ref_not_found"

    ssh_server.overrides[f"{LS} main"] = ""
    ssh_server.exits[f"{LS} main"] = 127
    with pytest.raises(gitref.RefError) as exc:
        await gitref.resolve_ref(cfg, db, REPO, "main")
    assert exc.value.code == "git_missing"

    ssh_server.exits[f"{LS} main"] = 128
    with pytest.raises(gitref.RefError) as exc:
        await gitref.resolve_ref(cfg, db, REPO, "main")
    assert exc.value.code == "ref_lookup_failed"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `.venv/bin/pytest -q tests/test_deploy_remote.py`
Expected: FAIL — `ImportError: cannot import name 'gitref' from 'sirdar_api.deploy'`

- [ ] **Step 4: Factor out the pinned connection and add `run_command`**

In `sirdar/api/src/sirdar_api/deploy/ssh.py`:

1. Rename `_load_client_key` to `load_client_key` (definition only; its one caller is rewritten below).
2. Add `RUN_TIMEOUT = 60` and `OUTPUT_LIMIT = 256 * 1024` next to the other constants at the top.
3. Replace everything from `async def test_connection(` to the end of the file with:

```python
@dataclass(frozen=True)
class PinnedHost:
    """A host whose live key matches the trusted one in ssh_known_hosts."""

    key: asyncssh.SSHKey
    key_type: str
    fingerprint: str
    public_key: str            # the stored OpenSSH public key line


async def pinned_host_key(db: AsyncSession, host: str, port: int) -> PinnedHost:
    """Fetch the live host key and compare it with the trusted one. Raises
    HostKeyUnknown, HostKeyMismatch or ConnectFailed; never logs in."""
    live = await known_hosts.fetch_host_key(host, port)
    actual, key_type = known_hosts.fingerprint(live), live.get_algorithm()
    stored = await known_hosts.lookup(db, host, port)
    if stored is None:
        raise HostKeyUnknown(host, port, key_type, actual)
    if stored.fingerprint_sha256 != actual:
        raise HostKeyMismatch(host, port, stored.fingerprint_sha256, actual, key_type)
    try:
        pinned = asyncssh.import_public_key(stored.public_key)
    except (asyncssh.KeyImportError, ValueError):
        raise ConnectFailed("Sirdar's saved key for this host is unreadable. "
                            "Forget the host and trust it again.") from None
    return PinnedHost(key=pinned, key_type=key_type, fingerprint=actual,
                      public_key=stored.public_key)


async def connect_pinned(cfg: SshTargetConfig,
                         pinned: PinnedHost) -> asyncssh.SSHClientConnection:
    """Log in, accepting only the pinned host key."""
    client_key = await load_client_key(cfg)
    try:
        return await asyncio.wait_for(asyncssh.connect(
            cfg.host, port=cfg.port, username=cfg.user, password=cfg.password,
            client_keys=[client_key] if client_key else None,
            # Pin the stored key: (trusted host keys, trusted CA keys, revoked keys).
            known_hosts=([pinned.key], [], []),
            agent_path=None, config=None, connect_timeout=CONNECT_TIMEOUT,
        ), CONNECT_TIMEOUT + 5)
    except asyncssh.PermissionDenied:
        raise ConnectFailed(_AUTH_FAILED) from None
    except asyncssh.HostKeyNotVerifiable:
        raise ConnectFailed("The server's host key changed during the test. Try again.") \
            from None
    except (OSError, TimeoutError, asyncssh.Error):
        raise known_hosts.unreachable(cfg.host, cfg.port) from None


async def test_connection(cfg: SshTargetConfig, db: AsyncSession, *,
                          target_id: str = "ssh") -> ConnectResult:
    pinned = await pinned_host_key(db, cfg.host, cfg.port)
    conn = await connect_pinned(cfg, pinned)
    async with conn:
        checks = await _checks(conn)
    facts = {"host": cfg.host, "port": cfg.port, "user": cfg.user, "auth": cfg.auth_label,
             "key_type": pinned.key_type, "fingerprint": pinned.fingerprint}
    return ConnectResult(ok=not any(c.status == "fail" for c in checks), target=target_id,
                         checks=checks, facts=facts)


test_connection.__test__ = False  # not a pytest test, despite the name


@dataclass(frozen=True)
class CommandResult:
    exit_status: int | None            # None: no answer in time
    stdout: str = field(repr=False)    # may hold secrets (an adopted .env)


async def run_command(cfg: SshTargetConfig, db: AsyncSession, command: str, *,
                      timeout: float = RUN_TIMEOUT) -> CommandResult:
    """Run one command on a pinned host and return its stdout (capped at
    OUTPUT_LIMIT) for the caller to parse. Callers quote every argument and
    never log the output."""
    pinned = await pinned_host_key(db, cfg.host, cfg.port)
    conn = await connect_pinned(cfg, pinned)
    async with conn:
        try:
            result = await asyncio.wait_for(
                conn.run(command, check=False, errors="replace"), timeout)
        except (OSError, TimeoutError, asyncssh.Error):
            return CommandResult(None, "")
    out = result.stdout if isinstance(result.stdout, str) else ""
    return CommandResult(result.exit_status, out[:OUTPUT_LIMIT])
```

- [ ] **Step 5: known_hosts lines**

Append to `sirdar/api/src/sirdar_api/deploy/known_hosts.py`:

```python
def openssh_line(host: str, port: int, public_key: str) -> str:
    """One OpenSSH known_hosts line that pins host:port to the stored key."""
    algorithm, blob = public_key.split()[:2]
    name = host if port == 22 else f"[{host}]:{port}"
    return f"{name} {algorithm} {blob}"


def host_key_algorithms(key_type: str) -> str:
    """ssh's HostKeyAlgorithms for a stored key. RSA keys sign with SHA-2:
    OpenSSH 8.8+ refuses ssh-rsa (SHA-1) signatures by default."""
    return "rsa-sha2-512,rsa-sha2-256" if key_type == "ssh-rsa" else key_type
```

- [ ] **Step 6: Ref resolution**

`sirdar/api/src/sirdar_api/deploy/gitref.py`:

```python
"""Resolve a git ref to a commit SHA by running `git ls-remote` on the
target: the target is what clones the repo, so its view is the one that
counts. A full 40-hex SHA is used as is (the host key is still checked)."""

import re
import shlex

from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.deploy import ConnectFailed, ssh
from sirdar_api.deploy.ssh import SshTargetConfig

LS_REMOTE_TIMEOUT = 60
SHA_RE = re.compile(r"[0-9a-f]{40}")
_ANY_SHA_RE = re.compile(r"[0-9a-fA-F]{40}")
# Branch and tag names: no leading "-", no "..", no shell or space characters.
_REF_RE = re.compile(r"(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}")


class RefError(Exception):
    """`code`: ref_invalid | ref_not_found | git_missing | ref_lookup_failed."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def valid_ref(ref: str) -> bool:
    return bool(_REF_RE.fullmatch(ref)) and not ref.endswith(("/", ".lock"))


def ls_remote_command(repo_url: str, ref: str) -> str:
    return f"git ls-remote {shlex.quote(repo_url)} {shlex.quote(ref)}"


def pick_sha(output: str, ref: str) -> str | None:
    """The commit for `ref` in ls-remote output: a branch first, then a tag
    (its peeled commit when listed), then an exact name such as HEAD."""
    found: dict[str, str] = {}
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) == 2 and SHA_RE.fullmatch(parts[0]):
            found[parts[1]] = parts[0]
    for name in (f"refs/heads/{ref}", f"refs/tags/{ref}^{{}}", f"refs/tags/{ref}", ref):
        if name in found:
            return found[name]
    return None


async def resolve_ref(cfg: SshTargetConfig, db: AsyncSession, repo_url: str, ref: str) -> str:
    if _ANY_SHA_RE.fullmatch(ref):
        await ssh.pinned_host_key(db, cfg.host, cfg.port)   # same host-key gate as a lookup
        return ref.lower()
    if not valid_ref(ref):
        raise RefError("ref_invalid")
    result = await ssh.run_command(cfg, db, ls_remote_command(repo_url, ref),
                                   timeout=LS_REMOTE_TIMEOUT)
    if result.exit_status is None:
        raise ConnectFailed("The target didn't answer git ls-remote in time.")
    if result.exit_status == 127:
        raise RefError("git_missing")
    if result.exit_status != 0:
        raise RefError("ref_lookup_failed")
    sha = pick_sha(result.stdout, ref)
    if sha is None:
        raise RefError("ref_not_found")
    return sha
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `.venv/bin/pytest -q tests/test_deploy_remote.py tests/test_deploy_ssh.py tests/test_deploy_api.py tests/test_deploy_ssh_targets_api.py`
Expected: PASS (all tests; the existing connection tests prove `test_connection` is unchanged)

- [ ] **Step 8: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/ssh.py sirdar/api/src/sirdar_api/deploy/known_hosts.py \
  sirdar/api/src/sirdar_api/deploy/gitref.py sirdar/api/tests/ssh_server.py \
  sirdar/api/tests/test_deploy_remote.py
git commit -m "feat(sirdar): pinned SSH run_command and git ref resolution on the target"
```

---
### Task 6: Step registry, playbooks and the Ansible dependencies

**Files:**
- Modify: `sirdar/api/pyproject.toml`
- Create: `sirdar/api/src/sirdar_api/deploy/steps.py`
- Create: `sirdar/api/src/sirdar_api/deploy/ansible/preflight.yml`, `bootstrap.yml`, `fetch.yml`, `render.yml`, `build.yml`, `dump.yml`, `reset.yml`, `up.yml`
- Test: `sirdar/api/tests/test_deploy_playbooks.py`

**Interfaces:**
- Produces: `steps.PLAYBOOK_DIR: Path`; `@dataclass(frozen=True) StepDef(number: int, key: str, name: str, playbook: str, timeout: int, modes: tuple[str, ...])`; `steps.STEPS` (8 entries, numbers 1–8); `steps.STEPS_BY_KEY: dict[str, StepDef]`; `steps.MODES = ("update", "reset")`; `steps.plan_for(mode: str) -> list[StepDef]` (raises `ValueError` for any other mode).
- Produces the playbook contract (extra vars every playbook may use): `env_name`, `env_dir`, `repo_url`, `sha`, `ss_stack`, `min_disk_gb`, `min_memory_mb`; `render.yml` also gets `env_file_b64` (base64 of the whole `.env`). Inventory host name: `target`. `dump.yml` reports `dump_path` through `set_stats` (empty when the database wasn't running).

- [ ] **Step 1: Add the dependencies and ship the playbooks with the package**

In `sirdar/api/pyproject.toml`, add to `dependencies` (after the asyncssh line):

```toml
    "ansible-core==2.21.4",    # deploy pipeline: ansible-playbook
    "ansible-runner==2.4.3",   # deploy pipeline: runs playbooks, streams events
```

and add after `[tool.setuptools.packages.find]`'s block:

```toml
[tool.setuptools.package-data]
"sirdar_api.deploy" = ["ansible/*.yml"]
```

Install (from `sirdar/api`): `.venv/bin/pip install -e '.[dev]'`
Expected: ends with `Successfully installed … ansible-core-2.21.4 … ansible-runner-2.4.3 …` and `.venv/bin/ansible-playbook --version` prints `ansible-playbook [core 2.21.4]`.

- [ ] **Step 2: Write the failing test**

`sirdar/api/tests/test_deploy_playbooks.py`:

```python
import os
import subprocess
import sys
from importlib import resources
from pathlib import Path

import pytest
import yaml

from sirdar_api.deploy import steps
from sirdar_api.deploy.steps import PLAYBOOK_DIR

ANSIBLE_PLAYBOOK = Path(sys.executable).parent / "ansible-playbook"
SHELL_MODULES = {"shell", "ansible.builtin.shell", "raw", "ansible.builtin.raw"}


def _tasks(playbook: str):
    plays = yaml.safe_load((PLAYBOOK_DIR / playbook).read_text())
    found: list[dict] = []

    def walk(tasks):
        for task in tasks or []:
            found.append(task)
            walk(task.get("block"))

    for play in plays:
        walk(play.get("tasks"))
    return plays, found


def test_plans():
    assert [s.number for s in steps.STEPS] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert [s.number for s in steps.plan_for("update")] == [1, 2, 3, 4, 5, 6, 8]
    assert [s.key for s in steps.plan_for("reset")] == [
        "preflight", "bootstrap", "fetch", "render", "build", "reset", "up"]
    with pytest.raises(ValueError):
        steps.plan_for("adopt")
    assert steps.STEPS_BY_KEY["up"].timeout >= 30 * 60
    assert steps.STEPS_BY_KEY["build"].timeout >= 60 * 60
    assert steps.STEPS_BY_KEY["up"].name == "Start services"


def test_every_playbook_belongs_to_a_step():
    assert sorted(p.name for p in PLAYBOOK_DIR.glob("*.yml")) == \
        sorted(s.playbook for s in steps.STEPS)


def test_playbooks_ship_with_the_package():
    folder = resources.files("sirdar_api.deploy").joinpath("ansible")
    for step in steps.STEPS:
        assert folder.joinpath(step.playbook).is_file()


@pytest.mark.parametrize("step", steps.STEPS, ids=lambda s: s.key)
def test_playbook_shape(step):
    plays, tasks = _tasks(step.playbook)
    assert len(plays) == 1 and plays[0]["hosts"] == "target"
    assert tasks
    for task in tasks:
        assert task.get("name"), f"{step.playbook}: every task needs a name"
        assert not SHELL_MODULES & set(task), f"{step.playbook}: {task['name']} uses a shell"
        if "env_file_b64" in yaml.safe_dump(task) and "block" not in task:
            assert task.get("no_log") is True, f"{step.playbook}: {task['name']} needs no_log"


@pytest.mark.parametrize("step", steps.STEPS, ids=lambda s: s.key)
def test_syntax_check(step, tmp_path):
    cfg = tmp_path / "ansible.cfg"
    cfg.write_text("[defaults]\n")
    env = {**os.environ, "ANSIBLE_CONFIG": str(cfg), "ANSIBLE_HOME": str(tmp_path),
           "ANSIBLE_LOCAL_TEMP": str(tmp_path / "tmp"), "ANSIBLE_NOCOLOR": "1"}
    result = subprocess.run(
        [str(ANSIBLE_PLAYBOOK), "--syntax-check", "-i", "target,",
         str(PLAYBOOK_DIR / step.playbook)],
        capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
    assert result.returncode == 0, result.stdout + result.stderr
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `.venv/bin/pytest -q tests/test_deploy_playbooks.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'sirdar_api.deploy.steps'`

- [ ] **Step 4: The step registry**

`sirdar/api/src/sirdar_api/deploy/steps.py`:

```python
"""The deploy steps (spec Section 2) and which run in each mode. Spec steps
8–11 (start data services, restore, migrate, start the app) are one step
here, "Start services": `ss-stack up` already starts db → storage →
migrate → api → web → status and waits on health. Snapshot restore is
phase 3; DNS, proxy and smoke tests (12–14) are phase 4."""

from dataclasses import dataclass
from pathlib import Path

PLAYBOOK_DIR = Path(__file__).resolve().parent / "ansible"
MODES = ("update", "reset")
_BOTH = ("update", "reset")


@dataclass(frozen=True)
class StepDef:
    number: int
    key: str
    name: str
    playbook: str
    timeout: int                 # seconds for the whole playbook run
    modes: tuple[str, ...]


STEPS: tuple[StepDef, ...] = (
    StepDef(1, "preflight", "Preflight", "preflight.yml", 5 * 60, _BOTH),
    StepDef(2, "bootstrap", "Bootstrap", "bootstrap.yml", 30 * 60, _BOTH),
    StepDef(3, "fetch", "Fetch code", "fetch.yml", 15 * 60, _BOTH),
    StepDef(4, "render", "Render config", "render.yml", 5 * 60, _BOTH),
    StepDef(5, "build", "Build images", "build.yml", 90 * 60, _BOTH),
    StepDef(6, "dump", "Pre-deploy dump", "dump.yml", 30 * 60, ("update",)),
    StepDef(7, "reset", "Reset data", "reset.yml", 15 * 60, ("reset",)),
    StepDef(8, "up", "Start services", "up.yml", 45 * 60, _BOTH),
)
STEPS_BY_KEY = {s.key: s for s in STEPS}


def plan_for(mode: str) -> list[StepDef]:
    if mode not in MODES:
        raise ValueError(f"unknown deploy mode: {mode}")
    return [s for s in STEPS if mode in s.modes]
```

- [ ] **Step 5: The playbooks**

`sirdar/api/src/sirdar_api/deploy/ansible/preflight.yml`:

```yaml
# Step 1 — Preflight. Changes nothing: checks that the host can take an
# environment before any other step touches it. Sudo must work, because
# Bootstrap needs it.
- name: Preflight
  hosts: target
  gather_facts: true
  tasks:
    - name: Ubuntu or Debian
      ansible.builtin.assert:
        that: ansible_facts['os_family'] == 'Debian'
        fail_msg: >-
          Sirdar deploys to Ubuntu or Debian hosts; this one runs
          {{ ansible_facts['distribution'] }}.
        quiet: true

    - name: Read the free space on /
      ansible.builtin.command:
        argv: [df, -Pk, /]
      register: df_root
      changed_when: false

    - name: Enough free disk
      ansible.builtin.assert:
        that: (df_root.stdout_lines[-1].split()[3] | int) >= (min_disk_gb | int) * 1048576
        fail_msg: "Less than {{ min_disk_gb }} GB free on /."
        quiet: true

    - name: Enough memory
      ansible.builtin.assert:
        that: (ansible_facts['memtotal_mb'] | int) >= (min_memory_mb | int)
        fail_msg: "Less than {{ min_memory_mb }} MB of memory."
        quiet: true

    - name: Sudo works
      ansible.builtin.command:
        argv: [id, -u]
      become: true
      register: root_id
      changed_when: false

    - name: Sudo gives root
      ansible.builtin.assert:
        that: root_id.stdout == '0'
        fail_msg: "sudo didn't give root on this host."
        quiet: true

    - name: Look for Docker
      ansible.builtin.command:
        argv: [docker, --version]
      register: docker_version
      changed_when: false
      failed_when: false

    - name: Summary
      ansible.builtin.debug:
        msg: >-
          Preflight passed: {{ ansible_facts['distribution'] }}
          {{ ansible_facts['distribution_version'] }},
          {{ ((df_root.stdout_lines[-1].split()[3] | int) / 1048576) | round(1) }} GB free,
          {{ ansible_facts['memtotal_mb'] }} MB memory, Docker
          {{ 'present' if docker_version.rc == 0 else 'missing (Bootstrap installs it)' }}.
```

`sirdar/api/src/sirdar_api/deploy/ansible/bootstrap.yml`:

```yaml
# Step 2 — Bootstrap. Idempotent: installs what is missing (git, Docker with
# the Compose plugin), lets the SSH user run docker, and creates the
# environment folder owned by that user. Root work goes through sudo.
- name: Bootstrap
  hosts: target
  gather_facts: true
  tasks:
    - name: Base packages
      ansible.builtin.apt:
        name: [git, ca-certificates, curl]
        state: present
        update_cache: true
        cache_valid_time: 3600
      become: true

    - name: Look for Docker
      ansible.builtin.command:
        argv: [docker, --version]
      register: docker_cli
      changed_when: false
      failed_when: false

    - name: Look for the Compose plugin
      ansible.builtin.command:
        argv: [docker, compose, version]
      register: compose_cli
      changed_when: false
      failed_when: false

    - name: Install Docker
      when: docker_cli.rc != 0 or compose_cli.rc != 0
      become: true
      block:
        - name: Download the Docker install script
          ansible.builtin.get_url:
            url: https://get.docker.com
            dest: /root/sirdar-get-docker.sh
            mode: "0700"

        - name: Run the Docker install script
          ansible.builtin.command:
            argv: [sh, /root/sirdar-get-docker.sh]

        - name: Remove the install script
          ansible.builtin.file:
            path: /root/sirdar-get-docker.sh
            state: absent

    - name: Docker starts on boot
      ansible.builtin.systemd_service:
        name: docker
        state: started
        enabled: true
      become: true

    - name: The SSH user may run docker
      ansible.builtin.user:
        name: "{{ ansible_facts['user_id'] }}"
        groups: [docker]
        append: true
      become: true
      when: ansible_facts['user_id'] != 'root'

    - name: Environments folder
      ansible.builtin.file:
        path: /opt/serversherpa
        state: directory
        owner: root
        group: root
        mode: "0755"
      become: true

    - name: Environment folder, owned by the SSH user
      ansible.builtin.file:
        path: "{{ env_dir }}"
        state: directory
        owner: "{{ ansible_facts['user_id'] }}"
        mode: "0750"
      become: true

    - name: Pick up the docker group on the next connection
      ansible.builtin.meta: reset_connection

    - name: Docker answers without sudo
      ansible.builtin.command:
        argv: [docker, ps, --quiet]
      changed_when: false
```

`sirdar/api/src/sirdar_api/deploy/ansible/fetch.yml`:

```yaml
# Step 3 — Fetch code: the environment's checkout at exactly the deployment's
# commit. Points origin at the configured repo URL; never discards local
# changes in the checkout (force: false fails instead).
- name: Fetch code
  hosts: target
  gather_facts: false
  tasks:
    - name: Check out the commit
      ansible.builtin.git:
        repo: "{{ repo_url }}"
        dest: "{{ env_dir }}/repo"
        version: "{{ sha }}"
        force: false
      register: checkout

    - name: The checkout is at the commit
      ansible.builtin.assert:
        that: checkout.after == sha
        fail_msg: "The checkout is at {{ checkout.after }}, not {{ sha }}."
        quiet: true
```

`sirdar/api/src/sirdar_api/deploy/ansible/render.yml`:

```yaml
# Step 4 — Render config: the environment's .env (mode 600) from Sirdar's
# record. It arrives base64-encoded so no value is ever read as a template,
# and it carries every secret, so the task is no_log.
- name: Render config
  hosts: target
  gather_facts: false
  tasks:
    - name: Backups folder
      ansible.builtin.file:
        path: "{{ env_dir }}/backups"
        state: directory
        mode: "0700"

    - name: Write .env
      ansible.builtin.copy:
        content: "{{ env_file_b64 | b64decode }}"
        dest: "{{ env_dir }}/.env"
        mode: "0600"
      no_log: true
```

`sirdar/api/src/sirdar_api/deploy/ansible/build.yml`:

```yaml
# Step 5 — Build every image at the deployment's tag. Running containers
# keep serving the old images until Start services.
- name: Build images
  hosts: target
  gather_facts: false
  tasks:
    - name: ss-stack build
      ansible.builtin.command:
        argv: ["{{ ss_stack }}", build, "{{ env_dir }}"]
```

`sirdar/api/src/sirdar_api/deploy/ansible/dump.yml`:

```yaml
# Step 6 — Pre-deploy dump (Update only). Skipped when the environment's
# database isn't running yet (a first deploy has nothing to dump). Reports
# the dump's path to Sirdar through set_stats.
- name: Pre-deploy dump
  hosts: target
  gather_facts: false
  tasks:
    - name: Is the database running?
      ansible.builtin.command:
        argv:
          - docker
          - ps
          - --quiet
          - --filter
          - "label=com.docker.compose.project=ss-{{ env_name }}-db"
          - --filter
          - status=running
      register: db_running
      changed_when: false

    - name: ss-stack dump
      ansible.builtin.command:
        argv: ["{{ ss_stack }}", dump, "{{ env_dir }}"]
      register: dump
      when: db_running.stdout | length > 0

    - name: Report the dump path
      ansible.builtin.set_stats:
        data:
          dump_path: "{{ dump.stdout_lines[-1] if dump is not skipped else '' }}"
        per_host: false
        aggregate: true
```

`sirdar/api/src/sirdar_api/deploy/ansible/reset.yml`:

```yaml
# Step 7 — Reset data (Reset only): stop every stack and delete its volumes.
# The next step starts the environment empty.
- name: Reset data
  hosts: target
  gather_facts: false
  tasks:
    - name: ss-stack down --volumes
      ansible.builtin.command:
        argv: ["{{ ss_stack }}", down, "{{ env_dir }}", --volumes]
```

`sirdar/api/src/sirdar_api/deploy/ansible/up.yml`:

```yaml
# Step 8 — Start services: ss-stack up starts db, storage, the migrate job,
# api + workers, web and status in order and waits on their health checks.
- name: Start services
  hosts: target
  gather_facts: false
  tasks:
    - name: ss-stack up
      ansible.builtin.command:
        argv: ["{{ ss_stack }}", up, "{{ env_dir }}"]
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/pytest -q tests/test_deploy_playbooks.py`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add sirdar/api/pyproject.toml sirdar/api/src/sirdar_api/deploy/steps.py \
  sirdar/api/src/sirdar_api/deploy/ansible sirdar/api/tests/test_deploy_playbooks.py
git commit -m "feat(sirdar): deploy steps 1-8 as Ansible playbooks; pin ansible-core and ansible-runner"
```

---

### Task 7: Redaction and the runner

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/redact.py`
- Create: `sirdar/api/src/sirdar_api/deploy/runner.py`
- Create: `sirdar/api/tests/fake_runner.py`
- Test: `sirdar/api/tests/test_deploy_runner.py`

**Interfaces:**
- Consumes: `steps.PLAYBOOK_DIR` (Task 6).
- Produces (`redact`): `REDACTED = "[redacted]"`, `MIN_SECRET_LENGTH = 4`, `class Redactor(secrets: Iterable[str])` callable `(text: str) -> str`.
- Verified before writing this plan (scratch venv with the pinned versions, real Ubuntu 24.04 SSH container): the eight playbooks pass `--syntax-check`; this runner ran Preflight over password auth with sudo, Render over key auth twice (`changed` 2 then 0, `.env` mode 600, no secret in the output), `set_stats` data arrives as `artifact_data`, and a wrong pinned key is refused. ansible-runner's `binary=` option must NOT be used: it switches to raw mode and drops the playbook argument, hence the PATH entry. Ansible refuses non-blocking stdio, so subprocess calls give it `stdin=subprocess.DEVNULL`.
- Produces (`runner`): `RunStatus = Literal["successful", "failed", "timeout", "canceled"]`; `@dataclass(frozen=True) RunTarget(host: str, port: int, user: str, known_hosts_line: str, host_key_algorithms: str, password: str | None = None, private_key: str | None = None, become_password: str | None = None)` (the three secrets hidden from repr; `private_key` = unencrypted OpenSSH key text); `@dataclass(frozen=True) RunRequest(step: str, playbook: str, target: RunTarget, timeout: int, extravars: dict = {})` (extravars hidden from repr); `@dataclass(frozen=True) RunResult(status: RunStatus, rc: int, changed: int = 0, data: dict = {})`; `class Runner(Protocol)`: `async run(request: RunRequest, on_output: Callable[[str], None]) -> RunResult`; `class AnsibleRunner(runner_dir: str)` with `prepare(request) -> Path`, `envvars(run_dir: Path, target: RunTarget) -> dict[str, str]`, `async run(...)`; `ansible_playbook_binary() -> str`; `CANCEL_GRACE_SECONDS = 30`.
- Produces (tests): `FakeRunner` with `requests: list[RunRequest]`, `results: dict[str, RunResult]`, `output: dict[str, list[str]]`, `raises: dict[str, Exception]`, `gates: dict[str, asyncio.Event]`, `started: defaultdict[str, asyncio.Event]`, `steps() -> list[str]`, `async run(request, on_output)`. Default output per step: `"ok: [target] <step>\n"`; default result: `RunResult(status="successful", rc=0)`.
- Contract: the runner passes output through raw; the caller (pipeline) redacts. `on_output` may be called from a worker thread.

- [ ] **Step 1: Write the failing test**

`sirdar/api/tests/test_deploy_runner.py`:

```python
import asyncio
import json
import os
import shutil
import stat
import time
from pathlib import Path
from types import SimpleNamespace

import ansible_runner
import pytest

from sirdar_api.deploy import runner as runner_mod
from sirdar_api.deploy.redact import REDACTED, Redactor
from sirdar_api.deploy.runner import AnsibleRunner, RunRequest, RunResult, RunTarget

PW = "ssh-PW-runner-1"
SUDO = "sudo-PW-runner-2"
KEY_TEXT = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
B64 = "c2VjcmV0LWVudi1maWxl"


def _target(**over) -> RunTarget:
    kw = dict(host="10.0.0.5", port=2222, user="deployer",
              known_hosts_line="[10.0.0.5]:2222 ssh-ed25519 AAAAC3",
              host_key_algorithms="ssh-ed25519", password=PW, private_key=KEY_TEXT,
              become_password=SUDO)
    kw.update(over)
    return RunTarget(**kw)


def _request(**over) -> RunRequest:
    kw = dict(step="render", playbook="render.yml", target=_target(), timeout=300,
              extravars={"env_name": "uat", "env_file_b64": B64})
    kw.update(over)
    return RunRequest(**kw)


def _mode(path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def test_redactor():
    redact = Redactor(["s3cret-value", "s3cret", "", "abc", None])
    assert redact("x s3cret-value y s3cret z abc") == f"x {REDACTED} y {REDACTED} z abc"
    assert Redactor([])("plain") == "plain"
    assert Redactor(["a.b.c"])("a.b.c axbxc") == f"{REDACTED} axbxc"   # literal, not a regex


def test_reprs_hide_secrets():
    text = repr(_request())
    for secret in (PW, SUDO, KEY_TEXT, B64):
        assert secret not in text


def test_prepare_writes_private_files(tmp_path):
    runner = AnsibleRunner(str(tmp_path / "runner"))
    run_dir = runner.prepare(_request())
    try:
        assert _mode(tmp_path / "runner") == 0o700
        assert _mode(run_dir) == 0o700
        for name in ("known_hosts", "id_key", "env/extravars", "inventory/hosts.json",
                     "ansible.cfg"):
            assert _mode(run_dir / name) == 0o600, name
        assert (run_dir / "known_hosts").read_text() == "[10.0.0.5]:2222 ssh-ed25519 AAAAC3\n"
        assert (run_dir / "id_key").read_text() == KEY_TEXT + "\n"
        assert json.loads((run_dir / "env" / "extravars").read_text()) == {
            "env_name": "uat", "env_file_b64": B64, "ansible_password": PW,
            "ansible_become_password": SUDO}
        assert json.loads((run_dir / "inventory" / "hosts.json").read_text()) == {
            "all": {"hosts": {"target": {
                "ansible_host": "10.0.0.5", "ansible_port": 2222, "ansible_user": "deployer",
                "ansible_ssh_private_key_file": str(run_dir / "id_key")}}}}
        assert (run_dir / "project" / "render.yml").is_file()
    finally:
        shutil.rmtree(run_dir)


def test_prepare_without_password_or_key(tmp_path):
    runner = AnsibleRunner(str(tmp_path / "runner"))
    run_dir = runner.prepare(_request(target=_target(password=None, private_key=None,
                                                     become_password=None)))
    try:
        assert not (run_dir / "id_key").exists()
        extravars = json.loads((run_dir / "env" / "extravars").read_text())
        assert "ansible_password" not in extravars
        assert "ansible_become_password" not in extravars
        hosts = json.loads((run_dir / "inventory" / "hosts.json").read_text())
        assert "ansible_ssh_private_key_file" not in hosts["all"]["hosts"]["target"]
    finally:
        shutil.rmtree(run_dir)


def test_failed_prepare_leaves_nothing(tmp_path, monkeypatch):
    def boom(*a, **kw):
        raise OSError("disk full")
    monkeypatch.setattr(runner_mod.shutil, "copytree", boom)
    with pytest.raises(OSError):
        AnsibleRunner(str(tmp_path / "runner")).prepare(_request())
    assert list((tmp_path / "runner").iterdir()) == []


def test_envvars_pin_the_host_key(tmp_path):
    run_dir = tmp_path / "run-x"
    env = AnsibleRunner(str(tmp_path)).envvars(run_dir, _target())
    args = env["ANSIBLE_SSH_ARGS"]
    for part in (f"-o UserKnownHostsFile={run_dir / 'known_hosts'}",
                 "-o StrictHostKeyChecking=yes", "-o GlobalKnownHostsFile=/dev/null",
                 "-o HostKeyAlgorithms=ssh-ed25519", "-F /dev/null", "-o ControlMaster=no",
                 "-o IdentitiesOnly=yes"):
        assert part in args, part
    assert env["ANSIBLE_HOST_KEY_CHECKING"] == "True"
    assert env["ANSIBLE_CONFIG"] == str(run_dir / "ansible.cfg")
    assert env["ANSIBLE_HOME"] == str(run_dir / "home")
    assert env["ANSIBLE_PIPELINING"] == "False"
    assert env["PATH"].split(os.pathsep)[0] == str(
        Path(runner_mod.ansible_playbook_binary()).parent)


def test_ansible_playbook_binary():
    assert Path(runner_mod.ansible_playbook_binary()).is_file()


async def test_run_streams_output_reports_stats_and_cleans_up(tmp_path, monkeypatch):
    seen: dict = {}

    def fake_run(**kw):
        run_dir = Path(kw["private_data_dir"])
        seen["dir"], seen["kw"] = run_dir, kw
        assert (run_dir / "env" / "extravars").is_file()
        seen["keep"] = kw["event_handler"]({"event": "runner_on_ok",
                                            "stdout": "ok: [target]"})
        kw["event_handler"]({"event": "playbook_on_stats", "stdout": "PLAY RECAP",
                             "event_data": {"changed": {"target": 2},
                                            "artifact_data": {"dump_path": "/x.dump"}}})
        kw["event_handler"]({"event": "verbose", "stdout": ""})
        return SimpleNamespace(status="successful", rc=0)

    monkeypatch.setattr(ansible_runner, "run", fake_run)
    lines: list[str] = []
    result = await AnsibleRunner(str(tmp_path / "runner")).run(_request(), lines.append)
    assert result == RunResult(status="successful", rc=0, changed=2,
                               data={"dump_path": "/x.dump"})
    assert lines == ["ok: [target]\n", "PLAY RECAP\n"]
    assert seen["keep"] is False                  # no event files on disk
    assert not seen["dir"].exists()
    kw = seen["kw"]
    assert (kw["playbook"], kw["timeout"], kw["quiet"]) == ("render.yml", 300, True)
    assert "binary" not in kw                     # raw mode would drop the playbook
    assert "UserKnownHostsFile" in kw["envvars"]["ANSIBLE_SSH_ARGS"]


@pytest.mark.parametrize("status, rc, expected", [
    ("failed", 2, ("failed", 2)), ("timeout", 254, ("timeout", 254)),
    ("error", None, ("failed", -1))])
async def test_run_status_mapping(tmp_path, monkeypatch, status, rc, expected):
    monkeypatch.setattr(ansible_runner, "run",
                        lambda **kw: SimpleNamespace(status=status, rc=rc))
    result = await AnsibleRunner(str(tmp_path / "runner")).run(_request(), lambda s: None)
    assert (result.status, result.rc) == expected


async def test_cancel_stops_the_run_and_cleans_up(tmp_path, monkeypatch):
    state: dict = {}

    def fake_run(**kw):
        state["dir"] = Path(kw["private_data_dir"])
        while not kw["cancel_callback"]():
            time.sleep(0.01)
        state["cancelled"] = True
        return SimpleNamespace(status="canceled", rc=254)

    monkeypatch.setattr(ansible_runner, "run", fake_run)
    task = asyncio.create_task(
        AnsibleRunner(str(tmp_path / "runner")).run(_request(), lambda s: None))
    while "dir" not in state:
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert state["cancelled"] is True
    assert not state["dir"].exists()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest -q tests/test_deploy_runner.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'sirdar_api.deploy.redact'`

- [ ] **Step 3: Redaction**

`sirdar/api/src/sirdar_api/deploy/redact.py`:

```python
"""Replace every known secret value in text with [redacted] before it is
stored or shown. Values shorter than MIN_SECRET_LENGTH are left alone:
they would blank out ordinary words."""

import re
from collections.abc import Iterable

REDACTED = "[redacted]"
MIN_SECRET_LENGTH = 4


class Redactor:
    def __init__(self, secrets: Iterable[str | None]):
        values = {s for s in secrets if s and len(s) >= MIN_SECRET_LENGTH}
        # Longest first, so a secret that contains another is replaced whole.
        ordered = sorted(values, key=len, reverse=True)
        self._pattern = re.compile("|".join(map(re.escape, ordered))) if ordered else None

    def __call__(self, text: str) -> str:
        return self._pattern.sub(REDACTED, text) if self._pattern else text
```

- [ ] **Step 4: The runner**

`sirdar/api/src/sirdar_api/deploy/runner.py`:

```python
"""Runs one deploy step's playbook on a target. The pipeline depends only
on the Runner protocol, so tests swap in a fake; AnsibleRunner drives
ansible-runner in a worker thread.

Each run gets a private folder (mode 700) under SIRDAR_RUNNER_DIR holding a
copy of the playbooks, the inventory, a known_hosts file that pins the
target's trusted host key, the extra vars (secrets included, mode 600) and,
for key auth, a decrypted copy of the SSH key (mode 600). The folder is
deleted when the run ends, however it ends. Event files are never written
(the event handler returns False), so task output never lands on disk
outside that folder. Output is passed to on_output raw: the caller redacts."""

import asyncio
import json
import os
import shlex
import shutil
import sys
import tempfile
import threading
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

from sirdar_api.deploy.steps import PLAYBOOK_DIR

RunStatus = Literal["successful", "failed", "timeout", "canceled"]
_STATUSES = ("successful", "failed", "timeout", "canceled")
CANCEL_GRACE_SECONDS = 30


@dataclass(frozen=True)
class RunTarget:
    host: str
    port: int
    user: str
    known_hosts_line: str
    host_key_algorithms: str
    password: str | None = field(default=None, repr=False)
    private_key: str | None = field(default=None, repr=False)   # unencrypted OpenSSH text
    become_password: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class RunRequest:
    step: str
    playbook: str
    target: RunTarget
    timeout: int
    extravars: dict = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class RunResult:
    status: RunStatus
    rc: int
    changed: int = 0
    data: dict = field(default_factory=dict)      # set_stats data (aggregate)


class Runner(Protocol):
    async def run(self, request: RunRequest,
                  on_output: Callable[[str], None]) -> RunResult: ...


def ansible_playbook_binary() -> str:
    """ansible-playbook beside this interpreter (a venv's bin/), else PATH."""
    beside = Path(sys.executable).parent / "ansible-playbook"
    if beside.is_file():
        return str(beside)
    found = shutil.which("ansible-playbook")
    if found is None:
        raise RuntimeError("ansible-playbook is not installed")
    return found


def _write_private(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)


class AnsibleRunner:
    def __init__(self, runner_dir: str):
        self.runner_dir = Path(runner_dir)

    def prepare(self, request: RunRequest) -> Path:
        self.runner_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.runner_dir, 0o700)
        run_dir = Path(tempfile.mkdtemp(prefix="run-", dir=self.runner_dir))   # mode 700
        try:
            for sub in ("env", "inventory", "home", "tmp"):
                (run_dir / sub).mkdir(mode=0o700)
            shutil.copytree(PLAYBOOK_DIR, run_dir / "project")
            t = request.target
            _write_private(run_dir / "known_hosts", t.known_hosts_line + "\n")
            host: dict = {"ansible_host": t.host, "ansible_port": t.port,
                          "ansible_user": t.user}
            if t.private_key is not None:
                key_file = run_dir / "id_key"
                text = t.private_key if t.private_key.endswith("\n") else t.private_key + "\n"
                _write_private(key_file, text)
                host["ansible_ssh_private_key_file"] = str(key_file)
            _write_private(run_dir / "inventory" / "hosts.json",
                           json.dumps({"all": {"hosts": {"target": host}}}))
            extravars = dict(request.extravars)
            if t.password is not None:
                extravars["ansible_password"] = t.password
            if t.become_password is not None:
                extravars["ansible_become_password"] = t.become_password
            _write_private(run_dir / "env" / "extravars", json.dumps(extravars))
            # An empty config: nothing from /etc/ansible or the working folder applies.
            _write_private(run_dir / "ansible.cfg", "[defaults]\n")
        except BaseException:
            shutil.rmtree(run_dir, ignore_errors=True)
            raise
        return run_dir

    def envvars(self, run_dir: Path, target: RunTarget) -> dict[str, str]:
        known = shlex.quote(str(run_dir / "known_hosts"))
        ssh_args = " ".join([
            "-F /dev/null",                       # no user or system ssh_config
            "-o ControlMaster=no", "-o ControlPersist=no",
            f"-o UserKnownHostsFile={known}", "-o GlobalKnownHostsFile=/dev/null",
            "-o StrictHostKeyChecking=yes",
            f"-o HostKeyAlgorithms={target.host_key_algorithms}",
            "-o IdentitiesOnly=yes",
            "-o ServerAliveInterval=30", "-o ServerAliveCountMax=10",
        ])
        return {
            # ansible-runner starts "ansible-playbook" through PATH (its
            # `binary` option would switch it to raw mode and drop the
            # playbook argument): put this interpreter's copy first.
            "PATH": os.pathsep.join([str(Path(ansible_playbook_binary()).parent),
                                     os.environ.get("PATH", "")]),
            "ANSIBLE_CONFIG": str(run_dir / "ansible.cfg"),
            "ANSIBLE_HOME": str(run_dir / "home"),
            "ANSIBLE_LOCAL_TEMP": str(run_dir / "tmp"),
            "ANSIBLE_SSH_ARGS": ssh_args,
            "ANSIBLE_HOST_KEY_CHECKING": "True",
            "ANSIBLE_PIPELINING": "False",
            "ANSIBLE_TIMEOUT": "30",
            "ANSIBLE_PYTHON_INTERPRETER": "auto_silent",
            "ANSIBLE_NOCOLOR": "1",
            "ANSIBLE_FORCE_COLOR": "0",
            "ANSIBLE_RETRY_FILES_ENABLED": "False",
            "ANSIBLE_DEPRECATION_WARNINGS": "False",
        }

    def _run_sync(self, run_dir: Path, request: RunRequest,
                  on_output: Callable[[str], None], cancel: threading.Event) -> RunResult:
        import ansible_runner   # imported here: heavy, and only a real run needs it

        stats: dict = {}

        def event_handler(event: dict) -> bool:
            text = event.get("stdout") or ""
            if text:
                on_output(text + "\n")
            if event.get("event") == "playbook_on_stats":
                data = event.get("event_data") or {}
                stats["changed"] = sum((data.get("changed") or {}).values())
                stats["data"] = dict(data.get("artifact_data") or {})
            return False                          # never write event files

        result = ansible_runner.run(
            private_data_dir=str(run_dir), playbook=request.playbook, ident="run",
            envvars=self.envvars(run_dir, request.target), event_handler=event_handler,
            cancel_callback=cancel.is_set, timeout=request.timeout, quiet=True)
        status = result.status if result.status in _STATUSES else "failed"
        rc = result.rc if isinstance(result.rc, int) else -1
        return RunResult(status=status, rc=rc, changed=stats.get("changed", 0),
                         data=stats.get("data", {}))

    async def run(self, request: RunRequest,
                  on_output: Callable[[str], None]) -> RunResult:
        run_dir = await asyncio.to_thread(self.prepare, request)
        cancel = threading.Event()
        work = asyncio.ensure_future(
            asyncio.to_thread(self._run_sync, run_dir, request, on_output, cancel))
        try:
            return await asyncio.shield(work)
        except asyncio.CancelledError:
            cancel.set()                          # ansible-runner polls this and stops
            with suppress(BaseException):
                await asyncio.wait_for(asyncio.shield(work), CANCEL_GRACE_SECONDS)
            raise
        finally:
            if work.done():
                shutil.rmtree(run_dir, ignore_errors=True)
            else:                                 # still stopping: clean up when it does
                work.add_done_callback(lambda _: shutil.rmtree(run_dir, ignore_errors=True))
```

- [ ] **Step 5: The fake runner for later tests**

`sirdar/api/tests/fake_runner.py`:

```python
"""A Runner for pipeline and API tests: records every request and answers
from canned results (default: success), with optional output, errors and
gates (an Event the step waits on, to test the lock and cancel)."""

import asyncio
from collections import defaultdict

from sirdar_api.deploy.runner import RunRequest, RunResult


class FakeRunner:
    def __init__(self):
        self.requests: list[RunRequest] = []
        self.results: dict[str, RunResult] = {}
        self.output: dict[str, list[str]] = {}
        self.raises: dict[str, Exception] = {}
        self.gates: dict[str, asyncio.Event] = {}
        self.started: defaultdict[str, asyncio.Event] = defaultdict(asyncio.Event)

    def steps(self) -> list[str]:
        return [r.step for r in self.requests]

    async def run(self, request: RunRequest, on_output) -> RunResult:
        self.requests.append(request)
        self.started[request.step].set()
        if request.step in self.raises:
            raise self.raises[request.step]
        for line in self.output.get(request.step, [f"ok: [target] {request.step}\n"]):
            on_output(line)
        if request.step in self.gates:
            await self.gates[request.step].wait()
        return self.results.get(request.step, RunResult(status="successful", rc=0))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/pytest -q tests/test_deploy_runner.py`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/redact.py sirdar/api/src/sirdar_api/deploy/runner.py \
  sirdar/api/tests/fake_runner.py sirdar/api/tests/test_deploy_runner.py
git commit -m "feat(sirdar): ansible-runner step runner with pinned known_hosts and private run dirs"
```

---
### Task 8: The pipeline engine

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/pipeline.py`
- Modify: `sirdar/api/src/sirdar_api/api/app.py` (`_lifespan`, add a logger)
- Create: `sirdar/api/tests/deploy_factories.py`
- Test: `sirdar/api/tests/test_deploy_pipeline.py`

**Interfaces:**
- Consumes: models (Task 3); `envfile`, `vault` (Tasks 1–2); `targets.ssh_config_for`, `ssh.pinned_host_key`, `ssh.load_client_key`, `ssh.MIN_DISK_GB`, `known_hosts.openssh_line`, `known_hosts.host_key_algorithms` (Tasks 4–5); `steps.STEPS_BY_KEY`, `steps.plan_for` (Task 6); `Redactor`, `RunRequest`, `RunResult`, `RunTarget`, `Runner`, `AnsibleRunner` (Task 7).
- Produces (`pipeline`):
  - constants `LOG_LIMIT = 262144`, `FLUSH_SECONDS = 2.0`, `MIN_MEMORY_MB = 1800`, `RETRYABLE_STATUSES = ("failed", "cancelled", "interrupted")`, `INTERRUPTED`, `CANCELLED`, `UNEXPECTED` (copy strings);
  - `class DeployInProgress(Exception)`; `class PrepareError(Exception)` with `.reason`;
  - `make_runner(settings) -> Runner` (tests monkeypatch this);
  - `async create_deployment(db, env, *, mode: str, git_ref: str, sha: str, actor_id: UUID | None, start_step: int = 1, retry_of: UUID | None = None) -> Deployment` (flushes, sets `env.status = "deploying"`, adds one step row per planned step — `skipped` below `start_step`, else `pending`; raises `DeployInProgress`; caller commits, then calls `launch`);
  - `launch(deployment_id) -> asyncio.Task`; `is_active(deployment_id) -> bool`; `async wait(deployment_id, timeout: float = 30.0) -> None`; `request_cancel(deployment_id) -> bool`; `async close_orphan(deployment_id) -> None`; `async shutdown(timeout: float = 10.0) -> None`; `async recover_orphans() -> int`.
- Produces (tests, `deploy_factories`): `SECRETS_KEY`, `ENV_SECRETS` (the six required secrets), fixtures `secrets_key`, `fake_runner` (a `FakeRunner` installed as `pipeline.make_runner`), autouse `stop_pipeline`; helpers `async trust_fake(db, fake)`, `async make_environment(db, *, name="uat", target_id="ssh", host="127.0.0.1", status="ready", current_sha=None, secrets=None) -> Environment`.
- Outcome rules: success → deployment `succeeded`, environment `ready` with `current_sha` and `image_tag`; failure → step `failed`, later steps `not_run`, deployment `failed` with `failed_step` and `error`, environment `failed`; cancel → step and deployment `cancelled`; shutdown or restart → `interrupted`. Errors in `error` and the step log are our copy.

- [ ] **Step 1: Shared test fixtures**

`sirdar/api/tests/deploy_factories.py`:

```python
"""Shared fixtures and builders for the deploy pipeline tests (phase 2a)."""

import pytest
from cryptography.fernet import Fernet

from sirdar_api.config import get_settings
from sirdar_api.db.models import Environment, EnvironmentSecret, EnvironmentService
from sirdar_api.deploy import envfile, known_hosts, pipeline, vault

from .fake_runner import FakeRunner

SECRETS_KEY = Fernet.generate_key().decode()
ENV_SECRETS = {
    "POSTGRES_PASSWORD": "pg-SECRET-0a1b2c3d4e5f",
    "SPACES_SECRET_KEY": "spaces-SECRET-6a7b8c9d",
    "SS_JWT_SECRET": "jwt-SECRET-0f1e2d3c4b5a",
    "SS_TOTP_ENCRYPTION_KEY": Fernet.generate_key().decode(),
    "SS_PASSWORD_PEPPER": "pepper-SECRET-99887766",
    "SS_WIKI_SERVICE_TOKEN": "wiki-SECRET-55443322",
}


@pytest.fixture
def secrets_key(monkeypatch):
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", SECRETS_KEY)
    get_settings.cache_clear()
    yield SECRETS_KEY
    get_settings.cache_clear()


@pytest.fixture
def fake_runner(monkeypatch):
    runner = FakeRunner()
    monkeypatch.setattr(pipeline, "make_runner", lambda settings: runner)
    return runner


@pytest.fixture(autouse=True)
async def stop_pipeline():
    """No deployment task outlives its test (and its event loop)."""
    yield
    await pipeline.shutdown()


async def trust_fake(db, fake) -> None:
    await known_hosts.trust(db, fake.host, fake.port, fake.fingerprint, actor_id=None)
    await db.commit()


async def make_environment(db, *, name: str = "uat", target_id: str = "ssh",
                           host: str = "127.0.0.1", status: str = "ready",
                           current_sha: str | None = None,
                           secrets: dict | None = None) -> Environment:
    settings = get_settings()
    env = Environment(name=name, type="dev", target_id=target_id,
                      base_domain=f"{name}.serversherpa.com", git_ref="main",
                      current_sha=current_sha,
                      image_tag=envfile.image_tag(current_sha) if current_sha else None,
                      status=status, proxy_ip="10.0.0.2", bind_ip="0.0.0.0",
                      keep_dumps=5, spaces_bucket="serversherpa", log_level="INFO")
    db.add(env)
    await db.flush()
    for service in envfile.SERVICES:
        db.add(EnvironmentService(
            environment_id=env.id, service=service, host_ip=host,
            port=envfile.DEFAULT_PORTS[service], proxied=False,
            hostname=(f"{service}.{env.base_domain}"
                      if service in envfile.PUBLIC_SERVICES else None)))
    for key, value in (ENV_SECRETS if secrets is None else secrets).items():
        db.add(EnvironmentSecret(environment_id=env.id, key=key,
                                 value_enc=vault.encrypt(settings, value)))
    await db.commit()
    return env
```

- [ ] **Step 2: Write the failing test**

`sirdar/api/tests/test_deploy_pipeline.py`:

```python
import asyncio
import base64

import pytest
from sqlalchemy import select, update

from sirdar_api.api.app import create_app
from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Deployment, DeploymentStep, Environment
from sirdar_api.deploy import envfile, pipeline
from sirdar_api.deploy.runner import RunResult
from sirdar_api.deploy.steps import STEPS_BY_KEY

from .deploy_factories import (  # noqa: F401
    ENV_SECRETS, fake_runner, make_environment, secrets_key, stop_pipeline, trust_fake,
)
from .ssh_server import SSH_PASSWORD, ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401

SHA = "e73b99ca" + "0" * 32
OLD = "a" * 40
UPDATE_KEYS = ["preflight", "bootstrap", "fetch", "render", "build", "dump", "up"]


@pytest.fixture
async def env(db, deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    return await make_environment(db, current_sha=OLD)


async def _create(db, env, mode="update", **kw) -> Deployment:
    dep = await pipeline.create_deployment(db, env, mode=mode, git_ref="main", sha=SHA,
                                           actor_id=None, **kw)
    await db.commit()
    return dep


async def _start(db, env, mode="update", **kw):
    dep = await _create(db, env, mode, **kw)
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def _load(dep_id):
    async with get_sessionmaker()() as s:
        dep = await s.get(Deployment, dep_id)
        steps = list(await s.scalars(select(DeploymentStep)
                                     .where(DeploymentStep.deployment_id == dep_id)
                                     .order_by(DeploymentStep.number)))
        env = await s.get(Environment, dep.environment_id)
        return dep, steps, env


async def test_update_runs_every_step_in_order(db, env, fake_runner):
    fake_runner.results["dump"] = RunResult(
        status="successful", rc=0, data={"dump_path": "/opt/serversherpa/uat/backups/x.dump"})
    dep_id = await _start(db, env)
    dep, steps, e = await _load(dep_id)
    assert fake_runner.steps() == UPDATE_KEYS
    assert [(s.number, s.status) for s in steps] == [
        (1, "succeeded"), (2, "succeeded"), (3, "succeeded"), (4, "succeeded"),
        (5, "succeeded"), (6, "succeeded"), (8, "succeeded")]
    assert all(s.started_at and s.finished_at for s in steps)
    assert steps[0].log == "ok: [target] preflight\n"
    assert (dep.status, dep.dump_path, dep.previous_sha, dep.error) == (
        "succeeded", "/opt/serversherpa/uat/backups/x.dump", OLD, None)
    assert dep.finished_at is not None
    assert (e.status, e.current_sha, e.image_tag) == ("ready", SHA, "e73b99ca")


async def test_requests_carry_the_pinned_target_and_step_vars(db, env, fake_runner,
                                                              ssh_server):
    await _start(db, env)
    target = fake_runner.requests[0].target
    assert (target.host, target.port, target.user) == ("127.0.0.1", ssh_server.port, "deployer")
    assert target.known_hosts_line.startswith(f"[127.0.0.1]:{ssh_server.port} ssh-ed25519 ")
    assert target.host_key_algorithms == "ssh-ed25519"
    assert (target.password, target.become_password, target.private_key) == (
        SSH_PASSWORD, SSH_PASSWORD, None)
    common = {"env_name": "uat", "env_dir": "/opt/serversherpa/uat",
              "repo_url": "https://github.com/encondata/BaseCampV3.git", "sha": SHA,
              "ss_stack": "/opt/serversherpa/uat/repo/deploy/stack/ss-stack",
              "min_disk_gb": 10, "min_memory_mb": 1800}
    for request in fake_runner.requests:
        assert request.playbook == STEPS_BY_KEY[request.step].playbook
        assert request.timeout == STEPS_BY_KEY[request.step].timeout
        if request.step == "render":
            assert set(request.extravars) == {*common, "env_file_b64"}
            values = envfile.parse_env(
                base64.b64decode(request.extravars["env_file_b64"]).decode())
            assert values["STACK_IMAGE_TAG"] == "e73b99ca"
            assert values["POSTGRES_PASSWORD"] == ENV_SECRETS["POSTGRES_PASSWORD"]
            assert values["STACK_PROXY_IP"] == "10.0.0.2"
        else:
            assert request.extravars == common


async def test_reset_plan(db, env, fake_runner):
    await _start(db, env, mode="reset")
    assert fake_runner.steps() == ["preflight", "bootstrap", "fetch", "render", "build",
                                   "reset", "up"]


async def test_first_failure_stops_the_deployment(db, env, fake_runner):
    fake_runner.results["build"] = RunResult(status="failed", rc=2)
    dep_id = await _start(db, env)
    dep, steps, e = await _load(dep_id)
    assert fake_runner.steps() == ["preflight", "bootstrap", "fetch", "render", "build"]
    by_key = {s.key: s.status for s in steps}
    assert by_key == {"preflight": "succeeded", "bootstrap": "succeeded",
                      "fetch": "succeeded", "render": "succeeded", "build": "failed",
                      "dump": "not_run", "up": "not_run"}
    assert (dep.status, dep.failed_step) == ("failed", 5)
    assert dep.error == "Step 5 (Build images) failed. See its log."
    assert (e.status, e.current_sha) == ("failed", OLD)


async def test_timeout_message(db, env, fake_runner):
    fake_runner.results["up"] = RunResult(status="timeout", rc=254)
    dep, _, _ = await _load(await _start(db, env))
    assert dep.error == "Step 8 (Start services) timed out after 45 minutes."


async def test_logs_are_redacted(db, env, fake_runner):
    fake_runner.output["preflight"] = [f"pw {SSH_PASSWORD}\n",
                                       f"pg {ENV_SECRETS['POSTGRES_PASSWORD']}\n"]
    _, steps, _ = await _load(await _start(db, env))
    assert steps[0].log == "pw [redacted]\npg [redacted]\n"


async def test_logs_keep_only_the_tail(db, env, fake_runner, monkeypatch):
    monkeypatch.setattr(pipeline, "LOG_LIMIT", 10)
    fake_runner.output["preflight"] = ["0123456789", "abcdef\n"]
    _, steps, _ = await _load(await _start(db, env))
    assert steps[0].log == "789abcdef\n"          # the last 10 characters


async def test_logs_flush_while_a_step_runs(db, env, fake_runner, monkeypatch):
    monkeypatch.setattr(pipeline, "FLUSH_SECONDS", 0.05)
    fake_runner.gates["build"] = asyncio.Event()
    fake_runner.output["build"] = ["building api\n"]
    dep = await _create(db, env)
    pipeline.launch(dep.id)
    await asyncio.wait_for(fake_runner.started["build"].wait(), 5)
    for _ in range(100):
        _, steps, _ = await _load(dep.id)
        if steps[4].log:
            break
        await asyncio.sleep(0.05)
    assert (steps[4].log, steps[4].status) == ("building api\n", "running")
    assert pipeline.is_active(dep.id)
    fake_runner.gates["build"].set()
    await pipeline.wait(dep.id)
    assert not pipeline.is_active(dep.id)


async def test_one_running_deployment_per_environment(db, env, fake_runner):
    fake_runner.gates["preflight"] = asyncio.Event()
    first_id = (await _create(db, env)).id     # the refused insert rolls the session back
    pipeline.launch(first_id)
    with pytest.raises(pipeline.DeployInProgress):
        await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                         actor_id=None)
    fake_runner.gates["preflight"].set()
    await pipeline.wait(first_id)


async def test_cancel(db, env, fake_runner):
    fake_runner.gates["build"] = asyncio.Event()
    dep = await _create(db, env)
    pipeline.launch(dep.id)
    await asyncio.wait_for(fake_runner.started["build"].wait(), 5)
    assert pipeline.request_cancel(dep.id) is True
    await pipeline.wait(dep.id)
    d, steps, e = await _load(dep.id)
    assert (d.status, d.error) == ("cancelled", pipeline.CANCELLED)
    by_key = {s.key: s.status for s in steps}
    assert (by_key["render"], by_key["build"], by_key["dump"], by_key["up"]) == (
        "succeeded", "cancelled", "not_run", "not_run")
    assert steps[4].log == "ok: [target] build\n"
    assert (e.status, e.current_sha) == ("failed", OLD)
    assert pipeline.request_cancel(dep.id) is False


async def test_shutdown_interrupts(db, env, fake_runner):
    fake_runner.gates["fetch"] = asyncio.Event()
    dep = await _create(db, env)
    pipeline.launch(dep.id)
    await asyncio.wait_for(fake_runner.started["fetch"].wait(), 5)
    await pipeline.shutdown()
    d, steps, _ = await _load(dep.id)
    assert (d.status, d.error) == ("interrupted", pipeline.INTERRUPTED)
    assert [s.status for s in steps] == ["succeeded", "succeeded", "interrupted", "not_run",
                                         "not_run", "not_run", "not_run"]


async def test_recover_orphans(db, env):
    dep = await _create(db, env)
    await db.execute(update(DeploymentStep).where(DeploymentStep.deployment_id == dep.id,
                                                  DeploymentStep.number == 1)
                     .values(status="running"))
    await db.commit()
    assert await pipeline.recover_orphans() == 1
    d, steps, e = await _load(dep.id)
    assert (d.status, d.error) == ("interrupted", pipeline.INTERRUPTED)
    assert d.finished_at is not None
    assert steps[0].status == "interrupted"
    assert {s.status for s in steps[1:]} == {"not_run"}
    assert e.status == "failed"
    assert await pipeline.recover_orphans() == 0


async def test_close_orphan(db, env):
    dep = await _create(db, env)
    await pipeline.close_orphan(dep.id)
    d, steps, _ = await _load(dep.id)
    assert d.status == "cancelled"
    assert {s.status for s in steps} == {"not_run"}


async def test_untrusted_host_fails_step_one_and_runs_nothing(db, deploy_env, ssh_server,
                                                              secrets_key, fake_runner):
    _ssh_env(deploy_env, ssh_server)
    env = await make_environment(db)
    d, steps, e = await _load(await _start(db, env))
    assert fake_runner.requests == []
    assert (d.status, d.failed_step) == ("failed", 1)
    assert steps[0].status == "failed"
    assert "Trust its host key on the Deploy page" in steps[0].log
    assert d.error == steps[0].log.strip()
    assert e.status == "failed"


async def test_missing_target_or_key_fails_step_one(db, env, fake_runner, monkeypatch):
    env.target_id = "ssh:gone"
    await db.commit()
    d, steps, _ = await _load(await _start(db, env))
    assert "isn't configured any more" in steps[0].log

    env.target_id = "ssh"
    await db.commit()
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    d, steps, _ = await _load(await _start(db, env))
    assert d.status == "failed"
    assert "SIRDAR_SECRETS_KEY isn't set" in steps[0].log
    assert fake_runner.requests == []


async def test_start_step_skips_earlier_steps(db, env, fake_runner):
    _, steps, _ = await _load(await _start(db, env, start_step=5))
    assert fake_runner.steps() == ["build", "dump", "up"]
    assert [s.status for s in steps] == ["skipped"] * 4 + ["succeeded"] * 3


async def test_runner_crash_is_a_failed_step_with_our_copy(db, env, fake_runner):
    fake_runner.raises["fetch"] = RuntimeError(f"boom {SSH_PASSWORD}")
    d, steps, _ = await _load(await _start(db, env))
    assert steps[2].status == "failed"
    assert steps[2].log == "Sirdar couldn't run this step.\n"
    assert d.error == "Step 3 (Fetch code) failed. See its log."


async def test_app_lifespan_recovers_then_shuts_down(monkeypatch):
    calls: list[str] = []

    async def recover():
        calls.append("recover")
        return 0

    async def shutdown(timeout=10.0):
        calls.append("shutdown")

    monkeypatch.setattr(pipeline, "recover_orphans", recover)
    monkeypatch.setattr(pipeline, "shutdown", shutdown)
    app = create_app()
    async with app.router.lifespan_context(app):
        assert calls == ["recover"]
    assert calls == ["recover", "shutdown"]
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `.venv/bin/pytest -q tests/test_deploy_pipeline.py`
Expected: FAIL — `ImportError: cannot import name 'pipeline' from 'sirdar_api.deploy'`

- [ ] **Step 4: The pipeline**

`sirdar/api/src/sirdar_api/deploy/pipeline.py`:

```python
"""Deployment pipeline (spec Section 2: steps 1–8 here; DNS, proxy and smoke
tests come in phase 4).

One asyncio task per running deployment, registered in _tasks; each task
uses its own database sessions. Steps run in plan order through a Runner,
and the first failure stops the deployment (later steps become not_run).
Retry is a new deployment whose earlier steps are skipped. The partial
unique index deployments_one_running allows one running deployment per
environment. Shutdown cancels running tasks (they end "interrupted"); at
startup, deployments a previous process left running are marked the same.
Sirdar runs one process: _tasks is the whole truth about live runs.

Logs are redacted (every secret value this run knows becomes [redacted])
before they are kept, and only a step's last LOG_LIMIT characters are
stored. Exception text never reaches a log or the database."""

import asyncio
import base64
import logging
import threading
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings, get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import (
    Deployment, DeploymentStep, Environment, EnvironmentSecret, EnvironmentService,
)
from sirdar_api.deploy import ConnectFailed, envfile, known_hosts, ssh, targets, vault
from sirdar_api.deploy.redact import Redactor
from sirdar_api.deploy.runner import AnsibleRunner, Runner, RunRequest, RunResult, RunTarget
from sirdar_api.deploy.steps import STEPS_BY_KEY, plan_for

log = logging.getLogger(__name__)

LOG_LIMIT = 256 * 1024          # characters kept per step: the tail
FLUSH_SECONDS = 2.0             # how often a running step's log is saved
MIN_MEMORY_MB = 1800            # "2 GB" as the kernel reports it
RETRYABLE_STATUSES = ("failed", "cancelled", "interrupted")
INTERRUPTED = "Sirdar stopped while this deployment was running."
CANCELLED = "Cancelled."
UNEXPECTED = "Sirdar couldn't run this step."

_tasks: dict[uuid.UUID, asyncio.Task] = {}
_cancel_requested: set[uuid.UUID] = set()


class DeployInProgress(Exception):
    """Another deployment of this environment is running."""


class PrepareError(Exception):
    """The run can't start. `reason` is our own copy, shown in the log."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def make_runner(settings: Settings) -> Runner:
    """The runner every deployment uses (tests replace this function)."""
    return AnsibleRunner(settings.runner_dir)


def _now() -> datetime:
    return datetime.now(UTC)


# ---- records -----------------------------------------------------------------

async def create_deployment(db: AsyncSession, env: Environment, *, mode: str, git_ref: str,
                            sha: str, actor_id: uuid.UUID | None, start_step: int = 1,
                            retry_of: uuid.UUID | None = None) -> Deployment:
    """Add a running deployment and its step rows. The caller commits, then
    calls launch(). Raises DeployInProgress (the session is rolled back)."""
    plan = plan_for(mode)
    dep = Deployment(environment_id=env.id, mode=mode, git_ref=git_ref, sha=sha,
                     status="running", start_step=start_step, retry_of=retry_of,
                     previous_sha=env.current_sha, actor_id=actor_id)
    db.add(dep)
    try:
        await db.flush()
    except IntegrityError as e:
        await db.rollback()
        if "deployments_one_running" in str(e.orig):
            raise DeployInProgress() from None
        raise
    for step in plan:
        db.add(DeploymentStep(deployment_id=dep.id, number=step.number, key=step.key,
                              name=step.name,
                              status="skipped" if step.number < start_step else "pending"))
    env.status = "deploying"
    env.updated_at = _now()
    await db.flush()
    return dep


# ---- task registry -------------------------------------------------------------

def launch(deployment_id: uuid.UUID) -> asyncio.Task:
    task = asyncio.create_task(_run(deployment_id), name=f"deployment-{deployment_id}")
    _tasks[deployment_id] = task

    def done(t: asyncio.Task) -> None:
        _tasks.pop(deployment_id, None)
        _cancel_requested.discard(deployment_id)
        if not t.cancelled() and t.exception() is not None:
            log.error("deployment %s task crashed: %s", deployment_id,
                      type(t.exception()).__name__)

    task.add_done_callback(done)
    return task


def is_active(deployment_id: uuid.UUID) -> bool:
    return deployment_id in _tasks


async def wait(deployment_id: uuid.UUID, timeout: float = 30.0) -> None:
    task = _tasks.get(deployment_id)
    if task is not None:
        await asyncio.wait({task}, timeout=timeout)


def request_cancel(deployment_id: uuid.UUID) -> bool:
    """Cancel a deployment running in this process; False when none is."""
    task = _tasks.get(deployment_id)
    if task is None:
        return False
    _cancel_requested.add(deployment_id)
    task.cancel()
    return True


async def shutdown(timeout: float = 10.0) -> None:
    """App shutdown: stop every run; each records itself interrupted."""
    tasks = list(_tasks.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.wait(tasks, timeout=timeout)


async def recover_orphans() -> int:
    """Mark deployments left running by a previous process as interrupted."""
    async with get_sessionmaker()() as s:
        query = select(Deployment.id).where(Deployment.status == "running")
        if _tasks:
            query = query.where(Deployment.id.not_in(list(_tasks)))
        ids = list(await s.scalars(query))
        if not ids:
            return 0
        now = _now()
        await s.execute(update(DeploymentStep)
                        .where(DeploymentStep.deployment_id.in_(ids),
                               DeploymentStep.status == "running")
                        .values(status="interrupted", finished_at=now))
        await s.execute(update(DeploymentStep)
                        .where(DeploymentStep.deployment_id.in_(ids),
                               DeploymentStep.status == "pending")
                        .values(status="not_run"))
        await s.execute(update(Environment)
                        .where(Environment.id.in_(select(Deployment.environment_id)
                                                  .where(Deployment.id.in_(ids))),
                               Environment.status == "deploying")
                        .values(status="failed", updated_at=now))
        await s.execute(update(Deployment).where(Deployment.id.in_(ids))
                        .values(status="interrupted", finished_at=now, error=INTERRUPTED))
        await s.commit()
        return len(ids)


async def close_orphan(deployment_id: uuid.UUID) -> None:
    """Cancel a running deployment that has no task in this process."""
    async with get_sessionmaker()() as s:
        dep = await s.get(Deployment, deployment_id)
        if dep is None or dep.status != "running":
            return
        env_id = dep.environment_id
        running = await s.scalar(select(DeploymentStep.number).where(
            DeploymentStep.deployment_id == deployment_id, DeploymentStep.status == "running"))
    await _close(deployment_id, env_id, running, step_status="cancelled",
                 dep_status="cancelled", error=CANCELLED)


async def _close(deployment_id: uuid.UUID, env_id: uuid.UUID, step_number: int | None, *,
                 step_status: str, dep_status: str, error: str, failed_step: int | None = None,
                 append_log: str = "") -> None:
    """End a deployment that didn't succeed, in a fresh session (the run's own
    session may be mid-transaction or cancelled)."""
    now = _now()
    async with get_sessionmaker()() as s:
        if step_number is not None:
            values: dict = {"status": step_status, "finished_at": now}
            if append_log:
                values["log"] = DeploymentStep.log + append_log
            await s.execute(update(DeploymentStep)
                            .where(DeploymentStep.deployment_id == deployment_id,
                                   DeploymentStep.number == step_number)
                            .values(**values))
        await s.execute(update(DeploymentStep)
                        .where(DeploymentStep.deployment_id == deployment_id,
                               DeploymentStep.status == "pending")
                        .values(status="not_run"))
        await s.execute(update(Deployment).where(Deployment.id == deployment_id)
                        .values(status=dep_status, finished_at=now, error=error,
                                failed_step=failed_step))
        await s.execute(update(Environment).where(Environment.id == env_id)
                        .values(status="failed", updated_at=now))
        await s.commit()


# ---- logs ----------------------------------------------------------------------

class _LogBuffer:
    """A step's output, redacted as it arrives (from the runner's thread)."""

    def __init__(self, redactor: Redactor):
        self._redact = redactor
        self._parts: list[str] = []
        self._size = 0
        self._lock = threading.Lock()
        self.version = 0

    def append(self, text: str) -> None:
        clean = self._redact(text)
        with self._lock:
            self._parts.append(clean)
            self._size += len(clean)
            self.version += 1
            if self._size > 2 * LOG_LIMIT:
                kept = "".join(self._parts)[-LOG_LIMIT:]
                self._parts, self._size = [kept], len(kept)

    def text(self) -> str:
        with self._lock:
            joined = "".join(self._parts)
        return self._redact(joined)[-LOG_LIMIT:]


async def _save_log(step_id: uuid.UUID, text: str) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(DeploymentStep).where(DeploymentStep.id == step_id)
                        .values(log=text))
        await s.commit()


async def _flush_loop(step_id: uuid.UUID, buffer: _LogBuffer) -> None:
    seen = 0
    while True:
        await asyncio.sleep(FLUSH_SECONDS)
        if buffer.version != seen:
            seen = buffer.version
            await _save_log(step_id, buffer.text())


# ---- running -------------------------------------------------------------------

@dataclass(frozen=True)
class _Context:
    target: RunTarget
    common: dict = field(repr=False)
    env_file_b64: str = field(repr=False)
    redactor: Redactor = field(repr=False)

    def vars_for(self, step_key: str) -> dict:
        if step_key == "render":
            return {**self.common, "env_file_b64": self.env_file_b64}
        return dict(self.common)


async def _load_secrets(db: AsyncSession, env_id: uuid.UUID,
                        settings: Settings) -> dict[str, str]:
    rows = await db.scalars(select(EnvironmentSecret)
                            .where(EnvironmentSecret.environment_id == env_id))
    try:
        return {row.key: vault.decrypt(settings, row.value_enc) for row in rows}
    except vault.SecretsKeyMissing:
        raise PrepareError("SIRDAR_SECRETS_KEY isn't set, so Sirdar can't read this "
                           "environment's secrets.") from None
    except vault.SecretUnreadable:
        raise PrepareError("This environment's secrets don't open with the current "
                           "SIRDAR_SECRETS_KEY.") from None


async def _prepare(db: AsyncSession, env: Environment, dep: Deployment,
                   settings: Settings) -> _Context:
    cfg = targets.ssh_config_for(env.target_id, settings)
    if cfg is None:
        raise PrepareError("This environment's SSH target isn't configured any more. "
                           "Pick another target, then retry.")
    try:
        pinned = await ssh.pinned_host_key(db, cfg.host, cfg.port)
    except ssh.HostKeyUnknown:
        raise PrepareError(f"Sirdar doesn't trust {cfg.host}:{cfg.port} yet. Trust its host "
                           "key on the Deploy page, then retry.") from None
    except ssh.HostKeyMismatch:
        raise PrepareError(f"The host key of {cfg.host}:{cfg.port} changed. Check the server, "
                           "forget the old key and trust the new one, then retry.") from None
    except ConnectFailed as e:
        raise PrepareError(e.reason) from None
    try:
        client_key = await ssh.load_client_key(cfg)
    except ConnectFailed as e:
        raise PrepareError(e.reason) from None
    secrets = await _load_secrets(db, env.id, settings)
    rows = await db.scalars(select(EnvironmentService)
                            .where(EnvironmentService.environment_id == env.id))
    ports = {**envfile.DEFAULT_PORTS, **{r.service: r.port for r in rows}}
    try:
        text = envfile.render_env(envfile.EnvConfig(
            name=env.name, domain=env.base_domain, image_tag=envfile.image_tag(dep.sha),
            proxy_ip=env.proxy_ip, bind_ip=env.bind_ip, ports=ports,
            keep_dumps=env.keep_dumps, spaces_bucket=env.spaces_bucket,
            log_level=env.log_level, secrets=secrets))
    except envfile.RenderError as e:
        raise PrepareError(f"Sirdar couldn't write this environment's .env: {e.reason}.") \
            from None
    env_b64 = base64.b64encode(text.encode()).decode()
    private_key = client_key.export_private_key("openssh").decode() if client_key else None
    folder = envfile.env_dir(env.name)
    target = RunTarget(
        host=cfg.host, port=cfg.port, user=cfg.user,
        known_hosts_line=known_hosts.openssh_line(cfg.host, cfg.port, pinned.public_key),
        host_key_algorithms=known_hosts.host_key_algorithms(pinned.key_type),
        password=cfg.password, private_key=private_key,
        become_password=cfg.sudo_password or cfg.password)
    common = {"env_name": env.name, "env_dir": folder, "repo_url": settings.deploy_repo_url,
              "sha": dep.sha, "ss_stack": f"{folder}/repo/deploy/stack/ss-stack",
              "min_disk_gb": ssh.MIN_DISK_GB, "min_memory_mb": MIN_MEMORY_MB}
    redactor = Redactor([*secrets.values(), env_b64, cfg.password, cfg.passphrase,
                         cfg.sudo_password, private_key])
    return _Context(target=target, common=common, env_file_b64=env_b64, redactor=redactor)


def _failure_reason(step: DeploymentStep, result: RunResult) -> str:
    if result.status == "timeout":
        minutes = STEPS_BY_KEY[step.key].timeout // 60
        return f"Step {step.number} ({step.name}) timed out after {minutes} minutes."
    return f"Step {step.number} ({step.name}) failed. See its log."


async def _mark_running(db: AsyncSession, step: DeploymentStep) -> None:
    step.status, step.started_at = "running", _now()
    await db.commit()


async def _run_step(runner: Runner, ctx: _Context, step: DeploymentStep) -> RunResult:
    definition = STEPS_BY_KEY[step.key]
    buffer = _LogBuffer(ctx.redactor)
    flusher = asyncio.create_task(_flush_loop(step.id, buffer))
    try:
        return await runner.run(
            RunRequest(step=step.key, playbook=definition.playbook, target=ctx.target,
                       timeout=definition.timeout, extravars=ctx.vars_for(step.key)),
            buffer.append)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001 — a failed step, never the exception text
        log.error("deploy step %s couldn't run: %s", step.key, type(e).__name__)
        buffer.append(UNEXPECTED + "\n")
        return RunResult(status="failed", rc=-1)
    finally:
        flusher.cancel()
        with suppress(asyncio.CancelledError):
            await flusher
        await _save_log(step.id, buffer.text())


async def _run(deployment_id: uuid.UUID) -> None:
    current: int | None = None                 # number of the step in progress
    env_id: uuid.UUID | None = None
    async with get_sessionmaker()() as db:
        try:
            dep = await db.get(Deployment, deployment_id)
            env = await db.get(Environment, dep.environment_id)
            env_id = env.id
            steps = list(await db.scalars(
                select(DeploymentStep).where(DeploymentStep.deployment_id == deployment_id)
                .order_by(DeploymentStep.number)))
            todo = [s for s in steps if s.status == "pending"]
            if todo:
                settings = get_settings()
                current = todo[0].number
                await _mark_running(db, todo[0])
                try:
                    ctx = await _prepare(db, env, dep, settings)
                except PrepareError as e:
                    await db.rollback()
                    await _close(deployment_id, env_id, current, step_status="failed",
                                 dep_status="failed", error=e.reason, failed_step=current,
                                 append_log=e.reason + "\n")
                    return
                runner = make_runner(settings)
                for step in todo:
                    current = step.number
                    if step.status != "running":
                        await _mark_running(db, step)
                    result = await _run_step(runner, ctx, step)
                    if result.status != "successful":
                        await db.rollback()
                        await _close(deployment_id, env_id, current, step_status="failed",
                                     dep_status="failed", error=_failure_reason(step, result),
                                     failed_step=current)
                        return
                    step.status, step.finished_at = "succeeded", _now()
                    if step.key == "dump":
                        dep.dump_path = result.data.get("dump_path") or None
                    await db.commit()
            current = None
            now = _now()
            dep.status, dep.finished_at = "succeeded", now
            env.current_sha, env.image_tag = dep.sha, envfile.image_tag(dep.sha)
            env.status, env.updated_at = "ready", now
            await db.commit()
        except asyncio.CancelledError:
            status = "cancelled" if deployment_id in _cancel_requested else "interrupted"
            with suppress(Exception):
                await db.rollback()
            if env_id is not None:
                await _close(deployment_id, env_id, current, step_status=status,
                             dep_status=status,
                             error=CANCELLED if status == "cancelled" else INTERRUPTED)
            raise
        except Exception as e:  # noqa: BLE001 — record the failure, never its text
            log.error("deployment %s stopped by %s", deployment_id, type(e).__name__)
            with suppress(Exception):
                await db.rollback()
            if env_id is not None:
                await _close(deployment_id, env_id, current, step_status="failed",
                             dep_status="failed", error=UNEXPECTED, failed_step=current)
```

- [ ] **Step 5: Lifespan hooks**

In `sirdar/api/src/sirdar_api/api/app.py`, add `import logging` to the imports, `log = logging.getLogger(__name__)` after the imports, and replace `_lifespan` with:

```python
@asynccontextmanager
async def _lifespan(app: FastAPI):
    from sirdar_api.deploy import pipeline

    try:
        await pipeline.recover_orphans()     # runs a previous process left "running"
    except Exception:  # noqa: BLE001 — a database hiccup must not stop the app starting
        log.warning("couldn't mark interrupted deployments at startup")
    yield
    await pipeline.shutdown()                # running deployments end "interrupted"
    await dispose_engine()
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/pytest -q tests/test_deploy_pipeline.py`
Expected: PASS (all tests)

- [ ] **Step 7: Run the whole suite**

Run: `.venv/bin/pytest -q`
Expected: every test passes (0 failed); the dashboard and earlier deploy tests are untouched.

- [ ] **Step 8: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/api/app.py \
  sirdar/api/tests/deploy_factories.py sirdar/api/tests/test_deploy_pipeline.py
git commit -m "feat(sirdar): deployment pipeline — step loop, lock, cancel, retry start, orphan recovery"
```

---
### Task 9: Environments — create, adopt, edit

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/environments.py`
- Modify: `sirdar/api/tests/deploy_factories.py` (append the remote `.env` helpers)
- Test: `sirdar/api/tests/test_deploy_environments.py`

**Interfaces:**
- Consumes: `envfile` constants and `parse_env`, `unsafe_value` (Task 1); `vault` (Task 2); models (Task 3); `ssh.run_command`, `SshTargetConfig`, `gitref.SHA_RE`, `gitref.valid_ref` (Task 5); `names.is_valid_custom_name`, `names.is_reserved_name`, `targets.ssh_config_for` (existing).
- Produces (`environments`):
  - `ENV_TYPES = ("dev", "beta", "custom")`; `SSH_TARGET_RE`;
  - `class EnvError(Exception)` with `.code: str` and `.extra: dict` (non-secret details such as `service`, `key`, `missing`);
  - `async get_by_name(db, name) -> Environment | None`; `async list_all(db) -> list[Environment]` (by name); `async services_of(db, env_id) -> list[EnvironmentService]` (in `envfile.SERVICES` order); `async secret_keys_of(db, env_id) -> set[str]`; `async is_deploying(db, env_id) -> bool`;
  - `async create_new(db, settings, *, name, type_, target_id, git_ref="main", base_domain=None, proxy_ip=None, bind_ip="0.0.0.0", ports=None, actor_id=None) -> Environment`;
  - `@dataclass(frozen=True) AdoptReport(sha: str, imported_secrets: list[str], ignored_keys: list[str])`; `async adopt(db, settings, *, name, type_, target_id, git_ref="main", actor_id=None) -> tuple[Environment, Deployment, AdoptReport]`;
  - `async update(db, settings, env, fields: dict) -> list[str]` (changed names: plain fields, `services.<svc>.<field>`, `secrets.<KEY>`).
  - Error codes: `name_invalid`, `name_reserved`, `type_invalid`, `target_invalid`, `target_not_configured`, `secrets_key_missing`, `environment_exists`, `ref_invalid`, `base_domain_invalid`, `proxy_ip_required`, `proxy_ip_invalid`, `bind_ip_invalid`, `host_ip_invalid`, `port_invalid` (+`service`), `ports_conflict`, `service_unknown` (+`service`), `keep_dumps_invalid`, `bucket_invalid`, `log_level_invalid`, `secret_not_editable` (+`key`), `secret_invalid` (+`key`), `deploy_in_progress`, `adopt_env_missing`, `adopt_env_mismatch`, `adopt_env_incomplete` (+`missing`), `adopt_repo_missing`, `adopt_value_invalid` (+`key`). The callers (Task 10) map them to HTTP.
  - `adopt` and `create_new` don't commit; callers audit and commit. `adopt` runs exactly two commands on the target: `cat -- <env-dir>/.env` and `git -C <env-dir>/repo rev-parse HEAD`.
- Produces (tests, appended to `deploy_factories`): `OLD_MINIO`, `ADOPT_SHA`, `CAT_ENV`, `REPO_HEAD`, `REMOTE_BASE`, `remote_env_text(**over) -> str` (`None` drops a key), `serve_remote_env(fake, text=None, sha=ADOPT_SHA)`.

- [ ] **Step 1: The remote `.env` test helpers**

Append to `sirdar/api/tests/deploy_factories.py`:

```python
# ---- a hand-built environment to adopt (shaped like uat on 10.10.48.63) ----------

OLD_MINIO = "minio-SECRET-legacy-123"
ADOPT_SHA = "e73b99ca" + "1" * 32
CAT_ENV = "cat -- /opt/serversherpa/uat/.env"
REPO_HEAD = "git -C /opt/serversherpa/uat/repo rev-parse HEAD"
REMOTE_BASE = {
    "STACK_ENV": "uat", "STACK_DOMAIN": "uat.serversherpa.com", "STACK_IMAGE_TAG": "e73b99ca",
    "STACK_REPO_DIR": "/opt/serversherpa/uat/repo", "STACK_PROXY_IP": "10.10.48.6",
    "STACK_BIND_IP": "0.0.0.0", "STACK_API_PORT": "8000", "STACK_PORTAL_PORT": "8091",
    "STACK_KIOSK_PORT": "8090", "STACK_WIKI_PORT": "8096", "STACK_SPACES_PORT": "9000",
    "STACK_STATUS_PORT": "8095", "STACK_MAILPIT_PORT": "8025", "STACK_KEEP_DUMPS": "5",
    **ENV_SECRETS,
    "SS_SPACES_BUCKET": "serversherpa", "SS_LOG_LEVEL": "INFO", "SS_ANTHROPIC_API_KEY": "",
    "SS_DB_TESTING_PASSWORD": "", "MINIO_ROOT_PASSWORD": OLD_MINIO,
}


def remote_env_text(**over) -> str:
    """The hand-built .env; a keyword set to None drops that key."""
    values = {**REMOTE_BASE, **over}
    return "# hand-made\n" + "".join(f"{k}={v}\n" for k, v in values.items() if v is not None)


def serve_remote_env(fake, text: str | None = None, sha: str = ADOPT_SHA) -> None:
    fake.overrides[CAT_ENV] = remote_env_text() if text is None else text
    fake.overrides[REPO_HEAD] = sha + "\n"
```

- [ ] **Step 2: Write the failing test**

`sirdar/api/tests/test_deploy_environments.py`:

```python
import pytest
from sqlalchemy import func, select

from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, EnvironmentSecret
from sirdar_api.deploy import envfile, environments, ssh, vault
from sirdar_api.deploy.environments import AdoptReport, EnvError

from .deploy_factories import (  # noqa: F401
    ADOPT_SHA, CAT_ENV, ENV_SECRETS, REPO_HEAD, make_environment, remote_env_text,
    secrets_key, serve_remote_env, stop_pipeline, trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401


@pytest.fixture
def target(deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    return ssh_server


async def _secrets(db, env_id) -> dict[str, str]:
    rows = await db.scalars(select(EnvironmentSecret)
                            .where(EnvironmentSecret.environment_id == env_id))
    return {r.key: vault.decrypt(get_settings(), r.value_enc) for r in rows}


def _new(**over) -> dict:
    kw = dict(name="qa", type_="custom", target_id="ssh", proxy_ip="10.10.48.6")
    kw.update(over)
    return kw


async def test_create_new_generates_everything(db, target):
    env = await environments.create_new(db, get_settings(), **_new(), actor_id=None)
    await db.commit()
    assert (env.status, env.base_domain, env.git_ref, env.bind_ip, env.current_sha,
            env.image_tag, env.keep_dumps, env.spaces_bucket, env.log_level) == (
        "new", "qa.serversherpa.com", "main", "0.0.0.0", None, None, 5, "serversherpa",
        "INFO")
    rows = await environments.services_of(db, env.id)
    assert [(r.service, r.host_ip, r.port, r.hostname, r.proxied) for r in rows] == [
        ("api", "127.0.0.1", 8000, "api.qa.serversherpa.com", False),
        ("portal", "127.0.0.1", 8091, "portal.qa.serversherpa.com", False),
        ("kiosk", "127.0.0.1", 8090, "kiosk.qa.serversherpa.com", False),
        ("wiki", "127.0.0.1", 8096, "wiki.qa.serversherpa.com", False),
        ("spaces", "127.0.0.1", 9000, "spaces.qa.serversherpa.com", False),
        ("status", "127.0.0.1", 8095, "status.qa.serversherpa.com", False),
        ("mailpit", "127.0.0.1", 8025, None, False)]
    stored = await _secrets(db, env.id)
    assert set(stored) == set(envfile.REQUIRED_SECRETS)
    raw = {r.key: r.value_enc for r in await db.scalars(select(EnvironmentSecret))}
    for key, value in stored.items():
        assert value.encode() not in raw[key]
    assert target.commands == []                    # creating touches no host


async def test_create_new_custom_values(db, target):
    env = await environments.create_new(
        db, get_settings(), **_new(base_domain="QA.Example.com.", bind_ip="10.10.48.63",
                                   git_ref="release/1", ports={"api": 8100}))
    await db.commit()
    assert (env.base_domain, env.bind_ip, env.git_ref) == (
        "qa.example.com", "10.10.48.63", "release/1")
    rows = {r.service: r for r in await environments.services_of(db, env.id)}
    assert (rows["api"].port, rows["api"].hostname) == (8100, "api.qa.example.com")


@pytest.mark.parametrize("over, code", [
    ({"name": "Bad"}, "name_invalid"),
    ({"name": "dev"}, "name_reserved"),
    ({"type_": "prod"}, "type_invalid"),
    ({"target_id": "digitalocean"}, "target_invalid"),
    ({"target_id": "ssh:nope"}, "target_not_configured"),
    ({"git_ref": "a..b"}, "ref_invalid"),
    ({"base_domain": "not a domain"}, "base_domain_invalid"),
    ({"proxy_ip": ""}, "proxy_ip_required"),
    ({"proxy_ip": "10.0.0"}, "proxy_ip_invalid"),
    ({"bind_ip": "::"}, "bind_ip_invalid"),
    ({"ports": {"api": 0}}, "port_invalid"),
    ({"ports": {"api": 8091}}, "ports_conflict"),
    ({"ports": {"db": 5432}}, "service_unknown"),
])
async def test_create_new_validation(db, target, over, code):
    with pytest.raises(EnvError) as exc:
        await environments.create_new(db, get_settings(), **_new(**over))
    assert exc.value.code == code
    assert await db.scalar(select(func.count()).select_from(Environment)) == 0


async def test_create_new_needs_the_key_and_a_free_name(db, target, monkeypatch):
    await make_environment(db, name="qa")
    with pytest.raises(EnvError) as exc:
        await environments.create_new(db, get_settings(), **_new())
    assert exc.value.code == "environment_exists"
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    with pytest.raises(EnvError) as exc:
        await environments.create_new(db, get_settings(), **_new(name="qa2"))
    assert exc.value.code == "secrets_key_missing"


async def test_adopt_imports_settings_and_secrets(db, target):
    await trust_fake(db, target)
    serve_remote_env(target)
    env, dep, report = await environments.adopt(db, get_settings(), name="uat", type_="dev",
                                                target_id="ssh")
    await db.commit()
    assert target.commands == [CAT_ENV, REPO_HEAD]
    assert (env.status, env.current_sha, env.image_tag, env.base_domain, env.proxy_ip,
            env.bind_ip) == ("ready", ADOPT_SHA, "e73b99ca", "uat.serversherpa.com",
                             "10.10.48.6", "0.0.0.0")
    assert (dep.mode, dep.status, dep.sha, dep.git_ref) == ("adopt", "adopted", ADOPT_SHA,
                                                            "main")
    assert dep.finished_at is not None
    assert await db.scalar(select(func.count()).select_from(DeploymentStep)) == 0
    assert report == AdoptReport(sha=ADOPT_SHA,
                                 imported_secrets=sorted(envfile.REQUIRED_SECRETS),
                                 ignored_keys=["MINIO_ROOT_PASSWORD"])
    assert await _secrets(db, env.id) == ENV_SECRETS


async def test_adopted_record_renders_the_same_env(db, target):
    """Adopting then deploying keeps every value the hand-built .env had."""
    await trust_fake(db, target)
    serve_remote_env(target, remote_env_text(SS_ANTHROPIC_API_KEY="sk-ant-api03-x",
                                             STACK_API_PORT="8100"))
    env, _, report = await environments.adopt(db, get_settings(), name="uat", type_="dev",
                                              target_id="ssh")
    await db.commit()
    assert "SS_ANTHROPIC_API_KEY" in report.imported_secrets
    rows = await environments.services_of(db, env.id)
    rendered = envfile.parse_env(envfile.render_env(envfile.EnvConfig(
        name=env.name, domain=env.base_domain, image_tag=env.image_tag, proxy_ip=env.proxy_ip,
        bind_ip=env.bind_ip, ports={r.service: r.port for r in rows},
        keep_dumps=env.keep_dumps, spaces_bucket=env.spaces_bucket, log_level=env.log_level,
        secrets=await _secrets(db, env.id))))
    remote = envfile.parse_env(remote_env_text(SS_ANTHROPIC_API_KEY="sk-ant-api03-x",
                                               STACK_API_PORT="8100"))
    assert rendered == {k: v for k, v in remote.items() if k in envfile.KNOWN_KEYS}


@pytest.mark.parametrize("text, code, extra", [
    (remote_env_text(STACK_ENV="other"), "adopt_env_mismatch", {}),
    (remote_env_text(SS_JWT_SECRET="CHANGEME", POSTGRES_PASSWORD=None),
     "adopt_env_incomplete", {"missing": ["POSTGRES_PASSWORD", "SS_JWT_SECRET"]}),
    (remote_env_text(STACK_PROXY_IP="nope"), "adopt_value_invalid", {"key": "STACK_PROXY_IP"}),
    (remote_env_text(STACK_API_PORT="80x"), "adopt_value_invalid", {"key": "STACK_API_PORT"}),
    (remote_env_text(SS_LOG_LEVEL="LOUD"), "adopt_value_invalid", {"key": "SS_LOG_LEVEL"}),
    (remote_env_text(STACK_PORTAL_PORT="8000"), "ports_conflict", {}),
])
async def test_adopt_refuses_a_bad_env(db, target, text, code, extra):
    await trust_fake(db, target)
    serve_remote_env(target, text)
    with pytest.raises(EnvError) as exc:
        await environments.adopt(db, get_settings(), name="uat", type_="dev", target_id="ssh")
    assert (exc.value.code, exc.value.extra) == (code, extra)
    for secret in ENV_SECRETS.values():
        assert secret not in repr(exc.value.extra)


async def test_adopt_missing_env_or_repo(db, target):
    await trust_fake(db, target)
    serve_remote_env(target, "")
    target.exits[CAT_ENV] = 1
    with pytest.raises(EnvError) as exc:
        await environments.adopt(db, get_settings(), name="uat", type_="dev", target_id="ssh")
    assert exc.value.code == "adopt_env_missing"

    serve_remote_env(target)
    target.exits[CAT_ENV] = 0
    target.exits[REPO_HEAD] = 128
    with pytest.raises(EnvError) as exc:
        await environments.adopt(db, get_settings(), name="uat", type_="dev", target_id="ssh")
    assert exc.value.code == "adopt_repo_missing"
    assert await db.scalar(select(func.count()).select_from(Environment)) == 0


async def test_adopt_needs_a_trusted_host(db, target):
    serve_remote_env(target)
    with pytest.raises(ssh.HostKeyUnknown):
        await environments.adopt(db, get_settings(), name="uat", type_="dev", target_id="ssh")
    assert target.commands == []


async def test_update_fields_services_and_secrets(db, target):
    env = await make_environment(db)
    settings = get_settings()
    changed = await environments.update(db, settings, env, {
        "base_domain": "uat2.serversherpa.com", "keep_dumps": 3, "log_level": "debug",
        "services": {"api": {"port": 8100, "proxied": True}, "mailpit": {"host_ip": "10.0.0.9"}},
        "secrets": {"SS_ANTHROPIC_API_KEY": "sk-ant-api03-abc"}})
    await db.commit()
    assert changed == ["base_domain", "keep_dumps", "log_level", "services.api.port",
                       "services.api.proxied", "services.mailpit.host_ip",
                       "secrets.SS_ANTHROPIC_API_KEY"]
    rows = {r.service: r for r in await environments.services_of(db, env.id)}
    assert (rows["api"].port, rows["api"].proxied, rows["api"].hostname) == (
        8100, True, "api.uat2.serversherpa.com")
    assert (rows["mailpit"].host_ip, rows["mailpit"].hostname) == ("10.0.0.9", None)
    assert env.log_level == "DEBUG"
    assert (await _secrets(db, env.id))["SS_ANTHROPIC_API_KEY"] == "sk-ant-api03-abc"

    assert await environments.update(db, settings, env, {"keep_dumps": 3}) == []
    changed = await environments.update(db, settings, env,
                                        {"secrets": {"SS_ANTHROPIC_API_KEY": ""}})
    await db.commit()
    assert changed == ["secrets.SS_ANTHROPIC_API_KEY"]
    assert "SS_ANTHROPIC_API_KEY" not in await environments.secret_keys_of(db, env.id)


@pytest.mark.parametrize("fields, code, extra", [
    ({"git_ref": "-x"}, "ref_invalid", {}),
    ({"target": "ssh:gone"}, "target_not_configured", {}),
    ({"base_domain": "x"}, "base_domain_invalid", {}),
    ({"proxy_ip": "1.2.3"}, "proxy_ip_invalid", {}),
    ({"keep_dumps": 0}, "keep_dumps_invalid", {}),
    ({"spaces_bucket": "Bad_Bucket"}, "bucket_invalid", {}),
    ({"log_level": "LOUD"}, "log_level_invalid", {}),
    ({"services": {"db": {"port": 1}}}, "service_unknown", {"service": "db"}),
    ({"services": {"api": {"port": 70000}}}, "port_invalid", {"service": "api"}),
    ({"services": {"api": {"port": 8091}}}, "ports_conflict", {}),
    ({"services": {"api": {"host_ip": "h"}}}, "host_ip_invalid", {}),
    ({"secrets": {"POSTGRES_PASSWORD": "x"}}, "secret_not_editable",
     {"key": "POSTGRES_PASSWORD"}),
    ({"secrets": {"SS_ANTHROPIC_API_KEY": "has space"}}, "secret_invalid",
     {"key": "SS_ANTHROPIC_API_KEY"}),
    ({"secrets": {"SS_ANTHROPIC_API_KEY": "a$b"}}, "secret_invalid",
     {"key": "SS_ANTHROPIC_API_KEY"}),
])
async def test_update_validation(db, target, fields, code, extra):
    env = await make_environment(db)
    with pytest.raises(EnvError) as exc:
        await environments.update(db, get_settings(), env, fields)
    assert (exc.value.code, exc.value.extra) == (code, extra)


async def test_update_refused_while_deploying(db, target):
    env = await make_environment(db)
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha="a" * 40,
                      status="running", start_step=1))
    await db.commit()
    assert await environments.is_deploying(db, env.id) is True
    with pytest.raises(EnvError) as exc:
        await environments.update(db, get_settings(), env, {"keep_dumps": 3})
    assert exc.value.code == "deploy_in_progress"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `.venv/bin/pytest -q tests/test_deploy_environments.py`
Expected: FAIL — `ImportError: cannot import name 'environments' from 'sirdar_api.deploy'`

- [ ] **Step 4: The environments service**

`sirdar/api/src/sirdar_api/deploy/environments.py`:

```python
"""Environments: create a new one, adopt a hand-built one, edit one.
Secrets are generated (new) or imported (adopt), encrypted with
SIRDAR_SECRETS_KEY, and never returned, logged or put in an error. Callers
audit and commit.

Adopt reads <env-dir>/.env and the checkout's HEAD over SSH and touches
nothing else: the environment's database, files, .env and containers stay
as they are. Keys Sirdar doesn't know are reported by name and dropped from
the .env on the next deploy."""

import ipaddress
import re
import shlex
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Deployment, Environment, EnvironmentSecret, EnvironmentService
from sirdar_api.deploy import ConnectFailed, envfile, names, ssh, targets, vault
from sirdar_api.deploy.gitref import SHA_RE, valid_ref
from sirdar_api.deploy.ssh import SshTargetConfig

ENV_TYPES = ("dev", "beta", "custom")
SSH_TARGET_RE = re.compile(r"ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*")
_DOMAIN_RE = re.compile(r"(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
_BUCKET_RE = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")
_TAG_RE = re.compile(r"[A-Za-z0-9_.-]{1,128}")
# Optional secrets set by hand (API keys, passwords): no whitespace, quotes,
# "$" (compose interpolation), "#", backslash or backtick.
_SECRET_VALUE_RE = re.compile(r"[A-Za-z0-9._~+/=:@%^*!?,;-]{1,1024}")
_NO_ANSWER = "The target didn't answer in time."


class EnvError(Exception):
    """A validation or state failure. `code` is the API error code; `extra`
    holds non-secret details (service and key names, never values)."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


def _now() -> datetime:
    return datetime.now(UTC)


# ---- checks ------------------------------------------------------------------

def _check_name(name: str) -> None:
    if not names.is_valid_custom_name(name):
        raise EnvError("name_invalid")
    if names.is_reserved_name(name):
        raise EnvError("name_reserved")


def _check_ref(ref: str) -> str:
    if not valid_ref(ref):
        raise EnvError("ref_invalid")
    return ref


def _check_domain(value: str) -> str:
    domain = value.strip().lower().rstrip(".")
    if not _DOMAIN_RE.fullmatch(domain):
        raise EnvError("base_domain_invalid")
    return domain


def _check_ipv4(value: str, code: str) -> str:
    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError:
        raise EnvError(code) from None


def _check_port(value, service: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise EnvError("port_invalid", service=service)
    return value


def _check_ports_unique(ports: dict[str, int]) -> None:
    if len(set(ports.values())) != len(ports):
        raise EnvError("ports_conflict")


def _check_keep_dumps(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100:
        raise EnvError("keep_dumps_invalid")
    return value


def _check_bucket(value: str) -> str:
    if not _BUCKET_RE.fullmatch(value):
        raise EnvError("bucket_invalid")
    return value


def _check_log_level(value: str) -> str:
    level = value.upper()
    if level not in envfile.LOG_LEVELS:
        raise EnvError("log_level_invalid")
    return level


def _check_target(target_id: str, settings: Settings) -> SshTargetConfig:
    if not SSH_TARGET_RE.fullmatch(target_id):
        raise EnvError("target_invalid")
    cfg = targets.ssh_config_for(target_id, settings)
    if cfg is None:
        raise EnvError("target_not_configured")
    return cfg


def _hostname(service: str, domain: str) -> str | None:
    return f"{service}.{domain}" if service in envfile.PUBLIC_SERVICES else None


# ---- reads -------------------------------------------------------------------

async def get_by_name(db: AsyncSession, name: str) -> Environment | None:
    return await db.scalar(select(Environment).where(Environment.name == name))


async def list_all(db: AsyncSession) -> list[Environment]:
    return list(await db.scalars(select(Environment).order_by(Environment.name)))


async def services_of(db: AsyncSession, env_id) -> list[EnvironmentService]:
    rows = await db.scalars(select(EnvironmentService)
                            .where(EnvironmentService.environment_id == env_id))
    order = {s: i for i, s in enumerate(envfile.SERVICES)}
    return sorted(rows, key=lambda r: order.get(r.service, len(order)))


async def secret_keys_of(db: AsyncSession, env_id) -> set[str]:
    return set(await db.scalars(select(EnvironmentSecret.key)
                                .where(EnvironmentSecret.environment_id == env_id)))


async def is_deploying(db: AsyncSession, env_id) -> bool:
    found = await db.scalar(select(Deployment.id).where(
        Deployment.environment_id == env_id, Deployment.status == "running").limit(1))
    return found is not None


# ---- create and adopt --------------------------------------------------------

async def _precheck(db: AsyncSession, settings: Settings, *, name: str, type_: str,
                    target_id: str, git_ref: str) -> SshTargetConfig:
    _check_name(name)
    if type_ not in ENV_TYPES:
        raise EnvError("type_invalid")
    cfg = _check_target(target_id, settings)
    _check_ref(git_ref)
    if not vault.is_configured(settings):
        raise EnvError("secrets_key_missing")
    if await get_by_name(db, name) is not None:
        raise EnvError("environment_exists")
    return cfg


async def _insert(db: AsyncSession, settings: Settings, cfg: SshTargetConfig, *, name: str,
                  type_: str, target_id: str, git_ref: str, domain: str, proxy_ip: str,
                  bind_ip: str, ports: dict[str, int], keep_dumps: int, spaces_bucket: str,
                  log_level: str, status: str, current_sha: str | None,
                  image_tag: str | None, secrets: dict[str, str],
                  actor_id) -> Environment:
    env = Environment(name=name, type=type_, target_id=target_id, base_domain=domain,
                      git_ref=git_ref, current_sha=current_sha, image_tag=image_tag,
                      status=status, proxy_ip=proxy_ip, bind_ip=bind_ip,
                      keep_dumps=keep_dumps, spaces_bucket=spaces_bucket,
                      log_level=log_level, created_by=actor_id)
    db.add(env)
    await db.flush()
    for service in envfile.SERVICES:
        db.add(EnvironmentService(environment_id=env.id, service=service, host_ip=cfg.host,
                                  port=ports[service], hostname=_hostname(service, domain),
                                  proxied=False))
    for key, value in secrets.items():
        db.add(EnvironmentSecret(environment_id=env.id, key=key,
                                 value_enc=vault.encrypt(settings, value)))
    await db.flush()
    return env


async def create_new(db: AsyncSession, settings: Settings, *, name: str, type_: str,
                     target_id: str, git_ref: str = "main", base_domain: str | None = None,
                     proxy_ip: str | None = None, bind_ip: str = "0.0.0.0",
                     ports: dict[str, int] | None = None, actor_id=None) -> Environment:
    """A new environment (status "new"): default ports unless given, the
    target's host for every service, freshly generated secrets."""
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
    domain = _check_domain(base_domain or f"{name}.serversherpa.com")
    if not proxy_ip:
        raise EnvError("proxy_ip_required")
    proxy = _check_ipv4(proxy_ip, "proxy_ip_invalid")
    bind = _check_ipv4(bind_ip, "bind_ip_invalid")
    given = ports or {}
    unknown = sorted(set(given) - set(envfile.SERVICES))
    if unknown:
        raise EnvError("service_unknown", service=unknown[0])
    all_ports = {s: _check_port(given.get(s, envfile.DEFAULT_PORTS[s]), s)
                 for s in envfile.SERVICES}
    _check_ports_unique(all_ports)
    return await _insert(
        db, settings, cfg, name=name, type_=type_, target_id=target_id, git_ref=git_ref,
        domain=domain, proxy_ip=proxy, bind_ip=bind, ports=all_ports,
        keep_dumps=envfile.DEFAULT_KEEP_DUMPS, spaces_bucket=envfile.DEFAULT_SPACES_BUCKET,
        log_level=envfile.DEFAULT_LOG_LEVEL, status="new", current_sha=None, image_tag=None,
        secrets=vault.generate_env_secrets(), actor_id=actor_id)


@dataclass(frozen=True)
class AdoptReport:
    sha: str
    imported_secrets: list[str]
    ignored_keys: list[str]


def _adopted_settings(values: dict[str, str]) -> dict:
    """Non-secret settings from an adopted .env. A bad value raises
    adopt_value_invalid naming the key."""
    def invalid(key: str) -> EnvError:
        return EnvError("adopt_value_invalid", key=key)

    def checked(key: str, check, default: str = ""):
        try:
            return check(values.get(key) or default)
        except EnvError:
            raise invalid(key) from None

    domain = checked("STACK_DOMAIN", _check_domain)
    proxy = checked("STACK_PROXY_IP", lambda v: _check_ipv4(v, "x"))
    bind = checked("STACK_BIND_IP", lambda v: _check_ipv4(v, "x"), "0.0.0.0")
    ports: dict[str, int] = {}
    for service in envfile.SERVICES:
        key = envfile.PORT_KEYS[service]
        raw = values.get(key) or str(envfile.DEFAULT_PORTS[service])
        if not raw.isdigit():
            raise invalid(key)
        ports[service] = checked(key, lambda v, s=service: _check_port(int(v), s), raw)
    _check_ports_unique(ports)
    keep = values.get("STACK_KEEP_DUMPS") or str(envfile.DEFAULT_KEEP_DUMPS)
    if not keep.isdigit():
        raise invalid("STACK_KEEP_DUMPS")
    keep_dumps = checked("STACK_KEEP_DUMPS", lambda v: _check_keep_dumps(int(v)), keep)
    bucket = checked("SS_SPACES_BUCKET", _check_bucket, envfile.DEFAULT_SPACES_BUCKET)
    level = checked("SS_LOG_LEVEL", _check_log_level, envfile.DEFAULT_LOG_LEVEL)
    tag = values.get("STACK_IMAGE_TAG") or None
    if tag is not None and not _TAG_RE.fullmatch(tag):
        raise invalid("STACK_IMAGE_TAG")
    return {"domain": domain, "proxy_ip": proxy, "bind_ip": bind, "ports": ports,
            "keep_dumps": keep_dumps, "spaces_bucket": bucket, "log_level": level,
            "image_tag": tag}


async def adopt(db: AsyncSession, settings: Settings, *, name: str, type_: str,
                target_id: str, git_ref: str = "main",
                actor_id=None) -> tuple[Environment, Deployment, AdoptReport]:
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
    folder = envfile.env_dir(name)
    found = await ssh.run_command(cfg, db, f"cat -- {shlex.quote(folder + '/.env')}")
    if found.exit_status is None:
        raise ConnectFailed(_NO_ANSWER)
    if found.exit_status != 0:
        raise EnvError("adopt_env_missing")
    values = envfile.parse_env(found.stdout)
    if values.get("STACK_ENV") != name:
        raise EnvError("adopt_env_mismatch")
    missing = [k for k in envfile.REQUIRED_SECRETS
               if values.get(k, "") in ("", envfile.PLACEHOLDER)]
    if missing:
        raise EnvError("adopt_env_incomplete", missing=missing)
    picked = _adopted_settings(values)
    secrets = {k: values[k] for k in envfile.SECRET_KEYS if values.get(k)}
    for key, value in secrets.items():
        if envfile.unsafe_value(value):
            raise EnvError("adopt_value_invalid", key=key)

    repo = shlex.quote(folder + "/repo")
    head = await ssh.run_command(cfg, db, f"git -C {repo} rev-parse HEAD")
    if head.exit_status is None:
        raise ConnectFailed(_NO_ANSWER)
    sha = head.stdout.strip()
    if head.exit_status != 0 or not SHA_RE.fullmatch(sha):
        raise EnvError("adopt_repo_missing")

    env = await _insert(
        db, settings, cfg, name=name, type_=type_, target_id=target_id, git_ref=git_ref,
        domain=picked["domain"], proxy_ip=picked["proxy_ip"], bind_ip=picked["bind_ip"],
        ports=picked["ports"], keep_dumps=picked["keep_dumps"],
        spaces_bucket=picked["spaces_bucket"], log_level=picked["log_level"],
        status="ready", current_sha=sha, image_tag=picked["image_tag"], secrets=secrets,
        actor_id=actor_id)
    now = _now()
    dep = Deployment(environment_id=env.id, mode="adopt", git_ref=git_ref, sha=sha,
                     status="adopted", start_step=1, actor_id=actor_id, started_at=now,
                     finished_at=now)
    db.add(dep)
    await db.flush()
    ignored = sorted(k for k in values if k not in envfile.KNOWN_KEYS)
    return env, dep, AdoptReport(sha=sha, imported_secrets=sorted(secrets),
                                 ignored_keys=ignored)


# ---- edit --------------------------------------------------------------------

async def update(db: AsyncSession, settings: Settings, env: Environment,
                 fields: dict) -> list[str]:
    """Apply a PATCH: an absent or None field is kept. Only the optional
    secrets are editable ("" clears one). Returns the changed names."""
    if await is_deploying(db, env.id):
        raise EnvError("deploy_in_progress")
    changed: list[str] = []

    def put(attr: str, value) -> None:
        if getattr(env, attr) != value:
            setattr(env, attr, value)
            changed.append(attr)

    if fields.get("git_ref") is not None:
        put("git_ref", _check_ref(fields["git_ref"]))
    if fields.get("target") is not None:
        _check_target(fields["target"], settings)
        put("target_id", fields["target"])
    old_domain = env.base_domain
    if fields.get("base_domain") is not None:
        put("base_domain", _check_domain(fields["base_domain"]))
    if fields.get("proxy_ip") is not None:
        put("proxy_ip", _check_ipv4(fields["proxy_ip"], "proxy_ip_invalid"))
    if fields.get("bind_ip") is not None:
        put("bind_ip", _check_ipv4(fields["bind_ip"], "bind_ip_invalid"))
    if fields.get("keep_dumps") is not None:
        put("keep_dumps", _check_keep_dumps(fields["keep_dumps"]))
    if fields.get("spaces_bucket") is not None:
        put("spaces_bucket", _check_bucket(fields["spaces_bucket"]))
    if fields.get("log_level") is not None:
        put("log_level", _check_log_level(fields["log_level"]))

    rows = {r.service: r for r in await services_of(db, env.id)}
    service_fields = fields.get("services") or {}
    unknown = sorted(set(service_fields) - set(rows))
    if unknown:
        raise EnvError("service_unknown", service=unknown[0])
    for service, patch in service_fields.items():
        row, patch = rows[service], patch or {}
        if patch.get("port") is not None:
            port = _check_port(patch["port"], service)
            if row.port != port:
                row.port = port
                changed.append(f"services.{service}.port")
        if patch.get("host_ip") is not None:
            host_ip = _check_ipv4(patch["host_ip"], "host_ip_invalid")
            if row.host_ip != host_ip:
                row.host_ip = host_ip
                changed.append(f"services.{service}.host_ip")
        if patch.get("proxied") is not None and row.proxied != bool(patch["proxied"]):
            row.proxied = bool(patch["proxied"])
            changed.append(f"services.{service}.proxied")
    _check_ports_unique({s: r.port for s, r in rows.items()})
    if env.base_domain != old_domain:
        for service, row in rows.items():
            row.hostname = _hostname(service, env.base_domain)

    secrets = fields.get("secrets") or {}
    for key, value in secrets.items():
        if key not in envfile.OPTIONAL_SECRETS:
            raise EnvError("secret_not_editable", key=key)
        if value is not None and (not isinstance(value, str)
                                  or (value and not _SECRET_VALUE_RE.fullmatch(value))):
            raise EnvError("secret_invalid", key=key)
    if any(v for v in secrets.values()) and not vault.is_configured(settings):
        raise EnvError("secrets_key_missing")
    existing = await secret_keys_of(db, env.id)
    for key, value in secrets.items():
        if value is None:
            continue
        if value == "":
            if key in existing:
                await db.execute(delete(EnvironmentSecret).where(
                    EnvironmentSecret.environment_id == env.id, EnvironmentSecret.key == key))
                changed.append(f"secrets.{key}")
            continue
        row = await db.get(EnvironmentSecret, (env.id, key))
        if row is None:
            db.add(EnvironmentSecret(environment_id=env.id, key=key,
                                     value_enc=vault.encrypt(settings, value)))
        else:
            row.value_enc, row.updated_at = vault.encrypt(settings, value), _now()
        changed.append(f"secrets.{key}")

    if changed:
        env.updated_at = _now()
    await db.flush()
    return changed
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/bin/pytest -q tests/test_deploy_environments.py`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/tests/deploy_factories.py \
  sirdar/api/tests/test_deploy_environments.py
git commit -m "feat(sirdar): environments service — create, adopt over SSH, edit"
```

---
### Task 10: Environment endpoints

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/serialize.py`
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (imports; append the environment section)
- Modify: `sirdar/api/tests/deploy_factories.py` (imports; append `leak_guard`)
- Test: `sirdar/api/tests/test_deploy_environments_api.py`

**Interfaces:**
- Consumes: `environments.*` (Task 9), models (Task 3), `envfile.env_dir`, `envfile.OPTIONAL_SECRETS`.
- Produces (`serialize`): `LOG_TAIL_DEFAULT = 8000`; `async latest_deployment(db, env_id) -> Deployment | None`; `async recent_deployments(db, env_id, limit: int) -> list[Deployment]`; `async deployment_summary(db, dep) -> dict` (keys `id, mode, git_ref, sha, status, start_step, retry_of, failed_step, dump_path, previous_sha, error, actor_name, started_at, finished_at, created_at`); `async deployment_out(db, dep, *, environment_name: str, tail: int = LOG_TAIL_DEFAULT) -> dict` (summary + `environment` + `steps: [{number, key, name, status, started_at, finished_at, log_size, log_tail}]`); `async environment_out(db, env) -> dict` (keys `id, name, type, target, base_domain, env_dir, git_ref, current_sha, image_tag, status, proxy_ip, bind_ip, keep_dumps, spaces_bucket, log_level, services, secrets_set, last_deployment, created_at, updated_at`; `services` items `{service, host_ip, port, hostname, proxied}`; `secrets_set` = `{key: bool}` for `OPTIONAL_SECRETS`).
- Produces (routes, all under `/api/deploy`):
  - `GET /environments` (view) → `{"environments": [environment_out…]}`
  - `GET /environments/{name}` (view) → `environment_out`; 404 `environment_not_found`
  - `POST /environments` (add) body `{mode: "new"|"adopt", name, type: "dev"|"beta"|"custom", target: "ssh"|"ssh:<slug>", git_ref="main", base_domain?, proxy_ip?, bind_ip="0.0.0.0", ports={}}` → 201 `environment_out` (adopt adds `ignored_keys`); audits `deploy.environment_create` / `deploy.environment_adopt`
  - `PATCH /environments/{name}` (change) body any of `git_ref, target, base_domain, proxy_ip, bind_ip, keep_dumps, spaces_bucket, log_level, services: {svc: {port?, host_ip?, proxied?}}, secrets: {SS_ANTHROPIC_API_KEY|SS_DB_TESTING_PASSWORD: str}` → 200 `environment_out`; audits `deploy.environment_update` `{"changed": [...]}` only when something changed
  - Route helpers for Task 11: `_environment(db, name) -> Environment` (404), `_ssh_http(e) -> HTTPException`, `_SSH_ERRORS`, `SSH_TARGET_PATTERN`.
- Produces (tests): fixture `leak_guard(client, db, secrets_key)` yielding a list the test may append extra secrets to.

- [ ] **Step 1: The leak guard**

In `sirdar/api/tests/deploy_factories.py`, extend the imports at the top to:

```python
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, Environment, EnvironmentSecret, EnvironmentService
from sirdar_api.deploy import envfile, known_hosts, pipeline, vault

from .fake_runner import FakeRunner
from .ssh_server import SSH_PASSWORD
```

and append:

```python
@pytest.fixture
async def leak_guard(client, db, secrets_key):
    """Every response body this test saw, and every audit row, must hold no
    secret: ENV_SECRETS, the legacy MinIO password, the fake SSH password,
    every secret stored in the database (decrypted with SECRETS_KEY) and
    whatever the test appends to the yielded list."""
    seen: list[str] = []

    async def record(response):
        await response.aread()
        seen.append(response.text)

    client.event_hooks["response"].append(record)
    extra: list[str] = []
    yield extra
    await db.rollback()
    fernet = Fernet(SECRETS_KEY.encode())
    stored = [fernet.decrypt(bytes(r.value_enc)).decode()
              for r in await db.scalars(select(EnvironmentSecret))]
    audits = [repr(c) for c in await db.scalars(select(AuditLog.changes))]
    assert seen, "the response hook recorded nothing"
    secrets = (*ENV_SECRETS.values(), OLD_MINIO, SSH_PASSWORD, *stored, *extra)
    for text in seen + audits:
        for secret in secrets:
            assert secret not in text
```

- [ ] **Step 2: Write the failing test**

`sirdar/api/tests/test_deploy_environments_api.py`:

```python
import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog
from sirdar_api.deploy import envfile

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    ADOPT_SHA, CAT_ENV, leak_guard, make_environment, remote_env_text, secrets_key,
    serve_remote_env, stop_pipeline, trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401

URL = "/api/deploy/environments"
ENV_KEYS = {"id", "name", "type", "target", "base_domain", "env_dir", "git_ref", "current_sha",
            "image_tag", "status", "proxy_ip", "bind_ip", "keep_dumps", "spaces_bucket",
            "log_level", "services", "secrets_set", "last_deployment", "created_at",
            "updated_at"}
NEW = {"mode": "new", "name": "qa", "type": "custom", "target": "ssh",
       "proxy_ip": "10.10.48.6"}


@pytest.fixture
def target(deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    return ssh_server


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def test_permissions(client, db, target, leak_guard):
    assert (await client.get(URL)).status_code == 401
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get(URL, headers=admin)).json() == {"environments": []}
    for method, url, body in (("POST", URL, NEW), ("PATCH", f"{URL}/qa", {"keep_dumps": 3})):
        resp = await client.request(method, url, headers=admin, json=body)
        assert resp.status_code == 403, url
        assert resp.json()["detail"]["code"] == "forbidden"


async def test_create_new_environment(client, db, target, leak_guard):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "ports": {"api": 8100}})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert set(body) == ENV_KEYS
    assert (body["name"], body["type"], body["target"], body["status"], body["base_domain"],
            body["env_dir"], body["current_sha"], body["last_deployment"]) == (
        "qa", "custom", "ssh", "new", "qa.serversherpa.com", "/opt/serversherpa/qa", None,
        None)
    assert body["services"][0] == {"service": "api", "host_ip": "127.0.0.1", "port": 8100,
                                   "hostname": "api.qa.serversherpa.com", "proxied": False}
    assert body["services"][-1]["service"] == "mailpit"
    assert body["services"][-1]["hostname"] is None
    assert body["secrets_set"] == {"SS_ANTHROPIC_API_KEY": False,
                                   "SS_DB_TESTING_PASSWORD": False}
    assert await _audits(db, "deploy.environment_create") == [{
        "name": "qa", "type": "custom", "target": "ssh", "base_domain": "qa.serversherpa.com",
        "git_ref": "main", "proxy_ip": "10.10.48.6", "bind_ip": "0.0.0.0"}]
    assert (await client.get(f"{URL}/qa", headers=h)).json() == body
    listed = (await client.get(URL, headers=h)).json()["environments"]
    assert [e["name"] for e in listed] == ["qa"]
    resp = await client.post(URL, headers=h, json=NEW)
    assert resp.status_code == 409
    assert resp.json() == {"detail": {"code": "environment_exists"}}


async def test_create_errors(client, db, target, leak_guard, monkeypatch, secrets_key):
    h = await auth_headers(client, db)
    for body, status, detail in (
            ({**NEW, "name": "Bad"}, 422, {"code": "name_invalid"}),
            ({**NEW, "proxy_ip": None}, 422, {"code": "proxy_ip_required"}),
            ({**NEW, "ports": {"db": 5432}}, 422, {"code": "service_unknown", "service": "db"}),
            ({**NEW, "target": "ssh:gone"}, 400, {"code": "target_not_configured"})):
        resp = await client.post(URL, headers=h, json=body)
        assert (resp.status_code, resp.json()) == (status, {"detail": detail}), body
    resp = await client.post(URL, headers=h, json={**NEW, "target": "digitalocean"})
    assert resp.status_code == 422                       # pydantic: not an SSH target id
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    resp = await client.post(URL, headers=h, json=NEW)
    assert (resp.status_code, resp.json()) == (400, {"detail": {"code": "secrets_key_missing"}})
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", secrets_key)    # the leak guard reads with it
    get_settings.cache_clear()


async def test_adopt_environment(client, db, target, leak_guard):
    await trust_fake(db, target)
    serve_remote_env(target)
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={"mode": "adopt", "name": "uat",
                                                   "type": "dev", "target": "ssh"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert set(body) == ENV_KEYS | {"ignored_keys"}
    assert (body["status"], body["current_sha"], body["image_tag"], body["proxy_ip"]) == (
        "ready", ADOPT_SHA, "e73b99ca", "10.10.48.6")
    assert body["ignored_keys"] == ["MINIO_ROOT_PASSWORD"]
    last = body["last_deployment"]
    assert (last["mode"], last["status"], last["sha"], last["actor_name"]) == (
        "adopt", "adopted", ADOPT_SHA, "Boss User")
    assert await _audits(db, "deploy.environment_adopt") == [{
        "name": "uat", "type": "dev", "target": "ssh", "sha": ADOPT_SHA,
        "image_tag": "e73b99ca", "imported_secrets": sorted(envfile.REQUIRED_SECRETS),
        "ignored_keys": ["MINIO_ROOT_PASSWORD"]}]


async def test_adopt_errors(client, db, target, leak_guard):
    h = await auth_headers(client, db)
    adopt = {"mode": "adopt", "name": "uat", "type": "dev", "target": "ssh"}
    serve_remote_env(target)
    resp = await client.post(URL, headers=h, json=adopt)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "host_key_unknown", "host": "127.0.0.1",
                                     "port": target.port, "key_type": "ssh-ed25519",
                                     "fingerprint": target.fingerprint}
    await trust_fake(db, target)
    serve_remote_env(target, remote_env_text(SS_JWT_SECRET="CHANGEME"))
    resp = await client.post(URL, headers=h, json=adopt)
    assert (resp.status_code, resp.json()) == (422, {"detail": {
        "code": "adopt_env_incomplete", "missing": ["SS_JWT_SECRET"]}})
    target.exits[CAT_ENV] = 1
    resp = await client.post(URL, headers=h, json=adopt)
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "adopt_env_missing"}})
    assert (await client.get(URL, headers=h)).json() == {"environments": []}


async def test_get_unknown_environment(client, db, target, leak_guard):
    h = await auth_headers(client, db)
    resp = await client.get(f"{URL}/nope", headers=h)
    assert (resp.status_code, resp.json()) == (404, {"detail": {"code": "environment_not_found"}})
    resp = await client.patch(f"{URL}/nope", headers=h, json={"keep_dumps": 3})
    assert resp.status_code == 404


async def test_patch_environment(client, db, target, leak_guard):
    await make_environment(db)
    h = await auth_headers(client, db)
    key = "sk-ant-api03-SECRETvalue"
    leak_guard.append(key)
    resp = await client.patch(f"{URL}/uat", headers=h, json={
        "base_domain": "uat2.serversherpa.com",
        "services": {"api": {"port": 8100, "proxied": True}},
        "secrets": {"SS_ANTHROPIC_API_KEY": key}})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["services"][0] == {"service": "api", "host_ip": "127.0.0.1", "port": 8100,
                                   "hostname": "api.uat2.serversherpa.com", "proxied": True}
    assert body["secrets_set"] == {"SS_ANTHROPIC_API_KEY": True,
                                   "SS_DB_TESTING_PASSWORD": False}
    assert await _audits(db, "deploy.environment_update") == [{"changed": [
        "base_domain", "services.api.port", "services.api.proxied",
        "secrets.SS_ANTHROPIC_API_KEY"]}]

    resp = await client.patch(f"{URL}/uat", headers=h,
                              json={"secrets": {"SS_ANTHROPIC_API_KEY": ""}})
    assert resp.json()["secrets_set"]["SS_ANTHROPIC_API_KEY"] is False

    for body, detail in (
            ({"secrets": {"SS_ANTHROPIC_API_KEY": "has space SECRET-x"}},
             {"code": "secret_invalid", "key": "SS_ANTHROPIC_API_KEY"}),
            ({"secrets": {"POSTGRES_PASSWORD": "new-SECRET-x"}},
             {"code": "secret_not_editable", "key": "POSTGRES_PASSWORD"}),
            ({"services": {"api": {"port": 8091}}}, {"code": "ports_conflict"})):
        resp = await client.patch(f"{URL}/uat", headers=h, json=body)
        assert (resp.status_code, resp.json()) == (422, {"detail": detail})
        assert "SECRET-x" not in resp.text

    resp = await client.patch(f"{URL}/uat", headers=h, json={})
    assert resp.status_code == 200
    assert len(await _audits(db, "deploy.environment_update")) == 2
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `.venv/bin/pytest -q tests/test_deploy_environments_api.py`
Expected: FAIL — `/api/deploy/environments` answers 404/405 (no route yet), e.g. `assert 404 == 401` in `test_permissions`.

- [ ] **Step 4: The serializers**

`sirdar/api/src/sirdar_api/deploy/serialize.py`:

```python
"""JSON shapes for the environment and deployment endpoints. Secrets never
appear: an environment reports only which optional secrets are set, and
step logs were redacted before they were stored."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.db.models import Deployment, DeploymentStep, Environment, User
from sirdar_api.deploy import envfile
from sirdar_api.deploy.environments import secret_keys_of, services_of

LOG_TAIL_DEFAULT = 8000


async def _actor_name(db: AsyncSession, actor_id) -> str | None:
    if actor_id is None:
        return None
    user = await db.get(User, actor_id)
    return user.display_name if user else None


async def latest_deployment(db: AsyncSession, env_id) -> Deployment | None:
    return await db.scalar(select(Deployment).where(Deployment.environment_id == env_id)
                           .order_by(Deployment.created_at.desc()).limit(1))


async def recent_deployments(db: AsyncSession, env_id, limit: int) -> list[Deployment]:
    return list(await db.scalars(select(Deployment)
                                 .where(Deployment.environment_id == env_id)
                                 .order_by(Deployment.created_at.desc()).limit(limit)))


async def deployment_summary(db: AsyncSession, dep: Deployment) -> dict:
    return {"id": str(dep.id), "mode": dep.mode, "git_ref": dep.git_ref, "sha": dep.sha,
            "status": dep.status, "start_step": dep.start_step,
            "retry_of": str(dep.retry_of) if dep.retry_of else None,
            "failed_step": dep.failed_step, "dump_path": dep.dump_path,
            "previous_sha": dep.previous_sha, "error": dep.error,
            "actor_name": await _actor_name(db, dep.actor_id),
            "started_at": dep.started_at, "finished_at": dep.finished_at,
            "created_at": dep.created_at}


async def deployment_out(db: AsyncSession, dep: Deployment, *, environment_name: str,
                         tail: int = LOG_TAIL_DEFAULT) -> dict:
    steps = await db.scalars(select(DeploymentStep)
                             .where(DeploymentStep.deployment_id == dep.id)
                             .order_by(DeploymentStep.number)
                             .execution_options(populate_existing=True))
    return {**await deployment_summary(db, dep), "environment": environment_name,
            "steps": [{"number": s.number, "key": s.key, "name": s.name, "status": s.status,
                       "started_at": s.started_at, "finished_at": s.finished_at,
                       "log_size": len(s.log), "log_tail": s.log[-tail:] if tail > 0 else ""}
                      for s in steps]}


async def environment_out(db: AsyncSession, env: Environment) -> dict:
    services = await services_of(db, env.id)
    keys = await secret_keys_of(db, env.id)
    last = await latest_deployment(db, env.id)
    return {
        "id": str(env.id), "name": env.name, "type": env.type, "target": env.target_id,
        "base_domain": env.base_domain, "env_dir": envfile.env_dir(env.name),
        "git_ref": env.git_ref, "current_sha": env.current_sha, "image_tag": env.image_tag,
        "status": env.status, "proxy_ip": env.proxy_ip, "bind_ip": env.bind_ip,
        "keep_dumps": env.keep_dumps, "spaces_bucket": env.spaces_bucket,
        "log_level": env.log_level,
        "services": [{"service": r.service, "host_ip": r.host_ip, "port": r.port,
                      "hostname": r.hostname, "proxied": r.proxied} for r in services],
        "secrets_set": {k: k in keys for k in envfile.OPTIONAL_SECRETS},
        "last_deployment": await deployment_summary(db, last) if last else None,
        "created_at": env.created_at, "updated_at": env.updated_at,
    }
```

- [ ] **Step 5: The routes**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, extend the imports:

```python
from sirdar_api.db.models import Environment, SshKnownHost
from sirdar_api.deploy import (
    ConnectFailed, digitalocean, environments, known_hosts, names, serialize, ssh, targets,
)
```

and append this section at the end of the file:

```python
# ---- environments (deploy pipeline) -------------------------------------------

SSH_TARGET_PATTERN = r"^(ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*)$"
EnvType = Literal["dev", "beta", "custom"]
_SSH_ERRORS = (ssh.HostKeyUnknown, ssh.HostKeyMismatch, ConnectFailed)
_ENV_STATUS = {"environment_exists": 409, "deploy_in_progress": 409,
               "secrets_key_missing": 400, "target_not_configured": 400}


class EnvironmentIn(BaseModel):
    mode: Literal["new", "adopt"]
    name: str = Field(max_length=64)
    type: EnvType
    target: str = Field(pattern=SSH_TARGET_PATTERN, max_length=36)
    git_ref: str = Field(default="main", max_length=200)
    # mode "new" only; adopt reads these from the target's .env
    base_domain: str | None = Field(default=None, max_length=253)
    proxy_ip: str | None = Field(default=None, max_length=45)
    bind_ip: str = Field(default="0.0.0.0", max_length=45)
    ports: dict[str, int] = Field(default_factory=dict)


class ServicePatch(BaseModel):
    port: int | None = None
    host_ip: str | None = Field(default=None, max_length=45)
    proxied: bool | None = None


class EnvironmentPatch(BaseModel):
    git_ref: str | None = Field(default=None, max_length=200)
    target: str | None = Field(default=None, pattern=SSH_TARGET_PATTERN, max_length=36)
    base_domain: str | None = Field(default=None, max_length=253)
    proxy_ip: str | None = Field(default=None, max_length=45)
    bind_ip: str | None = Field(default=None, max_length=45)
    keep_dumps: int | None = None
    spaces_bucket: str | None = Field(default=None, max_length=63)
    log_level: str | None = Field(default=None, max_length=10)
    services: dict[str, ServicePatch] | None = None
    # Write-only. No pydantic constraint on the values, so no validation error
    # can describe one; the service answers secret_invalid / secret_not_editable.
    secrets: dict[str, str] | None = None


def _env_http(e: environments.EnvError) -> HTTPException:
    return HTTPException(status_code=_ENV_STATUS.get(e.code, 422),
                         detail={"code": e.code, **e.extra})


def _ssh_http(e: Exception) -> HTTPException:
    """Host-key and connection failures, in /connect's shapes."""
    if isinstance(e, ssh.HostKeyUnknown):
        return HTTPException(status_code=409, detail={
            "code": "host_key_unknown", "host": e.host, "port": e.port,
            "key_type": e.key_type, "fingerprint": e.fingerprint})
    if isinstance(e, ssh.HostKeyMismatch):
        return HTTPException(status_code=409, detail={
            "code": "host_key_mismatch", "host": e.host, "port": e.port,
            "key_type": e.key_type, "expected": e.expected, "actual": e.actual})
    return HTTPException(status_code=502, detail={"code": "connect_failed", "reason": e.reason})


async def _environment(db, name: str) -> Environment:
    env = await environments.get_by_name(db, name)
    if env is None:
        raise HTTPException(status_code=404, detail={"code": "environment_not_found"})
    return env


@router.get("/environments")
async def list_environments(db: DbSession,
                            actor: AuthContext = require_permission("deploy", "view")):
    return {"environments": [await serialize.environment_out(db, env)
                             for env in await environments.list_all(db)]}


@router.get("/environments/{name}")
async def get_environment(name: str, db: DbSession,
                          actor: AuthContext = require_permission("deploy", "view")):
    return await serialize.environment_out(db, await _environment(db, name))


@router.post("/environments", status_code=201)
async def create_environment(body: EnvironmentIn, request: Request, db: DbSession,
                             actor: AuthContext = require_permission("deploy", "add")):
    settings = get_settings()
    actor_id = actor.user.person_id
    report = None
    try:
        if body.mode == "new":
            env = await environments.create_new(
                db, settings, name=body.name, type_=body.type, target_id=body.target,
                git_ref=body.git_ref, base_domain=body.base_domain, proxy_ip=body.proxy_ip,
                bind_ip=body.bind_ip, ports=body.ports, actor_id=actor_id)
        else:
            env, _, report = await environments.adopt(
                db, settings, name=body.name, type_=body.type, target_id=body.target,
                git_ref=body.git_ref, actor_id=actor_id)
    except environments.EnvError as e:
        raise _env_http(e) from None
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None
    if report is None:
        audit(db, actor_id=actor_id, action="deploy.environment_create",
              entity_type="environment", entity_id=env.name, ip=client_ip(request),
              changes={"name": env.name, "type": env.type, "target": env.target_id,
                       "base_domain": env.base_domain, "git_ref": env.git_ref,
                       "proxy_ip": env.proxy_ip, "bind_ip": env.bind_ip})
    else:
        audit(db, actor_id=actor_id, action="deploy.environment_adopt",
              entity_type="environment", entity_id=env.name, ip=client_ip(request),
              changes={"name": env.name, "type": env.type, "target": env.target_id,
                       "sha": report.sha, "image_tag": env.image_tag,
                       "imported_secrets": report.imported_secrets,
                       "ignored_keys": report.ignored_keys})
    await db.commit()
    await db.refresh(env)
    out = await serialize.environment_out(db, env)
    if report is not None:
        out["ignored_keys"] = report.ignored_keys
    return out


@router.patch("/environments/{name}")
async def update_environment(name: str, body: EnvironmentPatch, request: Request,
                             db: DbSession,
                             actor: AuthContext = require_permission("deploy", "change")):
    env = await _environment(db, name)
    try:
        changed = await environments.update(db, get_settings(), env,
                                            body.model_dump(exclude_unset=True))
    except environments.EnvError as e:
        raise _env_http(e) from None
    if changed:
        audit(db, actor_id=actor.user.person_id, action="deploy.environment_update",
              entity_type="environment", entity_id=env.name, ip=client_ip(request),
              changes={"changed": changed})
        await db.commit()
        await db.refresh(env)
    return await serialize.environment_out(db, env)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/pytest -q tests/test_deploy_environments_api.py tests/test_deploy_api.py`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/src/sirdar_api/api/routes/deploy.py \
  sirdar/api/tests/deploy_factories.py sirdar/api/tests/test_deploy_environments_api.py
git commit -m "feat(sirdar): environment endpoints — list, get, create or adopt, edit"
```

---
### Task 11: Deployment endpoints

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (imports; append the deployment section)
- Test: `sirdar/api/tests/test_deploy_deployments_api.py`

**Interfaces:**
- Consumes: `pipeline.*` (Task 8), `gitref.resolve_ref`, `gitref.RefError` (Task 5), `vault.is_configured` (Task 2), `steps.plan_for` (Task 6), `serialize.*`, `_environment`, `_ssh_http`, `_SSH_ERRORS` (Task 10).
- Produces (routes, under `/api/deploy`):
  - `POST /environments/{name}/deployments` (add; `mode: "reset"` also needs change) body `{mode="update", git_ref?, confirm_name?}` → 201 `deployment_out`. Errors: 403 `forbidden`; 404 `environment_not_found`; 422 `confirm_name_mismatch` (reset without the exact name); 409 `deploy_in_progress`; 400 `secrets_key_missing` / `target_not_configured`; 422 `ref_invalid` / `ref_not_found`; 502 `git_missing` / `ref_lookup_failed` (with `reason`); host-key 409s and 502 `connect_failed`. Audit `deploy.deployment_start` `{environment, mode, git_ref, sha}`.
  - `GET /environments/{name}/deployments?limit=20` (view, 1–100) → `{"deployments": [deployment_summary…]}` newest first.
  - `GET /deployments/{id}?tail=8000` (view, `0 ≤ tail ≤ 262144`) → `deployment_out`; 404 `deployment_not_found`.
  - `POST /deployments/{id}/cancel` (change) → 202 `{"id", "status": "cancelling"}` (task running here) or `{"id", "status": "cancelled"}` (no task: record closed); 409 `not_running`. Audit `deploy.deployment_cancel` `{environment, mode, sha}`.
  - `POST /deployments/{id}/retry` (add; a reset deployment also needs change and `confirm_name`) body `{from_step?, confirm_name?}` → 201 new `deployment_out` with `retry_of` and `start_step`. Errors: 409 `not_retryable` (not failed/cancelled/interrupted, or adopt), 409 `retry_not_latest`, 422 `from_step_invalid` (not in the mode's plan, or after the stopped step), 422 `confirm_name_mismatch`, plus the target errors above. Audit `deploy.deployment_retry` `{environment, mode, git_ref, sha, retry_of, from_step}`.

- [ ] **Step 1: Write the failing test**

`sirdar/api/tests/test_deploy_deployments_api.py`:

```python
import asyncio
import uuid

import pytest
from sqlalchemy import delete, select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, PermissionOverride, SshKnownHost, User
from sirdar_api.deploy import pipeline
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_runner, leak_guard, make_environment, secrets_key, stop_pipeline, trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401

START = "/api/deploy/environments/uat/deployments"
LS = "git ls-remote https://github.com/encondata/BaseCampV3.git"
SHA = "e73b99ca" + "2" * 32
OLD = "a" * 40
UPDATE_KEYS = ["preflight", "bootstrap", "fetch", "render", "build", "dump", "up"]
RESET_KEYS = ["preflight", "bootstrap", "fetch", "render", "build", "reset", "up"]


@pytest.fixture
async def ready(db, deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    ssh_server.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    return await make_environment(db, current_sha=OLD)


async def _headers_without_change(client, db) -> dict:
    """A developer with deploy:change denied by an override (add still allowed)."""
    h = await auth_headers(client, db, email="adder@test.example.com", roles=("developer",))
    user = await db.scalar(select(User).where(User.email == "adder@test.example.com"))
    db.add(PermissionOverride(person_id=user.person_id, resource="deploy", action="change",
                              allow=False))
    await db.commit()
    return h


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def _finish(body: dict) -> None:
    await pipeline.wait(uuid.UUID(body["id"]))


async def test_update_deploy_end_to_end(client, db, ready, fake_runner, leak_guard):
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["environment"], body["mode"], body["git_ref"], body["sha"], body["status"],
            body["previous_sha"], body["start_step"]) == (
        "uat", "update", "main", SHA, "running", OLD, 1)
    assert [s["key"] for s in body["steps"]] == UPDATE_KEYS
    await _finish(body)

    got = (await client.get(f"/api/deploy/deployments/{body['id']}", headers=h)).json()
    assert (got["status"], got["actor_name"], got["error"]) == ("succeeded", "Boss User", None)
    assert got["finished_at"] is not None
    first = got["steps"][0]
    assert (first["status"], first["log_tail"], first["log_size"]) == (
        "succeeded", "ok: [target] preflight\n", len("ok: [target] preflight\n"))
    short = (await client.get(f"/api/deploy/deployments/{body['id']}?tail=5",
                              headers=h)).json()
    assert short["steps"][0]["log_tail"] == "ight\n"
    none = (await client.get(f"/api/deploy/deployments/{body['id']}?tail=0", headers=h)).json()
    assert none["steps"][0]["log_tail"] == ""

    listed = (await client.get(START, headers=h)).json()["deployments"]
    assert [d["id"] for d in listed] == [body["id"]]
    assert "steps" not in listed[0]
    env = (await client.get("/api/deploy/environments/uat", headers=h)).json()
    assert (env["status"], env["current_sha"], env["image_tag"]) == ("ready", SHA, "e73b99ca")
    assert env["last_deployment"]["id"] == body["id"]
    assert await _audits(db, "deploy.deployment_start") == [
        {"environment": "uat", "mode": "update", "git_ref": "main", "sha": SHA}]


async def test_permissions(client, db, ready, fake_runner, leak_guard):
    assert (await client.get(START)).status_code == 401
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get(START, headers=admin)).json() == {"deployments": []}
    some = uuid.uuid4()
    for url in (START, f"/api/deploy/deployments/{some}/cancel",
                f"/api/deploy/deployments/{some}/retry"):
        resp = await client.post(url, headers=admin, json={})
        assert resp.status_code == 403, url
        assert resp.json()["detail"]["code"] == "forbidden"


async def test_reset_needs_change_and_the_typed_name(client, db, ready, fake_runner,
                                                     leak_guard):
    adder = await _headers_without_change(client, db)
    resp = await client.post(START, headers=adder, json={"mode": "reset", "confirm_name": "uat"})
    assert (resp.status_code, resp.json()) == (403, {"detail": {"code": "forbidden"}})
    resp = await client.post(START, headers=adder, json={})
    assert resp.status_code == 201, resp.text            # Update needs only add
    await _finish(resp.json())

    h = await auth_headers(client, db)
    for confirm in (None, "UAT", "uat "):
        resp = await client.post(START, headers=h, json={"mode": "reset", "confirm_name": confirm})
        assert (resp.status_code, resp.json()) == (422, {"detail": {
            "code": "confirm_name_mismatch"}})
    resp = await client.post(START, headers=h, json={"mode": "reset", "confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["mode"] == "reset"
    assert [s["key"] for s in body["steps"]] == RESET_KEYS
    await _finish(body)
    resp = await client.post(f"/api/deploy/deployments/{body['id']}/cancel", headers=adder)
    assert resp.status_code == 403


async def test_lock_and_cancel(client, db, ready, fake_runner, leak_guard):
    fake_runner.gates["preflight"] = asyncio.Event()
    h = await auth_headers(client, db)
    first = (await client.post(START, headers=h, json={})).json()
    await asyncio.wait_for(fake_runner.started["preflight"].wait(), 5)

    resp = await client.post(START, headers=h, json={})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "deploy_in_progress"}})
    resp = await client.patch("/api/deploy/environments/uat", headers=h, json={"keep_dumps": 3})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "deploy_in_progress"}})

    resp = await client.post(f"/api/deploy/deployments/{first['id']}/cancel", headers=h)
    assert (resp.status_code, resp.json()) == (202, {"id": first["id"], "status": "cancelling"})
    await _finish(first)
    got = (await client.get(f"/api/deploy/deployments/{first['id']}", headers=h)).json()
    assert (got["status"], got["error"]) == ("cancelled", "Cancelled.")
    assert [s["status"] for s in got["steps"]] == ["cancelled"] + ["not_run"] * 6
    resp = await client.post(f"/api/deploy/deployments/{first['id']}/cancel", headers=h)
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "not_running"}})
    assert await _audits(db, "deploy.deployment_cancel") == [
        {"environment": "uat", "mode": "update", "sha": SHA}]


async def test_cancel_without_a_task_closes_the_record(client, db, ready, leak_guard):
    dep = await pipeline.create_deployment(db, ready, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None)
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.post(f"/api/deploy/deployments/{dep.id}/cancel", headers=h)
    assert (resp.status_code, resp.json()) == (202, {"id": str(dep.id), "status": "cancelled"})
    got = (await client.get(f"/api/deploy/deployments/{dep.id}", headers=h)).json()
    assert got["status"] == "cancelled"


async def test_retry_from_the_failed_step(client, db, ready, fake_runner, leak_guard):
    fake_runner.results["build"] = RunResult(status="failed", rc=2)
    h = await auth_headers(client, db)
    first = (await client.post(START, headers=h, json={})).json()
    await _finish(first)
    got = (await client.get(f"/api/deploy/deployments/{first['id']}", headers=h)).json()
    assert (got["status"], got["failed_step"], got["error"]) == (
        "failed", 5, "Step 5 (Build images) failed. See its log.")

    retry = f"/api/deploy/deployments/{first['id']}/retry"
    for payload in ({"from_step": 6}, {"from_step": 7}, {"from_step": 0}):
        resp = await client.post(retry, headers=h, json=payload)
        assert resp.status_code == 422, payload

    del fake_runner.results["build"]
    fake_runner.requests.clear()
    resp = await client.post(retry, headers=h, json={})
    assert resp.status_code == 201, resp.text
    second = resp.json()
    assert (second["start_step"], second["retry_of"], second["sha"], second["mode"]) == (
        5, first["id"], SHA, "update")
    await _finish(second)
    assert fake_runner.steps() == ["build", "dump", "up"]
    got = (await client.get(f"/api/deploy/deployments/{second['id']}", headers=h)).json()
    assert got["status"] == "succeeded"
    assert [s["status"] for s in got["steps"]] == ["skipped"] * 4 + ["succeeded"] * 3

    resp = await client.post(retry, headers=h, json={})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "retry_not_latest"}})
    resp = await client.post(f"/api/deploy/deployments/{second['id']}/retry", headers=h, json={})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "not_retryable"}})
    assert await _audits(db, "deploy.deployment_retry") == [{
        "environment": "uat", "mode": "update", "git_ref": "main", "sha": SHA,
        "retry_of": first["id"], "from_step": 5}]


async def test_ref_errors_and_a_full_sha(client, db, ready, ssh_server, fake_runner, leak_guard):
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={"git_ref": "a..b"})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "ref_invalid"}})
    ssh_server.overrides[f"{LS} nope"] = ""
    resp = await client.post(START, headers=h, json={"git_ref": "nope"})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "ref_not_found"}})
    ssh_server.overrides[f"{LS} gone"] = ""
    ssh_server.exits[f"{LS} gone"] = 127
    resp = await client.post(START, headers=h, json={"git_ref": "gone"})
    assert resp.status_code == 502
    assert resp.json()["detail"]["code"] == "git_missing"
    assert "git" in resp.json()["detail"]["reason"]

    full = "b" * 40
    resp = await client.post(START, headers=h, json={"git_ref": full})
    assert resp.status_code == 201, resp.text
    assert resp.json()["sha"] == full
    assert not any(c.startswith(LS) and full in c for c in ssh_server.commands)
    await _finish(resp.json())


async def test_untrusted_host_is_409_with_the_connect_shape(client, db, ready, ssh_server,
                                                            leak_guard):
    await db.execute(delete(SshKnownHost))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={})
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "host_key_unknown", "host": "127.0.0.1",
                                     "port": ssh_server.port, "key_type": "ssh-ed25519",
                                     "fingerprint": ssh_server.fingerprint}


async def test_preconditions(client, db, ready, monkeypatch, secrets_key, leak_guard):
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/environments/nope/deployments", headers=h, json={})
    assert (resp.status_code, resp.json()) == (404, {"detail": {"code": "environment_not_found"}})
    resp = await client.get(f"/api/deploy/deployments/{uuid.uuid4()}", headers=h)
    assert (resp.status_code, resp.json()) == (404, {"detail": {"code": "deployment_not_found"}})
    assert (await client.get("/api/deploy/deployments/not-a-uuid", headers=h)).status_code == 422
    resp = await client.get(f"/api/deploy/deployments/{uuid.uuid4()}?tail=-1", headers=h)
    assert resp.status_code == 422
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    resp = await client.post(START, headers=h, json={})
    assert (resp.status_code, resp.json()) == (400, {"detail": {"code": "secrets_key_missing"}})
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", secrets_key)    # the leak guard reads with it
    get_settings.cache_clear()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest -q tests/test_deploy_deployments_api.py`
Expected: FAIL — the start route doesn't exist yet (`assert 405 == 201` / `404`).

- [ ] **Step 3: The routes**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, add `import uuid` to the standard-library imports, `from sqlalchemy import select` to the third-party imports, and extend the project imports to:

```python
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, SshKnownHost
from sirdar_api.deploy import (
    ConnectFailed, digitalocean, environments, gitref, known_hosts, names, pipeline, serialize,
    ssh, targets, vault,
)
from sirdar_api.deploy.ssh import SshTargetConfig
from sirdar_api.deploy.steps import plan_for
```

Then append:

```python
# ---- deployments (deploy pipeline) ---------------------------------------------

_REF_STATUS = {"ref_invalid": 422, "ref_not_found": 422, "git_missing": 502,
               "ref_lookup_failed": 502}
_REF_REASON = {
    "git_missing": "git isn't installed on the target. Install it "
                   "(sudo apt-get install git) and try again.",
    "ref_lookup_failed": "The target couldn't list the repository's branches and tags.",
}


class DeploymentIn(BaseModel):
    mode: Literal["update", "reset"] = "update"
    git_ref: str | None = Field(default=None, max_length=200)
    # Reset only: must equal the environment's name exactly.
    confirm_name: str | None = Field(default=None, max_length=64)


class RetryIn(BaseModel):
    from_step: int | None = Field(default=None, ge=1, le=99)
    confirm_name: str | None = Field(default=None, max_length=64)


def _forbidden() -> HTTPException:
    return HTTPException(status_code=403, detail={"code": "forbidden"})


def _require_mode(actor: AuthContext, mode: str) -> None:
    """Update needs deploy:add (the route's guard); Reset also needs change."""
    if mode == "reset" and not actor.access.can("deploy", "change"):
        raise _forbidden()


def _deploy_target(env: Environment) -> SshTargetConfig:
    settings = get_settings()
    if not vault.is_configured(settings):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    cfg = targets.ssh_config_for(env.target_id, settings)
    if cfg is None:
        raise HTTPException(status_code=400, detail={"code": "target_not_configured"})
    return cfg


async def _deployment(db, deployment_id: uuid.UUID) -> Deployment:
    dep = await db.get(Deployment, deployment_id)
    if dep is None:
        raise HTTPException(status_code=404, detail={"code": "deployment_not_found"})
    return dep


async def _launch(db, env: Environment, request: Request, actor: AuthContext, *, action: str,
                  mode: str, git_ref: str, sha: str, start_step: int = 1,
                  retry_of: uuid.UUID | None = None) -> dict:
    env_name = env.name           # read now: a lock conflict rolls the session back
    try:
        dep = await pipeline.create_deployment(db, env, mode=mode, git_ref=git_ref, sha=sha,
                                               actor_id=actor.user.person_id,
                                               start_step=start_step, retry_of=retry_of)
    except pipeline.DeployInProgress:
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"}) from None
    changes: dict = {"environment": env_name, "mode": mode, "git_ref": git_ref, "sha": sha}
    if retry_of is not None:
        changes |= {"retry_of": str(retry_of), "from_step": start_step}
    audit(db, actor_id=actor.user.person_id, action=action, entity_type="deployment",
          entity_id=str(dep.id), ip=client_ip(request), changes=changes)
    await db.commit()
    pipeline.launch(dep.id)
    return await serialize.deployment_out(db, dep, environment_name=env_name)


@router.post("/environments/{name}/deployments", status_code=201)
async def start_deployment(name: str, body: DeploymentIn, request: Request, db: DbSession,
                           actor: AuthContext = require_permission("deploy", "add")):
    _require_mode(actor, body.mode)
    env = await _environment(db, name)
    if body.mode == "reset" and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    cfg = _deploy_target(env)
    ref = body.git_ref or env.git_ref
    try:
        sha = await gitref.resolve_ref(cfg, db, get_settings().deploy_repo_url, ref)
    except gitref.RefError as e:
        detail: dict = {"code": e.code}
        if e.code in _REF_REASON:
            detail["reason"] = _REF_REASON[e.code]
        raise HTTPException(status_code=_REF_STATUS[e.code], detail=detail) from None
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode=body.mode, git_ref=ref, sha=sha)


@router.get("/environments/{name}/deployments")
async def list_deployments(name: str, db: DbSession,
                           limit: int = Query(default=20, ge=1, le=100),
                           actor: AuthContext = require_permission("deploy", "view")):
    env = await _environment(db, name)
    rows = await serialize.recent_deployments(db, env.id, limit)
    return {"deployments": [await serialize.deployment_summary(db, d) for d in rows]}


@router.get("/deployments/{deployment_id}")
async def get_deployment(deployment_id: uuid.UUID, db: DbSession,
                         tail: int = Query(default=serialize.LOG_TAIL_DEFAULT, ge=0,
                                           le=pipeline.LOG_LIMIT),
                         actor: AuthContext = require_permission("deploy", "view")):
    dep = await _deployment(db, deployment_id)
    env = await db.get(Environment, dep.environment_id)
    return await serialize.deployment_out(db, dep, environment_name=env.name, tail=tail)


@router.post("/deployments/{deployment_id}/cancel", status_code=202)
async def cancel_deployment(deployment_id: uuid.UUID, request: Request, db: DbSession,
                            actor: AuthContext = require_permission("deploy", "change")):
    dep = await _deployment(db, deployment_id)
    if dep.status != "running":
        raise HTTPException(status_code=409, detail={"code": "not_running"})
    env = await db.get(Environment, dep.environment_id)
    audit(db, actor_id=actor.user.person_id, action="deploy.deployment_cancel",
          entity_type="deployment", entity_id=str(dep.id), ip=client_ip(request),
          changes={"environment": env.name, "mode": dep.mode, "sha": dep.sha})
    await db.commit()
    if pipeline.request_cancel(dep.id):
        return {"id": str(dep.id), "status": "cancelling"}
    await pipeline.close_orphan(dep.id)        # running record, no task in this process
    return {"id": str(dep.id), "status": "cancelled"}


@router.post("/deployments/{deployment_id}/retry", status_code=201)
async def retry_deployment(deployment_id: uuid.UUID, body: RetryIn, request: Request,
                           db: DbSession,
                           actor: AuthContext = require_permission("deploy", "add")):
    dep = await _deployment(db, deployment_id)
    _require_mode(actor, dep.mode)
    if dep.status not in pipeline.RETRYABLE_STATUSES or dep.mode not in ("update", "reset"):
        raise HTTPException(status_code=409, detail={"code": "not_retryable"})
    env = await db.get(Environment, dep.environment_id)
    if dep.mode == "reset" and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    latest = await serialize.latest_deployment(db, env.id)
    if latest is None or latest.id != dep.id:
        raise HTTPException(status_code=409, detail={"code": "retry_not_latest"})
    stopped = await db.scalar(
        select(DeploymentStep.number)
        .where(DeploymentStep.deployment_id == dep.id,
               DeploymentStep.status.in_(pipeline.RETRYABLE_STATUSES))
        .order_by(DeploymentStep.number).limit(1))
    if stopped is None:
        raise HTTPException(status_code=409, detail={"code": "not_retryable"})
    from_step = body.from_step or stopped
    if from_step not in [s.number for s in plan_for(dep.mode)] or from_step > stopped:
        raise HTTPException(status_code=422, detail={"code": "from_step_invalid"})
    cfg = _deploy_target(env)
    try:
        await ssh.pinned_host_key(db, cfg.host, cfg.port)
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None
    return await _launch(db, env, request, actor, action="deploy.deployment_retry",
                         mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                         start_step=from_step, retry_of=dep.id)
```

Note for the reviewer: `retry` with `{"from_step": 0}` is rejected by the body model (`ge=1`), so the test's three 422s come from the model (0) and `from_step_invalid` (6: after the stopped step 5; 7: not in the Update plan).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest -q tests/test_deploy_deployments_api.py tests/test_deploy_environments_api.py tests/test_deploy_pipeline.py`
Expected: PASS (all tests)

- [ ] **Step 5: Run the whole suite**

Run: `.venv/bin/pytest -q`
Expected: every test passes (0 failed).

- [ ] **Step 6: Commit**

```bash
git add sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_deployments_api.py
git commit -m "feat(sirdar): deployment endpoints — start, list, poll, cancel, retry from step"
```

---
### Task 12: Image, compose, installer and docs

**Files:**
- Modify: `sirdar/Dockerfile` (python stage)
- Modify: `sirdar/docker-compose.yml` (`sirdar` service)
- Modify: `sirdar/.env.example` (append)
- Modify: `sirdar/install.sh` (`ensure_runner_dir`, `ensure_secrets_key`, `write_env`, `main`, `summary`)
- Modify: `sirdar/scripts/dev-env.sh`
- Modify: `sirdar/.gitignore`; Create: `sirdar/runner/.gitkeep` (empty)
- Modify: `sirdar/README.md`

**Interfaces:**
- Consumes: settings `SIRDAR_SECRETS_KEY`, `SIRDAR_RUNNER_DIR`, `SIRDAR_DEPLOY_REPO_URL` (Task 2); the pinned dependencies and package data (Task 6).
- Produces: an image with `ssh`, `sshpass`, `ansible-playbook` 2.21.4, `ansible-runner` 2.4.3, the playbooks inside the installed package, `HOME=/home/sirdar`, `/app/runner` (uid 10001, mode 700); compose mounts `./runner` there; the installer writes `SIRDAR_SECRETS_KEY` (generated, never prompted) on first install and on any re-run whose `.env` lacks the line, and creates `sirdar/runner` (uid 10001, 700) on every run.

- [ ] **Step 1: Dockerfile**

In `sirdar/Dockerfile`, replace everything from `FROM python:3.13-slim` down to (not including) `USER sirdar` with:

```dockerfile
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SIRDAR_STATIC_DIR=/app/static \
    HOME=/home/sirdar SIRDAR_RUNNER_DIR=/app/runner
# Deploy pipeline: ansible-runner drives ansible-playbook (both pip packages,
# pinned in pyproject.toml), which connects with ssh, and through sshpass for
# targets that use a password.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client sshpass \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/api
COPY sirdar/api/pyproject.toml ./
COPY sirdar/api/src ./src
RUN pip install --no-cache-dir .
COPY sirdar/api/alembic.ini ./
COPY sirdar/api/migrations ./migrations
COPY --from=web /app/sirdar/web/dist /app/static
COPY sirdar/docker-entrypoint.sh /usr/local/bin/sirdar-entrypoint
# uid 10001 gets a home (ssh and Ansible keep small state under $HOME) and the
# runner folder (compose mounts sirdar/runner over it).
RUN chmod 755 /usr/local/bin/sirdar-entrypoint \
 && useradd --system --uid 10001 --create-home --home-dir /home/sirdar sirdar \
 && install -d -o sirdar -g sirdar -m 700 /app/runner
```

- [ ] **Step 2: Compose**

In `sirdar/docker-compose.yml`, add to the `sirdar` service's `environment` (after `SIRDAR_DEPLOY_TARGETS_FILE`):

```yaml
      # Deploy runs: one private Ansible folder per step, deleted afterwards.
      SIRDAR_RUNNER_DIR: /app/runner
```

and to its `volumes` (after `./config:/app/config`):

```yaml
      # Deploy run folders hold a run's secrets while it runs: owned by uid
      # 10001, mode 700 (the installer sets that up).
      - ./runner:/app/runner
```

- [ ] **Step 3: `.env.example`, `.gitignore`, dev script**

Append to `sirdar/.env.example`:

```
# ── Deploy pipeline (environments) ─────────────────────────────────
# Fernet key that encrypts every environment's secrets in Sirdar's database.
# The installer generates it. Back it up together with this file: without it
# the stored secrets can't be read. Blank = deploying is off. Generate with:
#   python3 -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'
SIRDAR_SECRETS_KEY=
# Where targets clone ServerSherpa from (an https:// git URL).
# SIRDAR_DEPLOY_REPO_URL=https://github.com/encondata/BaseCampV3.git
```

Append to `sirdar/.gitignore`:

```
runner/*
!runner/.gitkeep
```

Create the empty file `sirdar/runner/.gitkeep`.

In `sirdar/scripts/dev-env.sh`, after the `JWT=` lines add:

```bash
SECRETS=$(grep -E '^SIRDAR_SECRETS_KEY=' .env 2>/dev/null | cut -d= -f2- || true)
[[ -n "$SECRETS" ]] || SECRETS=$(python3 -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')
```

and add these two lines inside the heredoc, after `SIRDAR_DEPLOY_TARGETS_FILE=…`:

```
SIRDAR_SECRETS_KEY=$SECRETS
SIRDAR_RUNNER_DIR=$PWD/runner
```

Also change the script's header comment `Re-run safely: it keeps an existing SIRDAR_JWT_SECRET.` to `Re-run safely: it keeps an existing SIRDAR_JWT_SECRET and SIRDAR_SECRETS_KEY.`

- [ ] **Step 4: Installer**

In `sirdar/install.sh`:

1. Directly above `NEW_SETTINGS=(…)`, add a comment line:

```bash
# (SIRDAR_SECRETS_KEY is not in this list: nobody types it, so
# ensure_secrets_key generates it without a prompt.)
```

2. After the `ensure_config_dir` function, add:

```bash
# Deploy steps run Ansible in <dir>/sirdar/runner (mounted at /app/runner):
# one private folder per run, holding that run's secrets until it ends. The
# folder must belong to the container user (uid 10001) and nobody else (700).
ensure_runner_dir() {  # ensure_runner_dir DIR
  local d="$1" ok=1
  mkdir -p "$d" 2>/dev/null || as_root mkdir -p "$d" || ok=0
  if [ "$ok" = 1 ]; then
    if [ "$(stat -c %u "$d" 2>/dev/null || stat -f %u "$d" 2>/dev/null || echo '')" != 10001 ]; then
      as_root chown 10001:10001 "$d" || ok=0
    fi
    chmod 700 "$d" 2>/dev/null || as_root chmod 700 "$d" || ok=0
  fi
  if [ "$ok" != 1 ]; then
    warn "couldn't give $d to uid 10001, so deployments will fail until it is. Run: sudo chown 10001:10001 '$d' && sudo chmod 700 '$d'"
  fi
  return 0
}

# SIRDAR_SECRETS_KEY encrypts each environment's secrets in Sirdar's database.
# Nobody types it, so it is generated (never prompted) whenever the .env has
# no such line, interactive or not. A present line, even a blank one, is left
# alone: a new key would make the stored secrets unreadable.
ensure_secrets_key() {  # ensure_secrets_key ENVFILE
  local target="$1" tmp
  grep -q '^SIRDAR_SECRETS_KEY=' "$target" && return 0
  tmp=$(mktemp "$target.new.XXXXXX")
  TMP_FILES+=("$tmp")
  chmod 600 "$tmp"
  cat "$target" >"$tmp"
  # A file without a final newline would otherwise glue the key onto its last line.
  [ ! -s "$tmp" ] || [ -z "$(tail -c 1 "$tmp")" ] || printf '\n' >>"$tmp"
  printf 'SIRDAR_SECRETS_KEY=%s\n' "$(fernet_key)" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$target"
  info "Added SIRDAR_SECRETS_KEY (generated) to $target. Back it up with that file: without it Sirdar can't read the environments' stored secrets."
}
```

3. In `write_env`, after `set_env_key SS_TOTP_ENCRYPTION_KEY "$totp" "$tmp"` add:

```bash
  set_env_key SIRDAR_SECRETS_KEY "$(fernet_key)" "$tmp"
```

and in its summary `printf` list, after `SIRDAR_DB_PASSWORD "$s_dbpw"` add a continuation so it ends:

```bash
    SIRDAR_DB_PASSWORD "$s_dbpw" \
    SIRDAR_SECRETS_KEY "generated (back it up with this file)"
```

4. In `main`, after `ensure_config_dir "$DIR/sirdar/config"` add `ensure_runner_dir "$DIR/sirdar/runner"`, and in the existing-`.env` branch call `ensure_secrets_key` before `add_new_settings`:

```bash
  if [ -f "$DIR/sirdar/.env" ]; then
    info "Keeping existing $DIR/sirdar/.env"
    ensure_secrets_key "$DIR/sirdar/.env"
    add_new_settings "$DIR/sirdar/.env"
  else
```

5. In `summary`, after the `Saved SSH targets:` line add:

```
  Deploy runs:  $DIR/sirdar/runner   (SIRDAR_SECRETS_KEY is in .env: back it up)
```

- [ ] **Step 5: README**

In `sirdar/README.md`:

1. Under `## Tests`, add a bullet after the API one:
   `- Deploy runner, end to end (opt-in; needs Docker and sshpass): SIRDAR_RUNNER_E2E=1 .venv/bin/pytest -q tests/test_runner_e2e.py`
2. Under `## Local development`, add after step 3: `   Deploy runs also need sshpass for password-auth targets: brew install sshpass (ansible-playbook comes with the virtualenv).`
3. Add this section directly before `### Supported systems`:

````markdown
### Deploy pipeline (environments)

Sirdar deploys ServerSherpa environments (the five Compose stacks in
`deploy/stack`) to a saved Custom (SSH) target. This part is the API; the
web UI comes next.

**Secrets key.** `SIRDAR_SECRETS_KEY` (a Fernet key) encrypts every
environment's secrets in Sirdar's database. The installer generates it,
without a prompt, when `.env` has no such line. Back it up together with
`.env`: without it the stored secrets can't be read, and a different key
leaves existing environments undeployable. Blank means deploying is off
(`secrets_key_missing`).

**Runner folder.** Each step runs Ansible in a private folder under
`sirdar/runner/` (mounted at `/app/runner`, owned by uid 10001, mode 700).
A run's folder holds its secrets only while it runs and is deleted
afterwards. The installer creates the folder; by hand:
`mkdir -p sirdar/runner && sudo chown 10001:10001 sirdar/runner && sudo chmod 700 sirdar/runner`.

**Targets.** Ubuntu or Debian, with sudo and git. Sirdar logs in as the
target's saved SSH user. Root steps (installing Docker, creating
`/opt/serversherpa/<env>`) go through sudo with the saved SSH password, or
with the target's **sudo password** for key-only targets (write-only, like
the other target secrets). Trust the host key on the Deploy page first;
every run pins it. Code comes from `SIRDAR_DEPLOY_REPO_URL` (default
`https://github.com/encondata/BaseCampV3.git`); a branch or tag becomes a
commit through `git ls-remote` on the target.

**Steps.** 1 Preflight · 2 Bootstrap · 3 Fetch code · 4 Render config ·
5 Build images · 6 Pre-deploy dump (Update) · 7 Reset data (Reset) ·
8 Start services. The first failure stops the deployment; retry re-runs
from the failed step. One deployment per environment at a time. Reset
deletes the environment's data: it needs `deploy:change` and the
environment's name typed back (`confirm_name`).

**Adopting a hand-built environment** (`POST /api/deploy/environments` with
`"mode": "adopt"`): Sirdar reads `/opt/serversherpa/<name>/.env` and the
checkout's commit over SSH and imports them, secrets encrypted. Nothing on
the host changes. Keys Sirdar doesn't manage come back in `ignored_keys`
and are left out of `.env` on the next deploy.

| API (under `/api/deploy`) | Needs |
|---|---|
| `GET /environments`, `GET /environments/{name}` | `deploy:view` |
| `POST /environments` (`mode`: `new` or `adopt`) | `deploy:add` |
| `PATCH /environments/{name}` | `deploy:change` |
| `POST /environments/{name}/deployments` (`mode`: `update` or `reset`) | `deploy:add`; Reset also `deploy:change` |
| `GET /environments/{name}/deployments`, `GET /deployments/{id}?tail=N` | `deploy:view` |
| `POST /deployments/{id}/cancel` | `deploy:change` |
| `POST /deployments/{id}/retry` | `deploy:add`; a Reset deployment also `deploy:change` |

Deployments run inside Sirdar's single API process. Restarting Sirdar marks
running deployments `interrupted`; retry them.
````

- [ ] **Step 6: Verify the installer functions**

Run from the worktree root:

```bash
bash -n sirdar/install.sh && echo syntax-ok
tmp=$(mktemp -d)
printf 'SIRDAR_ENV=production\nSIRDAR_PORT=8098' > "$tmp/.env"
SIRDAR_INSTALL_LIB=1 bash -c '. sirdar/install.sh; ensure_secrets_key "$1"; ensure_secrets_key "$1"' _ "$tmp/.env"
grep -c '^SIRDAR_SECRETS_KEY=' "$tmp/.env"
grep '^SIRDAR_PORT=' "$tmp/.env"
grep -qE '^SIRDAR_SECRETS_KEY=[A-Za-z0-9_-]{43}=$' "$tmp/.env" && echo key-ok
stat -f %Lp "$tmp/.env" 2>/dev/null || stat -c %a "$tmp/.env"
SIRDAR_INSTALL_LIB=1 bash -c '. sirdar/install.sh; as_root() { echo "as_root $*"; }; ensure_runner_dir "$1/runner"' _ "$tmp"
stat -f %Lp "$tmp/runner" 2>/dev/null || stat -c %a "$tmp/runner"
SIRDAR_NONINTERACTIVE=1 SIRDAR_INSTALL_LIB=1 bash -c '. sirdar/install.sh; write_env sirdar/.env.example "$1"' _ "$tmp/new.env" >/dev/null 2>&1
grep -cE '^SIRDAR_SECRETS_KEY=[A-Za-z0-9_-]{43}=$' "$tmp/new.env"
command -v shellcheck >/dev/null && shellcheck sirdar/install.sh && echo shellcheck-ok
```

Expected, in order: `syntax-ok`; one `==> Added SIRDAR_SECRETS_KEY (generated) …` line (the second call adds nothing); `1`; `SIRDAR_PORT=8098`; `key-ok`; `600`; `as_root chown 10001:10001 <tmp>/runner`; `700`; `1`; and `shellcheck-ok` when shellcheck is installed.

- [ ] **Step 7: Verify compose and the image**

```bash
SIRDAR_DB_PASSWORD=x docker compose -f sirdar/docker-compose.yml config \
  | grep -n -e 'SIRDAR_RUNNER_DIR' -e 'target: /app/runner'
docker build -f sirdar/Dockerfile -t sirdar:phase2a .
docker run --rm --entrypoint sh sirdar:phase2a -c 'id -u; echo "$HOME"; stat -c %a /app/runner; ansible-playbook --version | head -n 1; ansible-runner --version; command -v ssh sshpass; python -c "from importlib import resources; print(sorted(p.name for p in resources.files(\"sirdar_api.deploy\").joinpath(\"ansible\").iterdir()))"'
```

Expected: the compose output shows `SIRDAR_RUNNER_DIR: /app/runner` and `target: /app/runner`; the build succeeds; the run prints

```
10001
/home/sirdar
700
ansible-playbook [core 2.21.4]
2.4.3
/usr/bin/ssh
/usr/bin/sshpass
['bootstrap.yml', 'build.yml', 'dump.yml', 'fetch.yml', 'preflight.yml', 'render.yml', 'reset.yml', 'up.yml']
```

- [ ] **Step 8: Commit**

```bash
git add sirdar/Dockerfile sirdar/docker-compose.yml sirdar/.env.example sirdar/install.sh \
  sirdar/scripts/dev-env.sh sirdar/.gitignore sirdar/runner/.gitkeep sirdar/README.md
git commit -m "feat(sirdar): image ships ssh/sshpass/ansible; runner volume; installer writes SIRDAR_SECRETS_KEY"
```

---

### Task 13: Opt-in end-to-end runner test against a real SSH host

A real `AnsibleRunner` run — ansible-runner, ansible-playbook, ssh and sshpass — against a throwaway Ubuntu 24.04 container built by the test. It proves password auth with sudo, key auth, the pinned `known_hosts` (a wrong pin is refused), redaction-free output (no secret printed), the `.env` mode 600, idempotency (a second Render run changes nothing) and run-folder cleanup. The image is built here rather than using `lscr.io/linuxserver/openssh-server`: that image is Alpine without Python, so Ansible modules can't run and Preflight would fail its Ubuntu/Debian check.

**Files:**
- Create: `sirdar/api/tests/test_runner_e2e.py`

**Interfaces:**
- Consumes: `AnsibleRunner`, `RunRequest`, `RunTarget` (Task 7); `known_hosts.trust`, `fetch_host_key`, `fingerprint`, `openssh_line`, `host_key_algorithms`, `ssh.pinned_host_key` (Task 5); `preflight.yml`, `render.yml` (Task 6).

- [ ] **Step 1: Write the test**

`sirdar/api/tests/test_runner_e2e.py`:

```python
"""Opt-in: real playbooks end to end through ansible-runner against a
throwaway Ubuntu 24.04 SSH container that this test builds (about a minute
the first time).

    SIRDAR_RUNNER_E2E=1 .venv/bin/pytest -q tests/test_runner_e2e.py

Needs Docker and sshpass (brew install sshpass) on this machine, plus the
sirdar-db test database like every other test."""

import base64
import dataclasses
import os
import shutil
import socket
import subprocess
import time
import uuid

import asyncssh
import pytest

from sirdar_api.deploy import known_hosts, ssh
from sirdar_api.deploy.runner import AnsibleRunner, RunRequest, RunTarget

pytestmark = pytest.mark.skipif(os.environ.get("SIRDAR_RUNNER_E2E") != "1",
                                reason="opt-in: set SIRDAR_RUNNER_E2E=1")

IMAGE = "sirdar-runner-e2e:latest"
USER = "deployer"
PASSWORD = "e2e-SSH-pw-5150"
ENV_DIR = "/opt/serversherpa/e2e"
DOCKERFILE = f"""
FROM ubuntu:24.04
RUN apt-get update \\
 && apt-get install -y --no-install-recommends openssh-server python3 sudo \\
 && rm -rf /var/lib/apt/lists/* \\
 && mkdir -p /run/sshd \\
 && useradd --create-home --shell /bin/bash {USER} \\
 && echo '{USER}:{PASSWORD}' | chpasswd \\
 && echo '{USER} ALL=(ALL) ALL' > /etc/sudoers.d/{USER} \\
 && chmod 440 /etc/sudoers.d/{USER} \\
 && install -d -o {USER} -m 750 {ENV_DIR}
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def target():
    for tool in ("docker", "sshpass"):
        if shutil.which(tool) is None:
            pytest.fail(f"{tool} not found (sshpass: brew install sshpass)")
    subprocess.run(["docker", "build", "-t", IMAGE, "-"], input=DOCKERFILE, text=True,
                   check=True, capture_output=True)
    port = _free_port()
    name = f"sirdar-runner-e2e-{uuid.uuid4().hex[:8]}"
    subprocess.run(["docker", "run", "-d", "--rm", "--name", name,
                    "-p", f"127.0.0.1:{port}:22", IMAGE], check=True, capture_output=True)
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1) as s:
                    if s.recv(4).startswith(b"SSH-"):
                        break
            except OSError:
                pass
            if time.monotonic() > deadline:
                pytest.fail("the SSH container didn't start")
            time.sleep(0.3)
        yield {"name": name, "port": port}
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def _exec(target, *cmd: str, stdin: str | None = None) -> str:
    return subprocess.run(["docker", "exec", "-i", target["name"], *cmd], input=stdin,
                          text=True, capture_output=True, check=True).stdout


async def _pinned(db, target, **auth) -> RunTarget:
    host, port = "127.0.0.1", target["port"]
    live = await known_hosts.fetch_host_key(host, port)
    await known_hosts.trust(db, host, port, known_hosts.fingerprint(live), actor_id=None)
    await db.commit()
    pinned = await ssh.pinned_host_key(db, host, port)
    return RunTarget(host=host, port=port, user=USER,
                     known_hosts_line=known_hosts.openssh_line(host, port, pinned.public_key),
                     host_key_algorithms=known_hosts.host_key_algorithms(pinned.key_type),
                     **auth)


async def test_preflight_with_password_and_sudo(db, target, tmp_path):
    run_target = await _pinned(db, target, password=PASSWORD, become_password=PASSWORD)
    lines: list[str] = []
    result = await AnsibleRunner(str(tmp_path / "runner")).run(
        RunRequest(step="preflight", playbook="preflight.yml", target=run_target, timeout=300,
                   extravars={"min_disk_gb": 1, "min_memory_mb": 64}),
        lines.append)
    out = "".join(lines)
    assert result.status == "successful", out
    assert "Preflight passed: Ubuntu 24.04" in out
    assert "missing (Bootstrap installs it)" in out
    assert PASSWORD not in out
    assert list((tmp_path / "runner").iterdir()) == []


async def test_render_with_key_auth_is_private_and_idempotent(db, target, tmp_path):
    key = asyncssh.generate_private_key("ssh-ed25519")
    _exec(target, "sh", "-c",
          f"install -d -m 700 -o {USER} /home/{USER}/.ssh"
          f" && cat > /home/{USER}/.ssh/authorized_keys"
          f" && chown {USER} /home/{USER}/.ssh/authorized_keys"
          f" && chmod 600 /home/{USER}/.ssh/authorized_keys",
          stdin=key.export_public_key("openssh").decode())
    run_target = await _pinned(db, target,
                               private_key=key.export_private_key("openssh").decode())
    secret = "render-SECRET-" + uuid.uuid4().hex
    text = f"STACK_ENV=e2e\nPOSTGRES_PASSWORD={secret}\n"
    b64 = base64.b64encode(text.encode()).decode()
    runner = AnsibleRunner(str(tmp_path / "runner"))
    request = RunRequest(step="render", playbook="render.yml", target=run_target, timeout=300,
                         extravars={"env_dir": ENV_DIR, "env_file_b64": b64})
    lines: list[str] = []
    first = await runner.run(request, lines.append)
    second = await runner.run(request, lines.append)
    out = "".join(lines)
    assert (first.status, second.status) == ("successful", "successful"), out
    assert first.changed >= 1 and second.changed == 0
    assert secret not in out and b64 not in out
    assert _exec(target, "cat", f"{ENV_DIR}/.env") == text
    assert _exec(target, "stat", "-c", "%a %U", f"{ENV_DIR}/.env").strip() == f"600 {USER}"


async def test_a_wrong_pinned_key_is_refused(db, target, tmp_path):
    run_target = await _pinned(db, target, password=PASSWORD, become_password=PASSWORD)
    other = asyncssh.generate_private_key("ssh-ed25519").export_public_key("openssh").decode()
    wrong = dataclasses.replace(
        run_target, known_hosts_line=known_hosts.openssh_line("127.0.0.1", target["port"], other))
    lines: list[str] = []
    result = await AnsibleRunner(str(tmp_path / "runner")).run(
        RunRequest(step="preflight", playbook="preflight.yml", target=wrong, timeout=120,
                   extravars={"min_disk_gb": 1, "min_memory_mb": 64}),
        lines.append)
    out = "".join(lines)
    assert result.status == "failed", out
    # With a password, sshpass reports the refused key as "Host Key checking is
    # enabled"; with a key, ssh says "Host key verification failed".
    assert "Host Key checking is enabled" in out or "Host key verification failed" in out
    assert PASSWORD not in out
```

- [ ] **Step 2: Check that it is skipped by default**

Run: `.venv/bin/pytest -q tests/test_runner_e2e.py`
Expected: `3 skipped`

- [ ] **Step 3: Run it for real**

Run: `SIRDAR_RUNNER_E2E=1 .venv/bin/pytest -q tests/test_runner_e2e.py`
Expected: `3 passed` (the first run builds the image), plus a `DeprecationWarning` that `forkpty()` is used in a multi-threaded process: ansible-runner starts ansible-playbook from Sirdar's worker thread through pexpect; harmless here. If Preflight fails, the assertion message is the full Ansible output — fix the playbook or the runner, never the assertion.

- [ ] **Step 4: Run the whole suite one last time**

Run: `.venv/bin/pytest -q`
Expected: 0 failed; the three end-to-end tests are among the skipped ones (the suite already skips a few others).

- [ ] **Step 5: Commit**

```bash
git add sirdar/api/tests/test_runner_e2e.py
git commit -m "test(sirdar): opt-in end-to-end runner test against a real SSH container"
```

---

## Self-review notes

- **Spec coverage (Sections 2–4, 2a scope):** tables `environments`, `environment_services`, `deployments`, `deployment_steps` (+ `environment_secrets`) and the one-running index — Task 3; secrets encrypted with `SIRDAR_SECRETS_KEY`, generated on create and imported on adopt, never in responses/logs/audits — Tasks 2, 9, 10 (leak guard), 8 (redaction); write-only sudo password — Task 4; runner interface, private run folder, pinned `known_hosts` from the TOFU table, redaction, long timeouts — Tasks 5, 7, 8; steps 1–7 + "up" as playbooks — Task 6; Update/Reset plans, stop on first failure, retry from step, per-environment lock, orphan cleanup, task registry with lifespan cancel — Tasks 8, 11; endpoints (list/get/create new|adopt/patch environments; start with `confirm_name` for Reset and ref → SHA via `git ls-remote` on the target; get with steps and log tails; list; cancel; retry) — Tasks 10, 11; adopt reading the remote `.env` — Task 9; image/installer/compose/README — Task 12; fake-runner unit and API tests plus the opt-in real-SSH test — Tasks 7–13; permissions per endpoint and audit rows — Tasks 10, 11.
- **Recorded for 2b / phase 3:** each deployment keeps `dump_path` (step 6) and `previous_sha`, which rollback will use. Rollback itself, snapshots/restore (step 9), DNS/NPM/smoke (12–14) and all UI are out of scope; the dashboard's placeholders are untouched.
- **Spec deviations taken from the context file:** steps 8–11 are one "Start services" step (`ss-stack up` already orders and health-waits them); Bootstrap runs every time (idempotent) instead of "first run"; Bootstrap doesn't install a Sirdar key or a `deploy` user — it uses the target's saved SSH user and makes it a docker-group member owning the environment folder.
- **Dry run (2026-10-03):** every code block of Tasks 1–11 and 13 was applied to a scratch copy of `sirdar/api` (pinned ansible in a scratch venv, test database `sirdar_test_plancheck`, since dropped): the full suite passed (548 passed, 8 skipped) and `SIRDAR_RUNNER_E2E=1` passed 3/3 against a real Ubuntu 24.04 SSH container. Task 12's installer functions passed Step 6 and shellcheck; the Docker image build (Step 7) was not run.
- **Placeholder scan:** no TBD/TODO; every code step has complete code; every command has its expected output.
- **Type consistency checked:** `RunTarget`/`RunRequest`/`RunResult` fields (Tasks 7, 8, 13); `create_deployment(db, env, *, mode, git_ref, sha, actor_id, start_step, retry_of)` (Tasks 8, 11); `EnvError(code, **extra)` and its codes (Tasks 9, 10); `environment_out`/`deployment_out(db, dep, *, environment_name, tail)` (Tasks 10, 11); `PinnedHost.public_key`/`key_type` (Tasks 5, 8, 13); dotenv suffix `SUDO_PASS` vs API field `sudo_password` (Task 4).
