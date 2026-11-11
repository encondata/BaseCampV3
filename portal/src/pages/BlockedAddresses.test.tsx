// @vitest-environment jsdom
/**
 * /system/blocked-addresses — the sign-in address blocks list (SS-487).
 * Rows and labels from mocked API data, the Active | Ended filter, the
 * Actions ▾ menu (Clear block / Block permanently, by status) with a
 * refetch after each action and after a 409, and both empty states.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type BlockedAddress } from '../lib/api';
import { LIST_FIT, listGridStyle, ACTIONS_TRACK } from '../lib/listTools';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_size: 'default' } }),
}));

const api = vi.hoisted(() => ({
  listBlockedAddresses: vi.fn(),
  clearAddressBlock: vi.fn(),
  blockAddressPermanently: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

import BlockedAddresses, { BLOCKED_ADDRESS_COLUMNS } from './BlockedAddresses';

const base: BlockedAddress = {
  address: '203.0.113.7', status: 'blocked', level: 2,
  blocked_at: '2026-11-10T09:05:00', ends_at: '2026-11-10T15:05:00', ended_at: null,
  times_blocked: 2, failure_count: 10, last_route: 'login',
  first_blocked_at: '2026-11-09T08:00:00',
  cleared_at: null, cleared_by_name: null, made_permanent_at: null, made_permanent_by_name: null,
  attempts_while_blocked: 37, last_attempt_at: '2026-11-10T09:40:00',
};

const ACTIVE: BlockedAddress[] = [
  base,
  {
    ...base, address: '2001:db8:1:2::/64', status: 'permanent', level: 5, ends_at: null,
    times_blocked: 5, failure_count: 12, last_route: 'password_reset_confirm',
    made_permanent_at: '2026-11-10T10:00:00', made_permanent_by_name: 'Pat Admin',
    attempts_while_blocked: 0, last_attempt_at: null,
  },
];

const ENDED: BlockedAddress[] = [
  {
    ...base, address: '198.51.100.4', status: 'ended', level: 1,
    ends_at: '2026-11-08T13:00:00', ended_at: '2026-11-08T12:30:00',
    times_blocked: 1, last_route: 'totp_verify',
  },
];

const renderPage = () => render(<MemoryRouter><BlockedAddresses /></MemoryRouter>);
const rowFor = (address: string) => screen.getByText(address).closest('.dir-row') as HTMLElement;

beforeEach(() => {
  api.listBlockedAddresses.mockImplementation((show: string) =>
    Promise.resolve(show === 'ended' ? ENDED : ACTIVE));
  api.clearAddressBlock.mockResolvedValue({ ...base, status: 'ended' });
  api.blockAddressPermanently.mockResolvedValue({ ...base, status: 'permanent' });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('default columns fit the page with the actions track', () => {
  expect(BLOCKED_ADDRESS_COLUMNS.map((c) => c.label)).toEqual([
    'Address', 'Status', 'Ends', 'Times blocked', 'Tries while blocked',
    'Last route tried', 'First blocked', 'Last blocked',
  ]);
  expect(listGridStyle(BLOCKED_ADDRESS_COLUMNS, [ACTIONS_TRACK]).minWidth)
    .toBeLessThanOrEqual(LIST_FIT.page);
});

it('renders active rows with their labels', async () => {
  renderPage();
  await screen.findByText('203.0.113.7');
  expect(api.listBlockedAddresses).toHaveBeenCalledWith('active');

  const timed = rowFor('203.0.113.7');
  expect(within(timed).getByText('Blocked 6 h')).toBeTruthy();
  expect(within(timed).getByText('2026-11-10 15:05')).toBeTruthy();
  expect(within(timed).getByText('Password sign-in')).toBeTruthy();
  expect(within(timed).getByText('2026-11-09 08:00')).toBeTruthy();
  expect(within(timed).getByText('2026-11-10 09:05')).toBeTruthy();
  expect(within(timed).getByText('2').getAttribute('title'))
    .toBe('This block tripped on 10 failed sign-ins');
  expect(within(timed).getByText('37')).toBeTruthy();
  expect(within(timed).getByText('37').getAttribute('title')).toBe('Last try 2026-11-10 09:40');

  const perm = rowFor('2001:db8:1:2::/64');
  expect(within(perm).getByText('Permanent')).toBeTruthy();
  expect(within(perm).getByText('—')).toBeTruthy();
  expect(within(perm).getByText('0').getAttribute('title')).toBe('No tries since the block');
  expect(within(perm).getByText('Password reset link')).toBeTruthy();
});

it('labels every level and route', async () => {
  const levels = [1, 2, 3, 4].map((level, i) => ({
    ...base, address: `10.0.0.${i + 1}`, level,
    last_route: ['totp_verify', 'move_login', 'biometric_sign_in', 'password_reset_check'][i],
  }));
  api.listBlockedAddresses.mockResolvedValue(levels);
  renderPage();
  await screen.findByText('10.0.0.1');
  for (const label of ['Blocked 1 h', 'Blocked 6 h', 'Blocked 12 h', 'Blocked 24 h',
    '2FA code', 'Move password', 'Biometric sign-in', 'Password reset link']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
});

it('switches to ended blocks and shows when each ended, with no menu', async () => {
  renderPage();
  await screen.findByText('203.0.113.7');
  await userEvent.click(screen.getByRole('button', { name: 'Ended (last 30 days)' }));
  await screen.findByText('198.51.100.4');
  expect(api.listBlockedAddresses).toHaveBeenLastCalledWith('ended');
  const row = rowFor('198.51.100.4');
  expect(within(row).getByText('Ended')).toBeTruthy();
  expect(within(row).getByText('2026-11-08 12:30')).toBeTruthy();
  expect(within(row).getByText('2FA code')).toBeTruthy();
  expect(within(row).queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('Clear block calls the API and refetches', async () => {
  renderPage();
  await screen.findByText('203.0.113.7');
  await userEvent.click(within(rowFor('203.0.113.7')).getByRole('button', { name: /Actions/ }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Clear block' }));
  await waitFor(() => expect(api.clearAddressBlock).toHaveBeenCalledWith('203.0.113.7'));
  await waitFor(() => expect(api.listBlockedAddresses).toHaveBeenCalledTimes(2));
});

it('offers Block permanently only on a timed block', async () => {
  renderPage();
  await screen.findByText('203.0.113.7');
  await userEvent.click(within(rowFor('2001:db8:1:2::/64')).getByRole('button', { name: /Actions/ }));
  expect(await screen.findByRole('menuitem', { name: 'Clear block' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Block permanently' })).toBeNull();
  await userEvent.keyboard('{Escape}');

  await userEvent.click(within(rowFor('203.0.113.7')).getByRole('button', { name: /Actions/ }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Block permanently' }));
  await waitFor(() => expect(api.blockAddressPermanently).toHaveBeenCalledWith('203.0.113.7'));
  await waitFor(() => expect(api.listBlockedAddresses).toHaveBeenCalledTimes(2));
});

it('a 409 shows an error and refetches', async () => {
  api.clearAddressBlock.mockRejectedValue(new ApiError(409, 'block_not_active'));
  renderPage();
  await screen.findByText('203.0.113.7');
  await userEvent.click(within(rowFor('203.0.113.7')).getByRole('button', { name: /Actions/ }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Clear block' }));
  expect(await screen.findByText('This block has already ended or changed.')).toBeTruthy();
  await waitFor(() => expect(api.listBlockedAddresses).toHaveBeenCalledTimes(2));
});

it('shows the active empty state', async () => {
  api.listBlockedAddresses.mockResolvedValue([]);
  renderPage();
  expect(await screen.findByText('No addresses are blocked.')).toBeTruthy();
});

it('shows the ended empty state', async () => {
  api.listBlockedAddresses.mockResolvedValue([]);
  renderPage();
  await screen.findByText('No addresses are blocked.');
  await userEvent.click(screen.getByRole('button', { name: 'Ended (last 30 days)' }));
  expect(await screen.findByText('No blocks ended in the last 30 days.')).toBeTruthy();
});
