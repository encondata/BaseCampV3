// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import RfidTypeStep from './RfidTypeStep';

afterEach(cleanup);

it('offers Doorway, Dock Portal and Truck Portal with the fixed card copy', () => {
  render(<RfidTypeStep selected="" onSelect={vi.fn()} onBack={vi.fn()} />);
  expect(screen.getByText('Which RFID type?')).toBeTruthy();
  const options = screen.getAllByRole('option');
  expect(options.map((o) => o.querySelector('.setup-card-title')?.textContent))
    .toEqual(['Doorway', 'Dock Portal', 'Truck Portal']);
  expect(screen.getByText(
    "Today's RFID station: the reader at a doorway. Next: Move → Reader → Site → Scan type.")).toBeTruthy();
  expect(screen.getByText(
    'Reads crates at the dock and sets them to RFID 10 - Dock to Truck. Next: Move → Reader → Site.'))
    .toBeTruthy();
  expect(screen.getByText('Coming soon.')).toBeTruthy();
  options.forEach((o) => expect(o.getAttribute('aria-selected')).toBe('false'));
});

it('shows the saved choice selected', () => {
  render(<RfidTypeStep selected="dock_portal" onSelect={vi.fn()} onBack={vi.fn()} />);
  expect(screen.getByRole('option', { name: /Dock Portal/ }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('option', { name: /Doorway/ }).getAttribute('aria-selected')).toBe('false');
});

it('tapping a card picks it; Truck Portal is disabled and does nothing', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const onBack = vi.fn();
  render(<RfidTypeStep selected="" onSelect={onSelect} onBack={onBack} />);
  const truck = screen.getByRole('option', { name: /Truck Portal/ }) as HTMLButtonElement;
  expect(truck.disabled).toBe(true);
  expect(truck.getAttribute('aria-disabled')).toBe('true');
  await user.click(truck);
  expect(onSelect).not.toHaveBeenCalled();
  await user.click(screen.getByRole('option', { name: /Dock Portal/ }));
  expect(onSelect).toHaveBeenCalledWith('dock_portal');
  await user.click(screen.getByRole('option', { name: /Doorway/ }));
  expect(onSelect).toHaveBeenLastCalledWith('doorway');
  expect(onSelect).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalled();
});
