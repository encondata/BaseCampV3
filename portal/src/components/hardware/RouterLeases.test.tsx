// @vitest-environment jsdom
/**
 * RouterLeases — the DHCP lease expansion panel for a router row. Covers
 * the fetch-on-mount / Active-default render, the Active/Reserved
 * switcher, and the error + Retry path.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DeviceLease } from '../../lib/api';

const api = vi.hoisted(() => ({
  listDeviceLeases: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const LEASES: DeviceLease[] = [
  {
    id: 'l1', mac: '94:83:C4:00:00:01', ip: '192.168.8.10', hostname: 'laptop-a',
    reserved: false, up: true, last_seen_at: '2026-08-31T10:00:00Z',
  },
  {
    id: 'l2', mac: '94:83:C4:00:00:02', ip: '192.168.8.11', hostname: null,
    reserved: false, up: false, last_seen_at: '2026-08-31T09:00:00Z',
  },
  {
    id: 'l3', mac: '94:83:C4:00:00:03', ip: '192.168.8.12', hostname: 'printer',
    reserved: true, up: true, last_seen_at: '2026-08-31T08:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

const { default: RouterLeases } = await import('./RouterLeases');

it('fetches on mount and renders the Active view by default', async () => {
  api.listDeviceLeases.mockResolvedValue(LEASES);
  render(<RouterLeases deviceId="d1" />);

  expect(await screen.findByText('laptop-a')).not.toBeNull();
  expect(api.listDeviceLeases).toHaveBeenCalledWith('d1');

  // 2 active rows shown, reserved row not shown
  expect(screen.getByText('laptop-a')).not.toBeNull();
  expect(screen.queryByText('printer')).toBeNull();

  // null hostname renders '—'
  const rows = screen.getAllByRole('row').slice(1); // skip header row
  expect(rows.length).toBe(2);
  const dashRow = rows.find((r) => within(r).queryByText('192.168.8.11'));
  expect(dashRow).toBeDefined();
  expect(within(dashRow!).getByText('—')).not.toBeNull();

  // up dot class differs between the up and down rows
  const upRow = rows.find((r) => within(r).queryByText('laptop-a'))!;
  const downRow = rows.find((r) => within(r).queryByText('192.168.8.11'))!;
  expect(upRow.querySelector('.lease-dot.up')).not.toBeNull();
  expect(downRow.querySelector('.lease-dot.up')).toBeNull();
  expect(downRow.querySelector('.lease-dot')).not.toBeNull();

  // switcher labels
  expect(screen.getByRole('button', { name: 'Active (2)' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Reserved (1)' })).not.toBeNull();
});

it('clicking Reserved swaps to the reserved row set', async () => {
  api.listDeviceLeases.mockResolvedValue(LEASES);
  const user = userEvent.setup();
  render(<RouterLeases deviceId="d1" />);

  await screen.findByText('laptop-a');

  await user.click(screen.getByRole('button', { name: 'Reserved (1)' }));

  expect(screen.getByText('printer')).not.toBeNull();
  expect(screen.queryByText('laptop-a')).toBeNull();
});

it('renders an error and Retry re-calls listDeviceLeases', async () => {
  api.listDeviceLeases.mockRejectedValueOnce(new Error('boom'));
  const user = userEvent.setup();
  render(<RouterLeases deviceId="d1" />);

  expect(await screen.findByText("Couldn't load leases.")).not.toBeNull();

  api.listDeviceLeases.mockResolvedValueOnce(LEASES);
  await user.click(screen.getByRole('button', { name: 'Retry' }));

  await waitFor(() => expect(api.listDeviceLeases).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('laptop-a')).not.toBeNull();
});
