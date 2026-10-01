// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let me = 'me';
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, person: { id: me } }),
}));
vi.mock('@portal/components/access/MatrixTable', () => ({ default: () => null }));
vi.mock('../lib/sirdarApi', async (orig) => ({
  ...(await orig<typeof import('../lib/sirdarApi')>()),
  getUser: vi.fn(),
  getAccessSummary: vi.fn().mockResolvedValue({ resources: [{ id: 'users', label: 'Users' }] }),
  revokeSessions: vi.fn(),
}));

import * as api from '../lib/sirdarApi';
import UserDetail from './UserDetail';

const detail = (personId: string) => ({
  user: {
    person_id: personId, display_name: 'Bob Builder', email: 'b@x.co', source: 'portal',
    roles: ['admin'], disabled_at: null,
  },
  cells: {}, can_manage: true,
  sessions: [{ id: 's1', created_at: '2026-01-01T00:00:00Z', expires_at: '2026-01-02T00:00:00Z',
               ip_address: null, user_agent: null }],
});

const renderAt = (id: string) => render(
  <MemoryRouter initialEntries={[`/admin/users/${id}`]}>
    <Routes><Route path="/admin/users/:personId" element={<UserDetail />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  me = 'me';
  vi.mocked(api.getUser).mockImplementation(async (id: string) => detail(id) as never);
});
afterEach(cleanup);

it('hides Edit overrides when viewing yourself', async () => {
  renderAt('me');
  await waitFor(() => expect(screen.getByText('Bob Builder')).toBeTruthy());
  expect(screen.queryByRole('button', { name: /edit overrides/i })).toBeNull();
});

it('shows Edit overrides for a manageable other user', async () => {
  renderAt('other');
  await waitFor(() => expect(screen.getByText('Bob Builder')).toBeTruthy());
  expect(screen.getByRole('button', { name: /edit overrides/i })).toBeTruthy();
});

it('keeps the page and shows an inline error when revoke fails', async () => {
  vi.mocked(api.revokeSessions).mockRejectedValue(new Error('boom'));
  renderAt('other');
  await waitFor(() => expect(screen.getByText('Bob Builder')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /sign out everywhere/i }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(screen.getByText('Bob Builder')).toBeTruthy();
});

it('hides session details for people who outrank the viewer', async () => {
  vi.mocked(api.getUser).mockImplementation(
    async (id: string) => ({ ...detail(id), can_manage: false, sessions: [] }) as never);
  renderAt('other');
  await waitFor(() => expect(screen.getByText('Bob Builder')).toBeTruthy());
  expect(screen.getByText('Session details are hidden for people who outrank you.')).toBeTruthy();
  expect(screen.queryByRole('table', { name: /active sessions/i })).toBeNull();
  expect(screen.queryByText('No active sessions.')).toBeNull();
});
