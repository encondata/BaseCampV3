# Column Display Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can drag-reorder the columns of every record list (in the Columns popover and on the headers themselves), and the order persists per page in `preferences.list_prefs` exactly like column visibility.

**Architecture:** A pure `applyColumnOrder` helper reorders each page's static `ColumnDef[]` by a persisted `order: string[]`; `usePersistentListState` hydrates/saves that field alongside `visible`/`sortKey`/`sortDir`/`filters`. One shared `useReorderDrag` hook provides HTML5 drag-and-drop props for both surfaces (popover rows, axis `y`; header cells, axis `x`); both commit through `moveKey`, which moves one key relative to another in the full ordered key list.

**Tech Stack:** React 18 + TypeScript (Vite), vitest + @testing-library/react (jsdom), no new dependencies. No API changes — the existing preferences PATCH already accepts arbitrary JSON under `list_prefs`.

**Spec:** `docs/superpowers/specs/2026-08-25-column-order-design.md`

## Global Constraints

- All commands run from `portal/` (`cd /Users/jrh1812/Developer/BaseCampV3/portal`).
- Test runner: `npm test -- <file>` (vitest). Full build/typecheck: `npm run build`.
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The lead column (`primary`, the `2.2fr` name cell) and the trailing `30px` chevron column are never reorderable and never appear in `order`.
- Match surrounding code style: 2-space indent, comment density and tone of `lib/listTools.tsx` / `lib/columnMenu.tsx` (comments state constraints, not narration).
- One deliberate deviation from the spec: `ColumnsButton` needs no `order` prop — pages pass already-ordered columns; it only gains optional `onReorder`. `useHeaderDrag` in the spec is generalized here to `useReorderDrag(onMove, axis, opts)` so one hook serves both surfaces.

---

### Task 1: `applyColumnOrder` + `moveKey` pure helpers

**Files:**
- Modify: `src/lib/listTools.tsx` (add after `visibleColumnsFor`, ~line 47)
- Test: `src/lib/listTools.test.tsx` (create)

**Interfaces:**
- Consumes: existing `ColumnDef` from `src/lib/listTools.tsx`.
- Produces: `applyColumnOrder(columns: ColumnDef[], order: string[]): ColumnDef[]` and `moveKey(keys: string[], src: string, dst: string, before: boolean): string[]`, both exported from `src/lib/listTools.tsx`. Tasks 2–13 rely on these exact names/signatures.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/listTools.test.tsx`:

```tsx
// @vitest-environment jsdom
/**
 * lib/listTools.tsx: the column-order helpers (applyColumnOrder, moveKey),
 * the useReorderDrag drag-and-drop hook, and ColumnsButton's reorder mode.
 */

import { describe, expect, it } from 'vitest';

import { applyColumnOrder, moveKey, type ColumnDef } from './listTools';

const col = (key: string): ColumnDef => ({ key, label: key, width: '1fr', default: true });
const COLS: ColumnDef[] = [col('a'), col('b'), col('c'), col('d')];
const keysOf = (cols: ColumnDef[]) => cols.map((c) => c.key);

describe('applyColumnOrder', () => {
  it('returns columns unchanged for an empty order', () => {
    expect(applyColumnOrder(COLS, [])).toEqual(COLS);
  });

  it('orders by the given full key order', () => {
    expect(keysOf(applyColumnOrder(COLS, ['c', 'a', 'd', 'b']))).toEqual(['c', 'a', 'd', 'b']);
  });

  it('appends columns missing from a partial order in their default relative order', () => {
    // 'b' and 'd' unmentioned — they trail in original (b before d) order.
    expect(keysOf(applyColumnOrder(COLS, ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ignores order keys that match no column', () => {
    expect(keysOf(applyColumnOrder(COLS, ['zzz', 'b', 'a']))).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('moveKey', () => {
  it('moves src before dst', () => {
    expect(moveKey(['a', 'b', 'c', 'd'], 'd', 'b', true)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves src after dst', () => {
    expect(moveKey(['a', 'b', 'c', 'd'], 'a', 'c', false)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('returns keys unchanged when src === dst or either is unknown', () => {
    expect(moveKey(['a', 'b'], 'a', 'a', true)).toEqual(['a', 'b']);
    expect(moveKey(['a', 'b'], 'zzz', 'b', true)).toEqual(['a', 'b']);
    expect(moveKey(['a', 'b'], 'a', 'zzz', true)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/listTools.test.tsx`
Expected: FAIL — `applyColumnOrder`/`moveKey` are not exported.

- [ ] **Step 3: Implement the helpers**

In `src/lib/listTools.tsx`, directly after `visibleColumnsFor` (after line 47), add:

```tsx
/** Reorder `columns` by a persisted key order. Keys in `order` come first,
 *  in that order; columns the order doesn't mention (e.g. added to the
 *  codebase after the user saved) keep their default relative order,
 *  appended after the ordered ones. Unknown keys in `order` are skipped.
 *  Empty order = default order. */
export function applyColumnOrder(columns: ColumnDef[], order: string[]): ColumnDef[] {
  if (order.length === 0) return columns;
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const ordered = order
    .map((k) => byKey.get(k))
    .filter((c): c is ColumnDef => Boolean(c));
  const placed = new Set(order);
  return [...ordered, ...columns.filter((c) => !placed.has(c.key))];
}

/** Move `src` to sit before/after `dst` in a full ordered key list. Both
 *  reorder surfaces (Columns-menu rows, header dragging) commit through
 *  this, always over the COMPLETE key list — so one reorder converges a
 *  partial stored order into a full one, and moving a visible column never
 *  loses the position of hidden ones. */
export function moveKey(keys: string[], src: string, dst: string, before: boolean): string[] {
  if (src === dst || !keys.includes(src)) return keys;
  const without = keys.filter((k) => k !== src);
  const at = without.indexOf(dst);
  if (at < 0) return keys;
  const next = [...without];
  next.splice(before ? at : at + 1, 0, src);
  return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/listTools.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/listTools.tsx src/lib/listTools.test.tsx
git commit -m "feat(portal): applyColumnOrder + moveKey column-order helpers"
```

---

### Task 2: persist `order` in `usePersistentListState`

**Files:**
- Modify: `src/lib/columnMenu.tsx` (StoredListPrefs ~line 292, `sanitize` ~line 306, hook ~line 355)
- Test: `src/lib/columnMenu.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `usePersistentListState` additionally returns `colOrder: string[]` and `setColOrder: (next: string[]) => void`; the saved `list_prefs[pageKey]` payload gains `order: string[]`. Tasks 5–13 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

In `src/lib/columnMenu.test.tsx`, find the existing `usePersistentListState` describe block (search for `describe('usePersistentListState'`) and add these tests inside it, following the block's existing setup conventions (the mocked `auth` object, `renderHook`, timer helpers already in the file):

```tsx
  it('hydrates order from stored prefs, dropping unknown keys and junk', () => {
    auth.preferences.list_prefs = {
      pk: { order: ['site', 'ghost', 42, 'name'] },
    };
    const { result } = renderHook(() => usePersistentListState('pk', {
      visible: new Set(['name', 'site']), sortKey: 'name', sortDir: 1,
    }));
    expect(result.current.colOrder).toEqual(['site', 'name']);
  });

  it('hydrates an empty order when none is stored', () => {
    auth.preferences.list_prefs = { pk: { visible: ['name'] } };
    const { result } = renderHook(() => usePersistentListState('pk', {
      visible: new Set(['name', 'site']), sortKey: 'name', sortDir: 1,
    }));
    expect(result.current.colOrder).toEqual([]);
  });

  it('saves order changes through the debounced merge-save', async () => {
    auth.preferences.list_prefs = {};
    vi.useFakeTimers();
    const { result } = renderHook(() => usePersistentListState('pk', {
      visible: new Set(['name', 'site']), sortKey: 'name', sortDir: 1,
    }));
    act(() => result.current.setColOrder(['site', 'name']));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    vi.useRealTimers();
    expect(auth.updatePreferences).toHaveBeenCalled();
    const saved = auth.updatePreferences.mock.calls.at(-1)![0];
    expect((saved.list_prefs as Record<string, { order?: string[] }>).pk.order)
      .toEqual(['site', 'name']);
  });
```

If the existing block uses different fake-timer or `auth` reset helpers (e.g. a `beforeEach` that reassigns `auth.preferences.list_prefs` or an existing `flush` helper), match those instead of the raw `vi.useFakeTimers` calls above — behavior asserted must stay the same.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/columnMenu.test.tsx`
Expected: the three new tests FAIL (`colOrder` undefined); all pre-existing tests still PASS.

- [ ] **Step 3: Implement**

In `src/lib/columnMenu.tsx`:

a) `StoredListPrefs` (~line 292) — add the field:

```ts
interface StoredListPrefs {
  visible?: unknown;
  sortKey?: unknown;
  sortDir?: unknown;
  filters?: unknown;
  order?: unknown;
}
```

b) `sanitize` (~line 306) — extend the return type with `order: string[]` and add before the final `return`:

```ts
  let order: string[] = [];
  if (Array.isArray(stored.order)) {
    order = stored.order.filter((k): k is string => typeof k === 'string' && known.has(k));
  }
```

…and include it: `return { visible, sortKey, sortDir, filters, order };`

c) In `usePersistentListState`, after the `filters` state initializer (~line 382), add:

```ts
  // Display order for the page's columns. Empty = the page's default
  // (ColumnDef[] source order); applyColumnOrder treats it that way.
  const [colOrder, setColOrderState] = useState<string[]>(() => {
    const stored = preferences.list_prefs?.[pageKey];
    if (!stored || typeof stored !== 'object') return [];
    return sanitize(stored as StoredListPrefs, known, defaults).order;
  });
```

d) In the debounced save payload (inside `save`, ~line 407), add `order: colOrder,` after `filters,` — and add `colOrder` to the effect's dependency array:

```ts
  }, [pageKey, updatePreferences, visibleCols, sort, filters, colOrder]);
```

e) After the `setFilter`/`clearFilters` callbacks, add:

```ts
  const setColOrder = useCallback((next: string[]) => {
    setColOrderState(next);
  }, []);
```

f) Extend the hook's return object:

```ts
  return {
    visibleCols, setVisibleCols,
    sortKey: sort.key, sortDir: sort.dir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/columnMenu.test.tsx`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/columnMenu.tsx src/lib/columnMenu.test.tsx
git commit -m "feat(portal): persist column display order in list prefs"
```

---

### Task 3: `useReorderDrag` hook + drag/drop CSS

**Files:**
- Modify: `src/lib/listTools.tsx` (add hook after `moveKey`)
- Modify: `src/styles/column-menu.css` (append)
- Test: `src/lib/listTools.test.tsx`

**Interfaces:**
- Consumes: React `useState`; `moveKey` is NOT consumed here — callers pass an `onMove` callback.
- Produces (exported from `src/lib/listTools.tsx`):

```ts
export function useReorderDrag(
  onMove: (src: string, dst: string, before: boolean) => void,
  axis: 'x' | 'y',
  opts?: { ignoreFrom?: string },
): {
  dragProps: (key: string) => JSX.IntrinsicElements['span'];  // draggable + 5 drag handlers
  dropClass: (key: string) => string;                          // '' | 'drag-src' | 'drop-before' | 'drop-after'
}
```

CSS classes `drag-src`, `drop-before`, `drop-after`, `pop-grip` in `column-menu.css`. Tasks 4–13 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/listTools.test.tsx` (extend the imports at the top of the file to `import { applyColumnOrder, moveKey, useReorderDrag, type ColumnDef } from './listTools';` and add `import { cleanup, fireEvent, render, screen } from '@testing-library/react';`, `import { afterEach, vi } from 'vitest';` merged into the existing vitest import, plus `afterEach(cleanup);` after the imports):

```tsx
/** Renders one span per key wired to useReorderDrag, so tests can fire
 *  real drag events. jsdom rects are all-zero, so tests stub
 *  getBoundingClientRect and steer before/after with clientX/clientY. */
function DragHarness({ onMove, axis }: {
  onMove: (src: string, dst: string, before: boolean) => void;
  axis: 'x' | 'y';
}) {
  const { dragProps, dropClass } = useReorderDrag(onMove, axis, { ignoreFrom: '.pop-menu' });
  return (
    <div>
      {['a', 'b', 'c'].map((k) => (
        <span key={k} data-testid={k} className={dropClass(k)} {...dragProps(k)}>{k}</span>
      ))}
    </div>
  );
}

const dt = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' });

describe('useReorderDrag', () => {
  it('drops before the target left half (x axis) and reports before=true', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 100, top: 0, width: 50, height: 20, right: 150, bottom: 20, x: 100, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    const onMove = vi.fn();
    render(<DragHarness onMove={onMove} axis="x" />);
    fireEvent.dragStart(screen.getByTestId('c'), { dataTransfer: dt() });
    fireEvent.dragOver(screen.getByTestId('a'), { clientX: 110, dataTransfer: dt() }); // left half
    fireEvent.drop(screen.getByTestId('a'), { dataTransfer: dt() });
    expect(onMove).toHaveBeenCalledWith('c', 'a', true);
    vi.restoreAllMocks();
  });

  it('drops after the target bottom half (y axis) and reports before=false', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 100, width: 50, height: 20, right: 50, bottom: 120, x: 0, y: 100, toJSON: () => ({}) } as DOMRect,
    );
    const onMove = vi.fn();
    render(<DragHarness onMove={onMove} axis="y" />);
    fireEvent.dragStart(screen.getByTestId('a'), { dataTransfer: dt() });
    fireEvent.dragOver(screen.getByTestId('b'), { clientY: 115, dataTransfer: dt() }); // bottom half
    fireEvent.drop(screen.getByTestId('b'), { dataTransfer: dt() });
    expect(onMove).toHaveBeenCalledWith('a', 'b', false);
    vi.restoreAllMocks();
  });

  it('marks the source and the hovered drop side via dropClass', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 100, top: 0, width: 50, height: 20, right: 150, bottom: 20, x: 100, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    render(<DragHarness onMove={vi.fn()} axis="x" />);
    fireEvent.dragStart(screen.getByTestId('b'), { dataTransfer: dt() });
    expect(screen.getByTestId('b').className).toBe('drag-src');
    fireEvent.dragOver(screen.getByTestId('c'), { clientX: 140, dataTransfer: dt() }); // right half
    expect(screen.getByTestId('c').className).toBe('drop-after');
    fireEvent.dragEnd(screen.getByTestId('b'), { dataTransfer: dt() });
    expect(screen.getByTestId('b').className).toBe('');
    expect(screen.getByTestId('c').className).toBe('');
    vi.restoreAllMocks();
  });

  it('never calls onMove when the drop target is the source itself', () => {
    const onMove = vi.fn();
    render(<DragHarness onMove={onMove} axis="x" />);
    fireEvent.dragStart(screen.getByTestId('a'), { dataTransfer: dt() });
    fireEvent.drop(screen.getByTestId('a'), { dataTransfer: dt() });
    expect(onMove).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/listTools.test.tsx`
Expected: new tests FAIL (`useReorderDrag` not exported); Task 1 tests still PASS.

- [ ] **Step 3: Implement the hook**

In `src/lib/listTools.tsx`, extend the react import to include `DragEvent`:

```ts
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
```

Add after `moveKey`:

```tsx
/** HTML5 drag-and-drop reordering shared by both reorder surfaces: rows in
 *  the Columns popover (axis 'y') and the list header cells (axis 'x').
 *  The hook only tracks the gesture and reports (src, dst, before) on
 *  drop — callers commit via moveKey over their full ordered key list.
 *
 *  `opts.ignoreFrom`: a CSS selector; a drag starting inside a matching
 *  ancestor is cancelled. Headers pass '.pop-menu' so dragging inside an
 *  open column-funnel popover (rendered within the header span) never
 *  hijacks the pointer. Plain clicks are untouched either way — HTML5
 *  drag only engages on actual drag movement. */
export function useReorderDrag(
  onMove: (src: string, dst: string, before: boolean) => void,
  axis: 'x' | 'y',
  opts?: { ignoreFrom?: string },
) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ key: string; before: boolean } | null>(null);

  const dragProps = (key: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      if (opts?.ignoreFrom && (e.target as HTMLElement).closest?.(opts.ignoreFrom)) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', key); // Firefox refuses to start a drag with no data
      setDrag(key);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!drag || drag === key) return;
      e.preventDefault(); // required for the element to be a drop target
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const before = axis === 'x'
        ? e.clientX < rect.left + rect.width / 2
        : e.clientY < rect.top + rect.height / 2;
      setOver((prev) => (prev?.key === key && prev.before === before ? prev : { key, before }));
    },
    onDragLeave: () => {
      setOver((prev) => (prev?.key === key ? null : prev));
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      if (drag && drag !== key && over?.key === key) onMove(drag, key, over.before);
      setDrag(null);
      setOver(null);
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
    },
  });

  const dropClass = (key: string) => {
    if (key === drag) return 'drag-src';
    if (over?.key === key) return over.before ? 'drop-before' : 'drop-after';
    return '';
  };

  return { dragProps, dropClass };
}
```

- [ ] **Step 4: Add the CSS**

Append to `src/styles/column-menu.css`:

```css
/* ── drag-to-reorder (Columns-menu rows + list header cells) ─────── */
.pop-grip {
  display: inline-flex;
  flex: none;
  width: 8px;
  color: var(--text-mute);
  cursor: grab;
  opacity: 0.6;
}
.pop-item.drag-src,
.list-head .col-head.drag-src { opacity: 0.4; }
/* insertion line on the side the drop will land */
.pop-item.drop-before { box-shadow: inset 0 2px 0 var(--accent); }
.pop-item.drop-after  { box-shadow: inset 0 -2px 0 var(--accent); }
.list-head .col-head.drop-before { box-shadow: inset 2px 0 0 var(--accent); }
.list-head .col-head.drop-after  { box-shadow: inset -2px 0 0 var(--accent); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/lib/listTools.test.tsx`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/listTools.tsx src/lib/listTools.test.tsx src/styles/column-menu.css
git commit -m "feat(portal): useReorderDrag shared drag-to-reorder hook"
```

---

### Task 4: `ColumnsButton` reorder mode

**Files:**
- Modify: `src/lib/listTools.tsx` (`ColumnsButton`, ~line 155)
- Test: `src/lib/listTools.test.tsx`

**Interfaces:**
- Consumes: `useReorderDrag`, `moveKey` (Task 1/3).
- Produces: `ColumnsButton` gains optional prop `onReorder?: (next: string[]) => void`. When set, rows get a grip and are draggable; a drop emits the FULL new key order of the `columns` prop (including god-only columns not currently offered). Pages will pass their ordered columns as `columns` and `setColOrder` as `onReorder`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/listTools.test.tsx` (add `ColumnsButton` to the `./listTools` import):

```tsx
describe('ColumnsButton reorder', () => {
  const BTN_COLS: ColumnDef[] = [col('a'), col('b'), col('c')];

  it('emits the full new order when a row is dropped on another', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 100, width: 50, height: 20, right: 50, bottom: 120, x: 0, y: 100, toJSON: () => ({}) } as DOMRect,
    );
    const onReorder = vi.fn();
    render(
      <ColumnsButton columns={BTN_COLS} visible={new Set(['a', 'b', 'c'])}
                     onChange={vi.fn()} onReorder={onReorder} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    // Exact-string names — a regex like /c/ would also match the "Columns" toggle.
    const rowC = screen.getByRole('button', { name: 'c' });
    const rowA = screen.getByRole('button', { name: 'a' });
    fireEvent.dragStart(rowC, { dataTransfer: dt() });
    fireEvent.dragOver(rowA, { clientY: 105, dataTransfer: dt() }); // top half → before
    fireEvent.drop(rowA, { dataTransfer: dt() });
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b']);
    vi.restoreAllMocks();
  });

  it('still toggles visibility on click, and shows no grip without onReorder', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ColumnsButton columns={BTN_COLS} visible={new Set(['a'])} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    expect(container.querySelector('.pop-grip')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'b' }));
    expect(onChange).toHaveBeenCalledWith(new Set(['a', 'b']));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/listTools.test.tsx`
Expected: first new test FAILS (no `onReorder` prop / no drag handling). The toggle test may pass already except the grip assertion — that's fine.

- [ ] **Step 3: Implement**

Replace `ColumnsButton` in `src/lib/listTools.tsx` with:

```tsx
export function ColumnsButton({ columns, visible, onChange, godMode, onReorder }: {
  columns: ColumnDef[];
  visible: Set<string>;
  onChange: (next: Set<string>) => void;
  godMode?: boolean;
  /** When set, rows are drag-reorderable; a drop emits the FULL new key
   *  order of `columns` (offered or not), so a partial persisted order
   *  becomes complete on the first reorder. Pass display-ordered columns
   *  so the list reads in on-screen order. */
  onReorder?: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose<HTMLDivElement>(() => setOpen(false));
  const { dragProps, dropClass } = useReorderDrag(
    (src, dst, before) => onReorder?.(moveKey(columns.map((c) => c.key), src, dst, before)),
    'y',
  );

  const toggle = (key: string) => {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange(next);
  };

  const offered = columns.filter((c) => !c.godOnly || godMode);

  return (
    <div className="pop-wrap" ref={ref}>
      <button className="btn-ghost" onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round"><path d="M9 3v18M15 3v18M3 5.5h18M3 5.5v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-13a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z" /></svg>
        Columns
      </button>
      {open && (
        <div className="pop-menu">
          <div className="pop-title">Visible columns</div>
          {offered.map((c) => {
            const on = visible.has(c.key);
            return (
              <button key={c.key}
                      className={`pop-item ${on ? 'on' : ''} ${onReorder ? dropClass(c.key) : ''}`}
                      {...(onReorder ? dragProps(c.key) : {})}
                      onClick={() => toggle(c.key)}>
                {onReorder && (
                  <span className="pop-grip" aria-hidden="true">
                    <svg viewBox="0 0 8 12" fill="currentColor">
                      <circle cx="2.5" cy="2" r="1.1" /><circle cx="5.5" cy="2" r="1.1" />
                      <circle cx="2.5" cy="6" r="1.1" /><circle cx="5.5" cy="6" r="1.1" />
                      <circle cx="2.5" cy="10" r="1.1" /><circle cx="5.5" cy="10" r="1.1" />
                    </svg>
                  </span>
                )}
                <span className="pop-check">{CHECK}</span>
                {c.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/listTools.test.tsx`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/listTools.tsx src/lib/listTools.test.tsx
git commit -m "feat(portal): drag-to-reorder rows in the Columns popover"
```

---

### Task 5: wire Sites

**Files:**
- Modify: `src/pages/Sites.tsx` (~lines 43–48 imports, ~170–176 hook destructure, ~255 shownCols, ~362 ColumnsButton, ~389–390 header span)

**Interfaces:**
- Consumes: `colOrder`/`setColOrder` (Task 2), `applyColumnOrder`, `moveKey`, `useReorderDrag` (Tasks 1/3), `onReorder` prop (Task 4).
- Produces: nothing for later tasks — Tasks 5–13 are independent of each other and all follow this exact pattern.

- [ ] **Step 1: Add imports**

In the `from '../lib/listTools'` import block, add `applyColumnOrder`, `moveKey`, `useReorderDrag` (keep the list alphabetized like the surrounding imports).

- [ ] **Step 2: Pull order state from the hook**

In the `usePersistentListState` destructure (~line 170), add one line:

```ts
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'sites', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 }, ALL_COLUMN_KEYS,
  );
```

- [ ] **Step 3: Order the columns and create the header drag**

Replace (~line 255):

```ts
  const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);
```

with:

```ts
  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
```

NOTE: `useReorderDrag` is a hook — this replacement must stay in the component body's unconditional hook region (it already is: the existing line runs on every render, before the `return`). Body cells and the grid template already derive from `shownCols`, so no other render change is needed.

- [ ] **Step 4: Wire the Columns popover**

Change the `ColumnsButton` element (~line 362) to pass ordered columns and the reorder callback:

```tsx
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         godMode={godMode} onReorder={setColOrder} />
```

- [ ] **Step 5: Wire the header cells**

In the header row's `{shownCols.map((c) => (` block (~line 389), change only the span open tag:

```tsx
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
```

Leave the fixed lead (`primary`) span and the trailing `<span />` untouched.

- [ ] **Step 6: Verify**

Run: `npm test -- src/lib` and `npx tsc -b`
Expected: tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Sites.tsx
git commit -m "feat(portal): column display order on Sites"
```

---

### Task 6: wire Assets

**Files:**
- Modify: `src/pages/Assets.tsx` (imports; hook destructure ~line 152; `shownCols` ~line 253; ColumnsButton ~line 335; header span ~line 362)

Apply exactly the Task 5 pattern (identical markup, verified):

- [ ] **Step 1:** Add `applyColumnOrder`, `moveKey`, `useReorderDrag` to the `'../lib/listTools'` import.
- [ ] **Step 2:** Add `colOrder, setColOrder,` to the `usePersistentListState` destructure (page key `'assets'`).
- [ ] **Step 3:** Replace `const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);` with:

```ts
  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
```

- [ ] **Step 4:** ColumnsButton → `columns={orderedCols}` and add `onReorder={setColOrder}`.
- [ ] **Step 5:** Header map's span open tag →

```tsx
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
```

(Only the HEADER map at ~line 362 — the body-cell `shownCols.map` at ~line 410 is untouched.)

- [ ] **Step 6:** Run `npx tsc -b` — clean.
- [ ] **Step 7:** Commit:

```bash
git add src/pages/Assets.tsx
git commit -m "feat(portal): column display order on Assets"
```

---

### Task 7: wire AssetModels

**Files:**
- Modify: `src/pages/AssetModels.tsx` (imports; destructure ~line 146; `shownCols` ~line 215; ColumnsButton ~line 304; header span ~line 331)

- [ ] **Step 1:** Add `applyColumnOrder`, `moveKey`, `useReorderDrag` to the `'../lib/listTools'` import.
- [ ] **Step 2:** Add `colOrder, setColOrder,` to the `usePersistentListState` destructure (page key `'asset_models'`).
- [ ] **Step 3:** Replace `const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);` with:

```ts
  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
```

- [ ] **Step 4:** ColumnsButton → `columns={orderedCols}` and add `onReorder={setColOrder}`.
- [ ] **Step 5:** HEADER map's span open tag (~line 331; the body-cell map ~line 372 is untouched) →

```tsx
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
```

- [ ] **Step 6:** Run `npx tsc -b` — clean.
- [ ] **Step 7:** Commit:

```bash
git add src/pages/AssetModels.tsx
git commit -m "feat(portal): column display order on Asset models"
```

---

### Task 8: wire Containers

**Files:**
- Modify: `src/pages/Containers.tsx` (imports; destructure ~line 122; `shownCols` ~line 196; ColumnsButton ~line 268; header span ~line 300)

- [ ] **Step 1:** Add `applyColumnOrder`, `moveKey`, `useReorderDrag` to the `'../lib/listTools'` import.
- [ ] **Step 2:** Add `colOrder, setColOrder,` to the `usePersistentListState` destructure (the call here is multi-line; the destructure edit is the same one-line addition).
- [ ] **Step 3:** Replace `const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);` with:

```ts
  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
```

- [ ] **Step 4:** ColumnsButton → `columns={orderedCols}` and add `onReorder={setColOrder}`.
- [ ] **Step 5:** HEADER map's span open tag (~line 300) →

```tsx
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
```

- [ ] **Step 6:** Run `npx tsc -b` — clean.
- [ ] **Step 7:** Commit:

```bash
git add src/pages/Containers.tsx
git commit -m "feat(portal): column display order on Containers"
```

---

### Task 9: wire Workers

**Files:**
- Modify: `src/pages/Workers.tsx` (imports; destructure ~line 162; `shownCols` ~line 253; ColumnsButton ~line 317; header span ~line 342)

- [ ] **Step 1:** Add `applyColumnOrder`, `moveKey`, `useReorderDrag` to the `'../lib/listTools'` import.
- [ ] **Step 2:** Add `colOrder, setColOrder,` to the `usePersistentListState` destructure (page key `'workers'`).
- [ ] **Step 3:** Replace `const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);` with:

```ts
  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
```

- [ ] **Step 4:** ColumnsButton → `columns={orderedCols}` and add `onReorder={setColOrder}`.
- [ ] **Step 5:** HEADER map's span open tag (~line 342; the body-cell map ~line 386 is untouched) →

```tsx
            <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                  {...headerDrag.dragProps(c.key)}>
```

- [ ] **Step 6:** Run `npx tsc -b` — clean.
- [ ] **Step 7:** Commit:

```bash
git add src/pages/Workers.tsx
git commit -m "feat(portal): column display order on Workers"
```

---

### Task 10: wire External

**Files:**
- Modify: `src/pages/External.tsx` (imports; destructure ~line 177; `shownCols` ~line 310; ColumnsButton ~line 398; header span ~line 422)

- [ ] **Step 1:** Add `applyColumnOrder`, `moveKey`, `useReorderDrag` to the `'../lib/listTools'` import.
- [ ] **Step 2:** Add `colOrder, setColOrder,` to the `usePersistentListState` destructure (page key `'external'`).
- [ ] **Step 3:** Replace `const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);` with:

```ts
  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
```

- [ ] **Step 4:** ColumnsButton → `columns={orderedCols}` and add `onReorder={setColOrder}`.
- [ ] **Step 5:** HEADER map's span open tag (~line 422; the body-cell map ~line 462 is untouched) →

```tsx
            <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                  {...headerDrag.dragProps(c.key)}>
```

- [ ] **Step 6:** Run `npx tsc -b` — clean.
- [ ] **Step 7:** Commit:

```bash
git add src/pages/External.tsx
git commit -m "feat(portal): column display order on External systems"
```

---

### Task 11: wire Initiatives

**Files:**
- Modify: `src/pages/Initiatives.tsx` (imports ~line 55; destructure ~line 172; `shownCols` ~line 277; ColumnsButton ~lines 367–368; header span ~line 400)

- [ ] **Step 1:** Add `applyColumnOrder`, `moveKey`, `useReorderDrag` to the `'../lib/listTools'` import (~line 55).
- [ ] **Step 2:** Add `colOrder, setColOrder,` to the `usePersistentListState` destructure (page key `'initiatives'`, multi-line call).
- [ ] **Step 3:** Replace `const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);` with:

```ts
  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
```

- [ ] **Step 4:** ColumnsButton (already multi-line) →

```tsx
          <ColumnsButton columns={orderedCols} visible={visibleCols}
                         onChange={setVisibleCols} godMode={godMode}
                         onReorder={setColOrder} />
```

- [ ] **Step 5:** HEADER map's span open tag (~line 400) →

```tsx
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
```

- [ ] **Step 6:** Run `npx tsc -b` — clean.
- [ ] **Step 7:** Commit:

```bash
git add src/pages/Initiatives.tsx
git commit -m "feat(portal): column display order on Initiatives"
```

---

### Task 12: wire OrgDirectory (per-kind columns)

**Files:**
- Modify: `src/pages/OrgDirectory.tsx` (imports; destructure ~line 225; `shownCols` ~line 335; ColumnsButton ~line 457; header span ~line 482)

This page derives `columns` per kind (clients vs partners) via `useMemo` (~line 229) and persists under the per-kind page key `` `${cfg.kind}s` `` — so each kind keeps its own order automatically.

- [ ] **Step 1:** Add `applyColumnOrder`, `moveKey`, `useReorderDrag` to the `'../lib/listTools'` import.
- [ ] **Step 2:** Add `colOrder, setColOrder,` to the `usePersistentListState` destructure.
- [ ] **Step 3:** Replace `const shownCols = visibleColumnsFor(columns, visibleCols, godMode);` with:

```ts
  const orderedCols = applyColumnOrder(columns, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
```

- [ ] **Step 4:** ColumnsButton → `columns={orderedCols}`, add `onReorder={setColOrder}`.
- [ ] **Step 5:** HEADER map's span open tag (~line 482; the body-cell map ~line 532 is untouched) →

```tsx
            <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                  {...headerDrag.dragProps(c.key)}>
```
- [ ] **Step 6:** Run `npx tsc -b` — clean.
- [ ] **Step 7:** Commit:

```bash
git add src/pages/OrgDirectory.tsx
git commit -m "feat(portal): column display order on Clients/Partners directory"
```

---

### Task 13: wire Users (bespoke picker)

**Files:**
- Modify: `src/pages/Users.tsx` (import ~line 33; destructure ~line 156; picker rows ~lines 368–385; `shownCols` ~line 271; header span ~line 420)

Users keeps its bespoke columns popover (deliberately — see the comment at ~line 159), so the drag wiring goes into that popover directly instead of through `ColumnsButton`.

- [ ] **Step 1:** Extend the import at line 33:

```ts
import {
  applyColumnOrder, moveKey, useReorderDrag, visibleColumnsFor, type ColumnDef,
} from '../lib/listTools';
```

- [ ] **Step 2:** Add `colOrder, setColOrder,` to the `usePersistentListState` destructure (page key `'users'`).
- [ ] **Step 3:** Replace `const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);` (~line 271) with:

```ts
  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const reorder = (src: string, dst: string, before: boolean) =>
    setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before));
  const headerDrag = useReorderDrag(reorder, 'x', { ignoreFrom: '.pop-menu' });
  const menuDrag = useReorderDrag(reorder, 'y');
```

NOTE: both hook calls must sit in the unconditional hook region of the component body (where the replaced line already is).

- [ ] **Step 4:** In the bespoke picker (~line 368), change `{COLUMNS.map((c) => {` to `{orderedCols.map((c) => {` and change the row button's open tag + add a grip before the check span:

```tsx
                    <button key={c.key}
                            className={`pop-item ${on ? 'on' : ''} ${menuDrag.dropClass(c.key)}`}
                            {...menuDrag.dragProps(c.key)}
                            onClick={() => {
                              const next = new Set(visibleCols);
                              if (on) next.delete(c.key); else next.add(c.key);
                              setVisibleCols(next);
                            }}>
                      <span className="pop-grip" aria-hidden="true">
                        <svg viewBox="0 0 8 12" fill="currentColor">
                          <circle cx="2.5" cy="2" r="1.1" /><circle cx="5.5" cy="2" r="1.1" />
                          <circle cx="2.5" cy="6" r="1.1" /><circle cx="5.5" cy="6" r="1.1" />
                          <circle cx="2.5" cy="10" r="1.1" /><circle cx="5.5" cy="10" r="1.1" />
                        </svg>
                      </span>
                      <span className="pop-check">
```

(The existing `pop-check` span and label stay as they are.)

- [ ] **Step 5:** HEADER map's span open tag (~line 420; the body-cell map ~line 468 is untouched) →

```tsx
            <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                  {...headerDrag.dragProps(c.key)}>
```
- [ ] **Step 6:** Run `npx tsc -b` — clean.
- [ ] **Step 7:** Commit:

```bash
git add src/pages/Users.tsx
git commit -m "feat(portal): column display order on Users"
```

---

### Task 14: full verification + live smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 2: Build + typecheck**

Run: `npm run build`
Expected: clean `tsc -b` and vite build.

- [ ] **Step 3: Wiring completeness check**

Run: `grep -rn "<ColumnsButton" src/pages | grep -v "onReorder"`
Expected: no output (every ColumnsButton call site passes `onReorder`).

Run: `grep -rln "visibleColumnsFor(COLUMNS, visibleCols" src/pages; grep -rln "visibleColumnsFor(columns, visibleCols" src/pages`
Expected: no output (every page now orders through `orderedCols`).

- [ ] **Step 4: Browser smoke test (dev server)**

Start the portal dev server via the browser preview tooling and, on the Sites list:
1. Drag a header (e.g. Status) onto another column's left half → column moves before it; sort click still works.
2. Open Columns popover → rows listed in the new display order; drag a row → order updates live in the grid.
3. Reload the page → order persists (saved via preferences PATCH; check the network tab for the PATCH after a drag).
4. Open the funnel menu on a header and interact with it → no drag is triggered from inside the popover.

- [ ] **Step 5: Commit any fixes found, then finish**

If fixes were needed, commit them (`fix(portal): …`). Then use superpowers:finishing-a-development-branch to wrap up.
