// @vitest-environment jsdom
/**
 * ChipPicker: pick many of a list one at a time. Each pick is a chip with
 * a × (Remove <label>); the ComboBox below offers only what isn't picked,
 * in natural order, and clears after a pick. Backspace in the empty box
 * takes the last chip off; after a ×, focus goes to the next chip's ×,
 * else the previous one's, else the box. Opt-in "Clear all" (2+ chips) and
 * a one-line note under the chips.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import ChipPicker from './ChipPicker';
import type { ComboOption } from './ComboBox';

afterEach(cleanup);

const OPTIONS: ComboOption[] = [
  { value: 's10', label: 'NAP10' },
  { value: 's2', label: 'NAP2' },
  { value: 's1', label: 'NAP1' },
  { value: 'sb', label: 'bravo' },
];

/** A controlled picker, recording each change. */
function Harness({ initial = [], onChange = vi.fn(), ...rest }: {
  initial?: string[]; onChange?: (ids: string[]) => void; disabled?: boolean; clearAll?: boolean;
  note?: string;
}) {
  const [ids, setIds] = useState(initial);
  return (
    <ChipPicker options={OPTIONS} selected={ids} placeholder="Add a site…"
      onChange={(next) => { onChange(next); setIds(next); }} {...rest} />
  );
}

const box = () => screen.getByRole('combobox') as HTMLInputElement;
const chips = () => [...document.querySelectorAll('.chip-picker-list .chip')].map(
  (c) => c.firstChild?.textContent);

it('a pick adds a chip and clears the box; the menu offers only what is not picked, naturally', async () => {
  const onChange = vi.fn();
  render(<Harness initial={['s2']} onChange={onChange} />);
  expect(chips()).toEqual(['NAP2']);
  fireEvent.focus(box());
  const menu = document.querySelector('.combo-menu') as HTMLElement;
  expect([...menu.querySelectorAll('.kbar-item')].map((b) => b.textContent)).toEqual(['bravo', 'NAP1', 'NAP10']);
  fireEvent.mouseDown(within(menu).getByText('NAP10'));
  expect(onChange).toHaveBeenLastCalledWith(['s2', 's10']);
  expect(chips()).toEqual(['NAP2', 'NAP10']);
  expect(box().value).toBe('');
});

it('× removes that chip', async () => {
  const onChange = vi.fn();
  render(<Harness initial={['s1', 's2', 's10']} onChange={onChange} />);
  await userEvent.click(screen.getByRole('button', { name: 'Remove NAP2' }));
  expect(onChange).toHaveBeenLastCalledWith(['s1', 's10']);
  expect(chips()).toEqual(['NAP1', 'NAP10']);
});

it('Backspace in the empty box removes the last chip; with text it only edits', async () => {
  const onChange = vi.fn();
  render(<Harness initial={['s1', 's2']} onChange={onChange} />);
  await userEvent.click(box());
  await userEvent.keyboard('{Backspace}');
  expect(onChange).toHaveBeenLastCalledWith(['s1']);
  await userEvent.type(box(), 'NA');
  onChange.mockClear();
  await userEvent.keyboard('{Backspace}');
  expect(onChange).not.toHaveBeenCalled();
  expect(chips()).toEqual(['NAP1']);
});

it('each × is reachable by Tab, and focus moves on after a removal', async () => {
  render(<Harness initial={['s1', 's2', 's10']} />);
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove NAP1' }));
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove NAP2' }));
  // the next chip's ×
  await userEvent.keyboard('{Enter}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove NAP10' }));
  // the last one: the previous chip's ×
  await userEvent.keyboard('{Enter}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove NAP1' }));
  // none left: the box
  await userEvent.keyboard('{Enter}');
  expect(chips()).toEqual([]);
  expect(document.activeElement).toBe(box());
});

it('Clear all shows with two or more chips and empties the picker', async () => {
  const onChange = vi.fn();
  const { unmount } = render(<Harness initial={['s1']} clearAll onChange={onChange} />);
  expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  unmount();
  render(<Harness initial={['s1', 's2']} clearAll onChange={onChange} />);
  await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  expect(onChange).toHaveBeenLastCalledWith([]);
  expect(chips()).toEqual([]);
});

it('a note sits under the chips', () => {
  render(<Harness initial={['s1']} note="Linked to 1 site." />);
  const note = screen.getByText('Linked to 1 site.');
  const list = document.querySelector('.chip-picker-list') as HTMLElement;
  expect(list.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(note.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('disabled: no removing, no adding, no clearing', () => {
  render(<Harness initial={['s1', 's2']} clearAll disabled />);
  expect((screen.getByRole('button', { name: 'Remove NAP1' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Clear all' }) as HTMLButtonElement).disabled).toBe(true);
  expect(box().disabled).toBe(true);
  fireEvent.keyDown(box(), { key: 'Backspace' });
  expect(chips()).toEqual(['NAP1', 'NAP2']);
});

it('a picked id with no option shows the id itself', () => {
  render(<Harness initial={['gone']} />);
  expect(screen.getByRole('button', { name: 'Remove gone' })).toBeTruthy();
});
