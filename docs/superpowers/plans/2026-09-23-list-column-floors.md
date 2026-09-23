# List Column Floors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the initiative detail page, list columns keep a px floor, header labels swap to a short form when their track gets tight, single-line values truncate with an ellipsis instead of painting into the next column, and the list card scrolls sideways only below the floor sum — pilot for every other list.

**Architecture:** Two pure additions to the shared list module (`listGridStyle` builds `minmax()` tracks plus a row minimum width from `ColumnDef.min`/`short`; `ColHead` + `useFitLabel` render an adaptive header cell), one shared-component fix (the column filter menu renders through a portal so a scrolling card cannot clip it), one primitive-stylesheet variant (`.dir-list.list-scroll`, `.cell-line`), and the pilot page wired to all four. Spec: `docs/superpowers/specs/2026-09-23-list-column-floors-design.md`.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest + Testing Library (jsdom), plain CSS with the `--list-*` tokens in `portal/src/styles/directory.css`.

## Global Constraints

- Target: a full-width list gets **about 1176px** in a 1512px-wide window with the nav expanded; the nine default asset columns must fit that with no sideways scroll (row minimum ≤ 1176px).
- Floor derivation: `max(72, ceil(labelChars * 7.4) + 30)` from the short label when present; an explicit `min` never goes below the derived floor (helper takes the larger).
- `.dir-list.list-scroll` uses a **12px** track gap (not the 16px default); `listGridStyle`'s `gap` parameter defaults to 12.
- The list-typography guardrail (`portal/src/styles/listTypography.test.ts`) must stay green: no typography on list selectors outside `directory.css`, no raw `<table>`, no inline `fontSize`/`fontFamily`/`fontWeight`/`lineHeight`, and no page co-class rule on a `mini-row`/`mini-list-head` that declares display/padding/gap/border/min-height.
- American English in copy and comments (color, customize).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work happens in a worktree at `.claude/worktrees/list-floors` on branch `list-column-floors` off `main`, with `.env`, `api/.venv`, and `portal/node_modules` symlinked from the main checkout (`ln -s /Users/jrh1812/Developer/BaseCampV3/portal/node_modules portal/node_modules` etc.). All commands below run from that worktree's `portal/` directory unless stated.
- Test command: `npx vitest run <file>`. Type check: `npx tsc -b`. Both from `portal/`.

---

### Task 1: `ColumnDef.min`/`short` and the `listGridStyle` helper

**Files:**
- Modify: `portal/src/lib/listTools.tsx:41-47` (ColumnDef) and add the helper right after `visibleColumnsFor`
- Test: `portal/src/lib/listTools.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `ColumnDef` gains `short?: string` and `min?: number`.
  - `export function columnFloor(col: ColumnDef): number`
  - `export interface ListGridStyle { gridTemplateColumns: string; minWidth: number }`
  - `export function listGridStyle(cols: ColumnDef[], trailing?: string[], gap?: number): ListGridStyle`

- [ ] **Step 1: Write the failing tests**

Add to `portal/src/lib/listTools.test.tsx`. Extend the import from `./listTools` with `columnFloor, listGridStyle`. Append after the `moveKey` describe block:

```tsx
describe('columnFloor / listGridStyle', () => {
  const c = (over: Partial<ColumnDef>): ColumnDef =>
    ({ key: 'k', label: 'Label', width: '1fr', default: true, ...over });

  it('derives a floor from the label: ceil(chars * 7.4) + 30, never below 72', () => {
    expect(columnFloor(c({ label: 'Serial' }))).toBe(75);   // 6 chars → 45 + 30
    expect(columnFloor(c({ label: 'ID' }))).toBe(72);       // 2 chars → 45 → floor 72
  });

  it('derives the floor from the short label when one is present', () => {
    expect(columnFloor(c({ label: 'Destination Rack', short: 'Dest Rack' }))).toBe(97); // 9 chars → 67 + 30
  });

  it('an explicit min wins when larger; the derived floor wins when the explicit one is smaller', () => {
    expect(columnFloor(c({ label: 'Serial', min: 120 }))).toBe(120);
    expect(columnFloor(c({ label: 'Serial', min: 50 }))).toBe(75);
  });

  it('wraps fr columns in minmax() with their floor and passes fixed tracks through untouched', () => {
    const s = listGridStyle(
      [c({ key: 'a', label: 'Serial', width: '1.1fr' }), c({ key: 'b', label: 'X', width: '88px' })],
      ['30px'],
    );
    expect(s.gridTemplateColumns).toBe('minmax(75px, 1.1fr) 88px 30px');
  });

  it('minWidth sums floors, fixed px tracks, one gap between each pair of tracks, and 40px of padding', () => {
    const s = listGridStyle(
      [c({ key: 'a', label: 'Serial', width: '1.1fr' }), c({ key: 'b', label: 'X', width: '88px' })],
      ['30px'],
    );
    // 75 + 88 + 30 + 2 gaps × 12 + 40
    expect(s.minWidth).toBe(257);
  });

  it('honors a custom gap', () => {
    const s = listGridStyle([c({ key: 'a', label: 'Serial' }), c({ key: 'b', label: 'Serial' })], [], 16);
    expect(s.minWidth).toBe(75 + 75 + 16 + 40);
  });

  it('an unrecognized width passes through and still contributes its floor to minWidth', () => {
    const s = listGridStyle([c({ label: 'Serial', width: 'auto' })]);
    expect(s.gridTemplateColumns).toBe('auto');
    expect(s.minWidth).toBe(75 + 40);
  });

  it('an empty column set is just the padding', () => {
    expect(listGridStyle([])).toEqual({ gridTemplateColumns: '', minWidth: 40 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/listTools.test.tsx`
Expected: FAIL — `columnFloor` / `listGridStyle` are not exported (TypeScript/ESM import error or "is not a function").

- [ ] **Step 3: Implement**

In `portal/src/lib/listTools.tsx`, replace the `ColumnDef` interface with:

```ts
export interface ColumnDef {
  key: string;
  label: string;
  width: string;   // grid-template fraction/px for this column
  default: boolean;
  godOnly?: boolean; // only offered/shown once god mode is active
  /** Header label shown when the long `label` would overflow its track
   *  (see ColHead / useFitLabel). Also the label the derived floor is
   *  sized from, since the floor only has to fit the short form. */
  short?: string;
  /** px floor for the track (see listGridStyle). Derived from the label
   *  when absent; an explicit value below the derived floor is raised
   *  to it so the short label can never overflow. */
  min?: number;
}
```

Then add, directly after `visibleColumnsFor`:

```ts
/* ── column floors + sideways scroll (spec: 2026-09-23-list-column-floors) ──
 * `fr` tracks shrink to zero when a window is narrow, and any content
 * that cannot wrap then paints across its neighbor. Every column
 * therefore carries a px floor, the grid becomes `minmax(floor, fr)`,
 * and the header + rows carry the summed minimum so the card
 * (`.dir-list.list-scroll`, directory.css) scrolls sideways below it
 * instead of colliding. Above the sum nothing changes. */

/** 10px mono header glyph (directory.css --list-fs-head) plus 0.14em
 *  tracking, at list scale 1. */
const FLOOR_PX_PER_CHAR = 7.4;
/** Sort caret + the column-menu funnel button beside the label. */
const FLOOR_CHROME_PX = 30;
/** Nothing narrower than this reads as a column. */
const FLOOR_MIN_PX = 72;
/** .list-head / .row-main horizontal padding, 20px a side. */
const LIST_PAD_X = 40;
/** .dir-list.list-scroll track gap. */
const LIST_SCROLL_GAP = 12;

/** The px floor for one column: the larger of its explicit `min` and the
 *  floor derived from the label that has to fit (short when present). */
export function columnFloor(col: ColumnDef): number {
  const label = col.short ?? col.label;
  const derived = Math.max(
    FLOOR_MIN_PX, Math.ceil(label.length * FLOOR_PX_PER_CHAR) + FLOOR_CHROME_PX,
  );
  return Math.max(col.min ?? 0, derived);
}

export interface ListGridStyle {
  gridTemplateColumns: string;
  /** px: floors + fixed tracks + gaps + padding. Numbers render as px. */
  minWidth: number;
}

const FR_RE = /^\d*\.?\d+fr$/;
const PX_RE = /^(\d*\.?\d+)px$/;

/** Grid template + row minimum width for a shown column set. `trailing`
 *  are the fixed tracks a page appends after its columns (an actions
 *  track, a chevron track); only px trailing tracks count toward the
 *  minimum. Spread the result onto `.list-head`, and put `minWidth` on
 *  each `.dir-row` too so hover paint and borders span the scrolled
 *  width (see InitiativeDetail.tsx for the reference wiring). */
export function listGridStyle(
  cols: ColumnDef[], trailing: string[] = [], gap: number = LIST_SCROLL_GAP,
): ListGridStyle {
  const tracks: string[] = [];
  let min = 0;
  for (const c of cols) {
    const floor = columnFloor(c);
    if (FR_RE.test(c.width)) {
      tracks.push(`minmax(${floor}px, ${c.width})`);
      min += floor;
    } else {
      tracks.push(c.width);
      const px = PX_RE.exec(c.width);
      min += px ? Number(px[1]) : floor;
    }
  }
  for (const t of trailing) {
    tracks.push(t);
    const px = PX_RE.exec(t);
    min += px ? Number(px[1]) : 0;
  }
  const gaps = Math.max(0, tracks.length - 1) * gap;
  return { gridTemplateColumns: tracks.join(' '), minWidth: min + gaps + LIST_PAD_X };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/listTools.test.tsx`
Expected: PASS, every existing test in the file still green.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc -b`
Expected: no output (clean).

```bash
git add src/lib/listTools.tsx src/lib/listTools.test.tsx
git commit -m "feat(portal): ColumnDef min/short and listGridStyle — px column floors and the row minimum width

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `useFitLabel` and the shared `ColHead` header cell

**Files:**
- Modify: `portal/src/lib/listTools.tsx` (add after `listGridStyle`; extend the react import)
- Modify: `portal/src/styles/column-menu.css:15-22` (`.list-head .col-head` block)
- Test: `portal/src/lib/listTools.test.tsx`

**Interfaces:**
- Consumes: `ColumnDef` (Task 1), `useReorderDrag` (existing, same file).
- Produces:
  - `export function useFitLabel(long: string, short?: string): { cellRef: RefObject<HTMLSpanElement>; measureRef: RefObject<HTMLSpanElement>; label: string }`
  - `export type HeaderDragProps = ReturnType<ReturnType<typeof useReorderDrag>['dragProps']>`
  - `export function ColHead(props: { col: ColumnDef; sortDir: 1 | -1 | null; onToggleSort: () => void; className?: string; dragProps?: HeaderDragProps; children?: ReactNode }): JSX.Element` — `children` is the page's `<ColumnMenu>`.
  - Markup: `<span class="col-head [className]"><button class="sortable">{label} {caret}</button>[<span class="col-head-measure" aria-hidden>]{children}</span>` — identical to today's inline header markup on every page, so no page CSS changes.

- [ ] **Step 1: Write the failing tests**

In `portal/src/lib/listTools.test.tsx`: extend the `@testing-library/react` import with `act`, the vitest import with `beforeEach`, and the `./listTools` import with `ColHead`. Append:

```tsx
describe('ColHead / useFitLabel', () => {
  let resizeCallbacks: (() => void)[] = [];
  beforeEach(() => {
    resizeCallbacks = [];
    class ResizeObserverStub {
      constructor(cb: () => void) { resizeCallbacks.push(cb); }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });
  afterEach(() => vi.unstubAllGlobals());

  const setSize = (el: Element | null, prop: 'clientWidth' | 'offsetWidth', value: number) =>
    Object.defineProperty(el, prop, { configurable: true, get: () => value });
  const fire = () => act(() => { resizeCallbacks.forEach((cb) => cb()); });
  const wide: ColumnDef = {
    key: 'dr', label: 'Destination Rack', short: 'Dest Rack', width: '1fr', default: true,
  };

  it('shows the short label when the long one would overflow, and the long one again when room returns', () => {
    const { container } = render(<ColHead col={wide} sortDir={null} onToggleSort={() => {}} />);
    const cell = container.querySelector('.col-head');
    const measure = container.querySelector('.col-head-measure');
    const button = () => screen.getByRole('button');
    expect(button().textContent?.trim()).toBe('Destination Rack');

    setSize(measure, 'offsetWidth', 120);
    setSize(cell, 'clientWidth', 90);
    fire();
    expect(button().textContent?.trim()).toBe('Dest Rack');
    expect(button().getAttribute('title')).toBe('Destination Rack');

    setSize(cell, 'clientWidth', 200);
    fire();
    expect(button().textContent?.trim()).toBe('Destination Rack');
    expect(button().getAttribute('title')).toBeNull();
  });

  it('subtracts the column-menu trigger from the available width', () => {
    const { container } = render(
      <ColHead col={wide} sortDir={null} onToggleSort={() => {}}>
        <button type="button" className="colmenu-trigger" aria-label="menu" />
      </ColHead>,
    );
    setSize(container.querySelector('.col-head-measure'), 'offsetWidth', 100);
    setSize(container.querySelector('.colmenu-trigger'), 'offsetWidth', 20);
    setSize(container.querySelector('.col-head'), 'clientWidth', 110); // 110 - 20 - 2 = 88 < 100
    fire();
    expect(screen.getByRole('button', { name: /Dest Rack/ })).not.toBeNull();
  });

  it('a column without a short label renders no measuring span and never swaps', () => {
    const col: ColumnDef = { key: 's', label: 'Serial', width: '1fr', default: true };
    const { container } = render(<ColHead col={col} sortDir={1} onToggleSort={() => {}} />);
    expect(container.querySelector('.col-head-measure')).toBeNull();
    expect(resizeCallbacks).toHaveLength(0);
    expect(screen.getByRole('button').textContent).toContain('Serial');
    expect(screen.getByRole('button').textContent).toContain('▲');
  });

  it('without ResizeObserver (jsdom default) the long label renders and nothing throws', () => {
    vi.unstubAllGlobals();
    render(<ColHead col={wide} sortDir={-1} onToggleSort={() => {}} />);
    expect(screen.getByRole('button').textContent).toContain('Destination Rack');
    expect(screen.getByRole('button').textContent).toContain('▼');
  });

  it('forwards className, drag props, and the sort toggle', () => {
    const onToggleSort = vi.fn();
    const onDragStart = vi.fn();
    const { container } = render(
      <ColHead col={wide} sortDir={null} onToggleSort={onToggleSort} className="drop-before"
               dragProps={{ draggable: true, onDragStart } as unknown as HeaderDragProps} />,
    );
    const cell = container.querySelector('.col-head') as HTMLElement;
    expect(cell.className).toBe('col-head drop-before');
    expect(cell.getAttribute('draggable')).toBe('true');
    fireEvent.click(screen.getByRole('button'));
    expect(onToggleSort).toHaveBeenCalledTimes(1);
  });
});
```

Add `HeaderDragProps` to the type import from `./listTools` as well (`type ColumnDef, type HeaderDragProps`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/listTools.test.tsx`
Expected: FAIL — `ColHead` is not exported.

- [ ] **Step 3: Implement the hook and component**

In `portal/src/lib/listTools.tsx`, change the react import to:

```ts
import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type DragEvent, type ReactNode, type RefObject,
} from 'react';
```

Add after `listGridStyle`:

```tsx
/* ── adaptive header label ──────────────────────────────────────────
 * A header cell renders its long label while the track has room and its
 * `short` label once the long one would overflow. The cell is a grid
 * item, so its width is the track's — independent of which label is
 * showing — and the floor guarantees the short label fits, so the swap
 * can never oscillate. A hidden clone of the long label (plus caret) is
 * what gets measured; observing it too means a late font load re-checks. */

/** column-menu.css `.list-head .col-head { gap: 2px }`. */
const COL_HEAD_GAP = 2;

export function useFitLabel(long: string, short?: string): {
  cellRef: RefObject<HTMLSpanElement>;
  measureRef: RefObject<HTMLSpanElement>;
  label: string;
} {
  const cellRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);

  useLayoutEffect(() => {
    if (!short || typeof ResizeObserver === 'undefined') return;
    const cell = cellRef.current;
    const measure = measureRef.current;
    if (!cell || !measure) return;
    const check = () => {
      const trigger = cell.querySelector<HTMLElement>('.colmenu-trigger');
      const available = cell.clientWidth - (trigger ? trigger.offsetWidth + COL_HEAD_GAP : 0);
      setFits(measure.offsetWidth <= available);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(cell);
    ro.observe(measure);
    return () => ro.disconnect();
  }, [long, short]);

  return { cellRef, measureRef, label: short && !fits ? short : long };
}

export type HeaderDragProps = ReturnType<ReturnType<typeof useReorderDrag>['dragProps']>;

/** One list header cell: sortable label (long/short per useFitLabel),
 *  sort caret, and the page's ColumnMenu as `children`. Same markup every
 *  page already renders inline (`span.col-head > button.sortable`), so
 *  existing header CSS applies unchanged. */
export function ColHead({ col, sortDir, onToggleSort, className, dragProps, children }: {
  col: ColumnDef;
  sortDir: 1 | -1 | null;
  onToggleSort: () => void;
  className?: string;
  dragProps?: HeaderDragProps;
  children?: ReactNode;
}): JSX.Element {
  const { cellRef, measureRef, label } = useFitLabel(col.label, col.short);
  const caret = sortDir
    ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;
  return (
    <span ref={cellRef} className={`col-head${className ? ` ${className}` : ''}`} {...dragProps}>
      <button type="button" className="sortable" onClick={onToggleSort}
              title={label === col.label ? undefined : col.label}>
        {label} {caret}
      </button>
      {col.short && (
        <span ref={measureRef} className="col-head-measure" aria-hidden="true">
          {col.label} {caret}
        </span>
      )}
      {children}
    </span>
  );
}
```

Note `className` must be exactly `col-head` followed by the extra classes so the drop-class assertions (`col-head drop-before`) and the page's `idet-col-center` rule keep matching. An empty `className` string from a page (`dropClass()` returns `''`) must not leave a trailing space: the template above handles that.

- [ ] **Step 4: Style the measuring span**

In `portal/src/styles/column-menu.css`, replace the `.list-head .col-head` block (lines 15-22) with:

```css
.list-head .col-head {
  position: relative;      /* anchors .col-head-measure */
  display: inline-flex;
  align-items: center;
  gap: 2px;                /* listTools.tsx COL_HEAD_GAP mirrors this */
  min-width: 0;
}
.list-head .col-head .sortable { min-width: 0; white-space: nowrap; }
/* Hidden clone of the long label (+ caret) that useFitLabel measures.
 * Inherits the header's font from .list-head; carries no typography of
 * its own (listTypography guardrail). */
.list-head .col-head-measure {
  position: absolute;
  left: 0;
  top: 0;
  visibility: hidden;
  pointer-events: none;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;                /* matches .list-head .sortable's gap */
}
```

- [ ] **Step 5: Run the tests and the guardrail**

Run: `npx vitest run src/lib/listTools.test.tsx src/styles/listTypography.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc -b`
Expected: clean.

```bash
git add src/lib/listTools.tsx src/lib/listTools.test.tsx src/styles/column-menu.css
git commit -m "feat(portal): ColHead header cell with useFitLabel — long label when it fits, short label when it would overflow

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Portal the column filter menu

**Files:**
- Modify: `portal/src/lib/columnMenu.tsx` (ColumnMenu component, lines ~111-246)
- Modify: `portal/src/styles/column-menu.css` (`.colmenu-menu` rule, line ~46)
- Test: `portal/src/lib/columnMenu.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: no API change. The open menu is now a child of `document.body` with class `pop-menu colmenu-menu colmenu-portaled` and inline fixed coordinates.

- [ ] **Step 1: Write the failing tests**

In `portal/src/lib/columnMenu.test.tsx`, inside `describe('ColumnMenu', …)` append:

```tsx
  it('renders the open menu through a portal under document.body, and a mousedown inside it does not close it', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ColumnMenu colKey="name" label="Name" allRows={rows} filters={{}} text={text}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Name column menu' }));

    const menu = document.querySelector('.colmenu-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.classList.contains('colmenu-portaled')).toBe(true);

    fireEvent.mouseDown(screen.getByPlaceholderText('Filter Name'));
    expect(document.querySelector('.colmenu-menu')).not.toBeNull();

    fireEvent.mouseDown(document.body);
    expect(document.querySelector('.colmenu-menu')).toBeNull();
  });

  it('closes when its header scrolls out of the list card', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <div className="dir-list list-scroll">
        <ColumnMenu colKey="name" label="Name" allRows={rows} filters={{}} text={text}
                    filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />
      </div>,
    );
    const card = container.querySelector('.dir-list') as HTMLElement;
    const wrap = container.querySelector('.colmenu') as HTMLElement;
    const rect = (left: number, right: number) =>
      ({ left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON() {} }) as DOMRect;
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(rect(100, 600));
    const wrapRect = vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(200, 260));

    await user.click(screen.getByRole('button', { name: 'Name column menu' }));
    expect(document.querySelector('.colmenu-menu')).not.toBeNull();

    // Still inside the card after a scroll: stays open, re-placed.
    wrapRect.mockReturnValue(rect(500, 560));
    act(() => { window.dispatchEvent(new Event('scroll')); });
    expect(document.querySelector('.colmenu-menu')).not.toBeNull();

    // Scrolled past the card's right edge: closes.
    wrapRect.mockReturnValue(rect(700, 760));
    act(() => { window.dispatchEvent(new Event('scroll')); });
    expect(document.querySelector('.colmenu-menu')).toBeNull();
  });
```

`act` is already imported in this file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/columnMenu.test.tsx`
Expected: FAIL — the first new test fails at `container.contains(menu)` being `true` (menu is inline today); the second fails because the menu stays open.

- [ ] **Step 3: Implement the portal**

In `portal/src/lib/columnMenu.tsx`:

Add the import:

```ts
import { createPortal } from 'react-dom';
```

Above `export function ColumnMenu`, add:

```ts
/** Portaled menu placement. Below the trigger, right-aligned to it;
 *  left-aligned instead when right-alignment would push the menu past
 *  the viewport's left edge. */
interface MenuPos { top: number; left: number | 'auto'; right: number | 'auto' }
const MENU_GAP = 8;
/** chrome.css .pop-menu min-width — the width to keep on screen. */
const MENU_MIN_WIDTH = 230;
```

Inside `ColumnMenu`, replace the outside-click effect with:

```tsx
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPos | null>(null);

  // Close on an outside mousedown. The open menu lives in a portal under
  // document.body (a scrolling .dir-list would otherwise clip it), so a
  // single containment ref would treat every click on a menu item as
  // "outside" — both the trigger wrap and the menu count as inside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  // Anchor the portaled menu to the trigger. Re-placed on window resize
  // and on any scroll (capture phase catches the card's own sideways
  // scroll and the page scroller) so the menu follows its header; once
  // the header has scrolled out of its card's visible box the menu
  // closes instead of floating over unrelated columns.
  useEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const card = el.closest('.dir-list');
      if (card) {
        const box = card.getBoundingClientRect();
        if (rect.right < box.left || rect.left > box.right) { setOpen(false); return; }
      }
      const top = rect.bottom + MENU_GAP;
      if (rect.right - MENU_MIN_WIDTH < 0) setPos({ top, left: rect.left, right: 'auto' });
      else setPos({ top, left: 'auto', right: window.innerWidth - rect.right });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
```

Replace the `{open && (<div className="pop-menu colmenu-menu"> … </div>)}` block with the same inner content wrapped as:

```tsx
      {open && pos && createPortal(
        <div className="pop-menu colmenu-menu colmenu-portaled" ref={menuRef}
             style={{ top: pos.top, left: pos.left, right: pos.right }}>
          {/* …existing sort / search / list / actions markup, unchanged… */}
        </div>,
        document.body,
      )}
```

Keep every inner element exactly as it is today (the `.colmenu-sort` buttons, the `.colmenu-search` input, `.colmenu-list`, `.pop-sep`, `.colmenu-actions`).

Update the file's header comment (the block at the top of `columnMenu.tsx`) with one sentence: "The open menu is portaled to `document.body` (fixed position from the trigger's rect) so a scrolling list card cannot clip it; see RowActionsMenu for the same pattern."

- [ ] **Step 4: Style the portaled menu**

In `portal/src/styles/column-menu.css`, replace `.colmenu-menu { min-width: 220px; }` with:

```css
.colmenu-menu { min-width: 220px; }
/* Portaled under document.body (lib/columnMenu.tsx): fixed coordinates
 * come inline from the trigger's rect; z-index sits with RowActionsMenu's
 * portaled menu, above the list card and the sticky topbar. */
.pop-menu.colmenu-portaled { position: fixed; z-index: 1200; }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/columnMenu.test.tsx src/lib/listTools.test.tsx`
Expected: PASS — every existing ColumnMenu test still passes (they query through `screen`, which searches `document.body`).

Also run the pages that mount ColumnMenu to make sure nothing depended on the inline menu:

Run: `npx vitest run src/pages/Initiatives.test.tsx src/pages/InitiativeDetail.test.tsx src/pages/Sites.test.tsx src/pages/Assets.test.tsx`
Expected: PASS.

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc -b`
Expected: clean.

```bash
git add src/lib/columnMenu.tsx src/lib/columnMenu.test.tsx src/styles/column-menu.css
git commit -m "fix(portal): column filter menu renders through a portal so a scrolling list card cannot clip it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Stylesheet — `.list-scroll`, `.cell-line`, phone override, and the pilot page's overflow hacks

**Files:**
- Modify: `portal/src/styles/directory.css` (after `.dir-list.ngd-notif-grid`, line ~205; the `.cell .cell-nowrap` rule, line ~356; the ≤768px media block, line ~712)
- Modify: `portal/src/styles/initiatives.css:188-206` (delete the overflow-visible block) and `:916-921` (time list template)
- Test: `portal/src/styles/listTypography.test.ts` (existing guardrail, no new test)

**Interfaces:**
- Produces CSS classes used by Task 5: `dir-list.list-scroll`, `dir-list.list-scroll.editing`, `mini-list.list-scroll`, `cell-line`.

- [ ] **Step 1: Add the scroll variant**

In `portal/src/styles/directory.css`, directly after the `.dir-list.ngd-notif-grid { overflow-x: auto; }` line, add:

```css
/* Sideways scroll (spec 2026-09-23-list-column-floors): a list whose
 * columns carry px floors (lib/listTools.tsx listGridStyle) opts in
 * here. Above the floor sum nothing changes; below it the card scrolls
 * sideways as one unit — header and rows are siblings inside the card
 * and carry the same inline min-width, so the header background, row
 * borders, and hover paint span the full scrolled width. overflow-y is
 * pinned to hidden so an opening row detail never grows a vertical
 * scrollbar inside the card. The 12px gap (vs the 16px default above)
 * is what lets nine default columns fit a 14-inch MacBook Pro window
 * with the nav expanded; listGridStyle's default gap mirrors it.
 *
 * `.editing`: god-mode inline editors (GodCell → ComboBox) drop their
 * menu absolutely inside the cell, and a scroll container would clip it.
 * While a list is in edit mode the card goes back to visible overflow;
 * the header then paints its own top corners. Portaling ComboBox's menu
 * would remove this exception. */
.dir-list.list-scroll { overflow-x: auto; overflow-y: hidden; }
.dir-list.list-scroll .list-head,
.dir-list.list-scroll .row-main { gap: 12px; }
.dir-list.list-scroll.editing { overflow: visible; }
.dir-list.list-scroll.editing .list-head { border-radius: 15px 15px 0 0; }
.mini-list.list-scroll { overflow-x: auto; overflow-y: hidden; }
```

- [ ] **Step 2: Add `.cell-line`**

Replace the `.cell .cell-nowrap { … }` rule (and its comment) with:

```css
/* Single-line value: full while the column has room, an ellipsis once it
 * does not — pair it with a `title` carrying the full text. `.cell-line`
 * is the name the list-column-floors spec uses; `.cell-nowrap` (the
 * Notifications page's Quiet hours cell) is the same rule and stays. Not
 * folded into .cell-top/.cell-sub since most cells using those still
 * want to wrap. */
.cell .cell-nowrap,
.cell .cell-line {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 3: Phone override**

Inside the `@media (max-width: 768px) { … }` block, after `.row-main > * { min-width: 0; }`, add:

```css
  /* Phones stack rows into cards; the inline row minimum from
     listGridStyle must not force a sideways scroll there. */
  .list-head, .dir-row, .row-main { min-width: 0 !important; }
  .dir-list.list-scroll { overflow-x: hidden; }
```

- [ ] **Step 4: Remove the pilot page's overflow hacks and floor the time list**

In `portal/src/styles/initiatives.css`, delete these lines and the comment block above them (the "/* .dir-list clips overflow for its 16px corner radius …" paragraph):

```css
.idet-people-list { overflow: visible; }
.idet-people-list .list-head { border-radius: 15px 15px 0 0; }
.idet-people-list .dir-row:last-child .row-main { border-radius: 0 0 15px 15px; }
```

and, in the Assets block, these three (keep the `cursor: default` and `:hover` rules above them and the progress rules below):

```css
.idet-assets-list { overflow: visible; }
.idet-assets-list .list-head { border-radius: 15px 15px 0 0; }
.idet-assets-list .dir-row:last-child .row-main { border-radius: 0 0 15px 15px; }
```

Replace the removed comment with a one-line note where the People rule was: `/* The People and Assets cards use .dir-list.list-scroll (directory.css); the column menu is portaled, so no overflow override is needed here. */`

Then extend the time-list template rule to carry its floor sum as a min-width (floors 140+80+80+60+90 = 450, plus four 12px gaps):

```css
.idet-time-list-head,
.idet-time-row {
  grid-template-columns: minmax(140px, 1.6fr) minmax(80px, 0.9fr) minmax(80px, 0.9fr)
    minmax(60px, 0.7fr) minmax(90px, 1fr);
  min-width: 498px; /* floors + 4 × 12px gaps; the .mini-list.list-scroll card scrolls below it */
}
```

- [ ] **Step 5: Run the guardrail and the pilot page tests**

Run: `npx vitest run src/styles/listTypography.test.ts src/pages/InitiativeDetail.test.tsx src/pages/Notifications.test.tsx`
Expected: PASS. If the guardrail's check (g) flags `min-width` on `.idet-time-row`, it is a false positive by its own list (min-height is guarded, min-width is not) — report it rather than allowlisting; the property list in the test header is the contract.

- [ ] **Step 6: Commit**

```bash
git add src/styles/directory.css src/styles/initiatives.css
git commit -m "feat(portal): .dir-list.list-scroll + .cell-line primitives; initiative detail lists drop their overflow-visible hacks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Wire the initiative detail page

**Files:**
- Modify: `portal/src/lib/initiatives.ts:283-311` (MOVE_ASSET_COLUMNS)
- Modify: `portal/src/pages/InitiativeDetail.tsx` — PEOPLE_COLUMNS (~107-113), imports (~26-40 block from `../lib/listTools`), `peopleGrid`/`peopleCaret` (~545-550), `personCellFor` (~552-577), `assetsGrid`/`assetsCaret` (~578-583), `assetCellFor` (~589-647), the assets card + header loop + rows (~807-895), the people card + header loop + rows (~1010-1071), the time mini-list (~1144)
- Test: `portal/src/pages/InitiativeDetail.test.tsx`

**Interfaces:**
- Consumes: `listGridStyle`, `ColHead`, `ColumnDef.min/short` (Tasks 1-2); `list-scroll`, `editing`, `cell-line` (Task 4).
- Produces: the reference wiring other pages copy during rollout.

- [ ] **Step 1: Write the failing tests**

In `portal/src/pages/InitiativeDetail.test.tsx`, after the test named `'assets list: the action track is trigger-sized, and the chevron column survives'`, add:

```tsx
it('assets list: columns carry px floors, header and rows share one template and minimum width, and the card scrolls sideways', async () => {
  renderPage();

  const row = await assetRow();
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  expect(card.classList.contains('editing')).toBe(false);

  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(head.style.minWidth).toMatch(/^\d+px$/);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  // Nine default columns + actions + chevron must fit a 14-inch window
  // with the nav expanded (spec: ≤ 1176px).
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(1176);
});

it('assets list: single-line values truncate with the full text on hover', async () => {
  renderPage();

  const row = await assetRow();
  const name = within(row).getByText('switch-01');
  expect(name.classList.contains('cell-line')).toBe(true);
  expect(name.getAttribute('title')).toBe('switch-01');
});

it('assets list: the header renders through ColHead (long label, hidden short-label measure for wordy columns)', async () => {
  renderPage();

  const row = await assetRow();
  const head = (row.closest('.dir-list') as HTMLElement).querySelector('.list-head') as HTMLElement;
  expect(within(head).getByRole('button', { name: /Destination Rack/ })).not.toBeNull();
  expect(head.querySelector('.col-head-measure')).not.toBeNull();
});
```

And after the people-list test `'people row: one Actions trigger replaces the inline Edit/Remove buttons'`, add:

```tsx
it('people list: floors, shared template + minimum width, and the sideways-scroll card', async () => {
  renderPage();

  const row = await personRow();
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(main.style.gridTemplateColumns.endsWith('88px')).toBe(true);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(within(row).getByText('Ada Lovelace').classList.contains('cell-line')).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/pages/InitiativeDetail.test.tsx -t "floors|cell-line|ColHead|truncate"`
Expected: FAIL on the `list-scroll` class assertion (and the others).

- [ ] **Step 3: Column definitions**

In `portal/src/lib/initiatives.ts`, replace `MOVE_ASSET_COLUMNS` with:

```ts
/** Default columns mirror v2's MoveDetail grid; optional columns are the
 *  remaining per-move + asset fields, offered via the Columns picker.
 *  `min` floors on the nine defaults are sized so that, with the 88px
 *  actions track, the 30px chevron track, ten 12px gaps, and 40px of
 *  padding, the row minimum is 1170px — under the 1176px a 14-inch
 *  MacBook Pro window gives a list with the nav expanded (spec
 *  2026-09-23-list-column-floors). `short` is the header shown once the
 *  long label would overflow its track. Optional columns take the
 *  derived floor. */
export const MOVE_ASSET_COLUMNS: ColumnDef[] = [
  { key: 'asset_id', label: 'Asset ID', width: '0.8fr', default: true, min: 92 },
  { key: 'asset_name', label: 'Asset Name', width: '1.3fr', default: true, min: 136 },
  { key: 'serial', label: 'Serial', width: '1.1fr', default: true, min: 108 },
  { key: 'make_model', label: 'Make/Model', width: '1.2fr', default: true, min: 108 },
  { key: 'status', label: 'Status', width: '1.1fr', default: true, min: 96 },
  { key: 'source_rack', label: 'Source Rack', short: 'Src Rack', width: '1fr', default: true, min: 92 },
  { key: 'source_ru', label: 'Source RU', short: 'Src RU', width: '0.8fr', default: true, min: 76 },
  { key: 'destination_rack', label: 'Destination Rack', short: 'Dest Rack', width: '1fr', default: true, min: 100 },
  { key: 'destination_ru', label: 'Destination RU', short: 'Dest RU', width: '0.9fr', default: true, min: 84 },
  { key: 'wave', label: 'Wave', width: '0.8fr', default: false },
  { key: 'disposition', label: 'Disposition', width: '1.1fr', default: false },
  { key: 'owner', label: 'Owner', width: '1fr', default: false },
  { key: 'source_verified', label: 'Source Verified', short: 'Src Verified', width: '0.9fr', default: false },
  { key: 'source_position', label: 'Source Position', short: 'Src Position', width: '1fr', default: false },
  { key: 'source_pod', label: 'Source Pod', short: 'Src Pod', width: '0.8fr', default: false },
  { key: 'destination_verified', label: 'Destination Verified', short: 'Dest Verified', width: '1fr', default: false },
  { key: 'destination_position', label: 'Destination Position', short: 'Dest Position', width: '1.1fr', default: false },
  { key: 'destination_pod', label: 'Destination Pod', short: 'Dest Pod', width: '0.9fr', default: false },
  { key: 'cable_info', label: 'Cable Info', width: '1.2fr', default: false },
  { key: 'vendor_involved', label: 'Vendor Involved', short: 'Vendor', width: '1fr', default: false },
  { key: 'asset_status', label: 'Asset Status', width: '1.1fr', default: false },
  { key: 'rfid_tag', label: 'RFID Tag', width: '1fr', default: false },
  { key: 'location', label: 'Location', width: '1.1fr', default: false },
  { key: 'pod_number', label: 'Pod #', width: '0.7fr', default: false },
  { key: 'client', label: 'Client', width: '1fr', default: false },
  { key: 'added', label: 'Added', width: '0.9fr', default: false },
  { key: 'updated', label: 'Updated', width: '0.9fr', default: false },
];
```

In `portal/src/pages/InitiativeDetail.tsx`, replace `PEOPLE_COLUMNS` with:

```ts
const PEOPLE_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.4fr', default: true, min: 140 },
  { key: 'work_type', label: 'Work type', short: 'Type', width: '1fr', default: true, min: 110 },
  { key: 'site_worked', label: 'Site worked', short: 'Site', width: '1fr', default: true, min: 120 },
  { key: 'rating', label: 'Rating', width: '0.7fr', default: true, min: 76 },
  { key: 'added', label: 'Added', width: '0.9fr', default: false, min: 96 },
];
```

- [ ] **Step 4: Grids and headers**

In `InitiativeDetail.tsx`, add `ColHead, listGridStyle` to the existing `import { … } from '../lib/listTools'` list.

Replace the `peopleGrid` and `peopleCaret` definitions with:

```ts
  const peopleGrid = listGridStyle(peopleShownCols, canChange ? [ACTIONS_TRACK] : []);
```

Replace the `assetsGrid` and `assetsCaret` definitions with:

```ts
  const assetsGrid = listGridStyle(assetsShownCols, canChange ? [ACTIONS_TRACK, '30px'] : ['30px']);
```

(`peopleCaret` and `assetsCaret` are only used by the header loops being replaced; delete them. `npx tsc -b` will flag any other use.)

Replace the assets card opening and header loop with:

```tsx
              <div className={`dir-list idet-assets-list list-scroll${assetsEditing ? ' editing' : ''}`}>
                <div className="list-head" style={assetsGrid}>
                  {assetsShownCols.map((c) => (
                    <ColHead key={c.key} col={c}
                             sortDir={assetsSortKey === c.key ? assetsSortDir : null}
                             onToggleSort={() => toggleAssetsSort(c.key)}
                             className={`${assetsHeaderDrag.dropClass(c.key)}`
                               + `${ASSET_CENTERED_COLS.has(c.key) ? ' idet-col-center' : ''}`}
                             dragProps={assetsHeaderDrag.dragProps(c.key)}>
                      <ColumnMenu colKey={c.key} label={c.label}
                                  allRows={assets} filters={assetsFilters}
                                  text={moveAssetCellText}
                                  filter={assetsFilters[c.key]} onFilter={setAssetsFilter}
                                  sortDir={assetsSortKey === c.key ? assetsSortDir : null}
                                  onSort={(dir) => setAssetsSort(c.key, dir)} />
                    </ColHead>
                  ))}
                  {canChange && <span className="col-head" />}
                  <span className="col-head" />
                </div>
```

The `className` expression may start with a space when `dropClass` is empty (`' idet-col-center'`); `ColHead` prepends `col-head ` to whatever it receives, so trim it: pass `className={[assetsHeaderDrag.dropClass(c.key), ASSET_CENTERED_COLS.has(c.key) ? 'idet-col-center' : ''].filter(Boolean).join(' ')}` instead of the concatenation above.

In the assets `VirtualRows` render, change the row wrapper to carry the minimum width:

```tsx
                      <div key={a.id} className={`dir-row ${open ? 'open' : ''}`} {...vp}
                           style={{ ...vp?.style, minWidth: assetsGrid.minWidth }}>
                        <div className="row-main" style={assetsGrid}
```

Replace the people card opening and header loop with:

```tsx
                <div className={`dir-list idet-people-list list-scroll${god.editing ? ' editing' : ''}`}>
                  <div className="list-head" style={peopleGrid}>
                    {peopleShownCols.map((c) => (
                      <ColHead key={c.key} col={c}
                               sortDir={peopleSortKey === c.key ? peopleSortDir : null}
                               onToggleSort={() => togglePeopleSort(c.key)}
                               className={peopleHeaderDrag.dropClass(c.key)}
                               dragProps={peopleHeaderDrag.dragProps(c.key)}>
                        <ColumnMenu colKey={c.key} label={c.label}
                                    allRows={initiative.people} filters={peopleFilters}
                                    text={personCellText}
                                    filter={peopleFilters[c.key]} onFilter={setPeopleFilter}
                                    sortDir={peopleSortKey === c.key ? peopleSortDir : null}
                                    onSort={(dir) => setPeopleSort(c.key, dir)} />
                      </ColHead>
                    ))}
                    {canChange && <span className="col-head" />}
                  </div>
```

And the people row wrapper:

```tsx
                    <div key={p.id} className="dir-row" {...vp}
                         style={{ ...vp?.style, minWidth: peopleGrid.minWidth }}>
                      <div className="row-main" style={peopleGrid}>
```

- [ ] **Step 5: Values truncate**

In `personCellFor`, change the `name`, `site_worked`, and `added` cases to:

```tsx
      case 'name':
        return <span className="cell-top cell-line" title={p.person_name}>{p.person_name}</span>;
      case 'site_worked': {
        const site = p.site_worked_name || '—';
        return <span className="cell-top cell-line" title={site}>{site}</span>;
      }
      case 'added': {
        const added = personCellText(p, 'added');
        return <span className="mono cell-line" title={added}>{added}</span>;
      }
```

In `assetCellFor`, change the final fallback to:

```tsx
    const text = moveAssetCellText(a, key);
    return <span className="cell-top cell-line" title={text}>{text}</span>;
```

and give the rack button the same treatment (it is inline text today — a long rack name would spill): in `portal/src/styles/initiatives.css`, extend `.idet-rack-cell-btn` with

```css
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
```

and add `title={rackName}` to the button in `assetCellFor`.

The chips (`status`, `asset_status`, `work_type`) already truncate via `.cell .chip`. Leave them.

- [ ] **Step 6: The time mini-list**

Change `<div className="mini-list idet-time-list">` to `<div className="mini-list idet-time-list list-scroll">`.

- [ ] **Step 7: Run the page tests, the guardrail, and the full portal suite**

Run: `npx vitest run src/pages/InitiativeDetail.test.tsx src/styles/listTypography.test.ts`
Expected: PASS (the new tests and every existing one; the existing `'88px 30px'` suffix assertion still holds since trailing tracks are appended verbatim).

Run: `npx vitest run`
Expected: PASS across the portal.

- [ ] **Step 8: Type-check and commit**

Run: `npx tsc -b`
Expected: clean.

```bash
git add src/lib/initiatives.ts src/pages/InitiativeDetail.tsx src/pages/InitiativeDetail.test.tsx src/styles/initiatives.css
git commit -m "feat(initiatives): detail page lists get column floors, adaptive headers, truncating values, and sideways scroll below 1176px

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Live verification in the browser (main session)

This task is run by the coordinating session, not a subagent — it needs the dev stack and the browser tools.

**Files:** none modified unless a defect is found.

- [ ] **Step 1: Start the worktree's dev servers on spare ports**

From the worktree root:

```bash
SS_ALLOWED_ORIGINS="http://localhost:5173,http://localhost:5175" PYTHONPATH=$PWD/api/src nohup api/.venv/bin/python -m uvicorn --factory serversherpa.api.app:create_app --app-dir api/src --host 0.0.0.0 --port 8001 > .devlogs/api-8001.log 2>&1 &
VITE_API_URL=http://localhost:8001 nohup npm --prefix portal run dev -- --port 5175 > .devlogs/portal-5175.log 2>&1 &
```

(If `SS_ALLOWED_ORIGINS` is already set in `.env`, append `http://localhost:5175` to it instead.)

- [ ] **Step 2: Open a move initiative's detail page**

Sign in as claude-dev at `http://localhost:5175`, open Initiatives, open a move with assets (the NAP11 demo initiative has both people and assets).

- [ ] **Step 3: Check the three widths**

Using `resize_window`:

| viewport | expect |
| --- | --- |
| 1512 × 982, nav expanded | nine asset columns, long labels ("Destination Rack"), **no** horizontal scrollbar on the card; `card.scrollWidth === card.clientWidth` |
| 1200 × 900 | headers read "Src Rack" / "Dest Rack"; card scrolls sideways; header scrolls with the rows; hover on a row paints to the scrolled edge |
| 1512 again | long labels return, scrollbar gone |

Verify with `javascript_tool`:

```js
const c = document.querySelector('.idet-assets-list');
({ scroll: c.scrollWidth, client: c.clientWidth, labels: [...c.querySelectorAll('.col-head .sortable')].map((b) => b.textContent.trim()) })
```

- [ ] **Step 4: Popover and truncation**

At 1200 wide, scroll the card right, open the Destination Rack column menu: it must open fully (not clipped) beside its header; scroll the card further until the header leaves the card: the menu closes. Hover a long asset name: the browser tooltip shows the full name and the cell shows an ellipsis (`getComputedStyle(el).textOverflow === 'ellipsis'`).

- [ ] **Step 5: Edit mode**

Toggle god-mode edit on the People list: the card gains `editing`, a Work type combo opens without being clipped. Toggle off: `editing` drops.

- [ ] **Step 6: Phone width**

`resize_window` preset `mobile`: rows are stacked cards, no sideways scroll on the card. Reset to `desktop`.

- [ ] **Step 7: Record**

Screenshot at 1512 and 1200 for the user. Stop the two servers. Note any defect as a fix task before the final review.
