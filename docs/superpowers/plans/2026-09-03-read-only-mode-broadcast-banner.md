# Read-Only Mode + Broadcast Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Settings → Administration placeholders into a working read-only maintenance mode (write freeze + optional worker pause/resume) and a broadcast banner shown on the login page and in the portal shell — per docs/superpowers/specs/2026-09-03-read-only-mode-broadcast-banner-design.md.

**Architecture:** One `admin` section in the existing audited `SystemConfig` JSONB store; a public `GET /system/status` + gated `GET/PUT /system/admin`; the write freeze lives in the single `get_current_user` dependency (423 `read_only_mode`, developer role exempt, `/auth/*` + `/system/admin` allowlisted); workers idle when paused and heart-beat `meta.paused` so Processes shows "Paused". Portal: a public-status provider polling `/system/status`, a `SystemBanners` component mounted in the shell and login page, and an `AdminControls` card in Settings.

**Tech Stack:** FastAPI + SQLAlchemy async, React + vitest (jsdom for component tests).

## Global Constraints

- Error code for frozen writes: HTTP **423**, body `{"detail": {"code": "read_only_mode", "message": <read_only_message>}}`. Only `POST/PUT/PATCH/DELETE` are checked. Exempt: callers with role `developer`; paths starting with `/auth/`; exact path `/system/admin`.
- `admin` section defaults (verbatim): `read_only=False, read_only_message="", pause_workers=False, banner_enabled=False, banner_message=""`. Messages max 300 chars, trimmed. Enabling the banner with a blank message → 422 `banner_message_required`.
- Audit for PUT: `entity_type="system"`, `entity_id="admin"`, `action="admin_config_update"`, `changes={field: {"from","to"}}` for changed fields only.
- Copy (verbatim): read-only banner `Read-only maintenance mode — {message}` (just `Read-only maintenance mode` when blank); friendly error `The portal is in read-only maintenance mode — changes are disabled until it's lifted.`; Settings sub-row `Also pause background services`; button `Resume workers`; hint `Workers idle while paused; resume lifts the pause within a few seconds.`; blank-banner inline error `Enter a message first.`; Processes status label `Paused`.
- Portal poll cadence: 60s + `visibilitychange` (visible) + on-demand `refreshSystemStatus()`.
- API tests: from `api/`, `.venv/bin/python -m pytest`. Portal tests: from `portal/`, `npx vitest run`. Always FOREGROUND, one continuous call, timeout 600000ms — never background.
- Before any commit: `git checkout -- api/src/serversherpa/_dev_reload.py`.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: API — `admin` config section, public status, gated get/put

**Files:**
- Modify: `api/src/serversherpa/system/config_store.py` (DEFAULTS dict, ~line 7)
- Create: `api/src/serversherpa/system/admin_config.py`
- Modify: `api/src/serversherpa/api/schemas.py` (append near `SystemProcessOut`, ~line 1527)
- Modify: `api/src/serversherpa/api/routes/system.py` (imports ~lines 15–35; new routes after `list_processes`)
- Test: `api/tests/test_system_admin_api.py` (new)

**Interfaces:**
- Produces: `read_admin_config(db) -> dict` (section with defaults applied), `workers_paused(sessionmaker) -> bool` in `serversherpa.system.admin_config`; `GET /system/status` → `SystemStatusOut{read_only, read_only_message, workers_paused, banner}`; `GET/PUT /system/admin` → `AdminConfigOut{read_only, read_only_message, pause_workers, banner_enabled, banner_message}`; `AdminConfigIn` (all-optional patch, `extra="forbid"`). Tasks 2, 3, 4, 6 consume these exact names.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_system_admin_api.py`:

```python
"""Admin controls: public status, gated admin config get/put, audit."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, SystemConfig

from tests.test_status_values_write import _make


async def _admin(db, client):
    return await _make(db, client, "super_admin", "sa@test.example.com")


async def test_status_is_public_and_defaults_off(client):
    resp = await client.get("/system/status")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "read_only": False, "read_only_message": "",
        "workers_paused": False, "banner": None,
    }


async def test_admin_get_requires_settings_change(client, db, seeded_user):
    staff = await _make(db, client, "staff", "st@test.example.com")
    assert (await client.get("/system/admin", headers=staff)).status_code == 403
    hdrs = await _admin(db, client)
    resp = await client.get("/system/admin", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json() == {
        "read_only": False, "read_only_message": "", "pause_workers": False,
        "banner_enabled": False, "banner_message": "",
    }


async def test_put_merges_trims_and_audits(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/admin", headers=hdrs, json={
        "read_only": True, "read_only_message": "  Cutover until 14:00  ",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["read_only"] is True
    assert body["read_only_message"] == "Cutover until 14:00"
    assert body["banner_enabled"] is False          # untouched fields keep defaults

    # second patch only touches the banner; read-only survives the merge
    resp = await client.put("/system/admin", headers=hdrs, json={
        "banner_enabled": True, "banner_message": "Hello all",
    })
    assert resp.status_code == 200
    assert resp.json()["read_only"] is True
    assert resp.json()["banner_message"] == "Hello all"

    row = await db.get(SystemConfig, "admin")
    assert row is not None and row.data["banner_message"] == "Hello all"
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "system", AuditLog.entity_id == "admin",
        AuditLog.action == "admin_config_update"))).all()
    assert len(audits) == 2
    assert audits[0].changes["read_only"] == {"from": False, "to": True}
    assert "banner_enabled" not in audits[0].changes   # unchanged fields omitted

    status = (await client.get("/system/status")).json()
    assert status == {"read_only": True, "read_only_message": "Cutover until 14:00",
                      "workers_paused": False, "banner": "Hello all"}


async def test_put_rejects_blank_banner_and_unknown_fields(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/admin", headers=hdrs,
                            json={"banner_enabled": True, "banner_message": "   "})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "banner_message_required"
    resp = await client.put("/system/admin", headers=hdrs, json={"bogus": 1})
    assert resp.status_code == 422
    # disabling a banner with a blank message is fine
    resp = await client.put("/system/admin", headers=hdrs,
                            json={"banner_enabled": False})
    assert resp.status_code == 200


async def test_status_hides_banner_when_disabled_and_reports_pause(client, db, seeded_user):
    hdrs = await _admin(db, client)
    await client.put("/system/admin", headers=hdrs, json={
        "banner_enabled": True, "banner_message": "Up soon", "pause_workers": True,
    })
    status = (await client.get("/system/status")).json()
    assert status["banner"] == "Up soon"
    assert status["workers_paused"] is False       # pause needs read_only too
    await client.put("/system/admin", headers=hdrs,
                     json={"banner_enabled": False, "read_only": True})
    status = (await client.get("/system/status")).json()
    assert status["banner"] is None
    assert status["workers_paused"] is True
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest tests/test_system_admin_api.py -q` → 404s / assertion failures.

- [ ] **Step 3: Implement**

`config_store.py` — add to `DEFAULTS`:

```python
    "admin": {
        "read_only": False,
        "read_only_message": "",
        "pause_workers": False,
        "banner_enabled": False,
        "banner_message": "",
    },
```

`system/admin_config.py` (new):

```python
"""Admin controls (read-only maintenance mode, worker pause, broadcast
banner) — the `admin` system_config section, read with defaults so a
missing row means "everything off". Kept tiny and import-light: the auth
dependency (api/deps.py) and every worker loop call into it."""

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.system.config_store import read_section

SECTION = "admin"


async def read_admin_config(db: AsyncSession) -> dict:
    return await read_section(db, SECTION)


async def workers_paused(sessionmaker) -> bool:
    """True only while read-only mode is on AND the pause sub-toggle is set."""
    async with sessionmaker() as db:
        cfg = await read_admin_config(db)
    return bool(cfg["read_only"] and cfg["pause_workers"])
```

`schemas.py` — append after `SystemProcessOut`:

```python
class SystemStatusOut(BaseModel):
    """Public (unauthenticated) portal status — banners + read-only state."""

    read_only: bool
    read_only_message: str
    workers_paused: bool
    banner: str | None


class AdminConfigOut(BaseModel):
    read_only: bool
    read_only_message: str
    pause_workers: bool
    banner_enabled: bool
    banner_message: str


class AdminConfigIn(BaseModel):
    """Partial update — only sent fields change."""

    model_config = ConfigDict(extra="forbid")

    read_only: bool | None = None
    read_only_message: str | None = Field(default=None, max_length=300)
    pause_workers: bool | None = None
    banner_enabled: bool | None = None
    banner_message: str | None = Field(default=None, max_length=300)
```

(Confirm `Field` is already imported from pydantic in schemas.py; add it if not.)

`routes/system.py` — extend the schemas import with `AdminConfigIn, AdminConfigOut, SystemStatusOut`, add `from serversherpa.system.admin_config import read_admin_config`, and add after `list_processes`:

```python
# ── admin controls (read-only mode / worker pause / broadcast banner) ──

def _status_from(cfg: dict) -> SystemStatusOut:
    banner = cfg["banner_message"].strip() if cfg["banner_enabled"] else ""
    return SystemStatusOut(
        read_only=cfg["read_only"],
        read_only_message=cfg["read_only_message"],
        workers_paused=bool(cfg["read_only"] and cfg["pause_workers"]),
        banner=banner or None)


@router.get("/status", response_model=SystemStatusOut)
async def system_status(db: DbSession) -> SystemStatusOut:
    """Public: the login page shows banners before anyone signs in."""
    return _status_from(await read_admin_config(db))


@router.get("/admin", response_model=AdminConfigOut)
async def get_admin_config(
    db: DbSession,
    actor: AuthContext = require_permission("settings", "change"),
) -> AdminConfigOut:
    return AdminConfigOut(**await read_admin_config(db))


@router.put("/admin", response_model=AdminConfigOut)
async def put_admin_config(
    body: AdminConfigIn,
    db: DbSession,
    actor: AuthContext = require_permission("settings", "change"),
) -> AdminConfigOut:
    stored = await read_admin_config(db)
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items()
             if v is not None}
    for key in ("read_only_message", "banner_message"):
        if key in patch:
            patch[key] = patch[key].strip()
    data = {**stored, **patch}
    if data["banner_enabled"] and not data["banner_message"]:
        raise _err(422, "banner_message_required")

    row = await db.get(SystemConfig, "admin")
    if row is None:
        row = SystemConfig(section="admin")
        db.add(row)
    row.data = data
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor.person.id
    changes = {key: {"from": stored.get(key), "to": data[key]}
               for key in data if stored.get(key) != data[key]}
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="system",
              entity_id="admin", action="admin_config_update",
              changes=changes)
    await db.commit()
    return AdminConfigOut(**data)
```

Also update the module docstring's stale "Config endpoints arrive with Plan 2" line to mention the admin controls.

- [ ] **Step 4: Run** — `.venv/bin/python -m pytest tests/test_system_admin_api.py tests/test_system_api.py -q` → all pass.

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/system/config_store.py api/src/serversherpa/system/admin_config.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/system.py api/tests/test_system_admin_api.py
git commit -m "feat(api): admin controls config — public /system/status + gated /system/admin"
```

---

### Task 2: API — write freeze in `get_current_user`

**Files:**
- Modify: `api/src/serversherpa/api/deps.py` (`get_current_user`, ~line 80)
- Test: `api/tests/test_system_admin_api.py` (append)

**Interfaces:**
- Consumes: `read_admin_config` (Task 1).
- Produces: 423 `read_only_mode` behavior; constants `MUTATING_METHODS`, `READ_ONLY_EXEMPT_PREFIXES`, `READ_ONLY_EXEMPT_PATHS` in deps.py.

- [ ] **Step 1: Write the failing tests** — append to `api/tests/test_system_admin_api.py`:

```python
STATUS_PAYLOAD = {
    "record_type": "site", "key": "mothballed", "label": "Mothballed",
    "description": "Shut down, retained.", "color": "#8e44ad", "sort_order": 5,
}


async def _freeze(db, client, message="Cutover in progress"):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/admin", headers=hdrs,
                            json={"read_only": True, "read_only_message": message})
    assert resp.status_code == 200, resp.text
    return hdrs


async def test_read_only_blocks_non_developer_writes(client, db, seeded_user):
    sa = await _freeze(db, client)
    resp = await client.post("/status-values", headers=sa, json=STATUS_PAYLOAD)
    assert resp.status_code == 423, resp.text
    assert resp.json()["detail"] == {"code": "read_only_mode",
                                     "message": "Cutover in progress"}
    # reads are untouched
    assert (await client.get("/status-values", headers=sa)).status_code == 200


async def test_read_only_exempts_developers(client, db, seeded_user):
    await _freeze(db, client)
    dev = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.post("/status-values", headers=dev, json=STATUS_PAYLOAD)
    assert resp.status_code == 201, resp.text


async def test_read_only_allowlists_auth_and_the_toggle(client, db, seeded_user):
    sa = await _freeze(db, client)
    # the admin who froze the portal can always lift it
    resp = await client.put("/system/admin", headers=sa, json={"read_only": False})
    assert resp.status_code == 200
    # ...and writes flow again
    resp = await client.post("/status-values", headers=sa, json=STATUS_PAYLOAD)
    assert resp.status_code == 201
    await _freeze(db, client)
    # auth routes are never frozen (logout is a POST)
    resp = await client.post("/auth/logout", headers=sa)
    assert resp.status_code != 423


async def test_read_only_off_is_transparent(client, db, seeded_user):
    sa = await _admin(db, client)
    resp = await client.post("/status-values", headers=sa, json=STATUS_PAYLOAD)
    assert resp.status_code == 201
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest tests/test_system_admin_api.py -q -k read_only` → 201 where 423 expected.

- [ ] **Step 3: Implement** — in `deps.py`, add above `get_current_user`:

```python
MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# Never frozen: sign-in/out/refresh/password/preferences, and the admin
# toggle itself — whoever could turn read-only on can always turn it off.
READ_ONLY_EXEMPT_PREFIXES = ("/auth/",)
READ_ONLY_EXEMPT_PATHS = frozenset({"/system/admin"})


def _read_only_exempt(path: str) -> bool:
    return path in READ_ONLY_EXEMPT_PATHS or path.startswith(READ_ONLY_EXEMPT_PREFIXES)


async def enforce_read_only(db: AsyncSession, request: Request,
                            user: AuthContext) -> None:
    """Read-only maintenance mode: reject mutating calls from everyone but
    developers with 423. Only mutating methods pay the one-row lookup."""
    if (request.method not in MUTATING_METHODS
            or _read_only_exempt(request.url.path)
            or "developer" in user.roles):
        return
    from serversherpa.system.admin_config import read_admin_config

    cfg = await read_admin_config(db)
    if cfg["read_only"]:
        raise HTTPException(
            status_code=423,
            detail={"code": "read_only_mode",
                    "message": cfg["read_only_message"]})
```

and change `get_current_user` to:

```python
async def get_current_user(
    request: Request,
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthContext:
    if credentials is None:
        raise _unauthorized("missing_token")
    user = await authenticate_token(db, credentials.credentials)
    await enforce_read_only(db, request, user)
    return user
```

(`Request` is already imported in deps.py. The local import avoids an import cycle at module load.)

- [ ] **Step 4: Run** — `.venv/bin/python -m pytest tests/test_system_admin_api.py tests/test_auth_api.py -q` (or whichever auth test file exists — `ls tests | grep auth`) → all pass.

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/api/deps.py api/tests/test_system_admin_api.py
git commit -m "feat(api): read-only maintenance mode freezes non-developer writes (423)"
```

---

### Task 3: Worker pause — heartbeat meta, `paused` status, idle loops

**Files:**
- Modify: `api/src/serversherpa/system/registry.py` (`derive_status`, `_beat`, `heartbeat_loop`, `start_heartbeat`)
- Modify: `api/src/serversherpa/api/routes/system.py` (`list_processes` — pass meta; uptime for paused)
- Modify: `api/src/serversherpa/scans/worker.py` (`run_forever` ~126), `api/src/serversherpa/imports/worker.py` (`run_forever` ~118), `api/src/serversherpa/notifications/worker.py` (`run_forever` ~45)
- Modify: `portal/src/lib/system.ts` (`statusMeta`), `portal/src/styles/system.css` (`.sys-dot-paused`)
- Test: `api/tests/test_system_registry.py`, `api/tests/test_system_admin_api.py` (append), `portal/src/lib/system.test.ts` (extend or create)

**Interfaces:**
- Consumes: `workers_paused(sessionmaker)` (Task 1).
- Produces: `derive_status(heartbeat_at, stopped_at, now, meta=None) -> str` gains `"paused"`; `start_heartbeat(name, kind, meta_fn=None)`; `heartbeat_loop(name, kind, *, interval, meta_fn=None)`; portal `statusMeta('paused')` → `{ label: 'Paused', className: 'sys-dot-paused' }`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_system_registry.py` — extend `test_derive_status` and add a meta beat test:

```python
def test_derive_status_paused():
    fresh = NOW - timedelta(seconds=3)
    stale = NOW - timedelta(seconds=60)
    assert derive_status(fresh, None, NOW, meta={"paused": True}) == "paused"
    assert derive_status(fresh, None, NOW, meta={"paused": False}) == "running"
    assert derive_status(fresh, None, NOW, meta={}) == "running"
    # a stale or stopped process is never "paused"
    assert derive_status(stale, None, NOW, meta={"paused": True}) == "failed"
    assert derive_status(fresh, NOW, NOW, meta={"paused": True}) == "stopped"


async def test_heartbeat_writes_meta_from_callable(db):
    flag = {"paused": False}
    task = asyncio.create_task(heartbeat_loop(
        "testproc", "worker", interval=0.05,
        meta_fn=lambda: {"paused": flag["paused"]}))
    await asyncio.sleep(0.15)
    row = await db.get(SystemProcess, "testproc")
    assert row.meta == {"paused": False}
    flag["paused"] = True
    await asyncio.sleep(0.15)
    await db.refresh(row)
    assert row.meta == {"paused": True}
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
```

`api/tests/test_system_admin_api.py` — append a loop test (scan worker; the other two loops are the same shape and get the same edit):

```python
import asyncio

from serversherpa.db.engine import get_sessionmaker
from serversherpa.scans import worker as scan_worker
from serversherpa.system.admin_config import workers_paused


async def test_workers_paused_helper(client, db, seeded_user):
    assert await workers_paused(get_sessionmaker()) is False
    hdrs = await _admin(db, client)
    await client.put("/system/admin", headers=hdrs,
                     json={"read_only": True, "pause_workers": True})
    assert await workers_paused(get_sessionmaker()) is True


async def test_scan_worker_idles_while_paused(client, db, seeded_user, monkeypatch):
    calls: list[int] = []

    async def fake_run_once(maker):
        calls.append(1)
        return False

    monkeypatch.setattr(scan_worker, "run_once", fake_run_once)
    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    hdrs = await _admin(db, client)
    await client.put("/system/admin", headers=hdrs,
                     json={"read_only": True, "pause_workers": True})

    task = asyncio.create_task(scan_worker.run_forever(poll_seconds=0.05))
    await asyncio.sleep(0.3)
    assert calls == []                                   # paused: no work
    await client.put("/system/admin", headers=hdrs, json={"pause_workers": False})
    await asyncio.sleep(0.3)
    assert len(calls) >= 1                               # resumed within a poll
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
```

`portal/src/lib/system.test.ts` — add (create the file with the vitest imports if it doesn't exist):

```ts
it('statusMeta knows paused', () => {
  expect(statusMeta('paused')).toEqual({ label: 'Paused', className: 'sys-dot-paused' });
});
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest tests/test_system_registry.py tests/test_system_admin_api.py -q` (TypeError on `meta=`; loop test sees calls) and `npx vitest run src/lib/system.test.ts`.

- [ ] **Step 3: Implement**

`registry.py`:

```python
from collections.abc import Callable


def derive_status(heartbeat_at: datetime | None,
                  stopped_at: datetime | None,
                  now: datetime,
                  meta: dict | None = None) -> str:
    if stopped_at is not None and (
            heartbeat_at is None or stopped_at >= heartbeat_at):
        return "stopped"
    if heartbeat_at is None:
        return "failed"
    age = (now - heartbeat_at).total_seconds()
    if age >= STALE_AFTER_SECONDS:
        return "failed"
    # a live worker idling under read-only mode's pause sub-toggle
    return "paused" if (meta or {}).get("paused") else "running"


async def _beat(name: str, kind: str, *, first: bool,
                meta: dict | None = None) -> None:
    ...
    values = {"kind": kind, "pid": os.getpid(),
              "hostname": socket.gethostname(), "heartbeat_at": now}
    if meta is not None:
        values["meta"] = meta
    ...


async def heartbeat_loop(name: str, kind: str, *,
                         interval: float = HEARTBEAT_SECONDS,
                         meta_fn: Callable[[], dict] | None = None) -> None:
    first = True
    try:
        while True:
            try:
                meta = meta_fn() if meta_fn is not None else None
                await _beat(name, kind, first=first, meta=meta)
                first = False
            ...


def start_heartbeat(name: str, kind: str,
                    meta_fn: Callable[[], dict] | None = None) -> asyncio.Task:
    return asyncio.create_task(heartbeat_loop(name, kind, meta_fn=meta_fn))
```

`routes/system.py` `list_processes`: `status = derive_status(p.heartbeat_at, p.stopped_at, now, meta=p.meta)` and `if status in ("running", "paused") and p.started_at is not None:`. Update `SystemProcessOut.status`'s comment to `running | paused | stopped | failed`.

Each worker's `run_forever` (scans shown; imports identical; notifications wraps its timed `run_once` call the same way):

```python
    from serversherpa.system.admin_config import workers_paused

    install("scan-matching-worker")
    pause_state = {"paused": False}
    heartbeat = start_heartbeat("scan-matching-worker", "worker",
                                meta_fn=lambda: dict(pause_state))
    ...
    try:
        while True:
            # read-only mode's "also pause background services": idle (still
            # heart-beating as paused) until the flag clears — no work lost
            if await workers_paused(maker):
                if not pause_state["paused"]:
                    logger.info("paused by read-only maintenance mode")
                pause_state["paused"] = True
                await asyncio.sleep(poll_seconds)
                continue
            if pause_state["paused"]:
                logger.info("resumed")
            pause_state["paused"] = False
            worked = await run_once(maker)
            if not worked:
                await asyncio.sleep(poll_seconds)
```

`portal/src/lib/system.ts` — add `case 'paused': return { label: 'Paused', className: 'sys-dot-paused' };`. `portal/src/styles/system.css` — next to `.sys-dot-running`: `.sys-dot-paused { background: var(--amber, #a36207); }`.

- [ ] **Step 4: Run** — `.venv/bin/python -m pytest tests/test_system_registry.py tests/test_system_admin_api.py tests/test_system_api.py -q` and `npx vitest run src/lib/system.test.ts` → all pass.

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/system/registry.py api/src/serversherpa/api/routes/system.py api/src/serversherpa/api/schemas.py api/src/serversherpa/scans/worker.py api/src/serversherpa/imports/worker.py api/src/serversherpa/notifications/worker.py api/tests/test_system_registry.py api/tests/test_system_admin_api.py portal/src/lib/system.ts portal/src/lib/system.test.ts portal/src/styles/system.css
git commit -m "feat: workers idle under read-only pause and report Paused"
```

---

### Task 4: Portal — public status provider, banners component, read-only error mapping

**Files:**
- Modify: `portal/src/lib/api.ts` (`ApiError`/`errorFrom` ~139–158; add refresh bus next to `onSessionEnded` ~169)
- Create: `portal/src/lib/systemStatus.ts`, `portal/src/lib/systemStatusContext.tsx`, `portal/src/components/SystemBanners.tsx`
- Modify: `portal/src/styles/chrome.css` (append `.sys-banner` rules)
- Test: `portal/src/lib/systemStatus.test.ts`, `portal/src/components/SystemBanners.test.tsx`, `portal/src/lib/api.readonly.test.ts`

**Interfaces:**
- Produces: in `lib/api.ts` — `onSystemStatusRefresh(fn): () => void`, `refreshSystemStatus(): void`, `READ_ONLY_MESSAGE` const, `ApiError` gains optional 4th ctor arg `message`. In `lib/systemStatus.ts` — `interface SystemStatus { read_only: boolean; read_only_message: string; workers_paused: boolean; banner: string | null }`, `DEFAULT_SYSTEM_STATUS`, `getSystemStatus(): Promise<SystemStatus>`. In `lib/systemStatusContext.tsx` — `SystemStatusProvider`, `useSystemStatus(): { status: SystemStatus; refresh: () => void }`, `POLL_MS = 60_000`. `SystemBanners` default export. Tasks 5 and 6 consume these.

- [ ] **Step 1: Write the failing tests**

`portal/src/lib/systemStatus.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SYSTEM_STATUS, getSystemStatus } from './systemStatus';

afterEach(() => vi.unstubAllGlobals());

describe('getSystemStatus', () => {
  it('fetches /system/status without auth and returns the body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      read_only: true, read_only_message: 'Cutover', workers_paused: false, banner: 'Hi',
    })));
    vi.stubGlobal('fetch', fetchMock);
    const status = await getSystemStatus();
    expect(status).toEqual({ read_only: true, read_only_message: 'Cutover',
                             workers_paused: false, banner: 'Hi' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit?];
    expect(url).toMatch(/\/system\/status$/);
    expect(init?.headers).toBeUndefined();
  });
  it('throws on a non-2xx so the provider keeps its last value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    await expect(getSystemStatus()).rejects.toThrow();
    expect(DEFAULT_SYSTEM_STATUS.read_only).toBe(false);
  });
});
```

`portal/src/components/SystemBanners.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SystemBanners from './SystemBanners';
import type { SystemStatus } from '../lib/systemStatus';

let current: SystemStatus = { read_only: false, read_only_message: '', workers_paused: false, banner: null };
vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: current, refresh: vi.fn() }),
}));

afterEach(cleanup);

describe('SystemBanners', () => {
  it('renders nothing when everything is off', () => {
    const { container } = render(<SystemBanners />);
    expect(container.querySelector('.sys-banner')).toBeNull();
  });
  it('shows read-only (with message) and broadcast bars, read-only first', () => {
    current = { read_only: true, read_only_message: 'Cutover until 14:00',
                workers_paused: true, banner: 'Welcome to the new portal' };
    const { container } = render(<SystemBanners />);
    const bars = [...container.querySelectorAll('.sys-banner')];
    expect(bars.map((b) => b.textContent)).toEqual([
      'Read-only maintenance mode — Cutover until 14:00',
      'Welcome to the new portal',
    ]);
    expect(bars[0].className).toContain('sys-banner-readonly');
    expect(bars[1].className).toContain('sys-banner-broadcast');
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });
  it('omits the dash when the read-only message is blank', () => {
    current = { read_only: true, read_only_message: '', workers_paused: false, banner: null };
    render(<SystemBanners />);
    expect(screen.getByRole('status').textContent).toBe('Read-only maintenance mode');
  });
});
```

`portal/src/lib/api.readonly.test.ts` — exercise `errorFrom` through a public function that uses it (e.g. `listAssetModels` or any thin GET wrapper; pick one that calls `apiFetch` then `errorFrom` and has no extra logic):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, READ_ONLY_MESSAGE, onSystemStatusRefresh, updateAdminConfig } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('read_only_mode errors', () => {
  it('carry the friendly message and trigger a status refresh', async () => {
    const seen = vi.fn();
    const off = onSystemStatusRefresh(seen);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: { code: 'read_only_mode', message: 'Cutover' } }),
      { status: 423 })));
    const err = await updateAdminConfig({ read_only: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('read_only_mode');
    expect((err as ApiError).message).toBe(READ_ONLY_MESSAGE);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});
```

(`updateAdminConfig` is added in this task's Step 3 alongside `getAdminConfig` so Task 6 can consume them; both are plain `apiFetch` wrappers.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/systemStatus.test.ts src/components/SystemBanners.test.tsx src/lib/api.readonly.test.ts`.

- [ ] **Step 3: Implement**

`lib/api.ts` — `ApiError` and `errorFrom`:

```ts
export const READ_ONLY_MESSAGE =
  "The portal is in read-only maintenance mode — changes are disabled until it's lifted.";

export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown,
              message?: string) {
    super(message ?? code);
  }
}

async function errorFrom(resp: Response): Promise<ApiError> {
  let code = 'unknown_error';
  let detail: unknown;
  try {
    const body = await resp.json();
    detail = body?.detail;
    code = body?.detail?.code ?? code;
  } catch {
    /* non-JSON error body */
  }
  if (code === 'read_only_mode') {
    // the banner is the primary signal — make sure it appears at once
    refreshSystemStatus();
    return new ApiError(resp.status, code, detail, READ_ONLY_MESSAGE);
  }
  return new ApiError(resp.status, code, detail);
}
```

Next to `onSessionEnded`:

```ts
// ── public system status refresh bus (banners) ──────────────────────
const statusRefreshListeners = new Set<() => void>();

export function onSystemStatusRefresh(listener: () => void): () => void {
  statusRefreshListeners.add(listener);
  return () => statusRefreshListeners.delete(listener);
}

export function refreshSystemStatus(): void {
  statusRefreshListeners.forEach((fn) => fn());
}
```

Admin config client (append near the other system functions):

```ts
export interface AdminConfig {
  read_only: boolean; read_only_message: string; pause_workers: boolean;
  banner_enabled: boolean; banner_message: string;
}

export async function getAdminConfig(): Promise<AdminConfig> {
  const resp = await apiFetch('/system/admin');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateAdminConfig(patch: Partial<AdminConfig>): Promise<AdminConfig> {
  const resp = await apiFetch('/system/admin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

`lib/systemStatus.ts`:

```ts
/** Public portal status (no auth): read-only maintenance mode + broadcast
 *  banner. Fetched with plain fetch — the login page shows banners before
 *  anyone has a token. */
import { apiUrl } from './api';

export interface SystemStatus {
  read_only: boolean;
  read_only_message: string;
  workers_paused: boolean;
  banner: string | null;
}

export const DEFAULT_SYSTEM_STATUS: SystemStatus = {
  read_only: false, read_only_message: '', workers_paused: false, banner: null,
};

export async function getSystemStatus(): Promise<SystemStatus> {
  const resp = await fetch(`${apiUrl()}/system/status`);
  if (!resp.ok) throw new Error(`system status ${resp.status}`);
  return resp.json();
}
```

`lib/systemStatusContext.tsx`:

```tsx
/** Polls the public status every POLL_MS, on tab focus, and on demand
 *  (refreshSystemStatus() — fired when a write is rejected with
 *  read_only_mode). A failed poll keeps the last value: banners simply
 *  don't update, never error. Mounted above the router so the login page
 *  shares it with the shell. */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { onSystemStatusRefresh } from './api';
import { DEFAULT_SYSTEM_STATUS, getSystemStatus } from './systemStatus';
import type { SystemStatus } from './systemStatus';

export const POLL_MS = 60_000;

interface Value { status: SystemStatus; refresh: () => void; }

const Ctx = createContext<Value>({ status: DEFAULT_SYSTEM_STATUS, refresh: () => {} });

export function SystemStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SystemStatus>(DEFAULT_SYSTEM_STATUS);

  const refresh = useCallback(() => {
    getSystemStatus().then(setStatus).catch(() => { /* keep last value */ });
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    const off = onSystemStatusRefresh(refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      off();
    };
  }, [refresh]);

  return <Ctx.Provider value={{ status, refresh }}>{children}</Ctx.Provider>;
}

export function useSystemStatus(): Value {
  return useContext(Ctx);
}
```

`components/SystemBanners.tsx`:

```tsx
/** Slim console-wide bars: read-only maintenance mode (amber) first, then
 *  the broadcast banner (blue). Rendered in the shell above the topbar
 *  and on the login page above the form. */
import { useSystemStatus } from '../lib/systemStatusContext';

export default function SystemBanners() {
  const { status } = useSystemStatus();
  const readOnlyText = status.read_only_message
    ? `Read-only maintenance mode — ${status.read_only_message}`
    : 'Read-only maintenance mode';
  return (
    <>
      {status.read_only && (
        <div className="sys-banner sys-banner-readonly" role="status">{readOnlyText}</div>
      )}
      {status.banner && (
        <div className="sys-banner sys-banner-broadcast" role="status">{status.banner}</div>
      )}
    </>
  );
}
```

`styles/chrome.css` — append:

```css
/* ── console-wide banners (read-only mode / broadcast) ───────────────── */
.sys-banner {
  padding: 8px 20px;
  font-family: var(--font-display);
  font-size: 12.5px;
  font-weight: 500;
  text-align: center;
  border-bottom: 1px solid transparent;
}
.sys-banner-readonly {
  background: var(--c-amber-bg, #fff4e0);
  color: var(--c-amber-tx, #7a4b00);
  border-color: var(--c-amber-bd, #f2c880);
}
.sys-banner-broadcast {
  background: var(--c-blue-bg, #e8f1fb);
  color: var(--c-blue, #1668a7);
  border-color: var(--c-blue-bd, #b9d4ee);
}
```

(Check chrome.css/directory.css for the real amber/blue chip token names — `c-amber`/`c-blue` chips exist — and use those variables; the fallbacks above keep it correct if a name differs.)

- [ ] **Step 4: Run** — `npx vitest run src/lib/systemStatus.test.ts src/components/SystemBanners.test.tsx src/lib/api.readonly.test.ts` and `npx tsc --noEmit -p .` → pass.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/systemStatus.ts portal/src/lib/systemStatusContext.tsx portal/src/components/SystemBanners.tsx portal/src/styles/chrome.css portal/src/lib/systemStatus.test.ts portal/src/components/SystemBanners.test.tsx portal/src/lib/api.readonly.test.ts
git commit -m "feat(portal): public system status provider, banners, read-only error mapping"
```

---

### Task 5: Mount banners — App provider, shell, login page

**Files:**
- Modify: `portal/src/App.tsx` (~line 54: wrap `<AuthProvider>` with `<SystemStatusProvider>`)
- Modify: `portal/src/layout/AppShell.tsx` (~line 203: `<SystemBanners />` before `<Topbar />`)
- Modify: `portal/src/pages/Login.tsx` (above `<h2 className="form-title" data-reveal="">Sign in</h2>`)
- Test: `portal/src/layout/AppShell.test.tsx` (extend)

**Interfaces:**
- Consumes: `SystemStatusProvider`, `useSystemStatus` (Task 4), `SystemBanners` (Task 4).

- [ ] **Step 1: Write the failing test** — in `AppShell.test.tsx`, add a mock and a test (the file already mocks `../auth/AuthContext` and `../lib/api`; add `onSystemStatusRefresh: vi.fn(() => () => {})` to the `../lib/api` mock):

```tsx
vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({
    status: { read_only: true, read_only_message: 'Cutover', workers_paused: false, banner: 'Hello' },
    refresh: vi.fn(),
  }),
}));

it('renders the system banners above the topbar', () => {
  render(<MemoryRouter><AppShell><div>page</div></AppShell></MemoryRouter>);
  const col = document.querySelector('.portal-main-col')!;
  const first = col.firstElementChild!;
  expect(first.className).toContain('sys-banner-readonly');
  expect(screen.getByText('Hello').className).toContain('sys-banner-broadcast');
});
```

(Adapt the render call to the file's existing helper if it has one.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/layout/AppShell.test.tsx`.

- [ ] **Step 3: Implement**

`App.tsx`: `import { SystemStatusProvider } from './lib/systemStatusContext';` and wrap: `<SystemStatusProvider><AuthProvider>…</AuthProvider></SystemStatusProvider>`.

`AppShell.tsx`: `import SystemBanners from '../components/SystemBanners';` and:

```tsx
        <div className="portal-main-col">
          <SystemBanners />
          <Topbar />
          <main className="portal-main">{children}</main>
        </div>
```

`Login.tsx`: `import SystemBanners from '../components/SystemBanners';` and render `<div className="login-banners"><SystemBanners /></div>` immediately before the `<h2 className="form-title" …>` (no `data-reveal` — it must be visible without the entrance animation). Add to the login stylesheet (wherever `.form-title` is styled): `.login-banners { margin-bottom: 14px; } .login-banners .sys-banner { border-radius: 8px; border-width: 1px; }`.

- [ ] **Step 4: Run** — `npx vitest run src/layout/AppShell.test.tsx src/App.test.tsx` (if the latter exists) and `npx tsc --noEmit -p .` → pass.

- [ ] **Step 5: Commit**

```bash
git add portal/src/App.tsx portal/src/layout/AppShell.tsx portal/src/layout/AppShell.test.tsx portal/src/pages/Login.tsx portal/src/styles/
git commit -m "feat(portal): system banners in the shell and on the login page"
```

---

### Task 6: Settings — Administration card goes live

**Files:**
- Create: `portal/src/components/settings/AdminControls.tsx`
- Modify: `portal/src/pages/Settings.tsx` (Administration section ~lines 166–190; export `Switch` or move it to the new component)
- Modify: `portal/src/styles/settings.css` (sub-row + inline field styles)
- Test: `portal/src/components/settings/AdminControls.test.tsx`

**Interfaces:**
- Consumes: `getAdminConfig`, `updateAdminConfig`, `AdminConfig`, `refreshSystemStatus`, `ApiError` (Task 4 / lib/api).
- Produces: `AdminControls` default export (no props); `Switch` exported from `Settings.tsx` as a named export.

- [ ] **Step 1: Write the failing tests** — `AdminControls.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getAdminConfig: vi.fn(),
  updateAdminConfig: vi.fn(),
  refreshSystemStatus: vi.fn(),
}));
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  ...api,
}));

import AdminControls from './AdminControls';

const base = { read_only: false, read_only_message: '', pause_workers: false,
               banner_enabled: false, banner_message: '' };

beforeEach(() => {
  api.getAdminConfig.mockResolvedValue({ ...base });
  api.updateAdminConfig.mockImplementation(async (patch) => ({ ...base, ...patch }));
  api.refreshSystemStatus.mockReset();
});
afterEach(cleanup);

const switches = () => screen.getAllByRole('checkbox') as HTMLInputElement[];

describe('AdminControls', () => {
  it('toggling read-only PUTs immediately and refreshes the banners', async () => {
    render(<AdminControls />);
    await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
    fireEvent.click(switches()[0]);
    await waitFor(() => expect(api.updateAdminConfig).toHaveBeenCalledWith({ read_only: true }));
    expect(api.refreshSystemStatus).toHaveBeenCalled();
  });

  it('pause sub-toggle is disabled until read-only is on; Resume appears when paused', async () => {
    api.getAdminConfig.mockResolvedValue({ ...base, read_only: true, pause_workers: true });
    render(<AdminControls />);
    await screen.findByText('Resume workers');
    expect(switches()[1].disabled).toBe(false);
    fireEvent.click(screen.getByText('Resume workers'));
    await waitFor(() => expect(api.updateAdminConfig)
      .toHaveBeenCalledWith({ pause_workers: false }));
  });

  it('pause sub-toggle disabled when read-only is off', async () => {
    render(<AdminControls />);
    await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
    expect(switches()[1].disabled).toBe(true);
    expect(screen.queryByText('Resume workers')).toBeNull();
  });

  it('message Save appears when dirty and PUTs the trimmed text', async () => {
    render(<AdminControls />);
    await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
    expect(screen.queryByText('Save')).toBeNull();
    const input = screen.getByPlaceholderText(/Cutover in progress/);
    fireEvent.change(input, { target: { value: '  Back at 14:00 ' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.updateAdminConfig)
      .toHaveBeenCalledWith({ read_only_message: 'Back at 14:00' }));
  });

  it('refuses to enable the broadcast banner with a blank message', async () => {
    render(<AdminControls />);
    await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
    fireEvent.click(switches()[2]);
    expect(await screen.findByText('Enter a message first.')).toBeTruthy();
    expect(api.updateAdminConfig).not.toHaveBeenCalled();
    expect(switches()[2].checked).toBe(false);
  });

  it('surfaces a PUT failure inline', async () => {
    const { ApiError } = await import('../../lib/api');
    api.updateAdminConfig.mockRejectedValue(new ApiError(500, 'unknown_error'));
    api.getAdminConfig.mockResolvedValue({ ...base, banner_message: 'x' });
    render(<AdminControls />);
    await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
    fireEvent.click(switches()[2]);
    expect(await screen.findByText(/could not save/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/components/settings/AdminControls.test.tsx`.

- [ ] **Step 3: Implement**

`Settings.tsx`: change `function Switch` to `export function Switch`; replace the Administration section's two placeholder rows with `<AdminControls />` (keep the `set-head`); import it. Drop "Coming soon" copy.

`components/settings/AdminControls.tsx`:

```tsx
/**
 * Settings → Administration: read-only maintenance mode (+ pause workers,
 * resume) and the broadcast banner. Switches PUT immediately; message
 * fields save via an explicit Save that appears when dirty. Every
 * successful write nudges the public status so the banners update at
 * once instead of on the next 60s poll.
 */
import { useEffect, useState } from 'react';

import {
  ApiError, getAdminConfig, refreshSystemStatus, updateAdminConfig,
} from '../../lib/api';
import type { AdminConfig } from '../../lib/api';
import { Switch } from '../../pages/Settings';

const ERRORS: Record<string, string> = {
  banner_message_required: 'Enter a message first.',
};

function describe(err: unknown): string {
  const code = err instanceof ApiError ? err.code : '';
  return ERRORS[code] ?? 'Could not save — try again.';
}

export default function AdminControls() {
  const [cfg, setCfg] = useState<AdminConfig | null>(null);
  const [readOnlyDraft, setReadOnlyDraft] = useState('');
  const [bannerDraft, setBannerDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getAdminConfig().then((c) => {
      setCfg(c);
      setReadOnlyDraft(c.read_only_message);
      setBannerDraft(c.banner_message);
    }).catch((e: unknown) => setError(describe(e)));
  }, []);

  const apply = async (patch: Partial<AdminConfig>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await updateAdminConfig(patch);
      setCfg(next);
      setReadOnlyDraft(next.read_only_message);
      setBannerDraft(next.banner_message);
      refreshSystemStatus();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleBanner = (on: boolean) => {
    if (on && !bannerDraft.trim()) {
      setError('Enter a message first.');
      return;
    }
    void apply(on ? { banner_enabled: true, banner_message: bannerDraft.trim() }
                  : { banner_enabled: false });
  };

  if (!cfg) return <p className="set-note">{error ?? 'Loading…'}</p>;
  const readOnlyDirty = readOnlyDraft.trim() !== cfg.read_only_message;
  const bannerDirty = bannerDraft.trim() !== cfg.banner_message;
  const paused = cfg.read_only && cfg.pause_workers;

  return (
    <>
      <div className="set-row">
        <div className="set-label">
          <b>Read-only maintenance mode</b>
          <span>Freeze all writes across the portal during cutovers. Developers stay exempt.</span>
          <div className="set-inline">
            <input value={readOnlyDraft} maxLength={300}
                   placeholder="Shown to everyone in the banner, e.g. 'Cutover in progress until 14:00 ET'"
                   onChange={(e) => setReadOnlyDraft(e.target.value)} />
            {readOnlyDirty && (
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => void apply({ read_only_message: readOnlyDraft.trim() })}>
                Save
              </button>
            )}
          </div>
        </div>
        <Switch checked={cfg.read_only} disabled={busy}
                onChange={(v) => void apply({ read_only: v })} />
      </div>
      <div className="set-row set-subrow">
        <div className="set-label">
          <b>Also pause background services</b>
          <span>
            {paused
              ? 'Workers idle while paused; resume lifts the pause within a few seconds.'
              : 'Scan matching, imports and notifications idle while read-only mode is on.'}
          </span>
          {paused && (
            <div className="set-inline">
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => void apply({ pause_workers: false })}>
                Resume workers
              </button>
            </div>
          )}
        </div>
        <Switch checked={cfg.pause_workers} disabled={busy || !cfg.read_only}
                onChange={(v) => void apply({ pause_workers: v })} />
      </div>
      <div className="set-row">
        <div className="set-label">
          <b>Broadcast banner</b>
          <span>Show an announcement to everyone — on the login page and inside the portal.</span>
          <div className="set-inline">
            <input value={bannerDraft} maxLength={300}
                   placeholder="e.g. 'Scheduled maintenance Saturday 02:00–04:00 ET'"
                   onChange={(e) => setBannerDraft(e.target.value)} />
            {bannerDirty && cfg.banner_enabled && (
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => void apply({ banner_message: bannerDraft.trim() })}>
                Save
              </button>
            )}
          </div>
        </div>
        <Switch checked={cfg.banner_enabled} disabled={busy} onChange={toggleBanner} />
      </div>
      {error && <p className="set-note set-error">{error}</p>}
    </>
  );
}
```

Note: the blank-banner test expects `Enter a message first.` and NO PUT — `toggleBanner` handles it; the failure test expects `/could not save/i` for other codes — `describe` handles it. When the banner is OFF and the draft changes, the Save button stays hidden and the message is sent along with the enable (`toggleBanner` sends both) — matches "the switch can't be turned on with an empty message".

`settings.css` — append:

```css
.set-subrow { padding-left: 22px; }
.set-inline { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.set-inline input {
  flex: 1; min-width: 0; height: 32px; padding: 0 10px;
  border: 1px solid var(--paper-line); border-radius: 8px;
  font: inherit; font-size: 12.5px; background: var(--surface);
}
.set-error { color: var(--c-red, #c03540); }
```

- [ ] **Step 4: Run** — `npx vitest run src/components/settings/AdminControls.test.tsx src/pages` and `npx tsc --noEmit -p .` → pass.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/settings/AdminControls.tsx portal/src/components/settings/AdminControls.test.tsx portal/src/pages/Settings.tsx portal/src/styles/settings.css
git commit -m "feat(portal): Settings administration card — read-only mode, worker pause, broadcast banner"
```

---

### Task 7: Verification (controller-led)

- [ ] Full API suite foreground from `api/`: `.venv/bin/python -m pytest -q` (timeout 600000) → all pass.
- [ ] Full portal suite + build foreground from `portal/`: `npx vitest run && npm run build` → all pass.
- [ ] Live (browser pane, dev API restarted so `deps.py`/routes load): as claude-dev (developer) open Settings → Administration; enable the broadcast banner with a message → banner shows in the shell; sign out → banner shows on the login page. Enable read-only with a message + pause workers → amber bar appears; Dev → Processes shows workers **Paused**; a non-developer account (e.g. jhenderson super_admin or a seeded staff user) attempting a write gets the friendly error; developer writes still succeed. Resume workers → Processes back to Running. Turn everything off → banners gone.
- [ ] Fix anything found, commit.
