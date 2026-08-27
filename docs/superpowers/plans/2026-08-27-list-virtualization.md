# List Virtualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every standard list handles 100k+ rows: shared `VirtualRows` primitive + memoized search haystacks rolled out to all 12 standard-list surfaces, gzip on the API, verified against a 100k-row seed.

**Architecture:** Headless `@tanstack/react-virtual` behind a render-prop component that spreads positioning props onto each page's existing `.dir-row` (no wrapper DOM). Plain render below 300 rows. Scroll container is `.portal-main`. Spec: `docs/superpowers/specs/2026-08-27-list-virtualization-design.md`.

**Tech Stack:** React 18 / TypeScript / Vite / vitest (jsdom available); FastAPI.

## Global Constraints

- No visual or behavioral change to the standard-list UX besides windowed rendering: column menus, sorting, filtering, export, persistence, god-edit, pending-deletes, row expansion, deep-link focus all keep working identically.
- `VirtualRows` renders the plain full list when `rows.length <= 300`.
- No wrapper element around `.dir-row` in virtual mode — `virtualProps` spread onto the row div itself.
- Conversions are mechanical and per-page identical; do not restructure pages while converting.
- Never commit `api/src/serversherpa/_dev_reload.py`.
- Suites: portal `npm test` + `npm run build`; API `.venv/bin/python -m pytest -q` from `api/` (foreground, long timeout). Commit after each task with the `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.

---

### Task 1: `VirtualRows` + `useSearchHaystacks` + reference conversion (RawScansTab) at 100k

**Files:**
- Modify: `portal/package.json` (+`@tanstack/react-virtual`)
- Create: `portal/src/lib/virtualRows.tsx`
- Modify: `portal/src/lib/listTools.tsx` (append `useSearchHaystacks`)
- Modify: `portal/src/components/scans/RawScansTab.tsx` (reference conversion)
- Test: `portal/src/lib/virtualRows.test.tsx`

**Interfaces produced (used verbatim by every later conversion):**

```tsx
// portal/src/lib/virtualRows.tsx
export interface VirtualRowProps {
  ref: (el: HTMLElement | null) => void;
  style: CSSProperties;
  'data-index': number;
}
export const VIRTUAL_THRESHOLD = 300;
export function VirtualRows<T>(props: {
  rows: T[];
  renderRow: (row: T, vp?: VirtualRowProps) => ReactNode;
}): ReactNode;
// renderRow's returned .dir-row element must carry the React key itself
// (key={row.id}) — VirtualRows returns it directly, with no wrapper element.
```

```tsx
// listTools.tsx
export function useSearchHaystacks<T>(
  rows: T[] | null, text: (row: T) => string,
): (row: T) => string;
```

- [ ] **Step 1: Install the dependency**

From `portal/`: `npm install @tanstack/react-virtual` (v3.x lands in dependencies).

- [ ] **Step 2: Write the failing tests**

Create `portal/src/lib/virtualRows.test.tsx` (jsdom, like ComboBox.test.tsx — check that file's setup/imports for the house render pattern; use @testing-library/react if present, otherwise createRoot + act):

```tsx
// Behavior pinned:
// 1. rows.length <= VIRTUAL_THRESHOLD renders EVERY row, no positioning props.
// 2. rows.length > VIRTUAL_THRESHOLD renders a subset (fewer than rows.length,
//    more than zero) inside a spacer div whose height equals
//    rows.length * estimate; rendered rows carry data-index + absolute style.
// Rows render as <div className="dir-row" data-id={r} {...vp} style={vp?.style}>.
```

Write the two tests accordingly (render 10 rows → expect 10 `.dir-row`s; render 1000 rows → expect `document.querySelectorAll('.dir-row').length` > 0 and < 1000, and the spacer div's `style.height` to be set). Run and watch them fail (module missing).

- [ ] **Step 3: Implement `VirtualRows`**

```tsx
/**
 * VirtualRows — windowed rendering for the standard directory lists.
 * Headless wrapper over @tanstack/react-virtual: pages keep their own
 * .dir-row markup and spread `vp` (ref/style/data-index) onto it, so
 * there is no wrapper element and row CSS/semantics are untouched.
 * Below VIRTUAL_THRESHOLD rows it renders the plain full list (keeps
 * browser find-in-page for small lists). Dynamic row measurement
 * (ResizeObserver) tracks the expansion animation. The scroll container
 * is .portal-main (lists scroll inside it, not the window).
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode,
} from 'react';

export const VIRTUAL_THRESHOLD = 300;
const ESTIMATED_ROW_PX = 58;

export interface VirtualRowProps {
  ref: (el: HTMLElement | null) => void;
  style: CSSProperties;
  'data-index': number;
}

export function VirtualRows<T>({ rows, rowKey, renderRow }: {
  rows: T[];
  rowKey: (row: T) => string | number;
  renderRow: (row: T, vp?: VirtualRowProps) => ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [margin, setMargin] = useState(0);

  const virtual = rows.length > VIRTUAL_THRESHOLD;

  // The list's offset from the top of the scroller's content — stable
  // after mount (toolbar/header above it have fixed heights).
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const scroller = el?.closest('.portal-main');
    if (el && scroller) {
      setMargin(el.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top + scroller.scrollTop);
    }
  }, [virtual]);

  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () =>
      (wrapRef.current?.closest('.portal-main') as HTMLElement | null) ?? null,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: 12,
    scrollMargin: margin,
  });

  if (!virtual) return <>{rows.map((r) => renderRow(r))}</>;

  return (
    <div ref={wrapRef}
         style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const row = rows[vi.index];
        return (
          <span key={rowKey(row)} style={{ display: 'contents' }}>
            {renderRow(row, {
              ref: virtualizer.measureElement,
              'data-index': vi.index,
              style: {
                position: 'absolute', top: 0, left: 0, width: '100%',
                transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              },
            })}
          </span>
        );
      })}
    </div>
  );
}
```

Note the plain path also needs `wrapRef` mounted for the threshold crossover: wrap the plain render too if the margin effect misbehaves when a filter drops rows below threshold and back — simplest correct form is to always render `<div ref={wrapRef}>` around both branches with no styles in plain mode. Use your judgment, keep the two-branch behavior pinned by the tests.

- [ ] **Step 4: Implement `useSearchHaystacks`** (append to `listTools.tsx`)

```tsx
/** Precomputed lowercase search haystacks — one build per rows array
 *  instead of one per row per keystroke (matters at 100k rows). */
export function useSearchHaystacks<T>(
  rows: T[] | null, text: (row: T) => string,
): (row: T) => string {
  return useMemo(() => {
    const m = new Map<T, string>();
    rows?.forEach((r) => m.set(r, text(r)));
    return (row: T) => m.get(row) ?? text(row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
}
```

- [ ] **Step 5: Reference conversion — RawScansTab**

In `portal/src/components/scans/RawScansTab.tsx`:
- `const haystack = useSearchHaystacks(scans, rawScanSearchText);` and in the `visible` memo replace `rawScanSearchText(r).includes(q)` with `haystack(r).includes(q)` (add `haystack` to the memo deps).
- Replace the row loop:

```tsx
<VirtualRows rows={visible}
  renderRow={(r, vp) => {
    const open = openId === r.id;
    return (
      <div key={r.id} className={`dir-row ${open ? 'open' : ''}`}
           {...vp} style={vp?.style}>
        {/* existing row-main + detail JSX unchanged */}
      </div>
    );
  }} />
```

(The existing `visible.map` body moves inside `renderRow` unchanged.)

- [ ] **Step 6: Seed dev raw_scans to 100k**

Re-run the generator from `/private/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/848bd499-e8af-4bc9-b1d1-2d348a3310a1/scratchpad/seed_raw_scans.sql` adjusted to `generate_series(1, 95000)` (values/devices/dates distributions as-is), via `docker compose -f docker-compose.dev.yml exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`. Confirm `SELECT count(*) FROM raw_scans` ≈ 100k.

- [ ] **Step 7: Verify**

`npm test` + `npm run build` clean. Browser (launch.json `api`; portal dev server may already be running on 5173 — open the URL directly if `preview_start {name:"portal"}` reports the port busy): /admin/scans Raw tab at ~100k rows — page loads, badge shows the count, scrolling is smooth top→bottom→middle, `document.querySelectorAll('.dir-row').length` stays small (< 60) while scrolled, typing in the filter narrows instantly, row expansion opens/closes correctly mid-list, sort by Value works (a click may take ~a few hundred ms — acceptable), CSV export still exports the filtered set (do it with a filter applied to keep the file reasonable). Record rough timings in your report (initial fetch+render, keystroke latency).

- [ ] **Step 8: Commit**

`feat(portal): VirtualRows windowed rendering + search haystacks; raw scans at 100k`

---

### Task 2: Convert ProcessedScansTab

**Files:** `portal/src/components/scans/ProcessedScansTab.tsx`

Same recipe as Task 1 Step 5: `useSearchHaystacks(scans, processedScanSearchText)` in the `visible` memo; wrap the row loop in `VirtualRows`, spreading `vp` onto the `.dir-row` div (keep the `archived`/`open` class logic intact). Verify in browser with god mode: expansion, god-edit combo dropdowns (they must not clip/mis-position inside transformed rows — if they do, report it, don't improvise), god-delete, `?open=` deep link. `npm test` + build clean. Commit: `feat(portal): virtualize processed scans list`.

---

### Task 3: Rollout batch A — Assets, Containers, Sites, AssetModels

**Files:** `portal/src/pages/Assets.tsx`, `Containers.tsx`, `Sites.tsx`, `AssetModels.tsx`

Apply the identical recipe to each page: add `useSearchHaystacks(<rows>, <entity>SearchText)` into the page's `visible` memo, and wrap its row loop in `VirtualRows` with `vp` spread on the `.dir-row` div. Do not touch anything else in these files. These lists are usually < 300 rows, so the plain branch renders — verify each page still renders and expands in the browser (a quick load + one row expansion per page suffices), `npm test` + build clean. Commit: `feat(portal): virtualize assets/containers/sites/asset-models lists`.

---

### Task 4: Rollout batch B — Initiatives, InitiativeDetail, Users, Workers, External, OrgDirectory

**Files:** `portal/src/pages/Initiatives.tsx`, `InitiativeDetail.tsx`, `Users.tsx`, `Workers.tsx`, `External.tsx`, `OrgDirectory.tsx`

Same recipe. `InitiativeDetail` hosts an embedded assets list — convert that list's row loop; if its scroll container is not `.portal-main`, note it and leave that one page unconverted rather than guessing (report as a concern). Browser spot-check each page. `npm test` + build clean. Commit: `feat(portal): virtualize remaining standard lists`.

---

### Task 5: API — gzip + 100k endpoint measurement

**Files:** `api/src/serversherpa/api/app.py`; test `api/tests/test_cors_dev.py` neighborhood only if a gzip test is added.

- Add to `create_app()` after the CORS middleware:

```python
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1024)
```

- Measure against the dev API (100k rows seeded): `curl -s -o /dev/null -w '%{time_total}s %{size_download} bytes\n' -H "Authorization: Bearer <token>" http://localhost:8000/scans/raw` with and without `-H 'Accept-Encoding: gzip'` (obtain a token the way the browser does, or measure via the browser's network panel if simpler; the Task 6/7 reports in .superpowers/sdd/ describe dev sign-in). Record: payload size raw vs gzipped, total server time.
- If server time > ~2 s, do NOT optimize now — record the number and the suggested follow-up (dict + ORJSONResponse) in your report.
- Full API suite once (`.venv/bin/python -m pytest -q`, foreground, long timeout) — gzip middleware must not break any test. Commit: `feat(api): gzip responses (100k scan payloads)`.

---

### Task 6: Full verification

- API full suite, portal `npm test` + `npm run build` — all clean.
- Browser: one pass over /admin/scans (both tabs at scale) + two batch-A/B pages.
- No commit unless fixes were needed.
