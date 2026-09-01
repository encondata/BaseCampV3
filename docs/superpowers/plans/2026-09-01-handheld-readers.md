# Handheld Readers + Actions Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The last placeholder becomes the Handheld Readers page (android/ios/zebra), the kiosk modal generalizes into a shared DeviceEditModal, and kiosk + handheld rows trade their button strip for a single expanding Actions menu.

**Architecture:** Migration 0041 renames `devices.kiosk_type` → `sub_type` end-to-end. A shared `RowActionsMenu` (pop-menu mechanics reused from the list libs) and the generalized modal land first with the kiosk page converted; the Handhelds page is then a thin sibling.

**Spec:** `docs/superpowers/specs/2026-09-01-handheld-readers-design.md` — binding for the rename, menu item order/gating, modal props, and page copy.

**Tech Stack:** Alembic/FastAPI, React. No new dependencies.

## Global Constraints

- Migration **0041** (`down_revision = "0040"`): `ALTER TABLE devices RENAME COLUMN kiosk_type TO sub_type`; downgrade renames back. Wire shape renames everywhere (`DeviceItem.sub_type`, allowlist swaps `kiosk_type`→`sub_type`; a PATCH body with `kiosk_type` is now 422 `bad_field` — pinned by test).
- Sub-type labels: kiosk `laptop`→Laptop, `pi`→Pi; handheld `android`→Android, `ios`→iOS, `zebra`→Zebra; other values as-is; null `—`. One accessor: `subTypeLabel(type: string | null): string` replaces `kioskTypeLabel`.
- `RowActionsMenu` items in order: **Edit** (change) · **Register** (state `none`) or **Renew** (otherwise) (change) · **De-Register** (states other than `none`) (change) · **Delete** (delete, destructive class, last, visually separated). No grants → no Actions button rendered. One open menu at a time per page; Escape and outside click close; selecting an item closes then runs the existing flow. Trigger label exactly `Actions ▾`. Applied to KioskDevices + HandheldReaders ONLY.
- `DeviceEditModal` props exactly: `{ deviceType: string; noun: string; typeOptions: { value: string; label: string }[]; device: DeviceItem | null; onClose: () => void; onSaved: () => void }` — behavior otherwise identical to the current KioskEditModal (which it replaces; old name/file removed).
- Handhelds page: `device_type='handheld_reader'`, page key `'hardware-handhelds'`, hint `Android, iOS, and Zebra handheld scanners.`, CSV filename `handheld-readers`, `+ New handheld`.
- `ScanningHardware.tsx` is deleted (last placeholder gone); the nav-wiring test moves to `portal/src/layout/scanningHardwareNav.test.tsx` importing `NAV_SECTIONS` only.
- Sample data dev-DB SQL only. **All suites FOREGROUND, one continuous run, timeout 600000ms; never background a suite or end a turn with one running.** Never commit `api/src/serversherpa/_dev_reload.py`.

## File Structure

| File | Responsibility |
|---|---|
| `api/migrations/versions/0041_sub_type_rename.py` | Create: column rename |
| `api/src/serversherpa/db/models.py`, `api/.../api/schemas.py`, `api/.../api/routes/devices.py`, `api/tests/test_devices_api.py` | Modify: rename ripple |
| `portal/src/lib/listTools.tsx` | Modify: export `useOutsideClose` |
| `portal/src/components/hardware/RowActionsMenu.tsx` (+test) | Create: shared menu |
| `portal/src/components/hardware/DeviceEditModal.tsx` (+test) | Rename+generalize from KioskEditModal |
| `portal/src/pages/KioskDevices.tsx` (+test) | Modify: sub_type rename + menu |
| `portal/src/pages/HandheldReaders.tsx` (+test) | Create: sibling page |
| `portal/src/pages/ScanningHardware.tsx`/`.test.tsx` | Delete; nav test → `portal/src/layout/scanningHardwareNav.test.tsx` |
| `portal/src/lib/api.ts`, `portal/src/lib/devices.ts` (+tests) | Modify: rename + labels |
| `portal/src/App.tsx` | Modify: route → HandheldReaders |

---

### Task 1: API — sub_type rename (migration 0041)

**Files:**
- Create: `api/migrations/versions/0041_sub_type_rename.py`
- Modify: `api/src/serversherpa/db/models.py`, `api/src/serversherpa/api/schemas.py`, `api/src/serversherpa/api/routes/devices.py`, `api/tests/test_devices_api.py`

**Interfaces:**
- Produces: `DeviceItem.sub_type: str | None` (replacing `kiosk_type`); `_PATCH_FIELDS` contains `sub_type`, not `kiosk_type`.

- [ ] **Step 1: Adjust tests first** (this is a rename — the tests drive it): in `api/tests/test_devices_api.py`, replace every `kiosk_type` with `sub_type` (constructor kwargs, POST/PATCH bodies, assertions), and ADD to `test_patch_allowed_fields_and_guards`:

```python
    resp = await client.patch(f"/devices/{device_id}", headers=hdrs,
                              json={"kiosk_type": "laptop"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_field"
```

- [ ] **Step 2: Run to verify failure**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: FAIL — `'sub_type' is an invalid keyword argument`.

- [ ] **Step 3: Migration**

```python
# api/migrations/versions/0041_sub_type_rename.py
"""kiosk_type -> sub_type: the column is the shared per-family type
field now that handhelds use it too (kiosk: laptop/pi; handheld:
android/ios/zebra). Pure rename — data preserved.

Revision ID: 0041
Revises: 0040
Create Date: 2026-09-01
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0041"
down_revision: str | None = "0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("devices", "kiosk_type", new_column_name="sub_type")


def downgrade() -> None:
    op.alter_column("devices", "sub_type", new_column_name="kiosk_type")
```

- [ ] **Step 4: Ripple the rename**: `models.py` `Device.kiosk_type` → `sub_type` (update the comment to "kiosk: laptop/pi; handheld: android/ios/zebra"); `schemas.py` `DeviceItem.kiosk_type`/`DevicePatch.kiosk_type` → `sub_type`; `routes/devices.py` `_PATCH_FIELDS` + `_row_to_item` mapping. Grep `kiosk_type` under `api/` afterward — zero hits outside the migration.

- [ ] **Step 5: Run to verify pass**

Run: `api/.venv/bin/pytest api/tests/test_devices_api.py -v`
Expected: 15 PASS (incl. the new bad_field case).

- [ ] **Step 6: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/migrations/versions/0041_sub_type_rename.py api/src/serversherpa/db/models.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/devices.py api/tests/test_devices_api.py
git commit -m "feat(api): rename devices.kiosk_type to sub_type (migration 0041)"
```

---

### Task 2: Portal — RowActionsMenu + DeviceEditModal + kiosk page conversion

**Files:**
- Modify: `portal/src/lib/listTools.tsx` (add `export` to `useOutsideClose`, `listTools.tsx:163`), `portal/src/lib/api.ts`, `portal/src/lib/devices.ts`, `portal/src/lib/devices.test.ts`, `portal/src/pages/KioskDevices.tsx`, `portal/src/pages/KioskDevices.test.tsx`
- Create: `portal/src/components/hardware/RowActionsMenu.tsx`, `portal/src/components/hardware/RowActionsMenu.test.tsx`
- Rename: `portal/src/components/hardware/KioskEditModal.tsx` → `DeviceEditModal.tsx` (+ its test file)

**Interfaces:**
- Consumes: Task 1's `sub_type` wire field.
- Produces (consumed by Task 3):

```ts
// devices.ts
export function subTypeLabel(type: string | null): string   // replaces kioskTypeLabel
// deviceCellText/deviceSortValue key renamed 'kiosk_type' -> 'sub_type'

// RowActionsMenu.tsx
export interface RowAction { key: string; label: string; onSelect: () => void; destructive?: boolean }
export function RowActionsMenu({ label, actions }: { label?: string; actions: RowAction[] }): JSX.Element | null
// renders null when actions is empty; trigger text `${label ?? 'Actions'} ▾`

// DeviceEditModal.tsx
export default function DeviceEditModal(props: { deviceType: string; noun: string;
  typeOptions: { value: string; label: string }[]; device: DeviceItem | null;
  onClose: () => void; onSaved: () => void }): JSX.Element
```

- [ ] **Step 1: Lib renames, tests first.** `devices.test.ts`: rename `kioskTypeLabel` usages to `subTypeLabel`, extend the label test with `android`→`Android`, `ios`→`iOS`, `zebra`→`Zebra`; fixture field `kiosk_type` → `sub_type`; cellText key `'kiosk_type'` → `'sub_type'`. Run (FAIL) → implement in `devices.ts` + `api.ts` (`DeviceItem.sub_type`, `DeviceWrite.sub_type`) → run (PASS). `subTypeLabel`:

```ts
const SUB_TYPE_LABELS: Record<string, string> = {
  laptop: 'Laptop', pi: 'Pi', android: 'Android', ios: 'iOS', zebra: 'Zebra',
};
export function subTypeLabel(type: string | null): string {
  if (type == null) return '—';
  return SUB_TYPE_LABELS[type] ?? type;
}
```

- [ ] **Step 2: RowActionsMenu tests first** (`RowActionsMenu.test.tsx`, jsdom):

```ts
// 1. renders 'Actions ▾' trigger; menu items hidden until click; click
//    shows the given labels in order; destructive item carries the
//    destructive class.
// 2. selecting an item calls its onSelect AND closes the menu.
// 3. Escape closes; outside mousedown closes (fire on document.body).
// 4. actions=[] renders null (no trigger at all).
```

Run (FAIL) → implement:

```tsx
// portal/src/components/hardware/RowActionsMenu.tsx
/** One compact row-actions trigger opening a pop-menu — replaces
 *  per-row button strips on the device lists. Items are supplied
 *  pre-gated (an item the user may not use is simply not passed), so
 *  an empty list means no trigger at all. Popover mechanics match the
 *  column menus (outside-click via listTools' useOutsideClose; Escape
 *  handled here). */

import { useEffect, useState } from 'react';

import { useOutsideClose } from '../../lib/listTools';
import '../../styles/column-menu.css';

export interface RowAction {
  key: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

export function RowActionsMenu({ label, actions }: {
  label?: string; actions: RowAction[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose<HTMLDivElement>(() => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (actions.length === 0) return null;
  return (
    <div className="row-actions" ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="mini-btn" aria-haspopup="menu"
              aria-expanded={open}
              onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        {label ?? 'Actions'} ▾
      </button>
      {open && (
        <div className="pop-menu" role="menu">
          {actions.map((a) => (
            <button key={a.key} type="button" role="menuitem"
                    className={`pop-item${a.destructive ? ' danger' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setOpen(false); a.onSelect(); }}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

Check `column-menu.css` for the real `.pop-menu` item class names — if items there use a different class than `.pop-item`, use the real ones; add a `.pop-item.danger { color: var(--c-red); }`-style rule to `portal/src/styles/hardware.css` (reusing the existing red token from directory.css) plus a separator margin before the destructive item. Run tests (PASS).

- [ ] **Step 3: Generalize the modal.** `git mv` KioskEditModal.tsx → DeviceEditModal.tsx (and test file). Inside: rename component/export; replace hardcoded bits with props — `device_type: 'kiosk'` → `props.deviceType`; heading/copy "kiosk" → `props.noun` (e.g. `Edit — {name}` unchanged; create-mode heading `New {noun}`); Type select options from `props.typeOptions` (keep the "— none" option); field name `kiosk_type` → `sub_type` throughout. Update the test file: rename imports, pass `deviceType="kiosk" noun="kiosk" typeOptions={[{value:'laptop',label:'Laptop'},{value:'pi',label:'Pi'}]}`, add one case: with handheld typeOptions the select offers Android/iOS/Zebra and create POSTs `device_type: 'handheld_reader'` + `sub_type: 'zebra'`. Run modal tests (PASS).

- [ ] **Step 4: Convert the kiosk page.** In `KioskDevices.tsx`: `kiosk_type` key → `sub_type` (COLUMNS, facets, CSV, cellFor via `subTypeLabel`); import DeviceEditModal with the kiosk props; replace the trailing button strip with:

```tsx
<RowActionsMenu actions={[
  ...(canChange ? [{ key: 'edit', label: 'Edit', onSelect: () => setEditing(d) }] : []),
  ...(canChange ? [tokenExpiryState(d.token_expires_at) === 'none'
    ? { key: 'register', label: 'Register', onSelect: () => setRegistering(d) }
    : { key: 'renew', label: 'Renew', onSelect: () => setRegistering(d) }] : []),
  ...(canChange && tokenExpiryState(d.token_expires_at) !== 'none'
    ? [{ key: 'deregister', label: 'De-Register', onSelect: () => void deregister(d) }] : []),
  ...(canDelete ? [{ key: 'delete', label: 'Delete', destructive: true,
                     onSelect: () => void remove(d) }] : []),
]} />
```

Trailing track `110px`. Update `KioskDevices.test.tsx`: actions are now reached by opening the menu first (`await user.click(screen.getAllByRole('button', { name: /Actions/ })[0])` then click the item); assertions otherwise unchanged; add: viewer with no change/delete grants sees NO Actions button.

- [ ] **Step 5: Run the touched files**

Run: `npm --prefix portal test -- --run src/lib/devices.test.ts src/components/hardware/RowActionsMenu.test.tsx src/components/hardware/DeviceEditModal.test.tsx src/pages/KioskDevices.test.tsx`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/listTools.tsx portal/src/lib/api.ts portal/src/lib/devices.ts portal/src/lib/devices.test.ts portal/src/components/hardware portal/src/pages/KioskDevices.tsx portal/src/pages/KioskDevices.test.tsx portal/src/styles/hardware.css
git commit -m "feat(portal): shared RowActionsMenu + DeviceEditModal; kiosk page converted"
```

---

### Task 3: Portal — Handheld Readers page

**Files:**
- Create: `portal/src/pages/HandheldReaders.tsx`, `portal/src/pages/HandheldReaders.test.tsx`, `portal/src/layout/scanningHardwareNav.test.tsx`
- Delete: `portal/src/pages/ScanningHardware.tsx`, `portal/src/pages/ScanningHardware.test.tsx`
- Modify: `portal/src/App.tsx`

**Interfaces:**
- Consumes: Task 2's `RowActionsMenu`, `DeviceEditModal`, `subTypeLabel`.

- [ ] **Step 1: Move the nav test.** Create `portal/src/layout/scanningHardwareNav.test.tsx` containing the nav-wiring test currently in `ScanningHardware.test.tsx` verbatim (imports `NAV_SECTIONS` from `./navSections`; adjust the relative import). Delete `ScanningHardware.test.tsx` and `ScanningHardware.tsx`; remove the placeholder import from `App.tsx`.

- [ ] **Step 2: Failing page tests** (`HandheldReaders.test.tsx` — copy `KioskDevices.test.tsx` and adapt): fixtures `device_type: 'handheld_reader'`, sub_types android/ios/zebra; required cases —

```ts
// 1. rows render with Android/iOS/Zebra tags + registration chips.
// 2. + New handheld gated on add; opens the modal (create).
// 3. Actions menu: contextual Register vs Renew/De-Register items.
// 4. create flow POSTs device_type 'handheld_reader'.
// 5. load-error banner.
```

- [ ] **Step 3: Build the page** — copy `KioskDevices.tsx`, adapt: `listDevices('handheld_reader')`, page key `'hardware-handhelds'`, title `Handheld Readers`, hint `Android, iOS, and Zebra handheld scanners.`, `+ New handheld`, CSV filename `handheld-readers`, modal props `deviceType="handheld_reader" noun="handheld" typeOptions={[{value:'android',label:'Android'},{value:'ios',label:'iOS'},{value:'zebra',label:'Zebra'}]}`. Route in `App.tsx`: `/hardware/handheld-readers` → `HandheldReaders` (ProtectedRoute unchanged).

- [ ] **Step 4: Run everything**

Run: `npm --prefix portal test -- --run src/pages/HandheldReaders.test.tsx src/layout/scanningHardwareNav.test.tsx src/pages/KioskDevices.test.tsx`
Expected: all pass.
Then: `npm --prefix portal test -- --run && npm --prefix portal run build`
Expected: full suite green (nav/godmode intact), build clean.

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/HandheldReaders.tsx portal/src/pages/HandheldReaders.test.tsx portal/src/layout/scanningHardwareNav.test.tsx portal/src/App.tsx
git rm portal/src/pages/ScanningHardware.tsx portal/src/pages/ScanningHardware.test.tsx
git commit -m "feat(portal): Handheld Readers page — last placeholder replaced"
```

---

### Task 4: Verification + dev sample data

**Files:** none (dev-DB SQL only).

- [ ] **Step 1:** `cd api && .venv/bin/alembic upgrade head`, then full API suite FOREGROUND (`api/.venv/bin/pytest api/tests -x -q`, timeout 600000ms). Expected: all pass.
- [ ] **Step 2: Seed** (`docker exec -i serversherpa-dev-postgres-1 psql -U serversherpa -d serversherpa`; note `registered_at` is NOT NULL — always set it):

```sql
WITH s AS (SELECT id FROM sites ORDER BY name LIMIT 1),
     m AS (SELECT id FROM initiatives WHERE name ILIKE '%NAP11%' LIMIT 1)
INSERT INTO devices (device_type, name, sub_type, version, mac, lan_ip,
                     site_id, current_initiative_id, scan_status,
                     registered_at, token_expires_at, last_seen_at, raw_info)
SELECT * FROM (VALUES
  ('handheld_reader','handheld-a54-01','android','2.4.1','A4:6B:B6:01:02:03','192.168.8.61',
   (SELECT id FROM s),(SELECT id FROM m),'rfid_1_cage_exit',
   now(), now() + interval '30 days', now() - interval '90 seconds', '{}'::jsonb),
  ('handheld_reader','handheld-iphone-02','ios','2.4.1','F0:98:9D:04:05:06','192.168.8.62',
   (SELECT id FROM s), NULL, NULL,
   now() - interval '28 days', now() + interval '2 days',
   now() - interval '20 minutes', '{}'::jsonb),
  ('handheld_reader','handheld-tc21-07','zebra','2.3.9','48:A6:B8:07:08:09', NULL,
   NULL, NULL, NULL, now(), NULL, NULL, '{}'::jsonb)
) AS v(device_type,name,sub_type,version,mac,lan_ip,site_id,
       current_initiative_id,scan_status,registered_at,token_expires_at,
       last_seen_at,raw_info);
SELECT name, sub_type, token_expires_at IS NOT NULL AS has_expiry
FROM devices WHERE device_type='handheld_reader' ORDER BY name;
```

Expected: 3 rows.
- [ ] **Step 3: Browser (screenshot gate):** `/hardware/handheld-readers` — three handhelds, Android/iOS/Zebra tags, all three registration chips; **open the Actions menu** on a registered row (screenshot: Edit/Renew/De-Register/Delete with destructive styling) and on the unregistered row (Register instead of Renew, no De-Register); register `handheld-tc21-07` via the menu (days modal) and confirm the chip flips, then de-register; open the create modal (screenshot). Then `/hardware/kiosks` — Actions menu present there too (screenshot open). Escape closes the menu. Console clean (ignore the known stale HMR buffer).
- [ ] **Step 4:** `git status` clean; `_dev_reload.py` checked out if churned.

---

## Plan Self-Review (completed at write time)

- **Spec coverage:** rename → T1 (incl. the 422 pin); RowActionsMenu semantics/order/gating/Escape/outside-close/null-when-empty → T2 (component + tests); DeviceEditModal props + typeOptions case → T2; kiosk conversion + 110px track → T2; Handhelds page copy/keys/CSV/+New → T3; ScanningHardware deletion + nav-test relocation → T3; sample data (3 states, tc21-07 name linkage) → T4; screenshot gate incl. open menus + create modal → T4.
- **Placeholders:** the `.pop-item` class caveat is a named verify-against-file instruction with a concrete fallback; everything else is full code or exact adaptation lists.
- **Type consistency:** `sub_type` key/field consistent across T1 wire, T2 lib/pages, T3 page, T4 seed SQL; `RowAction`/`RowActionsMenu`/`DeviceEditModal` signatures match between Interfaces, code, and both consuming tasks; `subTypeLabel` replaces `kioskTypeLabel` everywhere.
