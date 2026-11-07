// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import RowTable, { type CheckRow } from './RowTable';

afterEach(cleanup);

const ROWS = ['A', 'B', 'C', 'D', 'E'];

function Harness({ onRange, disabled = new Set<string>() }: {
  onRange?: (keys: string[], on: boolean) => void; disabled?: Set<string>;
}) {
  const [ticked, setTicked] = useState(new Set<string>());
  const set = (keys: string[], on: boolean) => setTicked((cur) => {
    const next = new Set(cur);
    keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
    return next;
  });
  const rows: CheckRow[] = ROWS.map((r) => ({
    key: r, cells: [`Person ${r}`], checked: ticked.has(r), disabled: disabled.has(r), label: `Person ${r}`,
  }));
  return (
    <RowTable ariaLabel="Rows" columns={[{ key: 'name', label: 'Name' }]} rows={rows}
              onToggle={(k, on) => set([k], on)}
              onRange={(keys, on) => { onRange?.(keys, on); set(keys, on); }} />
  );
}

const box = (r: string) => screen.getByRole('checkbox', { name: `Row Person ${r}` }) as HTMLInputElement;

it('shift-click ticks the range between the last click and this one', () => {
  render(<Harness />);
  fireEvent.click(box('B'));
  fireEvent.click(box('D'), { shiftKey: true });
  expect(ROWS.map((r) => box(r).checked)).toEqual([false, true, true, true, false]);
});

it('shift-click unticks the range when the second row goes off', () => {
  const onRange = vi.fn();
  render(<Harness onRange={onRange} />);
  fireEvent.click(box('A'));
  fireEvent.click(box('E'), { shiftKey: true });
  expect(ROWS.every((r) => box(r).checked)).toBe(true);
  fireEvent.click(box('E'));                       // untick E (plain click)
  fireEvent.click(box('C'), { shiftKey: true });   // C goes off, so C..E go off
  expect(ROWS.map((r) => box(r).checked)).toEqual([true, true, false, false, false]);
  expect(onRange).toHaveBeenLastCalledWith(['C', 'D', 'E'], false);
});

it('leaves disabled rows out of a range', () => {
  const onRange = vi.fn();
  render(<Harness onRange={onRange} disabled={new Set(['C'])} />);
  expect(box('C').disabled).toBe(true);
  fireEvent.click(box('A'));
  fireEvent.click(box('E'), { shiftKey: true });
  expect(onRange).toHaveBeenLastCalledWith(['A', 'B', 'D', 'E'], true);
});
