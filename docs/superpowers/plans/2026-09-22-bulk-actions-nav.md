# Bulk Actions Nav Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Bulk Actions" sidebar section directly above Admin, visible at admin rank (60) and up, with a rank-gated `/bulk` route and an empty landing page ready to hold tool cards.

**Architecture:** Data-only change to `NAV_SECTIONS` (item-level `minRank`, the Processes precedent), one `ProtectedRoute minRank` route, one page component with an empty `BULK_TOOLS` seam.

**Tech Stack:** React 18, TypeScript, Vite, Vitest with jsdom.

Spec: `docs/superpowers/specs/2026-09-22-bulk-actions-nav-design.md`.

## Global Constraints

- Work in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-nav`, branch `bulk-actions-nav`. Never `cd` to the primary checkout. `portal/node_modules`, `api/.venv`, `.env` are symlinks; never install; never commit the `.env` symlink or `api/src/serversherpa/_dev_reload.py`.
- Portal tests: `npm --prefix portal run test` and `(cd portal && node_modules/.bin/tsc --noEmit)` before committing; one file via `(cd portal && node_modules/.bin/vitest run <path>)`.
- Section label `Bulk Actions`, inserted immediately before the `Admin` section (after `Scanning Hardware`). Item `{ to: '/bulk', label: 'Bulk Actions', resource: 'dashboard', minRank: ADMIN_RANK, end: true }` with `ADMIN_RANK` imported from `../lib/access`.
- Page copy: eyebrow `Admin`, title `Bulk Actions`, hint `One place for the jobs that touch many records at once.`, empty state `Nothing here yet` / `Bulk tools will appear here as they are added.`
- American English. Commit with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Ledger: `.superpowers/sdd/progress.md`.

---

### Task 1: Section, route, page, tests

**Files:**
- Modify: `portal/src/layout/navSections.tsx` (insert before the `Admin` section, ~line 499)
- Modify: `portal/src/App.tsx` (import + route next to `/system/processes`)
- Create: `portal/src/pages/BulkActions.tsx`
- Create: `portal/src/styles/bulk.css`
- Test: create `portal/src/layout/bulkActionsNav.test.tsx`, `portal/src/pages/BulkActions.test.tsx`

- [ ] **Step 1: Write the failing tests**

`portal/src/layout/bulkActionsNav.test.tsx`:

```tsx
/** Bulk Actions sits directly above Admin and is gated on admin rank. */
import { expect, it, vi } from 'vitest';

import { ADMIN_RANK } from '../lib/access';
import { isNavItemVisible } from '../lib/godmode';
import { NAV_SECTIONS } from './navSections';

it('sits immediately before Admin with one rank-gated item', () => {
  const labels = NAV_SECTIONS.map((s) => s.label);
  const idx = labels.indexOf('Bulk Actions');
  expect(idx).toBeGreaterThan(labels.indexOf('Scanning Hardware'));
  expect(labels[idx + 1]).toBe('Admin');
  const section = NAV_SECTIONS[idx];
  expect(section.items.map((i) => i.to)).toEqual(['/bulk']);
  expect(section.items[0].minRank).toBe(ADMIN_RANK);
});

it('hides below admin rank and shows at admin rank', () => {
  const item = NAV_SECTIONS.find((s) => s.label === 'Bulk Actions')!.items[0];
  const can = vi.fn(() => true);
  expect(isNavItemVisible(item, can, false, ADMIN_RANK - 1, true)).toBe(false);
  expect(isNavItemVisible(item, can, false, ADMIN_RANK, true)).toBe(true);
});
```

Read `portal/src/lib/godmode.ts` for `isNavItemVisible`'s exact parameter order and adjust the calls if it differs.

`portal/src/pages/BulkActions.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
afterEach(cleanup);
const { default: BulkActions } = await import('./BulkActions');

it('renders the empty state until tools are added', () => {
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Bulk Actions' })).toBeTruthy();
  expect(screen.getByText('Nothing here yet')).toBeTruthy();
  expect(screen.getByText('Bulk tools will appear here as they are added.')).toBeTruthy();
});
```

Run: `(cd portal && node_modules/.bin/vitest run src/layout/bulkActionsNav.test.tsx src/pages/BulkActions.test.tsx)` → FAIL.

- [ ] **Step 2: Nav section**

In `portal/src/layout/navSections.tsx`, add `import { ADMIN_RANK } from '../lib/access';` (check the file's existing imports; if `lib/access` is already imported, extend it). Insert before the object whose `label` is `'Admin'`:

```tsx
  {
    label: 'Bulk Actions',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
        <path d="m4 12 8 4.5 8-4.5" />
        <path d="m4 16.5 8 4.5 8-4.5" />
      </svg>
    ),
    items: [
      {
        to: '/bulk',
        label: 'Bulk Actions',
        resource: 'dashboard',
        minRank: ADMIN_RANK,
        end: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="6" rx="1.5" />
            <rect x="3" y="14" width="18" height="6" rx="1.5" />
          </svg>
        ),
      },
    ],
  },
```

- [ ] **Step 3: Page** — create `portal/src/pages/BulkActions.tsx`:

```tsx
/**
 * Bulk Actions — the launcher for jobs that touch many records at once.
 * Admin rank and up (the route and the nav item are both gated on
 * ADMIN_RANK). Tools are added as BULK_TOOLS entries; each renders a card
 * whose action either navigates to an existing page or opens an existing
 * dialog in place.
 */
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import '../styles/bulk.css';

export interface BulkTool {
  key: string;
  title: string;
  description: string;
  /** Hides the card when the viewer lacks this resource:action. */
  resource?: string;
  action?: 'view' | 'add' | 'change' | 'delete';
  /** Either navigate somewhere or run something in place. */
  to?: string;
  run?: () => void;
  button: string;
}

export const BULK_TOOLS: BulkTool[] = [];

export default function BulkActions() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const tools = BULK_TOOLS.filter((t) => !t.resource || can(t.resource, t.action ?? 'view'));

  return (
    <div className="portal-page">
      <div className="eyebrow">Admin</div>
      <h1 className="page-title">Bulk Actions</h1>
      <p className="page-hint">One place for the jobs that touch many records at once.</p>

      {tools.length === 0 ? (
        <div className="dir-empty"><b>Nothing here yet</b>Bulk tools will appear here as they are added.</div>
      ) : (
        <div className="bulk-grid">
          {tools.map((t) => (
            <div key={t.key} className="bulk-card">
              <b>{t.title}</b>
              <p className="page-hint">{t.description}</p>
              <button className="btn-solid" onClick={() => (t.to ? navigate(t.to) : t.run?.())}>
                {t.button}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

`portal/src/styles/bulk.css`:

```css
/* Bulk Actions launcher — a grid of tool cards. */
.bulk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-top: 16px; }
.bulk-card { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 12px; background: var(--surface); border: 1px solid var(--c-slate-bd, rgba(81, 96, 111, 0.25)); }
.bulk-card .btn-solid { align-self: flex-start; }
```

- [ ] **Step 4: Route** — in `portal/src/App.tsx` add `import BulkActions from './pages/BulkActions';` in alphabetical position among the page imports and `import { ADMIN_RANK } from './lib/access';` if not already imported; next to the `/system/processes` route add:

```tsx
                <Route path="/bulk" element={
                  <ProtectedRoute minRank={ADMIN_RANK}><BulkActions /></ProtectedRoute>
                } />
```

- [ ] **Step 5: Run the suite and type check**

Run: `npm --prefix portal run test` then `(cd portal && node_modules/.bin/tsc --noEmit)`
Expected: all PASS, tsc clean. The list-typography guardrail may object to `.bulk-card b` styling if you add typography; the CSS above sets none.

- [ ] **Step 6: Commit**

```bash
git add portal/src
git commit -m "feat(portal): Bulk Actions nav section above Admin, admin-rank gated, with an empty launcher page"
```
