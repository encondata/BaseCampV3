# Devices Table + Routers List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A unified `devices` table (device_type-discriminated) with list + delete API, and a real Routers page — full standard directory list over GL.iNet routers — replacing the placeholder, with two sample rows seeded into the dev DB.

**Architecture:** Migration 0037 creates the vocabulary + table; a small router (`/devices`) serves the read + delete surface; the portal Routers page mirrors the status-rules RulesTab (itself modeled on Notifications.tsx). Registration endpoint deliberately deferred — nothing here may block a future upsert-by-serial.

**Spec:** `docs/superpowers/specs/2026-08-31-devices-routers-design.md` — the column table, wire shape, and copy there are binding.

**Tech Stack:** Alembic/SQLAlchemy async/FastAPI, React + house list libs. No new dependencies.

## Global Constraints

- Migration number **0037** (`down_revision = "0036"`).
- Vocabulary record type `device_type`, keys exactly `router`, `fixed_reader`, `handheld_reader`, `kiosk`; registered in `status/registry.py` with `resource="scanning_hardware"`.
- `devices.serial` and `devices.mac` partial-unique (`WHERE … IS NOT NULL`); serial is the future registration upsert key — do not add constraints that would break upsert-by-serial.
- Hard delete only (no `archived_at`); DELETE is audited (`entity_type="device"`).
- All endpoints gated on resource `scanning_hardware` (view for GET, delete for DELETE). Error style `HTTPException(status, detail={"code": …})`; 404 code `device_not_found`.
- Routers page: page key `'hardware-routers'`, default sort `name` asc; disabled toolbar button labeled `Register router` with hint copy exactly "Routers self-register — the registration endpoint arrives with the device agent."
- Sample rows are dev-DB inserts only — never migration seeds; production starts empty.
- **All suites FOREGROUND, one continuous run, timeout 600000ms. Never background a suite.** API: `api/.venv/bin/pytest …`. Portal: `npm --prefix portal test -- --run …` + `npm --prefix portal run build`.
- Never commit `api/src/serversherpa/_dev_reload.py`.

## File Structure

| File | Responsibility |
|---|---|
| `api/migrations/versions/0037_devices.py` | Create: vocab seeds + `devices` table |
| `api/src/serversherpa/db/models.py` | Modify: +`Device` model (after `StatusRuleExecution`) |
| `api/src/serversherpa/status/registry.py` | Modify: +`device_type` record type |
| `api/src/serversherpa/api/schemas.py` | Modify: +`DeviceItem` |
| `api/src/serversherpa/api/routes/devices.py` | Create: GET list + DELETE |
| `api/src/serversherpa/api/app.py` | Modify: register router |
| `portal/src/lib/api.ts` | Modify: +devices client block |
| `portal/src/lib/devices.ts` | Create: uptime humanizer + list accessors |
| `portal/src/pages/Routers.tsx` | Create: full directory list |
| `portal/src/pages/ScanningHardware.tsx` | Modify: drop the `HardwareRouters` export |
| `portal/src/App.tsx` | Modify: route → `Routers` |
| Tests | `api/tests/test_devices_api.py`, `portal/src/lib/devices.test.ts`, `portal/src/pages/Routers.test.tsx`, updates to `ScanningHardware.test.tsx` |

---

### Task 1: Migration 0037, Device model, registry entry

**Files:**
- Create: `api/migrations/versions/0037_devices.py`
- Modify: `api/src/serversherpa/db/models.py`, `api/src/serversherpa/status/registry.py`
- Test: `api/tests/test_devices_api.py` (model tests; Task 2 appends route tests)

**Interfaces:**
- Produces the `Device` ORM model consumed by Task 2: columns exactly `id, device_type, name, serial, mac, site_id, wan_ip, lan_ip, uptime_seconds, last_seen_at, raw_info, registered_at, created_at, updated_at` (+ GENERATED `type_record_type`, never written).

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_devices_api.py
"""Devices — model round-trip, vocab FK enforcement (Task 1); list +
delete routes (Task 2 appends)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import Device


async def test_device_round_trip(db):
    d = Device(device_type="router", name="dock-router-1",
               serial="GL-MT300N-C4A1B2", mac="94:83:C4:12:A1:B2",
               wan_ip="203.0.113.14", lan_ip="192.168.8.1",
               uptime_seconds=1_036_800,
               last_seen_at=datetime.now(UTC),
               raw_info={"model": "GL-MT300N", "firmware": "4.3.11"})
    db.add(d)
    await db.commit()
    got = await db.scalar(select(Device).where(Device.id == d.id))
    assert got.device_type == "router"
    assert got.raw_info["model"] == "GL-MT300N"
    assert got.registered_at is not None


async def test_device_type_fk_rejects_unknown_key(db):
    db.add(Device(device_type="toaster", name="nope"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_serial_partial_unique(db):
    db.add(Device(device_type="router", name="a", serial="DUP-1"))
    await db.commit()
    db.add(Device(device_type="router", name="b", serial="DUP-1"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    # NULL serials never collide (partial index)
    db.add_all([Device(device_type="kiosk", name="k1"),
                Device(device_type="kiosk", name="k2")])
    await db.commit()
```

- [ ] **Step 2: Run to verify failure**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: FAIL — `ImportError: cannot import name 'Device'`

- [ ] **Step 3: Write the migration**

```python
# api/migrations/versions/0037_devices.py
"""devices — one table for the whole scanning-hardware fleet.
device_type discriminates (same unification trade as initiatives:
typed nullable per-family columns, never queryable-data-in-JSON);
wan_ip/lan_ip/uptime are the router block, future families add their
own columns in their own migrations. raw_info holds the device's last
raw registration payload verbatim (provenance only). serial is the
future registration endpoint's upsert key. Hard delete — no
archived_at; deletes are audited.

Revision ID: 0037
Revises: 0036
Create Date: 2026-08-31
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID

revision: str = "0037"
down_revision: str | None = "0036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

VOCAB_SEEDS = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('device_type','router','Router','GL.iNet site router.','#1668a7',1),
      ('device_type','fixed_reader','Fixed Reader','Zebra FX9600 fixed RFID reader.','#178a4c',2),
      ('device_type','handheld_reader','Handheld Reader','Android / iOS / Zebra handheld scanner.','#6d4fc4',3),
      ('device_type','kiosk','Kiosk','Web or iPad kiosk station.','#a36207',4)
"""


def upgrade() -> None:
    op.execute(VOCAB_SEEDS)
    op.create_table(
        "devices",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("device_type", sa.Text, nullable=False),
        sa.Column("name", CITEXT, nullable=False),
        sa.Column("serial", CITEXT,
                  comment="registration upsert key (future endpoint)"),
        sa.Column("mac", CITEXT),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("wan_ip", sa.Text, comment="router-typed"),
        sa.Column("lan_ip", sa.Text, comment="router-typed"),
        sa.Column("uptime_seconds", sa.BigInteger,
                  comment="last reported; display as-of last_seen_at"),
        sa.Column("last_seen_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("raw_info", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb"),
                  comment="last raw registration payload; never queried"),
        sa.Column("registered_at", sa.TIMESTAMP(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.execute("""
        ALTER TABLE devices ADD COLUMN type_record_type text
          GENERATED ALWAYS AS ('device_type') STORED
    """)
    op.create_foreign_key(
        "devices_device_type_fkey", "devices", "status_values",
        ["type_record_type", "device_type"], ["record_type", "key"])
    op.create_index("devices_type_idx", "devices", ["device_type"])
    op.create_index("devices_name_idx", "devices", ["name"])
    op.create_index("devices_serial_uniq", "devices", ["serial"],
                    unique=True, postgresql_where=sa.text("serial IS NOT NULL"))
    op.create_index("devices_mac_uniq", "devices", ["mac"],
                    unique=True, postgresql_where=sa.text("mac IS NOT NULL"))


def downgrade() -> None:
    op.drop_table("devices")
    op.get_bind().execute(sa.text(
        "DELETE FROM status_values WHERE record_type = 'device_type'"))
```

- [ ] **Step 4: Add the model** (in `api/src/serversherpa/db/models.py`, after `StatusRuleExecution`):

```python
class Device(Base):
    """One row per piece of scanning hardware; device_type discriminates
    (initiatives-style unification). wan_ip/lan_ip/uptime_seconds are
    the router block — NULL for other families. serial is the future
    registration endpoint's upsert key. Hard-delete only; deletes are
    audited."""

    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    device_type: Mapped[str]
    type_record_type: Mapped[str] = mapped_column(
        server_default=text("'device_type'"))  # GENERATED; never written
    name: Mapped[str] = mapped_column(CITEXT)
    serial: Mapped[str | None] = mapped_column(CITEXT)
    mac: Mapped[str | None] = mapped_column(CITEXT)
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    wan_ip: Mapped[str | None]
    lan_ip: Mapped[str | None]
    uptime_seconds: Mapped[int | None] = mapped_column(BigInteger)
    last_seen_at: Mapped[datetime | None]
    raw_info: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    registered_at: Mapped[datetime] = mapped_column(
        server_default=text("now()"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

Add to `api/src/serversherpa/status/registry.py`, after the `time_entry` entry:

```python
    StatusRecordType("device_type", "Device type",
                     sources=(("devices", "device_type"),),
                     resource="scanning_hardware"),
```

- [ ] **Step 5: Run tests + registry suites**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py api/tests/test_status_registry.py api/tests/test_status_values_api.py -v`
Expected: the 3 new tests pass; registry/vocab suites pass (update any pinned record-type lists deliberately, as was done when `device_type`'s predecessors were added — note updates in the report).

- [ ] **Step 6: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/migrations/versions/0037_devices.py api/src/serversherpa/db/models.py api/src/serversherpa/status/registry.py api/tests/test_devices_api.py
git commit -m "feat(api): devices table — unified fleet registry, device_type vocab (migration 0037)"
```

(Add any updated registry-test files too.)

---

### Task 2: API — list + delete routes

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py`
- Create: `api/src/serversherpa/api/routes/devices.py`
- Modify: `api/src/serversherpa/api/app.py`
- Test: `api/tests/test_devices_api.py` (append)

**Interfaces:**
- Consumes: Task 1's `Device`.
- Produces wire shape (consumed by Task 3): `GET /devices?device_type=` → `[DeviceItem]` = `{id, device_type, name, serial, mac, site_id, site_name, wan_ip, lan_ip, uptime_seconds, last_seen_at, raw_info, registered_at}`, ordered `registered_at DESC`; `DELETE /devices/{device_id}` → 204 / 404 `device_not_found`.

- [ ] **Step 1: Write the failing tests.** Append to `api/tests/test_devices_api.py`, reusing the client/login fixture pattern from `api/tests/test_status_rules_api.py` (read it first — same admin login + external-role 403 helpers). Full bodies for:

```python
# 4. test_list_devices_filters_by_type — insert 1 router + 1 kiosk +
#    a Site; GET /devices?device_type=router → only the router, with
#    site_name resolved and wan_ip/uptime_seconds present; GET /devices
#    (no filter) → both, newest registered_at first.
# 5. test_delete_device — DELETE /devices/{id} → 204; row gone; audit
#    row exists (entity_type="device", action="delete", changes carry
#    name/device_type/serial); DELETE again → 404 device_not_found.
# 6. test_devices_permissions — as an 'external'-role user: GET → 403
#    and DELETE → 403 (scanning_hardware grants absent).
```

- [ ] **Step 2: Run to verify failure**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: new tests FAIL with 404s (router unregistered).

- [ ] **Step 3: Implement.** Schema (append to `api/src/serversherpa/api/schemas.py`):

```python
# ── devices ──────────────────────────────────────────────────────────

class DeviceItem(BaseModel):
    id: uuid.UUID
    device_type: str
    name: str
    serial: str | None
    mac: str | None
    site_id: uuid.UUID | None
    site_name: str | None
    wan_ip: str | None
    lan_ip: str | None
    uptime_seconds: int | None
    last_seen_at: datetime | None
    raw_info: dict
    registered_at: datetime
```

Router:

```python
# api/src/serversherpa/api/routes/devices.py
"""Devices — the scanning-hardware fleet registry's read + delete
surface. The self-registration endpoint (pre-shared-token auth, upsert
by serial, doubles as the heartbeat) is deferred; nothing here may
block that shape. Hard delete, audited."""

import uuid

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import DeviceItem
from serversherpa.db.models import Device, Site
from serversherpa.services.audit import audit

router = APIRouter(prefix="/devices", tags=["devices"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


@router.get("", response_model=list[DeviceItem])
async def list_devices(
    db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "view"),
    device_type: str | None = None,
) -> list[dict]:
    query = (select(Device, Site.name)
             .outerjoin(Site, Device.site_id == Site.id)
             .order_by(Device.registered_at.desc(), Device.id))
    if device_type is not None:
        query = query.where(Device.device_type == device_type)
    rows = (await db.execute(query)).all()
    return [{
        "id": d.id, "device_type": d.device_type, "name": d.name,
        "serial": d.serial, "mac": d.mac,
        "site_id": d.site_id, "site_name": site_name,
        "wan_ip": d.wan_ip, "lan_ip": d.lan_ip,
        "uptime_seconds": d.uptime_seconds,
        "last_seen_at": d.last_seen_at, "raw_info": d.raw_info,
        "registered_at": d.registered_at,
    } for d, site_name in rows]


@router.delete("/{device_id}", status_code=204)
async def delete_device(
    device_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "delete"),
) -> None:
    device = await db.get(Device, device_id)
    if device is None:
        raise _err(404, "device_not_found")
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="delete",
          changes={"name": device.name, "device_type": device.device_type,
                   "serial": device.serial})
    await db.delete(device)
    await db.commit()
```

Register in `api/src/serversherpa/api/app.py`: add `devices` to the routes import and `app.include_router(devices.router)` after the `status_rules` line.

- [ ] **Step 4: Run to verify pass**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: 6 PASS

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/devices.py api/src/serversherpa/api/app.py api/tests/test_devices_api.py
git commit -m "feat(api): devices list + delete routes"
```

---

### Task 3: Portal — Routers directory list

**Files:**
- Modify: `portal/src/lib/api.ts` (append `/* ── devices ── */` block)
- Create: `portal/src/lib/devices.ts`, `portal/src/lib/devices.test.ts`
- Create: `portal/src/pages/Routers.tsx`, `portal/src/pages/Routers.test.tsx`
- Modify: `portal/src/App.tsx` (route `/hardware/routers` → `Routers`), `portal/src/pages/ScanningHardware.tsx` (drop `HardwareRouters`), `portal/src/pages/ScanningHardware.test.tsx` (drop its case)

**Interfaces:**
- Consumes: Task 2's wire shape.
- Produces in `api.ts`:

```ts
export interface DeviceItem {
  id: string; device_type: string; name: string;
  serial: string | null; mac: string | null;
  site_id: string | null; site_name: string | null;
  wan_ip: string | null; lan_ip: string | null;
  uptime_seconds: number | null; last_seen_at: string | null;
  raw_info: Record<string, unknown>; registered_at: string;
}
export async function listDevices(deviceType?: string): Promise<DeviceItem[]>
export async function deleteDevice(id: string): Promise<void>
```

- Produces in `devices.ts` (pure, no component imports): `formatUptime(seconds: number | null | undefined): string` (`'—'` when null; else `12d 4h` / `3h 12m` / `45m` / `<1m`), `deviceCellText(d: DeviceItem, key: string): string`, `deviceSearchText(d: DeviceItem): string`, `deviceSortValue(d: DeviceItem, key: string): string | number`.

- [ ] **Step 1: Write the failing lib tests**

```ts
// portal/src/lib/devices.test.ts
import { describe, expect, it } from 'vitest';

import type { DeviceItem } from './api';
import {
  deviceCellText, deviceSearchText, deviceSortValue, formatUptime,
} from './devices';

const R: DeviceItem = {
  id: 'd1', device_type: 'router', name: 'dock-router-1',
  serial: 'GL-MT300N-C4A1B2', mac: '94:83:C4:12:A1:B2',
  site_id: 's1', site_name: 'NAP 11',
  wan_ip: '203.0.113.14', lan_ip: '192.168.8.1',
  uptime_seconds: 1_036_800, last_seen_at: '2026-08-31T10:00:00Z',
  raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
};

describe('formatUptime', () => {
  it('humanizes', () => {
    expect(formatUptime(null)).toBe('—');
    expect(formatUptime(45)).toBe('<1m');
    expect(formatUptime(45 * 60)).toBe('45m');
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe('3h 12m');
    expect(formatUptime(1_036_800)).toBe('12d 0h');
  });
});

describe('device accessors', () => {
  it('cellText mirrors display fields', () => {
    expect(deviceCellText(R, 'name')).toBe('dock-router-1');
    expect(deviceCellText(R, 'wan_ip')).toBe('203.0.113.14');
    expect(deviceCellText(R, 'lan_ip')).toBe('192.168.8.1');
    expect(deviceCellText(R, 'mac')).toBe('94:83:C4:12:A1:B2');
    expect(deviceCellText(R, 'serial')).toBe('GL-MT300N-C4A1B2');
    expect(deviceCellText(R, 'uptime')).toBe('12d 0h');
    expect(deviceCellText(R, 'site')).toBe('NAP 11');
    expect(deviceCellText({ ...R, wan_ip: null }, 'wan_ip')).toBe('—');
    expect(deviceCellText({ ...R, last_seen_at: null }, 'last_seen')).toBe('never');
  });
  it('searchText covers name/ips/mac/serial/site', () => {
    const hay = deviceSearchText(R).toLowerCase();
    for (const bit of ['dock-router-1', '203.0.113.14', '192.168.8.1',
                       '94:83:c4:12:a1:b2', 'gl-mt300n-c4a1b2', 'nap 11']) {
      expect(hay).toContain(bit);
    }
  });
  it('sortValue is numeric for uptime', () => {
    expect(deviceSortValue(R, 'uptime')).toBe(1_036_800);
    expect(deviceSortValue({ ...R, uptime_seconds: null }, 'uptime')).toBe(-1);
    expect(deviceSortValue(R, 'name')).toBe('dock-router-1');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm --prefix portal test -- --run src/lib/devices.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement lib + api client.**

```ts
// portal/src/lib/devices.ts
/** Pure display helpers for the device-fleet lists. cellText mirrors
 *  the rendered cell text exactly (house search/CSV contract). */

import type { DeviceItem } from './api';

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return '<1m';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function deviceCellText(d: DeviceItem, key: string): string {
  switch (key) {
    case 'name': return d.name;
    case 'wan_ip': return d.wan_ip ?? '—';
    case 'lan_ip': return d.lan_ip ?? '—';
    case 'mac': return d.mac ?? '—';
    case 'serial': return d.serial ?? '—';
    case 'uptime': return formatUptime(d.uptime_seconds);
    case 'last_seen':
      return d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never';
    case 'site': return d.site_name ?? '—';
    default: return '';
  }
}

export function deviceSearchText(d: DeviceItem): string {
  return [d.name, d.wan_ip, d.lan_ip, d.mac, d.serial, d.site_name]
    .filter(Boolean).join(' ');
}

export function deviceSortValue(d: DeviceItem, key: string): string | number {
  switch (key) {
    case 'uptime': return d.uptime_seconds ?? -1;
    case 'last_seen': return d.last_seen_at ?? '';
    default: return deviceCellText(d, key).toLowerCase();
  }
}
```

`api.ts` block (modeled on the status-rules block's `apiFetch`/`errorFrom` pattern): `listDevices(deviceType?)` builds `/devices` + `?device_type=` via `URLSearchParams` when given; `deleteDevice(id)` DELETEs and returns void on 204. Interfaces per this task's Interfaces block, verbatim.

Run: `npm --prefix portal test -- --run src/lib/devices.test.ts` → all pass.

- [ ] **Step 4: Build the page.** `portal/src/pages/Routers.tsx` — a full standard directory page modeled on `portal/src/components/statusRules/RulesTab.tsx` (read it first; it is this codebase's freshest full-pattern list) but as a standalone page (own `.portal-page`/`.dir-head` like `Notifications.tsx`, eyebrow `Scanning Hardware`, title `Routers`, hint `GL.iNet site routers.`):

1. Columns:
   ```ts
   const COLUMNS: ColumnDef[] = [
     { key: 'name', label: 'Name', width: 'minmax(180px, 1.4fr)', default: true },
     { key: 'wan_ip', label: 'WAN IP', width: 'minmax(120px, 1fr)', default: true },
     { key: 'lan_ip', label: 'LAN IP', width: 'minmax(120px, 1fr)', default: true },
     { key: 'mac', label: 'MAC', width: 'minmax(150px, 1fr)', default: true },
     { key: 'serial', label: 'Serial', width: 'minmax(150px, 1fr)', default: true },
     { key: 'uptime', label: 'Uptime', width: '110px', default: true },
     { key: 'last_seen', label: 'Last seen', width: 'minmax(150px, 1fr)', default: false },
     { key: 'site', label: 'Site', width: 'minmax(130px, 1fr)', default: false },
   ];
   ```
   (Adapt to `ColumnDef`'s real field names.) Trailing fixed actions column sized for one Delete `.mini-btn`.
2. Load: `listDevices('router')` into `useState<DeviceItem[] | null>`; 403 vs generic error copy; `usePersistentListState('hardware-routers', { sortKey: 'name', sortDir: 'asc', … })`.
3. Toolbar: search + result count, `FilterButton` (single facet: Site, options = distinct `site_name` values of loaded rows, `'—'` bucket for null), `FilterSummaryChip`, `ColumnsButton`, `ExportButton` (CSV columns = all 8 + id, filename `routers`), then the disabled affordance button and the standard placement rules:
   ```tsx
   <button type="button" className="btn-solid" disabled
           title="Routers self-register — the registration endpoint arrives with the device agent.">
     Register router
   </button>
   ```
4. Cells: `mac`/`serial` rendered `.mono`; every non-widget cell's text from `deviceCellText`. Row action: Delete `.mini-btn danger`, gated `can('scanning_hardware','delete')`, `window.confirm` naming the router, then `deleteDevice` + reload with errors caught into the error state (house pattern).
5. `VirtualRows`, `EmptyClearFilters`, `.dir-empty` "No routers registered yet." for the truly-empty state.

Route wiring: in `portal/src/App.tsx` import `Routers` from `./pages/Routers` and point the `/hardware/routers` route at it (still `ProtectedRoute resource="scanning_hardware"`). In `ScanningHardware.tsx` delete the `HardwareRouters` export (keep `Placeholder` and the other three); in `ScanningHardware.test.tsx` remove the `HardwareRouters` page case (the nav-wiring test is unaffected — the route/nav entries don't change).

- [ ] **Step 5: Write the failing page tests**, full bodies, mirroring `portal/src/pages/StatusRules.test.tsx`'s mock style (hoisted `../lib/api` + `../auth/AuthContext` mocks):

```ts
// portal/src/pages/Routers.test.tsx — required cases:
// 1. renders seeded-style rows: two DeviceItems; assert name, WAN/LAN
//    IPs, MAC, serial, and humanized uptime text appear; default sort
//    by name asc (row order).
// 2. Register router button present but disabled.
// 3. Delete gating: with can(...,'delete') false, no Delete buttons;
//    with true, clicking Delete + confirm calls deleteDevice and
//    reloads (mock window.confirm true).
// 4. load-error banner when listDevices rejects.
```

- [ ] **Step 6: Run everything**

Run: `npm --prefix portal test -- --run src/lib/devices.test.ts src/pages/Routers.test.tsx src/pages/ScanningHardware.test.tsx`
Expected: all pass.
Then: `npm --prefix portal test -- --run && npm --prefix portal run build`
Expected: full suite green, build clean.

- [ ] **Step 7: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/devices.ts portal/src/lib/devices.test.ts portal/src/pages/Routers.tsx portal/src/pages/Routers.test.tsx portal/src/pages/ScanningHardware.tsx portal/src/pages/ScanningHardware.test.tsx portal/src/App.tsx
git commit -m "feat(portal): Routers page — device fleet list with delete"
```

---

### Task 4: Verification + dev sample data

**Files:** none (dev-DB inserts only — NOT migration seeds).

- [ ] **Step 1:** `cd api && .venv/bin/alembic upgrade head` (dev DB to 0037), then full API suite FOREGROUND: `api/.venv/bin/pytest api/tests -x -q` (timeout 600000ms). Expected: all pass.
- [ ] **Step 2: Seed two sample routers into the dev DB** (psql against the dev `serversherpa` DB; pick a real site id first):

```sql
WITH s AS (SELECT id FROM sites ORDER BY name LIMIT 1)
INSERT INTO devices (device_type, name, serial, mac, site_id, wan_ip,
                     lan_ip, uptime_seconds, last_seen_at, raw_info)
SELECT * FROM (VALUES
  ('router', 'dock-router-1', 'GL-MT300N-C4A1B2', '94:83:C4:12:A1:B2',
   (SELECT id FROM s), '203.0.113.14', '192.168.8.1', 1036800,
   now() - interval '4 minutes',
   '{"model": "GL-MT300N", "firmware": "4.3.11"}'::jsonb),
  ('router', 'warehouse-router', 'GL-AR750S-77D0E3', '94:83:C4:77:D0:E3',
   (SELECT id FROM s), '198.51.100.201', '192.168.8.1', 273600,
   now() - interval '90 seconds',
   '{"model": "GL-AR750S", "firmware": "4.3.11"}'::jsonb)
) AS v(device_type, name, serial, mac, site_id, wan_ip, lan_ip,
       uptime_seconds, last_seen_at, raw_info);
```

Run via `docker exec serversherpa-dev-postgres-1 psql -U serversherpa -d serversherpa` (heredoc or `-c`). Expected: `INSERT 0 2`.
- [ ] **Step 3: Browser** — open `/hardware/routers`: both routers render with name/WAN/LAN/MAC/serial/humanized uptime; Register router button visibly disabled; delete one router (confirm), verify it vanishes and the audit log at /admin/audit records it, then re-insert it with the SQL above (single-row variant); console clean; screenshot.
- [ ] **Step 4:** `git status` clean (`_dev_reload.py` checked out if churned).

---

## Plan Self-Review (completed at write time)

- **Spec coverage:** data model + vocab + registry → Task 1; API surface incl. audit/404/permissions → Task 2; portal list incl. columns/toolbar/disabled-Register/copy → Task 3; dev-only sample rows + browser pass → Task 4. Deferred registration endpoint: no task touches it; serial/mac partial-uniques keep upsert-by-serial viable.
- **Placeholders:** none — full code for migration/model/routes/lib; page structure anchored to the named in-repo model files with exact columns/copy; test sketches enumerate exact assertions.
- **Type consistency:** `Device`/`DeviceItem` field names identical across Tasks 1–3; `listDevices`/`deleteDevice`/`formatUptime`/`deviceCellText`/`deviceSearchText`/`deviceSortValue` names match between Interfaces blocks, code, and tests; page key `'hardware-routers'` and column keys consistent.
