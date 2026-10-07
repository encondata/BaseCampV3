// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import LanMachinesSection from './LanMachinesSection';
import { LAN_ENV } from './testData';

afterEach(cleanup);

it('lists the data VM and both app VMs with their slot state', () => {
  render(<LanMachinesSection env={LAN_ENV} canActivate onActivate={vi.fn()} />);
  const table = screen.getByRole('table', { name: 'Blue/Green VMs' });
  expect(within(table).getByText('ss-lan9-data')).toBeTruthy();
  expect(within(table).getByText('ss-lan9-orange')).toBeTruthy();
  expect(within(table).getByText('Live')).toBeTruthy();
  expect(within(table).getByText('10.10.48.47')).toBeTruthy();
});

it('offers Activate on the deployed idle slot only', async () => {
  const onActivate = vi.fn();
  render(<LanMachinesSection env={LAN_ENV} canActivate onActivate={onActivate} />);
  await userEvent.click(screen.getByRole('button', { name: 'Activate Purple' }));
  expect(onActivate).toHaveBeenCalledWith('purple');
  expect(screen.queryByRole('button', { name: 'Activate Orange' })).toBeNull();
});

it('has no Activate without permission', () => {
  render(<LanMachinesSection env={LAN_ENV} canActivate={false} onActivate={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
});

it('an idle slot that never ran a deploy says so and has no Activate', () => {
  const env = { ...LAN_ENV, lan_slots: LAN_ENV.lan_slots!.map((s) => (s.slot === 'purple'
    ? { ...s, sha: null, image_tag: null, last_check_ok: null, last_check_at: null } : s)) };
  render(<LanMachinesSection env={env} canActivate onActivate={vi.fn()} />);
  expect(screen.getByText('Not deployed')).toBeTruthy();
  expect(screen.getByText('Shared')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
});
