// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import ContainerTagPicker from './ContainerTagPicker';

afterEach(cleanup);

it('shows "No tag" when unset, and the tag label + colored chip when set', () => {
  const { rerender } = render(<ContainerTagPicker value={null} onChange={() => {}} />);
  expect(screen.getByText('No tag')).toBeTruthy();

  rerender(<ContainerTagPicker value="priority" onChange={() => {}} />);
  expect(screen.queryByText('No tag')).toBeNull();
  expect(screen.getByText('Priority')).toBeTruthy();
});

it('opens a menu of all five tags plus None, and picking one calls onChange and closes', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ContainerTagPicker value={null} onChange={onChange} label="Tag for Rack Cart 1" />);
  await user.click(screen.getByLabelText('Tag for Rack Cart 1'));

  expect(screen.getByRole('menuitem', { name: 'None' })).toBeTruthy();
  for (const label of ['Priority', 'Vendor', 'Accessories', 'E-Waste', 'Warehouse']) {
    expect(screen.getByRole('menuitem', { name: new RegExp(label) })).toBeTruthy();
  }

  await user.click(screen.getByRole('menuitem', { name: /Warehouse/ }));
  expect(onChange).toHaveBeenCalledWith('warehouse');
  expect(screen.queryByRole('menuitem', { name: 'None' })).toBeNull();
});

it('picking None calls onChange with null', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ContainerTagPicker value="vendor" onChange={onChange} label="Tag" />);
  await user.click(screen.getByLabelText('Tag'));
  await user.click(screen.getByRole('menuitem', { name: 'None' }));
  expect(onChange).toHaveBeenCalledWith(null);
});

it('a disabled picker does not open the menu', async () => {
  const user = userEvent.setup();
  render(<ContainerTagPicker value={null} onChange={() => {}} disabled label="Tag" />);
  await user.click(screen.getByLabelText('Tag'));
  expect(screen.queryByRole('menuitem', { name: 'None' })).toBeNull();
});
