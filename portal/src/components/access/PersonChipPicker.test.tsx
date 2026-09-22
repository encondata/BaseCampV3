// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import PersonChipPicker from './PersonChipPicker';

afterEach(cleanup);
const options = [
  { value: 'p1', label: 'Ann One', sub: 'staff' },
  { value: 'p2', label: 'Bob Two', sub: 'worker' },
];

it('adds a chip per pick, hides picked people from the menu, removes on ×', () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <PersonChipPicker options={options} selected={[]} onChange={onChange} placeholder="Add person…" />);
  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  fireEvent.mouseDown(screen.getByText('Ann One'));   // ComboBox selects on mousedown
  expect(onChange).toHaveBeenLastCalledWith(['p1']);
  rerender(<PersonChipPicker options={options} selected={['p1']} onChange={onChange} placeholder="Add person…" />);
  expect(screen.getByText('Ann One').closest('.chip')).toBeTruthy();
  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  expect(screen.queryAllByText('Ann One')).toHaveLength(1);   // chip only, not in the menu
  fireEvent.click(screen.getByLabelText('Remove Ann One'));
  expect(onChange).toHaveBeenLastCalledWith([]);
});
