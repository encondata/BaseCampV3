// @vitest-environment jsdom
/**
 * lib/listTools.tsx: the column-order helpers (applyColumnOrder, moveKey),
 * the useReorderDrag drag-and-drop hook, ColumnsButton's reorder mode, and
 * csvCell (exportCsv's field encoder incl. the OWASP formula-injection guard).
 */

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyColumnOrder, ColHead, ColumnsButton, csvCell, moveKey, useReorderDrag, useSearchHaystacks,
  columnFloor, listGridStyle, listScale,
  type ColumnDef, type HeaderDragProps,
} from './listTools';

// The pinned jsdom here has no DragEvent constructor, so @testing-library/dom's
// generic Event fallback silently drops clientX/clientY from fireEvent.dragOver
// inits. Polyfill it as a thin MouseEvent subclass so drag-position math under
// test actually receives coordinates; dataTransfer is patched on separately by
// RTL itself and needs no help here.
if (typeof DragEvent === 'undefined') {
  class DragEventPolyfill extends MouseEvent {}
  // @ts-expect-error -- test-only jsdom polyfill
  globalThis.DragEvent = DragEventPolyfill;
}

afterEach(cleanup);

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

  it('listScale maps the list_size preference to directory.css --list-scale', () => {
    expect(listScale('small')).toBe(0.9);
    expect(listScale(undefined)).toBe(1);
    expect(listScale('large')).toBe(1.15);
    expect(listScale('xlarge')).toBe(1.3);
  });

  it('scales every derived floor (ceil) while leaving fixed px tracks untouched', () => {
    const s = listGridStyle(
      [c({ key: 'a', label: 'Serial', width: '1.1fr' }), c({ key: 'b', label: 'X', width: '88px' })],
      ['30px'], 12, 1.3,
    );
    // 75 * 1.3 = 97.5 → ceil 98
    expect(s.gridTemplateColumns).toBe('minmax(98px, 1.1fr) 88px 30px');
    expect(s.minWidth).toBe(98 + 88 + 30 + 24 + 40);
  });
});

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

describe('useSearchHaystacks', () => {
  it('rebuilds the haystack when `text` changes identity, even with the same `rows` array', () => {
    const rows = [{ id: 1, name: 'alpha' }];
    const textV1 = (r: { id: number; name: string }) => `${r.name}-v1`;
    const textV2 = (r: { id: number; name: string }) => `${r.name}-v2`;

    const { result, rerender } = renderHook(
      ({ text }: { text: (r: { id: number; name: string }) => string }) =>
        useSearchHaystacks(rows, text),
      { initialProps: { text: textV1 } },
    );
    expect(result.current(rows[0])).toBe('alpha-v1');

    // Same `rows` identity, new `text` function — the memo must rebuild
    // and reflect the new function's output, not the stale cached one.
    rerender({ text: textV2 });
    expect(result.current(rows[0])).toBe('alpha-v2');
  });
});

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

describe('csvCell quoting (existing behavior)', () => {
  it('passes plain values through untouched', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell('')).toBe('');
  });

  it('quotes values containing commas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes values containing newlines', () => {
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('csvCell formula-injection guard', () => {
  it('neutralizes = formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(
      '"\'=HYPERLINK(""http://evil"")"',
    );
    expect(csvCell('=1+1')).toBe("'=1+1");
  });

  it('neutralizes + prefixed values', () => {
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc");
  });

  it('neutralizes - prefixed values', () => {
    expect(csvCell('-cmd|calc')).toBe("'-cmd|calc");
  });

  it('neutralizes @ prefixed values', () => {
    expect(csvCell('@SUM(1,2)')).toBe('"\'@SUM(1,2)"');
  });

  it('leaves purely numeric values alone (negative numbers are data)', () => {
    // Decision: only escape when the value is NOT purely numeric —
    // lists legitimately export negative/signed numbers like "-5".
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('-5.25')).toBe('-5.25');
    expect(csvCell('+12')).toBe('+12');
  });
});

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
