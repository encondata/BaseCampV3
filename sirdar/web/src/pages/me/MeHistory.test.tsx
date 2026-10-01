// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/api', async (orig) => ({
  ...(await orig<typeof import('@portal/lib/api')>()),
  getMyActivityRequest: vi.fn(),
}));
const exportCsv = vi.hoisted(() => vi.fn());
vi.mock('@portal/lib/listTools', async (orig) => ({
  ...(await orig<typeof import('@portal/lib/listTools')>()),
  exportCsv,
}));

import * as api from '@portal/lib/api';
import type { MyActivityItem } from '@portal/lib/api';

import MeHistory from './MeHistory';

const item = (id: string, at: string, action: string, entity_type: string, ip: string | null = null): MyActivityItem => ({
  id, at, action, entity_type, entity_id: null, ip, by_me: true, actor_name: 'Ada',
  changes: {}, entity_name: null, entity_summary: {},
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const bodyRows = () => {
  const table = screen.getByRole('table', { name: 'History' });
  return within(table).getAllByRole('row').slice(1);
};

it('renders rows newest first with When, Action, Record and IP', async () => {
  vi.mocked(api.getMyActivityRequest).mockResolvedValue([
    item('1', '2026-01-01T00:00:00Z', 'login', 'auth', '10.0.0.1'),
    item('2', '2026-03-01T00:00:00Z', 'password.change', 'user_account', '10.0.0.2'),
  ]);
  render(<MeHistory />);
  await screen.findByText('Changed password');
  const headers = within(screen.getByRole('table', { name: 'History' })).getAllByRole('columnheader')
    .map((h) => h.textContent);
  expect(headers).toEqual(['When', 'Action', 'Record', 'IP']);
  const rows = bodyRows();
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('Changed password');
  expect(rows[0].textContent).toContain('10.0.0.2');
  expect(rows[1].textContent).toContain('Signed in');
});

it('filters client-side by action and record type', async () => {
  vi.mocked(api.getMyActivityRequest).mockResolvedValue([
    item('1', '2026-01-01T00:00:00Z', 'login', 'auth'),
    item('2', '2026-02-01T00:00:00Z', 'logout', 'auth'),
    item('3', '2026-03-01T00:00:00Z', 'profile.update', 'person'),
  ]);
  render(<MeHistory />);
  await screen.findByText('Signed out');
  expect(bodyRows()).toHaveLength(3);

  await userEvent.click(screen.getByRole('combobox', { name: 'Record type' }));
  fireEvent.mouseDown(await screen.findByRole('button', { name: 'account' }));
  await waitFor(() => expect(bodyRows()).toHaveLength(2));

  await userEvent.click(screen.getByRole('combobox', { name: 'Action' }));
  fireEvent.mouseDown(await screen.findByRole('button', { name: 'Signed out' }));
  await waitFor(() => expect(bodyRows()).toHaveLength(1));
  expect(bodyRows()[0].textContent).toContain('Signed out');

  await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
  expect(exportCsv).toHaveBeenCalledTimes(1);
  expect(exportCsv.mock.calls[0][2]).toHaveLength(1);
});

it('shows the empty state when there is no activity', async () => {
  vi.mocked(api.getMyActivityRequest).mockResolvedValue([]);
  render(<MeHistory />);
  expect(await screen.findByText('No activity yet.')).toBeTruthy();
});
