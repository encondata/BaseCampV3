# Fixed Readers List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Fixed Readers placeholder becomes a real FX9600 list — shared `model` column + reader block on `devices`, scan-pipeline-derived Tags (24h), and a Routers-mold standard directory page.

**Architecture:** Migration 0039 adds four device columns (one shared, three reader-block, `scan_status` FK'd into the asset vocabulary). The list endpoint grows a vocab join and two grouped 24h scan-count subqueries keyed on the documented name = `raw_scans.device_id` convention. The portal page is a sibling of `Routers.tsx` sharing `lib/devices.ts` accessors.

**Spec:** `docs/superpowers/specs/2026-09-01-fixed-readers-design.md` — its column table, renderings, and convention notes are binding.

**Tech Stack:** Alembic/SQLAlchemy async/FastAPI, React. No new dependencies.

## Global Constraints

- Migration **0039** (`down_revision = "0038"`).
- `connection_type` plain TEXT (un-FK'd, `vpn_status` rationale); `scan_status` composite-FK'd → `status_values(record_type='asset')` via GENERATED `scan_status_record_type` (house pattern).
- `tags_read_24h` DERIVED: raw + processed scan counts where `device_id = devices.name` and `scanned_at >= now() - 24h`; grouped subqueries, no per-row queries; 0 never NULL.
- Readers' IP is the existing `lan_ip` column, displayed as "IP". Document in the `Device` docstring: reader `name` = reported `raw_scans.device_id`; `lan_ip` doubles as the reader's address.
- Page key `'hardware-fixed-readers'`; default sort `name` asc; disabled toolbar button labeled `Register reader`, hint exactly "Readers self-register — the registration endpoint arrives with the device agent."
- Antennas rendered `N / 8` (`—` null); connection labels `api`→`API`, `mqtt`→`MQTT`, `local_api`→`Local API`, other values as-is, null `—`; Scan Type = status chip in the vocab color.
- Sample data is dev-DB SQL only, never migration seeds.
- **All suites FOREGROUND, one continuous run, timeout 600000ms. Never background a suite or end a turn with one running.**
- Never commit `api/src/serversherpa/_dev_reload.py`.

## File Structure

| File | Responsibility |
|---|---|
| `api/migrations/versions/0039_fixed_reader_fields.py` | Create: 4 device columns + scan_status FK |
| `api/src/serversherpa/db/models.py` | Modify: Device columns + docstring conventions |
| `api/src/serversherpa/api/schemas.py` | Modify: extend `DeviceItem` |
| `api/src/serversherpa/api/routes/devices.py` | Modify: vocab join + tag-count subqueries |
| `portal/src/lib/api.ts` | Modify: extend `DeviceItem` |
| `portal/src/lib/devices.ts` | Modify: `connectionLabel` + new cellText/sort keys |
| `portal/src/pages/FixedReaders.tsx` | Create: the list page |
| `portal/src/pages/ScanningHardware.tsx` | Modify: drop `FixedReaders` export |
| `portal/src/App.tsx` | Modify: route → new page |
| Tests | extend `api/tests/test_devices_api.py`, `portal/src/lib/devices.test.ts`; new `portal/src/pages/FixedReaders.test.tsx`; update `ScanningHardware.test.tsx` |

---

### Task 1: API — migration 0039, reader fields, derived tag counts

**Files:**
- Create: `api/migrations/versions/0039_fixed_reader_fields.py`
- Modify: `api/src/serversherpa/db/models.py`, `api/src/serversherpa/api/schemas.py`, `api/src/serversherpa/api/routes/devices.py`
- Test: `api/tests/test_devices_api.py` (append)

**Interfaces:**
- Produces (consumed by Task 2): `DeviceItem` gains `model: str | None`, `antennas_connected: int | None`, `connection_type: str | None`, `scan_status: str | None`, `scan_status_label: str | None`, `scan_status_color: str | None`, `tags_read_24h: int`.

- [ ] **Step 1: Write the failing tests** (append to `api/tests/test_devices_api.py`; reuse that file's existing client/login helpers — read tests 4–6 first; `RawScan`/`ProcessedScan` imports needed):

```python
async def test_reader_fields_round_trip_and_fk(db):
    r = Device(device_type="fixed_reader", name="dock-reader-1",
               model="FX9600", antennas_connected=8,
               connection_type="api", scan_status="rfid_1_cage_exit")
    db.add(r)
    await db.commit()
    got = await db.scalar(select(Device).where(Device.id == r.id))
    assert got.scan_status == "rfid_1_cage_exit"
    assert got.antennas_connected == 8
    db.add(Device(device_type="fixed_reader", name="bad",
                  scan_status="not-a-status"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_list_derives_tags_read_24h(db, <admin-client-fixture>):
    now = datetime.now(UTC)
    r = Device(device_type="fixed_reader", name="dock-reader-9",
               scan_status="rfid_1_cage_exit")
    other = Device(device_type="fixed_reader", name="idle-reader")
    db.add_all([r, other])
    await db.flush()
    a = Asset(serial_number="TAGSCAN-1")
    db.add(a)
    await db.flush()
    db.add_all([
        # counted: raw, in-window, matching device_id
        RawScan(scanned_value="T1", scan_type="rfid",
                scanned_at=now - timedelta(hours=1),
                device_id="dock-reader-9"),
        RawScan(scanned_value="T2", scan_type="rfid",
                scanned_at=now - timedelta(hours=23),
                device_id="dock-reader-9"),
        # NOT counted: outside the window
        RawScan(scanned_value="T3", scan_type="rfid",
                scanned_at=now - timedelta(hours=25),
                device_id="dock-reader-9"),
        # NOT counted: different device
        RawScan(scanned_value="T4", scan_type="rfid",
                scanned_at=now - timedelta(hours=1),
                device_id="someone-else"),
        # counted: processed scan, in-window, matching device_id
        ProcessedScan(scanned_value="T5", scan_type="rfid",
                      scanned_at=now - timedelta(hours=2),
                      processed_at=now, device_id="dock-reader-9",
                      match_type="asset", asset_id=a.id),
    ])
    await db.commit()
    resp = await <admin-client>.get("/devices?device_type=fixed_reader")
    by_name = {i["name"]: i for i in resp.json()}
    assert by_name["dock-reader-9"]["tags_read_24h"] == 3   # 2 raw + 1 processed
    assert by_name["idle-reader"]["tags_read_24h"] == 0
    assert by_name["dock-reader-9"]["scan_status_label"] is not None
    assert by_name["dock-reader-9"]["scan_status_color"] is not None
    assert by_name["idle-reader"]["scan_status_label"] is None
```

Replace `<admin-client-fixture>`/`<admin-client>` with the file's real fixture; extend imports (`Asset`, `ProcessedScan`, `RawScan`, `timedelta`).

- [ ] **Step 2: Run to verify failure**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: new tests FAIL (`TypeError: 'model' is an invalid keyword argument` or similar).

- [ ] **Step 3: Migration**

```python
# api/migrations/versions/0039_fixed_reader_fields.py
"""fixed-reader fields on devices. model is SHARED (every family has
one); antennas_connected/connection_type/scan_status are the
fixed-reader block. connection_type is plain TEXT (device-reported
tolerance, like vpn_status); scan_status is OUR config — the asset
checkpoint this reader stamps (V2 devices_rfid_readers role, read by
the future matcher enrichment) — so it IS vocabulary-FK'd. Readers'
IP reuses lan_ip; reader name = reported raw_scans.device_id (the
tags-read derivation key).

Revision ID: 0039
Revises: 0038
Create Date: 2026-09-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0039"
down_revision: str | None = "0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("model", sa.Text))
    op.add_column("devices", sa.Column(
        "antennas_connected", sa.SmallInteger,
        comment="fixed-reader block; FX9600 has 8 ports"))
    op.add_column("devices", sa.Column(
        "connection_type", sa.Text,
        comment="fixed-reader block; api / mqtt / local_api"))
    op.add_column("devices", sa.Column(
        "scan_status", sa.Text,
        comment="asset checkpoint this reader stamps; matcher reads it"))
    op.execute("""
        ALTER TABLE devices ADD COLUMN scan_status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "devices_scan_status_fkey", "devices", "status_values",
        ["scan_status_record_type", "scan_status"], ["record_type", "key"])


def downgrade() -> None:
    op.drop_constraint("devices_scan_status_fkey", "devices",
                       type_="foreignkey")
    op.drop_column("devices", "scan_status_record_type")
    op.drop_column("devices", "scan_status")
    op.drop_column("devices", "connection_type")
    op.drop_column("devices", "antennas_connected")
    op.drop_column("devices", "model")
```

- [ ] **Step 4: Model + schemas.** `Device` gains (model after `name`; the reader block after `lan_ip`):

```python
    model: Mapped[str | None]
```
```python
    antennas_connected: Mapped[int | None] = mapped_column(SmallInteger)
    connection_type: Mapped[str | None]
    scan_status: Mapped[str | None]
    scan_status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED; never written
```

(`SmallInteger` import may need adding.) Extend the `Device` docstring with the two conventions: reader `name` = reported `raw_scans.device_id` (tags-read derivation key; renaming zeroes counts), and `lan_ip` doubles as a fixed reader's address.

`schemas.py` — extend `DeviceItem` (after `lan_ip`):

```python
    model: str | None
    antennas_connected: int | None
    connection_type: str | None
    scan_status: str | None
    scan_status_label: str | None
    scan_status_color: str | None
    tags_read_24h: int
```

- [ ] **Step 5: Routes.** In `routes/devices.py` `list_devices`, add the vocab join and two 24h count subqueries (imports: `RawScan, ProcessedScan, StatusValue` from models; `datetime/UTC/timedelta`):

```python
    cutoff = datetime.now(UTC) - timedelta(hours=24)
    raw_24h = (select(RawScan.device_id, func.count().label("n"))
               .where(RawScan.scanned_at >= cutoff)
               .group_by(RawScan.device_id).subquery())
    proc_24h = (select(ProcessedScan.device_id, func.count().label("n"))
                .where(ProcessedScan.scanned_at >= cutoff)
                .group_by(ProcessedScan.device_id).subquery())
    query = (select(Device, Site.name, up_counts.c.connected,
                    StatusValue.label, StatusValue.color,
                    raw_24h.c.n, proc_24h.c.n)
             .outerjoin(Site, Device.site_id == Site.id)
             .outerjoin(up_counts, up_counts.c.device_id == Device.id)
             .outerjoin(StatusValue,
                        (StatusValue.record_type == "asset")
                        & (StatusValue.key == Device.scan_status))
             .outerjoin(raw_24h, raw_24h.c.device_id == Device.name)
             .outerjoin(proc_24h, proc_24h.c.device_id == Device.name)
             .order_by(Device.registered_at.desc(), Device.id))
```

Row unpacking becomes `for d, site_name, connected, ss_label, ss_color, raw_n, proc_n in rows`, and the payload dict adds:

```python
        "model": d.model,
        "antennas_connected": d.antennas_connected,
        "connection_type": d.connection_type,
        "scan_status": d.scan_status,
        "scan_status_label": ss_label, "scan_status_color": ss_color,
        "tags_read_24h": (raw_n or 0) + (proc_n or 0),
```

- [ ] **Step 6: Run to verify pass**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: 11 PASS (9 existing + 2 new).

- [ ] **Step 7: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/migrations/versions/0039_fixed_reader_fields.py api/src/serversherpa/db/models.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/devices.py api/tests/test_devices_api.py
git commit -m "feat(api): fixed-reader device fields + derived 24h tag counts (migration 0039)"
```

---

### Task 2: Portal — Fixed Readers page

**Files:**
- Modify: `portal/src/lib/api.ts`, `portal/src/lib/devices.ts`, `portal/src/lib/devices.test.ts`, `portal/src/pages/ScanningHardware.tsx`, `portal/src/pages/ScanningHardware.test.tsx`, `portal/src/App.tsx`
- Create: `portal/src/pages/FixedReaders.tsx`, `portal/src/pages/FixedReaders.test.tsx`

**Interfaces:**
- Consumes: Task 1's wire shape.
- Produces in `api.ts` (`DeviceItem` additions, exact): `model: string | null; antennas_connected: number | null; connection_type: string | null; scan_status: string | null; scan_status_label: string | null; scan_status_color: string | null; tags_read_24h: number;`
- Produces in `devices.ts`: `connectionLabel(type: string | null): string`; `deviceCellText`/`deviceSortValue` handling keys `model`, `ip` (→ `lan_ip`), `tags_24h`, `antennas`, `connection`, `scan_status` (→ label).

- [ ] **Step 1: Failing lib tests** (append to `portal/src/lib/devices.test.ts`; extend the `R` fixture with the seven new DeviceItem fields so existing tests compile — nulls + `tags_read_24h: 0`):

```ts
import { connectionLabel } from './devices';

describe('connectionLabel', () => {
  it('maps known, passes through unknown', () => {
    expect(connectionLabel('api')).toBe('API');
    expect(connectionLabel('mqtt')).toBe('MQTT');
    expect(connectionLabel('local_api')).toBe('Local API');
    expect(connectionLabel('serial-console')).toBe('serial-console');
    expect(connectionLabel(null)).toBe('—');
  });
});

describe('reader cell accessors', () => {
  const fr = { ...R, model: 'FX9600', antennas_connected: 4,
               connection_type: 'mqtt', scan_status: 'rfid_1_cage_exit',
               scan_status_label: 'RFID 1 - Cage Exit',
               scan_status_color: '#31F527', tags_read_24h: 152 };
  it('cellText for the reader keys', () => {
    expect(deviceCellText(fr, 'model')).toBe('FX9600');
    expect(deviceCellText(fr, 'ip')).toBe('192.168.8.1');
    expect(deviceCellText(fr, 'tags_24h')).toBe('152');
    expect(deviceCellText(fr, 'antennas')).toBe('4 / 8');
    expect(deviceCellText(fr, 'connection')).toBe('MQTT');
    expect(deviceCellText(fr, 'scan_status')).toBe('RFID 1 - Cage Exit');
    expect(deviceCellText({ ...fr, antennas_connected: null }, 'antennas')).toBe('—');
    expect(deviceCellText({ ...fr, scan_status: null, scan_status_label: null },
                          'scan_status')).toBe('—');
  });
  it('sortValue numeric for tags/antennas', () => {
    expect(deviceSortValue(fr, 'tags_24h')).toBe(152);
    expect(deviceSortValue(fr, 'antennas')).toBe(4);
    expect(deviceSortValue({ ...fr, antennas_connected: null }, 'antennas')).toBe(-1);
  });
});
```

- [ ] **Step 2: Run to fail, then implement.** `devices.ts`:

```ts
export function connectionLabel(type: string | null): string {
  if (type == null) return '—';
  if (type === 'api') return 'API';
  if (type === 'mqtt') return 'MQTT';
  if (type === 'local_api') return 'Local API';
  return type;
}
```

`deviceCellText` new cases: `'model'` → `d.model ?? '—'`; `'ip'` → `d.lan_ip ?? '—'`; `'tags_24h'` → `String(d.tags_read_24h)`; `'antennas'` → `d.antennas_connected == null ? '—' : `${d.antennas_connected} / 8``; `'connection'` → `connectionLabel(d.connection_type)`; `'scan_status'` → `d.scan_status_label ?? (d.scan_status ?? '—')`. `deviceSortValue`: `'tags_24h'` → `d.tags_read_24h`; `'antennas'` → `d.antennas_connected ?? -1`. `deviceSearchText` additionally includes `d.model` and the scan-status label. `api.ts`: extend `DeviceItem` per Interfaces. Lib tests to green.

- [ ] **Step 3: Build the page.** `portal/src/pages/FixedReaders.tsx` — copy `portal/src/pages/Routers.tsx` wholesale (read it first) and adapt; do NOT invent structure. Differences only:

1. Head: title `Fixed Readers`, hint `Zebra FX9600 fixed RFID readers.`, eyebrow unchanged.
2. `listDevices('fixed_reader')`; page key `'hardware-fixed-readers'`.
3. Columns:
   ```ts
   const COLUMNS: ColumnDef[] = [
     { key: 'name', label: 'Name', width: 'minmax(160px, 1.3fr)', default: true },
     { key: 'model', label: 'Model', width: '100px', default: true },
     { key: 'mac', label: 'MAC', width: 'minmax(150px, 1fr)', default: true },
     { key: 'ip', label: 'IP', width: 'minmax(120px, 1fr)', default: true },
     { key: 'uptime', label: 'Uptime', width: '100px', default: true },
     { key: 'tags_24h', label: 'Tags (24h)', width: '100px', default: true },
     { key: 'antennas', label: 'Antennas', width: '95px', default: true },
     { key: 'connection', label: 'Connection', width: '110px', default: true },
     { key: 'scan_status', label: 'Scan Type', width: 'minmax(150px, 1fr)', default: true },
     { key: 'site', label: 'Site', width: 'minmax(120px, 1fr)', default: true },
     { key: 'last_seen', label: 'Last seen', width: 'minmax(150px, 1fr)', default: false },
   ];
   ```
4. `cellFor`: `mac` `.mono`; `connection` → `<span className="chip tag">{connectionLabel(...)}</span>` (bare `—` when null); `scan_status` → status chip with the vocab color exactly the way RulesTab's trigger chip does it (`style={{ '--chip': d.scan_status_color }}`-style — copy that chip rendering; read `portal/src/components/statusRules/RulesTab.tsx` for the exact mechanism), `—` when null; rest plain `deviceCellText`.
5. Facets: `site` (as Routers), `connection` (distinct `connectionLabel` values incl. `—`), `scan_status` (distinct labels incl. `—`).
6. CSV: all 11 columns + id, filename `fixed-readers`.
7. Toolbar button: `Register reader`, disabled, title "Readers self-register — the registration endpoint arrives with the device agent."
8. No expansion, no chevron — trailing actions column is Delete only (as the pre-expansion Routers layout: single `90px` trailing track and one action cell; row-main has no onClick).
9. Empty state: "No fixed readers registered yet."

Route wiring: `App.tsx` imports `FixedReaders` from `./pages/FixedReaders`, `/hardware/fixed-readers` route renders it (ProtectedRoute unchanged). `ScanningHardware.tsx` drops its `FixedReaders` export; `ScanningHardware.test.tsx` drops that page case (nav-wiring test untouched).

- [ ] **Step 4: Failing page tests** (`portal/src/pages/FixedReaders.test.tsx`, mirroring `Routers.test.tsx`'s mocks — full bodies):

```ts
// 1. renders two readers sorted by name: model, MAC, IP (from lan_ip),
//    uptime, tags count, '4 / 8' antennas, 'MQTT' tag, scan-status chip
//    label text, site name all present.
// 2. Register reader button present and disabled.
// 3. Delete gating both ways + confirm→deleteDevice→reload (copy the
//    Routers tests' shape).
// 4. load-error banner when listDevices rejects.
```

- [ ] **Step 5: Run everything**

Run: `npm --prefix portal test -- --run src/lib/devices.test.ts src/pages/FixedReaders.test.tsx src/pages/Routers.test.tsx src/pages/ScanningHardware.test.tsx`
Expected: all pass (Routers must stay green with the widened fixtures).
Then: `npm --prefix portal test -- --run && npm --prefix portal run build`
Expected: full suite green, build clean.

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/devices.ts portal/src/lib/devices.test.ts portal/src/pages/FixedReaders.tsx portal/src/pages/FixedReaders.test.tsx portal/src/pages/ScanningHardware.tsx portal/src/pages/ScanningHardware.test.tsx portal/src/App.tsx
git commit -m "feat(portal): Fixed Readers page — FX9600 list with derived tag counts"
```

---

### Task 3: Verification + dev sample data

**Files:** none (dev-DB SQL only).

- [ ] **Step 1:** `cd api && .venv/bin/alembic upgrade head`, then full API suite FOREGROUND (`api/.venv/bin/pytest api/tests -x -q`, timeout 600000ms). Expected: all pass.
- [ ] **Step 2: Seed readers + fresh scans** (`docker exec -i serversherpa-dev-postgres-1 psql -U serversherpa -d serversherpa`):

```sql
WITH s AS (SELECT id FROM sites ORDER BY name LIMIT 1)
INSERT INTO devices (device_type, name, model, serial, mac, site_id,
                     lan_ip, uptime_seconds, last_seen_at,
                     antennas_connected, connection_type, scan_status, raw_info)
SELECT * FROM (VALUES
  ('fixed_reader','dock-reader-1','FX9600','FX9600-D1A44F','84:24:8D:D1:A4:4F',
   (SELECT id FROM s),'192.168.8.31', 2419200::bigint, now() - interval '40 seconds',
   8::smallint,'api','rfid_1_cage_exit','{"firmware":"3.10.30"}'::jsonb),
  ('fixed_reader','dock-reader-2','FX9600','FX9600-D2B510','84:24:8D:D2:B5:10',
   (SELECT id FROM s),'192.168.8.32', 864000::bigint, now() - interval '65 seconds',
   4::smallint,'mqtt','rfid_10_dock_to_truck','{"firmware":"3.10.30"}'::jsonb),
  ('fixed_reader','warehouse-reader-1','FX9600','FX9600-WH77C2','84:24:8D:WH:77:C2',
   (SELECT id FROM s),'192.168.8.33', 432000::bigint, now() - interval '3 minutes',
   2::smallint,'local_api','rfid_4_into_cage','{"firmware":"3.10.28"}'::jsonb)
) AS v(device_type,name,model,serial,mac,site_id,lan_ip,uptime_seconds,
       last_seen_at,antennas_connected,connection_type,scan_status,raw_info);

-- Fresh raw scans inside the 24h window so Tags (24h) is non-zero.
-- (Whether the matcher later moves some to processed_scans is fine —
-- the derivation sums both tables.)
INSERT INTO raw_scans (scanned_value, scan_type, status, scanned_at, device_id, source)
SELECT 'E28011' || lpad(to_hex(g), 8, '0'),
       'rfid',
       CASE WHEN g % 2 = 0 THEN 'rfid_1_cage_exit' ELSE 'rfid_10_dock_to_truck' END,
       now() - (random() * interval '23 hours'),
       CASE WHEN g % 2 = 0 THEN 'dock-reader-1' ELSE 'dock-reader-2' END,
       'seed'
FROM generate_series(1, 300) AS g;
SELECT device_id, count(*) FROM raw_scans
  WHERE scanned_at >= now() - interval '24 hours' GROUP BY device_id;
SQL
```

Note the MAC `84:24:8D:WH:77:C2` contains non-hex chars — fix to `84:24:8D:AA:77:C2` when running. Expected: 3 devices inserted, 300 scans, counts ≈150 per dock reader.
- [ ] **Step 3: Browser (screenshot gate):** `/hardware/fixed-readers` — three readers with model/MAC/IP/uptime; Tags (24h) non-zero on the dock readers, 0 on warehouse; `8 / 8`, `4 / 8`, `2 / 8`; API/MQTT/Local API tags; Scan Type chips in vocab colors; Site column; Register reader disabled; delete round-trip on one row then re-insert; console clean (ignore the known stale HMR buffer entries); screenshot. NOTE: if columns are missing, this is a NEW page key — prefs can't hide them; investigate for real rather than assuming the prefs gotcha.
- [ ] **Step 4:** `git status` clean; `_dev_reload.py` checked out if churned.

---

## Plan Self-Review (completed at write time)

- **Spec coverage:** migration/columns/FK → Task 1; derivation incl. 0-never-NULL + both tables + window/name filters → Task 1 (test pins all four cases); vocab label/color → Task 1; portal columns/renderings/facets/CSV/copy → Task 2; convention docs in Device docstring → Task 1 Step 4; sample data incl. fresh scans → Task 3; screenshot gate → Task 3. No expansion (spec: out of scope).
- **Placeholders:** the `<admin-client-fixture>` markers instruct substitution with the file's real fixture (named instruction, not TBD); scan-status chip rendering points at the exact in-repo mechanism to copy. Seed SQL carries an explicit fix-note for the invalid MAC.
- **Type consistency:** `DeviceItem` field names identical across schemas.py/api.ts/tests; cell keys `model/ip/tags_24h/antennas/connection/scan_status/site` consistent between COLUMNS, accessors, facets, CSV, tests; `connectionLabel` name consistent.
