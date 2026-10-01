// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

let canAdd = true;
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a = 'view') => (r === 'users' && a === 'add' ? canAdd : true) }),
}));
vi.mock('../lib/sirdarApi', async (orig) => ({
  ...(await orig<typeof import('../lib/sirdarApi')>()),
  listUsers: vi.fn().mockResolvedValue([{
    person_id: 'p1', display_name: 'Alice Anderson', email: 'a@x.co', source: 'portal',
    roles: ['admin'], max_rank: 60, totp_enrolled: true, totp_required: true,
    last_login_at: null, disabled_at: null, disabled_reason: null, last_imported_at: null,
  }]),
  getImportSource: vi.fn().mockResolvedValue({ configured: true }),
}));

import Users from './Users';

afterEach(() => { cleanup(); canAdd = true; });

it('lists users and offers import to users:add holders', async () => {
  render(<MemoryRouter><Users /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('Alice Anderson')).toBeTruthy());
  expect(screen.getByRole('button', { name: /import from portal/i })).toBeTruthy();
});

it('hides import without users:add', async () => {
  canAdd = false;
  render(<MemoryRouter><Users /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('Alice Anderson')).toBeTruthy());
  expect(screen.queryByRole('button', { name: /import from portal/i })).toBeNull();
});
