# Router VPN Columns + DHCP Lease Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Routers list gains VPN status, derived connected-device count, and token-expiration columns, plus expandable rows showing active/reserved DHCP leases with up indicators.

**Architecture:** Migration 0038 adds two device columns and the `device_dhcp_leases` table; the list endpoint grows a grouped-count subquery and a new leases endpoint serves the expansion (fetch-per-open). The portal adds three columns to the existing standard list and a Containers.tsx-style row expansion hosting a view-switched lease table.

**Spec:** `docs/superpowers/specs/2026-08-31-router-vpn-leases-design.md` — column renderings, expansion layout, and chip thresholds there are binding. **The expansion must satisfy the house detail-surface rules: real aligned table, explicit view-switcher buttons, `—` per empty cell, never joined-string dumps.**

**Tech Stack:** Alembic/SQLAlchemy async/FastAPI, React. No new dependencies.

## Global Constraints

- Migration **0038** (`down_revision = "0037"`).
- `vpn_status` is plain TEXT (NOT vocabulary-FK'd — the future heartbeat must never be rejected); `connected_count` is DERIVED (COUNT of leases with `up`), never stored.
- `device_dhcp_leases` UNIQUE `(device_id, mac)`; `device_id` FK ON DELETE CASCADE.
- Leases endpoint ordering exactly `up DESC, hostname NULLS LAST, mac`.
- Token chip thresholds: past → red "expired"; within 7 days → amber; else plain locale date; null → `—`.
- Expansion: chevron toggles, ONE open at a time, model `portal/src/pages/Containers.tsx` (`openId`, `.dir-row.open`, `.chevron-cell`, `.detail > .detail-clip > .detail-inner`); view-switcher buttons `Active (N)` / `Reserved (M)`; leases fetched on each open.
- **The Delete button (and any other in-row button) must `stopPropagation`** — the row-main click now toggles expansion (ledger lesson: a prior expansion task shipped exactly this regression).
- **All suites FOREGROUND, one continuous run, timeout 600000ms. Never background a suite.** Sample data is dev-DB SQL only, never migration seeds.
- Never commit `api/src/serversherpa/_dev_reload.py`.

## File Structure

| File | Responsibility |
|---|---|
| `api/migrations/versions/0038_device_leases.py` | Create: device columns + leases table |
| `api/src/serversherpa/db/models.py` | Modify: +`Device.vpn_status/token_expires_at`, +`DeviceDhcpLease` |
| `api/src/serversherpa/api/schemas.py` | Modify: extend `DeviceItem`, +`DeviceLeaseItem` |
| `api/src/serversherpa/api/routes/devices.py` | Modify: derived count in list, +leases endpoint |
| `portal/src/lib/api.ts` | Modify: extend `DeviceItem`, +`DeviceLease` + `listDeviceLeases` |
| `portal/src/lib/devices.ts` | Modify: +vpn/token helpers, extend accessors |
| `portal/src/components/hardware/RouterLeases.tsx` | Create: expansion panel (switcher + table) |
| `portal/src/styles/hardware.css` | Create: lease-table styling (scoped) |
| `portal/src/pages/Routers.tsx` | Modify: 3 columns + expansion wiring |
| Tests | extend `api/tests/test_devices_api.py`, `portal/src/lib/devices.test.ts`, `portal/src/pages/Routers.test.tsx`; new `portal/src/components/hardware/RouterLeases.test.tsx` |

---

### Task 1: API — migration 0038, lease model, derived count, leases endpoint

**Files:**
- Create: `api/migrations/versions/0038_device_leases.py`
- Modify: `api/src/serversherpa/db/models.py`, `api/src/serversherpa/api/schemas.py`, `api/src/serversherpa/api/routes/devices.py`
- Test: `api/tests/test_devices_api.py` (append)

**Interfaces:**
- Produces (consumed by Task 2): `DeviceItem` gains `vpn_status: str | None`, `token_expires_at: datetime | None`, `connected_count: int`; new endpoint `GET /devices/{device_id}/leases` → `[DeviceLeaseItem]` = `{id, mac, ip, hostname, reserved, up, last_seen_at}`; ORM `DeviceDhcpLease(device_id, mac, ip, hostname, reserved, up, last_seen_at)`.

- [ ] **Step 1: Write the failing tests** (append to `api/tests/test_devices_api.py`; reuse its existing fixtures/imports — add `DeviceDhcpLease` to the models import):

```python
async def test_lease_round_trip_unique_and_cascade(db):
    d = Device(device_type="router", name="r1")
    db.add(d)
    await db.flush()
    db.add(DeviceDhcpLease(device_id=d.id, mac="AA:BB:CC:00:00:01",
                           ip="192.168.8.100", hostname="handheld-01",
                           reserved=False, up=True))
    await db.commit()
    db.add(DeviceDhcpLease(device_id=d.id, mac="aa:bb:cc:00:00:01"))
    with pytest.raises(IntegrityError):          # CITEXT: case-insensitive dupe
        await db.commit()
    await db.rollback()
    await db.delete(await db.get(Device, d.id))
    await db.commit()
    assert (await db.scalars(select(DeviceDhcpLease))).all() == []


async def test_list_derives_connected_count(db, client_admin):
    d = Device(device_type="router", name="counted",
               vpn_status="connected")
    empty = Device(device_type="router", name="empty")
    db.add_all([d, empty])
    await db.flush()
    db.add_all([
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:01", up=True),
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:02", up=True,
                        reserved=True),
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:03", up=False),
    ])
    await db.commit()
    resp = await client_admin.get("/devices?device_type=router")
    assert resp.status_code == 200
    by_name = {i["name"]: i for i in resp.json()}
    assert by_name["counted"]["connected_count"] == 2   # up only, reserved counts
    assert by_name["counted"]["vpn_status"] == "connected"
    assert by_name["empty"]["connected_count"] == 0
    assert by_name["empty"]["token_expires_at"] is None


async def test_leases_endpoint_ordering_404_403(db, client_admin, client_external):
    d = Device(device_type="router", name="r2")
    db.add(d)
    await db.flush()
    db.add_all([
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:10",
                        hostname="zeta", up=False),
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:11",
                        hostname=None, up=True),
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:12",
                        hostname="alpha", up=True),
    ])
    await db.commit()
    resp = await client_admin.get(f"/devices/{d.id}/leases")
    assert resp.status_code == 200
    rows = resp.json()
    # up DESC, hostname NULLS LAST, mac
    assert [(r["up"], r["hostname"]) for r in rows] == [
        (True, "alpha"), (True, None), (False, "zeta")]
    missing = await client_admin.get(
        "/devices/00000000-0000-0000-0000-000000000000/leases")
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "device_not_found"
    assert (await client_external.get(f"/devices/{d.id}/leases")).status_code == 403
```

Adapt fixture names (`client_admin`/`client_external`) to whatever the file actually uses for its admin and external-role clients — read the existing tests 4–6 first and reuse their helpers exactly.

- [ ] **Step 2: Run to verify failure**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: new tests FAIL (`ImportError: DeviceDhcpLease`).

- [ ] **Step 3: Migration**

```python
# api/migrations/versions/0038_device_leases.py
"""device_dhcp_leases + router VPN/token columns. vpn_status is plain
TEXT on purpose — the (deferred) heartbeat reports it and must never
be rejected for an unexpected value; the portal maps known values to
chips. connected counts are DERIVED from lease rows at read time,
never stored, so the list can't disagree with the expansion.
(device_id, mac) is the future heartbeat's lease-sync key.

Revision ID: 0038
Revises: 0037
Create Date: 2026-08-31
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0038"
down_revision: str | None = "0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column(
        "vpn_status", sa.Text,
        comment="reported string; not vocabulary-FK'd by design"))
    op.add_column("devices", sa.Column(
        "token_expires_at", sa.TIMESTAMP(timezone=True),
        comment="router agent API-token expiry"))
    op.create_table(
        "device_dhcp_leases",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("device_id", UUID(as_uuid=True),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("mac", CITEXT, nullable=False),
        sa.Column("ip", sa.Text),
        sa.Column("hostname", sa.Text),
        sa.Column("reserved", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("up", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("last_seen_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("device_id", "mac",
                            name="device_dhcp_leases_device_mac_uniq"),
    )
    op.create_index("device_dhcp_leases_device_idx", "device_dhcp_leases",
                    ["device_id"])


def downgrade() -> None:
    op.drop_table("device_dhcp_leases")
    op.drop_column("devices", "token_expires_at")
    op.drop_column("devices", "vpn_status")
```

- [ ] **Step 4: Model + schemas.** In `models.py`, add to `Device` (after `lan_ip`): `vpn_status: Mapped[str | None]` and (after `last_seen_at`) `token_expires_at: Mapped[datetime | None]`. After `Device`:

```python
class DeviceDhcpLease(Base):
    """One DHCP lease/reservation on a device, synced by the (future)
    heartbeat via UNIQUE (device_id, mac). reserved and up are
    orthogonal — a static reservation can be online."""

    __tablename__ = "device_dhcp_leases"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    device_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"))
    mac: Mapped[str] = mapped_column(CITEXT)
    ip: Mapped[str | None]
    hostname: Mapped[str | None]
    reserved: Mapped[bool] = mapped_column(server_default=text("false"))
    up: Mapped[bool] = mapped_column(server_default=text("false"))
    last_seen_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

In `schemas.py`: extend `DeviceItem` with `vpn_status: str | None`, `token_expires_at: datetime | None`, `connected_count: int` (after `lan_ip`); add:

```python
class DeviceLeaseItem(BaseModel):
    id: uuid.UUID
    mac: str
    ip: str | None
    hostname: str | None
    reserved: bool
    up: bool
    last_seen_at: datetime | None
```

- [ ] **Step 5: Routes.** In `routes/devices.py`, replace `list_devices`'s query with a grouped-count join and add the leases endpoint:

```python
@router.get("", response_model=list[DeviceItem])
async def list_devices(
    db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "view"),
    device_type: str | None = None,
) -> list[dict]:
    up_counts = (select(DeviceDhcpLease.device_id,
                        func.count().label("connected"))
                 .where(DeviceDhcpLease.up.is_(True))
                 .group_by(DeviceDhcpLease.device_id).subquery())
    query = (select(Device, Site.name, up_counts.c.connected)
             .outerjoin(Site, Device.site_id == Site.id)
             .outerjoin(up_counts, up_counts.c.device_id == Device.id)
             .order_by(Device.registered_at.desc(), Device.id))
    if device_type is not None:
        query = query.where(Device.device_type == device_type)
    rows = (await db.execute(query)).all()
    return [{
        "id": d.id, "device_type": d.device_type, "name": d.name,
        "serial": d.serial, "mac": d.mac,
        "site_id": d.site_id, "site_name": site_name,
        "wan_ip": d.wan_ip, "lan_ip": d.lan_ip,
        "vpn_status": d.vpn_status,
        "token_expires_at": d.token_expires_at,
        "connected_count": connected or 0,
        "uptime_seconds": d.uptime_seconds,
        "last_seen_at": d.last_seen_at, "raw_info": d.raw_info,
        "registered_at": d.registered_at,
    } for d, site_name, connected in rows]


@router.get("/{device_id}/leases", response_model=list[DeviceLeaseItem])
async def list_device_leases(
    device_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "view"),
) -> list[DeviceLeaseItem]:
    if await db.get(Device, device_id) is None:
        raise _err(404, "device_not_found")
    return (await db.scalars(
        select(DeviceDhcpLease)
        .where(DeviceDhcpLease.device_id == device_id)
        .order_by(DeviceDhcpLease.up.desc(),
                  DeviceDhcpLease.hostname.nulls_last(),
                  DeviceDhcpLease.mac))).all()
```

Extend imports: `func` (sqlalchemy), `DeviceDhcpLease` (models), `DeviceLeaseItem` (schemas). Route ordering: `/{device_id}/leases` is distinct from `/{device_id}` DELETE — no shadowing concern.

- [ ] **Step 6: Run to verify pass**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: 9 PASS (6 existing + 3 new).

- [ ] **Step 7: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/migrations/versions/0038_device_leases.py api/src/serversherpa/db/models.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/devices.py api/tests/test_devices_api.py
git commit -m "feat(api): device VPN/token columns + DHCP lease table, derived connected count"
```

---

### Task 2: Portal — columns, accessors, lease expansion

**Files:**
- Modify: `portal/src/lib/api.ts`, `portal/src/lib/devices.ts`, `portal/src/lib/devices.test.ts`, `portal/src/pages/Routers.tsx`, `portal/src/pages/Routers.test.tsx`
- Create: `portal/src/components/hardware/RouterLeases.tsx`, `portal/src/components/hardware/RouterLeases.test.tsx`, `portal/src/styles/hardware.css`

**Interfaces:**
- Consumes: Task 1's wire shapes.
- Produces in `api.ts`: `DeviceItem` gains `vpn_status: string | null; token_expires_at: string | null; connected_count: number;`; new

```ts
export interface DeviceLease {
  id: string; mac: string; ip: string | null; hostname: string | null;
  reserved: boolean; up: boolean; last_seen_at: string | null;
}
export async function listDeviceLeases(deviceId: string): Promise<DeviceLease[]>
```

- Produces in `devices.ts`: `vpnLabel(status: string | null): string` (`connected`→`Connected`, `disconnected`→`Disconnected`, other non-null→as-is, null→`—`), `tokenExpiryState(iso: string | null, now?: Date): 'none' | 'expired' | 'soon' | 'ok'` (soon = within 7 days), and `deviceCellText`/`deviceSortValue` handling new keys `vpn`, `connected`, `token_expires`.
- Produces: `<RouterLeases deviceId={string} />` — self-fetching expansion panel.

- [ ] **Step 1: Write the failing lib tests** (append to `portal/src/lib/devices.test.ts`):

```ts
import { tokenExpiryState, vpnLabel } from './devices';

describe('vpnLabel', () => {
  it('maps known values, passes through others', () => {
    expect(vpnLabel('connected')).toBe('Connected');
    expect(vpnLabel('disconnected')).toBe('Disconnected');
    expect(vpnLabel('wg-handshake-stale')).toBe('wg-handshake-stale');
    expect(vpnLabel(null)).toBe('—');
  });
});

describe('tokenExpiryState', () => {
  const now = new Date('2026-08-31T12:00:00Z');
  it('classifies', () => {
    expect(tokenExpiryState(null, now)).toBe('none');
    expect(tokenExpiryState('2026-08-30T00:00:00Z', now)).toBe('expired');
    expect(tokenExpiryState('2026-09-03T00:00:00Z', now)).toBe('soon');
    expect(tokenExpiryState('2026-11-29T00:00:00Z', now)).toBe('ok');
  });
});

describe('new cell accessors', () => {
  const r2 = { ...R, vpn_status: 'connected', connected_count: 4,
               token_expires_at: '2026-11-29T00:00:00Z' };
  it('cellText for vpn/connected/token_expires', () => {
    expect(deviceCellText(r2, 'vpn')).toBe('Connected');
    expect(deviceCellText(r2, 'connected')).toBe('4');
    expect(deviceCellText(r2, 'token_expires'))
      .toBe(new Date('2026-11-29T00:00:00Z').toLocaleDateString());
    expect(deviceCellText({ ...r2, token_expires_at: null }, 'token_expires')).toBe('—');
  });
  it('sortValue numeric for connected, iso for token', () => {
    expect(deviceSortValue(r2, 'connected')).toBe(4);
    expect(deviceSortValue(r2, 'token_expires')).toBe('2026-11-29T00:00:00Z');
    expect(deviceSortValue({ ...r2, token_expires_at: null }, 'token_expires')).toBe('');
  });
});
```

Extend the file's `R` fixture with the three new DeviceItem fields (`vpn_status: null, token_expires_at: null, connected_count: 0`) so existing tests still compile.

- [ ] **Step 2: Run to verify failure**, then implement the `devices.ts` additions:

```ts
export function vpnLabel(status: string | null): string {
  if (status == null) return '—';
  if (status === 'connected') return 'Connected';
  if (status === 'disconnected') return 'Disconnected';
  return status;
}

const SOON_MS = 7 * 24 * 3600 * 1000;

export function tokenExpiryState(
  iso: string | null | undefined, now: Date = new Date(),
): 'none' | 'expired' | 'soon' | 'ok' {
  if (!iso) return 'none';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'none';
  if (t <= now.getTime()) return 'expired';
  return t - now.getTime() <= SOON_MS ? 'soon' : 'ok';
}
```

`deviceCellText` gains cases: `'vpn'` → `vpnLabel(d.vpn_status)`; `'connected'` → `String(d.connected_count)`; `'token_expires'` → `d.token_expires_at ? new Date(d.token_expires_at).toLocaleDateString() : '—'`. `deviceSortValue`: `'connected'` → `d.connected_count`; `'token_expires'` → `d.token_expires_at ?? ''`. `deviceSearchText` additionally includes `vpnLabel(d.vpn_status)`.
`api.ts`: extend `DeviceItem`, add `DeviceLease` + `listDeviceLeases` (GET `/devices/${deviceId}/leases`, same fetch pattern as `listDevices`).
Run the lib tests to green.

- [ ] **Step 3: Build `RouterLeases.tsx`.** Read `portal/src/pages/Containers.tsx:340-395` + its `ContainerRowDetail` component and the `.detail/.detail-clip/.detail-inner` styles first. Component contract and structure:

```tsx
// portal/src/components/hardware/RouterLeases.tsx
/** Expansion panel for a router row: DHCP leases in a view-switched
 *  real table (Active / Reserved), fetched fresh on each open. House
 *  detail-surface rules: aligned columns, '—' per empty cell, explicit
 *  switcher buttons — never a joined-string dump. */
```

- State: `leases: DeviceLease[] | null`, `error: string`, `view: 'active' | 'reserved'`.
- `useEffect` on mount: `listDeviceLeases(deviceId)` → state; catch → `error` ("Couldn't load leases." + a `.mini-btn` Retry that re-runs the fetch).
- Switcher: `.lease-tabs` bar with two `.lease-tab` buttons (`aria-pressed`), labels `Active (${active.length})` / `Reserved (${reserved.length})` where `active = leases.filter(l => !l.reserved)`, `reserved = leases.filter(l => l.reserved)` — counts rendered even while the other view is selected.
- Table (`.lease-table`): header row Up · Hostname · IP · MAC · Last seen; body rows for the selected view: Up cell = `<span className={l.up ? 'lease-dot up' : 'lease-dot'} />` plus visually-hidden text `Up`/`Down` (or a `title`); Hostname/IP → value or `—`; MAC `.mono`; Last seen → locale date-time or `—`.
- Empty view: `.set-note` "No active leases." / "No reservations.". Loading: `.set-note` "Loading leases…".

`portal/src/styles/hardware.css` (header comment per house convention — states it does not duplicate directory.css):

```css
/* Scanning-hardware detail surfaces only (lease expansion). Builds on
 * directory.css's .detail plumbing — nothing here duplicates it. */

.lease-tabs { display: flex; gap: 8px; margin: 2px 0 10px; }
.lease-tab { /* mirror .sysconf-tab's look at small scale */ }
.lease-tab[aria-pressed='true'] { /* active state */ }
.lease-table { width: 100%; border-collapse: collapse; }
.lease-table th, .lease-table td { text-align: left; padding: 6px 12px 6px 0; }
.lease-table th { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .65; }
.lease-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--line, #9aa4af); }
.lease-dot.up { background: var(--ok, #178a4c); }
```

Fill the `.lease-tab` rules by copying the real `.sysconf-tab` declarations from `styles/system.css` scaled down (read it); use existing CSS variables where the tokens exist (check `directory.css:10-32` for the status color tokens — reuse `--ok`-equivalent token names actually defined there rather than inventing new ones).

- [ ] **Step 4: Write the failing RouterLeases tests** (`portal/src/components/hardware/RouterLeases.test.tsx`, jsdom, mock `../../lib/api`): full bodies for —

```ts
// 1. fetches on mount and renders the Active view by default: 2 active
//    (one up, one down) + 1 reserved lease mocked; table shows the 2
//    active rows, up dot class differs, '—' for null hostname; switcher
//    labels 'Active (2)' and 'Reserved (1)'.
// 2. clicking Reserved swaps to the reserved row set.
// 3. fetch rejection renders the error note and Retry re-calls
//    listDeviceLeases.
```

Run to fail, implement per Step 3, run to green.

- [ ] **Step 5: Wire the page.** In `portal/src/pages/Routers.tsx`:

1. `COLUMNS` gains, after `serial`: `{ key: 'vpn', label: 'VPN', width: '110px', default: true }`, `{ key: 'connected', label: 'Devices', width: '90px', default: true }`, `{ key: 'token_expires', label: 'Token expires', width: 'minmax(120px, 1fr)', default: true }`.
2. `cellFor` renders: `vpn` → chip `<span className={'chip' + (d.vpn_status === 'connected' ? ' c-green' : d.vpn_status === 'disconnected' ? ' c-red' : '')}>{vpnLabel(d.vpn_status)}</span>` (bare `—` un-chipped when null); `token_expires` → by `tokenExpiryState`: `expired` → `<span className="chip c-red">expired</span>`, `soon` → `<span className="chip c-amber">{text}</span>`, else plain `deviceCellText` (`—` for none); `connected` → plain text.
3. Facets: add a VPN group (`key: 'vpn'`, options = distinct `vpnLabel` values of loaded rows incl. `—`), `facetValues` returns `[vpnLabel(d.vpn_status)]`.
4. CSV: three new columns (VPN / Devices / Token expires) via `deviceCellText`.
5. Expansion: `openId` state (`string | null`); `.row-main` `onClick` toggles (`setOpenId(open ? null : d.id)`); chevron cell (copy Containers.tsx's `.chevron-cell` svg) appended after the Delete cell; row class gains `open`; below `.row-main`, the `.detail > .detail-clip > .detail-inner` block rendering `{open && <RouterLeases deviceId={d.id} />}`. Grid template's trailing width grows to fit Delete + chevron (e.g. `120px`). **Delete button onClick gains `e.stopPropagation()`.** Import `../styles/hardware.css`.
6. `key` prop and `vp` spread stay exactly as Containers.tsx does it (VirtualRows measureElement contract).

- [ ] **Step 6: Update page tests** (`portal/src/pages/Routers.test.tsx`): existing cases updated for the new columns (fixtures gain the three fields); add full bodies —

```ts
// 5. VPN chip + token chips render: one router vpn 'connected' (chip
//    text Connected), one 'disconnected'; one token expired (chip
//    'expired'), one in 3 days (amber chip present — assert by class),
//    one healthy (plain date text).
// 6. clicking a row toggles the expansion and renders RouterLeases
//    (mock listDeviceLeases to resolve []); clicking Delete does NOT
//    open the expansion (stopPropagation pinned: confirm mocked false,
//    expansion stays closed).
```

- [ ] **Step 7: Run everything**

Run: `npm --prefix portal test -- --run src/lib/devices.test.ts src/components/hardware/RouterLeases.test.tsx src/pages/Routers.test.tsx`
Expected: all pass.
Then: `npm --prefix portal test -- --run && npm --prefix portal run build`
Expected: full suite green, build clean.

- [ ] **Step 8: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/devices.ts portal/src/lib/devices.test.ts portal/src/components/hardware portal/src/styles/hardware.css portal/src/pages/Routers.tsx portal/src/pages/Routers.test.tsx
git commit -m "feat(portal): router VPN/devices/token columns + DHCP lease expansion"
```

---

### Task 3: Verification + dev sample data

**Files:** none (dev-DB SQL only).

- [ ] **Step 1:** `cd api && .venv/bin/alembic upgrade head`, then full API suite FOREGROUND (`api/.venv/bin/pytest api/tests -x -q`, timeout 600000ms). Expected: all pass.
- [ ] **Step 2: Seed** (via `docker exec -i serversherpa-dev-postgres-1 psql -U serversherpa -d serversherpa`):

```sql
UPDATE devices SET vpn_status='connected',
  token_expires_at = now() + interval '90 days'
  WHERE name='dock-router-1';
UPDATE devices SET vpn_status='disconnected',
  token_expires_at = now() + interval '3 days'
  WHERE name='warehouse-router';

INSERT INTO device_dhcp_leases (device_id, mac, ip, hostname, reserved, up, last_seen_at)
SELECT d.id, v.mac, v.ip, v.hostname, v.reserved, v.up, v.last_seen FROM devices d
JOIN (VALUES
  ('dock-router-1','94:83:C4:AA:00:01','192.168.8.10','zebra-fx9600-dock', true,  true,  now() - interval '30 seconds'),
  ('dock-router-1','48:A6:B8:AA:00:02','192.168.8.101','handheld-tc21-07', false, true,  now() - interval '2 minutes'),
  ('dock-router-1','F0:D1:A9:AA:00:03','192.168.8.102','kiosk-ipad-3',     false, true,  now() - interval '45 seconds'),
  ('dock-router-1','48:A6:B8:AA:00:04','192.168.8.103','handheld-tc21-02', false, false, now() - interval '2 days'),
  ('dock-router-1','00:80:92:AA:00:05','192.168.8.20','printer-dock',      true,  false, now() - interval '9 days'),
  ('warehouse-router','94:83:C4:BB:00:01','192.168.8.10','zebra-fx9600-wh1', true,  true,  now() - interval '20 seconds'),
  ('warehouse-router','48:A6:B8:BB:00:02','192.168.8.111','handheld-tc21-11', false, true,  now() - interval '75 seconds'),
  ('warehouse-router','3C:22:FB:BB:00:03','192.168.8.112','kiosk-web-wh',     false, false, now() - interval '6 hours')
) AS v(router, mac, ip, hostname, reserved, up, last_seen)
  ON d.name = v.router;
SELECT count(*) FROM device_dhcp_leases;
```

Expected: `INSERT 0 8`, count 8.
- [ ] **Step 3: Browser (screenshot gate — required):** `/hardware/routers` — new columns show `Connected`/`Disconnected` chips, Devices counts 3 and 2, token chips (plain date vs amber); expand `dock-router-1`: `Active (3)` / `Reserved (2)` switcher, aligned table with green/gray dots, `—`s where applicable; click Reserved; screenshot BOTH states; verify Delete click doesn't toggle the row; console clean.
- [ ] **Step 4:** `git status` clean; `_dev_reload.py` checked out if churned.

---

## Plan Self-Review (completed at write time)

- **Spec coverage:** migration/columns/lease table → Task 1 (constraints incl. (device_id,mac) unique, cascade, plain-TEXT vpn); derived count + leases endpoint + ordering/404/403 → Task 1; portal columns/chips/facet/CSV → Task 2 Step 5; expansion layout per binding rules (switcher, real table, dots, `—`, fetch-per-open, retry) → Task 2 Steps 3–4; sample data → Task 3; screenshot gate → Task 3.
- **Placeholders:** none — `.lease-tab` visual rules are explicitly sourced from `.sysconf-tab` (named file) rather than left vague.
- **Type consistency:** `DeviceLease`/`listDeviceLeases`/`vpnLabel`/`tokenExpiryState` names match across Interfaces/code/tests; column keys `vpn`/`connected`/`token_expires` consistent between COLUMNS, accessors, facets, CSV, and tests.
