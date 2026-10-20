// @vitest-environment jsdom
/**
 * The builder's number box (spec §4.5): arithmetic (`+5`, `*2`, `120-4`),
 * ↑/↓ steps (⇧ ten), Enter or leaving commits, Escape drops the edit.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import NumberBox, { evalNumber } from './NumberBox';

afterEach(cleanup);

describe('evalNumber', () => {
  it('reads numbers and arithmetic, a leading operator acting on the current value', () => {
    expect(evalNumber('12.5', 3)).toBe(12.5);
    expect(evalNumber(' 120 - 4 ', 3)).toBe(116);
    expect(evalNumber('2*(3+4)', 0)).toBe(14);
    expect(evalNumber('+5', 100)).toBe(105);
    expect(evalNumber('-5', 100)).toBe(95);
    expect(evalNumber('*2', 100)).toBe(200);
    expect(evalNumber('/4', 100)).toBe(25);
    expect(evalNumber('-5', null)).toBe(-5);
  });

  it('refuses what is not arithmetic', () => {
    for (const bad of ['', 'abc', '1+', '(2', '2)', '1/0', '1e400', 'alert(1)']) {
      expect(evalNumber(bad, 1)).toBeNull();
    }
  });
});

describe('NumberBox', () => {
  function setup(props: Partial<Parameters<typeof NumberBox>[0]> = {}) {
    const onCommit = vi.fn<(v: number | null) => void>();
    render(<NumberBox ariaLabel="X" value={100} onCommit={onCommit} {...props} />);
    return { onCommit, box: screen.getByRole('textbox', { name: 'X' }) as HTMLInputElement };
  }

  it('commits arithmetic on Enter and on leaving', () => {
    const { onCommit, box } = setup();
    fireEvent.change(box, { target: { value: '+15' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith(115);
    fireEvent.change(box, { target: { value: '*2' } });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenLastCalledWith(200);
  });

  it('steps with the arrows, ten with ⇧, inside min and max', () => {
    const { onCommit, box } = setup({ min: 0, max: 105 });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith(101);
    fireEvent.keyDown(box, { key: 'ArrowUp', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(105);
  });

  it('Escape drops the edit; nonsense reverts; empty commits null only when allowed', () => {
    const { onCommit, box } = setup();
    fireEvent.change(box, { target: { value: '7' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('100');
    fireEvent.change(box, { target: { value: 'abc' } });
    fireEvent.blur(box);
    expect(onCommit).not.toHaveBeenCalled();
    expect(box.value).toBe('100');
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.blur(box);
    expect(onCommit).not.toHaveBeenCalled();
    cleanup();
    const empty = setup({ allowEmpty: true, integer: true, min: 1 });
    fireEvent.change(empty.box, { target: { value: '' } });
    fireEvent.blur(empty.box);
    expect(empty.onCommit).toHaveBeenLastCalledWith(null);
    fireEvent.change(empty.box, { target: { value: '2.6' } });
    fireEvent.blur(empty.box);
    expect(empty.onCommit).toHaveBeenLastCalledWith(3);
    fireEvent.change(empty.box, { target: { value: '-4' } });
    fireEvent.blur(empty.box);
    // -4 from 100 is 96; the minimum only bites below it
    expect(empty.onCommit).toHaveBeenLastCalledWith(96);
  });

  it('shows a value that changes from outside', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<NumberBox ariaLabel="Y" value={1} onCommit={onCommit} />);
    rerender(<NumberBox ariaLabel="Y" value={2.346} onCommit={onCommit} />);
    expect((screen.getByRole('textbox', { name: 'Y' }) as HTMLInputElement).value).toBe('2.35');
  });

  it('over a selection: the edit for each element, Mixed when they differ', () => {
    const each = vi.fn<(apply: (current: number | null) => number | null) => void>();
    render(<NumberBox ariaLabel="Z" value={10} mixed allowEmpty integer min={1} onCommitEach={each} />);
    const box = screen.getByRole('textbox', { name: 'Z' }) as HTMLInputElement;
    expect(box.value).toBe('');
    expect(box.placeholder).toBe('Mixed');
    // an empty box over differing values changes nothing
    fireEvent.change(box, { target: { value: ' ' } });
    fireEvent.blur(box);
    expect(each).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '+5' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const add = each.mock.calls[0][0];
    expect([add(10), add(185), add(null)]).toEqual([15, 190, 5]);
    fireEvent.change(box, { target: { value: '7' } });
    fireEvent.blur(box);
    expect(each.mock.calls[1][0](3)).toBe(7);
    fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true });
    expect([each.mock.calls[2][0](30), each.mock.calls[2][0](4)]).toEqual([20, 1]);
  });
});
