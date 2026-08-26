# Process Monitor & Logging — Plan 3 (ENV Tab + Design Pass + Grafana) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The System Config ENV tab (masked .env viewer/editor + touch-triggered restart), a real visual design pass on the whole System Config page, and Loki+Grafana as first-class dev-stack services with a provisioned datasource.

**Architecture:** A pure `system/env_file.py` parses/rewrites `.env` preserving comments and order; keys are classified hidden (DB/Spaces/compose — never served), secret (Settings `SecretStr` introspection + a name heuristic — masked, keep-on-empty), or plain. Three devtools-gated endpoints serve read/update/restart; restart rewrites a tracked sentinel `.py` so every `--reload` process restarts and re-reads `.env`. The portal page gets an underline tab bar, carded groups, and the new searchable ENV tab. `docker-compose.dev.yml` gains `loki` + `grafana` (provisioned Loki datasource).

**Tech Stack:** FastAPI/pydantic-settings (api/), React+TypeScript+vitest (portal/), docker compose.

**Spec:** `docs/superpowers/specs/2026-08-26-process-monitor-logging-design.md` §5b addendum (approved).

## Global Constraints

- Branch `feature/initiatives`, repo `/Users/jrh1812/Developer/BaseCampV3`. Foreground commands only.
- API tests: `cd api && .venv/bin/pytest tests/<file> -q`. Portal: `cd portal && npx vitest run <file>`; `npx tsc --noEmit`.
- Classification (exact): HIDDEN key prefixes `SS_DATABASE_`, `SS_SPACES_`, `POSTGRES_`, `MINIO_` — never returned, never writable. SECRET = every `Settings` field typed `SecretStr` mapped to `SS_<FIELDNAME_UPPER>` UNION any key whose name matches `SECRET|PASSWORD|KEY|TOKEN|DSN|PEPPER|WORDS` (case-sensitive on the uppercase key) — value never returned, `set` bool instead; empty string on PUT = keep, non-empty = replace. Everything else plain.
- PUT accepts existing visible keys only; unknown/hidden keys → 422 `invalid_env_update` with an `unknown` list. File rewritten atomically (temp + `os.replace`) after copying the current file to `.env.bak`; comments/order/untouched lines byte-preserved.
- Audit: `entity_type="system"`; `action="env_update"` with changed key NAMES only (never values); `action="env_restart"`.
- Restart sentinel: `api/src/serversherpa/_dev_reload.py` (tracked), rewritten with a timestamp comment body — this is what uvicorn `--reload` and the watchfiles workers react to.
- Grafana/Loki: compose services `loki` (grafana/loki:3.0.0, 127.0.0.1:3100, volume `lokidata`) and `grafana` (grafana/grafana:11.1.0, 127.0.0.1:3000, volume `grafanadata`, admin creds `${GRAFANA_ADMIN_USER:-admin}` / `${GRAFANA_ADMIN_PASSWORD:-admin}`, datasource provisioning file mounted read-only) — Loki datasource `url: http://loki:3100`, `isDefault: true`.
- All new endpoints gate `require_permission("devtools", "change")`; errors use `_err` codes.
- Sentence-case copy, active verbs. Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: env_file module + endpoints + sentinel

**Files:**
- Create: `api/src/serversherpa/system/env_file.py`
- Create: `api/src/serversherpa/_dev_reload.py`
- Modify: `api/src/serversherpa/api/routes/system.py` (append)
- Test: `api/tests/test_env_file.py` (pure) + `api/tests/test_env_api.py` (routes)

**Interfaces:**
- Produces (`env_file.py`):
  - `default_env_path() -> Path` — `config._REPO_ROOT / ".env"` (import `_REPO_ROOT` from `serversherpa.config`).
  - `is_hidden(key: str) -> bool`, `is_secret(key: str) -> bool` (per Global Constraints; `_secret_keys()` introspects `Settings.model_fields` for `SecretStr` annotations).
  - `read_entries(path: Path) -> list[dict]` — file order, visible keys only: secret → `{"key", "secret": True, "set": bool}`; plain → `{"key", "secret": False, "value": str}`.
  - `apply_updates(path: Path, values: dict[str, str]) -> list[str]` — returns the changed key names; raises `EnvUpdateError(unknown=[...])` for unknown/hidden keys; secret+empty skipped; atomic rewrite + `.bak`.
  - `class EnvUpdateError(Exception)` with `.unknown: list[str]`.
  - `SENTINEL_PATH: Path` + `touch_sentinel() -> None` (rewrites `_dev_reload.py` with a timestamp comment).
- Produces (routes): `GET /system/env` → `{"entries": [...]}`; `PUT /system/env` body `{"values": {...}}` → `{"changed": [...]}` (audited); `POST /system/env/restart` → `{"restarting": true}` (audited).

- [ ] **Step 1: Write the failing pure tests**

Create `api/tests/test_env_file.py`:

```python
""".env parsing/classification/rewrite — against temp files only."""

import pytest

from serversherpa.system.env_file import (
    EnvUpdateError, apply_updates, is_hidden, is_secret, read_entries,
)

SAMPLE = """# ServerSherpa dev environment
SS_ENV=development
SS_LOG_LEVEL=INFO

# auth
SS_JWT_SECRET=supersecret123
SS_PASSWORD_PEPPER=pepperpepper

# db (hidden)
SS_DATABASE_URL=postgresql+asyncpg://u:p@h/db
POSTGRES_PASSWORD=pgpass

SS_SMTP_HOST=
SS_SENTRY_DSN=https://key@sentry.example/1
"""


@pytest.fixture
def env_path(tmp_path):
    path = tmp_path / ".env"
    path.write_text(SAMPLE)
    return path


def test_classification():
    assert is_hidden("SS_DATABASE_URL")
    assert is_hidden("SS_SPACES_SECRET_KEY")
    assert is_hidden("POSTGRES_PASSWORD")
    assert is_hidden("MINIO_ROOT_USER")
    assert not is_hidden("SS_JWT_SECRET")
    assert is_secret("SS_JWT_SECRET")          # SecretStr introspection
    assert is_secret("SS_PASSWORD_PEPPER")
    assert is_secret("SS_GOD_MODE_WORDS")
    assert is_secret("SS_SENTRY_DSN")          # name heuristic (DSN)
    assert not is_secret("SS_LOG_LEVEL")


def test_read_entries_masks_and_hides(env_path):
    entries = {e["key"]: e for e in read_entries(env_path)}
    assert "SS_DATABASE_URL" not in entries
    assert "POSTGRES_PASSWORD" not in entries
    assert entries["SS_LOG_LEVEL"] == {
        "key": "SS_LOG_LEVEL", "secret": False, "value": "INFO"}
    jwt = entries["SS_JWT_SECRET"]
    assert jwt == {"key": "SS_JWT_SECRET", "secret": True, "set": True}
    assert "supersecret123" not in str(entries)
    assert entries["SS_SMTP_HOST"]["value"] == ""
    # file order preserved
    keys = [e["key"] for e in read_entries(env_path)]
    assert keys.index("SS_ENV") < keys.index("SS_JWT_SECRET")


def test_apply_updates_rewrites_preserving_layout(env_path):
    changed = apply_updates(env_path, {
        "SS_LOG_LEVEL": "DEBUG",
        "SS_JWT_SECRET": "",              # empty secret = keep
        "SS_SMTP_HOST": "smtp.local",
    })
    assert sorted(changed) == ["SS_LOG_LEVEL", "SS_SMTP_HOST"]
    text = env_path.read_text()
    assert "SS_LOG_LEVEL=DEBUG" in text
    assert "SS_JWT_SECRET=supersecret123" in text     # kept
    assert "SS_SMTP_HOST=smtp.local" in text
    assert text.startswith("# ServerSherpa dev environment")
    assert "# auth" in text                            # comments preserved
    backup = env_path.with_suffix(".bak")
    assert backup.exists()
    assert "SS_LOG_LEVEL=INFO" in backup.read_text()   # pre-change copy


def test_apply_updates_replaces_secret(env_path):
    changed = apply_updates(env_path, {"SS_JWT_SECRET": "newsecret"})
    assert changed == ["SS_JWT_SECRET"]
    assert "SS_JWT_SECRET=newsecret" in env_path.read_text()


def test_apply_updates_rejects_unknown_and_hidden(env_path):
    with pytest.raises(EnvUpdateError) as exc:
        apply_updates(env_path, {"SS_DATABASE_URL": "x",
                                 "SS_NOT_A_KEY": "y"})
    assert sorted(exc.value.unknown) == ["SS_DATABASE_URL", "SS_NOT_A_KEY"]
    # nothing written
    assert "SS_DATABASE_URL=postgresql+asyncpg://u:p@h/db" \
        in env_path.read_text()


def test_no_change_is_not_reported(env_path):
    assert apply_updates(env_path, {"SS_LOG_LEVEL": "INFO"}) == []
```

- [ ] **Step 2: Write the failing route tests**

Create `api/tests/test_env_api.py`:

```python
"""ENV endpoints: gates, masking, update, restart sentinel."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog

from .test_assets_api import login
from .test_system_api import _developer_headers, _super_admin_headers

SAMPLE = "SS_ENV=development\nSS_LOG_LEVEL=INFO\nSS_JWT_SECRET=abc\n"


def _use_tmp_env(monkeypatch, tmp_path):
    from serversherpa.system import env_file
    path = tmp_path / ".env"
    path.write_text(SAMPLE)
    monkeypatch.setattr(env_file, "default_env_path", lambda: path)
    return path


async def test_env_gates(client, db, seeded_user):
    staff = await login(client)
    assert (await client.get("/system/env", headers=staff)).status_code == 403
    sa = await _super_admin_headers(db, client)
    assert (await client.get("/system/env", headers=sa)).status_code == 403


async def test_env_read_and_update(client, db, seeded_user, monkeypatch,
                                   tmp_path):
    path = _use_tmp_env(monkeypatch, tmp_path)
    dev = await _developer_headers(db, client)

    resp = await client.get("/system/env", headers=dev)
    assert resp.status_code == 200
    entries = {e["key"]: e for e in resp.json()["entries"]}
    assert entries["SS_JWT_SECRET"] == {"key": "SS_JWT_SECRET",
                                        "secret": True, "set": True}
    assert "abc" not in resp.text

    resp = await client.put("/system/env", headers=dev,
                            json={"values": {"SS_LOG_LEVEL": "DEBUG"}})
    assert resp.status_code == 200
    assert resp.json() == {"changed": ["SS_LOG_LEVEL"]}
    assert "SS_LOG_LEVEL=DEBUG" in path.read_text()

    entry = await db.scalar(select(AuditLog).where(
        AuditLog.action == "env_update"))
    assert entry.changes == {"changed": ["SS_LOG_LEVEL"]}

    resp = await client.put("/system/env", headers=dev,
                            json={"values": {"SS_DATABASE_URL": "x"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_env_update"


async def test_env_restart_touches_sentinel(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    from serversherpa.system.env_file import SENTINEL_PATH
    before = SENTINEL_PATH.read_text()
    resp = await client.post("/system/env/restart", headers=dev)
    assert resp.status_code == 200
    assert resp.json() == {"restarting": True}
    after = SENTINEL_PATH.read_text()
    assert after != before                       # rewritten with new stamp
    entry = await db.scalar(select(AuditLog).where(
        AuditLog.action == "env_restart"))
    assert entry is not None
```

NOTE: the restart test rewrites the real tracked sentinel file — that is its job; the working tree will show a modified `_dev_reload.py` after tests, which is expected and harmless (commit it as-is or checkout — the file's content is a timestamp comment).

- [ ] **Step 3: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_env_file.py tests/test_env_api.py -q`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

Create `api/src/serversherpa/_dev_reload.py`:

```python
"""Dev restart sentinel. POST /system/env/restart rewrites this file so
every --reload process (uvicorn, watchfiles workers) restarts and
re-reads .env. The content is meaningless; the mtime/content change is
the signal."""

_TOUCHED = "initial"
```

Create `api/src/serversherpa/system/env_file.py`:

```python
""".env reader/writer for the System Config ENV tab.

Classification: HIDDEN keys (DB/Spaces + compose companions) never leave
the server; SECRET keys (Settings SecretStr fields + a name heuristic)
are masked and keep-on-empty; the rest are plain. Rewrites are atomic
and byte-preserve comments, order, and untouched lines."""

import contextlib
import os
import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from pydantic import SecretStr

from serversherpa.config import _REPO_ROOT, Settings

HIDDEN_PREFIXES = ("SS_DATABASE_", "SS_SPACES_", "POSTGRES_", "MINIO_")
_SECRET_HINT = re.compile(r"SECRET|PASSWORD|KEY|TOKEN|DSN|PEPPER|WORDS")
_LINE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")

SENTINEL_PATH = Path(__file__).resolve().parents[1] / "_dev_reload.py"


def default_env_path() -> Path:
    return _REPO_ROOT / ".env"


def _secret_keys() -> set[str]:
    keys = set()
    for name, field in Settings.model_fields.items():
        if field.annotation is SecretStr:
            keys.add(f"SS_{name.upper()}")
    return keys


def is_hidden(key: str) -> bool:
    return key.startswith(HIDDEN_PREFIXES)


def is_secret(key: str) -> bool:
    return key in _secret_keys() or bool(_SECRET_HINT.search(key))


def _parse(path: Path) -> tuple[list[str], dict[str, int]]:
    """(raw lines, key -> line index) — comments/blank lines untouched."""
    lines = path.read_text().splitlines()
    index: dict[str, int] = {}
    for i, line in enumerate(lines):
        match = _LINE.match(line)
        if match:
            index[match.group(1)] = i
    return lines, index


def read_entries(path: Path) -> list[dict]:
    lines, index = _parse(path)
    entries = []
    for key, i in index.items():
        if is_hidden(key):
            continue
        value = _LINE.match(lines[i]).group(2)
        if is_secret(key):
            entries.append({"key": key, "secret": True,
                            "set": value != ""})
        else:
            entries.append({"key": key, "secret": False, "value": value})
    return entries


class EnvUpdateError(Exception):
    def __init__(self, unknown: list[str]) -> None:
        super().__init__(f"invalid env keys: {unknown}")
        self.unknown = unknown


def apply_updates(path: Path, values: dict[str, str]) -> list[str]:
    lines, index = _parse(path)
    unknown = [k for k in values
               if k not in index or is_hidden(k)]
    if unknown:
        raise EnvUpdateError(sorted(unknown))

    changed: list[str] = []
    for key, new_value in values.items():
        if is_secret(key) and new_value == "":
            continue                       # keep the stored secret
        i = index[key]
        current = _LINE.match(lines[i]).group(2)
        if current == new_value:
            continue
        lines[i] = f"{key}={new_value}"
        changed.append(key)

    if changed:
        shutil.copy2(path, path.with_suffix(".bak"))
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".env.tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                fh.write("\n".join(lines) + "\n")
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
    return changed


def touch_sentinel() -> None:
    stamp = datetime.now(UTC).isoformat()
    SENTINEL_PATH.write_text(
        '"""Dev restart sentinel. POST /system/env/restart rewrites this '
        "file so\nevery --reload process (uvicorn, watchfiles workers) "
        "restarts and\nre-reads .env. The content is meaningless; the "
        'mtime/content change is\nthe signal."""\n\n'
        f'_TOUCHED = "{stamp}"\n')
```

REPLACE the `contextlib_suppress` shim with the stdlib idiom — use `import contextlib` and `with contextlib.suppress(OSError): os.unlink(tmp)`; the shim above is a placeholder showing intent, do NOT ship a hand-rolled suppressor.

Append to `api/src/serversherpa/api/routes/system.py` (extend imports with `from serversherpa.system import env_file`):

```python
# ── environment file (System Config ENV tab) ───────────────────────


@router.get("/env")
async def get_env(
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    return {"entries": env_file.read_entries(env_file.default_env_path())}


@router.put("/env")
async def put_env(
    db: DbSession,
    body: dict = Body(...),
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    values = body.get("values")
    if not isinstance(values, dict) or not all(
            isinstance(v, str) for v in values.values()):
        raise _err(422, "invalid_env_update", unknown=[])
    try:
        changed = env_file.apply_updates(
            env_file.default_env_path(), values)
    except env_file.EnvUpdateError as exc:
        raise _err(422, "invalid_env_update", unknown=exc.unknown) from None
    if changed:
        audit(db, actor_id=actor.person.id, entity_type="system",
              entity_id="env", action="env_update",
              changes={"changed": sorted(changed)})
        await db.commit()
    return {"changed": sorted(changed)}


@router.post("/env/restart")
async def restart_processes(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    env_file.touch_sentinel()
    audit(db, actor_id=actor.person.id, entity_type="system",
          entity_id="env", action="env_restart", changes={})
    await db.commit()
    return {"restarting": True}
```

- [ ] **Step 5: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_env_file.py tests/test_env_api.py tests/test_system_api.py -q`
Expected: all passed. Then `git checkout api/src/serversherpa/_dev_reload.py` if the restart test dirtied it (or leave — content is a stamp).

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/system/env_file.py api/src/serversherpa/_dev_reload.py api/src/serversherpa/api/routes/system.py api/tests/test_env_file.py api/tests/test_env_api.py
git commit -m "feat(api): ENV endpoints — masked .env read/update + touch-triggered restart

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Loki + Grafana in the dev compose stack

**Files:**
- Modify: `docker-compose.dev.yml`
- Create: `docker/grafana-datasources.yml`
- Modify: `.env.example`

**Interfaces:** none code-side; compose services `loki` and `grafana` per Global Constraints.

- [ ] **Step 1: Add the services**

In `docker-compose.dev.yml`, after the `mailpit` service add:

```yaml
  loki:
    image: grafana/loki:3.0.0
    ports:
      - "127.0.0.1:3100:3100"   # push target for the log-service
    volumes:
      - lokidata:/loki

  grafana:
    image: grafana/grafana:11.1.0
    ports:
      - "127.0.0.1:3000:3000"   # log UI — Explore, Loki datasource
    environment:
      GF_SECURITY_ADMIN_USER: ${GRAFANA_ADMIN_USER:-admin}
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-admin}
    volumes:
      - grafanadata:/var/lib/grafana
      - ./docker/grafana-datasources.yml:/etc/grafana/provisioning/datasources/loki.yml:ro
    depends_on:
      - loki
```

and extend the `volumes:` block with `lokidata:` and `grafanadata:`.

- [ ] **Step 2: Provisioning file**

Create `docker/grafana-datasources.yml`:

```yaml
apiVersion: 1
datasources:
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    isDefault: true
    editable: true
```

- [ ] **Step 3: Document credentials**

In `.env.example`, next to the compose-only vars (POSTGRES_*/MINIO_*), add:

```
# Grafana (dev log UI at http://localhost:3000; Loki datasource provisioned)
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=change-me
```

- [ ] **Step 4: Validate + commit**

Run: `docker compose -f docker-compose.dev.yml config -q` (exit 0 = valid; do NOT `up` here — the controller does that in Task 5).

```bash
git add docker-compose.dev.yml docker/grafana-datasources.yml .env.example
git commit -m "feat(dev): Loki + Grafana services with provisioned datasource

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: System Config design pass (page shell + Logging tab)

**Files:**
- Modify: `portal/src/pages/SystemConfig.tsx`
- Modify: `portal/src/components/system/LoggingTab.tsx`
- Modify: `portal/src/styles/system.css`

**Interfaces:** behavior unchanged — this is visual restructuring only. All existing Logging-tab logic (state, validation, save, test event, transport swap, password rules) must survive byte-for-byte where possible.

**Design direction (binding):** The current page reads as unstyled plumbing. Target:

1. **Tab bar** — replace the mini-btn chips with a real underline tab bar: a horizontal row under the page hint, each tab a borderless button, active tab in `--text-dark` with a 2px amber underline (inactive: muted, transparent underline), 24px gap, hairline bottom border across the full row. Class family `.sysconf-tabbar` / `.sysconf-tab` / `.sysconf-tab.active`.
2. **Group cards** — each settings group (Mode, Storage limits, Remote transport) becomes its own `init-panel` card with an `eyebrow-sm` group title plus a one-line muted description under it ("How log records are kept and shipped." / "Caps on the local Postgres store." / "Where forwarded records go."). Consistent 18px internal spacing.
3. **Field grid** — labeled inputs align on a 2–3 column responsive grid (`.sysconf-row` refined: label above input, hint/error below, equal column widths, 16px gutters). Number inputs get sensible widths, not full-bleed.
4. **Actions bar** — one persistent row at the bottom of the tab (not per card): primary "Save changes", secondary "Send test event", and right-aligned status text (Saved. / test result / error) with the level of polish of the import page's footer. `.sysconf-actionbar` with a top hairline.
5. Page header keeps eyebrow Developer / title System Config and gains a one-line hint: "Runtime settings for the ServerSherpa processes."
6. Radio cards (imp-radio) stay — they look right — but get consistent vertical rhythm inside the new cards.

Steps: restyle, then run `cd portal && npx tsc --noEmit && npx vitest run` (all green — no behavior tests should change), then commit:

```bash
git add portal/src/pages/SystemConfig.tsx portal/src/components/system/LoggingTab.tsx portal/src/styles/system.css
git commit -m "polish(portal): System Config design pass — tab bar, group cards, action bar

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

The controller reviews this task VISUALLY in the browser (Task 5) in addition to the code review.

---

### Task 4: ENV tab

**Files:**
- Modify: `portal/src/lib/api.ts` (append)
- Create: `portal/src/lib/envConfig.ts`
- Test: `portal/src/lib/envConfig.test.ts`
- Create: `portal/src/components/system/EnvTab.tsx`
- Modify: `portal/src/pages/SystemConfig.tsx` (TABS entry)
- Modify: `portal/src/styles/system.css` (env rows)

**Interfaces:**
- api.ts: `EnvEntry = { key: string; secret: boolean; set?: boolean; value?: string }`; `getEnvEntries(): Promise<{entries: EnvEntry[]}>`; `putEnvValues(values: Record<string, string>): Promise<{changed: string[]}>`; `restartProcesses(): Promise<{restarting: boolean}>`.
- envConfig.ts (pure, tested): `filterEntries(entries, q)` — case-insensitive substring on key; `changedValues(entries, edits: Record<string, string>): Record<string, string>` — edits that differ from the entry's current value (secrets: any non-empty edit counts; empty never counts); `describeEntry(e)` → `{ placeholder, chip }` (secret+set → placeholder "••••••••  (leave blank to keep)", chip "set"; secret+unset → chip "not set"; plain → no chip).

- [ ] **Step 1: Failing helper tests**

Create `portal/src/lib/envConfig.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import type { EnvEntry } from './api';
import { changedValues, describeEntry, filterEntries } from './envConfig';

const plain = (key: string, value: string): EnvEntry =>
  ({ key, secret: false, value });
const secret = (key: string, set = true): EnvEntry =>
  ({ key, secret: true, set });

describe('filterEntries', () => {
  const entries = [plain('SS_ENV', 'development'), secret('SS_JWT_SECRET')];
  it('matches case-insensitively on key', () => {
    expect(filterEntries(entries, 'jwt')).toHaveLength(1);
    expect(filterEntries(entries, '')).toHaveLength(2);
    expect(filterEntries(entries, 'nope')).toHaveLength(0);
  });
});

describe('changedValues', () => {
  const entries = [plain('SS_ENV', 'development'), secret('SS_JWT_SECRET')];
  it('plain values count only when different', () => {
    expect(changedValues(entries, { SS_ENV: 'development' })).toEqual({});
    expect(changedValues(entries, { SS_ENV: 'production' }))
      .toEqual({ SS_ENV: 'production' });
  });
  it('secrets count only when non-empty', () => {
    expect(changedValues(entries, { SS_JWT_SECRET: '' })).toEqual({});
    expect(changedValues(entries, { SS_JWT_SECRET: 'new' }))
      .toEqual({ SS_JWT_SECRET: 'new' });
  });
});

describe('describeEntry', () => {
  it('marks secrets', () => {
    expect(describeEntry(secret('X')).chip).toBe('set');
    expect(describeEntry(secret('X', false)).chip).toBe('not set');
    expect(describeEntry(plain('X', 'v')).chip).toBeNull();
  });
});
```

- [ ] **Step 2: Implement lib + client**

`envConfig.ts`:

```typescript
/** Pure helpers for the System Config ENV tab. */

import type { EnvEntry } from './api';

export function filterEntries(
  entries: EnvEntry[], q: string,
): EnvEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => e.key.toLowerCase().includes(needle));
}

export function changedValues(
  entries: EnvEntry[], edits: Record<string, string>,
): Record<string, string> {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(edits)) {
    const entry = byKey.get(key);
    if (!entry) continue;
    if (entry.secret) {
      if (value !== '') out[key] = value;
    } else if (value !== (entry.value ?? '')) {
      out[key] = value;
    }
  }
  return out;
}

export function describeEntry(
  e: EnvEntry,
): { placeholder: string; chip: string | null } {
  if (!e.secret) return { placeholder: '', chip: null };
  return e.set
    ? { placeholder: '••••••••  (leave blank to keep)', chip: 'set' }
    : { placeholder: 'enter a value', chip: 'not set' };
}
```

api.ts additions follow the file's exact idiom (apiFetch + errorFrom) for the three calls; `putEnvValues` sends `{values}` via PUT `/system/env`, `restartProcesses` POSTs `/system/env/restart`.

- [ ] **Step 3: EnvTab component**

`EnvTab.tsx` — every commented behavior is real code:

```tsx
/** ENV tab: the repo .env, DB/Spaces hidden server-side, secrets
 *  masked. Save rewrites the file; Restart bounces every --reload
 *  process so changes take effect. */

/* state: entries, edits (Record<string,string>), q, busy, savedKeys,
   error, restarting */
/* mount: getEnvEntries; row inputs initialize from entry.value ?? '' for
   plain, '' for secret */
/* pending = changedValues(entries, edits); Save disabled when empty;
   on save: putEnvValues(pending) -> refetch entries, clear edits, show
   "Saved N value(s). Changes take effect after a restart." */
/* Restart: confirm dialog ("Restart the API and workers? Active
   requests may briefly fail.") -> restartProcesses() -> banner
   "Processes are restarting — they reappear on the Processes page
   within ~15 s."; the page itself may briefly lose the API. */
/* render: search input; rows in a card — each row: mono key, chip for
   secrets (describeEntry), input (type password for secrets); changed
   rows get an amber left rail; footer action bar: "Save N change(s)"
   primary + "Restart processes" danger-secondary + status text. */
```

Styles (`system.css`, `.envtab-` family): row grid `minmax(220px, 280px) 1fr auto`, mono key at 12.5px, hairline row separators, amber 3px left rail via `.envtab-row.changed`, search input matching `.sys-log-search`.

Wire `TABS` in `SystemConfig.tsx`: `{ key: 'env', label: 'Environment', component: EnvTab }`.

- [ ] **Step 4: Verify + commit**

Run: `cd portal && npx tsc --noEmit && npx vitest run` — green.

```bash
git add portal/src/lib/api.ts portal/src/lib/envConfig.ts portal/src/lib/envConfig.test.ts portal/src/components/system/EnvTab.tsx portal/src/pages/SystemConfig.tsx portal/src/styles/system.css
git commit -m "feat(portal): ENV tab — masked env editor with save + restart

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Live verification (controller)

- [ ] Stop and remove the standalone Loki container (`docker rm -f serversherpa-dev-loki`); add `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD` to the local `.env`; `docker compose -f docker-compose.dev.yml up -d` — loki + grafana come up; `curl -s localhost:3100/ready` → ready.
- [ ] Grafana at `http://localhost:3000`: log in with the .env credentials, Explore → Loki datasource pre-selected → query `{app="serversherpa"}` shows live log lines (the log-service keeps pushing to localhost:3100, now compose-owned).
- [ ] System Config in the browser: judge the redesign visually (tab bar, cards, action bar); screenshot.
- [ ] ENV tab: search filters; DB/Spaces keys absent; secrets masked with chips; edit `SS_LOG_LEVEL` → Save → "changes take effect after a restart" note; `.env.bak` exists; Restart → confirm → processes on the Processes page bounce (uptimes reset) and come back running; the edited value survives (GET again).
- [ ] Restore any `.env` value changed during verification; full suites (`pytest -q`; `tsc --noEmit && vitest run`) green.
