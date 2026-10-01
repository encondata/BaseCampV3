# Kiosk "Clear Setup" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin picks Clear Setup on a kiosk row in `/hardware/kiosks`; on the kiosk's next signed-in heartbeat it drops its Kiosk Setup and sends the signed-in person to Kiosk Setup.

**Architecture:** A pending request (id, requested_at, requested_by) on the `devices` row. The heartbeat reply carries `clear_setup: <id>` until a later heartbeat sends `setup_cleared: <id>`; then the server clears the request and audits it. Web kiosk and Android apply the clear locally (existing clear routines), ack on the next beat, navigate to Setup and show a banner.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (api/), React + Vitest (portal/, kiosk/), Kotlin + Compose + kotlinx.serialization + JUnit (Android_Kiosk_App/).

Spec: `docs/superpowers/specs/2026-10-01-kiosk-clear-setup-design.md`.

## Global Constraints

- Worktree: `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/kiosk-clear-setup`, branch `kiosk-clear-setup`. Never commit on `main`.
- Migration is `0086`, `down_revision = "0085"`, file `api/migrations/versions/0086_device_setup_clear.py`.
- Portal permission for both new endpoints: `require_permission("scanning_hardware", "change")`.
- Error codes: `device_not_found` (404), `not_a_kiosk` (409).
- Audit actions (entity_type `"device"`): `clear_setup_requested`, `clear_setup_cancelled`, `setup_cleared`.
- Wire names: heartbeat request `setup_cleared` (UUID string or omitted); heartbeat reply `clear_setup` (UUID string or null); DeviceItem `setup_clear_requested_at`, `setup_clear_requested_by_name`.
- Kiosk-local storage key (web localStorage and Android DataStore): `ss.kiosk.setupClear`, JSON `{"id": "<uuid>", "acked": <bool>, "notice": <bool>}`.
- Copy (exact):
  - Portal confirm: `Clear Setup on "<name>"? The next time it checks in, its move, site and checkpoint are cleared and whoever is signed in is sent to Kiosk Setup. Queued scans are kept.`
  - Portal chip: `Setup clear pending`; chip title `Requested by <name>, <locale date time>` (or `Requested <locale date time>` when name is null).
  - Portal `not_a_kiosk` error: `Only kiosks can have their setup cleared.`
  - Kiosk banner (web + Android): `An administrator cleared this kiosk's setup. Run Kiosk Setup to continue.`
- American English everywhere. Commit trailer exactly: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never `git stash`; never touch other worktrees; never commit `api/src/serversherpa/_dev_reload.py` (run `git checkout -- api/src/serversherpa/_dev_reload.py` if it shows as modified).
- API tests: from `api/`, `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_kiosk_clear_setup .venv/bin/pytest -q <files>` (foreground). Portal: from `portal/`, `npx vitest run <files>` and `npx tsc -b`. Kiosk: from `kiosk/`, `npx vitest run <files>` and `npx tsc -b`. Android: from `Android_Kiosk_App/`, `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew testDebugUnitTest` (foreground, long timeout).
- Portal/kiosk sorting: never `localeCompare`, `Intl.Collator`, or bare `.sort()` (guardrail `portal/src/styles/naturalSort.test.ts`).

---

### Task 1: API — pending request on the device + portal endpoints

**Files:**
- Create: `api/migrations/versions/0086_device_setup_clear.py`
- Modify: `api/src/serversherpa/db/models.py` (class `Device`, after `session_started_at`, ~line 1091)
- Modify: `api/src/serversherpa/api/schemas.py` (class `DeviceItem`, ~line 2738)
- Modify: `api/src/serversherpa/api/routes/devices.py` (`_device_query`, `_row_to_item`, new routes after `deregister_device`)
- Test: `api/tests/test_devices_clear_setup_api.py` (new)

**Interfaces:**
- Produces: `Device.setup_clear_id: uuid.UUID | None`, `Device.setup_clear_requested_at: datetime | None`, `Device.setup_clear_requested_by: uuid.UUID | None`; `POST /devices/{id}/clear-setup` and `POST /devices/{id}/clear-setup/cancel` → `DeviceItem`; `DeviceItem.setup_clear_requested_at: datetime | None`, `DeviceItem.setup_clear_requested_by_name: str | None`.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_devices_clear_setup_api.py`:

```python
"""Clear Setup on a kiosk row: request (fresh id each time), cancel,
404/409/403, audit, and the list fields the portal's pending chip reads."""

from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, Device
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff


async def _kiosk(db, name="kiosk-dock-1", device_type="kiosk") -> Device:
    d = Device(device_type=device_type, name=name)
    db.add(d)
    await db.commit()
    return d


async def test_request_sets_a_pending_clear_and_audits(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _kiosk(db)
    resp = await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["setup_clear_requested_at"] is not None
    assert body["setup_clear_requested_by_name"]          # the admin's display name
    await db.refresh(d)
    assert d.setup_clear_id is not None
    assert d.setup_clear_requested_by == seeded_user.id
    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "clear_setup_requested",
        AuditLog.entity_id == str(d.id)))
    assert row is not None and row.changes["request_id"] == str(d.setup_clear_id)


async def test_re_request_replaces_the_id(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _kiosk(db)
    await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    await db.refresh(d)
    first = d.setup_clear_id
    await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    await db.refresh(d)
    assert d.setup_clear_id is not None and d.setup_clear_id != first


async def test_cancel_clears_it_and_audits_once(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _kiosk(db)
    await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    await db.refresh(d)
    pending = d.setup_clear_id
    resp = await client.post(f"/devices/{d.id}/clear-setup/cancel", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["setup_clear_requested_at"] is None
    assert resp.json()["setup_clear_requested_by_name"] is None
    await db.refresh(d)
    assert (d.setup_clear_id, d.setup_clear_requested_at, d.setup_clear_requested_by) == (None, None, None)
    # cancelling again is a quiet no-op
    resp = await client.post(f"/devices/{d.id}/clear-setup/cancel", headers=hdrs)
    assert resp.status_code == 200
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "clear_setup_cancelled", AuditLog.entity_id == str(d.id)))).all()
    assert len(rows) == 1 and rows[0].changes["request_id"] == str(pending)


async def test_unknown_device_404_and_non_kiosk_409(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/devices/00000000-0000-0000-0000-000000000000/clear-setup", headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "device_not_found"
    router = await _kiosk(db, name="dock-router", device_type="router")
    for path in ("clear-setup", "clear-setup/cancel"):
        resp = await client.post(f"/devices/{router.id}/{path}", headers=hdrs)
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_a_kiosk"


async def test_needs_scanning_hardware_change(client, db, seeded_user):
    await db.execute(text("UPDATE person_roles SET role='external' WHERE person_id=:p"),
                     {"p": seeded_user.id})
    await db.commit()
    hdrs = await login_staff(client, seeded_user)
    d = await _kiosk(db)
    for path in ("clear-setup", "clear-setup/cancel"):
        resp = await client.post(f"/devices/{d.id}/{path}", headers=hdrs)
        assert resp.status_code == 403


async def test_list_exposes_the_pending_fields(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _kiosk(db)
    resp = await client.get("/devices?device_type=kiosk", headers=hdrs)
    row = next(r for r in resp.json() if r["id"] == str(d.id))
    assert row["setup_clear_requested_at"] is None and row["setup_clear_requested_by_name"] is None
    await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    resp = await client.get("/devices?device_type=kiosk", headers=hdrs)
    row = next(r for r in resp.json() if r["id"] == str(d.id))
    assert row["setup_clear_requested_at"] is not None and row["setup_clear_requested_by_name"]
    assert "setup_clear_id" not in row
```

(If `GET /devices` filters with a different query parameter than `device_type`, read the `list_devices` route and use its actual parameter, or drop the query string and search the full list.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_kiosk_clear_setup .venv/bin/pytest -q tests/test_devices_clear_setup_api.py`
Expected: FAIL (404 for the new routes / AttributeError `setup_clear_id`).

- [ ] **Step 3: Migration** — `api/migrations/versions/0086_device_setup_clear.py`:

```python
"""Clear Setup on a kiosk: a pending request on the device row, repeated on
every heartbeat reply until the kiosk acknowledges its id.

Revision ID: 0086
Revises: 0085
Create Date: 2026-10-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0086"
down_revision: str | None = "0085"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("setup_clear_id", UUID(as_uuid=True), nullable=True))
    op.add_column("devices", sa.Column(
        "setup_clear_requested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("devices", sa.Column(
        "setup_clear_requested_by", UUID(as_uuid=True),
        sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "setup_clear_requested_by")
    op.drop_column("devices", "setup_clear_requested_at")
    op.drop_column("devices", "setup_clear_id")
```

- [ ] **Step 4: Model** — in `class Device`, right after `session_started_at: Mapped[datetime | None]`:

```python
    # Clear Setup: a pending request for this kiosk to drop its Kiosk Setup.
    # Repeated on every heartbeat reply until the kiosk acknowledges this
    # exact id (migration 0086). All NULL = nothing pending.
    setup_clear_id: Mapped[uuid.UUID | None]
    setup_clear_requested_at: Mapped[datetime | None]
    setup_clear_requested_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id", ondelete="SET NULL"))
```

- [ ] **Step 5: Schema** — in `class DeviceItem`, after `session_started_at: datetime | None`:

```python
    setup_clear_requested_at: datetime | None = None
    setup_clear_requested_by_name: str | None = None
```

- [ ] **Step 6: Routes** — in `devices.py`:

Add a second alias next to `SessionPerson = aliased(Person)`:

```python
ClearRequester = aliased(Person)
```

In `_device_query()`, add three selected columns at the end of the `select(...)` tuple (after `SessionPerson.last_name`): `ClearRequester.preferred_name, ClearRequester.first_name, ClearRequester.last_name`, and one more join at the end of the chain:

```python
            .outerjoin(ClearRequester,
                       ClearRequester.id == Device.setup_clear_requested_by))
```

(move the closing paren accordingly). In `_row_to_item(row)` extend the unpacking and the dict:

```python
    (d, site_name, connected, ss_label, ss_color, raw_n, proc_n,
     initiative_name, session_preferred, session_first, session_last,
     clear_preferred, clear_first, clear_last) = row
```

```python
        "setup_clear_requested_at": d.setup_clear_requested_at,
        "setup_clear_requested_by_name": (
            f"{clear_preferred or clear_first} {clear_last}"
            if clear_last is not None else None),
```

Add `import uuid` usage (already imported) and these routes after `deregister_device`:

```python
async def _kiosk_or_error(db: DbSession, device_id: uuid.UUID) -> Device:
    device = await db.get(Device, device_id)
    if device is None:
        raise _err(404, "device_not_found")
    if device.device_type != "kiosk":
        raise _err(409, "not_a_kiosk")
    return device


@router.post("/{device_id}/clear-setup", response_model=DeviceItem)
async def request_clear_setup(
    device_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "change"),
) -> dict:
    """Queue a Clear Setup for this kiosk. A fresh id every time, so an
    acknowledgment of an older request can never close this one."""
    device = await _kiosk_or_error(db, device_id)
    now = datetime.now(UTC)
    device.setup_clear_id = uuid.uuid4()
    device.setup_clear_requested_at = now
    device.setup_clear_requested_by = actor.person.id
    device.updated_at = now
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="clear_setup_requested",
          changes={"request_id": str(device.setup_clear_id)})
    await db.commit()
    return await _item_for(db, device.id)


@router.post("/{device_id}/clear-setup/cancel", response_model=DeviceItem)
async def cancel_clear_setup(
    device_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "change"),
) -> dict:
    """Withdraw a pending Clear Setup. Cancelling nothing is a quiet 200."""
    device = await _kiosk_or_error(db, device_id)
    if device.setup_clear_id is not None:
        request_id = str(device.setup_clear_id)
        device.setup_clear_id = None
        device.setup_clear_requested_at = None
        device.setup_clear_requested_by = None
        device.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="device",
              entity_id=str(device.id), action="clear_setup_cancelled",
              changes={"request_id": request_id})
        await db.commit()
    return await _item_for(db, device.id)
```

Route order: these are `POST /{device_id}/...` with fixed suffixes; they don't collide with `POST /kiosks/clear-offline` (two literal segments). Keep `clear-offline` declared before them as it is today.

- [ ] **Step 7: Run tests to verify they pass**, plus the existing device tests:

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_kiosk_clear_setup .venv/bin/pytest -q tests/test_devices_clear_setup_api.py tests/test_devices_api.py tests/test_devices_clear_offline_api.py tests/test_migrations*.py`
Expected: all PASS. (If no `test_migrations*.py` exists, drop it from the command; if there's a migration up/down test elsewhere, e.g. `grep -l "downgrade" tests/*.py`, run it too.)

- [ ] **Step 8: Commit**

```bash
git add api/migrations/versions/0086_device_setup_clear.py api/src/serversherpa/db/models.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/devices.py api/tests/test_devices_clear_setup_api.py
git commit -m "feat(devices): Clear Setup request/cancel on kiosk rows (migration 0086)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: API — heartbeat carries the request and takes the acknowledgment

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (`HeartbeatIn` ~line 285, `HeartbeatOut` ~line 310)
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (`heartbeat`, ~line 411)
- Test: `api/tests/test_kiosk_heartbeat_clear_setup.py` (new)

**Interfaces:**
- Consumes: `Device.setup_clear_id`, `setup_clear_requested_at`, `setup_clear_requested_by` (Task 1); `POST /devices/{id}/clear-setup` (Task 1).
- Produces: heartbeat request field `setup_cleared: uuid.UUID | None`; reply field `clear_setup: uuid.UUID | None`.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_kiosk_heartbeat_clear_setup.py`:

```python
"""Heartbeat side of Clear Setup: the reply repeats the pending id until a
later beat acknowledges that exact id; stale acks are ignored."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device
from tests.test_access_roles_api import login_admin

BODY = {"serial": "kiosk-web-clr1", "name": "Dock 9", "mode": "web", "version": "0.1.0"}


async def _beat(client, hdrs, **extra):
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={**BODY, **extra})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _request(client, db, hdrs) -> str:
    d = await db.scalar(select(Device).where(Device.serial == BODY["serial"]))
    resp = await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    assert resp.status_code == 200, resp.text
    await db.refresh(d)
    return str(d.setup_clear_id)


async def test_reply_is_null_when_nothing_pending(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    assert (await _beat(client, hdrs))["clear_setup"] is None


async def test_reply_repeats_the_pending_id_until_acked(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _beat(client, hdrs)                       # creates the kiosk row
    pending = await _request(client, db, hdrs)
    assert (await _beat(client, hdrs))["clear_setup"] == pending
    assert (await _beat(client, hdrs))["clear_setup"] == pending
    # the ack closes it, and that same reply no longer asks
    assert (await _beat(client, hdrs, setup_cleared=pending))["clear_setup"] is None
    d = await db.scalar(select(Device).where(Device.serial == BODY["serial"]))
    await db.refresh(d)
    assert (d.setup_clear_id, d.setup_clear_requested_at, d.setup_clear_requested_by) == (None, None, None)
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "setup_cleared", AuditLog.entity_id == str(d.id)))
    assert row is not None
    assert row.changes["request_id"] == pending
    assert row.changes["requested_by"] == str(seeded_user.id)


async def test_stale_ack_is_ignored(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _beat(client, hdrs)
    old = await _request(client, db, hdrs)
    new = await _request(client, db, hdrs)            # re-request → new id
    assert old != new
    assert (await _beat(client, hdrs, setup_cleared=old))["clear_setup"] == new
    assert (await db.scalar(select(AuditLog).where(AuditLog.action == "setup_cleared"))) is None


async def test_ack_after_cancel_is_ignored(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _beat(client, hdrs)
    pending = await _request(client, db, hdrs)
    d = await db.scalar(select(Device).where(Device.serial == BODY["serial"]))
    await client.post(f"/devices/{d.id}/clear-setup/cancel", headers=hdrs)
    assert (await _beat(client, hdrs, setup_cleared=pending))["clear_setup"] is None
    assert (await db.scalar(select(AuditLog).where(AuditLog.action == "setup_cleared"))) is None


async def test_first_beat_ack_on_a_new_row_is_harmless(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    body = await _beat(client, hdrs, setup_cleared="00000000-0000-0000-0000-000000000001")
    assert body["clear_setup"] is None


async def test_sign_in_beat_also_carries_the_request(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _beat(client, hdrs)
    pending = await _request(client, db, hdrs)
    body = await _beat(client, hdrs, sign_in=True, login_method="password")
    assert body["clear_setup"] == pending
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_kiosk_clear_setup .venv/bin/pytest -q tests/test_kiosk_heartbeat_clear_setup.py`
Expected: FAIL (`KeyError: 'clear_setup'` / 422 for the unknown `setup_cleared` field if `HeartbeatIn` forbids extras).

- [ ] **Step 3: Schemas** — `HeartbeatIn` gains (after `login_method`):

```python
    # Clear Setup acknowledgment: the request id this kiosk has just applied.
    setup_cleared: uuid.UUID | None = None
```

`HeartbeatOut` gains (after `token_expires_at`):

```python
    # Clear Setup: the pending request id, repeated until acknowledged.
    clear_setup: uuid.UUID | None = None
```

- [ ] **Step 4: Route** — in `heartbeat()`, after the `if body.sign_in:` block and before `await db.commit()`:

```python
    # Clear Setup: an acknowledgment of exactly the pending id closes it.
    # A stale id (re-requested since) or one after a cancel is ignored.
    if body.setup_cleared is not None and device.setup_clear_id == body.setup_cleared:
        audit(db, actor_id=actor.person.id, entity_type="device",
              entity_id=str(device.id), action="setup_cleared",
              changes={"request_id": str(body.setup_cleared),
                       "requested_by": (str(device.setup_clear_requested_by)
                                        if device.setup_clear_requested_by else None)})
        device.setup_clear_id = None
        device.setup_clear_requested_at = None
        device.setup_clear_requested_by = None
```

and the return becomes:

```python
    return HeartbeatOut(device_id=device.id, name=device.name,
                        registration=registration_state(device.token_expires_at, now),
                        token_expires_at=device.token_expires_at,
                        clear_setup=device.setup_clear_id)
```

Also add one sentence to the `heartbeat` docstring: "A pending Clear Setup id is returned as `clear_setup` until a beat sends it back as `setup_cleared`."

- [ ] **Step 5: Run tests**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_kiosk_clear_setup .venv/bin/pytest -q tests/test_kiosk_heartbeat_clear_setup.py tests/test_kiosk_heartbeat_api.py tests/test_kiosk_pairing_sub_type.py tests/test_kiosk_session_scope.py`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/kiosk.py api/tests/test_kiosk_heartbeat_clear_setup.py
git commit -m "feat(kiosk): heartbeat carries a pending Clear Setup and takes the kiosk's acknowledgment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Portal — Clear Setup / Cancel actions and the pending chip

**Files:**
- Modify: `portal/src/lib/api.ts` (`DeviceItem` interface ~line 4437; add two functions after `deregisterDevice` ~line 4504)
- Modify: `portal/src/pages/KioskDevices.tsx` (imports, actions ~line 255–290, `cellFor` ~line 335, RowActionsMenu ~line 477, header comment)
- Modify fixtures that build `DeviceItem`: `portal/src/components/hardware/DeviceEditModal.test.tsx`, `portal/src/lib/devices.test.ts`, `portal/src/pages/KioskDevices.test.tsx`, `portal/src/pages/FixedReaders.test.tsx`, `portal/src/pages/Routers.test.tsx` — add `setup_clear_requested_at: null, setup_clear_requested_by_name: null` next to `session_started_at`.
- Test: `portal/src/pages/KioskDevices.test.tsx`

**Interfaces:**
- Consumes: `POST /devices/{id}/clear-setup`, `POST /devices/{id}/clear-setup/cancel` → DeviceItem (Task 1).
- Produces: `requestClearSetup(id: string): Promise<DeviceItem>`, `cancelClearSetup(id: string): Promise<DeviceItem>`; `DeviceItem.setup_clear_requested_at: string | null`, `DeviceItem.setup_clear_requested_by_name: string | null`.

- [ ] **Step 1: api.ts** — add to `DeviceItem` after `session_started_at: string | null;`:

```ts
  /** Clear Setup pending since (null = nothing pending) and who asked. */
  setup_clear_requested_at: string | null; setup_clear_requested_by_name: string | null;
```

and after `deregisterDevice`:

```ts
/** Queue a Clear Setup for a kiosk; it applies on the kiosk's next check-in. */
export async function requestClearSetup(id: string): Promise<DeviceItem> {
  const resp = await apiFetch(`/devices/${id}/clear-setup`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Withdraw a pending Clear Setup (a no-op when none is pending). */
export async function cancelClearSetup(id: string): Promise<DeviceItem> {
  const resp = await apiFetch(`/devices/${id}/clear-setup/cancel`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

Update the five fixtures (see Files) so `npx tsc -b` stays clean.

- [ ] **Step 2: Write the failing tests** — append to `portal/src/pages/KioskDevices.test.tsx`. Add `requestClearSetup: vi.fn()` and `cancelClearSetup: vi.fn()` to the hoisted `api` mock object. Use the file's existing `kiosk(overrides)` helper and its existing render/list-loading helper (read the top of the file and reuse what the "deregister" test does to render and open a row's Actions menu — copy that pattern exactly rather than inventing selectors). The tests:

```tsx
it('Clear Setup confirms with the spec copy, posts, and reloads', async () => {
  api.listDevices.mockResolvedValue([kiosk({ id: 'k1', name: 'kiosk-dock-1' })]);
  api.requestClearSetup.mockResolvedValue(kiosk({ id: 'k1' }));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  /* render the page and open k1's Actions menu exactly as the deregister test does */
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Clear Setup' }));
  expect(confirm).toHaveBeenCalledWith(
    'Clear Setup on "kiosk-dock-1"? The next time it checks in, its move, site and checkpoint are cleared and whoever is signed in is sent to Kiosk Setup. Queued scans are kept.');
  await waitFor(() => expect(api.requestClearSetup).toHaveBeenCalledWith('k1'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
});

it('declining the confirm does nothing', async () => {
  api.listDevices.mockResolvedValue([kiosk({ id: 'k1', name: 'kiosk-dock-1' })]);
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  /* render + open k1's Actions menu */
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Clear Setup' }));
  expect(api.requestClearSetup).not.toHaveBeenCalled();
});

it('a pending clear shows the chip with who/when and offers Cancel instead', async () => {
  api.listDevices.mockResolvedValue([kiosk({
    id: 'k1', name: 'kiosk-dock-1',
    setup_clear_requested_at: '2026-10-01T14:14:00Z',
    setup_clear_requested_by_name: 'Jimmy Henderson',
  })]);
  api.cancelClearSetup.mockResolvedValue(kiosk({ id: 'k1' }));
  /* render */
  const chip = await screen.findByText('Setup clear pending');
  expect(chip.getAttribute('title')).toMatch(/^Requested by Jimmy Henderson, /);
  /* open k1's Actions menu */
  expect(screen.queryByRole('menuitem', { name: 'Clear Setup' })).toBeNull();
  await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel clear setup' }));
  await waitFor(() => expect(api.cancelClearSetup).toHaveBeenCalledWith('k1'));
});

it('not_a_kiosk shows the friendly error', async () => {
  api.listDevices.mockResolvedValue([kiosk({ id: 'k1', name: 'kiosk-dock-1' })]);
  api.requestClearSetup.mockRejectedValue(new ApiError(409, 'not_a_kiosk'));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  /* render + open k1's Actions menu */
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Clear Setup' }));
  expect(await screen.findByText('Only kiosks can have their setup cleared.')).toBeTruthy();
});

it('Clear Setup is hidden without change permission', async () => {
  /* set the hoisted auth.can to return false for ('scanning_hardware','change') the way the
     file's existing permission test does, render, open the Actions menu if it renders */
  expect(screen.queryByRole('menuitem', { name: 'Clear Setup' })).toBeNull();
});
```

Replace each `/* ... */` comment with the file's real helper calls (they exist for the deregister/delete tests). The role of menu items must match what `RowActionsMenu` renders — check `portal/src/components/hardware/RowActionsMenu.tsx`; if it renders `button`s instead of `menuitem`s, query that role in all five tests.

- [ ] **Step 3: Run to verify they fail**

Run: `cd portal && npx vitest run src/pages/KioskDevices.test.tsx`
Expected: the five new tests FAIL (no Clear Setup item / no chip).

- [ ] **Step 4: Implement** in `KioskDevices.tsx`:

Import `cancelClearSetup, requestClearSetup` from `../lib/api`. Next to `deregister`:

```tsx
  const clearSetup = async (d: DeviceItem) => {
    if (!window.confirm(`Clear Setup on "${d.name}"? The next time it checks in, its move, site and checkpoint are cleared and whoever is signed in is sent to Kiosk Setup. Queued scans are kept.`)) return;
    setError('');
    setNotice('');
    try {
      await requestClearSetup(d.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'not_a_kiosk'
        ? 'Only kiosks can have their setup cleared.' : msgFor(err));
    }
  };

  const cancelClear = async (d: DeviceItem) => {
    setError('');
    setNotice('');
    try {
      await cancelClearSetup(d.id);
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };
```

In the `RowActionsMenu` actions array, right after the Edit entry:

```tsx
                        ...(canChange ? [d.setup_clear_requested_at
                          ? { key: 'cancel-clear-setup', label: 'Cancel clear setup',
                              onSelect: () => void cancelClear(d) }
                          : { key: 'clear-setup', label: 'Clear Setup',
                              onSelect: () => void clearSetup(d) }] : []),
```

In `cellFor`, add a `name` case before `default` (keep the default's text rendering for the name, then the chip):

```tsx
      case 'name': {
        const text = deviceCellText(d, key);
        return (
          <span className="cell-line" title={titleFor(text)}>
            {text}
            {d.setup_clear_requested_at && (
              <>
                {' '}
                <span className="chip c-amber" title={clearChipTitle(d)}>Setup clear pending</span>
              </>
            )}
          </span>
        );
      }
```

and a module-level helper above the component:

```tsx
/** Hover text for the pending Clear Setup chip. */
function clearChipTitle(d: DeviceItem): string {
  const when = d.setup_clear_requested_at
    ? new Date(d.setup_clear_requested_at).toLocaleString() : '';
  return d.setup_clear_requested_by_name
    ? `Requested by ${d.setup_clear_requested_by_name}, ${when}`
    : `Requested ${when}`;
}
```

Before adding the `name` case, read the `default:` branch of `cellFor` and mirror its exact markup for the text (class names, title) so list typography guardrails stay green. Add one line to the file's header comment: "Clear Setup queues a setup reset the kiosk applies on its next check-in; while pending, the row shows a chip and Actions offers Cancel."

- [ ] **Step 5: Run tests**

Run: `cd portal && npx vitest run src/pages/KioskDevices.test.tsx src/lib/devices.test.ts src/pages/FixedReaders.test.tsx src/pages/Routers.test.tsx src/components/hardware src/styles && npx tsc -b`
Expected: all PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add portal/src
git commit -m "feat(portal): Clear Setup / Cancel clear setup on kiosk rows with a pending chip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web kiosk — apply, remember and acknowledge in the heartbeat

**Files:**
- Create: `kiosk/src/lib/setupClear.ts`
- Create: `kiosk/src/lib/setupClear.test.ts`
- Modify: `kiosk/src/lib/api.ts` (`HeartbeatResult` ~line 241, `heartbeatRequest` ~line 248)
- Modify: `kiosk/src/lib/heartbeat.ts`
- Test: `kiosk/src/lib/heartbeat.test.ts`

**Interfaces:**
- Consumes: reply `clear_setup` / request `setup_cleared` (Task 2); `clearKioskSetup()` from `./kioskSetup`, `writeSetupState()` from `./setupState`.
- Produces:
  - `setupClear.ts`: `readSetupClear(): SetupClearRecord | null`, `applySetupClear(id: string): boolean` (true when newly applied), `pendingAck(): string | null`, `settleAck(replyId: string | null): void`, `dismissSetupClearNotice(): void`, `useSetupClearNotice(): boolean`, `type SetupClearRecord = { id: string; acked: boolean; notice: boolean }`.
  - `startHeartbeat(onState, intervalMs?, signIn?, onClearSetup?: (id: string) => void)`.
  - `HeartbeatResult.clear_setup: string | null`; `heartbeatRequest` body accepts `setup_cleared?: string`.

- [ ] **Step 1: Write the failing tests**

`kiosk/src/lib/setupClear.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';

import { readKioskSetup, writeKioskSetup } from './kioskSetup';
import { readSetupState, writeSetupState } from './setupState';
import {
  applySetupClear, dismissSetupClearNotice, pendingAck, readSetupClear, settleAck,
} from './setupClear';

beforeEach(() => localStorage.clear());

it('applies a new id once: clears the setup, marks incomplete, raises the notice', () => {
  writeSetupState('complete');
  expect(applySetupClear('a')).toBe(true);
  expect(readSetupState()).toBe('incomplete');
  expect(readKioskSetup()).toBeNull();
  expect(readSetupClear()).toEqual({ id: 'a', acked: false, notice: true });
  expect(applySetupClear('a')).toBe(false);          // same id never re-applies
  expect(pendingAck()).toBe('a');
});

it('the ack is pending until the server stops asking for that id', () => {
  applySetupClear('a');
  settleAck('a');                                    // still asking → keep sending
  expect(pendingAck()).toBe('a');
  settleAck(null);                                   // server stopped asking
  expect(pendingAck()).toBeNull();
  expect(readSetupClear()?.acked).toBe(true);
});

it('a newer id is applied after an older one', () => {
  applySetupClear('a');
  settleAck(null);
  writeSetupState('complete');
  expect(applySetupClear('b')).toBe(true);
  expect(readSetupState()).toBe('incomplete');
  expect(pendingAck()).toBe('b');
});

it('dismissing the notice keeps the id (no re-apply) and survives reload', () => {
  applySetupClear('a');
  dismissSetupClearNotice();
  expect(readSetupClear()).toEqual({ id: 'a', acked: false, notice: false });
  expect(applySetupClear('a')).toBe(false);
});
```

(If `kioskSetup.ts` has no `writeKioskSetup` export, read the file and use its setter to seed a selection before `applySetupClear`, then assert it is gone; keep the `readKioskSetup()` null assertion.)

Append to `kiosk/src/lib/heartbeat.test.ts`:

```ts
it('applies a clear_setup once, acks on an immediate re-beat, then stops acking', async () => {
  const onClear = vi.fn();
  api.heartbeatRequest
    .mockResolvedValueOnce({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: 'x1' })
    .mockResolvedValueOnce({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: null })
    .mockResolvedValue({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: null });
  const handle = startHeartbeat(vi.fn(), 60_000, undefined, onClear);
  await vi.advanceTimersByTimeAsync(0);
  expect(onClear).toHaveBeenCalledWith('x1');
  expect(api.heartbeatRequest).toHaveBeenCalledTimes(2);            // immediate re-beat
  expect(api.heartbeatRequest.mock.calls[0][0].setup_cleared).toBeUndefined();
  expect(api.heartbeatRequest.mock.calls[1][0].setup_cleared).toBe('x1');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.heartbeatRequest.mock.calls[2][0].setup_cleared).toBeUndefined();
  expect(onClear).toHaveBeenCalledTimes(1);
  handle.stop();
});

it('keeps sending the ack while the server still repeats the same id', async () => {
  api.heartbeatRequest.mockResolvedValue({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: 'x2' });
  const onClear = vi.fn();
  const handle = startHeartbeat(vi.fn(), 60_000, undefined, onClear);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_000);
  const calls = api.heartbeatRequest.mock.calls;
  expect(calls[calls.length - 1][0].setup_cleared).toBe('x2');
  expect(onClear).toHaveBeenCalledTimes(1);
  handle.stop();
});

it('a reload with an unacked id resumes acking without re-applying', async () => {
  localStorage.setItem('ss.kiosk.setupClear', JSON.stringify({ id: 'x3', acked: false, notice: true }));
  api.heartbeatRequest.mockResolvedValue({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: null });
  const onClear = vi.fn();
  const handle = startHeartbeat(vi.fn(), 60_000, undefined, onClear);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.heartbeatRequest.mock.calls[0][0].setup_cleared).toBe('x3');
  expect(onClear).not.toHaveBeenCalled();
  handle.stop();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd kiosk && npx vitest run src/lib/setupClear.test.ts src/lib/heartbeat.test.ts`
Expected: FAIL (module `./setupClear` not found; `setup_cleared` undefined).

- [ ] **Step 3: Implement `kiosk/src/lib/setupClear.ts`:**

```ts
/**
 * Clear Setup, kiosk side. The portal queues a request; the heartbeat
 * reply carries its id (`clear_setup`) until a later beat sends it back
 * (`setup_cleared`). This module is the kiosk-local memory of that
 * exchange, in localStorage like `setupState.ts` (same try/catch idiom):
 *
 *   { id, acked, notice }
 *   - id:     the last request applied — never applied twice, even
 *             across a reload;
 *   - acked:  false while the server may not know yet (keep sending it);
 *   - notice: the "an administrator cleared this kiosk's setup" banner
 *             is up (cleared when setup completes).
 *
 * Queued scans (outbox) and cached move data are deliberately untouched.
 */

import { useSyncExternalStore } from 'react';

import { clearKioskSetup } from './kioskSetup';
import { writeSetupState } from './setupState';

const KEY = 'ss.kiosk.setupClear';

export interface SetupClearRecord { id: string; acked: boolean; notice: boolean }

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): SetupClearRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SetupClearRecord>;
    return typeof v.id === 'string'
      ? { id: v.id, acked: v.acked === true, notice: v.notice === true } : null;
  } catch {
    return null;
  }
}

function write(rec: SetupClearRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rec));
  } catch {
    /* blocked storage: the clear still happened; it may re-apply after a reload */
  }
  listeners.forEach((fn) => fn());
}

export function readSetupClear(): SetupClearRecord | null {
  return read();
}

/** Applies a request id the kiosk hasn't applied before. True when it did. */
export function applySetupClear(id: string): boolean {
  if (read()?.id === id) return false;
  clearKioskSetup();
  writeSetupState('incomplete');
  write({ id, acked: false, notice: true });
  return true;
}

/** The id to send as `setup_cleared`, or null when nothing is owed. */
export function pendingAck(): string | null {
  const rec = read();
  return rec && !rec.acked ? rec.id : null;
}

/** Called with each reply's `clear_setup`: once the server stops asking
 *  for our id (null or a different id), our acknowledgment has landed. */
export function settleAck(replyId: string | null): void {
  const rec = read();
  if (rec && !rec.acked && replyId !== rec.id) write({ ...rec, acked: true });
}

export function dismissSetupClearNotice(): void {
  const rec = read();
  if (rec?.notice) write({ ...rec, notice: false });
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True while the "administrator cleared this kiosk's setup" banner is up. */
export function useSetupClearNotice(): boolean {
  return useSyncExternalStore(subscribe, () => read()?.notice === true, () => false);
}
```

- [ ] **Step 4: api.ts** — `HeartbeatResult` gains `clear_setup?: string | null;` and the `heartbeatRequest` body type gains `setup_cleared?: string;`. The body is already spread into JSON (`rest`), so `setup_cleared` passes through when present; make sure it is not stripped (only `sign_in` is destructured out today).

- [ ] **Step 5: heartbeat.ts** — new signature and beat body:

```ts
import { applySetupClear, pendingAck, settleAck } from './setupClear';

export function startHeartbeat(
  onState: (state: RegistrationState) => void,
  intervalMs: number = HEARTBEAT_MS,
  signIn?: { method: 'password' | 'link' },
  onClearSetup?: (id: string) => void,
): HeartbeatHandle {
```

inside `beat`:

```ts
    const ack = pendingAck();
    try {
      const result = await heartbeatRequest({
        serial, name, mode: platform().mode, version: kioskVersion(),
        ...(asSignIn ? { sign_in: true, login_method: asSignIn.method } : {}),
        ...(ack ? { setup_cleared: ack } : {}),
      });
      if (asSignIn) pendingSignIn = undefined;
      if (!stopped) onState(result.registration);
      const asked = result.clear_setup ?? null;
      settleAck(asked);
      if (asked && applySetupClear(asked)) {
        onClearSetup?.(asked);
        if (!stopped) void beat();          // acknowledge right away
      }
    } catch {
```

Update the module header comment with one sentence about Clear Setup ("A reply's `clear_setup` id is applied once via setupClear.ts and acknowledged on an immediate re-beat.").

- [ ] **Step 6: Run tests**

Run: `cd kiosk && npx vitest run src/lib && npx tsc -b`
Expected: all PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add kiosk/src/lib
git commit -m "feat(kiosk): heartbeat applies a Clear Setup once and acknowledges it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web kiosk — send the person to Kiosk Setup and show the banner

**Files:**
- Modify: `kiosk/src/auth/KioskAuthContext.tsx` (value interface ~line 40, heartbeat effect ~line 105)
- Modify: `kiosk/src/layout/KioskShell.tsx` (~line 59)
- Modify: `kiosk/src/pages/KioskSetup.tsx` (wizard view ~line 225; completion ~line 148)
- Tests: `kiosk/src/layout/KioskShell.test.tsx` (create if absent, else append), `kiosk/src/pages/KioskSetup.test.tsx` (append)

**Interfaces:**
- Consumes: `startHeartbeat(onState, intervalMs, signIn, onClearSetup)`, `useSetupClearNotice()`, `dismissSetupClearNotice()` (Task 4).
- Produces: `KioskAuthValue.setupClearedSignal: number` (0 until a clear is applied this session; increments on each applied clear).

- [ ] **Step 1: Write the failing tests**

In `kiosk/src/pages/KioskSetup.test.tsx` (reuse the file's render helper and mocks):

```tsx
it('shows the administrator banner while the clear notice is up, and drops it once setup completes', async () => {
  localStorage.setItem('ss.kiosk.setupClear', JSON.stringify({ id: 'x', acked: true, notice: true }));
  /* render KioskSetup exactly as the file's other tests do */
  expect(await screen.findByText(
    "An administrator cleared this kiosk's setup. Run Kiosk Setup to continue.")).toBeTruthy();
  /* complete the wizard exactly as the file's existing "completes setup" test does */
  await waitFor(() => expect(screen.queryByText(
    "An administrator cleared this kiosk's setup. Run Kiosk Setup to continue.")).toBeNull());
  expect(JSON.parse(localStorage.getItem('ss.kiosk.setupClear')!).notice).toBe(false);
});

it('shows no banner without a clear notice', async () => {
  /* render */
  await screen.findByText('Kiosk setup');
  expect(screen.queryByText(/administrator cleared this kiosk's setup/)).toBeNull();
});
```

For `KioskShell` navigation, test through the context's signal. If `kiosk/src/layout/KioskShell.test.tsx` exists, follow its mocking of `useKioskAuth`; otherwise create it:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth.value }));

import KioskShell from './KioskShell';

function base(signal: number) {
  return {
    status: 'authed', person: { display_name: 'A' }, registration: 'ok', preferences: null,
    sessionExpiresAt: null, kioskMove: null, logout: vi.fn(), setupClearedSignal: signal,
  };
}

it('a new clear signal sends the person to /setup', async () => {
  auth.value = base(0);
  const ui = (
    <MemoryRouter initialEntries={['/scan']}>
      <Routes>
        <Route path="/scan" element={<KioskShell><div>Scan page</div></KioskShell>} />
        <Route path="/setup" element={<div>Setup page</div>} />
      </Routes>
    </MemoryRouter>
  );
  const { rerender } = render(ui);
  expect(await screen.findByText('Scan page')).toBeTruthy();
  auth.value = base(1);
  rerender(ui);
  expect(await screen.findByText('Setup page')).toBeTruthy();
});
```

(KioskShell reads more fields from `useKioskAuth()` than `base()` provides — read its destructuring at line ~60 and add every field it uses to `base()` with a harmless value; mock any other module it imports that needs a provider, mirroring other kiosk component tests.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd kiosk && npx vitest run src/pages/KioskSetup.test.tsx src/layout/KioskShell.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Context** — in `KioskAuthContext.tsx`: add `setupClearedSignal: number;` to `KioskAuthValue`; `const [setupClearedSignal, setSetupClearedSignal] = useState(0);`; pass the hook to the heartbeat:

```ts
    const handle = startHeartbeat(setRegistration, HEARTBEAT_MS, signInRef.current,
      () => setSetupClearedSignal((n) => n + 1));
```

and include `setupClearedSignal` in the provided value object (and its `useMemo` deps if the value is memoized).

- [ ] **Step 4: KioskShell** — add `setupClearedSignal` to the `useKioskAuth()` destructuring and:

```tsx
  // Clear Setup from the portal: whoever is signed in goes to Kiosk Setup.
  useEffect(() => {
    if (setupClearedSignal > 0 && location.pathname !== '/setup') {
      navigate('/setup', { replace: true });
    }
    // only a NEW signal navigates — not every route change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupClearedSignal]);
```

(Import `useEffect` if not already imported.)

- [ ] **Step 5: KioskSetup** — import `dismissSetupClearNotice, useSetupClearNotice` from `../lib/setupClear`; in the component: `const clearNotice = useSetupClearNotice();`. In the wizard view, right after `<h1 className="page-title">Kiosk setup</h1>` (the ~line 227 occurrence):

```tsx
      {clearNotice && (
        <div className="sys-banner sys-banner-broadcast" role="status">
          An administrator cleared this kiosk&apos;s setup. Run Kiosk Setup to continue.
        </div>
      )}
```

Render the same block after the other `page-title` h1 (~line 170) too, so the banner is visible whichever view shows first. On successful completion, right after `writeSetupState('complete');` add `dismissSetupClearNotice();`.

- [ ] **Step 6: Run tests**

Run: `cd kiosk && npx vitest run && npx tsc -b`
Expected: all PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add kiosk/src
git commit -m "feat(kiosk): Clear Setup sends the signed-in person to Kiosk Setup with a banner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Android app — same contract

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/model/Kiosk.kt` (`HeartbeatIn` ~line 21, `HeartbeatResult` ~line 32)
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/prefs/KioskPrefs.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/heartbeat/Heartbeat.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/AppContainer.kt` (~line 82: pass `prefs`)
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/shell/KioskShell.kt` (navigate on clear)
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/setup/KioskSetupScreen.kt` and `KioskSetupViewModel.kt` (banner + dismiss on completion)
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/data/heartbeat/HeartbeatTest.kt`; `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/data/FakeKioskApi.kt` if its default `heartbeatResult` needs the new field

**Interfaces:**
- Consumes: reply `clear_setup` / request `setup_cleared` (Task 2).
- Produces: `HeartbeatIn.setup_cleared: String?`, `HeartbeatResult.clear_setup: String?`; `KioskPrefs.setupClear: Flow<SetupClearRecord?>`, `suspend fun applySetupClear(id: String): Boolean`, `suspend fun settleSetupClearAck(replyId: String?)`, `suspend fun pendingSetupClearAck(): String?`, `suspend fun dismissSetupClearNotice()`; `@Serializable data class SetupClearRecord(val id: String, val acked: Boolean = false, val notice: Boolean = false)`; `Heartbeat(api, identity, config, prefs, deviceInfo, intervalMs)` and `Heartbeat.setupCleared: SharedFlow<String>`.

- [ ] **Step 1: Write the failing tests** — in `HeartbeatTest.kt` change the harness to pass prefs and return both:

```kotlin
    private fun harness(scope: kotlinx.coroutines.CoroutineScope, api: FakeKioskApi): Pair<Heartbeat, KioskPrefs> {
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "hb.preferences_pb") })
        val config = KioskConfig(prefs, "https://api", "https://portal", "0.1.0")
        return Heartbeat(api, Identity(prefs), config, prefs, deviceInfo = { mapOf("model" to "MC2200") }, intervalMs = 60_000) to prefs
    }
```

(update the two existing tests to `val (hb, _) = harness(...)`), then add:

```kotlin
    @Test fun clearSetupAppliesOnceAcksOnARebeatThenStops() = runTest {
        val api = FakeKioskApi()
        // a fake server: repeats the pending id until a beat acknowledges it
        var pending: String? = "x1"
        api.heartbeatResult = {
            if (it.setup_cleared != null && it.setup_cleared == pending) pending = null
            HeartbeatResult("d", it.name, "ok", null, clear_setup = pending)
        }
        val (hb, prefs) = harness(backgroundScope, api)
        prefs.setSetupState(SetupState.COMPLETE)
        val events = mutableListOf<String>()
        backgroundScope.launch { hb.setupCleared.collect { events += it } }
        hb.start(backgroundScope, signIn = null)
        settle()
        assertEquals(listOf("x1"), events)
        assertEquals(SetupState.INCOMPLETE, prefs.setupState.first())
        assertNull(api.heartbeats[0].setup_cleared)
        assertEquals("x1", api.heartbeats[1].setup_cleared)          // immediate re-beat acks
        advanceTimeBy(60_001); settle()
        assertNull(api.heartbeats.last().setup_cleared)               // server stopped asking
        assertEquals(1, events.size)
    }

    @Test fun keepsAckingWhileTheServerRepeatsTheSameId() = runTest {
        val api = FakeKioskApi()
        api.heartbeatResult = { HeartbeatResult("d", it.name, "ok", null, clear_setup = "x2") }
        val (hb, _) = harness(backgroundScope, api)
        hb.start(backgroundScope, signIn = null)
        settle(); advanceTimeBy(60_001); settle()
        assertEquals("x2", api.heartbeats.last().setup_cleared)
    }

    @Test fun anUnackedIdFromBeforeARestartIsAckedNotReapplied() = runTest {
        val api = FakeKioskApi()
        api.heartbeatResult = { HeartbeatResult("d", it.name, "ok", null, clear_setup = null) }
        val (hb, prefs) = harness(backgroundScope, api)
        prefs.applySetupClear("x3")
        prefs.setSetupState(SetupState.COMPLETE)                       // set up again since
        hb.start(backgroundScope, signIn = null)
        settle()
        assertEquals("x3", api.heartbeats[0].setup_cleared)
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())   // not re-cleared
    }
```

Add imports: `com.serversherpa.kiosk.core.model.HeartbeatResult`, the `SetupState` type (find its package with `grep -rn "enum class SetupState" app/src/main`), `kotlinx.coroutines.flow.first`, `kotlinx.coroutines.launch`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd Android_Kiosk_App && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew testDebugUnitTest --tests '*HeartbeatTest*'`
Expected: compile FAIL (no `clear_setup`, no `prefs` parameter).

- [ ] **Step 3: Models** — `HeartbeatIn` gains `val setup_cleared: String? = null,` (last parameter); `HeartbeatResult` gains `val clear_setup: String? = null,` (last parameter). `KioskJson` has `explicitNulls = false`, so a null `setup_cleared` is omitted on the wire, and `ignoreUnknownKeys = true` keeps older builds safe.

- [ ] **Step 4: Prefs** — in `KioskPrefs.kt`:

```kotlin
/** Clear Setup memory — same JSON shape and key as the web kiosk's setupClear.ts. */
@Serializable
data class SetupClearRecord(val id: String, val acked: Boolean = false, val notice: Boolean = false)
```

Key: `val setupClear = stringPreferencesKey("ss.kiosk.setupClear")` in `Keys`. Members:

```kotlin
    val setupClear: Flow<SetupClearRecord?> = store.data.map { p ->
        p[Keys.setupClear]?.let { raw -> try { json.decodeFromString<SetupClearRecord>(raw) } catch (e: Exception) { null } }
    }

    /** Applies an id not applied before: drops the setup, marks incomplete, raises the notice — one write. */
    suspend fun applySetupClear(id: String): Boolean {
        var applied = false
        store.edit { p ->
            val cur = p[Keys.setupClear]?.let { raw -> try { json.decodeFromString<SetupClearRecord>(raw) } catch (e: Exception) { null } }
            if (cur?.id != id) {
                p.remove(Keys.setupSelection)
                p[Keys.setupState] = SetupState.INCOMPLETE.wire
                p[Keys.setupClear] = json.encodeToString(SetupClearRecord.serializer(), SetupClearRecord(id, acked = false, notice = true))
                applied = true
            }
        }
        return applied
    }

    suspend fun pendingSetupClearAck(): String? = setupClear.first()?.takeIf { !it.acked }?.id

    suspend fun settleSetupClearAck(replyId: String?) {
        val cur = setupClear.first() ?: return
        if (!cur.acked && replyId != cur.id) {
            store.edit { it[Keys.setupClear] = json.encodeToString(SetupClearRecord.serializer(), cur.copy(acked = true)) }
        }
    }

    suspend fun dismissSetupClearNotice() {
        val cur = setupClear.first() ?: return
        if (cur.notice) store.edit { it[Keys.setupClear] = json.encodeToString(SetupClearRecord.serializer(), cur.copy(notice = false)) }
    }
```

(imports: `kotlinx.coroutines.flow.first`, `kotlinx.serialization.Serializable` if not present.)

- [ ] **Step 5: Heartbeat** — constructor gains `private val prefs: KioskPrefs,` after `config`. Add:

```kotlin
    private val _setupCleared = MutableSharedFlow<String>(extraBufferCapacity = 1)
    /** Emits a Clear Setup id the moment it is applied, so the UI can go to Setup. */
    val setupCleared: SharedFlow<String> = _setupCleared
```

and `beat()` becomes:

```kotlin
    private suspend fun beat() {
        val (serial, name) = identity.get()
        val asSignIn = pendingSignIn
        val ack = prefs.pendingSetupClearAck()
        try {
            val result = api.heartbeat(HeartbeatIn(
                serial = serial, name = name, mode = "android", version = config.kioskVersion,
                raw_info = deviceInfo(), sign_in = asSignIn != null, login_method = asSignIn?.wire,
                setup_cleared = ack,
            ))
            if (asSignIn != null && pendingSignIn === asSignIn) pendingSignIn = null
            _registration.value = RegistrationState.fromWire(result.registration)
            prefs.settleSetupClearAck(result.clear_setup)
            val asked = result.clear_setup
            if (asked != null && prefs.applySetupClear(asked)) {
                _setupCleared.tryEmit(asked)
                beat()                                   // acknowledge right away
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            /* keep the last known state and any pending sign-in / ack */
        }
    }
```

(imports `kotlinx.coroutines.flow.MutableSharedFlow`, `SharedFlow`, `com.serversherpa.kiosk.data.prefs.KioskPrefs`.) Update the class KDoc with one sentence on Clear Setup.

- [ ] **Step 6: Wiring + UI**
  - `AppContainer.kt`: `Heartbeat(api, identity, config, prefs, deviceInfo = { ... })`.
  - `KioskShell.kt` (it already reads `container.heartbeat.registration`): add
    ```kotlin
    LaunchedEffect(Unit) {
        container.heartbeat.setupCleared.collect {
            nav.navigate(Routes.SETUP) { launchSingleTop = true }
        }
    }
    ```
  - `KioskSetupScreen.kt`: collect `container.prefs.setupClear` (or via the view model) and, when `record?.notice == true`, show under the screen title a banner `Text("An administrator cleared this kiosk's setup. Run Kiosk Setup to continue.")` styled like the screen's existing notice/error surfaces (read the file and reuse its existing banner or card composable; do not invent a new color).
  - `KioskSetupViewModel.kt`: wherever it marks setup complete (`setSetupState(SetupState.COMPLETE)` or equivalent), call `prefs.dismissSetupClearNotice()` right after.
  - If `FakeKioskApi`'s default `heartbeatResult` constructs `HeartbeatResult` positionally, it still compiles (new param has a default).

- [ ] **Step 7: Run tests**

Run: `cd Android_Kiosk_App && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew testDebugUnitTest`
Expected: BUILD SUCCESSFUL, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add Android_Kiosk_App/app/src
git commit -m "feat(android-kiosk): Clear Setup — apply once, acknowledge, go to Setup with a banner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
