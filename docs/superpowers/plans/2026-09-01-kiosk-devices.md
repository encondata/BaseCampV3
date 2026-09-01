# Kiosk Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Kiosk Devices placeholder becomes a real page: standard list with a derived registration lifecycle, the registry's first create/edit modal, and Register/Renew + De-Register + Delete actions.

**Architecture:** Migration 0040 adds `version` (shared) + the kiosk block (`kiosk_type`, `current_initiative_id`). Four new/extended endpoints (POST create, PATCH with an enforced allowed-field list, register/deregister actions). The page is a Routers/FixedReaders sibling; the modal is a new `components/hardware/KioskEditModal.tsx` obeying the binding form rules.

**Spec:** `docs/superpowers/specs/2026-09-01-kiosk-devices-design.md` — its lifecycle table, endpoint semantics, allowed-field list, column renderings, and modal layout are binding.

**Tech Stack:** Alembic/SQLAlchemy async/FastAPI, React. No new dependencies.

## Global Constraints

- Migration **0040** (`down_revision = "0039"`).
- Registration lifecycle DERIVED from `token_expires_at` (no status column): Registered (> now+7d, green) / Expires soon (≤7d, amber) / Expired (past, red) / Unregistered (null, neutral tag) — reuse `tokenExpiryState` ('ok'/'soon'/'expired'/'none').
- `POST /devices/{device_id}/register` body `{"days": int}` default 30, 422 `bad_days` outside 1–365; sets `registered_at=now()`, `token_expires_at=now()+days`. `POST /devices/{device_id}/deregister` nulls `token_expires_at` only. Both change-gated, audited (`register`/`deregister`).
- PATCH allowed fields EXACTLY `name, kiosk_type, mac, lan_ip, version, site_id, current_initiative_id, scan_status`; unknown field → 422 `bad_field`; `name` never null/empty (422 `bad_name`); explicit nulls allowed for the other fields; `scan_status` validated against asset vocab (422 `bad_scan_status`); `current_initiative_id` must exist (422 `bad_initiative`). POST /devices validates the same plus `device_type` against the vocabulary (422 `bad_device_type`).
- Page key `'hardware-kiosks'`; default sort `name` asc; `+ New kiosk` (add-gated); NO disabled register-affordance button on this page. Row actions: Edit (change) · Register/Renew (change; small days-modal default 30) or De-Register (change; confirm) · Delete (delete; confirm).
- Modal obeys the binding form rules: label-above-control, consistent 2-column `.pf-form` grid, select controls (no floating checkboxes), section headings visually distinct; registration dates never editable in the modal.
- Move options: `listInitiatives()` filtered client-side to `initiative_type === 'move'`, status `planned` or `in_progress`, unarchived (drop rows whose `archived_at` is set if the field exists on `InitiativeItem`). Scan-type options: `listStatusValues()` filtered to `record_type === 'asset'` and active.
- Sample data dev-DB SQL only. **All suites FOREGROUND, one continuous run, timeout 600000ms; never background a suite or end a turn with one running.** Never commit `api/src/serversherpa/_dev_reload.py`.

## File Structure

| File | Responsibility |
|---|---|
| `api/migrations/versions/0040_kiosk_fields.py` | Create: version + kiosk block |
| `api/src/serversherpa/db/models.py` | Modify: Device columns |
| `api/src/serversherpa/api/schemas.py` | Modify: DeviceItem + DeviceCreate/DevicePatch/DeviceRegisterIn |
| `api/src/serversherpa/api/routes/devices.py` | Modify: initiative join; +POST/PATCH/register/deregister |
| `portal/src/lib/api.ts` | Modify: DeviceItem fields + createDevice/patchDevice/registerDevice/deregisterDevice |
| `portal/src/lib/devices.ts` | Modify: kioskTypeLabel/registrationState labels + cell keys |
| `portal/src/pages/KioskDevices.tsx` | Create: the list page |
| `portal/src/components/hardware/KioskEditModal.tsx` | Create: create/edit modal |
| `portal/src/components/hardware/RegisterDaysModal.tsx` | Create: tiny days-confirm modal |
| `portal/src/pages/ScanningHardware.tsx` / `.test.tsx`, `portal/src/App.tsx` | Modify: swap placeholder |
| Tests | extend `api/tests/test_devices_api.py`, `portal/src/lib/devices.test.ts`; new `portal/src/pages/KioskDevices.test.tsx`, `portal/src/components/hardware/KioskEditModal.test.tsx` |

---

### Task 1: API — migration 0040, mutation endpoints, register/deregister

**Files:**
- Create: `api/migrations/versions/0040_kiosk_fields.py`
- Modify: `api/src/serversherpa/db/models.py`, `api/src/serversherpa/api/schemas.py`, `api/src/serversherpa/api/routes/devices.py`
- Test: `api/tests/test_devices_api.py` (append)

**Interfaces:**
- Produces (consumed by Task 2): `DeviceItem` gains `version: str | None`, `kiosk_type: str | None`, `current_initiative_id: uuid | None`, `current_initiative_name: str | None`. Endpoints: `POST /devices` → 201 DeviceItem; `PATCH /devices/{device_id}` → DeviceItem; `POST /devices/{device_id}/register` `{days:int=30}` → DeviceItem; `POST /devices/{device_id}/deregister` → DeviceItem. Error codes per Global Constraints.

- [ ] **Step 1: Write the failing tests** (append to `api/tests/test_devices_api.py`; reuse its real client/login helpers — read the existing route tests first; `Initiative` import needed). Full bodies for:

```python
# 12. test_create_kiosk_and_initiative_join — POST /devices with
#     device_type kiosk, name, kiosk_type 'laptop', mac/lan_ip/version,
#     scan_status 'rfid_1_cage_exit', current_initiative_id of a created
#     move Initiative → 201; GET list shows current_initiative_name.
#     POST with device_type 'toaster' → 422 bad_device_type; with
#     scan_status 'nope' → 422 bad_scan_status; with random initiative
#     uuid → 422 bad_initiative.
# 13. test_patch_allowed_fields_and_guards — PATCH name/version/
#     current_initiative_id(null clears) works and audits a diff;
#     PATCH {"serial": "x"} → 422 bad_field; PATCH {"name": ""} and
#     {"name": null} → 422 bad_name.
# 14. test_register_deregister_lifecycle — POST register (no body) sets
#     registered_at + expiry ≈ now+30d; register {"days": 7} ≈ now+7d;
#     {"days": 0} and {"days": 400} → 422 bad_days; deregister nulls
#     token_expires_at but keeps registered_at; audit rows exist with
#     actions register and deregister.
# 15. test_mutations_permission_denied — external-role user: POST → 403,
#     PATCH → 403, register → 403, deregister → 403.
```

- [ ] **Step 2: Run to verify failure**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: new tests FAIL (404/405 — endpoints missing).

- [ ] **Step 3: Migration**

```python
# api/migrations/versions/0040_kiosk_fields.py
"""kiosk fields on devices. version is SHARED (app/firmware version
string for any family). kiosk_type ('laptop'/'pi') and
current_initiative_id (the move a kiosk is scanning for) are the
kiosk block. Registration expiry reuses token_expires_at; kiosk IP
reuses lan_ip; the kiosk's checkpoint reuses scan_status.

Revision ID: 0040
Revises: 0039
Create Date: 2026-09-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0040"
down_revision: str | None = "0039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("version", sa.Text))
    op.add_column("devices", sa.Column(
        "kiosk_type", sa.Text, comment="kiosk block; laptop / pi"))
    op.add_column("devices", sa.Column(
        "current_initiative_id", UUID(as_uuid=True),
        sa.ForeignKey("initiatives.id"),
        comment="kiosk block; the selected move"))


def downgrade() -> None:
    op.drop_column("devices", "current_initiative_id")
    op.drop_column("devices", "kiosk_type")
    op.drop_column("devices", "version")
```

- [ ] **Step 4: Model + schemas.** `Device` gains `version: Mapped[str | None]` (after `model`), and after `scan_status_record_type`:

```python
    kiosk_type: Mapped[str | None]
    current_initiative_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("initiatives.id"))
```

`schemas.py`: `DeviceItem` gains `version: str | None`, `kiosk_type: str | None`, `current_initiative_id: uuid.UUID | None`, `current_initiative_name: str | None` (after `model`); add:

```python
class DevicePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    kiosk_type: str | None = None
    mac: str | None = None
    lan_ip: str | None = None
    version: str | None = None
    site_id: uuid.UUID | None = None
    current_initiative_id: uuid.UUID | None = None
    scan_status: str | None = None


class DeviceCreate(DevicePatch):
    device_type: str
    name: str = Field(min_length=1)


class DeviceRegisterIn(BaseModel):
    days: int = 30
```

NOTE on PATCH null-vs-absent: `extra="forbid"` yields FastAPI's own 422 for unknown fields — the spec's `bad_field` code requires a manual check instead, so drop `extra="forbid"` if it can't produce `detail.code == "bad_field"`; use `model_dump(exclude_unset=True)` + an explicit allowed-set check in the route (the authoritative mechanism; tests pin the code). Distinguish "name absent" from "name: null" via `exclude_unset`.

- [ ] **Step 5: Routes.** In `routes/devices.py`: add `Initiative` to model imports; extend the list query with `.outerjoin(Initiative, Device.current_initiative_id == Initiative.id)` selecting `Initiative.name`, and the payload with the four new fields. Add:

```python
_PATCH_FIELDS = {"name", "kiosk_type", "mac", "lan_ip", "version",
                 "site_id", "current_initiative_id", "scan_status"}


async def _validate_device_values(db: DbSession, data: dict) -> None:
    if "scan_status" in data and data["scan_status"] is not None:
        keys = set((await db.scalars(select(StatusValue.key).where(
            StatusValue.record_type == "asset"))).all())
        if data["scan_status"] not in keys:
            raise _err(422, "bad_scan_status")
    if "current_initiative_id" in data \
            and data["current_initiative_id"] is not None:
        if await db.get(Initiative, data["current_initiative_id"]) is None:
            raise _err(422, "bad_initiative")


async def _item_for(db: DbSession, device_id: uuid.UUID) -> dict:
    """One device re-read through the same joined shape as the list."""
    ...  # factor the list query's row->dict mapping into a helper both use


@router.post("", response_model=DeviceItem, status_code=201)
async def create_device(
    body: DeviceCreate, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "add"),
) -> dict:
    data = body.model_dump(exclude_unset=True)
    device_type = data.pop("device_type")
    vocab = set((await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "device_type"))).all())
    if device_type not in vocab:
        raise _err(422, "bad_device_type")
    unknown = set(data) - _PATCH_FIELDS
    if unknown:
        raise _err(422, "bad_field")
    await _validate_device_values(db, data)
    device = Device(device_type=device_type, **data)
    db.add(device)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="create",
          changes={k: (str(v) if v is not None else None)
                   for k, v in data.items()} | {"device_type": device_type})
    await db.commit()
    return await _item_for(db, device.id)


@router.patch("/{device_id}", response_model=DeviceItem)
async def patch_device(
    device_id: uuid.UUID, body: DevicePatch, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "change"),
) -> dict:
    device = await db.get(Device, device_id)
    if device is None:
        raise _err(404, "device_not_found")
    data = body.model_dump(exclude_unset=True)
    unknown = set(data) - _PATCH_FIELDS
    if unknown:
        raise _err(422, "bad_field")
    if "name" in data and (data["name"] is None or not data["name"].strip()):
        raise _err(422, "bad_name")
    await _validate_device_values(db, data)
    before = snapshot(device, list(data))
    for key, value in data.items():
        setattr(device, key, value)
    device.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="update",
          changes=diff(before, snapshot(device, list(data))))
    await db.commit()
    return await _item_for(db, device.id)


@router.post("/{device_id}/register", response_model=DeviceItem)
async def register_device(
    device_id: uuid.UUID, db: DbSession,
    body: DeviceRegisterIn | None = None,
    actor: AuthContext = require_permission("scanning_hardware", "change"),
) -> dict:
    device = await db.get(Device, device_id)
    if device is None:
        raise _err(404, "device_not_found")
    days = (body.days if body is not None else 30)
    if not 1 <= days <= 365:
        raise _err(422, "bad_days")
    now = datetime.now(UTC)
    device.registered_at = now
    device.token_expires_at = now + timedelta(days=days)
    device.updated_at = now
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="register",
          changes={"days": days,
                   "token_expires_at": device.token_expires_at.isoformat()})
    await db.commit()
    return await _item_for(db, device.id)


@router.post("/{device_id}/deregister", response_model=DeviceItem)
async def deregister_device(
    device_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "change"),
) -> dict:
    device = await db.get(Device, device_id)
    if device is None:
        raise _err(404, "device_not_found")
    device.token_expires_at = None
    device.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="deregister", changes={})
    await db.commit()
    return await _item_for(db, device.id)
```

Implement `_item_for` by factoring the existing list query's SELECT/joins/row-mapping into a shared internal (`_device_query()` + `_row_to_item(row)`), then `_item_for` filters it by id — the list endpoint and all four mutations return byte-identical shapes. Imports to extend: `DeviceCreate, DevicePatch, DeviceRegisterIn` (schemas), `Initiative` (models), `diff, snapshot` (services.audit), `timedelta`.

- [ ] **Step 6: Run to verify pass**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: 15 PASS (11 existing + 4 new).

- [ ] **Step 7: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/migrations/versions/0040_kiosk_fields.py api/src/serversherpa/db/models.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/devices.py api/tests/test_devices_api.py
git commit -m "feat(api): kiosk device fields + create/patch/register/deregister (migration 0040)"
```

---

### Task 2: Portal — Kiosks page, edit modal, register modal

**Files:**
- Modify: `portal/src/lib/api.ts`, `portal/src/lib/devices.ts`, `portal/src/lib/devices.test.ts`, `portal/src/pages/ScanningHardware.tsx`, `portal/src/pages/ScanningHardware.test.tsx`, `portal/src/App.tsx`
- Create: `portal/src/pages/KioskDevices.tsx`, `portal/src/pages/KioskDevices.test.tsx`, `portal/src/components/hardware/KioskEditModal.tsx`, `portal/src/components/hardware/KioskEditModal.test.tsx`, `portal/src/components/hardware/RegisterDaysModal.tsx`

**Interfaces:**
- Consumes: Task 1's wire shapes; existing `listInitiatives(): Promise<InitiativeItem[]>` and `listStatusValues(): Promise<StatusValue[]>` from `lib/api.ts` (read their item shapes first).
- Produces in `api.ts`: `DeviceItem` gains `version: string | null; kiosk_type: string | null; current_initiative_id: string | null; current_initiative_name: string | null;`; and

```ts
export interface DeviceWrite {
  name?: string; kiosk_type?: string | null; mac?: string | null;
  lan_ip?: string | null; version?: string | null; site_id?: string | null;
  current_initiative_id?: string | null; scan_status?: string | null;
}
export async function createDevice(body: DeviceWrite & { device_type: string; name: string }): Promise<DeviceItem>
export async function patchDevice(id: string, body: DeviceWrite): Promise<DeviceItem>
export async function registerDevice(id: string, days: number): Promise<DeviceItem>
export async function deregisterDevice(id: string): Promise<DeviceItem>
```

- Produces in `devices.ts`: `kioskTypeLabel(type: string | null): string` (`laptop`→`Laptop`, `pi`→`Pi`, other as-is, null `—`), `registrationLabel(state: ReturnType<typeof tokenExpiryState>): string` (`ok`→`Registered`, `soon`→`Expires soon`, `expired`→`Expired`, `none`→`Unregistered`), plus cellText/sortValue keys `kiosk_type`, `version`, `registration` (the label), `current_move`, `expires`.
- Produces: `<KioskEditModal device={DeviceItem | null} onClose onSaved />` (null = create) and `<RegisterDaysModal deviceName onConfirm(days) onClose />`.

- [ ] **Step 1: Failing lib tests** (append; widen the `R` fixture with the 4 new fields):

```ts
import { kioskTypeLabel, registrationLabel } from './devices';

describe('kiosk accessors', () => {
  const k = { ...R, kiosk_type: 'pi', version: '2.4.1',
              current_initiative_id: 'i1',
              current_initiative_name: 'NAP11 Hall Migration (demo)',
              token_expires_at: '2026-11-29T00:00:00Z' };
  it('labels', () => {
    expect(kioskTypeLabel('laptop')).toBe('Laptop');
    expect(kioskTypeLabel('pi')).toBe('Pi');
    expect(kioskTypeLabel(null)).toBe('—');
    expect(registrationLabel('ok')).toBe('Registered');
    expect(registrationLabel('soon')).toBe('Expires soon');
    expect(registrationLabel('expired')).toBe('Expired');
    expect(registrationLabel('none')).toBe('Unregistered');
  });
  it('cellText', () => {
    expect(deviceCellText(k, 'kiosk_type')).toBe('Pi');
    expect(deviceCellText(k, 'version')).toBe('2.4.1');
    expect(deviceCellText(k, 'current_move')).toBe('NAP11 Hall Migration (demo)');
    expect(deviceCellText({ ...k, current_initiative_name: null }, 'current_move')).toBe('—');
    expect(deviceCellText(k, 'registration')).toBe('Registered');
    expect(deviceCellText({ ...k, token_expires_at: null }, 'registration')).toBe('Unregistered');
    expect(deviceCellText(k, 'expires'))
      .toBe(new Date('2026-11-29T00:00:00Z').toLocaleDateString());
  });
});
```

(`registration` cellText computes `registrationLabel(tokenExpiryState(d.token_expires_at))` — note it uses real `now`, so fixture dates must be far-future/past; use `2126-…` for the 'ok' case if 2026 dates have aged by the time this runs — pick dates ≥50 years out/past to be time-proof.)

- [ ] **Step 2: Run to fail, implement lib + api.ts, run to green.** `devices.ts` additions per Interfaces; `sortValue`: `registration` → the label lowercased, `expires`/`current_move` → iso/name-or-''; `deviceSearchText` adds `version`, `kioskTypeLabel`, `current_initiative_name`. `api.ts` functions follow the house fetch pattern (`registerDevice` POSTs `{days}` JSON).

- [ ] **Step 3: Build `RegisterDaysModal.tsx`** — minimal house modal (`.modal-scrim/.modal-card` small): heading "Register {deviceName}", one `.pf-form` field "Valid for (days)" number input default 30 min 1 max 365, foot `.btn-solid` Confirm → `onConfirm(days)` / `.mini-btn` Cancel.

- [ ] **Step 4: Build `KioskEditModal.tsx`** — model the skeleton and error handling on `portal/src/components/statusRules/RuleEditorModal.tsx` (house form styling `.pf-form` 2-col grid, `.modal-section` headings, `.pf-error`). On mount fetch `listInitiatives()` + `listStatusValues()` (Promise.all; error → `.pf-error`); moves = filtered per Global Constraints; scan options = `record_type === 'asset'` active values. Fields in this order, each label-above-control, two per row: Name* / Type (select — none/Laptop/Pi); MAC / IP; Version / Site (select over sites — reuse the existing sites list export in `lib/api.ts`; read the file to find it); Current Move (select, "— none") / Scan Type (select with color dots like RuleEditorModal's status selects, "— none"). Save disabled until `name.trim()`. Create mode → `createDevice({device_type: 'kiosk', ...})`; edit mode → `patchDevice(id, changedFieldsOnly)` (compare against the incoming device; empty-string text inputs map to null for nullable fields). Error map: `bad_scan_status`, `bad_initiative`, `bad_field`, `bad_name`, `bad_device_type`.

- [ ] **Step 5: Build the page.** `portal/src/pages/KioskDevices.tsx` — copy `portal/src/pages/FixedReaders.tsx` (read first) and adapt:
1. Title `Kiosk Devices`, hint `Web and iOS (iPad) kiosk stations, provisioned from the portal.`, `listDevices('kiosk')`, page key `'hardware-kiosks'`.
2. Columns:
   ```ts
   { key: 'name', label: 'Name', width: 'minmax(150px, 1.2fr)', default: true },
   { key: 'kiosk_type', label: 'Type', width: '90px', default: true },
   { key: 'ip', label: 'IP', width: 'minmax(110px, 1fr)', default: true },
   { key: 'mac', label: 'MAC', width: 'minmax(150px, 1fr)', default: true },
   { key: 'version', label: 'Version', width: '90px', default: true },
   { key: 'registration', label: 'Registration', width: '120px', default: true },
   { key: 'current_move', label: 'Current Move', width: 'minmax(160px, 1.2fr)', default: true },
   { key: 'scan_status', label: 'Scan Type', width: 'minmax(140px, 1fr)', default: true },
   { key: 'site', label: 'Site', width: 'minmax(120px, 1fr)', default: true },
   { key: 'expires', label: 'Expires', width: 'minmax(110px, 1fr)', default: false },
   { key: 'last_seen', label: 'Last seen', width: 'minmax(150px, 1fr)', default: false },
   ```
3. `cellFor`: `kiosk_type` → `.chip.tag` (bare `—` null); `registration` → chip class by `tokenExpiryState`: `ok`→`chip c-green`, `soon`→`chip c-amber`, `expired`→`chip c-red`, `none`→`chip tag`, text = `registrationLabel(...)`; `scan_status` → the existing vocab-color chip mechanism with title; `mac` `.mono`; rest text.
4. Facets: `kiosk_type` (labels incl `—`), `registration` (the four labels), `site`.
5. CSV: all 11 + id, filename `kiosks`.
6. Toolbar: `+ New kiosk` `.btn-solid` gated `can('scanning_hardware','add')` → opens `KioskEditModal` with `device={null}`. No disabled register button.
7. Row actions (trailing cell, widen track to fit three `.mini-btn`s ≈ `210px`): Edit (change-gated) → modal with the row; then `tokenExpiryState(d.token_expires_at) === 'none' ? <Register> : <><Renew/><De-Register/></>` — Register/Renew opens `RegisterDaysModal` → `registerDevice(id, days)` then reload; De-Register `window.confirm` → `deregisterDevice(id)` then reload; Delete as existing pages. All mutations catch → error state (house pattern). Hmm — three-to-four buttons per row: render Edit, Register|Renew, De-Register (conditional), Delete; expected max 4 → track `260px`; adjust so header/row cell counts stay N+1 with the single trailing cell.
8. Empty state: "No kiosks yet — provision the first one."

Wire routing: `App.tsx` → `KioskDevices` page for `/hardware/kiosks`; `ScanningHardware.tsx` drops the `KioskDevices` placeholder export (only `HandheldReaders` remains); its test drops that case.

- [ ] **Step 6: Failing component/page tests, then green.** `KioskEditModal.test.tsx` (mock `../../lib/api`): full bodies —
```ts
// 1. create mode: fill name, pick type Pi + scan type + move, submit →
//    createDevice called with device_type 'kiosk' and exact fields.
// 2. edit mode: prefilled; change version only; submit → patchDevice
//    called with ONLY {version}.
// 3. move select offers only planned/in_progress unarchived moves from
//    the mocked listInitiatives payload.
// 4. bad_scan_status rejection surfaces mapped error text.
```
`KioskDevices.test.tsx` (mirror FixedReaders.test.tsx mocks): —
```ts
// 1. rows render: type tag, registration chips for all four states
//    (fixtures: far-future, +3d, past, null), current move name,
//    scan-type chip label.
// 2. + New kiosk hidden without add; opens modal with add.
// 3. contextual actions: unregistered row shows Register (not Renew/
//    De-Register); registered row shows Renew + De-Register.
// 4. Register flow: click Register → days modal → confirm →
//    registerDevice(id, 30) and reload.
// 5. load-error banner.
```

- [ ] **Step 7: Run everything**

Run: `npm --prefix portal test -- --run src/lib/devices.test.ts src/components/hardware/KioskEditModal.test.tsx src/pages/KioskDevices.test.tsx src/pages/FixedReaders.test.tsx src/pages/Routers.test.tsx src/pages/ScanningHardware.test.tsx`
Expected: all pass (sibling fixtures widened, nothing weakened).
Then: `npm --prefix portal test -- --run && npm --prefix portal run build`
Expected: full suite green, build clean.

- [ ] **Step 8: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/devices.ts portal/src/lib/devices.test.ts portal/src/pages/KioskDevices.tsx portal/src/pages/KioskDevices.test.tsx portal/src/components/hardware portal/src/pages/ScanningHardware.tsx portal/src/pages/ScanningHardware.test.tsx portal/src/App.tsx
git commit -m "feat(portal): Kiosk Devices page — provisioning modal + registration lifecycle"
```

---

### Task 3: Verification + dev sample data

**Files:** none (dev-DB SQL only).

- [ ] **Step 1:** `cd api && .venv/bin/alembic upgrade head`, then full API suite FOREGROUND (`api/.venv/bin/pytest api/tests -x -q`, timeout 600000ms). Expected: all pass.
- [ ] **Step 2: Seed** (`docker exec -i serversherpa-dev-postgres-1 psql -U serversherpa -d serversherpa`):

```sql
WITH s AS (SELECT id FROM sites ORDER BY name LIMIT 1),
     m AS (SELECT id FROM initiatives WHERE name ILIKE '%NAP11%' LIMIT 1)
INSERT INTO devices (device_type, name, kiosk_type, version, mac, lan_ip,
                     site_id, current_initiative_id, scan_status,
                     registered_at, token_expires_at, last_seen_at, raw_info)
SELECT * FROM (VALUES
  ('kiosk','kiosk-dock-1','laptop','2.4.1','10:6F:D9:0A:11:22','192.168.8.50',
   (SELECT id FROM s),(SELECT id FROM m),'rfid_1_cage_exit',
   now(), now() + interval '30 days', now() - interval '2 minutes', '{}'::jsonb),
  ('kiosk','kiosk-wh-1','pi','2.4.1','B8:27:EB:33:44:55','192.168.8.51',
   (SELECT id FROM s), NULL, 'rfid_4_into_cage',
   now() - interval '27 days', now() + interval '3 days',
   now() - interval '8 minutes', '{}'::jsonb),
  ('kiosk','kiosk-spare','pi','2.3.9','B8:27:EB:66:77:88', NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, '{}'::jsonb)
) AS v(device_type,name,kiosk_type,version,mac,lan_ip,site_id,
       current_initiative_id,scan_status,registered_at,token_expires_at,
       last_seen_at,raw_info);
SELECT name, kiosk_type, token_expires_at IS NOT NULL AS registered FROM devices
  WHERE device_type='kiosk' ORDER BY name;
```

Expected: 3 rows.
- [ ] **Step 3: Browser (screenshot gate):** `/hardware/kiosks` — three kiosks, registration chips green/amber/neutral, current move shown on kiosk-dock-1, scan-type chips; **open the Edit modal on kiosk-spare and screenshot it** (form-rules check: 2-col aligned grid, labeled selects, distinct section headings); register kiosk-spare via the days modal (default 30) and confirm the chip flips to Registered; de-register it back; console clean (ignore the known stale HMR buffer). Screenshot list + modal.
- [ ] **Step 4:** `git status` clean; `_dev_reload.py` checked out if churned.

---

## Plan Self-Review (completed at write time)

- **Spec coverage:** migration/columns → T1; lifecycle + register/deregister semantics incl. bad_days bounds → T1 (test 14); POST/PATCH validation incl. allowed-field/bad_name/explicit-null → T1 (test 13); initiative join → T1; page columns/chips/facets/CSV/+New/contextual actions → T2; modal per form rules + changed-fields-only PATCH → T2; move/scan option sourcing → T2 Step 4 + Global Constraints; sample data (3 states, NAP11 move) → T3; screenshot gate incl. open modal → T3.
- **Placeholders:** `_item_for`'s `...` is immediately specified ("factor the list query into `_device_query()`/`_row_to_item()`") — a concrete refactor instruction, not a TBD; sites-list export lookup is a named read-the-file instruction.
- **Type consistency:** endpoint paths/bodies match between T1 code, T1 tests, and T2's api.ts functions; cell keys `kiosk_type/version/registration/current_move/expires` consistent across accessors/COLUMNS/facets/CSV/tests; `registrationLabel(tokenExpiryState(...))` chain consistent.
