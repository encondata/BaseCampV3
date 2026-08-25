// @vitest-environment jsdom
/**
 * lib/listTools.tsx: the column-order helpers (applyColumnOrder, moveKey),
 * the useReorderDrag drag-and-drop hook, and ColumnsButton's reorder mode.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyColumnOrder, ColumnsButton, moveKey, useReorderDrag, type ColumnDef } from './listTools';

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
