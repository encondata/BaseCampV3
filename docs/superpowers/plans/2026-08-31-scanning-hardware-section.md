# Scanning Hardware Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Scanning Hardware" sidebar section between Stakeholders and Admin with four placeholder pages (Handheld Readers, Fixed Readers, Kiosk Devices, Routers) behind one new `scanning_hardware` resource.

**Architecture:** API side is access-surface only (resource registry entry + default grants + migration 0036 seeding role_permissions). Portal side is one page module with four thin exports plus the standard five registration touchpoints. No data model, no endpoints.

**Spec:** `docs/superpowers/specs/2026-08-31-scanning-hardware-section-design.md` — the route table and hint copy there are binding.

**Tech Stack:** Alembic/SQLAlchemy (grants only), React. No new dependencies.

## Global Constraints

- Migration number is **0036** (`down_revision = "0035"`).
- Resource id exactly `scanning_hardware`, label `Scanning hardware`, `visible_to=frozenset({"global"})`, routes = the four spec routes.
- Grants: developer/founder/super_admin/admin = FULL, staff = `("view",)` — in BOTH migration 0036 and `access/defaults.py`.
- Routes exactly: `/hardware/handheld-readers`, `/hardware/fixed-readers`, `/hardware/kiosks`, `/hardware/routers`.
- Nav section title exactly `Scanning Hardware`, placed between the Stakeholders and Admin sections.
- Placeholder body copy exactly: `Nothing here yet — device records land when this section is built out.`
- **All suites FOREGROUND, one continuous run, timeout 600000ms. Never background a suite.** API: `api/.venv/bin/pytest …` (Postgres via docker compose). Portal: `npm --prefix portal test -- --run …` + `npm --prefix portal run build`.
- Never commit `api/src/serversherpa/_dev_reload.py`.

## File Structure

| File | Responsibility |
|---|---|
| `api/migrations/versions/0036_scanning_hardware_grants.py` | Create: role grants for the new resource |
| `api/src/serversherpa/access/resources.py` | Modify: +resource |
| `api/src/serversherpa/access/defaults.py` | Modify: +grants mirror |
| `portal/src/pages/ScanningHardware.tsx` | Create: placeholder component + 4 page exports |
| `portal/src/pages/ScanningHardware.test.tsx` | Create: page + nav-wiring tests |
| `portal/src/App.tsx`, `portal/src/layout/navSections.tsx`, `portal/src/components/Topbar.tsx`, `portal/src/components/CommandPalette.tsx`, `portal/src/lib/access.ts` | Modify: registration |

---

### Task 1: API access surface — resource, defaults, migration 0036

**Files:**
- Create: `api/migrations/versions/0036_scanning_hardware_grants.py`
- Modify: `api/src/serversherpa/access/resources.py` (after the `status_rules` entry)
- Modify: `api/src/serversherpa/access/defaults.py`
- Test: existing `api/tests/test_access_registry.py` / `api/tests/test_access_api.py` (update expectations)

**Interfaces:**
- Produces: resource id `scanning_hardware` gating the four routes — Task 2's `ProtectedRoute`/`ROUTE_RESOURCE` entries use this exact id.

- [ ] **Step 1: See the current access tests pass, then make the registry change and watch what breaks** (these tests pin the registry contents, so TDD here is: change → run → update pinned expectations deliberately).

In `api/src/serversherpa/access/resources.py`, after the `status_rules` entry:

```python
    Resource("scanning_hardware", "Scanning hardware",
             routes=("/hardware/handheld-readers", "/hardware/fixed-readers",
                     "/hardware/kiosks", "/hardware/routers"),
             # internal-only: device fleet records are house operations data.
             visible_to=frozenset({"global"})),
```

In `api/src/serversherpa/access/defaults.py`: append `"scanning_hardware"` to `_ALL`; add `"scanning_hardware": FULL,` to the `admin` dict and `"scanning_hardware": ("view",),` to the `staff` dict.

- [ ] **Step 2: Run access tests, update pinned expectations**

Run: `api/.venv/bin/pytest api/tests/test_access_registry.py api/tests/test_access_api.py -v`
Expected: failures wherever resource lists/counts are pinned. Update those expectations to include `scanning_hardware` (mirror how the status_rules addition was folded in — see that file's history if unclear). Re-run to green.

- [ ] **Step 3: Write migration 0036**

```python
# api/migrations/versions/0036_scanning_hardware_grants.py
"""scanning_hardware — role grants for the new Scanning Hardware portal
section (placeholder pages; no tables). One resource covers all four
device-family routes; per-type resources are deferred until a family
needs different access.

Revision ID: 0036
Revises: 0035
Create Date: 2026-08-31
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0036"
down_revision: str | None = "0035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FULL = ("view", "add", "change", "delete")
GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": ("view",),
}


def upgrade() -> None:
    conn = op.get_bind()
    for role, actions in GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'scanning_hardware', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'scanning_hardware'"))
```

- [ ] **Step 4: Run the access tests plus migration-touching suites**

Run: `api/.venv/bin/pytest api/tests/test_access_registry.py api/tests/test_access_api.py api/tests/test_status_rules_models.py -v`
Expected: all pass (conftest migrates the test DB to the new head; the third file proves head migration still applies cleanly).

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/migrations/versions/0036_scanning_hardware_grants.py api/src/serversherpa/access/resources.py api/src/serversherpa/access/defaults.py api/tests/test_access_registry.py api/tests/test_access_api.py
git commit -m "feat(api): scanning_hardware resource + grants (migration 0036)"
```

(Include the test files in `git add` only if they changed.)

---

### Task 2: Portal — placeholder pages + full registration

**Files:**
- Create: `portal/src/pages/ScanningHardware.tsx`
- Create: `portal/src/pages/ScanningHardware.test.tsx`
- Modify: `portal/src/App.tsx`, `portal/src/layout/navSections.tsx`, `portal/src/components/Topbar.tsx`, `portal/src/components/CommandPalette.tsx`, `portal/src/lib/access.ts`

**Interfaces:**
- Consumes: resource id `scanning_hardware` (Task 1); house classes `.portal-page/.dir-head/.eyebrow/.page-title/.page-hint/.dir-empty` (import `../styles/directory.css`).
- Produces: page exports `HandheldReaders`, `FixedReaders`, `KioskDevices`, `HardwareRouters` from `pages/ScanningHardware.tsx`.

- [ ] **Step 1: Write the failing tests**

```tsx
// portal/src/pages/ScanningHardware.test.tsx
// @vitest-environment jsdom
/** Placeholder pages: static shells, so the tests pin the copy and the
 *  nav wiring (section position + resource gating comes from
 *  navSections data, which godmode.test.ts already validates
 *  structurally). */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { NAV_SECTIONS } from '../layout/navSections';
import {
  FixedReaders, HandheldReaders, HardwareRouters, KioskDevices,
} from './ScanningHardware';

afterEach(cleanup);

const PAGES = [
  [HandheldReaders, 'Handheld Readers', /Zebra \(Android\)/],
  [FixedReaders, 'Fixed Readers', /FX9600/],
  [KioskDevices, 'Kiosk Devices', /iPad/],
  [HardwareRouters, 'Routers', /GL\.iNet/],
] as const;

it.each(PAGES)('renders %o with title and hint', (Page, title, hint) => {
  render(<Page />);
  expect(screen.getByRole('heading', { name: title })).toBeTruthy();
  expect(screen.getByText(hint)).toBeTruthy();
  expect(screen.getByText(/Nothing here yet/)).toBeTruthy();
});

it('nav section sits between Stakeholders and Admin, gated on scanning_hardware', () => {
  const titles = NAV_SECTIONS.map((s) => s.title);
  const idx = titles.indexOf('Scanning Hardware');
  expect(idx).toBeGreaterThan(titles.indexOf('Stakeholders'));
  expect(idx).toBeLessThan(titles.indexOf('Admin'));
  const section = NAV_SECTIONS[idx];
  expect(section.items.map((i) => i.to)).toEqual([
    '/hardware/handheld-readers', '/hardware/fixed-readers',
    '/hardware/kiosks', '/hardware/routers',
  ]);
  expect(new Set(section.items.map((i) => i.resource)))
    .toEqual(new Set(['scanning_hardware']));
});
```

Adapt the `NAV_SECTIONS`/section field names (`title` vs `label`, `items`) to the real `NavSection` interface in `layout/navSections.tsx` — read it first; keep the assertions' meaning intact. `it.each` label formatting may need `$1`-style syntax per the project's vitest version; adjust mechanically.

- [ ] **Step 2: Run to verify failure**

Run: `npm --prefix portal test -- --run src/pages/ScanningHardware.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the page module**

```tsx
// portal/src/pages/ScanningHardware.tsx
/** Scanning Hardware placeholders — one shell, four pages. Each device
 *  family (handhelds, fixed readers, kiosks, routers) gets its own
 *  real spec/build later; these just claim the routes and copy. */

import '../styles/directory.css';

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Scanning Hardware</div>
          <h1 className="page-title">{title}</h1>
          <p className="page-hint">{hint}</p>
        </div>
      </div>
      <div className="dir-empty">
        Nothing here yet — device records land when this section is built out.
      </div>
    </div>
  );
}

export function HandheldReaders() {
  return <Placeholder title="Handheld Readers"
                      hint="Android, iOS, and Zebra (Android) handheld scanners." />;
}

export function FixedReaders() {
  return <Placeholder title="Fixed Readers"
                      hint="Zebra FX9600 fixed RFID readers." />;
}

export function KioskDevices() {
  return <Placeholder title="Kiosk Devices"
                      hint="Web and iOS (iPad) kiosk stations." />;
}

export function HardwareRouters() {
  return <Placeholder title="Routers"
                      hint="GL.iNet site routers." />;
}
```

- [ ] **Step 4: Register everywhere** (read each file first and match its real element shapes — the same drill as the status-rules registration):

1. `portal/src/App.tsx` — import the four exports; add between the stakeholder and admin route groups:
   ```tsx
   <Route path="/hardware/handheld-readers" element={
     <ProtectedRoute resource="scanning_hardware"><HandheldReaders /></ProtectedRoute>} />
   <Route path="/hardware/fixed-readers" element={
     <ProtectedRoute resource="scanning_hardware"><FixedReaders /></ProtectedRoute>} />
   <Route path="/hardware/kiosks" element={
     <ProtectedRoute resource="scanning_hardware"><KioskDevices /></ProtectedRoute>} />
   <Route path="/hardware/routers" element={
     <ProtectedRoute resource="scanning_hardware"><HardwareRouters /></ProtectedRoute>} />
   ```
2. `portal/src/layout/navSections.tsx` — new section between Stakeholders and Admin, all items `resource: 'scanning_hardware'`, one inline 24×24 stroke SVG each (`fill="none" stroke="currentColor" strokeWidth="1.7"`):
   - Handheld Readers: `<rect x="8" y="3" width="8" height="18" rx="2"/><path d="M11 18h2"/>`
   - Fixed Readers: `<rect x="4" y="12" width="16" height="7" rx="2"/><path d="M8 12V8m8 4V8M6 5c3.5-2.5 8.5-2.5 12 0" strokeLinecap="round"/>`
   - Kiosk Devices: `<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M12 16v4m-4 0h8" strokeLinecap="round"/>`
   - Routers: `<rect x="3" y="13" width="18" height="6" rx="2"/><path d="M7 13V9m0 0c2.8-2 7.2-2 10 0M17 16h.01M14 16h.01" strokeLinecap="round"/>`
3. `portal/src/components/Topbar.tsx` — `CRUMBS` entries `['Scanning Hardware', '<item label>']` for all four routes; `PAGES` entries with the four labels/paths (match the array's real element shape).
4. `portal/src/components/CommandPalette.tsx` — four `navGated('<label>', '<route>', 'scanning_hardware')` entries next to the existing nav block.
5. `portal/src/lib/access.ts` — four `ROUTE_RESOURCE` entries → `'scanning_hardware'`.

- [ ] **Step 5: Run tests + full suite + build**

Run: `npm --prefix portal test -- --run src/pages/ScanningHardware.test.tsx`
Expected: all pass.
Then: `npm --prefix portal test -- --run && npm --prefix portal run build`
Expected: full suite green (nav/godmode tests must pass with the new section) and clean build.

- [ ] **Step 6: Commit**

```bash
git add portal/src/pages/ScanningHardware.tsx portal/src/pages/ScanningHardware.test.tsx portal/src/App.tsx portal/src/layout/navSections.tsx portal/src/components/Topbar.tsx portal/src/components/CommandPalette.tsx portal/src/lib/access.ts
git commit -m "feat(portal): Scanning Hardware section — four placeholder pages + registration"
```

---

### Task 3: Verification

**Files:** none.

- [ ] **Step 1:** `api/.venv/bin/alembic upgrade head` from `api/` against the dev DB (grants land), then `api/.venv/bin/pytest api/tests -x -q` FOREGROUND (timeout 600000ms). Expected: all pass.
- [ ] **Step 2:** Browser: open `http://localhost:5173`, confirm the sidebar shows **Scanning Hardware** between Stakeholders and Admin with the four items; visit each page and confirm title/hint/placeholder copy; check the ⌘K palette lists the four pages; console clean.
- [ ] **Step 3:** `git status` clean (checkout `_dev_reload.py` if churned).

---

## Plan Self-Review (completed at write time)

- **Spec coverage:** routes/copy → Task 2 Steps 1/3; access resource + grants + migration 0036 → Task 1; registration touchpoints → Task 2 Step 4; testing section → Tasks 1/2 + Task 3 browser pass.
- **Placeholders:** none — all code shown; the two "match the file's real shape" notes name the exact files and mirror the approach that worked for the status-rules registration.
- **Type consistency:** resource id `scanning_hardware` used identically across Tasks 1–2; page export names consistent between module, tests, and App.tsx.
